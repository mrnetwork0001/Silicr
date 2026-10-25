# Hosted demos (VPS)

Silicr's public demos on a shared VPS behind its existing nginx: a **testnet** stack (anyone may drive a shared testnet wallet) and a **mainnet** stack (real ZEC from a tiny shared wallet with a hard cap).

| URL | What | Upstream |
|---|---|---|
| https://silicr.xyz (www → apex) | landing page (static export of `apps/landing`) | `/var/www/silicr/landing` |
| https://app.silicr.xyz/ | testnet web terminal (`next start`; pages `/`, `/provider`, `/wallet`, `/rfq/:id`) | `127.0.0.1:8703` |
| …/api/buyer/, …/api/provider/, …/api/relay/ | testnet buyer daemon (`/api/buyer/api/events` is SSE), provider daemon, ciphertext-only relay + directory + observer | `127.0.0.1:8701`, `8702`, `8700` |
| https://mainnet.silicr.xyz/ | **mainnet demo** terminal, same pages | `127.0.0.1:8713` |
| …/api/buyer/, …/api/provider/, …/api/relay/ | mainnet buyer daemon, provider daemon, relay | `127.0.0.1:8711`, `8712`, `8710` |
| https://silicr.38-49-213-208.sslip.io, https://app.silicr.38-49-213-208.sslip.io | the old names, aliases of the landing page and the testnet terminal | same as above |

The daemon proxies sit under `/api/…` on purpose: nginx prefix locations such as `/provider/` made `/provider` (a terminal page) 301 to `/provider/`, which is the provider daemon's `/` (404). The terminal has no `/api` routes of its own, so nothing can collide there. `Dockerfile.node` bakes `NEXT_PUBLIC_BUYER_URL=$APP_ORIGIN/api/buyer` (and `/api/provider`, `/api/relay`) into the web build, so the testnet and mainnet terminals are two image tags of the same Dockerfile: `silicr-node:latest` (origin `app.silicr.xyz`) and `silicr-node:main` (origin `mainnet.silicr.xyz`). The landing export gets `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_LANDING_URL` and `NEXT_PUBLIC_MAINNET_URL` (the "Real ZEC demo · tiny capped wallet" link in its final CTA).

## Files

- `Dockerfile.sidecar`: release build of `zec-sidecar` (Rust, linux/amd64).
- `Dockerfile.node`: Node 22 image with the workspace (prod deps + tsx), the built web terminal, `examples/`, python3 and the sidecar binary. Runs as `node` (uid 1000); data in `/data`. Target `landing` holds the landing export in `/out`. Build args `APP_ORIGIN`, `LANDING_ORIGIN`, `MAINNET_ORIGIN`.
- `compose.yml`: project `silicr` (testnet): `relay`, `provider`, `buyer`, `web`; ports 8700–8703 on 127.0.0.1 only; data under `/opt/silicr/data`.
- `compose.main.yml`: project `silicr-main` (mainnet demo): the same four services from `silicr-node:main`, ports 8710–8713, data under `/opt/silicr-main/data`, daemons with `--network main --public-demo --allow-mainnet --cap-per-request 0.001 --cap-total 0.005`.
- `fwd.mjs`: the daemons bind loopback only (by design), so each daemon container runs it as a TCP forwarder from the published port to the daemon inside the container. Bytes are not inspected or logged.
- `nginx-silicr.conf`: the full `/etc/nginx/sites-available/silicr`: HTTP → HTTPS for every name, `www` → apex, the four `silicr.xyz` names on one certificate (`xyz-tls` block), the sslip aliases on their own.
- `dockerignore`: copied to the build context as `.dockerignore` (the VPS has no buildx, so images are built with the classic builder).
- `deploy.sh`: the whole deployment, idempotent.

## Deploy

```bash
deploy/deploy.sh                  # testnet: sync, build (nice), landing, containers, nginx, certs, status
deploy/deploy.sh --wallets        # also re-copy the two testnet wallets (stops buyer/provider first)
deploy/deploy.sh --main           # mainnet demo: sync, build silicr-node:main, containers, nginx, status
deploy/deploy.sh --main --wallets # also re-copy the two mainnet demo wallets
SKIP_BUILD=1 deploy/deploy.sh
```

What it does:
1. rsyncs the repo to `/opt/silicr/src`, without `node_modules`, `.next*`, `target`, `.silicr`, `.git` or any wallet.
2. Wallets, on the first run of each mode (or with `--wallets`), with scp, without the lock and log files; directories 0700, files 0600, owned by uid 1000:
   - testnet: **only** `.silicr/wallets/test-buyer` and `test-provider` (refusing anything not `test-*` or whose config is not `"network": "test"`) to `/opt/silicr/data/wallets/`.
   - mainnet demo (`--main`): **only** `.silicr/wallets/demo-main-buyer` and `demo-main-provider` (refusing anything not `demo-main-*` or whose config is not `"network": "main"`) to `/opt/silicr-main/data/wallets/`. `main-buyer` and `main-provider` (the lead's own mainnet wallets) are never copied anywhere, and no testnet wallet reaches the mainnet project.
3. Builds `silicr-sidecar`, `silicr-landing` and `silicr-node:latest` (testnet) or `silicr-node:main` (mainnet) under `nice -n 15` with `DOCKER_BUILDKIT=0`. Public URLs are build args because Next inlines `NEXT_PUBLIC_*` at build time.
4. Testnet: copies the landing export to `/var/www/silicr/landing` (swapped in atomically).
5. `docker compose -p silicr up -d` or `-p silicr-main -f compose.main.yml up -d`. The daemons start only if the image's `silicr daemon --help` lists the flags they need (`--public-origin`, `--trust-proxy`, `--public-demo`; plus `--allow-mainnet` for the mainnet project); otherwise only `relay` and `web` start. With `--public-demo` the provider bids 60 s intervals (`PUBLIC_DEMO_INTERVAL_S`), the buyer auto-accepts requests that don't say otherwise and expires an unaccepted request 4 blocks after its bid window, and stop/accept/fault are scoped to the visitor (IP) who made the request.
6. Installs the nginx file. Missing certificates: it first installs the file without the matching TLS blocks (`xyz-tls`, `app-tls`), reloads, runs `certbot certonly --webroot -w /var/www/silicr` (for the four `silicr.xyz` names only once `dig @8.8.8.8` shows them pointing at the VPS; until then HTTPS for them is reported as pending), then installs the full file. Every install runs `nginx -t` first and only then `systemctl reload nginx` (never restart); on failure the previous silicr file is restored.

## The mainnet demo

Real ZEC, deliberately tiny. The buyer daemon runs `--public-demo --allow-mainnet --cap-per-request 0.001 --cap-total 0.005`: every public-demo rule applies (presets only, ≤ 15 min, 1 GPU, one live request, 3 per IP per hour, withdraw/policy/migrate/provider-stop disabled, visitor scoping) and on top the engine enforces the cap as a hard ceiling: a request whose worst case (every interval at the max price, plus the RFQ, ACCEPT/PAY and CLOSE fees) exceeds the per-request cap or what is left of the total is refused with 400 `spend_cap`; the max price is capped at 0.001 ZEC/h. `GET /api/status` carries `spendCap` (spent / total / per request), `publicDemoLimits.allowMainnet`, `publicDemoLimits.minWorstCaseZats` and `demoExhausted: true` once the wallet (or the cap) cannot afford the cheapest preset; the terminal then shows "This mainnet demo has spent its budget" instead of the form. The provider asks 0.0005 ZEC/h with 60 s intervals and bids only while it holds ≥ 0.0003 ZEC for fees (`bidding` in its status says so otherwise). Fund the two wallets with the addresses in their `/api/status`; with 0.005 ZEC in the buyer and ~0.001 ZEC in the provider the demo affords roughly two long runs or six quick ones, then reports itself exhausted.

## Sandbox

The provider uses the **process runner**: jobs run as child processes inside the provider container, and **the container is the sandbox**. No Docker socket is mounted. The container has a read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`, a tmpfs `/tmp`, a pid limit of 256, and 1 CPU / 1 GB. It mounts only its own wallet dir. It still has outbound network access (the wallet needs lightwalletd), so it can reach the internet and any host service bound to `0.0.0.0`. `--public-demo` is what limits what strangers can submit.

Limits: buyer and provider 1 CPU / 1 GB each, relay and web 0.5 CPU / 512 MB each. All containers use `restart: unless-stopped` and have healthchecks, plus json-file logs capped at 3 × 10 MB.

## Operate

```bash
ssh root@38.49.213.208
cd /opt/silicr/src/deploy
docker compose -p silicr ps                              # testnet
docker compose -p silicr-main -f compose.main.yml ps     # mainnet demo
docker compose -p silicr logs -f --tail 100 buyer
docker compose -p silicr-main -f compose.main.yml logs -f --tail 100 buyer
docker compose -p silicr restart web                     # only silicr containers
docker stats --no-stream $(docker ps -q --filter label=com.docker.compose.project=silicr)
```

Only touch the `silicr` and `silicr-main` projects. Never run `docker system prune`, and never run compose commands without `-p silicr` / `-p silicr-main`.

Data: `/opt/silicr/data/relay` and `/opt/silicr/data/wallets/test-*` (testnet), `/opt/silicr-main/data/relay` and `/opt/silicr-main/data/wallets/demo-main-*` (mainnet demo). Wallet dirs hold seeds: never copy them off the box or into git.
