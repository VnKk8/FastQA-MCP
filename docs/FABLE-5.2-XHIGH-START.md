# FastQA-MCP — Fable 5.2 / xHigh full-roadmap execution prompt

Select Fable 5.2 and xHigh in your coding client if available. Put the revision 3 plans under `docs/`. This prompt authorizes the full implementation in one session, not publication.

## Paste into the coding agent

You are the lead implementation engineer for FastQA-MCP. Read `docs/FASTQA-ROADMAP.md`, `docs/FASTQA-IMPLEMENTATION-PLAN.md` (revision 3), the repository instructions and root README. Your task is to **implement the entire roadmap in this single continuous session: all FQA-001 through FQA-012 tickets, all milestones from v0.4 through v1.0 readiness and all applicable acceptance criteria**. Do not merely produce a plan. Do not stop after the first vertical slice. No intermediate confirmation is required. The maintainer authorizes all in-scope implementation work described in the plans.

### Execution

1. Inspect the repository and git status, preserve user changes, map actual code paths and schemas, run the existing tests and establish reproducible performance baselines (FQA-001). Record real outcomes in `docs/evolution-baseline.md`.
2. Implement the first hidden-500 correlation demo from section 9, including deterministic regression tests. Treat it as an internal checkpoint, not the final deliverable.
3. Complete v0.4 observation/correlation, bounded privacy-first capture, safe locators and session isolation (FQA-002–004).
4. Complete v0.5 continuous detection, finding policies, profiles, compact MCP responses, late findings, strict finalization and configured business error rules (FQA-005–006, including FQA-006a).
5. Complete v0.6 evidence bundles, candidate bug reports, session artifacts, replay, exports and reporting parity (FQA-007–008).
6. Complete v0.7 observed product and API discovery (FQA-009).
7. Complete v0.8 optional OpenAPI validation, configured invariants, performance and state checks (FQA-010–011).
8. Complete FQA-012, the v1.0 integration/readiness gate: all acceptance journeys, legacy compatibility, privacy/load/isolation checks, actual MCP client/package smoke tests where available, build/CI validation, performance comparison, regression fixes and updated documentation.

### Working rules

- Follow the detailed contracts, acceptance criteria and dependency order in the implementation plan. Reuse the existing Playwright engine, tool registry, action runner, flow and CLI implementation. Preserve the eight MCP tools, legacy flows, explicit assertions and default pass/fail behaviour.
- Keep FastQA local-first, LLM-independent and runtime-agnostic. No unnecessary abstractions, infrastructure or dependencies. No blanket network-idle waits or fixed sleeps as synchronization. Keep capture bounded, scoped, opt-in for bodies, and sanitized before retention. Distinguish candidate findings from confirmed defects and temporal association from causality.
- Work in reviewable slices but automatically continue to the next dependency-ready ticket. Run focused tests after each slice and full regressions at milestone boundaries and final integration. Where useful, delegate independent tests, privacy work or review using supported subagents; avoid shared-file conflicts. The main agent remains responsible for integration and validation.
- Maintain `docs/evolution-progress.md` as a persistent execution checklist with all 12 tickets, acceptance gates, decisions, changed files, actual commands/results, performance comparisons and blockers. Update it after each checkpoint. If context compacts, reload both plans and this checklist, then continue. Do not use compaction as a reason to end the session.
- Fix defects and regressions discovered during testing. If a real blocker occurs, investigate safe alternatives, mark only affected gates blocked, work on independent requirements and retry integration. Do not manufacture success, weaken tests, add placeholder features or silently skip tickets. Report environmental limitations honestly.
- Run `npm test`, `npm run bench` and applicable build/package checks. Rebuild tracked dist if required. Compare measured browser execution and response size against the original baseline; separate assumed model latency from measured timings. Update README, reference, changelog and usage examples with only verified functionality and distinguish unpublished development code from published npm releases.
- Do not push, tag, publish or release automatically. Do not run tests against production or overwrite unrelated user work.

### Final completion gate

Continue until all roadmap requirements have been implemented and verified, or a genuine capability/environment limit makes further progress impossible. Before ending, inspect every checklist item and attempt remaining feasible work. Deliver the integrated code plus a final report covering all 12 tickets, acceptance results, test and benchmark measurements, documentation, compatibility and any unresolved blockers. A successful first demo or intermediate milestone is not completion. Do not end by simply proposing what another session should implement.
