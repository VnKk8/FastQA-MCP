# Changelog

All notable changes to `fastqa-mcp`. Versions follow [semantic versioning](https://semver.org/).

## Unreleased

Not on npm yet. Implemented and tested on the `evolution/v1-roadmap` branch; see `docs/evolution-progress.md` for what was verified and how. The version number is the maintainer's decision at release time.

### Added

- **Continuous QA.** `open`, `act` and `flow run` results end with a `QA:` line. FastQA reports candidate findings it observed by itself: failed first-party requests (`NET-5XX`, `NET-4XX`, `NET-FAIL`), uncaught exceptions (`JS-EXCEPTION`) and console errors (`CONSOLE-ERROR`). A finding is a lead to verify, not a confirmed defect, and it never changes a step result in the default mode.
- **Action and request correlation.** Every request is tied to the action that started it, with a stated confidence (`direct`, `inferred`, `ambiguous`, `unattributed`). A response that arrives during a later step, or after the batch returned, still belongs to the action that started the request; late findings appear in the next result.
- **Evidence views.** `evidence` gained read-only views: `summary`, `findings`, `network`, `timeline`, `discovery` and `config`, with filters and paging. `evidence {finding, report:true}` writes a candidate bug draft; `evidence {report:true}` writes the session bundle.
- **Modes.** `observe` (default), `strict`, `discovery`, `debug` and `off`, set by `quality.mode`, `FASTQA_QUALITY`, `--mode=` or `mode` on `flow run`. Strict fails a run on findings at or above `quality.failOnSeverity`, with a bounded wait for pending requests at the end of a replay.
- **Configuration file** `.fastqa/config.json`, strictly validated: expected responses (scoped, with a reason), suppressions for known issues, business rules for HTTP 200 responses that carry an error, performance limits, state rules, OpenAPI contracts, capture, privacy, strict locators, discovery, artifacts and browser options. `fastqa-mcp config` validates it and prints the effective configuration.
- **Optional checks**, all off until configured: `BUSINESS-ERROR`, `CONTRACT-STATUS` / `CONTRACT-MEDIA` / `CONTRACT-SCHEMA` (local OpenAPI 3.0 and 3.1 JSON), `PERF-SLOW`, `PERF-CALLS`, `PERF-BASELINE`, `STATE-INVARIANT`.
- **Opt-in payload capture.** JSON responses of allowlisted first-party endpoints only, sanitized before they are kept, bounded in size and number. A rule that needs a payload it could not read is reported as "not evaluated".
- **Session bundles** in `.fastqa/sessions/<runId>/` (`summary.json`, `actions.jsonl`, `observations.jsonl`, `findings.json`, `evidence/<id>/finding.md`), opt-in through `artifacts.enabled`, `--bundle` or `evidence {report:true}`, with retention limits.
- **Observed discovery.** With `quality.mode: "discovery"`, a bounded graph of the routes and endpoints that were actually seen, and `fastqa-mcp discovery` to merge saved exports.
- **Strict locators.** `strict: true` on `act`, or `locator.strict`, fails a step whose target matches several elements and lists refs to choose from. Stale refs are rejected in strict mode.
- **CLI.** `run` gained `--mode=`, `--bundle`, `--baseline=record|check` and `--repeat=`. New commands: `config`, `discovery`, `--help`.
- **Environment variables:** `FASTQA_QUALITY`, `FASTQA_CAPTURE=off`, `FASTQA_IGNORE_HTTPS_ERRORS`, `FASTQA_STRUCTURED`.

### Changed

- **Exported Playwright specs enforce QA assertions.** `expect_request`, `expect_no_errors` and `expect_accessible` are executable code; they were comments. Flows saved by 0.3 export this way too. A step that cannot be exported faithfully is listed in the result and in `<name>.parity.json`.
- **Reports** show steps and assertions separately from QA findings. JUnit keeps its structure; findings go to `<system-out>`, and a strict policy failure is a failure of type `fastqa.policy`.
- **Privacy.** Network URLs in every output lose credentials, fragments and query values (`?token=•••&page=…`). Known secret values are replaced wherever they appear, including page text. Screenshots mask password fields.
- **One step executor** for MCP and CLI replay, and browser listeners bound once per context, so the first requests of popups are observed and nothing is registered twice.
- Tool calls to one server are queued instead of running concurrently against the same page.
- Report and flow files are written atomically; parallel runs into one directory no longer overwrite each other.
- `npm run demo` works on Windows.

### Compatibility and migration

- The eight tools, their 0.3 parameters, flow files, CLI exit codes and report file names are unchanged. `bench/compat.mjs` replays the 0.3.2 call script and requires identical output apart from the `QA:` lines.
- **New output line.** Results now end with `QA: …`. Set `FASTQA_QUALITY=off` to get the exact 0.3 output.
- **Query values are hidden** in network URLs shown by `evidence`, assertion messages and reports. Allow specific parameters with `privacy.keepQueryParams`. `expect_request` still matches against the full URL.
- **TLS.** Without a config file nothing changes (invalid certificates are accepted, now with a warning on stderr when an HTTPS site is opened). As soon as `.fastqa/config.json` exists, invalid certificates are rejected unless `browser.ignoreHTTPSErrors` is `true`.
- **JUnit failure text** lists the screenshot with a path relative to `.fastqa/`.
- **Old reports and failure screenshots are pruned.** Only the newest 200 report pairs in `reports/` and the newest 200 failure screenshots in `artifacts/` are kept (`artifacts.maxReports`, `artifacts.maxScreenshots`). 0.3 kept them forever.
- **`run` rejects unknown options** with exit code 2. 0.3 ignored them.
- `open` now resolves `{{placeholders}}` in its URL, like `act` does.
- When a popup closes, the page that is still open becomes the active page again. In 0.3 the session stayed on the closed page until the next `open`.
- New dependency declared: `ajv` (already installed through the MCP SDK).

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
