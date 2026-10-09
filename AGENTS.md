# Agent guide

`ligule` is an agent harness under development. The 0.0.x line is a placeholder: the repository, the package name and the licence are claimed; the behaviour is not settled.

Design records, decisions (D) and open questions (U) live outside this repository and are not linked from here. This file states the rules a change inside this repository has to keep.

## Layout

```
src/kernel/      tool table, decision chain, loop, prompt assembly, slot registry,
                 assembly list, mode loader, result shapes, config, log, error codes
src/capability/  path boundaries, probing, command parsing and execution, search and
                 trash backends, network target classes, instruction loading, limits
src/tools/       the three read-only tools, the four write tools, the first-party
                 optional tools, what they share, the minimal list
src/session/     the record, its format, repair, listing, checkpoint, compaction
src/model/       the two wire shapes and their HTTP layer
src/host/        the client protocol, the line carrier, the session owner
src/tui/         the terminal client
modes/           the shipped assembly lists: minimal, full
desktop/         the Tauri shell and its Vite frontend (outside package.json#files)
scripts/         build and packaging helpers
test/            checks against dist/
```

- Dependencies point toward `kernel/`, never away from it.
- `test/architecture.test.js` scans those directories instead of a hand-written list, so a new file is covered without anyone adding it.
- Platform-specific code belongs in `capability/` (D18).

## Commands

```sh
npm ci              dependencies from the lockfile
npm run build       tsc → dist/
npm test            builds, then runs the suites against dist/
npm run check-pack  packs, unpacks, imports the package from an empty consumer
npm run build-rg    downloads the pinned ripgrep into packages/rg-*
```

## Invariants

- The kernel ships no tools (I1). An adapter adds one by registering it.
- The assembly list the model sees is the one the run loaded (I2).
- The decision chain is monotone: no later step relaxes an earlier refusal, and no declaration grants a pass (I3, I4).
- The session record is the only source of truth (I5). Derived files — listings, checkpoints — are rebuilt from it or discarded.
- Injected content is capped by bytes; over the cap the full text goes to a file and the record keeps a reference (I6).
- All interface content mounts through the slot registry; the host never names a plugin (I7, D25).
- Model-visible fields are name, description and parameter schema only (D12).
- Cancellation is one token shared by the tool, the provider and the loop (D20).
- Every failure carries a stable code (`KernelError#code`). `KernelError` is a tool that did not finish, and the loop continues with that result. `KernelRuntimeError` is the kernel itself failing, and the loop stops.
- An error without a code becomes `tool_failed`, and the original goes into `cause`. The code serves the host, `detail` serves the model, and the CLI prints both.
- Every dispatched call gets an answer in the record, including one the loop chose not to run (`tool_skipped`). A missing answer invalidates every later request body.

## Build and files

- `dist/` is what runs: `bin`, `exports` and `files` point there, and the tests import it, so a green run exercised the shipped bytes.
- `tsc` runs with `allowJs` and `checkJs: false`. New modules are TypeScript under `strict`, with erasable syntax only — no `enum`, no `namespace`, no parameter properties (D47). Older JavaScript files are copied through and convert layer by layer.
- `src/` is not runnable as it stands: a `.ts` module has no `.js` twin.
- `package.json#version` and `src/index.js#VERSION` stay equal; `test/kernel.test.js` asserts it.
- The Node floor is one number written in three kinds of place: `engines.node`, the badge in `README.md`, `PRIMARY_NODE_VERSION` in each workflow. `test/runtime-version.test.js` reads all of them and asserts they agree.


## Subdirectory guides

- `src/kernel/AGENTS.md`: modes, skills, prompt templates, extensions, parameter schemas, MCP and model providers.
- `src/tools/AGENTS.md`: the tools, what they share, and the first-party optional ones.
- `src/session/AGENTS.md`: the record, its format, repair, listing, checkpoint and compaction.
- `src/host/AGENTS.md`: the protocol, the session owner, reading a record and the export serializer.
- `src/tui/AGENTS.md` and `desktop/AGENTS.md`: the terminal and desktop rules (D33, D34); `## Clients` holds what those two share.
- One of these enters a run only when the working directory is inside the directory it governs: the loader walks from the project root down to the working directory (`src/capability/instructions.js`). The rules above hold from any directory.

## Clients

- `src/tui/AGENTS.md` holds the rules of the terminal client (D33) and `desktop/AGENTS.md` the rules of the desktop surface (D34); this section holds only what the two share.
- A round the person interrupted reads 这一轮已被打断 whichever code the kernel answered with: an abort landing on a live model call reports `provider_cancelled`, between two call groups `loop_cancelled`.
- Both surfaces describe an approval from the same three fields read off the arguments — the action, the block to remove, the block to put in — and mark the last two with `-` and `+` (`describeChange` in `src/tui/commands.ts`, `changeOf` and `changeBody` in `desktop/frontend/src/rows.ts`).
- A draft, a queued sentence, a fold and a key binding are interface state on either surface and reach no record (D81).

## Configuration

- Configuration arrives in layers: `~/.ligule/config.toml`, `<project root>/.ligule/config.toml`, `<project root>/.ligule/config.local.toml`, then `--config key.path=value`. The layers fold into one frozen snapshot (D8).
- Only plain tables merge recursively; arrays and scalars replace whole. A TOML datetime is a class instance, and a higher layer replaces it for that reason.
- The project layer can come from someone else's repository, which is why a `__proto__` key in any layer is refused (`config_key_unsafe`).
- Credentials never come from files. Every key in a config layer is readable by tools, so a key comes from the environment instead (`LIGULE_API_KEY`, renamed by `model.apiKeyEnv`).
- Tools read the snapshot the kernel passes them and log through the injected interface (`debug` and `log` required, `error` optional). Nothing under `src/` writes to an output sink directly, and a host that injects no logger gets no output.
- Sections the layers can set: `model` (`api`, `baseURL`, `model`, `apiKeyEnv`, `capabilities`, `retry`), `mode`, `policy` (`mode`, `rules`, `thresholds`), `loop` (`iterations`, `modelCalls`), `limits` (`readBytes`, `resultBytes`, `resultCount`, `scanBytes`, `scanFiles`, `execBytes`, `trashDirectory`, `skillSearchBytes`, `skillBodyBytes`, `skillFileBytes`, `fetchBytes`, `fetchTimeoutMs`, `fetchRedirects`, `promptFragmentBytes`, `contextTokens`, `compactThresholdRatio`, `compactRetainRatio`), `exec.shell`, `prompt` (`static`; when no layer writes it the shipped base prompt in `src/kernel/base-prompt.ts` supplies the static segment — D102), `instructions`, `mcp.servers`, `extensions`, `host.sessionDirectory`.
- `contextTokens` has no default and gates compaction (D75).

## Dependencies and search

- Runtime and optional dependencies are listed in `package.json`. `cross-spawn` launches external editors, `proper-lockfile` protects session writes across processes (D85), and `koffi` calls the Windows Job Object API (D87).
- Optional `marked` and `highlight.js` provide terminal Markdown rendering and code highlighting (D84), and `string-width` supports terminal display width.
- `tree-sitter`, `tree-sitter-bash` and `tree-sitter-pwsh` are native addons. All three ship prebuilds for six platform and architecture combinations, which is why no compiler runs, and npm blocking their install script does not matter.
- The bash grammar loads lazily through `createRequire`. The PowerShell one is an ESM graph with a top-level await, so `require` refuses it and only a dynamic `import` works; its `main` names a directory without an extension, and it loads from `bindings/node/index.js`.
- A parser that cannot load leaves the chain asking every time and says so in the reason. `scripts/check-pack.js` parses one command line with each grammar through the installed package, because a missing addon would otherwise look like a machine that asks a lot.
- `packages/rg-*` hold no committed binaries. `npm run build-rg` downloads the ripgrep version pinned in `scripts/ripgrep-pin.json`, checks size and sha256, and writes the executable plus licence texts there.
- An unpublished name cannot enter the lockfile, and `npm ci` refuses a `package.json` the lockfile does not cover, which is why the two entries stay out of `optionalDependencies` until publish. Until then search walks the tree and the two comparison tests skip.
- `ci.yml` runs `npm run build-rg` before `npm test`, so both platforms compare the real backend with our own walk. Nothing resolves `rg` from `PATH`: a bare `ripgrepPath` resolves as a relative path and fails.

## Release

- Bump `package.json` and `VERSION` together, then tag `vX.Y.Z` on `main`. The tag drives the publish workflow, which runs `npm run build-rg` and publishes the two ripgrep platform packages before the main one.
- The first publish cannot use npm Trusted Publishing, because npm requires the package to exist before a trusted publisher binds to it. Publish `0.0.1` with a token, configure the publisher, then let the workflow take over.
- The account has 2FA, so a direct `npm publish` asks a one-time password; run it interactively or pass `--otp`. Tokens that bypass 2FA are being restricted for direct publishing, so do not reach for one. OIDC publishing is not affected by 2FA.
- `npm ci` installs from the lockfile in both workflows.

## Verify

- `npm run check-pack` packs, unpacks, checks every entry `package.json` points at, then imports the package from an empty consumer directory. It copies the transitive closure of `dependencies` and installed optional dependencies from that closure, including native platform packages, while leaving unrelated root optional dependencies out, and it refuses when a declared runtime dependency is missing. Copying all of `node_modules` would hide a tarball short at runtime.
- It refuses before packing when `dist/` is missing. Build first.
- `npm test` exercises the same `dist/`, so it cannot see a file missing from `files` or an `exports` entry the tarball lacks. Invoke the script through npm: on Windows Node refuses to launch `npm.cmd` without a shell, and the script needs `npm_execpath` for that reason.
- The first devDependency, `@modelcontextprotocol/server-filesystem`, is the test MCP server and stays out of the consumer.
- `npm test` reports `skipped 2` when no ripgrep has been built locally; those two compare the real backend with our own tree walk and cannot be faked.
- Real endpoint checks read credentials from the process environment and inspect the persisted record. Credentials are never written into repository files.
- The shell's checks sit outside `npm test`. `cd desktop/src-tauri && cargo test` covers finding the backend entry and moving frames through the child's pipes; window verification uses the actual shell and host, and frontend build checks run TypeScript and Vite.
- The terminal interaction checks use the actual Host, provider adapter, local HTTP endpoint and Ink keyboard handling. Fixtures are repository files under `test/fixtures`, pure projections are checked separately, and `ligule tui` runs the same component in a terminal.
- The desktop frontend is checked by `npm --prefix desktop/frontend run check`: three Node assertions over the projection, the frame client and the key layer, plus `tsc --noEmit` and a Vite build. It runs against the fake host in `desktop/frontend/dev/`, which speaks the frame shapes of `src/host/protocol.js` and waits for a real interface reply before an approval proceeds.
