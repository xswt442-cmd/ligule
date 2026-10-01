# Agent guide

`ligule` is an agent harness under development. The 0.0.x line is a placeholder: the repository, the npm package name and the license are claimed, the behaviour is not settled yet.

## Engineering

- Keep `package.json#version` and `src/index.js#VERSION` equal; `test/kernel.test.js` asserts it.
- The kernel imports no transport, no UI framework and no adapter. CLI and desktop are adapters over the same interface, and adding one must not change a line of the kernel.
- Every failure carries a stable code (`KernelError#code`). A tool that did not finish raises `KernelError`; a failure of the kernel itself — the session log cannot be written, spilled content cannot be stored — raises `KernelRuntimeError`. The loop continues past the first and stops on the second. An error a tool raises without a code is wrapped into `tool_failed`, the original goes into `cause`, and the failure is recorded so the model sees it.
- Tool parameter schemas use a supported subset: at the root `type` (`object`), `properties`, `required`, `description`; on a leaf `type` (`string`, `integer`, `number`, `boolean`), `description`, `minimum`, `maximum`. Registration rejects anything else and names every violation; the kernel validates arguments before the decision chain runs. A full external JSON Schema needs an adapter layer that reduces it to this subset.
- Tools read configuration from the frozen snapshot the kernel passes them and log through the injected three-method interface (`debug` and `log` required, `error` optional). Nothing under `src/` writes to an output sink directly, and a host that injects no logger gets no output.
- The runtime floor is a single value written in four places: `engines.node` here, the README badge and `PRIMARY_NODE_VERSION` in each workflow. `test/runtime-version.test.js` asserts they agree, and the workflows install Node from that variable instead of repeating a number per step.
- Release: bump `package.json` and `VERSION` together, then tag `vX.Y.Z` on `main`. The tag drives the publish workflow.
- The very first publish cannot use npm Trusted Publishing: npm requires the package to exist before a trusted publisher can be bound to it. Publish `0.0.1` with a token, then configure the trusted publisher and let the workflow take over.
- The npm account has 2FA enabled, so a direct `npm publish` asks for a one-time password; run it interactively or pass `--otp`. Tokens that bypass 2FA are being restricted by npm for direct publishing, so do not reach for one. Trusted Publishing (OIDC) is not affected by 2FA — another reason to move publishing to the tag-driven workflow as soon as the package exists.

## Verify

```sh
npm test
npm run check-pack
```

`npm run check-pack` packs the tarball, unpacks it, checks every entry `package.json` points at, then imports the unpacked package from an empty consumer directory. `npm test` cannot catch those failures because it imports `src/` directly. Invoke the script through npm: on Windows Node refuses to launch `npm.cmd` without a shell, so the script needs `npm_execpath`.
