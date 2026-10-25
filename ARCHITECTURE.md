# Silicr: Architecture

## 1. Components

```
 Buyer machine                                         Provider machine
┌──────────────────────┐                             ┌──────────────────────┐
│ silicr CLI / web UI  │                             │ silicr provide       │
│  • shielded wallet   │   shielded txs + memos      │  • shielded wallet   │
│  • bid ranking       │◀──────── Zcash ────────────▶│  • memo listener     │
│  • metered payer     │                             │  • auto-bidder       │
│  • Leak Inspector    │                             │  • container runner  │
└─────────┬────────────┘                             │  • payment watchdog  │
          │  E2E-encrypted blobs                     └─────────┬────────────┘
          └──────────────▶ Silicr Relay ◀──────────────────────┘
                     (ciphertext only, no keys)
                 Provider Directory (public, pseudonymous)
```

- **Zcash** carries every coordination message (RFQ, BID, ACCEPT, CLOSE) and every payment. Everything is a shielded transaction paid to Orchard receivers. Since the NU6.3 "Ironwood" upgrade, that value lives in the Ironwood pool (see §2).
- **The relay** moves large blobs (the job bundle, logs, results) that don't fit in a memo. It stores ciphertext under random IDs and holds no keys.
- **The directory** is a public, signed list of provider entries:
  - a pseudonym and specs
  - the provider's Orchard unified address
  - its Ed25519 signing key and an optional bond address
  
  It holds no buyer data, so it can live as a JSON file in a Git repo.
- **There is no matching engine.** The buyer's client gathers bids and chooses one.

### Relay-less mode (`--transport memo`)

For small jobs the relay is optional: the sealed job, the provider's heartbeats and log batches, and the result all travel **inside Zcash memos**, so a deal needs nothing but the chain. The relay then only serves the public directory.

- **Framing.** A sealed blob (the same `Channel.seal()` ciphertext the relay would store) is cut into chunks, each a signed `BLOB` frame (type byte 6, additive to the memo protocol in §3): `[rfqId, kind, seq, index, total, sha256 (chunk 0 only), payload]`. A chunk fills the 380-byte frame budget: 244 payload bytes for chunk 0, 276 for the rest. Chunks are signed like every other memo (buyer → provider with the RFQ key, provider → buyer with the directory key); the AEAD on the whole blob still authenticates the content. The receiver reassembles per `(rfqId, kind, seq)`, drops duplicates, mismatched totals and anything that fails the digest, and bounds its buffer. See `packages/protocol/src/memochunks.ts`.
- **Transactions.** One shielded transaction carries up to `maxOutputsPerTx` outputs (40 on the sidecar and the memory chain), each paying the backend's minimum note value to the counterparty (the buyer sends to the bid's `payTo`, the provider to the RFQ's `replyTo`) with one chunk in its memo: ≈ 10.8 KB of sealed data per transaction. A blob is refused above a cap (default ≈ 44 KB, four transactions) with a message that points at the relay. Everything is Ironwood-only, as in §2: the chain shows an N+1-action shielded transaction and nothing else.
- **Negotiation.** The RFQ body is unchanged (its decoder is fixed-arity, so a trailing field would not be backward compatible). A memo-mode buyer instead adds one **HELLO** output per provider to the RFQ transaction: a `BLOB` of kind `control`, seq 0, payload `silicr/v1/transport/memo`, signed with the RFQ key. Two outputs per provider still pad to the usual 4/8/16 buckets. Memos are read before the RFQ handler runs, so output order within the transaction does not matter. Both sides must run the same mode: a relay provider that sees a HELLO, or a memo provider that does not, refuses to bid and records the reason (`no-bid` in its Leak Inspector); a provider's transport is part of what it offers, like its GPUs.
- **Cost model (ZIP 317, 5,000 zats per action).** A transaction with *n* memo outputs costs 5,000 × (*n* + 1) zats plus *n* × `minOutputZats` in note values that the other side receives. A full 40-output transaction is 205,000 zats (0.00205 ZEC) for 11,008 sealed bytes: about 0.00019 ZEC per KB. A 2 KB job is one 9-output transaction (50,000 zats). Heartbeats are sent **once per interval** (plus on every status or interval change, and the final one), not every 15 s, so a job costs its sender about 2 × 10,000 zats per interval for a heartbeat and a log batch, which the per-RFQ fee totals and the spend caps include. A log batch keeps the tail that fits one transaction.
- **Latency.** The receiver sees a blob as soon as its memos reach its wallet's mempool view (the sidecar and the memory chain both report unconfirmed notes), otherwise one block (~25 s on testnet since NU7, ~75 s on mainnet until its NU7 at height 3,543,405) per hop. The buyer's heartbeat timeout and payment-freshness window stretch to at least two intervals plus two blocks in this mode.
- **What it buys.** No relay operator sees blob sizes, timing or IP addresses: the only third party left is the light-wallet server (see THREAT_MODEL.md). What it costs: fees per memo, a job-size ceiling, and a payment train with more transactions per interval, which makes the timing correlation in THREAT_MODEL limit #4 a little easier.

## 2. Zcash integration

- **Pool: shielded only, Ironwood.**
  - The NU6.3 "Ironwood" upgrade went live on mainnet on 2026-07-28, and on testnet from height 4,134,000. It sealed the legacy Orchard pool after a soundness bug.
  - Since then, payments to Orchard receivers land in the new **Ironwood** pool: same keys, same unified-address receiver (typecode 0x03), Orchard-shaped actions, v6 transactions.
  - The legacy Orchard pool is withdraw-only, through a turnstile that **publishes the amount**.
  - Silicr therefore uses Orchard-receiver-only unified addresses (`toOrchardOnly()`), spends **Ironwood notes only**, and refuses transparent, Sapling and legacy-Orchard spends. The Rust sidecar checks this twice: once on the proposal and once on the finished transaction.
- **Stack:** chosen in the Week 0 spike. **`zec-sidecar/`** is our own Rust light wallet on librustzcash (`zcash_client_backend` 0.24, `zcash_client_sqlite` 0.22), one process per wallet, speaking JSON lines over stdio to `packages/zec/src/testnet/`. It syncs from a testnet lightwalletd (`testnet.zec.rocks:443` by default) and refuses any server that isn't on testnet.
  - **Ruled out:**
    - zcash-devtool: human-readable output only, no mempool access.
    - zingo-cli: text-only memos.
    - Zallet + Zebra + Zaino: a full node sync takes hours to days. It remains the self-hosted option.
  - See [docs/ZCASH_SETUP.md](docs/ZCASH_SETUP.md).
- **Wrapper:** everything else talks to the `ZecBackend` interface in [packages/zec/src/contract.ts](packages/zec/src/contract.ts). It has two implementations: the testnet/mainnet sidecar (what the app runs on) and the simulated memory chain, which exists only inside the test suite and `pnpm verify`.
- **Fees:** ZIP 317 fees: 5,000 zats per logical action, minimum 2, so a simple payment costs 0.0001 ZEC. An RFQ to N providers is one transaction with N outputs. The client pads N up to a fixed bucket (4, 8 or 16) with dummy outputs to itself, so the action count doesn't reveal how many providers were asked.
- **Confirmations:**
  - Received funds become spendable after 10 confirmations (the ZIP 315 default), and the wallet's own change after 3.
  - BID, ACCEPT and PAY messages are acted on as soon as they appear in the mempool, since each payment is small.
  - The buyer splits its balance into several notes before a job, so interval payments never wait for change to confirm.

## 3. Memo protocol v1

A memo is 512 bytes. Each message is one signed frame with a deterministic CBOR body:

```
[ magic "SLC1" | version u8 | type u8 | cbor body | ed25519 sig (64 B) ]
```

The frame travels in one of two encodings, depending on what the wallet backend can carry:
- **binary:** the ZIP 302 arbitrary-data memo (`0xFF` prefix, then the frame, zero padded).
- **text:** a UTF-8 text memo, `slc1:` + base64url(frame), for wallets that only carry text memos.

Every message has to fit in both, and tests check the worst case. The exact types are in [packages/protocol/src/contract.ts](packages/protocol/src/contract.ts).

| Type | From → To | Body (key fields) | Tx value |
|---|---|---|---|
| `RFQ` | buyer → each provider | `rfqId`, `gpu`, `count`, `durationS`, `maxPricePerHour` (0 = undisclosed: providers bid their own price and the buyer filters locally; the default), `replyTo` (one-time address), `buyerKey` (Ed25519), `buyerEph` (X25519), `expiresHeight` | minimum |
| `BID` | provider → `replyTo` | `rfqId`, `providerId`, `pricePerInterval`, `intervalS`, `startWithinS`, `providerEph`, `payTo` (fresh address) | minimum |
| `ACCEPT` | buyer → `payTo` | `rfqId`, `providerId`, `intervals`, `pricePerInterval` | pays interval 0 |
| `PAY` | buyer → `payTo` | `rfqId`, `seq` | pays interval `seq` |
| `CLOSE` | either side | `rfqId`, `by`, `reason`, `finalSeq`, `resultDigest` | minimum |

Relay mailbox ids for the job, logs, heartbeats, results and control messages are derived from the channel secret, so they never appear in a memo.

**Rules:**
- **Authenticated messages.** Zcash memos don't reveal the sender, so we authenticate them ourselves. Every provider message is signed with the key listed in the directory. Buyer messages are signed with a per-RFQ key, so different RFQs from the same buyer can't be linked.
- **Unlinkable replies.** `reply_ua` is a fresh diversified address for each RFQ.
- **Encrypted channel.** The buyer and the winning provider derive a shared key: `X25519(buyer_eph, provider_eph)` → HKDF → XChaCha20-Poly1305. All relay blobs are sealed with that key.
- **No replays.** Messages are rejected if they arrive after `expires_height` or repeat a `(rfq_id, seq)` already seen.

## 4. Metered settlement

Zcash has no smart contracts, so instead of escrow we limit how much either side can lose:

1. **ACCEPT pays interval 0.** The job starts when the provider's first signed heartbeat reaches the buyer. That time, on the buyer's clock, is `jobStart`.
2. **The buyer pays by its own clock.** Interval *k* is paid once `jobStart + k·I − lead` has passed on the buyer's clock, plus random jitter, so payments have no fixed rhythm. The buyer also needs a fresh heartbeat showing interval *k−1* being served. A heartbeat can block a payment, but it can never trigger one early: a provider that lies about its progress can't speed payments up.
3. **The provider serves only paid intervals.**
   - It runs interval *k+1* only once it has seen `PAY k+1` (in the mempool is enough) **and** `PAY k` is mined. So at most one unconfirmed payment is ever outstanding.
   - At an unpaid boundary it pauses the job. If the payment hasn't arrived by the end of the grace window, it checkpoints, stops and sends `CLOSE(unpaid)`.
   - If a payment it acted on vanishes from the wallet before being mined (a double-spend), it stops at once.
4. **The buyer watches for heartbeats.** They arrive signed over the relay. If they stop, the buyer stops paying and sends `CLOSE(no_heartbeat)`.
5. **What each side can lose:**
   - **Buyer:** at most `I + lead` of compute, i.e. `1 + lead/I` intervals, even against a provider that lies about progress. `lead = min(payLeadS, I/4)`, so that's never more than 1.25 intervals.
   - **Provider:** it never computes an interval nobody has paid for. Its only risk is one interval served on a mempool payment that is then double-spent, and that can happen at most once per job.
   
   Shorter intervals mean less exposure but more fees, and the client prints that trade-off.

   | Profile | *I* | *lead* | Buyer worst case |
   |---|---|---|---|
   | memory | 4 s | 1 s | 1.25 intervals |
   | fast | 2 s | 0.5 s | 1.25 intervals |
   | testnet | 300 s | 60 s | 1.2 intervals |

   Each payment goes out at a random point in `[open, open + lead/2]`, so payments have no fixed rhythm.

An earlier version paid interval *k+1* as soon as a heartbeat claimed interval *k*. The privacy audit showed that let a lying provider collect the whole job budget at once, so payment timing now comes from the buyer's clock only.

**Heartbeats and their limits.** Heartbeats contain a progress digest (step count and a hash of the latest checkpoint) so the buyer can tell the job is advancing. This shows the job is moving forward. It does **not** prove the right hardware or honest computation, and we say so in the threat model.

**Metered delivery.** Paying per interval only bounds the money; the work product is bounded too. At the end of every served interval (and when it pauses or stops, for whatever reason) the provider packs the job's `SILICR_CHECKPOINT_DIR`, seals it with the channel key under blob kind `checkpoint` (its own derived mailbox), and uploads it in ≤ 8 MiB chunks tagged with the interval and a SHA-256. An unchanged directory is not uploaded again, and checkpoints above 64 MiB (packed; `ProviderNodeOptions.maxCheckpointBytes`) are skipped and reported. The buyer verifies the digest, keeps only the latest checkpoint per RFQ at `<data>/checkpoints/<rfqId>/`, and reports it as `RfqDto.checkpoint`. So a buyer whose provider vanishes holds the state of the last paid interval, not just a receipt. **Migration** (`silicr migrate <rfqId>`, `POST /api/rfqs/:id/migrate`) opens a *new* RFQ for the same request and job: the sealed job blob carries the checkpoint after the bundle (`manifest.resumeFrom = { seq, sizeBytes, sha256 }`), the new provider verifies it and unpacks it into the job's checkpoint dir before starting, and the job resumes from it (tiny-train logs `resuming from checkpoint at step N`). The old RFQ gets `CLOSE(buyer_stop)` if it is still open. The two RFQs share nothing but the buyer's own records: fresh keys, reply address and channel, and the provider being left is not asked by default. The cost: the relay sees one more sealed blob per interval, i.e. one more size-and-timing signal (§ Threat model, limit 4); it still cannot read it or tell which deal it belongs to.

## 5. Provider bonds with FROST (experimental)

**Status (2026-10-25):** proven on Zcash testnet, not wired into the market. `zec-sidecar frost dkg-local` runs FROST distributed key generation for three parties (provider, buyer pool, arbiter) and derives an Orchard-only address whose spend authorization is the 2-of-3 group key (RedPallas re-randomized FROST, which Ironwood keeps unchanged). The bond address `utest19ccrveq86v…` was funded with 0.01 TAZ in [`cb59778e2c05…`](https://zexplorer.app/testnet/tx/cb59778e2c05bc823c659ab227b00899aa9f3f591bb7b36799d5ca42adae8f08) and released with signatures from the provider and the arbiter only, as a PCZT finalized and broadcast by the sidecar: [`f183ce4ebccd…`](https://zexplorer.app/testnet/tx/f183ce4ebccd72f928c5e57352989f190206c2c85ee1aca9528072b70dfec258). Still missing: the arbiter as a service, the slashing flow with evidence checks, bond publication and verification in the directory, and the bid badge. Crates: `reddsa` 0.5.2 (`frost::redpallas`), `frost-rerandomized` 3.0, `pczt` via `zcash_client_backend` 0.25.


- **Setup.** The provider, the Silicr arbiter and a buyer-pool key run FROST distributed key generation (RedPallas, using the Zcash Foundation's FROST tooling) and get a 2-of-3 shielded address (Orchard receiver, Ironwood pool; Ironwood keeps RedPallas spend authorization, confirmed by the testnet release above). The provider funds its bond there.
- **What it buys.** The bond size shows up in bids, so buyers can prefer bonded providers. That gives sybil resistance without revealing anyone's identity.
- **Slashing.** If a buyer shows signed evidence (a BID, an ACCEPT, paid intervals and no heartbeats), the arbiter and the buyer pool co-sign a slash. If the provider exits cleanly, the provider and the arbiter co-sign a release.
- **Trust.** The arbiter is a trusted party, and the threat model says so.

## 6. ZK job-count proof (stretch)

Each CLOSE that the buyer co-signs becomes a receipt leaf. The provider proves in **Noir** that "I hold ≥ N receipts with valid buyer signatures, under directory key K." It reveals neither the receipts nor the buyers. Nullifiers stop the same receipt from being counted twice. This goes into the directory entry as `proven_jobs ≥ N`.

## 7. Tech stack

| Layer | Choice |
|---|---|
| Zcash wrapper | Rust (librustzcash) or TS over Zallet RPC, decided in Week 0 |
| CLI and provider daemon | TypeScript (Node 22) or Rust, matching the wrapper |
| Job runner | Docker with the NVIDIA container toolkit; CPU fallback for the demo |
| Relay | ~100-line Node/Bun server; blobs on disk keyed by random ID; no auth beyond a capability URL |
| Web terminal | Next.js + Tailwind, talking to the local CLI daemon over localhost |
| Crypto | `@noble/curves`, `@noble/ciphers`, `@noble/hashes` (or the Rust equivalents) |

**UI direction.** The ZECATHON site is itself a green-phosphor "dark pool" terminal, so a generic dark glassmorphism terminal will look like a copy. Silicr's UI should be calm and dense, closer to an ops console (think Linear or Grafana) than a trading screen. The Leak Inspector's four-column view is its signature element.
