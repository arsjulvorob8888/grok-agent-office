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

  // Итог один. Если сервер прислал activity, он важнее сырого status.
  // status=working и activity=resting — это отдых, не зелёная точка.
  function finalStatus(agent) {
    const activity = agent && agent.activity;
    if (activity === 'working' || activity === 'coordinating' || activity === 'waiting' || activity === 'resting') {
      return activity;
    }
    if (agent && agent.status === 'working') return 'working';
    if (agent && agent.status === 'waiting') return 'waiting';
    return 'resting';
  }

  function activityMode(agent) {
    return finalStatus(agent);
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

  // Точка и яркость фигурки — одно решение. Тусклый вид только у неактивного.
  function presence(agent) {
    const mode = activityMode(agent);
    const tone = statusTone(agent);
    const inactive = mode === 'resting';
    return {
      mode,
      tone,
      dot: tone,
      opacity: inactive ? 0.55 : 1,
      filter: inactive ? 'grayscale(0.4)' : 'none',
      bright: !inactive,
    };
  }

  return { finalStatus, activityMode, activityLabel, statusTone, viewStatus, presence };
});
