# FastQA

[![npm version](https://img.shields.io/npm/v/fastqa-mcp?logo=npm&cacheSeconds=3600)](https://www.npmjs.com/package/fastqa-mcp)
[![npm downloads](https://img.shields.io/npm/dm/fastqa-mcp?logo=npm&cacheSeconds=3600)](https://www.npmjs.com/package/fastqa-mcp)
[![QA friendly](https://img.shields.io/badge/QA-friendly_%E2%9C%93-2ea44f)](#what-it-can-check-for-you)
[![license: MIT](https://img.shields.io/npm/l/fastqa-mcp.svg)](LICENSE)

**An MCP server with a QA mindset that lets an LLM drive and test web UI applications.**

FastQA connects any MCP client (Claude Code, OpenCode and others) to a real browser. The LLM clicks, types and reads the page the way a tester would, and FastQA checks every step: it asserts on text, URLs, field values and accessibility. It also **records every network call with its method, URL and status code**, so a `500 POST /api/orders` is caught even when the UI hides it.

When a test passes, FastQA saves it as a flow. Saved flows replay in about a second with no LLM calls, from the MCP client or from the command line in CI.

## Install

Add it to Claude Code with one command (needs Node.js 20+):
```bash
claude mcp add fastqa -- npx -y fastqa-mcp
```

Or install it from npm to run saved tests from a terminal or CI:
```bash
npm install -g fastqa-mcp
```

Other MCP clients (OpenCode, Cursor, Claude Desktop, VS Code) are covered in [Setting it up](#setting-it-up-about-2-minutes-once). See the [changelog](CHANGELOG.md) for what changed in each version.

---

## How it fits together

| Part | Role | Who does it |
|---|---|---|
| 🧠 The brain | Decides what to test and what to do next | The LLM (Claude, or whatever model OpenCode uses) |
| ✋ The hands and eyes | Clicks, types, reads the page, checks results | **FastQA** (the MCP server) |
| 📡 The network log | Records each call: method, URL, status code | **FastQA** |
| 💻 The browser | Runs the web app under test | Chrome, headless by default |

**Why it's fast:** Most browser MCP servers make the LLM do one click, stop and look, then do the next click and look again. Each "look" costs the LLM about 3 seconds of thinking.

FastQA lets the LLM send a **batch of steps** instead: *type the email, type the password, click Log in, check the welcome message, check that `POST /api/login` returned 200*. The whole batch runs in one go. The LLM only hears back **what changed** on the page, plus any failed calls or errors, not the whole page again.

The result is that the same test takes **about 8 seconds instead of about 33**. Once it's saved, it takes **about 1.5 seconds**.

---

## What it can check for you

| Check | What it means in plain words |
|---|---|
| **Text** | "The page must say *Thank you for your order*." |
| **Page address** | "After login, we must be on the dashboard." |
| **Field values** | "The quantity box must show 2." |
| **Buttons** | "*Place order* must be greyed out until I tick the terms box." |
| **Background calls** | "When I click *Place order*, the server must answer 201." This catches bugs the screen hides, like an error the page swallows. |
| **No hidden errors** | "Nothing broke behind the scenes." It catches crashes in the page's code and server errors. |
| **Accessibility** | "People using screen readers or the keyboard can use this page," following the WCAG rules. |
| **Phone view** | "Does it still work on an iPhone 13 screen?" |
| **Many users at once** | Runs the same test with a list of users from a simple spreadsheet (CSV) and shows which ones fail. |

It also handles the tricky parts of modern sites: **pop-in payment frames** (iframes, including a 3-D Secure frame inside a payment frame) and **self-contained widgets** (shadow DOM). You don't need to do anything special for these.

---

## What you get when something fails

- ❌ **Which step failed and why**, written in plain language. For example: `expected "Thank you for your order", but the page says "Payment could not be processed"`.
- 📸 **A screenshot** of the screen at the moment it failed.
- 🔎 **Evidence**: server errors (like `500 POST /api/orders`) and errors from the page's own code. You can paste these straight into a bug report.
- 📄 **A report page** you can open in any browser: green and red bars, each step and the screenshots.
- 🧾 **A Jenkins file** (JUnit XML), so the results show up in your pipeline like any other tests.

---

## Setting it up (about 2 minutes, once)

**You need:** Node.js 20 or newer, plus Google Chrome. If you don't have Chrome, run `npx playwright install chromium`.

There is nothing to download or build. `npx` fetches FastQA from npm the first time your AI tool starts it.

**Step 1: connect it to your AI tool**

*If you use Claude Code*, run this once:
```bash
claude mcp add fastqa -- npx -y fastqa-mcp
```

*If you use OpenCode*, add this to your `opencode.json`:
```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "fastqa": {
      "type": "local",
      "command": ["npx", "-y", "fastqa-mcp"],
      "enabled": true
    }
  }
}
```

*If you use another MCP client* (Cursor, Claude Desktop, VS Code and others), add this to its MCP config:
```json
{
  "mcpServers": {
    "fastqa": { "command": "npx", "args": ["-y", "fastqa-mcp"] }
  }
}
```

**Step 2: restart your AI tool.** You should now see `fastqa` in its list of tools.

To update later, restart your AI tool: `npx -y fastqa-mcp` uses the newest published version. If an old version keeps running, use `fastqa-mcp@latest` in the command once.

<details>
<summary>Running from source instead</summary>

```bash
git clone https://github.com/VnKk8/FastQA-MCP.git
cd FastQA-MCP
npm install
npm run build
claude mcp add fastqa -- node /full/path/to/FastQA-MCP/dist/index.js
```
</details>

---

## Your first test

Type this to your AI, in normal words:

> Open https://staging.example.com/login with FastQA. Log in as qa.user@example.com with password {{password}}. Add the "Blue T-shirt" to the cart, go to checkout and place the order. Check that it says "Thank you for your order" and that POST /api/orders returned 201. Make sure no server errors happened. If it passes, save it as "checkout".

That's it. The AI works out the steps and runs them in one go. It then tells you PASS or FAIL, with the reasons.

### About passwords 🔒
Never type a real password into the chat. Write `{{password}}` instead, and set the real value on your computer before starting your AI tool:

```bash
export FASTQA_VAR_password='the-real-password'     # Mac / Linux
setx FASTQA_VAR_password "the-real-password"       # Windows (then open a new terminal)
```

FastQA fills it in at the last moment, so the AI never sees it. Password fields always show as `•••`.

---

## Rerunning tests without the AI

Once a test is saved, you can rerun it in either of these ways.

**From the chat:**
> Run all saved FastQA flows.

**From a terminal or Jenkins** (no AI involved, free and fast):
```bash
npx fastqa-mcp run '*'                          # run every saved test
npx fastqa-mcp run checkout                     # run just one
```

It finishes with a ✅ or ❌ for each test and tells you where the report was saved.

### Testing with many users
Make a file `.fastqa/data/users.csv`:
```
email,password
john@example.com,secret123
emma@example.com,secret123
locked@example.com,wrong
```
Then run:
```bash
npx fastqa-mcp run login --data=users
```
The test runs once per line. The report shows each user's result, and password columns are never printed.

### Turning a test into real code
> Export the checkout flow.

This creates a normal Playwright test file in `.fastqa/tests/`. You can add it to your automation repo like any other test.

---

## Where things are saved

Everything goes in a `.fastqa` folder inside the project you're working in:

```
.fastqa/
├── flows/       ← saved tests (simple JSON you can read)
├── data/        ← your CSV files with test users or values
├── reports/     ← report pages (open latest.html) + Jenkins files
├── artifacts/   ← screenshots of failures
└── tests/       ← exported Playwright test files
```

---

## Handy phrases for the AI

| You want to... | Say something like... |
|---|---|
| Watch the browser while it works | Set `FASTQA_HEADED=true` before starting the AI tool |
| Test on a phone screen | "Open the login page in FastQA as an **iPhone 13**." |
| Check accessibility | "Run a FastQA **audit** on this page." |
| See what went wrong behind the scenes | "Show me the FastQA **evidence**." |
| Get a picture | "Take a FastQA **screenshot**." |
| List saved tests | "List my FastQA flows." |

---

## When something doesn't work

| What you see | What to do |
|---|---|
| "Could not launch a browser" | Install Chrome, or run `npx playwright install chromium`. |
| "No visible element matches 'X'" | The button or field is named differently on screen. Ask the AI to "take a snapshot" and use the exact name it shows. |
| Two things have the same name (e.g. three "I accept" boxes) | Ask the AI to use the **ref** from the snapshot (like `e15`) instead of the name. |
| A widget can't be seen at all | It may use a "closed" component that no testing tool can look inside. Ask the developers to add a `data-testid` to it. |
| Test passes in chat but fails when rerun | The page probably needs a moment to load. Ask the AI to add a check (like "expect the text *Welcome*") before the next click. |

---

## Good habits

1. **Always end with a check.** "Click Place order" isn't a test. "Click Place order, then check it says *Thank you for your order*" is.
2. **Add "no hidden errors"** to important journeys like sign-up, checkout and payments.
3. **Save every test that passes.** A saved test is a free regression test forever.
4. **Use test users and `{{password}}`.** Never use real customer data.
5. **Run all saved tests every night in Jenkins** and look at `reports/latest.html` in the morning.

---

Technical details (every option, setting and step type) are in [docs/REFERENCE.md](docs/REFERENCE.md).
