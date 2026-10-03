'use strict';

// Optional error tracking for Kardinal Screens.
//
// Self-hosted operators own their telemetry: this module is a strict no-op
// unless SENTRY_DSN is set in the process environment, in which case it
// initialises @sentry/node as early as possible (server.js calls init()
// right after the dependency preflight, before express loads).
//
// What we deliberately do NOT do:
// - No tracesSampleRate: this is a signage server, not a latency-sensitive
//   API; we want crash reports, not performance traces.
// - sendDefaultPii stays false: request bodies may contain media metadata,
//   playlist names and user emails, and none of that leaves the box.
// - No DSN, no SDK load: require('@sentry/node') only happens inside init(),
//   so installs without the dependency (or without the env var) boot exactly
//   as before.
let started = false;

function init() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn || started) return started;
  const Sentry = require('@sentry/node');
  let release = 'kardinal-screens@unknown';
  try {
    release = 'kardinal-screens@' + require('../version');
  } catch {
    /* version file missing in a dev checkout; release stays unknown */
  }
  Sentry.init({
    dsn,
    release,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'production',
    sendDefaultPii: false,
    // Scrub anything that looks like a credential before it leaves the box.
    // The SDK already redacts common header names; this covers values that
    // end up in extra/context objects.
    beforeSend(event) {
      const scrub = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        for (const k of Object.keys(obj)) {
          if (/api[_-]?key|secret|token|password|passwd|authorization/i.test(k)) obj[k] = '[redacted]';
          else if (typeof obj[k] === 'object') scrub(obj[k]);
        }
      };
      scrub(event.extra);
      scrub(event.contexts);
      return event;
    },
  });
  started = true;
  return true;
}

function isEnabled() {
  return started;
}

module.exports = { init, isEnabled };
