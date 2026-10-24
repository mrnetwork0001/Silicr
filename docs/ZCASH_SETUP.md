# Zcash setup (testnet, and mainnet)

Silicr's real-chain backend is `zec-sidecar`, a small Rust light wallet built on librustzcash. TypeScript reaches it through `openBackend({ kind: 'sidecar', network: 'main' | 'test', ... })` (or `createSidecarBackend()`) in `@silicr/zec`; the older `{ kind: 'testnet' }` / `createTestnetBackend()` spelling still works and means testnet. Each wallet runs as its own sidecar process. The process talks JSON lines over stdin/stdout and syncs from a public lightwalletd: `testnet.zec.rocks:443` on testnet, `zec.rocks:443` on mainnet.

**The network is explicit, and nothing defaults to mainnet.** The sidecar is started with `--network main|test`, refuses any server whose reported chain (`GetLightdInfo.chainName`) is not that network, and refuses to open a wallet directory created on the other network. The TS layer checks the sidecar's answer again. Mainnet means real ZEC: read [MAINNET.md](MAINNET.md) first (small balances, spend caps, your go-ahead before any send), and see §12 below for the server list and measured timings.

## 0. What you need to know first: NU6.3 / Ironwood

Testnet activated the Ironwood upgrade (NU6.3) at height **4,134,000**, and mainnet followed at 3,428,143 on 2026-07-28.

- **Orchard is now a legacy, withdraw-only pool.** New value can't enter it, and value can only leave it through a "turnstile" that publishes the amount.
- **Payments to Orchard receivers land in the new Ironwood pool.** Ironwood uses Orchard-shaped actions, the same keys and the same unified-address receiver (typecode `0x03`).

So, in practice for Silicr:

| Silicr rule | What the backend actually does on testnet today |
|---|---|
| "Orchard-only addresses" | Every address is a UA whose only item is an **Orchard receiver**, enforced by `toOrchardOnly` in TS and again in Rust. |
| "Spend Orchard notes only" | It spends **Ironwood notes only** and sends outputs and change only to Ironwood. It never draws on legacy Orchard (that would cross the turnstile and reveal the amount), Sapling or transparent funds. |
| "No cross-pool transfers" | The proposal and the built transaction are checked before broadcast: no transparent, Sapling or legacy-Orchard bundle may be present, and there must be exactly one Ironwood bundle. |
| `ReceivedNote.pool` | `'orchard'` (the Orchard-receiver protocol family). The extra field `valuePool` says `'ironwood'`. |
| `PublicTxView.orchard` | Only the legacy Orchard bundle, which is usually empty now. Ironwood actions are reported in the extra field `ironwood`. They are never folded into `orchard`, because summing the two would hide a turnstile crossing. |

The transactions are v6 (consensus branch `37a5165b`). A typical Silicr payment looks like this to an observer:

`version 6 · transparent 0/0 · sapling 0/0 · orchard 0 actions · ironwood N actions · valueBalance = fee`

## 1. Build

Requirements:
- Rust ≥ 1.88. It was tested with 1.98 on macOS arm64.
- Node ≥ 22 and pnpm 9 for the TS side.
- No system libraries. SQLite is bundled, and the Sapling parameters are compiled into the binary.

```bash
cd zec-sidecar
cargo build --release          # ≈1.5 min cold on an M-series Mac; the binary is ~73 MB (bundled Sapling params)
./target/release/zec-sidecar info
```

`info` should print `"chainName": "test"` and a `blockHeight` above 4,428,000. `info --network main` prints `"chainName": "main"`, a height above 3,525,000 and `"consensusBranchId": "37a5165b"` (NU6.3, the same branch id on both networks).

The TS backend looks for the binary in this order:
1. the `sidecarPath` option
2. `$SILICR_ZEC_SIDECAR`
3. `<repo>/zec-sidecar/target/release/zec-sidecar`

If none of them exists, it fails with `SidecarMissingError` and prints the build command.

## 2. Create the wallets

```bash
npx tsx packages/zec/scripts/testnet-roundtrip.ts --no-send
```

This creates `.silicr/wallets/buyer` and `.silicr/wallets/provider` if they are missing, syncs them, and prints each wallet's Orchard-only address and balance. A fresh wallet's birthday is the chain tip minus 100, so its first sync takes about 0.5 s.

Each wallet directory is gitignored. Every file in it is mode 0600, and the directory is 0700.

| File | Contents |
|---|---|
| `wallet.seed` | The 24-word BIP-39 phrase. Testnet only, but never print, paste or commit it. It is the only backup. |
| `wallet.json` | Network, birthday and account id. |
| `data.sqlite` | The `zcash_client_sqlite` wallet database. Deleting it forces a resync from the birthday; the seed stays. |
| `sidecar.log` | Sidecar logs (stderr). No seeds, keys or memo contents. |
| `sidecar.lock` | flock'd while a sidecar has the wallet open, so two processes can't open the same wallet. |
| `txviews.sqlite` | Local material for `inspectTx` (§5): the exact bytes of every transaction this wallet built, and compact-block summaries of the transactions that touch it. Public data only, but it records which transactions are ours, so keep it private. |

## 3. Fund the buyer (needs a human)

Send testnet ZEC (TAZ) to the **buyer** address printed above. These faucets were checked on 2026-10-01, and both pay Orchard receivers into Ironwood:

| Faucet | Amount | Notes |
|---|---|---|
| https://fauzec.com | 1 TAZ per address per 24 h | Run by Zcash Foundation staff. Has a Turnstile check. Accepts `utest1…`. |
| https://faucet.testnet.valargroup.dev | 0.125 TAZ per claim | Confirmed NU6.3. Global cap of 100 claims per 24 h. Was exhausted on 2026-10-01 and refills over the day. |
| https://zcashfaucet.jinolabs.xyz | 0.1 TAZ | Was down on 2026-10-01. |
| forum.zcashcommunity.com | varies | Post a "Requesting testnet TAZ" thread with your `utest1` address. |

To follow the transaction, look it up at `https://zexplorer.app/testnet/tx/<txid>` or `https://testnet.zecblock.com/tx/<txid>`. Avoid testnet.zcashexplorer.app, which is stale.

Received funds become **spendable after 10 confirmations**, and the wallet's own change after 3 (the ZIP 315 defaults). Testnet blocks target 25 s since NU7 (mainnet activates NU7 at height 3,543,405, around Nov 3, 2026), and arrive irregularly.

Run `npx tsx packages/zec/scripts/testnet-roundtrip.ts --no-send` again to watch the balance move from `pending` to `spendable`.

## 4. Run the round trip

```bash
npx tsx packages/zec/scripts/testnet-roundtrip.ts
```

The script:
1. Sends **one** transaction from buyer to provider with **two outputs**. Each output carries its own 512-byte ZIP 302 binary memo (`0xFF` prefix, every byte value present). One output goes to `provider.address()` and the other to a fresh `provider.newAddress()`.
2. Polls the provider until both notes are seen, first in the mempool and then mined.
3. Checks that all 512 memo bytes match, along with the value and the receiving address.
4. Prints send→seen latencies, the fee, the proving time and the `inspectTx` public view.

The exit code is 0 on success and 2 when the buyer is not funded or not yet spendable.

Options:
- `--amount <zats>`: the value per output (default 50000)
- `--timeout-min <n>`
- `--server host:port`
- `--wallets <dir>`

## 5. Use it from code

```ts
import { openBackend } from '@silicr/zec';

const zec = await openBackend({ kind: 'testnet', dataDir: '.silicr/wallets/buyer' });
await zec.address();                 // stable Orchard-only UA (diversifier index 0)
await zec.newAddress();              // fresh diversified Orchard-only UA, never reused
await zec.send([{ to, zats: 1000n, memo }]);   // ONE tx; each recipient goes through toOrchardOnly()
await zec.poll(sinceHeight);         // mined notes >= sinceHeight + unconfirmed ones; dedupe on (txid, index)
await zec.close();
```

**Capabilities**

| Capability | Value | Notes |
|---|---|---|
| `binaryMemos` | `true` | |
| `maxOutputsPerTx` | `40` | A 41-action v6 transaction has been mined on testnet. The sidecar's hard cap is 50. |
| `diversifiedAddresses` | `true` | |
| `minOutputZats` | `1n` | Matches the memory backend. Zero-value shielded outputs are valid on-chain. |
| `mempoolNotes` | `true` | |
| `inspectTx` | `true` | |

**Options.** These are extra keys on the testnet `BackendConfig`, and all of them are optional:

| Key | Default | Meaning |
|---|---|---|
| `network` | required for `kind: 'sidecar'`; `'test'` for `kind: 'testnet'` | `'main'` or `'test'`. Selects the consensus parameters (wallet DB, ZIP 32 coin type, `u`/`utest` address encoding, Ironwood activation: mainnet 3,428,143 / testnet 4,134,000, branch ids). |
| `server` | `testnet.zec.rocks:443` (test) / `zec.rocks:443` (main) | lightwalletd or Zaino endpoint (`host:port`). Its reported chain must match `network`. |
| `proxy` | `$SILICR_PROXY` | SOCKS5 proxy (`socks5h://host:port`, e.g. Tor on `127.0.0.1:9050`) for every connection to the server. `null` forces a direct connection even when the variable is set. See §11. |
| `create` | `true` | Create the wallet if `dataDir` has none |
| `birthday` | tip − 100 | Birthday height for a new wallet |
| `sidecarPath` | see §1 | Path to the `zec-sidecar` binary |
| `startupTimeoutMs` / `requestTimeoutMs` / `sendTimeoutMs` | 180000 / 60000 / 300000 | Timeouts |
| `syncIntervalMs` | 15000 | Background sync cadence. The sidecar also syncs on every new block, which the mempool stream signals, and before any `poll` once its last sync is more than 2 s old. |
| `trustedConfirmations` / `untrustedConfirmations` | 3 / 10 | ZIP 315 spendability policy. Lowering it also makes the anchor depth unusual, which fingerprints the transactions. |
| `targetNoteCount` / `minSplitZats` | 4 / 1000000 | Change splitting, so that back-to-back sends don't have to wait for change to confirm (see below). Each extra change note is one more action. |
| `onLog`, `logFile` | `<dataDir>/sidecar.log` | Sidecar log lines |

**Errors**

| Error | When |
|---|---|
| `PrivacyError` | A non-Orchard, Sapling, transparent or wrong-network recipient, or a proposal or transaction that would touch another pool. |
| `InsufficientFundsError` | Not enough spendable Ironwood funds. Check `balance().pending`: those funds are not yet at 10 or 3 confirmations. |
| `SidecarMissingError` | The binary was not found. |
| `SidecarTimeoutError` | A request ran past its timeout. |
| `SidecarExitedError` | The sidecar died. The backend restarts it on the next call, at most once every 10 s. |
| `TxNotKnownError` | `inspectTx` on a transaction this wallet holds no local data about. It never falls back to asking the server. |

**Change splitting and action counts.** The buyer splits on purpose:
- **What it does.** When the wallet holds fewer than `targetNoteCount` notes (default 4), change is split into up to that many notes, each at least `minSplitZats` (0.01 TAZ).
- **Why.** Own change needs 3 confirmations before it can be spent. With several notes in hand, ACCEPT and PAY can go out back to back instead of waiting on one change note.
- **What an observer sees.** The Ironwood action count is max(notes spent, payments + change notes), and never less than 2. At ZIP 317's 5000 zats per action, each extra change note costs 5000 zats.
- **Example.** An 8-output RFQ funded from a single note shows 9 actions with one change note, and up to 12 while the wallet is still building up its notes.

Note selection prefers a single funding note, so a send usually spends one note. Each RFQ bucket then shows a small range of action counts (4 → 5–8, 8 → 9–12, 16 → 17–20). The ranges don't overlap, so the count reveals the bucket, as designed, but not the number of providers asked. A send that has to combine many small notes can show more actions. Set `targetNoteCount: 1` for exactly one change note per transaction.

**inspectTx never asks the light-wallet server.** A `GetTransaction(txid)` request tells the server's operator that this IP cares about that transaction. So `inspectTx` builds its view only from data the wallet already holds, and `source` says which:

| `source` | Built from | `complete` |
|---|---|---|
| `broadcast` | The exact bytes of a transaction this wallet built, saved before broadcast (`txviews.sqlite`) | `true`: every field is exact |
| `wallet` | Bytes the wallet stored while syncing: memo enhancement, or the mempool stream | `true` |
| `mempool` | A copy from the mempool stream that hasn't been stored yet | `true` |
| `compact-block` | A summary kept from a compact block the wallet scanned anyway, for transactions that pay or spend this wallet's notes | `false` |

In a `compact-block` view these fields are exact:
- action and output counts
- transparent counts (the sidecar asks for transparent data in every compact block, which identifies nobody)
- height and time
- each `ciphertextSamples` entry: compact blocks carry 52 bytes of each ciphertext, and the sample uses the first 32

These fields are not, and `estimated` lists them:
- `sizeBytes`: a formula estimate, exact for shielded-only transactions (checked against mined ones)
- `version`: inferred, 6 when there are Ironwood actions
- `feeZats`: `null`
- value balances: reported as `0n` but unknown
- `expiryHeight` and `consensusBranchId`: `null`

For any other txid, `inspectTx` throws `TxNotKnownError`. In practice every transaction Silicr sends or receives has a full view: our own broadcasts are stored, and received notes need their full transaction anyway, for the memo.

**Extras on `TestnetBackend`**
- `startup`: the ready event, with the initial sync time and tip
- `proxy`: the SOCKS5 proxy the sidecar confirmed it is using (credentials stripped), or `null`
- `sync()`
- `info()`: a health check covering the server, tip, last sync age and mempool watcher state
- `send()`, which also returns `actions`, `proposeMs`, `proveMs`, `broadcastMs` and `expiryHeight`

## 6. The sidecar protocol (for debugging)

```bash
zec-sidecar serve --data-dir .silicr/wallets/buyer --network test|main [--create] [--server host:port] [--proxy socks5h://host:port]
```

`--network` defaults to `test`. The server defaults by network and must report that chain; a wallet directory records its network in `wallet.json` and is refused by a sidecar started for the other one.

`--proxy` (or `$SILICR_PROXY`) routes every connection to the server through a SOCKS5 proxy (§11). The TS backend always passes it explicitly and removes the variable from the sidecar's environment, so it has exactly one source.

Write one JSON request per line to stdin, `{"id":1,"method":"poll","params":{"sinceHeight":4428000}}`. The sidecar writes one response per line to stdout:
- success: `{"id":1,"ok":true,"result":…}`
- failure: `{"id":1,"ok":false,"error":{"code":"PrivacyError|InsufficientFunds|TxNotKnown|BadRequest|Internal","message":…}}`

Once the wallet is open and synced it emits `{"event":"ready","network":"main"|"test","address":…,"tip":…,"syncMs":…,"proxy":"socks5h://127.0.0.1:9050"|null}`. The TS backend refuses to continue if it asked for a proxy and `proxy` comes back null (unless the server is on this machine). Closing stdin makes the sidecar exit.

Methods:
- `ping`
- `info`
- `address`
- `newAddress`
- `balance`
- `height`
- `sync`
- `poll {sinceHeight}`
- `send {outputs:[{to, zats:"<decimal>", memoHex:"<1024 hex chars>"}]}`
- `inspectTx {txid}` (local data only, see §5)
- `exportViewingKey` (the Orchard-only UFVK; see §13. Answered to the caller only, never logged)
- `ledger` (every mined received note, change and sent payment with amount, memo and Silicr memo type; see §13)
- `shutdown`

Zats are decimal strings, and bytes are lowercase hex.

One-shot helpers, which need no wallet (all take `--network main|test`, `--server` and `--proxy` / `$SILICR_PROXY` too):
- `zec-sidecar info` checks the server, and prints the `proxy` in use.
- `zec-sidecar inspect-tx <txid> [--raw-hex]` is a **debug command**: it fetches the transaction from the server (which reveals interest in that txid) and prints its public view. The wallet never does this.
- `zec-sidecar find-txs --from H --to H` lists transactions with shielded parts in a block range.
- `zec-sidecar export-ufvk --data-dir <dir> --network main|test --confirm` prints the wallet's Orchard-only unified full viewing key (§13). It needs no server and takes no wallet lock, so it works while a daemon has the wallet open. Without `--confirm` it prints only the warning and exits 2.

`serve --view-only [--ufvk <uview…>]` runs a **watch-only** wallet (§13): `--ufvk` creates it from a viewing key if the directory has none (no seed file is ever written), and `--view-only` is required to open such a directory again. Every `send` is refused with `{"code":"ReadOnly"}`; everything else works. Note that `--ufvk` is visible to local users in the process list.

## 7. Tests

```bash
pnpm --filter @silicr/zec test                    # includes testnet.test.ts + testnet-sidecar.test.ts (no network)
SILICR_TESTNET_LIVE=1 pnpm --filter @silicr/zec exec vitest run test/testnet-live.test.ts
SILICR_TESTNET_LIVE=1 pnpm --filter @silicr/zec exec vitest run test/testnet-proxy-live.test.ts   # through an in-process SOCKS5 server (§11)
SILICR_MAINNET_LIVE=1 pnpm --filter @silicr/zec exec vitest run test/mainnet-live.test.ts         # read-only mainnet checks, never spends (§12)
cd zec-sidecar && cargo test --release            # guard, server refusal, SOCKS5 handshake, tx views, size formula, local store
```

The Rust tests parse a real public v6 Ironwood transaction (`zec-sidecar/testdata/tx-3229fe47.hex`: 3 actions, fee 15000, 12,322 bytes). They then check that its compact-block view (built the way lightwalletd delivers it) agrees with the full view on every count, every ciphertext sample and the exact size.

The live tests create a throwaway wallet and check:
- its addresses are Orchard-only, and `newAddress()` gives fresh ones;
- `inspectTx` on that same public transaction is **refused** with `TxNotKnownError`, because the wallet never touched it, rather than looked up on the server;
- both the TS and the Rust guard refuse transparent and Sapling recipients.

The whole run takes about 2 s.

## 8. What the light-wallet server operator can see

This is a light-client limitation; see the light-wallet-server row in THREAT_MODEL.md.

| The operator learns | Why | What the sidecar does about it |
|---|---|---|
| Your IP address and when you're online | Every request | **Set `proxy`** (§11): every connection goes through a SOCKS5 proxy such as Tor, with names resolved by the proxy and no direct fallback, so the server sees the exit's address. Or run your own Zebra + Zaino or lightwalletd and point `server` at it. |
| The **birthday height** of each new wallet | `GetTreeState(birthday − 1)` at creation | Unavoidable for a light wallet. The birthday is tip − 100, so it reveals roughly when the wallet was made. |
| Every transaction you **broadcast**, tied to your IP | `SendTransaction` | With `proxy` set the broadcast arrives from the proxy's exit, not from you. The server still learns *when* it was broadcast (see §11, timing). |
| The txid of a **received** transaction the mempool watcher missed | `GetTransaction(txid)` for memo enhancement (compact blocks don't carry memos) | Avoided in the normal case: the sidecar streams the **whole** mempool (no per-tx requests) and reuses those copies. A targeted fetch only happens for notes received while it was offline. |
| Status checks of your **own** sent transactions | `GetTransaction(txid)` | The operator already saw the broadcast, so nothing new is revealed. |
| **Nothing** about the transactions you inspect | `inspectTx` uses local data only | See §5. It throws `TxNotKnownError` rather than fetching. |
| Nothing about your addresses | | Shielded scanning uses whole compact blocks. Transparent addresses are never queried, and the wallet has none. |

## 9. Troubleshooting## 9. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `wallet … is already open in another zec-sidecar process` | Another daemon or script holds the wallet. Close it, or use a different `dataDir`. |
| `InsufficientFundsError` right after funding | Received notes need 10 confirmations. Watch `pending` turn into `spendable`. |
| `server rejected transaction … inputs stay locked until expiry height N` | The transaction was built but rejected. Its notes come back once the transaction expires, about 40 blocks later. |
| Reorg messages in `sidecar.log` | These are handled automatically (rewind by 10 blocks, then rescan). If the log says "unrecoverable reorg", delete `data.sqlite` but **not** `wallet.seed`. |
| Want to restore elsewhere | `wallet.seed` is a standard 24-word phrase, and any NU6.3-aware testnet wallet (Zodl 3.9+, Zingo, zcash-devtool) can import it. Never do this on mainnet. |

## 10. Why a sidecar (the Week 0 spike)

- **zcash-devtool** (zcash/zcash-devtool @ 5a26ee85): builds and syncs fine, and its `pay` command handles multi-output ZIP 321 payments. But:
  - its output is human-readable;
  - it doesn't scan the mempool;
  - it gives no JSON for received notes or memos;
  - it reconnects on every invocation;
  - it uses the default (all-pools) spend policy.
  
  It became the **wiring reference**, and its `Cargo.lock` seeded ours.
- **zingo-cli** (zingolib v6): handles multiple recipients, but memos are built from strings (text only), and pool control and output parsing are weaker.
- **Zallet + Zebra + Zaino** (v0.1.0-beta.3): needs a fully synced testnet node, which takes hours or days. It's the right long-term production path, but not for this hackathon.
- **zec-sidecar** (chosen): built on `zcash_client_backend` 0.24 and `zcash_client_sqlite` 0.22, with Ironwood support. It provides:
  - binary memos
  - one transaction per `send`
  - a strict Ironwood-only `SpendPolicy`
  - diversified Orchard-only UAs
  - mempool notes
  - raw-transaction parsing
  - machine-readable JSON
  
  It is about 2,100 lines of Rust.

## 11. Tor / SOCKS proxy

By default the relay and the light-wallet server both see the IP address of every party that talks to them (THREAT_MODEL.md, known limit 2). One setting closes that: a SOCKS5 proxy, which in practice means Tor.

### What goes through it

| Connection | Made by | Through the proxy? |
|---|---|---|
| Relay: mailboxes, directory, observer feed | `@silicr/relay`'s client (`proxyFetch`, built on node:http/https with an Agent whose sockets are SOCKS tunnels) | yes |
| lightwalletd gRPC/TLS: sync, mempool stream, broadcast, tree states | `zec-sidecar` (tonic with a custom SOCKS5 connector; TLS still terminates at the server) | yes |
| `zec-sidecar info / inspect-tx / find-txs` | the one-shot commands | yes, with `--proxy` or `$SILICR_PROXY` |
| CLI and web terminal → the daemons | loopback only | never leaves the machine |
| Connections to a relay or node on **this machine** (`localhost`, `127.0.0.0/8`, `::1`) | either side | no: nothing leaves the host, and Tor refuses private destinations anyway |
| Docker pulling a job's image on the provider | the Docker daemon, not Silicr | **no** (see "what it does not close") |

Rules, enforced in both the TypeScript and the Rust side:
- The destination is handed to the proxy as a **hostname** (SOCKS5 address type 3), whatever the scheme says, so no DNS lookup leaves this machine (`socks5h` semantics).
- **No fallback.** If the proxy is unreachable, refuses the connection or is not a SOCKS5 server, the connection fails and the daemon refuses to start; nothing ever dials the relay or lightwalletd directly while a proxy is configured. The sidecar echoes the proxy it uses in its `ready` event, and the TS side refuses to continue if that is missing.
- Anything that is not `socks5://` / `socks5h://` is an error (HTTP proxies can't carry the gRPC stream), not a silent no-op.
- TLS to lightwalletd is unchanged: the proxy sees the handshake (SNI `testnet.zec.rocks`) and ciphertext.
- The relay client keeps one tunnel alive per relay (HTTP keep-alive), so a job does not build a Tor circuit per request.

### Run Tor

```bash
brew install tor && tor            # macOS; Debian/Ubuntu: apt install tor && systemctl start tor
# Tor listens on 127.0.0.1:9050. Check it:
curl --socks5-hostname 127.0.0.1:9050 https://check.torproject.org/api/ip   # {"IsTor":true,"IP":"<exit>"}
```

### Set the proxy

One setting, four ways to set it (first wins): `--proxy` on the command line, `$SILICR_PROXY`, the `proxy` key in the party's `config.json` (written by `silicr init --proxy`), else direct. `--proxy none` forces direct connections for one run.

```bash
silicr init --role buyer --data .silicr/buyer --proxy socks5h://127.0.0.1:9050
silicr daemon --data .silicr/buyer                     # uses the config
SILICR_PROXY=socks5h://127.0.0.1:9050 silicr daemon --data .silicr/provider
zec-sidecar info --proxy socks5h://127.0.0.1:9050      # the sidecar alone
```

Syntax: `socks5h://[user:pass@]host[:port]`. `socks5://` means the same (names are always resolved by the proxy). The port defaults to 1080. `user:pass` is RFC 1929 authentication; with Tor's `IsolateSOCKSAuth` (on by default) different credentials get different circuits, so you can give the buyer and the provider daemons different credentials to keep their circuits apart. Credentials are never logged or shown: `silicr status` and the Leak Inspector show `socks5h://host:port`.

From code: `relayClient(url, { proxy: 'socks5h://127.0.0.1:9050' })` (no environment default: pass it explicitly) and `openBackend({ kind: 'testnet', dataDir, proxy: 'socks5h://127.0.0.1:9050' })`, which defaults to `$SILICR_PROXY`; `proxy: null` means direct even then.

A relay can also be reached as an onion service: run `silicr relay` and expose it with `HiddenServicePort 80 127.0.0.1:7700` in `torrc`; clients then use `--relay http://<name>.onion` with the proxy set, and the relay sees every client as `127.0.0.1` (Tor's local side of the service).

### Check it

- `silicr status` prints a `proxy` row: green with the proxy, yellow `none: direct connections, IP visible…` without.
- Each daemon records a `network` observation (globally, and as the first observation of every RFQ) that the Leak Inspector shows in its buyer/provider column: `network: via SOCKS5 proxy, IP not exposed to relay/light-wallet server`, or the opposite.
- `zec-sidecar info --proxy …` prints `"proxy": "socks5h://…"`; `sidecar.log` says `every connection to https://testnet.zec.rocks:443 goes through SOCKS5 proxy …`.
- Tests: `pnpm --filter @silicr/relay test` (an in-process SOCKS5 server records every CONNECT: hostnames only, TLS verified, no fallback when the proxy is down or refuses), `pnpm --filter @silicr/zec test` (the sidecar wrapper passes and verifies the setting), `cargo test` in `zec-sidecar` (the SOCKS5 handshake against an in-process proxy and echo server), and the opt-in live test above against the real testnet server.

Measured on 2026-10-21 (M-series Mac, Tor 0.4.9.12, one hop of a fresh circuit): see the table below.

| Operation (through Tor) | Time | Note |
|---|---|---|
| `proxyFetch` → `https://check.torproject.org/api/ip` | 1.9 s | `IsTor: true`; the exit's IP is what the server sees |
| Relay `append` #1 to a relay exposed as an onion service | 6.2 s | includes the rendezvous |
| Relay `append` #2 on the same keep-alive tunnel | 0.8 s | |
| Relay `read` (listing + 2 message fetches) | 2.3 s | |
| Relay `listDirectory` | 0.9 s | |
| The relay's observer feed, client ip | `127.0.0.1` | the onion service's local side; the relay never sees the client |
| `zec-sidecar info` (process start, TLS, GetLightdInfo) | 5.8 s | 4.1 s through a local SOCKS server on a direct network path |
| New wallet: create, tree state, first sync of 100 blocks | 6.2 s total, 3.8 s sync | 2.5 s / 1.6 s through a local SOCKS server |
| `height()` once open | 1.1 s | |
| Mempool stream | connected, 1 session | the stream reconnects on every block, through Tor each time |

So expect a few seconds of extra latency per circuit and under a second per request afterwards, which is nothing next to 25-second testnet blocks (75 s on mainnet until NU7).

### What it closes, and what it does not

Closed: the relay and the light-wallet server no longer learn this machine's IP address; the Tor exit learns that *someone* talks to `testnet.zec.rocks` and to the relay, not who.

Still open, and stated in THREAT_MODEL.md:
- **Timing correlation** (known limit 4). The light-wallet server still sees one padded RFQ broadcast followed by a train of uniform payments from *one* circuit, and the relay operator can still line up blob timing with chain timing. Tor hides where the traffic comes from, not when it happens.
- **A plain-`http://` relay** is readable by the Tor exit (and anyone on the path). Silicr never gives the relay plaintext, so this exposes ciphertext blobs, sizes and timing only. Use an `https://` relay or an onion service to remove the exit from the picture.
- **The wallet's birthday height** still tells the server roughly when the wallet was created.
- **Docker image pulls** on the provider go through the Docker daemon, from the provider's own IP, and tell the registry which image (`python:3.12-slim` by default) was pulled. Pre-pull images, or run Docker through Tor, if that matters to you.
- **Circuit reuse**: all of one daemon's connections share Tor's default circuit policy. Give the buyer and the provider different SOCKS credentials (above) if they run on the same machine and must not share a circuit.
- A proxy only helps if it is really Tor (or something you trust): the SOCKS proxy itself sees every destination.

## 12. Mainnet

Everything above applies on mainnet with `network: 'main'` (`silicr … --network main`, `zec-sidecar … --network main`). The differences:

- **Real ZEC.** Read [MAINNET.md](MAINNET.md): small balances, spend caps required by the daemon, and your go-ahead before any send. The sidecar logs `MAINNET: real ZEC` on start. The spend policy is the same on both networks: Ironwood notes only, Orchard-receiver-only recipients, no pool crossing.
- **Addresses are `u1…`** (the mainnet unified-address HRP); `toOrchardOnly(address, 'main')` and the sidecar produce byte-identical Orchard-only encodings. A testnet address is refused on a mainnet wallet and the other way round, in TypeScript and in Rust.
- **Chain check instead of a host blocklist.** The sidecar no longer refuses servers by name: it asks any server for `GetLightdInfo` and refuses to go on unless `chainName` equals the requested network. The TS layer refuses a sidecar whose `ready` event reports another network.
- **A wallet directory is locked to its network** (`wallet.json`). Never point `--network test` at a mainnet wallet dir or import a mainnet seed into a testnet wallet.

### Public mainnet lightwalletd servers (probed 2026-10-21, `zec-sidecar info --network main --server …`)

| Server | Answer | Note |
|---|---|---|
| `zec.rocks:443` (**default**) | chain `main`, branch `37a5165b`, lightwalletd v0.5.3 | zec.rocks anycast; 2.0 s to first answer from here |
| `na.zec.rocks:443`, `eu.zec.rocks:443`, `ap.zec.rocks:443`, `sa.zec.rocks:443` | same | regional zec.rocks nodes (Zebra 6.3.0), 0.4–0.7 s from here |
| `zcash.mysideoftheweb.com:9067` | chain `main`, branch `37a5165b`, lightwalletd v0.5.4 | community server, 1.1 s |
| `mainnet.lightwalletd.com:9067` (ECC's historical host), `lwd1…lwd8.zcash-infra.com:9067` | DNS does not resolve any more | not usable |

Set another with `--server host:port`; whichever you pick is checked for chain `main` before anything else happens. Your own Zebra + Zaino is the private option (THREAT_MODEL.md, light-wallet-server row), and a SOCKS5 proxy (§11) works the same on mainnet.

### Read-only mainnet check (never spends)

```bash
SILICR_MAINNET_LIVE=1 pnpm --filter @silicr/zec exec vitest run test/mainnet-live.test.ts
```

Creates a throwaway, never-funded wallet in a temp dir and checks: `info` (chain `main`, NU6.3 branch), the chain-mismatch refusal (a testnet server for a mainnet wallet), wallet creation and a ~100-block sync, `u1…` Orchard-only addresses byte-identical to `toOrchardOnly`, a zero balance, and that `inspectTx` on a public mainnet v6 transaction the wallet never touched is refused locally (`TxNotKnownError`) rather than fetched. Measured on 2026-10-21 against `zec.rocks:443` from an M-series Mac: `info` 0.48 s; wallet create (tree state at birthday) plus the first sync of 101 blocks, 4.2 s total of which 3.4 s syncing; tip 3,525,789. Mainnet blocks are ~75 s apart, so a wallet with birthday tip − 100 covers about two hours of chain.

## 13. Viewing keys (audits)

An accountant, a co-founder or a grant reviewer may need to see what a Silicr wallet paid and received, without being able to move a single zatoshi. Zcash has a key for exactly that: the **unified full viewing key** (ZIP 316 UFVK, `uview1…` on mainnet, `uviewtest1…` on testnet). Silicr exports the **Orchard component only**, matching its Orchard-receiver-only addresses; there is no Sapling or transparent part because the wallet never uses those pools.

**What the key reveals, to whoever holds it:**
- every note the wallet ever received: amount, memo (so every Silicr RFQ, BID, ACCEPT, PAY and CLOSE message it was sent), height and txid;
- every payment the wallet ever sent (recovered with the outgoing viewing key inside the UFVK): recipient address, amount, memo, fee;
- which addresses belong to this wallet: the key derives all of its diversified addresses, so the fresh per-RFQ reply addresses are linkable *by the key holder*;
- the wallet's balance over time.

**What it never includes:** spending authority. A UFVK cannot sign a transaction, and a watch-only wallet made from it holds no seed. It also says nothing about other wallets: a provider's viewing key shows the provider's payments, not who the buyers are beyond the addresses they used.

**Scope warning.** The key covers the *whole* wallet, past and future, and cannot be narrowed to a period or a counterparty. So use **one wallet per audit scope**: one `silicr init` data dir per client, per project or per accounting period, and hand over that wallet's key only. Hand it over on a private channel; anyone who gets the key gets the history.

### Export

```bash
silicr export-viewing-key --data .silicr/wallets/buyer            # testnet wallet; asks "Print the viewing key? [y/N]"
silicr export-viewing-key --data .silicr/wallets/main-buyer --yes  # mainnet; --yes acknowledges the warning (needed without a terminal)
```

The command resolves the network from `--network`, else the dir's `config.json`, else the sidecar's `wallet.json`, and refuses anything that is not a testnet or mainnet wallet. It prints the warning on **stderr** and the key alone on **stdout**, so `silicr export-viewing-key … --yes > key.txt` captures just the key. The key never goes to a log file, to the daemon or to the relay. It works while the daemon is running (it reads the wallet database read-only via `zec-sidecar export-ufvk`).

From code: `await backend.exportViewingKey()` on a sidecar backend (an optional method on `ZecBackend`), or `exportViewingKeyOffline({ dataDir, network })` from `@silicr/zec` for a wallet that is not open.

### Watch

```bash
silicr watch --network test --data .silicr/audit/client-a --viewing-key uviewtest1… [--birthday <height>] [--json]
silicr watch --network test --data .silicr/audit/client-a            # re-open: the key is in the watch wallet's database
```

`watch` creates a **watch-only wallet** in `--data` (a new directory: never a spending wallet's), syncs it from the light-wallet server like any other wallet, and prints a ledger:

```
  watch-only wallet  Zcash testnet  no spending key: sees everything, sends nothing

  address   utest1…
  data dir  .silicr/audit/client-a (no seed; still private: it holds the whole history)
  scanned   birthday 4428000 → tip 4431210
  received  0.0005 ZEC in 1 notes
  sent      0.00003 ZEC in 2 payments, 0.0003 ZEC fees

  height   time (UTC)        dir     amount       memo              txid           to/from
  4428050  2026-10-09 12:00  in      0.0005 ZEC   PAY               ab12cd34ef56…  utest1httsgu4z…
  4428060  2026-10-09 12:08  out     0.00001 ZEC  text "invoice 42" cd34ef56ab12…  utest1due6gq77…
  4428060  2026-10-09 12:08  change  0.00039 ZEC  none              cd34ef56ab12…  utest1httsgu4z…
```

The `memo` column is the Silicr message type when the memo is a Silicr frame (binary `0xFF|SLC1|…` or text `slc1:…`), else `none` (empty), `text` or `binary`. `--json` prints the same rows as JSON (`zats` and `feeZats` as decimal strings, `memoHex` as the full 512-byte memo). Give `--birthday` the audited wallet's birthday (from its `wallet.json`) to see its whole history; the default is tip − 100, which only shows what happens from now on.

The watch wallet's `send()` throws `ReadOnlyError` in TypeScript and the sidecar refuses it again with `{"code":"ReadOnly"}`. Its data dir holds no `wallet.seed`; `wallet.json` says `"viewOnly": true`, and the sidecar refuses to open it without `--view-only`. It is still private data (it records the whole history and, like any light wallet, its birthday height and IP reach the server; §8 and §11 apply).

### Tests

```bash
cd zec-sidecar && cargo test --release keys                         # UFVK round trip (Orchard-only, both HRPs, same address), refusals, memo-type decoding
ZEC_SIDECAR_LIVE=1 cargo test --release live_                       # two throwaway testnet wallets: export → watch-only import → same address → ledger → send refused (~3 s, never funded)
pnpm --filter @silicr/zec exec vitest run test/viewing-key.test.ts  # fake sidecar: --view-only --ufvk, ReadOnlyError, ledger parsing, offline export
pnpm --filter @silicr/cli exec vitest run test/keys.test.ts         # the two commands with the backend mocked
```

