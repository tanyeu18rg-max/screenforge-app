# Sentry setup (optional error tracking)

Kardinal Screens ships with Sentry **wired but inert**: `server/lib/sentry.js`
is a strict no-op unless `SENTRY_DSN` is set. No events leave the box without
the operator's explicit opt-in — self-hosters own their telemetry.

## What it captures

- Uncaught exceptions and unhandled rejections (via the SDK's default
  integrations), with the release tag `kardinal-screens@<VERSION>`.
- PII is off (`sendDefaultPii: false`); a `beforeSend` hook redacts anything
  shaped like a key/secret/token/password from event payloads.

## Setup (~10 minutes, needs the owner's Sentry account)

1. Create a project at https://sentry.io (platform: Node.js), copy its DSN.
2. On the VPS, add to the service environment (systemd unit
   `Environment=` line, or `/etc/kardinal-screens.env` if the unit uses
   `EnvironmentFile=`):
   ```
   SENTRY_DSN=https://<key>@<host>/<project>
   SENTRY_ENVIRONMENT=production   # optional; defaults to NODE_ENV or "production"
   ```
3. `systemctl restart kardinal-screens` and trigger a test event
   (Sentry dashboard → the project accepts its first event).

## Verify

With `SENTRY_DSN` set, the boot log shows the SDK initialising; without it,
boot is byte-for-byte identical to before (the SDK is never even required).
