import { bag } from '../bag.js';

export function install() {
  bag.viewDashboard = async function viewDashboard() {
    if (bag.isAllNodes()) {
      await bag.viewDashboardAll();
      return;
    }
    const filter = bag.state.dashFilter || 'all';
    bag.root.innerHTML = bag.shell('Tableau de bord', bag.pageLoadingHtml('Chargement du tableau de bord…'), {
      subtitle: 'Vue d’ensemble de votre environnement Docker',
      hidePageHeader: true,
    });
    const [containers, images, volumes, networks, stacks, info, df, host] = await Promise.all([
      bag.Api.docker('/containers/json?all=true'),
      bag.Api.docker('/images/json'),
      bag.Api.docker('/volumes'),
      bag.Api.docker('/networks'),
      bag.Api.stacks(),
      bag.Api.docker('/info').catch(() => ({})),
      bag.Api.docker('/system/df').catch(() => ({})),
      bag.Api.host().catch(() => ({})),
    ]);
    const list = containers || [];
    const imgs = images || [];
    const volList = volumes.Volumes || [];
    const running = list.filter((c) => String(c.State).toLowerCase() === 'running').length;
    const stopped = list.length - running;
    const memTotal = Number(info.MemTotal) || 0;
    if (info.ServerVersion) bag.state.engineVersion = info.ServerVersion;

    const layersSize = Number(df?.LayersSize) || 0;
    const imagesSize = (df?.Images || []).reduce((a, i) => a + (Number(i.Size) || 0), 0);
    const volumesSize = volList.reduce((a, v) => a + (Number(v.UsageData?.Size) || 0), 0);
    const dockerDisk = layersSize || imagesSize + volumesSize;
    const diskTotal = Number(host?.DiskTotal) || 0;
    const diskUsed = Number(host?.DiskUsed) || 0;
    const diskPct = diskTotal > 0
      ? Math.min(100, (diskUsed / diskTotal) * 100)
      : 0;

    const statsMap = {};
    let cpuPct = 0;
    let memPct = 0;
    let memUsage = 0;
    const sampleIds = list.filter((c) => String(c.State).toLowerCase() === 'running').slice(0, 8);
    await Promise.all(sampleIds.map(async (c) => {
      try {
        const st = await bag.Api.docker(`/containers/${c.Id}/stats?stream=false`);
        const computed = bag.computeStats(st, memTotal);
        statsMap[c.Id] = computed;
      } catch (_) {}
    }));
    const vals = Object.values(statsMap);
    if (vals.length) {
      cpuPct = vals.reduce((a, s) => a + s.cpuPct, 0);
      memUsage = vals.reduce((a, s) => a + s.memUsage, 0);
      memPct = memTotal ? (memUsage / memTotal) * 100 : vals.reduce((a, s) => a + s.memPct, 0) / vals.length;
    }

    const filtered = list.filter((c) => {
      const st = String(c.State).toLowerCase();
      if (filter === 'running') return st === 'running';
      if (filter === 'stopped') return st !== 'running';
      return true;
    }).slice(0, 12);

    const containerRows = filtered.map((c) => {
      const name = (c.Names && c.Names[0] ? c.Names[0].replace(/^\//, '') : bag.shortId(c.Id));
      const isRun = String(c.State).toLowerCase() === 'running';
      return `<tr data-search="${bag.esc(`${name} ${c.Image} ${c.State}`.toLowerCase())}">
        <td><a class="name-with-dot" href="#containers/${bag.esc(c.Id)}"><span class="sdot ${isRun ? 'on' : ''}"></span>${bag.esc(name)}</a></td>
        <td class="mono cell-clip" title="${bag.esc(c.Image)}">${bag.esc(c.Image)}</td>
        <td>${bag.badge(c.State)}</td>
        <td class="muted cell-nowrap">${bag.esc(bag.formatUptime(c.Status))}</td>
      </tr>`;
    }).join('');

    const topImages = [...imgs].sort((a, b) => (b.Created || 0) - (a.Created || 0)).slice(0, 5).map((img) => {
      const tags = img.RepoTags && img.RepoTags[0] ? img.RepoTags[0] : '<none>:<none>';
      const age = img.Created ? bag.relativeTime(img.Created * 1000) : '—';
      return `<tr>
        <td class="mono">${bag.esc(tags)}</td>
        <td>${bag.esc(bag.formatBytes(img.Size))}</td>
        <td class="muted">${bag.esc(age)}</td>
      </tr>`;
    }).join('');

    const activity = list.slice(0, 6).map((c) => {
      const name = (c.Names && c.Names[0] ? c.Names[0].replace(/^\//, '') : bag.shortId(c.Id));
      const isRun = String(c.State).toLowerCase() === 'running';
      const txt = isRun ? `Démarrage du conteneur ${name}` : `Arrêt du conteneur ${name}`;
      return `<li>
        <span class="dot ${isRun ? 'green' : 'orange'}"></span>
        <span class="txt">${bag.esc(txt)}</span>
        <span class="when">${bag.esc(bag.formatUptime(c.Status) === '—' ? 'récent' : bag.formatUptime(c.Status))}</span>
      </li>`;
    }).join('');

    const metricSeries = await bag.pushMetricSample({
      containers: list.length,
      images: imgs.length,
      volumes: volList.length,
      networks: (networks || []).length,
      cpu: cpuPct,
      mem: memPct,
      disk: diskPct,
    });

    bag.root.innerHTML = bag.shell('Tableau de bord', `
      ${bag.dashHeroHtml()}
      <div class="stat-grid dash-hero-stats">
        ${bag.dashStatCard('containers', 'blue', 'Conteneurs', list.length, metricSeries)}
        ${bag.dashStatCard('images', 'purple', 'Images', imgs.length, metricSeries)}
        ${bag.dashStatCard('volumes', 'green', 'Volumes', volList.length, metricSeries)}
        ${bag.dashStatCard('networks', 'orange', 'Réseaux', (networks || []).length, metricSeries)}
      </div>

      <div class="dash-layout">
        <div class="dash-col">
          <div class="panel-card">
            <div class="panel-head">
              <h3>Conteneurs</h3>
              <div class="filter-tabs" id="dash-filters">
                <button type="button" data-f="all" class="${filter === 'all' ? 'active' : ''}">Tous ${list.length}</button>
                <button type="button" data-f="running" class="${filter === 'running' ? 'active' : ''}">En cours ${running}</button>
                <button type="button" data-f="stopped" class="${filter === 'stopped' ? 'active' : ''}">Arrêtés ${stopped}</button>
              </div>
              <input class="search mini-search" id="filter" type="search" placeholder="Rechercher un conteneur…" value="${bag.esc(bag.state.filters.dashboard || '')}">
            </div>
            <div class="table-wrap" style="border:0;box-shadow:none;border-radius:0">
              <table class="data">
                <thead><tr><th>Nom</th><th>Image</th><th>Statut</th><th>Uptime</th></tr></thead>
                <tbody>${containerRows || `<tr><td colspan="4" class="empty">Aucun conteneur</td></tr>`}</tbody>
              </table>
            </div>
          </div>

          <div class="panel-card">
            <div class="panel-head">
              <h3>Images</h3>
              <a href="#images">Voir tout →</a>
            </div>
            <div class="table-wrap" style="border:0;box-shadow:none;border-radius:0">
              <table class="data">
                <thead><tr><th>Nom</th><th>Taille</th><th>Créée le</th></tr></thead>
                <tbody>${topImages || `<tr><td colspan="3" class="empty">Aucune image</td></tr>`}</tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="dash-col">
          <div class="panel-card">
            <div class="panel-head"><h3>Ressources hôte</h3></div>
            <div class="gauge-row">
              <div class="gauge">${bag.gaugeRing(cpuPct, '#3b82f6')}<div class="g-label">CPU</div></div>
              <div class="gauge">${bag.gaugeRing(memPct, '#22c55e')}<div class="g-label">Mémoire</div><div class="g-sub">${bag.formatBytes(memUsage)} / ${bag.formatBytes(memTotal)}</div></div>
              <div class="gauge">${bag.gaugeRing(diskPct, '#fb923c')}<div class="g-label">Disque</div><div class="g-sub">${diskTotal ? `${bag.formatBytes(diskUsed)} / ${bag.formatBytes(diskTotal)}` : '—'}${dockerDisk ? `<div class="g-hint">Docker ${bag.formatBytes(dockerDisk)}</div>` : ''}</div></div>
            </div>
            ${bag.hostResourceChart(metricSeries)}
          </div>

          <div class="panel-card">
            <div class="panel-head"><h3>Activité récente</h3></div>
            <ul class="activity-list">${activity || '<li><span class="txt muted">Aucune activité</span></li>'}</ul>
          </div>

          <div class="panel-card">
            <div class="panel-head"><h3>Actions rapides</h3></div>
            <div class="quick-grid">
              <a class="quick-tile blue" href="#containers/new"><span class="qi">${bag.ico('start')}</span>Créer un conteneur</a>
              <a class="quick-tile purple" href="#stacks/new"><span class="qi">${bag.ico('plus')}</span>Créer une stack</a>
              <a class="quick-tile green" href="#images/build"><span class="qi">${bag.ico('plus')}</span>Dockerfile / Build</a>
              ${Number(bag.state.user?.Role) === 1 ? `<button type="button" class="quick-tile orange" id="dash-prune">
                <span class="qi">${bag.ico('clean')}</span>Nettoyer les orphelins
              </button>` : `<div class="quick-tile muted-tile"><span class="qi">${bag.ico('containers')}</span>Ressources personnelles</div>`}
            </div>
          </div>
        </div>
      </div>
    `, { subtitle: 'Vue d’ensemble de votre environnement Docker', hidePageHeader: true });

    bag.bindSearch('dashboard');
    bag.startDashMetricSampler();
    bag.bindDashMetricSparklines(metricSeries);
    document.getElementById('dash-filters')?.querySelectorAll('button').forEach((btn) => {
      btn.onclick = () => {
        bag.state.dashFilter = btn.dataset.f;
        bag.route();
      };
    });
    document.getElementById('dash-prune')?.addEventListener('click', () => bag.openPruneOrphansModal());
  }

  bag.viewDashboardAll = async function viewDashboardAll() {
    const filter = bag.state.dashFilter || 'all';
    bag.root.innerHTML = bag.shell('Tableau de bord', bag.pageLoadingHtml('Agrégation de tous les nœuds…'), {
      subtitle: 'Vue agrégée — tous les nœuds',
      hidePageHeader: true,
    });

    const [cAgg, iAgg, vAgg, nAgg] = await Promise.all([
      bag.dockerAll('/containers/json?all=true'),
      bag.dockerAll('/images/json'),
      bag.dockerAll('/volumes', { pick: (d) => d?.Volumes || [] }),
      bag.dockerAll('/networks'),
    ]);

    const list = cAgg.items;
    const imgs = iAgg.items;
    const volList = vAgg.items;
    const nets = nAgg.items;
    const partial = cAgg.failed + iAgg.failed + vAgg.failed + nAgg.failed > 0;
    const running = list.filter((c) => String(c.State).toLowerCase() === 'running').length;
    const stopped = list.length - running;
    const perNodeHint = (cAgg.perNode || [])
      .map((n) => `${n.name}: ${n.count}`)
      .join(' · ');

    const filteredAll = list.filter((c) => {
      const st = String(c.State).toLowerCase();
      if (filter === 'running') return st === 'running';
      if (filter === 'stopped') return st !== 'running';
      return true;
    });
    // Important: ne pas .slice() sur la liste locale-first — échantillonner chaque nœud
    const filtered = bag.sampleAcrossNodes(filteredAll, 32);

    const containerRows = filtered.map((c) => {
      const name = (c.Names && c.Names[0] ? c.Names[0].replace(/^\//, '') : bag.shortId(c.Id));
      const isRun = String(c.State).toLowerCase() === 'running';
      return `<tr data-search="${bag.esc(`${name} ${c.Image} ${c.State} ${c._nodeName}`.toLowerCase())}">
        <td class="muted">${bag.esc(c._nodeName || '—')}</td>
        <td><a class="name-with-dot" href="#containers/${bag.esc(c.Id)}" data-switch-node="${bag.esc(c._nodeId)}"><span class="sdot ${isRun ? 'on' : ''}"></span>${bag.esc(name)}</a></td>
        <td class="mono cell-clip" title="${bag.esc(c.Image)}">${bag.esc(c.Image)}</td>
        <td>${bag.badge(c.State)}</td>
        <td class="muted cell-nowrap">${bag.esc(bag.formatUptime(c.Status))}</td>
      </tr>`;
    }).join('');

    const topImages = bag.sampleAcrossNodes(
      [...imgs].sort((a, b) => (b.Created || 0) - (a.Created || 0)),
      12,
    ).map((img) => {
      const tags = img.RepoTags && img.RepoTags[0] ? img.RepoTags[0] : '<none>:<none>';
      const age = img.Created ? bag.relativeTime(img.Created * 1000) : '—';
      return `<tr>
        <td class="muted">${bag.esc(img._nodeName || '—')}</td>
        <td class="mono">${bag.esc(tags)}</td>
        <td>${bag.esc(bag.formatBytes(img.Size))}</td>
        <td class="muted">${bag.esc(age)}</td>
      </tr>`;
    }).join('');

    const countById = Object.fromEntries((cAgg.perNode || []).map((n) => [n.id, n.count]));
    const failedSet = new Set(cAgg.failedNames || []);
    const nodeRows = (bag.state.endpoints || []).map((ep) => {
      const id = Number(ep.Id ?? ep.id);
      const st = Number(ep.Status);
      const cCount = countById[id];
      let label = st === 1 ? 'En ligne' : (st === 0 ? 'Désactivé' : 'Hors ligne');
      let cls = st === 1 ? 'badge-success' : (st === 0 ? 'badge-muted' : 'badge-warn');
      if (failedSet.has(ep.NodeName || ep.Name)) {
        label = 'Erreur agrégat';
        cls = 'badge-warn';
      } else if (cCount != null) {
        label = `En ligne · ${cCount}`;
        cls = 'badge-success';
      }
      const url = ep.AgentURL || ep.URL || '—';
      return `<tr>
        <td title="${bag.esc(ep.NodeName || ep.Name)}"><strong>${bag.esc(ep.NodeName || ep.Name)}</strong></td>
        <td>${bag.esc(ep.Kind === 'agent' ? 'Agent' : 'Local')}</td>
        <td><span class="badge ${cls}" title="${bag.esc(label)}">${bag.esc(label)}</span></td>
        <td class="mono cell-clip" title="${bag.esc(url)}">${bag.esc(url)}</td>
      </tr>`;
    }).join('');

    const failMsg = (cAgg.failedNames || []).length
      ? ` Nœuds sans réponse : ${(cAgg.failedNames || []).map(bag.esc).join(', ')}.`
      : '';

    const metricSeriesAll = await bag.pushMetricSample({
      containers: list.length,
      images: imgs.length,
      volumes: volList.length,
      networks: nets.length,
    });

    bag.root.innerHTML = bag.shell('Tableau de bord', `
      ${bag.dashHeroHtml({
        subtitle: 'Vue agrégée de tous vos nœuds Docker — une interface moderne.',
      })}
      ${partial ? `<div class="info-box" style="margin-bottom:12px">Agrégat partiel.${failMsg}</div>` : ''}
      ${perNodeHint ? `<div class="muted" style="margin-bottom:10px">Répartition conteneurs — ${bag.esc(perNodeHint)}</div>` : ''}
      <div class="stat-grid dash-hero-stats">
        ${bag.dashStatCard('containers', 'blue', 'Conteneurs', list.length, metricSeriesAll)}
        ${bag.dashStatCard('images', 'purple', 'Images', imgs.length, metricSeriesAll)}
        ${bag.dashStatCard('volumes', 'green', 'Volumes', volList.length, metricSeriesAll)}
        ${bag.dashStatCard('networks', 'orange', 'Réseaux', nets.length, metricSeriesAll)}
      </div>

      <div class="dash-layout">
        <div class="dash-col">
          <div class="panel-card">
            <div class="panel-head">
              <h3>Conteneurs</h3>
              <a href="#containers">Voir tout →</a>
              <div class="filter-tabs" id="dash-filters">
                <button type="button" data-f="all" class="${filter === 'all' ? 'active' : ''}">Tous ${list.length}</button>
                <button type="button" data-f="running" class="${filter === 'running' ? 'active' : ''}">En cours ${running}</button>
                <button type="button" data-f="stopped" class="${filter === 'stopped' ? 'active' : ''}">Arrêtés ${stopped}</button>
              </div>
              <input class="search mini-search" id="filter" type="search" placeholder="Rechercher…" value="${bag.esc(bag.state.filters.dashboard || '')}">
            </div>
            <div class="table-wrap" style="border:0;box-shadow:none;border-radius:0">
              <table class="data">
                <thead><tr><th>Nœud</th><th>Nom</th><th>Image</th><th>Statut</th><th>Uptime</th></tr></thead>
                <tbody>${containerRows || `<tr><td colspan="5" class="empty">Aucun conteneur</td></tr>`}</tbody>
              </table>
            </div>
          </div>
          <div class="panel-card">
            <div class="panel-head"><h3>Images</h3><a href="#images">Voir tout →</a></div>
            <div class="table-wrap" style="border:0;box-shadow:none;border-radius:0">
              <table class="data">
                <thead><tr><th>Nœud</th><th>Nom</th><th>Taille</th><th>Créée</th></tr></thead>
                <tbody>${topImages || `<tr><td colspan="4" class="empty">Aucune image</td></tr>`}</tbody>
              </table>
            </div>
          </div>
        </div>
        <div class="dash-col">
          <div class="panel-card">
            <div class="panel-head"><h3>Nœuds</h3></div>
            <div class="table-wrap" style="border:0;box-shadow:none;border-radius:0">
              <table class="data">
                <thead><tr><th>Nom</th><th>Type</th><th>Statut</th><th>URL</th></tr></thead>
                <tbody>${nodeRows || `<tr><td colspan="4" class="empty">Aucun nœud</td></tr>`}</tbody>
              </table>
            </div>
          </div>
          <div class="panel-card">
            <div class="panel-head"><h3>Actions</h3></div>
            <div class="info-box">${bag.esc(bag.requireSingleNodeMsg())}</div>
          </div>
        </div>
      </div>
    `, { subtitle: 'Vue agrégée — tous les nœuds', hidePageHeader: true });

    bag.bindSearch('dashboard');
    bag.startDashMetricSampler();
    bag.bindDashMetricSparklines(metricSeriesAll);
    document.getElementById('dash-filters')?.querySelectorAll('button').forEach((btn) => {
      btn.onclick = () => {
        bag.state.dashFilter = btn.dataset.f;
        bag.route();
      };
    });
    bag.root.querySelectorAll('[data-switch-node]').forEach((a) => {
      a.addEventListener('click', () => {
        const id = parseInt(a.getAttribute('data-switch-node'), 10);
        if (Number.isFinite(id) && id > 0) {
          bag.Api.setEndpointId(id);
          bag.state.endpointId = id;
        }
      });
    });
  }

  bag.openPruneOrphansModal = async function openPruneOrphansModal() {
    bag.closeAppModal();
    const host = bag.modalHost();
    host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-form" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3>Nettoyer les orphelins</h3>
              <div class="modal-sub">Supprime les ressources Docker inutilisées</div>
            </div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">✕</button>
          </div>
          <div id="prune-err"></div>
          <div class="info-box">
            Conteneurs arrêtés, images dangling, réseaux inutilisés et cache de build.
            Les volumes ne sont pas touchés.
          </div>
          <label class="check-row"><input type="checkbox" id="prune-images-all"> Inclure toutes les images non utilisées (pas seulement dangling)</label>
          <div id="prune-result" hidden></div>
          <div class="actions-bar">
            <button type="button" class="btn btn-primary" id="prune-run">Nettoyer</button>
            <button type="button" class="btn" data-close-modal>Fermer</button>
          </div>
        </div>
      </div>`;
    bag.bindAppModalChrome();

    bag.onBusyClick(document.getElementById('prune-run'), async () => {
      const errBox = document.getElementById('prune-err');
      const resultBox = document.getElementById('prune-result');
      if (errBox) errBox.innerHTML = '';
      if (resultBox) {
        resultBox.hidden = true;
        resultBox.innerHTML = '';
      }
      const allImages = document.getElementById('prune-images-all')?.checked;
      try {
        const [containers, images, networks, build] = await Promise.all([
          bag.Api.docker('/containers/prune', { method: 'POST', body: '{}' }),
          bag.Api.docker(`/images/prune${allImages ? '?filters=' + encodeURIComponent(JSON.stringify({ dangling: ['false'] })) : ''}`, {
            method: 'POST',
            body: '{}',
          }),
          bag.Api.docker('/networks/prune', { method: 'POST', body: '{}' }),
          bag.Api.docker('/build/prune', { method: 'POST', body: JSON.stringify({ all: true }) }).catch(() => ({ SpaceReclaimed: 0 })),
        ]);
        const cCount = (containers?.ContainersDeleted || []).length;
        const iCount = (images?.ImagesDeleted || []).filter(Boolean).length;
        const nCount = (networks?.NetworksDeleted || []).length;
        const space =
          (Number(containers?.SpaceReclaimed) || 0)
          + (Number(images?.SpaceReclaimed) || 0)
          + (Number(build?.SpaceReclaimed) || 0);
        if (resultBox) {
          resultBox.hidden = false;
          resultBox.innerHTML = `<div class="info-box">
            <strong>Nettoyage terminé</strong><br>
            Conteneurs : ${cCount}<br>
            Images : ${iCount}<br>
            Réseaux : ${nCount}<br>
            Espace récupéré : ${bag.esc(bag.formatBytes(space))}
          </div>`;
        }
      } catch (err) {
        if (errBox) errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
      }
    }, { disableSiblings: false, minMs: 300 });
  }

}
