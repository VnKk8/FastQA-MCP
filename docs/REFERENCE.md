# fastqa-mcp: technical reference

If you're new, start with the [README](../README.md).

Fast browser control for QA agents. It's one MCP server that you plug into **Claude Code**, **OpenCode** or any other MCP client.

Playwright MCP is slow for QA because each click is a separate model turn, and the big snapshots get re-read on every turn. fastqa reduces both:

| Same journey: login → add to cart → switch currency (bundled demo shop) | @playwright/mcp 0.0.86 | fastqa |
|---|---|---|
| Model turns (tool calls) | 10 | **2** |
| Tokens returned to the model | ~1,270 | **~310** (with 3 assertions included) |
| Tool definitions in the prompt, every turn | ~5,300 tokens (25 tools) | **~1,420 tokens (8 tools)** |
| Browser-side time | 3.1 s | 2.5 s |
| Estimated end-to-end at 3 s per model turn | ~33 s | **~8.5 s** |
| Re-run later | needs the model again | **1.4 s, no model** (`flow run`) |

Measured on fastqa-mcp 0.3.2 with `npm run bench` against the bundled demo shop. Most of the time is spent waiting on the model, so the main gain comes from needing fewer turns.

## Why it's faster

1. **Batched `act`.** You can fill a whole form, submit it and assert the result in one call, with up to 50 steps.
2. **Targets resolve without a snapshot.** A target like `"Email"`, `"Log in"` or `"Add to cart"` resolves through label, placeholder, role+name or text. You can still use refs (`e12`), `#id`, `css=…` or `testid=…`.
3. **Diffs instead of full snapshots.** After a batch, you only see `+ added` / `- removed` lines. You get a full snapshot when the page navigates or a step fails, so you can recover in the same turn.
4. **Compact snapshots.** Each element takes one line, e.g. `e5 textbox "Email" ="john@example.com" [required]`, with no YAML tree or wrapper divs.
5. **QA assertions built in.** The `expect_text`, `expect_url`, `expect_value`, `expect_visible`, `expect_hidden`, `expect_enabled`, `expect_disabled` and `expect_count` checks poll until they pass or time out.
6. **Record and replay.** Every successful step is recorded. `flow save` stores the journey, and `flow run` replays it with no LLM at all. `flow export` writes a Playwright Test `.spec.ts`.
7. **Evidence for free.** JS errors, console errors and HTTP responses of 400 and above are collected, and you're told about them after each act.
8. **Shadow DOM and iframes just work.** Open shadow roots are inlined in snapshots. Each iframe shows as an indented `frame "Payment"` block, including cross-origin and nested ones like a 3DS frame inside a payment frame. Targets are searched in the page, then in every visible frame. Recorded flows remember which frame a step ran in and export it as `page.frameLocator(…)`. Add `"frame": "Payment"` to a step only when two frames have the same label.
9. **Secrets stay out of the model.** `{{password}}` in a value is read from `FASTQA_VAR_password`. Password fields are masked in snapshots and logs.

## Install

Requires Node 20+. You need a browser, either one of:
- `npx playwright install chromium`, or
- an installed Google Chrome or Edge, which is picked up automatically.

FastQA is published on npm as `fastqa-mcp`, so MCP clients start it with `npx -y fastqa-mcp`. There is no separate install step.

### Claude Code
```bash
claude mcp add fastqa -- npx -y fastqa-mcp
```
You can also commit a project-level `.mcp.json`:
```json
{ "mcpServers": { "fastqa": { "command": "npx", "args": ["-y", "fastqa-mcp"], "env": { "FASTQA_HEADED": "false" } } } }
```
Keep secrets such as `FASTQA_VAR_password` out of committed files. Set them in your shell or CI instead.

### OpenCode (`opencode.json`)
```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "fastqa": {
      "type": "local",
      "command": ["npx", "-y", "fastqa-mcp"],
      "enabled": true,
      "environment": { "FASTQA_HEADED": "false" }
    }
  }
}
```

### Any other MCP client
Use stdio with the command `npx -y fastqa-mcp`.

### From source
```bash
git clone https://github.com/VnKk8/FastQA-MCP.git && cd FastQA-MCP
npm install && npm run build
claude mcp add fastqa -- node /abs/path/FastQA-MCP/dist/index.js
```

## Tools

| Tool | What it does |
|---|---|
| `open` | Opens a URL and returns a compact snapshot. It also starts a new recording. Add `device: "iPhone 13"` to emulate a phone. |
| `act` | Runs a batch of steps and returns pass/fail per step plus the page diff. |
| `snapshot` | `interactive` (default) or `full` (adds visible text), optionally scoped with `root=<css>`. |
| `screenshot` | Captures a JPEG of the page or an element. Use it only when visuals matter. |
| `audit` | Runs an accessibility check (axe-core, WCAG 2.1 A/AA) on the page and its iframes. |
| `evidence` | Lists JS errors, console errors and failed requests since the last call. |
| `flow` | `start`, `save`, `run` (name or `*`, optional `dataset` CSV), `list`, `show`, `export`. `run` writes an HTML report and a JUnit XML file. |
| `close` | Closes the browser. |

Step kinds: `goto click dblclick hover fill type press select check uncheck wait expect_text expect_no_text expect_url expect_title expect_value expect_visible expect_hidden expect_enabled expect_disabled expect_count expect_request expect_no_errors expect_accessible`.

QA checks:
- `expect_request`: `target` is `"POST /api/orders"`, a URL fragment or a `/regex/`. `value` is `"200"`, `"2xx"` or `"<400"` (the default). It passes if a matching API call has happened since the batch or flow started.
- `expect_no_errors`: fails on JS exceptions, `console.error`, network failures and HTTP 5xx since the batch started. With `value: "strict"`, 4xx also counts. `target` is optional text to ignore.
- `expect_accessible`: `value` is the lowest impact that fails the step: `critical`, `serious` (the default), `moderate` or `minor`.

These three are checked by fastqa. In exported Playwright specs they appear as comments.
Use `/regex/` in expected values to match a regex. Steps time out after 5 s by default, not Playwright's 30 s, so failures come back quickly.

Example `act`:
```json
{ "steps": [
  { "do": "fill",  "target": "Email", "value": "john@example.com" },
  { "do": "fill",  "target": "Password", "value": "{{password}}" },
  { "do": "click", "target": "Log in" },
  { "do": "expect_url",  "value": "/dashboard" },
  { "do": "expect_text", "value": "Welcome back" }
] }
```

## CI: run recorded flows with no model
```bash
npx fastqa-mcp run '*'                        # all flows in .fastqa/flows
npx fastqa-mcp run checkout --var=password=$PW
npx fastqa-mcp run login --data=users          # once per row of .fastqa/data/users.csv
```
Each run writes `.fastqa/reports/<time>.html` and `.junit.xml`, plus `latest.html` and `latest.junit.xml`. Failure screenshots go to `.fastqa/artifacts/`.
The exit code is 1 if any flow fails, so you can use it as a Jenkins stage. You can also export flows to Playwright specs and run them in your existing pipeline.

## Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `FASTQA_HEADED` | `false` | Shows the browser window. |
| `FASTQA_CHROME` | – | Path to a Chrome/Chromium executable. |
| `FASTQA_CDP_URL` | – | Attaches to an already running Chrome (`--remote-debugging-port`), e.g. one you're already logged into. |
| `FASTQA_TIMEOUT_MS` | `5000` | Default step timeout. |
| `FASTQA_VIEWPORT` | `1280x800` | Viewport size. |
| `FASTQA_MAX_LINES` | `250` | Snapshot line cap. |
| `FASTQA_DIR` | `./.fastqa` | Where flows and exported tests go. |
| `FASTQA_VAR_<name>` | – | Value for `{{name}}` placeholders. |

## Agent instructions (paste into CLAUDE.md / AGENTS.md)
```
When testing in the browser with fastqa:
- Batch: put every step you already know into ONE act call (fill + submit + expect_*). Do not act one step at a time.
- Target by visible label/text ("Email", "Log in"); use refs only when text is ambiguous.
- Always end a batch with expect_* assertions; a test without an assertion is not a test.
- Use {{name}} for secrets. Never type real passwords.
- When a journey passes, flow save it with a descriptive name so it can be re-run without you.
- On failure, call evidence before writing the bug report.
```

## Limitations (MVP)
- Chromium only.
- **Closed** shadow roots (`mode: 'closed'`) can't be reached by any page script or Playwright, so treat them as a black box. Ask devs for `open` mode or a `data-testid` on the host.
- `expect_count` with a CSS selector only checks the main frame.
- Semantic targets pick the first visible match. When the same label repeats, as with three "I accept" checkboxes, use a ref or `css=`.
- Only one tab is active at a time; popups become the active page.
- The demo benchmark is a small page. On heavy SPAs the snapshot savings are bigger, but the settle time depends on the app.

## Develop
```bash
npm test     # build + end-to-end over real MCP stdio (incl. shadow DOM + nested cross-origin iframes) + runs an exported spec with @playwright/test
npm run bench
npm run demo # demo app on http://127.0.0.1:4321
```

CI (`.github/workflows/ci.yml`) runs `npm test` on Node 20, 22 and 24 for every push and pull request. It also fails if the committed `dist/` doesn't match the source, so run `npm run build` and commit `dist/` with source changes.

## Releasing
Releases are automated by `.github/workflows/publish.yml`. Don't run `npm publish` by hand.

- **Manually:** Actions → **Release** → **Run workflow**, then pick `patch`, `minor` or `major`, or type an exact version.
- **On merge:** label a pull request `release:patch`, `release:minor` or `release:major` before merging it into `main`. Merged pull requests without one of these labels publish nothing.

The workflow bumps the version in `package.json`, runs the tests, publishes to npm with trusted publishing (with a provenance attestation), then pushes a `vX.Y.Z` commit and tag and creates the GitHub release. The server reads its version from `package.json`, so nothing else needs changing. Add the new version's notes to `CHANGELOG.md`.
