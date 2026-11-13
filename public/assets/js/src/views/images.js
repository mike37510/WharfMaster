import { bag } from '../bag.js';

export function install() {
  bag.parseImageRef = function parseImageRef(ref) {
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

  bag.parsePortBindings = function parsePortBindings(portsText) {
    const ExposedPorts = {};
    const PortBindings = {};
    String(portsText || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean).forEach((line) => {
      // host:container[/proto] = publié ; container[/proto] = exposé seulement (pas de PortBindings)
      const m = line.match(/^(?:(\d+(?:-\d+)?):)?(\d+(?:-\d+)?)(?:\/(tcp|udp|sctp))?$/i);
      if (!m) return;
      const proto = (m[3] || 'tcp').toLowerCase();
      const containerPort = `${m[2]}/${proto}`;
      ExposedPorts[containerPort] = {};
      // Port hôte fourni (y compris 0 = dynamique) → publier.
      // Port seul (80) → ExposedPorts seulement, pas de PortBindings.
      if (m[1] !== undefined && m[1] !== '') {
        PortBindings[containerPort] = [{ HostPort: String(m[1]) }];
      }
    });
    return { ExposedPorts, PortBindings };
  }

  bag.formatPullCount = function formatPullCount(n) {
    const v = Number(n) || 0;
    if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
    return String(v);
  }

  bag.imageSearchFieldsHtml = function imageSearchFieldsHtml(prefix) {
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

  bag.bindImageSearchPicker = function bindImageSearchPicker(prefix, modalRoot) {
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
        const data = await bag.Api.imageTags(repo);
        const tags = Array.isArray(data?.Tags) ? data.Tags : [];
        if (!tags.length || !tagSel) return;
        const names = tags.map((t) => t.Name).filter(Boolean);
        if (!names.includes('latest')) names.unshift('latest');
        const uniq = [...new Set(names)];
        tagSel.innerHTML = uniq.map((t) => `<option value="${bag.esc(t)}">${bag.esc(t)}</option>`).join('');
        tagSel.value = uniq.includes('latest') ? 'latest' : uniq[0];
        selectedImage = `${repo}:${tagSel.value}`;
        if (selRef) selRef.textContent = selectedImage;
      } catch (_) {}
    }

    tagSel?.addEventListener('change', () => {
      if (!selectedImage) return;
      const { fromImage } = bag.parseImageRef(selectedImage);
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
          <button type="button" class="img-search-item" data-src="local" data-name="${bag.esc(r.Name)}">
            <span class="img-search-main">
              <span class="img-search-name mono">${bag.esc(r.Name)}</span>
              <span class="img-search-desc muted">${bag.esc(r.Description || 'Image locale')}</span>
            </span>
            <span class="img-search-meta"><span class="img-selected-badge is-local">Local</span></span>
          </button>`).join('');
      }
      if (remote.length) {
        html += `<div class="img-search-section">Docker Hub</div>`;
        html += remote.map((r) => `
          <button type="button" class="img-search-item" data-src="hub" data-name="${bag.esc(r.Name)}">
            <span class="img-search-main">
              <span class="img-search-name mono">${bag.esc(r.Name)}${r.Official ? ' <span class="img-selected-badge is-hub">Officiel</span>' : ''}</span>
              <span class="img-search-desc muted">${bag.esc(r.Description || '')}</span>
            </span>
            <span class="img-search-meta muted">★ ${bag.esc(String(r.StarCount || 0))} · ${bag.esc(bag.formatPullCount(r.PullCount))} pulls</span>
          </button>`).join('');
      }
      if (data?.HubError) {
        html += `<div class="img-search-hint muted">Docker Hub : ${bag.esc(data.HubError)}</div>`;
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
        const data = await bag.Api.searchImages(q);
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
          const { fromImage } = bag.parseImageRef(selectedImage || 'x');
          selectedImage = `${fromImage}:${tagSel.value || 'latest'}`;
          if (selRef) selRef.textContent = selectedImage;
        }
        return { image: selectedImage.trim(), source: selectedSource };
      },
    };
  }

  bag.defaultDockerfile = function defaultDockerfile() {
    return `FROM alpine:latest

  LABEL maintainer="docker-manager"

  RUN apk add --no-cache curl

  WORKDIR /app

  CMD ["sh"]
  `;
  }

  bag.formatBuildLog = function formatBuildLog(raw) {
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

  bag.openBuildImageView = async function openBuildImageView(existingName = '') {
    let content = bag.defaultDockerfile();
    let saveName = existingName || '';
    if (existingName) {
      try {
        const df = await bag.Api.dockerfile(existingName);
        content = df.Content || content;
        saveName = df.Name || existingName;
      } catch (_) {}
    }
    let savedList = [];
    try { savedList = await bag.Api.dockerfiles(); } catch (_) {}

    const savedOptions = savedList.map((d) =>
      `<option value="${bag.esc(d.Name)}" ${d.Name === saveName ? 'selected' : ''}>${bag.esc(d.Name)}</option>`
    ).join('');

    bag.root.innerHTML = bag.shell('Builder une image', `
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
              ${bag.iconBtn({ elId: 'df-del', title: 'Supprimer le fichier sélectionné', icon: 'remove', danger: true })}
            </div>
          </div>
          <div class="form-row-2">
            <div class="form-group">
              <label class="field-label">Tag de l'image <span class="req">*</span></label>
              <input id="build-tag" placeholder="mon-app:latest" value="${bag.esc(saveName ? `${saveName}:latest` : 'mon-app:latest')}">
            </div>
            <div class="form-group">
              <label class="field-label">Enregistrer sous</label>
              <input id="build-saveas" placeholder="nom-du-dockerfile" value="${bag.esc(saveName)}">
            </div>
          </div>
          <div class="form-group">
            <label class="field-label">Dockerfile</label>
            <textarea id="build-df" class="code-area" spellcheck="false">${bag.esc(content)}</textarea>
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
        document.getElementById('build-df').value = bag.defaultDockerfile();
        document.getElementById('build-saveas').value = '';
        return;
      }
      try {
        const df = await bag.Api.dockerfile(name);
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
        await bag.Api.deleteDockerfile(name);
        location.hash = '#images/build';
        await bag.openBuildImageView();
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
        await bag.Api.saveDockerfile(name, content);
        errBox.innerHTML = `<div class="info-box">Dockerfile « ${bag.esc(name)} » enregistré.</div>`;
        const sel = document.getElementById('df-saved');
        if (sel && ![...sel.options].some((o) => o.value === name)) {
          const opt = document.createElement('option');
          opt.value = name;
          opt.textContent = name;
          sel.appendChild(opt);
        }
        if (sel) sel.value = name;
      } catch (err) {
        errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
      }
    };

    bag.onBusyClick(document.getElementById('build-run'), async () => {
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
        const res = await bag.Api.buildImage({ Tag: tag, Dockerfile: dockerfile, SaveAs: saveAs || undefined });
        log.textContent = bag.formatBuildLog(res.Log);
        if (!res.Success) {
          errBox.innerHTML = `<div class="error-box">${bag.esc(res.Error || 'Échec du build')}</div>`;
        } else {
          errBox.innerHTML = `<div class="info-box">Image <code>${bag.esc(tag)}</code> compilée avec succès.</div>`;
        }
        log.scrollTop = log.scrollHeight;
      } catch (err) {
        const raw = err.data?.Log || err.message;
        log.textContent = bag.formatBuildLog(raw);
        errBox.innerHTML = `<div class="error-box">${bag.esc(err.data?.Error || err.message)}</div>`;
      }
    }, { disableSiblings: false, minMs: 400 });
  }

  bag.openPullImageModal = async function openPullImageModal() {
    bag.closeAppModal();
    const host = bag.modalHost();
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
            ${bag.imageSearchFieldsHtml('p')}
          </div>
          <div class="actions-bar">
            <button type="button" class="btn btn-primary" id="i-save">Pull</button>
            <button type="button" class="btn" data-close-modal>Annuler</button>
          </div>
        </div>
      </div>`;
    bag.bindAppModalChrome();
    const imagePicker = bag.bindImageSearchPicker('p', host);
    imagePicker.focus();
    bag.onBusyClick(document.getElementById('i-save'), async () => {
      const errBox = document.getElementById('create-err');
      errBox.innerHTML = '';
      const { image } = imagePicker.getSelected();
      if (!image) {
        errBox.innerHTML = `<div class="error-box">Sélectionnez une image dans les résultats de recherche.</div>`;
        imagePicker.focus();
        return;
      }
      const { fromImage, tag } = bag.parseImageRef(image);
      try {
        await bag.Api.docker(`/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag.replace(/^@/, ''))}`, { method: 'POST' });
        bag.closeAppModal();
        if (location.hash === '#images/pull') location.hash = '#images';
        else await bag.route();
      } catch (err) {
        errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
      }
    }, { disableSiblings: false, minMs: 300 });
  }

  bag.viewImages = async function viewImages() {
    const all = bag.isAllNodes();
    let list = [];
    let containers = [];
    let partial = false;
    let scanByRef = new Map();
    const cveOn = bag.trivyOn();
    if (all) {
      const [aggImg, aggCtr] = await Promise.all([
        bag.dockerAll('/images/json'),
        bag.dockerAll('/containers/json?all=true'),
      ]);
      list = aggImg.items;
      containers = aggCtr.items;
      partial = aggImg.failed > 0 || aggCtr.failed > 0;
    } else {
      const tasks = [
        bag.Api.docker('/images/json'),
        bag.Api.docker('/containers/json?all=true'),
      ];
      if (cveOn) tasks.push(bag.Api.imageScans(bag.Api.getEndpointId()).catch(() => ({ Items: [] })));
      const [imgs, ctrs, scans] = await Promise.all(tasks);
      list = imgs || [];
      containers = ctrs || [];
      if (cveOn) {
        (scans?.Items || []).forEach((s) => {
          if (s.ImageRef) scanByRef.set(s.ImageRef, s);
          if (s.Digest) scanByRef.set(s.Digest, s);
        });
      }
    }

    const usageByKey = new Map();
    list.forEach((img, idx) => {
      const users = bag.containersUsingImage(img, containers);
      const key = `${img._nodeId || 0}:${img.Id || idx}`;
      usageByKey.set(key, { img, users, key });
      img._usageCount = users.length;
      img._tagsLabel = bag.imageTagsLabel(img);
      img._sortKey = key;
      const tags = (img.RepoTags || []).filter((t) => t && t !== '<none>:<none>');
      img._primaryTag = tags[0] || '';
      const dig = (img.RepoDigests || [])[0] || '';
      const digestOnly = dig.includes('@') ? dig.split('@')[1] : '';
      img._scan = scanByRef.get(img._primaryTag) || scanByRef.get(digestOnly) || null;
    });
    list = bag.sortItems(list, 'images', {
      name: (img) => img._tagsLabel || '',
      id: (img) => img.Id || '',
      size: (img) => Number(img.Size) || 0,
      usage: (img) => Number(img._usageCount) || 0,
      node: (img) => img._nodeName || '',
      created: (img) => bag.createdSortKey(img.Created),
    });
    const rows = list.map((img) => {
      const tags = img._tagsLabel || bag.imageTagsLabel(img);
      const sizeMb = ((img.Size || 0) / (1024 * 1024)).toFixed(1);
      const entry = usageByKey.get(img._sortKey) || { users: [] };
      const users = entry.users || [];
      const key = img._sortKey;
      const usageCell = users.length
        ? `<button type="button" class="badge badge-inuse img-usage-btn" data-img-key="${bag.esc(key)}" title="Voir les conteneurs">${users.length}&nbsp;conteneur${users.length > 1 ? 's' : ''}</button>`
        : `<span class="badge badge-unused">Inutilisé</span>`;
      const cveCell = !cveOn || all
        ? ''
        : bag.cveStatusTd(img._primaryTag, img._scan);
      const search = `${bag.shortId(img.Id)} ${tags} ${img._nodeName || ''} ${users.length ? 'utilise used' : 'inutilise unused'}`.toLowerCase();
      return `<tr data-search="${bag.esc(search)}" data-resource-id="${bag.esc(img.Id)}" data-resource-name="${bag.esc(tags)}">
        ${all ? '' : bag.bulkSelectTd(img.Id)}
        ${all ? `<td class="muted">${bag.esc(img._nodeName || '—')}</td>` : ''}
        <td class="mono">${bag.esc(bag.shortId(img.Id))}</td>
        <td>${bag.esc(tags)}</td>
        <td>${usageCell}</td>
        ${cveCell}
        <td>${bag.esc(sizeMb)} MB</td>
        <td>${bag.formatCreated(img.Created)}</td>
        <td class="actions">${all ? '<span class="muted">—</span>' : `<div class="quick-actions">
          ${bag.iconBtn({ id: img.Id, title: 'Supprimer', icon: 'remove', danger: true })}
        </div>`}</td>
      </tr>`;
    }).join('');
    const colSpan = (all ? 7 : 8) + (cveOn && !all ? 1 : 0);
    bag.root.innerHTML = bag.shell('Images', `
      ${bag.pageHeader(all ? 'Images — tous les nœuds' : 'Images')}
      ${partial ? '<div class="info-box" style="margin-bottom:12px">Agrégat partiel : certains nœuds n’ont pas répondu.</div>' : ''}
      ${all ? bag.pickNodeGuardHtml() : ''}
      ${bag.searchBar(
        'images',
        'Rechercher des images…',
        list.length,
        list.length,
        all ? '' : `${bag.createBtn('build-image', 'Dockerfile / Build')}${bag.createBtn('pull-image', 'Pull une image')}${bag.bulkDeleteBtnHtml()}`,
      )}
      <div class="table-wrap"><table class="data">
        <thead><tr>
          ${bag.bulkSelectTh(!all)}
          ${all ? bag.sortTh('Nœud', 'node', 'images') : ''}
          ${bag.sortTh('ID', 'id', 'images')}
          ${bag.sortTh('Tags', 'name', 'images')}
          ${bag.sortTh('Usage', 'usage', 'images')}
          ${cveOn && !all ? '<th>CVE</th>' : ''}
          ${bag.sortTh('Taille', 'size', 'images')}
          ${bag.sortTh('Créé', 'created', 'images')}
          <th></th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="${colSpan}" class="empty">Aucune image</td></tr>`}</tbody>
      </table></div>
      <div id="scan-modal"></div>`, { subtitle: all ? 'Vue agrégée (lecture)' : 'Images Docker locales' });
    bag.bindRefresh();
    bag.bindPagedSearch('images');
    bag.bindTableSort('images', () => bag.viewImages());
    bag.root.querySelectorAll('.img-usage-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const entry = usageByKey.get(btn.dataset.imgKey);
        if (entry) bag.openImageUsersModal(entry.img, entry.users);
      });
    });
    if (!all) {
      document.getElementById('build-image').onclick = () => { location.hash = '#images/build'; };
      document.getElementById('pull-image').onclick = () => bag.openPullImageModal();
      bag.bindCveDetailButtons(bag.root);
      if (cveOn) {
        const refs = [...new Set(list.map((img) => img._primaryTag).filter(Boolean))];
        if (refs.length) {
          bag.ensureImagesCveColumn(bag.root, refs).catch(() => {});
        }
      }
      const labelById = new Map(
        list.map((img) => [img.Id, (img._tagsLabel && img._tagsLabel !== '<none>' ? img._tagsLabel : bag.shortId(img.Id))]),
      );
      const deleteRefById = new Map(
        list.map((img) => {
          // Prefer a tag so Docker errors mention the name; fall back to id
          const tag = (img._primaryTag || '').trim();
          return [img.Id, tag || img.Id];
        }),
      );
      const deleteImage = async (id) => {
        const ref = deleteRefById.get(id) || id;
        try {
          await bag.Api.docker(`/images/${encodeURIComponent(ref)}?force=true`, { method: 'DELETE' });
        } catch (err) {
          const label = labelById.get(id) || bag.shortId(id) || id;
          let msg = String(err?.message || err || 'échec');
          msg = msg.replace(/sha256:[a-f0-9]{12,}/gi, label);
          const wrapped = new Error(msg);
          wrapped.status = err?.status;
          wrapped.data = err?.data;
          throw wrapped;
        }
      };
      bag.root.querySelectorAll('.quick-actions button[data-id]').forEach((btn) => {
        const entry = [...usageByKey.values()].find((e) => e.img.Id === btn.dataset.id);
        const used = !!(entry && entry.users.length);
        const label = labelById.get(btn.dataset.id) || bag.shortId(btn.dataset.id);
        bag.onBusyClick(btn, async (el) => {
          await deleteImage(el.dataset.id);
        }, {
          confirm: used
            ? `L’image « ${label} » est utilisée par des conteneurs. Forcer la suppression ?`
            : `Supprimer l’image « ${label} » ?`,
          reload: true,
        });
      });
      bag.bindBulkDelete({
        enabled: true,
        confirmOne: (id) => `Supprimer l’image « ${labelById.get(id) || bag.shortId(id)} » ?`,
        confirmMany: (n) => `Supprimer ${n} images (force) ? Les échecs seront ignorés pour continuer.`,
        labelOne: (id) => labelById.get(id) || bag.shortId(id),
        retryFailed: true,
        deleteOne: (id) => deleteImage(id),
        reload: () => bag.viewImages(),
      });
    }
    bag.restoreListFocus();
  }

  bag.imageTagsLabel = function imageTagsLabel(img) {
    const tags = (img?.RepoTags || []).filter((t) => t && t !== '<none>:<none>');
    return tags.length ? tags.join(', ') : '<none>';
  }

  bag.imageMatchesContainer = function imageMatchesContainer(img, container) {
    const imgId = bag.normalizeImageRef(img?.Id);
    const cImgId = bag.normalizeImageRef(container?.ImageID);
    if (imgId && cImgId && (imgId === cImgId || imgId.startsWith(cImgId) || cImgId.startsWith(imgId))) {
      return true;
    }
    const refs = [...(img?.RepoTags || []), ...(img?.RepoDigests || [])].filter((t) => t && t !== '<none>:<none>');
    const cref = String(container?.Image || '');
    if (cref && refs.includes(cref)) return true;
    const short = bag.normalizeImageRef(cref);
    if (imgId && short && /^[a-f0-9]{12,}$/.test(short) && imgId.startsWith(short)) return true;
    return false;
  }

  bag.containersUsingImage = function containersUsingImage(img, containers) {
    return (containers || []).filter((c) => {
      if (img?._nodeId != null && c?._nodeId != null && Number(img._nodeId) !== Number(c._nodeId)) {
        return false;
      }
      return bag.imageMatchesContainer(img, c);
    });
  }

  bag.normalizeImageRef = function normalizeImageRef(id) {
    return String(id || '').replace(/^sha256:/i, '').toLowerCase();
  }

  /** True if container was created from this image (ImageID / tags / digests). */

  bag.openImageUsersModal = function openImageUsersModal(img, users) {
    bag.openResourceUsersModal({
      title: 'Conteneurs utilisant cette image',
      subtitle: `${bag.imageTagsLabel(img)} · ${bag.shortId(img.Id)}`,
      users,
      extraCol: (c) => c.Image || '',
    });
  }

}
