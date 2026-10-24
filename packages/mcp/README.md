# @silicr/mcp

**Let an AI agent rent a GPU and pay for it in shielded ZEC, without telling the world.**

`silicr-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server (stdio) that exposes the local Silicr buyer daemon to an agent as eleven `silicr_*` tools. With it, Claude Code, Claude Desktop or any MCP client can:

1. look at the provider directory and estimate a rental,
2. send a sealed request (one shielded Zcash transaction), accept a signed bid and let the job run, paid per interval in shielded ZEC,
3. download the result, and
4. read the **Leak Inspector** and prove that the chain, the relay and the provider learned nothing they should not.

The server talks only to the local daemons over HTTP. It holds no keys.

```
agent ──MCP (stdio)──▶ silicr-mcp ──HTTP (loopback)──▶ buyer daemon :7701 ──shielded txs──▶ Zcash
                                   ├──▶ provider daemon :7702   (Leak Inspector, demo mode only)
                                   └──▶ relay observer  :7700   (Leak Inspector, demo mode only)
```

## Quick start

Start the testnet demo (relay, buyer and provider in one process on Zcash testnet, with the funded wallets in `.silicr/wallets/test-*`):

```bash
pnpm silicr demo --no-run --keep   # relay 7700, buyer 7701, provider 7702; Ctrl-C stops it
```

Then point an MCP client at the server. From the repo root the launcher is `packages/mcp/bin/silicr-mcp.js` (it runs TypeScript through `tsx`, no build step).

**Claude Code**: put this in `.mcp.json` at the root of the project the agent works in (or run `claude mcp add silicr -- node /abs/path/to/packages/mcp/bin/silicr-mcp.js --max-total-zec 0.05`):

```json
{
  "mcpServers": {
    "silicr": {
      "command": "node",
      "args": ["packages/mcp/bin/silicr-mcp.js", "--buyer", "http://127.0.0.1:7701", "--max-total-zec", "0.05"]
    }
  }
}
```

**Claude Desktop**: add the same server to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`), with absolute paths since Desktop has no project directory:

```json
{
  "mcpServers": {
    "silicr": {
      "command": "node",
      "args": [
        "/Users/you/Silicr/packages/mcp/bin/silicr-mcp.js",
        "--buyer", "http://127.0.0.1:7701",
        "--max-total-zec", "0.05",
        "--out-dir", "/Users/you/Silicr/.silicr/mcp-results"
      ]
    }
  }
}
```

A one-shot run from the command line, for a transcript:

```bash
claude -p "Rent 1 a100 for 0.05 hours at up to 0.8 ZEC/h to run examples/tiny-train, then show me the leak report" \
  --mcp-config .mcp.json --strict-mcp-config --allowedTools "mcp__silicr__*"
```

See [examples/agent/README.md](../../examples/agent/README.md) for the full walkthrough and the exact prompt.

## Options

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--buyer URL` | `SILICR_BUYER_URL` | `http://127.0.0.1:7701` | The buyer daemon. The only party the server needs. |
| `--provider URL\|none` | `SILICR_PROVIDER_URL` | `http://127.0.0.1:7702` | The provider daemon, read only for the Leak Inspector, and only when the buyer daemon reports `demoMode`. |
| `--relay URL\|none` | `SILICR_RELAY_URL` | the URL the buyer daemon reports | The relay's `/_observer` feed, same rules as the provider. |
| `--max-total-zec ZEC` | `SILICR_MCP_MAX_TOTAL_ZEC` | `0.05` | The most this session may commit. See *Safety model*. |
| `--out-dir DIR` | `SILICR_MCP_OUT_DIR` | `.silicr/mcp-results` | Where result bundles are saved. Nothing is ever written anywhere else. |

`stdout` is the MCP channel; diagnostics go to `stderr` and never include secrets, memo plaintext or job contents.

## Tools

Every tool returns a one-line human summary followed by concise JSON (also as `structuredContent`). Money is ZEC as a decimal string, times are ISO 8601. Errors come back as tool errors with the daemon's own message (and its error code), so the agent can read why.

| Tool | What it does | Side effects |
|---|---|---|
| `silicr_status` | Role, network (*Zcash testnet* or *Zcash mainnet (real ZEC)*), height, shielded balance, demo mode, the session cap (max, committed, spent, remaining), the daemon's own `spendCap` if it has one, and whether the provider daemon is reachable. | none |
| `silicr_list_providers` | The verified directory: alias, GPUs, min ZEC/h, bond, `verified`. | none |
| `silicr_estimate` | For gpu/count/hours/max ZEC/h: worst-case cost, estimated ZIP 317 fees, intervals, worst-case exposure to a bad provider (≈1.25 intervals), matching providers, and whether it fits the cap (session and daemon, whichever is stricter). | none |
| `silicr_request_compute` | Sealed RFQ → signed bids → (auto) accept → metered job. Takes gpu, count, hours, max_zec_per_hour, job_path (dir or one `.py`/`.sh`), command, image, env, providers, auto_accept (default true), wait_blocks. Refused if `hours × max_zec_per_hour` exceeds the remaining cap. The daemon's privacy guard refuses dangerous paths (home dir, `~/.ssh`, wallets); its message is surfaced verbatim. | creates a request, spends ZEC |
| `silicr_get_request` | The request, trimmed: state, bids, accepted provider, payments (ZEC), fees, heartbeats, log tail, result digest, close reason. | none |
| `silicr_wait` | Poll until `until` = `bids` (≥ `min_bids`), `accepted`, `running` or `closed`, or `timeout_s` (default 60). Returns at once on a terminal state; on timeout returns `reached: false` with the current state so the agent just calls again. Sends MCP progress notifications while waiting. | none |
| `silicr_accept_bid` | Accept a bid by alias or providerId prefix (pays interval 0). Cap-checked for requests not made in this session. | spends ZEC |
| `silicr_stop_request` | `CLOSE(buyer_stop)`: no further payments; the provider returns a partial result. | stops the job |
| `silicr_download_result` | Saves the result `tar.gz` under `--out-dir`; any path outside it (including through symlinks) is refused. Returns path, size, SHA-256, the sealed digest and `resultVerified`. | writes one file |
| `silicr_leak_report` | The who-knows-what matrix for a request (see below). | none |
| `silicr_list_requests` | Every request the daemon knows, newest first, with `inSessionCap`. | none |

### The leak report

`silicr_leak_report` is the agent's proof that the deal stayed private. It reads:

- the buyer daemon's Leak Inspector log for the request (`GET /api/leaks?rfqId=`), which also carries the chain's view of every transaction the buyer sent or received;
- the provider daemon's log and the relay's `/_observer` feed, **only in demo mode** (when every party runs on this machine; otherwise those columns are `na`: a real buyer cannot and should not see them);
- the public view of every transaction the request touched (`GET /api/chain/tx/:txid`): action counts, fee, ciphertext samples, and zero transparent or Sapling parts.

Then it computes, for six facts × four parties, what each party holds, using the `facts` tags the daemons put on every field (and label rules for the relay's untagged fields, the same rules as the web terminal):

| Cell | Meaning |
|---|---|
| `knows` | the party holds the fact **readable and sensitive** (`self: true` when the fact is about the party itself) |
| `hidden` | it holds the fact only sealed: ciphertext or an explicit "not present in any message" |
| `no` | nothing about it at all |
| `na` | that party's view is not available |

Facts: `buyer_identity`, `workload`, `price`, `amount`, `provider_identity` (the deal) and `buyer_ip` (network metadata). `knownLimits` lists the `knows` cells that [THREAT_MODEL.md](../../THREAT_MODEL.md) documents (the winning provider sees the job it runs: limit 1; the relay sees IP addresses: limit 2). `unexpected` lists any other `knows` cell, and `verdict` is `private` only when it is empty. The end-to-end test asserts exactly that on a real run: the chain and the relay learn none of the five deal facts, the provider never learns who the buyer is, and the buyer knows all six.

## Safety model

- **No keys.** The server never sees a seed, a spending key or memo plaintext; it only calls the buyer daemon's loopback HTTP API, so it can do exactly what the daemon allows and nothing more. Wallet files stay in the daemon's data dir.
- **A per-session spending cap** (`--max-total-zec`, default 0.05 ZEC) bounds what an agent can commit. `silicr_request_compute` reserves its worst case (`hours × max_zec_per_hour`) up front and is refused if that does not fit; `silicr_accept_bid` reserves `intervals × bid price` for requests the session did not create. When the daemon reports a request finished, the reservation shrinks to what was actually paid plus fees. The cap lives in the server process: restart it to reset it, or run it with a different value.
- **The daemon's own cap.** If the buyer daemon reports a `spendCap` (per request, total, spent), the stricter of the two applies in `silicr_estimate` and `silicr_request_compute`, and `silicr_status` shows both.
- **Results land only in `--out-dir`.** `file_name` is resolved inside it; `..`, absolute paths and symlinked escapes are refused.
- **Job paths are the daemon's call.** The daemon refuses to ship the filesystem root, your home directory, `~/.ssh`, `~/.gnupg`, `~/.aws`, gcloud config, any `.silicr` data dir or a wallet seed; the server passes its message through. The whole `job_path` directory is sent (encrypted) to the winning provider, who must read it to run it: the tool description says so, loudly.
- **Nothing leaves the machine except through the daemon.** No telemetry, no network calls other than the three local URLs.
- **What is shown to the agent** is what the buyer already has: its own request, bids, payments, log tail and results. Error messages carry no addresses or txids beyond the daemon's own text. `env` values are never echoed back, only their names.

### Mainnet

The team now runs Silicr on **Zcash mainnet with small amounts**, so this server will sometimes face real money. Three rules:

1. **`--max-total-zec` is the agent's hard ceiling per session.** The default is 0.05 ZEC. Raise it deliberately, per session, never in a shared config.
2. **The daemon has its own cap** (`spendCap`, required on mainnet). The server respects the stricter of the two and shows both in `silicr_status`; it never asks the daemon to raise it.
3. **Keep wallet balances small.** Fund the buyer wallet with what a few jobs need, not more. The cap bounds what an agent commits; the balance bounds what any bug can lose.

On mainnet `silicr_status` reports the network as *"Zcash mainnet (real ZEC)"*, and every result that commits funds (`silicr_request_compute`, `silicr_accept_bid`) carries a one-line *REAL ZEC* note so the agent repeats it to the person it works for.

## Tests

```bash
pnpm --filter @silicr/mcp test        # 23 tests
pnpm --filter @silicr/mcp typecheck
```

`test/mcp.test.ts` starts a real local stack on ephemeral ports (memory chain, relay with its observer feed, provider with the process runner, buyer), spawns `silicr-mcp` over stdio through its bin launcher and drives it with the MCP SDK client: status → providers → estimate → request `examples/tiny-train` → wait running → wait closed → download → leak report, plus the manual bids → accept → stop flow, cap refusal, dangerous-path refusal and out-dir escape refusal. `test/units.test.ts` covers the money helpers, the cap arithmetic, CLI parsing, the path guard and the matrix on synthetic data.

## Layout

```
bin/silicr-mcp.js   launcher (tsx register, no build step)
src/main.ts         stdio entry point
src/server.ts       createSilicrServer(): McpServer + tool context
src/tools.ts        the eleven tools
src/leaks.ts        facts → matrix → report (same rules as apps/web/lib/facts.ts)
src/cap.ts          the session spending cap
src/client.ts       tiny HTTP client for @silicr/api
src/trim.ts         RfqDto → what an agent needs
src/zec.ts          zatoshi ↔ ZEC
```

The package depends on `@silicr/api` (types only), the MCP SDK, `zod` and `tsx`. It does not link `@silicr/engine` at runtime (only in tests), so it cannot touch a wallet even by accident.
