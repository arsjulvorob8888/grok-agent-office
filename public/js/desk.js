/* Пульт направления: задачи, доли, свои SVG-графики и экранированный анализ. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OfficeDesk = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function isFinance(agent) {
    if (!agent) return false;
    if (agent.id === 'finance' || agent.parentId === 'finance') return true;
    return false;
  }

  function bucket(task) {
    const status = task.orderStatus || 'sent';
    if (status === 'in_progress') return 'progress';
    if (status === 'done' || status === 'failed') return 'done';
    return 'wait';
  }

  function doneAt(task) {
    const hist = Array.isArray(task.history) ? task.history : [];
    for (let i = hist.length - 1; i >= 0; i -= 1) {
      if (hist[i] && (hist[i].status === 'done' || hist[i].status === 'failed')) {
        const t = Date.parse(hist[i].at);
        if (!Number.isNaN(t)) return t;
      }
    }
    return null;
  }

  function durationMs(task, now) {
    const start = Date.parse(task.createdAt);
    if (Number.isNaN(start)) return 0;
    const finished = doneAt(task);
    const end = finished != null ? finished : now;
    return Math.max(0, end - start);
  }

  function formatDuration(ms) {
    const m = Math.max(0, Math.round(ms / 60000));
    if (m < 1) return 'меньше минуты';
    if (m < 60) return `${m} мин`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    if (h < 48) return rm ? `${h} ч ${rm} мин` : `${h} ч`;
    return `${Math.floor(h / 24)} д`;
  }

  function dayKey(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function dayLabel(key) {
    const parts = key.split('-');
    return `${parts[2]}.${parts[1]}`;
  }

  function lastDays(now, n) {
    const days = [];
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    for (let i = n - 1; i >= 0; i -= 1) {
      days.push(dayKey(start.getTime() - i * 86400000));
    }
    return days;
  }

  function progressOf(task) {
    const status = task.orderStatus || 'sent';
    if (status === 'done') return 100;
    if (status === 'failed') return 0;
    const n = Number(task.progress);
    if (Number.isFinite(n)) return Math.max(0, Math.min(100, n));
    if (status === 'in_progress') return 0;
    return 0;
  }

  function stats(tasks, now, finance) {
    const list = tasks || [];
    const total = list.length;
    const done = list.filter((t) => (t.orderStatus || '') === 'done').length;
    const progress = list.filter((t) => bucket(t) === 'progress').length;
    const wait = list.filter((t) => bucket(t) === 'wait').length;
    const donePct = total ? Math.round((done / total) * 100) : 0;
    const avgProgress = total ? Math.round(list.reduce((s, t) => s + progressOf(t), 0) / total) : 0;
    const doneTasks = list.filter((t) => doneAt(t) != null);
    const avgMs = doneTasks.length
      ? doneTasks.reduce((s, t) => s + durationMs(t, now), 0) / doneTasks.length
      : 0;
    const days = lastDays(now, 7);
    const doneByDay = Object.fromEntries(days.map((d) => [d, 0]));
    const touchByDay = Object.fromEntries(days.map((d) => [d, 0]));
    const hoursByDay = Object.fromEntries(days.map((d) => [d, []]));
    const progByDay = Object.fromEntries(days.map((d) => [d, []]));
    for (const task of list) {
      const finished = doneAt(task);
      if (finished != null) {
        const key = dayKey(finished);
        if (doneByDay[key] != null && task.orderStatus === 'done') {
          doneByDay[key] += 1;
          hoursByDay[key].push(durationMs(task, now) / 3600000);
        }
      }
      const touched = finished != null ? finished : Date.parse(task.createdAt);
      if (!Number.isNaN(touched)) {
        const key = dayKey(touched);
        if (touchByDay[key] != null) {
          touchByDay[key] += 1;
          progByDay[key].push(progressOf(task));
        }
      }
    }
    const labels = days.map(dayLabel);
    const doneSeries = days.map((d) => doneByDay[d]);
    const hourSeries = days.map((d) => {
      const arr = hoursByDay[d];
      if (!arr.length) return 0;
      const avg = arr.reduce((s, n) => s + n, 0) / arr.length;
      return Math.round(avg * 10) / 10;
    });
    const donePctSeries = days.map((d) => (touchByDay[d] ? Math.round((doneByDay[d] / touchByDay[d]) * 100) : 0));
    const progSeries = days.map((d) => {
      const arr = progByDay[d];
      if (!arr.length) return 0;
      return Math.round(arr.reduce((s, n) => s + n, 0) / arr.length);
    });
    return {
      total, done, progress, wait, donePct, avgProgress, avgMs, labels,
      doneSeries, hourSeries, donePctSeries, progSeries, finance,
    };
  }

  function chainText(task, tasks, nameOf) {
    const byId = new Map((tasks || []).map((t) => [t.id, t]));
    const path = [];
    const seen = new Set();
    let cur = task;
    while (cur && cur.id && !seen.has(cur.id)) {
      seen.add(cur.id);
      path.push(cur);
      cur = cur.parentOrderId ? byId.get(cur.parentOrderId) : null;
    }
    path.reverse();
    const names = [];
    for (const step of path) {
      const from = nameOf(step.fromAgentId || 'owner');
      const to = nameOf(step.agentId || step.agent);
      if (!names.length || names[names.length - 1] !== from) names.push(from);
      if (names[names.length - 1] !== to) names.push(to);
    }
    return names.join(' → ');
  }

  function bars(title, labels, values, unit) {
    const w = 360;
    const h = 160;
    const padL = 28;
    const padR = 8;
    const padT = 12;
    const padB = 28;
    const iw = w - padL - padR;
    const ih = h - padT - padB;
    const max = Math.max(1, ...values.map((n) => Number(n) || 0));
    const bw = labels.length ? (iw / labels.length) * 0.62 : iw;
    let body = '';
    labels.forEach((label, i) => {
      const v = Number(values[i]) || 0;
      const bh = Math.max(v > 0 ? 2 : 0, (v / max) * ih);
      const x = padL + (iw / labels.length) * i + ((iw / labels.length) - bw) / 2;
      const y = padT + ih - bh;
      body += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="#f5c451"/>`;
      body += `<text x="${(padL + (iw / labels.length) * i + iw / labels.length / 2).toFixed(1)}" y="${h - 8}" text-anchor="middle" fill="#94a3b8" font-size="10">${esc(label)}</text>`;
    });
    return `<figure class="desk-chart"><figcaption>${esc(title)}</figcaption><svg viewBox="0 0 ${w} ${h}" width="100%" height="auto" role="img" aria-label="${esc(title)}" preserveAspectRatio="xMidYMid meet">${body}</svg><div class="desk-unit">${esc(unit)}</div></figure>`;
  }

  const STATUS_WORD = {
    sent: 'отправлен',
    accepted: 'принял',
    in_progress: 'в работе',
    done: 'выполнено',
    failed: 'не выполнен',
  };
  const BUCKET_WORD = { wait: 'Ждёт', progress: 'В работе', done: 'Готово' };

  function taskCard(task, tasks, nameOf, now) {
    const hist = Array.isArray(task.history) ? task.history : [];
    const history = hist.map((h) => {
      const bits = [STATUS_WORD[h.status] || h.status || ''];
      if (h.progress != null) bits.push(`${h.progress}%`);
      if (h.note) bits.push(h.note);
      return `<li><span>${esc(bits.filter(Boolean).join(' · '))}</span></li>`;
    }).join('');
    const who = chainText(task, tasks, nameOf);
    return `<article class="desk-task" data-bucket="${bucket(task)}">
      <header><b>${esc(BUCKET_WORD[bucket(task)])}</b><span>${esc(formatDuration(durationMs(task, now)))}</span></header>
      <p>${esc(task.text || 'Без текста')}</p>
      ${who ? `<div class="desk-chain">${esc(who)}</div>` : ''}
      ${history ? `<ol class="desk-hist">${history}</ol>` : ''}
    </article>`;
  }

  function lockHTML() {
    return `<section class="desk-lock" data-desk-lock="1">
      <b>Закрыто паролем штаба</b>
      <p>У Финансов и помощников здесь только доли и прогресс, без сумм. Откройте паролем штаба.</p>
      <button type="button" class="btn gold" id="deskUnlock">Ввести пароль</button>
    </section>`;
  }

  function render(opts) {
    const agent = opts.agent;
    const tasks = opts.tasks || [];
    const now = opts.now || Date.now();
    const finance = isFinance(agent);
    const nameOf = opts.nameOf || ((id) => (id === 'owner' ? 'Владелец' : String(id || '')));
    if (opts.locked) {
      return `<div class="desk-wrap">${lockHTML()}</div>`;
    }
    const s = stats(tasks, now, finance);
    const kpis = finance
      ? `<div class="desk-kpis">
          <article class="desk-kpi"><div class="desk-kpi-label">Выполнено</div><div class="desk-kpi-value">${s.donePct}%</div></article>
          <article class="desk-kpi"><div class="desk-kpi-label">Прогресс</div><div class="desk-kpi-value">${s.avgProgress}%</div></article>
        </div>`
      : `<div class="desk-kpis">
          <article class="desk-kpi"><div class="desk-kpi-label">Всего</div><div class="desk-kpi-value">${s.total}</div></article>
          <article class="desk-kpi"><div class="desk-kpi-label">Выполнено</div><div class="desk-kpi-value">${s.donePct}%</div></article>
          <article class="desk-kpi"><div class="desk-kpi-label">В работе</div><div class="desk-kpi-value">${s.progress}</div></article>
          <article class="desk-kpi"><div class="desk-kpi-label">Среднее время</div><div class="desk-kpi-value">${esc(formatDuration(s.avgMs))}</div></article>
        </div>`;
    const charts = finance
      ? `${bars('Доля выполненного по дням', s.labels, s.donePctSeries, '%')}${bars('Прогресс по дням', s.labels, s.progSeries, '%')}`
      : `${bars('Выполнено по дням', s.labels, s.doneSeries, 'задач')}${bars('Время выполнения', s.labels, s.hourSeries, 'часы')}`;
    const groups = ['wait', 'progress', 'done'].map((key) => {
      const items = tasks.filter((t) => bucket(t) === key);
      const cards = items.map((t) => taskCard(t, tasks, nameOf, now)).join('')
        || '<div class="empty"><b>Пусто</b>В этом состоянии задач нет.</div>';
      return `<section class="desk-bucket" data-bucket="${key}"><h3>${BUCKET_WORD[key]}</h3>${cards}</section>`;
    }).join('');
    const analysis = opts.analysis && opts.analysis.text
      ? `<div class="desk-analysis">${esc(opts.analysis.text)}</div><time class="desk-when">${esc(opts.analysis.updatedAt || '')}</time>`
      : '<div class="empty"><b>Пока пусто</b>Направление ещё не прислало анализ.</div>';
    return `<div class="desk-wrap" data-finance="${finance ? '1' : '0'}">
      <section class="desk-sec"><h2>Задачи</h2>${groups}</section>
      <section class="desk-sec"><h2>Показатели</h2>${kpis}</section>
      <section class="desk-sec desk-charts"><h2>Графики</h2>${charts}</section>
      <section class="desk-sec" id="deskAnalysis"><h2>Анализ и прогноз</h2>${analysis}</section>
      <section class="desk-sec"><h2>Дать задачу</h2>
        <form id="deskTaskForm" class="task-form">
          <label for="deskTaskText">Задача для агента</label>
          <textarea id="deskTaskText" maxlength="4000" placeholder="Опиши, что нужно сделать…"></textarea>
          <div class="row"><span class="hint">Уйдёт в общий журнал</span><button class="btn gold" type="submit">Дать задачу</button></div>
          <div class="msg" id="deskMsg"></div>
        </form>
      </section>
    </div>`;
  }

  return {
    esc, isFinance, bucket, durationMs, formatDuration, stats, render, lockHTML,
  };
});
