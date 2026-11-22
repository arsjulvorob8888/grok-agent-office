/* Тестовые и отменённые приказы не видны как метки и не дают опыт.
   Один расчёт и для страницы, и для сервера. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TaskRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function isTestTask(task) {
    return String(task && task.text || '').trim().toLowerCase() === 'тест';
  }

  function isCancelledTask(task) {
    if (!task) return false;
    if (task.orderStatus === 'cancelled') return true;
    const status = String(task.status || '').trim().toLowerCase();
    return status === 'отменён' || status === 'отменен' || status === 'cancelled';
  }

  function isSilentTask(task) {
    return !!(task && (isTestTask(task) || isCancelledTask(task)));
  }

  function taskSurface(task) {
    if (!task || isSilentTask(task)) return { tag: '', badge: '', count: 0 };
    const text = String(task.text || '').trim();
    return { tag: text, badge: text, count: 1 };
  }

  function executorId(task) {
    return String((task && (task.agentId || task.agent)) || '');
  }

  function isDoneTask(task) {
    if (!task) return false;
    return task.orderStatus === 'done' || task.status === 'выполнена';
  }

  // Хранимый completed мог включать тестовые и отменённые. Лишние вычитаются,
  // свободные отметки без приказа (сверх всех done) остаются.
  function creditedCompleted(agent, tasks) {
    const id = agent && agent.id;
    const mine = (tasks || []).filter((task) => executorId(task) === id);
    const goodDone = mine.filter((task) => isDoneTask(task) && !isSilentTask(task)).length;
    const allDone = mine.filter((task) => isDoneTask(task)).length;
    const stored = Number(agent && agent.completed) || 0;
    const extras = Math.max(0, stored - allDone);
    return goodDone + extras;
  }

  function sentForXp(agent, tasks) {
    const id = agent && agent.id;
    return (tasks || []).filter((task) => executorId(task) === id && !isSilentTask(task)).length;
  }

  function xpOf(agent, tasks) {
    const completed = creditedCompleted(agent, tasks);
    const sent = sentForXp(agent, tasks);
    const xp = completed * 100 + sent * 10;
    let lvl = 1;
    let need = 150;
    let base = 0;
    while (xp >= base + need) {
      base += need;
      lvl += 1;
      need = 150 + (lvl - 1) * 75;
    }
    return { xp, lvl, into: xp - base, need, sent, completed };
  }

  return {
    isTestTask,
    isCancelledTask,
    isSilentTask,
    taskSurface,
    executorId,
    isDoneTask,
    creditedCompleted,
    sentForXp,
    xpOf,
  };
});
