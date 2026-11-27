import { promises as fs } from 'node:fs';
import path from 'node:path';
import { rel, writeAtomic } from './dirs.js';
import { html as esc } from './privacy/redact.js';
/**
 * Writes reports/<stamp>.html (open in a browser) and reports/<stamp>.junit.xml (Jenkins "Publish JUnit test result report").
 * Steps and explicit assertions are shown separately from QA findings. In observe mode findings never change a result;
 * in strict mode a policy failure is its own JUnit failure. Everything from the app under test is escaped and sanitized.
 */
export async function writeReports(runs, dir) {
    let stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const out = path.join(dir, 'reports');
    await fs.mkdir(out, { recursive: true });
    // two workers finishing in the same millisecond must not overwrite each other
    if (await fs.access(path.join(out, `${stamp}.html`)).then(() => true, () => false))
        stamp += `-${process.pid}`;
    const passed = runs.filter((r) => r.ok).length;
    const total = runs.reduce((a, r) => a + r.ms, 0);
    const candidates = runs.reduce((a, r) => a + r.findingLines.length, 0);
    const quality = (r) => {
        if (!r.quality)
            return '';
        const pol = r.policy?.outcome === 'failed' ? `<p class="pol bad">QA policy (strict): FAILED — ${esc(r.policy.reasons.join('; '))}</p>`
            : r.policy?.outcome === 'passed' ? '<p class="pol ok">QA policy (strict): passed</p>' : '';
        const cov = `<p class="ms">Observed ${r.quality.observedRequests} requests · coverage ${esc(r.quality.coverage)}${r.quality.pendingRequests ? ` (${r.quality.pendingRequests} pending)` : ''}${r.quality.droppedEvents ? ` (${r.quality.droppedEvents} events dropped)` : ''}${r.sessionId ? ` · session ${esc(r.sessionId)}` : ''}${r.bundle ? ` · bundle <code>${esc(r.bundle)}</code>` : ''}</p>`;
        const list = r.findingLines.length
            ? `<h4>QA findings <span class="ms">candidates observed during the run: leads to verify, not confirmed defects</span></h4><ul class="ev qa">${r.findingLines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`
            : '<p class="ms">No QA findings within the observed scope.</p>';
        return `<div class="q">${list}${pol}${cov}</div>`;
    };
    const cards = runs.map((r) => `
<details class="run ${r.ok ? 'pass' : 'fail'}" ${r.ok && !r.findingLines.length ? '' : 'open'}>
  <summary><b>${r.ok ? 'PASS' : 'FAIL'}</b> ${esc(r.name)} <span class="ms">${r.ms} ms</span>${r.findingLines.length ? ` <span class="tag">${r.findingLines.length} QA finding${r.findingLines.length === 1 ? '' : 's'}</span>` : ''}</summary>
  <h4>Steps and assertions <span class="ms">${r.stepsOk ? 'all passed' : 'failed'}</span></h4>
  <ol>${r.lines.map((l) => `<li class="${l.includes('✗') ? 'bad' : ''}">${esc(l.replace(/^\s*\d+\.\s*/, ''))}</li>`).join('')}</ol>
  ${r.evidence.length ? `<h4>Evidence</h4><ul class="ev">${r.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
  ${quality(r)}
  ${r.url ? `<p class="ms">Page at failure: ${esc(r.url)}</p>` : ''}
  ${r.screenshot ? `<img alt="screenshot at failure" src="data:image/jpeg;base64,${r.screenshot}">` : ''}
</details>`).join('\n');
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>fastqa report — ${passed}/${runs.length} passed</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;max-width:980px;margin:24px auto;padding:0 16px;color:#1d1d1f}
h1{font-size:22px;margin-bottom:4px}.sum{color:#555;margin-bottom:20px}h4{margin:12px 0 4px}
.bar{height:10px;border-radius:5px;background:#e33;overflow:hidden;margin:8px 0 20px}.bar i{display:block;height:100%;background:#2a2}
.run{border:1px solid #ddd;border-radius:10px;margin:10px 0;padding:8px 14px}.run.pass summary b{color:#1a7f37}.run.fail{border-color:#e33}.run.fail summary b{color:#c00}
summary{cursor:pointer}.ms{color:#777;font-size:13px;font-weight:400}li.bad{color:#c00;font-weight:600}.ev li{font-family:ui-monospace,monospace;font-size:12px}
.tag{background:#fff3cd;border:1px solid #e0c36a;border-radius:10px;padding:0 8px;font-size:12px}.q{border-top:1px dashed #ccc;margin-top:10px}
.pol.bad{color:#c00;font-weight:600}.pol.ok{color:#1a7f37}
img{max-width:100%;border:1px solid #ccc;border-radius:6px;margin-top:8px}
</style></head><body>
<h1>fastqa test report</h1>
<div class="sum">${passed} of ${runs.length} passed · ${candidates} QA finding${candidates === 1 ? '' : 's'} · ${(total / 1000).toFixed(1)} s · ${new Date().toLocaleString()}</div>
<div class="bar"><i style="width:${runs.length ? (100 * passed) / runs.length : 0}%"></i></div>
${cards}
</body></html>`;
    const body = (r) => [...r.lines, ...r.evidence.map((e) => 'evidence: ' + e), r.shotFile ? 'screenshot: ' + rel(r.shotFile) : ''].join('\n');
    const sysout = (r) => (r.quality
        ? `\n    <system-out>${esc([`qa: ${r.findingLines.length} candidate finding(s), coverage ${r.quality.coverage}, policy ${r.policy?.outcome ?? 'not_enforced'}${r.sessionId ? `, session ${r.sessionId}` : ''}`, ...r.findingLines.map((l) => 'qa: ' + l)].join('\n'))}</system-out>\n  `
        : '');
    const failure = (r) => {
        if (r.ok)
            return '';
        // a step failure keeps the 0.3 message; a run that only failed the strict policy says so
        const message = r.stepsOk ? `QA policy (strict): ${r.policy?.reasons.join('; ') ?? 'failed'}` : (r.lines.find((l) => l.includes('✗')) ?? 'failed').trim();
        return `\n    <failure message="${esc(message)}"${r.stepsOk ? ' type="fastqa.policy"' : ''}>${esc(body(r))}</failure>\n  `;
    };
    const junit = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="fastqa" tests="${runs.length}" failures="${runs.length - passed}" time="${(total / 1000).toFixed(3)}" timestamp="${new Date().toISOString()}">
${runs.map((r) => `  <testcase classname="fastqa.flows" name="${esc(r.name)}" time="${(r.ms / 1000).toFixed(3)}">${failure(r)}${sysout(r)}</testcase>`).join('\n')}
</testsuite>
`;
    const html_p = path.join(out, `${stamp}.html`);
    const junit_p = path.join(out, `${stamp}.junit.xml`);
    await fs.writeFile(html_p, html);
    await fs.writeFile(junit_p, junit);
    // latest.* is a convenience copy shared by every run in this directory: losing a race for it must not fail a run
    for (const [name, data] of [['latest.html', html], ['latest.junit.xml', junit]]) {
        try {
            await writeAtomic(path.join(out, name), data);
        }
        catch (e) {
            console.error(`fastqa: could not update reports/${name}: ${String(e).split('\n')[0]}`);
        }
    }
    return { html: html_p, junit: junit_p };
}
