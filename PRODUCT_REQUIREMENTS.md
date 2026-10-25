# Silicr: Product Requirements

## 1. The target

**ZECATHON** by zkSNARKs. $100K pool. Submissions are due **Oct 28, 2026, 23:59 UTC**. Judging runs Oct 29 – Nov 22 and winners are announced Nov 23.

- **Track:** Private Markets ($15K). Every account gets one submission in exactly one track.
- **Also chasing:** the Grand Prize ($20K, paid on top of the track prize) and Community Choice ($5K).
- **Rules that shape the plan:**
  - All code is written in the build window.
  - The repo is open source at submission.
  - **Leaks are disqualifying, not deductions.**
  - **Working beats ambitious.**

### Why we stand out
The Private Markets brief literally says "the dark-pool thesis," so most entries will be token dark pools with a central matcher and a slick terminal. Silicr differs in four ways:

1. **A different asset.** We trade GPU time, not tokens. The privacy need is concrete: compute purchases reveal a lab's roadmap.
2. **No operator in the middle.** Most "dark pools" quietly trust their matching server. Silicr has none. Bids go straight to the buyer.
3. **Settlement without smart contracts.** The buyer pays per interval, timed by its own clock. A provider can never pull payments ahead of time, and it never computes an unpaid interval. Exposure stays around one interval for both sides, using only plain shielded transactions, which is what Zcash does best.
4. **Privacy you can check.** The Leak Inspector shows judges exactly what each party learned, from real data. We publish a threat model that includes what we *don't* protect.

## 2. Judging criteria → what we build

| Criterion | How Silicr answers it |
|---|---|
| **Privacy** ("does it actually, or only look like it does?") | Shielded only (Ironwood pool via Orchard receivers; transparent, Sapling and legacy-Orchard spends refused); no server-side matching; signed bids; E2E encrypted job channel; [THREAT_MODEL.md](THREAT_MODEL.md); in-app Leak Inspector |
| **Usefulness** ("would someone use this on Monday?") | `silicr run ./train.py` actually runs a container on a provider and returns results, and `silicr provide` turns any GPU box into a seller |
| **Execution** ("does it run?") | The app runs on Zcash testnet or mainnet: every demo step is a real shielded transaction with a txid, and nothing in the main flow is mocked. The simulated chain exists only in the test suite (`pnpm test`, `pnpm verify`). |
| **Originality** | Shielded memos used as the RFQ and bid channel, plus metered payments as settlement. This is a compute market, not another token DEX. |

## 3. Users and flows

### Buyer (AI researcher / small lab)
1. `silicr init` creates an Orchard-only wallet, or connects an existing one. Transparent funds are refused, with an explanation of why.
2. `silicr run --gpu a100 --count 4 --hours 12 --max 0.8zec/h ./job` (or the same form in the web terminal).
3. The client picks matching providers from the directory and sends **one shielded transaction**. It carries an encrypted RFQ memo to each provider's address.
4. Signed bids arrive in memos at a one-time address made for this RFQ. The client checks each signature and ranks the bids by price and bond.
5. The buyer accepts a bid, or sets an auto-accept rule. The ACCEPT transaction pays interval 0. The encrypted channel key comes from the X25519 keys already exchanged in the RFQ and the BID.
6. The job is uploaded encrypted over the relay. Logs stream back encrypted.
7. The client pays one interval at a time (default 5 minutes on testnet), timed by its own clock, while the provider's heartbeats keep arriving.
8. Results download, the final interval settles, and the receipt is saved locally.

### Provider (GPU owner)
1. `silicr provide --gpu a100 --count 4 --min 0.6zec/h` publishes a directory entry: pseudonymous ID, specs, Orchard address and signing key.
2. *(Stretch)* The provider posts a bond into a FROST 2-of-3 address.
3. The daemon watches the provider's wallet for RFQ memos and bids automatically by policy.
4. When a bid wins, it pulls the encrypted job and runs it in a sandboxed container with GPU access.
5. It streams heartbeats and logs and checks each interval payment. **If a payment is late past the grace period, it stops the job.**

## 4. Scope

### Must ship (the demo depends on these)
- [ ] Memo protocol v1: RFQ, BID, ACCEPT, PAY, CLOSE, all signed and versioned; heartbeats travel signed and encrypted over the relay ([ARCHITECTURE.md §3](ARCHITECTURE.md))
- [ ] Buyer client: wallet, RFQ broadcast, bid collection and checking, accept, metered pay
- [ ] Provider daemon: directory entry, memo listener, auto-bid, container runner, payment watchdog
- [ ] Encrypted relay: a dumb store-and-forward server for ciphertext only
- [ ] Web terminal: request form, live bid list, job view with a running cost meter, **Leak Inspector**
- [ ] Shielded-only guard: Orchard-receiver addresses, Ironwood-only spends, refuse transparent and Sapling; pad the number of RFQ outputs
- [ ] A full end-to-end run on **Zcash testnet** with real txids, recorded

### Should ship
- [ ] Auto-accept rules ("cheapest bid with a bond ≥ X, within 2 blocks")
- [ ] Provider dashboard: earnings, jobs, uptime
- [ ] Settlement receipts exportable for accounting, with a viewing key handed only to the buyer's auditor

### Stretch (only after must-ship works)
- [ ] FROST 2-of-3 provider bonds (provider, buyer pool, arbiter) with a slashing flow
- [ ] Noir proof of "≥ N completed jobs" from receipts, without revealing which jobs
- [ ] An MCP server, so AI agents can rent compute and pay in shielded ZEC on their own

### Explicitly out of scope
These would be claims we can't back up in 27 days:
- TEE attestation or "proof of compute": TEEs are listed as future work and not mocked in the demo.
- Hiding the workload from the provider (needs a TEE).
- Large balances. Silicr runs on Zcash testnet or mainnet (mainnet since 2026-10-21, real ZEC, only with spend caps and small wallets; `silicr demo` and the hosted demo stay on testnet). The software is unaudited.

## 5. Build plan (Oct 1 → Oct 28)

| Week | Dates | Goal | Exit check |
|---|---|---|---|
| **0** | Oct 1–3 | Tooling spike: testnet node or light client running, send and receive a shielded tx with a memo from code | A memo sent from a script appears in the other wallet |
| **1** | Oct 4–10 | Memo protocol and signatures; provider daemon receives an RFQ and replies with a BID | RFQ → BID round trip on testnet |
| **2** | Oct 11–17 | ACCEPT, relay, container runner, metered payments, watchdog | A CPU job runs end to end and the provider is paid per interval |
| **3** | Oct 18–24 | Web terminal, Leak Inspector, auto-accept, polish; FROST bond if ahead of plan | A non-team member completes a run unaided |
| **4** | Oct 25–28 | Freeze features. Demo video, threat model review, README, make the repo public | Submitted by **Oct 27**, with one day spare |

Rule of thumb: if a week's exit check fails, cut scope from the stretch list. Never cut from must-ship.

## 6. Demo script (3 minutes)

1. **The problem (20 s):** a public DeAI order book next to an explorer showing a lab's payments. "This is your roadmap, published."
2. **Provider (20 s):** `silicr provide` on a GPU box. It shows up in the directory as a pseudonym.
3. **Buyer (60 s):** `silicr run ./finetune.py`. Bids arrive in the terminal and one is accepted. Logs stream and the cost meter ticks with each shielded payment.
4. **Leak Inspector (45 s):** flip it on. The explorer shows opaque Ironwood transactions. The relay shows ciphertext blobs. The provider sees the job but no buyer identity. Only the buyer sees everything.
5. **Fault (20 s):** kill the buyer's payments. The provider pauses at the next unpaid boundary and stops after the grace period, so it never computes unpaid work. Then flip it around: a provider that lies about its progress still can't pull payments ahead of the buyer's clock.
6. **Close (15 s):** results downloaded and real testnet txids on screen. "No server ever saw the order."
