# FastQA-MCP evolution: execution ledger

This is the record of the work that became 1.0.0: what was built, how it was verified, and the decisions taken on the way. It followed a roadmap and an implementation plan (revision 3, tickets FQA-001 to FQA-012). Those two planning documents were removed from the repository before the release at the maintainer's request; "the plan" below refers to them. Baseline: `docs/evolution-baseline.md`.

Branch `evolution/v1-roadmap`, cut from `41815d3` (0.3.2), pushed on 2026-11-27 as pull request 1 of `VnKk8/FastQA-MCP`. **Nothing is tagged, published or released**: the release is the maintainer's step, see "Pull request, CI on Linux and release as 1.0.0".

## Ticket status

| Ticket | Scope | Status | Verified by |
|---|---|---|---|
| FQA-001 | Baseline, compatibility harness, fault fixtures | verified | `docs/evolution-baseline.md`, `bench/compat.mjs` (50 checks), fixtures in `bench/demo-server.mjs` |
| FQA-002 | Scoped actions and request lifecycle | verified | `bench/observe.mjs` (38), correlation tests in `bench/unit.mjs` |
| FQA-003 | Privacy and bounded capture | verified | `bench/privacy.mjs` (37), redaction and config tests in `bench/unit.mjs` |
| FQA-004 | Locator and session safety | verified | `bench/safety.mjs` (34), `bench/cdp-tls.mjs` |
| FQA-005 | Rule registry and finding lifecycle | verified | rule and dedup tests in `bench/unit.mjs`, `bench/observe.mjs` |
| FQA-006 | Policy, compact MCP integration, profiles (incl. 006a) | verified | `bench/policy.mjs` (58), OpenCode smoke run |
| FQA-007 | Evidence bundle, session artifacts, reports | verified | `bench/artifacts.mjs` (46), `bench/privacy.mjs`, `bench/safety.mjs` |
| FQA-008 | Replay and Playwright export parity | verified | `bench/artifacts.mjs` (exported specs run under `@playwright/test`), `bench/compat.mjs` |
| FQA-009 | Route and endpoint graph | verified | `bench/unit-discovery.mjs` (12), `bench/artifacts.mjs` |
| FQA-010 | Contract and business rules | verified | `bench/unit-contract.mjs` (21), `bench/policy.mjs`, `bench/privacy.mjs` |
| FQA-011 | Performance and state checks | verified | `bench/policy.mjs`, `bench/unit.mjs` |
| FQA-012 | Integration and v1.0 readiness | verified with stated limits | this file, sections "v1.0 readiness gate" and "Independent review" |

"Verified" means: the listed tests were run on this machine and passed, and I read their output. Limits are listed under "Not verified" below.

## Acceptance journeys (plan section 11)

| Journey | Result | Where |
|---|---|---|
| Normal interaction: success UI plus a hidden 500, no extra tool call | pass | `observe.mjs` section 1 |
| Healthy batch: no findings, no history dump, 0.3 output intact | pass | `observe.mjs` section 2, `compat.mjs` |
| Delayed failure: attributed to the starting action; late finding in the next result; partial state explicit | pass | `observe.mjs` sections 3 and 4 |
| Negative test: expected 422 is not a misleading candidate; explicit assertions unchanged | pass | `observe.mjs` section 5, `policy.mjs` section 1 |
| Business response: HTTP 200 with `success:false` is a candidate with capture, "not evaluated" without | pass | `privacy.mjs` sections A to D |
| Discovery: bounded observed graph, stable edges and counts, no coverage claim | pass | `artifacts.mjs` section 4 |
| Evidence and replay: targeted redacted evidence, candidate bug draft, replay verified separately | pass | `artifacts.mjs` section 1 |
| CI strict: same policy in MCP and CLI, non-zero exit, partial handling | pass | `policy.mjs` section 3 |
| Performance: slow or repeated endpoint flagged only under an explicit policy | pass | `policy.mjs` sections 4 and 5 |
| Privacy and isolation: no canaries in any output, no cross-run leakage, bounded retention | pass | `privacy.mjs`, `safety.mjs` sections 3 and 4 |

## Test results (final run)

`npm test` on Windows 11, Node v24.11.1, Chromium 143 headless: exit code 0. The same command passes in CI on Ubuntu 24.04 with Node 20, 22 and 24 (commit `b174bd5`; the runs before it are described under "Pull request, CI on Linux and release as 1.0.0").

| Suite | Result |
|---|---|
| Unit: `bench/unit.mjs`, `unit-review.mjs`, `unit-contract.mjs`, `unit-discovery.mjs` | 90 of 90 |
| `bench/e2e.mjs` (0.3 suite, unchanged assertions) | ALL CHECKS PASSED |
| `bench/export-check.mjs` (0.3 suite) | exported spec: 1 passed |
| `bench/qa-features.mjs` (0.3 suite) | ALL QA FEATURE CHECKS PASSED |
| `bench/compat.mjs` | 50 of 50 |
| `bench/observe.mjs` | 38 of 38 |
| `bench/privacy.mjs` | 37 of 37 |
| `bench/policy.mjs` | 58 of 58 |
| `bench/safety.mjs` | 40 of 40 |
| `bench/artifacts.mjs` | 46 of 46 |
| `bench/review.mjs` (regressions for the independent review) | 24 of 24 |
| `bench/package-smoke.mjs` (`npm run test:package`, not part of `npm test`) | 29 of 29 |
| `bench/cdp-tls.mjs` (`npm run test:env`, not part of `npm test`: attaches to a running Chromium, and makes a throwaway certificate with `openssl`) | 15 of 15 |

Test order was not always "red first". `bench/observe.mjs` was written before the implementation and failed 27 of 38 checks against the 0.3.2 build. `bench/unit-review.mjs` (20 of 20 failing first) and `bench/review.mjs` (18 of 24 failing against the pre-fix build) were written before the review fixes. `bench/unit.mjs`, `policy`, `privacy`, `safety` and `artifacts` were written after the code they cover; they found the defects listed below, which were then fixed.

Defects found by the tests and fixed:

- Windows: two workers replacing `reports/latest.html` at the same moment made `rename` fail with `EPERM`. `writeAtomic` now retries briefly and bounded; `latest.*` can no longer fail a run. Found by `safety.mjs`, then 4 clean runs in a row.
- The demo server ignored query strings on `/login`, `/account` and `/checkout` (404). Fixed in the fixture.
- `npm run demo` never started on Windows. Fixed.
- Polling was attributed to the action that happened to run (reported by the discovery agent). Added periodic-traffic detection and a unit test.
- `goto` navigations were marked `inferred` instead of `direct` in navigation events. Fixed.
- A test fixture taught something real: Chrome serializes identical concurrent GETs of one URL (its cache lock), so a polling fixture with a cacheable URL queued requests without bound. The fixture's polls are now `no-store`. FastQA itself was not at fault.

## Performance against the baseline

Same harness, same machine, same fixture (`node bench/perf.mjs --samples=30 --replays=30`). Raw data: `docs/baseline/perf-0.3.2.json`, `docs/baseline/perf-current.json`.

| Measure | 0.3.2 | Now | Change | Gate |
|---|---|---|---|---|
| Tool calls per journey | 2 | 2 | 0 | unchanged: pass |
| Warm browser-side time, median | 1,481.4 ms | 1,484.1 ms | +0.2% | at most +10%: pass |
| Warm browser-side time, p95 | 1,513.4 ms | 1,526.2 ms | +0.8% | at most +20%: pass |
| Cold run (with browser launch) | 2,491 ms | 2,445 ms | -1.9% | not gated |
| `open` response, clean | 287 chars | 318 chars | +10.8% | at most +20%: pass |
| `act` response, clean | 982 chars | 1,014 chars | +3.3% | at most +20%: pass |
| Tool schemas | 5,663 bytes (~1,416 tokens) | 7,348 bytes (~1,837 tokens) | +29.8% | not gated, see below |
| Replay, median / p95 of 30 | 1,396 ms / 1,421 ms | 1,404 ms / 1,431 ms | +0.6% / +0.7% | not gated |
| Server RSS after the run | 114.5 MB | 123.9 MB | +8.2% | not gated |

Notes:

- **Tool schemas grew by about 420 tokens.** The plan asks to measure this, not to gate it. `evidence` gained 11 optional parameters, `act` two, `flow` one, and two descriptions gained a sentence. Descriptions were trimmed once (from +42% to +30%) and two filters the plan did not ask for were removed. Clients that resend tool definitions every turn pay this each turn.
- These numbers were measured after the review fix pass with nothing else running. The arrival-order queue (see "Pull request, CI on Linux and release as 1.0.0") was added later; a re-run of the same command after it gave an `open` median of 200 ms, an `act` median of 1,285 ms, a replay median of 1,405 ms (p95 1,439 ms), the same response sizes and 123.8 MB, which is the same within noise.
- **Replay outliers.** Some earlier runs showed one or two replays of about 2.0 s among 30. Interleaved runs of the committed 0.3.2 build and the new build showed the same kind of outlier in 0.3.2 (max 1,699 ms) and none in the new build (max 1,447 ms and 1,426 ms), so it is machine noise, not a regression. The outliers appeared while review agents were using the machine.
- **CPU time** was not measured (no dependency-free way for a child process on Windows).
- `npm run bench` (one run): `@playwright/mcp` 10 calls, 3,154 ms; fastqa 2 calls, 2,435 ms; replay 1,402 ms. The end-to-end estimates (33.2 s and 8.4 s) assume 3 s per model turn and are not measurements of a model.

## v1.0 readiness gate (FQA-012)

| Gate | Result |
|---|---|
| All unit, integration, MCP stdio, replay, export, CLI, reporting, privacy, resource and isolation tests | pass (table above) |
| The eight tools, legacy inputs and outputs, flows, flags, assertions | pass: `compat.mjs` requires output identical to 0.3.2 apart from the `QA:` block |
| Package contents and executable | pass: tarball has 29 files (91.8 kB packed, 302 kB unpacked; 0.3.2 had 10 files, 26.5 kB), only `dist/`, `README.md`, `LICENSE`, `package.json`; installed into an empty project, `--version`, `--help`, `config`, MCP server and CLI replay work |
| Tracked `dist/` matches the source | pass locally (`npm run build` leaves no diff after commit) and in CI (`git diff --exit-code -- dist`) |
| MCP client: OpenCode | **pass, real client.** OpenCode 1.19.0, `opencode mcp list` reports `fastqa connected`; `opencode run` with the free model `opencode/big-pickle` called `fastqa_open`, `fastqa_act`, `fastqa_evidence`, `fastqa_flow` (save, run) and `fastqa_close` against the local build and reported the QA line and finding. Transcript: `docs/baseline/opencode-smoke.txt`. Edit, bash and webfetch were denied in that temporary project |
| MCP client: a second one | **not verified.** Claude Code CLI 2.1.302 found the server from a temporary `.mcp.json` but showed "Pending approval". Approving a project server is the user's decision, so it was not approved. The official MCP SDK stdio client is the second client actually exercised (every e2e suite) |
| Performance comparison | pass (table above) |
| Secret handling, bounded stores, artifact cleanup, path safety | pass after one fix pass; 1 Critical and 16 Important review findings fixed and covered by tests, see "Independent review" |
| Docs: README, reference, config example, CLI usage, changelog, migration notes, benchmark method | done; they describe 1.0.0 (the "unreleased" marks were removed when the maintainer decided on the version) |

**Readiness statement.** The implementation is complete against the plan. It was verified on Windows (Node 24) and, through the pull request's CI, on Ubuntu 24.04 with Node 20, 22 and 24. On 2026-11-27 the maintainer decided to release it as 1.0.0. The items under "Not verified" remain open and are stated as limits.

## Verified late

Three items were first listed as not verified and then tested: attaching to a running Chromium over CDP with a tab fastqa does not drive, HTTPS with an invalid certificate (accepted with a warning without a config file, rejected with a hint once a config file exists, both overrides), and the age rule of bundle retention. See `bench/cdp-tls.mjs` and `bench/safety.mjs`.

## Pull request, CI on Linux and release as 1.0.0

The branch was pushed on 2026-11-27 and opened as pull request 1. CI runs `npm test` on Ubuntu 24.04 with Node 20, 22 and 24 and checks that the committed `dist/` matches the build. It was the first run of this work on Linux, and it took four runs to get green:

| Run | Commit | Node 20 | Node 22 | Node 24 | What failed |
|---|---|---|---|---|---|
| 1 | `e048579` | fail | fail | fail | `compat`: the 0.3.2 baseline was recorded on Windows and contains `\` in paths below the data directory, so no Linux output could match it |
| 2 | `5f8c730` | fail | pass | pass | `artifacts`: "polling is mostly background" got 7 of 15 on a slower runner |
| 3 | `5ce122e` | pass | pass | fail | `safety`: a snapshot sent after two `act` calls ran before them |
| 4 | `b174bd5` | pass | pass | pass | nothing |

What each failure was, and what was done:

- **Run 1, a test defect.** The comparison now brings paths below `<FASTQA_DIR>` to forward slashes on both sides (`slashes` in `bench/capture-baseline.mjs`, unit-tested). The recorded baseline file is unchanged.
- **Run 2, a marginal test.** The first four polls of a page are attributed to the nearest action by design (ruling 3), so a 900 ms window measured mostly warm-up: 9 of 17 here, 7 of 15 on the runner, against a bar of one half. The window is now 2.5 s (33 of 38 here) and the bar is unchanged (ruling 28).
- **Run 3, a product defect.** When several tool calls were read at once, the SDK's asynchronous argument validation let a call with a small schema run ahead of earlier ones. Reproduced deterministically by writing three requests in one write: answered in the order 13, 11, 12, and the snapshot saw the value from before both batches. Fixed in `src/ordering.ts` (ruling 30). Regression tests: `safety.mjs` section 2b (4 of 40 checks failed on the build before the fix, all pass after) and a unit test of the queue.

Job logs need a GitHub sign-in, so from run 2 on the failures were read from annotations that the CI step now writes (`bench/ci-annotate.mjs`, ruling 29).

Two of the three failures were timing-dependent and showed on one Node version only, in different runs. One green run of three jobs does not prove the suite is free of such tests; the check runs of later commits on the pull request are the continuing evidence.

**Release as 1.0.0.** Decided by the maintainer on 2026-11-27. The docs and the changelog describe 1.0.0. `package.json` stays at 0.3.2 on the branch because the release workflow sets the version (ruling 26). To publish: add the label `release:major` to the pull request before merging it, or merge it and run the "Release" workflow by hand with the exact version `1.0.0`. Nothing was tagged or published from this work.

## Not verified

- **Timing-sensitive tests on slow CI runners.** Several scenarios depend on delays (a 2.2 s response crossing a 1.5 s settle, polling every 150 to 250 ms). One of them did fail on a CI runner and was fixed (see the next section). The others have margins of several hundred milliseconds and passed on every CI run so far; a slow shared runner could still make one of them flaky.
- **macOS.** No test ran there.
- **A second real MCP client** (see the gate above).
- **Symlink escape** for contract spec paths: implemented (realpath containment) but not tested; creating symlinks needs elevation on this machine.
- **Service workers, WebSockets, cross-browser.** Out of scope and documented as limits.

## Independent review

Two reviewers with a fresh context (no knowledge of my conclusions) read the diff against `41815d3`: one for privacy and resource bounds, one for backward compatibility and the correctness of correlation, detection and policy. Both reproduced most findings with scratch scripts. They found 1 Critical and 16 Important issues. All were fixed in one pass, each with a test that failed first.

Regression tests: `bench/unit-review.mjs` (20 tests; all 20 failed before the fixes) and `bench/review.mjs` (24 browser checks; 18 failed against the pre-fix build `f86b404`, run through `FASTQA_TEST_DIST`).

| # | Finding | Severity | Fix | Test (red, then green) |
|---|---|---|---|---|
| P1 | A query parameter **name** from any page became the label of a learned secret and was spliced into flow files, exported specs and JSON artifacts: a page could inject steps into a saved flow or code into a spec | Critical | Two kinds of secrets. Values the user supplies through `{{name}}` keep that name (always a plain word). Values seen in the app are replaced by a fixed mask and never rewrite a flow or a spec | `unit-review` P1; `review.mjs` injection block (the pre-fix build wrote a corrupted flow) |
| P2 | A redaction regex was quadratic: 80 KB of hostile console text blocked the event loop for seconds | Important | Every pattern is bounded; inputs are cut before redaction | `unit-review` P2 (5 hostile inputs, each under 400 ms) |
| P3 | Redacting already-serialized JSON could produce invalid JSON (artifacts, structured content) | Important | Values are sanitized first (`redactor.deep`), then serialized | `unit-review` P3 |
| P4 | Known-secret replacement failed open: learned values were capped and could push out the bound password; escaped and clipped forms were missed; a business-rule finding copied a raw response value | Important | Bound secrets are never dropped (learned ones are an LRU of 500); escaped and clipped forms are matched; findings show the sanitized value | `unit-review` P4 (two tests) |
| P5 | URL credentials in free text, JSON-looking secrets in console text, children of secret-named objects were not masked | Important | Added bounded patterns and deep masking | `unit-review` P5 |
| P6 / C8 | `author`, `passengers`, `discard` counted as secret names; after opening `…?author=tolkien` snapshots showed `{{author}}` and `flow save` wrote a flow that could not replay | Important | Secret names are matched by whole words; learned values no longer touch flows | `unit-review` P6; `review.mjs` injection block replays the saved flow |
| P7 | Unbounded growth: findings, call counters, background map, CLI kept every observer, no length cap on request URLs | Important | Caps on all of them (500 findings, counted when exceeded) | `unit-review` P7 |
| P8 | Control characters from the page could make JUnit XML malformed | Important | Removed before escaping | `unit-review` P8 |
| C1 | Strict finalization counted requests that started after the run ended: an app that polls failed strict CI as "incomplete" | Important | Only the requests open when the run ended are waited for and judged | `review.mjs` polling block (0 of 3 runs passed before, 3 of 3 after) |
| C2 | A popup that closed with a request still open left it pending forever: coverage stayed partial, strict replay timed out | Important | A closing page abandons its open requests; the page that is still open becomes active again | `review.mjs` popup block |
| C3 | A suppression matched by one occurrence suppressed the whole deduplicated finding, so an unsuppressed 500 on another resource id passed strict | Important | Suppressed and expected are counted per occurrence; any unexplained occurrence keeps the finding a candidate | `unit-review` C3 |
| C4 | `expect_request` marked only the first matching response as expected | Important | Every response of the batch that satisfies the assertion is marked | `review.mjs` negative-test block |
| C5 | A known failure that happened again printed "QA: clean" and passed the strict batch policy; a finding that was expected first and then recurred unexpectedly was never listed | Important | Recurring findings are listed again ("known finding seen again", `×2 (again)`) and count for the batch policy | `unit-review` C5 (two tests); `review.mjs` recurrence block |
| C6 | Background and periodic heuristics misfired on action-driven traffic (four identical steps, single-endpoint APIs such as GraphQL); `PERF-CALLS` skipped ambiguous requests; a later background occurrence overwrote the association | Important | A request that starts while the step itself executes is never demoted; ambiguous requests count under their first candidate action; the first association is kept | `unit-review` C6 (four tests) |
| C7 | Context-level listeners saw service worker traffic and, over CDP, other tabs: legacy `expect_no_errors` could fail on traffic 0.3 never saw; page listeners were not re-bound after `open fresh` on CDP | Important | Service worker requests are ignored; over CDP only driven pages are observed; page listeners are re-bound | `review.mjs` service worker block; `cdp-tls.mjs` for the CDP part (4 of its checks failed on the pre-fix build) |
| C9 | The exported `expectNoErrors` checked instantly, while replay lets the page settle after each click: a failure arriving 200 ms later failed replay but passed the spec | Important | The helper waits (bounded 1.5 s) for open requests first; the remaining difference is listed in `parity.notExported` | `review.mjs` export block (real `@playwright/test` run) |

Minor findings fixed along the way: the `late` flag was set on findings that arrived between the end of a batch and its own result; a bundle written mid-session was not refreshed at close; the bundle stream could be written after it ended; a compressed response was sized by its wire length; the reader slot was freed before the read ended; a throwing rule could become an unhandled rejection; retention could remove a long-running session's bundle; a path pattern with several wildcards was polynomial; a flow name with a newline escaped the comment in an exported spec; `privacy.secretKeys: [""]` made every key secret; `safe()` had changed the file name of flows that start with a dot; `flow export` errors had stopped being MCP errors.

### Deferred minors

Not fixed, by decision. None is a regression against 0.3.2.

- `flow run --data=<path>` accepts any path and shows up to 40 characters of each row in the run name (0.3 behaviour).
- `expect_*` runs a regex the test author wrote against page text of any length (0.3 behaviour).
- The "known background endpoint" mark (two starts without an action) never decays during a session. Requests that start while a step executes are no longer affected by it.
- Tool results still print absolute paths for `report:` and `screenshot saved:` (ruling 12).
- An interactive session's `findings` list is capped at 500; beyond that findings are counted, not stored.

## Changed and new files

- Review regressions: `bench/unit-review.mjs`, `bench/review.mjs`.
- New source: `src/config.ts`, `src/dirs.ts`, `src/exec.ts`, `src/ordering.ts`, `src/services.ts`, `src/version.ts`, `src/observation/{types,store,observer}.ts`, `src/correlation/actions.ts`,
  `src/quality/{engine,summary,baseline}.ts`, `src/privacy/redact.ts`, `src/evidence/{query,bundle}.ts`, `src/discovery/graph.ts`, `src/contract/openapi.ts`, `src/util/paths.ts`.
- Changed source: `src/session.ts`, `src/runner.ts`, `src/flows.ts`, `src/index.ts`, `src/report.ts`. Unchanged: `src/snapshot.ts`, `src/a11y.ts`.
- Tests and tools in `bench/`: `lib`, `unit`, `unit-contract`, `unit-discovery`, `compat`, `observe`, `privacy`, `policy`, `safety`, `artifacts`, `package-smoke`, `perf`, `capture-baseline`, `ci-annotate`, fixtures in `demo-server.mjs`, `fixtures/`.
- Docs: `README.md`, `docs/REFERENCE.md`, `docs/config.example.json`, `CHANGELOG.md`, this file, `docs/evolution-baseline.md`, `docs/baseline/`.
- `package.json`: `ajv` declared as a direct dependency (it was already installed through the MCP SDK); scripts `test`, `test:unit`, `test:e2e`, `test:package`, `perf`.

Work split: the OpenAPI checker (`src/contract/openapi.ts`) and the discovery graph (`src/discovery/graph.ts`) were written by two parallel agents in separate git worktrees against frozen interfaces, then cherry-picked, wired and tested here. Their worktrees and branches (`worktree-agent-*`) still exist under `.claude/worktrees/` and can be deleted.

## Rulings

Decisions taken where the plan left a choice or reality differed. Each has its cost if wrong.

1. **Ledger.** The plan asks for `docs/evolution-progress.md`; the executing-plans skill asks for its own workspace scripts and ledger. This file is the ledger. Cost if wrong: none for the product.
2. **Listeners moved to context level.** The plan says "bind early enough for new pages". Page-level listeners miss a popup's first requests, so `request`, `response`, `requestfinished`, `requestfailed`, `console` and `weberror` are bound once per browser context. Cost if wrong: requests from service workers have no page; they are attributed to the active page.
3. **Association heuristics.** Assertions and waits are passive and never own a request. A request that starts while an interactive step itself executes (or within 100 ms of its return) is `inferred` to it and is never demoted to background. One that starts later, during the settle phase or within a 1.5 s window after the latest interactive step, is `inferred` to that step with the delay stated, unless the endpoint is known background traffic (2 or more earlier starts without an action) or fires at a steady rhythm (4 starts at near-constant intervals): then it is `ambiguous`. It is also `ambiguous` when another recent action still has requests in flight. `direct` is used only for the navigation a `goto` asked for. Cost if wrong: a timer-driven request of an older, already-settled action is attributed to the newer one; the confidence stays `inferred`, never more. A poll that happens to start in the 100 ms after a step is attributed to that step.
4. **Raw URLs stay in process memory for explicit assertions.** `expect_request` may match a query string, so `Session.log` keeps the raw URL for matching only. Everything retained in the event store, printed or written is sanitized. Cost if wrong: a secret in a query string lives in RAM until the log rotates (2,000 entries).
5. **Page URL keeps ordinary query values.** The snapshot `url:` line is the agent's navigation state, so only secret-looking parameters are masked there. Network URLs lose all query values unless a parameter is allowlisted in `privacy.keepQueryParams`. Cost if wrong: personal data in a page URL query is shown to the agent, as in 0.3.
6. **Secret values shorter than 6 characters are not registered.** Replacing a short value everywhere would shred ordinary text ("wrong" became `{{password}}` in a test). Cost if wrong: a very short secret that the page echoes is not hidden.
7. **NET-4XX severities.** 401 and 403 are `info` (apps probe sessions); other 4xx are `low`. A passing `expect_request` on a 4xx/5xx marks that response `expected`. Info findings are counted, not listed inline. Cost if wrong: an unexpected 403 is easy to miss in the inline summary; it is still in `evidence view=findings`.
8. **Payload capture skips responses of unknown size** unless `capture.allowUnknownLength` is set. Playwright cannot stream a body, so this is the only way to keep the bound honest. Cost if wrong: on APIs that use chunked encoding, body-based rules report "not evaluated" until the option is turned on.
9. **TLS.** Without a config file the 0.3 behaviour stays (invalid certificates accepted) and a warning goes to stderr when an HTTPS site is opened. With a `.fastqa/config.json` the default is secure; `browser.ignoreHTTPSErrors` or `FASTQA_IGNORE_HTTPS_ERRORS` opts in. Cost if wrong: adding a config file to a project that tests a self-signed staging host makes `open` fail until one line is added; the error says which line.
10. **Structured content is opt-in** (`mcp.structuredContent` or `FASTQA_STRUCTURED=true`). Some clients forward only `structuredContent` to the model when it is present, which would drop the page diff. The text result is always complete. Cost if wrong: clients that could use typed data must opt in.
11. **No ninth tool.** Bundles and bug drafts are reached through `evidence {report:true}`. Cost if wrong: one more parameter on `evidence`.
12. **Absolute paths stay in MCP text results** (`report:`, `screenshot saved:`) because 0.3 clients read them. Inside artifacts (reports, bundles, Markdown) paths are relative. Cost if wrong: an absolute local path is visible to the model, as in 0.3.
13. **OpenAPI: JSON only.** YAML would need a new dependency. A YAML or Swagger 2.0 document is skipped with a warning. Cost if wrong: teams with YAML specs must convert them first.
14. **A server error is reported once.** `CONTRACT-STATUS` is not raised for 5xx responses; `NET-5XX` already covers them. Cost if wrong: an API whose contract documents a 5xx gets no contract check for it.
15. **Baselines are keyed by method and normalized path, without the origin**, because test environments change host and port. Cost if wrong: two first-party origins that share a path share a baseline.
16. **Tool schema size is reported, not gated.** See the performance notes. Cost if wrong: about 420 more tokens per turn in clients that resend tool definitions.
17. **The README and reference describe 1.0.0.** They marked the new sections "(unreleased)" until the maintainer decided on the version (2026-11-27); the marks were then removed and the benchmark table re-measured on the current build. Cost if wrong: between merging the pull request and the npm publish, the GitHub README describes features that npm `latest` (0.3.2) does not have yet.
18. **Session bundles for flow runs are written by the run, interactive ones at session end** (close or fresh context) when `artifacts.enabled`. Observations are streamed to disk during the session; the other files and the manifest are written at the end. Cost if wrong: a crashed interactive session leaves `observations.jsonl` without `summary.json`; retention removes such a directory after a day.

19. **Two kinds of known secrets.** A value the user supplies through `{{name}}` is shown as that placeholder, also in flows and specs. A value seen in the application under test is shown as `•••` and never rewrites a flow or a spec. Cost if wrong: a secret that appears in a recorded `goto` URL of a flow stays in the flow file, as in 0.3.
20. **Secret-looking names are matched by whole words** (`password`, `access_token`, `apiKey`, `sessionId`, `card_number`), not by substring. Cost if wrong: an unusual name such as `pwdhash2` is not recognised until it is added to `privacy.secretKeys`.
21. **A compressed or chunked response counts as unknown size** for payload capture. Its decoded size cannot be bounded before reading it. Cost if wrong: most gzip'd APIs need `capture.allowUnknownLength: true` before body-based rules run.
22. **Strict finalization judges only the requests that were open when the run ended.** Later traffic is not waited for. Cost if wrong: a failure in a request that starts after the last step is not part of that run's verdict (it is still recorded if it arrives during the drain).
23. **A recurring finding is listed again** and counts for the batch policy in strict mode. Cost if wrong: a failure that repeats in every batch is listed in every result (one line each time).
24. **`run` rejects unknown options** (exit 2), where 0.3 ignored them. A typo in `--mode=strict` must not silently run in observe mode. Cost if wrong: a script that passed an unsupported flag to 0.3 now stops.
25. **Reports and failure screenshots are pruned** to the newest 200 each by default. The plan asks for bounded artifacts; 0.3 kept everything. Cost if wrong: a long-lived workspace loses reports older than the newest 200 unless `artifacts.maxReports` is raised.
26. **`package.json` stays at 0.3.2 on the branch.** The release workflow sets the version (`npm version`), commits and tags it. Writing 1.0.0 by hand would make a `release:major` label publish 2.0.0, and an exact `1.0.0` input fail as "version not changed". Cost if wrong: a build from this branch reports 0.3.2 until the workflow has run.
27. **The changelog names the public interface** that semantic versioning applies to from 1.0.0: the eight tools and their parameters, the flow file format, the CLI commands and exit codes, and `.fastqa/config.json`. Cost if wrong: the maintainer may want a wider or narrower promise; it is one paragraph in `CHANGELOG.md`.
28. **The polling check got a longer window, not a lower bar.** The discovery check "polling is mostly background" failed on one CI runner (7 of 15). The attribution rule was left as it is (ruling 3), the threshold stayed at one half, and the scenario now waits 2.5 s instead of 0.9 s so the steady state decides (33 of 38 here). Cost if wrong: in a session shorter than about a second, the first four polls of a page are attributed to the nearest action as `inferred`; that is the documented behaviour, not hidden by the test.
29. **CI lists failed checks as annotations.** The test step writes its output to a file and `bench/ci-annotate.mjs` turns failures into annotations on the pull request. Job logs need a GitHub sign-in; annotations do not. Cost if wrong: a failing run shows up to ten annotations; expected failures quoted inside passing checks are filtered out, and a new output format could slip past that filter.
30. **Tool calls run in arrival order.** Calls were already queued, but when several were read at once the SDK's asynchronous argument validation let a call with a small schema overtake earlier ones. A queue on the transport (`src/ordering.ts`) now hands calls to the server one at a time. A call cancelled while it waits never runs; at most 1,000 wait. Cost if wrong: a client that sends independent calls in parallel gets them answered strictly one after another (they could not overlap before either), and a tool call that never answers blocks the calls behind it, as before.
31. **The setup examples show what was checked, and say where they could not be.** The README's Claude Code command and the `.mcp.json` it writes were run with Claude Code 2.1.302 on Windows (the server stays "Pending approval" there, so a live connection through Claude Code was not made). Both OpenCode layouts (`mcp.servers.<name>` from the current OpenCode docs, and the older `mcp.<name>`) were connected with OpenCode 1.19 using `npx -y fastqa-mcp`. The file locations for Claude Desktop, Cursor and VS Code come from their documentation and were not run. Cost if wrong: a client changes its format and an example stops matching; the README says the client's own documentation wins.

## Blockers

None. The only item stopped by a deliberate guardrail is approving the server in Claude Code's CLI, which is the user's decision.
