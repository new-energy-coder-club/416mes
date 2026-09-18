'use strict';
// Read-only candidate inventory. This is NOT a functionality pass/fail verdict.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const workspace = path.resolve(__dirname, '../..');
const roots = { glm: '.dev-lines/glm53', kimi: '.dev-lines/kimik3', gpt: '.dev-lines/gpt6' };
const key = process.argv[2];
if (!Object.hasOwn(roots, key)) { console.error('Usage: node evaluation/unique-item/inspect-candidate.cjs glm|kimi|gpt'); process.exit(2); }
const root = path.join(workspace, roots[key]);
function git(args) { return cp.execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim(); }
function info(relative) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) return { path: relative, exists: false };
  const contents = fs.readFileSync(absolute);
  return { path: relative, exists: true, bytes: contents.length, sha256: crypto.createHash('sha256').update(contents).digest('hex') };
}
const baseline = '55d9297';
const tracked = git(['diff', '--name-status', baseline, '--']).split('\n').filter(Boolean);
const untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
const report = {
  kind: 'read-only-inventory-not-acceptance', candidate: key, root,
  observedAt: new Date().toISOString(), branch: git(['branch', '--show-current']),
  head: git(['rev-parse', 'HEAD']), baseline: git(['rev-parse', baseline]),
  commits: git(['log', '--format=%h %s', baseline + '..HEAD']).split('\n').filter(Boolean),
  workingTree: git(['status', '--short']), changedTrackedFiles: tracked, untrackedFiles: untracked,
  evidenceFiles: ['DEV_PROGRESS.md', 'LINE_REPORT.md', 'package.json', 'package-lock.json', 'index.html', 'lib/store.js'].map(info),
  testsExecutedByThisScript: false,
  warnings: ['Presence of files, passing candidate self-tests, or an in-memory coordinator is not independent acceptance.']
};
console.log(JSON.stringify(report, null, 2));
