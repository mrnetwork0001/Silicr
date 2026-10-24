# Vendored test vectors

Subsets of the official Zcash test vectors from
[zcash/zcash-test-vectors](https://github.com/zcash/zcash-test-vectors), `test-vectors/json/`,
at commit `78321beacb0e0477e33cd002b56585a107c2708c` (files last changed in `113b3914`).
Upstream is dual-licensed MIT / Apache-2.0. Rows are copied verbatim, in upstream format
(two header rows, then one vector per row).

| File | Upstream generator | What we kept |
|---|---|---|
| `unified_address.json` | `zcash_test_vectors/unified_address.py` | 26 of 60 mainnet UAs: all 9 for accounts 0–2, plus the first diversified address of each account 3–19. Covers every receiver combination upstream has, including unknown typecodes 0xfffb, 0xfffc, 0xfffd and 0xffff. Upstream has no P2SH vector; our P2SH cases are built in the tests. |
| `f4jumble.json` | `zcash_test_vectors/f4jumble.py` | The 6 vectors of 48, 64, 128, 129, 192 and 193 bytes (the two 16 KB vectors are dropped for size). |
| `f4jumble_long.json` | `zcash_test_vectors/f4jumble.py` (`long_test_vectors`) | Both: lengths 3 246 395 and 4 194 368, input `i & 0xff`, BLAKE2b-512 of the output. |
