# FastQA-MCP evolution: execution ledger

Plan: `docs/FASTQA-IMPLEMENTATION-PLAN.md` (revision 3). Roadmap: `docs/FASTQA-ROADMAP.md`. Baseline: `docs/evolution-baseline.md`.
Branch `evolution/v1-roadmap`, cut from `41815d3` (0.3.2). Nothing is pushed, tagged or published.

If context is lost: re-read the two plans and this file, then continue at the first ticket that is not `verified`.

## Ticket status

| Ticket | Scope | Status |
|---|---|---|
| FQA-001 | Baseline, compatibility harness, fault fixtures | in_progress |
| FQA-002 | Scoped actions and request lifecycle | in_progress |
| FQA-003 | Privacy and bounded capture | in_progress |
| FQA-004 | Locator and session safety | in_progress |
| FQA-005 | Rule registry and finding lifecycle | in_progress |
| FQA-006 | Policy, compact MCP integration, profiles (incl. 006a) | in_progress |
| FQA-007 | Evidence bundle, session artifacts, reports | pending |
| FQA-008 | Replay and Playwright export parity | in_progress |
| FQA-009 | Route and endpoint graph | pending |
| FQA-010 | Contract and business rules | pending |
| FQA-011 | Performance and state checks | pending |
| FQA-012 | Integration and v1.0 readiness | pending |

## Checkpoints

### A. Baseline and first demo (done)

- Baseline captured on the untouched code: see `docs/evolution-baseline.md`.
- Fault fixtures added to the existing demo server (`/orders` page, selected by query parameters).
- First demo passes: `open /orders?notify=500` then `act [click "Place order", expect_text "Thank you"]` returns `PASSED 2/2` plus
  `F-001 HIGH NET-5XX POST /api/notifications returned 500 — A-2 click "Place order" (inferred)`. No assertion, no extra tool call, no body capture.
- RED first: `node bench/observe.mjs` against the 0.3.2 build failed 27 of 38 checks. After the implementation: 38 of 38.
- Regression: `bench/e2e.mjs`, `bench/export-check.mjs`, `bench/qa-features.mjs` all pass unchanged.

## Changed and new files

- New: `src/config.ts`, `src/dirs.ts`, `src/exec.ts`, `src/services.ts`, `src/observation/{types,store,observer}.ts`, `src/correlation/actions.ts`,
  `src/quality/{engine,summary}.ts`, `src/privacy/redact.ts`, `src/evidence/query.ts`, `src/util/paths.ts`.
- Changed: `src/session.ts` (config, context-level listeners, strict locators), `src/runner.ts`, `src/flows.ts`, `src/index.ts`.
- Tests: `bench/lib.mjs`, `bench/observe.mjs`, `bench/perf.mjs`, `bench/capture-baseline.mjs`, fixtures in `bench/demo-server.mjs`, `bench/fixtures/legacy/`.

## Rulings

Decisions taken where the plan left a choice or reality differed. Each has its cost if wrong.

1. **Ledger.** The plan asks for `docs/evolution-progress.md`; the executing-plans skill asks for its own workspace scripts and ledger. This file is the ledger. Cost if wrong: none for the product.
2. **Listeners moved to context level.** The plan says "bind early enough for new pages". Page-level listeners miss a popup's first requests, so `request`, `response`, `requestfinished`, `requestfailed`, `console` and `weberror` are bound once per browser context. Cost if wrong: requests from service workers have no page; they are attributed to the active page.
3. **Association heuristics.** Assertions and waits are passive and never own a request. A request that starts while an interactive step runs is `inferred` to it. One that starts later is `inferred` to the latest interactive step inside a 1.5 s window, with the delay stated. It becomes `ambiguous` only when another recent action still has requests in flight, or the endpoint is known background traffic (2 or more earlier starts without an action). `direct` is used only for the navigation a `goto` asked for. Cost if wrong: a timer-driven request of an older, already-settled action is attributed to the newer one; the confidence stays `inferred`, never more.
4. **Raw URLs stay in process memory for explicit assertions.** `expect_request` may match a query string, so `Session.log` keeps the raw URL for matching only. Everything retained in the event store, printed or written is sanitized. Cost if wrong: a secret in a query string lives in RAM until the log rotates (2,000 entries).
5. **Page URL keeps ordinary query values.** The snapshot `url:` line is the agent's navigation state, so only secret-looking parameters are masked there. Network URLs lose all query values unless a parameter is allowlisted in `privacy.keepQueryParams`. Cost if wrong: personal data in a page URL query is shown to the agent, as in 0.3.
6. **Secret values shorter than 6 characters are not registered.** Replacing a short value everywhere would shred ordinary text ("wrong" became `{{password}}` in a test). Cost if wrong: a very short secret that the page echoes is not hidden.
7. **NET-4XX severities.** 401 and 403 are `info` (apps probe sessions); other 4xx are `low`. A passing `expect_request` on a 4xx/5xx marks that response `expected`. Info findings are counted, not listed inline. Cost if wrong: an unexpected 403 is easy to miss in the inline summary; it is still in `evidence view=findings`.
8. **Payload capture skips responses of unknown size** unless `capture.allowUnknownLength` is set. Playwright cannot stream a body, so this is the only way to keep the bound honest. Cost if wrong: on APIs that use chunked encoding, body-based rules report "not evaluated" until the option is turned on.
9. **TLS.** Without a config file the 0.3 behaviour stays (invalid certificates accepted) and a warning goes to stderr. With a `.fastqa/config.json` the default is secure; `browser.ignoreHTTPSErrors` or `FASTQA_IGNORE_HTTPS_ERRORS` opts in. Cost if wrong: adding a config file to a project that tests a self-signed staging host makes `open` fail until one line is added; the error says which line.
10. **Structured content is opt-in** (`mcp.structuredContent` or `FASTQA_STRUCTURED=true`). Some clients forward only `structuredContent` to the model when it is present, which would drop the page diff. The text result is always complete. Cost if wrong: clients that could use typed data must opt in.
11. **No ninth tool.** Bundles and bug drafts are reached through `evidence {report:true}`. Cost if wrong: one more parameter on `evidence`.
12. **Absolute paths stay in MCP text results** (`report:`, `screenshot saved:`) because 0.3 clients read them. Inside artifacts (reports, bundles, Markdown) paths are relative. Cost if wrong: an absolute local path is visible to the model, as in 0.3.

## Blockers

None so far.
