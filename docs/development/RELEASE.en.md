# Release checklist

[简体中文](RELEASE.zh-cn.md) · [English](RELEASE.en.md)

This document tracks desktop installer and npm package targets, artifacts, system requirements, and installation verification.

> **Release status: not public.** The repository version is `0.0.2`. Windows x64 installation and launch have been tested; Linux and both macOS targets still need hardware validation.

## Desktop installers

| Target | Installer | System requirement | Installation verification |
|---|---|---|---|
| Windows x64 | NSIS `.exe` | Windows 10; WebView2 runtime required | Installation, a real model request, exit, and uninstall tested; verify release attachments against the final build |
| Linux x64 | `.AppImage` and `.deb` | Ubuntu 22.04 and Debian 12 are declared targets | Awaiting installation and launch checks on both systems |
| macOS Apple Silicon | `.dmg` | macOS 13.5 or newer | Awaiting installation and launch check on Apple Silicon hardware |
| macOS Intel | `.dmg` | macOS 13.5 or newer | Awaiting installation and launch check on Intel hardware |

### Bundled Node.js runtimes

| Target | Rust target | Node archive | SHA-256 |
|---|---|---|---|
| Windows x64 | `x86_64-pc-windows-msvc` | `node-v24.21.0-win-x64.zip` | `158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541` |
| Linux x64 | `x86_64-unknown-linux-gnu` | `node-v24.21.0-linux-x64.tar.xz` | `fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6` |
| macOS Apple Silicon | `aarch64-apple-darwin` | `node-v24.21.0-darwin-arm64.tar.gz` | `bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057` |
| macOS Intel | `x86_64-apple-darwin` | `node-v24.21.0-darwin-x64.tar.gz` | `1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097` |

GitHub Actions builds them on `windows-latest`, `ubuntu-22.04`, `macos-15`, and `macos-15-intel` runners, respectively.

The four desktop targets are built by the Windows, Linux, Apple Silicon, and Intel runners in `ci.yml`. Automated builds and tests do not replace installation, first-launch, and platform-specific checks on the target systems. Each installer still needs validation, including tray menu and notification behavior.

Node.js v24.21.0 lists Linux x64 with a minimum Linux 4.18 and glibc 2.28 baseline. Its platform list includes arm64 and x64 targets on macOS 13.5. Ligule declares Ubuntu 22.04 and Debian 12 as Linux targets; a build runner version describes the build environment and does not replace installation checks on those systems. See the [Node.js v24.21.0 platform requirements](https://github.com/nodejs/node/blob/v24.21.0/BUILDING.md#platform-list).

AppImage is built on `ubuntu-22.04`. Installer formats are set in `desktop/src-tauri/tauri.<platform>.conf.json`. macOS packages use an ad-hoc signature for the matching architecture and are not notarized.

## npm packages

| Package | Contents | Version |
|---|---|---|
| `ligule` | Kernel, CLI, TUI, and Chinese and English user guides | `0.0.2` |
| `ligule-rg-win32-x64` | `rg.exe` and three licenses | `0.0.2` |
| `ligule-rg-linux-x64` | `rg` and three licenses | `0.0.2` |
| `ligule-rg-darwin-arm64` | `rg` and three licenses | `0.0.2` |
| `ligule-rg-darwin-x64` | `rg` and three licenses | `0.0.2` |

`npm run pack-release -- <artifact-directory>` creates a release package in an isolated staging directory using npm's file list, then adds four exact search package versions to the artifact's `optionalDependencies`. The development manifest does not depend on platform packages that have not been published, so `npm ci` remains usable.

Run `npm run verify-install -- <main-package-tarball>` in normal mode to install from the registry in a clean consumer and test the platform search package. Run `npm run verify-install -- --local-search` to pack and install the locally built platform package before testing the main package tarball. Verification fails if the search backend is missing or a real search fails. Publish only the tarball produced by the release packaging entry point.

## Search package archives

| Target in `scripts/ripgrep-pin.json` | Archive | Bytes | SHA-256 |
|---|---|---:|---|
| `win32-x64` | `ripgrep-15.2.0-x86_64-pc-windows-msvc.zip` | 1789611 | `71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5` |
| `linux-x64` | `ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz` | 2265718 | `33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c` |
| `darwin-arm64` | `ripgrep-15.2.0-aarch64-apple-darwin.tar.gz` | 1764284 | `3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4` |
| `darwin-x64` | `ripgrep-15.2.0-x86_64-apple-darwin.tar.gz` | 1878284 | `af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1` |

Each archive contains `LICENSE-MIT`, `UNLICENSE`, and `COPYING`. `npm run build-rg` verifies the pinned version and SHA-256, then places the binary and licenses in the corresponding platform package.

## Release sequence

1. **Prepare the version PR.** Manually run [`tag.yml`](../../.github/workflows/tag.yml), choose `prepare`, and enter a stable version (`X.Y.Z`) or `patch`, `minor`, or `major`. The workflow updates every version manifest from `main`, promotes the bilingual `[Unreleased]` section, and runs `npm test`, `npm run check-pack`, and the full four-platform CI matrix. It opens a PR to `main` only after those checks pass. Review the version diff and download the four installers from its CI run for hardware validation.
2. **Merge and validate.** Merge the reviewed version PR into `main`. Complete installation and launch validation on Windows x64, Linux x64, macOS Apple Silicon, and macOS Intel for the merged commit. A successful CI artifact build alone is not hardware validation.
3. **Create the tag.** Manually run [`tag.yml`](../../.github/workflows/tag.yml) on `main`, choose `tag`, enter the merged version, and confirm all four platform validations. The workflow checks that the tag is absent, the version matches the Changelog, and the commit is on `main`; it reruns the complete CI matrix and creates and pushes an annotated tag only after CI passes. You do not need to run `git tag` locally.
4. **Publish npm.** Manually run [`publish.yml`](../../.github/workflows/publish.yml) with the new `vX.Y.Z` tag. It validates and checks out that tag's main-branch commit, tests it, then enters the `npm-publish` Environment. Configure required reviewers there to gate publication of all four search packages and the main package; without protection rules, the Environment adds no wait. The first publication needs `NPM_TOKEN` configured as a repository secret. After npm succeeds, the workflow calls [`release.yml`](../../.github/workflows/release.yml).
5. **Complete the draft attachments.** `release.yml` uses the matching bilingual Changelog section as the Release body and creates or updates a draft after all matching npm packages are readable. It refuses to edit a published Release. Download the four desktop installers from the matching `main` CI run, verify their platforms and filenames, then upload them to the draft manually. Compute SHA-256 values with `Get-FileHash -Algorithm SHA256` or `sha256sum` and add them to the Release body. You can manually run `release.yml` after npm publication to repair or recreate the draft.
6. **Publish the Release.** Publish it on GitHub after all four hardware validations and the draft attachments and checksums are confirmed.

`CHANGELOG.md` is the single source for update history. The version PR promotes `[Unreleased]` into a dated version section; `release.yml` copies that version's Chinese and English content and appends download guidance instead of generating a separate summary. Desktop attachments and checksums are maintained on the GitHub Release after upload. Tags do not publish npm packages; `publish.yml` must be started manually. Remove the repository secret `NPM_TOKEN` after npm Trusted Publishing is configured. Check npm registry and GitHub Release state to determine what is public.
