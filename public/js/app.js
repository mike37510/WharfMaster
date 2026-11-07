(() => {
  const root = document.getElementById('app');
  const THEME_KEY = 'dm_theme';

  function readTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
    return 'dark';
  }

  function applyTheme(theme) {
    const t = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem(THEME_KEY, t);
    return t;
  }

  applyTheme(readTheme());

  const state = {
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
      dashboard: '',
    },
    theme: readTheme(),
    containerTab: 'overview',
    logTimer: null,
    term: null,
    publicUrl: '',
    dashFilter: 'all',
    engineVersion: '',
    alerts: [],
    dockerOnline: true,
    alertTimer: null,
    dismissedAlerts: new Set(JSON.parse(localStorage.getItem('dm_dismissed_alerts') || '[]')),
  };

  function matchQuery(q, ...parts) {
    if (!q) return true;
    const hay = parts.map((p) => String(p ?? '').toLowerCase()).join(' ');
    return hay.includes(q);
  }

  function searchBar(key, placeholder, shown, total, createHtml = '') {
    return `
      <div class="toolbar">
        <input class="search" id="filter" type="search" placeholder="${esc(placeholder)}" value="${esc(state.filters[key] || '')}">
        ${createHtml}
        <div class="spacer"></div>
        <span class="muted mono" id="filter-count">${shown} / ${total}</span>
      </div>`;
  }

  function createBtn(elId, label, title = label) {
    return `<button type="button" class="btn btn-info btn-create" id="${esc(elId)}" title="${esc(title)}">
      <span class="btn-ico">${ico('plus')}</span><span>${esc(label)}</span>
    </button>`;
  }

  function parseImageRef(ref) {
    const raw = String(ref || '').trim();
    if (!raw) return { fromImage: '', tag: 'latest' };
    if (raw.includes('@')) {
      const [fromImage, digest] = raw.split('@');
      return { fromImage, tag: digest ? `@${digest}` : 'latest' };
    }
    const idx = raw.lastIndexOf(':');
    if (idx > 0 && !raw.slice(idx + 1).includes('/')) {
      return { fromImage: raw.slice(0, idx), tag: raw.slice(idx + 1) || 'latest' };
    }
    return { fromImage: raw, tag: 'latest' };
  }

  function parsePortBindings(portsText) {
    const ExposedPorts = {};
    const PortBindings = {};
    String(portsText || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean).forEach((line) => {
      // host:container[/proto] or container[/proto]
      const m = line.match(/^(?:(\d+(?:-\d+)?):)?(\d+(?:-\d+)?)(?:\/(tcp|udp|sctp))?$/i);
      if (!m) return;
      const proto = (m[3] || 'tcp').toLowerCase();
      const containerPort = `${m[2]}/${proto}`;
      ExposedPorts[containerPort] = {};
      if (m[1]) {
        PortBindings[containerPort] = [{ HostPort: String(m[1]) }];
      } else {
        PortBindings[containerPort] = [{}];
      }
    });
    return { ExposedPorts, PortBindings };
  }

  function formatPullCount(n) {
    const v = Number(n) || 0;
    if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
    return String(v);
  }

  function imageSearchFieldsHtml(prefix) {
    return `
      <div class="img-search" id="${prefix}-img-wrap">
        <input id="${prefix}-image-q" type="search" placeholder="Rechercher une image (ex. nginx, redis…)" autocomplete="off" spellcheck="false">
        <div class="img-search-panel" id="${prefix}-image-panel" hidden>
          <div class="img-search-hint muted" id="${prefix}-image-hint">Saisissez au moins 1 caractère…</div>
          <div id="${prefix}-image-results"></div>
        </div>
      </div>
      <div class="img-selected" id="${prefix}-image-sel" hidden>
        <span class="img-selected-badge" id="${prefix}-image-badge">Local</span>
        <code class="mono" id="${prefix}-image-ref"></code>
        <button type="button" class="icon-btn img-selected-clear" id="${prefix}-image-clear" title="Changer d’image" aria-label="Changer">✕</button>
      </div>
      <div class="form-group" id="${prefix}-tag-wrap" hidden style="margin-top:12px;margin-bottom:0">
        <label class="field-label">Tag</label>
        <select id="${prefix}-tag" class="select-block"></select>
      </div>`;
  }

  function bindImageSearchPicker(prefix, modalRoot) {
    let selectedImage = '';
    let selectedSource = '';
    let searchTimer = null;
    let searchSeq = 0;
    const qInput = document.getElementById(`${prefix}-image-q`);
    const panel = document.getElementById(`${prefix}-image-panel`);
    const resultsEl = document.getElementById(`${prefix}-image-results`);
    const hintEl = document.getElementById(`${prefix}-image-hint`);
    const selBox = document.getElementById(`${prefix}-image-sel`);
    const selRef = document.getElementById(`${prefix}-image-ref`);
    const selBadge = document.getElementById(`${prefix}-image-badge`);
    const tagWrap = document.getElementById(`${prefix}-tag-wrap`);
    const tagSel = document.getElementById(`${prefix}-tag`);
    const wrap = document.getElementById(`${prefix}-img-wrap`);

    function hidePanel() {
      if (panel) panel.hidden = true;
    }

    function showSelection(ref, source) {
      selectedImage = ref;
      selectedSource = source;
      if (selRef) selRef.textContent = ref;
      if (selBadge) {
        selBadge.textContent = source === 'local' ? 'Local' : 'Docker Hub';
        selBadge.className = 'img-selected-badge' + (source === 'local' ? ' is-local' : ' is-hub');
      }
      if (selBox) selBox.hidden = false;
      if (qInput) qInput.value = '';
      hidePanel();
      wrap?.classList.add('is-picked');
    }

    function clearSelection() {
      selectedImage = '';
      selectedSource = '';
      if (selBox) selBox.hidden = true;
      if (tagWrap) tagWrap.hidden = true;
      if (tagSel) tagSel.innerHTML = '';
      wrap?.classList.remove('is-picked');
      qInput?.focus();
    }

    async function pickLocal(name) {
      showSelection(name, 'local');
      if (tagWrap) tagWrap.hidden = true;
    }

    async function pickHub(repo) {
      showSelection(`${repo}:latest`, 'hub');
      if (tagWrap) tagWrap.hidden = false;
      if (tagSel) tagSel.innerHTML = `<option value="latest">latest</option>`;
      try {
        const data = await Api.imageTags(repo);
        const tags = Array.isArray(data?.Tags) ? data.Tags : [];
        if (!tags.length || !tagSel) return;
        const names = tags.map((t) => t.Name).filter(Boolean);
        if (!names.includes('latest')) names.unshift('latest');
        const uniq = [...new Set(names)];
        tagSel.innerHTML = uniq.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
        tagSel.value = uniq.includes('latest') ? 'latest' : uniq[0];
        selectedImage = `${repo}:${tagSel.value}`;
        if (selRef) selRef.textContent = selectedImage;
      } catch (_) {}
    }

    tagSel?.addEventListener('change', () => {
      if (!selectedImage) return;
      const { fromImage } = parseImageRef(selectedImage);
      selectedImage = `${fromImage}:${tagSel.value || 'latest'}`;
      if (selRef) selRef.textContent = selectedImage;
    });
    document.getElementById(`${prefix}-image-clear`)?.addEventListener('click', clearSelection);

    function renderResults(data, query) {
      const local = Array.isArray(data?.Local) ? data.Local : [];
      const remote = Array.isArray(data?.Remote) ? data.Remote : [];
      if (!local.length && !remote.length) {
        if (hintEl) {
          hintEl.hidden = false;
          hintEl.textContent = `Aucun résultat pour « ${query} »`;
        }
        if (resultsEl) resultsEl.innerHTML = '';
        return;
      }
      if (hintEl) hintEl.hidden = true;
      let html = '';
      if (local.length) {
        html += `<div class="img-search-section">Local</div>`;
        html += local.map((r) => `
          <button type="button" class="img-search-item" data-src="local" data-name="${esc(r.Name)}">
            <span class="img-search-main">
              <span class="img-search-name mono">${esc(r.Name)}</span>
              <span class="img-search-desc muted">${esc(r.Description || 'Image locale')}</span>
            </span>
            <span class="img-search-meta"><span class="img-selected-badge is-local">Local</span></span>
          </button>`).join('');
      }
      if (remote.length) {
        html += `<div class="img-search-section">Docker Hub</div>`;
        html += remote.map((r) => `
          <button type="button" class="img-search-item" data-src="hub" data-name="${esc(r.Name)}">
            <span class="img-search-main">
              <span class="img-search-name mono">${esc(r.Name)}${r.Official ? ' <span class="img-selected-badge is-hub">Officiel</span>' : ''}</span>
              <span class="img-search-desc muted">${esc(r.Description || '')}</span>
            </span>
            <span class="img-search-meta muted">★ ${esc(String(r.StarCount || 0))} · ${esc(formatPullCount(r.PullCount))} pulls</span>
          </button>`).join('');
      }
      if (data?.HubError) {
        html += `<div class="img-search-hint muted">Docker Hub : ${esc(data.HubError)}</div>`;
      }
      if (resultsEl) {
        resultsEl.innerHTML = html;
        resultsEl.querySelectorAll('.img-search-item').forEach((btn) => {
          btn.addEventListener('click', () => {
            const name = btn.getAttribute('data-name') || '';
            const src = btn.getAttribute('data-src') || '';
            if (src === 'local') pickLocal(name);
            else pickHub(name);
          });
        });
      }
    }

    async function runSearch(query) {
      const seq = ++searchSeq;
      const q = query.trim();
      if (!q) {
        if (hintEl) {
          hintEl.hidden = false;
          hintEl.textContent = 'Saisissez au moins 1 caractère…';
        }
        if (resultsEl) resultsEl.innerHTML = '';
        if (panel) panel.hidden = false;
        return;
      }
      if (panel) panel.hidden = false;
      if (hintEl) {
        hintEl.hidden = false;
        hintEl.textContent = 'Recherche…';
      }
      if (resultsEl) resultsEl.innerHTML = '';
      try {
        const data = await Api.searchImages(q);
        if (seq !== searchSeq) return;
        renderResults(data, q);
      } catch (err) {
        if (seq !== searchSeq) return;
        if (hintEl) {
          hintEl.hidden = false;
          hintEl.textContent = err.message || 'Erreur de recherche';
        }
        if (resultsEl) resultsEl.innerHTML = '';
      }
    }

    qInput?.addEventListener('focus', () => {
      if (!selectedImage && panel) panel.hidden = false;
    });
    qInput?.addEventListener('input', () => {
      if (selectedImage) clearSelection();
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => runSearch(qInput.value), 280);
    });
    qInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hidePanel();
    });
    modalRoot?.querySelector('.modal')?.addEventListener('mousedown', (e) => {
      if (wrap && !wrap.contains(e.target)) hidePanel();
    });

    return {
      focus: () => qInput?.focus(),
      getSelected() {
        if (selectedSource === 'hub' && tagSel && tagWrap && !tagWrap.hidden) {
          const { fromImage } = parseImageRef(selectedImage || 'x');
          selectedImage = `${fromImage}:${tagSel.value || 'latest'}`;
          if (selRef) selRef.textContent = selectedImage;
        }
        return { image: selectedImage.trim(), source: selectedSource };
      },
    };
  }

  async function openCreateContainerModal() {
    closeAppModal();
    const host = modalHost();
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
            ${imageSearchFieldsHtml('c')}
          </div>
          <div class="form-group">
            <label class="field-label">Nom</label>
            <input id="c-name" placeholder="mon-conteneur (optionnel)" autocomplete="off">
          </div>
          <div class="form-group">
            <label class="field-label">Ports</label>
            <input id="c-ports" placeholder="8080:80 ou 80 (un par ligne / virgule)" autocomplete="off">
          </div>
          <div class="form-group">
            <div class="field-label-row">
              <label class="field-label">Volumes</label>
              <button type="button" class="btn btn-sm" id="c-vol-add" title="Ajouter un volume">
                <span class="btn-ico">${ico('plus')}</span><span>Ajouter</span>
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
    bindAppModalChrome();
    const imagePicker = bindImageSearchPicker('c', host);
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
        ? volumeNames.map((n) => `<option value="${esc(n)}"${prefill.name === n ? ' selected' : ''}>${esc(n)}</option>`).join('')
        : '<option value="">Aucun volume disponible</option>';
      row.innerHTML = `
        <select class="vol-name select-block" title="Volume Docker" ${volumeNames.length ? '' : 'disabled'}>
          <option value="">Volume…</option>
          ${opts}
        </select>
        <input class="vol-dest" placeholder="/chemin/conteneur" value="${esc(prefill.dest || '')}" autocomplete="off" spellcheck="false">
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
        const data = await Api.docker('/volumes');
        volumeNames = (data?.Volumes || []).map((v) => v.Name).filter(Boolean).sort((a, b) => a.localeCompare(b));
        volListEl?.querySelectorAll('.vol-name').forEach((sel) => {
          const cur = sel.value;
          sel.innerHTML = `<option value="">Volume…</option>`
            + volumeNames.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
          if (cur && volumeNames.includes(cur)) sel.value = cur;
          sel.disabled = volumeNames.length === 0;
        });
      } catch (_) {
        volumeNames = [];
      }
    })();

    imagePicker.focus();
    onBusyClick(document.getElementById('c-save'), async () => {
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
      const { ExposedPorts, PortBindings } = parsePortBindings(document.getElementById('c-ports').value);
      const { binds, errors: volErrors } = collectVolumeBinds();
      if (volErrors.length) {
        errBox.innerHTML = `<div class="error-box">${esc(volErrors.join('\n'))}</div>`;
        return;
      }
      const payload = {
        Image: image,
        HostConfig: {
          PortBindings,
          RestartPolicy: { Name: 'unless-stopped' },
        },
      };
      if (Object.keys(ExposedPorts).length) payload.ExposedPorts = ExposedPorts;
      if (binds.length) payload.HostConfig.Binds = binds;
      if (cmd) payload.Cmd = cmd.split(/\s+/);
      const q = name ? `?name=${encodeURIComponent(name)}` : '';
      try {
        if (source !== 'local') {
          try {
            const { fromImage, tag } = parseImageRef(image);
            await Api.docker(`/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag.replace(/^@/, ''))}`, { method: 'POST' });
          } catch (_) {}
        }
        const created = await Api.docker(`/containers/create${q}`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        if (start && created?.Id) {
          await Api.docker(`/containers/${created.Id}/start`, { method: 'POST' });
        }
        closeAppModal();
        if (location.hash === '#containers/new') location.hash = '#containers';
        else await route();
      } catch (err) {
        errBox.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
      }
    }, { disableSiblings: false, minMs: 300 });
  }

  function defaultDockerfile() {
    return `FROM alpine:latest

LABEL maintainer="docker-manager"

RUN apk add --no-cache curl

WORKDIR /app

CMD ["sh"]
`;
  }

  function formatBuildLog(raw) {
    const lines = String(raw || '').split(/\r?\n/).filter(Boolean);
    const out = [];
    for (const line of lines) {
      try {
        const j = JSON.parse(line);
        if (j.stream) out.push(j.stream.replace(/\n$/, ''));
        else if (j.status) out.push([j.status, j.progress, j.id].filter(Boolean).join(' '));
        else if (j.error) out.push('ERROR: ' + j.error);
        else if (j.aux) out.push(JSON.stringify(j.aux));
        else out.push(line);
      } catch {
        out.push(line);
      }
    }
    return out.join('\n') || '(aucune sortie)';
  }

  async function openBuildImageView(existingName = '') {
    let content = defaultDockerfile();
    let saveName = existingName || '';
    if (existingName) {
      try {
        const df = await Api.dockerfile(existingName);
        content = df.Content || content;
        saveName = df.Name || existingName;
      } catch (_) {}
    }
    let savedList = [];
    try { savedList = await Api.dockerfiles(); } catch (_) {}

    const savedOptions = savedList.map((d) =>
      `<option value="${esc(d.Name)}" ${d.Name === saveName ? 'selected' : ''}>${esc(d.Name)}</option>`
    ).join('');

    root.innerHTML = shell('Builder une image', `
      <div class="build-layout">
        <div class="panel-card">
          <div class="panel-head">
            <h3>Dockerfile</h3>
          </div>
          <div id="build-err"></div>
          <div class="form-group">
            <label class="field-label">Fichier enregistré</label>
            <div class="build-file-row">
              <select id="df-saved" class="select-block" title="Dockerfiles enregistrés">
                <option value="">Nouveau Dockerfile</option>
                ${savedOptions}
              </select>
              ${iconBtn({ elId: 'df-del', title: 'Supprimer le fichier sélectionné', icon: 'remove', danger: true })}
            </div>
          </div>
          <div class="form-row-2">
            <div class="form-group">
              <label class="field-label">Tag de l'image <span class="req">*</span></label>
              <input id="build-tag" placeholder="mon-app:latest" value="${esc(saveName ? `${saveName}:latest` : 'mon-app:latest')}">
            </div>
            <div class="form-group">
              <label class="field-label">Enregistrer sous</label>
              <input id="build-saveas" placeholder="nom-du-dockerfile" value="${esc(saveName)}">
            </div>
          </div>
          <div class="form-group">
            <label class="field-label">Dockerfile</label>
            <textarea id="build-df" class="code-area" spellcheck="false">${esc(content)}</textarea>
          </div>
          <div class="actions-bar" style="margin-top:12px">
            <button type="button" class="btn btn-primary" id="build-run">Compiler (build)</button>
            <button type="button" class="btn" id="build-save">Enregistrer</button>
            <a class="btn" href="#images">Retour</a>
          </div>
        </div>
        <div class="panel-card">
          <div class="panel-head"><h3>Sortie du build</h3></div>
          <pre class="logs build-log" id="build-log">En attente d’un build…</pre>
        </div>
      </div>
    `, { subtitle: 'Écrire un Dockerfile et compiler une image locale' });

    const loadSaved = async (name) => {
      if (!name) {
        document.getElementById('build-df').value = defaultDockerfile();
        document.getElementById('build-saveas').value = '';
        return;
      }
      try {
        const df = await Api.dockerfile(name);
        document.getElementById('build-df').value = df.Content || '';
        document.getElementById('build-saveas').value = df.Name || name;
        const tag = document.getElementById('build-tag');
        if (tag && (!tag.value || tag.value.endsWith(':latest'))) tag.value = `${df.Name || name}:latest`;
      } catch (err) {
        alert(err.message);
      }
    };

    const dfSel = document.getElementById('df-saved');
    const dfDel = document.getElementById('df-del');
    const syncDfDel = () => {
      if (!dfDel) return;
      const hasSaved = !!(dfSel?.value);
      dfDel.disabled = !hasSaved;
      dfDel.style.opacity = hasSaved ? '1' : '0.4';
      dfDel.title = hasSaved ? 'Supprimer le fichier sélectionné' : 'Sélectionnez un fichier enregistré';
    };
    dfSel.onchange = (e) => {
      loadSaved(e.target.value);
      syncDfDel();
    };
    syncDfDel();
    dfDel.onclick = async () => {
      const name = dfSel.value;
      if (!name) return;
      if (!confirm(`Supprimer le Dockerfile « ${name} » ?`)) return;
      try {
        await Api.deleteDockerfile(name);
        location.hash = '#images/build';
        await openBuildImageView();
      } catch (err) { alert(err.message); }
    };

    document.getElementById('build-save').onclick = async () => {
      const errBox = document.getElementById('build-err');
      errBox.innerHTML = '';
      const name = document.getElementById('build-saveas').value.trim();
      const content = document.getElementById('build-df').value;
      if (!name) {
        errBox.innerHTML = `<div class="error-box">Indiquez un nom pour enregistrer le Dockerfile.</div>`;
        return;
      }
      try {
        await Api.saveDockerfile(name, content);
        errBox.innerHTML = `<div class="info-box">Dockerfile « ${esc(name)} » enregistré.</div>`;
        const sel = document.getElementById('df-saved');
        if (sel && ![...sel.options].some((o) => o.value === name)) {
          const opt = document.createElement('option');
          opt.value = name;
          opt.textContent = name;
          sel.appendChild(opt);
        }
        if (sel) sel.value = name;
      } catch (err) {
        errBox.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
      }
    };

    onBusyClick(document.getElementById('build-run'), async () => {
      const errBox = document.getElementById('build-err');
      const log = document.getElementById('build-log');
      errBox.innerHTML = '';
      const tag = document.getElementById('build-tag').value.trim();
      const dockerfile = document.getElementById('build-df').value;
      const saveAs = document.getElementById('build-saveas').value.trim();
      if (!tag) {
        errBox.innerHTML = `<div class="error-box">Le tag de l’image est requis.</div>`;
        return;
      }
      log.textContent = 'Build en cours…';
      try {
        const res = await Api.buildImage({ Tag: tag, Dockerfile: dockerfile, SaveAs: saveAs || undefined });
        log.textContent = formatBuildLog(res.Log);
        if (!res.Success) {
          errBox.innerHTML = `<div class="error-box">${esc(res.Error || 'Échec du build')}</div>`;
        } else {
          errBox.innerHTML = `<div class="info-box">Image <code>${esc(tag)}</code> compilée avec succès.</div>`;
        }
        log.scrollTop = log.scrollHeight;
      } catch (err) {
        const raw = err.data?.Log || err.message;
        log.textContent = formatBuildLog(raw);
        errBox.innerHTML = `<div class="error-box">${esc(err.data?.Error || err.message)}</div>`;
      }
    }, { disableSiblings: false, minMs: 400 });
  }

  async function openPullImageModal() {
    closeAppModal();
    const host = modalHost();
    host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-form modal-form-wide" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3>Pull une image</h3>
              <div class="modal-sub">Recherche locale puis Docker Hub</div>
            </div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">✕</button>
          </div>
          <div id="create-err"></div>
          <div class="form-group">
            <label class="field-label">Image <span class="req">*</span></label>
            ${imageSearchFieldsHtml('p')}
          </div>
          <div class="actions-bar">
            <button type="button" class="btn btn-primary" id="i-save">Pull</button>
            <button type="button" class="btn" data-close-modal>Annuler</button>
          </div>
        </div>
      </div>`;
    bindAppModalChrome();
    const imagePicker = bindImageSearchPicker('p', host);
    imagePicker.focus();
    onBusyClick(document.getElementById('i-save'), async () => {
      const errBox = document.getElementById('create-err');
      errBox.innerHTML = '';
      const { image } = imagePicker.getSelected();
      if (!image) {
        errBox.innerHTML = `<div class="error-box">Sélectionnez une image dans les résultats de recherche.</div>`;
        imagePicker.focus();
        return;
      }
      const { fromImage, tag } = parseImageRef(image);
      try {
        await Api.docker(`/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag.replace(/^@/, ''))}`, { method: 'POST' });
        closeAppModal();
        if (location.hash === '#images/pull') location.hash = '#images';
        else await route();
      } catch (err) {
        errBox.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
      }
    }, { disableSiblings: false, minMs: 300 });
  }

  async function openCreateVolumeModal() {
    closeAppModal();
    const host = modalHost();
    host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-form" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div><h3>Créer un volume</h3></div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">✕</button>
          </div>
          <div id="create-err"></div>
          <div class="form-group">
            <label class="field-label">Nom <span class="req">*</span></label>
            <input id="v-name" placeholder="mon-volume" autocomplete="off">
          </div>
          <div class="form-group">
            <label class="field-label">Pilote</label>
            <input id="v-driver" value="local" autocomplete="off">
          </div>
          <div class="actions-bar">
            <button type="button" class="btn btn-primary" id="v-save">Créer</button>
            <button type="button" class="btn" data-close-modal>Annuler</button>
          </div>
        </div>
      </div>`;
    bindAppModalChrome();
    document.getElementById('v-name')?.focus();
    onBusyClick(document.getElementById('v-save'), async () => {
      const errBox = document.getElementById('create-err');
      errBox.innerHTML = '';
      const Name = document.getElementById('v-name').value.trim();
      const Driver = document.getElementById('v-driver').value.trim() || 'local';
      if (!Name) {
        errBox.innerHTML = `<div class="error-box">Le nom est requis.</div>`;
        return;
      }
      try {
        await Api.docker('/volumes/create', { method: 'POST', body: JSON.stringify({ Name, Driver }) });
        closeAppModal();
        await route();
      } catch (err) {
        errBox.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
      }
    }, { disableSiblings: false, minMs: 250 });
  }

  async function openCreateNetworkModal() {
    closeAppModal();
    const host = modalHost();
    host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-form" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div><h3>Créer un réseau</h3></div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">✕</button>
          </div>
          <div id="create-err"></div>
          <div class="form-group">
            <label class="field-label">Nom <span class="req">*</span></label>
            <input id="n-name" placeholder="mon-reseau" autocomplete="off">
          </div>
          <div class="form-group">
            <label class="field-label">Pilote</label>
            <select id="n-driver">
              <option value="bridge" selected>bridge</option>
              <option value="overlay">overlay</option>
              <option value="macvlan">macvlan</option>
              <option value="ipvlan">ipvlan</option>
            </select>
          </div>
          <div class="actions-bar">
            <button type="button" class="btn btn-primary" id="n-save">Créer</button>
            <button type="button" class="btn" data-close-modal>Annuler</button>
          </div>
        </div>
      </div>`;
    bindAppModalChrome();
    document.getElementById('n-name')?.focus();
    onBusyClick(document.getElementById('n-save'), async () => {
      const errBox = document.getElementById('create-err');
      errBox.innerHTML = '';
      const Name = document.getElementById('n-name').value.trim();
      const Driver = document.getElementById('n-driver').value;
      if (!Name) {
        errBox.innerHTML = `<div class="error-box">Le nom est requis.</div>`;
        return;
      }
      try {
        await Api.docker('/networks/create', {
          method: 'POST',
          body: JSON.stringify({ Name, Driver, CheckDuplicate: true }),
        });
        closeAppModal();
        await route();
      } catch (err) {
        errBox.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
      }
    }, { disableSiblings: false, minMs: 250 });
  }

  function bindSearch(key) {
    const input = document.getElementById('filter');
    const table = root.querySelector('table.data tbody');
    if (!input || !table) return;
    const total = table.querySelectorAll('tr[data-search]').length;

    const run = () => {
      const q = input.value.trim().toLowerCase();
      state.filters[key] = input.value;
      let shown = 0;
      table.querySelectorAll('tr[data-search]').forEach((tr) => {
        const ok = !q || tr.getAttribute('data-search').includes(q);
        tr.style.display = ok ? '' : 'none';
        if (ok) shown += 1;
      });
      updateFilterCount(shown, total);
      const empty = table.querySelector('tr.filter-empty');
      if (empty) empty.remove();
      if (shown === 0) {
        const cols = table.parentElement?.querySelectorAll('thead th').length || 4;
        const tr = document.createElement('tr');
        tr.className = 'filter-empty';
        tr.innerHTML = `<td colspan="${cols}" class="empty">Aucun résultat pour “${esc(input.value)}”</td>`;
        table.appendChild(tr);
      }
    };

    let timer = null;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(run, 80);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        input.value = '';
        run();
      }
    });
    if ((state.filters[key] || '').trim()) run();
  }

  function updateFilterCount(shown, total) {
    const el = document.getElementById('filter-count');
    if (el) el.textContent = `${shown} / ${total}`;
  }

  function toggleTheme() {
    state.theme = applyTheme(state.theme === 'dark' ? 'light' : 'dark');
    const btn = document.getElementById('theme-toggle');
    if (btn) btn.textContent = state.theme === 'dark' ? '☀' : '☾';
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('#theme-toggle');
    if (t) {
      e.preventDefault();
      toggleTheme();
    }
  });

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function shortId(id) {
    return String(id || '').replace(/^sha256:/, '').slice(0, 12);
  }

  function stopTimers() {
    if (state.logTimer) {
      clearInterval(state.logTimer);
      state.logTimer = null;
    }
    if (state.term) {
      try { state.term.dispose(); } catch (_) {}
      state.term = null;
    }
  }

  function badge(stateName) {
    const s = String(stateName || '').toLowerCase();
    let cls = 'badge';
    let label = stateName || 'inconnu';
    if (s.includes('running')) { cls += ' badge-running'; label = 'En cours'; }
    else if (s.includes('exit') || s.includes('dead')) { cls += ' badge-exited'; label = 'Arrêté'; }
    else if (s.includes('pause')) { cls += ' badge-paused'; label = 'En pause'; }
    else if (s.includes('creat')) { cls += ' badge-created'; label = 'Créé'; }
    else cls += ' badge-created';
    return `<span class="${cls}">${esc(label)}</span>`;
  }

  function brandMarkImg(cls = 'brand-mark-img') {
    return `<img class="${cls}" src="/public/img/wharfmaster-mark.png" width="40" height="40" alt="" decoding="async">`;
  }

  function brandLogoImg(cls = 'brand-logo-img') {
    return `<img class="${cls}" src="/public/img/wharfmaster-logo.png" alt="WharfMaster" decoding="async">`;
  }

  function sparkline(tone = 'blue') {
    const d = 'M0 20 C12 18, 18 8, 30 12 S48 22, 60 14 S78 4, 100 10';
    const fill = 'M0 28 L0 20 C12 18, 18 8, 30 12 S48 22, 60 14 S78 4, 100 10 L100 28 Z';
    return `<svg class="sparkline ${tone}" viewBox="0 0 100 28" preserveAspectRatio="none"><path class="fill" d="${fill}" fill="currentColor"/><path d="${d}"/></svg>`;
  }

  function gaugeRing(pct, color = '#3b82f6') {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    const r = 34;
    const c = 2 * Math.PI * r;
    const off = c - (p / 100) * c;
    return `<svg viewBox="0 0 84 84">
      <circle cx="42" cy="42" r="${r}" fill="none" stroke="rgba(148,163,184,.15)" stroke-width="7"/>
      <circle cx="42" cy="42" r="${r}" fill="none" stroke="${color}" stroke-width="7"
        stroke-linecap="round" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"
        transform="rotate(-90 42 42)"/>
      <text x="42" y="46" text-anchor="middle" fill="currentColor" font-size="14" font-weight="700">${p.toFixed(0)}%</text>
    </svg>`;
  }

  function formatUptime(status) {
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

  function usageCell(pct, label, kind = 'cpu') {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    let bar = kind === 'mem' ? 'usage-bar mem' : 'usage-bar';
    if (p >= 85) bar += ' danger';
    else if (p >= 65) bar += ' warn';
    return `<div class="usage-cell"><div class="u-val">${esc(label)}</div><div class="${bar}"><span style="width:${p.toFixed(0)}%"></span></div></div>`;
  }

  function computeStats(st, memTotal) {
    const cpuDelta = (st.cpu_stats?.cpu_usage?.total_usage || 0) - (st.precpu_stats?.cpu_usage?.total_usage || 0);
    const sysDelta = (st.cpu_stats?.system_cpu_usage || 0) - (st.precpu_stats?.system_cpu_usage || 0);
    const online = st.cpu_stats?.online_cpus || st.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
    let cpuPct = 0;
    if (sysDelta > 0) cpuPct = (cpuDelta / sysDelta) * online * 100;
    const usage = st.memory_stats?.usage || 0;
    const limit = st.memory_stats?.limit || memTotal || 1;
    const memPct = (usage / limit) * 100;
    return { cpuPct, memPct, memUsage: usage, memLimit: limit };
  }

  function hostBase() {
    const configured = (state.publicUrl || '').trim().replace(/\/$/, '');
    if (configured) return configured;
    const { protocol, hostname } = window.location;
    return `${protocol}//${hostname}`;
  }

  function portHref(pub) {
    const base = hostBase();
    try {
      const u = new URL(base.includes('://') ? base : `https://${base}`);
      // If PublicURL already includes a non-default port, keep host and swap/add published port
      u.port = String(pub);
      return u.toString().replace(/\/$/, '');
    } catch {
      return `${base.replace(/\/$/, '')}:${pub}`;
    }
  }

  function formatPorts(ports) {
    if (!ports || !ports.length) return '<span class="muted">—</span>';
    const seen = new Set();
    const chips = [];
    for (const p of ports) {
      const pub = p.PublicPort || p.publicPort;
      const priv = p.PrivatePort || p.privatePort;
      const type = (p.Type || p.type || 'tcp').toLowerCase();
      if (!priv) continue;
      if (pub) {
        const key = `${pub}:${priv}/${type}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const href = portHref(pub);
        chips.push(
          `<a class="port-link" href="${esc(href)}" target="_blank" rel="noopener" title="${esc(href)}">${esc(pub)}:${esc(priv)}/${esc(type)} ↗</a>`
        );
      } else {
        const key = `${priv}/${type}`;
        if (seen.has(key)) continue;
        seen.add(key);
        chips.push(`<span class="port-chip">${esc(priv)}/${esc(type)}</span>`);
      }
    }
    return chips.length ? `<div class="ports">${chips.join('')}</div>` : '<span class="muted">—</span>';
  }

  function portsFromInspect(info) {
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

  async function ensureSession() {
    if (!Api.getToken()) return false;
    try {
      state.user = await Api.me();
      if (!state.engineVersion) {
        Api.docker('/info').then((info) => {
          if (info?.ServerVersion) state.engineVersion = info.ServerVersion;
        }).catch(() => {});
      }
      return true;
    } catch {
      Api.setToken('');
      state.user = null;
      return false;
    }
  }

  function ico(name) {
    const icons = {
      dashboard: '<svg viewBox="0 0 16 16"><path d="M1 1h6v6H1V1zm8 0h6v6H9V1zM1 9h6v6H1V9zm8 0h6v6H9V9z"/></svg>',
      stacks: '<svg viewBox="0 0 16 16"><path d="M0 4l8-3 8 3-8 3L0 4zm0 4l8 3 8-3v2l-8 3-8-3V8zm0 4l8 3 8-3v2l-8 3-8-3v-2z"/></svg>',
      containers: '<svg viewBox="0 0 16 16"><path d="M1 3h14v2H1V3zm0 4h14v2H1V7zm0 4h14v2H1v-2z"/></svg>',
      images: '<svg viewBox="0 0 16 16"><path d="M1 2h14v12H1V2zm2 2v8h10V4H3zm2 2h2v2H5V6zm4 0h3v1H9V6zm0 2h3v1H9V8z"/></svg>',
      networks: '<svg viewBox="0 0 16 16"><path d="M8 1a3 3 0 110 6 3 3 0 010-6zM2 9a2 2 0 110 4 2 2 0 010-4zm12 0a2 2 0 110 4 2 2 0 010-4zM8 8v2.5M3.5 10.5L6.5 8.5m6 2L9.5 8.5"/></svg>',
      volumes: '<svg viewBox="0 0 16 16"><path d="M3 2h10v12H3V2zm2 2v8h6V4H5z"/></svg>',
      settings: '<svg viewBox="0 0 16 16"><path d="M6.5 1h3l.4 2.1a5 5 0 011.4.8L13.5 3l1.5 2.6-1.7 1.2a5 5 0 010 1.6l1.7 1.2L13.5 13l-2.2-.9a5 5 0 01-1.4.8L9.5 15h-3l-.4-2.1a5 5 0 01-1.4-.8L2.5 13 1 10.4l1.7-1.2a5 5 0 010-1.6L1 6.4 2.5 3.8l2.2.9a5 5 0 011.4-.8L6.5 1zM8 6a2 2 0 100 4 2 2 0 000-4z"/></svg>',
      users: '<svg viewBox="0 0 16 16"><path d="M8 8a3 3 0 100-6 3 3 0 000 6zm-5 6v-1a4 4 0 014-4h2a4 4 0 014 4v1H3zm10-7a2 2 0 100-4 2 2 0 000 4zm1 7v-1a4.9 4.9 0 00-1.5-3.5A4 4 0 0115 13v1h-1z"/></svg>',
      registries: '<svg viewBox="0 0 16 16"><path d="M2 2h12v3H2V2zm0 4.5h12V10H2V6.5zM2 11h12v3H2v-3z"/></svg>',
      about: '<svg viewBox="0 0 16 16"><path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM7.25 5h1.5v1.5h-1.5V5zM7.25 7.5h1.5V11h-1.5V7.5z"/></svg>',
      logout: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2.5H3.5A1.5 1.5 0 002 4v8a1.5 1.5 0 001.5 1.5H6M10.5 11.5L14 8l-3.5-3.5M14 8H6"/></svg>',
      bell: '<svg viewBox="0 0 16 16"><path d="M8 1.75a3.5 3.5 0 00-3.5 3.5v2.1L3.2 9.6A.75.75 0 003.75 11h8.5a.75.75 0 00.55-1.25L11.5 7.35V5.25A3.5 3.5 0 008 1.75zM6.6 12.5a1.4 1.4 0 002.8 0"/></svg>',
      pull: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8M5 7.5L8 10l3-2.5M3 12.5h10"/></svg>',
      clean: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5c1.8-3.2 4.2-5 8-6.5l.8.8c-1.8 3.5-3.5 6-7.2 7.7L4 12.5zM12 4.5l1.8-1.8"/></svg>',
      plus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>',
      edit: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 3.5l3 3L5 14H2v-3L9.5 3.5zM8 5l3 3"/></svg>',
      copy: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.2"/><path d="M10.5 5.5V3.8A1.3 1.3 0 009.2 2.5H3.8A1.3 1.3 0 002.5 3.8v5.4A1.3 1.3 0 003.8 10.5H5.5"/></svg>',
      key: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="5.5" cy="10.5" r="2.5"/><path d="M7.3 8.7L13 3v2.2h2V7H13.2"/></svg>',
      back: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5L5.5 8 10 12.5"/></svg>',
      save: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 3.5h7.2L12.5 5.3V12.5h-9V3.5zM5.5 3.5V6h5V3.5M5.5 9.5h5"/></svg>',
      logs: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3.5 2.5h9v11h-9z"/><path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3"/></svg>',
      activity: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3.5h10v9H3z"/><path d="M5.5 6.5h5M5.5 9h3.5M5.5 11.5h2"/><path d="M11.5 2.5v2"/></svg>',
      console: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 7l2 1.5L5 10M8.5 10h2.5"/></svg>',
      start: '<svg viewBox="0 0 16 16"><path d="M4.5 2.8v10.4L13 8 4.5 2.8z"/></svg>',
      stop: '<svg viewBox="0 0 16 16"><rect x="3.5" y="3.5" width="9" height="9" rx="1.2"/></svg>',
      restart: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M13 8a5 5 0 11-1.3-3.4"/><path d="M13 2.5V6h-3.5" fill="none"/></svg>',
      remove: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3.5 4.5h9M6 4.5V3.2h4v1.3M5.5 4.5l.5 8h4l.5-8M7 7v4M9 7v4"/></svg>',
      inspect: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3.5h6v9H5z"/><path d="M7 6h2M7 8.5h2M7 11h1.5"/><circle cx="11.5" cy="11.5" r="2"/><path d="M13 13l1.5 1.5"/></svg>',
      search: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>',
      folder: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 3.5h4l1.2 1.5H14V13H2V3.5z"/></svg>',
      file: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 2.5h5.5L12 5v8.5H4V2.5z"/><path d="M9.5 2.5V5H12"/></svg>',
      link: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M6.5 9.5l3-3M7 11.5H5.2A2.2 2.2 0 015.2 7H7m2 1.5h1.8a2.2 2.2 0 010 4.4H9"/></svg>',
    };
    return icons[name] || icons.dashboard;
  }

  function iconBtn({
    tag = 'button', href, act, id, title, icon,
    danger = false, info = false, success = false,
    modal, name, running, del, reset, elId, label,
  }) {
    const withLabel = !!(label && String(label).trim());
    const cls = `btn btn-icon btn-sm${withLabel ? ' btn-icon-label' : ''}${danger ? ' btn-danger' : ''}${info ? ' btn-info' : ''}${success ? ' btn-success' : ''}`;
    const attrs = [
      `class="${cls}"`,
      `title="${esc(title)}"`,
      `aria-label="${esc(title)}"`,
      elId ? `id="${esc(elId)}"` : '',
      act ? `data-act="${esc(act)}"` : '',
      id ? `data-id="${esc(id)}"` : '',
      href ? `href="${href}"` : '',
      modal ? `data-modal="${esc(modal)}"` : '',
      name ? `data-name="${esc(name)}"` : '',
      running != null ? `data-running="${running ? '1' : '0'}"` : '',
      del != null ? `data-del="${esc(del)}"` : '',
      reset != null ? `data-reset="${esc(reset)}"` : '',
      tag === 'button' ? 'type="button"' : '',
    ].filter(Boolean).join(' ');
    const labelHtml = withLabel ? `<span class="btn-label">${esc(label)}</span>` : '';
    return `<${tag} ${attrs}><span class="btn-ico">${ico(icon)}</span>${labelHtml}</${tag}>`;
  }

  function modalHost() {
    let el = document.getElementById('app-modal');
    if (!el) {
      el = document.createElement('div');
      el.id = 'app-modal';
      document.body.appendChild(el);
    }
    return el;
  }

  function closeAppModal() {
    if (state.logTimer) {
      clearInterval(state.logTimer);
      state.logTimer = null;
    }
    if (state.term) {
      try { state.term.dispose(); } catch (_) {}
      state.term = null;
    }
    const host = document.getElementById('app-modal');
    if (host) host.innerHTML = '';
  }

  function bindAppModalChrome() {
    const host = modalHost();
    host.querySelectorAll('[data-close-modal]').forEach((el) => {
      el.onclick = (e) => {
        e.preventDefault();
        closeAppModal();
      };
    });
    const backdrop = host.querySelector('.modal-backdrop');
    if (backdrop) {
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) closeAppModal();
      });
    }
  }

  /** Simple name prompt modal. Resolves string or null if cancelled. */
  function promptName({ title, label, value = '', confirmLabel = 'OK', placeholder = '' } = {}) {
    return new Promise((resolve) => {
      closeAppModal();
      const host = modalHost();
      host.innerHTML = `
        <div class="modal-backdrop">
          <div class="modal modal-form" role="dialog" aria-modal="true">
            <div class="modal-head">
              <div><h3>${esc(title || 'Saisie')}</h3></div>
              <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">✕</button>
            </div>
            <form id="prompt-name-form">
              <div class="form-group">
                <label>${esc(label || 'Nom')}</label>
                <input id="prompt-name-input" type="text" required maxlength="255" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off">
              </div>
              <div class="actions-bar">
                <button type="submit" class="btn btn-primary">${esc(confirmLabel)}</button>
                <button type="button" class="btn" data-close-modal>Annuler</button>
              </div>
            </form>
          </div>
        </div>`;
      bindAppModalChrome();
      const input = document.getElementById('prompt-name-input');
      const form = document.getElementById('prompt-name-form');
      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        closeAppModal();
        resolve(val);
      };
      host.querySelectorAll('[data-close-modal]').forEach((el) => {
        el.addEventListener('click', () => finish(null));
      });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const v = (input.value || '').trim();
        if (!v) return;
        finish(v);
      });
      input.focus();
      input.select();
    });
  }

  function hideVolContextMenu() {
    const el = document.getElementById('vol-ctx');
    if (el) el.remove();
  }

  function showVolContextMenu(x, y, items) {
    hideVolContextMenu();
    const menu = document.createElement('div');
    menu.id = 'vol-ctx';
    menu.className = 'vol-ctx';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = items.map((it) => {
      if (it === '—') return '<div class="vol-ctx-sep" role="separator"></div>';
      const danger = it.danger ? ' is-danger' : '';
      const disabled = it.disabled ? ' is-disabled' : '';
      return `<button type="button" class="vol-ctx-item${danger}${disabled}" role="menuitem" data-act="${esc(it.id)}" ${it.disabled ? 'disabled' : ''}>${esc(it.label)}</button>`;
    }).join('');
    document.body.appendChild(menu);
    const pad = 8;
    const rect = menu.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + rect.width > window.innerWidth - pad) left = window.innerWidth - rect.width - pad;
    if (top + rect.height > window.innerHeight - pad) top = window.innerHeight - rect.height - pad;
    if (left < pad) left = pad;
    if (top < pad) top = pad;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    const onDoc = (ev) => {
      if (!menu.contains(ev.target)) {
        hideVolContextMenu();
        document.removeEventListener('mousedown', onDoc, true);
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('scroll', onDoc, true);
      }
    };
    const onKey = (ev) => {
      if (ev.key === 'Escape') {
        hideVolContextMenu();
        document.removeEventListener('mousedown', onDoc, true);
        document.removeEventListener('keydown', onKey, true);
      }
    };
    setTimeout(() => {
      document.addEventListener('mousedown', onDoc, true);
      document.addEventListener('keydown', onKey, true);
      document.addEventListener('scroll', onDoc, true);
    }, 0);
    return menu;
  }

  function bindModalActions(scope = root) {
    scope.querySelectorAll('[data-modal]').forEach((btn) => {
      btn.onclick = async (e) => {
        e.preventDefault();
        const id = btn.dataset.id;
        const name = btn.dataset.name || shortId(id);
        const running = btn.dataset.running === '1';
        if (btn.dataset.modal === 'logs') await openLogsModal(id, name);
        else if (btn.dataset.modal === 'console') await openConsoleModal(id, name, running);
        else if (btn.dataset.modal === 'inspect') await openInspectModal(id, name);
      };
    });
  }

  async function openInspectModal(id, name) {
    closeAppModal();
    const host = modalHost();
    host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-xl modal-inspect" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3>Inspecter</h3>
              <div class="modal-sub mono">${esc(name)} · ${esc(shortId(id))}</div>
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
    bindAppModalChrome();
    const view = document.getElementById('inspect-view');
    const meta = document.getElementById('inspect-meta');
    let rawJson = '';
    const load = async () => {
      try {
        const info = await Api.docker(`/containers/${id}/json`);
        const resolved = (info.Name || '').replace(/^\//, '') || name;
        name = resolved;
        const sub = host.querySelector('.modal-sub');
        if (sub) sub.textContent = `${resolved} · ${shortId(id)}`;
        rawJson = JSON.stringify(info, null, 2);
        view.textContent = rawJson;
        if (meta) meta.textContent = `${formatBytes(rawJson.length)} · JSON`;
      } catch (err) {
        rawJson = '';
        view.textContent = err.message;
        if (meta) meta.textContent = 'Erreur';
      }
    };
    await load();
    onBusyClick(document.getElementById('inspect-refresh'), load, { disableSiblings: false, minMs: 200 });
    document.getElementById('inspect-copy')?.addEventListener('click', async () => {
      if (!rawJson) return;
      try { await navigator.clipboard.writeText(rawJson); } catch (_) {}
    });
  }

  function parseLogTimestamp(line) {
    const s = line.charCodeAt(0) === 0x1e ? line.slice(1) : line;
    const m = s.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s/);
    return m ? m[1] : null;
  }

  function stripLogAnnotations(text) {
    return String(text || '').replace(/\x1e/g, '');
  }

  function renderLogLines(text, filter) {
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
      const isErr = line.charCodeAt(0) === 0x1e;
      const clean = isErr ? line.slice(1) : line;
      if (q && !clean.toLowerCase().includes(q)) continue;
      shown += 1;
      const cls = isErr ? 'log-line log-err' : 'log-line';
      if (q) {
        const idx = clean.toLowerCase().indexOf(q);
        const before = esc(clean.slice(0, idx));
        const match = esc(clean.slice(idx, idx + q.length));
        const after = esc(clean.slice(idx + q.length));
        html += `<div class="${cls}">${before}<mark class="log-hit">${match}</mark>${after}</div>`;
      } else {
        html += `<div class="${cls}">${esc(clean)}</div>`;
      }
    }
    if (!shown) {
      return `<div class="log-empty">Aucun résultat pour « ${esc(filter)} »</div>`;
    }
    return html;
  }

  function downloadTextFile(filename, text) {
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

  async function openLogsModal(id, name) {
    closeAppModal();
    const host = modalHost();
    const safeName = String(name || id).replace(/[^\w.-]+/g, '_');
    host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-xl modal-logs" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3>Logs conteneur</h3>
              <div class="modal-sub mono">${esc(name)} · ${esc(shortId(id))}</div>
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
    bindAppModalChrome();

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
        view.innerHTML = `<div class="log-empty log-error">${esc(session.err)}</div>`;
        return;
      }
      view.innerHTML = renderLogLines(session.buffer, filter);
      if (session.stickBottom) view.scrollTop = view.scrollHeight;
    };

    const advanceCursor = (chunk) => {
      const lines = String(chunk || '').split(/\r\n|\n|\r/);
      for (const line of lines) {
        if (!line) continue;
        const iso = parseLogTimestamp(line);
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
        const text = await Api.containerLogs(id, opts);
        session.err = null;
        if (incremental && session.buffer && opts.since) {
          if (text) {
            const incoming = String(text);
            const filtered = incoming.split(/\r\n|\n|\r/).filter((line) => {
              if (!line) return false;
              const iso = parseLogTimestamp(line);
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

    onBusyClick(document.getElementById('refresh-logs'), async () => {
      session.lastIso = null;
      await fetchLogs({ incremental: false });
    }, { disableSiblings: false, minMs: 200 });

    document.getElementById('copy-logs')?.addEventListener('click', async () => {
      const plain = stripLogAnnotations(session.buffer);
      try {
        await navigator.clipboard.writeText(plain);
        setStatus(followEl?.checked ? 'is-live' : 'is-paused', 'Copié dans le presse-papiers');
      } catch (_) {
        setStatus('is-error', 'Impossible de copier');
      }
    });

    document.getElementById('download-logs')?.addEventListener('click', () => {
      downloadTextFile(`${safeName}-logs.txt`, stripLogAnnotations(session.buffer));
    });

    await fetchLogs({ incremental: false });
    if (state.logTimer) {
      clearInterval(state.logTimer);
      state.logTimer = null;
    }
    state.logTimer = setInterval(() => {
      if (!followEl?.checked) return;
      fetchLogs({ incremental: !!tsEl?.checked && !!session.lastIso });
    }, 1800);
  }

  async function openConsoleModal(id, name, runningHint) {
    closeAppModal();
    let running = !!runningHint;
    if (runningHint == null) {
      try {
        const info = await Api.docker(`/containers/${id}/json`);
        running = String(info.State?.Status || '').toLowerCase() === 'running';
        name = (info.Name || '').replace(/^\//, '') || name;
      } catch (_) {}
    }
    const host = modalHost();
    host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-xl modal-console" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3>Console</h3>
              <div class="modal-sub mono">${esc(name)} · ${esc(shortId(id))}</div>
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
            <div class="console-hint">Console exec · Entrée exécute chaque commande · Builtins : clear, cd, pwd</div>
          </div>
        </div>
      </div>`;
    bindAppModalChrome();
    if (running) setupConsole(id, name);
  }

  function pageHeader(_title, withRefresh = true) {
    if (!withRefresh) return '';
    return `<div class="page-header page-header-tools">
      <button class="refresh" id="refresh" title="Actualiser">↻</button>
    </div>`;
  }

  function shell(title, bodyHtml, opts = {}) {
    const subtitle = opts.subtitle || '';
    const hidePageHeader = !!opts.hidePageHeader;
    const items = [
      ['dashboard', 'Tableau de bord'],
      ['containers', 'Conteneurs'],
      ['images', 'Images'],
      ['volumes', 'Volumes'],
      ['networks', 'Réseaux'],
      ['stacks', 'Stacks'],
      ['registries', 'Registres'],
      ['activity', 'Journaux'],
      ['settings', 'Paramètres'],
    ];
    if (Number(state.user?.Role) === 1) items.push(['users', 'Utilisateurs']);
    const nav = items.map(([id, label]) =>
      `<a href="#${id}" class="${state.route === id || state.route.startsWith(id + '/') ? 'active' : ''}"><span class="nav-ico">${ico(id)}</span>${label}</a>`
    ).join('');
    const initial = (state.user?.Username || 'A').slice(0, 2).toUpperCase();
    const username = state.user?.Username || 'admin';
    const engine = state.engineVersion ? `Docker Engine v${state.engineVersion}` : 'Docker Engine';

    return `
      <div class="shell">
        <aside class="sidebar">
          <div class="brand">
            <div class="brand-mark">${brandMarkImg()}</div>
            <div>
              <div class="brand-title">WharfMaster</div>
              <div class="brand-ver">v1.0.2</div>
            </div>
          </div>
          <div class="nav-section">
            <nav class="nav">${nav}</nav>
          </div>
          <div class="sidebar-bottom">
            <nav class="nav">
              <a href="#about"><span class="nav-ico">${ico('about')}</span>À propos</a>
              <a href="#logout"><span class="nav-ico">${ico('logout')}</span>Déconnexion</a>
            </nav>
            <div class="engine-pill">
              <span class="dot"></span>
              <div><strong>${esc(engine)}</strong>Environnement local</div>
            </div>
          </div>
        </aside>
        <div class="main">
          <header class="topbar">
            <div class="topbar-title">
              <h1>${esc(title)}</h1>
              ${subtitle ? `<p class="sub">${esc(subtitle)}</p>` : ''}
            </div>
            <div class="topbar-right">
              <span class="status-online ${state.dockerOnline ? '' : 'is-offline'}" id="status-online">
                <span class="dot"></span>${state.dockerOnline ? 'En ligne' : 'Hors ligne'}
              </span>
              <button type="button" class="theme-toggle" id="theme-toggle" title="Basculer clair / sombre">${state.theme === 'dark' ? '☀' : '☾'}</button>
              <div class="notif-wrap">
                <button type="button" class="icon-btn notif-btn" id="notif-bell" title="Notifications" aria-label="Notifications" aria-expanded="false">
                  ${ico('bell')}
                  <span class="notif-badge" id="notif-badge" ${visibleAlerts().length ? '' : 'hidden'}>${badgeCount(visibleAlerts().length)}</span>
                </button>
                <div class="notif-panel" id="notif-panel" hidden>
                  <div class="notif-panel-head">
                    <strong>Alertes</strong>
                    <button type="button" class="notif-refresh" id="notif-refresh" title="Actualiser">↻</button>
                  </div>
                  <div class="notif-panel-body" id="notif-list">${renderAlertList()}</div>
                </div>
              </div>
              <div class="user-chip" title="${esc(username)}">
                <span class="avatar">${esc(initial)}</span>
              </div>
            </div>
          </header>
          <div class="content">${hidePageHeader ? bodyHtml : bodyHtml}</div>
        </div>
      </div>`;
  }

  function visibleAlerts() {
    return (state.alerts || []).filter((a) => !state.dismissedAlerts.has(a.id));
  }

  function badgeCount(n) {
    return n > 9 ? '9+' : String(n);
  }

  function renderAlertList() {
    const list = visibleAlerts();
    if (!list.length) {
      return `<div class="notif-empty">Aucune alerte pour le moment.</div>`;
    }
    return list.map((a) => `
      <div class="notif-item level-${esc(a.level)}" data-alert-id="${esc(a.id)}">
        <div class="notif-item-main">
          ${a.href ? `<a href="${esc(a.href)}" class="notif-title">${esc(a.title)}</a>` : `<div class="notif-title">${esc(a.title)}</div>`}
          ${a.detail ? `<div class="notif-detail">${esc(a.detail)}</div>` : ''}
        </div>
        <button type="button" class="notif-dismiss" data-dismiss="${esc(a.id)}" title="Ignorer">✕</button>
      </div>
    `).join('');
  }

  function updateAlertUi() {
    const badge = document.getElementById('notif-badge');
    const list = document.getElementById('notif-list');
    const status = document.getElementById('status-online');
    const alerts = visibleAlerts();
    if (badge) {
      badge.hidden = alerts.length === 0;
      badge.textContent = badgeCount(alerts.length);
    }
    if (list) list.innerHTML = renderAlertList();
    if (status) {
      status.classList.toggle('is-offline', !state.dockerOnline);
      status.innerHTML = `<span class="dot"></span>${state.dockerOnline ? 'En ligne' : 'Hors ligne'}`;
    }
    bindAlertDismiss();
  }

  function bindAlertDismiss() {
    document.querySelectorAll('[data-dismiss]').forEach((btn) => {
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        state.dismissedAlerts.add(btn.dataset.dismiss);
        try {
          localStorage.setItem('dm_dismissed_alerts', JSON.stringify([...state.dismissedAlerts].slice(-80)));
        } catch (_) {}
        updateAlertUi();
      };
    });
  }

  function bindAlertUi() {
    const bell = document.getElementById('notif-bell');
    const panel = document.getElementById('notif-panel');
    const refresh = document.getElementById('notif-refresh');
    if (!bell || !panel) return;

    bell.onclick = (e) => {
      e.stopPropagation();
      const open = panel.hasAttribute('hidden');
      panel.hidden = !open;
      bell.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) refreshAlerts();
    };
    if (refresh) {
      refresh.onclick = (e) => {
        e.stopPropagation();
        refreshAlerts();
      };
    }
    bindAlertDismiss();
  }

  async function refreshAlerts() {
    const alerts = [];
    let online = true;
    try {
      const [containers, host, info] = await Promise.all([
        Api.docker('/containers/json?all=true'),
        Api.host().catch(() => null),
        Api.docker('/info').catch(() => null),
      ]);

      if (!info || !info.ServerVersion) {
        online = false;
      } else {
        state.engineVersion = info.ServerVersion;
      }

      const list = containers || [];
      const stopped = list.filter((c) => {
        const s = String(c.State || '').toLowerCase();
        return s !== 'running' && s !== 'restarting' && s !== 'removing';
      });
      const unhealthy = list.filter((c) => String(c.Status || '').toLowerCase().includes('(unhealthy)'));

      if (stopped.length) {
        const names = stopped.slice(0, 4).map((c) =>
          (c.Names && c.Names[0] ? c.Names[0].replace(/^\//, '') : shortId(c.Id))
        );
        alerts.push({
          id: `stopped-${stopped.length}-${stopped.map((c) => shortId(c.Id)).join(',')}`,
          level: 'warn',
          title: `${stopped.length} conteneur${stopped.length > 1 ? 's' : ''} arrêté${stopped.length > 1 ? 's' : ''}`,
          detail: names.join(', ') + (stopped.length > 4 ? '…' : ''),
          href: '#containers',
        });
      }

      unhealthy.forEach((c) => {
        const name = c.Names && c.Names[0] ? c.Names[0].replace(/^\//, '') : shortId(c.Id);
        alerts.push({
          id: `unhealthy-${shortId(c.Id)}`,
          level: 'danger',
          title: `${name} est unhealthy`,
          detail: c.Status || '',
          href: `#containers/${c.Id}`,
        });
      });

      if (host && Number(host.DiskTotal) > 0) {
        const pct = Number(host.DiskUsedPercent) || ((Number(host.DiskUsed) / Number(host.DiskTotal)) * 100);
        if (pct >= 95) {
          alerts.push({
            id: `disk-critical-${Math.floor(pct)}`,
            level: 'danger',
            title: `Disque critique (${pct.toFixed(0)} %)`,
            detail: `${formatBytes(host.DiskUsed)} utilisés sur ${formatBytes(host.DiskTotal)}`,
            href: '#dashboard',
          });
        } else if (pct >= 85) {
          alerts.push({
            id: `disk-warn-${Math.floor(pct)}`,
            level: 'warn',
            title: `Disque presque plein (${pct.toFixed(0)} %)`,
            detail: `${formatBytes(host.DiskUsed)} / ${formatBytes(host.DiskTotal)}`,
            href: '#dashboard',
          });
        }
      }
    } catch (_) {
      online = false;
    }

    if (!online) {
      alerts.unshift({
        id: 'docker-offline',
        level: 'danger',
        title: 'Docker inaccessible',
        detail: 'Impossible de joindre le moteur Docker',
        href: '#dashboard',
      });
    }

    state.dockerOnline = online;
    state.alerts = alerts;
    updateAlertUi();
  }

  function ensureAlertPolling() {
    if (state.alertTimer) return;
    state.alertTimer = setInterval(() => {
      if (state.user) refreshAlerts();
    }, 45000);
  }

  function authView(mode, err) {
    const isInit = mode === 'init';
    return `
      <div class="auth-wrap">
        <form class="auth-card" id="auth-form">
          <div class="logo logo-full">${brandLogoImg('auth-logo-img')}</div>
          <div class="sub">${isInit ? 'Veuillez créer le compte administrateur initial.' : 'Connectez-vous à votre instance WharfMaster.'}</div>
          ${err ? `<div class="error-box">${esc(err)}</div>` : ''}
          <div class="form-group"><label>Nom d'utilisateur</label>
          <input name="username" autocomplete="username" required value="admin"></div>
          <div class="form-group"><label>Mot de passe</label>
          <input name="password" type="password" autocomplete="${isInit ? 'new-password' : 'current-password'}" required minlength="10"></div>
          ${isInit ? `<div class="form-group"><label>Confirmer le mot de passe</label><input name="confirm" type="password" required minlength="10"></div>` : ''}
          <button class="btn btn-primary btn-block" type="submit" style="margin-top:8px">${isInit ? "Créer l'utilisateur" : 'Connexion'}</button>
          <p class="muted" style="margin:14px 0 0;text-align:center;font-size:.9rem"><a href="/">À propos du projet</a></p>
        </form>
      </div>`;
  }

  async function renderAuth() {
    let needInit = false;
    try {
      const check = await Api.adminCheck();
      needInit = !!check.adminInit;
    } catch { needInit = false; }
    root.innerHTML = authView(needInit ? 'init' : 'login', state.error);
    document.getElementById('auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const submitBtn = form.querySelector('button[type="submit"]');
      const fd = new FormData(form);
      const username = String(fd.get('username') || '');
      const password = String(fd.get('password') || '');
      try {
        await withBusy(submitBtn, async () => {
          if (needInit) {
            if (password !== String(fd.get('confirm') || '')) throw new Error('Les mots de passe ne correspondent pas');
            await Api.adminInit(username, password);
          }
          const res = await Api.auth(username, password);
          Api.setToken(res.jwt);
        }, { disableSiblings: false });
        state.error = '';
        await boot();
      } catch (err) {
        state.error = err.message;
        renderAuth();
      }
    });
  }

  async function containerAction(id, act) {
    if (act === 'start') await Api.docker(`/containers/${id}/start`, { method: 'POST' });
    if (act === 'stop') await Api.docker(`/containers/${id}/stop`, { method: 'POST' });
    if (act === 'restart') await Api.docker(`/containers/${id}/restart`, { method: 'POST' });
    if (act === 'remove') await Api.docker(`/containers/${id}?force=true`, { method: 'DELETE' });
  }

  function makeSpinner(extraClass = '') {
    const s = document.createElement('span');
    s.className = 'spinner spinner-abs' + (extraClass ? ' ' + extraClass : '');
    s.setAttribute('aria-hidden', 'true');
    return s;
  }

  /**
   * Show a mini spinner on any action control while an async job runs.
   * Keeps the spinner visible at least ~280ms so fast API calls still flash feedback.
   */
  async function withBusy(btn, fn, opts = {}) {
    if (!btn) return fn();
    if (btn.dataset.busy === '1') return;
    const row = opts.row !== undefined
      ? opts.row
      : (btn.closest('tr') || btn.closest('.quick-actions') || btn.closest('.toolbar') || btn.closest('.actions-bar') || null);
    const siblings = opts.disableSiblings === false
      ? []
      : (row ? Array.from(row.querySelectorAll('button, a.btn, .btn, .refresh')) : []);

    btn.dataset.busy = '1';
    btn.classList.add('is-loading');
    if ('disabled' in btn) btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');

    const spinner = makeSpinner(btn.classList.contains('btn-primary') ? 'spinner-dark' : '');
    btn.appendChild(spinner);

    siblings.forEach((el) => {
      if (el === btn) return;
      if ('disabled' in el) el.disabled = true;
      el.classList.add('is-disabled-temp');
    });
    if (row) row.classList.add('row-busy');

    const started = Date.now();
    try {
      return await fn();
    } finally {
      const wait = Math.max(0, (opts.minMs ?? 280) - (Date.now() - started));
      if (wait) await new Promise((r) => setTimeout(r, wait));
      // Element may have been removed by a re-render
      if (btn.isConnected) {
        spinner.remove();
        btn.classList.remove('is-loading');
        if ('disabled' in btn) btn.disabled = false;
        btn.removeAttribute('aria-busy');
        delete btn.dataset.busy;
      }
      siblings.forEach((el) => {
        if (!el.isConnected) return;
        if ('disabled' in el) el.disabled = false;
        el.classList.remove('is-disabled-temp');
      });
      if (row && row.isConnected) row.classList.remove('row-busy');
    }
  }

  /** Bind click → confirm? → withBusy(fn) → optional reload */
  function onBusyClick(el, handler, opts = {}) {
    if (!el) return;
    el.addEventListener('click', async (e) => {
      e.preventDefault();
      if (opts.confirm && !window.confirm(opts.confirm)) return;
      const target = e.currentTarget;
      try {
        await withBusy(target, () => handler(target, e), opts);
        if (opts.reload) await route();
      } catch (err) {
        alert(err.message || String(err));
      }
    });
  }

  function bindRefresh() {
    const btn = document.getElementById('refresh');
    if (!btn) return;
    onBusyClick(btn, async () => { await route(); }, { disableSiblings: false, minMs: 200 });
  }

  function pctBar(pct) {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    return `<div class="progress"><span style="width:${p.toFixed(1)}%"></span></div>`;
  }

  function formatBytes(n) {
    const v = Number(n) || 0;
    if (v < 1024) return `${v} B`;
    if (v < 1024 ** 2) return `${(v / 1024).toFixed(1)} KB`;
    if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)} MB`;
    return `${(v / 1024 ** 3).toFixed(1)} GB`;
  }

  function pageLoadingHtml(label = 'Chargement…') {
    return `<div class="page-loading" role="status" aria-live="polite">
      <span class="spinner spinner-lg" aria-hidden="true"></span>
      <span class="page-loading-label">${esc(label)}</span>
    </div>`;
  }

  async function viewDashboard() {
    const filter = state.dashFilter || 'all';
    root.innerHTML = shell('Tableau de bord', pageLoadingHtml('Chargement du tableau de bord…'), {
      subtitle: 'Vue d’ensemble de votre environnement Docker',
      hidePageHeader: true,
    });
    const [containers, images, volumes, networks, stacks, info, df, host] = await Promise.all([
      Api.docker('/containers/json?all=true'),
      Api.docker('/images/json'),
      Api.docker('/volumes'),
      Api.docker('/networks'),
      Api.stacks(),
      Api.docker('/info').catch(() => ({})),
      Api.docker('/system/df').catch(() => ({})),
      Api.host().catch(() => ({})),
    ]);
    const list = containers || [];
    const imgs = images || [];
    const volList = volumes.Volumes || [];
    const running = list.filter((c) => String(c.State).toLowerCase() === 'running').length;
    const stopped = list.length - running;
    const memTotal = Number(info.MemTotal) || 0;
    if (info.ServerVersion) state.engineVersion = info.ServerVersion;

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
        const st = await Api.docker(`/containers/${c.Id}/stats?stream=false`);
        const computed = computeStats(st, memTotal);
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
      const name = (c.Names && c.Names[0] ? c.Names[0].replace(/^\//, '') : shortId(c.Id));
      const isRun = String(c.State).toLowerCase() === 'running';
      return `<tr data-search="${esc(`${name} ${c.Image} ${c.State}`.toLowerCase())}">
        <td><a class="name-with-dot" href="#containers/${esc(c.Id)}"><span class="sdot ${isRun ? 'on' : ''}"></span>${esc(name)}</a></td>
        <td class="mono cell-clip" title="${esc(c.Image)}">${esc(c.Image)}</td>
        <td>${badge(c.State)}</td>
        <td class="muted cell-nowrap">${esc(formatUptime(c.Status))}</td>
      </tr>`;
    }).join('');

    const topImages = [...imgs].sort((a, b) => (b.Created || 0) - (a.Created || 0)).slice(0, 5).map((img) => {
      const tags = img.RepoTags && img.RepoTags[0] ? img.RepoTags[0] : '<none>:<none>';
      const age = img.Created ? relativeTime(img.Created * 1000) : '—';
      return `<tr>
        <td class="mono">${esc(tags)}</td>
        <td>${esc(formatBytes(img.Size))}</td>
        <td class="muted">${esc(age)}</td>
      </tr>`;
    }).join('');

    const activity = list.slice(0, 6).map((c) => {
      const name = (c.Names && c.Names[0] ? c.Names[0].replace(/^\//, '') : shortId(c.Id));
      const isRun = String(c.State).toLowerCase() === 'running';
      const txt = isRun ? `Démarrage du conteneur ${name}` : `Arrêt du conteneur ${name}`;
      return `<li>
        <span class="dot ${isRun ? 'green' : 'orange'}"></span>
        <span class="txt">${esc(txt)}</span>
        <span class="when">${esc(formatUptime(c.Status) === '—' ? 'récent' : formatUptime(c.Status))}</span>
      </li>`;
    }).join('');

    root.innerHTML = shell('Tableau de bord', `
      <div class="stat-grid">
        <div class="stat-card">
          <div class="stat-top">
            <div class="stat-ico blue">${ico('containers')}</div>
            <span class="stat-delta">+${Math.min(running, 9)}</span>
          </div>
          <div class="stat-value">${list.length}</div>
          <div class="stat-label">Conteneurs</div>
          ${sparkline('blue')}
        </div>
        <div class="stat-card">
          <div class="stat-top">
            <div class="stat-ico purple">${ico('images')}</div>
            <span class="stat-delta">+0</span>
          </div>
          <div class="stat-value">${imgs.length}</div>
          <div class="stat-label">Images</div>
          ${sparkline('purple')}
        </div>
        <div class="stat-card">
          <div class="stat-top">
            <div class="stat-ico green">${ico('volumes')}</div>
            <span class="stat-delta">+0</span>
          </div>
          <div class="stat-value">${volList.length}</div>
          <div class="stat-label">Volumes</div>
          ${sparkline('green')}
        </div>
        <div class="stat-card">
          <div class="stat-top">
            <div class="stat-ico orange">${ico('networks')}</div>
            <span class="stat-delta">+0</span>
          </div>
          <div class="stat-value">${(networks || []).length}</div>
          <div class="stat-label">Réseaux</div>
          ${sparkline('orange')}
        </div>
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
              <input class="search mini-search" id="filter" type="search" placeholder="Rechercher un conteneur…" value="${esc(state.filters.dashboard || '')}">
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
              <div class="gauge">${gaugeRing(cpuPct, '#3b82f6')}<div class="g-label">CPU</div></div>
              <div class="gauge">${gaugeRing(memPct, '#22c55e')}<div class="g-label">Mémoire</div><div class="g-sub">${formatBytes(memUsage)} / ${formatBytes(memTotal)}</div></div>
              <div class="gauge">${gaugeRing(diskPct, '#fb923c')}<div class="g-label">Disque</div><div class="g-sub">${diskTotal ? `${formatBytes(diskUsed)} / ${formatBytes(diskTotal)}` : '—'}${dockerDisk ? `<div class="g-hint">Docker ${formatBytes(dockerDisk)}</div>` : ''}</div></div>
            </div>
            <svg class="wave-chart" viewBox="0 0 320 88" preserveAspectRatio="none">
              <path d="M0 60 C40 50, 60 30, 100 40 S160 70, 200 45 S260 20, 320 35" fill="none" stroke="#3b82f6" stroke-width="2"/>
              <path d="M0 70 C50 65, 80 50, 120 55 S180 75, 220 58 S280 40, 320 50" fill="none" stroke="#22c55e" stroke-width="2"/>
            </svg>
          </div>

          <div class="panel-card">
            <div class="panel-head"><h3>Activité récente</h3></div>
            <ul class="activity-list">${activity || '<li><span class="txt muted">Aucune activité</span></li>'}</ul>
          </div>

          <div class="panel-card">
            <div class="panel-head"><h3>Actions rapides</h3></div>
            <div class="quick-grid">
              <a class="quick-tile blue" href="#containers/new"><span class="qi">${ico('start')}</span>Créer un conteneur</a>
              <a class="quick-tile purple" href="#stacks/new"><span class="qi">${ico('plus')}</span>Créer une stack</a>
              <a class="quick-tile green" href="#images/build"><span class="qi">${ico('plus')}</span>Dockerfile / Build</a>
              ${Number(state.user?.Role) === 1 ? `<button type="button" class="quick-tile orange" id="dash-prune">
                <span class="qi">${ico('clean')}</span>Nettoyer les orphelins
              </button>` : `<div class="quick-tile muted-tile"><span class="qi">${ico('containers')}</span>Ressources personnelles</div>`}
            </div>
          </div>
        </div>
      </div>
    `, { subtitle: 'Vue d’ensemble de votre environnement Docker', hidePageHeader: true });

    bindSearch('dashboard');
    document.getElementById('dash-filters')?.querySelectorAll('button').forEach((btn) => {
      btn.onclick = () => {
        state.dashFilter = btn.dataset.f;
        route();
      };
    });
    document.getElementById('dash-prune')?.addEventListener('click', () => openPruneOrphansModal());
  }

  async function openPruneOrphansModal() {
    closeAppModal();
    const host = modalHost();
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
    bindAppModalChrome();

    onBusyClick(document.getElementById('prune-run'), async () => {
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
          Api.docker('/containers/prune', { method: 'POST', body: '{}' }),
          Api.docker(`/images/prune${allImages ? '?filters=' + encodeURIComponent(JSON.stringify({ dangling: ['false'] })) : ''}`, {
            method: 'POST',
            body: '{}',
          }),
          Api.docker('/networks/prune', { method: 'POST', body: '{}' }),
          Api.docker('/build/prune', { method: 'POST', body: JSON.stringify({ all: true }) }).catch(() => ({ SpaceReclaimed: 0 })),
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
            Espace récupéré : ${esc(formatBytes(space))}
          </div>`;
        }
      } catch (err) {
        if (errBox) errBox.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
      }
    }, { disableSiblings: false, minMs: 300 });
  }

  function relativeTime(ts) {
    const diff = Math.max(0, Date.now() - ts);
    const min = Math.floor(diff / 60000);
    if (min < 1) return "à l'instant";
    if (min < 60) return `il y a ${min} min`;
    const h = Math.floor(min / 60);
    if (h < 48) return `il y a ${h} h`;
    const d = Math.floor(h / 24);
    return `il y a ${d} j`;
  }

  async function viewContainers() {
    const containers = await Api.docker('/containers/json?all=true');
    const list = containers || [];
    const rows = list.map((c) => {
      const name = (c.Names && c.Names[0] ? c.Names[0].replace(/^\//, '') : shortId(c.Id));
      const search = `${name} ${c.Image} ${c.Id} ${c.State}`.toLowerCase();
      return `<tr data-search="${esc(search)}">
        <td class="name-cell">
          <strong><a href="#containers/${esc(c.Id)}">${esc(name)}</a></strong>
          <span class="id">${esc(shortId(c.Id))}</span>
        </td>
        <td class="mono">${esc(c.Image)}</td>
        <td>${badge(c.State)}</td>
        <td>${formatPorts(c.Ports || [])}</td>
        <td class="actions"><div class="quick-actions">
          ${iconBtn({ modal: 'logs', id: c.Id, name, running: String(c.State).toLowerCase() === 'running', title: 'Logs conteneur', icon: 'logs' })}
          ${iconBtn({ modal: 'console', id: c.Id, name, running: String(c.State).toLowerCase() === 'running', title: 'Console', icon: 'console' })}
          ${iconBtn({ modal: 'inspect', id: c.Id, name, running: String(c.State).toLowerCase() === 'running', title: 'Inspecter', icon: 'inspect' })}
          ${iconBtn({ act: 'start', id: c.Id, title: 'Démarrer', icon: 'start', success: true })}
          ${iconBtn({ act: 'stop', id: c.Id, title: 'Arrêter', icon: 'stop' })}
          ${iconBtn({ act: 'restart', id: c.Id, title: 'Redémarrer', icon: 'restart' })}
          ${iconBtn({ act: 'remove', id: c.Id, title: 'Supprimer', icon: 'remove', danger: true })}
        </div></td>
      </tr>`;
    }).join('');

    root.innerHTML = shell('Conteneurs', `
      ${pageHeader('Liste des conteneurs')}
      ${searchBar('containers', 'Rechercher des conteneurs…', list.length, list.length, createBtn('create-container', 'Créer un conteneur'))}
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>Nom</th><th>Image</th><th>État</th><th>Ports publiés</th><th>Actions</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="5" class="empty">Aucun conteneur</td></tr>`}</tbody>
        </table>
      </div>`, { subtitle: 'Gérez vos conteneurs Docker' });

    bindRefresh();
    bindSearch('containers');
    bindModalActions();
    document.getElementById('create-container').onclick = () => openCreateContainerModal();
    root.querySelectorAll('[data-act]').forEach((btn) => {
      onBusyClick(btn, async (el) => {
        await containerAction(el.dataset.id, el.dataset.act);
      }, {
        confirm: btn.dataset.act === 'remove' ? 'Supprimer ce conteneur ?' : null,
        reload: true,
      });
    });
  }

  async function viewContainerDetail(id, tab) {
    const requested = tab || 'overview';
    const openAsModal = requested === 'logs' || requested === 'console' || requested === 'inspect';
    state.containerTab = openAsModal ? 'overview' : requested;
    const info = await Api.docker(`/containers/${id}/json`);
    const name = (info.Name || '').replace(/^\//, '');
    const ports = portsFromInspect(info);
    const running = String(info.State?.Status || '').toLowerCase() === 'running';
    const tabs = [
      ['overview', 'Aperçu'],
      ['logs', 'Logs conteneur'],
      ['console', 'Console'],
      ['inspect', 'Inspecter'],
    ].map(([t, label]) =>
      `<button class="tab ${state.containerTab === t ? 'active' : ''}" data-tab="${t}">${label}</button>`
    ).join('');

    const body = `
        <div class="panel">
          <dl class="kv">
            <dt>Nom</dt><dd>${esc(name)}</dd>
            <dt>ID</dt><dd class="mono">${esc(info.Id)}</dd>
            <dt>Image</dt><dd>${esc(info.Config?.Image || '')}</dd>
            <dt>Statut</dt><dd>${badge(info.State?.Status || '')}</dd>
            <dt>Créé le</dt><dd>${esc(info.Created || '')}</dd>
            <dt>Adresse IP</dt><dd class="mono">${esc(info.NetworkSettings?.IPAddress || Object.values(info.NetworkSettings?.Networks || {})[0]?.IPAddress || '—')}</dd>
            <dt>Ports publiés</dt><dd>${formatPorts(ports)}</dd>
            <dt>Commande</dt><dd class="mono">${esc((info.Config?.Cmd || []).join(' '))}</dd>
          </dl>
        </div>`;

    root.innerHTML = shell(`Conteneur · ${name}`, `
      ${pageHeader(name, false)}
      <div class="toolbar">
        ${iconBtn({ tag: 'a', href: '#containers', title: 'Retour', icon: 'back' })}
        ${iconBtn({ modal: 'logs', id, name, running, title: 'Logs conteneur', icon: 'logs' })}
        ${iconBtn({ modal: 'console', id, name, running, title: 'Console', icon: 'console' })}
        ${iconBtn({ modal: 'inspect', id, name, running, title: 'Inspecter', icon: 'inspect' })}
        ${iconBtn({ act: 'start', title: 'Démarrer', icon: 'start', success: true })}
        ${iconBtn({ act: 'stop', title: 'Arrêter', icon: 'stop' })}
        ${iconBtn({ act: 'restart', title: 'Redémarrer', icon: 'restart' })}
        ${iconBtn({ act: 'remove', title: 'Supprimer', icon: 'remove', danger: true })}
        <div class="spacer"></div>
        ${formatPorts(ports)}
      </div>
      <div class="tabs">${tabs}</div>
      ${body}
    `, { subtitle: 'Détail du conteneur' });

    bindModalActions();
    root.querySelectorAll('.tab').forEach((el) => {
      el.onclick = async () => {
        const t = el.dataset.tab;
        if (t === 'logs') {
          await openLogsModal(id, name);
          return;
        }
        if (t === 'console') {
          await openConsoleModal(id, name, running);
          return;
        }
        if (t === 'inspect') {
          await openInspectModal(id, name);
          return;
        }
        location.hash = `#containers/${id}/${t}`;
      };
    });
    root.querySelectorAll('[data-act]').forEach((btn) => {
      onBusyClick(btn, async (el) => {
        await containerAction(id, el.dataset.act);
        if (el.dataset.act === 'remove') {
          location.hash = '#containers';
          return 'navigated';
        }
      }, {
        confirm: btn.dataset.act === 'remove' ? 'Supprimer ce conteneur ?' : null,
        reload: btn.dataset.act !== 'remove',
      });
    });

    if (requested === 'logs') await openLogsModal(id, name);
    else if (requested === 'console') await openConsoleModal(id, name, running);
    else if (requested === 'inspect') await openInspectModal(id, name);
  }

  function setConsoleStatus(mode, text) {
    const el = document.getElementById('console-status');
    if (!el) return;
    el.classList.remove('is-connected', 'is-busy');
    if (mode) el.classList.add(mode);
    const label = el.querySelector('.label');
    if (label) label.textContent = text;
  }

  function setupConsole(containerId, containerName) {
    const connectBtn = document.getElementById('console-connect');
    const disconnectBtn = document.getElementById('console-disconnect');
    const shellSelect = document.getElementById('shell-bin');
    if (!connectBtn) return;

    onBusyClick(connectBtn, async () => {
      await mountConsole(containerId, containerName);
      connectBtn.disabled = true;
      shellSelect.disabled = true;
      disconnectBtn.disabled = false;
      setConsoleStatus('is-connected', 'Connecté');
    }, { disableSiblings: false });

    disconnectBtn.onclick = () => {
      if (state.term) {
        try { state.term.dispose(); } catch (_) {}
        state.term = null;
      }
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
      setConsoleStatus('', 'Prêt à connecter');
    };
  }

  async function mountConsole(containerId, containerName) {
    const wrap = document.getElementById('term');
    if (!wrap) return;
    if (typeof Terminal === 'undefined') {
      wrap.innerHTML = '<div class="error-box" style="margin:12px">Échec du chargement de xterm</div>';
      return;
    }

    const placeholder = document.getElementById('console-placeholder');
    if (placeholder) placeholder.remove();
    wrap.innerHTML = '';

    if (state.term) {
      try { state.term.dispose(); } catch (_) {}
      state.term = null;
    }

    const shellSelect = document.getElementById('shell-bin');
    const shortName = (containerName || shortId(containerId)).replace(/[^a-zA-Z0-9_.-]/g, '') || 'container';

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: 'Menlo, Monaco, Consolas, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.35,
      letterSpacing: 0,
      theme: {
        background: '#0c0c0c',
        foreground: '#cccccc',
        cursor: '#cccccc',
        cursorAccent: '#0c0c0c',
        selectionBackground: '#264f78',
        black: '#0c0c0c',
        red: '#cd3131',
        green: '#0dbc79',
        yellow: '#e5e510',
        blue: '#2472c8',
        magenta: '#bc3fbc',
        cyan: '#11a8cd',
        white: '#e5e5e5',
        brightBlack: '#666666',
        brightRed: '#f14c4c',
        brightGreen: '#23d18b',
        brightYellow: '#f5f543',
        brightBlue: '#3b8eea',
        brightMagenta: '#d670d6',
        brightCyan: '#29b8db',
        brightWhite: '#e5e5e5',
      },
      convertEol: true,
      allowTransparency: false,
      scrollback: 5000,
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
    state.term = term;
    term.focus();

    let cwd = '/';
    let user = 'root';
    let buffer = '';
    let busy = false;
    let history = [];
    let historyIdx = -1;

    // Probe identity / cwd
    setConsoleStatus('is-busy', 'Connexion…');
    try {
      const who = await Api.containerExec(containerId, 'whoami; pwd', shellSelect.value, '');
      const lines = ((who.Stdout || '') + (who.Stderr || '')).trim().split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines[0]) user = lines[0];
      if (lines[1]) cwd = lines[1];
    } catch (_) {}

    const promptStr = () => {
      const host = shortName.slice(0, 20);
      return `\x1b[1;32m${user}@${host}\x1b[0m:\x1b[1;34m${cwd}\x1b[0m# `;
    };
    const writePrompt = () => { term.write(promptStr()); };

    term.writeln(`\x1b[90mConnecté à ${shortName} via ${shellSelect.value}\x1b[0m`);
    writePrompt();
    setConsoleStatus('is-connected', `Connecté · ${shellSelect.value}`);

    const onResize = () => { try { fit && fit.fit(); } catch (_) {} };
    window.addEventListener('resize', onResize);

    const runLine = async (line) => {
      const trimmed = line.trim();
      if (!trimmed) { writePrompt(); return; }
      if (trimmed === 'clear' || trimmed === 'cls') {
        term.clear();
        writePrompt();
        return;
      }
      if (trimmed === 'pwd') {
        term.writeln(cwd || '/');
        writePrompt();
        return;
      }
      if (trimmed === 'exit') {
        document.getElementById('console-disconnect')?.click();
        return;
      }
      if (trimmed.startsWith('cd ') || trimmed === 'cd') {
        const target = trimmed === 'cd' ? '/' : trimmed.slice(3).trim() || '/';
        busy = true;
        setConsoleStatus('is-busy', 'Exécution…');
        try {
          const res = await Api.containerExec(
            containerId,
            `cd ${shellQuote(cwd)} && cd ${shellQuote(target)} && pwd`,
            shellSelect.value,
            '',
          );
          const out = (res.Stdout || '').trim();
          if (res.ExitCode === 0 && out) cwd = out.split('\n').pop().trim();
          else {
            const err = (res.Stderr || res.Stdout || 'cd: no such file or directory').trim();
            term.writeln(`\x1b[31m${err}\x1b[0m`);
          }
        } catch (err) {
          term.writeln(`\x1b[31m${err.message}\x1b[0m`);
        }
        busy = false;
        setConsoleStatus('is-connected', `Connecté · ${shellSelect.value}`);
        writePrompt();
        return;
      }

      busy = true;
      setConsoleStatus('is-busy', 'Exécution…');
      try {
        const res = await Api.containerExec(containerId, trimmed, shellSelect.value, cwd);
        const out = (res.Stdout || '') + (res.Stderr || '');
        if (out) {
          const parts = out.replace(/\n$/, '').split('\n');
          for (const l of parts) term.writeln(l);
        }
      } catch (err) {
        term.writeln(`\x1b[31m${err.message}\x1b[0m`);
      }
      busy = false;
      setConsoleStatus('is-connected', `Connecté · ${shellSelect.value}`);
      writePrompt();
    };

    term.onData(async (data) => {
      if (busy) return;
      // Arrow up / down (history)
      if (data === '\x1b[A') {
        if (!history.length) return;
        if (historyIdx < 0) historyIdx = history.length - 1;
        else historyIdx = Math.max(0, historyIdx - 1);
        while (buffer.length) { term.write('\b \b'); buffer = buffer.slice(0, -1); }
        buffer = history[historyIdx];
        term.write(buffer);
        return;
      }
      if (data === '\x1b[B') {
        while (buffer.length) { term.write('\b \b'); buffer = buffer.slice(0, -1); }
        if (historyIdx < 0) return;
        historyIdx += 1;
        if (historyIdx >= history.length) { historyIdx = -1; buffer = ''; return; }
        buffer = history[historyIdx];
        term.write(buffer);
        return;
      }
      if (data === '\r') {
        const line = buffer;
        buffer = '';
        historyIdx = -1;
        term.write('\r\n');
        if (line.trim()) history.push(line);
        if (history.length > 100) history.shift();
        await runLine(line);
        return;
      }
      if (data === '\u0003') { // Ctrl+C
        buffer = '';
        term.write('^C\r\n');
        writePrompt();
        return;
      }
      if (data === '\u000c') { // Ctrl+L
        term.clear();
        writePrompt();
        term.write(buffer);
        return;
      }
      const code = data.charCodeAt(0);
      if (code === 127 || data === '\x7f') {
        if (buffer.length) {
          buffer = buffer.slice(0, -1);
          term.write('\b \b');
        }
        return;
      }
      if (code < 32) return;
      buffer += data;
      term.write(data);
    });

    // Keep fit handler; cleaned when term disposed / route changes via stopTimers
    term.onDispose?.(() => window.removeEventListener('resize', onResize));
  }

  function shellQuote(s) {
    return `'${String(s).replace(/'/g, `'\\''`)}'`;
  }

  async function viewImages() {
    const images = await Api.docker('/images/json');
    const list = images || [];
    const rows = list.map((img) => {
      const tags = (img.RepoTags && img.RepoTags.length) ? img.RepoTags.join(', ') : '<none>';
      const sizeMb = ((img.Size || 0) / (1024 * 1024)).toFixed(1);
      const search = `${shortId(img.Id)} ${tags}`.toLowerCase();
      return `<tr data-search="${esc(search)}">
        <td class="mono">${esc(shortId(img.Id))}</td>
        <td>${esc(tags)}</td>
        <td>${esc(sizeMb)} MB</td>
        <td class="actions"><div class="quick-actions">${iconBtn({ id: img.Id, title: 'Supprimer', icon: 'remove', danger: true })}</div></td>
      </tr>`;
    }).join('');
    root.innerHTML = shell('Images', `
      ${pageHeader('Images')}
      ${searchBar(
        'images',
        'Rechercher des images…',
        list.length,
        list.length,
        `${createBtn('build-image', 'Dockerfile / Build')}${createBtn('pull-image', 'Pull une image')}`
      )}
      <div class="table-wrap"><table class="data">
        <thead><tr><th>ID</th><th>Tags</th><th>Taille</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4" class="empty">Aucune image</td></tr>`}</tbody>
      </table></div>`, { subtitle: 'Images Docker locales' });
    bindRefresh();
    bindSearch('images');
    document.getElementById('build-image').onclick = () => { location.hash = '#images/build'; };
    document.getElementById('pull-image').onclick = () => openPullImageModal();
    root.querySelectorAll('button[data-id]').forEach((btn) => {
      onBusyClick(btn, async (el) => {
        await Api.docker(`/images/${encodeURIComponent(el.dataset.id)}?force=true`, { method: 'DELETE' });
      }, { confirm: 'Supprimer cette image ?', reload: true });
    });
  }

  async function viewVolumes() {
    const data = await Api.docker('/volumes');
    const volumes = data.Volumes || [];
    const rows = volumes.map((v) => {
      const search = `${v.Name} ${v.Driver} ${v.Mountpoint || ''}`.toLowerCase();
      return `<tr data-search="${esc(search)}">
      <td><a href="#volumes/${encodeURIComponent(v.Name)}">${esc(v.Name)}</a></td>
      <td>${esc(v.Driver)}</td>
      <td class="mono">${esc(v.Mountpoint || '')}</td>
      <td class="actions"><div class="quick-actions">
        ${iconBtn({ tag: 'a', href: `#volumes/${encodeURIComponent(v.Name)}`, title: 'Explorer', icon: 'search' })}
        ${iconBtn({ name: v.Name, title: 'Supprimer', icon: 'remove', danger: true })}
      </div></td>
    </tr>`;
    }).join('');
    root.innerHTML = shell('Volumes', `
      ${pageHeader('Volumes')}
      <div class="toolbar">
        <input class="search" id="filter" type="search" placeholder="Rechercher des volumes…" value="${esc(state.filters.volumes || '')}">
        ${createBtn('create', 'Créer un volume')}
        <div class="spacer"></div>
        <span class="muted mono" id="filter-count">${volumes.length} / ${volumes.length}</span>
      </div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Nom</th><th>Pilote</th><th>Point de montage</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4" class="empty">Aucun volume</td></tr>`}</tbody>
      </table></div>`, { subtitle: 'Volumes Docker' });
    bindRefresh();
    bindSearch('volumes');
    document.getElementById('create').onclick = () => openCreateVolumeModal();
    root.querySelectorAll('button[data-name]').forEach((btn) => {
      onBusyClick(btn, async (el) => {
        await Api.docker(`/volumes/${encodeURIComponent(el.dataset.name)}`, { method: 'DELETE' });
      }, { confirm: 'Supprimer ce volume ?', reload: true });
    });
  }

  function volumeBreadcrumbs(volumeName, path) {
    const parts = String(path || '/').split('/').filter(Boolean);
    let acc = '';
    const crumbs = [`<a href="#volumes/${encodeURIComponent(volumeName)}" data-path="/">/</a>`];
    parts.forEach((p) => {
      acc += '/' + p;
      crumbs.push(`<a href="#volumes/${encodeURIComponent(volumeName)}?path=${encodeURIComponent(acc)}" data-path="${esc(acc)}">${esc(p)}</a>`);
    });
    return `<nav class="vol-crumbs">${crumbs.join('<span class="muted"> / </span>')}</nav>`;
  }

  async function openVolumeFilePreview(volumeName, path) {
    closeAppModal();
    const host = modalHost();
    host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-form modal-form-wide" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3 class="mono">${esc(path)}</h3>
              <div class="modal-sub">Aperçu du fichier</div>
            </div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">✕</button>
          </div>
          <div id="vol-file-body"><div class="muted">Chargement…</div></div>
          <div class="actions-bar">
            <a class="btn btn-primary" id="vol-dl" href="#">Télécharger</a>
            <button type="button" class="btn" data-close-modal>Fermer</button>
          </div>
        </div>
      </div>`;
    bindAppModalChrome();
    const body = document.getElementById('vol-file-body');
    const dl = document.getElementById('vol-dl');
    try {
      const file = await Api.volumeFile(volumeName, path);
      const token = Api.getToken();
      dl.href = Api.volumeDownloadUrl(volumeName, path);
      dl.onclick = async (e) => {
        e.preventDefault();
        try {
          const res = await fetch(Api.volumeDownloadUrl(volumeName, path), {
            headers: token ? { Authorization: 'Bearer ' + token } : {},
          });
          if (!res.ok) {
            const t = await res.text();
            throw new Error(t || res.statusText);
          }
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = file.Name || 'file';
          a.click();
          URL.revokeObjectURL(url);
        } catch (err) {
          alert(err.message);
        }
      };
      if (file.Binary) {
        body.innerHTML = `<div class="info-box">Fichier binaire (${esc(formatBytes(file.Size))})${file.Truncated ? ' — aperçu tronqué' : ''}. Utilisez Télécharger.</div>`;
      } else {
        body.innerHTML = `
          <div class="muted" style="margin-bottom:8px;font-size:12px">${esc(formatBytes(file.Size))}${file.Truncated ? ' — aperçu tronqué à 512 Ko' : ''}</div>
          <pre class="logs vol-file-preview">${esc(file.Content || '')}</pre>`;
      }
    } catch (err) {
      body.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
      dl.hidden = true;
    }
  }

  async function viewVolumeBrowse(volumeName) {
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    let currentPath = params.get('path') || '/';
    if (!currentPath.startsWith('/')) currentPath = '/' + currentPath;

    function joinVolPath(dir, name) {
      const base = dir === '/' ? '' : dir.replace(/\/$/, '');
      return `${base}/${name}`.replace(/\/+/g, '/');
    }

    function goPath(p) {
      location.hash = `#volumes/${encodeURIComponent(volumeName)}${p === '/' ? '' : `?path=${encodeURIComponent(p)}`}`;
    }

    async function downloadEntry(path, name) {
      const token = Api.getToken();
      const res = await fetch(Api.volumeDownloadUrl(volumeName, path), {
        headers: token ? { Authorization: 'Bearer ' + token } : {},
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || res.statusText);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name || 'file';
      a.click();
      URL.revokeObjectURL(url);
    }

    async function runVolAction(action, entry) {
      hideVolContextMenu();
      try {
        if (action === 'open') {
          if (!entry) return;
          if (entry.type === 'dir') goPath(entry.path);
          else await openVolumeFilePreview(volumeName, entry.path);
          return;
        }
        if (action === 'refresh') {
          await render(currentPath);
          return;
        }
        if (action === 'new-file') {
          const name = await promptName({
            title: 'Nouveau fichier',
            label: 'Nom du fichier',
            placeholder: 'exemple.txt',
            confirmLabel: 'Créer',
          });
          if (!name) return;
          if (/[\\/]/.test(name)) {
            alert('Le nom ne doit pas contenir de chemin.');
            return;
          }
          await Api.volumeWriteFile(volumeName, joinVolPath(currentPath, name), { Content: '', CreateOnly: true });
          await render(currentPath);
          return;
        }
        if (action === 'new-dir') {
          const name = await promptName({
            title: 'Nouveau dossier',
            label: 'Nom du dossier',
            placeholder: 'mon-dossier',
            confirmLabel: 'Créer',
          });
          if (!name) return;
          if (/[\\/]/.test(name)) {
            alert('Le nom ne doit pas contenir de chemin.');
            return;
          }
          await Api.volumeMkdir(volumeName, joinVolPath(currentPath, name));
          await render(currentPath);
          return;
        }
        if (action === 'rename' && entry) {
          const name = await promptName({
            title: 'Renommer',
            label: 'Nouveau nom',
            value: entry.name,
            confirmLabel: 'Renommer',
          });
          if (!name || name === entry.name) return;
          if (/[\\/]/.test(name)) {
            alert('Le nom ne doit pas contenir de chemin.');
            return;
          }
          const parent = entry.path.replace(/\/[^/]+\/?$/, '') || '/';
          const to = joinVolPath(parent === '' ? '/' : parent, name);
          await Api.volumeRename(volumeName, entry.path, to);
          await render(currentPath);
          return;
        }
        if (action === 'download' && entry && entry.type !== 'dir') {
          await downloadEntry(entry.path, entry.name);
          return;
        }
        if (action === 'delete' && entry) {
          const label = entry.type === 'dir' ? `le dossier « ${entry.name} » et son contenu` : `« ${entry.name} »`;
          if (!confirm(`Supprimer ${label} ?`)) return;
          await Api.volumeDeleteEntry(volumeName, entry.path);
          await render(currentPath);
        }
      } catch (err) {
        alert(err.message || String(err));
      }
    }

    function openCtx(ev, entry) {
      ev.preventDefault();
      ev.stopPropagation();
      const items = [];
      if (entry) {
        items.push({ id: 'open', label: entry.type === 'dir' ? 'Ouvrir' : 'Aperçu' });
        items.push({ id: 'rename', label: 'Renommer…' });
        if (entry.type !== 'dir') items.push({ id: 'download', label: 'Télécharger' });
        items.push('—');
        items.push({ id: 'delete', label: 'Supprimer', danger: true });
        items.push('—');
      }
      items.push({ id: 'new-file', label: 'Nouveau fichier…' });
      items.push({ id: 'new-dir', label: 'Nouveau dossier…' });
      items.push({ id: 'refresh', label: 'Actualiser' });
      const menu = showVolContextMenu(ev.clientX, ev.clientY, items);
      menu.querySelectorAll('[data-act]').forEach((btn) => {
        btn.addEventListener('click', () => runVolAction(btn.getAttribute('data-act'), entry));
      });
    }

    async function render(path) {
      hideVolContextMenu();
      root.innerHTML = shell(`Volume · ${volumeName}`, `
        ${pageHeader(volumeName, false)}
        <div class="toolbar">
          ${iconBtn({ tag: 'a', href: '#volumes', title: 'Retour', icon: 'back' })}
          <button type="button" class="btn btn-sm" id="vol-new-file">Nouveau fichier</button>
          <button type="button" class="btn btn-sm" id="vol-new-dir">Nouveau dossier</button>
          <div class="spacer"></div>
          <span class="muted">Clic droit pour plus d’actions</span>
          <span class="muted mono">${esc(volumeName)}</span>
        </div>
        <div id="vol-err"></div>
        ${volumeBreadcrumbs(volumeName, path)}
        <div class="table-wrap vol-explorer" id="vol-explorer">
          <table class="data">
            <thead><tr><th>Nom</th><th>Taille</th><th>Modifié</th><th></th></tr></thead>
            <tbody id="vol-rows"><tr><td colspan="4" class="muted">Chargement…</td></tr></tbody>
          </table>
        </div>`, { subtitle: 'Explorateur de fichiers' });

      document.getElementById('vol-new-file').onclick = () => runVolAction('new-file');
      document.getElementById('vol-new-dir').onclick = () => runVolAction('new-dir');

      const explorer = document.getElementById('vol-explorer');
      const tbody = document.getElementById('vol-rows');
      const errBox = document.getElementById('vol-err');
      explorer.addEventListener('contextmenu', (ev) => {
        if (ev.target.closest('.vol-row[data-entry]')) return;
        openCtx(ev, null);
      });

      try {
        const data = await Api.volumeBrowse(volumeName, path);
        currentPath = data.Path || path;
        root.querySelectorAll('.vol-crumbs a').forEach((a) => {
          a.addEventListener('click', (e) => {
            e.preventDefault();
            goPath(a.getAttribute('data-path') || '/');
          });
        });
        const entries = data.Entries || [];
        const parentPath = currentPath === '/' ? null : currentPath.replace(/\/[^/]+\/?$/, '') || '/';
        let rows = '';
        if (parentPath != null) {
          rows += `<tr class="vol-row" data-dir="${esc(parentPath)}">
            <td colspan="3"><a href="#" class="vol-link" data-dir="${esc(parentPath)}">../</a></td>
            <td></td>
          </tr>`;
        }
        if (!entries.length) {
          rows += `<tr><td colspan="4" class="empty">Dossier vide — clic droit pour créer</td></tr>`;
        } else {
          rows += entries.map((e) => {
            const isDir = e.Type === 'dir';
            const icon = isDir ? 'folder' : (e.Type === 'link' ? 'link' : 'file');
            const when = e.ModTime ? new Date(e.ModTime * 1000).toLocaleString() : '—';
            const size = isDir ? '—' : formatBytes(e.Size || 0);
            return `<tr class="vol-row" data-entry="1" data-type="${isDir ? 'dir' : 'file'}" data-path="${esc(e.Path)}" data-name="${esc(e.Name)}">
              <td>
                <a href="#" class="vol-link" data-${isDir ? 'dir' : 'file'}="${esc(e.Path)}">
                  <span class="vol-ico">${ico(icon)}</span>${esc(e.Name)}${isDir ? '/' : ''}
                </a>
              </td>
              <td class="mono">${esc(size)}</td>
              <td class="muted">${esc(when)}</td>
              <td class="actions"><div class="quick-actions">
                ${isDir ? '' : `<button type="button" class="btn btn-icon btn-sm" title="Aperçu" data-file="${esc(e.Path)}"><span class="btn-ico">${ico('logs')}</span></button>`}
              </div></td>
            </tr>`;
          }).join('');
        }
        tbody.innerHTML = rows;
        tbody.querySelectorAll('.vol-row[data-entry]').forEach((row) => {
          row.addEventListener('contextmenu', (ev) => {
            openCtx(ev, {
              path: row.getAttribute('data-path'),
              name: row.getAttribute('data-name'),
              type: row.getAttribute('data-type'),
            });
          });
        });
        tbody.querySelectorAll('[data-dir]').forEach((el) => {
          el.addEventListener('click', (ev) => {
            ev.preventDefault();
            goPath(el.getAttribute('data-dir') || '/');
          });
        });
        tbody.querySelectorAll('[data-file]').forEach((el) => {
          el.addEventListener('click', (ev) => {
            ev.preventDefault();
            openVolumeFilePreview(volumeName, el.getAttribute('data-file') || '');
          });
        });
      } catch (err) {
        tbody.innerHTML = `<tr><td colspan="4" class="empty">—</td></tr>`;
        if (errBox) errBox.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
      }
    }

    await render(currentPath);
  }

  async function viewNetworks() {
    const networks = await Api.docker('/networks');
    const list = networks || [];
    const rows = list.map((n) => {
      const search = `${n.Id} ${n.Name} ${n.Driver} ${n.Scope}`.toLowerCase();
      return `<tr data-search="${esc(search)}">
      <td class="mono">${esc(shortId(n.Id))}</td>
      <td>${esc(n.Name)}</td>
      <td>${esc(n.Driver)}</td>
      <td>${esc(n.Scope)}</td>
      <td class="actions"><div class="quick-actions">
        ${['bridge', 'host', 'none'].includes(n.Name) ? '' :
          iconBtn({ id: n.Id, title: 'Supprimer', icon: 'remove', danger: true })}
      </div></td>
    </tr>`;
    }).join('');
    root.innerHTML = shell('Réseaux', `
      ${pageHeader('Réseaux')}
      <div class="toolbar">
        <input class="search" id="filter" type="search" placeholder="Rechercher des réseaux…" value="${esc(state.filters.networks || '')}">
        ${createBtn('create', 'Créer un réseau')}
        <div class="spacer"></div>
        <span class="muted mono" id="filter-count">${list.length} / ${list.length}</span>
      </div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>ID</th><th>Nom</th><th>Pilote</th><th>Portée</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5" class="empty">Aucun réseau</td></tr>`}</tbody>
      </table></div>`, { subtitle: 'Réseaux Docker' });
    bindRefresh();
    bindSearch('networks');
    document.getElementById('create').onclick = () => openCreateNetworkModal();
    root.querySelectorAll('button[data-id]').forEach((btn) => {
      onBusyClick(btn, async (el) => {
        await Api.docker(`/networks/${encodeURIComponent(el.dataset.id)}`, { method: 'DELETE' });
      }, { confirm: 'Supprimer ce réseau ?', reload: true });
    });
  }

  async function viewStacks() {
    if (state.route === 'stacks/new') {
      showStackEditor();
      return;
    }
    const stacks = await Api.stacks();
    const list = stacks || [];
    const rows = list.map((s) => {
      const search = `${s.Id} ${s.Name} ${s.CreatedBy || ''} ${s.Status === 1 ? 'actif' : s.Status}`.toLowerCase();
      return `<tr data-search="${esc(search)}">
      <td>${esc(s.Id)}</td>
      <td><a href="#stacks/${s.Id}">${esc(s.Name)}</a></td>
      <td>${badge(s.Status === 1 ? 'actif' : String(s.Status))}</td>
      <td>${esc(s.CreatedBy || '')}</td>
      <td class="actions"><div class="quick-actions">
        ${iconBtn({ tag: 'a', href: `#stacks/${s.Id}`, title: 'Ouvrir', icon: 'edit' })}
        ${iconBtn({ del: s.Id, title: 'Supprimer', icon: 'remove', danger: true })}
      </div></td>
    </tr>`;
    }).join('');
    root.innerHTML = shell('Stacks', `
      ${pageHeader('Stacks')}
      <div class="toolbar">
        <input class="search" id="filter" type="search" placeholder="Rechercher des stacks…" value="${esc(state.filters.stacks || '')}">
        <a class="btn btn-info btn-create" href="#stacks/new" title="Créer une stack">
          <span class="btn-ico">${ico('plus')}</span><span>Créer une stack</span>
        </a>
        <div class="spacer"></div>
        <span class="muted mono" id="filter-count">${list.length} / ${list.length}</span>
      </div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Id</th><th>Nom</th><th>Statut</th><th>Créé par</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5" class="empty">Aucune stack disponible.</td></tr>`}</tbody>
      </table></div>`, { subtitle: 'Projets Compose' });
    bindRefresh();
    bindSearch('stacks');
    root.querySelectorAll('[data-del]').forEach((btn) => {
      onBusyClick(btn, async (el) => {
        await Api.deleteStack(el.dataset.del);
      }, { confirm: 'Supprimer la stack et ses conteneurs ?', reload: true });
    });
  }

  function parseDotEnv(text) {
    const pairs = [];
    String(text || '').split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const body = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
      const eq = body.indexOf('=');
      if (eq <= 0) return;
      const name = body.slice(0, eq).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return;
      let value = body.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      pairs.push({ name, value });
    });
    return pairs;
  }

  function showStackEditor(existing) {
    const isEdit = !!existing;
    const defaultCompose = `services:
  web:
    image: nginx:alpine
    ports:
      - "8090:80"
`;
    const initialEnv = Array.isArray(existing?.Env) ? existing.Env : [];
    root.innerHTML = shell(isEdit ? 'Modifier la stack' : 'Créer une stack', `
      ${pageHeader(isEdit ? 'Modifier la stack' : 'Créer une stack', false)}
      <div id="stack-err"></div>
      <div class="form-group">
        <label class="field-label">Nom <span class="req">*</span></label>
        <input id="stack-name" ${isEdit ? 'disabled' : ''} value="${esc(existing?.Name || '')}" placeholder="ex. ma-stack">
      </div>

      <div class="form-group">
        <label class="field-label">Fichier Compose <span class="req">*</span></label>
        <div class="code-editor">
          <div class="code-editor-bar">
            ${iconBtn({ elId: 'copy-compose', title: 'Copier', icon: 'copy' })}
          </div>
          <textarea id="stack-file">${esc(existing?.content || defaultCompose)}</textarea>
        </div>
      </div>

      <div class="section-title">Variables d’environnement</div>
      <div class="info-box">
        Écrites dans <code>.env</code> du projet Compose et injectées au déploiement (<code>\${VAR}</code> dans le YAML).
      </div>
      <div class="toolbar env-toolbar">
        <button type="button" class="btn btn-sm" id="add-env">+ Ajouter une variable</button>
        <button type="button" class="btn btn-sm" id="load-env">Charger un fichier .env</button>
        <input type="file" id="env-file" accept=".env,text/plain,*/*" hidden>
      </div>
      <div class="env-list" id="env-list"></div>
      <div class="muted" id="env-empty" style="font-size:13px;margin-top:6px">Aucune variable</div>

      <div class="actions-bar">
        <button class="btn btn-primary" id="stack-save">${isEdit ? 'Mettre à jour la stack' : 'Déployer la stack'}</button>
        <a class="btn" href="#stacks" style="margin-left:8px">Annuler</a>
      </div>
    `);

    const envList = document.getElementById('env-list');
    const envEmpty = document.getElementById('env-empty');

    function syncEnvEmpty() {
      const rows = envList?.querySelectorAll('.env-row') || [];
      if (envEmpty) envEmpty.hidden = rows.length > 0;
    }

    function addEnvRow(name = '', value = '') {
      const row = document.createElement('div');
      row.className = 'env-row';
      row.innerHTML = `
        <input class="env-name" placeholder="NOM" value="${esc(name)}" autocomplete="off" spellcheck="false">
        <input class="env-value" placeholder="valeur" value="${esc(value)}" autocomplete="off" spellcheck="false">
        <button type="button" class="icon-btn env-remove" title="Retirer" aria-label="Retirer">✕</button>`;
      row.querySelector('.env-remove')?.addEventListener('click', () => {
        row.remove();
        syncEnvEmpty();
      });
      envList?.appendChild(row);
      syncEnvEmpty();
      return row;
    }

    function collectEnv() {
      const Env = [];
      const errors = [];
      envList?.querySelectorAll('.env-row').forEach((row, i) => {
        const name = row.querySelector('.env-name')?.value?.trim() || '';
        const value = row.querySelector('.env-value')?.value ?? '';
        if (!name && value === '') return;
        if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          errors.push(`Variable ${i + 1} : nom invalide (ex. MYSQL_PASSWORD)`);
          return;
        }
        Env.push({ name, value });
      });
      return { Env, errors };
    }

    function mergeEnvPairs(pairs, { replace = false } = {}) {
      if (replace) envList.innerHTML = '';
      const existing = new Map();
      envList?.querySelectorAll('.env-row').forEach((row) => {
        const n = row.querySelector('.env-name')?.value?.trim();
        if (n) existing.set(n, row);
      });
      pairs.forEach(({ name, value }) => {
        if (existing.has(name)) {
          existing.get(name).querySelector('.env-value').value = value;
        } else {
          addEnvRow(name, value);
        }
      });
      syncEnvEmpty();
    }

    initialEnv.forEach((p) => {
      const name = p.name || p.Name || '';
      const value = p.value ?? p.Value ?? '';
      if (name) addEnvRow(name, value);
    });
    syncEnvEmpty();

    document.getElementById('add-env')?.addEventListener('click', () => {
      const row = addEnvRow();
      row.querySelector('.env-name')?.focus();
    });
    document.getElementById('load-env')?.addEventListener('click', () => {
      document.getElementById('env-file')?.click();
    });
    document.getElementById('env-file')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      try {
        const text = await file.text();
        const pairs = parseDotEnv(text);
        if (!pairs.length) {
          const errBox = document.getElementById('stack-err');
          if (errBox) errBox.innerHTML = `<div class="error-box">Aucune variable trouvée dans ce fichier.</div>`;
          return;
        }
        mergeEnvPairs(pairs);
      } catch (err) {
        const errBox = document.getElementById('stack-err');
        if (errBox) errBox.innerHTML = `<div class="error-box">${esc(err.message || 'Lecture .env impossible')}</div>`;
      }
    });

    document.getElementById('copy-compose').onclick = async () => {
      const text = document.getElementById('stack-file').value;
      try { await navigator.clipboard.writeText(text); } catch (_) {}
    };
    onBusyClick(document.getElementById('stack-save'), async () => {
      const name = document.getElementById('stack-name').value.trim();
      const content = document.getElementById('stack-file').value;
      const errBox = document.getElementById('stack-err');
      if (errBox) errBox.innerHTML = '';
      const { Env, errors } = collectEnv();
      if (errors.length) {
        if (errBox) errBox.innerHTML = `<div class="error-box">${esc(errors.join('\n'))}</div>`;
        return;
      }
      try {
        if (isEdit) await Api.updateStack(existing.Id, content, Env);
        else await Api.createStack(name, content, Env);
        location.hash = '#stacks';
      } catch (err) {
        if (errBox) {
          errBox.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
          window.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
          alert(err.message);
        }
      }
    }, { disableSiblings: false, minMs: 400 });
  }

  async function viewStackDetail(id) {
    if (id === 'new') {
      showStackEditor();
      return;
    }
    const [stack, file] = await Promise.all([Api.stack(id), Api.stackFile(id)]);
    root.innerHTML = shell(`Stack · ${stack.Name}`, `
      ${pageHeader(stack.Name, false)}
      <div class="toolbar">
        ${iconBtn({ tag: 'a', href: '#stacks', title: 'Retour', icon: 'back' })}
        ${iconBtn({ elId: 'edit', title: 'Éditeur', icon: 'edit', info: true })}
        ${iconBtn({ elId: 'del', title: 'Supprimer', icon: 'remove', danger: true })}
      </div>
      <div class="panel" style="margin-bottom:1rem">
        <dl class="kv">
          <dt>Id</dt><dd>${stack.Id}</dd>
          <dt>Type</dt><dd>Compose</dd>
          <dt>Environnement</dt><dd>${stack.EndpointId}</dd>
        </dl>
      </div>
      <div class="section-title">Fichier Compose</div>
      <pre class="logs">${esc(file.StackFileContent || '')}</pre>`);
    document.getElementById('edit').onclick = () =>
      showStackEditor({ Id: stack.Id, Name: stack.Name, content: file.StackFileContent, Env: stack.Env || [] });
    onBusyClick(document.getElementById('del'), async () => {
      await Api.deleteStack(id);
      location.hash = '#stacks';
    }, { confirm: 'Supprimer la stack ?', minMs: 300 });
  }

  async function loadPublicUrl() {
    try {
      const s = await Api.settings();
      state.publicUrl = s.PublicURL || s.HostURL || '';
    } catch (_) {
      state.publicUrl = '';
    }
  }

  function registryHost(reg) {
    return String(reg?.URL || '').replace(/^https?:\/\//i, '').replace(/\/$/, '');
  }

  function registryImageRef(reg, repo, tag) {
    const t = tag || 'latest';
    if ((reg?.Type || '') === 'hub') return `${repo}:${t}`;
    return `${registryHost(reg)}/${repo}:${t}`;
  }

  function openCreateRegistryModal() {
    closeAppModal();
    const host = modalHost();
    host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-form" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3>Ajouter un registre</h3>
              <div class="modal-sub">Docker Hub ou Registry V2</div>
            </div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">✕</button>
          </div>
          <div id="create-err"></div>
          <div class="form-group">
            <label class="field-label">Nom <span class="req">*</span></label>
            <input id="r-name" placeholder="Mon registre" autocomplete="off">
          </div>
          <div class="form-group">
            <label class="field-label">Type</label>
            <select id="r-type" class="select-block">
              <option value="hub">Docker Hub</option>
              <option value="v2">Registry V2</option>
            </select>
          </div>
          <div class="form-group" id="r-url-wrap">
            <label class="field-label">URL <span class="req">*</span></label>
            <input id="r-url" placeholder="https://registry.example.com" autocomplete="off">
          </div>
          <div class="form-group">
            <label class="field-label">Utilisateur</label>
            <input id="r-user" placeholder="optionnel" autocomplete="username">
          </div>
          <div class="form-group">
            <label class="field-label">Mot de passe / jeton</label>
            <input id="r-pass" type="password" placeholder="optionnel" autocomplete="current-password">
          </div>
          <div class="actions-bar">
            <button type="button" class="btn btn-primary" id="r-save">Ajouter</button>
            <button type="button" class="btn" data-close-modal>Annuler</button>
          </div>
        </div>
      </div>`;
    bindAppModalChrome();
    const typeSel = document.getElementById('r-type');
    const urlWrap = document.getElementById('r-url-wrap');
    const urlInput = document.getElementById('r-url');
    const syncType = () => {
      const hub = typeSel.value === 'hub';
      urlWrap.hidden = hub;
      if (hub) urlInput.value = 'https://docker.io';
      else if (urlInput.value === 'https://docker.io') urlInput.value = '';
    };
    typeSel.addEventListener('change', syncType);
    syncType();
    document.getElementById('r-name')?.focus();
    onBusyClick(document.getElementById('r-save'), async () => {
      const errBox = document.getElementById('create-err');
      errBox.innerHTML = '';
      const Name = document.getElementById('r-name').value.trim();
      const Type = document.getElementById('r-type').value;
      const URL = Type === 'hub' ? 'https://docker.io' : document.getElementById('r-url').value.trim();
      const Username = document.getElementById('r-user').value.trim();
      const Password = document.getElementById('r-pass').value;
      if (!Name || !URL) {
        errBox.innerHTML = `<div class="error-box">Le nom et l’URL sont requis.</div>`;
        return;
      }
      try {
        await Api.createRegistry({ Name, URL, Type, Username, Password });
        closeAppModal();
        await route();
      } catch (err) {
        errBox.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
      }
    }, { disableSiblings: false, minMs: 300 });
  }

  async function viewRegistries() {
    const list = await Api.registries();
    const rows = (list || []).map((r) => {
      const search = `${r.Name} ${r.URL} ${r.Type} ${r.Username || ''}`.toLowerCase();
      const typeLabel = r.Type === 'hub' ? 'Docker Hub' : 'Registry V2';
      return `<tr data-search="${esc(search)}">
        <td><a href="#registries/${r.Id}">${esc(r.Name)}</a></td>
        <td class="mono">${esc(r.URL)}</td>
        <td>${esc(typeLabel)}</td>
        <td>${r.Authentication ? esc(r.Username || 'authentifié') : '<span class="muted">anonyme</span>'}</td>
        <td class="actions"><div class="quick-actions">
          ${iconBtn({ tag: 'a', href: `#registries/${r.Id}`, title: 'Parcourir', icon: 'search' })}
          ${iconBtn({ del: r.Id, title: 'Supprimer', icon: 'remove', danger: true })}
        </div></td>
      </tr>`;
    }).join('');
    root.innerHTML = shell('Registres', `
      ${pageHeader('Registres')}
      <div class="toolbar">
        <input class="search" id="filter" type="search" placeholder="Rechercher des registres…" value="${esc(state.filters.registries || '')}">
        ${createBtn('create-registry', 'Ajouter un registre')}
        <div class="spacer"></div>
        <span class="muted mono" id="filter-count">${(list || []).length} / ${(list || []).length}</span>
      </div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Nom</th><th>URL</th><th>Type</th><th>Auth</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5" class="empty">Aucun registre</td></tr>`}</tbody>
      </table></div>`, { subtitle: 'Connexion aux registres d’images' });
    bindRefresh();
    bindSearch('registries');
    document.getElementById('create-registry').onclick = () => openCreateRegistryModal();
    root.querySelectorAll('[data-del]').forEach((btn) => {
      onBusyClick(btn, async (el) => {
        await Api.deleteRegistry(el.dataset.del);
      }, { confirm: 'Supprimer ce registre ?', reload: true });
    });
  }

  async function viewRegistryBrowse(id) {
    const reg = await Api.registry(id);
    let selectedRepo = '';
    let searchTimer = null;

    root.innerHTML = shell(`Registre · ${reg.Name}`, `
      ${pageHeader(reg.Name, false)}
      <div class="toolbar">
        ${iconBtn({ tag: 'a', href: '#registries', title: 'Retour', icon: 'back' })}
        <div class="spacer"></div>
        <span class="muted mono">${esc(reg.URL)} · ${reg.Type === 'hub' ? 'Docker Hub' : 'V2'}</span>
      </div>
      <div id="reg-err"></div>
      <div class="reg-browse">
        <div class="reg-pane">
          <div class="reg-pane-head">
            <label class="field-label">Dépôts</label>
            <input class="search" id="reg-q" type="search" placeholder="${reg.Type === 'hub' ? 'Rechercher sur Docker Hub…' : 'Filtrer le catalogue…'}" autocomplete="off">
          </div>
          <div class="reg-list" id="reg-repos"><div class="muted" style="padding:12px">Chargement…</div></div>
        </div>
        <div class="reg-pane">
          <div class="reg-pane-head">
            <label class="field-label">Tags <span class="muted" id="reg-repo-label"></span></label>
          </div>
          <div class="reg-list" id="reg-tags"><div class="muted" style="padding:12px">Sélectionnez un dépôt</div></div>
        </div>
      </div>`, { subtitle: 'Parcourir les images' });

    const errBox = document.getElementById('reg-err');
    const reposEl = document.getElementById('reg-repos');
    const tagsEl = document.getElementById('reg-tags');
    const repoLabel = document.getElementById('reg-repo-label');
    const qInput = document.getElementById('reg-q');

    async function loadTags(repo) {
      selectedRepo = repo;
      repoLabel.textContent = repo ? `· ${repo}` : '';
      tagsEl.innerHTML = `<div class="muted" style="padding:12px">Chargement des tags…</div>`;
      try {
        const data = await Api.registryTags(id, repo);
        const tags = data?.Tags || [];
        if (!tags.length) {
          tagsEl.innerHTML = `<div class="muted" style="padding:12px">Aucun tag</div>`;
          return;
        }
        tagsEl.innerHTML = tags.map((t) => {
          const ref = registryImageRef(reg, repo, t.Name);
          const meta = [
            t.Size ? formatBytes(t.Size) : '',
            t.LastUpdated ? new Date(t.LastUpdated).toLocaleDateString() : '',
          ].filter(Boolean).join(' · ');
          return `<div class="reg-item">
            <div class="reg-item-main">
              <div class="mono">${esc(t.Name)}</div>
              ${meta ? `<div class="muted" style="font-size:12px">${esc(meta)}</div>` : ''}
            </div>
            <div class="quick-actions">
              <button type="button" class="btn btn-icon btn-sm" title="Pull ${esc(ref)}" aria-label="Pull" data-repo="${esc(repo)}" data-tag="${esc(t.Name)}">
                <span class="btn-ico">${ico('pull')}</span>
              </button>
            </div>
          </div>`;
        }).join('');
        tagsEl.querySelectorAll('[data-repo][data-tag]').forEach((btn) => {
          onBusyClick(btn, async (el) => {
            errBox.innerHTML = '';
            const repository = el.getAttribute('data-repo') || '';
            const tag = el.getAttribute('data-tag') || 'latest';
            const ref = registryImageRef(reg, repository, tag);
            try {
              await Api.registryPull(id, repository, tag);
              errBox.innerHTML = `<div class="info-box">Pull terminé : <code>${esc(ref)}</code></div>`;
            } catch (err) {
              errBox.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
            }
          }, { disableSiblings: false, minMs: 300 });
        });
      } catch (err) {
        tagsEl.innerHTML = `<div class="error-box" style="margin:12px">${esc(err.message)}</div>`;
      }
    }

    async function loadRepos(q) {
      reposEl.innerHTML = `<div class="muted" style="padding:12px">Recherche…</div>`;
      try {
        const data = await Api.registryRepos(id, q, 60);
        const repos = data?.Repositories || [];
        if (!repos.length) {
          const hint = reg.Type === 'hub' && !q
            ? 'Saisissez un terme pour rechercher sur Docker Hub (ex. nginx), ou ajoutez des identifiants pour lister vos dépôts.'
            : 'Aucun dépôt trouvé';
          reposEl.innerHTML = `<div class="muted" style="padding:12px">${esc(hint)}</div>`;
          return;
        }
        reposEl.innerHTML = repos.map((r) => `
          <button type="button" class="reg-item reg-item-btn${selectedRepo === r.Name ? ' active' : ''}" data-repo="${esc(r.Name)}">
            <div class="reg-item-main">
              <div class="mono">${esc(r.Name)}${r.Official ? ' <span class="img-selected-badge is-hub">Officiel</span>' : ''}</div>
              ${r.Description ? `<div class="muted reg-item-desc">${esc(r.Description)}</div>` : ''}
            </div>
            ${r.StarCount || r.PullCount ? `<div class="muted" style="font-size:11px;flex-shrink:0">★ ${esc(String(r.StarCount || 0))}</div>` : ''}
          </button>`).join('');
        reposEl.querySelectorAll('[data-repo]').forEach((btn) => {
          btn.addEventListener('click', () => {
            reposEl.querySelectorAll('.reg-item-btn').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            loadTags(btn.getAttribute('data-repo') || '');
          });
        });
      } catch (err) {
        reposEl.innerHTML = `<div class="error-box" style="margin:12px">${esc(err.message)}</div>`;
      }
    }

    qInput?.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => loadRepos(qInput.value.trim()), 320);
    });
    await loadRepos('');
  }

  function formatAuditTime(ts) {
    const n = Number(ts) || 0;
    if (!n) return '—';
    try {
      return new Date(n * 1000).toLocaleString();
    } catch (_) {
      return String(ts);
    }
  }

  function auditActionBadge(action) {
    const a = String(action || '');
    let tone = 'neutral';
    if (a.includes('fail') || a.includes('rate_limited') || a.includes('delete') || a.includes('remove')) tone = 'danger';
    else if (a.includes('login.ok') || a.includes('create') || a.includes('start')) tone = 'success';
    else if (a.includes('update') || a.includes('stop') || a.includes('restart') || a.includes('password')) tone = 'warn';
    return `<span class="audit-action tone-${tone}">${esc(a)}</span>`;
  }

  async function viewActivity() {
    const actionFilter = state.filters.activityAction || '';
    let data;
    try {
      data = await Api.audit({ limit: 150, action: actionFilter || undefined });
    } catch (err) {
      root.innerHTML = shell('Journaux', `${pageHeader('Journaux d’activité', false)}<div class="error-box">${esc(err.message)}</div>`, {
        subtitle: 'Qui se connecte, qui fait quoi',
      });
      return;
    }
    const items = data?.Items || [];
    const total = Number(data?.Total) || items.length;
    const isAdmin = Number(state.user?.Role) === 1;
    const rows = items.map((ev) => {
      const who = ev.Username || (ev.UserId ? `#${ev.UserId}` : '—');
      const search = `${ev.Action} ${ev.Message} ${who} ${ev.Ip}`.toLowerCase();
      return `<tr data-search="${esc(search)}">
        <td class="muted cell-nowrap">${esc(formatAuditTime(ev.CreatedAt))}</td>
        <td>${esc(who)}</td>
        <td>${auditActionBadge(ev.Action)}</td>
        <td>${esc(ev.Message || '')}</td>
        <td class="mono muted">${esc(ev.Ip || '—')}</td>
      </tr>`;
    }).join('');

    root.innerHTML = shell('Journaux', `
      ${pageHeader('Journaux d’activité')}
      <div class="toolbar">
        <input class="search" id="filter" type="search" placeholder="Filtrer les événements…" value="${esc(state.filters.activity || '')}">
        <select id="audit-action-filter" class="audit-filter">
          <option value="">Toutes les actions</option>
          <option value="auth" ${actionFilter === 'auth' ? 'selected' : ''}>Connexions</option>
          <option value="user" ${actionFilter === 'user' ? 'selected' : ''}>Utilisateurs</option>
          <option value="stack" ${actionFilter === 'stack' ? 'selected' : ''}>Stacks</option>
          <option value="docker" ${actionFilter === 'docker' ? 'selected' : ''}>Docker</option>
          <option value="settings" ${actionFilter === 'settings' ? 'selected' : ''}>Paramètres</option>
          <option value="api_key" ${actionFilter === 'api_key' ? 'selected' : ''}>Clés API</option>
        </select>
        <div class="spacer"></div>
        <span class="muted mono" id="filter-count">${items.length} / ${total}</span>
      </div>
      <p class="muted audit-hint">${isAdmin
        ? 'Histor des connexions et actions réalisées dans WharfMaster (admin : vue globale).'
        : 'Vos connexions et actions dans WharfMaster.'}</p>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Date</th><th>Utilisateur</th><th>Action</th><th>Détail</th><th>IP</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5" class="empty">Aucun événement pour le moment — connectez-vous ou lancez une action.</td></tr>`}</tbody>
      </table></div>
    `, { subtitle: 'Qui se connecte, qui fait quoi' });

    bindRefresh();
    bindSearch('activity');
    const sel = document.getElementById('audit-action-filter');
    if (sel) {
      sel.onchange = () => {
        state.filters.activityAction = sel.value || '';
        route();
      };
    }
  }

  async function viewSettings() {
    await loadPublicUrl();
    const fallback = `${window.location.protocol}//${window.location.hostname}`;
    root.innerHTML = shell('Paramètres', `
      ${pageHeader('Paramètres', false)}
      <div id="settings-err"></div>
      <div class="panel" style="max-width:720px; margin-bottom:16px">
        <div class="section-title" style="margin-top:0">Apparence</div>
        <p class="muted" style="margin:0 0 14px">Basculer entre le thème clair et sombre. La préférence est enregistrée dans ce navigateur.</p>
        <div class="toolbar" style="margin:0">
          <button type="button" class="btn ${state.theme === 'dark' ? 'btn-info' : ''}" id="theme-dark">Sombre</button>
          <button type="button" class="btn ${state.theme === 'light' ? 'btn-info' : ''}" id="theme-light">Clair</button>
        </div>
      </div>
      <div class="panel" style="max-width:720px">
        <div class="section-title" style="margin-top:0">URL publique / hôte</div>
        <p class="muted" style="margin:0 0 14px">
          URL de base utilisée pour ouvrir les ports publiés (liens dans Conteneurs).
          Laisser vide pour utiliser l'hôte du navigateur (<code>${esc(fallback)}</code>).
        </p>
        <div class="form-group">
          <label class="field-label">URL publique</label>
          <input id="public-url" type="text" placeholder="https://docker.example.com" value="${esc(state.publicUrl)}">
        </div>
        <div class="info-box">
          Exemple : avec l'URL publique <code>https://nas.lan</code>, un port publié <code>8080</code> devient
          <code>https://nas.lan:8080</code>.
        </div>
        <div class="actions-bar">
          <button class="btn btn-primary" id="save-settings">Enregistrer</button>
        </div>
      </div>
    `);
    document.getElementById('theme-dark').onclick = () => {
      state.theme = applyTheme('dark');
      route();
    };
    document.getElementById('theme-light').onclick = () => {
      state.theme = applyTheme('light');
      route();
    };
    onBusyClick(document.getElementById('save-settings'), async () => {
      const value = document.getElementById('public-url').value.trim();
      const errBox = document.getElementById('settings-err');
      errBox.innerHTML = '';
      try {
        const saved = await Api.updateSettings({ PublicURL: value });
        state.publicUrl = saved.PublicURL || '';
        errBox.innerHTML = `<div class="info-box">Paramètres enregistrés.</div>`;
      } catch (err) {
        errBox.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
      }
    }, { disableSiblings: false, minMs: 250 });
  }

  function roleLabel(role) {
    return Number(role) === 1 ? 'Administrateur' : 'Utilisateur';
  }

  async function viewUsers() {
    const users = await Api.users();
    const list = users || [];
    const rows = list.map((u) => {
      const isSelf = Number(u.Id) === Number(state.user?.Id);
      const search = `${u.Id} ${u.Username} ${roleLabel(u.Role)}`.toLowerCase();
      return `<tr data-search="${esc(search)}">
        <td>${esc(u.Id)}</td>
        <td>${esc(u.Username)}${isSelf ? ' <span class="muted">(vous)</span>' : ''}</td>
        <td>${esc(roleLabel(u.Role))}</td>
        <td class="actions"><div class="quick-actions">
          ${iconBtn({ reset: u.Id, name: u.Username, title: 'Réinitialiser le mot de passe', icon: 'key' })}
          ${isSelf ? '' : iconBtn({ del: u.Id, title: 'Supprimer', icon: 'remove', danger: true })}
        </div></td>
      </tr>`;
    }).join('');

    root.innerHTML = shell('Utilisateurs', `
      ${pageHeader('Gestion des utilisateurs', false)}
      <div class="toolbar">
        <input class="search" id="filter" type="search" placeholder="Rechercher des utilisateurs…" value="${esc(state.filters.users || '')}">
        ${createBtn('add-user', 'Ajouter un utilisateur')}
        <div class="spacer"></div>
        <span class="muted mono" id="filter-count">${list.length} / ${list.length}</span>
      </div>
      <div id="users-err"></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Id</th><th>Nom d'utilisateur</th><th>Rôle</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4" class="empty">Aucun utilisateur</td></tr>`}</tbody>
      </table></div>
      <div id="user-modal"></div>
    `);

    bindSearch('users');
    document.getElementById('add-user').onclick = () => showUserModal();
    root.querySelectorAll('[data-del]').forEach((btn) => {
      onBusyClick(btn, async (el) => {
        await Api.deleteUser(el.dataset.del);
      }, { confirm: 'Supprimer cet utilisateur ?', reload: true });
    });
    root.querySelectorAll('[data-reset]').forEach((btn) => {
      btn.onclick = () => showResetPasswordModal(btn.dataset.reset, btn.dataset.name);
    });
  }

  function showUserModal() {
    const slot = document.getElementById('user-modal');
    slot.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal" style="max-width:480px">
          <h3>Ajouter un utilisateur</h3>
          <div id="user-form-err"></div>
          <div class="form-group">
            <label class="field-label">Nom d'utilisateur <span class="req">*</span></label>
            <input id="new-username" autocomplete="off">
          </div>
          <div class="form-group">
            <label class="field-label">Mot de passe <span class="req">*</span></label>
            <input id="new-password" type="password" minlength="8" autocomplete="new-password">
          </div>
          <div class="form-group">
            <label class="field-label">Rôle</label>
            <select id="new-role">
              <option value="2">Utilisateur</option>
              <option value="1">Administrateur</option>
            </select>
          </div>
          <div class="actions-bar">
            <button class="btn btn-primary" id="save-user">Créer l'utilisateur</button>
            <button class="btn" id="cancel-user" style="margin-left:8px">Annuler</button>
          </div>
        </div>
      </div>`;
    document.getElementById('cancel-user').onclick = () => { slot.innerHTML = ''; };
    onBusyClick(document.getElementById('save-user'), async () => {
      const username = document.getElementById('new-username').value.trim();
      const password = document.getElementById('new-password').value;
      const role = Number(document.getElementById('new-role').value);
      const errBox = document.getElementById('user-form-err');
      errBox.innerHTML = '';
      try {
        await Api.createUser(username, password, role);
        slot.innerHTML = '';
        await viewUsers();
      } catch (err) {
        errBox.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
      }
    }, { disableSiblings: false, minMs: 250 });
  }

  function showResetPasswordModal(userId, username) {
    const slot = document.getElementById('user-modal');
    const isSelf = Number(userId) === Number(state.user?.Id);
    slot.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal" style="max-width:480px">
          <h3>Réinitialiser le mot de passe · ${esc(username)}</h3>
          <div id="user-form-err"></div>
          ${isSelf ? `<div class="form-group">
            <label class="field-label">Mot de passe actuel</label>
            <input id="cur-password" type="password" autocomplete="current-password">
          </div>` : ''}
          <div class="form-group">
            <label class="field-label">Nouveau mot de passe <span class="req">*</span></label>
            <input id="new-password" type="password" minlength="8" autocomplete="new-password">
          </div>
          <div class="actions-bar">
            <button class="btn btn-primary" id="save-pass">Mettre à jour</button>
            <button class="btn" id="cancel-user" style="margin-left:8px">Annuler</button>
          </div>
        </div>
      </div>`;
    document.getElementById('cancel-user').onclick = () => { slot.innerHTML = ''; };
    onBusyClick(document.getElementById('save-pass'), async () => {
      const errBox = document.getElementById('user-form-err');
      errBox.innerHTML = '';
      const payload = { Password: document.getElementById('new-password').value };
      if (isSelf) payload.CurrentPassword = document.getElementById('cur-password').value;
      try {
        await Api.changePassword(userId, payload);
        slot.innerHTML = '';
      } catch (err) {
        errBox.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
      }
    }, { disableSiblings: false, minMs: 250 });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (document.querySelector('#app-modal .modal-backdrop')) closeAppModal();
      const panel = document.getElementById('notif-panel');
      const bell = document.getElementById('notif-bell');
      if (panel && !panel.hidden) {
        panel.hidden = true;
        if (bell) bell.setAttribute('aria-expanded', 'false');
      }
    }
  });

  document.addEventListener('click', (e) => {
    const wrap = e.target.closest('.notif-wrap');
    if (wrap) return;
    const panel = document.getElementById('notif-panel');
    const bell = document.getElementById('notif-bell');
    if (panel && !panel.hidden) {
      panel.hidden = true;
      if (bell) bell.setAttribute('aria-expanded', 'false');
    }
  });

  async function route() {
    stopTimers();
    closeAppModal();
    state.route = (location.hash.slice(1) || 'dashboard').replace(/^\/+/, '');
    if (state.route === 'logout') {
      Api.setToken('');
      state.user = null;
      state.publicUrl = '';
      if (state.alertTimer) {
        clearInterval(state.alertTimer);
        state.alertTimer = null;
      }
      location.hash = '';
      await boot();
      return;
    }
    if (!(await ensureSession())) {
      await renderAuth();
      return;
    }
    try {
      if (!state._settingsLoaded) {
        await loadPublicUrl();
        state._settingsLoaded = true;
      }
      if (state.route === 'users' && Number(state.user?.Role) !== 1) {
        location.hash = '#dashboard';
        return;
      }
      if (state.route !== 'dashboard') {
        root.innerHTML = shell('Chargement', pageLoadingHtml());
      }
      if (state.route === 'dashboard') await viewDashboard();
      else if (state.route === 'containers' || state.route === 'containers/new') {
        await viewContainers();
        if (state.route === 'containers/new') await openCreateContainerModal();
      }
      else if (state.route.startsWith('containers/')) {
        const parts = state.route.split('/');
        const id = parts[1];
        const tab = parts[2] || 'overview';
        await viewContainerDetail(id, tab);
      }
      else if (state.route === 'images/build' || state.route.startsWith('images/build/')) {
        const name = state.route.startsWith('images/build/')
          ? decodeURIComponent(state.route.slice('images/build/'.length))
          : '';
        await openBuildImageView(name);
      }
      else if (state.route === 'images' || state.route === 'images/pull') {
        await viewImages();
        if (state.route === 'images/pull') await openPullImageModal();
      }
      else if (state.route === 'volumes') await viewVolumes();
      else if (state.route.startsWith('volumes/')) {
        const name = decodeURIComponent(state.route.slice('volumes/'.length).split('?')[0]);
        await viewVolumeBrowse(name);
      }
      else if (state.route === 'networks') await viewNetworks();
      else if (state.route === 'stacks' || state.route === 'stacks/new') await viewStacks();
      else if (state.route.startsWith('stacks/')) await viewStackDetail(state.route.split('/')[1]);
      else if (state.route === 'activity') await viewActivity();
      else if (state.route === 'settings') await viewSettings();
      else if (state.route === 'users') await viewUsers();
      else if (state.route === 'registries') await viewRegistries();
      else if (state.route.startsWith('registries/')) await viewRegistryBrowse(state.route.split('/')[1]);
      else if (state.route === 'about') {
        root.innerHTML = shell('À propos', `<div class="panel-card">
          <div class="about-brand">${brandLogoImg('about-logo-img')}</div>
          <h3 style="margin-top:14px">WharfMaster</h3>
          <p class="muted">Version <strong>1.0.2</strong> — interface de gestion Docker locale.</p>
          <p class="muted">Compatibilité API : endpoints alignés sur l’API Portainer CE (clients / scripts existants).</p>
          <p class="muted">Changelog : <code>CHANGELOG.md</code></p>
          <p class="muted">Socket : <code>unix:///var/run/docker.so</code></p>
          <p class="muted"><a href="/" target="_blank" rel="noopener">Site public</a> — présentation du projet et des outils.</p>
          <p class="muted" style="margin-bottom:0">Licence : <strong>MIT</strong> — open source, libre d’utilisation. Voir <code>LICENSE</code>.</p>
        </div>`, { subtitle: 'Informations sur l’application' });
      }
      else await viewDashboard();
    } catch (err) {
      root.innerHTML = shell('Erreur', `${pageHeader('Erreur', false)}<div class="error-box">${esc(err.message)}</div>`);
    }
    bindAlertUi();
    ensureAlertPolling();
    refreshAlerts();
  }

  async function boot() {
    if (!(await ensureSession())) {
      await renderAuth();
      return;
    }
    state._settingsLoaded = false;
    await loadPublicUrl();
    state._settingsLoaded = true;
    await route();
  }

  window.addEventListener('hashchange', () => route());
  boot();
})();
