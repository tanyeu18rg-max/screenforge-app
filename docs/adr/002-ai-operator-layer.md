# ADR-002: Kardinal AI operator (chat + Brain)

Date: 2026-10-01
Status: Accepted (shipped on the `rebrand/screenforge` branch, unreleased)

## Context

Operators run display networks from the dashboard; the most common tasks
("which screens are offline?", "put this media on the lobby playlist") are
mechanical lookups and edits. An AI chat drawer with tool-calling removes
that friction, but a model with database access is a liability unless the
authorization boundary is airtight.

## Decision

- **The model never touches the database.** It only receives tool schemas
  (`server/lib/ai-tools.js`); every call runs through `executeTool`, which
  scopes rows to the caller's workspace and refuses mutations when
  `canMutate` is false. The tool list itself is filtered: a viewer never even
  sees the mutating tools.
- **Mutations are audit-logged** (`logActivity`) like any other operator
  action — agent actions must be attributable.
- **Brain is keyword retrieval, not vectors** (`getBrainContext` in
  `server/lib/ai-agent.js`): workspace-scoped facts matched by keyword
  overlap. Deliberately dependency-free — no vector DB, no embeddings
  endpoint, nothing for a self-hoster to configure or pay for. It is less
  clever than embeddings and fails in obvious, debuggable ways.
- **BYO model endpoint** (OpenAI-compatible, cloud or self-hosted),
  configured per workspace in AI settings. The existing `endpointAllowed`
  SSRF guard in `routes/ai` vets the configured URL before any request.
- Tool-loop bounds: max 6 iterations, 90s total, 60s per request, 20-message
  history window. Errors return `{error, status}` rather than throwing.

## Consequences

- A compromised or hallucinating model can at worst act as the *current
  user* within *their own workspace* — the same blast radius as the user
  clicking the buttons themselves.
- No new infrastructure for self-hosters; AI is inert until the operator
  configures an endpoint.
- 16 unit tests (`server/test/ai-agent.test.js`) pin the scoping behavior;
  the tenant-isolation tests are the ones that must never be weakened.
