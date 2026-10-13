# Release checklist

[简体中文](RELEASE.zh-cn.md) · [English](RELEASE.en.md)

Ligule maintains independent CLI and Desktop versions and changelogs. The root `package.json`, `src/version.ts`, and `CHANGELOG.md` describe the npm CLI package. `desktop/package.json` and `desktop/CHANGELOG.md` describe Electron installers. The private frontend package version is internal metadata and is not a release version. `pnpm-lock.yaml` records dependency resolution and is not rewritten for a version-only change.

Do not infer publication state from a local manifest. Check the [GitHub Releases](https://github.com/xswt442-cmd/ligule/releases) page and the [npm package](https://www.npmjs.com/package/ligule) before retrying or describing a release. The historical `v0.0.3` tag remains unchanged; new releases use product-specific tags.

## Desktop targets

| Target | Installer | System requirement | Automated package check |
|---|---|---|---|
| Windows x64 | NSIS `.exe` | Windows 10 or later; WebView2 is not required because Electron embeds Chromium | Install and inspect the packaged runtime; run the Windows Host process-tree test |
| Linux x64 | `.AppImage` and `.deb` | Ubuntu 22.04 and Debian 12 are declared targets | Inspect both packages and run the bundled runtime check |
| macOS Apple Silicon | `.dmg` | macOS 13.5 or newer | Verify the DMG and bundled runtime |
| macOS Intel | `.dmg` | macOS 13.5 or newer | Verify the DMG and bundled runtime |

Electron's supported platform list documents Windows 10 and later and macOS Ventura and later; see [Electron platform support](https://github.com/electron/electron/blob/main/README.md#platform-support). The Windows installer embeds Electron's Chromium renderer and does not depend on the Microsoft Edge WebView2 runtime. macOS packages use an ad-hoc signature and are not notarized. Automated checks do not replace first-launch, tray, notification, or OS-specific validation on the target systems.

The application bundles Node.js v24.21.0 for the four targets. The archive SHA-256 values are pinned in `desktop/node-pin.json`; update that source and the bundled runtime tests together when changing the runtime. Linux targets require glibc 2.28 or newer; see [Node.js v24.21.0 platform requirements](https://github.com/nodejs/node/blob/v24.21.0/BUILDING.md#platform-list).

| Target | Node archive | SHA-256 |
|---|---|---|
| Windows x64 | `node-v24.21.0-win-x64.zip` | `158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541` |
| Linux x64 | `node-v24.21.0-linux-x64.tar.xz` | `fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6` |
| macOS Apple Silicon | `node-v24.21.0-darwin-arm64.tar.gz` | `bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057` |
| macOS Intel | `node-v24.21.0-darwin-x64.tar.gz` | `1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097` |

## CLI package

The `ligule` npm package contains the kernel, CLI, TUI, guides, and runtime dependencies. Use npm for consumer operations such as global installation and clean-consumer verification. Release automation installs the repository's frozen pnpm workspace (`pnpm@12.9.1`) to run repository scripts and tests; it does not use npm to install the monorepo.

`pnpm --filter ligule run pack-release <artifact-directory>` creates the npm tarball. `pnpm --filter ligule run verify-install <tarball>` installs that exact tarball with npm into an isolated consumer and exercises its CLI and exports.

## Independent release procedure

1. **Prepare a product version.** Manually run [`tag.yml`](../../.github/workflows/tag.yml) from `main`, choose `prepare`, select `cli` or `desktop`, and enter `patch`, `minor`, `major`, or `X.Y.Z`. The workflow updates only that product's version and changelog, pushes a review branch, runs the full CI workflow for its exact commit, and opens a PR. Review and merge the PR.
2. **Create the product tag.** Run `tag.yml` from `main` with action `tag`, the same product, and the merged version. The workflow refuses an existing tag, requires `main` to point at the selected commit, checks that the full `main` push CI succeeded for that exact SHA, then creates an annotated `cli-vX.Y.Z` or `desktop-vX.Y.Z` tag.
3. **Publish the CLI to npm.** Manually run [`publish.yml`](../../.github/workflows/publish.yml) with a `cli-vX.Y.Z` tag. It verifies main ancestry and successful CI for the exact tag SHA, tests and packs that commit, checks the exact tarball against the npm registry, and installs it into an empty npm consumer. It also checks through the GitHub API that the existing `npm-publish` Environment has at least one required reviewer; the workflow fails closed if it does not. After that check, publication waits at the Environment and uses npm Trusted Publishing with OIDC. A Desktop tag cannot trigger or satisfy this flow.
4. **Build the Desktop draft.** Manually run [`release.yml`](../../.github/workflows/release.yml) from `main` with a `desktop-vX.Y.Z` tag. It rechecks that the tag is on `main` and that main CI passed for the tag SHA, then builds Windows x64, Linux x64, macOS arm64, and macOS x64 installers from that exact commit. Each installer filename and manifest bind the version, target architecture, source commit, workflow run, and SHA-256. The workflow creates or completes a GitHub draft Release. An existing draft's title and notes are preserved; identical existing assets are skipped, conflicting bytes fail, and published Releases are never modified.
5. **Review and publish the Desktop draft.** Confirm installer checksums and run first-launch, tray, notification, and OS-specific checks on the target systems. Publish the draft manually on GitHub only after those checks pass. The workflow does not publish the draft.

The CLI and Desktop changelogs are independent. Version preparation never changes the other product's manifest, changelog, runtime version, or the private frontend version. A version-only change does not update the dependency lockfile.
