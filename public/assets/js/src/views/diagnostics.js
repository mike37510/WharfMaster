import { bag } from '../bag.js';

export function install() {
  const SPA_HANDLERS = [
    'viewDashboard',
    'viewContainers',
    'viewImages',
    'viewVolumes',
    'viewNetworks',
    'viewStacks',
    'viewSettings',
    'viewSettingsAuth',
    'viewDiagnostics',
    'viewUsers',
    'viewTeams',
    'viewNodes',
    'viewRegistries',
    'viewDocs',
    'viewActivity',
  ];

  const HASH_LINKS = [
    ['#dashboard', 'Tableau de bord'],
    ['#containers', 'Conteneurs'],
    ['#images', 'Images'],
    ['#volumes', 'Volumes'],
    ['#networks', 'Réseaux'],
    ['#stacks', 'Stacks'],
    ['#activity', 'Journaux'],
    ['#settings', 'Paramètres'],
    ['#settings/auth', 'Authentification'],
    ['#settings/diagnostics', 'Diagnostics'],
    ['#registries', 'Registres'],
    ['#nodes', 'Nœuds'],
    ['#users', 'Utilisateurs'],
    ['#teams', 'Équipes'],
    ['#docs', 'Documentation'],
  ];

  function levelBadge(level, ok) {
    const lv = level || (ok ? 'ok' : 'fail');
    if (lv === 'ok') return '<span class="badge badge-success">OK</span>';
    if (lv === 'warn') return '<span class="badge badge-warn">WARN</span>';
    return '<span class="badge badge-danger">KO</span>';
  }

  function groupChecks(checks) {
    const map = new Map();
    for (const c of checks) {
      const g = c.group || 'Autre';
      if (!map.has(g)) map.set(g, []);
      map.get(g).push(c);
    }
    return map;
  }

  function renderReport(checks, summary) {
    const groups = groupChecks(checks);
    const failed = summary?.failed ?? checks.filter((c) => !c.ok || c.level === 'fail').length;
    const warns = summary?.warnings ?? checks.filter((c) => c.level === 'warn').length;
    const total = summary?.total ?? checks.length;
    const okCount = total - failed - warns;
    let html = `
      <div class="panel" style="margin-bottom:16px">
        <div class="section-title" style="margin-top:0">Résumé</div>
        <p style="margin:0">
          <span class="badge badge-success">${okCount} OK</span>
          <span class="badge badge-warn" style="margin-left:6px">${warns} warn</span>
          <span class="badge badge-danger" style="margin-left:6px">${failed} KO</span>
          <span class="muted" style="margin-left:10px">${total} checks</span>
        </p>
      </div>`;
    for (const [group, items] of groups) {
      html += `<div class="panel" style="margin-bottom:16px">
        <div class="section-title" style="margin-top:0">${bag.esc(group)}</div>
        <table class="data-table"><thead><tr>
          <th style="width:90px">Statut</th><th>Check</th><th>Détail</th>
        </tr></thead><tbody>`;
      for (const c of items) {
        html += `<tr>
          <td>${levelBadge(c.level, c.ok)}</td>
          <td class="mono">${bag.esc(c.id)}</td>
          <td>${c.html ? c.detail : bag.esc(c.detail || '')}</td>
        </tr>`;
      }
      html += '</tbody></table></div>';
    }
    return html;
  }

  async function runClientApiSmoke() {
    const checks = [];
    const add = (id, ok, detail, level) => {
      checks.push({ id, group: 'API client', ok, level: level || (ok ? 'ok' : 'fail'), detail });
    };

    const tryCall = async (id, fn, okDetail) => {
      try {
        const data = await fn();
        add(id, true, okDetail(data));
      } catch (err) {
        add(id, false, err.message || String(err));
      }
    };

    await tryCall('api.me', () => bag.Api.me(), (d) => `Connecté : ${d.Username || d.username || '?'}`);
    await tryCall('api.settings', () => bag.Api.settings(), () => 'Paramètres lisibles');
    await tryCall('api.endpoints', () => bag.Api.endpoints(), (d) => {
      const n = Array.isArray(d) ? d.length : (d?.length ?? 0);
      return `${n} endpoint(s)`;
    });
    await tryCall('api.nodes', () => bag.Api.nodes(), (d) => {
      const n = Array.isArray(d) ? d.length : (Array.isArray(d?.Nodes) ? d.Nodes.length : '?');
      return `Nœuds : ${n}`;
    });

    if (!bag.Api.isAllEndpoints()) {
      await tryCall(
        'api.docker.containers',
        () => bag.Api.docker('/containers/json?all=true'),
        (d) => `${Array.isArray(d) ? d.length : 0} conteneur(s)`
      );
    } else {
      add('api.docker.containers', true, 'Mode « tous les nœuds » — skip docker local', 'warn');
    }

    await tryCall(
      'api.stacks',
      () => bag.Api.stacks(),
      (d) => `${Array.isArray(d) ? d.length : (d?.Stacks?.length ?? '?')} stack(s)`
    );

    return checks;
  }

  function runSpaHandlerChecks() {
    return SPA_HANDLERS.map((name) => {
      const ok = typeof bag[name] === 'function';
      return {
        id: `spa.${name}`,
        group: 'Handlers SPA',
        ok,
        level: ok ? 'ok' : 'fail',
        detail: ok ? 'fonction présente' : 'manquante',
      };
    });
  }

  function runHashLinkChecks() {
    return HASH_LINKS.map(([href, label]) => ({
      id: `link.${href.slice(1).replace(/\//g, '.')}`,
      group: 'Liens console',
      ok: true,
      level: 'ok',
      html: true,
      detail: `<a href="${bag.esc(href)}">${bag.esc(label)}</a> <span class="mono muted">${bag.esc(href)}</span>`,
    }));
  }

  bag.viewDiagnostics = async function viewDiagnostics() {
    if (Number(bag.state.user?.Role) !== 1) {
      location.hash = '#settings';
      return;
    }

    bag.root.innerHTML = bag.shell('Diagnostics', `
      ${bag.pageHeader('Diagnostics', false)}
      ${bag.settingsSubnav('settings/diagnostics')}
      <div class="panel" style="max-width:820px;margin-bottom:16px">
        <div class="section-title" style="margin-top:0">Contrôle post-migration</div>
        <p class="muted" style="margin:0 0 14px">
          Vérifie runtime, Docker, assets, API et handlers SPA (lecture seule — aucune action destructive).
        </p>
        <button type="button" class="btn btn-primary" id="diag-run">Lancer les tests</button>
        <span class="muted" id="diag-status" style="margin-left:12px"></span>
      </div>
      <div id="diag-report"><div class="info-box">Cliquez sur <strong>Lancer les tests</strong> pour générer le rapport.</div></div>
    `, { subtitle: 'Vérification de l’instance' });

    const btn = document.getElementById('diag-run');
    const status = document.getElementById('diag-status');
    const report = document.getElementById('diag-report');

    btn.onclick = async () => {
      btn.disabled = true;
      status.textContent = 'Exécution…';
      report.innerHTML = '<div class="info-box">Collecte des checks…</div>';
      const all = [];
      let summary = null;
      try {
        const server = await bag.Api.diagnostics();
        all.push(...(server.checks || []));
        summary = server.summary || null;
      } catch (err) {
        all.push({
          id: 'api.diagnostics',
          group: 'Serveur',
          ok: false,
          level: 'fail',
          detail: err.message || String(err),
        });
      }

      try {
        all.push(...(await runClientApiSmoke()));
      } catch (err) {
        all.push({
          id: 'api.smoke',
          group: 'API client',
          ok: false,
          level: 'fail',
          detail: err.message || String(err),
        });
      }

      all.push(...runSpaHandlerChecks());
      all.push(...runHashLinkChecks());

      if (!summary) {
        const failed = all.filter((c) => !c.ok || c.level === 'fail').length;
        const warnings = all.filter((c) => c.level === 'warn').length;
        summary = { total: all.length, failed, warnings };
      } else {
        const clientExtra = all.length - (summary.total || 0);
        if (clientExtra > 0) {
          const failed = all.filter((c) => !c.ok || c.level === 'fail').length;
          const warnings = all.filter((c) => c.level === 'warn').length;
          summary = { total: all.length, failed, warnings };
        }
      }

      report.innerHTML = renderReport(all, summary);
      const failed = summary.failed || 0;
      status.textContent = failed === 0
        ? `Terminé — ${summary.total} checks`
        : `Terminé — ${failed} échec(s)`;
      btn.disabled = false;
    };
  };
}
