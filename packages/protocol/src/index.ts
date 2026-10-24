export * from './contract.ts';

export { ProtocolError, fromHex, sha256, toHex } from './bytes.ts';
export { deriveRfqKeys, generateSigner, generateX25519, newRfqId, signerFromSecret, x25519FromSecret } from './keys.ts';
export { MAX_FRAME_BYTES, decodeMemo, encodeMemo } from './memo.ts';
export { BLOB_KINDS, deriveChannel } from './channel.ts';
export { MAX_NOTE_BYTES, decodeHeartbeat, encodeHeartbeat } from './heartbeat.ts';
export { canonicalDirectoryBytes, signDirectoryEntry, verifyDirectoryEntry } from './directory.ts';
// Relay-less mode: sealed blobs carried in BLOB memos (type 6) and reassembled. Additive.
export {
  BLOB_TYPE_CODE,
  CHUNK_PAYLOAD_BYTES,
  HELLO_PAYLOAD,
  MAX_CHUNKS_PER_BLOB,
  MemoBlobAssembler,
  chunkCount,
  decodeBlobMemo,
  encodeBlobFrame,
  encodeBlobMemo,
  helloChunk,
  isHelloChunk,
  maxBlobBytes,
  payloadCapacity,
  splitBlob,
} from './memochunks.ts';
export type { AssembledBlob, AssemblerOptions, BlobChunk, DecodedBlobMemo } from './memochunks.ts';
