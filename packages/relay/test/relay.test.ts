import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LeakObservation, RelayObserverResponse } from '@silicr/api';
import { MAX_MESSAGE_BYTES, RelayError, relayClient, startRelay } from '../src/index.ts';
import type { RelayOptions, RunningRelay } from '../src/index.ts';
import { generateSigner, signDirectoryEntry, toHex, verifyDirectoryEntry } from '@silicr/protocol';
import type { DirectoryEntry } from '@silicr/protocol';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => undefined);
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'silicr-relay-test-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function start(opts: Partial<RelayOptions> = {}) {
  const dataDir = opts.dataDir ?? (await tempDir());
  const logs: string[] = [];
  const relay = await startRelay({ port: 0, dataDir, log: (l) => logs.push(l), ...opts });
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await relay.close();
    }
  };
  cleanups.push(close);
  return { relay, dataDir, logs, client: relayClient(relay.url, { backoffMs: 50 }), close };
}

const nowS = () => Math.floor(Date.now() / 1000);

/** A provider identity that signs well-formed directory entries (updatedAt in Unix seconds). */
function provider() {
  const { signer } = generateSigner();
  const providerId = toHex(signer.publicKey);
  const sign = (over: Partial<Omit<DirectoryEntry, 'sig'>> = {}): DirectoryEntry =>
    signDirectoryEntry(
      {
        v: 1,
        providerId,
        alias: 'amber-otter-17',
        address: `utest1${'q'.repeat(60)}`,
        gpus: [{ model: 'a100', count: 4, vramGb: 80 }],
        minPricePerHourZats: '60000000',
        updatedAt: nowS(),
        ...over,
      },
      signer,
    );
  return { providerId, sign };
}

async function postEntry(relay: RunningRelay, entry: unknown) {
  return status(`${relay.url}/directory`, { method: 'POST', body: JSON.stringify(entry) });
}

const newId = () => randomBytes(16).toString('hex');
const newProviderId = () => randomBytes(32).toString('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function status(url: string, init?: RequestInit): Promise<{ status: number; body: unknown; headers: Headers }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body, headers: res.headers };
}

async function observations(relay: RunningRelay, after = ''): Promise<LeakObservation[]> {
  const res = await fetch(`${relay.url}/_observer${after ? `?after=${after}` : ''}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as RelayObserverResponse).observations;
}

describe('mailboxes', () => {
  it('appends and reads in order', async () => {
    const { client } = await start();
    const mb = newId();
    const payloads = Array.from({ length: 5 }, (_, i) => randomBytes(100 + i));
    const seqs: number[] = [];
    for (const p of payloads) seqs.push(await client.append(mb, p));
    expect(seqs).toEqual([1, 2, 3, 4, 5]);

    const all = await client.read(mb, 0);
    expect(all.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
    all.forEach((m, i) => expect(Buffer.from(m.data).equals(payloads[i]!)).toBe(true));

    const tail = await client.read(mb, 3);
    expect(tail.map((m) => m.seq)).toEqual([4, 5]);
    expect(await client.read(mb, 5)).toEqual([]);
    // Unknown mailboxes list as empty rather than 404.
    expect(await client.read(newId(), 0)).toEqual([]);
  });

  it('gives concurrent appends unique, contiguous seqs', async () => {
    const { client } = await start();
    const mb = newId();
    const seqs = await Promise.all(Array.from({ length: 25 }, (_, i) => client.append(mb, Uint8Array.of(i))));
    expect([...seqs].sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    const all = await client.read(mb, 0);
    expect(all).toHaveLength(25);
    // Each seq maps to the payload whose append returned it.
    for (const m of all) expect(seqs[m.data[0]!]).toBe(m.seq);
  });

  it('stores the exact bytes, including empty bodies', async () => {
    const { relay, client } = await start();
    const mb = newId();
    const seq = await client.append(mb, new Uint8Array(0));
    const res = await fetch(`${relay.url}/m/${mb}/${seq}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it('long-poll wakes as soon as a message arrives', async () => {
    const { client } = await start();
    const mb = newId();
    const t0 = Date.now();
    const pending = client.read(mb, 0, 10);
    await sleep(200);
    await client.append(mb, Buffer.from('wake'));
    const got = await pending;
    expect(got.map((m) => m.seq)).toEqual([1]);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('long-poll times out with an empty list', async () => {
    const { client } = await start();
    const mb = newId();
    await client.append(mb, Buffer.from('one'));
    const t0 = Date.now();
    const none = await client.read(mb, 1, 0.5);
    const elapsed = Date.now() - t0;
    expect(none).toEqual([]);
    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(elapsed).toBeLessThan(3000);
  });

  it('caps the long-poll wait', async () => {
    const { relay } = await start({ limits: { maxWaitS: 1 } });
    const t0 = Date.now();
    const r = await status(`${relay.url}/m/${newId()}?after=0&wait=600`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ messages: [] });
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  it('releases long-polls on close', async () => {
    const { client, close } = await start();
    const pending = client.read(newId(), 0, 20);
    await sleep(150);
    const t0 = Date.now();
    await close();
    expect(await pending).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('rejects bad mailbox ids, seqs and queries with 400', async () => {
    const { relay, client } = await start();
    const bad = [
      'ABCDEF0123456789ABCDEF0123456789', // uppercase
      '0123456789abcdef0123456789abcde', // 31
      '0123456789abcdef0123456789abcdef0', // 33
      'g123456789abcdef0123456789abcdef', // non-hex
      '%2e%2e%2f%2e%2e%2fetc', // traversal attempt
      '',
    ];
    for (const id of bad) {
      expect((await status(`${relay.url}/m/${id}`, { method: 'PUT', body: 'x' })).status).toBe(400);
      expect((await status(`${relay.url}/m/${id}?after=0`)).status).toBe(400);
      expect((await status(`${relay.url}/m/${id}/1`)).status).toBe(400);
    }
    const good = newId();
    const r = await status(`${relay.url}/m/${good}/0`);
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'bad_request' });
    expect((await status(`${relay.url}/m/${good}/abc`)).status).toBe(400);
    expect((await status(`${relay.url}/m/${good}?after=-1`)).status).toBe(400);
    expect((await status(`${relay.url}/m/${good}?after=1.5`)).status).toBe(400);
    expect((await status(`${relay.url}/m/${good}?wait=soon`)).status).toBe(400);
    expect((await status(`${relay.url}/m/${good}/1`)).status).toBe(404);
    await expect(client.append('NOT-AN-ID', Buffer.from('x'))).rejects.toMatchObject({ status: 400 });
  });

  it('answers unknown routes with 404 and wrong methods with 405', async () => {
    const { relay } = await start();
    expect((await status(`${relay.url}/nope`)).status).toBe(404);
    expect((await status(`${relay.url}/m/${newId()}/1/2`)).status).toBe(404);
    const r = await status(`${relay.url}/m/${newId()}`, { method: 'DELETE' });
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('GET, PUT');
    expect((await status(`${relay.url}/health`, { method: 'POST', body: '{}' })).status).toBe(405);
    expect((await status(`${relay.url}/health`)).body).toEqual({ ok: true });
  });
});

describe('limits', () => {
  it('accepts exactly 16 MiB and rejects one byte more with 413', async () => {
    const { relay, client } = await start();
    const mb = newId();
    const max = randomBytes(MAX_MESSAGE_BYTES);
    expect(await client.append(mb, max)).toBe(1);
    const [back] = await client.read(mb, 0);
    expect(back && Buffer.from(back.data).equals(max)).toBe(true);

    const over = await status(`${relay.url}/m/${mb}`, { method: 'PUT', body: new Uint8Array(MAX_MESSAGE_BYTES + 1) });
    expect(over.status).toBe(413);
    expect(over.body).toMatchObject({ code: 'too_large' });
    await expect(client.append(mb, new Uint8Array(MAX_MESSAGE_BYTES + 1))).rejects.toMatchObject({ status: 413 });
    expect((await client.read(mb, 0)).map((m) => m.seq)).toEqual([1]);
  }, 30_000);

  it('rejects an oversized chunked body with 413', async () => {
    const { relay } = await start({ limits: { maxMessageBytes: 1024 } });
    const chunks = [new Uint8Array(700), new Uint8Array(700)];
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        const c = chunks.shift();
        if (c) ctrl.enqueue(c);
        else ctrl.close();
      },
    });
    const r = await status(`${relay.url}/m/${newId()}`, { method: 'PUT', body, duplex: 'half' } as RequestInit);
    expect(r.status).toBe(413);
  });

  it('caps messages per mailbox with 507', async () => {
    const { client } = await start({ limits: { maxMessagesPerMailbox: 3 } });
    const mb = newId();
    for (let i = 0; i < 3; i++) await client.append(mb, Buffer.from([i]));
    await expect(client.append(mb, Buffer.from('4th'))).rejects.toMatchObject({ status: 507, code: 'mailbox_full' });
    // Other mailboxes are unaffected.
    expect(await client.append(newId(), Buffer.from('x'))).toBe(1);
  });

  it('caps total storage with 507', async () => {
    const { client } = await start({ limits: { maxTotalBytes: 1000 } });
    await client.append(newId(), new Uint8Array(900));
    await expect(client.append(newId(), new Uint8Array(200))).rejects.toMatchObject({ status: 507, code: 'storage_full' });
  });

  it('caps directory entries at 16 KiB', async () => {
    const { relay } = await start();
    const entry = { v: 1, providerId: newProviderId(), updatedAt: 1, pad: 'x'.repeat(17 * 1024) };
    const r = await status(`${relay.url}/directory`, { method: 'POST', body: JSON.stringify(entry) });
    expect(r.status).toBe(413);
  });
});

describe('persistence and TTL', () => {
  it('rebuilds the index from disk on restart', async () => {
    const dataDir = await tempDir();
    const first = await start({ dataDir });
    const mb = newId();
    for (const s of ['a', 'b', 'c']) await first.client.append(mb, Buffer.from(s));
    await first.close();
    expect((await readdir(join(dataDir, 'mailboxes', mb))).sort()).toEqual(['1.bin', '2.bin', '3.bin']);

    const second = await start({ dataDir });
    const all = await second.client.read(mb, 0);
    expect(all.map((m) => Buffer.from(m.data).toString())).toEqual(['a', 'b', 'c']);
    expect(await second.client.append(mb, Buffer.from('d'))).toBe(4);
  });

  it('expires mailboxes untouched for ttlMs', async () => {
    const { relay, client, dataDir } = await start({ ttlMs: 300 });
    const mb = newId();
    await client.append(mb, Buffer.from('short-lived'));
    expect(await client.read(mb, 0)).toHaveLength(1);
    await sleep(700);
    expect(await client.read(mb, 0)).toEqual([]);
    expect((await status(`${relay.url}/m/${mb}/1`)).status).toBe(404);
    const dir = join(dataDir, 'mailboxes', mb);
    for (let i = 0; i < 40 && existsSync(dir); i++) await sleep(50);
    expect(existsSync(dir)).toBe(false);
    // Reusing an expired id starts again at seq 1.
    expect(await client.append(mb, Buffer.from('again'))).toBe(1);
  });

  it('keeps mailboxes that are being read', async () => {
    const { client } = await start({ ttlMs: 400 });
    const mb = newId();
    await client.append(mb, Buffer.from('kept'));
    for (let i = 0; i < 8; i++) {
      await sleep(100);
      expect(await client.read(mb, 0)).toHaveLength(1);
    }
  });

  it('expires mailboxes on restart when the TTL passed while down', async () => {
    const dataDir = await tempDir();
    const first = await start({ dataDir });
    const mb = newId();
    await first.client.append(mb, Buffer.from('stale'));
    await first.close();
    await sleep(400);
    const second = await start({ dataDir, ttlMs: 200 });
    expect(await second.client.read(mb, 0)).toEqual([]);
  });
});

describe('directory', () => {
  it('keeps the latest signed entry per provider; older or conflicting entries get 409', async () => {
    const dataDir = await tempDir();
    const { client, close } = await start({ dataDir });
    const a = provider();
    const b = provider();
    const t = nowS();
    const first = a.sign({ alias: 'first', updatedAt: t - 100 });
    await client.publishDirectory(first);
    // Re-publishing the identical entry is a no-op.
    await client.publishDirectory(first);
    const second = a.sign({ alias: 'second', minPricePerHourZats: '70000000', updatedAt: t });
    await client.publishDirectory(second);
    await expect(client.publishDirectory(a.sign({ alias: 'older', updatedAt: t - 50 }))).rejects.toMatchObject({ status: 409, code: 'stale' });
    // A different entry with the same updatedAt does not replace it either...
    await expect(client.publishDirectory(a.sign({ alias: 'same-second', updatedAt: t }))).rejects.toMatchObject({ status: 409 });
    // ...and the engine's 409 recovery (stored updatedAt + 1) goes through.
    const bumped = a.sign({ alias: 'bumped', updatedAt: t + 1 });
    await client.publishDirectory(bumped);
    await client.publishDirectory(b.sign({ alias: 'other', updatedAt: t - 10 }));

    const list = (await client.listDirectory()) as DirectoryEntry[];
    expect(list).toHaveLength(2);
    expect(list.find((e) => e.providerId === a.providerId)).toEqual(bumped);
    expect(list.find((e) => e.providerId === b.providerId)?.alias).toBe('other');
    expect(list.every((e) => verifyDirectoryEntry(e))).toBe(true);

    const onDisk = JSON.parse(await readFile(join(dataDir, 'directory.json'), 'utf8')) as unknown[];
    expect(onDisk).toEqual(list);
    await close();
    const again = await start({ dataDir });
    expect(await again.client.listDirectory()).toEqual(list);
  });

  it('serves a signed entry exactly as it was published', async () => {
    const { client } = await start();
    const p = provider();
    const entry = p.sign({ bondZats: '500000000', region: 'eu' });
    await client.publishDirectory(entry);
    expect(await client.listDirectory()).toEqual([entry]);
  });

  it('rejects a forged signature', async () => {
    const { relay, client } = await start();
    const p = provider();
    const honest = p.sign();
    const forged = { ...honest, alias: 'forged', sig: 'ab'.repeat(64) };
    expect(await postEntry(relay, forged)).toMatchObject({ status: 400, body: { code: 'bad_signature' } });
    // A valid signature over different content does not carry over either.
    expect(await postEntry(relay, { ...honest, minPricePerHourZats: '1' })).toMatchObject({ status: 400, body: { code: 'bad_signature' } });
    const { sig: _sig, ...unsigned } = honest;
    expect(await postEntry(relay, unsigned)).toMatchObject({ status: 400, body: { code: 'bad_signature' } });
    // Fields the protocol does not know make the entry malformed, so it does not verify.
    expect(await postEntry(relay, { ...honest, extra: true })).toMatchObject({ status: 400, body: { code: 'bad_signature' } });
    expect(await client.listDirectory()).toEqual([]);
  });

  it("rejects someone else's signed entry with the providerId swapped", async () => {
    const { relay, client } = await start();
    const victim = provider();
    const attacker = provider();
    const signedByAttacker = attacker.sign({ alias: 'not-the-victim' });
    expect(await postEntry(relay, { ...signedByAttacker, providerId: victim.providerId })).toMatchObject({
      status: 400,
      body: { code: 'bad_signature' },
    });
    expect(await client.listDirectory()).toEqual([]);
  });

  it('rejects far-future and non-safe-integer updatedAt', async () => {
    const { relay, client } = await start();
    const p = provider();
    const day = 24 * 3600;
    for (const updatedAt of [nowS() + day + 120, Number.MAX_SAFE_INTEGER, 1e300, Number.MAX_SAFE_INTEGER + 2, 1.5, -1]) {
      // Validly signed by the provider itself: the timestamp alone is the problem.
      const r = await postEntry(relay, p.sign({ updatedAt }));
      expect(r, `updatedAt ${updatedAt}`).toMatchObject({ status: 400, body: { code: 'bad_entry' } });
    }
    expect(await postEntry(relay, { ...p.sign(), updatedAt: '1' })).toMatchObject({ status: 400, body: { code: 'bad_entry' } });
    expect(await client.listDirectory()).toEqual([]);
    // Up to 24 h of clock skew is fine.
    await client.publishDirectory(p.sign({ updatedAt: nowS() + 3600 }));
    expect(await client.listDirectory()).toHaveLength(1);
  });

  it('defeats the audit eviction exploit: the honest entry stays visible and updatable', async () => {
    const { relay, client } = await start({ observer: true });
    const victim = provider();
    const honest = victim.sign({ alias: 'honest-provider' });
    await client.publishDirectory(honest);

    const garbageSig = 'cd'.repeat(64);
    const attacks: unknown[] = [
      { ...honest, alias: 'evil', updatedAt: Number.MAX_SAFE_INTEGER, sig: garbageSig },
      { ...honest, alias: 'evil', updatedAt: 1e300, sig: garbageSig },
      { v: 1, providerId: victim.providerId, updatedAt: Number.MAX_SAFE_INTEGER },
      { ...provider().sign({ alias: 'evil', updatedAt: nowS() + 60 }), providerId: victim.providerId },
    ];
    for (const attack of attacks) expect((await postEntry(relay, attack)).status).toBe(400);
    expect(await client.listDirectory()).toEqual([honest]);

    // The provider's next routine publish still lands.
    const next = victim.sign({ alias: 'honest-provider', updatedAt: honest.updatedAt + 60 });
    await client.publishDirectory(next);
    expect(await client.listDirectory()).toEqual([next]);

    // Each rejection is visible to the observer with the providerId and reason only.
    const rejected = (await observations(relay)).filter((o) => o.event === 'directory-rejected');
    expect(rejected).toHaveLength(attacks.length);
    for (const o of rejected) {
      expect(o.fields.map((f) => f.label)).toEqual(['providerId', 'reason']);
      expect(o.fields[0]!.value).toBe(victim.providerId);
      expect(['bad_signature', 'bad_entry']).toContain(o.fields[1]!.value);
    }
  });

  it('drops invalid rows from directory.json on start', async () => {
    const dataDir = await tempDir();
    const good = provider().sign({ alias: 'good' });
    const victim = provider();
    const forged = { ...victim.sign(), updatedAt: Number.MAX_SAFE_INTEGER, sig: 'ef'.repeat(64) };
    const farFuture = provider().sign({ updatedAt: nowS() + 10 * 24 * 3600 });
    const huge = { ...provider().sign(), updatedAt: 1e300 };
    await writeFile(join(dataDir, 'directory.json'), JSON.stringify([good, forged, farFuture, huge, { junk: true }]));
    const { client, logs } = await start({ dataDir });
    expect(await client.listDirectory()).toEqual([good]);
    expect(JSON.parse(await readFile(join(dataDir, 'directory.json'), 'utf8'))).toEqual([good]);
    expect(logs.some((l) => l.includes('dropped 4 invalid'))).toBe(true);
  });

  it('rejects malformed bodies', async () => {
    const { relay } = await start();
    const post = (body: string) => status(`${relay.url}/directory`, { method: 'POST', body });
    expect(await post('not json')).toMatchObject({ status: 400, body: { code: 'bad_request' } });
    expect(await post('[]')).toMatchObject({ status: 400, body: { code: 'bad_request' } });
    expect(await post('null')).toMatchObject({ status: 400, body: { code: 'bad_request' } });
    expect(await post(JSON.stringify({ providerId: 'abc', updatedAt: 1 }))).toMatchObject({ status: 400, body: { code: 'bad_entry' } });
    expect(await post(JSON.stringify({ providerId: newProviderId().toUpperCase(), updatedAt: 1 }))).toMatchObject({ status: 400, body: { code: 'bad_entry' } });
    expect(await post(JSON.stringify({ providerId: newProviderId() }))).toMatchObject({ status: 400, body: { code: 'bad_entry' } });
  });
});

describe('CORS', () => {
  it('allows only the web terminal origins (port 7703) on GET /_observer, /directory and /health', async () => {
    const { relay } = await start({ observer: true });
    for (const path of ['/_observer', '/directory', '/health']) {
      for (const origin of ['http://localhost:7703', 'http://127.0.0.1:7703']) {
        const res = await fetch(`${relay.url}${path}`, { headers: { Origin: origin } });
        expect(res.status).toBe(200);
        expect(res.headers.get('access-control-allow-origin')).toBe(origin);
        await res.body?.cancel();
      }
      // Port 3000 belongs to an unrelated app; it is not the web terminal.
      for (const origin of ['http://evil.example', 'http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:7703.evil.example']) {
        const other = await fetch(`${relay.url}${path}`, { headers: { Origin: origin } });
        expect(other.headers.get('access-control-allow-origin')).toBeNull();
        await other.body?.cancel();
      }
    }
    const mb = await fetch(`${relay.url}/m/${newId()}?after=0`, { headers: { Origin: 'http://localhost:7703' } });
    expect(mb.headers.get('access-control-allow-origin')).toBeNull();
    await mb.body?.cancel();

    const pre = await fetch(`${relay.url}/_observer`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:7703', 'Access-Control-Request-Method': 'GET' },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('http://localhost:7703');
    expect(pre.headers.get('access-control-allow-methods')).toContain('GET');
  });
});

describe('observer feed', () => {
  it('is off unless enabled', async () => {
    const { relay } = await start();
    expect((await status(`${relay.url}/_observer`)).status).toBe(404);
  });

  it('records stores, fetches and directory traffic as relay observations', async () => {
    const { relay, client } = await start({ observer: true });
    const mb = newId();
    const body = randomBytes(100);
    await client.append(mb, body);
    await client.read(mb, 0); // one listing + one fetch
    const p = provider();
    const pid = p.providerId;
    await client.publishDirectory(p.sign());
    await client.listDirectory();

    await postEntry(relay, { ...p.sign(), sig: '11'.repeat(64) });
    const obs = await observations(relay);
    expect(obs.map((o) => o.event)).toEqual(['blob-stored', 'blob-fetched', 'directory-published', 'directory-read', 'directory-rejected']);
    expect(obs.map((o) => o.id)).toEqual(['relay-1', 'relay-2', 'relay-3', 'relay-4', 'relay-5']);
    const rejected = obs.pop()!;
    expect(rejected.fields).toEqual([
      { label: 'providerId', value: pid, readable: true, sensitive: false },
      { label: 'reason', value: 'bad_signature', readable: true, sensitive: false },
    ]);
    for (const o of obs) {
      expect(o.party).toBe('relay');
      expect(o.rfqId).toBeUndefined();
      expect(typeof o.at).toBe('number');
      const ip = o.fields.find((f) => f.label === 'client ip');
      expect(ip).toMatchObject({ value: '127.0.0.1', readable: true, sensitive: true });
    }
    const stored = obs[0]!;
    const field = (label: string) => stored.fields.find((f) => f.label === label);
    expect(field('mailbox')).toMatchObject({ value: mb, readable: true, sensitive: false });
    expect(field('size')?.value).toBe('100 bytes');
    expect(field('sha256')?.value).toMatch(/^[0-9a-f]{16}…$/);
    expect(field('first 24 bytes')).toMatchObject({ value: `${body.subarray(0, 24).toString('hex')}…`, readable: false });
    expect(obs[2]!.fields.find((f) => f.label === 'providerId')?.value).toBe(pid);
  });

  it('never exposes body bytes beyond the 24-byte prefix, in the feed or the logs', async () => {
    const { relay, client, logs } = await start({ observer: true });
    const MARKER = 'SILICR-PLAINTEXT-MARKER-7f3a9c';
    const m = Buffer.from(MARKER);
    const feedText = async () => (await fetch(`${relay.url}/_observer`)).text();
    const markerNeedles = [MARKER, m.toString('hex'), m.toString('base64'), m.toString('base64url')];

    // 1. A body with a random 24-byte prefix (like a sealed blob's nonce) and the marker after it.
    const prefix = randomBytes(24);
    const body = Buffer.concat([prefix, Buffer.from(`${MARKER} weights=llama-secret ${MARKER}`), randomBytes(64), m]);
    const mb = newId();
    await client.append(mb, body);
    await client.read(mb, 0);
    await client.read(mb, 0, 0.1);
    let feed = await feedText();
    const windows = Array.from({ length: body.length - 24 - 7 }, (_, i) => body.subarray(24 + i, 32 + i).toString('hex'));
    for (const needle of [...markerNeedles, body.toString('base64'), ...windows]) {
      expect(feed).not.toContain(needle);
      expect(logs.join('\n')).not.toContain(needle);
    }
    expect(feed).toContain(`${prefix.toString('hex')}…`);

    // 2. A body that starts with the marker: only its first 24 bytes may appear, as hex.
    const short = Buffer.from(`${MARKER}${MARKER}`);
    await client.append(mb, short);
    await client.read(mb, 1);
    feed = await feedText();
    expect(feed).toContain(`${short.subarray(0, 24).toString('hex')}…`);
    expect(feed).not.toContain(short.subarray(0, 25).toString('hex'));
    expect(feed).not.toContain(short.subarray(1, 26).toString('hex'));

    // 3. Directory traffic carrying the marker, valid and invalid, plus other error paths.
    const marked = provider();
    await client.publishDirectory(marked.sign({ alias: MARKER }));
    await postEntry(relay, { ...marked.sign({ alias: MARKER, updatedAt: nowS() + 5 }), sig: '00'.repeat(64) }); // rejected
    await postEntry(relay, { providerId: MARKER.repeat(3), alias: MARKER, updatedAt: 1 }); // rejected, providerId not hex
    await status(`${relay.url}/directory`, { method: 'POST', body: `{"alias":"${MARKER}", broken` });
    await status(`${relay.url}/m/${newId()}`, { method: 'PUT', body: new Uint8Array(17 * 1024 * 1024) });
    await status(`${relay.url}/m/NOT-AN-ID`, { method: 'PUT', body: MARKER });
    feed = await feedText();
    const logText = logs.join('\n');
    expect(logs.length).toBeGreaterThan(0);
    for (const needle of markerNeedles) {
      expect(feed).not.toContain(needle);
      expect(logText).not.toContain(needle);
    }

    // Body-derived values are limited to size, a hash prefix and the unreadable 24-byte prefix.
    const parsed = JSON.parse(feed) as RelayObserverResponse;
    expect(parsed.observations.length).toBeGreaterThan(0);
    for (const o of parsed.observations) {
      for (const f of o.fields) {
        if (f.label.startsWith('first ')) {
          expect(f.readable).toBe(false);
          expect(f.value.replace('…', '').length).toBeLessThanOrEqual(48);
        }
        expect(['mailbox', 'seq', 'size', 'sha256', 'first 24 bytes', 'client ip', 'time', 'providerId', 'entries', 'reason']).toContain(f.label);
        if (f.label === 'providerId') expect(f.value).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  it('supports after= cursors and keeps only the newest observations', async () => {
    const { relay, client } = await start({ observer: true, limits: { maxObservations: 10 } });
    for (let i = 0; i < 15; i++) await client.listDirectory();
    const all = await observations(relay);
    expect(all.map((o) => o.id)).toEqual(Array.from({ length: 10 }, (_, i) => `relay-${i + 6}`));
    expect((await observations(relay, 'relay-12')).map((o) => o.id)).toEqual(['relay-13', 'relay-14', 'relay-15']);
    expect((await observations(relay, '12')).map((o) => o.id)).toEqual(['relay-13', 'relay-14', 'relay-15']);
    expect(await observations(relay, 'relay-15')).toEqual([]);
    // A cursor from a previous relay run (larger than any id issued) returns what is retained.
    expect(await observations(relay, 'relay-999')).toHaveLength(10);
    expect((await status(`${relay.url}/_observer?after=bogus`)).status).toBe(400);
    const limited = (await status(`${relay.url}/_observer?limit=2`)).body as RelayObserverResponse;
    expect(limited.observations.map((o) => o.id)).toEqual(['relay-6', 'relay-7']);
  });
});

describe('client', () => {
  it('retries while the relay is unreachable', async () => {
    const dataDir = await tempDir();
    const first = await start({ dataDir });
    const port = Number(new URL(first.relay.url).port);
    await first.close();

    const client = relayClient(first.relay.url, { attempts: 8, backoffMs: 100 });
    const mb = newId();
    const pending = client.append(mb, Buffer.from('after restart'));
    await sleep(250);
    const second = await start({ dataDir, port });
    expect(await pending).toBe(1);
    expect((await second.client.read(mb, 0)).map((m) => Buffer.from(m.data).toString())).toEqual(['after restart']);
  });

  it('reports a network error once retries run out', async () => {
    const first = await start();
    const url = first.relay.url;
    await first.close();
    const client = relayClient(url, { attempts: 2, backoffMs: 10 });
    const err = await client.listDirectory().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect(err).toMatchObject({ status: 0, code: 'network' });
  });

  it('stops a read early once maxReadBytes is reached', async () => {
    const { relay, client } = await start();
    const mb = newId();
    for (let i = 0; i < 4; i++) await client.append(mb, new Uint8Array(1000));
    const small = relayClient(relay.url, { maxReadBytes: 2500 });
    const first = await small.read(mb, 0);
    expect(first.map((m) => m.seq)).toEqual([1, 2]);
    const rest = await small.read(mb, 2);
    expect(rest.map((m) => m.seq)).toEqual([3, 4]);
  });
});
