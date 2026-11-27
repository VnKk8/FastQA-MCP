# FastQA-MCP evolution: baseline (FQA-001)

Recorded before any source change of the roadmap work. Everything here was measured or read from the checkout, not assumed.

- Baseline commit: `41815d3` (package version 0.3.2, branch `main`)
- Work branch: `evolution/v1-roadmap` (local only)
- Machine: Windows 11 Pro x64, Node v24.11.1, npm 11.7.0
- Browser: Playwright 1.57.0 bundled Chromium headless shell 143.0.7499.4
- Fixture: the bundled demo shop (`bench/demo-server.mjs`) on `127.0.0.1`, random port

## Code map of 0.3.2

| Responsibility | File | Symbols |
|---|---|---|
| MCP tool registry (8 tools) | `src/index.ts` | `server.registerTool('open' / 'act' / 'snapshot' / 'screenshot' / 'audit' / 'evidence' / 'flow' / 'close')` |
| CLI replay | `src/index.ts` | `cli()` (`run <flow or *> --var= --data=`), `--version` |
| Browser owner, listeners, settle | `src/session.ts` | `Session.ensure`, `Session.attach` (page-level `console`, `pageerror`, `request`, `response`, `requestfinished`, `requestfailed`), `Session.settle`, `launch()` |
| Target resolution | `src/session.ts` | `Session.resolve`, `Session.candidates`, `Session.scopesFor`, `Session.listFrames` |
| Snapshots and diffs | `src/snapshot.ts`, `src/session.ts` | `snapshotInPage`, `domSettleInPage`, `deepTextInPage`, `Session.snapshot`, `Session.diff`, `Session.render` |
| Step execution and assertions | `src/runner.ts` | `runStep` (one `case` per step kind), `bind`, `STEP_KINDS` |
| Network and error log for assertions | `src/session.ts` | `Session.log` (`LogEvent`), `Session.mark`, `Session.since`, `Session.evidence`, `Session.takeEvidence` |
| Flow save, load, replay, export | `src/flows.ts` | `saveFlow`, `loadFlow`, `listFlows`, `runFlow`, `runSuite`, `exportFlow`, `loadDataset` |
| HTML and JUnit reports | `src/report.ts` | `writeReports` |
| Accessibility | `src/a11y.ts` | `auditA11y`, `renderA11y` |
| Tests | `bench/e2e.mjs`, `bench/export-check.mjs`, `bench/qa-features.mjs` | run by `npm test` after `tsc` |
| Benchmark | `bench/bench.mjs` | `npm run bench`: one pass of `@playwright/mcp` and one of fastqa |
| CI and release | `.github/workflows/ci.yml`, `.github/workflows/publish.yml` | Node 20/22/24 matrix, `git diff --exit-code -- dist`, release by workflow only |

Findings from reading the code (each became a ticket item):

- Two step loops existed: one in the `act` handler and one in `runFlow`. They had the same settle rule but were separate code.
- `Session.ensure` registered `context.on('page')` every time the page had to be re-created, so listeners could pile up.
- Listeners were page-level, so the first requests of a popup could be missed.
- `ignoreHTTPSErrors: true` was always on.
- `expect_request`, `expect_no_errors` and `expect_accessible` were exported to Playwright specs as comments.
- `npm run demo` never started on Windows (`import.meta.url` was compared with a `file://` string built by hand).
- Raw request URLs, including query strings, went into tool output and reports.

## Contracts captured from 0.3.2

Captured by `node bench/capture-baseline.mjs 0.3.2` (kept in the repo so it can be repeated):

- `bench/fixtures/legacy/tools-0.3.2.json`: the eight tool schemas exactly as `tools/list` returned them (5,663 bytes).
- `bench/fixtures/legacy/flows/legacy-shop.json`: a flow saved by 0.3.2 (12 steps, `{{base}}` and `{{password}}` placeholders).
- `docs/baseline/responses-0.3.2.txt`: normalized responses of `open`, `act` (pass and fail), `evidence`, `snapshot`, `flow save/show/run/list`, `close`, and the CLI (`exit=0` on pass, `exit=1` on a failed flow, `exit=2` on a missing flow, `--version`).

`bench/compat.mjs` replays the legacy flow and compares the current build with these files.

## Test baseline

`npm test` on `41815d3`: all pass.

| Script | Result |
|---|---|
| `bench/e2e.mjs` | `ALL CHECKS PASSED` |
| `bench/export-check.mjs` | exported spec: `1 passed` |
| `bench/qa-features.mjs` | `ALL QA FEATURE CHECKS PASSED`, CLI exit 1 on the deliberately failing data row |

No failing test existed before the work started.

## Performance baseline

`node bench/perf.mjs --samples=30` (3 warm-up runs discarded, then 30 warm samples; every sample opens a fresh context, logs in, adds to cart and switches currency: 1 `open` + 1 `act` with 9 steps). Raw result: `docs/baseline/perf-0.3.2.json`.

| Measure | 0.3.2 |
|---|---|
| Tool calls per journey | 2 |
| Browser-side time, warm, median | 1,481 ms |
| Browser-side time, warm, p95 | 1,513 ms |
| Browser-side time, cold (includes browser launch) | 2,491 ms |
| `open` response | 287 characters |
| `act` response (clean run) | 982 characters |
| Tool schemas (`tools/list`) | 5,663 bytes, about 1,416 tokens |
| Replay of the saved flow (`flow run`), median / p95 | 1,396 ms / 1,421 ms |
| Server process RSS after the run | 114.5 MB |

`npm run bench` on the same commit: `@playwright/mcp` 0.0.86 needed 10 tool calls and 3,174 ms of tool time; fastqa needed 2 calls and 2,457 ms; replay took 1,402 ms. The "33 s vs 8.5 s end to end" figures in the README are estimates that add an assumed 3 s per model turn. They are not measurements of a live model.

CPU time of the server process was not measured: there is no dependency-free way to read it for a child process on Windows. RSS is read with `tasklist`.

## Gates derived from this baseline

Targets from the implementation plan, applied to the numbers above (default mode, same fixture and machine):

| Gate | Limit |
|---|---|
| Tool calls per journey | 2 (unchanged) |
| Warm median browser-side time | at most 1,629 ms (+10%) |
| Warm p95 browser-side time | at most 1,816 ms (+20%) |
| Clean `act` response | at most 1,178 characters (+20%) |
| Clean `open` response | at most 344 characters (+20%) |

A failed gate is to be explained or fixed, not moved.
