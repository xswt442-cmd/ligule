import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import yauzl from 'yauzl';
import { KernelError } from '../kernel/error.js';
import { IMAGE_LIMITS } from '../session/media.js';
import { DOCUMENT_LIMITS, type DocumentChunk, type DocumentOptions, type DocumentRequest, type DocumentResult } from './document-types.js';

/** Validate actual inflated bytes, not just ZIP directory size declarations. Never extracts files. */
async function checkOfficeZip(input: Buffer, format: string): Promise<void> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.fromBuffer(input,
    { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, value) => error ? reject(error) : resolve(value!)));
  let entries = 0;
  let inflated = 0;
  let mainPart = false;
  const seen = new Set<string>();
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', (entry: yauzl.Entry) => {
        void (async () => {
          if (++entries > DOCUMENT_LIMITS.zipEntries || seen.has(entry.fileName)) throw new KernelError('document_archive_limit');
          seen.add(entry.fileName);
          if (entry.isEncrypted()) throw new KernelError('document_password_required');
          if (entry.uncompressedSize > DOCUMENT_LIMITS.zipBytes - inflated) throw new KernelError('document_archive_limit');
          if (entry.fileName === ({ docx: 'word/document.xml', xlsx: 'xl/workbook.xml', pptx: 'ppt/presentation.xml' } as Record<string, string>)[format]) mainPart = true;
          const stream = await new Promise<NodeJS.ReadableStream>((resolveStream, rejectStream) =>
            zip.openReadStream(entry, (error, value) => error ? rejectStream(error) : resolveStream(value!)));
          for await (const chunk of stream) {
            inflated += Buffer.byteLength(chunk);
            if (inflated > DOCUMENT_LIMITS.zipBytes) throw new KernelError('document_archive_limit');
          }
          zip.readEntry();
        })().catch(error => { zip.close(); reject(error); });
      });
      zip.readEntry();
    });
  } finally { zip.close(); }
  if (!mainPart) throw new KernelError('document_format_mismatch');
}

function boundedChunks(request: DocumentRequest, units: readonly DocumentChunk[], total: number,
  warnings: readonly string[], next: (unit: number, offset: number) => DocumentOptions, sheets?: readonly string[]): DocumentResult {
  let budget = request.outputBytes;
  const chunks: DocumentChunk[] = [];
  let continuation: DocumentOptions | null = null;
  for (let index = 0; index < units.length; index++) {
    const unit = units[index];
    const offset = index === 0 ? request.options.offset ?? 0 : 0;
    if (offset > unit.text.length) throw new KernelError('document_offset_invalid');
    const previous = unit.text.charCodeAt(offset - 1);
    const current = unit.text.charCodeAt(offset);
    if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) throw new KernelError('document_offset_invalid');
    let text = '';
    let consumed = 0;
    for (const character of unit.text.slice(offset)) {
      const bytes = Buffer.byteLength(character);
      if (bytes > budget) break;
      budget -= bytes;
      text += character;
      consumed += character.length;
    }
    chunks.push({ location: unit.location, text });
    if (offset + consumed < unit.text.length) { continuation = next(index, offset + consumed); break; }
  }
  if (continuation === null && units.length > 0) continuation = next(units.length, 0);
  // The caller supplies the remaining units' cursor; a cursor beyond total means completion.
  if (continuation !== null && (continuation.range?.startRow ?? continuation.start ?? 1) > total) continuation = null;
  return { format: request.format, total, chunks, warnings: [...new Set(warnings)].slice(0, 40),
    truncated: continuation !== null, continuation, ...(sheets === undefined ? {} : { sheets }) };
}

async function office(request: DocumentRequest): Promise<{ result: DocumentResult }> {
  const { OfficeParser } = await import('officeparser');
  const ast = await OfficeParser.parseOffice(request.input, { ocr: false, extractAttachments: false,
    includeRawContent: false, allowRemoteAssets: false, ignoreNotes: false,
    decompressionLimits: { maxUncompressedBytes: DOCUMENT_LIMITS.zipBytes, maxZipEntries: DOCUMENT_LIMITS.zipEntries,
      maxTableCells: DOCUMENT_LIMITS.cells, maxXmlElements: 200_000, maxRepeatedContent: 1_000_000 } });
  if (ast.type !== request.format) throw new KernelError('document_format_mismatch');
  const nodes = ast.content;
  if (request.format === 'pptx' && nodes.length > DOCUMENT_LIMITS.units) throw new KernelError('document_page_limit');
  const start = request.options.start ?? 1;
  if (start > Math.max(nodes.length, 1)) throw new KernelError('document_range_invalid');
  const textOf = (node: typeof nodes[number]): string => {
    if (node.type === 'image' || node.type === 'chart' || node.type === 'drawing' || node.type === 'embed') return `[${node.type}: visual content not extracted]`;
    if (node.type === 'table') return (node.children ?? []).map(row =>
      (row.children ?? []).map(cell => cell.text ?? '').join('\t')).join('\n');
    if (node.children?.length) return node.children.map(textOf).join(node.type === 'paragraph' ? '' : '\n');
    return node.text ?? '';
  };
  const chunks = nodes.slice(start - 1, start - 1 + (request.options.count ?? 20)).map((node, index) => ({
    location: `${request.format === 'pptx' ? 'slide' : 'block'} ${start + index}`, text: textOf(node),
  }));
  const result = boundedChunks(request, chunks, nodes.length, ['Text extraction excludes embedded images, charts and drawings.', ...ast.warnings.map(item => item.code)],
    (index, offset) => ({ ...request.options, start: start + index, offset }));
  return { result: { ...result, truncated: result.truncated || ast.warnings.some(item => item.code.includes('LIMIT')) } };
}

async function spreadsheet(request: DocumentRequest): Promise<{ result: DocumentResult }> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  // ExcelJS declares a legacy Buffer type; its loader accepts the real Node Buffer.
  await workbook.xlsx.load(request.input as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  if (workbook.worksheets.length > DOCUMENT_LIMITS.units) throw new KernelError('document_sheet_limit');
  const sheets = workbook.worksheets.map(sheet => sheet.name);
  const sheet = request.options.sheet === undefined ? workbook.worksheets[0] : workbook.getWorksheet(request.options.sheet);
  if (sheet === undefined) throw new KernelError('document_sheet_not_found');
  const start = request.options.range?.startRow ?? request.options.start ?? 1;
  const end = request.options.range?.endRow ?? Math.min(sheet.rowCount, start + (request.options.count ?? 20) - 1);
  if (start > Math.max(sheet.rowCount, 1)) throw new KernelError('document_range_invalid');
  const left = request.options.range?.startColumn ?? 1;
  const right = request.options.range?.endColumn ?? Math.min(Math.max(sheet.columnCount, 1), 10);
  const chunks: DocumentChunk[] = [];
  for (let row = start; row <= end; row++) {
    const cells: string[] = [];
    for (let column = left; column <= right; column++) {
      const cell = sheet.getCell(row, column);
      const formula = cell.formula;
      const value = formula === undefined ? cell.text : `formula=${formula}; cached=${JSON.stringify(cell.result ?? null)}`;
      cells.push(`${cell.address}: ${value}`);
    }
    chunks.push({ location: `${sheet.name}!row ${row}`, text: cells.join('\n') });
  }
  const total = request.options.range?.endRow ?? sheet.rowCount;
  return { result: boundedChunks(request, chunks, total, ['Formulas are not evaluated; embedded objects and charts are not extracted.'],
    (index, offset) => request.options.range === undefined
      ? { ...request.options, sheet: sheet.name, start: start + index, offset }
      : { ...request.options, sheet: sheet.name, range: { ...request.options.range, startRow: start + index }, offset }, sheets) };
}

async function pdf(request: DocumentRequest): Promise<{ result: DocumentResult; png?: Buffer }> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('pdfjs-dist/package.json'));
  const loading = getDocument({ data: new Uint8Array(request.input), verbosity: 1,
    useWorkerFetch: false, useSystemFonts: false, useWasm: false, enableXfa: false, stopAtErrors: request.options.renderPage === undefined,
    maxImageSize: IMAGE_LIMITS.pixels, canvasMaxAreaInBytes: DOCUMENT_LIMITS.pixels * 4,
    standardFontDataUrl: join(root, 'standard_fonts') + '/',
    cMapUrl: join(root, 'cmaps') + '/', cMapPacked: true });
  const document = await loading.promise;
  try {
    if (document.numPages > DOCUMENT_LIMITS.units) throw new KernelError('document_page_limit');
    if (request.options.renderPage !== undefined) {
      if (request.options.renderPage > document.numPages) throw new KernelError('document_range_invalid');
      const page = await document.getPage(request.options.renderPage);
      const initial = page.getViewport({ scale: 1 });
      if (!Number.isFinite(initial.width) || !Number.isFinite(initial.height) || initial.width <= 0 || initial.height <= 0) throw new KernelError('document_page_invalid');
      const scale = Math.min(2, DOCUMENT_LIMITS.dimension / Math.max(initial.width, initial.height));
      const viewport = page.getViewport({ scale });
      if (Math.ceil(viewport.width) * Math.ceil(viewport.height) > DOCUMENT_LIMITS.pixels) throw new KernelError('document_pixels_exceeded');
      const { createCanvas } = await import('@napi-rs/canvas');
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvas: canvas as unknown as Parameters<typeof page.render>[0]['canvas'], viewport }).promise;
      const png = await canvas.encode('png');
      return { result: { format: 'pdf', total: document.numPages, chunks: [{ location: `page ${request.options.renderPage}`, text: 'Rendered page image; no OCR performed.' }],
        warnings: [], truncated: false, continuation: null }, png };
    }
    const start = request.options.start ?? 1;
    if (start > document.numPages) throw new KernelError('document_range_invalid');
    const chunks: DocumentChunk[] = [];
    const warnings: string[] = ['PDF text extraction excludes page images and charts; use renderPage for visual content.'];
    for (let index = start; index <= Math.min(document.numPages, start + (request.options.count ?? 20) - 1); index++) {
      const page = await document.getPage(index);
      const content = await page.getTextContent();
      const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('');
      if (text.trim() === '') warnings.push(`Page ${index} has no text layer; use renderPage=${index} with an image-capable model.`);
      chunks.push({ location: `page ${index}`, text });
      page.cleanup();
    }
    return { result: boundedChunks(request, chunks, document.numPages, warnings,
      (index, offset) => ({ ...request.options, start: start + index, offset })) };
  } finally { await loading.destroy(); }
}

export async function parseDocument(request: DocumentRequest): Promise<{ result: DocumentResult; png?: Buffer }> {
  if (request.format !== 'pdf') await checkOfficeZip(request.input, request.format);
  if (request.format === 'pdf') return await pdf(request);
  if (request.format === 'xlsx') return await spreadsheet(request);
  return await office(request);
}
