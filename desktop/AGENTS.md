# Desktop

Rules for `desktop/` as a directory: the Tauri shell and its Vite frontend (D34). The repository-wide rules in [../AGENTS.md](../AGENTS.md) apply here too. The shell's own rules are in [src-tauri/AGENTS.md](src-tauri/AGENTS.md) and the window's interface in [frontend/AGENTS.md](frontend/AGENTS.md).

- `desktop/` is the Tauri shell. Rust opens the window, starts the Node host and moves one line per frame each way. `frontend/` is a Vite project (React, TypeScript) built by `npm run build` into `dist/`, and Tauri embeds that directory.
- `desktop/` stays outside `package.json#files`.
