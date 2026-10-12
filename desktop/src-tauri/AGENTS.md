# Desktop shell

The repository [Agent guide](../../AGENTS.md) and [desktop guide](../AGENTS.md) apply here. This crate owns Tauri windows, native integrations, and the Node Host process.

- Forward Host frames as lines between the WebView and Node stdin/stdout. Rust must not interpret method names, session IDs, policy, records, or business errors.
- Resolve the Node executable and CLI from bundled resources first, then the documented development overrides. Each frame and log forwarding task belongs to its child process; replacing a Host must stop the old process and disconnect its streams.
- On application exit, close Host stdin so Node can cancel active work and release session locks. Use a bounded wait before forcefully terminating an unresponsive process.
- A window may hide on close only while a usable tray host exists. On Linux, monitor the StatusNotifierWatcher through Session D-Bus; restore a tray-hidden window if the host disappears or detection fails. D-Bus failures must not block Host work.
- The frontend owns session selection and notification preferences. The shell may deliver native notifications and return an opaque click target; it must not parse that target or decide which session to open. Use the Tauri notification plugin for permission integration and the native response handle for click delivery.
- Keep Tauri capabilities minimal. The file dialog exposes save selection only; the frontend gives the selected path to the Host for export. Do not add general filesystem access to the WebView.
- Bundle resources are generated per target under `desktop/vendor/`; do not reuse native dependencies across operating systems or architectures. Installer formats come from the target-specific Tauri configuration.

Run `cargo fmt --check` and `cargo test` from `desktop/src-tauri/`. Platform tray, notification, and installer behavior also needs verification on the matching desktop target; Rust unit tests do not establish real system behavior.
