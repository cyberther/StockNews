// Alerts as GitHub issues, one open issue per kind of problem: a repeat adds a comment
// instead of a new issue. Run by the workflows with GITHUB_TOKEN (issues: write).
//
//   node ingest/notify.mjs --title="Ingest: over budget" --file=summary.json --field=over
//   node ingest/notify.mjs --title="Ingest: health" --file=health.json --field=problems
//
// Does nothing when the field is empty. Uses the gh CLI, present on GitHub's runners.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function issueAction(openIssues, title) {
  const hit = openIssues.find(i => i.title === title && (i.state || 'open').toLowerCase() === 'open');
  return hit ? { action: 'comment', number: hit.number } : { action: 'create' };
}

function main() {
  const arg = n => { const a = process.argv.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : ''; };
  const title = arg('title'), data = JSON.parse(readFileSync(arg('file'), 'utf8')), items = data[arg('field')] || [];
  if (!title || !items.length) return;
  const body = `${items.map(x => '- ' + x).join('\n')}\n\nRun: ${process.env.GITHUB_SERVER_URL || ''}/${process.env.GITHUB_REPOSITORY || ''}/actions/runs/${process.env.GITHUB_RUN_ID || ''}`;
  const open = JSON.parse(execFileSync('gh', ['issue', 'list', '--state', 'open', '--search', `"${title}" in:title`, '--json', 'number,title,state', '--limit', '20'], { encoding: 'utf8' }));
  const a = issueAction(open, title);
  if (a.action === 'comment') execFileSync('gh', ['issue', 'comment', String(a.number), '--body', body], { stdio: 'inherit' });
  else execFileSync('gh', ['issue', 'create', '--title', title, '--body', body], { stdio: 'inherit' });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
