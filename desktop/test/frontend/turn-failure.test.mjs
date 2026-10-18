import test from 'node:test';
import assert from 'node:assert/strict';
import { turnFailure } from '../../frontend/src/turn-failure.ts';

test('response completion and budget errors have actionable bilingual Desktop explanations', () => {
  const fallback = turnFailure('unknown_error').explanation;
  for (const code of [
    'provider_output_exhausted', 'provider_empty_response', 'provider_stream_incomplete',
    'provider_stream_interrupted', 'provider_finish_reason_invalid', 'provider_tool_call_invalid',
    'provider_output_budget_invalid', 'provider_output_budget_unsupported',
  ]) {
    const explanation = turnFailure(code).explanation;
    assert.notDeepEqual(explanation, fallback, `${code} requires specific guidance`);
    assert.match(explanation[0], /[\u3400-\u9fff]/u);
    assert.doesNotMatch(explanation[1], /[\u3400-\u9fff]/u);
  }
});

test('Provider errors retain only safe HTTP diagnostics in the session turn summary', () => {
  const failure = turnFailure('provider_http_error', {
    category: 'authentication', status: 401, attempts: 2,
    responseReceived: true, streamReceived: false, recoverable: false,
    url: 'https://user:secret@example.invalid/?key=private',
  });
  assert.match(failure.diagnostic[0], /HTTP 401.*身份认证.*尝试 2 次.*收到响应/u);
  assert.match(failure.diagnostic[1], /HTTP 401.*authentication.*2 attempts.*response received/u);
  assert.doesNotMatch(failure.diagnostic.join(' '), /secret|private|example\.invalid/u);
  assert.equal(turnFailure('provider_http_error', { category: 'http', attempts: 0 }).diagnostic, undefined);
});
