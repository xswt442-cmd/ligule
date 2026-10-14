// 查询 npm 版本；只有 E404 表示缺少版本，其余查询失败都阻止发布。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnNpm } from './npm-cli.js';

const [specification, tarball] = process.argv.slice(2);
if (!specification) throw new Error('provide a package version specification');
const result = spawnNpm(['view', specification, '--json'], {
  encoding: 'utf8', timeout: 60_000, windowsHide: true,
});
let metadata;
try { metadata = JSON.parse(result.stdout); }
catch { throw new Error(`registry_query_failed: ${result.error?.code ?? result.status ?? 'invalid_json'}`); }
if (result.status !== 0) {
  if (metadata?.error?.code === 'E404') process.stdout.write('missing\n');
  else throw new Error(`registry_query_failed: ${metadata?.error?.code ?? result.error?.code ?? result.status}`);
} else {
  if (tarball !== undefined) {
    const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
    if (metadata?.dist?.integrity !== integrity) throw new Error(`registry_artifact_conflict: ${specification}`);
  }
  process.stdout.write('present\n');
}
