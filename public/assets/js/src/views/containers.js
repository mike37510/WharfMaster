import { bag } from '../bag.js';

export function install() {
  bag.openCreateContainerModal = async function openCreateContainerModal() {
    bag.closeAppModal();
    const host = bag.modalHost();
    host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-form modal-form-wide" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3>Créer un conteneur</h3>
              <div class="modal-sub">Recherche locale puis Docker Hub</div>
            </div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">✕</button>
          </div>
          <div id="create-err"></div>
          <div class="form-group">
            <label class="field-label">Image <span class="req">*</span></label>
            ${bag.imageSearchFieldsHtml('c')}
          </div>
          <div class="form-group">
            <label class="field-label">Nom</label>
            <input id="c-name" placeholder="mon-conteneur (optionnel)" autocomplete="off">
          </div>
          <div class="form-group">
            <label class="field-label">Ports</label>
            <input id="c-ports" placeholder="8080:80 (publié) ou 80 (interne) — ligne / virgule" autocomplete="off">
            <p class="field-hint muted" style="margin-top:6px"><code>8080:80</code> fixe · <code>0:80</code> port hôte aléatoire · <code>80</code> / <code>80,443</code> interne seulement.</p>
          </div>
          <div class="form-group">
            <div class="field-label-row">
              <label class="field-label">Volumes</label>
              <button type="button" class="btn btn-sm" id="c-vol-add" title="Ajouter un volume">
                <span class="btn-ico">${bag.ico('plus')}</span><span>Ajouter</span>
              </button>
            </div>
            <div class="vol-mount-list" id="c-vol-list">
              <div class="muted" id="c-vol-empty" style="font-size:13px">Aucun volume lié</div>
            </div>
          </div>
          <div class="form-group">
            <label class="field-label">Commande</label>
            <input id="c-cmd" placeholder="optionnel" autocomplete="off">
          </div>
          <label class="check-row"><input type="checkbox" id="c-start" checked> Démarrer après création</label>
          <div class="actions-bar">
            <button type="button" class="btn btn-primary" id="c-save">Créer</button>
            <button type="button" class="btn" data-close-modal>Annuler</button>
          </div>
        </div>
      </div>`;
    bag.bindAppModalChrome();
    const imagePicker = bag.bindImageSearchPicker('c', host);
    const volListEl = document.getElementById('c-vol-list');
    let volumeNames = [];

    function collectVolumeBinds() {
      const binds = [];
      const errors = [];
      volListEl?.querySelectorAll('.vol-mount-row').forEach((row, i) => {
        const vol = row.querySelector('.vol-name')?.value?.trim() || '';
        const dest = row.querySelector('.vol-dest')?.value?.trim() || '';
        const ro = row.querySelector('.vol-ro')?.checked;
        if (!vol && !dest) return;
        if (!vol) {
          errors.push(`Ligne ${i + 1} : volume requis`);
          return;
        }
        if (!dest || !dest.startsWith('/')) {
          errors.push(`Ligne ${i + 1} : chemin conteneur absolu requis (ex. /data)`);
          return;
        }
        binds.push(ro ? `${vol}:${dest}:ro` : `${vol}:${dest}`);
      });
      return { binds, errors };
    }

    function syncVolEmpty() {
      const empty = document.getElementById('c-vol-empty');
      const rows = volListEl?.querySelectorAll('.vol-mount-row') || [];
      if (empty) empty.hidden = rows.length > 0;
    }

    function addVolumeRow(prefill = {}) {
      const empty = document.getElementById('c-vol-empty');
      if (empty) empty.hidden = true;
      const row = document.createElement('div');
      row.className = 'vol-mount-row';
      const opts = volumeNames.length
        ? volumeNames.map((n) => `<option value="${bag.esc(n)}"${prefill.name === n ? ' selected' : ''}>${bag.esc(n)}</option>`).join('')
        : '<option value="">Aucun volume disponible</option>';
      row.innerHTML = `
        <select class="vol-name select-block" title="Volume Docker" ${volumeNames.length ? '' : 'disabled'}>
          <option value="">Volume…</option>
          ${opts}
        </select>
        <input class="vol-dest" placeholder="/chemin/conteneur" value="${bag.esc(prefill.dest || '')}" autocomplete="off" spellcheck="false">
        <label class="vol-ro-label" title="Lecture seule"><input type="checkbox" class="vol-ro"${prefill.ro ? ' checked' : ''}> RO</label>
        <button type="button" class="icon-btn vol-remove" title="Retirer" aria-label="Retirer">✕</button>`;
      if (prefill.name && volumeNames.includes(prefill.name)) {
        row.querySelector('.vol-name').value = prefill.name;
      }
      row.querySelector('.vol-remove')?.addEventListener('click', () => {
        row.remove();
        syncVolEmpty();
      });
      volListEl?.appendChild(row);
      row.querySelector('.vol-dest')?.focus();
    }

    document.getElementById('c-vol-add')?.addEventListener('click', () => addVolumeRow());

    (async () => {
      try {
        const data = await bag.Api.docker('/volumes');
        volumeNames = (data?.Volumes || []).map((v) => v.Name).filter(Boolean).sort((a, b) => a.localeCompare(b));
        volListEl?.querySelectorAll('.vol-name').forEach((sel) => {
          const cur = sel.value;
          sel.innerHTML = `<option value="">Volume…</option>`
            + volumeNames.map((n) => `<option value="${bag.esc(n)}">${bag.esc(n)}</option>`).join('');
          if (cur && volumeNames.includes(cur)) sel.value = cur;
          sel.disabled = volumeNames.length === 0;
        });
      } catch (_) {
        volumeNames = [];
      }
    })();

    imagePicker.focus();
    bag.onBusyClick(document.getElementById('c-save'), async () => {
      const errBox = document.getElementById('create-err');
      errBox.innerHTML = '';
      const { image, source } = imagePicker.getSelected();
      const name = document.getElementById('c-name').value.trim();
      const cmd = document.getElementById('c-cmd').value.trim();
      const start = document.getElementById('c-start').checked;
      if (!image) {
        errBox.innerHTML = `<div class="error-box">Sélectionnez une image dans les résultats de recherche.</div>`;
        imagePicker.focus();
        return;
      }
      const { ExposedPorts, PortBindings } = bag.parsePortBindings(document.getElementById('c-ports').value);
      const { binds, errors: volErrors } = collectVolumeBinds();
      if (volErrors.length) {
        errBox.innerHTML = `<div class="error-box">${bag.esc(volErrors.join('\n'))}</div>`;
        return;
      }
      const payload = {
        Image: image,
        HostConfig: {
          RestartPolicy: { Name: 'unless-stopped' },
          PublishAllPorts: false,
        },
      };
      // PortBindings seulement si hôte:conteneur (publié).
      // Port seul (80) → ExposedPorts uniquement, jamais de binding vide (sinon Docker
      // assigne un port hôte aléatoire genre 32804:80).
      if (Object.keys(PortBindings).length) payload.HostConfig.PortBindings = PortBindings;
      if (Object.keys(ExposedPorts).length) payload.ExposedPorts = ExposedPorts;
      if (binds.length) payload.HostConfig.Binds = binds;
      if (cmd) payload.Cmd = cmd.split(/\s+/);
      const q = name ? `?name=${encodeURIComponent(name)}` : '';
      try {
        if (source !== 'local') {
          try {
            const { fromImage, tag } = bag.parseImageRef(image);
            await bag.Api.docker(`/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag.replace(/^@/, ''))}`, { method: 'POST' });
          } catch (_) {}
        }
        const gate = await bag.cveAdviseBeforeDeploy({ Image: image }, errBox);
        if (!gate.proceed) {
          if (errBox && !errBox.innerHTML) {
            errBox.innerHTML = `<div class="info-box">Création annulée.</div>`;
          }
          return;
        }
        const created = await bag.Api.docker(`/containers/create${q}`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        if (start && created?.Id) {
          await bag.Api.docker(`/containers/${created.Id}/start`, { method: 'POST' });
        }
        bag.closeAppModal();
        if (location.hash === '#containers/new') location.hash = '#containers';
        else await bag.route();
      } catch (err) {
        errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
      }
    }, { disableSiblings: false, minMs: 300 });
  }

  bag.openContainerStatsModal = async function openContainerStatsModal(id, name, runningHint) {
    bag.closeAppModal();
    const host = bag.modalHost();
    let running = !!runningHint;
    let history = await bag.loadContainerMetricHistory(id);
    host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-form modal-form-wide modal-cstats" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3>Ressources</h3>
              <div class="modal-sub mono">${bag.esc(name)} · ${bag.esc(bag.shortId(id))}</div>
            </div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">✕</button>
          </div>
          <div class="cstats-toolbar">
            <span class="logs-status" id="cstats-status"><span class="dot"></span><span class="label">Chargement…</span></span>
            <div class="spacer"></div>
            <span class="muted" style="font-size:12px" title="Identique au dashboard (Paramètres)">${bag.esc(bag.metricWindowLabel())} · rétention ${bag.esc(String(bag.metricRetentionDays()))} j</span>
            <button type="button" class="btn btn-sm" id="cstats-refresh">Actualiser</button>
          </div>
          <div id="cstats-chart" class="cstats-chart">${bag.containerResourceChart(history)}</div>
          <div id="cstats-body" class="cstats-body">
            <div class="muted" style="padding:1.5rem;text-align:center">Collecte des métriques…</div>
          </div>
        </div>
      </div>`;
    bag.bindAppModalChrome();

    const body = document.getElementById('cstats-body');
    const chartEl = document.getElementById('cstats-chart');
    const statusEl = document.getElementById('cstats-status');
    let prev = null;
    let prevAt = 0;
    let lastPersistAt = 0;

    const setStatus = (cls, label) => {
      if (!statusEl) return;
      statusEl.className = `logs-status ${cls || ''}`.trim();
      const lbl = statusEl.querySelector('.label');
      if (lbl) lbl.textContent = label;
    };

    const refreshChart = async (force = false, livePoint = null) => {
      if (force || !history.length) {
        history = await bag.loadContainerMetricHistory(id);
      }
      const series = livePoint ? history.concat([livePoint]) : history;
      if (chartEl) chartEl.innerHTML = bag.containerResourceChart(series);
    };

    const render = (computed, rate, netScore) => {
      const cpu = Math.max(0, Number(computed.cpuPct) || 0);
      const mem = Math.max(0, Number(computed.memPct) || 0);
      const level = bag.resourceLoadLevel(cpu, mem, netScore);
      bag.applyStatsIconLevel(
        id,
        level,
        `CPU ${cpu.toFixed(0)}% · RAM ${mem.toFixed(0)}% · Réseau ${bag.formatBitRate((rate?.rx || 0) + (rate?.tx || 0))}`,
      );
      const netRows = Object.entries(computed.networks || {}).map(([iface, n]) => {
        const rx = Number(n?.rx_bytes || 0) || 0;
        const tx = Number(n?.tx_bytes || 0) || 0;
        return `<tr>
          <td class="mono">${bag.esc(iface)}</td>
          <td class="mono">${bag.esc(bag.formatBytes(rx))}</td>
          <td class="mono">${bag.esc(bag.formatBytes(tx))}</td>
        </tr>`;
      }).join('');
      body.innerHTML = `
        <div class="cstats-gauges">
          <div class="gauge">${bag.gaugeRing(cpu, '#3b82f6')}<div class="g-label">CPU</div><div class="g-sub">${cpu.toFixed(1)} %</div></div>
          <div class="gauge">${bag.gaugeRing(mem, '#22c55e')}<div class="g-label">RAM</div><div class="g-sub">${bag.esc(bag.formatBytes(computed.memUsage))} / ${bag.esc(bag.formatBytes(computed.memLimit))}</div></div>
          <div class="gauge">${bag.gaugeRing(netScore, '#a78bfa')}<div class="g-label">Réseau</div><div class="g-sub">↓ ${bag.esc(bag.formatBitRate(rate?.rx || 0))} · ↑ ${bag.esc(bag.formatBitRate(rate?.tx || 0))}</div></div>
        </div>
        <div class="cstats-meta muted">PID ${bag.esc(String(computed.pids || 0))} · live · historique ${bag.esc(bag.metricWindowLabel())}</div>
        <div class="section-title" style="margin-top:14px">Interfaces réseau</div>
        <div class="table-wrap" style="margin:0">
          <table class="data">
            <thead><tr><th>Interface</th><th>Reçu</th><th>Émis</th></tr></thead>
            <tbody>${netRows || '<tr><td colspan="3" class="muted">Aucune interface</td></tr>'}</tbody>
          </table>
        </div>`;
    };

    const tick = async () => {
      if (!document.getElementById('cstats-body')) {
        if (bag.state.statsTimer) {
          clearInterval(bag.state.statsTimer);
          bag.state.statsTimer = null;
        }
        return;
      }
      try {
        if (!running) {
          try {
            const info = await bag.Api.docker(`/containers/${id}/json`);
            running = String(info.State?.Status || '').toLowerCase() === 'running';
            if (!name || name === bag.shortId(id)) {
              name = (info.Name || '').replace(/^\//, '') || name;
            }
          } catch (_) {}
        }
        if (!running) {
          setStatus('is-paused', 'Conteneur arrêté');
          bag.applyStatsIconLevel(id, 'off', 'Conteneur arrêté — pas de charge');
          body.innerHTML = `<div class="info-box">Démarrez le conteneur pour voir CPU, RAM et réseau en direct.</div>`;
          return;
        }
        setStatus('is-live', 'En direct');
        const st = await bag.Api.docker(`/containers/${id}/stats?stream=false`);
        const now = Date.now();
        const computed = bag.computeStats(st, 0);
        let rate = { rx: 0, tx: 0 };
        if (prev && prevAt > 0) {
          const dt = Math.max(0.5, (now - prevAt) / 1000);
          rate = {
            rx: Math.max(0, (computed.netRx - prev.netRx) / dt),
            tx: Math.max(0, (computed.netTx - prev.netTx) / dt),
          };
        }
        prev = computed;
        prevAt = now;
        const netScore = bag.netLoadScore(rate.rx, rate.tx);
        render(computed, rate, netScore);
        const livePoint = {
          t: now,
          cpu: Math.max(0, Number(computed.cpuPct) || 0),
          mem: Math.max(0, Number(computed.memPct) || 0),
          disk: netScore,
          containers: 1,
          images: 0,
          volumes: 0,
          networks: 0,
        };
        // Persist with same retention/window as dashboard (server min-gap ~5 min)
        if (!lastPersistAt || (now - lastPersistAt) > 60_000) {
          lastPersistAt = now;
          await bag.pushContainerMetricSample(id, computed.cpuPct, computed.memPct, netScore);
          await refreshChart(true, livePoint);
        } else {
          await refreshChart(false, livePoint);
        }
      } catch (err) {
        setStatus('is-error', 'Erreur');
        body.innerHTML = `<div class="error-box">${bag.esc(err.message || 'Stats indisponibles')}</div>`;
      }
    };

    document.getElementById('cstats-refresh')?.addEventListener('click', async () => {
      await refreshChart(true);
      await tick();
    });
    await tick();
    bag.state.statsTimer = setInterval(tick, 2000);
  }

  bag.openInspectModal = async function openInspectModal(id, name) {
    bag.closeAppModal();
    const host = bag.modalHost();
    host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-xl modal-workspace modal-inspect" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3>Inspecter</h3>
              <div class="modal-sub mono">${bag.esc(name)} · ${bag.esc(bag.shortId(id))}</div>
            </div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">✕</button>
          </div>
          <div class="toolbar">
            <button class="btn btn-sm" id="inspect-refresh">Actualiser</button>
            <button class="btn btn-sm" id="inspect-copy">Copier JSON</button>
            <div class="spacer"></div>
            <span class="muted" id="inspect-meta">Chargement…</span>
          </div>
          <pre class="logs" id="inspect-view">Chargement…</pre>
        </div>
      </div>`;
    bag.bindAppModalChrome();
    const view = document.getElementById('inspect-view');
    const meta = document.getElementById('inspect-meta');
    let rawJson = '';
    const load = async () => {
      try {
        const info = await bag.Api.docker(`/containers/${id}/json`);
        const resolved = (info.Name || '').replace(/^\//, '') || name;
        name = resolved;
        const sub = host.querySelector('.modal-sub');
        if (sub) sub.textContent = `${resolved} · ${bag.shortId(id)}`;
        rawJson = JSON.stringify(info, null, 2);
        view.textContent = rawJson;
        if (meta) meta.textContent = `${bag.formatBytes(rawJson.length)} · JSON`;
      } catch (err) {
        rawJson = '';
        view.textContent = err.message;
        if (meta) meta.textContent = 'Erreur';
      }
    };
    await load();
    bag.onBusyClick(document.getElementById('inspect-refresh'), load, { disableSiblings: false, minMs: 200 });
    document.getElementById('inspect-copy')?.addEventListener('click', async () => {
      if (!rawJson) return;
      try { await navigator.clipboard.writeText(rawJson); } catch (_) {}
    });
  }

  bag.openLogsModal = async function openLogsModal(id, name) {
    bag.closeAppModal();
    const host = bag.modalHost();
    const safeName = String(name || id).replace(/[^\w.-]+/g, '_');
    host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-xl modal-workspace modal-logs" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3>Logs conteneur</h3>
              <div class="modal-sub mono">${bag.esc(name)} · ${bag.esc(bag.shortId(id))}</div>
            </div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">✕</button>
          </div>
          <div class="logs-panel">
            <div class="logs-toolbar">
              <div class="field-inline">
                <label for="log-tail">Tail</label>
                <select id="log-tail">
                  <option value="100">100</option>
                  <option value="300" selected>300</option>
                  <option value="1000">1000</option>
                  <option value="all">Tout</option>
                </select>
              </div>
              <label class="logs-check"><input type="checkbox" id="log-follow" checked> Suivre</label>
              <label class="logs-check"><input type="checkbox" id="log-timestamps" checked> Horodatage</label>
              <div class="field-inline logs-search-wrap">
                <label for="log-search">Recherche</label>
                <input type="search" id="log-search" placeholder="Filtrer…" autocomplete="off">
              </div>
              <button type="button" class="btn btn-sm" id="refresh-logs">Actualiser</button>
              <button type="button" class="btn btn-sm" id="copy-logs">Copier</button>
              <button type="button" class="btn btn-sm" id="download-logs">Télécharger</button>
              <div class="logs-status" id="log-status">
                <span class="dot"></span>
                <span class="label">Chargement…</span>
              </div>
            </div>
            <div class="logs log-view" id="log-view" tabindex="0">Chargement des journaux…</div>
          </div>
        </div>
      </div>`;
    bag.bindAppModalChrome();

    const view = document.getElementById('log-view');
    const statusEl = document.getElementById('log-status');
    const followEl = document.getElementById('log-follow');
    const tsEl = document.getElementById('log-timestamps');
    const tailEl = document.getElementById('log-tail');
    const searchEl = document.getElementById('log-search');

    const session = {
      buffer: '',
      lastIso: null,
      stickBottom: true,
      loading: false,
      err: null,
    };

    const setStatus = (mode, text) => {
      if (!statusEl) return;
      statusEl.classList.remove('is-live', 'is-paused', 'is-error');
      if (mode) statusEl.classList.add(mode);
      const label = statusEl.querySelector('.label');
      if (label) label.textContent = text;
    };

    const paint = () => {
      const filter = searchEl?.value || '';
      if (session.err && !session.buffer) {
        view.innerHTML = `<div class="log-empty log-error">${bag.esc(session.err)}</div>`;
        return;
      }
      view.innerHTML = bag.renderLogLines(session.buffer, filter);
      if (session.stickBottom) view.scrollTop = view.scrollHeight;
    };

    const advanceCursor = (chunk) => {
      const lines = String(chunk || '').split(/\r\n|\n|\r/);
      for (const line of lines) {
        if (!line) continue;
        const iso = bag.parseLogTimestamp(line);
        if (iso && (!session.lastIso || iso > session.lastIso)) session.lastIso = iso;
      }
    };

    const fetchLogs = async ({ incremental = false } = {}) => {
      if (session.loading) return;
      session.loading = true;
      const timestamps = !!tsEl?.checked;
      const tail = tailEl?.value || '300';
      const opts = {
        timestamps,
        annotate: true,
        stdout: true,
        stderr: true,
      };
      if (incremental && timestamps && session.lastIso) {
        const since = Math.floor(Date.parse(session.lastIso) / 1000);
        if (Number.isFinite(since) && since > 0) {
          opts.since = since;
          opts.tail = 'all';
        } else {
          opts.tail = tail;
        }
      } else {
        opts.tail = tail;
      }
      try {
        const text = await bag.Api.containerLogs(id, opts);
        session.err = null;
        if (incremental && session.buffer && opts.since) {
          if (text) {
            const incoming = String(text);
            const filtered = incoming.split(/\r\n|\n|\r/).filter((line) => {
              if (!line) return false;
              const iso = bag.parseLogTimestamp(line);
              if (!iso) return true;
              return iso > session.lastIso;
            }).join('\n');
            if (filtered) {
              session.buffer = session.buffer.replace(/\s*$/, '') + (session.buffer ? '\n' : '') + filtered;
              advanceCursor(filtered);
            }
          }
        } else {
          session.buffer = String(text || '');
          session.lastIso = null;
          advanceCursor(session.buffer);
        }
        paint();
        const when = new Date().toLocaleTimeString();
        if (followEl?.checked) setStatus('is-live', `En direct · ${when}`);
        else setStatus('is-paused', `À jour · ${when}`);
      } catch (err) {
        session.err = err.message || String(err);
        if (!session.buffer) paint();
        setStatus('is-error', session.err);
      } finally {
        session.loading = false;
      }
    };

    view.addEventListener('scroll', () => {
      const gap = view.scrollHeight - view.scrollTop - view.clientHeight;
      session.stickBottom = gap < 40;
    });

    searchEl?.addEventListener('input', () => paint());
    tsEl?.addEventListener('change', async () => {
      session.lastIso = null;
      await fetchLogs({ incremental: false });
    });
    tailEl?.addEventListener('change', async () => {
      session.lastIso = null;
      await fetchLogs({ incremental: false });
    });
    followEl?.addEventListener('change', () => {
      if (followEl.checked) setStatus('is-live', 'En direct…');
      else setStatus('is-paused', 'Suivi en pause');
    });

    bag.onBusyClick(document.getElementById('refresh-logs'), async () => {
      session.lastIso = null;
      await fetchLogs({ incremental: false });
    }, { disableSiblings: false, minMs: 200 });

    document.getElementById('copy-logs')?.addEventListener('click', async () => {
      const plain = bag.stripLogAnnotations(session.buffer);
      try {
        await navigator.clipboard.writeText(plain);
        setStatus(followEl?.checked ? 'is-live' : 'is-paused', 'Copié dans le presse-papiers');
      } catch (_) {
        setStatus('is-error', 'Impossible de copier');
      }
    });

    document.getElementById('download-logs')?.addEventListener('click', () => {
      bag.downloadTextFile(`${safeName}-logs.txt`, bag.stripLogAnnotations(session.buffer));
    });

    await fetchLogs({ incremental: false });
    if (bag.state.logTimer) {
      clearInterval(bag.state.logTimer);
      bag.state.logTimer = null;
    }
    bag.state.logTimer = setInterval(() => {
      if (!followEl?.checked) return;
      fetchLogs({ incremental: !!tsEl?.checked && !!session.lastIso });
    }, 1800);
  }

  bag.openConsoleModal = async function openConsoleModal(id, name, runningHint) {
    bag.closeAppModal();
    let running = !!runningHint;
    if (runningHint == null) {
      try {
        const info = await bag.Api.docker(`/containers/${id}/json`);
        running = String(info.State?.Status || '').toLowerCase() === 'running';
        name = (info.Name || '').replace(/^\//, '') || name;
      } catch (_) {}
    }
    const host = bag.modalHost();
    host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-xl modal-workspace modal-console" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3>Console</h3>
              <div class="modal-sub mono">${bag.esc(name)} · ${bag.esc(bag.shortId(id))}</div>
            </div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">✕</button>
          </div>
          <div class="console-panel">
            <div class="console-toolbar">
              <div class="field-inline">
                <label for="shell-bin">Commande</label>
                <select id="shell-bin">
                  <option value="/bin/bash">/bin/bash</option>
                  <option value="/bin/sh" selected>/bin/sh</option>
                  <option value="/bin/ash">/bin/ash</option>
                </select>
              </div>
              <button class="btn btn-info btn-sm" id="console-connect" ${running ? '' : 'disabled'}>Connecter</button>
              <button class="btn btn-sm" id="console-disconnect" disabled>Déconnecter</button>
              <div class="console-status" id="console-status">
                <span class="dot"></span>
                <span class="label">${running ? 'Prêt à connecter' : "Le conteneur n'est pas démarré"}</span>
              </div>
            </div>
            <div class="console-wrap" id="term">
              <div class="console-placeholder" id="console-placeholder">
                <div style="font-size:28px;opacity:.5">⬛</div>
                <p>${running
                  ? 'Choisissez un shell puis cliquez sur <strong>Connecter</strong> pour ouvrir une console dans ce conteneur.'
                  : "Démarrez le conteneur avant d'ouvrir la console."}</p>
              </div>
            </div>
            <div class="console-hint">TTY interactif (WebSocket) · comme un vrai shell · Ctrl+C / vi / top supportés</div>
          </div>
        </div>
      </div>`;
    bag.bindAppModalChrome();
    if (running) bag.setupConsole(id, name);
  }

  bag.viewContainers = async function viewContainers() {
    const all = bag.isAllNodes();
    let list = [];
    let partial = false;
    let perNodeHint = '';
    let failMsg = '';
    if (all) {
      const agg = await bag.dockerAll('/containers/json?all=true');
      list = agg.items;
      partial = agg.failed > 0;
      perNodeHint = (agg.perNode || []).map((n) => `${n.name}: ${n.count}`).join(' · ');
      failMsg = (agg.failedNames || []).length
        ? ` Nœuds sans réponse : ${(agg.failedNames || []).join(', ')}.`
        : '';
    } else {
      list = (await bag.Api.docker('/containers/json?all=true')) || [];
    }

    const containerName = (c) => (c.Names && c.Names[0] ? c.Names[0].replace(/^\//, '') : bag.shortId(c.Id));
    list = bag.sortItems(list, 'containers', {
      name: containerName,
      image: (c) => c.Image || '',
      state: (c) => String(c.State || ''),
      node: (c) => c._nodeName || '',
      ports: (c) => bag.formatPorts(c.Ports || [], c._nodeId || c.EndpointId),
      created: (c) => bag.createdSortKey(c.Created),
    });

    const rows = list.map((c) => {
      const name = containerName(c);
      const st = String(c.State || '').toLowerCase();
      const isRunning = st === 'running' || st === 'restarting';
      const rowCls = isRunning ? '' : 'row-stopped';
      const search = `${name} ${c.Image} ${c.Id} ${c.State} ${c._nodeName || ''}`.toLowerCase();
      const actions = all
        ? `<span class="muted">—</span>`
        : `<div class="quick-actions">
          ${bag.iconBtn({ act: 'start', id: c.Id, title: 'Démarrer', icon: 'start', success: !isRunning })}
          ${bag.iconBtn({ act: 'stop', id: c.Id, title: 'Arrêter', icon: 'stop', danger: isRunning })}
          ${bag.iconBtn({ act: 'restart', id: c.Id, title: 'Redémarrer', icon: 'restart' })}
          ${bag.iconBtn({
            modal: 'stats', id: c.Id, name, running: isRunning,
            title: isRunning ? 'CPU / RAM / Réseau' : 'Conteneur arrêté',
            icon: 'stats', statsId: c.Id,
            extraClass: isRunning ? 'is-stats-ok' : 'is-stats-off',
          })}
          ${bag.iconBtn({ modal: 'logs', id: c.Id, name, running: isRunning, title: 'Logs', icon: 'logs' })}
          ${bag.iconBtn({ modal: 'console', id: c.Id, name, running: isRunning, title: 'Console', icon: 'console' })}
          ${bag.iconBtn({ modal: 'inspect', id: c.Id, name, running: isRunning, title: 'Inspecter', icon: 'inspect' })}
          ${bag.iconBtn({ title: 'Partager', icon: 'users', info: true, shareType: 'container', shareKey: name || c.Id })}
          ${bag.iconBtn({ act: 'remove', id: c.Id, title: 'Supprimer', icon: 'remove', danger: true })}
        </div>`;
      return `<tr class="${rowCls}" data-search="${bag.esc(search)}" data-container-id="${bag.esc(c.Id)}">
        ${all ? '' : bag.bulkSelectTd(c.Id)}
        ${all ? `<td class="muted">${bag.esc(c._nodeName || '—')}</td>` : ''}
        <td class="name-cell">
          <strong><a href="#containers/${bag.esc(c.Id)}" ${all ? `data-switch-node="${bag.esc(c._nodeId)}"` : ''}>${bag.esc(name)}</a></strong>
          <span class="id">${bag.esc(bag.shortId(c.Id))}</span>
        </td>
        <td class="mono cell-clip cell-image" title="${bag.esc(c.Image || '')}">
          <span class="img-with-upd">
            ${all ? '' : `<span class="img-upd-slot" data-cupd="${bag.esc(c.Id)}">
              <span class="img-upd is-loading img-upd-dot-only" title="Vérification de l’image…"><span class="img-upd-dot"></span></span>
            </span>`}
            <span class="img-name">${bag.esc(c.Image || '')}</span>
          </span>
        </td>
        <td>${bag.badge(c.State)}</td>
        <td>${bag.formatPorts(c.Ports || [], c._nodeId || c.EndpointId)}</td>
        <td>${bag.formatCreated(c.Created)}</td>
        <td class="actions">${actions}</td>
      </tr>`;
    }).join('');

    const colSpan = all ? 7 : 8;
    bag.root.innerHTML = bag.shell('Conteneurs', `
      ${bag.pageHeader(all ? 'Conteneurs — tous les nœuds' : 'Liste des conteneurs')}
      ${partial ? `<div class="info-box" style="margin-bottom:12px">Agrégat partiel.${bag.esc(failMsg)}</div>` : ''}
      ${all && perNodeHint ? `<div class="muted" style="margin-bottom:10px">Répartition — ${bag.esc(perNodeHint)}</div>` : ''}
      ${all ? bag.pickNodeGuardHtml() : ''}
      <div class="toolbar">
        <input class="search" id="filter" type="search" placeholder="Rechercher des conteneurs…" value="${bag.esc(bag.state.filters.containers || '')}">
        ${all ? '' : `${bag.createBtn('create-container', 'Créer un conteneur')}${bag.bulkDeleteBtnHtml()}`}
        <div class="spacer"></div>
        ${all ? '' : `<span class="muted" style="font-size:12px">● vert = à jour · ● orange = mise à jour dispo · cache 24 h</span>
        <button type="button" class="btn btn-sm" id="container-upd-refresh" title="Revérifier les images maintenant">Rafraîchir images</button>`}
        <span class="muted mono" id="filter-count">${list.length} / ${list.length}</span>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr>
            ${bag.bulkSelectTh(!all)}
            ${all ? bag.sortTh('Nœud', 'node', 'containers') : ''}
            ${bag.sortTh('Nom', 'name', 'containers')}
            ${bag.sortTh('Image', 'image', 'containers')}
            ${bag.sortTh('État', 'state', 'containers')}
            ${bag.sortTh('Ports publiés', 'ports', 'containers')}
            ${bag.sortTh('Créé', 'created', 'containers')}
            <th>Actions</th>
          </tr></thead>
          <tbody>${rows || `<tr><td colspan="${colSpan}" class="empty">Aucun conteneur</td></tr>`}</tbody>
        </table>
      </div>`, { subtitle: all ? 'Vue agrégée (lecture)' : 'Gérez vos conteneurs Docker' });

    bag.bindRefresh();
    bag.bindShareButtons();
    bag.bindMoreActions();
    bag.bindPagedSearch('containers');
    bag.bindTableSort('containers', () => bag.viewContainers());
    if (!all) {
      bag.bindModalActions();
      document.getElementById('create-container').onclick = () => bag.openCreateContainerModal();
      bag.root.querySelectorAll('[data-act]').forEach((btn) => {
        const act = btn.dataset.act;
        bag.onBusyClick(btn, async (el) => {
          await bag.containerAction(el.dataset.id, act);
        }, {
          confirm: act === 'remove' ? 'Supprimer ce conteneur ?' : null,
          reload: true,
        });
      });
      bag.bindBulkDelete({
        enabled: true,
        confirmOne: () => 'Supprimer ce conteneur ?',
        confirmMany: (n) => `Supprimer ${n} conteneurs ?`,
        deleteOne: (id) => bag.containerAction(id, 'remove'),
        reload: () => bag.viewContainers(),
      });
      document.getElementById('container-upd-refresh')?.addEventListener('click', () => {
        bag.root.querySelectorAll('[data-cupd]').forEach((slot) => {
          slot.innerHTML = `<span class="img-upd is-loading img-upd-dot-only" title="Vérification…"><span class="img-upd-dot"></span></span>`;
        });
        bag.loadContainerUpdateIndicators(true);
      });
      bag.loadContainerUpdateIndicators(false);
      bag.startContainerStatsPoll(list);
    } else {
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
    bag.restoreListFocus();
  }

  bag.loadContainerUpdateIndicators = async function loadContainerUpdateIndicators(refresh = false) {
    if (!refresh) bag.paintCachedUpdateIndicators('containers', 'data-cupd');
    try {
      const data = await bag.Api.containerUpdates(!!refresh);
      const map = data?.Updates || {};
      bag.writeImageUpdateCache('containers', map);
      const fromCache = !!data?.FromCache;
      const checkedAt = Number(data?.CheckedAt || 0);
      Object.keys(map).forEach((id) => {
        const slot = bag.root.querySelector(`[data-cupd="${CSS.escape(String(id))}"]`);
        if (!slot) return;
        const u = map[id] || {};
        const ver = bag.formatImageUpdateVersions(u);
        let title = ver || u.Detail || u.Error || 'Aucun contrôle';
        if (u.Image) title = `${u.Image}\n${title}`;
        if (fromCache && checkedAt) {
          title += `\n(cache · vérifié ${new Date(checkedAt * 1000).toLocaleString()})`;
        }
        slot.innerHTML = bag.stackUpdatePill(u.Status, u.UpdateCount || 0, title, {
          action: 'container',
          id,
          dotOnly: true,
        });
      });
      bag.root.querySelectorAll('[data-cupd] .img-upd.is-loading').forEach((el) => {
        el.className = 'img-upd is-unknown img-upd-dot-only';
        el.title = 'Contrôle indisponible';
      });
      bag.bindImageUpdateActions(bag.root);
    } catch {
      bag.root.querySelectorAll('[data-cupd]').forEach((slot) => {
        slot.innerHTML = bag.stackUpdatePill('unknown', 0, 'Contrôle indisponible', { dotOnly: true });
      });
    }
  }

  bag.viewContainerDetail = async function viewContainerDetail(id, tab) {
    const requested = tab || 'overview';
    const openAsModal = requested === 'logs' || requested === 'console' || requested === 'inspect';
    bag.state.containerTab = openAsModal ? 'overview' : requested;
    const info = await bag.Api.docker(`/containers/${id}/json`);
    const name = (info.Name || '').replace(/^\//, '');
    const ports = bag.portsFromInspect(info);
    const running = String(info.State?.Status || '').toLowerCase() === 'running';
    const tabs = [
      ['overview', 'Aperçu'],
      ['logs', 'Logs conteneur'],
      ['console', 'Console'],
      ['inspect', 'Inspecter'],
    ].map(([t, label]) =>
      `<button class="tab ${bag.state.containerTab === t ? 'active' : ''}" data-tab="${t}">${label}</button>`
    ).join('');

    const body = `
        <div class="panel">
          <dl class="kv">
            <dt>Nom</dt><dd>${bag.esc(name)}</dd>
            <dt>ID</dt><dd class="mono">${bag.esc(info.Id)}</dd>
            <dt>Image</dt><dd class="mono">${bag.esc(info.Config?.Image || '')}</dd>
            <dt>Mise à jour</dt><dd id="container-upd-summary"><span class="img-upd is-loading" title="Vérification…"><span class="img-upd-dot"></span><span class="img-upd-lbl">…</span></span></dd>
            <dt>Statut</dt><dd>${bag.badge(info.State?.Status || '')}</dd>
            <dt>Créé le</dt><dd>${bag.esc(info.Created || '')}</dd>
            <dt>Adresse IP</dt><dd class="mono">${bag.esc(info.NetworkSettings?.IPAddress || Object.values(info.NetworkSettings?.Networks || {})[0]?.IPAddress || '—')}</dd>
            <dt>Ports publiés</dt><dd>${bag.formatPorts(ports, bag.state.endpointId)}</dd>
            <dt>Commande</dt><dd class="mono">${bag.esc((info.Config?.Cmd || []).join(' '))}</dd>
          </dl>
        </div>
        <div class="section-title" style="margin-top:1rem">Topologie</div>
        <p class="muted" style="margin:0 0 10px;font-size:12.5px">Réseaux partagés — volumes montés sur chaque conteneur</p>
        <div id="container-topology"><div class="muted">Chargement du schéma…</div></div>`;

    bag.root.innerHTML = bag.shell(`Conteneur · ${name}`, `
      ${bag.pageHeader(name, false)}
      <div class="toolbar">
        ${bag.iconBtn({ tag: 'a', href: '#containers', title: 'Retour', icon: 'back' })}
        <div class="quick-actions">
          ${bag.iconBtn({ act: 'start', title: 'Démarrer', icon: 'start', success: !running })}
          ${bag.iconBtn({ act: 'stop', title: 'Arrêter', icon: 'stop', danger: running })}
          ${bag.iconBtn({ act: 'restart', title: 'Redémarrer', icon: 'restart' })}
          ${bag.iconBtn({
            modal: 'stats', id, name, running,
            title: running ? 'CPU / RAM / Réseau' : 'Conteneur arrêté',
            icon: 'stats', statsId: id,
            extraClass: running ? 'is-stats-ok' : 'is-stats-off',
          })}
          ${bag.iconBtn({ modal: 'logs', id, name, running, title: 'Logs', icon: 'logs' })}
          ${bag.iconBtn({ modal: 'console', id, name, running, title: 'Console', icon: 'console' })}
          ${bag.iconBtn({ modal: 'inspect', id, name, running, title: 'Inspecter', icon: 'inspect' })}
          ${bag.iconBtn({ title: 'Partager', icon: 'users', info: true, shareType: 'container', shareKey: name || id })}
          ${bag.iconBtn({ act: 'remove', title: 'Supprimer', icon: 'remove', danger: true })}
        </div>
        <div class="spacer"></div>
        ${bag.formatPorts(ports, bag.state.endpointId)}
      </div>
      <div class="tabs">${tabs}</div>
      ${body}
    `, { subtitle: 'Détail du conteneur' });

    bag.bindModalActions();
    bag.bindShareButtons();
    bag.bindMoreActions();
    bag.startContainerStatsPoll([{ Id: id, State: running ? 'running' : 'exited' }]);
    bag.root.querySelectorAll('.tab').forEach((el) => {
      el.onclick = async () => {
        const t = el.dataset.tab;
        if (t === 'logs') {
          await bag.openLogsModal(id, name);
          return;
        }
        if (t === 'console') {
          await bag.openConsoleModal(id, name, running);
          return;
        }
        if (t === 'inspect') {
          await bag.openInspectModal(id, name);
          return;
        }
        location.hash = `#containers/${id}/${t}`;
      };
    });
    bag.root.querySelectorAll('[data-act]').forEach((btn) => {
      bag.onBusyClick(btn, async (el) => {
        const focus = bag.captureListFocus(el);
        await bag.containerAction(id, el.dataset.act);
        if (el.dataset.act === 'remove') {
          location.hash = '#containers';
          return 'navigated';
        }
        bag.rememberListFocus(focus);
        return;
      }, {
        confirm: btn.dataset.act === 'remove' ? 'Supprimer ce conteneur ?' : null,
        reload: btn.dataset.act !== 'remove',
      });
    });
    try {
      const upd = await bag.Api.containerUpdateStatus(id);
      const sum = document.getElementById('container-upd-summary');
      if (sum) {
        sum.innerHTML = bag.stackUpdatePill(
          upd.Status,
          upd.UpdateCount || 0,
          (() => {
            const ver = bag.formatImageUpdateVersions(upd);
            let tip = ver || upd.Detail || `${upd.Checked || 0} contrôle(s)`;
            if (upd.Image) tip = `${upd.Image}\n${tip}`;
            return tip;
          })(),
          { action: 'container', id },
        );
        bag.bindImageUpdateActions(sum);
      }
    } catch (err) {
      const sum = document.getElementById('container-upd-summary');
      if (sum) sum.innerHTML = bag.stackUpdatePill('unknown', 0, err.message || 'Erreur');
    }

    // Schéma réseau (hub) + volumes montés sur chaque carte conteneur
    (async () => {
      const mount = document.getElementById('container-topology');
      if (!mount || typeof bag.renderTopologySectionHtml !== 'function') return;
      try {
        const [netsData, ctrs] = await Promise.all([
          bag.Api.docker('/networks'),
          bag.Api.docker('/containers/json?all=true'),
        ]);
        const networks = Array.isArray(netsData?.Networks) ? netsData.Networks : (Array.isArray(netsData) ? netsData : []);
        let containers = Array.isArray(ctrs) ? ctrs : [];
        // Inject inspect Mounts on the current container
        containers = containers.map((c) => {
          if (!bag.containerIdMatches(c.Id, id)) return c;
          return {
            ...c,
            Mounts: (Array.isArray(info.Mounts) && info.Mounts.length) ? info.Mounts : (c.Mounts || []),
          };
        });
        const listSelf = containers.find((c) => bag.containerIdMatches(c.Id, id)) || info;
        const attached = bag.networksAttachedToContainer(listSelf, networks)
          .filter((n) => String(n.Name || '') !== 'none' && String(n.Driver || '') !== 'null');
        if (!attached.length) {
          mount.innerHTML = `<div class="muted">Aucun réseau Docker attaché</div>`;
          return;
        }
        mount.innerHTML = bag.renderTopologySectionHtml(attached, containers, {
          highlightId: id,
          selfLabel: 'vous',
          showMounts: true,
        });
        bag.bindTopologyClicks(mount);
      } catch (err) {
        mount.innerHTML = `<div class="error-box">${bag.esc(err.message || 'Schéma indisponible')}</div>`;
      }
    })();

    if (requested === 'logs') await bag.openLogsModal(id, name);
    else if (requested === 'console') await bag.openConsoleModal(id, name, running);
    else if (requested === 'inspect') await bag.openInspectModal(id, name);
  }

  bag.setConsoleStatus = function setConsoleStatus(mode, text) {
    const el = document.getElementById('console-status');
    if (!el) return;
    el.classList.remove('is-connected', 'is-busy');
    if (mode) el.classList.add(mode);
    const label = el.querySelector('.label');
    if (label) label.textContent = text;
  }

  bag.setupConsole = function setupConsole(containerId, containerName) {
    const connectBtn = document.getElementById('console-connect');
    const disconnectBtn = document.getElementById('console-disconnect');
    const shellSelect = document.getElementById('shell-bin');
    if (!connectBtn) return;

    bag.onBusyClick(connectBtn, async () => {
      await bag.mountConsole(containerId, containerName);
      connectBtn.disabled = true;
      shellSelect.disabled = true;
      disconnectBtn.disabled = false;
    }, { disableSiblings: false });

    disconnectBtn.onclick = () => {
      bag.closeConsoleSession();
      const wrap = document.getElementById('term');
      if (wrap) {
        wrap.innerHTML = `<div class="console-placeholder" id="console-placeholder">
          <div style="font-size:28px;opacity:.5">⬛</div>
          <p>Déconnecté. Cliquez sur <strong>Connecter</strong> pour une nouvelle session.</p>
        </div>`;
      }
      connectBtn.disabled = false;
      shellSelect.disabled = false;
      disconnectBtn.disabled = true;
      bag.setConsoleStatus('', 'Prêt à connecter');
    };
  }

  bag.closeConsoleSession = function closeConsoleSession() {
    if (bag.state.consoleWs) {
      try { bag.state.consoleWs.close(); } catch (_) {}
      bag.state.consoleWs = null;
    }
    if (bag.state.consoleResizeTimer) {
      clearTimeout(bag.state.consoleResizeTimer);
      bag.state.consoleResizeTimer = null;
    }
    if (bag.state.term) {
      try { bag.state.term.dispose(); } catch (_) {}
      bag.state.term = null;
    }
    bag.state.consoleExecId = null;
  }

  bag.mountConsole = async function mountConsole(containerId, containerName) {
    const wrap = document.getElementById('term');
    if (!wrap) return;
    if (typeof Terminal === 'undefined') {
      wrap.innerHTML = '<div class="error-box" style="margin:12px">Échec du chargement de xterm</div>';
      return;
    }

    bag.closeConsoleSession();
    const placeholder = document.getElementById('console-placeholder');
    if (placeholder) placeholder.remove();
    wrap.innerHTML = '';

    const shellSelect = document.getElementById('shell-bin');
    const shortName = (containerName || bag.shortId(containerId)).replace(/[^a-zA-Z0-9_.-]/g, '') || 'container';

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      fontFamily: '"IBM Plex Mono", "JetBrains Mono", Menlo, Monaco, Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.4,
      letterSpacing: 0.3,
      theme: {
        background: '#0b1220',
        foreground: '#e2e8f0',
        cursor: '#38bdf8',
        cursorAccent: '#0b1220',
        selectionBackground: '#1e3a5f',
        black: '#0b1220',
        red: '#f87171',
        green: '#4ade80',
        yellow: '#fbbf24',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#e2e8f0',
        brightBlack: '#64748b',
        brightRed: '#fca5a5',
        brightGreen: '#86efac',
        brightYellow: '#fde68a',
        brightBlue: '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9',
        brightWhite: '#f8fafc',
      },
      convertEol: true,
      allowTransparency: false,
      scrollback: 8000,
    });

    let fit = null;
    try {
      const FitCtor = (window.FitAddon && window.FitAddon.FitAddon)
        || (window.FitAddon && window.FitAddon.prototype ? window.FitAddon : null);
      if (FitCtor) {
        fit = new FitCtor();
        term.loadAddon(fit);
      }
    } catch (_) {}

    term.open(wrap);
    if (fit) {
      fit.fit();
      requestAnimationFrame(() => { try { fit.fit(); } catch (_) {} });
    }
    bag.state.term = term;
    term.focus();

    bag.setConsoleStatus('is-busy', 'Création de la session…');
    let session;
    try {
      session = await bag.Api.createConsoleSession(containerId, {
        shell: shellSelect?.value || '/bin/sh',
        cols: Math.max(40, term.cols || 120),
        rows: Math.max(10, term.rows || 40),
      });
    } catch (err) {
      term.writeln(`\x1b[31m${err.message || err}\x1b[0m`);
      bag.setConsoleStatus('', 'Erreur');
      throw err;
    }

    const execId = session.Id || session.id;
    const ticket = session.Token || session.token;
    const endpointId = session.EndpointId || bag.Api.getEndpointId();
    bag.state.consoleExecId = execId;

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${location.host}/api/websocket/exec?id=${encodeURIComponent(execId)}&endpointId=${encodeURIComponent(endpointId)}&token=${encodeURIComponent(ticket)}`;

    bag.setConsoleStatus('is-busy', 'Connexion WebSocket…');
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    bag.state.consoleWs = ws;

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Délai de connexion WebSocket dépassé')), 15000);
      ws.onopen = () => { clearTimeout(t); resolve(); };
      ws.onerror = () => { clearTimeout(t); reject(new Error('Échec WebSocket (proxy Upgrade ?)')); };
    });

    term.writeln(`\x1b[90mConnecté à ${shortName} via ${session.Shell || shellSelect?.value || '/bin/sh'} (TTY)\x1b[0m`);
    bag.setConsoleStatus('is-connected', `Connecté · ${session.Shell || shellSelect?.value || '/bin/sh'}`);

    const sendResize = () => {
      const h = Math.max(10, term.rows || 40);
      const w = Math.max(40, term.cols || 120);
      bag.Api.resizeConsole(execId, h, w).catch(() => {});
    };
    sendResize();

    ws.onmessage = (ev) => {
      if (!bag.state.term) return;
      if (typeof ev.data === 'string') {
        term.write(ev.data);
        return;
      }
      const bytes = new Uint8Array(ev.data);
      let s = '';
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      term.write(s);
    };
    ws.onclose = () => {
      bag.state.consoleWs = null;
      if (bag.state.term) {
        term.writeln('\r\n\x1b[33m[session terminée]\x1b[0m');
        bag.setConsoleStatus('', 'Déconnecté');
      }
    };
    ws.onerror = () => {
      term.writeln('\r\n\x1b[31m[erreur WebSocket]\x1b[0m');
    };

    term.onData((data) => {
      if (!bag.state.consoleWs || bag.state.consoleWs.readyState !== WebSocket.OPEN) return;
      bag.state.consoleWs.send(data);
    });

    const onResize = () => {
      try { fit && fit.fit(); } catch (_) {}
      if (bag.state.consoleResizeTimer) clearTimeout(bag.state.consoleResizeTimer);
      bag.state.consoleResizeTimer = setTimeout(sendResize, 120);
    };
    window.addEventListener('resize', onResize);
    const modalEl = wrap.closest('.modal-workspace');
    if (modalEl) modalEl.addEventListener('wm-modal-resize', onResize);
    term.onResize?.(() => {
      if (bag.state.consoleResizeTimer) clearTimeout(bag.state.consoleResizeTimer);
      bag.state.consoleResizeTimer = setTimeout(sendResize, 120);
    });

    term.onDispose?.(() => {
      window.removeEventListener('resize', onResize);
      if (bag.state.consoleWs) {
        try { bag.state.consoleWs.close(); } catch (_) {}
        bag.state.consoleWs = null;
      }
    });
  }

  bag.containerAction = async function containerAction(id, act) {
    if (act === 'start') await bag.Api.docker(`/containers/${id}/start`, { method: 'POST' });
    if (act === 'stop') await bag.Api.docker(`/containers/${id}/stop`, { method: 'POST' });
    if (act === 'restart') await bag.Api.docker(`/containers/${id}/restart`, { method: 'POST' });
    if (act === 'remove') await bag.Api.docker(`/containers/${id}?force=true`, { method: 'DELETE' });
  }

  bag.parseLogTimestamp = function parseLogTimestamp(line) {
    const s = line.charCodeAt(0) === 0x1e ? line.slice(1) : line;
    const m = s.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s/);
    return m ? m[1] : null;
  }

  bag.stripLogAnnotations = function stripLogAnnotations(text) {
    return String(text || '').replace(/\x1e/g, '');
  }

  /**
   * Infer a log severity from common formats (syslog, docker, logfmt, JSON, brackets…).
   * Returns: fatal | error | warn | info | debug | success | null
   */

  bag.detectLogLevel = function detectLogLevel(line, fromStderr) {
    const s = String(line || '');
    if (!s) return fromStderr ? 'error' : null;

    // Structured / keyed levels first (most reliable)
    let m = s.match(/(?:^|[^\w])(?:level|severity|severityname|severity_name|severityNum|severity_num|sev|severityity)\s*[=:]\s*"?([a-zA-Z]+)"?/i);
    if (m) {
      const lvl = bag.classifyLevelToken(m[1]);
      if (lvl) return lvl;
    }
    m = s.match(/"level"\s*:\s*"([^"]+)"/i);
    if (m) {
      const lvl = bag.classifyLevelToken(m[1]);
      if (lvl) return lvl;
    }

    // Bracket / angle / paren tokens: [ERROR], <warn>, (INFO)
    m = s.match(/[\[(<]\s*(FATAL|CRIT(?:ICAL)?|PANIC|EMERG(?:ENCY)?|ALERT|ERROR|ERR|SEVERE|WARN(?:ING)?|INFO(?:RMATION)?|NOTICE|DEBUG|TRACE|VERBOSE|SUCCESS|OK)\s*[\])>]/i);
    if (m) {
      const lvl = bag.classifyLevelToken(m[1]);
      if (lvl) return lvl;
    }

    // Timestamp-prefixed: 2024-01-01T12:00:00Z ERROR …  |  Jan 01 12:00:00 host ERROR …
    m = s.match(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\s+(?:[\[(<])?\s*(FATAL|CRIT(?:ICAL)?|PANIC|EMERG(?:ENCY)?|ALERT|ERROR|ERR|SEVERE|WARN(?:ING)?|INFO(?:RMATION)?|NOTICE|DEBUG|TRACE|VERBOSE)\b/i);
    if (m) {
      const lvl = bag.classifyLevelToken(m[1]);
      if (lvl) return lvl;
    }

    // Standalone token near start of line (after optional time / pid)
    const head = s.slice(0, 160);
    m = head.match(/(?:^|[\s|:\[\]])(FATAL|CRITICAL|PANIC|EMERGENCY|ALERT|ERROR|SEVERE|WARNING|WARN|INFORMATION|INFO|NOTICE|DEBUG|TRACE|VERBOSE|SUCCESS)\b(?=[\s|:\]\)>,-]|$)/i);
    if (m) {
      const lvl = bag.classifyLevelToken(m[1]);
      if (lvl) return lvl;
    }

    // Fallback heuristics on free text (avoid false positives on “info” alone)
    if (/\b(?:exception|traceback|stack\s*trace|fatal\s+error|segmentation\s+fault)\b/i.test(s)) return 'error';
    if (/\b(?:failed|failure|cannot|unable to)\b/i.test(s) && /\b(?:error|err)\b/i.test(s)) return 'error';

    if (fromStderr) return 'error';
    return null;
  }

  bag.classifyLevelToken = function classifyLevelToken(tok) {
    const t = String(tok || '').toLowerCase();
    if (['fatal', 'crit', 'critical', 'panic', 'emerg', 'emergency', 'alert', 'severe'].includes(t)) return 'fatal';
    if (['error', 'err', 'errr'].includes(t)) return 'error';
    if (['warn', 'warning'].includes(t)) return 'warn';
    if (['info', 'information', 'notice'].includes(t)) return 'info';
    if (['debug', 'trace', 'verbose'].includes(t)) return 'debug';
    if (['success', 'ok'].includes(t)) return 'success';
    return null;
  }

  bag.renderLogLines = function renderLogLines(text, filter) {
    const raw = String(text || '');
    if (!raw) {
      return '<div class="log-empty">(aucun journal)</div>';
    }
    const q = (filter || '').trim().toLowerCase();
    const lines = raw.split(/\r\n|\n|\r/);
    let html = '';
    let shown = 0;
    for (const line of lines) {
      if (line === '' && shown === 0 && lines.length === 1) continue;
      const fromStderr = line.charCodeAt(0) === 0x1e;
      const clean = fromStderr ? line.slice(1) : line;
      if (q && !clean.toLowerCase().includes(q)) continue;
      shown += 1;
      const level = bag.detectLogLevel(clean, fromStderr);
      const cls = level ? `log-line log-${level}` : 'log-line';
      if (q) {
        const idx = clean.toLowerCase().indexOf(q);
        const before = bag.esc(clean.slice(0, idx));
        const match = bag.esc(clean.slice(idx, idx + q.length));
        const after = bag.esc(clean.slice(idx + q.length));
        html += `<div class="${cls}">${before}<mark class="log-hit">${match}</mark>${after}</div>`;
      } else {
        html += `<div class="${cls}">${bag.esc(clean)}</div>`;
      }
    }
    if (!shown) {
      return `<div class="log-empty">Aucun résultat pour « ${bag.esc(filter)} »</div>`;
    }
    return html;
  }

  bag.downloadTextFile = function downloadTextFile(filename, text) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

}
