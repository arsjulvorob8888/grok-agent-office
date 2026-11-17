/* Безопасный markdown для страницы вопроса. HTML экранируется.
   Ссылками становятся только http:// и https://. grokbot:// остаётся текстом. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.renderSafeMarkdown = api.renderSafeMarkdown;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const GROK_HINT = 'Откройте в Grok — браузер эту ссылку не откроет';

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function isHttp(url) {
    return /^https?:\/\/\S+$/i.test(url) && !/[\s<>"']/.test(url);
  }

  function isGrok(url) {
    return /^grokbot:\/\/\S+$/i.test(url) && !/[\s<>"']/.test(url);
  }

  function grokHtml(url) {
    return `<span class="md-grok">${esc(url)}<span class="md-grok-hint">${esc(GROK_HINT)}</span></span>`;
  }

  function anchorOrText(url, labelHtml) {
    const u = String(url || '').trim();
    if (isHttp(u)) {
      return `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${labelHtml}</a>`;
    }
    if (isGrok(u)) return grokHtml(u);
    return labelHtml;
  }

  function splitTrail(url) {
    let u = url;
    let trail = '';
    while (/[),.;!?]$/.test(u)) {
      trail = u.slice(-1) + trail;
      u = u.slice(0, -1);
    }
    return { u, trail };
  }

  function renderInline(raw) {
    const tokens = [];
    const hold = (html) => {
      tokens.push(html);
      return `\u0000${tokens.length - 1}\u0000`;
    };
    let s = String(raw ?? '');
    s = s.replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${esc(code)}</code>`));
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label, url) => hold(anchorOrText(url, esc(label))));
    s = s.replace(/https?:\/\/[^\s<]+/g, (url) => {
      const parts = splitTrail(url);
      return hold(anchorOrText(parts.u, esc(parts.u))) + parts.trail;
    });
    s = s.replace(/grokbot:\/\/[^\s<]+/g, (url) => {
      const parts = splitTrail(url);
      return hold(isGrok(parts.u) ? grokHtml(parts.u) : esc(parts.u)) + parts.trail;
    });
    s = esc(s).replace(/\u0000(\d+)\u0000/g, (_, i) => tokens[Number(i)]);
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    return s;
  }

  function renderSafeMarkdown(src) {
    const lines = String(src ?? '').replace(/\r\n/g, '\n').split('\n');
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line)) {
        const buf = [];
        i += 1;
        while (i < lines.length && !/^```/.test(lines[i])) {
          buf.push(lines[i]);
          i += 1;
        }
        if (i < lines.length) i += 1;
        blocks.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
        continue;
      }
      if (!line.trim()) {
        i += 1;
        continue;
      }
      const heading = line.match(/^(#{1,3})\s+(.*)$/);
      if (heading) {
        blocks.push(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`);
        i += 1;
        continue;
      }
      if (/^\s*[-*]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          items.push(`<li>${renderInline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`);
          i += 1;
        }
        blocks.push(`<ul>${items.join('')}</ul>`);
        continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          items.push(`<li>${renderInline(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`);
          i += 1;
        }
        blocks.push(`<ol>${items.join('')}</ol>`);
        continue;
      }
      const para = [];
      while (
        i < lines.length
        && lines[i].trim()
        && !/^```/.test(lines[i])
        && !/^#{1,3}\s+/.test(lines[i])
        && !/^\s*[-*]\s+/.test(lines[i])
        && !/^\s*\d+\.\s+/.test(lines[i])
      ) {
        para.push(lines[i]);
        i += 1;
      }
      blocks.push(`<p>${renderInline(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
    }
    return blocks.join('');
  }

  return { renderSafeMarkdown, GROK_HINT };
});
