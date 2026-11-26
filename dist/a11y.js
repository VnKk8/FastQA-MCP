import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
let AXE_SRC;
const axeSource = () => (AXE_SRC ??= readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'));
const ORDER = { critical: 0, serious: 1, moderate: 2, minor: 3 };
/** Runs axe-core (WCAG 2.1 A/AA rules) in the page and every iframe. */
export async function auditA11y(page, frameLabel) {
    const issues = [];
    for (const f of page.frames()) {
        if (f.isDetached())
            continue;
        try {
            const has = await f.evaluate(() => typeof window.axe !== 'undefined');
            if (!has)
                await f.evaluate(axeSource());
            const res = await f.evaluate(async () => {
                const r = await window.axe.run(document, {
                    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
                    resultTypes: ['violations'],
                });
                return r.violations.map((v) => ({
                    impact: v.impact || 'minor', id: v.id, help: v.help, count: v.nodes.length,
                    examples: v.nodes.slice(0, 3).map((n) => String(n.target?.join(' ') ?? '').slice(0, 80)),
                }));
            });
            const label = f === page.mainFrame() ? undefined : frameLabel(f);
            for (const v of res)
                issues.push({ ...v, frame: label });
        }
        catch { /* frame navigated away or blocked script injection (CSP) */ }
    }
    return issues.sort((a, b) => (ORDER[a.impact] ?? 9) - (ORDER[b.impact] ?? 9) || b.count - a.count);
}
export function renderA11y(issues) {
    if (!issues.length)
        return 'No WCAG 2.1 A/AA violations found by automated checks (manual checks still needed).';
    const by = (i) => issues.filter((x) => x.impact === i).length;
    return `${issues.length} rule(s) violated — critical ${by('critical')}, serious ${by('serious')}, moderate ${by('moderate')}, minor ${by('minor')}\n` +
        issues.map((i) => `[${i.impact}] ${i.id}: ${i.help} ×${i.count}${i.frame ? ` (frame "${i.frame}")` : ''}\n    e.g. ${i.examples.join(' | ')}`).join('\n');
}
