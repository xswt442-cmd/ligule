// 本地请求诊断的单条摘要：只展示计数、来源与缓存，不包含请求正文或凭据。
import { textOf as chooseText, type Locale } from '@ligule/core/tui.js';
import { isRecord } from './guards.js';

export function requestDiagnosticLines(entries: readonly Record<string, unknown>[], locale: Locale = 'zh'): string[] {
  const t = (zh: string, en: string) => chooseText(locale, zh, en);
  return entries.map((entry) => {
    const components = isRecord(entry.components) ? entry.components : {};
    const compaction = isRecord(entry.compaction) ? entry.compaction : {};
    const truncation = isRecord(entry.truncation) ? entry.truncation : {};
    const resolvedImages = isRecord(entry.resolvedImages) ? entry.resolvedImages : {};
    const cache = isRecord(entry.cache) ? entry.cache : undefined;
    const request = typeof entry.requestId === 'string' ? entry.requestId.slice(0, 8) : 'request';
    const attempt = typeof entry.attempt === 'number' ? entry.attempt : '?';
    const provider = typeof entry.provider === 'string' ? entry.provider : 'unknown';
    const model = typeof entry.model === 'string' ? entry.model : 'unknown';
    const number = (value: unknown) => typeof value === 'number' ? value : 0;
    const usage = (value: unknown) => typeof value === 'number' ? String(value) : t('未知', 'unknown');
    const blocks = Array.isArray(compaction.blocks) ? compaction.blocks : [];
    const ranges = blocks.flatMap((item) => isRecord(item) && typeof item.fromSeq === 'number' && typeof item.toSeq === 'number'
      ? [`${item.fromSeq}–${item.toSeq}`] : []);
    const cacheSummary = cache === undefined ? t('缓存用量未报', 'cache usage unreported')
      : t(`缓存命中 ${usage(cache.hitInputTokens)}、未命中 ${usage(cache.missInputTokens)}`, `cache hit ${usage(cache.hitInputTokens)}, miss ${usage(cache.missInputTokens)}`);
    return [
      `${request} · ${provider}/${model} · ${t(`尝试 ${attempt}`, `attempt ${attempt}`)} · ${String(entry.status ?? 'unknown')}`,
      t(`估算 ${number(entry.estimatedInputTokens)} tokens（${String(entry.estimateMethod ?? 'unknown')}）；实报输入 ${usage(entry.inputTokens)}、输出 ${usage(entry.outputTokens)}`,
        `estimated ${number(entry.estimatedInputTokens)} tokens (${String(entry.estimateMethod ?? 'unknown')}); reported input ${usage(entry.inputTokens)}, output ${usage(entry.outputTokens)}`) + ` · ${cacheSummary}`,
      t(`字节：系统 ${number(components.systemBytes)}（前缀 ${number(components.systemPrefixBytes)}、指南 ${number(components.projectGuideBytes)}、动态 ${number(components.dynamicContextBytes)}），工具 Schema ${number(components.toolSchemaBytes)}，历史 ${number(components.historyBytes)}，图片 ${number(components.imageReferenceCount)} 个（引用 ${number(components.imageReferenceBytes)} 字节；已解析 ${number(resolvedImages.count)} 个、${number(resolvedImages.bytes)} 字节）`,
        `bytes: system ${number(components.systemBytes)} (prefix ${number(components.systemPrefixBytes)}, guides ${number(components.projectGuideBytes)}, dynamic ${number(components.dynamicContextBytes)}), tool schemas ${number(components.toolSchemaBytes)}, history ${number(components.historyBytes)}, images ${number(components.imageReferenceCount)} (${number(components.imageReferenceBytes)} reference bytes; ${number(resolvedImages.count)} resolved, ${number(resolvedImages.bytes)} bytes)`),
      t(`投影准备：提示片段截断 ${number(truncation.promptFragments)} 处，消息 ${number(truncation.messagesBeforePreparation)} → ${number(truncation.messagesAfterPreparation)}；${truncation.preparationChangedProjection === true ? '压缩或提醒改变了投影' : '未改变投影'}`,
        `request preparation: ${number(truncation.promptFragments)} prompt fragments truncated, ${number(truncation.messagesBeforePreparation)} → ${number(truncation.messagesAfterPreparation)} messages; ${truncation.preparationChangedProjection === true ? 'compaction or reminder changed it' : 'unchanged'}`),
      t(`压缩块 ${ranges.length === 0 ? '无' : ranges.join('、')}；摘要请求 ${number(compaction.summaryRequests)} 次（${String(compaction.summaryUsageScope ?? 'unknown')}）：输入 ${usage(compaction.summaryInputTokens)}、输出 ${usage(compaction.summaryOutputTokens)}、缓存 ${usage(compaction.summaryCachedInputTokens)}`,
        `compaction blocks ${ranges.length === 0 ? 'none' : ranges.join(', ')}; ${number(compaction.summaryRequests)} summary requests (${String(compaction.summaryUsageScope ?? 'unknown')}): input ${usage(compaction.summaryInputTokens)}, output ${usage(compaction.summaryOutputTokens)}, cached ${usage(compaction.summaryCachedInputTokens)}`)
        + t(` · 检查点 ${String(compaction.checkpointValidation ?? 'unknown')}${typeof compaction.checkpointValidationReason === 'string' ? ` (${compaction.checkpointValidationReason})` : ''}`,
          ` · checkpoint ${String(compaction.checkpointValidation ?? 'unknown')}${typeof compaction.checkpointValidationReason === 'string' ? ` (${compaction.checkpointValidationReason})` : ''}`),
    ].join('\n');
  });
}
