# Silicr on Zcash mainnet

Silicr's real-chain mode runs on Zcash **mainnet with small balances**, or on testnet ([docs/ZCASH_SETUP.md](ZCASH_SETUP.md)). The zero-setup demo (`silicr demo`) touches neither: it runs a simulated chain. This page is the mainnet checklist. Items marked *unverified* have not been exercised on mainnet yet, and nothing here claims that a mainnet run has happened.

## Why mainnet

- **Instant funding.** Any shielded wallet can send a few thousand zatoshis to the buyer's address. No faucet queue: in three weeks on testnet, the faucets were never used.
- **Real proof.** A deal settled on mainnet is a set of transactions anyone can find on a public explorer, with nothing in them anyone can read.
- **A larger anonymity set.** On mainnet Silicr's transactions sit among every other shielded Ironwood transaction on the network, a far larger crowd than testnet. That weakens the traffic-shape inference in [THREAT_MODEL.md](../THREAT_MODEL.md) limit 4; it does not remove it.

## Guardrails

- **Explicit opt-in.** Mainnet only with `--network main`. Nothing defaults to it, and tests, `silicr demo` and `pnpm verify` never touch it.
- **Spend caps are required.** A daemon refuses to start on mainnet without a per-request cap and a total cap in its config. The web terminal shows them next to the network ("cap: spent X of Y ZEC (per request ≤ Z)") and refuses a request whose worst case, max price × duration plus fees, exceeds them; the daemon checks again before anything is sent. *Unverified:* the config keys, which are being added with this document; `silicr init --help` is the reference.
- **Your go-ahead before real money moves.** The terminal prints the amount and the cap before a mainnet request and asks for a second click. Never let a script send on mainnet on your behalf without reading what it is about to spend.
- **Small balances.** Fund what a demo needs (below) plus a little margin. Silicr wallets are not a place to keep savings.
- **Seeds.** Wallet files and the 24-word seed live under `.silicr/` (gitignored), mode 0600 in a 0700 directory, and are never printed, logged or committed. Back the seed up, or treat the wallet as throwaway; with small balances either is fine. Do not import a mainnet seed into a testnet wallet or the other way round.
- **Shielded only, Ironwood only.** Every recipient is an Orchard-receiver-only unified address and every spend comes from the Ironwood pool, checked in TypeScript and again in the Rust wallet. A turnstile withdrawal from the legacy Orchard pool would publish an amount, so none is ever built.

## What a demo costs

- Fees follow ZIP 317: 5,000 zatoshis per logical action, two actions minimum. A payment transaction (one output plus change) costs **0.0001 ZEC**. An RFQ padded to 4 outputs plus change is 5 actions, 0.00025 ZEC.
- A short demo is about 15 transactions: the RFQ, a bid, the ACCEPT, a run of PAYs and the CLOSEs. That is **≈ 0.0015 ZEC in fees**, under 0.002 ZEC all in.
- The interval payments themselves are not lost: they move from the buyer's wallet to the provider's. When you run both sides, that value circulates between your own two wallets and only the fees are gone.
- Size the buyer's balance as max price × duration, plus fees, plus a margin. A 10-minute job at 0.01 ZEC/h needs under 0.005 ZEC; 0.02 ZEC covers several demos.

## How to fund

1. `silicr init --role buyer --network main --data .silicr/wallets/main-buyer` creates the wallet and prints its `u1…` address: a unified address whose only receiver is Orchard, so funds can only arrive shielded.
2. Send a small amount of ZEC to that address from any shielded wallet. Pay from a shielded balance; a wallet that insists on a transparent send cannot pay this address at all, which is the point.
3. The funds become **spendable after 10 confirmations** (the ZIP 315 default for received notes): about **12 to 13 minutes** at 75-second blocks. `silicr status` shows the balance moving from `pending` to `spendable`.
4. The provider needs a little ZEC too: each bid and each CLOSE costs 0.0001 ZEC. After its first job, its earnings cover that. Use `--data .silicr/wallets/main-provider` for its wallet.

## Timing on mainnet

Mainnet blocks arrive about every 75 seconds. The mainnet timing profile uses longer intervals than testnet (on the order of ten minutes), a payment lead ahead of each interval, and longer grace and timeout windows, so a job sends fewer transactions per hour. `silicr status` shows the live values for your daemons. The worst-case buyer exposure is unchanged: the rest of the interval in progress plus one prepaid interval, (I + lead) / I intervals as in ARCHITECTURE.md §4. *Unverified on mainnet:* the profile numbers; they are being set with this document.

## The explorer

Checked on 2026-10-21 with two v6 (Ironwood) mainnet transactions:

| Explorer | Result |
|---|---|
| `https://mainnet.zcashexplorer.app/transactions/<txid>` | Rendered both, server-side: version, fee and the action count (labelled "Orchard Action transfers"). The terminal's default (`NEXT_PUBLIC_EXPLORER_TX_URL_MAIN`). |
| `https://zecblock.com/tx/<txid>` | Rendered one ("Shielded Zcash transaction", "Zcash mainnet", NU6.3-aware), then rate-limited repeated fetches (HTTP 429). A fine alternative for occasional clicks. |
| `https://zexplorer.app/mainnet/tx/<txid>` | Answered "Transaction unavailable: upstream did not respond". Not used. |
| Blockchair | Its API misreports v6 shielded transactions (the whole input shown as fee) and its pages refuse scripted fetches. Not used. |

An explorer is a third party: opening a link tells it which txid you are interested in, from your browser's IP. A SOCKS5 proxy configured on the daemon does not cover your browser. What it shows is what the public chain shows: version 6, the number of shielded actions and the fee; not the sender, the recipients, the amounts or the memos.

## Light-wallet server and proxy

Your wallet syncs from the lightwalletd or Zaino server you choose with `--server host:port`. The operator learns your IP address, every transaction you broadcast and when, and the wallet's birthday height (THREAT_MODEL.md, light-wallet-server row). The wallet never asks it for another party's transaction by txid. When a daemon is configured to send its traffic through a SOCKS5 proxy (Tor), `silicr status` and the terminal show "via SOCKS5 proxy", and the relay and the light-wallet server see the proxy's address instead of yours. *Unverified:* the mainnet default server and the proxy option, which are being added with this document.

## Before a mainnet run

1. Build the Rust wallet (`cargo build --release` in `zec-sidecar/`) and start a relay both parties can reach.
2. `silicr init … --network main` for each party, with spend caps set; check `silicr status` shows **Zcash mainnet** and the caps.
3. Fund the buyer, wait for `spendable`, and give the provider a little for fees.
4. Open the terminal and confirm the header shows the red **REAL ZEC** chip, the cap, and the right network, before sending anything.
5. Send a small request first. Read the amount and the cap on the confirm step; then, and only then, confirm.
