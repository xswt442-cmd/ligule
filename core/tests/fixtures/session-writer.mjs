import { createSessionLog } from '../../dist/session/session.js';
import { once } from 'node:events';

const [operation, directory, id, text = 'child writer'] = process.argv.slice(2);
const session = createSessionLog({ directory, id, meta: { projectRoot: directory } });

function report(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

try {
  await session.acquire();
  await session.append({ kind: 'user', text });
  report({ acquired: true, path: session.path });
  if (operation === 'hold') {
    process.stdin.resume();
    await once(process.stdin, 'end');
  }
  await session.close();
} catch (error) {
  await session.close();
  report({ acquired: false, code: error.code, message: error.message });
}
