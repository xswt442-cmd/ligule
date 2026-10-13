# Release checklist

[简体中文](RELEASE.zh-cn.md) · [English](RELEASE.en.md)

This document tracks desktop installer and npm package targets, artifacts, system requirements, and installation verification.

> **Release status: public.** `v0.0.3` is available on [GitHub Releases](https://github.com/xswt442-cmd/ligule/releases/tag/v0.0.3) and [npm](https://www.npmjs.com/package/ligule). CI checked the bundled Node and ripgrep runtime in all four platform packages; first launch, tray, and notification behavior on Linux and both macOS targets still need hardware validation.

## Desktop installers

| Target | Installer | System requirement | Installation verification |
|---|---|---|---|
| Windows x64 | NSIS `.exe` | Windows 10; WebView2 runtime required | Installation, a real model request, exit, and uninstall tested; v0.0.3 installer installed in CI and passed its bundled runtime check |
| Linux x64 | `.AppImage` and `.deb` | Ubuntu 22.04 and Debian 12 are declared targets | CI checked runtimes in both packages; installation and first launch on the actual systems remain unverified |
| macOS Apple Silicon | `.dmg` | macOS 13.5 or newer | CI checked the DMG and bundled runtime; first launch on Apple Silicon hardware remains unverified |
| macOS Intel | `.dmg` | macOS 13.5 or newer | CI checked the DMG and bundled runtime; first launch on Intel hardware remains unverified |

### Bundled Node.js runtimes

| Target | Node target | Node archive | SHA-256 |
|---|---|---|---|
| Windows x64 | `win32-x64` | `node-v24.21.0-win-x64.zip` | `158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541` |
| Linux x64 | `linux-x64` | `node-v24.21.0-linux-x64.tar.xz` | `fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6` |
| macOS Apple Silicon | `darwin-arm64` | `node-v24.21.0-darwin-arm64.tar.gz` | `bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057` |
| macOS Intel | `darwin-x64` | `node-v24.21.0-darwin-x64.tar.gz` | `1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097` |

GitHub Actions builds them on `windows-latest`, `ubuntu-22.04`, `macos-15`, and `macos-15-intel` runners, respectively.

The four desktop targets are built by the Windows, Linux, Apple Silicon, and Intel runners in `ci.yml`. Each runner installs or extracts its generated artifact and runs the search-backend check with the bundled Node executable. This confirms that the target's optional binary is inside the installer and can run. It does not replace first-launch and platform-specific checks on real systems; tray menus and notifications still need target-by-target validation before release.

Node.js v24.21.0 lists Linux x64 with a minimum Linux 4.18 and glibc 2.28 baseline. Its platform list includes arm64 and x64 targets on macOS 13.5. Ligule declares Ubuntu 22.04 and Debian 12 as Linux targets; a build runner version describes the build environment and does not replace installation checks on those systems. See the [Node.js v24.21.0 platform requirements](https://github.com/nodejs/node/blob/v24.21.0/BUILDING.md#platform-list).

AppImage is built on `ubuntu-22.04`. Windows NSIS, Linux AppImage/deb, and macOS DMG targets are configured in `desktop/electron-builder.cjs`. macOS packages use an ad-hoc signature for the matching architecture and are not notarized.

## npm packages

| Package | Contents | Version |
|---|---|---|
| `ligule` | Kernel, CLI, TUI, Chinese and English guides; uses `@vscode/ripgrep@1.18.0` for content search | `0.0.3` |

The `@vscode/ripgrep` JavaScript wrapper selects ripgrep through platform-specific optional dependencies. npm installs only the matching binary on Windows x64, Linux x64, macOS arm64, or macOS x64. Ligule publishes only its main package and does not maintain separate ripgrep packages.

`npm run pack-release -- <artifact-directory>` creates the main package tarball in an isolated staging directory using npm's file list. Run `npm run verify-install -- <tarball>` to install it into a clean consumer, start the host ripgrep binary, and perform a real search. Verification fails if the backend is missing or the search fails.

## Release sequence

1. **Prepare the version PR.** Manually run [`tag.yml`](../../.github/workflows/tag.yml), choose `prepare`, and enter a stable version (`X.Y.Z`) or `patch`, `minor`, or `major`. The workflow updates the version manifests and bilingual release checklist from `main`, promotes `[Unreleased]` into the new version, and runs the full four-platform CI matrix. CI installs or extracts each desktop artifact and runs a real search with its bundled Node and target ripgrep binary. The workflow opens the version PR only after the matrix passes.
2. **Merge the version PR.** Review the generated version diff and the four-platform CI result, then merge the PR into `main`. Before publishing the GitHub Release, verify first launch, tray, and notifications on the actual desktop systems; the automated runtime check does not cover those UI behaviors.
3. **Create the tag.** Manually run [`tag.yml`](../../.github/workflows/tag.yml) on `main`, choose `tag`, and enter the merged version. The workflow checks that the full `main` push CI for that SHA passed and rechecks that remote `main` still points to the same SHA immediately before pushing the tag. Any mismatch stops the job. It then creates and pushes an annotated tag; you do not need to run `git tag` locally.
4. **Publish npm.** Manually run [`publish.yml`](../../.github/workflows/publish.yml) with the new `vX.Y.Z` tag. It validates and checks out that tag's main-branch commit, tests it, then enters the `npm-publish` Environment. Configure required reviewers there to gate publication of the main package. The job uses Trusted Publishing after approval. After npm succeeds, the workflow calls [`release.yml`](../../.github/workflows/release.yml).
5. **Complete the draft attachments.** `release.yml` uses the matching bilingual Changelog section as the Release body and creates a draft only when it does not already exist and the main npm package is readable. Existing drafts keep their title, body, and assets; published Releases cannot be changed by this workflow. Download the four desktop installers from the matching `main` CI run, verify their platforms and filenames, then upload them to the draft manually. Compute SHA-256 values with `Get-FileHash -Algorithm SHA256` or `sha256sum` and add them to the Release body. You can manually run `release.yml` to create a missing draft.
6. **Publish the Release.** Publish it on GitHub after all four hardware validations and the draft attachments and checksums are confirmed.

`CHANGELOG.md` is the single source for update history. The version PR promotes `[Unreleased]` into a dated version section; when creating a new draft, `release.yml` copies that version's Chinese and English content and appends download guidance instead of generating a separate summary. Existing drafts are preserved so manually added checksums and notes remain intact. Tags do not publish npm packages; `publish.yml` must be started manually. Check npm registry and GitHub Release state to determine what is public.
