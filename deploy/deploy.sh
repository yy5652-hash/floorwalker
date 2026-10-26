#!/usr/bin/env bash
# Deploys the current checkout to the demo server (Node 24 lives in /opt/allowance/node; nothing system-wide changes
# except one nginx site and one systemd unit). Usage: deploy/deploy.sh [user@host]
set -euo pipefail
HOST=${1:-ubuntu@43.160.214.187}
NODE=v24.21.0
cd "$(dirname "$0")/.."
npm run build
rsync -az --delete --exclude node_modules --exclude .git --exclude data --exclude .env --exclude 'film/work' --exclude 'film/out' --exclude 'film/.venv' --exclude notes --exclude PLAN.md \
  ./ "$HOST:/tmp/allowance-src/"
scp -q .env "$HOST:/tmp/allowance.env"
ssh "$HOST" NODE=$NODE 'bash -s' <<'REMOTE'
set -euo pipefail
id allowance >/dev/null 2>&1 || sudo useradd --system --home /opt/allowance --shell /usr/sbin/nologin allowance
sudo mkdir -p /opt/allowance/app/data
if [ ! -x /opt/allowance/node/bin/node ] || [ "$(/opt/allowance/node/bin/node -v)" != "$NODE" ]; then
  curl -fsSL "https://nodejs.org/dist/$NODE/node-$NODE-linux-x64.tar.xz" -o /tmp/node.tar.xz
  sudo rm -rf /opt/allowance/node && sudo mkdir -p /opt/allowance/node
  sudo tar -xJf /tmp/node.tar.xz -C /opt/allowance/node --strip-components=1
fi
sudo rsync -a --delete --exclude data --exclude node_modules /tmp/allowance-src/ /opt/allowance/app/
sudo install -m 600 -o allowance -g allowance /tmp/allowance.env /opt/allowance/app/.env && rm -f /tmp/allowance.env
sudo chown -R allowance:allowance /opt/allowance
cd /opt/allowance/app && sudo -u allowance env PATH=/opt/allowance/node/bin:/usr/bin:/bin npm ci --no-audit --no-fund --loglevel=error
sudo install -m 644 deploy/allowance.service /etc/systemd/system/allowance.service
if [ ! -e /etc/nginx/sites-enabled/allowance ]; then
  sudo install -m 644 deploy/nginx.conf /etc/nginx/sites-available/allowance
  sudo ln -s /etc/nginx/sites-available/allowance /etc/nginx/sites-enabled/allowance
  sudo nginx -t && sudo systemctl reload nginx
  sudo certbot --nginx -d allowance.43-160-214-187.sslip.io --non-interactive --agree-tos --register-unsafely-without-email --redirect
fi
sudo systemctl daemon-reload && sudo systemctl enable --now allowance && sudo systemctl restart allowance
sleep 6 && curl -fsS -o /dev/null -w "local %{http_code}\n" http://127.0.0.1:18810/v1/openapi.json
REMOTE
echo "https://allowance.43-160-214-187.sslip.io"
