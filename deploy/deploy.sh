#!/usr/bin/env bash
# Deploy the Silicr hosted demos to the VPS. Idempotent; run from anywhere:
#   deploy/deploy.sh                  # TESTNET project `silicr` + landing page: sync, build, start, nginx, certs
#   deploy/deploy.sh --wallets        # also (re)copy the two TESTNET wallets (stops buyer/provider first)
#   deploy/deploy.sh --main           # MAINNET demo project `silicr-main` (real ZEC, tiny capped wallet): build silicr-node:main, start, nginx
#   deploy/deploy.sh --main --wallets # also (re)copy the two mainnet DEMO wallets (demo-main-buyer, demo-main-provider)
#   SKIP_BUILD=1 deploy/deploy.sh     # reuse the images already on the VPS
# Touches only: /opt/silicr, /opt/silicr-main, /var/www/silicr, /etc/nginx/sites-available/silicr, the compose
# projects `silicr` and `silicr-main`, and certbot certs for the silicr hostnames. Reloads nginx (never
# restarts) and only after `nginx -t` passes. Copies exactly the wallets named below, never main-buyer or
# main-provider, never a testnet wallet into the mainnet project.
set -euo pipefail

HOST=${SILICR_VPS:-root@38.49.213.208}
VPS_IP=38.49.213.208
LANDING_HOST=silicr.xyz
APP_HOST=app.silicr.xyz
MAIN_HOST=mainnet.silicr.xyz
XYZ_HOSTS="$LANDING_HOST www.$LANDING_HOST $APP_HOST $MAIN_HOST"
# The old names stay as aliases (their own certs, issued earlier).
SSLIP_LANDING_HOST=silicr.38-49-213-208.sslip.io
SSLIP_APP_HOST=app.silicr.38-49-213-208.sslip.io
REPO=$(cd "$(dirname "$0")/.." && pwd)
SSH=(ssh -o BatchMode=yes "$HOST")
COPY_WALLETS=0
MAIN=0
for a in "$@"; do
  case "$a" in
    --wallets) COPY_WALLETS=1 ;;
    --main) MAIN=1 ;;
    *) echo "unknown flag $a" >&2; exit 1 ;;
  esac
done

log() { printf '\n== %s\n' "$*"; }

# Wallet and key files only: skip the lock, the sidecar log, local deal history (*-state.json, rfqs/,
# results/, checkpoints/) and any other directory.
copy_wallet() { # <local name> <remote dir>
  local w=$1 dest=$2 files=() f
  for f in "$REPO/.silicr/wallets/$w"/*; do
    [[ -f "$f" ]] || continue
    case "$(basename "$f")" in sidecar.lock|sidecar.log|*-state.json) ;; *) files+=("$f") ;; esac
  done
  scp -q -p "${files[@]}" "$HOST:$dest/"
}

if [[ $MAIN == 0 ]]; then
  # ======================================================================= TESTNET + landing
  log "preflight (testnet)"
  "${SSH[@]}" 'set -e
    mkdir -p /opt/silicr/src /opt/silicr/data/relay /var/www/silicr
    chmod 700 /opt/silicr/data
    if ! docker ps --filter label=com.docker.compose.project=silicr -q | grep -q .; then
      if ss -ltnH | awk "{print \$4}" | grep -Eq ":(870[0-4])$"; then echo "ports 8700-8704 are in use by something else" >&2; exit 1; fi
    fi'

  log "sync repo -> $HOST:/opt/silicr/src"
  rsync -az --delete \
    --exclude node_modules --exclude '.next*' --exclude target --exclude .silicr --exclude .git \
    --exclude 'apps/landing/out' --exclude video --exclude '*.log' --exclude .DS_Store --exclude 'tsconfig.tsbuildinfo' \
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
    for w in test-buyer test-provider; do copy_wallet "$w" "/opt/silicr/data/wallets/$w"; done
    "${SSH[@]}" 'set -e; cd /opt/silicr/data/wallets
      chown -R 1000:1000 /opt/silicr/data/wallets
      find . -type d -exec chmod 700 {} +; find . -type f -exec chmod 600 {} +'
  fi
  "${SSH[@]}" 'chown -R 1000:1000 /opt/silicr/data/relay; chmod 700 /opt/silicr/data/relay'

  if [[ -z "${SKIP_BUILD:-}" ]]; then
    log "build images (nice, classic builder): sidecar, landing, silicr-node:latest (origins $APP_HOST / $LANDING_HOST)"
    "${SSH[@]}" "set -e; cd /opt/silicr/src; export DOCKER_BUILDKIT=0
      nice -n 15 docker build -q -f deploy/Dockerfile.sidecar -t silicr-sidecar:latest .
      nice -n 15 docker build -q -f deploy/Dockerfile.node --target landing -t silicr-landing:latest \
        --build-arg APP_ORIGIN=https://$APP_HOST --build-arg LANDING_ORIGIN=https://$LANDING_HOST --build-arg MAINNET_ORIGIN=https://$MAIN_HOST .
      nice -n 15 docker build -q -f deploy/Dockerfile.node --target runtime -t silicr-node:latest \
        --build-arg APP_ORIGIN=https://$APP_HOST --build-arg LANDING_ORIGIN=https://$LANDING_HOST --build-arg MAINNET_ORIGIN=https://$MAIN_HOST ."
  fi

  log "landing -> /var/www/silicr/landing"
  "${SSH[@]}" 'set -e
    rm -rf /var/www/silicr/landing.new; cid=$(docker create silicr-landing:latest true)
    docker cp "$cid:/out" /var/www/silicr/landing.new; docker rm "$cid" >/dev/null
    test -f /var/www/silicr/landing.new/index.html
    chown -R root:root /var/www/silicr/landing.new; chmod -R a+rX /var/www/silicr/landing.new
    rm -rf /var/www/silicr/landing.old; [ -d /var/www/silicr/landing ] && mv /var/www/silicr/landing /var/www/silicr/landing.old
    mv /var/www/silicr/landing.new /var/www/silicr/landing; rm -rf /var/www/silicr/landing.old'

  log "containers (project silicr)"
  "${SSH[@]}" 'set -e; cd /opt/silicr/src/deploy
    help=$(docker run --rm --entrypoint sh silicr-node:latest -c "\$TSX packages/cli/src/main.ts daemon --help")
    if echo "$help" | grep -q -- "--public-demo" && echo "$help" | grep -q -- "--trust-proxy" && echo "$help" | grep -q -- "--public-origin"; then
      docker compose -p silicr -f compose.yml up -d --no-build --remove-orphans
    else
      echo "daemon flags --public-origin/--trust-proxy/--public-demo not in this build: starting relay + web only"
      docker compose -p silicr -f compose.yml up -d --no-build relay web
    fi'
else
  # ======================================================================= MAINNET demo
  log "preflight (mainnet demo)"
  "${SSH[@]}" 'set -e
    mkdir -p /opt/silicr/src /opt/silicr-main/data/relay
    chmod 700 /opt/silicr-main/data
    if ! docker ps --filter label=com.docker.compose.project=silicr-main -q | grep -q .; then
      if ss -ltnH | awk "{print \$4}" | grep -Eq ":(871[0-3])$"; then echo "ports 8710-8713 are in use by something else" >&2; exit 1; fi
    fi'

  log "sync repo -> $HOST:/opt/silicr/src"
  rsync -az --delete \
    --exclude node_modules --exclude '.next*' --exclude target --exclude .silicr --exclude .git \
    --exclude 'apps/landing/out' --exclude video --exclude '*.log' --exclude .DS_Store --exclude 'tsconfig.tsbuildinfo' \
    --exclude '**/wallets/' --exclude '*.seed' --exclude '.env*' \
    "$REPO/" "$HOST:/opt/silicr/src/"
  "${SSH[@]}" 'cp /opt/silicr/src/deploy/dockerignore /opt/silicr/src/.dockerignore'

  if [[ $COPY_WALLETS == 1 ]] || ! "${SSH[@]}" 'test -d /opt/silicr-main/data/wallets/demo-main-buyer -a -d /opt/silicr-main/data/wallets/demo-main-provider'; then
    log "copy the two mainnet DEMO wallets (demo-main-buyer, demo-main-provider; never main-buyer/main-provider, never testnet)"
    for w in demo-main-buyer demo-main-provider; do
      [[ $w == demo-main-* ]] || { echo "refusing to copy $w" >&2; exit 1; }
      [[ -f "$REPO/.silicr/wallets/$w/config.json" ]] || { echo "$w: no .silicr/wallets/$w/config.json (create it with silicr init --network main --cap-per-request 0.001 --cap-total 0.005 --data .silicr/wallets/$w)" >&2; exit 1; }
      grep -q '"network": *"main"' "$REPO/.silicr/wallets/$w/config.json" || { echo "$w is not a mainnet wallet" >&2; exit 1; }
    done
    "${SSH[@]}" 'set -e; cd /opt/silicr/src/deploy
      docker compose -p silicr-main -f compose.main.yml stop buyer provider 2>/dev/null || true
      install -d -m 700 /opt/silicr-main/data/wallets /opt/silicr-main/data/wallets/demo-main-buyer /opt/silicr-main/data/wallets/demo-main-provider'
    for w in demo-main-buyer demo-main-provider; do copy_wallet "$w" "/opt/silicr-main/data/wallets/$w"; done
    "${SSH[@]}" 'set -e; cd /opt/silicr-main/data/wallets
      chown -R 1000:1000 /opt/silicr-main/data/wallets
      find . -type d -exec chmod 700 {} +; find . -type f -exec chmod 600 {} +'
  fi
  "${SSH[@]}" 'chown -R 1000:1000 /opt/silicr-main/data/relay; chmod 700 /opt/silicr-main/data/relay'

  if [[ -z "${SKIP_BUILD:-}" ]]; then
    log "build silicr-node:main (nice, classic builder; web origin $MAIN_HOST)"
    "${SSH[@]}" "set -e; cd /opt/silicr/src; export DOCKER_BUILDKIT=0
      docker image inspect silicr-sidecar:latest >/dev/null 2>&1 || nice -n 15 docker build -q -f deploy/Dockerfile.sidecar -t silicr-sidecar:latest .
      nice -n 15 docker build -q -f deploy/Dockerfile.node --target runtime -t silicr-node:main \
        --build-arg APP_ORIGIN=https://$MAIN_HOST --build-arg LANDING_ORIGIN=https://$LANDING_HOST --build-arg MAINNET_ORIGIN=https://$MAIN_HOST ."
  fi

  log "containers (project silicr-main)"
  "${SSH[@]}" 'set -e; cd /opt/silicr/src/deploy
    help=$(docker run --rm --entrypoint sh silicr-node:main -c "\$TSX packages/cli/src/main.ts daemon --help")
    if echo "$help" | grep -q -- "--allow-mainnet" && echo "$help" | grep -q -- "--public-demo"; then
      docker compose -p silicr-main -f compose.main.yml up -d --no-build --remove-orphans
    else
      echo "daemon flag --allow-mainnet not in this build: starting relay + web only"
      docker compose -p silicr-main -f compose.main.yml up -d --no-build relay web
    fi'
fi

log "nginx"
# The xyz-tls blocks need /etc/letsencrypt/live/silicr.xyz; the app-tls block needs the sslip app cert.
# Missing certs: install the file without those blocks, try certbot (xyz only once DNS points here), then the full file.
"${SSH[@]}" "set -e
  conf=/opt/silicr/src/deploy/nginx-silicr.conf
  site=/etc/nginx/sites-available/silicr
  cp \$site /opt/silicr/nginx-silicr.prev
  apply() { cp \"\$1\" \$site; if nginx -t 2>/dev/null; then systemctl reload nginx; else cp /opt/silicr/nginx-silicr.prev \$site; nginx -t; echo 'nginx -t failed; restored the previous silicr file' >&2; exit 1; fi; }
  strip() { sed \"/^# BEGIN \$1/,/^# END \$1/d\"; }
  have_xyz=0; have_app=0
  [ -f /etc/letsencrypt/live/$LANDING_HOST/fullchain.pem ] && have_xyz=1
  [ -f /etc/letsencrypt/live/$SSLIP_APP_HOST/fullchain.pem ] && have_app=1
  if [ \$have_xyz = 0 ] || [ \$have_app = 0 ]; then
    cp \$conf /opt/silicr/nginx-silicr.bootstrap
    [ \$have_xyz = 1 ] || strip xyz-tls < \$conf > /opt/silicr/nginx-silicr.bootstrap
    [ \$have_app = 1 ] || { strip app-tls < /opt/silicr/nginx-silicr.bootstrap > /opt/silicr/nginx-silicr.bootstrap2; mv /opt/silicr/nginx-silicr.bootstrap2 /opt/silicr/nginx-silicr.bootstrap; }
    apply /opt/silicr/nginx-silicr.bootstrap
    if [ \$have_app = 0 ]; then
      certbot certonly --webroot -w /var/www/silicr -d $SSLIP_APP_HOST --non-interactive --agree-tos --register-unsafely-without-email && have_app=1
    fi
    if [ \$have_xyz = 0 ]; then
      dns_ok=1
      for h in $XYZ_HOSTS; do [ \"\$(dig +short \$h @8.8.8.8 | tail -1)\" = \"$VPS_IP\" ] || dns_ok=0; done
      if [ \$dns_ok = 1 ]; then
        certbot certonly --webroot -w /var/www/silicr $(for h in $XYZ_HOSTS; do printf -- '-d %s ' "$h"; done) --non-interactive --agree-tos --register-unsafely-without-email && have_xyz=1
      else
        echo 'DNS for the silicr.xyz names does not point here yet: HTTPS for them is pending; rerun deploy.sh once it does' >&2
      fi
    fi
  fi
  if [ \$have_xyz = 1 ] && [ \$have_app = 1 ]; then apply \$conf
  elif [ \$have_xyz = 1 ]; then strip app-tls < \$conf > /opt/silicr/nginx-silicr.bootstrap; apply /opt/silicr/nginx-silicr.bootstrap
  fi"

log "status"
if [[ $MAIN == 0 ]]; then
  "${SSH[@]}" 'docker ps --filter label=com.docker.compose.project=silicr --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"'
  urls=("https://$LANDING_HOST/" "https://$APP_HOST/" "https://$APP_HOST/provider" "https://$APP_HOST/api/relay/health" "https://$APP_HOST/api/buyer/api/status" "https://$APP_HOST/api/provider/api/status" "https://$SSLIP_LANDING_HOST/" "https://$SSLIP_APP_HOST/api/buyer/api/status")
else
  "${SSH[@]}" 'docker ps --filter label=com.docker.compose.project=silicr-main --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"'
  urls=("https://$MAIN_HOST/" "https://$MAIN_HOST/provider" "https://$MAIN_HOST/api/relay/health" "https://$MAIN_HOST/api/buyer/api/status" "https://$MAIN_HOST/api/provider/api/status")
fi
for u in "${urls[@]}"; do
  printf '%s %s\n' "$(curl -s -o /dev/null -m 20 -w '%{http_code}' "$u")" "$u"
done
