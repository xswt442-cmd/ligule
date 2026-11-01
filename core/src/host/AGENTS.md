# Host

The [repository guide](../../../AGENTS.md) applies. Host owns protocol dispatch, project environments, permissions, open sessions, and export; see [architecture](../../../docs/development/ARCHITECTURE.en.md).

- `protocol.ts` defines method and parameter contracts. Update dispatch, clients, and real Host tests together. Protocol validation does not replace domain checks.
- Resolve a project by normalized `projectRoot`; keep project ownership distinct from tool `boundary`. A Session owns its lock, active turn, approvals, and questions. Validate IDs before file access, never create missing records on open, and keep already-open Sessions read-only for other owners.
- Reads, search, and listing must not mutate records. Only locked recovery may resolve incomplete tool calls, recording an unknown outcome without replaying execution.
- Derive caller identity and Run permissions from trusted transport and persisted acceptance. Request fields such as `origin` or `requestKey` cannot grant capabilities. Enforce Grant scope, permission ceilings, revocation, and project ownership at each sensitive entry point.
- Expose configuration through a public allowlist; writes require a matching version, preserve unrelated TOML, and report shadowed values. Rebuild model providers from effective config; apply model changes at turn boundaries.
- Resolve credentials at request time (nonempty environment first, then OS keyring); require persistent Secret Service on Linux. Never serialize secrets to records, exports, or logs.
- Bind approval and question responses to their original request and Session; reject stale replies. Preference updates use version checks. Export complete records and spill content with per-file outcomes, without overwriting collisions.

Verify with Core Host tests and real dispatch/integration tests under `tests/`. Run `pnpm test` for complete regression.
