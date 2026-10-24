import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { createBase58check } from '@scure/base';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMemoryNetwork,
  decodeUnifiedAddress,
  encodeUnifiedAddress,
  InsufficientFundsError,
  isOrchardOnly,
  MEMO_SIZE,
  openBackend,
  PrivacyError,
  randomOrchardAddress,
  ZATS_PER_ZEC,
  type MemoryNetwork,
  type MemoryNetworkOptions,
  type PublicTxView,
  type ZecBackend,
} from '../src/index.ts';

const ZEC = ZATS_PER_ZEC;
const FEE = 5000n; // ZIP 317 marginal fee
const networks: MemoryNetwork[] = [];

/** A manual-mining network (blockTimeMs: 0) that is stopped after each test. */
function manual(opts: MemoryNetworkOptions = {}): MemoryNetwork {
  const net = createMemoryNetwork({ blockTimeMs: 0, ...opts });
  networks.push(net);
  return net;
}

afterEach(() => {
  for (const net of networks.splice(0)) net.stop();
  vi.useRealTimers();
});

/** A ZIP 302 arbitrary-data memo: 0xFF then random bytes. */
function binaryMemo(): Uint8Array {
  const memo = randomBytes(MEMO_SIZE);
  memo[0] = 0xff;
  return memo;
}

function textMemo(text: string): Uint8Array {
  const memo = new Uint8Array(MEMO_SIZE);
  memo.set(new TextEncoder().encode(text));
  return memo;
}

const json = (value: unknown) => JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));

async function pay(from: ZecBackend, to: ZecBackend | string, zats: bigint, memo = binaryMemo()) {
  return from.send([{ to: typeof to === 'string' ? to : await to.address(), zats, memo }]);
}

describe('memory network: wallets and funding', () => {
  it('reports the memory capabilities', () => {
    const w = manual().wallet('a');
    expect(w.network).toBe('memory');
    expect(w.capabilities).toEqual({
      binaryMemos: true,
      maxOutputsPerTx: 50,
      diversifiedAddresses: true,
      minOutputZats: 1n,
      mempoolNotes: true,
      inspectTx: true,
    });
    expect(Object.isFrozen(w.capabilities)).toBe(true);
    expect(typeof w.inspectTx).toBe('function');
  });

  it('funds a new wallet with one note, mined at once and immediately spendable', async () => {
    const net = manual();
    expect(net.height).toBe(0);
    const alice = net.wallet('alice', { fundZats: 2n * ZEC });
    expect(net.height).toBe(1);
    expect(await alice.height()).toBe(1);
    expect(await alice.balance()).toEqual({ spendable: 2n * ZEC, pending: 0n });
    const notes = await alice.poll(0);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ height: 1, zats: 2n * ZEC, toAddress: await alice.address(), pool: 'orchard', valuePool: 'ironwood' });
    expect(notes[0]!.memo[0]).toBe(0xf6); // ZIP 302 "no memo"
    expect(notes[0]!.memo.subarray(1).every((b) => b === 0)).toBe(true);
    expect(net.explorer()).toHaveLength(1);
    expect(net.explorer()[0]).toMatchObject({ height: 1, version: 6, feeZats: 2n * FEE, orchard: { actions: 0 }, ironwood: { actions: 2 } });
  });

  it('returns the same wallet by name; fundZats applies only on creation', async () => {
    const net = manual();
    const a = net.wallet('alice', { fundZats: ZEC });
    const again = net.wallet('alice', { fundZats: 5n * ZEC });
    expect(again).toBe(a);
    expect(await again.balance()).toEqual({ spendable: ZEC, pending: 0n });
    const bob = net.wallet('bob');
    expect(await bob.balance()).toEqual({ spendable: 0n, pending: 0n });
    expect(net.height).toBe(1); // no funding, no block
  });

  it('hands out Orchard-only uregtest addresses; address() is stable, newAddress() is fresh', async () => {
    const bob = manual().wallet('bob');
    const main = await bob.address();
    expect(main.startsWith('uregtest1')).toBe(true);
    expect(isOrchardOnly(main)).toBe(true);
    expect(decodeUnifiedAddress(main).network).toBe('regtest');
    expect(await bob.address()).toBe(main);
    const fresh = [await bob.newAddress(), await bob.newAddress(), await bob.newAddress()];
    expect(new Set([main, ...fresh]).size).toBe(4);
    for (const a of fresh) expect(isOrchardOnly(a)).toBe(true);
  });

  it('newAddress() strings differ but all reach the same wallet, each note naming its own address', async () => {
    const net = manual();
    const alice = net.wallet('alice', { fundZats: ZEC });
    const bob = net.wallet('bob');
    const [b1, b2] = [await bob.newAddress(), await bob.newAddress()];
    await alice.send([
      { to: b1, zats: 1000n, memo: textMemo('one') },
      { to: b2, zats: 2000n, memo: textMemo('two') },
    ]);
    net.mine();
    const notes = await bob.poll(0);
    expect(notes.map((n) => [n.toAddress, n.zats]).sort()).toEqual([[b1, 1000n], [b2, 2000n]].sort());
    expect(await bob.balance()).toEqual({ spendable: 3000n, pending: 0n });
  });

  it('reports toAddress exactly as handed out, however the sender wrote the address', async () => {
    const net = manual();
    const alice = net.wallet('alice', { fundZats: ZEC });
    const bob = net.wallet('bob');
    const handedOut = await bob.newAddress();
    const orchard = decodeUnifiedAddress(handedOut).receivers[0]!;
    const withSapling = encodeUnifiedAddress('regtest', [{ typecode: 2, kind: 'sapling', data: randomBytes(43) }, orchard]);
    await alice.send([
      { to: handedOut.toUpperCase(), zats: 10n, memo: binaryMemo() },
      { to: withSapling, zats: 20n, memo: binaryMemo() },
    ]);
    const notes = await bob.poll(0);
    expect(notes).toHaveLength(2);
    for (const n of notes) expect(n.toAddress).toBe(handedOut);
  });

  it('newAddress() falls back to address() when diversifiedAddresses is off', async () => {
    const bob = manual({ capabilities: { diversifiedAddresses: false } }).wallet('bob');
    expect(bob.capabilities.diversifiedAddresses).toBe(false);
    expect(await bob.newAddress()).toBe(await bob.address());
  });
});

describe('memory network: send and receive', () => {
  it('delivers memos byte for byte, through the mempool and into a block', async () => {
    const net = manual();
    const alice = net.wallet('alice', { fundZats: ZEC });
    const bob = net.wallet('bob');
    const memo = binaryMemo();
    const sent = new Uint8Array(memo);
    const { txid, feeZats } = await pay(alice, bob, 12_345n, memo);
    expect(txid).toMatch(/^[0-9a-f]{64}$/);
    expect(feeZats).toBe(2n * FEE);
    memo.fill(0); // the backend must have copied it

    const unconfirmed = await bob.poll(0);
    expect(unconfirmed).toHaveLength(1);
    expect(unconfirmed[0]).toMatchObject({
      txid,
      height: null,
      zats: 12_345n,
      toAddress: await bob.address(),
      pool: 'orchard',
      valuePool: 'ironwood',
    });
    expect(bytesToHex(unconfirmed[0]!.memo)).toBe(bytesToHex(sent));
    expect(await bob.balance()).toEqual({ spendable: 0n, pending: 12_345n });

    unconfirmed[0]!.memo.fill(1); // callers can't corrupt the chain either
    net.mine();
    const mined = await bob.poll(0);
    expect(mined).toHaveLength(1);
    expect(mined[0]).toMatchObject({ txid, index: unconfirmed[0]!.index, height: 2 });
    expect(bytesToHex(mined[0]!.memo)).toBe(bytesToHex(sent));
    expect(await bob.balance()).toEqual({ spendable: 12_345n, pending: 0n });
  });

  it('carries text memos too', async () => {
    const net = manual();
    const alice = net.wallet('alice', { fundZats: ZEC });
    const bob = net.wallet('bob');
    await pay(alice, bob, 1n, textMemo('slc1:hello'));
    const [note] = await bob.poll(0);
    expect(new TextDecoder().decode(note!.memo).replace(/\0+$/, '')).toBe('slc1:hello');
  });

  it('pays several outputs in one transaction, with ZIP 317 fees and change', async () => {
    const net = manual();
    const alice = net.wallet('alice', { fundZats: ZEC });
    const bob = net.wallet('bob');
    const carol = net.wallet('carol');
    const self = await alice.newAddress(); // a dummy padding output back to ourselves
    const { txid, feeZats } = await alice.send([
      { to: await bob.address(), zats: 10_000_000n, memo: binaryMemo() },
      { to: await carol.address(), zats: 20_000_000n, memo: binaryMemo() },
      { to: self, zats: 1_000n, memo: binaryMemo() },
    ]);
    // 1 spend, 3 outputs + change → 4 logical actions.
    expect(feeZats).toBe(4n * FEE);
    const change = ZEC - 30_001_000n - 4n * FEE;
    expect(await alice.balance()).toEqual({ spendable: 0n, pending: change + 1_000n });

    net.mine();
    expect(await alice.balance()).toEqual({ spendable: change + 1_000n, pending: 0n });
    expect((await bob.poll(0)).map((n) => n.zats)).toEqual([10_000_000n]);
    expect((await carol.poll(0)).map((n) => n.zats)).toEqual([20_000_000n]);

    // The sender sees its own dummy output, but never its change.
    const own = (await alice.poll(0)).filter((n) => n.txid === txid);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ toAddress: self, zats: 1_000n });

    const view = await alice.inspectTx!(txid);
    expect(view.ironwood!.actions).toBe(4);
    expect(view.feeZats).toBe(4n * FEE);
    const indexes = [...(await bob.poll(0)), ...(await carol.poll(0)), ...own].map((n) => n.index);
    expect(new Set(indexes).size).toBe(3);
    for (const i of indexes) expect(i >= 0 && i < 4).toBe(true);
  });

  it('spends several notes when it must, and pays for each spend', async () => {
    const net = manual();
    const alice = net.wallet('alice', { fundZats: ZEC });
    const bob = net.wallet('bob');
    const carol = net.wallet('carol');
    for (let i = 0; i < 3; i++) {
      await pay(alice, bob, 50_000n);
      net.mine(); // alice's change must confirm before she can spend again
    }
    expect(await bob.balance()).toEqual({ spendable: 150_000n, pending: 0n });
    const { txid, feeZats } = await pay(bob, carol, 120_000n);
    expect(feeZats).toBe(3n * FEE); // 3 spends > 2 outputs (payment + change)
    expect((await bob.inspectTx!(txid)).ironwood!.actions).toBe(3);
    net.mine();
    expect(await bob.balance()).toEqual({ spendable: 150_000n - 120_000n - 3n * FEE, pending: 0n });
    expect(await carol.balance()).toEqual({ spendable: 120_000n, pending: 0n });
  });

  it('omits the change output when the notes cover payment and fee exactly', async () => {
    const net = manual();
    const alice = net.wallet('alice', { fundZats: 50_000n });
    const bob = net.wallet('bob');
    const { feeZats } = await pay(alice, bob, 40_000n);
    expect(feeZats).toBe(2n * FEE);
    expect(await alice.balance()).toEqual({ spendable: 0n, pending: 0n });
  });

  it('honours marginalFeeZats', async () => {
    const net = manual({ marginalFeeZats: 1000n });
    const alice = net.wallet('alice', { fundZats: ZEC });
    expect((await pay(alice, net.wallet('bob'), 1n)).feeZats).toBe(2000n);
  });

  it('accepts maxOutputsPerTx (50) outputs in one transaction and refuses more', async () => {
    const net = manual();
    const alice = net.wallet('alice', { fundZats: ZEC });
    const bob = net.wallet('bob');
    const outputs = [];
    for (let i = 0; i < 50; i++) outputs.push({ to: await bob.newAddress(), zats: 1_000n, memo: binaryMemo() });
    const { txid, feeZats } = await alice.send(outputs);
    expect(feeZats).toBe(51n * FEE);
    expect((await alice.inspectTx!(txid)).ironwood!.actions).toBe(51);
    const notes = await bob.poll(0);
    expect(notes).toHaveLength(50);
    expect(new Set(notes.map((n) => n.toAddress)).size).toBe(50);
    expect(new Set(notes.map((n) => n.index)).size).toBe(50);
    net.mine();
    await expect(alice.send([...outputs, outputs[0]!])).rejects.toThrow(/at most 50 outputs/);
  });

  it('can simulate a single-output backend', async () => {
    const net = manual({ capabilities: { maxOutputsPerTx: 1 } });
    const alice = net.wallet('alice', { fundZats: ZEC });
    const out = { to: await net.wallet('bob').address(), zats: 1n, memo: binaryMemo() };
    await expect(alice.send([out, out])).rejects.toThrow(RangeError);
    await expect(alice.send([out])).resolves.toMatchObject({ feeZats: 2n * FEE });
  });

  it('can simulate a text-memo-only backend', async () => {
    const net = manual({ capabilities: { binaryMemos: false } });
    const alice = net.wallet('alice', { fundZats: ZEC });
    const bob = net.wallet('bob');
    await expect(pay(alice, bob, 1n, binaryMemo())).rejects.toThrow(/only text memos/);
    const invalidUtf8 = textMemo('x');
    invalidUtf8[1] = 0xc3; // truncated 2-byte sequence
    await expect(pay(alice, bob, 1n, invalidUtf8)).rejects.toThrow(/only text memos/);
    await expect(pay(alice, bob, 1n, textMemo('slc1:AAAA'))).resolves.toBeDefined();
  });
});

describe('memory network: refusals', () => {
  it('throws InsufficientFundsError, and changes nothing', async () => {
    const net = manual();
    const alice = net.wallet('alice', { fundZats: ZEC });
    const bob = net.wallet('bob');
    await expect(pay(alice, bob, ZEC)).rejects.toThrow(InsufficientFundsError); // fee on top
    await expect(pay(alice, bob, ZEC - 2n * FEE + 1n)).rejects.toThrow(InsufficientFundsError);
    expect(await alice.balance()).toEqual({ spendable: ZEC, pending: 0n });
    expect(net.explorer()).toHaveLength(1);
    await expect(pay(alice, bob, ZEC - 2n * FEE)).resolves.toBeDefined(); // exactly everything
  });

  it('needs a confirmation before change can be spent again', async () => {
    const net = manual();
    const alice = net.wallet('alice', { fundZats: ZEC });
    const bob = net.wallet('bob');
    await pay(alice, bob, 1_000n);
    const err = await pay(alice, bob, 1_000n).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsufficientFundsError);
    expect((err as Error).message).toMatch(/only 0 zats are spendable \(\d+ more are waiting for a confirmation\)/);
    net.mine();
    await expect(pay(alice, bob, 1_000n)).resolves.toBeDefined();
  });

  it('refuses non-Orchard recipients with PrivacyError, and sends nothing', async () => {
    const net = manual();
    const alice = net.wallet('alice', { fundZats: ZEC });
    const bob = net.wallet('bob');
    const bad = [
      createBase58check(sha256).encode(Uint8Array.from([0x1d, 0x25, ...randomBytes(20)])), // tm… transparent
      randomOrchardAddress('test'), // wrong network
      encodeUnifiedAddress('regtest', [{ typecode: 2, kind: 'sapling', data: randomBytes(43) }]), // no Orchard
      'definitely not an address',
    ];
    for (const to of bad) {
      await expect(alice.send([{ to, zats: 1_000n, memo: binaryMemo() }])).rejects.toThrow(PrivacyError);
      // One bad output poisons the whole transaction.
      await expect(
        alice.send([
          { to: await bob.address(), zats: 1_000n, memo: binaryMemo() },
          { to, zats: 1_000n, memo: binaryMemo() },
        ]),
      ).rejects.toThrow(PrivacyError);
    }
    expect(net.explorer()).toHaveLength(1);
    expect(await alice.balance()).toEqual({ spendable: ZEC, pending: 0n });
    expect(await bob.poll(0)).toEqual([]);
  });

  it('validates memos, values and the output list', async () => {
    const net = manual();
    const alice = net.wallet('alice', { fundZats: ZEC });
    const to = await net.wallet('bob').address();
    await expect(alice.send([])).rejects.toThrow(RangeError);
    await expect(alice.send([{ to, zats: 1n, memo: new Uint8Array(511) }])).rejects.toThrow(/exactly 512 bytes/);
    await expect(alice.send([{ to, zats: 1n, memo: new Uint8Array(513) }])).rejects.toThrow(/exactly 512 bytes/);
    await expect(alice.send([{ to, zats: 0n, memo: binaryMemo() }])).rejects.toThrow(/at least 1/);
    await expect(alice.send([{ to, zats: -5n, memo: binaryMemo() }])).rejects.toThrow(RangeError);
    await expect(alice.send([{ to, zats: 5 as unknown as bigint, memo: binaryMemo() }])).rejects.toThrow(TypeError);
    expect(net.explorer()).toHaveLength(1);
  });

  it('honours a custom minOutputZats', async () => {
    const net = manual({ capabilities: { minOutputZats: 0n } });
    const alice = net.wallet('alice', { fundZats: ZEC });
    await expect(pay(alice, net.wallet('bob'), 0n)).resolves.toBeDefined();
  });

  it('rejects calls on a closed handle; wallet() hands out a new one', async () => {
    const net = manual();
    const alice = net.wallet('alice', { fundZats: ZEC });
    const address = await alice.address();
    await alice.close();
    await expect(alice.balance()).rejects.toThrow(/closed/);
    const reopened = net.wallet('alice');
    expect(reopened).not.toBe(alice);
    expect(await reopened.address()).toBe(address);
    expect(await reopened.balance()).toEqual({ spendable: ZEC, pending: 0n });
  });
});

describe('memory network: poll()', () => {
  it('returns mined notes at height >= sinceHeight plus every unconfirmed note', async () => {
    const net = manual();
    const alice = net.wallet('alice', { fundZats: ZEC });
    const bob = net.wallet('bob');
    const heights: number[] = [];
    for (const zats of [1n, 2n, 3n]) {
      await pay(alice, bob, zats);
      net.mine();
      heights.push(net.height);
    }
    await pay(alice, bob, 4n); // stays in the mempool
    const [h1, h2, h3] = heights as [number, number, number];
    expect(h1 < h2 && h2 < h3).toBe(true);

    const view = async (since: number) => (await bob.poll(since)).map((n) => [n.zats, n.height]);
    expect(await view(0)).toEqual([[1n, h1], [2n, h2], [3n, h3], [4n, null]]);
    expect(await view(h2)).toEqual([[2n, h2], [3n, h3], [4n, null]]);
    expect(await view(h3 + 1)).toEqual([[4n, null]]);
    net.mine();
    expect(await view(h3 + 1)).toEqual([[4n, h3 + 1]]);
    expect(await view(h3 + 2)).toEqual([]);
  });

  it('keeps (txid, index) stable from mempool to block', async () => {
    const net = manual();
    const alice = net.wallet('alice', { fundZats: ZEC });
    const bob = net.wallet('bob');
    await alice.send([
      { to: await bob.address(), zats: 5n, memo: binaryMemo() },
      { to: await bob.newAddress(), zats: 6n, memo: binaryMemo() },
    ]);
    const key = (notes: Awaited<ReturnType<ZecBackend['poll']>>) => notes.map((n) => `${n.txid}:${n.index}:${n.zats}`).sort();
    const before = key(await bob.poll(0));
    net.mine();
    expect(key(await bob.poll(0))).toEqual(before);
  });

  it('hides unconfirmed notes when mempoolNotes is off', async () => {
    const net = manual({ capabilities: { mempoolNotes: false } });
    const alice = net.wallet('alice', { fundZats: ZEC });
    const bob = net.wallet('bob');
    await pay(alice, bob, 7n);
    expect(await bob.poll(0)).toEqual([]);
    expect(await bob.balance()).toEqual({ spendable: 0n, pending: 0n });
    expect((await alice.balance()).pending).toBeGreaterThan(0n); // the sender knows its own change
    net.mine();
    expect((await bob.poll(0)).map((n) => n.zats)).toEqual([7n]);
  });

  it('delays mempool visibility for other wallets by deliveryDelayMs', async () => {
    vi.useFakeTimers();
    const net = manual({ deliveryDelayMs: 500 });
    const alice = net.wallet('alice', { fundZats: ZEC });
    const bob = net.wallet('bob');
    await pay(alice, bob, 9n);
    expect(await bob.poll(0)).toEqual([]);
    expect((await bob.balance()).pending).toBe(0n);
    expect((await alice.balance()).pending).toBeGreaterThan(0n);
    vi.advanceTimersByTime(499);
    expect(await bob.poll(0)).toEqual([]);
    vi.advanceTimersByTime(1);
    expect((await bob.poll(0)).map((n) => [n.zats, n.height])).toEqual([[9n, null]]);

    await pay(net.wallet('carol', { fundZats: ZEC }), bob, 10n);
    net.mine(); // a mined transaction is visible to everyone at once
    expect((await bob.poll(0)).map((n) => n.zats)).toEqual([9n, 10n]);
  });
});

describe('memory network: inspectTx() and explorer()', () => {
  it('shows what a chain observer sees, and nothing private', async () => {
    const net = manual();
    const alice = net.wallet('alice', { fundZats: ZEC });
    const bob = net.wallet('bob');
    const to = await bob.newAddress();
    const memo = binaryMemo();
    const amount = 12_345_678n;
    const { txid, feeZats } = await alice.send([{ to, zats: amount, memo }]);
    const view = await alice.inspectTx!(txid);

    expect(Object.keys(view).sort()).toEqual([
      'feeZats',
      'height',
      'ironwood',
      'orchard',
      'sapling',
      'sizeBytes',
      'time',
      'transparent',
      'txid',
      'version',
    ]);
    expect(view).toEqual({
      txid,
      height: null,
      time: null,
      version: 6,
      sizeBytes: 9165, // 2 actions, in the Orchard bundle layout that Ironwood shares
      feeZats,
      transparent: { inputs: 0, outputs: 0 },
      sapling: { spends: 0, outputs: 0, valueBalanceZats: 0n },
      orchard: { actions: 0, valueBalanceZats: 0n, ciphertextSamples: [] }, // legacy pool: never used
      ironwood: { actions: 2, valueBalanceZats: feeZats, ciphertextSamples: view.ironwood!.ciphertextSamples },
    });
    expect(view.ironwood!.ciphertextSamples).toHaveLength(2);
    for (const sample of view.ironwood!.ciphertextSamples) expect(sample).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(view.ironwood!.ciphertextSamples).size).toBe(2);

    const text = json(view);
    const change = ZEC - amount - feeZats;
    for (const secret of [to, await alice.address(), await bob.address(), amount.toString(), change.toString(), ZEC.toString()]) {
      expect(text).not.toContain(secret);
    }
    const receiverHex = bytesToHex(decodeUnifiedAddress(to).receivers[0]!.data);
    expect(text).not.toContain(receiverHex);
    expect(text).not.toContain(receiverHex.slice(22)); // pk_d alone
    const memoHex = bytesToHex(memo);
    for (let i = 0; i + 16 <= memoHex.length; i += 16) expect(text).not.toContain(memoHex.slice(i, i + 16));

    net.mine();
    const mined = await bob.inspectTx!(txid); // any wallet can inspect any transaction
    expect(mined.height).toBe(net.height);
    expect(typeof mined.time).toBe('number');
    expect(mined.ironwood!.ciphertextSamples).toEqual(view.ironwood!.ciphertextSamples);
    await expect(bob.inspectTx!('00'.repeat(32))).rejects.toThrow(/unknown transaction/);
  });

  it('models Ironwood: every note is valuePool ironwood (pool orchard), every bundle is Ironwood', async () => {
    const net = manual();
    const alice = net.wallet('alice', { fundZats: ZEC });
    const bob = net.wallet('bob');
    await alice.send([
      { to: await bob.address(), zats: 5n, memo: binaryMemo() },
      { to: await alice.newAddress(), zats: 6n, memo: binaryMemo() }, // a self-send
    ]);
    const notes = [...(await alice.poll(0)), ...(await bob.poll(0))];
    expect(notes).toHaveLength(3); // funding, self-send, payment
    net.mine();
    notes.push(...(await alice.poll(0)), ...(await bob.poll(0)));
    for (const n of notes) expect([n.pool, n.valuePool]).toEqual(['orchard', 'ironwood']);
    for (const v of net.explorer()) {
      expect(v.version).toBe(6);
      expect(v.orchard).toEqual({ actions: 0, valueBalanceZats: 0n, ciphertextSamples: [] });
      expect(v.ironwood!.actions).toBeGreaterThanOrEqual(2);
      expect(v.ironwood!.valueBalanceZats).toBe(v.feeZats);
      expect(v.ironwood!.ciphertextSamples).toHaveLength(v.ironwood!.actions);
    }
  });

  it('grows the size with the action count', async () => {
    const net = manual();
    const alice = net.wallet('alice', { fundZats: ZEC });
    const to = await net.wallet('bob').address();
    const sizes: number[] = [];
    for (const n of [1, 3, 7]) {
      const { txid } = await alice.send(Array.from({ length: n }, () => ({ to, zats: 1n, memo: binaryMemo() })));
      sizes.push((await alice.inspectTx!(txid)).sizeBytes);
      net.mine();
    }
    expect(sizes[0]! < sizes[1]! && sizes[1]! < sizes[2]!).toBe(true);
  });

  it('lists every transaction in chain order, mempool last', async () => {
    const net = manual();
    const alice = net.wallet('alice', { fundZats: ZEC });
    const bob = net.wallet('bob');
    const first = await pay(alice, bob, 1n);
    const carol = net.wallet('carol', { fundZats: ZEC }); // a faucet block, mined before `first`
    net.mine();
    const second = await pay(carol, bob, 2n);
    const list: PublicTxView[] = net.explorer();
    expect(list.map((v) => v.height)).toEqual([1, 2, 3, null]);
    expect(list[2]!.txid).toBe(first.txid);
    expect(list[3]!.txid).toBe(second.txid);
    expect(json(list)).not.toContain(await bob.address());
  });
});

describe('memory network: blocks and timers', () => {
  it('blockTimeMs: 0 mines only on mine(), and creates no timer', async () => {
    vi.useFakeTimers();
    const net = manual();
    const alice = net.wallet('alice', { fundZats: ZEC });
    await pay(alice, net.wallet('bob'), 1n);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(net.height).toBe(1);
    net.mine();
    net.mine();
    expect(net.height).toBe(3);
    expect(await alice.height()).toBe(3);
  });

  it('mines on a timer, and stop() clears it', () => {
    vi.useFakeTimers();
    const net = createMemoryNetwork({ blockTimeMs: 1000 });
    networks.push(net);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(3_500);
    expect(net.height).toBe(3);
    net.mine(); // in addition to the timer
    expect(net.height).toBe(4);
    net.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(net.height).toBe(4);
    net.stop(); // idempotent
  });

  it('defaults to one block per second', () => {
    vi.useFakeTimers();
    const net = createMemoryNetwork();
    networks.push(net);
    vi.advanceTimersByTime(2_000);
    expect(net.height).toBe(2);
  });

  it('mines in the background with real timers, and leaves nothing running after stop()', async () => {
    const net = createMemoryNetwork({ blockTimeMs: 5 });
    networks.push(net);
    const alice = net.wallet('alice', { fundZats: ZEC });
    const bob = net.wallet('bob');
    await pay(alice, bob, 3n);
    await vi.waitFor(async () => expect((await bob.poll(0))[0]?.height).not.toBeNull(), { timeout: 2_000, interval: 5 });
    net.stop();
    const height = net.height;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(net.height).toBe(height);
  });

  it('validates its options', () => {
    expect(() => createMemoryNetwork({ blockTimeMs: -1 })).toThrow(RangeError);
    expect(() => createMemoryNetwork({ blockTimeMs: Number.NaN })).toThrow(RangeError);
    expect(() => createMemoryNetwork({ marginalFeeZats: 5000 as unknown as bigint })).toThrow(RangeError);
    expect(() => createMemoryNetwork({ deliveryDelayMs: -5 })).toThrow(RangeError);
    expect(() => createMemoryNetwork({ capabilities: { maxOutputsPerTx: 0 } })).toThrow(RangeError);
    expect(() => manual().wallet('')).toThrow(TypeError);
    expect(() => manual().wallet('x', { fundZats: -1n })).toThrow(RangeError);
  });
});

describe('memory network: determinism', () => {
  async function scenario(seed: string) {
    const net = manual({ seed });
    const alice = net.wallet('alice', { fundZats: ZEC });
    const bob = net.wallet('bob');
    const memo = new Uint8Array(MEMO_SIZE).fill(0xff);
    const sent = await alice.send([
      { to: await bob.address(), zats: 10n, memo },
      { to: await bob.newAddress(), zats: 20n, memo },
    ]);
    net.mine();
    return {
      addresses: [await alice.address(), await bob.address(), await bob.newAddress()],
      sent,
      notes: (await bob.poll(0)).map((n) => [n.txid, n.index, n.toAddress, n.zats]),
      explorer: net.explorer().map(({ time: _time, ...rest }) => rest),
    };
  }

  it('replays the same chain from the same seed', async () => {
    const a = await scenario('silicr-demo');
    expect(await scenario('silicr-demo')).toEqual(a);
    const other = await scenario('another seed');
    expect(other.addresses[0]).not.toBe(a.addresses[0]);
    expect(other.sent.txid).not.toBe(a.sent.txid);
  });
});

describe('openBackend', () => {
  it('opens (and funds) a memory wallet', async () => {
    const net = manual();
    const backend = await openBackend({ kind: 'memory', network: net, wallet: 'provider', fundZats: 5n * ZEC });
    expect(backend.network).toBe('memory');
    expect(await backend.balance()).toEqual({ spendable: 5n * ZEC, pending: 0n });
    expect(await openBackend({ kind: 'memory', network: net, wallet: 'provider' })).toBe(backend);
  });

  it('rejects unknown kinds', async () => {
    await expect(openBackend({ kind: 'mainnet' } as never)).rejects.toThrow(/unknown backend kind "mainnet"/);
  });
});
