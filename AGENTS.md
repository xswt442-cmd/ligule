# Agent guide

`ligule` is an agent harness under development. The 0.0.x line is a placeholder: the repository, the npm package name and the license are claimed, the behaviour is not settled yet.

## Engineering

- Keep `package.json#version` and `src/index.js#VERSION` equal; `test/kernel.test.js` asserts it.
- The kernel imports no transport, no UI framework and no adapter. CLI and desktop are adapters over the same interface, and adding one must not change a line of the kernel.
- Every failure carries a stable code (`KernelError#code`).
- Release: bump `package.json` and `VERSION` together, then tag `vX.Y.Z` on `main`. The tag drives the publish workflow.
- The very first publish cannot use npm Trusted Publishing: npm requires the package to exist before a trusted publisher can be bound to it. Publish `0.0.1` with a token, then configure the trusted publisher and let the workflow take over.
- The npm account has 2FA enabled, so a direct `npm publish` asks for a one-time password; run it interactively or pass `--otp`. Tokens that bypass 2FA are being restricted by npm for direct publishing, so do not reach for one. Trusted Publishing (OIDC) is not affected by 2FA — another reason to move publishing to the tag-driven workflow as soon as the package exists.

## Verify

```sh
npm test
npm pack --dry-run
```
