# Contributing

## Branches

Pull requests target the development branch recorded in the repository's `AGENTS.md`. Maintainers merge, tag, and publish. CI runs on pull requests.

## Pull request descriptions

A description states the change, the work completed, and the checks actually run, in a Simplified Chinese section and a matching English section. Deferred work belongs in an issue.

## Commit messages

Start the subject with a Conventional Commit type: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `perf:`, `build:`, `ci:`, `chore:`, or `release:`. Add a scope in parentheses when it clarifies the area (`fix(paths):`). Follow the colon with one sentence describing the change. One commit carries one type; split unrelated changes into separate commits.

## Documentation

The repository's bilingual document pairs change together. Pair declarations and the check command live in the repository's `AGENTS.md`. Tracked files contain no personal paths, credentials, private host details, or one-off logs.

## Verification

Run the checks listed under `Verify` in the repository's `AGENTS.md` before opening a pull request.

## Security reports

Security findings follow [SECURITY.md](SECURITY.md).
