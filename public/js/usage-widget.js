/* Виджет «Лимит Grok». Пороги: от 80 жёлтый, от 95 красный баннер. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GrokUsage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function levelOf(usedPct) {
    const n = Number(usedPct);
    if (!Number.isFinite(n)) return 'empty';
    if (n >= 95) return 'critical';
    if (n >= 80) return 'warn';
    return 'ok';
  }

  function formatPct(value) {
    const rounded = Math.round(Number(value) * 100) / 100;
    if (!Number.isFinite(rounded)) return '';
    return String(Object.is(rounded, -0) ? 0 : rounded);
  }

  function formatMsk(iso) {
    const date = new Date(iso || '');
    if (Number.isNaN(date.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Moscow',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const pick = (type) => {
      const part = parts.find((item) => item.type === type);
      return part ? part.value : '';
    };
    const day = pick('day');
    const month = pick('month');
    const hour = pick('hour');
    const minute = pick('minute');
    if (!day || !month || !hour || !minute) return '';
    return `${day}.${month} ${hour}:${minute} МСК`;
  }

  function emptyView() {
    return {
      empty: true,
      level: 'empty',
      plan: 'нет данных',
      pctText: '',
      splitText: '',
      resetText: '',
      updatedText: '',
      timesText: '',
      banner: '',
      meter: 0,
      label: 'Лимит Grok: нет данных',
    };
  }

  function present(usage) {
    const latest = usage && usage.latest;
    const pct = latest && typeof latest.usedPct === 'number' ? latest.usedPct : Number.NaN;
    if (!Number.isFinite(pct)) return emptyView();
    const level = levelOf(pct);
    const used = formatPct(pct);
    const left = formatPct(Math.max(0, 100 - pct));
    const reset = formatMsk(latest.resetsAt);
    const updated = formatMsk(latest.updatedAt);
    const plan = typeof latest.plan === 'string' && latest.plan.trim() ? latest.plan.trim() : 'нет данных';
    const banner = level === 'critical'
      ? `Лимит Grok почти исчерпан: использовано ${used}%. Сброс ${reset}`
      : '';
    const resetText = reset ? `сброс ${reset}` : '';
    const updatedText = updated ? `обновлено ${updated}` : '';
    return {
      empty: false,
      level,
      plan,
      pctText: `${used}%`,
      splitText: `использовано ${used}% · осталось ${left}%`,
      resetText,
      updatedText,
      timesText: [resetText, updatedText].filter(Boolean).join(' · '),
      banner,
      meter: Math.max(0, Math.min(100, pct)),
      label: `Лимит Grok, план ${plan}, использовано ${used}%, осталось ${left}%, сброс ${reset}, обновлено ${updated}`,
    };
  }

  return { levelOf, formatPct, formatMsk, present };
});
