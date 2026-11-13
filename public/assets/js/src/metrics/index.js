import { bag } from '../bag.js';

export function install() {
  bag.metricChartHours = function metricChartHours() {
    const h = Number(bag.state.metricsChartHours);
    return Number.isFinite(h) && h >= 1 ? Math.min(168, Math.floor(h)) : 72;
  }

  bag.metricRetentionDays = function metricRetentionDays() {
    const d = Number(bag.state.metricsRetentionDays);
    return Number.isFinite(d) && d >= 7 ? Math.min(365, Math.floor(d)) : 90;
  }

  bag.metricWindowLabel = function metricWindowLabel() {
    const h = bag.metricChartHours();
    if (h === 24) return '24 h glissantes';
    if (h % 24 === 0) {
      const days = h / 24;
      return `${days} j glissant${days > 1 ? 's' : ''}`;
    }
    return `${h} h glissantes`;
  }

  bag.metricScopeKey = function metricScopeKey() {
    return bag.Api.isAllEndpoints() ? 'all' : `ep:${bag.Api.getEndpointId()}`;
  }

  bag.getMetricSeries = function getMetricSeries() {
    return bag.metricCache.scope === bag.metricScopeKey() ? bag.metricCache.series : [];
  }

  bag.loadMetricHistory = async function loadMetricHistory(scope = metricScopeKey()) {
    try {
      const hours = bag.metricChartHours();
      const points = Math.min(288, Math.max(48, Math.ceil((hours * 60) / 5)));
      const data = await bag.Api.metricsHistory(scope, { hours, points });
      if (data?.ChartHours != null) bag.state.metricsChartHours = Number(data.ChartHours) || bag.state.metricsChartHours;
      if (data?.RetentionDays != null) bag.state.metricsRetentionDays = Number(data.RetentionDays) || bag.state.metricsRetentionDays;
      const series = Array.isArray(data?.Series) ? data.Series : [];
      bag.metricCache.scope = scope;
      bag.metricCache.series = series;
      return series;
    } catch (_) {
      if (bag.metricCache.scope !== scope) {
        bag.metricCache.scope = scope;
        bag.metricCache.series = [];
      }
      return bag.metricCache.series;
    }
  }

  /** Persist a sample server-side (SQLite, 90 j) and refresh local cache. */

  bag.pushMetricSample = async function pushMetricSample(counts) {
    const scope = bag.metricScopeKey();
    const clampPct = (v) => Math.max(0, Math.min(100, Number(v) || 0));
    const payload = {
      Scope: scope,
      containers: Number(counts.containers) || 0,
      images: Number(counts.images) || 0,
      volumes: Number(counts.volumes) || 0,
      networks: Number(counts.networks) || 0,
    };
    if (counts.cpu != null) payload.cpu = clampPct(counts.cpu);
    if (counts.mem != null) payload.mem = clampPct(counts.mem);
    if (counts.disk != null) payload.disk = clampPct(counts.disk);
    try {
      await bag.Api.metricsSample(payload);
    } catch (_) { /* ignore offline */ }
    return bag.loadMetricHistory(scope);
  }

  /** Multi-series resource chart. Default scale 0–100 %; pass maxY for absolute counts. */

  bag.resourceChart = function resourceChart(series, opts = {}) {
    const w = 320;
    const h = 88;
    const padY = 4;
    const keys = opts.keys || [
      { key: 'cpu', color: '#3b82f6', label: 'CPU' },
      { key: 'mem', color: '#22c55e', label: 'Mémoire' },
      { key: 'disk', color: '#fb923c', label: 'Disque' },
    ];
    let maxY = Number(opts.maxY);
    if (!Number.isFinite(maxY) || maxY <= 0) {
      maxY = 100;
      keys.forEach(({ key }) => {
        const vals = bag.metricValues(series, key);
        vals.forEach((v) => { if (v > maxY && opts.autoScale) maxY = v; });
      });
      if (!opts.autoScale) maxY = 100;
    }
    maxY = Math.max(1, maxY);
    const yAt = (v) => padY + (1 - Math.max(0, Math.min(maxY, Number(v) || 0)) / maxY) * (h - padY * 2);
    const wrapId = opts.wrapId || 'host-wave-wrap';
    const n = Math.max(1, (series || []).length);
    const paths = keys.map(({ key, color }) => {
      const vals = bag.metricValues(series, key);
      if (!vals.length) {
        return `<path d="M0 ${yAt(0).toFixed(2)} L${w} ${yAt(0).toFixed(2)}" fill="none" stroke="${color}" stroke-width="2" stroke-opacity="0.35"/>`;
      }
      const coords = vals.map((v, i) => {
        const x = vals.length === 1 ? w / 2 : (i / (vals.length - 1)) * w;
        return [x, yAt(v)];
      });
      if (coords.length === 1) {
        const y = coords[0][1];
        return `<path d="M0 ${y.toFixed(2)} L${w} ${y.toFixed(2)}" fill="none" stroke="${color}" stroke-width="2.4"/>`;
      }
      const d = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c[0].toFixed(2)} ${c[1].toFixed(2)}`).join(' ');
      return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`;
    }).join('');
    const labels = keys.map((k) => k.label).join(' / ');
    const isPct = !opts.maxY && !opts.autoScale;
    const title = n < 2
      ? 'Historique en construction'
      : `Évolution ${labels} — ${n} relevés`;
    const legend = keys.map(({ color, label }) =>
      `<span class="wave-leg"><i style="background:${color}"></i>${bag.esc(label)}</span>`
    ).join('');
    const topLbl = isPct ? '100%' : String(Math.round(maxY));
    const midLbl = isPct ? '50%' : String(Math.round(maxY / 2));
    const botLbl = isPct ? '0%' : '0';
    const yTop = yAt(maxY).toFixed(1);
    const yMid = yAt(maxY / 2).toFixed(1);
    const yBot = yAt(0).toFixed(1);
    return `<div class="wave-wrap" id="${bag.esc(wrapId)}">
      <div class="wave-head"><span class="stat-hint" title="Fenêtre configurable dans Paramètres">Courbes · ${bag.esc(bag.metricWindowLabel())} · rétention ${bag.esc(String(bag.metricRetentionDays()))} j</span></div>
      <div class="wave-plot">
        <div class="wave-y" aria-hidden="true">
          <span>${bag.esc(topLbl)}</span>
          <span>${bag.esc(midLbl)}</span>
          <span>${bag.esc(botLbl)}</span>
        </div>
        <svg class="wave-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${bag.esc(title)}">
          <title>${bag.esc(title)}</title>
          <line x1="0" y1="${yTop}" x2="${w}" y2="${yTop}" class="wave-grid"/>
          <line x1="0" y1="${yMid}" x2="${w}" y2="${yMid}" class="wave-grid"/>
          <line x1="0" y1="${yBot}" x2="${w}" y2="${yBot}" class="wave-grid"/>
          ${paths}
        </svg>
      </div>
      <div class="wave-legend">${legend}</div>
    </div>`;
  }

  bag.hostResourceChart = function hostResourceChart(series) {
    return bag.resourceChart(series, {
      wrapId: 'host-wave-wrap',
      keys: [
        { key: 'cpu', color: '#3b82f6', label: 'CPU' },
        { key: 'mem', color: '#22c55e', label: 'Mémoire' },
        { key: 'disk', color: '#fb923c', label: 'Disque' },
      ],
    });
  }

  bag.resetHostChartNav = function resetHostChartNav() {
    const hours = bag.metricChartHours();
    const until = Math.floor(Date.now() / 1000);
    bag._hostChartNav = {
      hours,
      until,
      from: until - hours * 3600,
      loading: false,
    };
  }

  bag.isHostChartLive = function isHostChartLive() {
    const nav = bag._hostChartNav;
    if (!nav) return true;
    return Number(nav.until) >= Math.floor(Date.now() / 1000) - 90;
  }

  bag.hostChartBlockHtml = function hostChartBlockHtml(series) {
    if (!bag._hostChartNav) bag.resetHostChartNav();
    const nav = bag._hostChartNav;
    const from = Number(nav.from) || (nav.until - nav.hours * 3600);
    return `<div id="host-chart-block" class="host-chart-block">
      ${bag.metricHistoryNavHtml({
        hours: nav.hours,
        until: nav.until,
        fromSec: from,
        untilSec: nav.until,
        retentionDays: bag.metricRetentionDays(),
      })}
      ${bag.hostResourceChart(series || [])}
    </div>`;
  }

  bag.loadHostMetricHistory = async function loadHostMetricHistory(opts = {}) {
    if (!bag._hostChartNav) bag.resetHostChartNav();
    const retentionDays = bag.metricRetentionDays();
    const hours = opts.hours != null
      ? Math.max(1, Math.min(retentionDays * 24, Number(opts.hours) || bag.metricChartHours()))
      : bag._hostChartNav.hours;
    let until = opts.until != null
      ? Math.floor(Number(opts.until))
      : bag._hostChartNav.until;
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(until) || until <= 0 || until > now) until = now;
    const points = Math.min(720, Math.max(48, Math.ceil((hours * 60) / 5)));
    try {
      const data = await bag.Api.metricsHistory(bag.metricScopeKey(), { hours, until, points });
      if (data?.ChartHours != null) bag.state.metricsChartHours = Number(data.ChartHours) || bag.state.metricsChartHours;
      if (data?.RetentionDays != null) bag.state.metricsRetentionDays = Number(data.RetentionDays) || bag.state.metricsRetentionDays;
      const untilOut = Number(data?.Until) || until;
      const fromOut = Number(data?.From) || (untilOut - hours * 3600);
      return {
        series: Array.isArray(data?.Series) ? data.Series : [],
        from: fromOut,
        until: untilOut,
        hours,
      };
    } catch (_) {
      return { series: [], from: until - hours * 3600, until, hours };
    }
  }

  bag.bindHostResourceChartNav = function bindHostResourceChartNav() {
    const root = document.getElementById('host-chart-block');
    if (!root) return;
    if (!bag._hostChartNav) bag.resetHostChartNav();
    const retentionDays = bag.metricRetentionDays();
    root.querySelector('[data-metric-prev]')?.addEventListener('click', () => {
      const nav = bag._hostChartNav;
      nav.until = Math.max(
        Math.floor(Date.now() / 1000) - retentionDays * 86400 + nav.hours,
        nav.until - nav.hours,
      );
      void bag.refreshHostResourceChart();
    });
    root.querySelector('[data-metric-next]')?.addEventListener('click', () => {
      const nav = bag._hostChartNav;
      nav.until = Math.min(Math.floor(Date.now() / 1000), nav.until + nav.hours);
      void bag.refreshHostResourceChart();
    });
    root.querySelector('[data-metric-live]')?.addEventListener('click', () => {
      bag._hostChartNav.until = Math.floor(Date.now() / 1000);
      void bag.refreshHostResourceChart();
    });
    root.querySelectorAll('[data-metric-hours]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const h = parseInt(btn.getAttribute('data-metric-hours') || '', 10);
        if (!Number.isFinite(h) || h < 1) return;
        bag._hostChartNav.hours = h;
        void bag.refreshHostResourceChart();
      });
    });
  }

  bag.paintHostResourceChart = function paintHostResourceChart(series) {
    const block = document.getElementById('host-chart-block');
    if (!block) return;
    block.outerHTML = bag.hostChartBlockHtml(series);
    bag.bindHostResourceChartNav();
  }

  bag.refreshHostResourceChart = async function refreshHostResourceChart() {
    if (!bag._hostChartNav) bag.resetHostChartNav();
    if (bag._hostChartNav.loading) return;
    bag._hostChartNav.loading = true;
    try {
      const data = await bag.loadHostMetricHistory();
      bag._hostChartNav.hours = data.hours;
      bag._hostChartNav.until = data.until;
      bag._hostChartNav.from = data.from;
      bag.paintHostResourceChart(data.series);
    } finally {
      bag._hostChartNav.loading = false;
    }
  }

  bag.containerResourceChart = function containerResourceChart(series) {
    return bag.resourceChart(series, {
      wrapId: 'ctr-wave-wrap',
      keys: [
        { key: 'cpu', color: '#3b82f6', label: 'CPU' },
        { key: 'mem', color: '#22c55e', label: 'Mémoire' },
        { key: 'disk', color: '#a78bfa', label: 'Réseau' },
      ],
    });
  }

  bag.containerMetricScope = function containerMetricScope(containerId) {
    const ep = bag.Api.isAllEndpoints() ? 0 : bag.Api.getEndpointId();
    const id = String(containerId || '').replace(/^sha256:/, '');
    return `ctr:${ep}:${id.slice(0, 64)}`;
  }

  /** Map network throughput → 0–100 score (aligned with CPU/RAM thresholds). */

  bag.netLoadScore = function netLoadScore(rxRate, txRate) {
    const bps = Math.max(0, Number(rxRate) || 0) + Math.max(0, Number(txRate) || 0);
    const mbps = bps / (1024 * 1024);
    if (mbps <= 0) return 0;
    if (mbps < 1) return Math.min(40, mbps * 40);
    if (mbps < 5) return 40 + ((mbps - 1) / 4) * 25;
    if (mbps < 20) return 65 + ((mbps - 5) / 15) * 20;
    return Math.min(100, 85 + ((mbps - 20) / 40) * 15);
  }

  /** ok | warn | hot from CPU / RAM / réseau scores. */

  bag.resourceLoadLevel = function resourceLoadLevel(cpuPct, memPct, netPct) {
    const cpu = Number(cpuPct) || 0;
    const mem = Number(memPct) || 0;
    const net = Number(netPct) || 0;
    const max = Math.max(cpu, mem, net);
    if (max >= 85) return 'hot';
    if (max >= 65) return 'warn';
    return 'ok';
  }

  bag.applyStatsIconLevel = function applyStatsIconLevel(containerId, level, title) {
    const btn = bag.root.querySelector(`[data-stats-id="${CSS.escape(String(containerId))}"]`);
    if (!btn) return;
    btn.classList.remove('is-stats-ok', 'is-stats-warn', 'is-stats-hot', 'is-stats-off');
    const cls = level === 'hot' ? 'is-stats-hot'
      : level === 'warn' ? 'is-stats-warn'
        : level === 'off' ? 'is-stats-off'
          : 'is-stats-ok';
    btn.classList.add(cls);
    if (title) {
      btn.title = title;
      btn.setAttribute('aria-label', title);
    }
  }

  bag.pushContainerMetricSample = async function pushContainerMetricSample(containerId, cpu, mem, net) {
    const clamp = (v) => Math.max(0, Math.min(100, Number(v) || 0));
    try {
      await bag.Api.metricsSample({
        Scope: bag.containerMetricScope(containerId),
        cpu: clamp(cpu),
        mem: clamp(mem),
        disk: clamp(net),
        containers: 1,
      });
    } catch (_) { /* ignore */ }
  }

  bag.loadContainerMetricHistory = async function loadContainerMetricHistory(containerId, opts = {}) {
    const retentionDays = bag.metricRetentionDays();
    const hours = opts.hours != null
      ? Math.max(1, Math.min(retentionDays * 24, Number(opts.hours) || bag.metricChartHours()))
      : bag.metricChartHours();
    const points = opts.points != null
      ? Number(opts.points)
      : Math.min(720, Math.max(48, Math.ceil((hours * 60) / 5)));
    try {
      const params = { hours, points };
      if (opts.until != null && Number(opts.until) > 0) params.until = Math.floor(Number(opts.until));
      const data = await bag.Api.metricsHistory(bag.containerMetricScope(containerId), params);
      if (data?.ChartHours != null) bag.state.metricsChartHours = Number(data.ChartHours) || bag.state.metricsChartHours;
      if (data?.RetentionDays != null) bag.state.metricsRetentionDays = Number(data.RetentionDays) || bag.state.metricsRetentionDays;
      const untilOut = Number(data?.Until) || params.until || Math.floor(Date.now() / 1000);
      const fromOut = Number(data?.From) || (untilOut - hours * 3600);
      return {
        series: Array.isArray(data?.Series) ? data.Series : [],
        from: fromOut,
        until: untilOut,
        hours,
      };
    } catch (_) {
      const untilOut = opts.until != null ? Math.floor(Number(opts.until)) : Math.floor(Date.now() / 1000);
      return { series: [], from: untilOut - hours * 3600, until: untilOut, hours };
    }
  }

  bag.metricWindowChoices = function metricWindowChoices() {
    const retentionDays = bag.metricRetentionDays();
    const defaultHours = bag.metricChartHours();
    return Array.from(new Set([
      defaultHours,
      24,
      48,
      72,
      168,
      Math.min(retentionDays * 24, 720),
    ].filter((h) => h >= 1 && h <= retentionDays * 24))).sort((a, b) => a - b);
  }

  bag.metricHoursLabel = function metricHoursLabel(h) {
    const hours = Number(h) || 0;
    if (hours === 24) return '24 h';
    if (hours % 24 === 0) {
      const d = hours / 24;
      return `${d} j`;
    }
    return `${hours} h`;
  }

  /** Nav rétention (Préc. / Maintenant / Suiv. + chips) — dashboard détail & modal conteneur. */
  bag.metricHistoryNavHtml = function metricHistoryNavHtml({ hours, until, fromSec, untilSec, retentionDays } = {}) {
    const h = Number(hours) || bag.metricChartHours();
    const ret = Number(retentionDays) || bag.metricRetentionDays();
    const now = Math.floor(Date.now() / 1000);
    const end = Number(until) || now;
    const floor = now - ret * 86400;
    const canPrev = end - h > floor + 60;
    const canNext = end < now - 90;
    const chips = bag.metricWindowChoices().map((choice) =>
      `<button type="button" class="btn btn-sm metric-win-chip${choice === h ? ' is-active' : ''}" data-metric-hours="${choice}">${bag.esc(bag.metricHoursLabel(choice))}</button>`
    ).join('');
    const from = Number(fromSec) || (end - h * 3600);
    const to = Number(untilSec) || end;
    return `<div class="metric-detail-nav cstats-metric-nav">
      <div class="metric-detail-nav-row">
        <button type="button" class="btn btn-sm" data-metric-prev ${canPrev ? '' : 'disabled'} title="Fenêtre précédente">← Préc.</button>
        <button type="button" class="btn btn-sm" data-metric-live ${canNext ? '' : 'disabled'} title="Revenir à maintenant">Maintenant</button>
        <button type="button" class="btn btn-sm" data-metric-next ${canNext ? '' : 'disabled'} title="Fenêtre suivante">Suiv. →</button>
      </div>
      <div class="metric-detail-nav-row metric-win-chips">${chips}</div>
      <p class="muted metric-detail-range">${bag.esc(bag.formatMetricRange(from, to))} · rétention ${ret} j</p>
    </div>`;
  }

  bag.stopContainerStatsPoll = function stopContainerStatsPoll() {
    if (bag.state.containerStatsTimer) {
      clearInterval(bag.state.containerStatsTimer);
      bag.state.containerStatsTimer = null;
    }
  }

  bag.startContainerStatsPoll = function startContainerStatsPoll(containers) {
    bag.stopContainerStatsPoll();
    const list = containers || [];
    const tick = () => {
      if (bag.state.route !== 'containers' && bag.state.route !== 'container') {
        bag.stopContainerStatsPoll();
        return;
      }
      void bag.refreshContainerStatsIcons(list);
    };
    tick();
    // Light poll: colour-only icon, visible page only (~pageSize), every 10s
    bag.state.containerStatsTimer = setInterval(tick, 10_000);
  }

  bag.visibleContainerIds = function visibleContainerIds() {
    const ids = new Set();
    bag.root.querySelectorAll('tbody tr[data-container-id]').forEach((tr) => {
      if (tr.style.display === 'none') return;
      const id = tr.getAttribute('data-container-id');
      if (id) ids.add(id);
    });
    // Detail page / toolbar chip without a list row
    if (ids.size === 0) {
      bag.root.querySelectorAll('[data-stats-id]').forEach((el) => {
        const id = el.getAttribute('data-stats-id');
        if (id) ids.add(id);
      });
    }
    return ids;
  }

  bag.refreshContainerStatsIcons = async function refreshContainerStatsIcons(containers) {
    if (bag.state.route !== 'containers' && bag.state.route !== 'container') return;
    // Only poll what the user sees (≤ pageSize, typically 20) — not an arbitrary 24.
    const visible = bag.visibleContainerIds();
    const onPage = (containers || []).filter((c) => visible.size === 0 || visible.has(c.Id));
    const running = onPage.filter((c) => {
      const st = String(c.State || '').toLowerCase();
      return st === 'running' || st === 'restarting';
    });
    onPage.forEach((c) => {
      const st = String(c.State || '').toLowerCase();
      if (st !== 'running' && st !== 'restarting') {
        bag.applyStatsIconLevel(c.Id, 'off', 'Conteneur arrêté — pas de charge');
      }
    });
    if (!bag.state.containerStatsPrev) bag.state.containerStatsPrev = {};
    const queue = [...running];
    const workers = 3;
    const runOne = async () => {
      while (queue.length) {
        if (bag.state.route !== 'containers' && bag.state.route !== 'container') return;
        const c = queue.shift();
        if (!c) return;
        try {
          const st = await bag.Api.docker(`/containers/${c.Id}/stats?stream=false`);
          const computed = bag.computeStats(st, 0);
          const now = Date.now();
          const prev = bag.state.containerStatsPrev[c.Id];
          let rate = { rx: 0, tx: 0 };
          if (prev && prev.at > 0) {
            const dt = Math.max(0.5, (now - prev.at) / 1000);
            rate = {
              rx: Math.max(0, (computed.netRx - prev.netRx) / dt),
              tx: Math.max(0, (computed.netTx - prev.netTx) / dt),
            };
          }
          bag.state.containerStatsPrev[c.Id] = {
            netRx: computed.netRx,
            netTx: computed.netTx,
            at: now,
          };
          const net = bag.netLoadScore(rate.rx, rate.tx);
          const level = bag.resourceLoadLevel(computed.cpuPct, computed.memPct, net);
          const title = `CPU ${computed.cpuPct.toFixed(0)}% · RAM ${computed.memPct.toFixed(0)}% · Réseau ${bag.formatBitRate(rate.rx + rate.tx)}`;
          bag.applyStatsIconLevel(c.Id, level, title);
          void bag.pushContainerMetricSample(c.Id, computed.cpuPct, computed.memPct, net);
        } catch (_) {
          bag.applyStatsIconLevel(c.Id, 'off', 'Stats indisponibles');
        }
      }
    };
    await Promise.all(Array.from({ length: workers }, () => runOne()));
  }

  bag.metricValues = function metricValues(series, key) {
    return (series || []).map((p) => Number(p?.[key]) || 0);
  }

  bag.metricDeltaHtml = function metricDeltaHtml(series, key) {
    const vals = bag.metricValues(series, key);
    if (vals.length < 2) {
      return '<span class="stat-delta is-flat" title="Pas encore d’historique">·</span>';
    }
    const d = vals[vals.length - 1] - vals[vals.length - 2];
    if (d === 0) return '<span class="stat-delta is-flat" title="Stable">=</span>';
    if (d > 0) return `<span class="stat-delta is-up" title="Depuis le dernier relevé">+${d}</span>`;
    return `<span class="stat-delta is-down" title="Depuis le dernier relevé">${d}</span>`;
  }

  bag.stopDashMetricSampler = function stopDashMetricSampler() {
    if (bag.state.metricTimer) {
      clearInterval(bag.state.metricTimer);
      bag.state.metricTimer = null;
    }
  }

  bag.startDashMetricSampler = function startDashMetricSampler() {
    bag.stopDashMetricSampler();
    bag.state.metricTimer = setInterval(() => {
      if (bag.state.route !== 'dashboard') {
        bag.stopDashMetricSampler();
        return;
      }
      void bag.refreshDashMetricSample();
    }, 60_000);
  }

  bag.sampleHostResourcePercents = async function sampleHostResourcePercents(containers, memTotalHint) {
    const list = containers || [];
    const running = list.filter((c) => String(c.State).toLowerCase() === 'running').slice(0, 8);
    let cpuPct = 0;
    let memPct = 0;
    let memUsage = 0;
    let memTotal = Number(memTotalHint) || 0;
    const stats = await Promise.all(running.map(async (c) => {
      try {
        return await bag.Api.docker(`/containers/${c.Id}/stats?stream=false`);
      } catch {
        return null;
      }
    }));
    const computed = stats.filter(Boolean).map((st) => bag.computeStats(st, memTotal));
    if (computed.length) {
      cpuPct = computed.reduce((a, s) => a + s.cpuPct, 0);
      memUsage = computed.reduce((a, s) => a + s.memUsage, 0);
      if (!memTotal) {
        memTotal = computed.reduce((a, s) => Math.max(a, s.memLimit || 0), 0);
      }
      memPct = memTotal ? (memUsage / memTotal) * 100 : computed.reduce((a, s) => a + s.memPct, 0) / computed.length;
    }
    let diskPct = 0;
    try {
      const host = await bag.Api.host();
      const diskTotal = Number(host?.DiskTotal) || 0;
      const diskUsed = Number(host?.DiskUsed) || 0;
      diskPct = diskTotal > 0 ? Math.min(100, (diskUsed / diskTotal) * 100) : 0;
    } catch (_) { /* ignore */ }
    return { cpu: cpuPct, mem: memPct, disk: diskPct };
  }

  bag.refreshDashMetricSample = async function refreshDashMetricSample() {
    try {
      let counts;
      if (bag.isAllNodes()) {
        const [cAgg, iAgg, vAgg, nAgg] = await Promise.all([
          bag.dockerAll('/containers/json?all=true', { pick: (d) => (Array.isArray(d) ? d : []), refresh: false }),
          bag.dockerAll('/images/json', { pick: (d) => (Array.isArray(d) ? d : []), refresh: false }),
          bag.dockerAll('/volumes', { pick: (d) => d?.Volumes || [], refresh: false }),
          bag.dockerAll('/networks', { pick: (d) => (Array.isArray(d) ? d : []), refresh: false }),
        ]);
        counts = {
          containers: (cAgg.items || []).length,
          images: (iAgg.items || []).length,
          volumes: (vAgg.items || []).length,
          networks: (nAgg.items || []).length,
        };
      } else {
        const [c, i, v, n, info] = await Promise.all([
          bag.Api.docker('/containers/json?all=true'),
          bag.Api.docker('/images/json'),
          bag.Api.docker('/volumes'),
          bag.Api.docker('/networks'),
          bag.Api.docker('/info').catch(() => ({})),
        ]);
        const hostPct = await bag.sampleHostResourcePercents(c || [], Number(info?.MemTotal) || 0);
        counts = {
          containers: (c || []).length,
          images: (i || []).length,
          volumes: (v?.Volumes || []).length,
          networks: (n || []).length,
          cpu: hostPct.cpu,
          mem: hostPct.mem,
          disk: hostPct.disk,
        };
      }
      const series = await bag.pushMetricSample(counts);
      bag.updateDashStatCards(series, counts);
      bag.updateHostResourceChart(series, counts);
    } catch (_) { /* silent */ }
  }

  bag.updateDashStatCards = function updateDashStatCards(series, counts) {
    bag._dashMetricSeries = series;
    const map = [
      ['containers', 'blue'],
      ['images', 'purple'],
      ['volumes', 'green'],
      ['networks', 'orange'],
    ];
    map.forEach(([key, tone]) => {
      const card = document.querySelector(`.stat-card[data-metric="${key}"]`);
      if (!card) return;
      const val = card.querySelector('.stat-value');
      const delta = card.querySelector('.stat-delta');
      const sparkBtn = card.querySelector('.sparkline-btn');
      const spark = sparkBtn?.querySelector('.sparkline') || card.querySelector('.sparkline');
      if (val && counts && counts[key] != null) val.textContent = String(counts[key]);
      if (delta) delta.outerHTML = bag.metricDeltaHtml(series, key);
      if (spark) spark.outerHTML = bag.sparklineFromValues(bag.metricValues(series, key), tone);
    });
  }

  bag.bindDashMetricSparklines = function bindDashMetricSparklines(series) {
    bag._dashMetricSeries = series || bag.getMetricSeries();
    bag.root.querySelectorAll('[data-metric-detail]').forEach((btn) => {
      if (btn.dataset.boundDetail === '1') return;
      btn.dataset.boundDetail = '1';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const key = btn.dataset.metricDetail;
        bag.openMetricDetailModal(key, bag._dashMetricSeries || bag.getMetricSeries());
      });
    });
  }

  bag.formatMetricRange = function formatMetricRange(fromSec, untilSec) {
    const fmt = (sec) => {
      try {
        return new Date(sec * 1000).toLocaleString('fr-FR', {
          day: '2-digit',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        });
      } catch {
        return String(sec);
      }
    };
    return `${fmt(fromSec)} → ${fmt(untilSec)}`;
  }

  bag.openMetricDetailModal = function openMetricDetailModal(key, series) {
    const meta = bag.dashMetricMeta?.[key] || {
      label: key,
      tone: 'blue',
      color: '#38bdf8',
      href: `#${key}`,
    };
    const retentionDays = bag.metricRetentionDays();
    const defaultHours = bag.metricChartHours();
    const windowChoices = Array.from(new Set([
      defaultHours,
      24,
      48,
      72,
      168,
      Math.min(retentionDays * 24, 720),
    ].filter((h) => h >= 1 && h <= retentionDays * 24))).sort((a, b) => a - b);

    let hours = defaultHours;
    let until = Math.floor(Date.now() / 1000);
    let loading = false;

    const windowLabel = (h) => {
      if (h === 24) return '24 h';
      if (h % 24 === 0) {
        const d = h / 24;
        return `${d} j`;
      }
      return `${h} h`;
    };

    const renderBody = (pts, fromSec, untilSec) => {
      const vals = bag.metricValues(pts, key);
      const n = vals.length;
      const last = n ? vals[n - 1] : 0;
      const max = n ? Math.max(...vals) : 0;
      const min = n ? Math.min(...vals) : 0;
      const avg = n ? vals.reduce((a, b) => a + b, 0) / n : 0;
      const delta = n >= 2 ? vals[n - 1] - vals[n - 2] : 0;
      const chart = bag.resourceChart(pts, {
        wrapId: 'metric-detail-wave',
        keys: [{ key, color: meta.color, label: meta.label }],
        maxY: Math.max(max, 1) * 1.15,
      });
      const now = Math.floor(Date.now() / 1000);
      const floor = now - retentionDays * 86400;
      const canPrev = until - hours > floor + 60;
      const canNext = until < now - 90;
      const chips = windowChoices.map((h) =>
        `<button type="button" class="btn btn-sm metric-win-chip${h === hours ? ' is-active' : ''}" data-metric-hours="${h}">${bag.esc(windowLabel(h))}</button>`
      ).join('');

      return `
          <div class="metric-detail-nav">
            <div class="metric-detail-nav-row">
              <button type="button" class="btn btn-sm" data-metric-prev ${canPrev ? '' : 'disabled'} title="Fenêtre précédente">← Préc.</button>
              <button type="button" class="btn btn-sm" data-metric-live ${canNext ? '' : 'disabled'} title="Revenir à maintenant">Maintenant</button>
              <button type="button" class="btn btn-sm" data-metric-next ${canNext ? '' : 'disabled'} title="Fenêtre suivante">Suiv. →</button>
            </div>
            <div class="metric-detail-nav-row metric-win-chips">${chips}</div>
            <p class="muted metric-detail-range">${bag.esc(bag.formatMetricRange(fromSec, untilSec))} · rétention ${retentionDays} j</p>
          </div>
          <div class="metric-detail-kpis">
            <div class="metric-kpi"><span class="muted">${canNext ? 'Fin fenêtre' : 'Actuel'}</span><strong>${last}</strong></div>
            <div class="metric-kpi"><span class="muted">Min</span><strong>${min}</strong></div>
            <div class="metric-kpi"><span class="muted">Max</span><strong>${max}</strong></div>
            <div class="metric-kpi"><span class="muted">Moyenne</span><strong>${avg.toFixed(1)}</strong></div>
            <div class="metric-kpi"><span class="muted">Δ dernier</span><strong class="${delta > 0 ? 'ok' : delta < 0 ? 'bad' : ''}">${delta > 0 ? '+' : ''}${delta}</strong></div>
            <div class="metric-kpi"><span class="muted">Relevés</span><strong>${n}</strong></div>
          </div>
          <div class="metric-detail-chart">${chart}</div>`;
    };

    bag.closeAppModal();
    const host = bag.modalHost();
    host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-form-wide" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div class="metric-detail-head">
              <div class="stat-ico ${bag.esc(meta.tone)}">${bag.ico(key === 'networks' ? 'networks' : key)}</div>
              <div>
                <h3>${bag.esc(meta.label)}</h3>
                <div class="modal-sub" id="metric-detail-sub">Historique · navigation sur ${retentionDays} j de rétention</div>
              </div>
            </div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">✕</button>
          </div>
          <div id="metric-detail-body">
            <div class="muted" style="padding:12px 0">Chargement…</div>
          </div>
          <div class="actions-bar">
            <a class="btn btn-primary" href="${bag.esc(meta.href)}">Ouvrir ${bag.esc(meta.label)}</a>
            <button type="button" class="btn" data-close-modal>Fermer</button>
          </div>
        </div>
      </div>`;
    bag.bindAppModalChrome();

    const bodyEl = () => document.getElementById('metric-detail-body');
    const subEl = () => document.getElementById('metric-detail-sub');

    const bindNav = () => {
      const root = bodyEl();
      if (!root) return;
      root.querySelector('[data-metric-prev]')?.addEventListener('click', () => {
        until = Math.max(
          Math.floor(Date.now() / 1000) - retentionDays * 86400 + hours,
          until - hours,
        );
        void load();
      });
      root.querySelector('[data-metric-next]')?.addEventListener('click', () => {
        until = Math.min(Math.floor(Date.now() / 1000), until + hours);
        void load();
      });
      root.querySelector('[data-metric-live]')?.addEventListener('click', () => {
        until = Math.floor(Date.now() / 1000);
        void load();
      });
      root.querySelectorAll('[data-metric-hours]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const h = parseInt(btn.getAttribute('data-metric-hours') || '', 10);
          if (!Number.isFinite(h) || h < 1) return;
          hours = h;
          void load();
        });
      });
    };

    const paint = (pts, fromSec, untilSec) => {
      const el = bodyEl();
      if (!el) return;
      el.innerHTML = renderBody(pts, fromSec, untilSec);
      if (subEl()) {
        subEl().textContent = `Fenêtre ${windowLabel(hours)} · rétention ${retentionDays} j`;
      }
      bindNav();
    };

    const load = async () => {
      if (loading) return;
      loading = true;
      const el = bodyEl();
      if (el) el.innerHTML = `<div class="muted" style="padding:12px 0">Chargement…</div>`;
      try {
        const scope = bag.metricScopeKey();
        const points = Math.min(720, Math.max(48, Math.ceil((hours * 60) / 5)));
        const now = Math.floor(Date.now() / 1000);
        if (until > now) until = now;
        const data = await bag.Api.metricsHistory(scope, { hours, until, points });
        const pts = Array.isArray(data?.Series) ? data.Series : [];
        const fromSec = Number(data?.From) || (until - hours * 3600);
        const untilSec = Number(data?.Until) || until;
        until = untilSec;
        paint(pts, fromSec, untilSec);
      } catch (err) {
        if (el) {
          el.innerHTML = `<div class="error-box">${bag.esc(err.message || String(err))}</div>`;
        }
      } finally {
        loading = false;
      }
    };

    // First paint from cached series if viewing "now" window, then refresh
    if (Array.isArray(series) && series.length) {
      const fromSec = until - hours * 3600;
      paint(series, fromSec, until);
    }
    void load();
  }

  bag.updateHostResourceChart = function updateHostResourceChart(series, counts) {
    // Courbes : uniquement en fenêtre « maintenant » (sinon on garde l’historique navigué)
    if (bag.isHostChartLive() && document.getElementById('host-chart-block')) {
      if (!bag._hostChartNav) bag.resetHostChartNav();
      const now = Math.floor(Date.now() / 1000);
      bag._hostChartNav.until = now;
      bag._hostChartNav.from = now - bag._hostChartNav.hours * 3600;
      bag.paintHostResourceChart(series || []);
    } else if (bag.isHostChartLive()) {
      const wrap = document.getElementById('host-wave-wrap');
      if (wrap) wrap.outerHTML = bag.hostResourceChart(series || []);
    }
    if (!counts) return;
    const gauges = document.querySelectorAll('.panel-card .gauge-row .gauge');
    if (gauges.length >= 3) {
      if (counts.cpu != null) {
        gauges[0].querySelector('svg')?.replaceWith(
          (() => { const t = document.createElement('div'); t.innerHTML = bag.gaugeRing(counts.cpu, '#3b82f6'); return t.firstElementChild; })()
        );
      }
      if (counts.mem != null) {
        gauges[1].querySelector('svg')?.replaceWith(
          (() => { const t = document.createElement('div'); t.innerHTML = bag.gaugeRing(counts.mem, '#22c55e'); return t.firstElementChild; })()
        );
      }
      if (counts.disk != null) {
        gauges[2].querySelector('svg')?.replaceWith(
          (() => { const t = document.createElement('div'); t.innerHTML = bag.gaugeRing(counts.disk, '#fb923c'); return t.firstElementChild; })()
        );
      }
    }
  }

}
