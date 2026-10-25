import { setTimeout as delay } from 'node:timers/promises';
import { createKernel, createLoop, createSessionLog } from '../../dist/index.js';

const directory = process.argv[2];
const session = createSessionLog({ directory, id: 'interrupted-stream' });
await session.acquire();
const provider = {
  async *stream() {
    yield { type: 'text', text: 'Visible unfinished text. ' + '界🙂'.repeat(6000) };
    yield { type: 'reasoning', text: 'Unconfirmed reasoning.' };
    await delay(500);
    process.stdout.write('STREAM_VISIBLE\n');
    await delay(60_000);
  },
};
await createLoop({ kernel: createKernel({ session }), provider, session }).run('Inspect provisional persistence.');
