# Release distribution

This is the release list for the desktop installers and the npm packages: one row per target, each row filled with the
artifact identity, the digest, the system floor, the build host and where the installed product gets checked. Digests
come from the archives downloaded on 2026-10-10; a row is only as good as the run that reproduces it.

## Desktop targets

| Target | Rust target | Bundled Node archive | Node SHA-256 | Installer | System floor | Build host | Installation and run check |
|---|---|---|---|---|---|---|---|
| Windows x64 | `x86_64-pc-windows-msvc` | `node-v24.21.0-win-x64.zip` | `158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541` | NSIS `.exe` | Windows 10 (WebView2 is preinstalled from 1803) | GitHub Actions `windows-latest` | first install, upgrade over an existing install, first run without the WebView2 runtime |
| Linux x64 | `x86_64-unknown-linux-gnu` | `node-v24.21.0-linux-x64.tar.xz` | `fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6` | `.AppImage` and `.deb` | glibc ≥ 2.34, kernel ≥ 5.14: Ubuntu 22.04 and Debian 12 | GitHub Actions `ubuntu-22.04` | run the AppImage, install the `.deb`, start the window |
| macOS arm64 | `aarch64-apple-darwin` | `node-v24.21.0-darwin-arm64.tar.gz` | `bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057` | `.dmg` | macOS 13.5 | GitHub Actions `macos-15` | mount, drag to Applications, launch after the download |
| macOS x64 | `x86_64-apple-darwin` | `node-v24.21.0-darwin-x64.tar.gz` | `1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097` | `.dmg` | macOS 13.5 | GitHub Actions `macos-15-intel` | mount, drag to Applications, launch after the download |

The Node floor and the system floors come from the same table: Node 24 lists Windows x64 at 10 or Server 2016,
Linux x64 at kernel 5.14 with glibc 2.34, and both macOS architectures at 13.5. macOS x64 sits in Node's Experimental
tier, so the release notes say so instead of promising it. Tauri asks for less (Windows 7, macOS 10.15, and a Linux
with WebKitGTK 4.1 installed), so the Node numbers decide.

AppImage is built on Ubuntu 22.04 rather than a moving default image: the glibc of the build host becomes the floor of
the produced file, and Ubuntu 22.04 is the oldest release this list supports.

`ci.yml` builds all four rows: one `desktop` job runs the matrix on `windows-latest`, `ubuntu-22.04`, `macos-15` and
`macos-15-intel`, and each runner bundles on its own architecture. Every one of them checks the bundled runtime it is
about to ship (its `--version`, its tool count), formats and tests the Rust half, then uploads the produced installers
as check attachments. Those attachments are not a release: the last column of the table above is a person installing
the file on that system, which no runner does.

Each platform's installer type comes from its own `desktop/src-tauri/tauri.<platform>.conf.json`, merged into
`tauri.conf.json` by the bundler, because `bundle.targets` takes either one list or `all` — a single list of all four
names would ask a Windows runner for a Linux package, and `all` would add an MSI this table does not carry.

The four bundles ship ad-hoc signed and are not notarized. Apple Silicon requires every Mach-O binary in the bundle,
the bundled Node included, to carry at least an ad-hoc signature for the same architecture, so signing is a build step
per architecture, not a Windows-style "no certificate means nothing to do".

## npm packages

| Package | Contents | Version |
|---|---|---|
| `ligule` | kernel, CLI, TUI, docs in both languages | moves with the tag |
| `ligule-rg-win32-x64` | `rg.exe` from ripgrep 15.2.0, three license files | moves with the tag |
| `ligule-rg-linux-x64` | `rg` from the same release, musl build, three license files | moves with the tag |
| `ligule-rg-darwin-arm64` | `rg` from the same release, three license files | moves with the tag |
| `ligule-rg-darwin-x64` | `rg` from the same release, three license files | moves with the tag |

The four search packages stay out of `optionalDependencies` until they exist on the registry: `npm ci` requires the
lockfile and `package.json` to agree, and npm drops an unpublished optional dependency from the lockfile silently
(exit code 0, nothing installed, no message). The version check in `test/runtime-version.test.js` keeps the manifests
of these packages and the desktop shell on one version, so the declaration and the release go in together.

The installer carries a runtime tree, so the order is build, vendor, then bundle: `npm run build`, `node desktop/fetch-runtime.mjs`, then the desktop build. Bundling copies whatever `desktop/vendor/app` holds, so skipping the vendor step yields an installer that starts and answers with an older host — a method the interface asks is simply not there.

`koffi` is an optional dependency: it only serves the Windows job object, its tarball carries no prebuilt binary and
its install step either downloads one or compiles it. A normal `npm install` on Windows still gets it, and an install on
Linux or macOS succeeds whether that step works or fails. The desktop runtime tree takes it from the build host only when
that host is Windows and refuses when it is not. `tree-sitter`, `tree-sitter-bash` and `tree-sitter-pwsh` ship prebuilt
binaries for darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-arm64 and win32-x64 inside their own tarballs, so no
compiler is needed for them.

## Search artifacts

| Key in `scripts/ripgrep-pin.json` | Archive | Bytes | SHA-256 |
|---|---|---|---|
| `win32-x64` | `ripgrep-15.2.0-x86_64-pc-windows-msvc.zip` | 1789611 | `71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5` |
| `linux-x64` | `ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz` | 2265718 | `33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c` |
| `darwin-arm64` | `ripgrep-15.2.0-aarch64-apple-darwin.tar.gz` | 1764284 | `3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4` |
| `darwin-x64` | `ripgrep-15.2.0-x86_64-apple-darwin.tar.gz` | 1878284 | `af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1` |

Each archive carries `LICENSE-MIT`, `UNLICENSE` and `COPYING`, which `npm run build-rg` copies next to the binary and
which the platform packages ship. The two macOS digests above were recomputed from the downloaded archives; the Linux
and Windows ones come from the pin written earlier.

## Not settled yet

- npm publishing identity: the repository has no Actions secrets, so the first publish of `ligule@0.0.2` and of the four
  search packages runs on the account owner's machine, and the workflow's token path gets configured with them.
- Release attachments and the public state of `v0.0.2` are set by the release run itself, after the four desktop
  targets and the npm packages have been verified.
- The library behind targeted edits in the configuration text (U56) is not chosen, so this list says nothing about it.
- Which Linux desktops show a tray icon, and whether a notification click can carry the session it belongs to (U57),
  are read from the released plugin source and the installed bundles, not from documentation.
