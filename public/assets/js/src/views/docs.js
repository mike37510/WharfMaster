import { bag } from '../bag.js';

export function install() {
  bag.renderMarkdown = function renderMarkdown(src) {
    const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
    const html = [];
    let i = 0;
    let inCode = false;
    let codeLang = '';
    let codeBuf = [];
    let listType = null; // ul | ol
    let inTable = false;

    const flushList = () => {
      if (listType) {
        html.push(`</${listType}>`);
        listType = null;
      }
    };
    const flushTable = () => {
      if (inTable) {
        html.push('</tbody></table></div>');
        inTable = false;
      }
    };
    const inline = (text) => {
      let t = bag.esc(text);
      t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
      t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
        const safe = String(href).startsWith('http') || String(href).startsWith('/') || String(href).startsWith('#')
          ? href
          : '#';
        const ext = String(safe).startsWith('http') ? ' target="_blank" rel="noopener"' : '';
        return `<a href="${bag.esc(safe)}"${ext}>${label}</a>`;
      });
      return t;
    };
    const splitRow = (line) => line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

    while (i < lines.length) {
      const line = lines[i];
      if (line.startsWith('```')) {
        flushList();
        flushTable();
        if (!inCode) {
          inCode = true;
          codeLang = line.slice(3).trim();
          codeBuf = [];
        } else {
          html.push(`<pre class="docs-code"><code class="lang-${bag.esc(codeLang)}">${bag.esc(codeBuf.join('\n'))}</code></pre>`);
          inCode = false;
          codeLang = '';
          codeBuf = [];
        }
        i += 1;
        continue;
      }
      if (inCode) {
        codeBuf.push(line);
        i += 1;
        continue;
      }
      if (/^\|/.test(line) && line.includes('|')) {
        flushList();
        const cells = splitRow(line);
        const next = lines[i + 1] || '';
        const isSep = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(next);
        if (!inTable) {
          html.push('<div class="table-wrap docs-table"><table class="data"><thead><tr>');
          cells.forEach((c) => { html.push(`<th>${inline(c)}</th>`); });
          html.push('</tr></thead><tbody>');
          inTable = true;
          if (isSep) {
            i += 2;
            continue;
          }
          i += 1;
          continue;
        }
        if (isSep) {
          i += 1;
          continue;
        }
        html.push('<tr>');
        cells.forEach((c) => { html.push(`<td>${inline(c)}</td>`); });
        html.push('</tr>');
        i += 1;
        continue;
      }
      flushTable();
      if (/^---+$/.test(line.trim())) {
        flushList();
        html.push('<hr class="docs-hr">');
        i += 1;
        continue;
      }
      const hm = line.match(/^(#{1,3})\s+(.*)$/);
      if (hm) {
        flushList();
        const lvl = hm[1].length;
        const id = hm[2].toLowerCase().replace(/[^a-z0-9àâäéèêëïîôùûüç]+/gi, '-').replace(/^-|-$/g, '');
        html.push(`<h${lvl} id="${bag.esc(id)}" class="docs-h${lvl}">${inline(hm[2])}</h${lvl}>`);
        i += 1;
        continue;
      }
      const ul = line.match(/^[-*]\s+(.*)$/);
      if (ul) {
        if (listType !== 'ul') {
          flushList();
          html.push('<ul class="docs-list">');
          listType = 'ul';
        }
        html.push(`<li>${inline(ul[1])}</li>`);
        i += 1;
        continue;
      }
      const ol = line.match(/^\d+\.\s+(.*)$/);
      if (ol) {
        if (listType !== 'ol') {
          flushList();
          html.push('<ol class="docs-list">');
          listType = 'ol';
        }
        html.push(`<li>${inline(ol[1])}</li>`);
        i += 1;
        continue;
      }
      if (line.trim() === '') {
        flushList();
        i += 1;
        continue;
      }
      flushList();
      html.push(`<p class="docs-p">${inline(line)}</p>`);
      i += 1;
    }
    flushList();
    flushTable();
    if (inCode) {
      html.push(`<pre class="docs-code"><code>${bag.esc(codeBuf.join('\n'))}</code></pre>`);
    }
    return html.join('\n');
  }

  bag.viewDocs = async function viewDocs() {
    bag.root.innerHTML = bag.shell('Documentation', `
      ${bag.pageHeader('Documentation', false)}
      <div class="panel-card docs-panel">
        <div class="muted" id="docs-loading">Chargement du guide…</div>
        <div class="docs-body" id="docs-body" hidden></div>
      </div>
    `, { subtitle: 'Guide produit & API' });
    try {
      const res = await fetch('/docs/DOCUMENTATION.md?v=2.1.0', { headers: { Accept: 'text/plain' } });
      if (!res.ok) throw new Error('Impossible de charger la documentation (' + res.status + ')');
      const md = await res.text();
      const el = document.getElementById('docs-body');
      const loading = document.getElementById('docs-loading');
      if (el) {
        el.innerHTML = bag.renderMarkdown(md);
        el.hidden = false;
      }
      if (loading) loading.remove();
    } catch (err) {
      const loading = document.getElementById('docs-loading');
      if (loading) loading.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
    }
  }

}
