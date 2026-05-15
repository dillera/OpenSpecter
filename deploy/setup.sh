#!/usr/bin/env bash
# setup.sh — one-time host setup: systemd service + nginx location block.
# Run as root. Safe to re-run (idempotent).
set -euo pipefail

APP_DIR="/root/apps/open-spector"
BACKEND_DIR="${APP_DIR}/backend"
SERVICE_NAME="open-specter"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
NGINX_CONF="/etc/nginx/sites-enabled/apps.diller.org"
# Marker used to detect whether our block is already present
NGINX_MARKER="# open-specter location block"

log()  { echo "[setup] $*"; }
die()  { echo "[setup] ERROR: $*" >&2; exit 1; }

[[ "${EUID}" -eq 0 ]] || die "This script must be run as root."

# ── 1. Verify node / npm are available ────────────────────────────────────────
command -v node >/dev/null 2>&1 || die "node not found — install Node.js 20+ before running setup."
command -v npm  >/dev/null 2>&1 || die "npm not found — install Node.js 20+ before running setup."

# ── 2. Create app directory ────────────────────────────────────────────────────
mkdir -p "${APP_DIR}"
log "App directory: ${APP_DIR}"

# ── 3. Create systemd service ──────────────────────────────────────────────────
if [[ -f "${SERVICE_FILE}" ]]; then
    log "systemd service already exists at ${SERVICE_FILE} — skipping creation."
else
    log "Creating systemd service ${SERVICE_FILE}..."
    cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=Open Specter backend (Express / SQLite)
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${BACKEND_DIR}
EnvironmentFile=${BACKEND_DIR}/.env
ExecStart=/usr/bin/node ${BACKEND_DIR}/dist/index.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable "${SERVICE_NAME}"
    log "Service enabled. Start it with: systemctl start ${SERVICE_NAME}"
fi

# ── 4. Patch nginx config ──────────────────────────────────────────────────────
[[ -f "${NGINX_CONF}" ]] || die "Nginx config not found: ${NGINX_CONF}"

if grep -qF "${NGINX_MARKER}" "${NGINX_CONF}"; then
    log "Nginx location block already present in ${NGINX_CONF} — skipping."
else
    log "Inserting /specter location block into ${NGINX_CONF}..."

    # Build the block we want to insert
    LOCATION_BLOCK=$(cat <<'NGINX'
    # open-specter location block — managed by setup.sh, do not edit this comment
    location /specter/ {
        proxy_pass         http://127.0.0.1:3001/;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_set_header   Upgrade           $http_upgrade;
        proxy_set_header   Connection        "upgrade";
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        client_max_body_size 50m;
    }
NGINX
)

    # Insert before the last closing brace of the first server{} block.
    # Uses Python for reliable multi-line insertion — available on all modern Linux.
    python3 - "${NGINX_CONF}" <<PYEOF
import sys, re

path = sys.argv[1]
text = open(path).read()

block = """
${LOCATION_BLOCK}
"""

# Find the last } in the file and insert our block before it.
idx = text.rfind("}")
if idx == -1:
    print("Could not find closing brace in nginx config", file=sys.stderr)
    sys.exit(1)

patched = text[:idx] + block + "\n" + text[idx:]
open(path, "w").write(patched)
print("Nginx config patched.")
PYEOF

    # Validate and reload nginx
    nginx -t || die "Nginx config test failed — inspect ${NGINX_CONF} and fix manually."
    systemctl reload nginx
    log "Nginx reloaded with /specter location block."
fi

# ── 5. Summary ─────────────────────────────────────────────────────────────────
log ""
log "Setup complete. Next steps:"
log "  1. Clone / pull the repo:          run deploy.sh (it will clone for you)"
log "  2. Create the env file:            cp ${BACKEND_DIR}/.env.example ${BACKEND_DIR}/.env && \$EDITOR ${BACKEND_DIR}/.env"
log "  3. Deploy and start the service:   bash $(dirname "$0")/deploy.sh"
log "  4. Check service logs:             journalctl -u ${SERVICE_NAME} -f"
