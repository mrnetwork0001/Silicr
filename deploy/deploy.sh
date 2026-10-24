#!/usr/bin/env bash
# Deploy the Silicr hosted testnet demo to the VPS. Idempotent; run from anywhere:
#   deploy/deploy.sh                  # sync, build, start, nginx, certs, landing
#   deploy/deploy.sh --wallets        # also (re)copy the two TESTNET wallets (stops buyer/provider first)
#   SKIP_BUILD=1 deploy/deploy.sh     # reuse the images already on the VPS
# Touches only: /opt/silicr, /var/www/silicr, /etc/nginx/sites-available/silicr, compose project
# `silicr`, and certbot certs for the two silicr hostnames. Reloads nginx (never restarts) and only
# after `nginx -t` passes. Never copies mainnet wallets.
set -euo pipefail

HOST=${SILICR_VPS:-root@38.49.213.208}
LANDING_HOST=silicr.38-49-213-208.sslip.io
APP_HOST=app.silicr.38-49-213-208.sslip.io
REPO=$(cd "$(dirname "$0")/.." && pwd)
SSH=(ssh -o BatchMode=yes "$HOST")
COPY_WALLETS=0
[[ "${1:-}" == "--wallets" ]] && COPY_WALLETS=1

log() { printf '\n== %s\n' "$*"; }

log "preflight"
"${SSH[@]}" 'set -e
  mkdir -p /opt/silicr/src /opt/silicr/data/relay /var/www/silicr
  chmod 700 /opt/silicr/data
  if ! docker ps --filter label=com.docker.compose.project=silicr -q | grep -q .; then
    if ss -ltnH | awk "{print \$4}" | grep -Eq ":(870[0-4])$"; then echo "ports 8700-8704 are in use by something else" >&2; exit 1; fi
  fi'

log "sync repo -> $HOST:/opt/silicr/src"
rsync -az --delete \
  --exclude node_modules --exclude '.next*' --exclude target --exclude .silicr --exclude .git \
  --exclude 'apps/landing/out' --exclude '*.log' --exclude .DS_Store --exclude 'tsconfig.tsbuildinfo' \
  --exclude '**/wallets/' --exclude '*.seed' --exclude '.env*' \
  "$REPO/" "$HOST:/opt/silicr/src/"
"${SSH[@]}" 'cp /opt/silicr/src/deploy/dockerignore /opt/silicr/src/.dockerignore'

if [[ $COPY_WALLETS == 1 ]] || ! "${SSH[@]}" 'test -d /opt/silicr/data/wallets/test-buyer -a -d /opt/silicr/data/wallets/test-provider'; then
  log "copy the two testnet wallets (never main-*)"
  for w in test-buyer test-provider; do
    [[ $w == test-* ]] || { echo "refusing to copy $w" >&2; exit 1; }
    grep -q '"network": *"test"' "$REPO/.silicr/wallets/$w/config.json" || { echo "$w is not a testnet wallet" >&2; exit 1; }
  done
  "${SSH[@]}" 'set -e; cd /opt/silicr/src/deploy
    docker compose -p silicr -f compose.yml stop buyer provider 2>/dev/null || true
    install -d -m 700 /opt/silicr/data/wallets /opt/silicr/data/wallets/test-buyer /opt/silicr/data/wallets/test-provider'
  for w in test-buyer test-provider; do
    # Wallet and key files only: skip the lock, the sidecar log, local deal history
    # (*-state.json, rfqs/, results/, checkpoints/) and any other directory.
    files=()
    for f in "$REPO/.silicr/wallets/$w"/*; do
      [[ -f "$f" ]] || continue
      case "$(basename "$f")" in sidecar.lock|sidecar.log|*-state.json) ;; *) files+=("$f") ;; esac
    done
    scp -q -p "${files[@]}" "$HOST:/opt/silicr/data/wallets/$w/"
  done
  "${SSH[@]}" 'set -e; cd /opt/silicr/data/wallets
    chown -R 1000:1000 /opt/silicr/data/wallets
    find . -type d -exec chmod 700 {} +; find . -type f -exec chmod 600 {} +'
fi
"${SSH[@]}" 'chown -R 1000:1000 /opt/silicr/data/relay; chmod 700 /opt/silicr/data/relay'

if [[ -z "${SKIP_BUILD:-}" ]]; then
  log "build images (nice, classic builder)"
  "${SSH[@]}" "set -e; cd /opt/silicr/src; export DOCKER_BUILDKIT=0
    nice -n 15 docker build -q -f deploy/Dockerfile.sidecar -t silicr-sidecar:latest .
    nice -n 15 docker build -q -f deploy/Dockerfile.node --target landing -t silicr-landing:latest \
      --build-arg APP_ORIGIN=https://$APP_HOST --build-arg LANDING_ORIGIN=https://$LANDING_HOST .
    nice -n 15 docker build -q -f deploy/Dockerfile.node --target runtime -t silicr-node:latest \
      --build-arg APP_ORIGIN=https://$APP_HOST --build-arg LANDING_ORIGIN=https://$LANDING_HOST ."
fi

log "landing -> /var/www/silicr/landing"
"${SSH[@]}" 'set -e
  rm -rf /var/www/silicr/landing.new; cid=$(docker create silicr-landing:latest true)
  docker cp "$cid:/out" /var/www/silicr/landing.new; docker rm "$cid" >/dev/null
  test -f /var/www/silicr/landing.new/index.html
  chown -R root:root /var/www/silicr/landing.new; chmod -R a+rX /var/www/silicr/landing.new
  rm -rf /var/www/silicr/landing.old; [ -d /var/www/silicr/landing ] && mv /var/www/silicr/landing /var/www/silicr/landing.old
  mv /var/www/silicr/landing.new /var/www/silicr/landing; rm -rf /var/www/silicr/landing.old'

log "containers"
"${SSH[@]}" 'set -e; cd /opt/silicr/src/deploy
  if docker run --rm --entrypoint sh silicr-node:latest -c "\$TSX packages/cli/src/main.ts daemon --help" | grep -q -- "--public-demo" \
     && docker run --rm --entrypoint sh silicr-node:latest -c "\$TSX packages/cli/src/main.ts daemon --help" | grep -q -- "--trust-proxy" \
     && docker run --rm --entrypoint sh silicr-node:latest -c "\$TSX packages/cli/src/main.ts daemon --help" | grep -q -- "--public-origin"; then
    docker compose -p silicr -f compose.yml up -d --no-build --remove-orphans
  else
    echo "daemon flags --public-origin/--trust-proxy/--public-demo not in this build: starting relay + web only"
    docker compose -p silicr -f compose.yml up -d --no-build relay web
  fi'

log "nginx"
"${SSH[@]}" "set -e
  conf=/opt/silicr/src/deploy/nginx-silicr.conf
  site=/etc/nginx/sites-available/silicr
  cp \$site /opt/silicr/nginx-silicr.prev
  apply() { cp \"\$1\" \$site; if nginx -t 2>/dev/null; then systemctl reload nginx; else cp /opt/silicr/nginx-silicr.prev \$site; nginx -t; echo 'nginx -t failed; restored the previous silicr file' >&2; exit 1; fi; }
  if [ ! -f /etc/letsencrypt/live/$APP_HOST/fullchain.pem ]; then
    sed '/^# BEGIN app-tls/,/^# END app-tls/d' \$conf > /opt/silicr/nginx-silicr.bootstrap
    apply /opt/silicr/nginx-silicr.bootstrap
    certbot certonly --webroot -w /var/www/silicr -d $APP_HOST --non-interactive --agree-tos --register-unsafely-without-email
  fi
  apply \$conf"

log "status"
"${SSH[@]}" 'docker ps --filter label=com.docker.compose.project=silicr --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"'
for u in "https://$LANDING_HOST/" "https://$APP_HOST/" "https://$APP_HOST/relay/health"; do
  printf '%s %s\n' "$(curl -s -o /dev/null -m 20 -w '%{http_code}' "$u")" "$u"
done
