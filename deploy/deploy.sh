#!/usr/bin/env bash
# Deploys the current checkout to the demo server (Node 24 lives in /opt/floorwalker/node; nothing system-wide changes
# except one nginx site and one systemd unit). Usage: [DEPLOY_KEY=~/.ssh/key] deploy/deploy.sh [user@host]
set -euo pipefail
HOST=${1:-ubuntu@43.160.214.187}
NODE=v24.21.0
DOMAIN=floorwalker.43-160-214-187.sslip.io
SSH=(ssh ${DEPLOY_KEY:+-i "$DEPLOY_KEY"})
cd "$(dirname "$0")/.."
npm run build
rsync -e "${SSH[*]}" -az --delete --exclude node_modules --exclude .git --exclude data --exclude .env --exclude 'film/work' --exclude 'film/out' --exclude 'film/music' --exclude 'film/.venv' --exclude notes --exclude PLAN.md --exclude COMPETITOR_ANALYSIS.md --exclude REDESIGN_PLAN.md \
  ./ "$HOST:/tmp/floorwalker-src/"
scp -q ${DEPLOY_KEY:+-i "$DEPLOY_KEY"} .env "$HOST:/tmp/floorwalker.env"
"${SSH[@]}" "$HOST" NODE=$NODE DOMAIN=$DOMAIN 'bash -s' <<'REMOTE'
set -euo pipefail
id floorwalker >/dev/null 2>&1 || sudo useradd --system --home /opt/floorwalker --shell /usr/sbin/nologin floorwalker
sudo mkdir -p /opt/floorwalker/app
# One-time move from the product's old name: stop the old service and bring its data along.
if [ -d /opt/allowance/app/data ] && [ ! -d /opt/floorwalker/app/data ]; then
  sudo systemctl disable --now allowance || true
  sudo cp -a /opt/allowance/app/data /opt/floorwalker/app/data
  sudo rm -f /etc/systemd/system/allowance.service /etc/nginx/sites-enabled/allowance
fi
sudo mkdir -p /opt/floorwalker/app/data
if [ ! -x /opt/floorwalker/node/bin/node ] || [ "$(/opt/floorwalker/node/bin/node -v)" != "$NODE" ]; then
  curl -fsSL "https://nodejs.org/dist/$NODE/node-$NODE-linux-x64.tar.xz" -o /tmp/node.tar.xz
  sudo rm -rf /opt/floorwalker/node && sudo mkdir -p /opt/floorwalker/node
  sudo tar -xJf /tmp/node.tar.xz -C /opt/floorwalker/node --strip-components=1
fi
sudo rsync -a --delete --exclude data --exclude node_modules /tmp/floorwalker-src/ /opt/floorwalker/app/
sudo install -m 600 -o floorwalker -g floorwalker /tmp/floorwalker.env /opt/floorwalker/app/.env && rm -f /tmp/floorwalker.env
sudo chown -R floorwalker:floorwalker /opt/floorwalker
cd /opt/floorwalker/app && sudo -u floorwalker env PATH=/opt/floorwalker/node/bin:/usr/bin:/bin npm ci --no-audit --no-fund --loglevel=error
sudo install -m 644 deploy/floorwalker.service /etc/systemd/system/floorwalker.service
if [ ! -e /etc/nginx/sites-enabled/floorwalker ]; then
  sudo install -m 644 deploy/nginx.conf /etc/nginx/sites-available/floorwalker
  sudo ln -s /etc/nginx/sites-available/floorwalker /etc/nginx/sites-enabled/floorwalker
  sudo nginx -t && sudo systemctl reload nginx
  sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect
fi
if sudo test -e /etc/letsencrypt/live/allowance.43-160-214-187.sslip.io/fullchain.pem && [ ! -e /etc/nginx/sites-enabled/allowance-redirect ]; then
  sudo install -m 644 deploy/nginx-old-name.conf /etc/nginx/sites-available/allowance-redirect
  sudo ln -s /etc/nginx/sites-available/allowance-redirect /etc/nginx/sites-enabled/allowance-redirect
fi
sudo nginx -t && sudo systemctl reload nginx
sudo systemctl daemon-reload && sudo systemctl enable --now floorwalker && sudo systemctl restart floorwalker
sleep 6 && curl -fsS -o /dev/null -w "local %{http_code}\n" http://127.0.0.1:18810/v1/openapi.json
REMOTE
echo "https://$DOMAIN"
