# Agent guidelines template

Replace this template with the target repository's actual ownership boundaries, validation commands, and links. Keep only rules applicable to that repository.

- Inspect the current source, documentation, Git state, and local directory guides before editing. Preserve existing changes and restrict work to the requested scope.
- Keep public documentation portable, self-contained, and limited to current behavior. Do not commit personal paths, credentials, private hosts, test output, temporary investigations, or handoff notes.
- Keep root-level rules global; put local constraints in nearer `AGENTS.md` files. Prefer repository-relative links and align user-facing languages where applicable.
- Update maintained documentation and changelogs only for verified behavior changes. PR descriptions record actual changes and checks; future work belongs in Issues.
- Run existing relevant build, test, and security checks, report skipped/failed work accurately, and preserve user data and release artifacts.
- Do not commit, push, change branches, restore or reset files, publish, or alter production state without explicit authorization.

Add the repository-specific architecture, safety invariants, and validation instructions before using this file.
