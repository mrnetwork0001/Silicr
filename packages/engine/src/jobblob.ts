// Plaintext formats sealed inside relay blobs. Both ends are this package, so they live here.
//
//   job:    "SJB1" | u32be manifestLen | manifest JSON (UTF-8) | bundle (tar.gz) [| checkpoint (tar.gz)]
//           The checkpoint section is present iff manifest.resumeFrom is set (a migrated job): the
//           provider unpacks it into SILICR_CHECKPOINT_DIR before the job starts.
//   log:    see blobs.ts (u32be batch seq | UTF-8 lines joined by "\n")
//   result: the packed output dir (tar.gz), as returned by packBundle
//   checkpoint: "SCP1" | u32be interval seq | sha256(tar) (32) | the packed checkpoint dir (tar.gz)
// Job, result and checkpoint payloads travel chunked (blobs.ts).

const MAGIC = new TextEncoder().encode('SJB1');
const MAX_MANIFEST = 64 * 1024;

export interface JobManifest {
  v: 1;
  command: string[];
  image?: string;
  gpu?: { model: string; count: number } | null;
  /** Extra environment for the job, chosen by the buyer. Reserved names are dropped by the provider. */
  env?: Record<string, string>;
  bundleSize: number;
  /** Hex SHA-256 of the bundle bytes. */
  bundleSha256: string;
  /**
   * Migration: a checkpoint from an earlier run of the same job follows the bundle in the blob.
   * The provider verifies it and unpacks it into the job's checkpoint dir, so the job resumes
   * from interval `seq` of the earlier deal (the job itself decides what to do with the files).
   */
  resumeFrom?: { seq: number; sizeBytes: number; sha256: string };
}

export function encodeJobBlob(manifest: JobManifest, bundle: Uint8Array, checkpoint?: Uint8Array): Uint8Array {
  const m = new TextEncoder().encode(JSON.stringify(manifest));
  if (m.length > MAX_MANIFEST) throw new Error('job manifest too large');
  if (!!manifest.resumeFrom !== !!checkpoint) throw new Error('manifest.resumeFrom and the checkpoint bytes go together');
  if (checkpoint && manifest.resumeFrom && checkpoint.length !== manifest.resumeFrom.sizeBytes) throw new Error('checkpoint size mismatch');
  const ck = checkpoint ?? new Uint8Array();
  const out = new Uint8Array(4 + 4 + m.length + bundle.length + ck.length);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(4, m.length, false);
  out.set(m, 8);
  out.set(bundle, 8 + m.length);
  out.set(ck, 8 + m.length + bundle.length);
  return out;
}

export function decodeJobBlob(bytes: Uint8Array): { manifest: JobManifest; bundle: Uint8Array; checkpoint?: Uint8Array } {
  if (bytes.length < 8) throw new Error('job blob too short');
  for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIC[i]) throw new Error('not a Silicr job blob');
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, false);
  if (len > MAX_MANIFEST || 8 + len > bytes.length) throw new Error('bad job manifest length');
  const manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + len))) as JobManifest;
  if (manifest.v !== 1 || !Array.isArray(manifest.command) || manifest.command.length === 0 || !manifest.command.every((c) => typeof c === 'string')) {
    throw new Error('bad job manifest');
  }
  const end = 8 + len + manifest.bundleSize;
  if (!Number.isInteger(manifest.bundleSize) || manifest.bundleSize < 0 || end > bytes.length) throw new Error('job bundle size mismatch');
  const bundle = bytes.slice(8 + len, end);
  const rf = manifest.resumeFrom;
  if (rf === undefined) {
    if (bytes.length !== end) throw new Error('job bundle size mismatch');
    return { manifest, bundle };
  }
  if (!rf || !Number.isInteger(rf.seq) || rf.seq < 0 || !Number.isInteger(rf.sizeBytes) || rf.sizeBytes < 0 || !/^[0-9a-f]{64}$/.test(String(rf.sha256))) {
    throw new Error('bad job manifest: resumeFrom');
  }
  const checkpoint = bytes.slice(end);
  if (checkpoint.length !== rf.sizeBytes) throw new Error('job checkpoint size mismatch');
  return { manifest, bundle, checkpoint };
}

// ---------------------------------------------------------------------------- checkpoint blobs

const CKPT_MAGIC = new TextEncoder().encode('SCP1');
const CKPT_HEADER = 4 + 4 + 32;

/** The provider's per-interval checkpoint: the interval it was taken at the end of, and the packed dir. */
export function encodeCheckpointBlob(seq: number, tarSha256: Uint8Array, tar: Uint8Array): Uint8Array {
  if (!Number.isInteger(seq) || seq < 0 || seq > 0xffffffff) throw new Error('bad checkpoint seq');
  if (tarSha256.length !== 32) throw new Error('bad checkpoint digest');
  const out = new Uint8Array(CKPT_HEADER + tar.length);
  out.set(CKPT_MAGIC, 0);
  new DataView(out.buffer).setUint32(4, seq, false);
  out.set(tarSha256, 8);
  out.set(tar, CKPT_HEADER);
  return out;
}

/** Returns null if the bytes are not a checkpoint blob. The digest is NOT checked here: the reader does that. */
export function decodeCheckpointBlob(bytes: Uint8Array): { seq: number; sha256: Uint8Array; tar: Uint8Array } | null {
  if (bytes.length < CKPT_HEADER) return null;
  for (let i = 0; i < 4; i++) if (bytes[i] !== CKPT_MAGIC[i]) return null;
  const seq = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, false);
  return { seq, sha256: bytes.slice(8, 40), tar: bytes.slice(CKPT_HEADER) };
}

const RESERVED_ENV = /^(PATH|HOME|USER|SHELL|LD_.*|DYLD_.*|NODE_OPTIONS|SILICR_OUTPUT_DIR|SILICR_CHECKPOINT_DIR)$/;

/** Keep only plain NAME=value pairs that can't redirect the provider's own tooling. */
export function sanitizeEnv(env: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!env || typeof env !== 'object') return out;
  for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(k) || RESERVED_ENV.test(k)) continue;
    if (typeof v !== 'string' || v.length > 4096) continue;
    out[k] = v;
  }
  return out;
}
