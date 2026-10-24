# Silicr

**Rent a GPU without telling the world. No one in the middle sees your order.**

Silicr is a private compute market on Zcash. An AI team asks for GPUs, vetted providers send back sealed bids, and the winner is paid by the minute in shielded ZEC. The chain sees nothing it can read. Silicr's server sees nothing it can read. The provider learns only what it needs to run the job.

```bash
silicr run --gpu a100 --count 4 --hours 12 --max 0.8zec/h ./train.py
```

`--max` stays private: the RFQ memo carries 0 ("undisclosed"), providers bid their own price and the daemon drops bids above your max locally. Add `--disclose-max` to put the ceiling in the memo instead.

Built for **ZECATHON** (zkSNARKs, Sep 28 – Oct 28, 2026), entered in the **Private Markets** track.

## Why this matters

Which lab rents how many H100s, and for how long, tells you what it is about to ship. Today that information leaks everywhere. Cloud bills, public DeAI order books and on-chain payments all expose who is training what, at what scale, and who they pay. Silicr removes each of those leaks and shows you what was removed.

## How it works

| Step | What happens | Who can read it |
|---|---|---|
| 1. **Sealed RFQ** | The buyer sends one shielded transaction. Its outputs carry an encrypted request memo to each vetted provider. | Only the providers it was sent to |
| 2. **Sealed bids** | Each provider replies with a signed bid memo to a one-time address the buyer made for this request. | Only the buyer |
| 3. **Encrypted job** | The keys for an encrypted job channel are swapped inside the memos. The job and its results move over an end-to-end encrypted relay. | Buyer and winning provider |
| 4. **Metered settlement** | The buyer pays per interval in shielded ZEC. If payment stops, the job stops. If the job stops, payment stops. | Buyer and provider |
| 5. **Bonded providers** | Each provider locks a bond in a FROST 2-of-3 shielded address. The bond can be slashed for fraud. *(stretch)* | Bond holders |

**There is no matching engine and no order book on a server.** Matching happens in the buyer's client, on the buyer's machine.

## Leak Inspector

Every screen in the terminal has a **Leak Inspector** toggle. It shows the same moment from four viewpoints side by side: the public chain, the Silicr relay, the provider and the buyer. It shows what each party actually received, taken from real data, not a diagram. See [THREAT_MODEL.md](THREAT_MODEL.md) for the full list of what is visible and what is not.

## Verify it yourself

```bash
pnpm install && pnpm verify
```

One command starts a complete Silicr stack in a temp dir (test harness: simulated chain, plus the real relay, real crypto and a real training job), runs a deal, then checks every privacy claim against what each party actually holds: the relay stores only ciphertext, the chain shows only shielded action counts and fees, padding hides the provider count, forged directory entries and bids are rejected, a lying provider cannot pull payments early, a buyer that stops paying gets no unpaid work, and no secret is ever printed. It prints ✓/✗ per check with the evidence and exits non-zero on any failure. [docs/JUDGES.md](docs/JUDGES.md) maps each claim to its check and its tests, lists the known limits unsoftened, and says what is simulated and what is real.

The app runs on Zcash testnet or mainnet; the simulated chain exists only inside the test suite (and `pnpm verify`, which says so at the top of its output). `pnpm verify` and `pnpm test` never touch a real chain, and nothing touches mainnet without an explicit `--network main`. Unaudited: keep amounts small.

## Try it on testnet

```bash
pnpm silicr demo                    # relay + buyer + provider on Zcash testnet, runs the tiny-train deal
pnpm --filter @silicr/web dev       # the terminal on http://localhost:7703 (press L for the Leak Inspector)
```

`silicr demo` (same as `silicr demo --network test`) opens the funded testnet wallets in `.silicr/wallets/test-buyer` and `.silicr/wallets/test-provider` (create them with `silicr init --network test` and fund them from a faucet), starts the relay and both daemons, and runs one deal with [examples/tiny-train](examples/tiny-train/README.md). `--network main` is refused for the demo: real money. Testnet blocks arrive about every 25 s since NU7 (mainnet activates NU7 at height 3,543,405, about Nov 3, 2026). The web terminal needs a running daemon: without one it shows how to start it on testnet or mainnet.

## Public testnet demo

A hosted testnet stack runs at **https://app.silicr.38-49-213-208.sslip.io** (the daemons are proxied under `/buyer/`, `/provider/` and `/relay/`). It is a shared wallet with testnet coins only. A daemon serves it with:

| Flag | What it does |
|---|---|
| `--public-demo` | Refused on mainnet. `POST /api/rfqs` takes only `job: { preset: 'tiny-train' \| 'tiny-train-quick' }`, mapped to server-side example jobs (client paths, commands, images and env are ignored); `durationS` ≤ 900 s, `count` ≤ 1 and a max price ≤ 0.5 ZEC/h; one live request at a time (409 `busy`); 3 requests per IP per hour (429 `rate_limited`). Withdraw, `PUT /api/policy`, `POST /api/jobs/:id/stop` and migrate return 403 `demo_disabled`. Faults stay enabled: they are part of the demo. `GET /api/status` reports `publicDemo: true` and the presets. |
| `--public-origin <url>` | Repeatable. An extra allowed Origin for CORS and an accepted `Host` (the URL's host name); the loopback rules stay as they are. |
| `--trust-proxy` | Take the client IP for rate limits from `X-Forwarded-For` (only behind your own reverse proxy). |
| `--host <addr>` | Bind address; anything other than loopback only together with `--public-origin`. |

To fund a real-chain wallet, run `silicr wallet` (address and a ZIP 321 QR to scan with Zashi or any shielded wallet) or open **Wallet** in the web terminal; `silicr withdraw <u1…> <zec|all>` sends it back. Keys never leave your machine. See [docs/MAINNET.md](docs/MAINNET.md#funding-and-withdrawing).

## Repo guide
- [PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md): scope, user flows, the 27-day build plan and the demo script.
- [ARCHITECTURE.md](ARCHITECTURE.md): components, the memo protocol, settlement and the tech stack.
- [THREAT_MODEL.md](THREAT_MODEL.md): what every party can and cannot learn, including what we do not protect.

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option, like the Zcash Rust libraries Silicr builds on.
