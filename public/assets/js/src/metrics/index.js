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

  /** Multi-series resource chart (0–100 %). */

  bag.resourceChart = function resourceChart(series, opts = {}) {
    const w = 320;
    const h = 88;
    const padY = 4;
    const yAt = (pct) => padY + (1 - Math.max(0, Math.min(100, pct)) / 100) * (h - padY * 2);
    const keys = opts.keys || [
      { key: 'cpu', color: '#3b82f6', label: 'CPU' },
      { key: 'mem', color: '#22c55e', label: 'Mémoire' },
      { key: 'disk', color: '#fb923c', label: 'Disque' },
    ];
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
        return `<path d="M0 ${y.toFixed(2)} L${w} ${y.toFixed(2)}" fill="none" stroke="${color}" stroke-width="2"/>`;
      }
      const d = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c[0].toFixed(2)} ${c[1].toFixed(2)}`).join(' ');
      return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
    }).join('');
    const labels = keys.map((k) => k.label).join(' / ');
    const title = n < 2
      ? 'Historique ressources en construction'
      : `Évolution ${labels} — ${n} relevés (échelle 0–100 %)`;
    const legend = keys.map(({ color, label }) =>
      `<span class="wave-leg"><i style="background:${color}"></i>${bag.esc(label)}</span>`
    ).join('');
    const y100 = yAt(100).toFixed(1);
    const y50 = yAt(50).toFixed(1);
    const y0 = yAt(0).toFixed(1);
    return `<div class="wave-wrap" id="${bag.esc(wrapId)}">
      <div class="wave-head"><span class="stat-hint" title="Fenêtre configurable dans Paramètres">Courbes · ${bag.esc(bag.metricWindowLabel())} · rétention ${bag.esc(String(bag.metricRetentionDays()))} j</span></div>
      <div class="wave-plot">
        <div class="wave-y" aria-hidden="true">
          <span>100%</span>
          <span>50%</span>
          <span>0%</span>
        </div>
        <svg class="wave-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${bag.esc(title)}">
          <title>${bag.esc(title)}</title>
          <line x1="0" y1="${y100}" x2="${w}" y2="${y100}" class="wave-grid"/>
          <line x1="0" y1="${y50}" x2="${w}" y2="${y50}" class="wave-grid"/>
          <line x1="0" y1="${y0}" x2="${w}" y2="${y0}" class="wave-grid"/>
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

  bag.statsLoadTone = function statsLoadTone(pct) {
    const p = Number(pct) || 0;
    if (p >= 85) return 'hot';
    if (p >= 65) return 'warn';
    return 'ok';
  }

  /** Compact clickable CPU/RAM chip (replaces color-only stats icon). */
  bag.statsLoadBtn = function statsLoadBtn({ id, name, running }) {
    const title = running
      ? 'CPU / RAM en direct — cliquer pour le détail'
      : 'Conteneur arrêté';
    const level = running ? 'is-stats-ok' : 'is-stats-off';
    return `<button type="button" class="btn btn-stats-load ${level}"
      data-modal="stats" data-id="${bag.esc(id)}" data-name="${bag.esc(name || '')}"
      data-running="${running ? '1' : '0'}" data-stats-id="${bag.esc(id)}"
      title="${bag.esc(title)}" aria-label="${bag.esc(title)}">
      <span class="sl-row" data-sl="cpu">
        <span class="sl-k">CPU</span>
        <span class="sl-bar"><i style="width:0%"></i></span>
        <span class="sl-v">${running ? '…' : '—'}</span>
      </span>
      <span class="sl-row" data-sl="mem">
        <span class="sl-k">RAM</span>
        <span class="sl-bar mem"><i style="width:0%"></i></span>
        <span class="sl-v">${running ? '…' : '—'}</span>
      </span>
    </button>`;
  }

  bag.applyStatsIconLevel = function applyStatsIconLevel(containerId, level, title, metrics = null) {
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
    if (!btn.classList.contains('btn-stats-load')) return;
    const setRow = (key, pct) => {
      const row = btn.querySelector(`[data-sl="${key}"]`);
      if (!row) return;
      const bar = row.querySelector('.sl-bar');
      const fill = row.querySelector('i');
      const val = row.querySelector('.sl-v');
      row.classList.remove('is-ok', 'is-warn', 'is-hot');
      if (level === 'off' || pct == null || !Number.isFinite(Number(pct))) {
        if (fill) fill.style.width = '0%';
        if (val) val.textContent = '—';
        return;
      }
      const p = Math.max(0, Math.min(100, Number(pct) || 0));
      const tone = bag.statsLoadTone(p);
      row.classList.add(`is-${tone}`);
      if (bar) bar.dataset.tone = tone;
      if (fill) fill.style.width = `${p.toFixed(0)}%`;
      if (val) val.textContent = `${Math.round(p)}%`;
    };
    setRow('cpu', metrics?.cpu);
    setRow('mem', metrics?.mem);
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

  bag.loadContainerMetricHistory = async function loadContainerMetricHistory(containerId) {
    try {
      const hours = bag.metricChartHours();
      const points = Math.min(288, Math.max(48, Math.ceil((hours * 60) / 5)));
      const data = await bag.Api.metricsHistory(bag.containerMetricScope(containerId), { hours, points });
      if (data?.ChartHours != null) bag.state.metricsChartHours = Number(data.ChartHours) || bag.state.metricsChartHours;
      if (data?.RetentionDays != null) bag.state.metricsRetentionDays = Number(data.RetentionDays) || bag.state.metricsRetentionDays;
      return Array.isArray(data?.Series) ? data.Series : [];
    } catch (_) {
      return [];
    }
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
    bag.state.containerStatsTimer = setInterval(tick, 4000);
  }

  bag.refreshContainerStatsIcons = async function refreshContainerStatsIcons(containers) {
    if (bag.state.route !== 'containers' && bag.state.route !== 'container') return;
    const running = (containers || []).filter((c) => {
      const st = String(c.State || '').toLowerCase();
      return st === 'running' || st === 'restarting';
    }).slice(0, 24);
    (containers || []).forEach((c) => {
      const st = String(c.State || '').toLowerCase();
      if (st !== 'running' && st !== 'restarting') {
        bag.applyStatsIconLevel(c.Id, 'off', 'Conteneur arrêté — pas de charge', { cpu: null, mem: null });
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
          const title = `CPU ${computed.cpuPct.toFixed(0)}% · RAM ${computed.memPct.toFixed(0)}% · Réseau ${bag.formatBitRate(rate.rx + rate.tx)} — cliquer pour le détail`;
          bag.applyStatsIconLevel(c.Id, level, title, {
            cpu: computed.cpuPct,
            mem: computed.memPct,
          });
          void bag.pushContainerMetricSample(c.Id, computed.cpuPct, computed.memPct, net);
        } catch (_) {
          bag.applyStatsIconLevel(c.Id, 'off', 'Stats indisponibles', { cpu: null, mem: null });
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
      const spark = card.querySelector('.sparkline');
      if (val && counts && counts[key] != null) val.textContent = String(counts[key]);
      if (delta) delta.outerHTML = bag.metricDeltaHtml(series, key);
      if (spark) spark.outerHTML = bag.sparklineFromValues(bag.metricValues(series, key), tone);
    });
  }

  bag.updateHostResourceChart = function updateHostResourceChart(series, counts) {
    const wrap = document.getElementById('host-wave-wrap');
    if (wrap) wrap.outerHTML = bag.hostResourceChart(series);
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
