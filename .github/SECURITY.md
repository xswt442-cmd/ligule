# Security policy

## Supported versions

Security fixes ship as a new version on the current release line of each shipping product: the CLI/TUI package on npm and the Desktop application in GitHub Releases. Older releases receive no fixes. A fix for shared Core code is recorded in the release notes of the products that actually include it.

## Reporting

Open an issue that only asks for a preferred security contact. Keep exploit details, reproduction steps for an unfixed weakness, credentials, and private host information out of that issue; provide them through the contact the maintainer names in reply.

A report names the affected version and product line, the affected component, the observed behavior, and the steps that reproduce it.

## Scope

The following trust boundaries belong to this repository:

- The Host and kernel split. The Host owns business logic, project environments, sessions, and policy; the kernel executes only registered tools. A network target or command backend is resolved once, and the same resolved target must govern both approval and execution.
- Native transport and lifecycle in the Electron main and preload processes, and the messages the desktop frontend exchanges with them.
- Session records. The Session JSONL file is authoritative, writable sessions take a cross-process lock, derived checkpoints are validated before use, and a recovery never replays a tool whose outcome is unknown.
- Configuration merging, including the `__proto__` merge guard and the public-field allowlists applied to project input.
- Credential resolution and storage. `LIGULE_HOME` must be an absolute path; credentials come from a nonempty environment variable or the operating system credential store, and their values must not appear in session records, logs, or configuration files.
- The distinction between `workspaceRoot` as project identity and the filesystem tool `boundary`, and the approval decisions that follow from it.
- Policy decisions and tool permissions exposed through the Agent Control (MCP) channel.

Weaknesses in another project's code belong to that project's reporting channel.

## Handling

Maintainers answer the contact request, assess each finding against the current release line, and record a confirmed fix in the release notes of the version that ships it. Report details stay out of public issues until that release is published.
