import { parseDocument } from './document-parser.js';
import { Console } from 'node:console';
import { checkedDocumentOptions, DOCUMENT_LIMITS, type DocumentRequest } from './document-types.js';

if (!process.connected) throw new Error('document_worker_requires_ipc');
// stdout is the bounded result protocol; library diagnostics belong on stderr.
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
let completed = false;
process.once('disconnect', () => process.exit(completed ? 0 : 1));
process.once('message', async (request: DocumentRequest) => {
  try {
    if (!Buffer.isBuffer(request.input) || request.input.length > DOCUMENT_LIMITS.inputBytes
      || !Number.isSafeInteger(request.outputBytes) || request.outputBytes < 256 || request.outputBytes > DOCUMENT_LIMITS.outputBytes
      || checkedDocumentOptions(request.options) !== request.format) throw new Error('document_options_invalid');
    const { result, png } = await parseDocument(request);
    if (png !== undefined && png.length > 8 * 1024 * 1024) throw new Error('document_image_bytes_exceeded');
    process.stdout.write(JSON.stringify({ result, ...(png === undefined ? {} : { png: png.toString('base64') }) }), () => {
      completed = true;
      process.disconnect?.();
    });
  } catch (error) {
    const issue = error as { code?: unknown; name?: string; message?: string; officeIssue?: { code?: string } };
    const own = typeof issue.code === 'string' ? issue.code : issue.message;
    const code = typeof own === 'string' && own.startsWith('document_') ? own
      : issue.name === 'PasswordException' || issue.officeIssue?.code === 'PASSWORD_REQUIRED' ? 'document_password_required'
      : issue.message?.includes('Image exceeded maximum allowed size') ? 'document_pixels_exceeded'
      : issue.officeIssue?.code?.includes('LIMIT') ? 'document_archive_limit' : 'document_parse_failed';
    process.send?.({ error: code }, () => { completed = true; process.disconnect?.(); });
  }
});
process.send?.({ ready: process.pid });
