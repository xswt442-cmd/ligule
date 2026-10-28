# Harbor adapter

This adapter targets Harbor `0.25.0` and installs the exact Ligule npm tarball supplied through `ligule_tarball`. It subclasses Harbor's `BaseInstalledAgent`, declares `capabilities.atif = true`, and runs `ligule run --json` inside the task environment. It never reads verifier files or writes task files on the Agent's behalf.

The Node helper is copied into the installed `ligule` package directory after npm installation, never into `/logs/agent` or an unrelated working directory. Installation probes both Core subpath exports from that exact package root and fails if they cannot be resolved. The helper then imports `@ligule/core/session/atif.js`, reads only the trial's explicit `LIGULE_HOME/sessions/<sessionId>.jsonl`, resolves the actual `runId` to its Session user event, restores validated spill files from that same session directory, and writes `trajectory.json` under Harbor's agent log directory. The exported trajectory is redacted by default. `--include-sensitive-content` is available only to direct local helper invocation; the adapter never enables it.

The Session directory is an explicit child of a fresh per-run `LIGULE_HOME`. Each CLI run explicitly sets `policy.mode=auto`. This lets policy-approved direct file operations and statically safe commands run without a human terminal; commands requiring manual approval and hard-denied operations still fail closed. The adapter never synthesizes a human approval. The Ligule CLI receives only the selected API key, `LIGULE_HOME`, required runtime paths, proxy settings, and `NODE_EXTRA_CA_CERTS`; other Harbor agent environment values are not inherited. Harbor's separately configured task verifier remains the source of pass/fail scores.

## Adapter inputs

- `ligule_tarball`: absolute path to a built `ligule` npm tarball. The adapter verifies its package name, package version, and SHA-256 before upload, then verifies the uploaded bytes inside the task environment.
- `ligule_api`: `messages` or `chat-completions`.
- `ligule_base_url`: configured Provider endpoint.
- `ligule_model`: optional override; defaults to Harbor's selected `--model` value.
- `ligule_api_key_env`: environment variable name, default `LIGULE_API_KEY`. Provide its value through Harbor's agent environment/secret mechanism.
- `ligule_model_calls`, `ligule_timeout_ms`, `ligule_request_timeout_ms`: bounded request and execution limits.

The target task image must provide Node.js 24 or newer and npm. A missing or older runtime fails setup with an explicit error. Provider configuration, permissions, task network access, resource limits, and verifier configuration still need to be selected in the Harbor job configuration for the intended benchmark.

## Offline checks

Build Core before running the Node test:

```sh
pnpm --filter @ligule/core run build
uv run --no-project --with harbor==0.25.0 python -m unittest discover -s evals/harbor -p 'test_*.py'
node --test --test-concurrency=1 evals/harbor/export_session.test.mjs
```

The tests inspect a fixture npm tarball, the Harbor `0.25.0` class contract, non-root install ownership, CLI result filtering and environment allowlisting, process timeout termination, and a real Session written by Core's `createSessionLog`. The Node test creates a clean temporary npm-style package layout with the actual built Core manifest and `dist` under `ligule/node_modules/@ligule/core`; it verifies package-subpath import, spill restoration, privacy defaults, terminal-state agreement, and rejection of a missing spill file. The adapter's post-install import probe runs at the same package root after npm has installed the supplied tarball. Neither the offline fixture nor that unexecuted runtime probe substitutes for a clean install of the current Ligule tarball. No Docker is started, no model is invoked, no benchmark task is run, and no verifier result is claimed.

To validate the JSON emitted by the Node test with Harbor's official validator, set `LIGULE_ATIF_OUTPUT_PATH` to a temporary file outside the repository before running that test, then run:

```sh
uv run --no-project --with harbor==0.25.0 python -m harbor.utils.trajectory_validator <temporary-file>
```

Do not use a hand-written trajectory as evidence that the exporter passes validation.
