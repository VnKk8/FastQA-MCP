# Changelog

All notable changes to `fastqa-mcp`. Versions follow [semantic versioning](https://semver.org/).

## 1.0.2 (2026-11-27)

### Added

- **File uploads.** `act` has an `upload` step that chooses files for a file input. The value names the files: `"photo.png"` makes a small valid PNG, `"big.jpg:6MB"` or `"edge.png:5242881"` makes a file of exactly that size, `"virus.exe"` makes filler bytes, `"a.png|b.pdf"` chooses several files and `""` clears the selection. Made images, PDFs and text files stay valid files of their type at every size, so a size limit test fails on the size and not on a broken file. Your own files come from `.fastqa/files/` as `"files/<name>"`; no other path on disk can be uploaded. The target can be the input's label, a hidden input, a styled "Upload" button or a drop zone that opens the file picker, or nothing when the page has one file input. The result gives each file's exact size and says when a file is outside the input's `accept` list. A disabled file input fails the step, as it would for a person, although the browser itself would take the files. Uploads are recorded in flows, replayed with the same bytes and exported to Playwright specs as code. File contents never appear in results, evidence or saved flows. The step costs about 40 more tokens of tool definitions (about 1,920 in total).

- **Facts for the agent, so it needs fewer calls.** Each is one short line, only when there is something to say. On the normal path none adds a wait; measured against 1.0.1, a click costs about 3 ms more.
  - **Snapshot field rules:** `type:`, `maxlength:`, `minlength:`, `min:`, `max:`, `step:` and `pattern:` at the end of a field's line. Once validation applies to the person, the browser's own message: `invalid:"Please include an '@' …"`.
  - **What each action did,** on a `↳` line under its step in `act`:
    - the first-party calls it made, failed ones first, with status and time;
    - a navigation or a new tab;
    - messages that came and went before the next action;
    - native dialogs, downloads and file pickers, under the step during which they happened;
    - `nothing sent: the browser blocked the form` with the invalid fields;
    - `no effect within N ms` for a dead click;
    - `field holds "…"` when a field keeps something other than what was typed.
  - **The server's reason** for a failed call, only when payload capture is on for it.
  - **Why a step failed:** the closest names with refs when a target matched nothing, the element covering a button, and the empty required fields that keep a submit disabled.
  - **Page facts on `open`:** forms and fields, a visible captcha, or a bot check page instead of the site.
- **New QA rules:** `SILENT-FAILURE` (a submission failed and the page showed nothing until the batch ended), `DUPLICATE-SUBMIT` (one action sent the same submission twice), `DEAD-CLICK` (a button or link changed nothing), `BROKEN-IMAGE` (a first-party image arrived but could not be shown). They run in replays too. They err on the side of silence; when one is suspected, the page gets one more second before it is judged. In strict mode, `SILENT-FAILURE` and `DUPLICATE-SUBMIT` (medium) fail a run when `failOnSeverity` is `medium` or lower.

### Changed

- **The 0.3.2 output format gains two additive things:** lines that start with `↳`, and tokens at the end of snapshot lines (the field rules and `invalid:"…"`). `[invalid]` keeps its 0.3 meaning. Everything else is unchanged byte for byte (checked by `bench/compat.mjs`). Clients that parse results line by line should skip `↳` lines.
- **Native dialogs, downloads and file pickers are recorded.** fastqa now listens for them and handles dialogs exactly as Playwright did on its own before: `alert`, `confirm` and `prompt` are dismissed, `beforeunload` is accepted. Behaviour is the same; the agent is told. Listening for file pickers also keeps a headed browser from opening the native picker, which would block the run.
- **Setup examples use `fastqa-mcp@latest`,** so npx looks for a new release each time instead of reusing an older downloaded copy. Pin a version (`fastqa-mcp@1.0.2`) to stay on one.
- **The snapshot shows file inputs as `file`**, not `textbox`, with the chosen file names, the accepted types, and `[hidden]` for hidden inputs, which are now listed too (at most 5 per frame; the rest are counted in one line). `fill` on a file input fails with a message that points to `upload` instead of Playwright's "Input of type file cannot be filled".

### Fixed

- **The OpenCode example in the README repeated `"FASTQA_COOKIES"`,** a duplicate key that editors and schema checks flag. Every JSON example in the README and the reference is now checked by `npm test` (it must parse and have no duplicate keys).

## 1.0.1 (2026-11-27)

### Added

- **Cookie banners.** `open` takes `cookies: "accept" | "reject" | "keep"`, `act` has a `cookies` step, and `FASTQA_COOKIES=accept|reject` makes every `open` answer the banner. FastQA finds the button by the ids of common consent tools, or by the words on it in nine languages, inside iframes and open shadow DOM too. FastQA waits for a banner only while the page is still loading things (at most 2.5 seconds), so a page without one costs about 0.8 seconds. A page without a banner passes, and `reject` never clicks "Settings" or a button that refuses only by subscribing: it reports the buttons it saw instead. The answer is recorded in flows, replayed, and exported to Playwright specs as code. Off unless asked for: with the option unused, nothing changes except about 46 more tokens of tool definitions (about 1,880 in total).

### Fixed

- **`close` no longer hangs on Windows.** Closing waited until the browser's temporary profile folder was deleted. On Windows that takes as long as another program (antivirus, indexer) holds a file in the folder, so the call could outlast the client's time limit although the browser had already closed. `close` now answers once the browser has exited and lets the cleanup finish in the background. If the browser has not exited after 10 seconds, the answer says so instead of waiting.
- **Parallel replays no longer overwrite each other's report.** Two runs that finished in the same millisecond in one `.fastqa` folder (parallel CI workers) could both write `reports/<time>.html`, so one report was lost. The name is now claimed with an exclusive create, and a run that finds it taken adds its process id.
- **A page that is still arriving no longer breaks the result.** When a site loaded a new document right after a step and only its head had arrived, the snapshot failed with `Cannot read properties of null`. FastQA now waits for the document.

## 1.0.0 (2026-11-27)

First stable release. It adds continuous QA: FastQA observes the browser while steps run and reports what it noticed, without being asked. Everything from 0.3 keeps working; read "Compatibility and migration" below before upgrading a pipeline.

From this version on, the public interface is the eight tools and their parameters, the flow file format, the CLI commands and exit codes, and `.fastqa/config.json`. A breaking change to any of them needs a new major version. How this release was verified is in `docs/evolution-progress.md`.

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
- Tool calls to one server are queued instead of running concurrently against the same page, and they run in the order they arrive. A call that is cancelled while it waits never runs.
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
