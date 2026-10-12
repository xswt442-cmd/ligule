# Glossary

These terms describe current ligule behavior. Protocol method names and configuration keys keep their code spelling.

| Term | Meaning in ligule |
|---|---|
| **Kernel** | The runtime that registers tools, validates calls, applies policy, runs allowed tools, and records their results. It starts with an empty tool registry. |
| **Host** | The Node.js owner of a project environment and its open sessions. It assembles the kernel, model provider, policy, session records, extensions, and client protocol. |
| **Adapter** | An interface-specific entry point that presents Host behavior to a user. The CLI, TUI, and desktop frontend use different transports. |
| **Plugin** | A module installed by the Host that registers tools or prompt fragments and returns cleanup actions. |
| **Tool** | A registered, model-callable operation with a name, description, parameter schema, and implementation. A tool call always passes through kernel validation and policy. |
| **Capability** | Host-side code that performs an operation requiring access to the operating system or environment, such as path resolution, process execution, or network access. A capability is not necessarily a model-callable tool. A policy verdict's `capability` field labels the operation evaluated. |
| **Tool mode** | A named selection of registered tools and prompt fragments. A mode controls the model's available tool manifest; it does not grant approval. |
| **Approval policy** | The decision rules applied to a tool call after argument and target checks. A policy can allow, refuse, or ask the user. The session may override the configured approval mode. |
| **Workspace** | A registered real directory used as a project's identity and default location for new sessions. Multiple workspaces can be active in one desktop window. |
| **Project root** | The directory whose configuration, resources, and sessions belong to a Host project environment. It may differ from the tool access boundary. |
| **Boundary** | The filesystem scope enforced by file tools. It controls which paths a tool may access; it does not determine session ownership. |
| **Session record** | The append-only JSONL event log for a conversation. It is the source of truth for messages, tool outcomes, turn state, and recoverable session facts. |
| **Checkpoint** | A separate, validated summary of a covered record range. It can shorten the model projection; it never replaces the JSONL source record. |
| **Spill file** | A sidecar file that holds a tool result or summary exceeding the configured inline limit. The record retains a reference to that file. |
