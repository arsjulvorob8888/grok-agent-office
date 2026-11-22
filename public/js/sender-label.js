/* Имя отправителя на экране. Идентификатор owner не меняется. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OfficeSender = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const OWNER_SENDER_NAME = 'Путин';

  function senderName(id) {
    if (!id || id === 'owner') return OWNER_SENDER_NAME;
    return '';
  }

  // Реплика самого Арсения. Маршрут приказа по-прежнему «Путин →».
  function speakerLabel(id) {
    if (!id || id === 'owner') return 'Вы';
    return '';
  }

  function displayOrderSender(text) {
    const raw = String(text ?? '');
    const legacy = 'Приказ: Владелец →';
    const next = `Приказ: ${OWNER_SENDER_NAME} →`;
    if (!raw.includes(legacy)) return raw;
    return raw.split(legacy).join(next);
  }

  return { OWNER_SENDER_NAME, senderName, speakerLabel, displayOrderSender };
});
