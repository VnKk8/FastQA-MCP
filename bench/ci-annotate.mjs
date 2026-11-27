// Turns the failed checks of a test log into GitHub annotations, so a red CI run says what failed on the pull request
// itself, without opening the log.
//   node bench/ci-annotate.mjs test.log        (CI only; prints workflow commands)
// GitHub shows at most 10 error annotations per step, so the last 9 failures are reported, plus the end of the log.
import { existsSync, readFileSync } from 'node:fs';

const MAX_BLOCKS = 9;
const MAX_LINES = 40;
const MAX_CHARS = 3500;
const TAIL_LINES = 25;

/** Failure records of the suites in bench/ and of `node --test` (spec and TAP reporters). */
const START = /^(FAIL |=== FAIL |EXPORTED SPEC FAILED|not ok \d+|✖ |([\w-]+: )?\d+ (of \d+ )?FAILED)/;
/** A line that begins the next record, which ends the current block. */
const NEXT = /^(ok {2}|ok \d+|FAIL |=== |not ok \d+|✔ |✖ |# |> )/;
/** The 0.3 suites print each tool call as "=== OK name" followed by the tool's own output, which may quote a failing flow on purpose. */
const QUOTE = /^=== (OK|FAIL)/;
const UNQUOTE = /^(ok {2}|ALL .*PASSED$|([\w-]+: )?\d+ (of \d+ )?FAILED$|[\w-]+: all \d+ checks passed$)/;

export function failures(text) {
  const lines = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/);
  const blocks = [];
  let quoted = false;
  for (let i = 0; i < lines.length; i++) {
    if (QUOTE.test(lines[i])) quoted = true; else if (UNQUOTE.test(lines[i])) quoted = false;
    if (!START.test(lines[i]) || (quoted && lines[i].startsWith('FAIL '))) continue;
    const block = [lines[i]];
    for (let j = i + 1; j < lines.length && block.length < MAX_LINES && !NEXT.test(lines[j]); j++) block.push(lines[j]);
    blocks.push(block.join('\n').trimEnd());
  }
  const tail = lines.filter((l) => l.trim()).slice(-TAIL_LINES).join('\n');
  return { blocks: blocks.slice(-MAX_BLOCKS), total: blocks.length, tail };
}

const data = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const property = (s) => data(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters in the log)` : s);

export function commands(text) {
  const { blocks, total, tail } = failures(text);
  const out = blocks.map((b) => `::error title=${property(clip(b.split('\n')[0], 120))}::${data(clip(b, MAX_CHARS))}`);
  if (total > blocks.length) out.push(`::warning title=${total - blocks.length} earlier failure(s) not shown::See the test log.`);
  out.push(`::notice title=Last lines of the test log::${data(clip(tail, MAX_CHARS))}`);
  return out;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  const file = process.argv[2];
  if (!file || !existsSync(file)) console.log('ci-annotate: no test log to read');
  else for (const line of commands(readFileSync(file, 'utf8'))) console.log(line);
}
