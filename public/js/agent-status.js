/* Один статус агента для карты, полосы, окна и дашборда.
   Считает уже готовое поле activity. Порог 15 минут живёт на сервере. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AgentStatus = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LABEL = {
    working: 'Работает',
    coordinating: 'Координирует',
    waiting: 'Ждёт',
    resting: 'Спит',
  };

  function activityMode(agent) {
    if (agent && agent.activity === 'working') return 'working';
    if (agent && agent.activity === 'coordinating') return 'coordinating';
    if (agent && agent.activity === 'waiting') return 'waiting';
    return 'resting';
  }

  function activityLabel(agent) {
    return LABEL[activityMode(agent)] || LABEL.resting;
  }

  function statusTone(agent) {
    const mode = activityMode(agent);
    if (mode === 'working') return 'working';
    if (mode === 'waiting') return 'waiting';
    return 'idle';
  }

  function viewStatus(agent) {
    const mode = activityMode(agent);
    const label = activityLabel(agent);
    const tone = statusTone(agent);
    return {
      mode,
      label,
      tone,
      map: tone,
      sidebar: tone,
      panel: label,
      dashboard: label,
    };
  }

  return { activityMode, activityLabel, statusTone, viewStatus };
});
