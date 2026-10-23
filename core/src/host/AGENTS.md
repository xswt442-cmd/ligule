# Host

The repository [Agent guide](../../../AGENTS.md) applies here. The Host owns client protocol dispatch, project environments, open sessions, and Markdown export. See the [architecture guide](../../../docs/development/ARCHITECTURE.en.md) for the shared runtime flow.

## Project and session ownership

- `protocol.js` is the authority for method names and parameter schemas. When changing a method, update dispatch, clients, and protocol tests together. Keep business validation at the Host or domain module even when the schema accepts the shape.
- A project environment is keyed by normalized `projectRoot` and owns its configuration, provider, policy, modes, extensions, MCP servers, and session directory. `boundary` separately limits file tools. Never use one project's environment to continue a session belonging to another project.
- A session owns its record lock, kernel assembly, active turn, approvals, and questions. Keep requests, cancellation, events, and results scoped to that session. Opening an already open session is read-only; `session.close` releases its ownership after any running turn is cancelled.
- Use the session ID only after validating it as a record identifier. A missing record must remain a `session_not_found` error; opening it must not create an empty replacement.
- Record reads and listings do not write. Only the recovery path may repair unresolved dispatched calls, and it must record an unknown outcome rather than replaying the tool.

## Configuration and credentials

- `config.get` constructs its response from the public field allowlist. Never return the merged configuration object or a secret value.
- Read values, sources, and versions from the same layer snapshot. Config writes accept only supported fields and writable layers, compare the supplied version, preserve unrelated TOML bytes, and report whether a higher layer shadows the saved value.
- Recompute a provider from the effective configuration after a model-service write. Model changes apply at the session's turn boundary; approval policy changes apply to the next decision.
- Credentials are read at request time. A non-empty environment variable takes precedence; otherwise use the system credential store. On Linux require persistent Secret Service. Never write secret values to config, records, preferences, exports, or logs.

## Protocol behavior

- Session listing, search, record paging, export, config, preferences, and workspace operations belong in Host methods. Clients do not access session files or project configuration directly.
- Approval requests and structured question requests are distinct protocol interactions with separate IDs. Answers are accepted once by the originating session; reconnect or session close invalidates stale requests.
- `prefs.read` and `prefs.write` operate on the data-root document. Writes carry the version read by the client and fail on a conflict; do not silently merge stale drafts or queues.
- Export reads the complete record, including available spill files, and returns one outcome per output file. A subtask collision must not overwrite an existing file or hide other per-file results.

## Verification

From `core/`, run `npm test` for the Core module suite. From the repository root, run `pnpm test` to include the Host dispatch integration tests in `tests/host.test.js` and `tests/host-bootstrap.test.js`. Verify protocol behavior through the real Host dispatch path, not only with a mock dispatcher.
