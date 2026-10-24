/**
 * Memo protocol v1 (ARCHITECTURE.md §3).
 *
 *   frame = "SLC1" | version u8 | type u8 | CBOR body | Ed25519 sig (64 B)
 *   sig   = Sign(utf8("silicr/v1/memo") | version | type | body)
 *
 *   binary memo = 0xFF | frame | zero padding          (ZIP 302 arbitrary data)
 *   text memo   = utf8("slc1:" + base64url(frame)) | zero padding   (ZIP 302 text)
 */
import { base64urlnopad } from '@scure/base';
import { MAGIC, PROTOCOL_VERSION } from './contract.ts';
import type { Bytes, Close, CloseReason, DecodedMemo, MemoMessage, MemoType, Signer, Transport } from './contract.ts';
import { ProtocolError, concat, utf8 } from './bytes.ts';
import { decodeCbor, encodeCbor } from './cbor.ts';
import {
  GPU_SLUG_PATTERN,
  type Spec,
  U32_MAX,
  UA_PATTERN,
  bytes,
  decodeFields,
  encodeFields,
  enumCodes,
  optional,
  pattern,
  u64,
  uint,
} from './fields.ts';
import { RFQ_ID_BYTES, verifySignature } from './keys.ts';

const MEMO_BYTES = 512;
/** ZIP 302: a first byte of 0xFF marks arbitrary data; the remaining 511 bytes are unconstrained. */
export const ARBITRARY_DATA_MARKER = 0xff;
export const TEXT_PREFIX = 'slc1:';
/**
 * Frame budget: the largest frame whose base64url still fits a text memo,
 * floor((512 - 5) * 3 / 4) = 380. Binary memos have room for 511 but are held
 * to the same budget, so every message fits both transports.
 */
export const MAX_FRAME_BYTES = Math.floor(((MEMO_BYTES - TEXT_PREFIX.length) * 3) / 4);

const MAGIC_BYTES = utf8(MAGIC);
const TEXT_PREFIX_BYTES = utf8(TEXT_PREFIX);
const SIGNATURE_DOMAIN = utf8('silicr/v1/memo');
const HEADER_BYTES = MAGIC_BYTES.length + 2;
const SIG_BYTES = 64;

const rfqId = bytes(RFQ_ID_BYTES);
const key = bytes(32);
const gpu = pattern(GPU_SLUG_PATTERN, 'a GPU slug matching [a-z0-9-]{1,16}');
const address = pattern(UA_PATTERN, 'a unified address (u…1…)');

// Enum wire codes. `satisfies` makes the compiler flag any value missing a code.
const CLOSE_BY = { buyer: 0, provider: 1 } as const satisfies Record<Close['by'], number>;
const CLOSE_REASONS = {
  done: 0,
  buyer_stop: 1,
  provider_stop: 2,
  unpaid: 3,
  no_heartbeat: 4,
  error: 5,
} as const satisfies Record<CloseReason, number>;

type Body<T extends MemoType> = Omit<Extract<MemoMessage, { t: T }>, 't'>;

// Wire layouts: the body is a CBOR array of these fields, in this order.
const SPECS: { readonly [T in MemoType]: { readonly code: number; readonly fields: Spec<Body<T>> } } = {
  RFQ: {
    code: 1,
    fields: {
      rfqId,
      gpu,
      count: uint(1, 64),
      durationS: uint(1, U32_MAX),
      maxPricePerHourZats: u64, // 0 = undisclosed (contract.ts)
      replyTo: address,
      buyerKey: key,
      buyerEph: key,
      expiresHeight: uint(0, U32_MAX),
    },
  },
  BID: {
    code: 2,
    fields: {
      rfqId,
      providerId: key,
      pricePerIntervalZats: u64,
      intervalS: uint(1, U32_MAX),
      startWithinS: uint(0, U32_MAX),
      providerEph: key,
      payTo: address,
    },
  },
  ACCEPT: {
    code: 3,
    fields: { rfqId, providerId: key, intervals: uint(1, U32_MAX), pricePerIntervalZats: u64 },
  },
  PAY: {
    code: 4,
    fields: { rfqId, seq: uint(1, U32_MAX) },
  },
  CLOSE: {
    code: 5,
    fields: {
      rfqId,
      by: enumCodes(CLOSE_BY),
      reason: enumCodes(CLOSE_REASONS),
      finalSeq: uint(0, U32_MAX),
      resultDigest: optional(bytes(32)),
    },
  },
};

const TYPE_BY_CODE = new Map(Object.entries(SPECS).map(([t, spec]) => [spec.code, t as MemoType]));

function signedBytes(code: number, body: Bytes): Bytes {
  return concat(SIGNATURE_DOMAIN, Uint8Array.of(PROTOCOL_VERSION, code), body);
}

/** The signed frame on its own, before any transport wrapping. */
export function encodeFrame(msg: MemoMessage, signer: Signer): Bytes {
  const t = (msg as { t?: unknown } | null)?.t;
  if (typeof t !== 'string' || !Object.hasOwn(SPECS, t)) {
    throw new ProtocolError('message type must be one of RFQ, BID, ACCEPT, PAY, CLOSE');
  }
  const spec = SPECS[t as MemoType];
  const body = encodeCbor(encodeFields(t, spec.fields, msg));
  const size = HEADER_BYTES + body.length + SIG_BYTES;
  if (size > MAX_FRAME_BYTES) {
    throw new ProtocolError(
      `${t} frame would be ${size} bytes; every Silicr memo must fit ${MAX_FRAME_BYTES} bytes (the text-transport limit)`,
    );
  }
  const sig = signer.sign(signedBytes(spec.code, body));
  if (!(sig instanceof Uint8Array) || sig.length !== SIG_BYTES) {
    throw new ProtocolError('signer must return a 64-byte Ed25519 signature');
  }
  return concat(MAGIC_BYTES, Uint8Array.of(PROTOCOL_VERSION, spec.code), body, sig);
}

export function encodeMemo(msg: MemoMessage, signer: Signer, transport: Transport): Bytes {
  if (transport !== 'binary' && transport !== 'text') {
    throw new ProtocolError("transport must be 'binary' or 'text'");
  }
  const frame = encodeFrame(msg, signer);
  const memo = new Uint8Array(MEMO_BYTES);
  if (transport === 'binary') {
    memo[0] = ARBITRARY_DATA_MARKER;
    memo.set(frame, 1);
  } else {
    memo.set(utf8(TEXT_PREFIX + base64urlnopad.encode(frame)));
  }
  return memo;
}

interface Frame {
  msg: MemoMessage;
  signed: Bytes;
  sig: Bytes;
  /** Index just past the signature. */
  end: number;
}

/** Parses the frame that starts at `start`. Throws on anything malformed. */
function parseFrame(buf: Bytes, start: number): Frame {
  for (let i = 0; i < MAGIC_BYTES.length; i++) {
    if (buf[start + i] !== MAGIC_BYTES[i]) throw new ProtocolError('not a Silicr frame');
  }
  if (buf[start + 4] !== PROTOCOL_VERSION) throw new ProtocolError('unsupported protocol version');
  const code = buf[start + 5] ?? -1;
  const t = TYPE_BY_CODE.get(code);
  if (t === undefined) throw new ProtocolError('unknown message type');
  const bodyStart = start + HEADER_BYTES;
  const { value, end: bodyEnd } = decodeCbor(buf, bodyStart);
  const end = bodyEnd + SIG_BYTES;
  if (end > buf.length || end - start > MAX_FRAME_BYTES) throw new ProtocolError('frame truncated or over budget');
  const msg = { t, ...decodeFields(t, SPECS[t].fields, value) } as MemoMessage;
  return { msg, signed: signedBytes(code, buf.subarray(bodyStart, bodyEnd)), sig: buf.slice(bodyEnd, end), end };
}

function decoded({ msg, signed, sig }: Frame, transport: Transport): DecodedMemo {
  return { msg, transport, verifiedBy: (publicKey: Bytes) => verifySignature(publicKey, signed, sig) };
}

function decodeBinary(memo: Bytes): DecodedMemo | null {
  const frame = parseFrame(memo, 1);
  for (let i = frame.end; i < memo.length; i++) if (memo[i] !== 0) return null;
  return decoded(frame, 'binary');
}

function decodeText(memo: Bytes): DecodedMemo | null {
  // ZIP 302 text memo: strip trailing zero bytes, the rest is the text.
  let len = memo.length;
  while (len > 0 && memo[len - 1] === 0) len--;
  if (len <= TEXT_PREFIX_BYTES.length) return null;
  for (let i = 0; i < TEXT_PREFIX_BYTES.length; i++) if (memo[i] !== TEXT_PREFIX_BYTES[i]) return null;
  // base64url is ASCII, so bytes map 1:1 to characters. The decoder rejects any other
  // character and non-zero padding bits, so each frame has exactly one text encoding.
  const frameBytes = base64urlnopad.decode(String.fromCharCode(...memo.subarray(TEXT_PREFIX_BYTES.length, len)));
  const frame = parseFrame(frameBytes, 0);
  return frame.end === frameBytes.length ? decoded(frame, 'text') : null;
}

export function decodeMemo(memo: Bytes): DecodedMemo | null {
  try {
    if (!(memo instanceof Uint8Array) || memo.length > MEMO_BYTES) return null;
    // Private copy: later changes to the caller's buffer can't affect the result.
    // A short input reads as if zero padded to 512 bytes.
    const m = new Uint8Array(MEMO_BYTES);
    m.set(memo);
    return m[0] === ARBITRARY_DATA_MARKER ? decodeBinary(m) : decodeText(m);
  } catch {
    return null;
  }
}
