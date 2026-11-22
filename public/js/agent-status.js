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

  const VIEW_NAMES = ['hierarchy', 'room', 'dashboard', 'card', 'roster', 'map'];

  // Подпись статуса только из activity (живой ход и окно 15 минут уже на сервере).
  function statusLabel(agent) {
    return LABEL[finalStatus(agent)] || LABEL.resting;
  }

  function viewLabels(agent) {
    const label = statusLabel(agent);
    const labels = {};
    for (const name of VIEW_NAMES) labels[name] = label;
    return labels;
  }

  function ownDoing(agent) {
    if (!agent || typeof agent.doing !== 'string') return '';
    return agent.doing.trim();
  }

  // Свой doing. Если его нет — свой currentTask. Чужой ход приходит как «Имя: текст».
  function chipCaption(agent) {
    const own = ownDoing(agent);
    if (own) return own;
    if (!agent || agent.activity === 'coordinating') return '';
    const task = typeof agent.currentTask === 'string' ? agent.currentTask.trim() : '';
    if (!task) return '';
    if (task.includes(': ')) return '';
    return task;
  }

  // Советник сидит в Кремле, но остаётся в нижней панели. Замы и архив — нет.
  function inBottomRoster(agent, roomOf) {
    if (!agent || agent.archived || agent.vacant) return false;
    if (agent.parentId) return false;
    if (agent.id === 'advisor') return true;
    const host = roomOf && roomOf[agent.id];
    return !host;
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

  return {
    finalStatus,
    activityMode,
    activityLabel,
    statusLabel,
    viewLabels,
    statusTone,
    viewStatus,
    presence,
    ownDoing,
    chipCaption,
    inBottomRoster,
  };
});
