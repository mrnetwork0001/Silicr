// Relay-less mode: the relay's mailbox interface, carried in Zcash memos (ARCHITECTURE.md §1).
//
// MemoTransport implements RelayClient. A mailbox that belongs to a registered memo-mode deal is
// served on-chain: append() cuts the sealed blob into BLOB memos (protocol memochunks.ts) and sends
// them as ≤ maxOutputsPerTx outputs per shielded transaction to the counterparty's address; read()
// returns blobs reassembled from the memos the wallet received. Every other mailbox, and the
// directory, goes to the real relay, so relay-mode deals on the same node are untouched.
//
// Incoming chunks are picked up by wrapping the wallet's poll(): every note is checked for a BLOB
// memo before the node's own watcher sees the batch, so a HELLO that arrives next to an RFQ in the
// same transaction is known by the time the RFQ handler runs, whatever the output order.
//
// Cost model: an output costs minOutputZats (its note value, received by the other side) and one
// ZIP 317 action (5,000 zats); a transaction pays for max(2, outputs + 1 change). A full 40-output
// transaction carries maxBlobBytes(40) = 11,008 sealed bytes for 41 × 5,000 = 205,000 zats:
// about 18,600 zats (0.000186 ZEC) per KB. Latency: the receiver sees a blob as soon as its
// memos are in the mempool (backends with mempoolNotes), else one block per hop.
import type { BlobKind, Channel, Signer, Transport } from '@silicr/protocol';
import {
  MemoBlobAssembler,
  chunkCount,
  decodeBlobMemo,
  encodeBlobMemo,
  helloChunk,
  isHelloChunk,
  maxBlobBytes,
  splitBlob,
  type DecodedBlobMemo,
} from '@silicr/protocol';
import type { RelayClient } from '@silicr/relay';
import type { Output, ReceivedNote, SendResult, ZecBackend } from '@silicr/zec';
import { EngineError } from './errors.ts';
import type { LeakInput, TxFacts } from './leaks.ts';
import { field } from './leaks.ts';
import { formatZec } from './zats.ts';
import { hex, unhex } from './util.ts';

export type BlobTransport = 'relay' | 'memo';

/** ZIP 317 marginal fee per logical action. */
const ACTION_FEE_ZATS = 5000n;
/** Default blob cap: four full 40-output transactions. */
export const DEFAULT_MAX_MEMO_BLOB_BYTES = maxBlobBytes(4 * 40);

export interface MemoTransportOptions {
  mode: BlobTransport;
  relay: RelayClient;
  backend: ZecBackend;
  /** Memo encoding this backend carries. */
  transport: Transport;
  /** Whose blobs this node signs: names the sealed facts for the Leak Inspector. */
  role: 'buyer' | 'provider';
  /** The node's guarded, serialised sender (NodeBase.send). */
  send: (outputs: Output[], ctx: { rfqId: string; what: string; sealed: TxFacts }) => Promise<SendResult>;
  /** Largest sealed blob append() accepts. Default DEFAULT_MAX_MEMO_BLOB_BYTES (≈ 44 KB, 4 transactions). */
  maxBlobBytes?: number;
  /** Throws (EngineError 'spend_cap') if sending `costZats` more for this RFQ would break the caps. */
  capCheck?: (rfqId: string, costZats: bigint) => void;
  /** Fees and note values spent on a blob, for the RFQ's fee accounting. */
  onSpent?: (rfqId: string, feeZats: bigint, valueZats: bigint) => void;
  record?: (input: LeakInput) => void;
  log?: (msg: string) => void;
}

interface Registration {
  rfqId: string;
  channel: Channel;
  /** Counterparty address every blob of this deal is sent to. */
  to: string;
  signer: Signer;
  /** Next blob number per kind. */
  seq: Map<BlobKind, number>;
}

interface Queue {
  items: { seq: number; data: Uint8Array }[];
  waiters: Set<() => void>;
}

export interface MemoTransportStats {
  transactions: number;
  outputs: number;
  feeZats: bigint;
  valueZats: bigint;
  sealedBytes: number;
}

const MAX_SEEN_NOTES = 20_000;
const MAX_HELLOS = 1000;

export class MemoTransport implements RelayClient {
  readonly mode: BlobTransport;
  readonly maxBlobBytes: number;
  /** Verification key for incoming chunks of an RFQ (buyerKey on a provider, providerId on a buyer); null = not ours. */
  keyFor: (rfqId: string) => Uint8Array | null = () => null;
  private readonly o: MemoTransportOptions;
  private readonly regs = new Map<string, Registration>();
  private readonly byMailbox = new Map<string, { rfqId: string; kind: BlobKind }>();
  private readonly queues = new Map<string, Queue>();
  private readonly hellos = new Map<string, DecodedBlobMemo>();
  private readonly seen = new Set<string>();
  private readonly assembler: MemoBlobAssembler;
  private readonly stats = new Map<string, MemoTransportStats>();
  /** Chunks dropped before reassembly: not for an RFQ we know, or a bad signature. */
  rejectedChunks = 0;

  constructor(o: MemoTransportOptions) {
    this.o = o;
    this.mode = o.mode;
    this.maxBlobBytes = o.maxBlobBytes ?? DEFAULT_MAX_MEMO_BLOB_BYTES;
    this.assembler = new MemoBlobAssembler({ maxBlobBytes: this.maxBlobBytes });
  }

  get baseUrl(): string {
    return this.o.relay.baseUrl;
  }

  // ------------------------------------------------------------------ wiring

  /** The backend with poll() intercepted; hand this to the NoteWatcher. */
  wrapBackend(): ZecBackend {
    const inner = this.o.backend;
    const wrapped: ZecBackend = {
      network: inner.network,
      capabilities: inner.capabilities,
      address: () => inner.address(),
      newAddress: () => inner.newAddress(),
      balance: () => inner.balance(),
      height: () => inner.height(),
      send: (outputs) => inner.send(outputs),
      poll: async (since) => {
        const notes = await inner.poll(since);
        for (const n of notes) this.ingest(n);
        return notes;
      },
      close: () => inner.close(),
    };
    if (inner.inspectTx) wrapped.inspectTx = (txid) => inner.inspectTx!(txid);
    return wrapped;
  }

  /** A deal whose blobs travel in memos: called once the channel exists (ACCEPT sent or received). */
  register(rfqId: string, channel: Channel, peer: { to: string; signer: Signer }): void {
    const id = rfqId.toLowerCase();
    const prev = this.regs.get(id);
    const reg: Registration = { rfqId: id, channel, to: peer.to, signer: peer.signer, seq: prev?.seq ?? new Map() };
    this.regs.set(id, reg);
    for (const [kind, box] of Object.entries(channel.mailboxes) as [BlobKind, string][]) this.byMailbox.set(box, { rfqId: id, kind });
  }

  unregister(rfqId: string): void {
    const reg = this.regs.get(rfqId.toLowerCase());
    if (!reg) return;
    for (const box of Object.values(reg.channel.mailboxes)) this.byMailbox.delete(box);
    this.regs.delete(reg.rfqId);
  }

  isMemo(rfqId: string): boolean {
    return this.regs.has(rfqId.toLowerCase());
  }

  /** Per-RFQ spend on memo blobs so far (both directions are paid by their sender). */
  statsFor(rfqId: string): MemoTransportStats {
    return this.stats.get(rfqId.toLowerCase()) ?? { transactions: 0, outputs: 0, feeZats: 0n, valueZats: 0n, sealedBytes: 0 };
  }

  // ------------------------------------------------------------------ negotiation

  /** The HELLO output a memo-mode buyer adds next to each RFQ output. */
  helloOutput(rfqId: string, signer: Signer, to: string, zats: bigint): Output {
    return { to, zats, memo: encodeBlobMemo(helloChunk(unhex(rfqId)), signer, this.o.transport) };
  }

  /** True if a HELLO signed by `buyerKey` arrived for this RFQ (same transaction as the RFQ, any output order). */
  helloSeen(rfqId: string, buyerKey: Uint8Array): boolean {
    const h = this.hellos.get(rfqId.toLowerCase());
    return !!h && h.verifiedBy(buyerKey);
  }

  /** Why a provider in this mode must not bid on an RFQ, or null if the transports agree. */
  bidRefusal(rfqId: string, buyerKey: Uint8Array): string | null {
    const wantsMemo = this.helloSeen(rfqId, buyerKey);
    if (wantsMemo && this.mode !== 'memo') {
      return 'the buyer asked for relay-less transport (job, logs and result in memos) and this provider uses the relay; start it with --transport memo to serve such requests';
    }
    if (!wantsMemo && this.mode === 'memo') {
      return 'the buyer uses the relay for job, logs and result and this provider is relay-less (--transport memo); it only serves buyers that send RFQs with --transport memo';
    }
    return null;
  }

  // ------------------------------------------------------------------ RelayClient

  async append(mailbox: string, data: Uint8Array): Promise<number> {
    const owner = this.byMailbox.get(mailbox);
    if (!owner) return this.o.relay.append(mailbox, data);
    const reg = this.regs.get(owner.rfqId)!;
    if (data.length > this.maxBlobBytes) {
      throw new EngineError(
        'blob_too_large',
        `sealed ${owner.kind} blob is ${data.length} bytes; relay-less (memo) transport carries at most ${this.maxBlobBytes} bytes ` +
          `(${chunkCount(this.maxBlobBytes)} memos, ${Math.ceil(chunkCount(this.maxBlobBytes) / this.outputsPerTx)} transactions of ${this.outputsPerTx}); use the relay (--transport relay) for jobs this size`,
        413,
      );
    }
    const seq = this.nextSeq(reg, owner.kind);
    const chunks = splitBlob(unhex(reg.rfqId), owner.kind, seq, data);
    const zats = this.o.backend.capabilities.minOutputZats;
    const outputs: Output[] = chunks.map((c) => ({ to: reg.to, zats, memo: encodeBlobMemo(c, reg.signer, this.o.transport) }));
    const txs: Output[][] = [];
    for (let i = 0; i < outputs.length; i += this.outputsPerTx) txs.push(outputs.slice(i, i + this.outputsPerTx));
    const estimate = txs.reduce((n, t) => n + ACTION_FEE_ZATS * BigInt(t.length + 1) + zats * BigInt(t.length), 0n);
    this.o.capCheck?.(reg.rfqId, estimate);
    const st = this.statsFor(reg.rfqId);
    const sealed: TxFacts = { memo: ['workload'], sender: [this.o.role === 'buyer' ? 'buyer_identity' : 'provider_identity'], recipients: [] };
    const txids: string[] = [];
    let fee = 0n;
    let value = 0n;
    for (const [i, tx] of txs.entries()) {
      const what = `Sealed ${owner.kind} blob in memos${txs.length > 1 ? ` (${i + 1}/${txs.length})` : ''}`;
      const res = await this.o.send(tx, { rfqId: reg.rfqId, what, sealed });
      const v = zats * BigInt(tx.length);
      fee += res.feeZats;
      value += v;
      txids.push(res.txid);
      this.o.onSpent?.(reg.rfqId, res.feeZats, v);
    }
    st.transactions += txs.length;
    st.outputs += outputs.length;
    st.feeZats += fee;
    st.valueZats += value;
    st.sealedBytes += data.length;
    this.stats.set(reg.rfqId, st);
    this.o.record?.({
      party: this.o.role,
      event: 'memo-blob-sent',
      summary: `Sealed ${owner.kind} blob sent on-chain: ${data.length} bytes in ${outputs.length} memo(s), ${txs.length} transaction(s)`,
      fields: [
        field('Kind', owner.kind, true, false, []),
        field('Sealed size', `${data.length} bytes (ciphertext; the chain never holds plaintext)`, true, false, ['workload']),
        field('Memos', `${outputs.length} × 512-byte memo, ${chunks[0]!.payload.length}–${chunks[chunks.length - 1]!.payload.length} payload bytes each`, true, false, []),
        field('Transactions', `${txs.length} (at most ${this.outputsPerTx} outputs each)`, true, false, []),
        field('Fees', `${formatZec(fee)} ZEC (ZIP 317, ${ACTION_FEE_ZATS} zats per action) + ${formatZec(value)} ZEC in note values to the other side`, true, false, []),
        field('Relay', 'not used: nothing but the chain carries this deal', true, false, []),
      ],
      rfqId: reg.rfqId,
      txid: txids[0]!,
    });
    return seq;
  }

  async read(mailbox: string, afterSeq: number, waitS = 0): Promise<{ seq: number; data: Uint8Array }[]> {
    const owner = this.byMailbox.get(mailbox);
    if (!owner) return this.o.relay.read(mailbox, afterSeq, waitS);
    const q = this.queue(owner.rfqId, owner.kind);
    const deadline = Date.now() + waitS * 1000;
    for (;;) {
      const out = q.items.filter((m) => m.seq > afterSeq).map((m) => ({ seq: m.seq, data: new Uint8Array(m.data) }));
      const remaining = deadline - Date.now();
      if (out.length || remaining <= 0) return out;
      await new Promise<void>((r) => {
        const t = setTimeout(() => {
          q.waiters.delete(wake);
          r();
        }, remaining);
        const wake = () => {
          clearTimeout(t);
          r();
        };
        q.waiters.add(wake);
      });
    }
  }

  listDirectory(): Promise<unknown[]> {
    return this.o.relay.listDirectory();
  }

  publishDirectory(entry: unknown): Promise<void> {
    return this.o.relay.publishDirectory(entry);
  }

  // ------------------------------------------------------------------ internals

  private get outputsPerTx(): number {
    return Math.max(1, this.o.backend.capabilities.maxOutputsPerTx);
  }

  /** Blob numbers start at the unix second the node came up, so a restart never repeats one seen by the other side. */
  private nextSeq(reg: Registration, kind: BlobKind): number {
    const n = reg.seq.get(kind) ?? Math.floor(Date.now() / 1000);
    reg.seq.set(kind, n + 1);
    return n;
  }

  private queue(rfqId: string, kind: BlobKind): Queue {
    const key = `${rfqId}/${kind}`;
    let q = this.queues.get(key);
    if (!q) {
      q = { items: [], waiters: new Set() };
      this.queues.set(key, q);
    }
    return q;
  }

  private ingest(n: ReceivedNote): void {
    if (n.pool !== 'orchard') return;
    const key = `${n.txid}:${n.index}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > MAX_SEEN_NOTES) this.seen.delete(this.seen.keys().next().value!);
    const d = decodeBlobMemo(n.memo);
    if (!d) return;
    const rfqId = hex(d.chunk.rfqId);
    if (isHelloChunk(d.chunk)) {
      // Verified lazily: the buyer key is only known once the RFQ next to it has been read.
      if (!this.hellos.has(rfqId)) {
        this.hellos.set(rfqId, d);
        if (this.hellos.size > MAX_HELLOS) this.hellos.delete(this.hellos.keys().next().value!);
      }
      return;
    }
    const pk = this.keyFor(rfqId);
    if (!pk || !d.verifiedBy(pk)) {
      this.rejectedChunks += 1;
      return;
    }
    const done = this.assembler.push(d.chunk);
    if (!done) return;
    const q = this.queue(rfqId, done.kind);
    q.items.push({ seq: q.items.length + 1, data: done.sealed });
    for (const w of q.waiters) w();
    q.waiters.clear();
    this.o.log?.(`memo transport: ${done.kind} blob of ${done.sealed.length} bytes reassembled for ${rfqId.slice(0, 8)}`);
  }
}
