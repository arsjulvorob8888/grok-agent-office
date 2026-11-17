/* Поток состояния. Если он замолчал, страница чаще опрашивает /api/state сама. */
(function () {
  'use strict';

  const FALLBACK_OK = 30000;
  const FALLBACK_DOWN = 4000;
  let source = null;
  let backoff = 1000;
  let waitTimer = null;
  let refreshTimer = null;
  let up = false;
  let closing = false;
  let onRefresh = function () {};

  function ago(iso, at) {
    const t = Date.parse(iso || '');
    const now = Number.isFinite(at) ? at : Date.now();
    if (!Number.isFinite(t)) return '';
    const sec = Math.max(0, Math.round((now - t) / 1000));
    if (sec < 45) return 'только что';
    const min = Math.floor(sec / 60);
    if (min < 60) return min < 1 ? 'только что' : `${min} мин`;
    const hours = Math.floor(min / 60);
    if (hours < 48) return `${hours} ч`;
    return `${Math.floor(hours / 24)} д`;
  }

  function queueRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      try { onRefresh(); } catch (_) { /* следующий опрос подхватит */ }
    }, 120);
  }

  function schedule() {
    if (waitTimer) return;
    const pause = backoff;
    backoff = Math.min(backoff * 2, 30000);
    waitTimer = setTimeout(() => {
      waitTimer = null;
      connect();
    }, pause);
  }

  function connect() {
    if (typeof EventSource === 'undefined') {
      up = false;
      return;
    }
    closing = false;
    const next = new EventSource('/api/stream');
    source = next;
    next.onopen = () => {
      if (source !== next) return;
      backoff = 1000;
      up = true;
    };
    next.addEventListener('state', () => {
      if (source !== next) return;
      queueRefresh();
    });
    next.onerror = () => {
      if (closing || source !== next) return;
      up = false;
      closing = true;
      next.close();
      if (source === next) source = null;
      schedule();
    };
  }

  function start(refresh) {
    onRefresh = typeof refresh === 'function' ? refresh : function () {};
    if (source || waitTimer) return;
    connect();
  }

  window.LiveStream = {
    start,
    ago,
    connected: () => up,
    pollMs: () => (up ? FALLBACK_OK : FALLBACK_DOWN),
  };
})();
