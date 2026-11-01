# Kernel

The [repository guide](../../../AGENTS.md) applies. The kernel owns tool assembly, validation, policy, configuration, and shared user state.

- Workspace identity uses a resolved directory. Registry and shared preferences/history use locked, versioned writes; reject invalid registries and stale updates rather than treating them as empty. Input history contains sent text only; drafts and queues belong to each client.
- A new kernel has no tools. Plugins register tools and prompt fragments with cleanup; modes may narrow registered capabilities but never introduce undeclared tools or weaken policy.
- Policy denial is final: later stages cannot override a refusal or turn a hard denial into an approval prompt. Validate tool parameters against supported schemas before requesting approval.
- Tool metadata is kernel-owned, not model-authorized. Project configuration must not select executable extensions silently; extension tool requests go through `kernel.call`. Treat MCP server/tool declarations as untrusted and check them against the live schema and policy.
- Skills and templates do not grant permission. Host owns template expansion; preserve the raw input separately from model text.
- Model-service configuration validates provider IDs, endpoints, and selections. Keep legacy single-service compatibility; capabilities may be narrowed by configuration, never expanded beyond provider limits.

Run relevant kernel, policy, provider, config, preference, and workspace tests, plus `pnpm test` for full verification.
