/* Полноэкранный дашборд агента: обзор, задачи, аналитика, переписка.
   Кнопка «Развернуть» дописывается в панель, саму панель карта перерисовывает сама. */
(function () {
  'use strict';

  const TABS = ['overview', 'tasks', 'analytics', 'chat'];
  const TEMPLATES = [
    ['Доложи статус', 'Доложи текущий статус и что сделано.'],
    ['Что в работе', 'Что сейчас в работе и какой следующий шаг?'],
    ['Пришли итог', 'Закрой текущую задачу и пришли короткий итог.'],
  ];
  const ACTIVITY = { working: 'Работает', waiting: 'Ждёт', resting: 'Спит' };
  const STATUS = { working: 'Работает', idle: 'Свободен', waiting: 'Ждёт тебя' };
  const LIVE = { working: 'Работает', idle: 'Свободен' };
  const COL_TITLE = { new: 'Новые', work: 'В работе', done: 'Готово' };
  const STATUS_TITLE = { sent: 'Новые', accepted: 'Принял', in_progress: 'В работе', done: 'Готово', failed: 'Не выполнен' };

  const root = document.getElementById('agentDash');
  if (!root) return;

  let open = false;
  let agentId = '';
  let tab = 'overview';
  let data = null;
  let error = '';
  let note = '';
  let query = '';
  let columnFilter = 'all';
  let layout = 'kanban';
  let ticket = 0;
  let frame = 0;
  let ownsHistory = false;
  const frozen = [];

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));

  function password() {
    try { return localStorage.getItem('appPassword') || ''; } catch (_) { return ''; }
  }

  function ownerName() {
    return window.OfficeSender.speakerLabel('owner');
  }

  function visibleText(text) {
    const sent = window.OfficeSender.displayOrderSender(text || '');
    return window.OfficeFeed && typeof OfficeFeed.maskServiceIds === 'function'
      ? OfficeFeed.maskServiceIds(sent)
      : sent;
  }

  function readHash() {
    const params = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
    const name = params.get('tab') || 'overview';
    return {
      agent: params.get('agent') || '',
      view: params.get('view') || '',
      tab: TABS.includes(name) ? name : 'overview',
    };
  }

  function hashUrl(hash) {
    return `${location.pathname}${location.search}#${hash}`;
  }

  function panelHash() {
    return `agent=${encodeURIComponent(agentId)}`;
  }

  function dashboardHash() {
    return `agent=${encodeURIComponent(agentId)}&view=dashboard&tab=${tab}`;
  }

  function writeHash(mode) {
    const url = hashUrl(dashboardHash());
    const own = mode === 'push' || ownsHistory || !!(history.state && history.state.agentDash);
    if (mode === 'push') history.pushState({ agentDash: 1 }, '', url);
    else history.replaceState(own ? { agentDash: 1 } : null, '', url);
  }

  // Прямая ссылка сидит на первой записи. Кладём под неё панель, чтобы Back
  // остался на сайте, но свою push-запись клика не считаем: закрытие идёт через replaceState.
  function anchorDirectLink() {
    if (ownsHistory || (history.state && history.state.agentDash)) return;
    history.replaceState({ agentPanel: 1 }, '', hashUrl(panelHash()));
    history.pushState({ agentDash: 1, direct: 1 }, '', hashUrl(dashboardHash()));
  }

  function revealPanel(id) {
    const office = window.Office;
    if (office && typeof office.showAgent === 'function') office.showAgent(id);
  }

  function fmtTime(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    try {
      if (window.OfficeFeed && typeof window.OfficeFeed.formatDateTimeMsk === 'function') {
        return window.OfficeFeed.formatDateTimeMsk(iso);
      }
      return new Date(t).toLocaleString('ru-RU', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Europe/Moscow',
        hourCycle: 'h23',
      }) + ' МСК';
    } catch (_) { return ''; }
  }

  function fmtDuration(ms) {
    const min = Math.round(ms / 60000);
    if (min < 1) return 'меньше минуты';
    if (min < 60) return `${min} мин`;
    const hours = Math.floor(min / 60);
    const rest = min % 60;
    return rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
  }

  function filteredTasks() {
    const tasks = (data && data.tasks) || [];
    const q = query.trim().toLowerCase();
    return tasks.filter((task) => {
      if (columnFilter !== 'all' && task.column !== columnFilter) return false;
      if (!q) return true;
      return String(task.text || '').toLowerCase().includes(q);
    });
  }

  function freeze() {
    const app = document.getElementById('app');
    if (!app) return;
    for (const child of app.children) {
      if (child === root || child.hasAttribute('inert') || child.hidden) continue;
      child.setAttribute('inert', '');
      frozen.push(child);
    }
  }

  function thaw() {
    while (frozen.length) frozen.pop().removeAttribute('inert');
  }

  function paintShell() {
    if (root.querySelector('.dash-shell')) return;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'dashTitle');
    root.innerHTML = `
      <div class="dash-shell">
        <header class="dash-head">
          <div>
            <p class="dash-kicker" id="dashKicker"></p>
            <h2 id="dashTitle">Дашборд</h2>
            <p class="dash-role" id="dashRole"></p>
          </div>
          <div class="dash-head-actions">
            <button type="button" class="btn ghost" id="dashCollapse">Свернуть</button>
          </div>
        </header>
        <div class="dash-main" id="dashMain"><div id="dashPanel" role="tabpanel" tabindex="0"></div></div>
        <div class="dash-tabs" role="tablist" aria-label="Разделы дашборда">
          <button type="button" role="tab" id="dashTab-overview" data-tab="overview" aria-controls="dashPanel">Обзор</button>
          <button type="button" role="tab" id="dashTab-tasks" data-tab="tasks" aria-controls="dashPanel">Задачи</button>
          <button type="button" role="tab" id="dashTab-analytics" data-tab="analytics" aria-controls="dashPanel">Аналитика</button>
          <button type="button" role="tab" id="dashTab-chat" data-tab="chat" aria-controls="dashPanel">Переписка</button>
        </div>
      </div>`;
    root.querySelector('#dashCollapse').addEventListener('click', closeDash);
    root.querySelectorAll('[role="tab"]').forEach((button) => {
      button.addEventListener('click', () => selectTab(button.dataset.tab));
    });
    const panel = document.getElementById('dashPanel');
    panel.addEventListener('click', onPanelClick);
    panel.addEventListener('input', (event) => {
      if (event.target.id === 'dashSearch') query = event.target.value;
      if (event.target.id === 'dashFilter') columnFilter = event.target.value;
      if (event.target.id === 'dashSearch' || event.target.id === 'dashFilter') render();
    });
    panel.addEventListener('submit', (event) => {
      event.preventDefault();
      if (event.target.id === 'dashChatForm') sendChat();
      if (event.target.id === 'dashCreateForm') createTask();
    });
    panel.addEventListener('keydown', (event) => {
      if (event.target.id === 'dashChatInput' && event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendChat();
      }
    });
  }

  function selectTab(next) {
    if (!TABS.includes(next) || next === tab) return;
    tab = next;
    writeHash('replace');
    render();
  }

  function show() {
    frame += 1;
    paintShell();
    root.hidden = false;
    root.setAttribute('aria-hidden', 'false');
    const button = document.querySelector('.dash-expand');
    if (button) button.setAttribute('aria-expanded', 'true');
    const collapse = document.getElementById('dashCollapse');
    if (collapse) collapse.focus();
    requestAnimationFrame(() => {
      if (open) root.classList.add('open');
    });
  }

  function hide() {
    if (!open && root.hidden) return;
    open = false;
    root.classList.remove('open');
    const token = ++frame;
    const finish = () => {
      if (token !== frame || open) return;
      root.hidden = true;
      root.setAttribute('aria-hidden', 'true');
      thaw();
      const button = document.querySelector('.dash-expand');
      if (button) {
        button.setAttribute('aria-expanded', 'false');
        if (!button.closest('[inert]')) button.focus();
      }
    };
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) finish();
    else window.setTimeout(finish, 250);
  }

  function openDash(id, nextTab, mode) {
    if (!id) return;
    const was = open;
    agentId = id;
    tab = TABS.includes(nextTab) ? nextTab : 'overview';
    open = true;
    if (!was) freeze();
    show();
    if (mode === 'push') {
      writeHash('push');
      ownsHistory = true;
    } else if (mode === 'replace') writeHash('replace');
    else anchorDirectLink();
    load();
  }

  function closeDash() {
    if (!open) return;
    if (ownsHistory) {
      ownsHistory = false;
      history.back();
      return;
    }
    const id = agentId;
    history.replaceState({ agentPanel: 1 }, '', hashUrl(panelHash()));
    revealPanel(id);
    hide();
  }

  function applyHash() {
    const hash = readHash();
    if (hash.view === 'dashboard' && hash.agent) openDash(hash.agent, hash.tab, 'quiet');
    else {
      if (hash.agent) revealPanel(hash.agent);
      hide();
    }
  }

  async function load() {
    const mine = ++ticket;
    const id = agentId;
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(id)}/dashboard`, { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (mine !== ticket || id !== agentId) return;
      if (!res.ok) {
        error = (body && body.error) || 'Не удалось загрузить дашборд';
        data = null;
      } else {
        error = '';
        data = body;
      }
    } catch (_) {
      if (mine !== ticket) return;
      error = 'Не удалось загрузить дашборд';
    }
    if (open && id === agentId) render();
  }

  function capture() {
    const chat = document.getElementById('dashChatInput');
    const task = document.getElementById('dashTaskInput');
    const result = document.getElementById('dashResult');
    return {
      active: document.activeElement && document.activeElement.id,
      chat: chat ? chat.value : null,
      task: task ? task.value : null,
      result: result ? result.value : null,
      resultFor: result ? result.dataset.orderId : '',
    };
  }

  function restore(keep) {
    if (!keep) return;
    const chat = document.getElementById('dashChatInput');
    const task = document.getElementById('dashTaskInput');
    const result = document.getElementById('dashResult');
    if (chat && keep.chat != null) chat.value = keep.chat;
    if (task && keep.task != null) task.value = keep.task;
    if (result && keep.result != null && result.dataset.orderId === keep.resultFor) result.value = keep.result;
    if (keep.active) {
      const el = document.getElementById(keep.active);
      if (el) el.focus();
    }
  }

  function onPanelClick(event) {
    const view = event.target.closest('[data-layout]');
    if (view) {
      layout = view.dataset.layout;
      render();
      return;
    }
    const template = event.target.closest('.dash-template');
    if (template) {
      const input = document.getElementById('dashChatInput');
      if (input) {
        input.value = template.dataset.text || '';
        input.focus();
      }
      return;
    }
    const again = event.target.closest('[data-retry]');
    if (again) {
      retryTask(again.dataset.retry, again);
      return;
    }
  }

  async function retryTask(orderId, btn) {
    note = '';
    if (!password()) {
      note = 'Нужен пароль штаба';
      render();
      return;
    }
    if (btn) btn.disabled = true;
    const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-app-password': password() },
      body: '{}',
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) {
      try { localStorage.removeItem('appPassword'); } catch (_) { /* пароль уже стёрт */ }
      note = 'Нужен пароль штаба';
      render();
      return;
    }
    if (!res.ok) {
      note = body.error || 'Не удалось отправить повторно';
      render();
      return;
    }
    note = '';
    await load();
  }

  async function createTask() {
    const input = document.getElementById('dashTaskInput');
    const text = input ? input.value.trim() : '';
    if (!text) return;
    await postTask(text, input);
  }

  async function sendChat() {
    const input = document.getElementById('dashChatInput');
    const text = input ? input.value.trim() : '';
    if (!text) return;
    await postTask(text, input);
  }

  async function postTask(text, input) {
    note = '';
    if (!password()) {
      note = 'Нужен пароль штаба';
      render();
      return;
    }
    const res = await fetch('/api/task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-app-password': password() },
      body: JSON.stringify({ agent: agentId, text, fromAgentId: 'owner' }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      note = body.error || 'Не удалось отправить';
      render();
      return;
    }
    if (input) input.value = '';
    const phrase = window.OfficeFeed && typeof OfficeFeed.cardRouteLine === 'function'
      ? OfficeFeed.cardRouteLine({ id: agentId, deliveryRoute: body.deliveryRoute, linkCheck: data && data.linkCheck })
      : '';
    note = phrase ? `Приказ сохранён. ${phrase}` : 'Приказ сохранён.';
    if (body.deliveryRoute) data = Object.assign({}, data, { deliveryRoute: body.deliveryRoute });
    await load();
  }

  function render() {
    if (!open) return;
    paintShell();
    const keep = capture();
    const agent = (data && data.agent) || {};
    const kicker = document.getElementById('dashKicker');
    const title = document.getElementById('dashTitle');
    const role = document.getElementById('dashRole');
    if (kicker) kicker.textContent = agent.number ? `${agent.number}. ${agent.name || agentId}` : (agent.name || agentId || 'Агент');
    if (title) title.textContent = agent.name || agentId || 'Дашборд';
    if (role) role.textContent = agent.role || '';
    root.querySelectorAll('[role="tab"]').forEach((button) => {
      const on = button.dataset.tab === tab;
      button.setAttribute('aria-selected', on ? 'true' : 'false');
      button.tabIndex = on ? 0 : -1;
    });
    const panel = document.getElementById('dashPanel');
    const tabBtn = document.getElementById(`dashTab-${tab}`);
    if (panel && tabBtn) panel.setAttribute('aria-labelledby', tabBtn.id);
    if (panel) panel.innerHTML = error && !data ? `<p class="dash-empty">${esc(error)}</p>` : viewHtml();
    restore(keep);
  }

  function viewHtml() {
    if (!data) return '<p class="dash-empty">Загрузка…</p>';
    if (tab === 'tasks') return tasksHtml();
    if (tab === 'analytics') return analyticsHtml();
    if (tab === 'chat') return chatHtml();
    return overviewHtml();
  }

  function overviewHtml() {
    const agent = data.agent;
    const metrics = data.metrics || { total: 0, done: 0, inProgress: 0 };
    const mode = window.AgentStatus ? AgentStatus.activityMode(agent) : (agent.activity || 'resting');
    const activity = window.AgentStatus && AgentStatus.statusLabel
      ? AgentStatus.statusLabel(agent)
      : (window.AgentStatus ? AgentStatus.activityLabel(agent) : (ACTIVITY[mode] || 'Спит'));
    const doing = window.AgentStatus && AgentStatus.ownDoing ? AgentStatus.ownDoing(agent) : '';
    const log = (data.activityLog || []).map((line) => {
      const when = line.at ? `<time datetime="${esc(line.at)}">${esc(fmtTime(line.at))}</time>` : '<time>без времени</time>';
      return `<li>${when}${esc(visibleText(line.text))}</li>`;
    }).join('');
    return `
      <div class="dash-status">
        <span class="dash-pill ${esc(mode)}">${esc(activity)}</span>
        ${doing ? `<span class="dash-now">${esc(doing)}</span>` : ''}
      </div>
      <div class="dash-block">
        <h3>Текущая задача</h3>
        <p class="${agent.currentTask ? '' : 'dash-empty'}">${agent.currentTask ? esc(visibleText(agent.currentTask)) : 'Сейчас нет задачи'}</p>
      </div>
      <div class="dash-metrics">
        <div class="dash-metric"><b>${metrics.total}</b><span>${esc(window.OfficeFeed && OfficeFeed.ruCount ? OfficeFeed.ruCount(metrics.total, 'задача', 'задачи', 'задач') : 'задач')}</span></div>
        <div class="dash-metric"><b>${metrics.done}</b><span>Выполнено</span></div>
        <div class="dash-metric"><b>${metrics.inProgress}</b><span>В работе</span></div>
      </div>
      <div class="dash-block">
        <h3>Последние активности</h3>
        ${log ? `<ul class="dash-activity">${log}</ul>` : '<p class="dash-empty">Пока нет активности</p>'}
      </div>`;
  }

  function taskUndelivered(task) {
    if (!task) return false;
    if (task.orderStatus === 'done' || task.orderStatus === 'failed' || task.orderStatus === 'cancelled') return false;
    const code = Number(task.forwardStatus);
    return !(Number.isInteger(code) && code >= 200 && code < 300);
  }

  function routeLine() {
    const kind = data && (data.deliveryRoute === 'agent' || data.deliveryRoute === 'putin' || data.deliveryRoute === 'env' || data.deliveryRoute === 'none')
      ? data.deliveryRoute
      : 'none';
    const phrase = window.OfficeFeed && typeof OfficeFeed.cardRouteLine === 'function'
      ? OfficeFeed.cardRouteLine({ id: agentId, deliveryRoute: kind, linkCheck: data && data.linkCheck })
      : '';
    if (!phrase) return '';
    return `<p class="task-route" data-route="${esc(kind)}">${esc(phrase)}</p>`;
  }

  function taskCard(task) {
    const retry = password() && taskUndelivered(task)
      ? `<button type="button" data-retry="${esc(task.id)}">Отправить повторно</button>`
      : '';
    const bits = [];
    if (task.deliveryLabel) bits.push(esc(task.deliveryLabel));
    if (task.orderStatus === 'failed') bits.push('Не выполнен');
    return `<article class="dash-card">
      <p>${esc(visibleText(task.text || 'Задача'))}</p>
      ${bits.length ? `<p class="dash-card-meta">${bits.join(' · ')}</p>` : ''}
      ${retry ? `<div class="dash-card-actions">${retry}</div>` : ''}
    </article>`;
  }

  function tasksHtml() {
    const agent = data.agent || {};
    const tasks = filteredTasks();
    const all = (data.tasks || []);
    const locked = agent.archived || agent.vacant;
    const columns = ['new', 'work', 'done'].map((key) => {
      const cards = tasks.filter((task) => task.column === key).map(taskCard).join('');
      return `<section class="dash-col dash-col-${key}" aria-label="${COL_TITLE[key]}">
        <h3>${COL_TITLE[key]} <span>${tasks.filter((task) => task.column === key).length}</span></h3>
        ${cards || '<p class="dash-empty">Пусто</p>'}
      </section>`;
    }).join('');
    const list = tasks.map(taskCard).join('') || '<p class="dash-empty">Ничего не найдено</p>';
    const body = !all.length
      ? '<p class="dash-empty">Задач пока нет</p>'
      : (tasks.length ? (layout === 'list' ? `<div class="dash-list">${list}</div>` : `<div class="dash-kanban">${columns}</div>`) : '<p class="dash-empty">Ничего не найдено</p>');
    const create = locked ? '' : `
      <form class="dash-create" id="dashCreateForm">
        <label for="dashTaskInput">Новая задача</label>
        ${routeLine()}
        <textarea id="dashTaskInput" maxlength="4000" placeholder="Приказ агенту"></textarea>
        <button class="btn gold" type="submit">Создать задачу</button>
      </form>`;
    return `
      <div class="dash-tools">
        <input id="dashSearch" type="search" placeholder="Поиск" aria-label="Поиск задач" value="${esc(query)}">
        <select id="dashFilter" aria-label="Фильтр колонки">
          <option value="all"${columnFilter === 'all' ? ' selected' : ''}>Все</option>
          <option value="new"${columnFilter === 'new' ? ' selected' : ''}>Новые</option>
          <option value="work"${columnFilter === 'work' ? ' selected' : ''}>В работе</option>
          <option value="done"${columnFilter === 'done' ? ' selected' : ''}>Готово</option>
        </select>
        <div class="dash-view" role="group" aria-label="Вид списка">
          <button type="button" data-layout="kanban" aria-pressed="${layout === 'kanban' ? 'true' : 'false'}">Канбан</button>
          <button type="button" data-layout="list" aria-pressed="${layout === 'list' ? 'true' : 'false'}">Список</button>
        </div>
      </div>
      ${body}
      ${create}
      <p class="dash-note${note.startsWith('Приказ сохранён') ? ' ok' : ''}">${esc(note)}</p>`;
  }

  function bars(days) {
    const width = 320;
    const plot = 88;
    const gap = 3;
    const max = Math.max(1, ...days.map((day) => day.count));
    const bar = (width - gap * (days.length - 1)) / days.length;
    const shapes = days.map((day, index) => {
      const h = day.count ? Math.max(4, (day.count / max) * plot) : 2;
      const x = index * (bar + gap);
      const y = plot - h;
      const faint = day.count ? '' : ' fill="rgba(255,255,255,.22)"';
      return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${Math.max(bar, 1).toFixed(2)}" height="${h.toFixed(2)}" rx="1"${faint}><title>${esc(day.date)}: ${day.count}</title></rect>`;
    }).join('');
    const mark = (index) => {
      const day = days[index];
      if (!day) return '';
      const x = Math.min(width - 18, Math.max(18, index * (bar + gap) + bar / 2));
      return `<text x="${x.toFixed(1)}" y="${plot + 16}" text-anchor="middle">${esc(day.date.slice(8))}.${esc(day.date.slice(5, 7))}</text>`;
    };
    const sum = days.reduce((total, day) => total + day.count, 0);
    const label = days.map((day) => `${day.date.slice(8)}.${day.date.slice(5, 7)} ${day.count}`).join(', ');
    const svg = `<svg viewBox="0 0 ${width} ${plot + 22}" role="img" aria-label="Задачи по дням: ${esc(label)}"><line x1="0" y1="${plot}" x2="${width}" y2="${plot}" stroke="rgba(255,255,255,.16)"/>${shapes}${mark(0)}${mark(Math.floor((days.length - 1) / 2))}${mark(days.length - 1)}</svg>`;
    return { svg, sum };
  }

  function statusChart(byStatus) {
    const rows = Object.keys(STATUS_TITLE).map((key) => ({ key, count: byStatus[key] || 0 }));
    const max = Math.max(1, ...rows.map((row) => row.count));
    const height = rows.length * 22;
    const marks = rows.map((row, index) => {
      const y = index * 22 + 4;
      const w = (row.count / max) * 180;
      return `<text x="0" y="${y + 11}">${esc(STATUS_TITLE[row.key])}</text>
        <rect class="track" x="92" y="${y}" width="180" height="14" rx="4"></rect>
        <rect x="92" y="${y}" width="${w.toFixed(1)}" height="14" rx="4"><title>${esc(STATUS_TITLE[row.key])}: ${row.count}</title></rect>
        <text x="278" y="${y + 11}">${row.count}</text>`;
    }).join('');
    return `<svg viewBox="0 0 320 ${height}" role="img" aria-label="Распределение по статусам">${marks}</svg>`;
  }

  function analyticsHtml() {
    const analytics = (data && data.analytics) || {};
    const daysBlock = !analytics.days
      ? '<p class="dash-empty">Пока нет задач</p>'
      : (() => {
        const chart = bars(analytics.days);
        const hint = chart.sum ? `За 14 дней: ${chart.sum}` : 'За 14 дней новых задач нет';
        return `<h3>Задачи по дням</h3><p>${esc(hint)}</p>${chart.svg}`;
      })();
    const statusBlock = !analytics.byStatus
      ? ''
      : `<h3>По статусам</h3>${statusChart(analytics.byStatus)}`;
    const avg = analytics.avgCompletionMs == null
      ? 'Нет завершённых задач'
      : fmtDuration(analytics.avgCompletionMs);
    const share = !analytics.delivered
      ? 'Нет сообщений с доставкой'
      : `${analytics.delivered.delivered} из ${analytics.delivered.total}`;
    return `
      <div class="dash-charts">
        <div class="dash-chart">${daysBlock}</div>
        <div class="dash-chart">${statusBlock || '<p class="dash-empty">Пока нет задач</p>'}</div>
      </div>
      <div class="dash-stats">
        <div class="dash-stat"><span>Среднее время выполнения</span><b>${esc(avg)}</b></div>
        <div class="dash-stat"><span>Доставлено сообщений</span><b>${esc(share)}</b></div>
      </div>`;
  }

  function chatHtml() {
    const messages = (data && data.messages) || [];
    const wait = window.OfficeFeed && OfficeFeed.replyWaitCaption
      ? OfficeFeed.replyWaitCaption(data.tasks, messages, agentId)
      : '';
    const lines = messages.filter((message) => {
      return !(window.OfficeFeed && typeof OfficeFeed.ownerDirectPlaque === 'function'
        && OfficeFeed.ownerDirectPlaque(message, data.tasks));
    }).map((message) => {
      const role = message.role === 'owner' ? 'owner' : message.role === 'system' ? 'system' : 'agent';
      const who = role === 'owner' ? ownerName() : role === 'system' ? 'Система' : ((data.agent && data.agent.name) || 'Агент');
      const text = visibleText(message.text);
      const delivery = message.deliveryLabel ? `<span class="dash-delivery">${esc(message.deliveryLabel)}</span>` : '';
      return `<article class="dash-bubble ${role}">
        <header><b>${esc(who)}</b><time datetime="${esc(message.createdAt || '')}">${esc(fmtTime(message.createdAt))}</time></header>
        ${text ? `<p>${esc(text)}</p>` : ''}
        ${delivery}
      </article>`;
    }).join('');
    const templates = TEMPLATES.map(([label, text]) =>
      `<button type="button" class="dash-template" data-text="${esc(text)}">${esc(label)}</button>`).join('');
    return `
      <div class="dash-chat" id="dashChatLog">${wait ? `<p class="reply-wait">${esc(wait)}</p>` : ''}${lines || (wait ? '' : '<p class="dash-empty">Сообщений пока нет</p>')}</div>
      <div class="dash-templates">${templates}</div>
      <form class="dash-compose" id="dashChatForm">
        <label for="dashChatInput">Сообщение агенту</label>
        ${routeLine()}
        <textarea id="dashChatInput" maxlength="4000" placeholder="Приказ. Enter отправляет, Shift+Enter переносит строку"></textarea>
        <button class="btn gold" id="dashSend" type="submit">Отправить</button>
      </form>
      <p class="dash-note${note.startsWith('Приказ сохранён') ? ' ok' : ''}">${esc(note)}</p>`;
  }

  function ensureButton() {
    const panel = document.getElementById('panel');
    const hero = panel && panel.querySelector('.p-hero');
    if (!hero || hero.querySelector('.dash-expand')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dash-expand';
    button.textContent = 'Развернуть';
    button.setAttribute('aria-controls', 'agentDash');
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (panel.dataset.agent) openDash(panel.dataset.agent, 'overview', 'push');
    });
    hero.appendChild(button);
  }

  function onKey(event) {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeDash();
      return;
    }
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      if (!event.target.closest('[role="tablist"]')) return;
      event.preventDefault();
      const index = TABS.indexOf(tab);
      const next = event.key === 'ArrowRight' ? (index + 1) % TABS.length : (index + TABS.length - 1) % TABS.length;
      selectTab(TABS[next]);
      const button = document.getElementById(`dashTab-${TABS[next]}`);
      if (button) button.focus();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = [...root.querySelectorAll('button, a, input, textarea, select')].filter((el) => !el.disabled && el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function boot() {
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'dashTitle');
    ensureButton();
    const panel = document.getElementById('panel');
    if (panel) new MutationObserver(ensureButton).observe(panel, { childList: true, subtree: true });
    window.addEventListener('popstate', applyHash);
    window.addEventListener('hashchange', applyHash);
    window.addEventListener('keydown', onKey, true);
    window.setInterval(() => { if (open) load(); }, 4000);
    applyHash();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
