import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const output = 'dist';
const directories = [
  'templates/shared',
  'templates/stock-news-dark',
  'templates/stock-news-web',
];

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

for (const directory of directories) {
  cpSync(directory, join(output, directory), { recursive: true });
}

console.log(`Built safe Netlify bundle in ${output}`);
