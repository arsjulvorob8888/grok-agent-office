/* Панель «Процессы сейчас»: живые приказы, время идёт каждую секунду. */
(function () {
  'use strict';

  const OPEN = new Set(['sent', 'accepted', 'in_progress']);
  const LABEL = { sent: 'Доставлено', accepted: 'Принято', in_progress: 'В работе', done: 'Выполнена', failed: 'Не выполнен', cancelled: 'Устарело' };
  let tasks = [];
  let agents = [];
  let routines = [];
  let lastEvent = 0;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function byId() {
    return new Map(agents.map((a) => [a.id, a]));
  }

  function person(id, map) {
    const owner = window.OfficeSender.senderName(id);
    if (owner) return owner;
    const a = map.get(id);
    if (!a) return id;
    const name = a.id === 'grok' ? 'Путин' : (a.name || a.id);
    if (!a.number) return name;
    const num = String(a.number).includes('.') ? String(a.number) : `${a.number}.`;
    return `${num} ${name}`;
  }

  function formatStamp(iso, now) {
    if (window.OfficeFeed && typeof window.OfficeFeed.formatProcessStamp === 'function') {
      return window.OfficeFeed.formatProcessStamp(iso, now);
    }
    return '';
  }

  function ownerReady() {
    try { return !!localStorage.getItem('appPassword'); } catch (_) { return false; }
  }

  function deliveredCode(task) {
    const code = Number(task && task.forwardStatus);
    return Number.isInteger(code) && code >= 200 && code < 300;
  }

  function canRetry(task) {
    if (!ownerReady() || !task || !task.id) return false;
    if (task.orderStatus === 'done' || task.orderStatus === 'failed' || task.orderStatus === 'cancelled') return false;
    return !deliveredCode(task);
  }

  async function retryOrder(id, btn) {
    let password = '';
    try { password = localStorage.getItem('appPassword') || ''; } catch (_) { password = ''; }
    if (!id || !password) return;
    if (btn) btn.disabled = true;
    try {
      const res = await fetch(`/api/orders/${encodeURIComponent(id)}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-app-password': password },
        body: '{}',
      });
      if (res.status === 401) {
        try { localStorage.removeItem('appPassword'); } catch (_) { /* пароль уже стёрт */ }
      }
    } catch (_) { /* сеть: подпись обновит следующий опрос */ }
    if (btn) btn.disabled = false;
  }

  function rowStatus(task) {
    const status = task.orderStatus || 'sent';
    if (status === 'sent' && deliveredCode(task)) return 'Доставлено';
    if (status === 'sent') {
      if (task.deliveryLabel) return task.deliveryLabel;
      if (window.OfficeFeed) return window.OfficeFeed.deliveryCaption(task.forwardStatus);
    }
    return LABEL[status] || status;
  }

  function archivedParty(id) {
    if (!id || id === 'owner') return false;
    const a = agents.find((x) => x.id === id);
    return !!(a && a.archived);
  }

  function active() {
    return tasks.filter((t) => t && OPEN.has(t.orderStatus)
      && !archivedParty(t.agentId || t.agent)
      && !archivedParty(t.fromAgentId));
  }

  function activeRoutines() {
    return routines.filter((r) => r && r.active && !archivedParty(r.agentId));
  }

  function setOpen(open) {
    const panel = document.getElementById('processes');
    const btn = document.getElementById('btnProcesses');
    if (!panel || !btn) return;
    if (!open) {
      const active = document.activeElement;
      if (active && active !== document.body && panel.contains(active)) {
        try { btn.focus({ preventScroll: true }); } catch (_) { btn.focus(); }
        if (panel.contains(document.activeElement) && active.blur) active.blur();
      }
    }
    panel.classList.toggle('open', open);
    panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    btn.classList.toggle('on', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    document.body.classList.toggle('proc-on', open);
    if (open && innerWidth <= 900) {
      const journal = document.getElementById('journal');
      const hier = document.getElementById('hier');
      if (journal) journal.classList.remove('mobile-open');
      if (hier) hier.classList.remove('open');
      document.body.classList.remove('hier-on');
      const hierBtn = document.getElementById('btnHier');
      if (hierBtn) {
        hierBtn.classList.remove('on');
        hierBtn.setAttribute('aria-pressed', 'false');
      }
    }
  }

  function tick() {
    const now = Date.now();
    document.querySelectorAll('#procList .proc-elapsed').forEach((el) => {
      const next = formatStamp(el.getAttribute('datetime'), now);
      if (next && el.textContent !== next) el.textContent = next;
    });
  }

  function render() {
    const list = document.getElementById('procList');
    const count = document.getElementById('procCount');
    const badge = document.getElementById('procBadge');
    if (!list) return;
    const rows = active();
    const runs = activeRoutines();
    const total = rows.length + runs.length;
    if (count) count.textContent = String(total);
    if (badge) {
      badge.textContent = String(total);
      badge.classList.toggle('zero', total === 0);
    }
    const sig = rows.map((t) => [t.id, t.orderStatus, t.forwardStatus, t.deliveryLabel, t.text, t.fromAgentId, t.agentId || t.agent, t.createdAt, ownerReady() ? 1 : 0].join('\u0001')).join('\u0002')
      + '\u0003' + runs.map((r) => [r.id, r.name, r.agentId, r.startedAt].join('\u0001')).join('\u0002');
    tick();
    if (list.dataset.sig === sig) return;
    const top = list.scrollTop;
    list.dataset.sig = sig;
    const map = byId();
    if (!rows.length && !runs.length) {
      list.innerHTML = '<div class="proc-empty"><b>Сейчас тихо</b>Нет приказов в пути, принятых или в работе.</div>';
      list.scrollTop = 0;
      return;
    }
    const now = Date.now();
    const routineHtml = runs.map((r) => {
      const who = person(r.agentId, map);
      return `<button type="button" class="proc-row in_progress" data-routine-id="${esc(r.id)}">
        <span class="proc-route"><b>${esc(who)}</b><span class="arr" aria-hidden="true">·</span><b>рутина</b></span>
        <span class="proc-what">${esc(r.name || 'Рутина')}</span>
        <span class="proc-meta"><span class="proc-st in_progress">Идёт</span><time class="proc-elapsed" datetime="${esc(r.startedAt)}">${esc(formatStamp(r.startedAt, now))}</time></span>
      </button>`;
    }).join('');
    list.innerHTML = routineHtml + rows.map((t) => {
      const from = person(t.fromAgentId || 'grok', map);
      const to = person(t.agentId || t.agent, map);
      const what = t.text || 'Задача';
      const status = t.orderStatus;
      const label = rowStatus(t);
      const retry = canRetry(t)
        ? `<button type="button" class="proc-retry" data-retry="${esc(t.id)}">Отправить повторно</button>`
        : '';
      return `<div class="proc-row ${esc(status)}" data-order-id="${esc(t.id)}" role="button" tabindex="0">
        <span class="proc-route"><b>${esc(from)}</b><span class="arr" aria-hidden="true">→</span><b>${esc(to)}</b></span>
        <span class="proc-what">${esc(what)}</span>
        <span class="proc-meta"><span class="proc-st ${esc(status)}">${esc(label)}</span><time class="proc-elapsed" datetime="${esc(t.createdAt)}">${esc(formatStamp(t.createdAt, now))}</time>${retry}</span>
      </div>`;
    }).join('');
    list.scrollTop = top;
    list.querySelectorAll('.proc-row').forEach((btn) => {
      btn.onclick = (event) => {
        if (event.target.closest('[data-retry]')) return;
        const id = btn.dataset.orderId;
        if (window.Office && typeof window.Office.openOrder === 'function') window.Office.openOrder(id);
        if (innerWidth <= 900) setOpen(false);
      };
    });
    list.querySelectorAll('[data-retry]').forEach((btn) => {
      btn.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        retryOrder(btn.dataset.retry, btn);
      };
    });
  }

  function take(data) {
    tasks = (data && data.tasks) || [];
    agents = (data && data.agents) || [];
    routines = (data && data.routines) || [];
    render();
  }

  function init() {
    const btn = document.getElementById('btnProcesses');
    const close = document.getElementById('procClose');
    if (btn) btn.onclick = () => setOpen(!document.getElementById('processes').classList.contains('open'));
    if (close) close.onclick = () => setOpen(false);
    setInterval(tick, 1000);
  }

  document.addEventListener('officestate', (e) => {
    lastEvent = Date.now();
    take(e.detail);
  });

  async function fallback() {
    if (Date.now() - lastEvent < 25000) return;
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (!res.ok) return;
    lastEvent = Date.now();
    take(await res.json());
  }
  setInterval(() => { fallback().catch(() => {}); }, 30000);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.Processes = { take, render, setOpen };
})();
