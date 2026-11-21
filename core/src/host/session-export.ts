// 会话导出：读取完整记录、派生会话与图片资产，排版为可离线阅读的 Markdown 并逐文件写出。
// 用户通过保存对话框选择的路径不受项目边界限制；每个文件的写入/跳过/失败分别报告。
import { dirname, join } from 'node:path';
import { KernelError } from '../kernel/error.js';
import { errorCode, errorMessage } from '../tools/common.js';
import { createMediaStore } from '../capability/media.js';
import { IMAGE_LIMITS, type ImageReference } from '../media.js';
import type { SessionEvent, SessionHeader } from '../session/format.js';
import type { SessionDirectoryConfig } from '../session/list.js';
import { branchSessionId, exportImageUrl, exportMarkdown, exportRecordOf, MAX_EXPORT_ASSETS, readExportEvidence, writeExport, type ExportAsset, type ExportRecord } from './export.js';

export type ExportEnvironment = {
  readonly projectRoot: string;
  readonly directory: string;
  readonly config: SessionDirectoryConfig;
};

export type ExportRecordPage = {
  readonly header?: SessionHeader | null;
  readonly events: readonly SessionEvent[];
};

export type SessionExportScope = {
  readonly sessionId: string;
  readonly path: string;
  readonly environmentOf: (id: string) => ExportEnvironment | undefined;
  readonly defaultEnvironment: ExportEnvironment;
  readonly branchOwner: (id: string) => string | undefined;
  readonly running: boolean;
  readonly readRecord: (id: string, params: { fullResults: boolean }) => Promise<ExportRecordPage>;
};

export async function exportSession(scope: SessionExportScope) {
  const { sessionId, path, environmentOf, defaultEnvironment, branchOwner, running, readRecord } = scope;
  const record = await readRecord(sessionId, { fullResults: true });
  const exportEnvironment = environmentOf(sessionId) ?? environmentOf(branchOwner(sessionId) ?? '') ?? defaultEnvironment;
  const assets: ExportAsset[] = [];
  const assetFailures: { path: string; code: string }[] = [];
  const imageUrls = new Map<string, string>();
  const seenImages = new Map<string, ImageReference>();
  let assetBytes = 0;
  const collectImages = async (id: string, records: readonly ExportRecord[]) => {
    const references = records.flatMap(item => item.result?.images ?? []);
    if (references.length === 0) return;
    const media = createMediaStore({ ...exportEnvironment.config, workspaceRoot: exportEnvironment.projectRoot }, id, references);
    for (const reference of references) {
      const previous = seenImages.get(reference.id);
      if (previous !== undefined && (Object.keys(previous) as (keyof ImageReference)[]).every(key => previous[key] === reference[key])) continue;
      const failedPath = join(dirname(path), decodeURIComponent(exportImageUrl(path, reference.id)));
      if (previous !== undefined) {
        imageUrls.delete(reference.id);
        assetFailures.push({ path: failedPath, code: 'export_asset_conflict' });
        continue;
      }
      seenImages.set(reference.id, reference);
      if (assets.length >= MAX_EXPORT_ASSETS || assetBytes + reference.bytes > IMAGE_LIMITS.storageBytes) {
        assetFailures.push({ path: failedPath, code: 'export_asset_limit_exceeded' });
        continue;
      }
      try {
        const data = await media.read(reference);
        assets.push({ reference, data });
        assetBytes += data.length;
        imageUrls.set(reference.id, exportImageUrl(path, reference.id));
      } catch (error) {
        assetFailures.push({ path: failedPath, code: errorCode(error) ?? 'image_unavailable' });
      }
    }
  };
  const header: SessionHeader | undefined = record.header ?? undefined;
  const exportRecords = record.events.flatMap((event) => {
    const item = exportRecordOf(event);
    return item === undefined ? [] : [item];
  });
  await collectImages(sessionId, exportRecords);
  // 同时导出父会话记录引用的派生会话内容。
  const branches = [];
  const skipped = [];
  for (const event of record.events) {
    const item = exportRecordOf(event);
    if (item === undefined) continue;
    const branchId = branchSessionId(item);
    if (branchId === undefined) continue;
    let branch;
    try {
      branch = await readRecord(branchId, { fullResults: true });
    } catch (error) {
      skipped.push({ id: branchId, code: errorCode(error) ?? 'session_read_failed' });
      continue;
    }
    const branchEvents = branch.events.flatMap((event) => {
      const exported = exportRecordOf(event);
      return exported === undefined ? [] : [exported];
    });
    await collectImages(branchId, branchEvents);
    branches.push({ id: branchId, events: branchEvents });
  }
  // 导出件要能离线读到日志与基线正文；读不到就写明原因，不能静默保留一个悬空引用。
  const evidence = await readExportEvidence(exportEnvironment.directory,
    [...exportRecords, ...branches.flatMap((branch) => branch.events)]);
  try {
    // 对每个导出文件分别返回结果，包括路径冲突和写入失败，并附上主文件路径。
    const main = exportMarkdown(exportRecords, {
      id: sessionId, projectRoot: header?.projectRoot, createdAt: header?.createdAt ?? null,
      unfinished: running,
    }, imageUrls, evidence);
    const branchTexts = branches.map(branch => ({ id: branch.id,
      text: exportMarkdown(branch.events, { id: branch.id, projectRoot: header?.projectRoot }, imageUrls, evidence) }));
    const done = await writeExport(path, main, branchTexts, assets);
    return { written: done.written, skipped: [...skipped, ...done.skipped], failed: [...assetFailures, ...done.failed] };
  } catch (cause) {
    if (cause instanceof KernelError) throw cause;
    // 无法创建目标目录时，报告整批导出尚未开始。
    throw new KernelError('host_export_write_failed', { cause, detail: `${path}: ${errorMessage(cause) ?? String(cause)}` });
  }
}
