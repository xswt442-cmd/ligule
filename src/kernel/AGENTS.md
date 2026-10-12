# Kernel

The repository [Agent guide](../../AGENTS.md) applies here. This file keeps kernel-specific ownership and safety rules; see the [architecture guide](../../docs/development/ARCHITECTURE.en.md) for the request flow.

## Shared state

- Unit tests can inject the data-root resolver's home and environment arguments; the `npm test` hook isolates `HOME`/`USERPROFILE` and clears `LIGULE_HOME`.
- Workspace identity is based on the resolved directory. Registry updates are locked read-modify-write operations; an invalid or unsupported registry must fail instead of appearing empty. Changing the default workspace must not remove registered entries.
- Desktop preferences and shared input history use versioned, locked writes. A stale preference version must not overwrite a newer one. Input history contains only sent text and is shared by desktop and TUI; drafts and queues belong to each interface.

## Assembly and policy

- A new kernel has an empty registry. Plugins register tools and prompt fragments through the assembly path and provide cleanup actions. Modes select registered tools and prompt fragments; they cannot add tools or lower the decision chain's restrictions.
- The decision chain is monotonic: once a rule or guard refuses a call, no later stage can turn it into an allowance. A refusal before the ask stage must not become a user prompt.
- Tool parameter schemas use the supported subset enforced by `schema.js`; validate arguments before asking for approval.
- A tool's `readOnly`, execution, disclosure, command, target, or capability metadata is kernel-side. Do not add these fields to the model manifest. They are declarations, not permission to bypass per-call validation or policy.
- Extensions are executable code. Only user-selected extension sources load; project configuration cannot silently choose code to execute. Extension `request()` must call through `kernel.call`.
- MCP uses stdio. Treat server declarations and hints as untrusted; validate tool arguments against the current server declaration and run each call through policy under its effective `mcp:<server>/<tool>` identity.

## Resources and providers

- Skills and prompt templates are read from their documented user and project locations. A skill can disclose its own files through the registered tool, but loading it grants no tool or approval. Template expansion remains a Host responsibility; raw invocation text must stay distinct from expanded model input.
- `model-services.ts` validates service IDs, endpoints, model lists, and session selections. Preserve support for the legacy single-service fields. Provider adapters expose declared capability ceilings; configuration may lower those limits, never raise them.

## Verification

Run `npm test` for the full suite. For changes here, include the relevant kernel, config, policy, provider, workspace, or preference tests; use the test names and scripts already present in `test/` and `package.json`.

