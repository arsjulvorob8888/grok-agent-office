/* Панель «Процессы сейчас»: живые приказы, время идёт каждую секунду. */
(function () {
  'use strict';

  const OPEN = new Set(['sent', 'accepted', 'in_progress']);
  const LABEL = { sent: 'Отправлена', accepted: 'Принял', in_progress: 'В работе' };
  let tasks = [];
  let agents = [];
  let routines = [];
  let lastEvent = 0;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function byId() {
    return new Map(agents.map((a) => [a.id, a]));
  }

  function person(id, map) {
    if (!id || id === 'owner') return 'Владелец';
    const a = map.get(id);
    if (!a) return id;
    const name = a.id === 'grok' ? 'Путин' : (a.name || a.id);
    if (!a.number) return name;
    const num = String(a.number).includes('.') ? String(a.number) : `${a.number}.`;
    return `${num} ${name}`;
  }

  function formatElapsed(iso, now) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '0:00';
    const sec = Math.max(0, Math.floor((now - t) / 1000));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    const ss = String(s).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
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
      const next = formatElapsed(el.dataset.start, now);
      if (el.textContent !== next) el.textContent = next;
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
    const sig = rows.map((t) => [t.id, t.orderStatus, t.text, t.fromAgentId, t.agentId || t.agent, t.createdAt].join('\u0001')).join('\u0002')
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
        <span class="proc-meta"><span class="proc-st in_progress">Идёт</span><time class="proc-elapsed" data-start="${esc(r.startedAt)}" datetime="${esc(r.startedAt)}">${esc(formatElapsed(r.startedAt, now))}</time></span>
      </button>`;
    }).join('');
    list.innerHTML = routineHtml + rows.map((t) => {
      const from = person(t.fromAgentId || 'grok', map);
      const to = person(t.agentId || t.agent, map);
      const what = t.text || 'Задача';
      const status = t.orderStatus;
      return `<button type="button" class="proc-row ${esc(status)}" data-order-id="${esc(t.id)}">
        <span class="proc-route"><b>${esc(from)}</b><span class="arr" aria-hidden="true">→</span><b>${esc(to)}</b></span>
        <span class="proc-what">${esc(what)}</span>
        <span class="proc-meta"><span class="proc-st ${esc(status)}">${esc(LABEL[status] || status)}</span><time class="proc-elapsed" data-start="${esc(t.createdAt)}" datetime="${esc(t.createdAt)}">${esc(formatElapsed(t.createdAt, now))}</time></span>
      </button>`;
    }).join('');
    list.scrollTop = top;
    list.querySelectorAll('.proc-row').forEach((btn) => {
      btn.onclick = () => {
        const id = btn.dataset.orderId;
        if (window.Office && typeof window.Office.openOrder === 'function') window.Office.openOrder(id);
        if (innerWidth <= 900) setOpen(false);
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
    if (Date.now() - lastEvent < 6000) return;
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (!res.ok) return;
    lastEvent = Date.now();
    take(await res.json());
  }
  setInterval(() => { fallback().catch(() => {}); }, 4000);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.Processes = { take, render, setOpen };
})();
