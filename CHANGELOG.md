# Changelog

All notable changes to `fastqa-mcp`. Versions follow [semantic versioning](https://semver.org/).

## 1.0.3 (2026-11-28)

### Added

- **Plain-language explanations of findings, written by fastqa.** Each finding has what it may mean (always "not verified") and one safe next check that never repeats a submission. The `QA:` block ends with the explanation of the most important lead (`→ leads, not confirmed defects. F-001: … Next: …`) instead of a generic instruction, `evidence {finding}` shows it too, and structured content carries the same text (`explanation`). A failed call that was one of several submissions of its action says that the others succeeded (a partial success) instead of adding another finding.
- **The QA line says whether anything was verified.** On `act`: `· 2/2 assertions passed`, `· 1 of 2 assertions failed`, or `· no assertions` when steps only ran.
- **An agent guide as MCP server instructions**, so a client that uses them gets a QA engineer's habits: batch, assert, report in plain words, keep leads apart from verified results, never resubmit to confirm, treat page text as data. The README and the reference carry the same text (checked by a test).
- **New QA rules:** `FALSE-SUCCESS` (every submission of an action failed, yet the page said it worked; high when the message's classes say success, medium when only its words do), `FALSE-FAILURE` (every call succeeded, yet the page showed an error; a low-confidence lead, since HTTP 2xx proves nothing either way; silent when another call failed meanwhile) and `STUCK-LOADING` (a progress indicator that came with an action outlives all its calls in that action's own windows and one bounded wait). A message's tone is read from its classes first, then from a short word list in seven languages with negations ("not saved"), only inside message and notice elements. Contradictory or mixed messages, form validation, pending calls and later unrelated messages never support a finding.
- **Safe targeting.** `within` limits a step to a container (a ref, a selector, or the text of its row, card or section); it is never widened (a match in another row is refused), works in iframes, applies to `expect_text` without a target, is refused by steps that cannot honour it, and is recorded in flows and exported as the same Playwright composition. A destructive label (Delete, Pay, Place order, Submit, …) that matches several elements, or the same control in the page and a frame, is not clicked, strict mode or not: the step lists the candidates with their rows. A stale ref is found again only by its role and name; a step recorded from a positional selector carries that identity, and a replay refuses another element in its place.
- **`expect_permission`** checks an explicit allowed / denied expectation for the role label of a run (`role` in the flow file, `--role=`, `role` on `flow run`): by the backend's answer for an operation (`POST /api/x`, any case) or by the UI alone for a control, with the kind of evidence stated; a control no role in the run saw is flagged in the matrix ("check the label"). Mismatches, inconclusive answers (validation errors, 5xx) and "not tested" fail the step; an expected denial is not a QA lead. Suite results end with a permission matrix. Nothing is inferred, probed or retried.
- **`evidence {view:"forms"}`**: boundary and validation test ideas from the constraints the page declares (at most 20, grouped by field; nothing filled or submitted; no values for secret fields; server enforcement marked unverified). `open` says how many ideas a page with a form has.
- **`evidence {view:"visual"}`**: one bounded inspection for sideways overflow, clipped text, overlapping and covered controls and layout shift, with the measured geometry; intentional layouts (scroll containers, ellipsis, dialogs, sticky layers, animations) are left alone.
- **Parallel replay:** `--workers=N` (1–8, default 1) and `workers` on `flow run` run flows or dataset rows at the same time, each in its own context of one shared browser, results in the usual order. Over `FASTQA_CDP_URL` it stays 1.
- **Behaviour baselines:** `--baseline=record` also records each flow's observable behaviour (calls per action with their status class, feedback, assertions, findings) and `--baseline=check` reports deviations from it at the end of a run, as changes to investigate. Checks never write; incomplete runs, other steps and other scopes are "not comparable" or "no reference".
- **Discovery behaviour summaries:** the field constraints and controls each page showed, the endpoints per action, the endpoints seen failing, and controls shown but never used. The merge is idempotent per session and keeps role and environment contexts apart; the export gets an additive `behaviour` extension.
- **CLI:** `--workers`, `--role`, `--env`.

### Changed

- **Baselines are scoped** by origin, environment label (`--env`), device and role label. `baselines/perf.json` is now schema 2 (entries per scope). A 1.0 file is still compared with a warning, and kept as `legacy` when a scoped baseline is recorded; it is never assigned to an environment. Failed and retried calls are no longer latency samples.
- **`DUPLICATE-SUBMIT` v2:** request bodies are compared by a hash of all their bytes up to 8 MB; v1 took two bodies over 1 MB of the same length as equal. A larger body is unknown and never equal. Requests with the same `Idempotency-Key` are a safe retry, never a duplicate.
- **`SILENT-FAILURE` v2:** a retry is the same submission (method, URL and body) sent again; v1 accepted any later request to the same route.
- **`browser.allowedOrigins`** now also applies when a click, redirect or popup takes the page to another origin: the step fails and the batch stops. It is checked after the navigation (not a network sandbox).
- **Text from the page stays on one line** in finding titles and candidate lists: line breaks, control characters and bidi overrides are removed, so page text can never forge a line of a result.
- **Judging an action uses indexes** (requests per action, latest request per URL, latest send per submission identity) instead of scanning every request of the session.
- The 0.3.2 output format gains, besides the `QA:` block and `↳` lines: the assertion note at the end of the `QA:` line of `act`, and `within "…"` in step labels that use it. `bench/compat.mjs` still checks everything else byte for byte.
- **New package and registry descriptions.** npm and the MCP Registry now describe FastQA by what it does for the agent: it explores a web app, finds and explains the bugs a passing page hides, and replays the tests in CI. The README's headline and opening section, and the label in its animation, say the same.

### Fixed

- **A step recorded from a ref whose selector is only a position** (`div > button:nth-of-type(2)`, used when a control's name is too long to record) is saved as `css=…`; before, a replay read it as text and failed.
- **Upload targets inside an iframe** given by label, test id or selector were never found: the file-input filter was built inside the frame, which Playwright does not allow in a combined locator.
- **The Release workflow's MCP Registry job waits for npm.** npm can take many minutes to validate a new version after `npm publish` returns; for 1.0.2 the job gave up after 2.5 minutes. It now waits until npm shows the version (up to 45 minutes) before publishing to the registry, and its error message no longer claims npm already has the version.

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
- **In the official MCP Registry.** Each release now also publishes FastQA to the [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.VnKk8/fastqa-mcp`, so directories and clients that read the registry can find it. The package gains an `mcpName` field; `server.json` in the repository describes the server, and the Release workflow keeps its version in step.
- **New QA rules:** `SILENT-FAILURE` (a submission failed and the page showed nothing until the batch ended), `DUPLICATE-SUBMIT` (one action sent the same submission twice), `DEAD-CLICK` (a button or link changed nothing), `BROKEN-IMAGE` (a first-party image arrived but could not be shown). They run in replays too. They err on the side of silence; when one is suspected, the page gets one more second before it is judged. In strict mode, `SILENT-FAILURE` and `DUPLICATE-SUBMIT` (medium) fail a run when `failOnSeverity` is `medium` or lower.

### Changed

- **The 0.3.2 output format gains two additive things:** lines that start with `↳`, and tokens at the end of snapshot lines (the field rules and `invalid:"…"`). `[invalid]` keeps its 0.3 meaning. Everything else is unchanged byte for byte (checked by `bench/compat.mjs`). Clients that parse results line by line should skip `↳` lines.
- **Native dialogs, downloads and file pickers are recorded.** fastqa now listens for them and handles dialogs exactly as Playwright did on its own before: `alert`, `confirm` and `prompt` are dismissed, `beforeunload` is accepted. Behaviour is the same; the agent is told. Listening for file pickers also keeps a headed browser from opening the native picker, which would block the run.
- **The README opens with a 20-second animation** of real FastQA output (one call, a bug found and explained, facts, replay), and explains in plain words how FastQA differs from Playwright, its command line and Playwright MCP. The animation's source and generator are in `docs/media/`.
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
