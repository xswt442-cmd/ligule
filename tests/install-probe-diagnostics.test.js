import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../scripts/verify-install.js', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('verify-install.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const failures = [];
function visit(node) {
  if (ts.isThrowStatement(node) && /(?:mcpProbe|reopenProbe)\.stderr/u.test(node.getText(parsed))) failures.push(node.getText(parsed));
  ts.forEachChild(node, visit);
}
visit(parsed);

test('both install probe diagnostics retain real spawn failures without disclosing stdout', () => {
  assert.equal(failures.length, 2);
  const timeout = spawnSync(process.execPath, ['-e', "console.log('PROBE_STDOUT_PRIVATE'); setInterval(() => {}, 1000)"], { timeout: 1000, encoding: 'utf8', windowsHide: true });
  const missing = spawnSync('ligule-deliberately-missing-probe-executable', [], { encoding: 'utf8', windowsHide: true });
  assert.equal(timeout.error?.code, 'ETIMEDOUT');
  assert.equal(missing.error?.code, 'ENOENT');
  assert.match(timeout.stdout, /PROBE_STDOUT_PRIVATE/u);
  for (const result of [timeout, missing]) {
    for (const statement of failures) {
      assert.throws(() => runInNewContext(statement, { mcpProbe: result, reopenProbe: result }), error => {
        assert.ok(error.message.includes(`status=${result.status}`));
        assert.ok(error.message.includes(`signal=${result.signal}`));
        assert.ok(error.message.includes(`error=${result.error.message}`));
        assert.ok(!error.message.includes('PROBE_STDOUT_PRIVATE'));
        return true;
      });
    }
  }
});
