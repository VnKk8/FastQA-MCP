import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FlowRun } from './flows.js';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Writes reports/<stamp>.html (open in a browser) and reports/<stamp>.junit.xml (Jenkins "Publish JUnit test result report"). */
export async function writeReports(runs: FlowRun[], dir: string): Promise<{ html: string; junit: string }> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = path.join(dir, 'reports');
  await fs.mkdir(out, { recursive: true });
  const passed = runs.filter((r) => r.ok).length;
  const total = runs.reduce((a, r) => a + r.ms, 0);

  const cards = runs.map((r) => `
<details class="run ${r.ok ? 'pass' : 'fail'}" ${r.ok ? '' : 'open'}>
  <summary><b>${r.ok ? 'PASS' : 'FAIL'}</b> ${esc(r.name)} <span class="ms">${r.ms} ms</span></summary>
  <ol>${r.lines.map((l) => `<li class="${l.includes('✗') ? 'bad' : ''}">${esc(l.replace(/^\s*\d+\.\s*/, ''))}</li>`).join('')}</ol>
  ${r.evidence.length ? `<h4>Evidence</h4><ul class="ev">${r.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
  ${r.url ? `<p class="ms">Page at failure: ${esc(r.url)}</p>` : ''}
  ${r.screenshot ? `<img alt="screenshot at failure" src="data:image/jpeg;base64,${r.screenshot}">` : ''}
</details>`).join('\n');

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>fastqa report — ${passed}/${runs.length} passed</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;max-width:980px;margin:24px auto;padding:0 16px;color:#1d1d1f}
h1{font-size:22px;margin-bottom:4px}.sum{color:#555;margin-bottom:20px}
.bar{height:10px;border-radius:5px;background:#e33;overflow:hidden;margin:8px 0 20px}.bar i{display:block;height:100%;background:#2a2}
.run{border:1px solid #ddd;border-radius:10px;margin:10px 0;padding:8px 14px}.run.pass summary b{color:#1a7f37}.run.fail{border-color:#e33}.run.fail summary b{color:#c00}
summary{cursor:pointer}.ms{color:#777;font-size:13px}li.bad{color:#c00;font-weight:600}.ev li{font-family:ui-monospace,monospace;font-size:12px}
img{max-width:100%;border:1px solid #ccc;border-radius:6px;margin-top:8px}
</style></head><body>
<h1>fastqa test report</h1>
<div class="sum">${passed} of ${runs.length} passed · ${(total / 1000).toFixed(1)} s · ${new Date().toLocaleString()}</div>
<div class="bar"><i style="width:${runs.length ? (100 * passed) / runs.length : 0}%"></i></div>
${cards}
</body></html>`;

  const junit = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="fastqa" tests="${runs.length}" failures="${runs.length - passed}" time="${(total / 1000).toFixed(3)}" timestamp="${new Date().toISOString()}">
${runs.map((r) => `  <testcase classname="fastqa.flows" name="${esc(r.name)}" time="${(r.ms / 1000).toFixed(3)}">${r.ok ? '' : `
    <failure message="${esc((r.lines.find((l) => l.includes('✗')) ?? 'failed').trim())}">${esc([...r.lines, ...r.evidence.map((e) => 'evidence: ' + e), r.shotFile ? 'screenshot: ' + r.shotFile : ''].join('\n'))}</failure>
  `}</testcase>`).join('\n')}
</testsuite>
`;
  const html_p = path.join(out, `${stamp}.html`);
  const junit_p = path.join(out, `${stamp}.junit.xml`);
  await fs.writeFile(html_p, html);
  await fs.writeFile(junit_p, junit);
  await fs.copyFile(html_p, path.join(out, 'latest.html'));
  await fs.copyFile(junit_p, path.join(out, 'latest.junit.xml'));
  return { html: html_p, junit: junit_p };
}
