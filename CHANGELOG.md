# Changelog

All notable changes to `fastqa-mcp`. Versions follow [semantic versioning](https://semver.org/).

## 0.3.2 (2026-11-26)

First release published by the automated release workflow.

- The server reads its version from `package.json`, so a release only changes one file.
- CI runs the test suite on Node 20, 22 and 24 for every push and pull request, and checks that the committed `dist/` matches the source.
- Releases run from GitHub Actions (manually, or when a labelled pull request is merged) and publish to npm with trusted publishing and a provenance attestation.

## 0.3.1 (2026-11-26)

- README rewritten: FastQA is described as an MCP server with a QA mindset that lets an LLM drive and test web UIs, and it highlights network call and status code recording.
- Setup uses `npx -y fastqa-mcp`, with snippets for Claude Code, OpenCode and other MCP clients. Building from source is optional.
- Examples use a neutral online-shop checkout, and the bundled demo app is now a small shop.
- Added npm badges, an Install section, the MIT `LICENSE` and repository links in `package.json`.
- The test scripts run on Windows and in folders whose path contains spaces.

## 0.3.0 (2026-11-26)

- First public release on npm.
