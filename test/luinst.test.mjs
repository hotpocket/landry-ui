// luinst stamps what it fetched, so a vendored copy says which landry-ui
// commit it is — a committed copy without that is a fork nobody can update.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const luinst = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'luinst');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

test('luinst copies the component and records repo, branch and commit', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'luinst-'));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'comp'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'comp', 'a.ts'), 'export {};\n');
  git(tmp, 'init', '-q', '-b', 'trunk', repo);
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'c');
  const sha = git(repo, 'rev-parse', 'HEAD');

  const dest = path.join(tmp, 'dest');
  execFileSync(luinst, ['comp', dest], {
    env: { ...process.env, LANDRY_UI_REPO: repo, LANDRY_UI_BRANCH: 'trunk' },
    stdio: 'pipe',
  });

  assert.equal(fs.readFileSync(path.join(dest, 'a.ts'), 'utf8'), 'export {};\n');
  const stamp = fs.readFileSync(path.join(dest, '.luinst'), 'utf8');
  assert.match(stamp, new RegExp(`^repo=${repo}$`, 'm'));
  assert.match(stamp, /^branch=trunk$/m);
  assert.match(stamp, new RegExp(`^commit=${sha}$`, 'm'));
  assert.match(stamp, /^component=comp$/m);
});
