import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import type { Page, Frame } from 'playwright';

const require = createRequire(import.meta.url);
let AXE_SRC: string | undefined;
const axeSource = () => (AXE_SRC ??= readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'));

export interface A11yIssue { impact: string; id: string; help: string; count: number; examples: string[]; frame?: string }

const ORDER: Record<string, number> = { critical: 0, serious: 1, moderate: 2, minor: 3 };

/** Runs axe-core (WCAG 2.1 A/AA rules) in the page and every iframe. */
export async function auditA11y(page: Page, frameLabel: (f: Frame) => string): Promise<A11yIssue[]> {
  const issues: A11yIssue[] = [];
  for (const f of page.frames()) {
    if (f.isDetached()) continue;
    try {
      const has = await f.evaluate(() => typeof (window as any).axe !== 'undefined');
      if (!has) await f.evaluate(axeSource());
      const res: any = await f.evaluate(async () => {
        const r = await (window as any).axe.run(document, {
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
          resultTypes: ['violations'],
        });
        return r.violations.map((v: any) => ({
          impact: v.impact || 'minor', id: v.id, help: v.help, count: v.nodes.length,
          examples: v.nodes.slice(0, 3).map((n: any) => String(n.target?.join(' ') ?? '').slice(0, 80)),
        }));
      });
      const label = f === page.mainFrame() ? undefined : frameLabel(f);
      for (const v of res) issues.push({ ...v, frame: label });
    } catch { /* frame navigated away or blocked script injection (CSP) */ }
  }
  return issues.sort((a, b) => (ORDER[a.impact] ?? 9) - (ORDER[b.impact] ?? 9) || b.count - a.count);
}

export function renderA11y(issues: A11yIssue[]): string {
  if (!issues.length) return 'No WCAG 2.1 A/AA violations found by automated checks (manual checks still needed).';
  const by = (i: string) => issues.filter((x) => x.impact === i).length;
  return `${issues.length} rule(s) violated — critical ${by('critical')}, serious ${by('serious')}, moderate ${by('moderate')}, minor ${by('minor')}\n` +
    issues.map((i) => `[${i.impact}] ${i.id}: ${i.help} ×${i.count}${i.frame ? ` (frame "${i.frame}")` : ''}\n    e.g. ${i.examples.join(' | ')}`).join('\n');
}
