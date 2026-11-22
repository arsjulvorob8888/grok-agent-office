/* Поток состояния. Комментарии SSE браузер не показывает, поэтому живость
   видна по событию ping. Если поток замолчал, страница сама опрашивает /api/state. */
(function () {
  'use strict';

  const FALLBACK_OK = 30000;
  const FALLBACK_DOWN = 12000;
  const SILENCE_MS = 55000;
  let source = null;
  let backoff = 1000;
  let waitTimer = null;
  let refreshTimer = null;
  let silenceTimer = null;
  let up = false;
  let closing = false;
  let hidden = typeof document !== 'undefined' && document.hidden;
  let suspended = false;
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

  function tell() {
    try { document.dispatchEvent(new CustomEvent('livestream')); } catch (_) { /* страницы ещё нет */ }
  }

  function setUp(value) {
    const next = !!value;
    if (up === next) {
      if (next) armSilence();
      return;
    }
    up = next;
    if (next) armSilence();
    else clearTimeout(silenceTimer);
    tell();
  }

  function queueRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      try { onRefresh(); } catch (_) { /* следующий опрос подхватит */ }
    }, 120);
  }

  function blocked() {
    return hidden || suspended;
  }

  function schedule() {
    if (waitTimer || blocked()) return;
    const pause = backoff;
    backoff = Math.min(backoff * 2, 30000);
    waitTimer = setTimeout(() => {
      waitTimer = null;
      connect();
    }, pause);
  }

  function armSilence() {
    clearTimeout(silenceTimer);
    if (!up || blocked()) return;
    silenceTimer = setTimeout(() => {
      silenceTimer = null;
      dropSocket();
      setUp(false);
      backoff = 1000;
      connect();
      queueRefresh();
    }, SILENCE_MS);
  }

  function dropSocket() {
    if (!source) return;
    const current = source;
    closing = true;
    try { current.close(); } catch (_) { /* уже закрыт */ }
    if (source === current) source = null;
    closing = false;
  }

  function connect() {
    if (blocked()) return;
    if (typeof EventSource === 'undefined') {
      setUp(false);
      return;
    }
    dropSocket();
    closing = false;
    let next;
    try {
      next = new EventSource('/api/stream');
    } catch (_) {
      setUp(false);
      schedule();
      return;
    }
    source = next;
    next.onopen = () => {
      if (source !== next) return;
      backoff = 1000;
      setUp(true);
      queueRefresh();
    };
    next.addEventListener('state', () => {
      if (source !== next) return;
      setUp(true);
      queueRefresh();
    });
    next.addEventListener('ping', () => {
      if (source !== next) return;
      setUp(true);
    });
    next.onerror = () => {
      if (closing || source !== next) return;
      setUp(false);
      closing = true;
      try { next.close(); } catch (_) { /* уже закрыт */ }
      if (source === next) source = null;
      closing = false;
      schedule();
    };
  }

  function suspend(on) {
    suspended = !!on;
    clearTimeout(waitTimer);
    waitTimer = null;
    clearTimeout(silenceTimer);
    dropSocket();
    setUp(false);
    if (!suspended && !hidden) connect();
  }

  function start(refresh) {
    onRefresh = typeof refresh === 'function' ? refresh : function () {};
    if (source || waitTimer) return;
    connect();
  }

  document.addEventListener('visibilitychange', () => {
    hidden = document.hidden;
    if (hidden) {
      clearTimeout(waitTimer);
      waitTimer = null;
      clearTimeout(silenceTimer);
      return;
    }
    backoff = 1000;
    if (!source || source.readyState !== 1) connect();
    else armSilence();
    queueRefresh();
  });

  window.LiveStream = {
    start,
    ago,
    suspend,
    connected: () => up && !suspended,
    pollMs: () => (up && !suspended ? FALLBACK_OK : FALLBACK_DOWN),
  };
})();
