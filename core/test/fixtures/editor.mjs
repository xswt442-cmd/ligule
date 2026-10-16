import { readFile, rm, writeFile } from 'node:fs/promises';

const [operation, markerPath, markerText, exitCode, draftPath] = process.argv.slice(2);

if (markerPath !== '-') await writeFile(markerPath, markerText, 'utf8');

if (operation === 'append-crlf') {
  const draft = await readFile(draftPath, 'utf8');
  await writeFile(draftPath, `${draft} edited\r\n`, 'utf8');
} else if (operation === 'remove') {
  await rm(draftPath);
} else if (operation === 'exit') {
  process.exit(Number(exitCode));
}
