# Silicr: notes for Claude Code

Read README.md, ARCHITECTURE.md and THREAT_MODEL.md before changing anything. Deadline: ZECATHON submissions close 2026-10-28 23:59 UTC. Working beats ambitious.

## Layout

| Path | Package | What |
|---|---|---|
| packages/protocol | @silicr/protocol | Memo protocol v1, signatures, channel crypto, directory signing. Pure, no I/O. |
| packages/zec | @silicr/zec | `ZecBackend` contract, ZIP 316 UA codec + Orchard-receiver guard, MemoryBackend, testnet backend (drives `zec-sidecar/`) |
| packages/relay | @silicr/relay | Ciphertext-only relay, public directory, observer feed, client |
| packages/runner | @silicr/runner | Job bundles, docker/process runner |
| packages/engine | @silicr/engine | Buyer and provider nodes, metered settlement, daemon HTTP API |
| packages/cli | @silicr/cli | The `silicr` command |
| packages/api | @silicr/api | Daemon ↔ web JSON contract (types only) |
| packages/mcp | @silicr/mcp | MCP server: AI agents rent compute via the local buyer daemon, with a per-session spend cap |
| apps/web | @silicr/web | Next.js terminal + Leak Inspector |
| apps/landing | @silicr/landing | Static landing page (Next.js export) with the Launch app button |
| zec-sidecar/ | (Rust) | librustzcash light wallet (JSON lines over stdio) behind the testnet backend |
| examples/ | | Demo jobs |

Each package's `src/contract.ts` (or the documented types in `src/index.ts` for relay, runner and api) is the interface other packages build against. Don't change it silently: keep changes additive and mention them in your report.

## Conventions
- TypeScript 7, ESM, Node ≥ 22. No build step: packages export `src/index.ts`; run with `tsx`, test with `vitest`.
- Relative imports include the `.ts` extension. Erasable TS syntax only (no enums, namespaces or parameter properties).
- Money is `bigint` zatoshis in code and decimal strings in JSON. Bytes are `Uint8Array` in code and lowercase hex in JSON.
- Tests live in each package's `test/`. Run `pnpm --filter @silicr/<pkg> test` and `pnpm --filter @silicr/<pkg> typecheck`.
- Few dependencies. Crypto and encoding come from `@noble/*` and `@scure/base` only.

## Privacy rules (ZECATHON disqualifies on leaks)
- Shielded only. Addresses are Orchard-receiver-only UAs (every recipient goes through `toOrchardOnly()`), and value lives in the Ironwood pool since NU6.3 (2026-07-28). Never send to or spend from transparent, Sapling or legacy Orchard: turnstile withdrawals publish amounts.
- Never fetch another party's transaction by txid from the light-wallet server; it reveals interest. Build public views from blocks the wallet already has.
- Never log seeds, secret keys, memo plaintext or job contents outside the owning party's data dir.
- The relay never receives plaintext, or anything linking a mailbox to an RFQ, wallet or address.
- Nothing about buyers reaches the directory.
- Mainnet is allowed only with explicit `--network main`, and only with the spend caps on (per-RFQ and total, set in the daemon config; refuse to start on mainnet without them). Tests, `silicr demo` and `pnpm verify` never touch mainnet. Mainnet wallets hold small balances; a demo costs under 0.002 ZEC in fees.
- Never send real funds without the user's explicit go-ahead for that run. Print the amount and the cap before any mainnet send.
- Wallet files and seeds live under `.silicr/` (gitignored) and are never committed, logged or printed.

## Local ports
relay 7700 · buyer daemon 7701 · provider daemon 7702 · web terminal 7703 · landing page 7704. Ports 3000, 3001 and 3100 belong to the user's other projects: never use or kill them.

## Working in parallel
Several agents may be working in this tree at once, each owning one directory. Edit only the directory you own. To add a dependency, run `pnpm --filter <your-pkg> add <dep>`; if pnpm fails on the lockfile, wait a few seconds and retry. Don't reformat or "fix" other packages; report problems instead.
