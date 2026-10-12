# Release checklist

[简体中文](RELEASE.md) · [English](RELEASE.en.md)

This document tracks desktop installer and npm package targets, artifacts, system requirements, and installation verification. The repository version is `0.0.2`; this checklist does not mean that the version has been publicly released.

## Desktop installers

| Target | Rust target | Bundled Node archive | SHA-256 | Installer | System requirement | Build runner | Installation verification |
|---|---|---|---|---|---|---|---|
| Windows x64 | `x86_64-pc-windows-msvc` | `node-v24.21.0-win-x64.zip` | `158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541` | NSIS `.exe` | Windows 10; WebView2 runtime required | GitHub Actions `windows-latest` | Installation, a real model request, exit, and uninstall tested; verify release attachments against the final build |
| Linux x64 | `x86_64-unknown-linux-gnu` | `node-v24.21.0-linux-x64.tar.xz` | `fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6` | `.AppImage` and `.deb` | Ubuntu 22.04 and Debian 12 are declared targets | GitHub Actions `ubuntu-22.04` | Awaiting installation and launch checks on both systems |
| macOS Apple Silicon | `aarch64-apple-darwin` | `node-v24.21.0-darwin-arm64.tar.gz` | `bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057` | `.dmg` | macOS 13.5 or newer | GitHub Actions `macos-15` | Awaiting installation and launch check on Apple Silicon hardware |
| macOS Intel | `x86_64-apple-darwin` | `node-v24.21.0-darwin-x64.tar.gz` | `1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097` | `.dmg` | macOS 13.5 or newer | GitHub Actions `macos-15-intel` | Awaiting installation and launch check on Intel hardware |

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

`publish.yml` creates one tarball each for the main package and four platform packages, and stores their SHA-256 values as build artifacts. The workflow verifies and publishes the four search packages first, installs them from the registry to test the same main package tarball, publishes that tarball, and creates a GitHub draft Release last. If a version already exists, the workflow compares its tarball with the registry version and fails when their contents differ.

GitHub Actions uses npm Trusted Publishing. `NPM_TOKEN` can be used when establishing the packages and publishing trust for the first time. `ci.yml` builds desktop installers as check artifacts; the GitHub Release remains a draft. After all four platform packages have been tested on hardware and the attachments checked, a maintainer can publish the Release. The registry and GitHub release state determine whether an npm version or desktop package is public.
