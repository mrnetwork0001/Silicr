/**
 * Heartbeat = CBOR body | Ed25519 sig (64 B), sig over utf8("silicr/v1/heartbeat") | body.
 * The engine then seals these bytes on the channel with kind 'heartbeat'.
 */
import type { Bytes, Heartbeat, Signer } from './contract.ts';
import { ProtocolError, concat, utf8 } from './bytes.ts';
import { decodeCbor, encodeCbor } from './cbor.ts';
import { type Spec, U32_MAX, bytes, decodeFields, encodeFields, enumCodes, optional, text, uint } from './fields.ts';
import { RFQ_ID_BYTES, verifySignature } from './keys.ts';

const DOMAIN = utf8('silicr/v1/heartbeat');
const SIG_BYTES = 64;
export const MAX_NOTE_BYTES = 1024;

const STATUS = {
  starting: 0,
  running: 1,
  paused: 2,
  finished: 3,
  failed: 4,
} as const satisfies Record<Heartbeat['status'], number>;

const counter = uint(0, Number.MAX_SAFE_INTEGER);

const HEARTBEAT: Spec<Heartbeat> = {
  rfqId: bytes(RFQ_ID_BYTES),
  seq: counter,
  ts: counter,
  step: counter,
  checkpointDigest: bytes(32),
  status: enumCodes(STATUS),
  servingSeq: uint(0, U32_MAX),
  note: optional(text(MAX_NOTE_BYTES)),
};

export function encodeHeartbeat(hb: Heartbeat, signer: Signer): Bytes {
  const body = encodeCbor(encodeFields('Heartbeat', HEARTBEAT, hb));
  const sig = signer.sign(concat(DOMAIN, body));
  if (!(sig instanceof Uint8Array) || sig.length !== SIG_BYTES) {
    throw new ProtocolError('signer must return a 64-byte Ed25519 signature');
  }
  return concat(body, sig);
}

export function decodeHeartbeat(bytes: Bytes, providerId: Bytes): Heartbeat | null {
  try {
    if (!(bytes instanceof Uint8Array)) return null;
    const b = new Uint8Array(bytes);
    const { value, end } = decodeCbor(b);
    if (b.length - end !== SIG_BYTES) return null;
    if (!verifySignature(providerId, concat(DOMAIN, b.subarray(0, end)), b.subarray(end))) return null;
    return decodeFields('Heartbeat', HEARTBEAT, value) as unknown as Heartbeat;
  } catch {
    return null;
  }
}
