/**
 * Testnet backend: everything that can be checked without a network, funds or the sidecar.
 * Parsing of zec-sidecar output, error mapping, config refusal (mainnet), and the send-path
 * privacy guard.
 */
import { describe, expect, it } from 'vitest';
import { InsufficientFundsError, MEMO_SIZE, PrivacyError, randomOrchardAddress, toOrchardOnly } from '../src/index.ts';
import {
  TESTNET_CAPABILITIES,
  TxNotKnownError,
  memoFromHex,
  parseFreshness,
  memoToHex,
  parseBalance,
  parseNote,
  parsePollResult,
  parseSendResult,
  parseTxView,
  prepareOutputs,
  resolveOptions,
  toError,
  zats,
  SidecarProtocolError,
} from '../src/testnet/index.ts';

// Real addresses produced by zec-sidecar (librustzcash) for this repo's testnet wallets.
const BUYER = 'utest1httsgu4zng6ywdzu9wahetvegs3f5lygju3m7qxu6qlht5k44gedr0cupnmg93hn4wkd202qjmlzf67n6rz3kytzxuqqqa2x4sxqvrj4';
const BUYER_DIVERSIFIED =
  'utest16c6xwdea76wwprsn98v723xm9rmka8tgk6smps0vpw9l8lyg6x4tqpdn8q6pjdnhyp5exvzw95y9qep6fj899x8t4wddjz2xjynqu29y';
// A zcash-devtool UA with Orchard + Sapling + P2PKH receivers, and its Orchard receiver alone as
// encoded by librustzcash. The TS guard must produce byte-identical output.
const FULL_UA =
  'utest1cc6xtxg57vq4ca6p8vej87zw03wph4jgg0z4z7ws620js6hgxx98xufcxkqeeeslysr8f9rzufqfnhtefjj93qa7pwnhfke9aqpxf95vsffm5jz0c0vvmejp6z5haegle7uxjtkhjfm69sttekp860q04xn8ugyeq5cyfz83g645ug9ys8xeu7cc7lf32lnxpwqve00vudshuumsnpn';
const FULL_UA_ORCHARD_ONLY =
  'utest1th74wdjrhclrr3klkgwzv63jhd224vvk0ta5h9urlwndm5pv2v29e2x8jgk5ekkk5e9w9me2k7yc7r8up8k2y866kwh03llcuctp0pdt';
const TADDR = 'tmWK81GXyxz8D259FJPkmfpdLXD32F741co';
const SAPLING = 'ztestsapling1v6wh0dawepflf7yx5722fr77yatrl22hmg0ffd2tdxfl9rr356fper8gznajnl6ww3tuj67zv60';

// `zec-sidecar inspect-tx 3229fe47…` against testnet.zec.rocks, 2026-10-01 (a public v6 Ironwood tx).
const INSPECT_3229 = {
  consensusBranchId: '37a5165b',
  expiryHeight: 4428018,
  feeZats: '15000',
  fullyShieldedOrchardProtocol: true,
  height: 4427819,
  ironwood: {
    actions: 3,
    ciphertextSamples: [
      '54a2e44f0c6d39ba4c8d781ce8cc154de18179700649d79ca3efd493125f9038',
      '29f4b16dab7cb5e1d3e309ad5865bf68932b4e131473c43f5f4c43d2c1907f9d',
      '430818d8683c34dd7fe9056c96a312ac8440532362f5606dbf2fd44feb87e980',
    ],
    valueBalanceZats: '15000',
  },
  orchard: { actions: 0, ciphertextSamples: [], valueBalanceZats: '0' },
  sapling: { outputs: 0, spends: 0, valueBalanceZats: '0' },
  sizeBytes: 12322,
  time: 1790856791,
  transparent: { coinbase: false, inputs: 0, outputs: 0 },
  txid: '3229fe47ebc9b381914dc964bc9603ec998bd86680e9097aaa4c0a847a01ccab',
  version: 6,
  source: 'wallet',
  complete: true,
  estimated: [],
};

// The same transaction as a compact-block view (what the sidecar builds when it holds no raw bytes).
const COMPACT_3229 = {
  ...INSPECT_3229,
  feeZats: null,
  expiryHeight: null,
  consensusBranchId: null,
  ironwood: { ...INSPECT_3229.ironwood, valueBalanceZats: '0' },
  source: 'compact-block',
  complete: false,
  estimated: ['sizeBytes', 'version', 'feeZats', 'valueBalances', 'expiryHeight', 'consensusBranchId'],
};

function memo(fill: number, prefix = [0xff]): Uint8Array {
  const m = new Uint8Array(MEMO_SIZE).fill(fill);
  m.set(prefix, 0);
  return m;
}

describe('guard interop with librustzcash', () => {
  it('sidecar addresses are already canonical Orchard-only UAs', () => {
    expect(toOrchardOnly(BUYER, 'test')).toBe(BUYER);
    expect(toOrchardOnly(BUYER_DIVERSIFIED, 'test')).toBe(BUYER_DIVERSIFIED);
  });
  it('strips a full UA to exactly the encoding librustzcash produces', () => {
    expect(toOrchardOnly(FULL_UA, 'test')).toBe(FULL_UA_ORCHARD_ONLY);
  });
});

describe('prepareOutputs (send-path privacy guard)', () => {
  const good = { to: BUYER, zats: 1000n, memo: memo(0) };

  it('passes Orchard-only recipients and hex-encodes memos', () => {
    const [o] = prepareOutputs([good], toOrchardOnly);
    expect(o).toEqual({ to: BUYER, zats: '1000', memoHex: memoToHex(good.memo) });
  });
  it('reduces a full UA to its Orchard receiver', () => {
    const [o] = prepareOutputs([{ ...good, to: FULL_UA }], toOrchardOnly);
    expect(o?.to).toBe(FULL_UA_ORCHARD_ONLY);
  });
  it('refuses transparent and Sapling recipients with PrivacyError', () => {
    expect(() => prepareOutputs([{ ...good, to: TADDR }], toOrchardOnly)).toThrow(PrivacyError);
    expect(() => prepareOutputs([{ ...good, to: SAPLING }], toOrchardOnly)).toThrow(PrivacyError);
    // One bad output poisons the whole transaction.
    expect(() => prepareOutputs([good, { ...good, to: TADDR }], toOrchardOnly)).toThrow(PrivacyError);
  });
  it('refuses wrong-network addresses', () => {
    expect(() => prepareOutputs([{ ...good, to: randomOrchardAddress('main') }], toOrchardOnly)).toThrow(PrivacyError);
    expect(() => prepareOutputs([{ ...good, to: randomOrchardAddress('regtest') }], toOrchardOnly)).toThrow(PrivacyError);
  });
  it('validates counts, amounts and memo size', () => {
    expect(() => prepareOutputs([], toOrchardOnly)).toThrow(RangeError);
    const many = Array.from({ length: TESTNET_CAPABILITIES.maxOutputsPerTx + 1 }, () => good);
    expect(() => prepareOutputs(many, toOrchardOnly)).toThrow(RangeError);
    expect(() => prepareOutputs([{ ...good, zats: 0n }], toOrchardOnly)).toThrow(RangeError);
    expect(() => prepareOutputs([{ ...good, zats: 1 as unknown as bigint }], toOrchardOnly)).toThrow(RangeError);
    expect(() => prepareOutputs([{ ...good, memo: new Uint8Array(511) }], toOrchardOnly)).toThrow(RangeError);
  });
  it('always calls the guard with the testnet network', () => {
    const seen: string[] = [];
    prepareOutputs([good], (a, n) => {
      seen.push(n);
      return a;
    });
    expect(seen).toEqual(['test']);
  });
});

describe('resolveOptions', () => {
  it('applies defaults', () => {
    const o = resolveOptions({ kind: 'testnet', dataDir: '/tmp/w' });
    expect(o.server).toBe('testnet.zec.rocks:443');
    expect(o.create).toBe(true);
    expect(o.sidecarPath).toMatch(/zec-sidecar\/target\/release\/zec-sidecar$/);
    expect(o.guard).toBe(toOrchardOnly);
    expect(o.targetNoteCount).toBe(4);
    expect(resolveOptions({ kind: 'testnet', dataDir: '/tmp/w', targetNoteCount: 1 }).targetNoteCount).toBe(1);
  });
  it('selects the network explicitly and never defaults to mainnet', () => {
    // The old spelling is testnet, and refuses to be talked into mainnet.
    expect(() => resolveOptions({ kind: 'testnet', dataDir: '/tmp/w', network: 'main' })).toThrow(/use \{ kind: 'sidecar', network: 'main' \} for mainnet/);
    expect(resolveOptions({ kind: 'testnet', dataDir: '/tmp/w' }).network).toBe('test');
    // kind 'sidecar' needs an explicit network; which chain a server serves is checked by the sidecar, not guessed from its name.
    const main = resolveOptions({ kind: 'sidecar', network: 'main', dataDir: '/tmp/w' });
    expect(main.network).toBe('main');
    expect(main.server).toBe('zec.rocks:443');
    expect(resolveOptions({ kind: 'sidecar', network: 'test', dataDir: '/tmp/w' }).server).toBe('testnet.zec.rocks:443');
    expect(resolveOptions({ kind: 'sidecar', network: 'main', dataDir: '/tmp/w', server: 'lwd.example:9067' }).server).toBe('lwd.example:9067');
    for (const network of [undefined, 'regtest', 'memory', 'mainnet']) {
      expect(() => resolveOptions({ kind: 'sidecar', network: network as never, dataDir: '/tmp/w' })).toThrow(/network must be 'main' or 'test'/);
    }
  });
  it('type-checks options', () => {
    expect(() => resolveOptions({ kind: 'testnet', dataDir: '' })).toThrow(TypeError);
    expect(() => resolveOptions({ kind: 'testnet', dataDir: '/tmp/w', create: 'yes' })).toThrow(TypeError);
    expect(() => resolveOptions({ kind: 'testnet', dataDir: '/tmp/w', minSplitZats: 5 })).toThrow(TypeError);
    expect(() => resolveOptions({ kind: 'testnet', dataDir: '/tmp/w', targetNoteCount: 0 })).toThrow(TypeError);
    expect(() => resolveOptions({ kind: 'testnet', dataDir: '/tmp/w', targetNoteCount: 2.5 })).toThrow(TypeError);
  });
});

describe('parsing zec-sidecar output', () => {
  const noteJson = {
    txid: 'aa'.repeat(32),
    index: 1,
    height: 4427000,
    toAddress: BUYER,
    zats: '12345',
    memoHex: memoToHex(memo(7)),
    pool: 'orchard',
    valuePool: 'ironwood',
    source: 'wallet',
  };

  it('parses notes into contract types', () => {
    const n = parseNote(noteJson);
    expect(n.zats).toBe(12345n);
    expect(n.memo).toEqual(memo(7));
    expect(n.pool).toBe('orchard');
    expect(n.valuePool).toBe('ironwood');
    expect(parsePollResult({ notes: [noteJson, { ...noteJson, index: 2, height: null, source: 'mempool' }] })[1]?.height).toBeNull();
  });
  it('pads a memo the sidecar reports without its null padding (never drops a note for memo length)', () => {
    // librustzcash's MemoBytes::as_slice() strips trailing zeros: a mempool note's memo came back short.
    const frame = new Uint8Array([0xff, ...new TextEncoder().encode('SLC1\x01\x04 short')]);
    const n = parseNote({ ...noteJson, memoHex: Buffer.from(frame).toString('hex') });
    expect(n.memo.length).toBe(MEMO_SIZE);
    expect(n.memo.subarray(0, frame.length)).toEqual(frame);
    expect(n.memo.subarray(frame.length).every((b) => b === 0)).toBe(true);
    expect(memoFromHex('')).toEqual(new Uint8Array(MEMO_SIZE));
    const empty = new Uint8Array(MEMO_SIZE);
    empty[0] = 0xf6;
    expect(memoFromHex('f6')).toEqual(empty); // the ZIP 302 "no memo" marker, as the wallet DB stores it

    const batch = parsePollResult({ notes: [{ ...noteJson, memoHex: 'ff' }, noteJson] });
    expect(batch).toHaveLength(2);
    expect(batch[0]!.memo[0]).toBe(0xff);
    // Longer than a memo field is the only malformed case.
    expect(() => memoFromHex('00'.repeat(MEMO_SIZE + 1))).toThrow(SidecarProtocolError);
  });
  it('reads the freshness of an answer (absent on older sidecars = fresh)', () => {
    expect(parseFreshness({ notes: [] })).toEqual({ stale: false, syncError: null, syncAgeMs: null, tip: null });
    expect(parseFreshness({ notes: [], tip: 10, stale: true, syncError: 'GetLatestBlock: connection reset', syncAgeMs: 1234 })).toEqual({
      stale: true,
      syncError: 'GetLatestBlock: connection reset',
      syncAgeMs: 1234,
      tip: 10,
    });
    expect(parseFreshness({ height: 5, stale: false, syncError: null, syncAgeMs: 0 }).stale).toBe(false);
    expect(() => parseFreshness(null)).toThrow(SidecarProtocolError);
  });
  it('rejects malformed notes', () => {
    expect(() => parseNote({ ...noteJson, memoHex: '00'.repeat(MEMO_SIZE + 1) })).toThrow(SidecarProtocolError);
    expect(() => parseNote({ ...noteJson, txid: 'xyz' })).toThrow(SidecarProtocolError);
    expect(() => parseNote({ ...noteJson, zats: 1.5 })).toThrow(SidecarProtocolError);
    expect(() => parseNote({ ...noteJson, valuePool: 'sapling' })).toThrow(SidecarProtocolError);
    // valuePool is mandatory from the testnet backend: every note says which pool it is in.
    expect(() => parseNote({ ...noteJson, valuePool: undefined })).toThrow(SidecarProtocolError);
    expect(() => parsePollResult({})).toThrow(SidecarProtocolError);
  });
  it('round-trips binary memos byte for byte', () => {
    const m = new Uint8Array(MEMO_SIZE);
    for (let i = 0; i < MEMO_SIZE; i++) m[i] = (i * 37 + 0xff) & 0xff;
    expect(memoFromHex(memoToHex(m))).toEqual(m);
    expect(() => memoToHex(new Uint8Array(10))).toThrow(TypeError);
  });
  it('parses balances (decimal strings → bigint)', () => {
    const b = parseBalance({
      spendable: '100000000',
      pending: '5',
      mempoolIncoming: '5',
      legacyOrchard: { spendable: '1', changePending: '0', valuePending: '2' },
      synced: true,
    });
    expect(b).toEqual({ spendable: 100000000n, pending: 5n, mempoolIncoming: 5n, legacyOrchardZats: 3n, synced: true });
    expect(zats('18446744073709551615')).toBe(18446744073709551615n);
    expect(() => zats('1e3')).toThrow(SidecarProtocolError);
  });
  it('parses send results', () => {
    const r = parseSendResult({
      txid: 'bb'.repeat(32),
      feeZats: '15000',
      actions: 3,
      proposeMs: 10,
      proveMs: 2000,
      broadcastMs: 300,
      expiryHeight: 4428100,
    });
    expect(r.feeZats).toBe(15000n);
    expect(r.txid).toBe('bb'.repeat(32));
  });
  it('parses a real public testnet transaction view', () => {
    const v = parseTxView(INSPECT_3229);
    expect(v.version).toBe(6);
    expect(v.feeZats).toBe(15000n);
    expect(v.transparent).toEqual({ inputs: 0, outputs: 0 });
    expect(v.sapling).toEqual({ spends: 0, outputs: 0, valueBalanceZats: 0n });
    expect(v.orchard.actions).toBe(0);
    expect(v.ironwood.actions).toBe(3);
    expect(v.ironwood.valueBalanceZats).toBe(15000n);
    expect(v.ironwood.ciphertextSamples).toHaveLength(3);
    expect(v.fullyShieldedOrchardProtocol).toBe(true);
    expect(v.coinbase).toBe(false);
    expect(v).toMatchObject({ source: 'wallet', complete: true, estimated: [], expiryHeight: 4428018, consensusBranchId: '37a5165b' });
  });
  it('parses a compact-block view and says what it cannot know', () => {
    const v = parseTxView(COMPACT_3229);
    expect(v).toMatchObject({ source: 'compact-block', complete: false, feeZats: null, expiryHeight: null, consensusBranchId: null });
    expect(v.estimated).toEqual(['sizeBytes', 'version', 'feeZats', 'valueBalances', 'expiryHeight', 'consensusBranchId']);
    // Counts and ciphertext samples are exact even from compact data.
    expect(v.ironwood.actions).toBe(3);
    expect(v.ironwood.ciphertextSamples).toEqual(INSPECT_3229.ironwood.ciphertextSamples);
    expect(v.sizeBytes).toBe(12322);
  });
  it('rejects unknown view sources and estimated fields', () => {
    expect(() => parseTxView({ ...INSPECT_3229, source: 'server' })).toThrow(SidecarProtocolError);
    expect(() => parseTxView({ ...INSPECT_3229, estimated: ['everything'] })).toThrow(SidecarProtocolError);
  });
  it('maps sidecar errors to contract errors', () => {
    expect(toError('send', { code: 'PrivacyError', message: 'no' })).toBeInstanceOf(PrivacyError);
    expect(toError('send', { code: 'InsufficientFunds', message: 'short' })).toBeInstanceOf(InsufficientFundsError);
    expect(toError('inspectTx', { code: 'TxNotKnown', message: 'unknown' })).toBeInstanceOf(TxNotKnownError);
    const other = toError('poll', { code: 'Internal', message: 'boom' });
    expect(other).not.toBeInstanceOf(PrivacyError);
    expect(other.message).toBe('poll: boom');
  });
});

describe('capabilities', () => {
  it('match what the sidecar implements', () => {
    expect(TESTNET_CAPABILITIES).toEqual({
      binaryMemos: true,
      maxOutputsPerTx: 40,
      diversifiedAddresses: true,
      minOutputZats: 1n,
      mempoolNotes: true,
      inspectTx: true,
    });
    expect(Object.isFrozen(TESTNET_CAPABILITIES)).toBe(true);
  });
});
