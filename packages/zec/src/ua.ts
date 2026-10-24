/**
 * ZIP 316 unified address codec (Revision 0: HRPs "u", "utest", "uregtest").
 * Spec: https://zips.z.cash/zip-0316 § "Encoding of Unified Addresses" and
 * § "Requirements for both Unified Addresses and Unified Viewing Keys".
 *
 * Encoding: items as (typecode: compactSize, length: compactSize, data) in
 * ascending typecode order || HRP padded to 16 bytes → F4Jumble → Bech32m
 * with no length limit. Decoding reverses that and enforces every structural
 * rule the ZIP puts on Consumers. This layer checks receiver lengths, as the
 * reference `zcash_address` crate does; whether the Orchard pk_d is a valid
 * curve point is checked by the Orchard-only guard (see guard.ts).
 */
import { bech32m } from '@scure/base';
import type { AddressNetwork, DecodedAddress, Receiver, ReceiverKind } from './contract.ts';
import { F4JUMBLE_MAX_LENGTH, F4JUMBLE_MIN_LENGTH, f4jumble, f4jumbleInv } from './f4jumble.ts';

/** Thrown by decodeUnifiedAddress / encodeUnifiedAddress for anything that isn't a valid ZIP 316 UA. */
export class UnifiedAddressError extends Error {
  override name = 'UnifiedAddressError';
}

/** Revision 0 unified address HRPs. */
export const UA_HRP: Readonly<Record<AddressNetwork, string>> = Object.freeze({
  main: 'u',
  test: 'utest',
  regtest: 'uregtest',
});

const NETWORK_BY_HRP: ReadonlyMap<string, AddressNetwork> = new Map(
  (Object.keys(UA_HRP) as AddressNetwork[]).map((network) => [UA_HRP[network], network]),
);

export const TYPECODE_P2PKH = 0x00;
export const TYPECODE_P2SH = 0x01;
export const TYPECODE_SAPLING = 0x02;
export const TYPECODE_ORCHARD = 0x03;

const KNOWN_KINDS: readonly ReceiverKind[] = ['p2pkh', 'p2sh', 'sapling', 'orchard'];
/** Receiver encoding lengths: transparent = 20-byte hash, Sapling/Orchard = 11-byte d || 32-byte pk_d. */
const KNOWN_LENGTHS: readonly number[] = [20, 20, 43, 43];

/** compactSize values (typecodes and lengths) MUST be <= 0x2000000. */
const MAX_COMPACT_SIZE = 0x2000000;
/** 0xC0..=0xFC are Metadata Items; 0xE0..=0xFC are MUST-understand and forbidden in Revision 0. */
const METADATA_MIN = 0xc0;
const MUST_UNDERSTAND_MIN = 0xe0;
const METADATA_MAX = 0xfc;
const PADDING_LENGTH = 16;

const hex2 = (n: number): string => `0x${n.toString(16).padStart(2, '0')}`;

/** The kind a typecode decodes to. Anything other than 0x00..0x03 is preserved as 'unknown'. */
export function receiverKind(typecode: number): ReceiverKind {
  return KNOWN_KINDS[typecode] ?? 'unknown';
}

function hrpPadding(hrp: string): Uint8Array {
  if (hrp.length > PADDING_LENGTH) throw new UnifiedAddressError(`HRP "${hrp}" is longer than 16 bytes`);
  const padding = new Uint8Array(PADDING_LENGTH);
  for (let i = 0; i < hrp.length; i++) padding[i] = hrp.charCodeAt(i);
  return padding;
}

function compactSizeLength(n: number): number {
  return n < 0xfd ? 1 : n <= 0xffff ? 3 : 5; // n <= 0x2000000 always fits the 0xfe form
}

function writeCompactSize(out: Uint8Array, pos: number, n: number): number {
  if (n < 0xfd) {
    out[pos] = n;
    return pos + 1;
  }
  if (n <= 0xffff) {
    out[pos] = 0xfd;
    out[pos + 1] = n & 0xff;
    out[pos + 2] = n >>> 8;
    return pos + 3;
  }
  out[pos] = 0xfe;
  out[pos + 1] = n & 0xff;
  out[pos + 2] = (n >>> 8) & 0xff;
  out[pos + 3] = (n >>> 16) & 0xff;
  out[pos + 4] = n >>> 24;
  return pos + 5;
}

/** Reads a canonical (minimally encoded) compactSize <= 0x2000000. Returns [value, nextPos]. */
function readCompactSize(buf: Uint8Array, pos: number, what: string): [number, number] {
  const first = buf[pos];
  if (first === undefined) throw new UnifiedAddressError(`truncated item: missing ${what}`);
  if (first < 0xfd) return [first, pos + 1];
  if (first === 0xfd) {
    if (pos + 3 > buf.length) throw new UnifiedAddressError(`truncated compactSize ${what}`);
    const value = buf[pos + 1]! | (buf[pos + 2]! << 8);
    if (value < 0xfd) throw new UnifiedAddressError(`non-canonical compactSize ${what}`);
    return [value, pos + 3];
  }
  if (first === 0xfe) {
    if (pos + 5 > buf.length) throw new UnifiedAddressError(`truncated compactSize ${what}`);
    const value = buf[pos + 1]! + buf[pos + 2]! * 0x100 + buf[pos + 3]! * 0x10000 + buf[pos + 4]! * 0x1000000;
    if (value < 0x10000) throw new UnifiedAddressError(`non-canonical compactSize ${what}`);
    if (value > MAX_COMPACT_SIZE) throw new UnifiedAddressError(`${what} ${value} exceeds 0x2000000`);
    return [value, pos + 5];
  }
  // 0xff introduces a 64-bit value; a canonical one is >= 2^32, far above the 0x2000000 cap.
  throw new UnifiedAddressError(`${what} exceeds 0x2000000`);
}

/**
 * The Consumer-side item rules of ZIP 316 Revision 0, for items in encoding order:
 * typecodes strictly ascending (so no duplicates), not both P2PKH and P2SH,
 * no MUST-understand metadata, known receivers have their exact lengths,
 * at least one non-metadata item, and at least one that isn't transparent.
 * (Like librustzcash, an unrecognised data typecode counts as non-transparent:
 * it may be a future shielded pool, and Consumers must ignore it, not reject it.)
 */
function validateItems(items: readonly Receiver[]): void {
  if (items.length === 0) throw new UnifiedAddressError('a unified address must contain at least one receiver');
  let previous = -1;
  let hasData = false;
  let hasNonTransparentData = false;
  for (const item of items) {
    const tc = item.typecode;
    if (!Number.isInteger(tc) || tc < 0 || tc > MAX_COMPACT_SIZE) {
      throw new UnifiedAddressError(`typecode ${String(tc)} is out of range (0..0x2000000)`);
    }
    if (tc === previous) throw new UnifiedAddressError(`duplicate typecode ${hex2(tc)}`);
    if (tc < previous) throw new UnifiedAddressError('receivers are not in ascending typecode order');
    if (tc === TYPECODE_P2SH && previous === TYPECODE_P2PKH) {
      throw new UnifiedAddressError('a unified address must not contain both P2PKH and P2SH receivers');
    }
    if (tc >= MUST_UNDERSTAND_MIN && tc <= METADATA_MAX) {
      throw new UnifiedAddressError(
        `typecode ${hex2(tc)} is MUST-understand metadata, which a Revision 0 unified address must not contain`,
      );
    }
    const expectedLength = KNOWN_LENGTHS[tc];
    if (expectedLength !== undefined && item.data.length !== expectedLength) {
      throw new UnifiedAddressError(
        `${receiverKind(tc)} receiver must be ${expectedLength} bytes, got ${item.data.length}`,
      );
    }
    if (tc < METADATA_MIN || tc > METADATA_MAX) {
      hasData = true;
      if (tc !== TYPECODE_P2PKH && tc !== TYPECODE_P2SH) hasNonTransparentData = true;
    }
    previous = tc;
  }
  if (!hasData) throw new UnifiedAddressError('a unified address must contain at least one non-metadata item');
  if (!hasNonTransparentData) {
    throw new UnifiedAddressError('a Revision 0 unified address must contain at least one shielded receiver');
  }
}

/** Decode a ZIP 316 unified address (bech32m + F4Jumble). Throws UnifiedAddressError on bad checksum, padding or encoding. */
export function decodeUnifiedAddress(ua: string): DecodedAddress {
  if (typeof ua !== 'string') throw new UnifiedAddressError('a unified address must be a string');
  let prefix: string;
  let words: number[];
  try {
    ({ prefix, words } = bech32m.decode(ua, false));
  } catch (err) {
    throw new UnifiedAddressError(`not a valid Bech32m string: ${(err as Error).message}`);
  }
  const network = NETWORK_BY_HRP.get(prefix);
  if (network === undefined) throw new UnifiedAddressError(`unknown unified address prefix "${prefix}"`);

  let jumbled: Uint8Array;
  try {
    jumbled = bech32m.fromWords(words);
  } catch (err) {
    throw new UnifiedAddressError(`invalid Bech32m data padding: ${(err as Error).message}`);
  }
  if (jumbled.length < F4JUMBLE_MIN_LENGTH || jumbled.length > F4JUMBLE_MAX_LENGTH) {
    throw new UnifiedAddressError(`encoded length ${jumbled.length} is outside ${F4JUMBLE_MIN_LENGTH}..${F4JUMBLE_MAX_LENGTH} bytes`);
  }
  const raw = f4jumbleInv(jumbled);

  const padding = hrpPadding(prefix);
  const bodyLength = raw.length - PADDING_LENGTH;
  for (let i = 0; i < PADDING_LENGTH; i++) {
    if (raw[bodyLength + i] !== padding[i]) {
      throw new UnifiedAddressError('invalid padding: the address is corrupted or its prefix was changed');
    }
  }

  const receivers: Receiver[] = [];
  let pos = 0;
  while (pos < bodyLength) {
    let typecode: number;
    let length: number;
    [typecode, pos] = readCompactSize(raw, pos, 'typecode');
    [length, pos] = readCompactSize(raw, pos, 'length');
    if (pos + length > bodyLength) {
      throw new UnifiedAddressError(`truncated item: typecode ${hex2(typecode)} claims ${length} bytes`);
    }
    receivers.push({ typecode, kind: receiverKind(typecode), data: raw.slice(pos, pos + length) });
    pos += length;
  }
  validateItems(receivers);
  return { network, receivers };
}

/** Encode receivers as a ZIP 316 unified address (receivers sorted by typecode as the spec requires). */
export function encodeUnifiedAddress(network: AddressNetwork, receivers: Receiver[]): string {
  const hrp = UA_HRP[network];
  if (hrp === undefined || !Object.hasOwn(UA_HRP, network)) {
    throw new UnifiedAddressError(`unknown address network "${String(network)}" (expected main, test or regtest)`);
  }
  if (!Array.isArray(receivers)) throw new UnifiedAddressError('receivers must be an array');
  const items = receivers
    .map((receiver, i): Receiver => {
      if (receiver === null || typeof receiver !== 'object' || !(receiver.data instanceof Uint8Array)) {
        throw new UnifiedAddressError(`receivers[${i}] must be { typecode, kind, data: Uint8Array }`);
      }
      const kind = receiverKind(receiver.typecode);
      if (receiver.kind !== kind) {
        throw new UnifiedAddressError(
          `receivers[${i}] has kind "${String(receiver.kind)}" but typecode ${hex2(receiver.typecode)} is "${kind}"`,
        );
      }
      return receiver;
    })
    .sort((a, b) => a.typecode - b.typecode);
  validateItems(items);

  let bodyLength = 0;
  for (const item of items) {
    bodyLength += compactSizeLength(item.typecode) + compactSizeLength(item.data.length) + item.data.length;
  }
  const total = bodyLength + PADDING_LENGTH;
  if (total < F4JUMBLE_MIN_LENGTH || total > F4JUMBLE_MAX_LENGTH) {
    throw new UnifiedAddressError(`encoded length ${total} is outside ${F4JUMBLE_MIN_LENGTH}..${F4JUMBLE_MAX_LENGTH} bytes`);
  }
  const raw = new Uint8Array(total);
  let pos = 0;
  for (const item of items) {
    pos = writeCompactSize(raw, pos, item.typecode);
    pos = writeCompactSize(raw, pos, item.data.length);
    raw.set(item.data, pos);
    pos += item.data.length;
  }
  raw.set(hrpPadding(hrp), pos);
  return bech32m.encode(hrp, bech32m.toWords(f4jumble(raw)), false);
}
