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

One command starts a complete Silicr stack in a temp dir (simulated chain, real relay, real crypto, a real training job), runs a deal, then checks every privacy claim against what each party actually holds: the relay stores only ciphertext, the chain shows only shielded action counts and fees, padding hides the provider count, forged directory entries and bids are rejected, a lying provider cannot pull payments early, a buyer that stops paying gets no unpaid work, and no secret is ever printed. It prints ✓/✗ per check with the evidence and exits non-zero on any failure. [docs/JUDGES.md](docs/JUDGES.md) maps each claim to its check and its tests, lists the known limits unsoftened, and says what is simulated and what is real.

`pnpm verify`, `pnpm test` and `silicr demo` never touch a real chain. The real-chain mode runs on Zcash mainnet (or testnet), with small amounts, unaudited.

## Repo guide
- [PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md): scope, user flows, the 27-day build plan and the demo script.
- [ARCHITECTURE.md](ARCHITECTURE.md): components, the memo protocol, settlement and the tech stack.
- [THREAT_MODEL.md](THREAT_MODEL.md): what every party can and cannot learn, including what we do not protect.

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option, like the Zcash Rust libraries Silicr builds on.
