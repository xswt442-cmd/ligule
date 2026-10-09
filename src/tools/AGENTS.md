# Tools

Rules for `src/tools/`: the three read-only tools, the four write tools, the first-party optional tools and what they share. The repository-wide rules in [../../AGENTS.md](../../AGENTS.md) apply here too; this file states what only this directory has to keep.

## Optional first-party tools

`fetch` is a first-party optional tool: the registry holds it, `minimal` hides it, `full` offers it (D48).

- It issues GET over http(s), times out at 15 seconds and reads at most 64 KB. It sends no cookie, no custom header and no credential this machine already holds.
- The target is judged by the address it resolves to, and that address is classified from its bytes. `::ffff:127.0.0.1` and `::ffff:7f00:1` are one loopback, and `::`, `0.0.0.0` and multicast land in a reserved class.
- Link-local, metadata endpoints and reserved addresses are refused. Loopback and private ranges must be asked at least once. Public ones follow the normal order (D58).
- Resolution happens once and the socket binds to the approved address. The hostname stays in the `Host` header, the TLS SNI and certificate verification.
- Every redirect is rebuilt, re-resolved, re-classified and re-judged. Only a same-origin hop continues, and a changed host or port raises `fetch_redirect_denied`.

`exec` runs under the backend the host chose (D59).

- `exec.shell` takes `auto`, `bash` or `powershell`. `auto` on Windows tries `pwsh`, then the built-in `powershell`, then Git Bash. On POSIX it tries `/bin/bash`, then `bash` on `PATH`, then `sh`.
- Probing starts no process: known locations are stat-ed and bare names are searched directory by directory. A named backend this machine lacks raises `exec_shell_unavailable` and lists what was searched; the other grammar is never substituted.
- The kernel resolves the backend once per call and hands the same object to the chain and the tool. The record carries `{kind, executable, segments}`.
- PowerShell auto-approval covers a literal command with literal arguments only (D66). `|`, sub-expressions, script blocks, splatting, the invocation operator, redirects, comments, reserved declaration forms, non-ASCII or `$`/backtick-bearing arguments and any parse error all fall back to asking.
- Two Windows PowerShell 5.1 facts shape this: `-Command` returns 1 for any failing native command while the real code stays in `$LASTEXITCODE`, and a failing cmdlet leaves `$LASTEXITCODE` alone. Appending `; exit $LASTEXITCODE` unconditionally therefore reads a cmdlet failure as the previous native command's code.
- The kernel appends that tail only when the chain read the whole line as one simple command whose name is an executable on `PATH` or a known location. `withNativeExitCode` decides, and the record carries the tail. A path with no chain gets none: the missing code is preferred over the masked failure.
- Quoted arguments passed to a native command lose `<` and `>`, so the exec tests run a temporary script file rather than `node -e`.

`subagent` is a first-party plugin tool, not a kernel concept (D61, D71).

- The derived agent runs a second loop in this process with its own kernel and its own record. The decision chain is the parent's instance, so a child can never sit at a looser level than the run that spawned it.
- Only one level exists. The child's assembly is the parent's plugin list, which has no `subagent` in it. Its record is `<parent id>.sub-<n>.jsonl` beside the parent's.
- Model-visible parameters are `task` and an optional `mode`. A name no layer holds fails with `mode_unknown`, and a run with no mode directories fails with `subagent_mode_paths_required`.
- The parent receives the child's text, its session id and the record path. One child at a time; the concurrency field is untouched (D29).
- The tool registers only when a session is built, so `ligule tools` counts nine. A branch is read with the existing action (D74).

