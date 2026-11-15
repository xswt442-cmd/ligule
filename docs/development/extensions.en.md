# Host extensions

Ligule extensions are trusted Node.js modules loaded by the Host from paths declared in user configuration or from the user's extension directory. They run in the Host process; they are not an operating-system sandbox. Core remains private to the repository and is not a separately published SDK.

## Enable an extension

Add its absolute path to the top-level `extensions` array in the user `config.toml`:

```toml
extensions = [
  "/absolute/path/to/project-audit.mjs",
  "/absolute/path/to/project-context.mjs",
]
```

The Host loads configured extensions when opening a Session that uses `full-access` Permission and `unrestricted` network. A Permission change does not hot-load or remove extensions from an open Session; close and reopen the Session after raising those settings. Existing Policy, tool preflight, approvals, sandbox selection and Session recording still apply. An extension cannot raise Permission or override a denial. Treat each configured module as executable trusted code.

## Request tools through the Kernel

An extension can register a composite tool and call other tools through `host.request` while that tool is running. Every nested call gets its own Kernel validation, Permission and Policy decision, cancellation signal, and Session event. The outer tool's access level does not grant access to nested tools.

[`core/examples/extensions/project-audit.mjs`](../../core/examples/extensions/project-audit.mjs) reads a file, searches it, and runs the fixed command `node --version`. Its declared `exec` access means callers need the corresponding Permission; the nested `exec` still goes through normal approval and execution checks. The example bounds each returned excerpt.

`host.request` requires an active Run. Setup functions, event callbacks and timers do not inherit a Run and cannot use this capability. Request-preparation and completion Hooks expose read-only Kernel tools. Before-tool and after-tool Hooks cannot make nested requests.

## Add request context and check completion

[`core/examples/extensions/project-context.mjs`](../../core/examples/extensions/project-context.mjs) demonstrates two Hook stages:

- `prepareRequest` reads a short README excerpt through the Kernel and adds it to the current Provider request. The text is not written into the user's Session input.
- `completeRun` checks the current completion candidate and reads `verification.txt` through the Kernel. Its first demo candidate returns `continue`; the Host sends the bounded reason in the next request and spends the same Run budget. Later candidates are accepted only when the file contains `PASS`.

`accept` means that the Hook's own condition passed; it is not an independent Verifier result. A `continue` decision does not reset the iteration or model-call budget. It invalidates a previous structured submission, which must be submitted and checked again. Hook output is bounded by the configured prompt-fragment limit. A `fail` reason is validated and capped at 512 UTF-8 bytes; the Session and durable Run result retain the stable error code. Hook errors or `fail` decisions prevent successful completion; a later Hook cannot override them.

The completion context includes the current Run, Session event range, candidate ID and, when present, a digest of the structured result. Keep these fields with any external check result. Do not store raw prompts, credentials or full tool results in extension diagnostics.

## Compatibility and lifecycle

`onEvent` remains observation-only. Hooks run in registration order and are owned by the extension that registered them. A Hook request is cancelled with its Run and bounded by the existing request deadline. Host shutdown waits for asynchronous disposers; it cannot force-stop arbitrary trusted JavaScript.

Use the real Host APIs for embedded and stdio/MCP integrations. The Core extension contract does not add a second protocol, tool registry, Session store, global lock or public Core package. The examples use portable project-relative file names and do not perform direct filesystem operations to simulate tool results.

## Verify changes

Core extension and embedded Host regressions run with:

```sh
node --experimental-strip-types --test core/tests/extensions.test.ts core/tests/subagent.test.ts
```

The stdio/MCP integration uses the real CLI process and SDK transport:

```sh
node --experimental-strip-types --test --import ./tests/hooks/isolated-data-root.ts tests/mcp-server.test.ts
```

Use `pnpm test` for the full repository suite.
