// Path helpers shared by correlation, policy matching, discovery and contract validation.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "/orders/{id}" or "/api/*" -> anchored RegExp. "*" matches one segment, "**" any suffix. */
export function patternToRegex(pattern: string): RegExp {
  const src = pattern.split('/').map((seg) => {
    if (seg === '**') return '.*';
    if (seg === '*' || /^\{[^}]+\}$/.test(seg) || /^:[\w-]+$/.test(seg)) return '[^/]+';
    return seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  }).join('/');
  return new RegExp(`^${src}/?$`);
}

const cache = new Map<string, RegExp>();
export function pathMatches(pattern: string, pathname: string): boolean {
  let re = cache.get(pattern);
  if (!re) { re = patternToRegex(pattern); if (cache.size < 500) cache.set(pattern, re); }
  return re.test(pathname);
}

export interface EndpointRule { method?: string; path: string }
export function endpointMatches(rule: EndpointRule, method: string, pathname: string): boolean {
  if (rule.method && rule.method !== '*' && rule.method.toUpperCase() !== method.toUpperCase()) return false;
  return pathMatches(rule.path, pathname);
}

/**
 * Conservative path normalization: explicit templates win, then numeric ids, UUIDs and long hex hashes
 * become placeholders. Anything else is kept verbatim, so two different resources are never merged by guesswork.
 */
export function normalizePath(pathname: string, templates: string[] = []): string {
  for (const t of templates) if (pathMatches(t, pathname)) return t;
  return pathname.split('/').map((seg) => {
    if (/^\d+$/.test(seg)) return '{id}';
    if (UUID.test(seg)) return '{uuid}';
    if (/^[0-9a-f]{16,}$/i.test(seg)) return '{hash}';
    return seg;
  }).join('/') || '/';
}

/** RFC 6901 JSON pointer lookup. Returns { found } so that a present null differs from a missing value. */
export function jsonPointer(doc: unknown, pointer: string): { found: boolean; value?: unknown } {
  if (pointer === '' || pointer === '/') return { found: true, value: doc };
  let cur: any = doc;
  for (const raw of pointer.replace(/^\//, '').split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur === null || typeof cur !== 'object' || !(key in cur)) return { found: false };
    cur = cur[key];
  }
  return { found: true, value: cur };
}

/** Field names and JSON types only, never values. Arrays are summarized by their first element. */
export function shapeOf(v: unknown, depth = 0): unknown {
  if (v === null) return 'null';
  if (Array.isArray(v)) return depth > 5 ? ['…'] : v.length ? [shapeOf(v[0], depth + 1)] : [];
  if (typeof v === 'object') {
    if (depth > 5) return '{…}';
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).slice(0, 60)) out[k] = shapeOf((v as any)[k], depth + 1);
    return out;
  }
  return typeof v;
}
