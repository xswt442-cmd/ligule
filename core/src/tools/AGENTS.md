# Tools

The repository [Agent guide](../../../AGENTS.md) applies here. This directory contains model-callable tool contracts and their implementations. Platform and filesystem primitives live under [`core/src/capability/`](../capability/); every tool call still enters through the kernel.

## Filesystem tools

- Resolve every path against the Host-provided working directory and enforce the configured tool boundary. Do not replace path validation with a string-prefix check or follow a link outside the boundary.
- `write` requires a complete prior read and rejects a stale observed version. `edit` requires a non-empty anchor that occurs exactly once. Preserve these checks when changing write behavior.
- `delete` moves its target to the configured system or managed trash. Never replace it with in-place deletion or silently switch a pinned trash backend.
- File and result limits come from the configuration snapshot. Truncated tool results must say how to continue; incomplete search results must be identified as incomplete.

## Network and process tools

- Reject link-local, metadata, and reserved network targets; private or loopback targets require approval. Re-resolve and re-judge each redirect, and permit only same-origin redirects.
- `exec` uses the exact shell backend selected by configuration. Do not substitute a different command grammar when the selected executable is unavailable. Automatic approval is limited to command forms the parser proves safe; parse errors and unsupported syntax require approval.
- Cancellation must terminate the process tree: POSIX uses a process group and Windows uses a Job Object guardian. Do not rely on terminating only the shell parent.

## Optional tools and interaction

- `fetch`, MCP, skills, subagents, and `ask_user_question` are registered through plugins and may be narrowed by a mode according to their disclosure rules. Adding a tool requires a schema in the kernel's supported subset and a stable result/error shape.
- An MCP server's tool list and read-only/destructive hints are untrusted. Validate arguments against the current declaration and send calls through the decision chain using the effective server/tool identity.
- A subagent runs a separate loop and record with the parent's policy; it must not gain a looser approval mode or start a recursive subagent chain.
- `ask_user_question` is a user interaction, not tool approval. It is available only to interactive clients, returns only the user's actual answers, and must be cancelled with its originating turn.

## Verification

Run `npm test` and use the existing tests for path escape, observed writes, network classification, command parsing, process cancellation, MCP, and question handling. Security-sensitive changes must exercise the real validation and execution path.

