import { KernelError } from '../kernel/error.js';
import type { ToolContext, ToolDefinition } from '../kernel/kernel.js';
import { readDocument, type DocumentOptions } from '../capability/document.js';
import type { MediaStore } from '../capability/media.js';

interface DocumentDeps { readonly media?: MediaStore; readonly supportsImages?: () => boolean }

export function createReadDocumentPlugin({ media, supportsImages }: DocumentDeps = {}) {
  return {
    name: 'ligule-read-document',
    setup(kernel: { register(tool: unknown): () => void }) {
      return kernel.register({
        name: 'read_document', access: 'read', readOnly: true, execution: 'parallel',
        description: 'Read bounded PDF pages, DOCX paragraph/table blocks, XLSX cells or PPTX slides inside the file boundary. start/count are 1-based units (default first 20; XLSX rows default first ten columns). offset is a UTF-16 text offset returned by continuation. XLSX range uses numeric row/column bounds. PDF renderPage returns one actual page image and requires image input support. Does not perform OCR, execute macros, evaluate formulas or fetch document links. Follow returned continuation exactly when truncated.',
        parameters: { type: 'object', additionalProperties: false, properties: {
          path: { type: 'string', minLength: 1, maxLength: 2048 },
          start: { type: 'integer', minimum: 1, maximum: 1048576 },
          count: { type: 'integer', minimum: 1, maximum: 20 },
          offset: { type: 'integer', minimum: 0, maximum: 67108864 },
          sheet: { type: 'string', minLength: 1, maxLength: 128 },
          range: { type: 'object', additionalProperties: false, properties: {
            startRow: { type: 'integer', minimum: 1, maximum: 1048576 },
            endRow: { type: 'integer', minimum: 1, maximum: 1048576 },
            startColumn: { type: 'integer', minimum: 1, maximum: 16384 },
            endColumn: { type: 'integer', minimum: 1, maximum: 16384 },
          }, required: ['startRow', 'endRow', 'startColumn', 'endColumn'] },
          renderPage: { type: 'integer', minimum: 1, maximum: 200 },
        }, required: ['path'] },
        async run(args: DocumentOptions, { config, signal }: Pick<ToolContext, 'config' | 'signal'>) {
          if (args.renderPage !== undefined) {
            if (supportsImages?.() !== true) throw new KernelError('model_image_input_unsupported');
            if (media === undefined) throw new KernelError('image_store_unavailable');
          }
          const { result, png } = await readDocument(config, args, signal);
          signal?.throwIfAborted();
          const text = JSON.stringify({ path: args.path, ...result });
          if (png === undefined) return text;
          signal?.throwIfAborted();
          const reference = await media!.put(png, 'document', signal);
          return { kind: 'image_result', text, images: [reference] };
        },
      } satisfies ToolDefinition<DocumentOptions>);
    },
  };
}
