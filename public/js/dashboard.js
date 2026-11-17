/* Безопасная отрисовка дашборда: свой SVG и markdown без HTML агента. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OfficeDashboard = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PALETTE = ['#f5c451', '#7dd3fc', '#c4b5fd', '#86efac', '#fdba74', '#f9a8d4'];

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function unescapeHtml(s) {
    return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  }

  function safeHttp(raw) {
    const s = String(raw || '').trim();
    if (!s || /[\s"'<>]/.test(s)) return '';
    try {
      const url = new URL(s);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      if (url.username || url.password) return '';
      return url.href;
    } catch (_) {
      return '';
    }
  }

  function applyOutsideTags(html, fn) {
    return html.split(/(<[^>]+>)/g).map((part, i) => (i % 2 ? part : fn(part))).join('');
  }

  function formatInline(raw) {
    let html = esc(raw);
    html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (full, label, url) => {
      const href = safeHttp(unescapeHtml(url));
      if (!href) return full;
      return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });
    html = applyOutsideTags(html, (text) => {
      let out = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
      out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
      out = out.replace(/(^|[\s(])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
      return out;
    });
    return html;
  }

  function inline(raw) {
    const stash = [];
    const withCodes = String(raw).replace(/`([^`\n]+)`/g, (_, code) => {
      const token = `\uE000${stash.length}\uE001`;
      stash.push(`<code>${esc(code)}</code>`);
      return token;
    });
    const html = formatInline(withCodes);
    return html.replace(/\uE000(\d+)\uE001/g, (_, i) => stash[Number(i)] || '');
  }

  function renderMarkdown(src) {
    const stash = [];
    const token = (html) => {
      const mark = `\uE000${stash.length}\uE001`;
      stash.push(html);
      return mark;
    };
    let text = String(src ?? '').replace(/\r\n/g, '\n');
    text = text.replace(/(^|\n)```[^\n]*\n([\s\S]*?)\n```(?=\n|$)/g, (_, lead, code) => (
      `${lead}${token(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`)}`
    ));
    const lines = text.split('\n');
    let html = '';
    let list = null;
    const closeList = () => {
      if (!list) return;
      html += list === 'ol' ? '</ol>' : '</ul>';
      list = null;
    };
    for (const line of lines) {
      const only = /^\uE000(\d+)\uE001$/.exec(line.trim());
      if (only) {
        closeList();
        html += stash[Number(only[1])] || '';
        continue;
      }
      if (!line.trim()) {
        closeList();
        continue;
      }
      const heading = /^(#{1,3})\s+(.*)$/.exec(line);
      if (heading) {
        closeList();
        const level = heading[1].length;
        html += `<h${level} class="md-h">${inline(heading[2])}</h${level}>`;
        continue;
      }
      const ul = /^[-*]\s+(.*)$/.exec(line);
      const ol = /^\d+\.\s+(.*)$/.exec(line);
      if (ul || ol) {
        const kind = ul ? 'ul' : 'ol';
        if (list && list !== kind) closeList();
        if (!list) {
          html += kind === 'ol' ? '<ol>' : '<ul>';
          list = kind;
        }
        html += `<li>${inline((ul || ol)[1])}</li>`;
        continue;
      }
      closeList();
      html += `<p>${inline(line)}</p>`;
    }
    closeList();
    return html;
  }

  function formatTick(v) {
    const abs = Math.abs(v);
    if (abs >= 100 || Number.isInteger(v)) return String(Math.round(v));
    return String(Math.round(v * 10) / 10);
  }

  function chartSvg(block) {
    const w = 360;
    const h = 210;
    const padL = 42;
    const padR = 12;
    const padT = 16;
    const padB = 32;
    const iw = w - padL - padR;
    const ih = h - padT - padB;
    const labels = block.labels || [];
    const series = block.series || [];
    const nums = series.flatMap((s) => (s.data || []).map(Number)).filter((n) => Number.isFinite(n));
    let min = Math.min(0, ...(nums.length ? nums : [0]));
    let max = Math.max(0, ...(nums.length ? nums : [1]));
    if (min === max) max = min + 1;
    const span = max - min || 1;
    const y = (v) => padT + ((max - v) / span) * ih;
    const xAt = (i) => (labels.length <= 1 ? padL + iw / 2 : padL + (iw * i) / (labels.length - 1));
    let grid = '';
    for (let i = 0; i <= 4; i++) {
      const v = min + (span * i) / 4;
      const yy = y(v).toFixed(1);
      grid += `<line x1="${padL}" y1="${yy}" x2="${w - padR}" y2="${yy}" stroke="rgba(255,255,255,.12)" stroke-width="1"/>`;
      grid += `<text x="${padL - 6}" y="${yy}" text-anchor="end" dominant-baseline="middle" fill="#94a3b8" font-size="10">${esc(formatTick(v))}</text>`;
    }
    let body = '';
    if (block.kind === 'line') {
      series.forEach((s, si) => {
        const color = PALETTE[si % PALETTE.length];
        const pts = (s.data || []).map((v, i) => `${xAt(i).toFixed(1)},${y(Number(v)).toFixed(1)}`).join(' ');
        body += `<polyline fill="none" stroke="${color}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" points="${pts}"/>`;
        (s.data || []).forEach((v, i) => {
          body += `<circle cx="${xAt(i).toFixed(1)}" cy="${y(Number(v)).toFixed(1)}" r="3.2" fill="${color}"/>`;
        });
      });
    } else {
      const groupW = labels.length ? iw / labels.length : iw;
      const barW = Math.min(22, (groupW * 0.72) / Math.max(1, series.length));
      const groupBars = series.length * barW;
      labels.forEach((_, i) => {
        const gx = padL + groupW * i + (groupW - groupBars) / 2;
        series.forEach((s, si) => {
          const v = Number((s.data || [])[i]);
          if (!Number.isFinite(v)) return;
          const y0 = y(0);
          const y1 = y(v);
          const top = Math.min(y0, y1);
          const bh = Math.max(1.5, Math.abs(y1 - y0));
          const color = PALETTE[si % PALETTE.length];
          body += `<rect x="${(gx + si * barW).toFixed(1)}" y="${top.toFixed(1)}" width="${Math.max(2, barW - 2).toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${color}"/>`;
        });
      });
    }
    labels.forEach((label, i) => {
      const step = Math.ceil(labels.length / 8);
      const show = labels.length <= 8 || i % step === 0 || i === labels.length - 1;
      if (!show) return;
      const x = block.kind === 'line' ? xAt(i) : padL + (iw / labels.length) * i + (iw / labels.length) / 2;
      body += `<text x="${x.toFixed(1)}" y="${h - 10}" text-anchor="middle" fill="#94a3b8" font-size="10">${esc(label)}</text>`;
    });
    const legend = series.map((s, si) => (
      `<span class="legend-item"><i style="background:${PALETTE[si % PALETTE.length]}"></i>${esc(s.name || '')}</span>`
    )).join('');
    return `<figure class="dash-chart"><svg viewBox="0 0 ${w} ${h}" width="100%" height="auto" role="img" aria-label="${esc(block.title || 'График')}" preserveAspectRatio="xMidYMid meet">${grid}${body}</svg><figcaption>${legend}</figcaption></figure>`;
  }

  function kpiCard(block) {
    const trend = block.trend === 'up' ? '↑' : block.trend === 'down' ? '↓' : block.trend === 'flat' ? '→' : '';
    const trendHtml = trend ? `<span class="kpi-trend trend-${esc(block.trend)}">${trend}</span>` : '';
    const delta = block.delta != null && block.delta !== '' ? `<span class="kpi-delta">${esc(block.delta)}</span>` : '';
    const target = block.target != null && block.target !== '' ? `<span class="kpi-target">цель ${esc(block.target)}</span>` : '';
    const unit = block.unit ? `<span class="kpi-unit">${esc(block.unit)}</span>` : '';
    return `<article class="kpi-card"><div class="kpi-label">${esc(block.label)}</div><div class="kpi-value">${esc(block.value)}${unit}</div><div class="kpi-sub">${trendHtml}${delta}${target}</div></article>`;
  }

  function forecastCard(block) {
    const pct = Math.round(Math.max(0, Math.min(1, Number(block.confidence) || 0)) * 100);
    const unit = block.unit ? `<span class="kpi-unit">${esc(block.unit)}</span>` : '';
    return `<article class="forecast"><div class="kpi-label">${esc(block.label)}</div><div class="kpi-value">${esc(block.value)}${unit}</div><div class="forecast-meta">горизонт ${esc(block.horizon || '')} · уверенность ${pct}%</div><div class="conf-bar" aria-hidden="true"><i style="width:${pct}%"></i></div></article>`;
  }

  function linksBlock(block) {
    const items = (block.items || []).map((item) => {
      const href = safeHttp(item && item.url);
      if (!href) return '';
      return `<a class="dash-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(item.label || href)}</a>`;
    }).join('');
    if (!items) return '';
    return `<div class="dash-links">${items}</div>`;
  }

  function renderBlock(block) {
    if (!block || typeof block !== 'object') return '';
    if (block.type === 'chart') {
      return `<section class="dash-block"><h3 class="dash-block-title">${esc(block.title || '')}</h3>${chartSvg(block)}</section>`;
    }
    if (block.type === 'forecast') return forecastCard(block);
    if (block.type === 'markdown') return `<div class="md">${renderMarkdown(block.text || '')}</div>`;
    if (block.type === 'links') return linksBlock(block);
    return '';
  }

  const EXAMPLE = {
    title: 'Сводка направления',
    blocks: [
      { type: 'kpi', label: 'Выполнено', value: 12, unit: 'задач', target: 15, delta: '+2', trend: 'up' },
      { type: 'kpi', label: 'В работе', value: 3, unit: 'задачи', trend: 'flat' },
      {
        type: 'chart',
        title: 'Задачи по дням',
        kind: 'bar',
        labels: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт'],
        series: [{ name: 'Закрыто', data: [3, 5, 4, 6, 2] }],
      },
      { type: 'forecast', label: 'Ближайший срок', value: 'пятница', horizon: '5 дней', confidence: 0.7 },
      { type: 'markdown', text: '## Статус\nВсё **в графике**.\n\n- смотрю очередь\n- жду вводные' },
      { type: 'links', items: [{ label: 'Доска', url: 'https://example.com/board' }] },
    ],
  };

  function exampleDetails() {
    return `<details class="dash-example"><summary>Пример шаблона</summary><pre><code>${esc(JSON.stringify(EXAMPLE, null, 2))}</code></pre></details>`;
  }

  function fmtWhen(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function renderBlocks(blocks) {
    let html = '';
    let i = 0;
    const list = Array.isArray(blocks) ? blocks : [];
    while (i < list.length) {
      if (list[i] && list[i].type === 'kpi') {
        let cards = '';
        while (i < list.length && list[i] && list[i].type === 'kpi') {
          cards += kpiCard(list[i]);
          i += 1;
        }
        html += `<div class="kpi-grid">${cards}</div>`;
      } else {
        html += renderBlock(list[i]);
        i += 1;
      }
    }
    return html;
  }

  function renderDashboard(dashboard) {
    if (!dashboard || !Array.isArray(dashboard.blocks)) {
      return `<div class="dash dash-empty"><div class="empty"><b>Агент ещё не опубликовал дашборд</b>Направление само присылает сводку методом POST.</div>${exampleDetails()}</div>`;
    }
    const title = dashboard.title ? `<h3 class="dash-title">${esc(dashboard.title)}</h3>` : '';
    const when = dashboard.updatedAt ? `<time class="dash-when" datetime="${esc(dashboard.updatedAt)}">обновлено ${esc(fmtWhen(dashboard.updatedAt))}</time>` : '';
    const blocks = renderBlocks(dashboard.blocks) || '<div class="empty"><b>Блоков нет</b>В этой версии нет ни одного блока.</div>';
    return `<div class="dash">${title}${when}${blocks}</div>`;
  }

  return { esc, safeHttp, renderMarkdown, renderDashboard, chartSvg, EXAMPLE };
});
