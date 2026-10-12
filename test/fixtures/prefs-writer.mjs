import { savePrefs } from '../../dist/kernel/desktop-prefs.js';

const [path, version, json] = process.argv.slice(2);

try {
  const saved = await savePrefs(path, JSON.parse(json), { version });
  process.stdout.write(JSON.stringify({ saved }));
} catch (error) {
  process.stdout.write(JSON.stringify({ code: error.code ?? 'unknown_error' }));
  process.exitCode = 1;
}
