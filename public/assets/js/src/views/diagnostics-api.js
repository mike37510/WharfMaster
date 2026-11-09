import { bag } from '../bag.js';

/**
 * Admin Docker Engine API smoke via Portainer-style proxy: create then delete.
 * (Stacks Compose / users are out of scope — not Docker Engine API.)
 */
export function install() {
  function levelBadge(level, ok) {
    const lv = level || (ok ? 'ok' : 'fail');
    if (lv === 'ok') return '<span class="badge badge-success">OK</span>';
    if (lv === 'warn') return '<span class="badge badge-warn">WARN</span>';
    if (lv === 'skip') return '<span class="badge">SKIP</span>';
    return '<span class="badge badge-danger">KO</span>';
  }

  function renderSteps(steps) {
    if (!steps.length) {
      return '<div class="info-box">Lancez la suite pour tester création + suppression via l’API.</div>';
    }
    const failed = steps.filter((s) => s.level === 'fail').length;
    const ok = steps.filter((s) => s.level === 'ok').length;
    const warn = steps.filter((s) => s.level === 'warn' || s.level === 'skip').length;
    let html = `
      <div class="panel" style="margin-bottom:16px">
        <div class="section-title" style="margin-top:0">Résumé</div>
        <p style="margin:0">
          <span class="badge badge-success">${ok} OK</span>
          <span class="badge badge-warn" style="margin-left:6px">${warn} warn/skip</span>
          <span class="badge badge-danger" style="margin-left:6px">${failed} KO</span>
          <span class="muted" style="margin-left:10px">${steps.length} étapes</span>
        </p>
      </div>
      <div class="panel">
        <div class="section-title" style="margin-top:0">Journal</div>
        <table class="data-table"><thead><tr>
          <th style="width:90px">Statut</th><th>Étape</th><th>Détail</th><th style="width:90px">ms</th>
        </tr></thead><tbody>`;
    for (const s of steps) {
      html += `<tr>
        <td>${levelBadge(s.level, s.ok)}</td>
        <td class="mono">${bag.esc(s.id)}</td>
        <td>${bag.esc(s.detail || '')}</td>
        <td class="mono muted">${s.ms != null ? s.ms : '—'}</td>
      </tr>`;
    }
    html += '</tbody></table></div>';
    return html;
  }

  async function runApiLifecycleSmoke(onStep) {
    const steps = [];
    const push = (step) => {
      steps.push(step);
      if (onStep) onStep(steps.slice());
    };
    const run = async (id, fn) => {
      const t0 = performance.now();
      try {
        const detail = await fn();
        push({
          id,
          ok: true,
          level: 'ok',
          detail: detail == null ? 'OK' : String(detail),
          ms: Math.round(performance.now() - t0),
        });
        return true;
      } catch (err) {
        push({
          id,
          ok: false,
          level: 'fail',
          detail: err.message || String(err),
          ms: Math.round(performance.now() - t0),
        });
        return false;
      }
    };
    const skip = (id, detail) => {
      push({ id, ok: true, level: 'skip', detail, ms: 0 });
    };

    const tag = `wm${Date.now().toString(36)}`;
    const volName = `apitest_vol_${tag}`;
    const netName = `apitest_net_${tag}`;
    const ctrName = `apitest_ctr_${tag}`;
    const imageRef = 'alpine:latest';

    const created = {
      volume: null,
      networkId: null,
      containerId: null,
    };

    // --- Auth / discovery (read) ---
    await run('auth.me', async () => {
      const me = await bag.Api.me();
      return `user=${me.Username || me.username || '?'} role=${me.Role ?? me.role ?? '?'}`;
    });
    await run('endpoints.list', async () => {
      const eps = await bag.Api.endpoints();
      const n = Array.isArray(eps) ? eps.length : 0;
      if (!n) throw new Error('Aucun endpoint');
      return `${n} endpoint(s)`;
    });

    const dockerOk = !bag.Api.isAllEndpoints() && !!bag.Api.getEndpointId();
    if (!dockerOk) {
      skip('docker.*', 'Choisissez un nœud précis (pas « tous ») pour les tests Docker');
    }

    if (dockerOk) {
      // Ensure alpine present (best-effort pull)
      await run('images.ensure', async () => {
        try {
          await bag.Api.docker(`/images/${encodeURIComponent(imageRef)}/json`);
          return `${imageRef} déjà présente`;
        } catch (_) {
          // Docker Engine pull (stream body ignored)
          await bag.Api.docker(`/images/create?fromImage=alpine&tag=latest`, {
            method: 'POST',
            body: '',
          });
          await bag.Api.docker(`/images/${encodeURIComponent(imageRef)}/json`);
          return `${imageRef} tirée`;
        }
      });

      await run('images.list', async () => {
        const imgs = await bag.Api.docker('/images/json');
        return `${Array.isArray(imgs) ? imgs.length : 0} image(s)`;
      });

      // --- Volume ---
      await run('volumes.create', async () => {
        const res = await bag.Api.docker('/volumes/create', {
          method: 'POST',
          body: JSON.stringify({
            Name: volName,
            Driver: 'local',
            Labels: { 'wharfmaster.apitest': tag },
          }),
        });
        created.volume = res?.Name || volName;
        return created.volume;
      });
      await run('volumes.inspect', async () => {
        const v = await bag.Api.docker(`/volumes/${encodeURIComponent(created.volume)}`);
        if (!v?.Name) throw new Error('inspect volume vide');
        return v.Name;
      });
      await run('volumes.delete', async () => {
        await bag.Api.docker(`/volumes/${encodeURIComponent(created.volume)}`, { method: 'DELETE' });
        const n = created.volume;
        created.volume = null;
        return `supprimé ${n}`;
      });

      // --- Network ---
      await run('networks.create', async () => {
        const res = await bag.Api.docker('/networks/create', {
          method: 'POST',
          body: JSON.stringify({
            Name: netName,
            Driver: 'bridge',
            CheckDuplicate: true,
            Labels: { 'wharfmaster.apitest': tag },
          }),
        });
        created.networkId = res?.Id || netName;
        return `Id=${bag.shortId?.(created.networkId) || String(created.networkId).slice(0, 12)}`;
      });
      await run('networks.inspect', async () => {
        const n = await bag.Api.docker(`/networks/${encodeURIComponent(created.networkId)}`);
        if (!n?.Name && !n?.Id) throw new Error('inspect réseau vide');
        return n.Name || n.Id;
      });
      await run('networks.delete', async () => {
        await bag.Api.docker(`/networks/${encodeURIComponent(created.networkId)}`, { method: 'DELETE' });
        created.networkId = null;
        return 'supprimé';
      });

      // --- Container ---
      await run('containers.create', async () => {
        const res = await bag.Api.docker(`/containers/create?name=${encodeURIComponent(ctrName)}`, {
          method: 'POST',
          body: JSON.stringify({
            Image: imageRef,
            Cmd: ['sleep', '120'],
            Labels: { 'wharfmaster.apitest': tag },
            HostConfig: { AutoRemove: false },
          }),
        });
        created.containerId = res?.Id;
        if (!created.containerId) throw new Error('Id conteneur manquant');
        return bag.shortId(created.containerId);
      });
      await run('containers.start', async () => {
        await bag.Api.docker(`/containers/${encodeURIComponent(created.containerId)}/start`, {
          method: 'POST',
          body: '',
        });
        return 'démarré';
      });
      await run('containers.inspect', async () => {
        const info = await bag.Api.docker(`/containers/${encodeURIComponent(created.containerId)}/json`);
        const state = info?.State?.Status || '?';
        return `state=${state}`;
      });
      await run('containers.delete', async () => {
        await bag.Api.docker(
          `/containers/${encodeURIComponent(created.containerId)}?force=true`,
          { method: 'DELETE' },
        );
        created.containerId = null;
        return 'supprimé (force)';
      });
    }

    // --- Always cleanup leftovers (sequential) ---
    if (created.containerId && dockerOk) {
      await run('cleanup.container', async () => {
        await bag.Api.docker(
          `/containers/${encodeURIComponent(created.containerId)}?force=true`,
          { method: 'DELETE' },
        );
        created.containerId = null;
        return 'OK';
      });
    }
    if (created.volume && dockerOk) {
      await run('cleanup.volume', async () => {
        await bag.Api.docker(`/volumes/${encodeURIComponent(created.volume)}`, { method: 'DELETE' });
        created.volume = null;
        return 'OK';
      });
    }
    if (created.networkId && dockerOk) {
      await run('cleanup.network', async () => {
        await bag.Api.docker(`/networks/${encodeURIComponent(created.networkId)}`, { method: 'DELETE' });
        created.networkId = null;
        return 'OK';
      });
    }

    return steps;
  }

  bag.viewDiagnosticsApi = async function viewDiagnosticsApi() {
    if (Number(bag.state.user?.Role) !== 1) {
      location.hash = '#settings';
      return;
    }

    const epLabel = bag.Api.isAllEndpoints()
      ? 'tous les nœuds (Docker skip)'
      : (bag.endpointLabel?.(bag.Api.getEndpointId()) || `endpoint #${bag.Api.getEndpointId()}`);

    bag.root.innerHTML = bag.shell('Tests API', `
      ${bag.pageHeader('Tests API Docker', false)}
      ${bag.settingsSubnav('settings/diagnostics/api')}
      <div class="panel" style="max-width:860px;margin-bottom:16px">
        <div class="section-title" style="margin-top:0">Cycle création → suppression</div>
        <p class="muted" style="margin:0 0 10px">
          Vérifie le proxy Docker Engine (via endpoints Portainer) : image, volume, réseau, conteneur.
          Pas de stacks Compose ni d’utilisateurs (hors API Docker).
          Chaque ressource créée est <strong>supprimée</strong> ensuite (préfixe <code>apitest_*</code>).
        </p>
        <p class="muted" style="margin:0 0 14px">
          Nœud courant : <strong>${bag.esc(epLabel)}</strong>
        </p>
        <div class="toolbar" style="margin:0">
          <button type="button" class="btn btn-primary" id="api-smoke-run">Lancer la suite API</button>
          <span class="muted" id="api-smoke-status" style="margin-left:12px"></span>
        </div>
      </div>
      <div id="api-smoke-report">${renderSteps([])}</div>
    `, { subtitle: 'Smoke test destructif contrôlé' });

    const btn = document.getElementById('api-smoke-run');
    const status = document.getElementById('api-smoke-status');
    const report = document.getElementById('api-smoke-report');

    btn.onclick = async () => {
      if (btn.dataset.busy === '1') return;
      const ok = window.confirm(
        'Lancer les tests API ?\nDes ressources temporaires seront créées puis supprimées sur le nœud sélectionné.',
      );
      if (!ok) return;
      btn.dataset.busy = '1';
      btn.disabled = true;
      status.textContent = 'Exécution…';
      report.innerHTML = renderSteps([]);
      try {
        const steps = await runApiLifecycleSmoke((live) => {
          report.innerHTML = renderSteps(live);
          status.textContent = `Étape ${live.length}…`;
        });
        const failed = steps.filter((s) => s.level === 'fail').length;
        status.textContent = failed === 0
          ? `Terminé — ${steps.length} étapes OK`
          : `Terminé — ${failed} échec(s) / ${steps.length}`;
        report.innerHTML = renderSteps(steps);
      } catch (err) {
        status.textContent = 'Erreur';
        report.innerHTML = `<div class="error-box">${bag.esc(err.message || String(err))}</div>`;
      } finally {
        btn.disabled = false;
        delete btn.dataset.busy;
      }
    };
  };
}
