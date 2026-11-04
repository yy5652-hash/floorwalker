#!/usr/bin/env bash
# Deploys the current checkout as a second, separate instance (own directory, data, port and domain) so a new
# version can be checked before it replaces the live one. The live service, its data and its nginx site are untouched.
# Usage: [DEPLOY_KEY=~/.ssh/key] deploy/preview.sh [user@host]
set -euo pipefail
HOST=${1:-ubuntu@43.160.214.187}
DOMAIN=${PREVIEW_DOMAIN:?set PREVIEW_DOMAIN to a name that points at the server (the main instance owns floorwalker.yingzhilu.cn)}
PORT=${PREVIEW_PORT:-18811}
SSH=(ssh ${DEPLOY_KEY:+-i "$DEPLOY_KEY"})
cd "$(dirname "$0")/.."
npm run build
rsync -e "${SSH[*]}" -az --delete --exclude node_modules --exclude .git --exclude data --exclude .env --exclude 'film/work' --exclude 'film/out' --exclude 'film/music' --exclude 'film/.venv' --exclude notes --exclude PLAN.md --exclude COMPETITOR_ANALYSIS.md --exclude REDESIGN_PLAN.md --exclude LAUNCH_PLAN.md --exclude dns-backup \
  ./ "$HOST:/tmp/floorwalker-next-src/"
scp -q ${DEPLOY_KEY:+-i "$DEPLOY_KEY"} .env "$HOST:/tmp/floorwalker-next.env"
"${SSH[@]}" "$HOST" DOMAIN=$DOMAIN PORT=$PORT 'bash -s' <<'REMOTE'
set -euo pipefail
test -x /opt/floorwalker/node/bin/node
sudo mkdir -p /opt/floorwalker-next/app/data
sudo rsync -a --delete --exclude data --exclude node_modules /tmp/floorwalker-next-src/ /opt/floorwalker-next/app/
sudo install -m 600 -o floorwalker -g floorwalker /tmp/floorwalker-next.env /opt/floorwalker-next/app/.env && rm -f /tmp/floorwalker-next.env
sudo chown -R floorwalker:floorwalker /opt/floorwalker-next
cd /opt/floorwalker-next/app && sudo -u floorwalker env PATH=/opt/floorwalker/node/bin:/usr/bin:/bin npm ci --no-audit --no-fund --loglevel=error
sed -e "s#/opt/floorwalker/app#/opt/floorwalker-next/app#g" -e "s#PORT=18810#PORT=$PORT#" -e "s#FLOORWALKER_BASE_URL=.*#FLOORWALKER_BASE_URL=https://$DOMAIN#" \
  -e "s#^Description=.*#Description=Floorwalker preview ($DOMAIN)#" deploy/floorwalker.service | sudo tee /etc/systemd/system/floorwalker-next.service >/dev/null
if [ ! -e /etc/nginx/sites-enabled/floorwalker-next ]; then
  sed -e "s#server_name .*;#server_name $DOMAIN;#" -e "s#127.0.0.1:18810#127.0.0.1:$PORT#" deploy/nginx.conf | sudo tee /etc/nginx/sites-available/floorwalker-next >/dev/null
  sudo ln -s /etc/nginx/sites-available/floorwalker-next /etc/nginx/sites-enabled/floorwalker-next
  sudo nginx -t && sudo systemctl reload nginx
  sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect
fi
sudo nginx -t && sudo systemctl reload nginx
sudo systemctl daemon-reload && sudo systemctl enable --now floorwalker-next && sudo systemctl restart floorwalker-next
sleep 6 && curl -fsS -o /dev/null -w "preview local %{http_code}\n" http://127.0.0.1:$PORT/healthz
curl -fsS -o /dev/null -w "live local %{http_code}\n" http://127.0.0.1:18810/v1/openapi.json
REMOTE
echo "https://$DOMAIN"
