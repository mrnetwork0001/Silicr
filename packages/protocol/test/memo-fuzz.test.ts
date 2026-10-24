import { isDeepStrictEqual } from 'node:util';
import { base64urlnopad } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { type DecodedMemo, type MemoMessage, decodeMemo, encodeMemo, signerFromSecret } from '../src/index.ts';
import { encodeFrame } from '../src/memo.ts';
import { fakeUa, rng, sampleMessages, selfDeclaredKey, worstCaseMessages } from './helpers.ts';

type Rng = ReturnType<typeof rng>;
const transports = ['binary', 'text'] as const;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const ARITY = [9, 7, 4, 2, 5]; // RFQ, BID, ACCEPT, PAY, CLOSE

// Everything is seeded (and Ed25519 is deterministic), so a failing case replays exactly.
const seeded = rng(0x51c1);
const signer = signerFromSecret(seeded.bytes(32));
const strangers = [signerFromSecret(seeded.bytes(32)).publicKey, new Uint8Array(32), Uint8Array.of(1, ...new Array(31).fill(0))];
const toMemos = (msgs: MemoMessage[]) =>
  msgs.flatMap((msg) => transports.map((transport) => ({ msg, memo: encodeMemo(msg, signer, transport) })));
const samples = toMemos(sampleMessages(signer, seeded.bytes));
const valid = [...samples, ...toMemos(worstCaseMessages())];

/**
 * Decodes one memo and checks the result. A memo may verify under the real key
 * only if it decodes to a message it was derived from.
 */
function check(memo: Uint8Array, origins: MemoMessage[]): { failure?: string; decoded?: DecodedMemo } {
  let decoded: DecodedMemo | null;
  try {
    decoded = decodeMemo(memo);
  } catch (e) {
    return { failure: `decodeMemo threw ${String(e)}` };
  }
  if (decoded === null) return {};
  try {
    for (const key of strangers) if (decoded.verifiedBy(key)) return { failure: 'verified under a stranger key' };
    const own = selfDeclaredKey(decoded.msg);
    for (const key of own ? [signer.publicKey, own] : [signer.publicKey]) {
      if (decoded.verifiedBy(key) && !origins.some((o) => isDeepStrictEqual(o, decoded.msg))) {
        return { failure: `a ${decoded.msg.t} that was never signed verified` };
      }
    }
  } catch (e) {
    return { failure: `checking the result threw ${String(e)}` };
  }
  return { decoded };
}

describe('single-byte flips', () => {
  it('turn every memo into null or one that fails verification', () => {
    const r = rng(1);
    const failures: string[] = [];
    let decodedButRejected = 0;
    for (const { msg, memo } of samples) {
      for (let i = 0; i < memo.length; i++) {
        for (const mask of [0x01, 0x80, 0xff, 1 + r.int(255)]) {
          const m = memo.slice();
          m[i] = m[i]! ^ mask;
          const decoded = decodeMemo(m);
          if (decoded === null) continue;
          decodedButRejected++;
          const keys = [signer.publicKey, selfDeclaredKey(decoded.msg)].filter((k) => k !== undefined);
          if (keys.some((k) => decoded.verifiedBy(k))) failures.push(`${msg.t}: byte ${i} ^ ${mask} still verifies`);
        }
      }
    }
    expect(failures).toEqual([]);
    // Sanity: plenty of flips get past parsing, so the signature check really is exercised.
    expect(decodedButRejected).toBeGreaterThan(1000);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Generators for the fuzz run

const pad512 = (bytes: ArrayLike<number>) => {
  const memo = new Uint8Array(512);
  memo.set(Array.from(bytes).slice(0, 512));
  return memo;
};
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const header = (r: Rng) => [...ascii('SLC1'), r.int(8) === 0 ? r.int(256) : 1, r.int(8) === 0 ? r.int(256) : 1 + r.int(5)];

function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 256) return [(major << 5) | 24, n];
  return [(major << 5) | 25, n >> 8, n & 0xff];
}

/** Random CBOR-ish item: mostly well formed, often of the wrong shape, sometimes malformed. */
function item(r: Rng, depth: number): number[] {
  switch (depth > 5 ? 0 : r.int(11)) {
    case 0:
      return [r.int(256)];
    case 1:
      return head(0, r.pick([0, 1, 23, 24, 64, 65, 255, 256, 600]));
    case 2:
      return [0x1a, ...r.bytes(4)]; // u32, possibly non-minimal
    case 3:
      return [0x1b, ...r.bytes(8)]; // u64, possibly non-minimal
    case 4:
      return [0x50, ...r.bytes(16)];
    case 5:
      return [0x58, 0x20, ...r.bytes(32)];
    case 6: {
      const s = ascii(r.pick(['', 'a100', 'A100', 'h100-sxm5-80gb-x', fakeUa(113), 'tmHqEMjvxe3ZRGYTWUZjHb6AoeUstpE7vEy']));
      return [...head(3, s.length), ...s];
    }
    case 7: {
      const n = r.int(12);
      return [...head(4, n), ...Array.from({ length: n }, () => item(r, depth + 1)).flat()];
    }
    case 8:
      return [r.pick([0xf4, 0xf5, 0xf6, 0xf7, 0xf9, 0xfa, 0xfb, 0xa0, 0xc0, 0x20, 0x5f, 0x7f, 0x9f, 0xff, 0x1c])];
    case 9:
      return [r.pick([0x5a, 0x7a, 0x9a]), 0xff, 0xff, 0xff, 0xff]; // length far past the end
    default:
      return [0x18, r.int(24)]; // non-minimal
  }
}

/** A body with the right arity for some type, filled with random items. */
const body = (r: Rng) => {
  const n = r.int(6) === 0 ? r.int(12) : r.pick(ARITY);
  return [...head(4, n), ...Array.from({ length: n }, () => item(r, 1)).flat()];
};

/** `origins`: the messages this memo was derived from, which it may legitimately still equal. */
type Generated = { memo: Uint8Array; origins: MemoMessage[] };
const generators: ((r: Rng) => Generated)[] = [
  // Pure noise, then noise behind each marker the decoder knows.
  (r) => ({ memo: r.bytes(512), origins: [] }),
  (r) => ({ memo: pad512([0xff, ...r.bytes(511)]), origins: [] }),
  (r) => ({
    memo: pad512(ascii(`slc1:${Array.from({ length: r.int(508) }, () => r.pick([...B64])).join('')}`)),
    origins: [],
  }),
  // Plausible frames with random bodies, in both transports.
  (r) => ({ memo: pad512([0xff, ...header(r), ...body(r), ...r.bytes(64)]), origins: [] }),
  (r) => {
    const frame = Uint8Array.from([...header(r), ...body(r), ...r.bytes(64)].slice(0, 380));
    return { memo: pad512(ascii(`slc1:${base64urlnopad.encode(frame)}`)), origins: [] };
  },
  // Mutations of real memos.
  (r) => {
    const v = r.pick(valid);
    const m = v.memo.slice();
    for (let k = 1 + r.int(8); k > 0; k--) m[r.int(512)] = r.int(256);
    return { memo: m, origins: [v.msg] };
  },
  (r) => {
    const v = r.pick(valid);
    const at = r.int(512);
    const bytes = Array.from(v.memo);
    if (r.int(2) === 0) bytes.splice(at, 0, r.int(256));
    else bytes.splice(at, 1);
    return { memo: pad512(bytes), origins: [v.msg] };
  },
  (r) => {
    const v = r.pick(valid);
    return { memo: pad512(v.memo.subarray(0, r.int(512))), origins: [v.msg] };
  },
  (r) => {
    const v = r.pick(valid.filter((x) => x.memo[0] !== 0xff));
    const m = v.memo.slice();
    for (let k = 1 + r.int(4); k > 0; k--) m[5 + r.int(100)] = r.pick(B64.split('')).charCodeAt(0);
    return { memo: m, origins: [v.msg] };
  },
  (r) => {
    const a = r.pick(valid);
    const b = r.pick(valid);
    const at = r.int(512);
    return { memo: pad512([...a.memo.subarray(0, at), ...b.memo.subarray(at)]), origins: [a.msg, b.msg] };
  },
  // A real frame header with the body swapped for another type's body.
  (r) => {
    const a = encodeFrame(r.pick(valid).msg, signer);
    const b = r.pick(valid).msg;
    return { memo: pad512([0xff, ...a.subarray(0, 6), ...encodeFrame(b, signer).subarray(6)]), origins: [b] };
  },
];

describe('fuzzing', () => {
  it('decodeMemo never throws on 5000 random and mutated memos, and never yields a forgery', () => {
    const r = rng(0x5111c7);
    const failures: string[] = [];
    let parsed = 0;
    for (let i = 0; i < 5000; i++) {
      const { memo, origins } = generators[i % generators.length]!(r);
      expect(memo).toHaveLength(512);
      const { failure, decoded } = check(memo, origins);
      if (failure) failures.push(`case ${i}: ${failure}`);
      if (decoded) parsed++;
    }
    expect(failures).toEqual([]);
    // Sanity: a good share of cases (about 1 in 5) get through parsing to the signature check.
    expect(parsed).toBeGreaterThan(500);
  }, 120_000);
});
