import { bag } from './bag.js';

export function install() {
  bag.trivyOn = function trivyOn() {
    return bag.state.trivyEnabled !== false;
  }

  /** Minimal Markdown → HTML (headers, lists, tables, code, links). */

  bag.cveBadge = function cveBadge(summary) {
    if (!summary || typeof summary !== 'object') return '<span class="muted">—</span>';
    const c = Number(summary.CRITICAL || 0);
    const h = Number(summary.HIGH || 0);
    const m = Number(summary.MEDIUM || 0);
    if (c > 0) return `<span class="badge badge-danger" title="Critical ${c}">C${c}</span>`;
    if (h > 0) return `<span class="badge badge-warn" title="High ${h}">H${h}</span>`;
    if (m > 0) return `<span class="badge badge-info" title="Medium ${m}">M${m}</span>`;
    if (Number(summary.TOTAL || 0) > 0) return `<span class="badge">L${Number(summary.LOW || 0)}</span>`;
    return `<span class="badge badge-success" title="Aucune CVE">CVE OK</span>`;
  }

  bag.cveStatusTd = function cveStatusTd(ref, scan) {
    if (!ref) return '<td><span class="muted">—</span></td>';
    if (!scan) {
      return `<td data-cve-cell="${bag.esc(ref)}"><span class="muted cve-pending">…</span></td>`;
    }
    if (scan.Status === 'skipped' || scan.Warning) {
      return `<td data-cve-cell="${bag.esc(ref)}"><span class="muted" title="${bag.esc(scan.Warning || 'Scan ignoré')}">—</span></td>`;
    }
    return `<td data-cve-cell="${bag.esc(ref)}"><button type="button" class="cve-pill-btn" data-cve-ref="${bag.esc(ref)}" title="Détail CVE">${bag.cveBadge(scan.Summary)}</button></td>`;
  }

  bag.fillCveCell = function fillCveCell(cell, item) {
    if (!cell || !item) return;
    const ref = item.ImageRef || cell.dataset.cveCell || '';
    if (item.Status === 'skipped' || item.Warning) {
      cell.innerHTML = `<span class="muted" title="${bag.esc(item.Warning || 'Scan ignoré')}">—</span>`;
      return;
    }
    cell.innerHTML = `<button type="button" class="cve-pill-btn" data-cve-ref="${bag.esc(ref)}" title="Détail CVE">${bag.cveBadge(item.Summary)}</button>`;
  }

  bag.bindCveDetailButtons = function bindCveDetailButtons(scope) {
    (scope || document).querySelectorAll('[data-cve-ref]').forEach((btn) => {
      if (btn.dataset.cveBound === '1') return;
      btn.dataset.cveBound = '1';
      btn.addEventListener('click', () => bag.openCveScanModal(btn.dataset.cveRef));
    });
  }

  bag.ensureImagesCveColumn = async function ensureImagesCveColumn(root, refs) {
    let res;
    try {
      res = await bag.Api.ensureImageScans(bag.Api.getEndpointId(), { Images: refs });
    } catch (_) {
      bag.root.querySelectorAll('[data-cve-cell]').forEach((cell) => {
        if (cell.querySelector('.cve-pending')) {
          cell.innerHTML = '<span class="muted" title="Scan indisponible">—</span>';
        }
      });
      return;
    }
    const byRef = new Map();
    (res?.Items || []).forEach((it) => {
      if (it.ImageRef) byRef.set(it.ImageRef, it);
    });
    bag.root.querySelectorAll('[data-cve-cell]').forEach((cell) => {
      const ref = cell.dataset.cveCell;
      const it = byRef.get(ref);
      if (it) bag.fillCveCell(cell, it);
      else if (cell.querySelector('.cve-pending')) {
        cell.innerHTML = '<span class="muted">—</span>';
      }
    });
    bag.bindCveDetailButtons(bag.root);
  }

  bag.openCveScanModal = async function openCveScanModal(ref) {
    if (!ref) return;
    const host = document.getElementById('scan-modal') || (() => {
      const el = document.createElement('div');
      el.id = 'scan-modal';
      bag.root?.appendChild(el);
      return el;
    })();
    host.innerHTML = `<div class="info-box">Chargement CVE <code>${bag.esc(ref)}</code>…</div>`;
    try {
      let res = null;
      try {
        res = await bag.Api.imageScan(bag.Api.getEndpointId(), { ref });
      } catch (_) {
        res = await bag.Api.scanImage(bag.Api.getEndpointId(), { Image: ref, Force: false });
      }
      const findings = (res.Findings || []).slice(0, 40);
      const rowsF = findings.map((f) => `<tr>
        <td>${bag.esc(f.Severity)}</td>
        <td class="mono">${bag.esc(f.Cve)}</td>
        <td>${bag.esc(f.Package)} ${bag.esc(f.Version || '')}</td>
        <td class="muted">${bag.esc((f.Title || '').slice(0, 120))}</td>
      </tr>`).join('');
      host.innerHTML = `
        <div class="modal-backdrop">
          <div class="modal modal-form-wide" style="max-width:820px">
            <h3>Scan CVE · ${bag.esc(ref)}</h3>
            <p>${bag.cveBadge(res.Summary)} · ${bag.esc(String(res.Summary?.TOTAL || 0))} finding(s)${res.FromCache ? ' <span class="muted">(cache)</span>' : ''}</p>
            <div class="table-wrap" style="max-height:360px;overflow:auto">
              <table class="data"><thead><tr><th>Sévérité</th><th>CVE</th><th>Paquet</th><th>Titre</th></tr></thead>
              <tbody>${rowsF || `<tr><td colspan="4" class="empty">Aucune vulnérabilité</td></tr>`}</tbody></table>
            </div>
            <div class="actions-bar"><button class="btn" id="close-scan">Fermer</button></div>
          </div>
        </div>`;
      document.getElementById('close-scan').onclick = () => { host.innerHTML = ''; };
    } catch (err) {
      host.innerHTML = `<div class="error-box">${bag.esc(err.message || 'Erreur CVE')}</div>`;
    }
  }

  /** Soft CVE gate before create/deploy — never throws; returns { proceed, html }. */

  bag.cveAdviseBeforeDeploy = async function cveAdviseBeforeDeploy(payload, errBox) {
    if (!bag.trivyOn()) {
      return { proceed: true, advise: null };
    }
    if (errBox) {
      errBox.innerHTML = `<div class="info-box">Vérification CVE (non bloquante)…</div>`;
    }
    let advise = null;
    try {
      advise = await bag.Api.adviseImages(bag.Api.getEndpointId(), payload);
    } catch (err) {
      if (errBox) {
        errBox.innerHTML = `<div class="info-box">Scan CVE indisponible (${bag.esc(err.message || 'erreur')}) — déploiement non bloqué.</div>`;
      }
      return { proceed: true, advise: null };
    }
    const items = Array.isArray(advise?.Items) ? advise.Items : [];
    if (!items.length) {
      if (errBox) errBox.innerHTML = '';
      return { proceed: true, advise };
    }
    const lines = items.map((it) => {
      if (it.Status === 'skipped' || it.Warning) {
        return `<li><code>${bag.esc(it.ImageRef || '?')}</code> — <span class="muted">${bag.esc(it.Warning || 'scan ignoré')}</span></li>`;
      }
      return `<li><code>${bag.esc(it.ImageRef || '?')}</code> ${bag.cveBadge(it.Summary)}${it.FromCache ? ' <span class="muted">(cache)</span>' : ''}</li>`;
    });
    const worst = String(advise?.Worst || 'ok');
    const skippedOnly = items.every((it) => it.Status === 'skipped' || it.Warning);
    let boxClass = 'info-box';
    let title = 'Scan CVE';
    if (worst === 'critical' || worst === 'high') {
      boxClass = 'error-box';
      title = 'CVE critiques / élevées détectées';
    } else if (worst === 'findings') {
      boxClass = 'info-box';
      title = 'CVE détectées (sévérité moyenne ou basse)';
    } else if (skippedOnly || worst === 'skipped') {
      boxClass = 'info-box';
      title = 'Scan CVE partiel ou indisponible';
    } else {
      title = 'Scan CVE : aucune vulnérabilité critique';
    }
    if (errBox) {
      errBox.innerHTML = `<div class="${boxClass}"><strong>${bag.esc(title)}</strong><ul style="margin:8px 0 0;padding-left:18px">${lines.join('')}</ul><p class="muted" style="margin:8px 0 0;font-size:12px">Le déploiement n’est jamais bloqué par Trivy.</p></div>`;
    }
    if (worst === 'critical' || worst === 'high') {
      const ok = window.confirm(
        'Des CVE Critical/High ont été trouvées sur une ou plusieurs images.\n\nContinuer le déploiement ?',
      );
      return { proceed: ok, advise };
    }
    return { proceed: true, advise };
  }

}
