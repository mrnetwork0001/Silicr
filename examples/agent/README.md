# An agent rents a GPU

This walkthrough has an AI agent rent a GPU on Silicr, pay for it per interval in shielded ZEC, collect the result, and then read the Leak Inspector to confirm that nobody else learned anything. It uses the `silicr-mcp` server from [packages/mcp](../../packages/mcp/README.md) and the tiny training job in [examples/tiny-train](../tiny-train/README.md).

## 1. Start the stack

```bash
pnpm install
pnpm silicr demo --keep     # Zcash testnet: relay (7700) + buyer (7701) + provider (7702), one process
```

Leave it running. It opens the funded testnet wallets in `.silicr/wallets/test-buyer` and `.silicr/wallets/test-provider` (testnet coins only; `--network main` is refused for the demo) and the provider offers `1× a100`. Optionally start the web terminal (`pnpm --filter @silicr/web dev`, http://localhost:7703) to watch the same deal in the Leak Inspector.

## 2. Give the agent the tools

Claude Code reads `.mcp.json` from the project root. Put this there:

```json
{
  "mcpServers": {
    "silicr": {
      "command": "node",
      "args": ["packages/mcp/bin/silicr-mcp.js", "--buyer", "http://127.0.0.1:7701", "--max-total-zec", "0.2"]
    }
  }
}
```

`--max-total-zec` is the agent's hard ceiling for the session (default 0.05 ZEC; 0.2 here to leave room for the demo provider's hourly price). For Claude Desktop, see the snippet in the package README.

## 3. The prompt

Give the agent exactly this:

> Use the silicr tools. Rent 1× a100 for 0.05 hours at up to 0.8 ZEC/h to run the job in `examples/tiny-train` (command `python3 train.py`, env `SILICR_STEPS=60`, `SILICR_STEP_DELAY_MS=30`), auto-accepting the cheapest signed bid. First check the status and the estimate, then make the request, wait until it is running, wait until it is closed, download the result, and finally run the leak report. Tell me, in a few lines, what each party learned and whether anything leaked.

Or from a terminal, in one shot (prints the agent's final answer):

```bash
claude -p "<the prompt above>" --mcp-config .mcp.json --strict-mcp-config --allowedTools "mcp__silicr__*"
```

## 4. What the agent does

The table and [TRANSCRIPT.md](TRANSCRIPT.md) were recorded on 2026-10-21 against the in-process test harness (simulated chain, 4 s intervals), before the app went testnet/mainnet only. On testnet the flow and the tool calls are the same; intervals are 300 s, blocks about 25 s, and the status reports `network: test`.

| Step | Tool call | What comes back |
|---|---|---|
| 1 | `silicr_status` | `role: buyer`, `network: "simulated chain (…no real ZEC)"`, balance ≈ 9.99 ZEC, `sessionCap: { maxZec: "0.2", remainingZec: "0.2" }`, provider reachable, `demoMode: true` |
| 2 | `silicr_list_providers` | one verified entry: `velvet-orca-13`, `1× a100 (80 GB)` + `8× cpu`, min 0.6 ZEC/h |
| 3 | `silicr_estimate` `{gpu: "a100", hours: 0.05, max_zec_per_hour: 0.8}` | `maxCostZec: "0.04"`, `estimatedFeesZec ≈ 0.0006`, `intervals: 45` of 4 s, `maxExposure ≈ 0.0011 ZEC` (1.25 intervals), `cap.fits: true` |
| 4 | `silicr_request_compute` `{…, job_path: "examples/tiny-train", command: ["python3","train.py"], env: {…}}` | `rfqId`, `cap.reservedZec: "0.04"`. The daemon packed and encrypted the job, and broadcast one shielded transaction whose padded outputs carry the sealed RFQ. |
| 5 | `silicr_wait` `{until: "running"}` | after a few seconds: a signed bid (0.6 ZEC/h, `signatureValid: true`), the ACCEPT that paid interval 0, the first heartbeat |
| 6 | `silicr_wait` `{until: "closed"}` | `state: closed`, `closeReason: done`, one or more payments of 0.00066667 ZEC (at these settings the job finishes inside the first 4 s interval), `result.verified: true` (the sealed bundle's digest matched the provider's signed CLOSE), the job's log tail with its loss curve |
| 7 | `silicr_download_result` | `.silicr/mcp-results/silicr-result-<rfq>.tar.gz` with `model.json`, `metrics.json`, `sample.txt` |
| 8 | `silicr_leak_report` | the matrix below, `verdict: "private"`, `unexpected: []` |

The leak report for a demo run looks like this (the agent gets it as JSON; this is the same data as a table):

| Fact | Chain | Relay | Provider | Buyer |
|---|---|---|---|---|
| Who the buyer is | hidden (ciphertext) | no | hidden ("not present in any message") | knows (self) |
| What is being run | hidden | hidden (ciphertext) | **knows** (known limit 1: it runs the job) | knows |
| Price | hidden | no | knows (expected: it set it) | knows |
| Amounts paid | hidden | no | knows (expected: it was paid) | knows |
| Which provider | hidden | no | knows (self) | knows |
| Buyer IP | no | **knows** (known limit 2) | no | knows (self) |

`chain`: every transaction fully shielded (Ironwood actions only, 0 transparent and 0 Sapling parts); amounts, senders, recipients and memos sealed. `relay`: sizes, timing, mailbox ids, 24 bytes of ciphertext per blob and the client IP. `provider`: the request, its own price, the payments it received and the job it ran, and nothing that identifies the buyer. `buyer`: its own deal.

The final answer from a real run (see [TRANSCRIPT.md](TRANSCRIPT.md): 8 turns, 19 seconds, $0.14 of API use):

> Job completed successfully (60 steps, 2s runtime, result verified, saved to `.silicr/mcp-results/silicr-result-c47a3371.tar.gz`).
>
> - **Paid:** 0.00066667 ZEC to provider velvet-orca-13 (1 interval, job finished almost instantly) + ~0.00065 ZEC total network fees.
> - **Chain:** 0/6 facts — sees only 5 shielded txs, fully encrypted Orchard actions, no transparent/Sapling parts.
> - **Relay:** 1/6 (buyer's IP only, a documented known limit) — never sees workload, price, or amounts.
> - **Provider:** 4/6 (workload, price, amount, its own identity) — expected, since it must see the job it runs.
> - **Buyer:** 6/6 (all its own deal data) — expected.
> - **Verdict: "private"** — no unexpected leaks.

## 5. Variations

- **Manual acceptance.** Add `auto_accept: false`; the agent then uses `silicr_wait {until: "bids"}` and `silicr_accept_bid {provider: "<alias>"}`. Useful when a person wants to approve the price.
- **Stopping early.** `silicr_stop_request` sends `CLOSE(buyer_stop)`: no further payments, and the provider returns what the job produced so far (tiny-train checkpoints on SIGTERM).
- **Over the cap.** Ask for 1 hour at 0.8 ZEC/h with a 0.2 ZEC cap and `silicr_request_compute` is refused before the daemon is touched: *"refused by the spending cap: this request could cost up to 0.8 ZEC …"*.
- **A dangerous path.** Point `job_path` at your home directory and the daemon's privacy guard refuses: *"refusing to send /Users/you to a provider: that is your whole home directory"*.
- **Testnet or mainnet.** Run a buyer daemon (`silicr init --role buyer --network test --data .silicr/buyer`, then `silicr daemon --data .silicr/buyer`) and point `--buyer` at it. Outside demo mode the provider and relay columns of the leak report are `na`: a real buyer cannot see them, by design. On mainnet keep `--max-total-zec` small, keep the wallet balance small, and expect the *REAL ZEC* note on every result that spends.
