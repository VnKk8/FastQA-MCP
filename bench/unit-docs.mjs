// The JSON examples people copy from the docs must be valid: every ```json block in README.md and docs/REFERENCE.md
// parses and has no duplicate keys (JSON.parse accepts those silently, but editors and schema checks flag them).
// Run with: node --test bench/unit-docs.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** Keys that appear twice in the same object. */
function duplicateKeys(text) {
  const out = []; const stack = []; let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1; while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const key = text.slice(i + 1, j); i = j + 1;
      let k = i; while (/\s/.test(text[k])) k++;
      const top = stack[stack.length - 1];
      if (text[k] === ':' && top instanceof Set) { if (top.has(key)) out.push(key); top.add(key); }
      continue;
    }
    if (c === '{') stack.push(new Set()); else if (c === '[') stack.push('array'); else if (c === '}' || c === ']') stack.pop();
    i++;
  }
  return out;
}

for (const file of ['README.md', 'docs/REFERENCE.md']) {
  test(`${file}: every JSON example parses and has no duplicate keys`, () => {
    const md = readFileSync(file, 'utf8');
    const blocks = [...md.matchAll(/```json\r?\n([\s\S]*?)```/g)];
    assert.ok(blocks.length > 0, 'no JSON examples found');
    for (const m of blocks) {
      const line = md.slice(0, m.index).split('\n').length;
      assert.doesNotThrow(() => JSON.parse(m[1]), `${file}:${line} does not parse`);
      assert.deepEqual(duplicateKeys(m[1]), [], `${file}:${line} has duplicate keys`);
    }
  });
}

test('the duplicate-key check finds a repeated key and ignores the same key in sibling objects', () => {
  assert.deepEqual(duplicateKeys('{"a":1,"b":{"a":2},"a":3}'), ['a']);
  assert.deepEqual(duplicateKeys('{"x":{"k":1},"y":{"k":2},"z":[{"k":1},{"k":2}]}'), []);
});
