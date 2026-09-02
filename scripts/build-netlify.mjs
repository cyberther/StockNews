import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

const output = 'dist';
const files = ['styles.css', '_ds_bundle.js'];
const directories = [
  'templates/shared',
  'templates/stock-news-dark',
  'templates/stock-news-web',
];

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

for (const file of files) {
  const destination = join(output, file);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(file, destination);
}

for (const directory of directories) {
  cpSync(directory, join(output, directory), { recursive: true });
}

console.log(`Built safe Netlify bundle in ${output}`);
