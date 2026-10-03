# ADR-003: Self-host on the owner's VPS (not Vercel)

Date: 2026-10-01
Status: Accepted

## Context

Kardinal Screens is a stateful Node.js server: Express + Socket.io,
better-sqlite3/node:sqlite on local disk, file uploads, background jobs.
The Kardinal Signage SaaS runs serverless on Vercel, which raised the
question of hosting Screens there too.

## Decision

Host Kardinal Screens on the owner's VPS (`deploy-vps.sh`: isolated systemd
service), **not** on Vercel.

## Rationale

- Vercel's serverless functions have no persistent disk (SQLite would lose
  data), no long-lived websockets (player protocol depends on them), and
  request-timeout limits that don't fit media uploads. The app's architecture
  and the platform's constraints are fundamentally mismatched.
- The systemd unit isolates the service (own user, own `DATA_DIR`) so it
  cannot interfere with other apps on the same VPS.

## Consequences

- Deploys are `git pull` + `systemctl restart` on the VPS (see
  `deploy-vps.sh`), not `git push` auto-deploys.
- Backups are the operator's responsibility: the SQLite database and uploads
  live under `DATA_DIR` — back that directory up, and test the restore.
- The marketing site (static) may live on Vercel; the app server may not.
