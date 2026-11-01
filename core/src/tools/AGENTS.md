# Tools

The [repository guide](../../../AGENTS.md) applies. Tools are model-callable contracts; OS and filesystem primitives belong in [capability](../capability/). All tools execute through the kernel.

- Resolve filesystem targets against the Host working directory and configured boundary; defend against symlinks and path-prefix confusion. `write` requires a complete prior read and matching observed version; `edit` requires a unique, nonempty anchor.
- `delete` only uses the OS recycle bin. Failure or unknown outcome must not trigger permanent deletion or a private trash fallback. Shell commands remain subject to separate policy and approval.
- Preserve configured resource limits and indicate truncated or incomplete outputs.
- Reject prohibited network ranges and metadata targets. Private/loopback access requires approval; revalidate each redirect, permitting only the authorized target and same-origin redirects.
- `exec` uses the configured shell backend; no fallback grammar. Unsupported parses cannot qualify for automatic approval. Cancellation must terminate the managed process tree (POSIX process groups; Windows Job Object).
- Validate MCP tool schemas against current server declarations; hints are untrusted. Subagents inherit policy ceilings and cannot recurse. `ask_user_question` is an actual user interaction, distinct from approval, bound to the current turn and cancellable.

Use real tool/backend tests for path escapes, writes, deletion failures, network targets, commands, process cancellation, MCP, and questions; run `pnpm test` for full verification.
