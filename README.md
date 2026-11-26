# fastqa

**An AI assistant that tests websites for you, quickly, and remembers how.**

You describe a test in plain words. The AI clicks through the website, checks the results and tells you what broke. When a test passes, fastqa saves it. After that, it reruns by itself in about a second, with no AI needed.

---

## The idea in one picture

Think of a new team member who is very smart but has never used a computer.

| Part | In real life it's... | In fastqa |
|---|---|---|
| 🧠 The brain | The tester who decides what to do next | The AI (Claude, or whatever model OpenCode uses) |
| ✋ The hands and eyes | Clicking, typing, reading the screen | **fastqa** |
| 💻 The computer | The browser | Chrome, running invisibly in the background |

**Why it's fast:** Other tools make the AI do one click, then stop and look, then do the next click, then look again. Each "look" takes the AI about 3 seconds to think.

fastqa gives the AI a **checklist** instead: *type the email, type the password, click Log in, check the welcome message*. The whole list runs in one go. The AI only hears back **what changed** on the screen, not the whole page again.

The result is that the same test takes **about 8 seconds instead of about 33**. Once it's saved, it takes **about 1.5 seconds**.

---

## What it can check for you

| Check | What it means in plain words |
|---|---|
| **Text** | "The page must say *Bonus activated*." |
| **Page address** | "After login, we must be on the lobby page." |
| **Field values** | "The currency box must show BGN." |
| **Buttons** | "*Claim* must be greyed out until I tick the terms box." |
| **Background calls** | "When I click *Claim*, the server must answer OK." This catches bugs the screen hides, like an error the page swallows. |
| **No hidden errors** | "Nothing broke behind the scenes." It catches crashes in the page's code and server errors. |
| **Accessibility** | "People using screen readers or the keyboard can use this page," following the WCAG rules. |
| **Phone view** | "Does it still work on an iPhone 13 screen?" |
| **Many users at once** | Runs the same test with a list of users from a simple spreadsheet (CSV) and shows which ones fail. |

It also handles the tricky parts of modern sites: **pop-in payment frames** (iframes, including a 3-D Secure frame inside a payment frame) and **self-contained widgets** (shadow DOM). You don't need to do anything special for these.

---

## What you get when something fails

- ❌ **Which step failed and why**, written in plain language. For example: `expected "Bonus activated", but the page says "Could not claim bonus"`.
- 📸 **A screenshot** of the screen at the moment it failed.
- 🔎 **Evidence**: server errors (like `500 POST /api/claim/spins`) and errors from the page's own code. You can paste these straight into a bug report.
- 📄 **A report page** you can open in any browser: green and red bars, each step and the screenshots.
- 🧾 **A Jenkins file** (JUnit XML), so the results show up in your pipeline like any other tests.

---

## Setting it up (about 5 minutes, once)

**You need:** Node.js 20 or newer, plus Google Chrome. If you don't have Chrome, run `npx playwright install chromium`.

**Step 1: get it ready**
```bash
cd fastqa-mcp
npm install
npm run build
```

**Step 2: connect it to your AI tool**

*If you use OpenCode*, add this to your `opencode.json`:
```json
{
  "mcp": {
    "fastqa": {
      "type": "local",
      "command": ["node", "/full/path/to/fastqa-mcp/dist/index.js"],
      "enabled": true
    }
  }
}
```

*If you use Claude Code*, run this once:
```bash
claude mcp add fastqa -- node /full/path/to/fastqa-mcp/dist/index.js
```

**Step 3: restart your AI tool.** You should now see `fastqa` in its list of tools.

---

## Your first test

Type this to your AI, in normal words:

> Open https://staging.example.com/login with fastqa. Log in as qa.user@test.com with password {{password}}. Claim the welcome bonus and check that it says "Bonus activated". Make sure no server errors happened. If it passes, save it as "claim-welcome-bonus".

That's it. The AI works out the steps and runs them in one go. It then tells you PASS or FAIL, with the reasons.

### About passwords 🔒
Never type a real password into the chat. Write `{{password}}` instead, and set the real value on your computer before starting your AI tool:

```bash
export FASTQA_VAR_password='the-real-password'     # Mac / Linux
setx FASTQA_VAR_password "the-real-password"       # Windows (then open a new terminal)
```

fastqa fills it in at the last moment, so the AI never sees it. Password fields always show as `•••`.

---

## Rerunning tests without the AI

Once a test is saved, you can rerun it in either of these ways.

**From the chat:**
> Run all saved fastqa flows.

**From a terminal or Jenkins** (no AI involved, free and fast):
```bash
npx fastqa-mcp run '*'                          # run every saved test
npx fastqa-mcp run claim-welcome-bonus          # run just one
```

It finishes with a ✅ or ❌ for each test and tells you where the report was saved.

### Testing with many users
Make a file `.fastqa/data/users.csv`:
```
email,password
ivan@test.bg,secret123
maria@test.bg,secret123
locked@test.bg,wrong
```
Then run:
```bash
npx fastqa-mcp run login --data=users
```
The test runs once per line. The report shows each user's result, and password columns are never printed.

### Turning a test into real code
> Export the claim-welcome-bonus flow.

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
| Test on a phone screen | "Open the login page in fastqa as an **iPhone 13**." |
| Check accessibility | "Run a fastqa **audit** on this page." |
| See what went wrong behind the scenes | "Show me the fastqa **evidence**." |
| Get a picture | "Take a fastqa **screenshot**." |
| List saved tests | "List my fastqa flows." |

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

1. **Always end with a check.** "Click Claim" isn't a test. "Click Claim, then check it says *Bonus activated*" is.
2. **Add "no hidden errors"** to important journeys like payments, bonuses and registration.
3. **Save every test that passes.** A saved test is a free regression test forever.
4. **Use test users and `{{password}}`.** Never use real customer data.
5. **Run all saved tests every night in Jenkins** and look at `reports/latest.html` in the morning.

---

Technical details (every option, setting and step type) are in [docs/REFERENCE.md](docs/REFERENCE.md).
