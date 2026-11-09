import { bag } from './bag.js';
import { Api } from './api.js';

export function installCore() {
  bag.Api = Api;

  bag.root = document.getElementById('app');
  bag.THEME_KEY = 'dm_theme';
  bag.SIDEBAR_KEY = 'wm_sidebar_collapsed';

  bag.readTheme = function readTheme() {
    const saved = localStorage.getItem(bag.THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
    return 'dark';
  }

  bag.applyTheme = function applyTheme(theme) {
    const t = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem(bag.THEME_KEY, t);
    return t;
  }

  bag.readSidebarCollapsed = function readSidebarCollapsed() {
    return localStorage.getItem(bag.SIDEBAR_KEY) === '1';
  }

  bag.applySidebarCollapsed = function applySidebarCollapsed(collapsed) {
    const on = !!collapsed;
    document.documentElement.setAttribute('data-sidebar', on ? 'collapsed' : 'expanded');
    localStorage.setItem(bag.SIDEBAR_KEY, on ? '1' : '0');
    return on;
  }

  bag.applyTheme(bag.readTheme());
  bag.applySidebarCollapsed(bag.readSidebarCollapsed());

  bag.state = {
    user: null,
    route: location.hash.slice(1) || 'dashboard',
    error: '',
    filters: {
      containers: '',
      images: '',
      volumes: '',
      networks: '',
      stacks: '',
      registries: '',
      users: '',
      teams: '',
      dashboard: '',
    },
    pages: {
      containers: 1,
      images: 1,
      volumes: 1,
      networks: 1,
      stacks: 1,
    },
    sorts: {
      containers: { key: 'name', dir: 'asc' },
      images: { key: 'name', dir: 'asc' },
      volumes: { key: 'name', dir: 'asc' },
      networks: { key: 'name', dir: 'asc' },
      stacks: { key: 'name', dir: 'asc' },
    },
    pageSize: 20,
    theme: bag.readTheme(),
    sidebarCollapsed: bag.readSidebarCollapsed(),
    containerTab: 'overview',
    logTimer: null,
    statsTimer: null,
    term: null,
    publicUrl: '',
    metricsChartHours: 72,
    metricsRetentionDays: 90,
    trivyEnabled: true,
    dashFilter: 'all',
    engineVersion: '',
    appVersion: '',
    endpoints: [],
    endpointId: 1,
    alerts: [],
    dockerOnline: true,
    alertTimer: null,
    metricTimer: null,
    dismissedAlerts: new Set(JSON.parse(localStorage.getItem('dm_dismissed_alerts') || '[]')),
  };

  /** Metrics in SQLite; chart window + retention come from Paramètres. */
  bag.metricCache = { scope: '', series: [] };

  bag.toggleTheme = function toggleTheme() {
    bag.state.theme = bag.applyTheme(bag.state.theme === 'dark' ? 'light' : 'dark');
    const btn = document.getElementById('theme-toggle');
    if (btn) btn.textContent = bag.state.theme === 'dark' ? '☀' : '☾';
  }

  bag.toggleSidebar = function toggleSidebar() {
    bag.state.sidebarCollapsed = bag.applySidebarCollapsed(!bag.state.sidebarCollapsed);
    const aside = document.querySelector('.sidebar');
    if (aside) aside.classList.toggle('is-collapsed', bag.state.sidebarCollapsed);
    const btn = document.getElementById('sidebar-toggle');
    if (btn) {
      btn.title = bag.state.sidebarCollapsed ? 'Afficher le menu' : 'Réduire le menu';
      btn.setAttribute('aria-label', btn.title);
      btn.setAttribute('aria-expanded', bag.state.sidebarCollapsed ? 'false' : 'true');
      btn.innerHTML = `<span class="btn-ico">${bag.ico(bag.state.sidebarCollapsed ? 'panel-right' : 'panel-left')}</span>`;
    }
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('#theme-toggle');
    if (t) {
      e.preventDefault();
      bag.toggleTheme();
    }
    const s = e.target.closest('#sidebar-toggle');
    if (s) {
      e.preventDefault();
      bag.toggleSidebar();
    }
  });

  document.addEventListener('change', (e) => {
    const sel = e.target.closest('#endpoint-select');
    if (!sel) return;
    const id = parseInt(sel.value, 10);
    if (!Number.isFinite(id) || id < 0) return;
    bag.Api.setEndpointId(id);
    bag.state.endpointId = id;
    bag.route();
  });

  bag.isAllNodes = function isAllNodes() {
    return Number(bag.state.endpointId) === 0 || bag.Api.isAllEndpoints();
  }

  bag.activeEndpoints = function activeEndpoints() {
    return (bag.state.endpoints || []).filter((e) => {
      const id = Number(e.Id ?? e.id);
      if (!Number.isFinite(id) || id < 1) return false;
      // 0 = désactivé ; 1/2 = inclure (on tente quand même le hors-ligne)
      return Number(e.Status) !== 0;
    });
  }

  bag.refreshEndpointsList = async function refreshEndpointsList() {
    try {
      const list = await bag.Api.endpoints();
      if (Array.isArray(list) && list.length) bag.state.endpoints = list;
    } catch (_) {}
  }

  /** Round-robin sample so every node appears (not only the first fat local node). */

  bag.sampleAcrossNodes = function sampleAcrossNodes(items, limit = 24) {
    const byNode = new Map();
    (items || []).forEach((it) => {
      const key = String(it._nodeId ?? it._nodeName ?? '?');
      if (!byNode.has(key)) byNode.set(key, []);
      byNode.get(key).push(it);
    });
    const queues = [...byNode.values()];
    const out = [];
    let i = 0;
    while (out.length < limit && queues.some((q) => q.length)) {
      const q = queues[i % queues.length];
      if (q.length) out.push(q.shift());
      i += 1;
    }
    return out;
  }

  /** Fan-out Docker GET across nodes; tags each item with _nodeId / _nodeName. */

  bag.dockerAll = async function dockerAll(path, { pick, refresh = true } = {}) {
    if (refresh) await bag.refreshEndpointsList();
    const eps = bag.activeEndpoints();
    if (!eps.length) {
      return { items: [], results: [], failed: 0, okCount: 0, total: 0, perNode: [] };
    }
    const results = await Promise.all(eps.map(async (ep) => {
      const id = Number(ep.Id ?? ep.id);
      const name = ep.NodeName || ep.Name || String(id);
      try {
        const data = await bag.Api.dockerOn(id, path);
        return { ok: true, id, name, data };
      } catch (err) {
        return { ok: false, id, name, error: err, message: err?.message || String(err) };
      }
    }));
    const failed = results.filter((r) => !r.ok).length;
    const ok = results.filter((r) => r.ok);
    let items = [];
    const perNode = [];
    if (typeof pick === 'function') {
      ok.forEach((r) => {
        const arr = pick(r.data) || [];
        const list = Array.isArray(arr) ? arr : [];
        perNode.push({ id: r.id, name: r.name, count: list.length });
        list.forEach((item) => {
          items.push(Object.assign({}, item, { _nodeId: r.id, _nodeName: r.name }));
        });
      });
    } else {
      ok.forEach((r) => {
        const arr = Array.isArray(r.data) ? r.data : [];
        perNode.push({ id: r.id, name: r.name, count: arr.length });
        arr.forEach((item) => {
          items.push(Object.assign({}, item, { _nodeId: r.id, _nodeName: r.name }));
        });
      });
    }
    // Stable order: by node name then keep docker order within node
    items.sort((a, b) => String(a._nodeName || '').localeCompare(String(b._nodeName || ''), 'fr'));
    return {
      items,
      results,
      failed,
      okCount: ok.length,
      total: eps.length,
      perNode,
      failedNames: results.filter((r) => !r.ok).map((r) => r.name),
    };
  }

  bag.requireSingleNodeMsg = function requireSingleNodeMsg() {
    return 'Choisissez un nœud dans le sélecteur pour cette action.';
  }

  bag.pickNodeGuardHtml = function pickNodeGuardHtml() {
    if (!bag.isAllNodes()) return '';
    return `<div class="info-box" style="margin-bottom:12px">${bag.esc(bag.requireSingleNodeMsg())}</div>`;
  }

  bag.loadEndpoints = async function loadEndpoints() {
    try {
      const list = await bag.Api.endpoints();
      bag.state.endpoints = Array.isArray(list) ? list : [];
      const preferred = bag.Api.getEndpointId();
      if (preferred === 0 && bag.state.endpoints.length > 1) {
        bag.state.endpointId = 0;
        bag.Api.setEndpointId(0);
      } else {
        const exists = bag.state.endpoints.some((e) => Number(e.Id) === Number(preferred));
        bag.state.endpointId = exists ? preferred : (Number(bag.state.endpoints[0]?.Id) || 1);
        bag.Api.setEndpointId(bag.state.endpointId);
      }
    } catch (_) {
      bag.state.endpoints = bag.state.endpoints || [];
      bag.state.endpointId = bag.Api.getEndpointId();
    }
  }

  /** Portainer CE Type is int (6=hub, 3=custom); WharfMaster also sends RegistryKind. */

  bag.esc = function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  bag.shortId = function shortId(id) {
    return String(id || '').replace(/^sha256:/, '').slice(0, 12);
  }

  bag.openResourceUsersModal = function openResourceUsersModal({ title, subtitle, users, extraCol }) {
    bag.closeAppModal();
    const host = bag.modalHost();
    const showNode = (users || []).some((c) => c._nodeName);
    const rows = (users || []).map((c) => {
      const name = (c.Names && c.Names[0] ? c.Names[0].replace(/^\//, '') : bag.shortId(c.Id));
      const node = c._nodeName ? `<td class="muted">${bag.esc(c._nodeName)}</td>` : '';
      const extra = extraCol ? `<td class="mono cell-clip" title="${bag.esc(extraCol(c) || '')}">${bag.esc(extraCol(c) || '—')}</td>` : '';
      return `<tr>
        ${node}
        <td><a class="res-user-link" href="#containers/${bag.esc(c.Id)}">${bag.esc(name)}</a></td>
        ${extra}
        <td>${bag.badge(c.State)}</td>
        <td class="muted cell-nowrap">${bag.esc(bag.formatUptime(c.Status))}</td>
      </tr>`;
    }).join('');
    const colCount = (showNode ? 1 : 0) + 1 + (extraCol ? 1 : 0) + 2;
    host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3>${bag.esc(title)}</h3>
              <p class="modal-sub mono">${bag.esc(subtitle || '')}</p>
            </div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">✕</button>
          </div>
          <div class="table-wrap" style="margin:0">
            <table class="data">
              <thead><tr>${showNode ? '<th>Nœud</th>' : ''}<th>Nom</th>${extraCol ? '<th>Détail</th>' : ''}<th>État</th><th>Statut</th></tr></thead>
              <tbody>${rows || `<tr><td colspan="${colCount}" class="empty">Aucun conteneur</td></tr>`}</tbody>
            </table>
          </div>
          <div class="actions-bar" style="margin-top:14px">
            <button type="button" class="btn" data-close-modal>Fermer</button>
          </div>
        </div>
      </div>`;
    bag.bindAppModalChrome();
    host.querySelectorAll('a.res-user-link').forEach((a) => {
      a.addEventListener('click', () => bag.closeAppModal());
    });
  }

  bag.stopTimers = function stopTimers() {
    if (bag.state.logTimer) {
      clearInterval(bag.state.logTimer);
      bag.state.logTimer = null;
    }
    if (bag.state.statsTimer) {
      clearInterval(bag.state.statsTimer);
      bag.state.statsTimer = null;
    }
    if (bag.state.term) {
      try { bag.state.term.dispose(); } catch (_) {}
      bag.state.term = null;
    }
    bag.stopDashMetricSampler();
  }

  bag.formatUptime = function formatUptime(status) {
    const s = String(status || '');
    if (/^up\s+/i.test(s)) {
      const m = s.match(/up\s+(?:about\s+)?(.+)/i);
      if (!m) return s;
      return m[1]
        .replace(/seconds?/ig, 's').replace(/minutes?/ig, 'min').replace(/hours?/ig, 'h')
        .replace(/days?/ig, 'j').replace(/weeks?/ig, 'sem').replace(/months?/ig, 'mois')
        .replace(/an hour/ig, '1 h').replace(/a minute/ig, '1 min');
    }
    return '—';
  }

  bag.computeStats = function computeStats(st, memTotal) {
    const cpuDelta = (st.cpu_stats?.cpu_usage?.total_usage || 0) - (st.precpu_stats?.cpu_usage?.total_usage || 0);
    const sysDelta = (st.cpu_stats?.system_cpu_usage || 0) - (st.precpu_stats?.system_cpu_usage || 0);
    const online = st.cpu_stats?.online_cpus || st.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
    let cpuPct = 0;
    if (sysDelta > 0) cpuPct = (cpuDelta / sysDelta) * online * 100;
    const memStats = st.memory_stats || {};
    const cache = Number(memStats.stats?.cache || memStats.stats?.inactive_file || 0) || 0;
    const rawUsage = Number(memStats.usage || 0) || 0;
    const usage = Math.max(0, rawUsage - cache);
    const limit = Number(memStats.limit || memTotal || 1) || 1;
    const memPct = (usage / limit) * 100;
    let netRx = 0;
    let netTx = 0;
    const nets = st.networks || {};
    Object.values(nets).forEach((n) => {
      if (!n || typeof n !== 'object') return;
      netRx += Number(n.rx_bytes || 0) || 0;
      netTx += Number(n.tx_bytes || 0) || 0;
    });
    const pids = Number(st.pids_stats?.current || 0) || 0;
    return {
      cpuPct,
      memPct,
      memUsage: usage,
      memLimit: limit,
      netRx,
      netTx,
      pids,
      networks: nets,
      readAt: st.read || null,
    };
  }

  bag.formatBitRate = function formatBitRate(bytesPerSec) {
    const v = Math.max(0, Number(bytesPerSec) || 0);
    if (v < 1024) return `${v.toFixed(0)} B/s`;
    if (v < 1024 ** 2) return `${(v / 1024).toFixed(1)} KB/s`;
    if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)} MB/s`;
    return `${(v / 1024 ** 3).toFixed(2)} GB/s`;
  }

  bag.hostBase = function hostBase() {
    const configured = (bag.state.publicUrl || '').trim().replace(/\/$/, '');
    if (configured) return configured;
    const { protocol, hostname } = window.location;
    return `${protocol}//${hostname}`;
  }

  bag.portHref = function portHref(pub) {
    const base = bag.hostBase();
    try {
      const u = new URL(base.includes('://') ? base : `https://${base}`);
      // If PublicURL already includes a non-default port, keep host and swap/add published port
      u.port = String(pub);
      return u.toString().replace(/\/$/, '');
    } catch {
      return `${base.replace(/\/$/, '')}:${pub}`;
    }
  }

  bag.formatPorts = function formatPorts(ports) {
    if (!ports || !ports.length) return '<span class="muted">—</span>';
    const seen = new Set();
    const chips = [];
    for (const p of ports) {
      const pubRaw = p.PublicPort ?? p.publicPort;
      const pub = Number(pubRaw) || 0;
      const priv = p.PrivatePort || p.privatePort;
      const type = (p.Type || p.type || 'tcp').toLowerCase();
      if (!priv) continue;
      // Port hôte 0 / absent = interne uniquement (pas de lien public)
      if (pub > 0) {
        const key = `${pub}:${priv}/${type}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const href = bag.portHref(pub);
        chips.push(
          `<a class="port-link" href="${bag.esc(href)}" target="_blank" rel="noopener" title="${bag.esc(href)}">${bag.esc(pub)}:${bag.esc(priv)}/${bag.esc(type)} ↗</a>`
        );
      } else {
        const key = `int:${priv}/${type}`;
        if (seen.has(key)) continue;
        seen.add(key);
        chips.push(`<span class="port-chip" title="Port interne (non publié)">${bag.esc(priv)}/${bag.esc(type)}</span>`);
      }
    }
    return chips.length ? `<div class="ports">${chips.join('')}</div>` : '<span class="muted">—</span>';
  }

  bag.portsFromInspect = function portsFromInspect(info) {
    const ports = [];
    const bindings = info?.NetworkSettings?.Ports || {};
    for (const [key, hosts] of Object.entries(bindings)) {
      const [priv, type] = key.split('/');
      if (!hosts) {
        ports.push({ PrivatePort: Number(priv), Type: type });
        continue;
      }
      for (const h of hosts) {
        ports.push({
          PrivatePort: Number(priv),
          PublicPort: Number(h.HostPort),
          Type: type,
          IP: h.HostIp,
        });
      }
    }
    return ports;
  }

  bag.ensureSession = async function ensureSession() {
    if (!bag.Api.getToken()) return false;
    try {
      bag.state.user = await bag.Api.me();
      if (!bag.state.engineVersion) {
        bag.Api.docker('/info').then((info) => {
          if (info?.ServerVersion) bag.state.engineVersion = info.ServerVersion;
        }).catch(() => {});
      }
      return true;
    } catch {
      bag.Api.setToken('');
      bag.state.user = null;
      return false;
    }
  }

  bag.formatBytes = function formatBytes(n) {
    const v = Number(n) || 0;
    if (v < 1024) return `${v} B`;
    if (v < 1024 ** 2) return `${(v / 1024).toFixed(1)} KB`;
    if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)} MB`;
    return `${(v / 1024 ** 3).toFixed(1)} GB`;
  }

  bag.relativeTime = function relativeTime(ts) {
    const diff = Math.max(0, Date.now() - ts);
    const min = Math.floor(diff / 60000);
    if (min < 1) return "à l'instant";
    if (min < 60) return `il y a ${min} min`;
    const h = Math.floor(min / 60);
    if (h < 48) return `il y a ${h} h`;
    const d = Math.floor(h / 24);
    return `il y a ${d} j`;
  }

  bag.shellQuote = function shellQuote(s) {
    return `'${String(s).replace(/'/g, `'\\''`)}'`;
  }

  bag.endpointLabel = function endpointLabel(endpointId) {
    const ep = (bag.state.endpoints || []).find((e) => Number(e.Id) === Number(endpointId));
    if (!ep) return String(endpointId || '—');
    return ep.NodeName || ep.Name || String(ep.Id);
  }

  bag.fmtTs = function fmtTs(ts) {
    if (!ts) return '—';
    try {
      return new Date(Number(ts) * 1000).toLocaleString();
    } catch (_) {
      return String(ts);
    }
  }

  bag.route = async function route() {
    bag.stopTimers();
    bag.closeAppModal();
    bag.state.route = (location.hash.slice(1) || 'dashboard').replace(/^\/+/, '');
    if (bag.state.route === 'logout') {
      bag.Api.setToken('');
      bag.state.user = null;
      bag.state.publicUrl = '';
      if (bag.state.alertTimer) {
        clearInterval(bag.state.alertTimer);
        bag.state.alertTimer = null;
      }
      location.hash = '';
      await bag.boot();
      return;
    }
    if (!(await bag.ensureSession())) {
      await bag.renderAuth();
      return;
    }
    try {
      if (!bag.state._settingsLoaded) {
        await bag.loadPublicUrl();
        bag.state._settingsLoaded = true;
      }
      await bag.loadEndpoints();
      if (bag.state.route === 'users' && Number(bag.state.user?.Role) !== 1) {
        location.hash = '#dashboard';
        return;
      }
      if (bag.state.route === 'nodes' && Number(bag.state.user?.Role) !== 1) {
        location.hash = '#dashboard';
        return;
      }
      if (bag.state.route !== 'dashboard') {
        bag.root.innerHTML = bag.shell('Chargement', bag.pageLoadingHtml());
      }
      if (bag.state.route === 'dashboard') await bag.viewDashboard();
      else if (bag.state.route === 'containers' || bag.state.route === 'containers/new') {
        await bag.viewContainers();
        if (bag.state.route === 'containers/new' && !bag.isAllNodes()) {
          await bag.openCreateContainerModal();
        }
      }
      else if (bag.state.route.startsWith('containers/')) {
        if (bag.isAllNodes()) {
          bag.root.innerHTML = bag.shell('Conteneur', `${bag.pageHeader('Détail')} ${bag.pickNodeGuardHtml()}`);
        } else {
          const parts = bag.state.route.split('/');
          const id = parts[1];
          const tab = parts[2] || 'overview';
          await bag.viewContainerDetail(id, tab);
        }
      }
      else if (bag.state.route === 'images/build' || bag.state.route.startsWith('images/build/')) {
        if (bag.isAllNodes()) {
          bag.root.innerHTML = bag.shell('Build', `${bag.pageHeader('Dockerfile / Build')} ${bag.pickNodeGuardHtml()}`);
        } else {
          const name = bag.state.route.startsWith('images/build/')
            ? decodeURIComponent(bag.state.route.slice('images/build/'.length))
            : '';
          await bag.openBuildImageView(name);
        }
      }
      else if (bag.state.route === 'images' || bag.state.route === 'images/pull') {
        await bag.viewImages();
        if (bag.state.route === 'images/pull' && !bag.isAllNodes()) {
          await bag.openPullImageModal();
        }
      }
      else if (bag.state.route === 'volumes') await bag.viewVolumes();
      else if (bag.state.route.startsWith('volumes/')) {
        if (bag.isAllNodes()) {
          bag.root.innerHTML = bag.shell('Volume', `${bag.pageHeader('Explorer')} ${bag.pickNodeGuardHtml()}`);
        } else {
          const name = decodeURIComponent(bag.state.route.slice('volumes/'.length).split('?')[0]);
          await bag.viewVolumeBrowse(name);
        }
      }
      else if (bag.state.route === 'networks') await bag.viewNetworks();
      else if (bag.state.route === 'stacks' || bag.state.route === 'stacks/new') await bag.viewStacks();
      else if (bag.state.route.startsWith('stacks/')) {
        await bag.viewStackDetail(bag.state.route.split('/')[1]);
      }
      else if (bag.state.route === 'activity') await bag.viewActivity();
      else if (bag.state.route === 'nodes') {
        if (Number(bag.state.user?.Role) !== 1) {
          location.hash = '#dashboard';
          return;
        }
        await bag.viewNodes();
      }
      else if (bag.state.route === 'settings' || bag.state.route === 'settings/') await bag.viewSettings();
      else if (bag.state.route === 'settings/auth') await bag.viewSettingsAuth();
      else if (bag.state.route === 'settings/diagnostics') {
        if (Number(bag.state.user?.Role) !== 1) {
          location.hash = '#settings';
          return;
        }
        await bag.viewDiagnostics();
      }
      else if (bag.state.route === 'users') {
        if (Number(bag.state.user?.Role) !== 1) {
          location.hash = '#dashboard';
          return;
        }
        await bag.viewUsers();
      }
      else if (bag.state.route === 'teams') {
        if (Number(bag.state.user?.Role) !== 1) {
          location.hash = '#dashboard';
          return;
        }
        await bag.viewTeams();
      }
      else if (bag.state.route === 'registries') await bag.viewRegistries();
      else if (bag.state.route.startsWith('registries/')) await bag.viewRegistryBrowse(bag.state.route.split('/')[1]);
      else if (bag.state.route === 'docs') await bag.viewDocs();
      else if (bag.state.route === 'about') {
        location.hash = '#dashboard';
        return;
      }
      else await bag.viewDashboard();
    } catch (err) {
      bag.root.innerHTML = bag.shell('Erreur', `${bag.pageHeader('Erreur', false)}<div class="error-box">${bag.esc(err.message)}</div>`);
    }
    bag.bindAlertUi();
    bag.ensureAlertPolling();
    bag.refreshAlerts();
  }

  bag.ensureAppVersion = async function ensureAppVersion() {
    if (bag.state.appVersion) return bag.state.appVersion;
    try {
      const st = await bag.Api.status();
      const v = String(st?.Version || st?.version || '').trim();
      if (v) bag.state.appVersion = v.replace(/^v/i, '');
    } catch (_) {}
    return bag.state.appVersion || '';
  }

  bag.appVersionLabel = function appVersionLabel() {
    const v = bag.state.appVersion || '';
    return v ? `v${v}` : '';
  }

  bag.boot = async function boot() {
    await bag.ensureAppVersion();
    if (!(await bag.ensureSession())) {
      await bag.renderAuth();
      return;
    }
    bag.state._settingsLoaded = false;
    await bag.loadPublicUrl();
    bag.state._settingsLoaded = true;
    await bag.route();
  }

}
