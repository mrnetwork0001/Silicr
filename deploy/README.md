# Hosted testnet demo (VPS)

Silicr's public demo on Zcash **testnet**, on a shared VPS behind its existing nginx.

| URL | What | Upstream |
|---|---|---|
| https://silicr.38-49-213-208.sslip.io | landing page (static export of `apps/landing`) | `/var/www/silicr/landing` |
| https://app.silicr.38-49-213-208.sslip.io/ | web terminal (`next start`; its pages are `/`, `/provider`, `/wallet`, `/rfq/:id`) | `127.0.0.1:8703` |
| …/api/buyer/ | buyer daemon (`/api/buyer/api/events` is SSE) | `127.0.0.1:8701` |
| …/api/provider/ | provider daemon | `127.0.0.1:8702` |
| …/api/relay/ | ciphertext-only relay, directory, observer | `127.0.0.1:8700` |

The daemon proxies sit under `/api/…` on purpose: nginx prefix locations such as `/provider/` made
`/provider` (a terminal page) 301 to `/provider/`, which is the provider daemon's `/` (404). The
terminal has no `/api` routes of its own, so nothing can collide there. `Dockerfile.node` bakes
`NEXT_PUBLIC_BUYER_URL=$APP_ORIGIN/api/buyer` (and `/api/provider`, `/api/relay`) into the web build.

## Files

- `Dockerfile.sidecar`: release build of `zec-sidecar` (Rust, linux/amd64).
- `Dockerfile.node`: Node 22 image with the workspace (prod deps + tsx), the built web terminal, `examples/`, python3 and the sidecar binary. Runs as `node` (uid 1000); data in `/data`. Target `landing` holds the landing export in `/out`.
- `compose.yml`: project `silicr`: `relay`, `provider`, `buyer`, `web`. Ports published on 127.0.0.1 only.
- `fwd.mjs`: the daemons bind loopback only (by design), so each daemon container runs it as a TCP forwarder from the published port (870x) to the daemon (770x) inside the container. Bytes are not inspected or logged.
- `nginx-silicr.conf`: the full `/etc/nginx/sites-available/silicr`.
- `dockerignore`: copied to the build context as `.dockerignore` (the VPS has no buildx, so images are built with the classic builder).
- `deploy.sh`: the whole deployment, idempotent.

## Deploy

```bash
deploy/deploy.sh             # sync, build (nice), landing, containers, nginx, certs, status
deploy/deploy.sh --wallets   # also re-copy the two testnet wallets (stops buyer/provider first)
SKIP_BUILD=1 deploy/deploy.sh
```

What it does:
1. rsyncs the repo to `/opt/silicr/src`, without `node_modules`, `.next*`, `target`, `.silicr`, `.git` or any wallet.
2. On the first run (or with `--wallets`) it copies **only** `.silicr/wallets/test-buyer` and `.silicr/wallets/test-provider` (refusing anything not `test-*` or whose config is not `"network": "test"`) to `/opt/silicr/data/wallets/` with scp, without the lock and log files. Directories are 0700, files 0600, owned by uid 1000. Mainnet wallets are never copied.
3. Builds `silicr-sidecar`, `silicr-landing` and `silicr-node` under `nice -n 15` with `DOCKER_BUILDKIT=0`. Public URLs are build args (`APP_ORIGIN`, `LANDING_ORIGIN`) because Next inlines `NEXT_PUBLIC_*` at build time.
4. Copies the landing export to `/var/www/silicr/landing` (swapped in atomically).
5. `docker compose -p silicr up -d`. The daemons start only if the image's `silicr daemon --help` lists `--public-origin`, `--trust-proxy` and `--public-demo`; otherwise only `relay` and `web` start. With `--public-demo` the provider bids 60 s intervals (`PUBLIC_DEMO_INTERVAL_S`), the buyer auto-accepts requests that don't say otherwise and expires an unaccepted request 4 blocks after its bid window, and stop/accept/fault are scoped to the visitor (IP) who made the request.
6. Installs the nginx file. If the app cert is missing, it first installs it without the app's 443 block, reloads, runs `certbot certonly --webroot -w /var/www/silicr -d app.silicr…`, then installs the full file. Every install runs `nginx -t` first and only then `systemctl reload nginx` (never restart); on failure the previous silicr file is restored.

## Sandbox

The provider uses the **process runner**: jobs run as child processes inside the provider container, and **the container is the sandbox**. No Docker socket is mounted. The container has a read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`, a tmpfs `/tmp`, a pid limit of 256, and 1 CPU / 1 GB. It mounts only its own wallet dir. It still has outbound network access (the wallet needs lightwalletd), so it can reach the internet and any host service bound to `0.0.0.0`. `--public-demo` is what limits what strangers can submit.

Limits: buyer and provider 1 CPU / 1 GB each, relay and web 0.5 CPU / 512 MB each. All containers use `restart: unless-stopped` and have healthchecks, plus json-file logs capped at 3 × 10 MB.

## Operate

```bash
ssh root@38.49.213.208
cd /opt/silicr/src/deploy
docker compose -p silicr ps
docker compose -p silicr logs -f --tail 100 buyer
docker compose -p silicr restart web          # only silicr containers
docker stats --no-stream $(docker ps -q --filter label=com.docker.compose.project=silicr)
```

Only touch the `silicr` project. Never run `docker system prune`, and never run compose commands without `-p silicr`.

Data: `/opt/silicr/data/relay` (relay mailboxes and directory) and `/opt/silicr/data/wallets/test-*` (testnet wallets, seeds included: never copy them off the box or into git).
