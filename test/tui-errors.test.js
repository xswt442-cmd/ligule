import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeFailureText } from '../dist/tui/errors.js';

const actionableCodes = [
  'provider_credential_missing',
  'credential_store_unavailable',
  'host_model_config_missing',
  'provider_api_form_required',
  'provider_base_url_required',
  'provider_model_required',
  'model_service_not_found',
  'model_not_available',
  'provider_transport_failed',
  'provider_http_error',
  'provider_stream_invalid',
  'provider_tool_args_invalid',
];

test('known runtime failures give next steps in Chinese and English', () => {
  for (const code of actionableCodes) {
    const chinese = runtimeFailureText(code);
    const english = runtimeFailureText(code, 'en');
    assert.ok(chinese, `${code} has Chinese guidance`);
    assert.ok(english, `${code} has English guidance`);
    assert.match(chinese, /[。；：]|\/model|\/credentials/u, `${code} gives a next step`);
    assert.doesNotMatch(english, /[\u3400-\u9fff]/u, `${code} English text contains no Chinese`);
  }
});

test('credential and response failures avoid exposing secret or response details', () => {
  const credential = runtimeFailureText('provider_credential_missing');
  const response = runtimeFailureText('provider_http_error');
  assert.match(credential, /\/credentials/u);
  assert.match(credential, /环境变量/u);
  assert.match(credential, /桌面/u);
  assert.doesNotMatch(response, /response body|原始响应|响应正文/u);
});

test('unknown runtime failure codes remain available to the caller', () => {
  assert.equal(runtimeFailureText('future_error_code'), undefined);
  assert.equal(runtimeFailureText('future_error_code', 'en'), undefined);
});
