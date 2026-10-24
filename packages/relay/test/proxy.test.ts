/**
 * SOCKS5 / Tor support: the relay client's traffic goes through the proxy (destination sent as a
 * hostname, never resolved here), TLS still terminates at the server, and nothing ever falls back
 * to a direct connection. Uses the in-process SOCKS5 server from ./socks-server.ts.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RelayObserverResponse } from '@silicr/api';
import { ProxyError, RelayError, isLoopbackHost, parseProxyUrl, proxyFetch, relayClient, socksConnect, startRelay } from '../src/index.ts';
import { startSocksServer } from './socks-server.ts';

// A self-signed certificate for relay.test (test fixture only; P-256, valid to 2036).
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg+p4Ie3aT/yhv2+tG
yWRqgyV/PfwVnULCG0ljJiBs1SehRANCAAT4utFYGVhw9jxmL84YLUGoHNfOEIFQ
K0i4Wf806ne4nPj4qgjfJsY/UJqbG0VFOPrn1BnFbrALsg7qSWdjctsI
-----END PRIVATE KEY-----
`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBljCCATygAwIBAgIUYnTj3mydl0BfK1QdZoalysjLihswCgYIKoZIzj0EAwIw
FTETMBEGA1UEAwwKcmVsYXkudGVzdDAeFw0yNjEwMjExNzI4MDNaFw0zNjEwMTgx
NzI4MDNaMBUxEzARBgNVBAMMCnJlbGF5LnRlc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAT4utFYGVhw9jxmL84YLUGoHNfOEIFQK0i4Wf806ne4nPj4qgjfJsY/
UJqbG0VFOPrn1BnFbrALsg7qSWdjctsIo2owaDAdBgNVHQ4EFgQUY+4n4DR4mcq5
Epmb4teNSvRowYYwHwYDVR0jBBgwFoAUY+4n4DR4mcq5Epmb4teNSvRowYYwDwYD
VR0TAQH/BAUwAwEB/zAVBgNVHREEDjAMggpyZWxheS50ZXN0MAoGCCqGSM49BAMC
A0gAMEUCIQChIb60kKo1i7zNkZi7G7+oDR8jWSBXKi06iwS1FeYtJwIgem0UPvEV
VhE/m1uswt17+dMnkf7vfE2cGkE4CClmGGg=
-----END CERTIFICATE-----
`;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** A port nobody listens on. */
async function closedPort(): Promise<number> {
  const srv = createNetServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

/** A raw TCP server whose connections are destroyed on cleanup (an unread socket would block close()). */
async function rawServer(handler: (s: Socket) => void): Promise<number> {
  const conns = new Set<Socket>();
  const srv = createNetServer((s) => {
    conns.add(s);
    s.on('close', () => conns.delete(s));
    s.on('error', () => undefined);
    handler(s);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        for (const c of conns) c.destroy();
        srv.close(() => r());
      }),
  );
  return (srv.address() as AddressInfo).port;
}

const echoServer = () => rawServer((s) => s.pipe(s));

async function socks(targets: Record<string, number>, auth?: { username: string; password: string }) {
  const s = await startSocksServer({
    resolve: (host, port) => (host in targets && targets[host] === port ? { host: '127.0.0.1', port } : null),
    ...(auth ? { auth } : {}),
  });
  cleanups.push(() => s.close());
  return s;
}

async function relay() {
  const dataDir = await mkdtemp(join(tmpdir(), 'silicr-relay-proxy-'));
  const logs: string[] = [];
  const r = await startRelay({ port: 0, dataDir, observer: true, log: (l) => logs.push(l) });
  cleanups.push(async () => {
    await r.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { r, logs, port: Number(new URL(r.url).port) };
}

describe('parseProxyUrl', () => {
  it('accepts socks5h and socks5 urls and strips credentials from the shown url', () => {
    expect(parseProxyUrl('socks5h://127.0.0.1:9050')).toEqual({ kind: 'socks5', host: '127.0.0.1', port: 9050, url: 'socks5h://127.0.0.1:9050' });
    expect(parseProxyUrl('SOCKS5://tor.local/')).toMatchObject({ host: 'tor.local', port: 1080, url: 'socks5h://tor.local:1080' });
    expect(parseProxyUrl('socks5h://[::1]:9050')).toMatchObject({ host: '::1', port: 9050, url: 'socks5h://[::1]:9050' });
    const a = parseProxyUrl(' socks5h://silicr:isolation@127.0.0.1:9050 ');
    expect(a.auth).toEqual({ username: 'silicr', password: 'isolation' });
    expect(a.url).toBe('socks5h://127.0.0.1:9050');
  });

  it('refuses anything that is not SOCKS5 rather than ignoring it', () => {
    for (const bad of ['http://127.0.0.1:8118', 'socks4://127.0.0.1:1080', '127.0.0.1:9050', 'socks5h://:9050', 'socks5h://127.0.0.1:0', 'socks5h://127.0.0.1:9050/path', 'socks5h://x:99999']) {
      expect(() => parseProxyUrl(bad), bad).toThrow(ProxyError);
    }
    expect(() => parseProxyUrl('http://127.0.0.1:8118')).toThrow(/only SOCKS5/);
  });

  it('knows loopback hosts', () => {
    for (const h of ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ['relay.example', '10.0.0.1', '128.0.0.1', 'localhost.evil', '::2']) expect(isLoopbackHost(h), h).toBe(false);
  });
});

describe('socksConnect', () => {
  it('tunnels to the destination, sending the hostname for the proxy to resolve', async () => {
    const echo = await echoServer();
    const s = await socks({ 'echo.test': echo });
    const sock = await socksConnect(parseProxyUrl(s.url), { host: 'echo.test', port: echo });
    cleanups.push(() => {
      sock.destroy();
    });
    const reply = new Promise<string>((r) => sock.once('data', (d: Buffer) => r(d.toString())));
    sock.write('hello through socks');
    expect(await reply).toBe('hello through socks');
    expect(s.seen).toEqual([{ atyp: 'domain', host: 'echo.test', port: echo }]);
  });

  it('sends IP literals as addresses', async () => {
    const echo = await echoServer();
    const s = await socks({ '127.0.0.1': echo });
    const sock = await socksConnect(parseProxyUrl(s.url), { host: '127.0.0.1', port: echo });
    sock.destroy();
    expect(s.seen).toEqual([{ atyp: 'ipv4', host: '127.0.0.1', port: echo }]);
  });

  it('authenticates with username/password when the proxy asks', async () => {
    const echo = await echoServer();
    const s = await socks({ 'echo.test': echo }, { username: 'silicr', password: 'circuit-1' });
    const ok = await socksConnect(parseProxyUrl(`socks5h://silicr:circuit-1@127.0.0.1:${s.port}`), { host: 'echo.test', port: echo });
    ok.destroy();
    await expect(socksConnect(parseProxyUrl(`socks5h://silicr:wrong@127.0.0.1:${s.port}`), { host: 'echo.test', port: echo })).rejects.toMatchObject({ code: 'proxy_auth' });
    await expect(socksConnect(parseProxyUrl(s.url), { host: 'echo.test', port: echo })).rejects.toMatchObject({ code: 'proxy_auth' });
  });

  it('fails clearly when the proxy refuses, is unreachable or is not SOCKS5', async () => {
    const s = await socks({});
    await expect(socksConnect(parseProxyUrl(s.url), { host: 'nowhere.test', port: 443 })).rejects.toMatchObject({ code: 'proxy_refused' });
    await expect(socksConnect(parseProxyUrl(s.url), { host: 'nowhere.test', port: 443 })).rejects.toThrow(/host unreachable/);

    const dead = await closedPort();
    await expect(socksConnect(parseProxyUrl(`socks5h://127.0.0.1:${dead}`), { host: 'nowhere.test', port: 443 })).rejects.toMatchObject({ code: 'proxy_unreachable' });

    // A plain TCP service answering something else (an HTTP server, say) is not a SOCKS proxy.
    const notSocksPort = await rawServer((c) => c.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
    await expect(socksConnect(parseProxyUrl(`socks5h://127.0.0.1:${notSocksPort}`), { host: 'nowhere.test', port: 443 })).rejects.toMatchObject({ code: 'proxy_protocol' });

    // A proxy that accepts but never answers.
    const silentPort = await rawServer(() => undefined);
    await expect(socksConnect(parseProxyUrl(`socks5h://127.0.0.1:${silentPort}`), { host: 'nowhere.test', port: 443 }, { timeoutMs: 100 })).rejects.toMatchObject({ code: 'proxy_timeout' });
  });
});

describe('proxyFetch', () => {
  it('speaks https through the tunnel and still verifies the certificate', async () => {
    const srv = https.createServer({ key: TEST_KEY, cert: TEST_CERT }, (req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, host: req.headers.host, method: req.method, path: req.url }));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => new Promise<void>((r) => srv.close(() => r())));
    const port = (srv.address() as AddressInfo).port;
    const s = await socks({ 'relay.test': port });

    const f = proxyFetch(s.url, { tls: { ca: TEST_CERT } });
    const res = await f(`https://relay.test:${port}/health?x=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ ok: true, host: `relay.test:${port}`, method: 'GET', path: '/health?x=1' });
    expect(s.seen).toEqual([{ atyp: 'domain', host: 'relay.test', port }]);

    // Without the test CA the self-signed certificate is rejected: no silent downgrade.
    const strict = proxyFetch(s.url);
    await expect(strict(`https://relay.test:${port}/health`)).rejects.toMatchObject({ cause: { code: expect.stringMatching(/SELF_SIGNED/) } });
  });

  it('honours AbortSignal timeouts and rejects like fetch', async () => {
    const srv = http.createServer(() => undefined); // never answers
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => new Promise<void>((r) => srv.close(() => r())));
    const port = (srv.address() as AddressInfo).port;
    const s = await socks({ 'slow.test': port });
    const f = proxyFetch(s.url);
    await expect(f(`http://slow.test:${port}/`, { signal: AbortSignal.timeout(150) })).rejects.toMatchObject({ name: 'TimeoutError' });
    await expect(f('ftp://slow.test/')).rejects.toThrow(/unsupported protocol/);
  });
});

describe('relay client through a SOCKS5 proxy', () => {
  it('sends every request through the proxy, as a hostname, and the relay sees only the proxy', async () => {
    const { r, port } = await relay();
    const s = await socks({ 'relay.test': port });
    // relay.test does not resolve anywhere: the only way to reach the relay is through the proxy.
    const client = relayClient(`http://relay.test:${port}`, { proxy: s.url, backoffMs: 20 });
    const mb = randomBytes(16).toString('hex');
    const blob = randomBytes(300);
    expect(await client.append(mb, blob)).toBe(1);
    const got = await client.read(mb, 0);
    expect(got).toHaveLength(1);
    expect(Buffer.from(got[0]!.data).equals(blob)).toBe(true);
    expect(await client.listDirectory()).toEqual([]);

    expect(s.seen.length).toBeGreaterThan(0);
    for (const c of s.seen) expect(c).toEqual({ atyp: 'domain', host: 'relay.test', port });
    // Keep-alive: the whole exchange rode one tunnel rather than a circuit per request.
    expect(s.connections).toBe(1);

    // The relay's own observer feed (fetched directly, over loopback) saw the proxy's address.
    const obs = (await (await fetch(`${r.url}/_observer`)).json()) as RelayObserverResponse;
    const ips = obs.observations.flatMap((o) => o.fields.filter((f) => f.label === 'client ip').map((f) => f.value));
    expect(ips.length).toBeGreaterThan(0);
    for (const ip of ips) expect(ip).toBe('127.0.0.1');
  });

  it('never falls back to a direct connection when the proxy is down or refuses', async () => {
    const { r, logs, port } = await relay();
    const dead = await closedPort();
    const down = relayClient(`http://relay.test:${port}`, { proxy: `socks5h://127.0.0.1:${dead}`, attempts: 2, backoffMs: 10 });
    const err = await down.append(randomBytes(16).toString('hex'), Uint8Array.of(1)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect((err as RelayError).code).toBe('network');
    expect((err as RelayError).message).toMatch(/via SOCKS5 proxy socks5h:\/\/127\.0\.0\.1:\d+: SOCKS5 proxy .* is unreachable/);

    const refusing = await socks({});
    const refused = relayClient(`http://relay.test:${port}`, { proxy: refusing.url, attempts: 2, backoffMs: 10 });
    await expect(refused.listDirectory()).rejects.toThrow(/refused to connect to relay.test/);
    expect(refusing.seen).toHaveLength(2);

    // Nothing reached the relay, through any path.
    expect(logs).toEqual([]);
    expect(r.url).toMatch(/127\.0\.0\.1/);
  });

  it('connects directly to a loopback relay (nothing leaves the machine) and refuses fetch+proxy together', async () => {
    const { r } = await relay();
    const s = await socks({});
    const client = relayClient(r.url, { proxy: s.url, backoffMs: 20 });
    expect(await client.listDirectory()).toEqual([]);
    expect(s.seen).toEqual([]);
    expect(s.connections).toBe(0);
    expect(() => relayClient(r.url, { proxy: s.url, fetch })).toThrow(/either fetch or proxy/);
  });
});
