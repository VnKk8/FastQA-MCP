#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Session } from './session.js';
import { runStep, bind, STEP_KINDS } from './runner.js';
import { saveFlow, loadFlow, listFlows, runSuite, exportFlow, FLOW_DIR } from './flows.js';
import { auditA11y, renderA11y } from './a11y.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
const VERSION = '0.3.0';
const session = new Session();
const text = (t) => ({ content: [{ type: 'text', text: t }] });
const stripHash = (u) => u.split('#')[0];
const MUTATING = /^(goto|click|dblclick|press|select|check|uncheck|fill|type)$/;
function evidenceSummary() {
    const e = session.evidence;
    const errs = e.pageErrors.length + e.console.filter((c) => c.startsWith('[error]')).length;
    const parts = [];
    if (errs)
        parts.push(`${errs} JS error(s)`);
    if (e.failedRequests.length)
        parts.push(`${e.failedRequests.length} failed request(s)`);
    return parts.length ? `\n⚠ ${parts.join(', ')} so far — call evidence for details` : '';
}
const server = new McpServer({ name: 'fastqa', version: VERSION });
server.registerTool('open', {
    description: 'Open a URL in the QA browser and return a compact snapshot: one line per element, e.g. `e4 textbox "Email" [required]`. Shadow DOM content is inlined; iframes appear as indented `frame "…"` blocks. ' +
        'Refs (eN) can be used as targets in act. Starts recording a new tape for flow save.',
    inputSchema: {
        url: z.string().describe('URL to open'),
        fresh: z.boolean().optional().describe('New isolated context (clears cookies/storage). Default false.'),
        device: z.string().optional().describe('Emulate a device, e.g. "iPhone 13", "Pixel 7", "iPad Mini". "" = back to desktop.'),
    },
}, async ({ url, fresh, device }) => {
    const page = await session.ensure(!!fresh, device);
    session.mark = Date.now();
    const t0 = Date.now();
    const r = await runStep(session, { do: 'goto', value: url });
    session.tape = r.recorded ? [r.recorded] : [];
    if (!r.ok)
        return text(r.line);
    await session.settle();
    const snap = await session.snapshot();
    session.lastLines = snap.items.map((i) => i.line);
    return text(`${Session.render(snap)}\n(${Date.now() - t0}ms)${evidenceSummary()}`);
});
const StepSchema = z.object({
    do: z.enum(STEP_KINDS),
    target: z.string().optional().describe('ref "e5", visible text/label like "Log in" or "Email", or a selector: "#id", "css=..", "testid=..". expect_request: "POST /api/claim" or "/regex/". expect_no_errors: optional text to ignore.'),
    value: z.string().optional().describe('text to fill, key to press, option to select, url, expected text/url (use /regex/ for regex). {{name}} reads env FASTQA_VAR_name so secrets never pass through the model. expect_request: status "200"/"2xx"/"<400". expect_no_errors: "strict" also fails on 4xx. expect_accessible: lowest failing impact, default "serious".'),
    timeout: z.number().optional().describe('ms, default 5000'),
    frame: z.string().optional().describe('only search inside this iframe (title, name, id or src fragment). Usually not needed: targets are searched in the page, shadow DOM and all iframes.'),
});
server.registerTool('act', {
    description: 'Run MANY steps in ONE call (fill a whole form, submit, assert) — this is what makes fastqa fast. ' +
        'Targets resolve by ref, label, placeholder, role+name or text — also inside open shadow DOM and iframes — so you usually do not need a snapshot first. ' +
        'Stops at the first failing step and then returns a full snapshot so you can recover. ' +
        'Otherwise returns only what changed on the page (+ added / - removed lines). ' +
        'expect_* steps are QA assertions that poll until they pass or time out. expect_request checks an API call happened with the right status, ' +
        'expect_no_errors fails on JS errors / 5xx since the batch started, expect_accessible runs a WCAG check.',
    inputSchema: {
        steps: z.array(StepSchema).min(1).max(50),
        snapshot: z.enum(['diff', 'full', 'none']).optional().describe('What to return after the steps. Default diff.'),
    },
}, async ({ steps, snapshot = 'diff' }) => {
    if (!session.page)
        return text('No page open. Call open first.');
    const t0 = Date.now();
    const out = [];
    let failed = false;
    const urlBefore = session.page.url();
    session.mark = Date.now();
    for (const step of steps) {
        const r = await runStep(session, bind(step, {}), step);
        out.push(r.line);
        if (!r.ok) {
            failed = true;
            break;
        }
        if (r.recorded)
            session.tape.push(r.recorded);
        if (MUTATING.test(step.do) && step.do !== 'fill' && step.do !== 'type')
            await session.settle(1500);
    }
    await session.settle(1500);
    const snap = await session.snapshot();
    const lines = snap.items.map((i) => i.line);
    let tail = '';
    if (failed) {
        let shot = '';
        try {
            const f = path.join(FLOW_DIR(), 'artifacts', `fail-${Date.now()}.jpg`);
            await fs.mkdir(path.dirname(f), { recursive: true });
            await session.page.screenshot({ path: f, type: 'jpeg', quality: 60 });
            shot = `\nscreenshot saved: ${f}`;
        }
        catch { /* ignore */ }
        tail = shot + '\n--- page now ---\n' + Session.render(snap);
    }
    else if (snapshot === 'full') {
        tail = '\n--- page now ---\n' + Session.render(snap);
    }
    else if (snapshot === 'diff' && stripHash(snap.url) !== stripHash(urlBefore)) {
        tail = '\n--- navigated, new page ---\n' + Session.render(snap); // a diff across pages is noise
    }
    else if (snapshot === 'diff') {
        const { added, removed } = session.diff(lines);
        const urlLine = `url: ${snap.url}`;
        tail = '\n--- changes ---\n' + urlLine + '\n' +
            (added.length || removed.length
                ? [...removed.slice(0, 60).map((l) => '- ' + l), ...added.slice(0, 120).map((l) => '+ ' + l)].join('\n')
                : '(no visible changes)');
    }
    session.lastLines = lines;
    const head = failed
        ? `FAILED at step ${out.length}/${steps.length} after ${Date.now() - t0}ms`
        : `PASSED ${steps.length}/${steps.length} steps in ${Date.now() - t0}ms`;
    return text(`${head}\n${out.join('\n')}${tail}${evidenceSummary()}`);
});
server.registerTool('snapshot', {
    description: 'Compact page snapshot. mode=interactive (default): controls, headings, alerts. mode=full: also visible text. root=css to scope to part of the page.',
    inputSchema: {
        mode: z.enum(['interactive', 'full']).optional(),
        root: z.string().optional(),
    },
}, async ({ mode = 'interactive', root }) => {
    if (!session.page)
        return text('No page open. Call open first.');
    const snap = await session.snapshot(mode, root);
    if (!root && mode === 'interactive')
        session.lastLines = snap.items.map((i) => i.line);
    return text(Session.render(snap));
});
server.registerTool('screenshot', {
    description: 'JPEG screenshot. Only use when layout/visuals matter — text snapshots are much cheaper.',
    inputSchema: {
        target: z.string().optional().describe('element to capture (ref/text/selector)'),
        full_page: z.boolean().optional(),
    },
}, async ({ target, full_page }) => {
    if (!session.page)
        return text('No page open. Call open first.');
    const buf = target
        ? await (await session.resolve(target, 'any')).loc.screenshot({ type: 'jpeg', quality: 60 })
        : await session.page.screenshot({ type: 'jpeg', quality: 60, fullPage: !!full_page });
    return { content: [{ type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' }] };
});
server.registerTool('audit', {
    description: 'Accessibility check (axe-core, WCAG 2.1 A/AA) of the current page and its iframes. Returns violations grouped by impact.',
    inputSchema: {},
}, async () => {
    if (!session.page)
        return text('No page open. Call open first.');
    const issues = await auditA11y(session.page, (f) => f.name() || f.url().split('?')[0]);
    return text(renderA11y(issues));
});
server.registerTool('evidence', {
    description: 'JS errors, console errors/warnings and failed HTTP requests (>=400) collected since the last call. Use for bug reports.',
    inputSchema: {},
}, async () => {
    const e = session.takeEvidence();
    const sec = (h, a) => `${h} (${a.length})${a.length ? '\n  ' + a.join('\n  ') : ''}`;
    return text([sec('page errors', e.pageErrors), sec('console', e.console), sec('failed requests', e.failedRequests)].join('\n'));
});
server.registerTool('flow', {
    description: 'Record & replay without the model. start: begin a new recording tape. save: store the steps recorded since open/start as a named flow. ' +
        'run: replay a flow (or "*" for all) in an isolated context, no LLM calls, returns pass/fail per step. ' +
        'list / show: inspect flows. export: write a Playwright Test .spec.ts.',
    inputSchema: {
        action: z.enum(['start', 'save', 'run', 'list', 'show', 'export']),
        name: z.string().optional(),
        vars: z.record(z.string()).optional().describe('values for {{placeholders}} when running'),
        dataset: z.string().optional().describe('run: CSV file (or name in .fastqa/data/) — the flow runs once per row, columns fill {{placeholders}}'),
    },
}, async ({ action, name, vars, dataset }) => {
    switch (action) {
        case 'start': {
            session.tape = session.page ? [{ do: 'goto', value: session.page.url(), code: `await page.goto(${JSON.stringify(session.page.url())});` }] : [];
            return text(`Recording from ${session.page?.url() ?? '(no page)'}`);
        }
        case 'save': {
            if (!name)
                return text('name is required');
            if (!session.tape.length)
                return text('Nothing recorded yet.');
            const p = await saveFlow(name, session.tape);
            return text(`Saved ${session.tape.length} steps to ${p}`);
        }
        case 'list': {
            const all = await listFlows();
            return text(all.length ? all.join('\n') : 'No flows saved yet.');
        }
        case 'show': {
            if (!name)
                return text('name is required');
            const f = await loadFlow(name);
            return text(f.steps.map((s, i) => `${i + 1}. ${s.do}${s.target ? ' ' + JSON.stringify(s.target) : ''}${s.value !== undefined ? ' ' + JSON.stringify(s.value) : ''}${Array.isArray(s.frame) && s.frame.length ? '  @ ' + s.frame.join(' >> ') : ''}`).join('\n'));
        }
        case 'run': {
            if (!name)
                return text('name is required ("*" runs all)');
            await session.ensure();
            const names = name === '*' ? await listFlows() : [name];
            const { runs, html, junit } = await runSuite(names, vars ?? {}, dataset, session);
            const passed = runs.filter((r) => r.ok).length;
            const report = runs.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name} (${r.ms}ms)` + (r.ok ? '' : '\n' + r.lines.map((l) => '   ' + l).join('\n')) +
                (r.shotFile ? `\n   screenshot: ${r.shotFile}` : '') +
                (r.evidence.length ? '\n   evidence: ' + r.evidence.slice(0, 5).join(' | ') : ''));
            return text(`${passed}/${runs.length} flows passed\n${report.join('\n')}\nreport: ${html}\njunit: ${junit}`);
        }
        case 'export': {
            if (!name)
                return text('name is required');
            const { file, code } = await exportFlow(name);
            return text(`Wrote ${file}\n\n${code}`);
        }
    }
});
server.registerTool('close', { description: 'Close the browser.', inputSchema: {} }, async () => {
    await session.close();
    return text('closed');
});
// ---- CLI: `fastqa-mcp run <flow|*>` replays flows with no model (for CI) ----
async function cli(args) {
    const name = args[1] ?? '*';
    const vars = {};
    let dataset;
    for (const a of args.slice(2)) {
        const m = /^--var=(\w+)=(.*)$/.exec(a);
        if (m)
            vars[m[1]] = m[2];
        const d = /^--data=(.+)$/.exec(a);
        if (d)
            dataset = d[1];
    }
    const names = name === '*' ? await listFlows() : [name];
    if (!names.length) {
        console.log('No flows found in ' + FLOW_DIR());
        process.exit(2);
    }
    const { runs, html, junit } = await runSuite(names, vars, dataset);
    for (const r of runs) {
        console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name} (${r.ms}ms)`);
        if (!r.ok)
            r.lines.forEach((l) => console.log('   ' + l));
        r.evidence.slice(0, 5).forEach((e) => console.log('   evidence: ' + e));
    }
    const failed = runs.filter((r) => !r.ok).length;
    console.log(`${runs.length - failed}/${runs.length} passed\nreport: ${html}\njunit:  ${junit}`);
    process.exit(failed ? 1 : 0);
}
const argv = process.argv.slice(2);
if (argv[0] === 'run') {
    cli(argv).catch((e) => { console.error(e); process.exit(2); });
}
else if (argv[0] === '--version') {
    console.log(VERSION);
}
else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    const shutdown = async () => { await session.close(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.stdin.on('close', shutdown);
}
