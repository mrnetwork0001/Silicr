/**
 * Provider directory entries: sig = Ed25519(utf8("silicr/v1/directory\n") | canonicalJson(entry without sig)).
 */
import type { Bytes, DirectoryEntry, Signer } from './contract.ts';
import { fromHex, toHex, utf8 } from './bytes.ts';
import { GPU_SLUG_PATTERN, U64_MAX, UA_PATTERN } from './fields.ts';
import { verifySignature } from './keys.ts';

const DOMAIN = 'silicr/v1/directory\n';

/**
 * JSON with object keys sorted (UTF-16 order) at every level, no whitespace and
 * undefined members omitted; otherwise JSON.stringify semantics. It is total,
 * so signing never throws: bigint becomes a decimal string, a cycle becomes null.
 */
export function canonicalJson(value: unknown): string {
  return canon(value, []) ?? 'null';
}

function canon(v: unknown, path: object[]): string | undefined {
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'number':
      return Number.isFinite(v) ? JSON.stringify(v) : 'null';
    case 'boolean':
      return v ? 'true' : 'false';
    case 'bigint':
      return JSON.stringify(v.toString());
    case 'object':
      break;
    default:
      return undefined; // undefined, functions, symbols
  }
  if (v === null || path.includes(v)) return 'null';
  path.push(v);
  let out: string;
  if (Array.isArray(v)) {
    out = `[${Array.from(v, (x) => canon(x, path) ?? 'null').join(',')}]`;
  } else {
    const record = v as Record<string, unknown>;
    const members = Object.keys(record)
      .sort()
      .flatMap((k) => {
        const s = canon(record[k], path);
        return s === undefined ? [] : [`${JSON.stringify(k)}:${s}`];
      });
    out = `{${members.join(',')}}`;
  }
  path.pop();
  return out;
}

function withoutSig(entry: unknown): Record<string, unknown> {
  if (typeof entry !== 'object' || entry === null) return {};
  const { sig: _sig, ...rest } = entry as Record<string, unknown>;
  return rest;
}

/** The bytes a directory signature covers. A `sig` member, if present, is ignored. */
export function canonicalDirectoryBytes(entry: Omit<DirectoryEntry, 'sig'>): Bytes {
  return utf8(DOMAIN + canonicalJson(withoutSig(entry)));
}

/** Signs the entry as given (it does not validate it); any existing `sig` is replaced. */
export function signDirectoryEntry(entry: Omit<DirectoryEntry, 'sig'>, signer: Signer): DirectoryEntry {
  const rest = withoutSig(entry);
  const sig = toHex(signer.sign(canonicalDirectoryBytes(rest as Omit<DirectoryEntry, 'sig'>)));
  return { ...rest, sig } as DirectoryEntry;
}

/** True only for a well-formed entry whose signature verifies under its own providerId. Never throws. */
export function verifyDirectoryEntry(entry: DirectoryEntry): boolean {
  try {
    if (!isWellFormedEntry(entry)) return false;
    return verifySignature(fromHex(entry.providerId), canonicalDirectoryBytes(entry), fromHex(entry.sig));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Shape checks for untrusted entries

type Check = (v: unknown) => boolean;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isHex = (bytes: number): Check => (v) => typeof v === 'string' && v.length === 2 * bytes && /^[0-9a-f]+$/.test(v);
const isInt = (min: number, max: number): Check => (v) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
// Display labels: no control characters and no bidi overrides (terminal and UI spoofing).
const UNSAFE_TEXT = /[\p{Cc}‪-‮⁦-⁩]/u;
const isLabel = (max: number): Check => (v) =>
  typeof v === 'string' && v.length >= 1 && v.length <= max && !UNSAFE_TEXT.test(v);
const isZats: Check = (v) => typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= U64_MAX;

/** No keys outside `checks`, every non-optional key present, every present key valid. Undefined counts as absent. */
function hasExactly(v: Record<string, unknown>, checks: Record<string, Check>, optional: readonly string[] = []): boolean {
  for (const k of Object.keys(v)) if (v[k] !== undefined && !Object.hasOwn(checks, k)) return false;
  return Object.entries(checks).every(([k, ok]) => (v[k] === undefined ? optional.includes(k) : ok(v[k])));
}

const GPU_CHECKS: Record<keyof DirectoryEntry['gpus'][number], Check> = {
  model: (v) => typeof v === 'string' && GPU_SLUG_PATTERN.test(v),
  count: isInt(1, 1024),
  vramGb: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 10_000,
};

const isGpuList: Check = (v) => {
  if (!Array.isArray(v) || v.length < 1 || v.length > 32) return false;
  for (let i = 0; i < v.length; i++) {
    const gpu: unknown = v[i];
    if (!isRecord(gpu) || !hasExactly(gpu, GPU_CHECKS)) return false;
  }
  return true;
};

const ENTRY_CHECKS: Record<keyof DirectoryEntry, Check> = {
  v: (v) => v === 1,
  providerId: isHex(32),
  alias: isLabel(64),
  address: (v) => typeof v === 'string' && UA_PATTERN.test(v),
  gpus: isGpuList,
  minPricePerHourZats: isZats,
  bondZats: isZats,
  region: isLabel(32),
  updatedAt: (v) => Number.isSafeInteger(v) && (v as number) >= 0,
  sig: isHex(64),
};
const OPTIONAL_ENTRY_KEYS = ['bondZats', 'region'] as const satisfies readonly (keyof DirectoryEntry)[];

function isWellFormedEntry(v: unknown): v is DirectoryEntry {
  return isRecord(v) && hasExactly(v, ENTRY_CHECKS, OPTIONAL_ENTRY_KEYS);
}
