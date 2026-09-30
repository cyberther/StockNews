const fs = require('fs');
const path = require('path');

const output = 'dist';
const files = ['styles.css'];
const directories = [
  'templates/shared',
  'templates/stock-news-dark',
  'templates/stock-news-web',
];

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

for (const file of files) fs.cpSync(file, path.join(output, file));
for (const directory of directories) {
  fs.cpSync(directory, path.join(output, directory), { recursive: true });
}

console.log(`Built Netlify bundle in ${output}`);
