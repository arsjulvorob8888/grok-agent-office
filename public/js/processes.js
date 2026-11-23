/* Панель «Процессы сейчас»: живые приказы, время идёт каждую секунду. */
(function () {
  'use strict';

  const OPEN = new Set(['sent', 'accepted', 'in_progress']);
  const LABEL = { sent: 'Доставлено', accepted: 'Принято', in_progress: 'В работе', done: 'Выполнена', failed: 'Не выполнен', cancelled: 'Устарело' };
  let tasks = [];
  let agents = [];
  let routines = [];
  let messages = [];
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

  async function cancelOrder(id, btn) {
    let password = '';
    try { password = localStorage.getItem('appPassword') || ''; } catch (_) { password = ''; }
    if (!id || !password) return;
    if (btn) btn.disabled = true;
    try {
      const res = await fetch(`/api/orders/${encodeURIComponent(id)}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-app-password': password },
        body: '{}',
      });
      if (res.status === 401) {
        try { localStorage.removeItem('appPassword'); } catch (_) { /* пароль уже стёрт */ }
      }
    } catch (_) { /* сеть: список обновит следующий опрос */ }
    if (btn) btn.disabled = false;
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

  function routeText(task, map) {
    if (task && task.routeLabel) return task.routeLabel;
    const from = person(task.fromAgentId || 'grok', map);
    const to = person(task.agentId || task.agent, map);
    return `${from} → ${to}`;
  }

  function orderRow(task, map, now, withActions) {
    const route = routeText(task, map);
    const raw = task.text || 'Задача';
    const what = window.OfficeFeed && typeof OfficeFeed.maskServiceIds === 'function'
      ? OfficeFeed.maskServiceIds(raw)
      : raw;
    const status = task.orderStatus || 'sent';
    const label = rowStatus(task);
    const actions = withActions && ownerReady()
      ? `<button type="button" class="proc-retry" data-retry="${esc(task.id)}">Повторить</button><button type="button" class="proc-cancel" data-cancel="${esc(task.id)}">Отменить</button>`
      : '';
    const parts = esc(route).split('→');
    const routeHtml = parts.length === 2
      ? `<b>${parts[0].trim()}</b><span class="arr" aria-hidden="true">→</span><b>${parts[1].trim()}</b>`
      : `<b>${esc(route)}</b>`;
    return `<div class="proc-row ${esc(status)}" data-order-id="${esc(task.id)}" role="button" tabindex="0">
      <span class="proc-route">${routeHtml}</span>
      <span class="proc-what">${esc(what)}</span>
      <span class="proc-meta"><span class="proc-st ${esc(status)}">${esc(label)}</span><time class="proc-elapsed" datetime="${esc(task.createdAt)}">${esc(formatStamp(task.createdAt, now))}</time>${actions}</span>
    </div>`;
  }

  function render() {
    const list = document.getElementById('procList');
    const count = document.getElementById('procCount');
    const badge = document.getElementById('procBadge');
    if (!list) return;
    const visibleTasks = tasks.filter((task) => task && !archivedParty(task.agentId || task.agent) && !archivedParty(task.fromAgentId));
    const visibleRuns = routines.filter((item) => item && !archivedParty(item.agentId));
    const panel = window.OfficeFeed && OfficeFeed.processPanel
      ? OfficeFeed.processPanel(visibleTasks, visibleRuns, Date.now(), { agents, messages })
      : { live: active(), undelivered: [], pulses: activeRoutines(), total: active().length + activeRoutines().length, entries: active().concat(activeRoutines()) };
    const rows = panel.live;
    const held = panel.undelivered;
    const runs = panel.pulses;
    const total = panel.total;
    if (count) count.textContent = String(total);
    if (badge) badge.textContent = String(total);
    const showCount = (el, n) => {
      if (!el) return;
      const value = Math.max(0, Number(n) || 0);
      el.textContent = String(value);
      const empty = value === 0;
      el.hidden = empty;
      el.classList.toggle('zero', empty);
    };
    showCount(count, total);
    showCount(badge, total);
    const pack = (listRows) => listRows.map((t) => [t.id, t.orderStatus, t.forwardStatus, t.deliveryLabel, t.routeLabel, t.text, t.fromAgentId, t.agentId || t.agent, t.createdAt, ownerReady() ? 1 : 0].join('\u0001')).join('\u0002');
    const sig = pack(rows) + '\u0003' + runs.map((r) => [r.id, r.name, r.agentId, r.startedAt].join('\u0001')).join('\u0002') + '\u0003' + pack(held);
    tick();
    if (list.dataset.sig === sig) return;
    const top = list.scrollTop;
    list.dataset.sig = sig;
    const map = byId();
    if (!rows.length && !runs.length && !held.length) {
      list.innerHTML = '<div class="proc-empty"><b>Сейчас тихо</b>Нет задач, которые агент сейчас выполняет.</div>';
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
    const liveHtml = rows.map((task) => orderRow(task, map, now, false)).join('');
    const heldHtml = held.length
      ? `<section class="proc-held"><h3>Не доставлено</h3>${held.map((task) => orderRow(task, map, now, true)).join('')}</section>`
      : '';
    list.innerHTML = routineHtml + liveHtml + heldHtml;
    list.scrollTop = top;
    list.querySelectorAll('.proc-row').forEach((btn) => {
      btn.onclick = (event) => {
        if (event.target.closest('[data-retry], [data-cancel]')) return;
        const id = btn.dataset.orderId;
        if (!id) return;
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
    list.querySelectorAll('[data-cancel]').forEach((btn) => {
      btn.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        cancelOrder(btn.dataset.cancel, btn);
      };
    });
  }

  function take(data) {
    tasks = (data && data.tasks) || [];
    agents = (data && data.agents) || [];
    routines = (data && data.routines) || [];
    messages = (data && data.messages) || [];
    render();
  }

  function init() {
    const btn = document.getElementById('btnProcesses');
    const close = document.getElementById('procClose');
    if (btn) btn.onclick = () => setOpen(!document.getElementById('processes').classList.contains('open'));
    if (close) close.onclick = () => setOpen(false);
    setInterval(() => {
      render();
    }, 1000);
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
