# Deployment Guide

This directory contains two scripts for deploying the Open Specter backend on a Linux host.

| Script | Purpose | When to run |
|--------|---------|-------------|
| `setup.sh` | One-time host configuration | First deploy only (safe to re-run) |
| `deploy.sh` | Pull, build, and restart | Every deploy |

## Prerequisites

- Linux host with **Node.js 20+** and **npm** installed
- **nginx** running with a server block in `/etc/nginx/sites-enabled/apps.diller.org`
- **systemd** as the init system
- Scripts must be run as **root**

## First-Time Setup

### 1. Run setup.sh

```bash
bash /path/to/deploy/setup.sh
```

This script:
- Creates the app directory at `/root/apps/open-spector`
- Creates `/etc/systemd/system/open-specter.service` and enables it
- Inserts a `location /specter/` proxy block into the nginx config
- Validates the nginx config (`nginx -t`) and reloads nginx

The service is enabled at boot but **not started** until you complete the next two steps.

### 2. Create the .env file

The deploy script will refuse to run without a `.env` file. After the first `git clone` (or after running `deploy.sh` once and letting it fail on the missing-env check), copy the example and fill in your values:

```bash
cp /root/apps/open-spector/open-specter-main/backend/.env.example \
   /root/apps/open-spector/open-specter-main/backend/.env

nano /root/apps/open-spector/open-specter-main/backend/.env
```

Required values:

```
PORT=3001
FRONTEND_URL=https://apps.diller.org
DATABASE_PATH=./data/openspecter.db

# Supabase — used only for JWT validation, not data storage
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SECRET_KEY=your-supabase-service-role-key

# Cloud storage (Cloudflare R2)
R2_ENDPOINT_URL=https://your-account-id.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=your-r2-access-key
R2_SECRET_ACCESS_KEY=your-r2-secret-key
R2_BUCKET_NAME=open-specter

# AI provider keys
GEMINI_API_KEY=your-gemini-key
ANTHROPIC_API_KEY=your-anthropic-key
OPENROUTER_API_KEY=your-openrouter-key
RESEND_API_KEY=your-resend-key
```

### 3. Run deploy.sh

```bash
bash /path/to/deploy/deploy.sh
```

This clones the repo, installs dependencies, builds, and starts the service.

---

## Subsequent Deploys

```bash
bash /path/to/deploy/deploy.sh
```

That's it. The script pulls the latest `main` branch, rebuilds, and restarts the service.

---

## What deploy.sh does

1. If `/root/apps/open-spector/.git` exists: `git fetch` + `git reset --hard origin/main` + `git clean -fd`
2. If not: `git clone` the repo from `https://github.com/dillera/OpenSpecter.git`
3. Aborts if `.env` is missing
4. `npm ci --omit=dev` — clean install, no dev dependencies
5. `npm run build` — compiles TypeScript to `dist/`
6. `systemctl restart open-specter`

---

## Nginx

`setup.sh` inserts this block into the existing server config at `/etc/nginx/sites-enabled/apps.diller.org`:

```nginx
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
```

The app is then accessible at `http://apps.diller.org/specter/`.

The block is inserted once and detected by a marker comment — re-running `setup.sh` will not duplicate it.

---

## systemd Service

The service file written to `/etc/systemd/system/open-specter.service`:

- Runs `node dist/index.js` from the backend directory
- Sources the `.env` file via `EnvironmentFile`
- Restarts automatically on failure with a 5-second delay
- Logs to the systemd journal

Useful commands:

```bash
# View live logs
journalctl -u open-specter -f

# Check status
systemctl status open-specter

# Manual start / stop / restart
systemctl start open-specter
systemctl stop open-specter
systemctl restart open-specter
```

---

## SQLite database

The SQLite database is created automatically on first startup at the path set by `DATABASE_PATH` in `.env` (default: `./data/openspecter.db` relative to the backend directory, i.e. `/root/apps/open-spector/open-specter-main/backend/data/openspecter.db`).

Drizzle migrations run automatically at startup — no manual migration step is needed.

Back up the database by copying that file while the service is stopped, or use SQLite's online backup:

```bash
sqlite3 /root/apps/open-spector/open-specter-main/backend/data/openspecter.db \
  ".backup /root/backups/openspecter-$(date +%Y%m%d).db"
```
