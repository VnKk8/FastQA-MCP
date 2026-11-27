import { readFileSync } from 'node:fs';

// Single source of truth: package.json sits one level above dist/ in the repo and in the npm package.
export const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
