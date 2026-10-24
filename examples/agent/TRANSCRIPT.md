# Transcript: an agent rents a GPU (real run)

A real, unedited-except-for-trimming run of Claude Code against the live `silicr demo` stack on this machine (simulated chain, Docker runner), 2026-10-21. Model `claude-sonnet-5` through Claude Code 2.1.261; 8 turns, 19 s, $0.14 of API use. Tool results are shown trimmed: the first 600 characters of the JSON the agent saw, and the leak report as its summary and matrix.

```bash
claude -p "<prompt>" --mcp-config mcp.json --strict-mcp-config --allowedTools "mcp__silicr__*" --tools "" \
  --permission-prompts none --output-format stream-json --verbose --no-session-persistence --model sonnet
```

The MCP server was started by Claude Code from `mcp.json` as `node packages/mcp/bin/silicr-mcp.js --buyer http://127.0.0.1:7701 --provider http://127.0.0.1:7702 --relay http://127.0.0.1:7700 --max-total-zec 0.2 --out-dir .silicr/mcp-results`.

## Prompt

> Use the silicr tools. Rent 1x a100 for 0.05 hours at up to 0.8 ZEC/h to run the job in /Users/mrnetwork/Silicr/examples/tiny-train (command python3 train.py, env SILICR_STEPS=60 and SILICR_STEP_DELAY_MS=30), auto-accepting the cheapest signed bid. First check the status and the estimate, then make the request, wait until it is running, wait until it is closed (use timeout_s 60 and call wait again if it times out), download the result, and finally run the leak report. Then tell me, in at most six lines, what you paid, what each party (chain, relay, provider, buyer) learned, and whether anything leaked.

## Tool calls

> I'll start by checking status and getting a cost estimate.

### 1. `silicr_status`

**input** `{}`

**result** (JSON below)

<details><summary>JSON</summary>

```json
{"role":"buyer","network":"simulated chain (in-memory stand-in for Zcash: no real ZEC)","networkCode":"memory","realZec":false,"height":1757,"blockTimeS":1,"address":"uregtest1vuhurv24sq5t0x2u9pjx9gut9hrj0239mgy8220mjap82m0rpwpl6uzlpxvnzgqzv75wnpjedj29xyxsm880h2mh5g3gqran4gy93zk3","balance":{"spendableZec":"9.99504998","pendingZec":"0"},"demoMode":true,"relayUrl":"http://127.0.0.1:7700","version":"0.1.0","sessionCap":{"maxZec":"0.2","committedZec":"0","spentZec":"0","remainingZec":"0.2","requests":0,"note":"Per-session ceiling enforced by silicr-mcp: a request reserves hours × max_zec_per_hour…
```
</details>

### 2. `silicr_estimate`

**input** `{"gpu":"a100","hours":0.05,"max_zec_per_hour":0.8}`

**result** (JSON below)

<details><summary>JSON</summary>

```json
{"gpu":"a100","count":1,"hours":0.05,"durationS":180,"maxZecPerHour":"0.8","intervalS":4,"intervalAssumed":true,"intervals":45,"maxCostZec":"0.04","estimatedFeesZec":"0.00495","estimatedMaxTotalZec":"0.04495","maxExposure":{"intervals":1.25,"zec":"0.00111112","seconds":5,"note":"The most a provider that stops working (or lies about progress) can take: one prepaid interval plus the one in progress."},"cap":{"fits":true,"perRequestLimitZec":"0.2","limitedBy":"session","session":{"maxZec":"0.2","remainingZec":"0.2"}},"matchingProviders":[{"alias":"velvet-orca-13","providerId":"9da9e4f57b198a84fdb…
```
</details>

> Fits within cap (max ~0.045 ZEC incl. fees). Submitting the request now.

### 3. `silicr_request_compute`

**input** `{"gpu":"a100","hours":0.05,"max_zec_per_hour":0.8,"job_path":"/Users/mrnetwork/Silicr/examples/tiny-train","command":["python3","train.py"],"env":{"SILICR_STEPS":"60","SILICR_STEP_DELAY_MS":"30"}}`

**result** (JSON below)

<details><summary>JSON</summary>

```json
{"rfqId":"c47a33718d5359ea5037d40fb14b5977","state":"broadcasting","request":{"gpu":"a100","count":1,"hours":0.05,"durationS":180,"maxZecPerHour":"0.8","job":{"directory":"/Users/mrnetwork/Silicr/examples/tiny-train","command":["python3","train.py"],"image":"python:3.12-slim","envKeys":["SILICR_STEPS","SILICR_STEP_DELAY_MS"]}},"autoAccept":{"rule":"cheapest","waitBlocks":2},"cap":{"reservedZec":"0.04","sessionRemainingZec":"0.16"},"realZec":false,"next":"Call silicr_wait with until=\"running\", then until=\"closed\"; then silicr_download_result and silicr_leak_report."}
```
</details>

> Request submitted (c47a33718d5359ea5037d40fb14b5977). Now waiting for it to start running.

### 4. `silicr_wait`

**input** `{"rfq_id":"c47a33718d5359ea5037d40fb14b5977","until":"running","timeout_s":60}`

**result** (JSON below)

<details><summary>JSON</summary>

```json
{"reached":true,"terminal":false,"timedOut":false,"state":"running","waitedS":0,"request":{"rfqId":"c47a33718d5359ea5037d40fb14b5977","state":"running","terminal":false,"createdAt":"2026-10-21T17:37:57.466Z","jobStartedAt":"2026-10-21T17:37:58.237Z","request":{"gpu":"a100","count":1,"durationS":180,"hours":0.05,"maxZecPerHour":"0.8"},"providersAsked":1,"paddedOutputs":4,"expiresHeight":1769,"rfqTxid":"31c8ddcc0b0ad13dd858be94089a0673bfee79e4386ae4562fc5d4392a43f20a","bids":[{"alias":"velvet-orca-13","providerId":"9da9e4f57b198a84fdb44d61f0c9e93f0af59174a005d31e4e54b344db55d487","zecPerHour":"0…
```
</details>

> Job is running (step 51/60). Now waiting for it to close.

### 5. `silicr_wait`

**input** `{"rfq_id":"c47a33718d5359ea5037d40fb14b5977","until":"closed","timeout_s":60}`

**result** (JSON below)

<details><summary>JSON</summary>

```json
{"reached":true,"terminal":true,"timedOut":false,"state":"closed","waitedS":0,"request":{"rfqId":"c47a33718d5359ea5037d40fb14b5977","state":"closed","terminal":true,"closeReason":"done","createdAt":"2026-10-21T17:37:57.466Z","closedAt":"2026-10-21T17:38:00.819Z","jobStartedAt":"2026-10-21T17:37:58.237Z","request":{"gpu":"a100","count":1,"durationS":180,"hours":0.05,"maxZecPerHour":"0.8"},"providersAsked":1,"paddedOutputs":4,"expiresHeight":1769,"rfqTxid":"31c8ddcc0b0ad13dd858be94089a0673bfee79e4386ae4562fc5d4392a43f20a","bids":[{"alias":"velvet-orca-13","providerId":"9da9e4f57b198a84fdb44d61f0…
```
</details>

> Job finished in 2s (done, verified). Downloading the result and running the leak report.

### 6. `silicr_download_result`

**input** `{"rfq_id":"c47a33718d5359ea5037d40fb14b5977"}`

**result** (JSON below)

<details><summary>JSON</summary>

```json
{"path":"/Users/mrnetwork/Silicr/.silicr/mcp-results/silicr-result-c47a3371.tar.gz","sizeBytes":2252,"sha256":"6681e868ef1b568c4bfa00b34351c5f656046d7d87d7cb95d4a21fb9c0de8ed8","sealedDigest":"0e25aad2745ecd1cc5470673bc231e623a58d5dfe7e21ea159076881aac88025","resultVerified":true,"format":"tar.gz (unpack with: tar -xzf <path>)","note":"sealedDigest is the SHA-256 of the encrypted blob the provider signed in its CLOSE; sha256 is the plaintext bundle you now hold."}
```
</details>

### 7. `silicr_leak_report`

**input** `{"rfq_id":"c47a33718d5359ea5037d40fb14b5977"}`

**result** chain knows 0/6 facts; relay knows 1/6 facts (buyer_ip: known limit 2); provider knows 4/6 facts (workload, price, amount, provider_identity: all expected); buyer knows 6/6 facts (its own deal). No unexpected leaks: 5 shielded transaction(s) with 0 transparent and 0 Sapling parts.

| Fact | chain | relay | provider | buyer |
|---|---|---|---|---|
| Who the buyer is | hidden | no | hidden | knows (self) |
| What is being run | hidden | hidden | knows (known limit 1) | knows |
| Price | hidden | no | knows | knows |
| Amounts paid | hidden | no | knows | knows |
| Which provider | hidden | no | knows (self) | knows |
| Buyer IP | no | knows (known limit 2) | no | knows (self) |

chain: {"transactions":5,"mined":5,"shieldedActions":13,"transparentParts":0,"saplingParts":0,"legacyOrchardActions":0,"feesZec":"0.00065","viewsUnavailable":0}  
unexpected: []

## Final answer

Job completed successfully (60 steps, 2s runtime, result verified, saved to `.silicr/mcp-results/silicr-result-c47a3371.tar.gz`).

- **Paid:** 0.00066667 ZEC to provider velvet-orca-13 (1 interval, job finished almost instantly) + ~0.00065 ZEC total network fees.
- **Chain:** 0/6 facts — sees only 5 shielded txs, fully encrypted Orchard actions, no transparent/Sapling parts.
- **Relay:** 1/6 (buyer's IP only, a documented known limit) — never sees workload, price, or amounts.
- **Provider:** 4/6 (workload, price, amount, its own identity) — expected, since it must see the job it runs.
- **Buyer:** 6/6 (all its own deal data) — expected.
- **Verdict: "private"** — no unexpected leaks.
