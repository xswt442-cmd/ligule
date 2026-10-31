import assert from 'node:assert/strict';
import { defaultSettings, settingsFrom } from '../../src/settings.ts';

assert.equal(settingsFrom({ font: 'small' }).fontUi, 15, 'legacy small preference remains close to its previous scale');
assert.equal(settingsFrom({ font: 'medium' }).fontUi, 16, 'legacy medium preference keeps the browser default scale');
assert.equal(settingsFrom({ font: 'large' }).fontUi, 18, 'legacy large preference remains close to its previous scale');
assert.equal(settingsFrom({ fontUser: 40 }).fontUser, 14, 'invalid message font falls back safely');

const chosen = settingsFrom({ fontUi: 11, fontUser: 30, fontAssistant: 19, transcriptLineHeight: 2.3 });
assert.deepEqual(
  [chosen.fontUi, chosen.fontUser, chosen.fontAssistant, chosen.transcriptLineHeight],
  [11, 30, 19, 2.3],
  'role font sizes and transcript line height load independently',
);
assert.equal(settingsFrom({ ...chosen }).fontAssistant, 19, 'new appearance preferences survive serialization');
assert.equal(defaultSettings.transcriptLineHeight, 1.6);
console.log('外观设置兼容性检查通过');
