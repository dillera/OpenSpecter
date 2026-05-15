#!/usr/bin/env bash
# deploy.sh — build and restart the open-specter service.
# Run as root from the repo root on the host: bash deploy/deploy.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BACKEND_DIR="${REPO_DIR}/backend"
SERVICE_NAME="open-specter"

log()  { echo "[deploy] $*"; }
die()  { echo "[deploy] ERROR: $*" >&2; exit 1; }

# ── 1. Verify we're in the repo ───────────────────────────────────────────────
[[ -d "${REPO_DIR}/.git" ]] || die "No .git found at ${REPO_DIR} — run this script from within the cloned repo."
[[ -d "${BACKEND_DIR}/src" ]] || die "backend/src not found — is ${REPO_DIR} the right repo root?"

# ── 2. Check .env ─────────────────────────────────────────────────────────────
if [[ ! -f "${BACKEND_DIR}/.env" ]]; then
    die ".env not found at ${BACKEND_DIR}/.env — copy backend/.env.example, fill in values, then re-run."
fi

# ── 3. Install dependencies ───────────────────────────────────────────────────
log "Installing dependencies..."
npm --prefix "${BACKEND_DIR}" ci --omit=dev --silent

# ── 4. Build ──────────────────────────────────────────────────────────────────
log "Building..."
npm --prefix "${BACKEND_DIR}" run build

# ── 5. Restart service ────────────────────────────────────────────────────────
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
