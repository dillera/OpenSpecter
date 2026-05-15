#!/usr/bin/env bash
# deploy.sh — pull latest code, build, and restart the open-specter service.
# Run as root from anywhere on the host.
set -euo pipefail

REPO_URL="https://github.com/dillera/OpenSpecter.git"
APP_DIR="/root/apps/open-spector"
BACKEND_DIR="${APP_DIR}/backend"
SERVICE_NAME="open-specter"
BRANCH="main"

log()  { echo "[deploy] $*"; }
die()  { echo "[deploy] ERROR: $*" >&2; exit 1; }

# ── 1. Update or clone repo ────────────────────────────────────────────────────
if [[ -d "${APP_DIR}/.git" ]]; then
    log "Fetching latest ${BRANCH} from origin..."
    git -C "${APP_DIR}" fetch --quiet origin
    git -C "${APP_DIR}" reset --hard "origin/${BRANCH}"
    git -C "${APP_DIR}" clean -fd --quiet
else
    log "Cloning repository into ${APP_DIR}..."
    mkdir -p "$(dirname "${APP_DIR}")"
    git clone --branch "${BRANCH}" --single-branch "${REPO_URL}" "${APP_DIR}"
fi

# ── 2. Check .env ──────────────────────────────────────────────────────────────
if [[ ! -f "${BACKEND_DIR}/.env" ]]; then
    die ".env not found at ${BACKEND_DIR}/.env — copy .env.example and fill in values, then re-run."
fi

# ── 3. Install dependencies ────────────────────────────────────────────────────
log "Installing dependencies..."
npm --prefix "${BACKEND_DIR}" ci --omit=dev --silent

# ── 4. Build ───────────────────────────────────────────────────────────────────
log "Building..."
npm --prefix "${BACKEND_DIR}" run build

# ── 5. Restart service ─────────────────────────────────────────────────────────
if systemctl is-active --quiet "${SERVICE_NAME}"; then
    log "Restarting ${SERVICE_NAME}..."
    systemctl restart "${SERVICE_NAME}"
elif systemctl is-enabled --quiet "${SERVICE_NAME}" 2>/dev/null; then
    log "Starting ${SERVICE_NAME}..."
    systemctl start "${SERVICE_NAME}"
else
    die "Service '${SERVICE_NAME}' is not registered. Run setup.sh first."
fi

systemctl --no-pager status "${SERVICE_NAME}"
log "Deploy complete."
