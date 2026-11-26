// Central redaction. Everything that leaves the process (MCP results, reports, flows, evidence, artifacts)
// goes through here; observations are also sanitized before they are retained.
// This reduces exposure of recognizable secrets. It cannot recognize an unknown secret shown in arbitrary page text.
const SECRET_KEY = /pass(word|wd)?|pwd|secret|token|auth|session|\bsid\b|signature|\bsig\b|api[-_]?key|access[-_]?key|credential|jwt|\botp\b|\bpin\b|ssn|card|cvv|cvc|cookie/i;
const SECRET_HEADERS = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i;
export const MASK = '•••';
/** Shorter values are not treated as secrets: replacing e.g. "wrong" everywhere would shred ordinary text. */
export const MIN_SECRET_LENGTH = 6;
export class Redactor {
    /** value -> label, for values known to be secret (bound placeholders, values seen in secret positions) */
    secrets = new Map();
    sorted = [];
    keep = new Set();
    extraKeys = [];
    secretVars = new Set();
    configure(o) {
        this.keep = new Set((o.keepQueryParams ?? []).map((k) => k.toLowerCase()));
        this.extraKeys = (o.secretKeys ?? []).map((k) => new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
        this.secretVars = new Set(o.secretVars ?? []);
    }
    isSecretKey(k) { return SECRET_KEY.test(k) || this.extraKeys.some((r) => r.test(k)); }
    isSecretVar(name) { return this.secretVars.has(name) || this.isSecretKey(name); }
    /** Remember a secret value so it is removed wherever it shows up later. Short values are ignored: they would shred normal text. */
    addSecret(value, label = 'secret') {
        if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH || this.secrets.has(value) || this.secrets.size >= 500)
            return;
        this.secrets.set(value, label);
        this.sorted = [...this.secrets.keys()].sort((a, b) => b.length - a.length);
    }
    get knownSecrets() { return this.secrets.size; }
    /** Only known secret values, replaced by their {{placeholder}}. Safe for files that must stay replayable (flows, exported specs). */
    knownOnly(s) {
        for (const v of this.sorted)
            if (s.includes(v))
                s = s.split(v).join(`{{${this.secrets.get(v)}}}`);
        return s;
    }
    /** Free text: known secret values, then recognizable credential patterns. */
    text(s) {
        if (!s)
            return s;
        for (const v of this.sorted)
            if (s.includes(v))
                s = s.split(v).join(`{{${this.secrets.get(v)}}}`);
        // Patterns are deliberately narrow: ordinary UI text such as "Basic information" or "Password confirmation" must survive.
        return s
            .replace(/\b(Bearer|Basic)\s+(?=[A-Za-z0-9._~+/=-]*[0-9+/=_])[A-Za-z0-9._~+/=-]{12,}/g, `$1 ${MASK}`)
            .replace(/([?&;]|\b)([\w.-]*(?:pass(?:word|wd)?|pwd|secret|token|api[-_]?key|access[-_]?key|signature|credential|jwt)[\w.-]*)=([^&\s"'<>]+)/gi, (_m, p, k) => `${p}${k}=${MASK}`)
            .replace(/\b(password|passwd|secret|token|api[-_ ]?key)(\s*:\s*|\s+)(["']?)(?=[^\s"',;]*\d)[^\s"',;]{8,}\3/gi, (_m, k, sep, qt) => `${k}${sep}${qt}${MASK}${qt}`);
    }
    /** Network URL: no credentials, no fragment, query values removed unless the parameter is allowlisted. */
    networkUrl(u) {
        let url;
        try {
            url = new URL(u);
        }
        catch {
            return this.text(u).slice(0, 300);
        }
        if (url.protocol === 'data:' || url.protocol === 'blob:')
            return `${url.protocol}…`;
        const q = [];
        url.searchParams.forEach((v, k) => {
            if (this.isSecretKey(k)) {
                this.addSecret(v, k);
                q.push(`${k}=${MASK}`);
            }
            else
                q.push(this.keep.has(k.toLowerCase()) ? `${k}=${this.text(v)}` : `${k}=…`);
        });
        return `${url.origin}${this.text(url.pathname)}${q.length ? '?' + q.slice(0, 20).join('&') : ''}`;
    }
    /** Page URL shown to the agent: keeps ordinary query values (they are navigation state), hides secret-looking ones. */
    pageUrl(u) {
        let url;
        try {
            url = new URL(u);
        }
        catch {
            return this.text(u);
        }
        if (!url.username && !url.password && !url.search)
            return this.text(u);
        url.username = '';
        url.password = '';
        let out = `${url.origin}${url.pathname}`;
        const q = [];
        url.searchParams.forEach((v, k) => {
            if (this.isSecretKey(k)) {
                this.addSecret(v, k);
                q.push(`${k}=${MASK}`);
            }
            else
                q.push(`${k}=${v}`);
        });
        if (q.length)
            out += '?' + q.join('&');
        return this.text(out + url.hash);
    }
    headers(h) {
        const out = {};
        for (const [k, v] of Object.entries(h)) {
            if (SECRET_HEADERS.test(k) || this.isSecretKey(k)) {
                const bare = v.replace(/^(Bearer|Basic)\s+/i, '');
                this.addSecret(bare, k.toLowerCase());
                out[k] = MASK;
            }
            else
                out[k] = this.text(v).slice(0, 200);
        }
        return out;
    }
    /** Deep copy of JSON data with secret-named fields masked and every string passed through text(). Bounded. */
    json(v, budget = { nodes: 3000 }, depth = 0, key) {
        if (budget.nodes-- <= 0 || depth > 12)
            return '…';
        if (key !== undefined && this.isSecretKey(key) && (typeof v === 'string' || typeof v === 'number')) {
            this.addSecret(String(v), key);
            return MASK;
        }
        if (typeof v === 'string')
            return this.text(v).slice(0, 500);
        if (Array.isArray(v))
            return v.slice(0, 50).map((x) => this.json(x, budget, depth + 1, key));
        if (v && typeof v === 'object') {
            const out = {};
            for (const [k, x] of Object.entries(v))
                out[k] = this.json(x, budget, depth + 1, k);
            return out;
        }
        return v;
    }
}
/** One redactor per process: secrets learned in one session stay hidden in every later output. */
export const redactor = new Redactor();
const escHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Untrusted text into HTML. */
export const html = (s) => escHtml(redactor.text(String(s ?? '')));
/** Untrusted text into Markdown: no raw HTML, no accidental formatting, single line. */
export const md = (s) => redactor.text(String(s ?? '')).replace(/[\r\n]+/g, ' ').replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;')).replace(/([\\`*_[\]|])/g, '\\$1');
