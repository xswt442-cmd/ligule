import assert from 'node:assert/strict';
import { defaultNotifications, NOTIFICATION_KINDS, notificationOf, notificationsFrom, notificationTarget } from '../../src/notifications.ts';
import { settingsFrom } from '../../src/settings.ts';

assert.deepEqual(notificationsFrom(undefined), defaultNotifications);
for (const kind of NOTIFICATION_KINDS) {
  const settings = settingsFrom({ notifications: { enabled: false, [kind]: false } });
  assert.equal(settings.notifications.enabled, false);
  assert.equal(settings.notifications[kind], false);
  const roundTrip = settingsFrom(JSON.parse(JSON.stringify(settings)));
  assert.deepEqual(roundTrip.notifications, settings.notifications);
  for (const locale of ['zh', 'en']) {
    const target = { sessionId: 'session-a', projectRoot: 'E:/中文项目' };
    const notification = notificationOf(kind, locale, target, 'Review');
    assert.deepEqual(notificationTarget(notification.target), target);
    assert.equal(notification.title, 'ligule');
    assert.match(notification.body, /^Review · /);
    assert.equal(notification.openLabel, locale === 'en' ? 'Open conversation' : '打开会话');
    if (locale === 'en') assert.doesNotMatch(notification.body, /[\u3400-\u9fff]/u);
  }
}
assert.equal(notificationTarget(notificationOf('disconnected', 'en').target), null);
assert.throws(() => notificationTarget('{'));
for (const invalid of ['null', '[]', '{}', '{"sessionId":1,"projectRoot":"a"}', '{"sessionId":"","projectRoot":"a"}']) {
  assert.throws(() => notificationTarget(invalid));
}
assert.equal(notificationsFrom({ enabled: 'false', failed: 0 }).enabled, true);
assert.equal(notificationsFrom({ enabled: 'false', failed: 0 }).failed, true);
console.log('桌面通知设置与目标检查通过');
