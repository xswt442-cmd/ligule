// 失败行的解释文案：已知码用固定句子，未知但明显是提供方 HTTP 故障的码也要说人话，原始信息留详情。
import assert from 'node:assert/strict';
import { failureExplanation, turnFailure } from '../../src/turn-failure.ts';

const httpFailure = failureExplanation('openai_http_error', 'Provider replied HTTP 503.');
assert.equal(httpFailure.original, true);
assert.match(httpFailure.explanation[0], /HTTP 503/u);
assert.match(httpFailure.explanation[1], /HTTP 503/u);

const withoutStatus = failureExplanation('openai_http_error', 'connection dropped');
assert.equal(withoutStatus.original, true);
assert.match(withoutStatus.explanation[0], /模型服务返回错误/u);

const known = failureExplanation('provider_credential_missing');
assert.equal(known.original, false);
assert.equal(known.explanation[0], turnFailure('provider_credential_missing').explanation[0]);

const unknown = failureExplanation('some_future_code');
assert.equal(unknown.original, true);
assert.match(unknown.explanation[0], /本轮未能完成/u);

const timeout = failureExplanation('provider_timeout');
assert.equal(timeout.original, false);
assert.match(timeout.explanation[0], /超过时限/u);
