# ADR-001: Rebrand ScreenTinker → Kardinal Screens

Date: 2026-10-01
Status: Accepted (shipped on the `rebrand/screenforge` branch, unreleased)

## Context

The product began as a fork of ScreenTinker (MIT, v2.3.0) first reskinned as
"ScreenForge". The owner decided the product needs its own brand rather than
a name one letter off upstream's: **Kardinal Screens**, with the cardinal-red
(#d92038) identity shared across the Kardinal product family.

## Decision

- Product name, marketing site, UI chrome and copy say "Kardinal Screens".
- The `screentinker-*` **wire identifiers are preserved** (API paths, socket
  event names, player protocol strings). Renaming the wire protocol would
  brick every deployed player that hasn't updated; the brand is skin, the
  protocol is contract.
- Visual rules (standing): white/light surfaces by default, cardinal red
  #d92038 accents, no neon, no glow, no gradients, no glassmorphism.

## Consequences

- Existing players, BrightSign packages and mobile apps keep working with no
  update required.
- Upstream merges stay feasible: the rebrand is a layer of renames on top of
  upstream files, not a rewrite. Conflicts on rebrand-touched files are
  expected and mechanical.
- Marketing/SEO pages were rewritten (fresh copy); the old
  `cloud-digital-signage.html` page was removed.
