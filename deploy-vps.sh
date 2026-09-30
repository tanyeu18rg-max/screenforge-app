#!/bin/bash
# ScreenForge VPS deploy script — safe to run alongside existing apps.
# Does NOT touch other services, ports, or configs. Only adds ScreenForge.
set -e

APP_DIR="/opt/screenforge"
APP_PORT="${SCREENFORGE_PORT:-8902}"
APP_USER="screenforge"

echo "=== ScreenForge deploy ==="
echo "App dir: $APP_DIR | Port: $APP_PORT"

# 1. Node.js 20+ (skip if already present)
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "--- Installing Node.js 20 ---"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  echo "--- Node $(node --version) already present, skipping ---"
fi

# 2. Check port is free (do not steal another app's port)
if ss -tln 2>/dev/null | grep -q ":$APP_PORT "; then
  echo "ERROR: port $APP_PORT is already in use. Set SCREENFORGE_PORT to a free port and re-run."
  exit 1
fi
echo "--- Port $APP_PORT is free ---"

# 3. Dedicated system user (no root runtime)
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd -r -m -d "$APP_DIR" -s /usr/sbin/nologin "$APP_USER"
  echo "--- Created user $APP_USER ---"
fi

# 4. Code: either a git checkout (with .git) or an extracted tarball.
#    For tarball installs, the operator extracts to $APP_DIR before running.
if [ ! -d "$APP_DIR/server" ]; then
  if [ -d "$APP_DIR/.git" ]; then
    echo "ERROR: $APP_DIR is a git repo but server/ is missing — corrupt checkout?"
    exit 1
  elif [ -n "$REPO_URL" ]; then
    echo "--- Cloning $REPO_URL ---"
    git clone --branch "${REPO_BRANCH:-rebrand/screenforge}" "$REPO_URL" "$APP_DIR"
  else
    echo "ERROR: $APP_DIR/server not found."
    echo "Extract the release tarball to $APP_DIR first, or set REPO_URL."
    exit 1
  fi
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# 5. Dependencies (as app user)
echo "--- Installing dependencies ---"
sudo -u "$APP_USER" bash -c "cd '$APP_DIR/server' && npm ci --omit=dev 2>/dev/null || npm install --omit=dev"

# 6. Data dir (persistent, outside the repo)
DATA_DIR="/var/lib/screenforge"
mkdir -p "$DATA_DIR"
chown -R "$APP_USER:$APP_USER" "$DATA_DIR"

# 7. systemd service (only manages screenforge, nothing else)
echo "--- Installing systemd service ---"
cat > /etc/systemd/system/screenforge.service <<EOF
[Unit]
Description=ScreenForge digital signage CMS
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR/server
Environment=NODE_ENV=production
Environment=SELF_HOSTED=true
Environment=DATA_DIR=$DATA_DIR
Environment=PORT=$APP_PORT
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now screenforge
sleep 3
systemctl is-active --quiet screenforge && echo "--- Service is running ---" || {
  echo "ERROR: service failed to start. Logs:"; journalctl -u screenforge -n 30 --no-pager; exit 1;
}

# 8. Firewall: open the app port (ufw only, no other rules touched)
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "$APP_PORT/tcp" >/dev/null && echo "--- Opened port $APP_PORT in ufw ---"
fi

echo ""
echo "=== DONE ==="
echo "ScreenForge is live at: http://$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}'):$APP_PORT"
echo "Sign up the FIRST account in the web UI — it automatically becomes the admin."
echo "Service: systemctl [status|restart|stop] screenforge | Logs: journalctl -u screenforge -f"
