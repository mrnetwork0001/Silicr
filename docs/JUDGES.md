# Silicr: the judges' verification kit

For a skeptical judge with ten minutes. Silicr claims to be a private GPU-compute market on Zcash, and the Private Markets brief treats leaks as disqualifying. This page does not ask you to trust the README: it says what Silicr claims, how to check each claim yourself with one command, where the matching test lives, what we deliberately do not protect, and what is simulated.

Everything here was written against the code and tests in this checkout. Where something could not be verified, it says so.

## 1. One command (about a minute)

```bash
pnpm install          # once. Node >= 22, pnpm 9, python3 on PATH (the example job is a real training script)
pnpm verify           # scripts/verify-privacy.ts
```

`pnpm verify` starts a complete Silicr stack inside one process on ephemeral ports: the simulated chain (`@silicr/zec` memory backend), the real relay with its observer feed, the real memo protocol and channel crypto, the process-mode job runner and a buyer and a provider with their HTTP daemons. It runs one real deal on `examples/tiny-train` (sealed RFQ, signed bid, ACCEPT, metered PAYs, heartbeats, result, CLOSE), then eleven named checks against what each party actually holds, and prints `✓` or `✗` per check with the evidence. The last line is `PASS: 11/11 checks passed in N s` or `FAIL`, and the exit code is non-zero on any failure. The run takes 15 to 30 s; everything lives in a fresh temp dir that is deleted at the end (`pnpm verify --keep` keeps it, and prints its path).

`pnpm verify`, `pnpm test` and `silicr demo` never touch a real chain, `.silicr/` or the demo ports: the simulated chain exists only inside the process.

## 2. The claims, and where each one is checked

| Claim (THREAT_MODEL.md row or mitigation) | `pnpm verify` check | Tests that already prove it |
|---|---|---|
| **Shielded only.** Every recipient is reduced to an Orchard receiver; transparent, Sapling, TEX, Sprout, viewing keys, wrong-network and malformed addresses are refused with a plain reason, in TypeScript and again in the wallet backend | 11 (`toOrchardOnly` refusals, a multi-receiver UA stripped to Orchard, the backend's `send()` refusing on its own, the relay refusing a Sapling directory address) | `packages/zec/test/guard.test.ts` (every refusal class, never echoes the input), `memory.test.ts` "refuses non-Orchard recipients with PrivacyError, and sends nothing", `testnet-live.test.ts` "the sidecar refuses non-Orchard recipients on its own"; in `zec-sidecar`, `check_proposal` and `check_built_tx` in `src/wallet.rs` (`cargo test` covers the address guard and the mainnet refusal) |
| **Public chain observer** learns only that shielded transactions happened, their action counts and fees; never senders, recipients, amounts or memos | 2 (every transaction on the chain: v6, 0 transparent, 0 Sapling, 0 legacy-Orchard, Ironwood only, fee = ZIP 317; no address, price, rfqId or memo bytes in the serialised views) | `memory.test.ts` "shows what a chain observer sees, and nothing private", "models Ironwood"; `engine/test/units.test.ts` "chain views"; `e2e.test.ts` |
| **Fixed output buckets:** the RFQ's action count does not reveal how many providers were asked | 3 (RFQs to 1 and to 2 providers both show 4 outputs and the same action count; the `padBucket` table) | `engine/test/flow.test.ts` "pads 5 providers to 8 outputs in one transaction", `units.test.ts` "pads output counts to buckets of 4, 8, 16", "dummy memos … decode to null" |
| **Silicr relay operator** learns blob sizes, timing and IPs; never contents, which RFQ a blob belongs to, prices or identities | 1 (every stored blob, every mailbox id, the whole `/_observer` feed and `directory.json` searched for 17 plaintext needles: command, rfqId as hex and raw bytes, three prices, four addresses, alias, two decrypted log lines, bundle digest) | `relay/test/relay.test.ts` "never exposes body bytes beyond the 24-byte prefix, in the feed or the logs"; `e2e.test.ts` "the relay learns nothing"; `engine/test/blobs.test.ts` |
| **Directory host** can drop an entry but cannot forge or replace one; nothing about buyers reaches it | 4 (four forgeries → 400, honest entry unchanged byte for byte, the buyer re-verifies on read) and 1 (`directory.json` holds only signed provider entries) | `relay.test.ts` directory suite ("rejects a forged signature", "someone else's signed entry with the providerId swapped", "far-future … updatedAt", "defeats the audit eviction exploit", "drops invalid rows … on start"); `protocol/test/directory.test.ts` (27 malformed variants, every field change detected); `engine/test/units.test.ts` "directory client" |
| **Signed protocol messages.** A forged BID or PAY is rejected; strict RFC 8032 verification | 7 (forged, overpriced and unasked bids ignored with the recorded reasons; accepting the stranger fails) | `engine/test/faults.test.ts` (also "provider ignores a forged PAY and a replayed PAY", "refuses an underpaid ACCEPT"); `protocol/test/memo-fuzz.test.ts` (every single-byte flip of every message, 5000 fuzz cases, no forgery); `memo.test.ts` "rejects a weak (small-order) key" |
| **Bounded loss, timed by the buyer's own clock.** A provider that lies about progress cannot pull payments early; at most 1.25 intervals at risk | 5 (an evil provider floods signed heartbeats claiming interval 9 of 10 within 200 ms; the buyer's paid count stays ≤ 1 + ⌊(t − jobStart + lead)/I⌋ at every one of ~330 samples, each PAY leaves after its window opens) | `engine/test/settlement.test.ts` "buyer-clock settlement (C1)", "exposure bound per profile" |
| **A buyer that stops paying gets nothing past the paid interval**: the provider pauses at the unpaid boundary and stops after the grace period | 6 (fault endpoint; paused at the first unpaid boundary, stopped ≈ grace later with CLOSE(unpaid); intervals served = intervals paid; "paused" heartbeats show the step frozen) | `faults.test.ts`, `e2e.test.ts` "real runner: buyer stops paying → job paused (SIGSTOP)", `settlement.test.ts` "at most one unconfirmed payment outstanding (M5)" (a PAY that never confirms, a PAY that vanishes) |
| **No lookups that reveal interest.** The wallet never fetches another party's transaction by txid | 2 (`GET /api/chain/tx/<a stranger's txid>` → 404 "not a transaction this node sent or received") | `engine/test/daemon.test.ts`; `zec/test/testnet-live.test.ts` "refuses to inspect a transaction it holds no data about, instead of asking the server"; `docs/ZCASH_SETUP.md` §5 (`inspectTx` is built from local data only) |
| **Fresh keys per RFQ:** a one-time reply address, a fresh pay-to address and a per-RFQ signing key | not a separate check; the deal's one-time reply address and fresh pay-to address are two of the needles in check 1 | `protocol/test/keys.test.ts` "gives unlinkable keys per RFQ and per seed"; `memory.test.ts` "newAddress() is fresh" |
| **Winning provider** learns the request, price and job, never the buyer's wallet, identity or IP | not a check; see the Leak Inspector (section 4) | `daemon.test.ts` asserts the provider's "Buyer identity" field is `readable: false` and that every field carries its fact tags |
| **Local daemons** cannot be driven by a web page from another origin or through DNS rebinding | 9 (foreign `Origin` → 403, foreign `Host` → 403, non-JSON POST → 415, refuses to bind to 0.0.0.0) | `daemon.test.ts` "CORS …; checks Host", "binds to loopback only" |
| **Nothing from `$HOME`, key directories or wallet data is ever packed into a job** | 10 (`$HOME`, `~/.ssh`, a project containing `.silicr/`, and with a fake home `~/.gnupg`, `~/.config/gcloud`, a `master.seed`, a symlink into `~/.aws`; no RFQ and no transaction created) | `engine/test/guards.test.ts` |
| **Seeds, keys and memo plaintext are never logged** (CLAUDE.md privacy rules); secrets at rest are owner-only | 8 (runs last: 20 secrets searched as hex, base64 and raw bytes in everything printed, the node logs, the observer feed and every relay file; every 64-hex string printed is a txid or a public key; `master.seed`, `identity.key` and state files are 0600, data dirs 0700) | `guard.test.ts` "never echoes the refused input"; `memo.test.ts` "names the field in errors but never echoes its value"; `keys.test.ts` "does not expose the secret on the signer object"; `docs/ZCASH_SETUP.md` §2 (wallet files 0600) |
| **Docker runner isolates jobs**: no network, read-only filesystem, all capabilities dropped (known limit 7 says the process-mode fallback does not) | not covered: `pnpm verify` uses process mode on purpose, so it runs anywhere | `runner/test/docker.test.ts` (runs only when Docker answers; probes network, read-only root and bundle, pause/stop, timeout), `units.test.ts` "docker argv", `bundle.test.ts` (19 unsafe-archive cases: traversal, symlinks, devices, zip bombs) |

The numbered checks print in the order 1 to 7, 9, 10, 11, and then 8, because 8 scans everything the others printed.

## 3. Reading the `pnpm verify` output

The header says what is real and what is not: the chain is simulated (no real ZEC, 100 ms blocks), the relay, the crypto and the training job are real, and the runner is process mode, which is **not a sandbox**. Then the deal summary: one RFQ to one provider padded to 4 outputs, one signed bid, an ACCEPT and a few PAYs, the result's SHA-256 matching the provider's signed CLOSE, and `metrics.json` from the real training run.

Each check prints its evidence underneath. The lines worth reading closely:

- **1.** `none of 17 plaintext needles found` and `observer fields are only: providerId, size, sha256, client ip, time, entries, mailbox, seq, first 24 bytes`. The first 24 bytes of a blob are its random nonce. Note the client IP: the relay does see who connects (known limit 2).
- **2.** `every one: version 6, 0 transparent inputs/outputs, 0 Sapling spends/outputs, 0 legacy-Orchard actions` and the RFQ's `5 actions = 4 padded outputs + 1 change`. The fee is the only amount an observer learns.
- **3.** The two RFQs show `identical shape` on chain.
- **5.** `claiming interval 9 of 10 served 186 ms after the job start; the buyer had paid 1 interval(s) by then`, and `intervals paid ≤ 1 + floor(...)` at every sample. This is the regression for the design flaw the audit found (ARCHITECTURE.md §4, last paragraph): an earlier engine paid on heartbeats and could be drained in under a second.
- **6.** `provider paused … at the first unpaid boundary`, `stopped … after pausing (grace 2000 ms)`, `intervals paid 0,1 = intervals served 0..1`.
- **8.** `not found in … of this script's stdout/stderr, … the observer feed or … relay files`, then the count of 64-hex strings printed (the RFQ's txid in the deal summary, at least) with `every one is a transaction id or a public key`, and the `0600` / `0700` modes.

If a check fails, the line after its evidence starts with `FAILED:` and names the first assertion that did not hold; for check 6 it also dumps both sides' view of the job.

## 4. The other one-liners (another five minutes)

**The test suites.** `pnpm test` runs every package's Vitest suite (`pnpm --filter @silicr/<pkg> test` for one). Counts measured in this checkout on 2026-10-21, all passing:

| Package | Tests | What they cover |
|---|---|---|
| `@silicr/api` | 0 (types only) | the daemon ↔ web contract |
| `@silicr/cli` | 8 | every command against an in-process stack, including `run --auto` end to end |
| `@silicr/engine` | 69 | happy path, padding and text-memo fallback, settlement (C1, M5), faults, forged messages, guards, daemon surface, persistence, chunked blobs, proxy support |
| `@silicr/mcp` | 23 | the MCP server that lets an agent rent compute through the local buyer daemon |
| `@silicr/protocol` | 314 | memo wire format and size budget, every-byte flips and 5000-case fuzz, strict signatures, channel crypto, heartbeats, directory entries, CBOR |
| `@silicr/relay` | 46 | mailboxes, limits, TTL, directory forgery and eviction, CORS, observer feed privacy, client retries, SOCKS proxying |
| `@silicr/runner` | 59 (6 of them Docker-mode probes, which skip when Docker is unreachable) | process mode (pause/resume/stop, timeouts, minimal env), bundle packing determinism, unsafe archives, Docker isolation |
| `@silicr/zec` | 192 (+9 live-testnet tests skipped unless `SILICR_TESTNET_LIVE=1`) | the Orchard-only guard, the ZIP 316 codec against the reference vectors, the memory chain, the sidecar protocol |
| `@silicr/web` | 35 | formatting, config, the market view, the mock driver and the Leak Inspector's fact matrix |

The Rust wallet has its own: `cd zec-sidecar && cargo test --release` (address guard, mainnet refusal, transaction views against a real public v6 Ironwood transaction, the size formula, the local tx store).

**The demo.** `pnpm silicr demo --run --fast` runs the same deal on ports 7700–7702 with the CLI's live view (use `--port-base` and `--data` if those ports are busy). Look for: `RFQ … sealed to 1 provider(s) in 1 tx, 4 outputs after padding`; `CHAIN public view of …: 5 shielded (Ironwood) actions, … 0 transparent parts; no sender, recipients, amounts or memo text`; `BID … signature valid`; `ACCEPT … interval #0 paid`; one `PAY #n` per interval with its txid; `RESULT digest matches the provider's signed CLOSE`; and the closing line `N transactions on the simulated chain, 0 transparent or Sapling parts`. The `runner` line says `process mode: NOT a sandbox` unless Docker (or Colima) is running. `pnpm silicr fault <rfq> stop-paying` and `stop-heartbeats` inject the faults of checks 5 and 6 by hand.

**The Leak Inspector.** With the demo kept running (`pnpm silicr demo --run --fast --keep`), start the web terminal with `pnpm --filter @silicr/web dev` and open http://localhost:7703. Press **L** to toggle the Leak Inspector (Esc closes it; 1–6 pin one of the key facts, 0 clears). It shows the same request from four viewpoints, each column built from that party's own data: the public chain from `GET /api/chain/tx/<txid>`, the relay from its `/_observer` feed, and the provider and the buyer from their `GET /api/leaks`. Nothing in it is a diagram.

**A real chain.** Silicr's real-chain mode runs on Zcash mainnet (or testnet), with small amounts, and is unaudited. [docs/MAINNET.md](MAINNET.md) is the mainnet checklist (an explicit `--network main` opt-in, required spend caps, what a demo costs in fees, which explorers render v6 transactions) and [docs/ZCASH_SETUP.md](ZCASH_SETUP.md) covers testnet. `pnpm verify`, `pnpm test` and `silicr demo` never touch either. The testnet round trip is `npx tsx packages/zec/scripts/testnet-roundtrip.ts` (`--no-send` only creates and syncs the wallets and prints addresses). No mainnet run is recorded in this kit; the lead will add transaction ids here once one has happened, and MAINNET.md marks what has not been exercised on mainnet yet as *unverified*. Two things to know before trusting a real-chain claim: this kit did not run the round trip (no funded wallet was available while it was written), and the network checks in the checkout it was written against (`packages/zec/src/testnet/index.ts`, `zec-sidecar/src/remote.rs`, `packages/cli/src/commands/node.ts`) accepted testnet only, so mainnet depends on the change MAINNET.md describes as being added with it.

## 5. Known limits, stated plainly

Copied from THREAT_MODEL.md, not softened.

1. **The workload is visible to the winning provider.** Hiding it would need TEE execution with attestation, which is future work. Buyers with secret weights should treat providers as able to see their code and data.
2. **Network metadata.** The relay sees both parties' IP addresses, and the light-wallet server sees each wallet's IP and broadcasts. Mitigations are future work: Tor or SOCKS support, or running your own Zebra + Zaino/lightwalletd.
3. **No proof of correct computation.** Heartbeats show the job is progressing, not that it ran on the claimed GPU or produced honest outputs. Bonds and reputation discourage cheating but don't prevent it.
4. **Timing correlation and the payment train.** The light-wallet server sees the buyer's IP broadcast one padded RFQ, then a run of uniform 2-action payments. From that it can link one job's transactions and infer roughly how long the job ran. Random jitter on payment times blurs the cadence, but not the count. Whoever runs the relay can also line up blob timing with chain timing. Mitigations not yet built: batched payments, randomised upload delays, Tor, and running your own light-wallet server.
5. **Losing bidders see demand.** RFQ details reach every provider asked. Buyers control this by choosing how many to ask.
6. **The arbiter is trusted** in the FROST bond flow (stretch only).
7. **Process-mode runner is not a sandbox.** The Docker runner isolates jobs: no network, read-only filesystem, all capabilities dropped. The process-mode fallback, used when Docker is unavailable, does not, and the provider's status says so.

You can see limits 2 and 4 in the `pnpm verify` output itself: the observer feed carries a `client ip` field, and check 6's evidence shows the chain receiving one PAY per interval. On mainnet, Silicr's transactions sit among every other shielded Ironwood transaction, which weakens the inference in limit 4 but does not remove it.

## 6. What we tried to break, and could not

The audit notes behind the checks above, with where to look.

- **Shielded-only, enforced twice.** `toOrchardOnly()` (`packages/zec/src/guard.ts`) is applied to every recipient by the engine (`NodeBase.guard`) and again inside each backend's `send()`; on a real chain the Rust sidecar checks the proposal (`check_proposal`: one step, no transparent inputs, Ironwood notes only) and the built transaction (`check_built_tx`: no transparent, Sapling or legacy-Orchard bundle, exactly one Ironwood bundle) before broadcast. A legacy-Orchard spend would cross the NU6.3 turnstile and publish the amount; the public views report the legacy bundle separately so that could never be hidden by a sum.
- **No txid lookups.** `inspectTx` is built from the wallet's own copies (broadcast bytes, mempool stream, compact blocks) and throws `TxNotKnownError` rather than asking lightwalletd (`docs/ZCASH_SETUP.md` §5); the daemons refuse any txid they did not send or receive (`NodeBase.inspectTx`).
- **Relay ciphertext-only.** The relay never parses bodies; the observer feed keeps 24 bytes, a size and a hash prefix (`packages/relay/src/observer.ts`). Mailbox ids are HKDF outputs of the channel secret, so the relay cannot even group blobs by RFQ. Job, logs, heartbeats and results are sealed with XChaCha20-Poly1305 under a key from X25519 + HKDF, with the blob kind and rfqId in the associated data so blobs cannot be swapped between roles or RFQs (`packages/protocol/src/channel.ts`, `channel.test.ts`).
- **Memo protocol replay and forgery.** Every memo is a signed frame; verification is strict (canonical encodings, s < L, small-order keys rejected). Every single-byte flip of every sample message either fails to decode or fails to verify, and 5000 random or mutated memos never verify as a message that was not signed (`memo-fuzz.test.ts`). A replayed PAY is rejected as `already paid (replay)`, an out-of-order one as `in the past`, a bid after `expiresHeight` as late, an ACCEPT that underpays interval 0 is refused (`faults.test.ts`).
- **Settlement.** The earlier design paid interval k+1 as soon as a heartbeat claimed interval k; the audit showed a lying provider could collect the whole budget at once, and the engine now pays on the buyer's clock only (ARCHITECTURE.md §4). The provider side serves an interval only when its payment has been seen and the previous one is mined, so a double-spent payment costs at most one interval, once (`settlement.test.ts` M5).
- **Daemon CSRF and rebinding.** Loopback bind only; an `Origin` outside the web terminal's two origins gets 403 with no CORS headers; a non-loopback `Host` gets 403; bodies must be JSON (`packages/engine/src/daemon.ts`).
- **Runner.** Docker mode: `--network none --cap-drop ALL --security-opt no-new-privileges --read-only --pids-limit --cpus --memory`, bundle mounted read-only, a random container name (`dockerRunArgs`). Bundle unpacking refuses path traversal, absolute paths, symlinks and hard links, devices, FIFOs, PAX and GNU long-name overrides, duplicates and decompression bombs before writing anything (`bundle.test.ts`). Process mode gives the job a minimal environment (the provider's variables are not passed on) and its own copy of the bundle, and is labelled as not a sandbox everywhere it appears.
- **Secrets at rest.** `master.seed`, `identity.key`, state files and wallet files are written atomically with mode 0600 in 0700 directories; signers keep the secret in a closure so printing one shows only the public key; the guard's error messages never echo the refused input; the directory refuses aliases with control characters or bidi overrides (terminal spoofing).
- **Directory eviction.** The audit found that a forged entry with a huge `updatedAt` could evict an honest one from a relay that only compared timestamps. Writes are now signature-checked, the timestamp is bounded to 24 h ahead, and `directory.json` is re-checked on start (`relay.test.ts` "defeats the audit eviction exploit").

## 7. What is simulated and what is real

| Piece | In `pnpm verify` and `silicr demo` | On a real chain |
|---|---|---|
| Chain | **Simulated** by `createMemoryNetwork()`: Orchard-receiver-only recipients, Ironwood-only value, ZIP 317 fees, action padding to 2, random output positions, mempool then blocks, change pending until mined, `inspectTx` returning only what an observer sees. No zero-knowledge proofs are made and nothing leaves the process. | **Real**: `zec-sidecar`, a Rust light wallet on librustzcash (`zcash_client_backend` 0.24) talking to a lightwalletd; v6 Ironwood transactions with real proofs. Zcash mainnet (or testnet), small amounts, unaudited. |
| Relay and directory | Real (`@silicr/relay` over HTTP on 127.0.0.1) | Real; the same server, reachable by both parties |
| Memo protocol, signatures, channel crypto | Real (`@silicr/protocol`) | Real |
| Job runner | Process mode: a child process of the provider, **not a sandbox** (`silicr demo` picks Docker when it is reachable) | Docker mode when available (`runner.sandboxed: true`); process mode otherwise, and the status says so |
| Job | Real: `examples/tiny-train` trains a bigram model with checkpoints and resumes | Any bundle the buyer ships |
| GPUs | Simulated: the provider advertises GPUs, the job runs on the CPU | Passed through with `--gpus` only when the NVIDIA runtime exists; otherwise CPU, and the runner says so |
| FROST bonds, Noir job-count proof | Not built (stretch) | Not built |

## 8. What this kit could not verify

- A real-chain round trip: not executed here. The wallets in this checkout were unfunded when the kit was written, and no mainnet run has happened yet.
- Docker isolation: `pnpm verify` runs the job in process mode so it works on any machine; the Docker probes in `runner/test/docker.test.ts` run only where `docker info` answers.
- The Rust sidecar's second guard layer and its refusal of mainnet servers: `cargo test` and the live testnet tests, not `pnpm verify`.
- That heartbeats prove honest computation: they do not, and the threat model says so (limit 3).
