/**
 * MemoryNetwork: an in-process simulated Zcash chain. Payments go to Orchard
 * receivers and, as on testnet since NU6.3 (Ironwood), the value lives in the
 * Ironwood pool. Nothing ever touches the legacy Orchard pool, which is
 * withdraw-only through a turnstile that publishes amounts.
 *
 * Faithful where callers could otherwise come to depend on behaviour a real
 * wallet doesn't have:
 * - Notes are spendable after 1 confirmation; change is pending until mined.
 * - ZIP 317 fees: marginal fee × max(2, logical actions), where the logical
 *   actions are the Ironwood actions: max(notes spent, outputs including change).
 * - Bundles are padded to at least 2 actions and the outputs are placed at
 *   random action positions, as the builder does: an output's `index`
 *   is NOT its position in the outputs[] passed to send().
 * - Change goes to an internal address, so poll() never reports it.
 * - Unmined transactions are mempool entries: poll() reports their notes with
 *   height null (after deliveryDelayMs), and the next block mines all of them.
 * - Funding (wallet(name, { fundZats })) is a faucet payment mined at once in a
 *   block of its own, so the new wallet can spend immediately.
 * - inspectTx() shows only what a chain observer sees: a v6 transaction whose
 *   actions are all in the Ironwood bundle (the legacy Orchard bundle is
 *   empty), and no amounts or recipients.
 * - Received notes report pool 'orchard' (the receiver type they were paid to)
 *   and valuePool 'ironwood' (where the value lives).
 */
import { blake2b } from '@noble/hashes/blake2.js';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import {
  InsufficientFundsError,
  MEMO_SIZE,
  ZATS_PER_ZEC,
  type BackendCapabilities,
  type Balance,
  type MemoryNetwork,
  type MemoryNetworkOptions,
  type Output,
  type PublicTxView,
  type ReceivedNote,
  type SendResult,
  type ZecBackend,
  type Zats,
} from './contract.ts';
import { toOrchardOnly } from './guard.ts';
import { randomOrchardReceiver } from './pallas.ts';
import { TYPECODE_ORCHARD, decodeUnifiedAddress, encodeUnifiedAddress } from './ua.ts';

const MAX_MONEY = 21_000_000n * ZATS_PER_ZEC;
/** ZIP 317 grace_actions; also the minimum number of actions in a bundle (padding). */
const GRACE_ACTIONS = 2;
/** ZIP 302 "no memo": 0xF6 followed by 511 zero bytes. Used for change and faucet notes. */
const EMPTY_MEMO: Uint8Array = (() => {
  const memo = new Uint8Array(MEMO_SIZE);
  memo[0] = 0xf6;
  return memo;
})();

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (ch) => ch.charCodeAt(0));
const SEED_PERSONALIZATION = ascii('Silicr_MemSeed__');
const SAMPLE_PERSONALIZATION = ascii('Silicr_ct_sample');

type Random = (length: number) => Uint8Array;

function seededRandom(seed: string | Uint8Array): Random {
  const seedBytes = typeof seed === 'string' ? new TextEncoder().encode(seed) : new Uint8Array(seed);
  const key = blake2b(seedBytes, { dkLen: 32, personalization: SEED_PERSONALIZATION });
  let counter = 0;
  return (length) => {
    const out = new Uint8Array(length);
    const block = new Uint8Array(8);
    for (let offset = 0; offset < length; offset += 64) {
      new DataView(block.buffer).setBigUint64(0, BigInt(counter++), true);
      out.set(blake2b(block, { key, dkLen: 64 }).subarray(0, Math.min(64, length - offset)), offset);
    }
    return out;
  };
}

/** Uniform integer in [0, n) by rejection sampling. */
function randomInt(random: Random, n: number): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  for (;;) {
    const b = random(4);
    const v = (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0;
    if (v < limit) return v % n;
  }
}

function compactSizeLength(n: number): number {
  return n < 0xfd ? 1 : n <= 0xffff ? 3 : 5;
}

/**
 * Estimated serialized size of a transaction whose only shielded bundle has `actions` actions.
 * Ironwood actions use the Orchard Action structure (ZIP 317 Revision 1), so this follows the
 * v5 Orchard bundle layout; the v6 envelope (ZIP 229) is not modelled byte for byte.
 */
function txSizeFor(actions: number): number {
  const header = 4 * 5; // header, nVersionGroupId, nConsensusBranchId, nLockTime, nExpiryHeight
  const transparent = 1 + 1; // empty vin and vout
  const sapling = 1 + 1; // nSpendsSapling = nOutputsSapling = 0
  const proof = 2720 + 2272 * actions; // Halo 2 proof size for `actions` actions
  const actionSize = 32 + 32 + 32 + 32 + 32 + 580 + 80; // cv, nf, rk, cmx, epk, encCiphertext, outCiphertext
  const bundle =
    compactSizeLength(actions) + actions * actionSize + 1 + 8 + 32 + compactSizeLength(proof) + proof + actions * 64 + 64;
  return header + transparent + sapling + bundle;
}

/** ZIP 302 text memo (UTF-8, zero padded) or the "no memo" marker. */
function isTextMemo(memo: Uint8Array): boolean {
  if (memo[0] === 0xf6) return memo.every((b, i) => i === 0 || b === 0);
  if (memo[0]! > 0xf4) return false;
  let end = memo.length;
  while (end > 0 && memo[end - 1] === 0) end--;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(memo.subarray(0, end));
    return true;
  } catch {
    return false;
  }
}

interface WalletState {
  readonly name: string;
  readonly address: string;
  /** Notes this wallet owns: received ones and its own change. */
  readonly notes: NoteState[];
  handle: ZecBackend | null;
}

interface TxState {
  readonly seq: number;
  readonly txid: string;
  /** null: the faucet. */
  readonly sender: WalletState | null;
  /** When other wallets learn of it while it is unmined. */
  readonly visibleAtMs: number;
  readonly fee: Zats;
  readonly actions: number;
  readonly sizeBytes: number;
  readonly ciphertextSamples: readonly string[];
  height: number | null;
  time: number | null;
}

interface NoteState {
  readonly tx: TxState;
  readonly index: number;
  /** The external address it was paid to, exactly as handed out; null for change (internal address). */
  readonly toAddress: string | null;
  readonly zats: Zats;
  readonly memo: Uint8Array;
  spentBy: TxState | null;
}

const byChainOrder = (a: TxState, b: TxState): number =>
  (a.height ?? Number.POSITIVE_INFINITY) - (b.height ?? Number.POSITIVE_INFINITY) || a.seq - b.seq;

const sumZats = (notes: readonly NoteState[]): Zats => notes.reduce((total, n) => total + n.zats, 0n);

function resolveCapabilities(overrides: MemoryNetworkOptions['capabilities']): BackendCapabilities {
  const caps: BackendCapabilities = {
    binaryMemos: overrides?.binaryMemos ?? true,
    maxOutputsPerTx: overrides?.maxOutputsPerTx ?? 50,
    diversifiedAddresses: overrides?.diversifiedAddresses ?? true,
    minOutputZats: overrides?.minOutputZats ?? 1n,
    mempoolNotes: overrides?.mempoolNotes ?? true,
    inspectTx: true,
  };
  if (!Number.isInteger(caps.maxOutputsPerTx) || caps.maxOutputsPerTx < 1) {
    throw new RangeError('capabilities.maxOutputsPerTx must be an integer >= 1');
  }
  if (typeof caps.minOutputZats !== 'bigint' || caps.minOutputZats < 0n) {
    throw new RangeError('capabilities.minOutputZats must be a bigint >= 0n');
  }
  return Object.freeze(caps);
}

export function createMemoryNetwork(opts: MemoryNetworkOptions = {}): MemoryNetwork {
  const blockTimeMs = opts.blockTimeMs ?? 1000;
  const marginalFee = opts.marginalFeeZats ?? 5000n;
  const deliveryDelayMs = opts.deliveryDelayMs ?? 0;
  if (typeof blockTimeMs !== 'number' || !Number.isFinite(blockTimeMs) || blockTimeMs < 0) {
    throw new RangeError('blockTimeMs must be a finite number >= 0 (0 = mine only via mine())');
  }
  if (typeof marginalFee !== 'bigint' || marginalFee < 0n) throw new RangeError('marginalFeeZats must be a bigint >= 0n');
  if (typeof deliveryDelayMs !== 'number' || !Number.isFinite(deliveryDelayMs) || deliveryDelayMs < 0) {
    throw new RangeError('deliveryDelayMs must be a finite number >= 0');
  }
  const capabilities = resolveCapabilities(opts.capabilities);
  const random: Random = opts.seed === undefined ? (n) => randomBytes(n) : seededRandom(opts.seed);

  let tip = 0;
  let seq = 0;
  let mempool: TxState[] = [];
  const txs: TxState[] = [];
  const txById = new Map<string, TxState>();
  const wallets = new Map<string, WalletState>();
  /** hex(43-byte Orchard receiver) → the wallet and the exact address string handed out for it. */
  const receivers = new Map<string, { wallet: WalletState; address: string }>();

  const feeFor = (spends: number, outputs: number): Zats =>
    marginalFee * BigInt(Math.max(GRACE_ACTIONS, spends, outputs));

  function sealBlock(included: readonly TxState[]): void {
    tip += 1;
    const time = Math.floor(Date.now() / 1000);
    for (const tx of included) {
      tx.height = tip;
      tx.time = time;
    }
  }

  function mine(): void {
    const included = mempool;
    mempool = [];
    sealBlock(included);
  }

  /** A fresh Orchard-only regtest UA for a receiver not yet used on this network. */
  function mintAddress(): { key: string; address: string } {
    for (;;) {
      const receiver = randomOrchardReceiver(random);
      const key = bytesToHex(receiver);
      if (receivers.has(key)) continue;
      return { key, address: encodeUnifiedAddress('regtest', [{ typecode: TYPECODE_ORCHARD, kind: 'orchard', data: receiver }]) };
    }
  }

  function issueAddress(wallet: WalletState): string {
    const { key, address } = mintAddress();
    receivers.set(key, { wallet, address });
    return address;
  }

  /** Records a transaction; returns it with `outputs` distinct random action positions for its outputs. */
  function recordTx(sender: WalletState | null, spends: number, outputs: number): { tx: TxState; slots: number[] } {
    const actions = Math.max(GRACE_ACTIONS, spends, outputs);
    const positions = Array.from({ length: actions }, (_, i) => i);
    for (let i = actions - 1; i > 0; i--) {
      const j = randomInt(random, i + 1);
      [positions[i], positions[j]] = [positions[j]!, positions[i]!];
    }
    let txid: string;
    do txid = bytesToHex(random(32));
    while (txById.has(txid));
    const txidBytes = hexToBytes(txid);
    const ciphertextSamples = Object.freeze(
      Array.from({ length: actions }, (_, i) => {
        const input = new Uint8Array(36);
        input.set(txidBytes, 0);
        new DataView(input.buffer).setUint32(32, i, true);
        return bytesToHex(blake2b(input, { dkLen: 32, personalization: SAMPLE_PERSONALIZATION }));
      }),
    );
    const tx: TxState = {
      seq: seq++,
      txid,
      sender,
      visibleAtMs: Date.now() + deliveryDelayMs,
      fee: feeFor(spends, outputs),
      actions,
      sizeBytes: txSizeFor(actions),
      ciphertextSamples,
      height: null,
      time: null,
    };
    txs.push(tx);
    txById.set(txid, tx);
    return { tx, slots: positions.slice(0, outputs) };
  }

  function createWallet(name: string, fundZats: Zats): WalletState {
    const { key, address } = mintAddress();
    const wallet: WalletState = { name, address, notes: [], handle: null };
    receivers.set(key, { wallet, address });
    wallets.set(name, wallet);
    if (fundZats > 0n) {
      // A faucet payment: one spend, two outputs (this note and the faucet's change), mined right away.
      const { tx, slots } = recordTx(null, 1, 2);
      wallet.notes.push({ tx, index: slots[0]!, toAddress: wallet.address, zats: fundZats, memo: EMPTY_MEMO, spentBy: null });
      sealBlock([tx]);
    }
    return wallet;
  }

  function publicView(tx: TxState): PublicTxView {
    return {
      txid: tx.txid,
      height: tx.height,
      time: tx.time,
      version: 6,
      sizeBytes: tx.sizeBytes,
      feeZats: tx.fee,
      transparent: { inputs: 0, outputs: 0 },
      sapling: { spends: 0, outputs: 0, valueBalanceZats: 0n },
      // The legacy Orchard pool is withdraw-only since NU6.3; Silicr never uses it.
      orchard: { actions: 0, valueBalanceZats: 0n, ciphertextSamples: [] },
      ironwood: { actions: tx.actions, valueBalanceZats: tx.fee, ciphertextSamples: [...tx.ciphertextSamples] },
    };
  }

  function makeHandle(wallet: WalletState): ZecBackend {
    let closed = false;
    const assertOpen = (): void => {
      if (closed) throw new Error(`memory wallet "${wallet.name}" is closed`);
    };
    /** Whether this wallet knows about an unmined transaction yet. */
    const knows = (tx: TxState, now: number): boolean =>
      tx.sender === wallet || (capabilities.mempoolNotes && now >= tx.visibleAtMs);
    const spendableNotes = (): NoteState[] =>
      wallet.notes.filter((n) => n.tx.height !== null && n.spentBy === null);
    const pendingNotes = (now: number): NoteState[] =>
      wallet.notes.filter((n) => n.tx.height === null && n.spentBy === null && knows(n.tx, now));

    const handle: ZecBackend = {
      network: 'memory',
      capabilities,

      async address() {
        assertOpen();
        return wallet.address;
      },

      async newAddress() {
        assertOpen();
        return capabilities.diversifiedAddresses ? issueAddress(wallet) : wallet.address;
      },

      async balance(): Promise<Balance> {
        assertOpen();
        return { spendable: sumZats(spendableNotes()), pending: sumZats(pendingNotes(Date.now())) };
      },

      async height() {
        assertOpen();
        return tip;
      },

      async send(outputs: Output[]): Promise<SendResult> {
        assertOpen();
        // Validate everything before touching any state: a refused send changes nothing.
        if (!Array.isArray(outputs) || outputs.length === 0) throw new RangeError('send() needs at least one output');
        if (outputs.length > capabilities.maxOutputsPerTx) {
          throw new RangeError(`send() takes at most ${capabilities.maxOutputsPerTx} outputs per transaction, got ${outputs.length}`);
        }
        let total = 0n;
        const prepared = outputs.map((output, i) => {
          if (output === null || typeof output !== 'object') throw new TypeError(`outputs[${i}] must be { to, zats, memo }`);
          const to = toOrchardOnly(output.to, 'memory'); // throws PrivacyError
          const { zats, memo } = output;
          if (typeof zats !== 'bigint') throw new TypeError(`outputs[${i}].zats must be a bigint`);
          if (zats < capabilities.minOutputZats) {
            throw new RangeError(`outputs[${i}].zats must be at least ${capabilities.minOutputZats} (capabilities.minOutputZats)`);
          }
          if (zats > MAX_MONEY) throw new RangeError(`outputs[${i}].zats exceeds the 21M ZEC supply`);
          if (!(memo instanceof Uint8Array) || memo.length !== MEMO_SIZE) {
            throw new RangeError(`outputs[${i}].memo must be exactly ${MEMO_SIZE} bytes`);
          }
          if (!capabilities.binaryMemos && !isTextMemo(memo)) {
            throw new RangeError(`outputs[${i}].memo is not a UTF-8 text memo, and this backend carries only text memos (binaryMemos: false)`);
          }
          total += zats;
          const receiver = decodeUnifiedAddress(to).receivers[0]!.data;
          return { destination: receivers.get(bytesToHex(receiver)), zats, memo: new Uint8Array(memo) };
        });
        if (total > MAX_MONEY) throw new RangeError('the outputs add up to more than the 21M ZEC supply');

        // Largest notes first: for each count k this maximises the value of k notes, and the fee depends only on k.
        const candidates = spendableNotes().sort(
          (a, b) => (a.zats === b.zats ? a.tx.seq - b.tx.seq || a.index - b.index : a.zats > b.zats ? -1 : 1),
        );
        const chosen: NoteState[] = [];
        let available = 0n;
        let plan: { fee: Zats; change: Zats } | null = null;
        for (const note of candidates) {
          chosen.push(note);
          available += note.zats;
          const exactFee = feeFor(chosen.length, prepared.length);
          if (available === total + exactFee) {
            plan = { fee: exactFee, change: 0n };
            break;
          }
          const feeWithChange = feeFor(chosen.length, prepared.length + 1);
          if (available > total + feeWithChange) {
            plan = { fee: feeWithChange, change: available - total - feeWithChange };
            break;
          }
        }
        if (plan === null) {
          const fee = feeFor(Math.max(1, candidates.length), prepared.length + 1);
          const pending = sumZats(pendingNotes(Date.now()));
          throw new InsufficientFundsError(
            `Insufficient funds: sending ${total} zats needs ${total + fee} zats including the ${fee}-zat ZIP 317 fee, ` +
              `but only ${sumZats(candidates)} zats are spendable` +
              (pending > 0n ? ` (${pending} more are waiting for a confirmation)` : '') +
              '.',
          );
        }

        const outputCount = prepared.length + (plan.change > 0n ? 1 : 0);
        const { tx, slots } = recordTx(wallet, chosen.length, outputCount);
        for (const note of chosen) note.spentBy = tx;
        prepared.forEach((p, i) => {
          if (p.destination === undefined) return; // nobody on this network holds that receiver: the funds are gone
          p.destination.wallet.notes.push({
            tx,
            index: slots[i]!,
            toAddress: p.destination.address,
            zats: p.zats,
            memo: p.memo,
            spentBy: null,
          });
        });
        if (plan.change > 0n) {
          wallet.notes.push({ tx, index: slots[prepared.length]!, toAddress: null, zats: plan.change, memo: EMPTY_MEMO, spentBy: null });
        }
        mempool.push(tx);
        return { txid: tx.txid, feeZats: tx.fee };
      },

      async poll(sinceHeight: number): Promise<ReceivedNote[]> {
        assertOpen();
        if (typeof sinceHeight !== 'number' || Number.isNaN(sinceHeight)) throw new TypeError('sinceHeight must be a number');
        const now = Date.now();
        return wallet.notes
          .filter((n) => {
            if (n.toAddress === null) return false; // change is internal, never "received"
            if (n.tx.height !== null) return n.tx.height >= sinceHeight;
            return capabilities.mempoolNotes && knows(n.tx, now);
          })
          .sort((a, b) => byChainOrder(a.tx, b.tx) || a.index - b.index)
          .map((n) => ({
            txid: n.tx.txid,
            index: n.index,
            height: n.tx.height,
            toAddress: n.toAddress!,
            zats: n.zats,
            memo: new Uint8Array(n.memo),
            pool: 'orchard' as const, // the receiver type
            valuePool: 'ironwood' as const, // where the value lives since NU6.3
          }));
      },

      async inspectTx(txid: string): Promise<PublicTxView> {
        assertOpen();
        const tx = typeof txid === 'string' ? txById.get(txid.toLowerCase()) : undefined;
        if (tx === undefined) throw new Error('unknown transaction');
        return publicView(tx);
      },

      async close() {
        closed = true;
        if (wallet.handle === handle) wallet.handle = null;
      },
    };
    return handle;
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  if (blockTimeMs > 0) {
    timer = setInterval(mine, blockTimeMs);
    timer.unref?.(); // never keep a process alive on its own; stop() is still required
  }

  return {
    wallet(name: string, walletOpts: { fundZats?: Zats } = {}): ZecBackend {
      if (typeof name !== 'string' || name === '') throw new TypeError('wallet name must be a non-empty string');
      let wallet = wallets.get(name);
      if (wallet === undefined) {
        const fundZats = walletOpts.fundZats ?? 0n;
        if (typeof fundZats !== 'bigint' || fundZats < 0n || fundZats > MAX_MONEY) {
          throw new RangeError('fundZats must be a bigint between 0n and the 21M ZEC supply');
        }
        wallet = createWallet(name, fundZats);
      }
      wallet.handle ??= makeHandle(wallet);
      return wallet.handle;
    },
    mine,
    get height() {
      return tip;
    },
    explorer(): PublicTxView[] {
      return [...txs].sort(byChainOrder).map(publicView);
    },
    stop(): void {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
