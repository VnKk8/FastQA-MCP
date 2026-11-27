// Central redaction. Everything that leaves the process (MCP results, reports, flows, evidence, artifacts)
// goes through here; observations are also sanitized before they are retained.
// This reduces exposure of recognizable secrets. It cannot recognize an unknown secret shown in arbitrary page text.
//
// Two kinds of known secret values, kept apart on purpose:
//  - bound:   values the user supplied through a {{placeholder}}. Shown as "{{name}}" (the name is always a plain word),
//             also inside flow files and exported specs, where the placeholder keeps the file replayable.
//  - learned: values seen in a secret position of the app under test (a token= parameter, an Authorization header,
//             a password field in JSON). They come from the page, so they are only ever replaced by a fixed mask and
//             are never used to rewrite a flow or a spec: nothing the page controls ends up as a label or as code.
const SECRET_TOKENS = new Set([
    'pass', 'password', 'passwd', 'passphrase', 'pwd', 'secret', 'secrets', 'token', 'tokens', 'auth', 'authorization', 'authentication',
    'session', 'sessionid', 'sid', 'signature', 'sig', 'credential', 'credentials', 'jwt', 'otp', 'pin', 'ssn', 'cvv', 'cvc',
    'cookie', 'cookies', 'apikey', 'accesskey', 'bearer', 'card', 'csrf', 'xsrf', 'iban',
]);
const SECRET_PAIRS = [['api', 'key'], ['access', 'key'], ['secret', 'key'], ['private', 'key'], ['client', 'secret']];
const SECRET_HEADERS = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i;
export const MASK = '•••';
/** Shorter values are not treated as secrets: replacing e.g. "wrong" everywhere would shred ordinary text. */
export const MIN_SECRET_LENGTH = 6;
const MAX_LEARNED = 500;
/** A clipped copy of a long secret (snapshots clip values) is recognised by this many leading characters. */
const PREFIX = 16;
// Every pattern below is bounded (no nested or unbounded quantifiers over the same characters), so hostile page text
// cannot make redaction slow. Patterns are narrow: ordinary UI text such as "Basic information" must survive.
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{1,15}:\/\/)[^\s/@:"'<>]{1,100}(?::[^\s/@"'<>]{0,200})?@/gi;
const BEARER = /\b(Bearer|Basic)\s{1,4}(?=[A-Za-z0-9._~+/=-]{0,4000}?[0-9+/=_])[A-Za-z0-9._~+/=-]{12,4000}/g;
const KEY_EQUALS = /(?<![\w.-])([A-Za-z][\w.-]{0,60})=([^&\s"'<>\\]{1,2000})/g;
const JSON_PAIR = /(["'])([A-Za-z][\w.-]{0,60})\1(\s{0,3}:\s{0,3})(["'])([^"'\\]{1,500})\4/g;
const KEY_THEN_VALUE = /\b(password|passwd|secret|token|api[-_ ]?key)(\s{0,3}:\s{0,3}|\s{1,3})(["']?)(?=[^\s"',;]{0,200}\d)[^\s"',;]{8,200}\3/gi;
// characters that are not allowed in XML 1.0 (JUnit) and have no place in HTML or Markdown either
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFE\uFFFF]/g;
const keyTokens = (k) => k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/).filter(Boolean);
export class Redactor {
    bound = new Map();
    learned = new Set();
    keep = new Set();
    extraKeys = [];
    secretVars = new Set();
    configure(o) {
        this.keep = new Set((o.keepQueryParams ?? []).map((k) => k.toLowerCase()));
        this.extraKeys = (o.secretKeys ?? []).filter(Boolean).map((k) => k.toLowerCase());
        this.secretVars = new Set(o.secretVars ?? []);
    }
    /** By whole words of the key (password, access_token, apiKey, sessionId), so "author" or "passengers" are not secrets. */
    isSecretKey(k) {
        const t = keyTokens(k);
        if (t.some((x) => SECRET_TOKENS.has(x)))
            return true;
        for (let i = 0; i + 1 < t.length; i++)
            if (SECRET_PAIRS.some(([a, b]) => t[i] === a && t[i + 1] === b))
                return true;
        const low = k.toLowerCase();
        return this.extraKeys.some((x) => low.includes(x));
    }
    isSecretVar(name) { return this.secretVars.has(name) || this.isSecretKey(name); }
    /** A secret the user supplied through a {{placeholder}}: hidden everywhere, shown as its placeholder. Never dropped. */
    addSecret(value, label = 'secret') {
        if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH)
            return;
        this.bound.set(value, label.replace(/\W+/g, '_').replace(/^_+|_+$/g, '') || 'secret');
        this.learned.delete(value);
    }
    /** A value seen in a secret position of the app under test. Bounded: the oldest are forgotten first. */
    learn(value) {
        if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH || value.length > 4096 || this.bound.has(value))
            return;
        this.learned.delete(value);
        this.learned.add(value);
        if (this.learned.size > MAX_LEARNED)
            this.learned.delete(this.learned.values().next().value);
    }
    get knownSecrets() { return this.bound.size + this.learned.size; }
    /** Replaces a value, its JSON-escaped form and clipped copies of it. */
    swap(s, v, to) {
        if (s.includes(v))
            s = s.split(v).join(to);
        const esc = JSON.stringify(v).slice(1, -1);
        if (esc !== v && s.includes(esc))
            s = s.split(esc).join(to);
        if (v.length > PREFIX) {
            const head = v.slice(0, PREFIX);
            if (s.includes(head)) {
                let out = '';
                let i = 0;
                for (;;) {
                    const at = s.indexOf(head, i);
                    if (at < 0)
                        break;
                    let n = PREFIX;
                    while (n < v.length && s[at + n] === v[n])
                        n++;
                    let end = at + n;
                    if (s[end] === '…')
                        end++;
                    out += s.slice(i, at) + to;
                    i = end;
                }
                s = out + s.slice(i);
            }
        }
        return s;
    }
    /** Only user-supplied secrets, replaced by their {{placeholder}}. Used for files that must stay replayable (flows, exported specs). */
    knownOnly(s) {
        for (const [v, label] of [...this.bound].sort((a, b) => b[0].length - a[0].length))
            s = this.swap(s, v, `{{${label}}}`);
        return s;
    }
    /** Free text: known secret values, then recognizable credential patterns. Linear in the length of the text. */
    text(s) {
        if (!s)
            return s;
        s = this.knownOnly(s);
        for (const v of this.learned)
            s = this.swap(s, v, MASK);
        return s
            .replace(URL_CREDENTIALS, '$1')
            .replace(BEARER, `$1 ${MASK}`)
            .replace(KEY_EQUALS, (m, k) => (this.isSecretKey(k) ? `${k}=${MASK}` : m))
            .replace(JSON_PAIR, (m, q1, k, sep, q2) => (this.isSecretKey(k) ? `${q1}${k}${q1}${sep}${q2}${MASK}${q2}` : m))
            .replace(KEY_THEN_VALUE, (_m, k, sep, qt) => `${k}${sep}${qt}${MASK}${qt}`);
    }
    /** A deep copy with every string sanitized. Use this BEFORE JSON.stringify: redacting serialized JSON can break it. */
    deep(v, depth = 0) {
        if (typeof v === 'string')
            return this.text(v);
        if (v === null || typeof v !== 'object' || depth > 40)
            return v;
        if (Array.isArray(v))
            return v.map((x) => this.deep(x, depth + 1));
        const out = {};
        for (const [k, x] of Object.entries(v))
            out[k] = this.deep(x, depth + 1);
        return out;
    }
    /** Network URL: no credentials, no fragment, query values removed unless the parameter is allowlisted. Bounded length. */
    networkUrl(u) {
        if (u.length > 8192)
            u = u.slice(0, 8192);
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
            if (q.length >= 20)
                return;
            const key = k.slice(0, 60);
            if (this.isSecretKey(k)) {
                this.learn(v);
                q.push(`${key}=${MASK}`);
            }
            else
                q.push(this.keep.has(k.toLowerCase()) ? `${key}=${this.text(v).slice(0, 200)}` : `${key}=…`);
        });
        return `${url.origin}${this.text(url.pathname).slice(0, 500)}${q.length ? '?' + q.join('&') : ''}`;
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
        // Everything that is not a secret-looking parameter is kept exactly as written (no re-encoding).
        const dec = (s) => { try {
            return decodeURIComponent(s.replace(/\+/g, ' '));
        }
        catch {
            return s;
        } };
        const q = url.search.slice(1).split('&').map((part) => {
            const i = part.indexOf('=');
            if (i < 0 || !this.isSecretKey(dec(part.slice(0, i))))
                return part;
            this.learn(dec(part.slice(i + 1)));
            return `${part.slice(0, i)}=${MASK}`;
        });
        return this.text(`${url.origin}${url.pathname}${url.search ? '?' + q.join('&') : ''}${url.hash}`);
    }
    headers(h) {
        const out = {};
        for (const [k, v] of Object.entries(h)) {
            if (SECRET_HEADERS.test(k) || this.isSecretKey(k)) {
                this.learn(v.replace(/^(Bearer|Basic)\s+/i, ''));
                out[k] = MASK;
            }
            else
                out[k] = this.text(v).slice(0, 200);
        }
        return out;
    }
    /**
     * Deep copy of captured JSON: secret-named fields are masked, including everything below a secret-named object,
     * and every other string passes through text(). Bounded in depth and size.
     */
    json(v, budget = { nodes: 3000 }, depth = 0, key, masked = false) {
        if (budget.nodes-- <= 0 || depth > 12)
            return '…';
        const secret = masked || (key !== undefined && this.isSecretKey(key));
        if (typeof v === 'string' || typeof v === 'number') {
            if (secret) {
                this.learn(String(v));
                return MASK;
            }
            return typeof v === 'string' ? this.text(v).slice(0, 500) : v;
        }
        if (Array.isArray(v))
            return v.slice(0, 50).map((x) => this.json(x, budget, depth + 1, key, secret));
        if (v && typeof v === 'object') {
            const out = {};
            for (const [k, x] of Object.entries(v))
                out[k.slice(0, 80)] = this.json(x, budget, depth + 1, k, secret);
            return out;
        }
        return v;
    }
}
/** One redactor per process: secrets learned in one session stay hidden in every later output. */
export const redactor = new Redactor();
const escHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Untrusted text into HTML or XML: sanitized, control characters removed, escaped. */
export const html = (s) => escHtml(redactor.text(String(s ?? '')).replace(CONTROL, ''));
/** Untrusted text into Markdown: no raw HTML, no accidental formatting, single line. */
export const md = (s) => redactor.text(String(s ?? '')).replace(CONTROL, '').replace(/[\r\n]+/g, ' ').replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;')).replace(/([\\`*_[\]|])/g, '\\$1');
