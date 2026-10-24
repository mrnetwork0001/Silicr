/**
 * The Orchard-only privacy guard. Every recipient Silicr pays goes through
 * toOrchardOnly(): it returns a unified address holding only the Orchard
 * receiver, or throws PrivacyError explaining in plain words why the address
 * was refused. Messages never echo the input (a pasted key must not end up in
 * logs); they name the kind of address by its well-known prefix instead.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bech32, bech32m, createBase58check } from '@scure/base';
import { PrivacyError, type AddressNetwork, type DecodedAddress, type Network, type ReceiverKind } from './contract.ts';
import { isValidOrchardReceiver, randomOrchardReceiver } from './pallas.ts';
import { TYPECODE_ORCHARD, UA_HRP, decodeUnifiedAddress, encodeUnifiedAddress } from './ua.ts';

const base58check = createBase58check(sha256);

const NETWORK_NAME: Record<Network, string> = {
  main: 'mainnet',
  test: 'testnet',
  regtest: 'regtest',
  memory: 'the in-memory simulated chain (regtest encoding)',
};

const KIND_NAME: Record<ReceiverKind, string> = {
  p2pkh: 'transparent P2PKH',
  p2sh: 'transparent P2SH',
  sapling: 'Sapling',
  orchard: 'Orchard',
  unknown: 'unrecognised',
};

const TRANSPARENT_WHY = 'transparent payments publish sender, recipient and amount';
const ASK_FOR_UA = 'Ask the recipient for a unified address with an Orchard receiver';

/** Which address encoding a network uses. 'memory' backends use regtest encoding. */
export function addressNetworkOf(network: Network): AddressNetwork {
  if (network === 'memory') return 'regtest';
  if (network === 'main' || network === 'test' || network === 'regtest') return network;
  throw new TypeError(`unknown network "${String(network)}"`);
}

const refuse = (message: string): PrivacyError => new PrivacyError(message);

/** Base58Check version prefixes (zcash_protocol constants; testnet and regtest share theirs). */
const BASE58_KINDS: ReadonlyArray<{ prefix: readonly number[]; length: number; error: () => PrivacyError }> = [
  { prefix: [0x1c, 0xb8], length: 22, error: () => transparentError('t1…') },
  { prefix: [0x1c, 0xbd], length: 22, error: () => transparentError('t3…') },
  { prefix: [0x1d, 0x25], length: 22, error: () => transparentError('tm…') },
  { prefix: [0x1c, 0xba], length: 22, error: () => transparentError('t2…') },
  { prefix: [0x16, 0x9a], length: 66, error: () => sproutError('zc…') },
  { prefix: [0x16, 0xb6], length: 66, error: () => sproutError('zt…') },
];

function transparentError(prefix: string): PrivacyError {
  return refuse(`Refusing transparent address (${prefix}): ${TRANSPARENT_WHY}. ${ASK_FOR_UA}.`);
}

function sproutError(prefix: string): PrivacyError {
  return refuse(
    `Refusing Sprout address (${prefix}): the Sprout pool no longer accepts funds (ZIP 211), and Silicr pays only to Orchard receivers. ${ASK_FOR_UA}.`,
  );
}

function saplingError(prefix: string): PrivacyError {
  return refuse(
    `Refusing Sapling address (${prefix}): Silicr pays only from the Ironwood pool, and a payment to Sapling crosses pools, which publishes the amount. ${ASK_FOR_UA}.`,
  );
}

function texError(prefix: string): PrivacyError {
  return refuse(
    `Refusing TEX address (${prefix}): a TEX address (ZIP 320) accepts only transparent payments, and ${TRANSPARENT_WHY}. ${ASK_FOR_UA}.`,
  );
}

function viewingKeyError(): PrivacyError {
  return refuse(
    "Refusing viewing key: this is a viewing key, not an address. Keep it private: it reveals the wallet's transactions.",
  );
}

function spendingKeyError(): PrivacyError {
  return refuse('Refusing spending key: this is a secret key, not an address. Never paste or share it; anyone holding it can spend the funds.');
}

function garbageError(detail = 'it is not a recognised Zcash address encoding, or its checksum is wrong'): PrivacyError {
  return refuse(`Refusing address: ${detail}.`);
}

// Maps, not object literals: the HRP is attacker-chosen ("constructor" must not hit Object.prototype).
const SAPLING_HRPS = new Map([['zs', 'zs1…'], ['ztestsapling', 'ztestsapling1…'], ['zregtestsapling', 'zregtestsapling1…']]);
const TEX_HRPS = new Map([['tex', 'tex1…'], ['textest', 'textest1…'], ['texregtest', 'texregtest1…']]);
const UA_HRPS = new Set<string>(Object.values(UA_HRP));
const R2_SHIELDED_HRPS = new Set(['zu', 'zutest', 'zuregtest']);
const R2_TRANSPARENT_HRPS = new Set(['tu', 'tutest', 'turegtest']);
const UVK_HRP = /^(uview|uivk|uvf|uvi)(test|regtest)?$/;
const SAPLING_VIEWING_HRP = /^(zxview|zivk)/;
const SPENDING_KEY_HRP = /^(secret-|zxsprout|usk)/;

function decodeOrRefuse(address: string): DecodedAddress {
  // Bech32m: unified addresses and keys, Revision 2 addresses, TEX.
  const asBech32m = bech32m.decodeUnsafe(address, false);
  if (asBech32m) {
    const hrp = asBech32m.prefix;
    if (UA_HRPS.has(hrp)) {
      try {
        return decodeUnifiedAddress(address);
      } catch (err) {
        throw refuse(`Refusing malformed unified address: ${(err as Error).message}.`);
      }
    }
    const tex = TEX_HRPS.get(hrp);
    if (tex !== undefined) throw texError(tex);
    if (R2_TRANSPARENT_HRPS.has(hrp)) {
      throw refuse(`Refusing transparent-enabled unified address (tu…): it may route the payment to a transparent receiver, and ${TRANSPARENT_WHY}. ${ASK_FOR_UA}.`);
    }
    if (R2_SHIELDED_HRPS.has(hrp)) {
      throw refuse(
        'Refusing ZIP 316 Revision 2 address (zu…): Silicr does not support Revision 2 yet. Ask for a Revision 0 unified address (u1…, utest1… or uregtest1…) with an Orchard receiver.',
      );
    }
    if (UVK_HRP.test(hrp)) throw viewingKeyError();
    if (SPENDING_KEY_HRP.test(hrp)) throw spendingKeyError();
    throw garbageError('it uses an unknown Bech32m prefix');
  }

  // Bech32 (BIP 173): Sapling addresses and keys.
  const asBech32 = bech32.decodeUnsafe(address, false);
  if (asBech32) {
    const hrp = asBech32.prefix;
    const sapling = SAPLING_HRPS.get(hrp);
    if (sapling !== undefined) throw saplingError(sapling);
    if (SAPLING_VIEWING_HRP.test(hrp)) throw viewingKeyError();
    if (SPENDING_KEY_HRP.test(hrp)) throw spendingKeyError();
    throw garbageError('it uses an unknown Bech32 prefix');
  }

  // Base58Check: transparent and Sprout addresses, and WIF / Sprout secret keys.
  let raw: Uint8Array | undefined;
  try {
    raw = base58check.decode(address);
  } catch {
    raw = undefined;
  }
  if (raw !== undefined) {
    for (const kind of BASE58_KINDS) {
      if (raw.length === kind.length && raw[0] === kind.prefix[0] && raw[1] === kind.prefix[1]) throw kind.error();
    }
    const wif = (raw[0] === 0x80 || raw[0] === 0xef) && (raw.length === 33 || raw.length === 34);
    const sproutSpendingKey =
      raw.length === 34 && ((raw[0] === 0xab && raw[1] === 0x36) || (raw[0] === 0xac && raw[1] === 0x08));
    const sproutViewingKey =
      raw.length === 67 && raw[0] === 0xa8 && ((raw[1] === 0xab && raw[2] === 0xd3) || (raw[1] === 0xac && raw[2] === 0x0c));
    if (wif || sproutSpendingKey) throw spendingKeyError();
    if (sproutViewingKey) throw viewingKeyError();
    throw garbageError('it is not a recognised Zcash address encoding');
  }

  // Nothing parsed. Name the near-misses, since "checksum is wrong" helps more than "garbage".
  const lower = address.toLowerCase();
  if (lower.startsWith('zcash:')) {
    throw garbageError('this is a ZIP 321 payment URI, not an address; pass just the address');
  }
  if (/^(u|utest|uregtest)1/.test(lower)) {
    throw garbageError('it looks like a unified address, but its checksum is wrong (a typo, or truncated?)');
  }
  if (/^(t1|t3|tm|t2)[1-9A-HJ-NP-Za-km-z]{25,40}$/.test(address)) {
    throw refuse(`Refusing transparent-looking address (with a bad checksum): ${TRANSPARENT_WHY}. ${ASK_FOR_UA}.`);
  }
  if (/^(zs|ztestsapling|zregtestsapling)1/.test(lower)) {
    throw refuse('Refusing Sapling-looking address (with a bad checksum): Silicr pays only to Orchard receivers; paying Sapling from the Ironwood pool publishes the amount.');
  }
  if (/^(tex|textest|texregtest)1/.test(lower)) {
    throw refuse(`Refusing TEX-looking address (with a bad checksum): TEX addresses accept only transparent payments, and ${TRANSPARENT_WHY}.`);
  }
  throw garbageError();
}

/**
 * The privacy guard. Returns an Orchard-only UA for the same receiver, or throws
 * PrivacyError for transparent addresses, Sapling addresses, UAs without an
 * Orchard receiver, or a network mismatch ('memory' expects regtest encoding).
 */
export function toOrchardOnly(address: string, expected: Network): string {
  const want = addressNetworkOf(expected);
  if (typeof address !== 'string') throw garbageError('expected the address as a string');
  const trimmed = address.trim();
  if (trimmed === '') throw garbageError('it is empty');

  const decoded = decodeOrRefuse(trimmed);
  if (decoded.network !== want) {
    throw refuse(
      `Refusing ${NETWORK_NAME[decoded.network]} address: this wallet is on ${NETWORK_NAME[expected]}, so a payment to it could never arrive.`,
    );
  }
  const orchard = decoded.receivers.find((r) => r.typecode === TYPECODE_ORCHARD);
  if (orchard === undefined) {
    const kinds = [...new Set(decoded.receivers.map((r) => KIND_NAME[r.kind]))].join(', ');
    const reasons: string[] = [];
    if (decoded.receivers.some((r) => r.kind === 'sapling')) {
      reasons.push('paying its Sapling receiver from the Ironwood pool crosses pools, which publishes the amount');
    }
    if (decoded.receivers.some((r) => r.kind === 'p2pkh' || r.kind === 'p2sh')) reasons.push(TRANSPARENT_WHY);
    const why = reasons.length > 0 ? `; ${reasons.join(', and ')}` : '';
    throw refuse(
      `Refusing unified address without an Orchard receiver (it has only: ${kinds}): Silicr pays only to Orchard receivers${why}. ${ASK_FOR_UA}.`,
    );
  }
  if (!isValidOrchardReceiver(orchard.data)) {
    throw refuse(
      'Refusing unified address: its Orchard receiver is invalid (pk_d is not a point on the Pallas curve), so no wallet could ever receive this payment.',
    );
  }
  return encodeUnifiedAddress(want, [{ typecode: TYPECODE_ORCHARD, kind: 'orchard', data: orchard.data }]);
}

/** True iff the string is a valid unified address (any network) whose only item is a valid Orchard receiver. */
export function isOrchardOnly(address: string): boolean {
  if (typeof address !== 'string') return false;
  try {
    const { receivers } = decodeUnifiedAddress(address);
    const only = receivers[0];
    return receivers.length === 1 && only !== undefined && only.typecode === TYPECODE_ORCHARD && isValidOrchardReceiver(only.data);
  } catch {
    return false;
  }
}

/**
 * A fresh Orchard-only UA for a random receiver that nobody holds keys for.
 * For fixtures and tests (directory entries, protocol size checks); funds sent
 * to it are lost.
 */
export function randomOrchardAddress(network: Network): string {
  return encodeUnifiedAddress(addressNetworkOf(network), [
    { typecode: TYPECODE_ORCHARD, kind: 'orchard', data: randomOrchardReceiver() },
  ]);
}
