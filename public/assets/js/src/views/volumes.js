import { bag } from '../bag.js';

export function install() {
  bag.openCreateVolumeModal = async function openCreateVolumeModal() {
    bag.closeAppModal();
    const isAdmin = Number(bag.state.user?.Role) === 1;
    const host = bag.modalHost();
    host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-form" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div><h3>Créer un volume</h3></div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">✕</button>
          </div>
          <div id="create-err"></div>
          ${isAdmin ? `
          <div class="form-group">
            <label class="field-label">Type</label>
            <select id="v-type">
              <option value="volume" selected>Volume Docker</option>
              <option value="bind">Bind (chemin hôte)</option>
            </select>
          </div>` : ''}
          <div class="form-group">
            <label class="field-label">Nom <span class="req">*</span></label>
            <input id="v-name" placeholder="mon-volume" autocomplete="off">
          </div>
          <div class="form-group" id="v-driver-wrap">
            <label class="field-label">Pilote</label>
            <input id="v-driver" value="local" autocomplete="off">
          </div>
          <div class="form-group" id="v-bind-wrap" hidden>
            <label class="field-label">Chemin hôte <span class="req">*</span></label>
            <input id="v-host" class="mono" placeholder="/data/mon-app" autocomplete="off">
            <p class="field-hint muted">Chemin absolu sur le nœud Docker. Le dossier n’est pas créé automatiquement.</p>
          </div>
          <div class="actions-bar">
            <button type="button" class="btn btn-primary" id="v-save">Créer</button>
            <button type="button" class="btn" data-close-modal>Annuler</button>
          </div>
        </div>
      </div>`;
    bag.bindAppModalChrome();
    const typeEl = document.getElementById('v-type');
    const syncType = () => {
      const isBind = typeEl?.value === 'bind';
      const driverWrap = document.getElementById('v-driver-wrap');
      const bindWrap = document.getElementById('v-bind-wrap');
      if (driverWrap) driverWrap.hidden = !!isBind;
      if (bindWrap) bindWrap.hidden = !isBind;
    };
    typeEl?.addEventListener('change', syncType);
    syncType();
    document.getElementById('v-name')?.focus();
    bag.onBusyClick(document.getElementById('v-save'), async () => {
      const errBox = document.getElementById('create-err');
      errBox.innerHTML = '';
      const Name = document.getElementById('v-name').value.trim();
      const isBind = typeEl?.value === 'bind';
      if (!Name) {
        errBox.innerHTML = `<div class="error-box">Le nom est requis.</div>`;
        return;
      }
      try {
        if (isBind) {
          const HostPath = document.getElementById('v-host').value.trim();
          if (!HostPath || !HostPath.startsWith('/')) {
            errBox.innerHTML = `<div class="error-box">Chemin hôte absolu requis (ex. /data/app).</div>`;
            return;
          }
          await bag.Api.createBindVolume(Name, HostPath);
        } else {
          const Driver = document.getElementById('v-driver').value.trim() || 'local';
          await bag.Api.docker('/volumes/create', { method: 'POST', body: JSON.stringify({ Name, Driver }) });
        }
        bag.closeAppModal();
        await bag.route();
      } catch (err) {
        errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
      }
    }, { disableSiblings: false, minMs: 250 });
  }

  bag.viewVolumes = async function viewVolumes() {
    const all = bag.isAllNodes();
    const isAdmin = Number(bag.state.user?.Role) === 1;
    let volumes = [];
    let containers = [];
    let partial = false;
    if (all) {
      const [aggVol, aggCtr] = await Promise.all([
        bag.dockerAll('/volumes', { pick: (d) => d?.Volumes || [] }),
        bag.dockerAll('/containers/json?all=true'),
      ]);
      volumes = aggVol.items;
      containers = aggCtr.items;
      partial = aggVol.failed > 0 || aggCtr.failed > 0;
    } else {
      const [data, ctrs, binds] = await Promise.all([
        bag.Api.docker('/volumes'),
        bag.Api.docker('/containers/json?all=true'),
        bag.Api.bindVolumes().catch(() => ({ Volumes: [] })),
      ]);
      volumes = data.Volumes || [];
      containers = ctrs || [];
      const bindList = binds?.Volumes || [];
      const named = new Set(volumes.map((v) => String(v.Name || '').toLowerCase()));
      bindList.forEach((b) => {
        const key = String(b.Name || '').toLowerCase();
        if (!key || named.has(key)) return;
        volumes.push(b);
        named.add(key);
      });
    }

    const usageByKey = new Map();
    volumes.forEach((v, idx) => {
      const users = bag.containersUsingVolume(v, containers);
      const key = `${v._nodeId || 0}:${v.Name || idx}`;
      usageByKey.set(key, { vol: v, users });
      v._usageCount = users.length;
      v._sortKey = key;
    });
    volumes = bag.sortItems(volumes, 'volumes', {
      name: (v) => v.Name || '',
      driver: (v) => v.Driver || '',
      usage: (v) => Number(v._usageCount) || 0,
      mount: (v) => v.Mountpoint || v.HostPath || '',
      node: (v) => v._nodeName || '',
      created: (v) => bag.createdSortKey(v.CreatedAt || v.created_at || v.Created),
    });
    const rows = volumes.map((v) => {
      const users = (usageByKey.get(v._sortKey) || {}).users || [];
      const key = v._sortKey;
      const isBind = !!(v._bind || String(v.Driver || '').toLowerCase() === 'bind');
      const mount = v.HostPath || v.Mountpoint || '';
      const usageCell = users.length
        ? `<button type="button" class="badge badge-inuse img-usage-btn" data-vol-key="${bag.esc(key)}" title="Voir les conteneurs">${users.length}&nbsp;conteneur${users.length > 1 ? 's' : ''}</button>`
        : `<span class="badge badge-unused">Inutilisé</span>`;
      const driverLabel = isBind
        ? (v.Source === 'stack' ? 'bind · stack' : 'bind')
        : (v.Driver || '');
      const search = `${v.Name} ${driverLabel} ${mount} ${v.StackName || ''} ${v._nodeName || ''} ${users.length ? 'utilise used' : 'inutilise unused'} bind`.toLowerCase();
      const canDelete = !all && (!isBind || isAdmin);
      const actions = all
        ? '<span class="muted">—</span>'
        : `<div class="quick-actions">
        ${bag.iconBtn({ tag: 'a', href: `#volumes/${encodeURIComponent(v.Name)}`, title: 'Explorer', icon: 'search' })}
        ${!isBind ? bag.shareBtn('volume', v.Name) : ''}
        ${canDelete ? bag.iconBtn({
          name: v.Name,
          title: isBind ? 'Retirer la déclaration bind' : 'Supprimer',
          icon: 'remove',
          danger: true,
          del: isBind ? String(v.Id || '') : '',
        }) : ''}
      </div>`;
      return `<tr data-search="${bag.esc(search)}" data-resource-id="${bag.esc(v.Name)}" data-resource-name="${bag.esc(v.Name)}" data-bind="${isBind ? '1' : '0'}" data-bind-id="${bag.esc(isBind ? (v.Id || '') : '')}">
      ${all ? '' : bag.bulkSelectTd(v.Name, { disabled: isBind, title: isBind ? 'Les binds se retirent unitairement' : '' })}
      ${all ? `<td class="muted">${bag.esc(v._nodeName || '—')}</td>` : ''}
      <td class="name-cell">
        <strong>${all
          ? bag.esc(v.Name)
          : `<a href="#volumes/${encodeURIComponent(v.Name)}">${bag.esc(v.Name)}</a>`}</strong>
        ${isBind
          ? `<span class="id">${v.StackName ? bag.esc(v.StackName) : 'bind'}</span>`
          : ''}
      </td>
      <td>${bag.esc(driverLabel)}</td>
      <td>${usageCell}</td>
      <td class="mono cell-clip" title="${bag.esc(mount)}">${bag.esc(mount)}</td>
      <td>${bag.formatCreated(v.CreatedAt || v.created_at || v.Created)}</td>
      <td class="actions">${actions}</td>
    </tr>`;
    }).join('');
    const colSpan = all ? 7 : 8;
    bag.root.innerHTML = bag.shell('Volumes', `
      ${bag.pageHeader(all ? 'Volumes — tous les nœuds' : 'Volumes')}
      ${partial ? '<div class="info-box" style="margin-bottom:12px">Agrégat partiel : certains nœuds n’ont pas répondu.</div>' : ''}
      ${all ? bag.pickNodeGuardHtml() : ''}
      <div class="toolbar">
        <input class="search" id="filter" type="search" placeholder="Rechercher des volumes…" value="${bag.esc(bag.state.filters.volumes || '')}">
        ${all ? '' : `${bag.createBtn('create', isAdmin ? 'Créer / déclarer' : 'Créer un volume')}${bag.bulkDeleteBtnHtml()}`}
        <div class="spacer"></div>
        ${all ? '' : '<span class="muted" style="font-size:12px">bind = chemin hôte · sync auto depuis les stacks</span>'}
        <span class="muted mono" id="filter-count">${volumes.length} / ${volumes.length}</span>
      </div>
      <div class="table-wrap"><table class="data">
        <thead><tr>
          ${bag.bulkSelectTh(!all)}
          ${all ? bag.sortTh('Nœud', 'node', 'volumes') : ''}
          ${bag.sortTh('Nom', 'name', 'volumes')}
          ${bag.sortTh('Pilote', 'driver', 'volumes')}
          ${bag.sortTh('Usage', 'usage', 'volumes')}
          ${bag.sortTh('Point de montage', 'mount', 'volumes')}
          ${bag.sortTh('Créé', 'created', 'volumes')}
          <th></th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="${colSpan}" class="empty">Aucun volume</td></tr>`}</tbody>
      </table></div>`, { subtitle: all ? 'Vue agrégée (lecture)' : 'Volumes Docker et binds' });
    bag.bindRefresh();
    bag.bindShareButtons();
    bag.bindPagedSearch('volumes');
    bag.bindTableSort('volumes', () => bag.viewVolumes());
    bag.root.querySelectorAll('[data-vol-key]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const entry = usageByKey.get(btn.dataset.volKey);
        if (entry) bag.openVolumeUsersModal(entry.vol, entry.users);
      });
    });
    if (!all) {
      document.getElementById('create').onclick = () => bag.openCreateVolumeModal();
      bag.bindBulkDelete({
        enabled: true,
        confirmOne: () => 'Supprimer ce volume ?',
        confirmMany: (n) => `Supprimer ${n} volumes ?`,
        deleteOne: (name) => bag.Api.docker(`/volumes/${encodeURIComponent(name)}`, { method: 'DELETE' }),
        reload: () => bag.viewVolumes(),
      });
      bag.root.querySelectorAll('.quick-actions button[data-name]').forEach((btn) => {
        const entry = [...usageByKey.values()].find((e) => e.vol.Name === btn.dataset.name);
        const used = !!(entry && entry.users.length);
        const isBind = !!(entry?.vol?._bind || String(entry?.vol?.Driver || '').toLowerCase() === 'bind');
        bag.onBusyClick(btn, async (el) => {
          if (isBind) {
            const bindId = el.dataset.del || entry?.vol?.Id;
            if (!bindId) throw new Error('Bind introuvable');
            await bag.Api.deleteBindVolume(bindId);
            return;
          }
          await bag.Api.docker(`/volumes/${encodeURIComponent(el.dataset.name)}`, { method: 'DELETE' });
        }, {
          confirm: isBind
            ? 'Retirer cette déclaration bind de la liste ? (le dossier hôte n’est pas supprimé)'
            : (used
              ? 'Ce volume est utilisé par des conteneurs. Supprimer quand même ?'
              : 'Supprimer ce volume ?'),
          reload: true,
        });
      });
    }
    bag.restoreListFocus();
  }

  bag.volumeBreadcrumbs = function volumeBreadcrumbs(volumeName, path) {
    const parts = String(path || '/').split('/').filter(Boolean);
    let acc = '';
    const crumbs = [`<a href="#volumes/${encodeURIComponent(volumeName)}" data-path="/">/</a>`];
    parts.forEach((p) => {
      acc += '/' + p;
      crumbs.push(`<a href="#volumes/${encodeURIComponent(volumeName)}?path=${encodeURIComponent(acc)}" data-path="${bag.esc(acc)}">${bag.esc(p)}</a>`);
    });
    return `<nav class="vol-crumbs">${crumbs.join('<span class="muted"> / </span>')}</nav>`;
  }

  bag.openVolumeFilePreview = async function openVolumeFilePreview(volumeName, path) {
    bag.closeAppModal();
    const host = bag.modalHost();
    host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-form modal-form-wide" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3 class="mono">${bag.esc(path)}</h3>
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
    bag.bindAppModalChrome();
    const body = document.getElementById('vol-file-body');
    const dl = document.getElementById('vol-dl');
    try {
      const file = await bag.Api.volumeFile(volumeName, path);
      const token = bag.Api.getToken();
      dl.href = bag.Api.volumeDownloadUrl(volumeName, path);
      dl.onclick = async (e) => {
        e.preventDefault();
        try {
          const res = await fetch(bag.Api.volumeDownloadUrl(volumeName, path), {
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
        body.innerHTML = `<div class="info-box">Fichier binaire (${bag.esc(bag.formatBytes(file.Size))})${file.Truncated ? ' — aperçu tronqué' : ''}. Utilisez Télécharger.</div>`;
      } else {
        body.innerHTML = `
          <div class="muted" style="margin-bottom:8px;font-size:12px">${bag.esc(bag.formatBytes(file.Size))}${file.Truncated ? ' — aperçu tronqué à 512 Ko' : ''}</div>
          <pre class="logs vol-file-preview">${bag.esc(file.Content || '')}</pre>`;
      }
    } catch (err) {
      body.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
      dl.hidden = true;
    }
  }

  bag.viewVolumeBrowse = async function viewVolumeBrowse(volumeName) {
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
      const token = bag.Api.getToken();
      const res = await fetch(bag.Api.volumeDownloadUrl(volumeName, path), {
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
      bag.hideVolContextMenu();
      try {
        if (action === 'open') {
          if (!entry) return;
          if (entry.type === 'dir') goPath(entry.path);
          else await bag.openVolumeFilePreview(volumeName, entry.path);
          return;
        }
        if (action === 'refresh') {
          await render(currentPath);
          return;
        }
        if (action === 'new-file') {
          const name = await bag.promptName({
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
          await bag.Api.volumeWriteFile(volumeName, joinVolPath(currentPath, name), { Content: '', CreateOnly: true });
          await render(currentPath);
          return;
        }
        if (action === 'new-dir') {
          const name = await bag.promptName({
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
          await bag.Api.volumeMkdir(volumeName, joinVolPath(currentPath, name));
          await render(currentPath);
          return;
        }
        if (action === 'rename' && entry) {
          const name = await bag.promptName({
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
          await bag.Api.volumeRename(volumeName, entry.path, to);
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
          await bag.Api.volumeDeleteEntry(volumeName, entry.path);
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
      const menu = bag.showVolContextMenu(ev.clientX, ev.clientY, items);
      menu.querySelectorAll('[data-act]').forEach((btn) => {
        btn.addEventListener('click', () => runVolAction(btn.getAttribute('data-act'), entry));
      });
    }

    function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const bytes = new Uint8Array(reader.result || new ArrayBuffer(0));
          let binary = '';
          const chunk = 0x8000;
          for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
          }
          resolve(btoa(binary));
        };
        reader.onerror = () => reject(new Error('Lecture fichier impossible'));
        reader.readAsArrayBuffer(file);
      });
    }

    function readAllDirectoryEntries(reader) {
      return new Promise((resolve, reject) => {
        const all = [];
        const readBatch = () => {
          reader.readEntries((batch) => {
            if (!batch.length) {
              resolve(all);
              return;
            }
            all.push(...batch);
            readBatch();
          }, reject);
        };
        readBatch();
      });
    }

    /**
     * Snapshot DataTransfer synchronously during the drop event.
     * After any await, browsers clear items/files (often leaving only 1 entry).
     */
    function snapshotDataTransfer(dataTransfer) {
      const rootEntries = [];
      const flatFiles = [];
      const items = dataTransfer && dataTransfer.items ? Array.from(dataTransfer.items) : [];
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        if (!item || item.kind !== 'file') continue;
        let entry = null;
        try {
          if (typeof item.webkitGetAsEntry === 'function') entry = item.webkitGetAsEntry();
        } catch (_) { /* ignore */ }
        if (entry) {
          rootEntries.push(entry);
          continue;
        }
        try {
          const f = typeof item.getAsFile === 'function' ? item.getAsFile() : null;
          if (f) flatFiles.push(f);
        } catch (_) { /* ignore */ }
      }
      if (!rootEntries.length && !flatFiles.length) {
        Array.from((dataTransfer && dataTransfer.files) || []).forEach((f) => flatFiles.push(f));
      }
      return { rootEntries, flatFiles };
    }

    async function collectDropEntries(snapshot, destDir) {
      const files = [];
      const dirs = new Set();
      const rootEntries = (snapshot && snapshot.rootEntries) || [];
      const flatFiles = (snapshot && snapshot.flatFiles) || [];

      async function walkEntry(entry, parentRel) {
        if (!entry) return;
        const rel = parentRel ? `${parentRel}/${entry.name}` : entry.name;
        if (entry.isFile) {
          const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
          files.push({ relPath: rel, file });
          return;
        }
        if (entry.isDirectory) {
          dirs.add(rel);
          const reader = entry.createReader();
          const children = await readAllDirectoryEntries(reader);
          for (const child of children) {
            await walkEntry(child, rel);
          }
        }
      }

      if (rootEntries.length) {
        for (const entry of rootEntries) {
          await walkEntry(entry, '');
        }
      } else {
        flatFiles.forEach((file) => {
          const rel = file.webkitRelativePath || file.name;
          files.push({ relPath: rel, file });
        });
      }

      // Ensure parent dirs of files exist even without DirectoryEntry
      files.forEach(({ relPath }) => {
        const parts = String(relPath).split('/');
        let acc = '';
        for (let i = 0; i < parts.length - 1; i += 1) {
          acc = acc ? `${acc}/${parts[i]}` : parts[i];
          dirs.add(acc);
        }
      });

      const sortedDirs = Array.from(dirs).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
      return { destDir, dirs: sortedDirs, files };
    }

    let volUploadBusy = false;

    function openVolumeUploadModal() {
      bag.closeAppModal();
      const host = bag.modalHost();
      host.innerHTML = `
        <div class="modal-backdrop vol-up-backdrop" data-no-dismiss="1">
          <div class="modal modal-form vol-up-modal" role="dialog" aria-modal="true" aria-labelledby="vol-up-title">
            <div class="modal-head">
              <div>
                <h3 id="vol-up-title">Envoi vers le volume</h3>
                <p class="modal-sub" id="vol-up-sub">Préparation…</p>
              </div>
            </div>
            <div class="vol-up-body">
              <div class="progress vol-up-bar-wrap"><span id="vol-up-bar" style="width:0%"></span></div>
              <div class="vol-up-meta">
                <span id="vol-up-count">0 / 0</span>
                <span id="vol-up-pct">0 %</span>
              </div>
              <p class="muted mono vol-up-file" id="vol-up-file"></p>
              <div id="vol-up-err"></div>
            </div>
            <div class="actions-bar">
              <button type="button" class="btn btn-primary" id="vol-up-close" hidden>Fermer</button>
            </div>
          </div>
        </div>`;
      document.getElementById('vol-up-close')?.addEventListener('click', () => bag.closeAppModal());
      return {
        setProgress({ done, total, label, phase }) {
          const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
          const bar = document.getElementById('vol-up-bar');
          const count = document.getElementById('vol-up-count');
          const pctEl = document.getElementById('vol-up-pct');
          const fileEl = document.getElementById('vol-up-file');
          const sub = document.getElementById('vol-up-sub');
          if (bar) bar.style.width = `${pct}%`;
          if (count) count.textContent = `${done} / ${total}`;
          if (pctEl) pctEl.textContent = `${pct} %`;
          if (fileEl) fileEl.textContent = label || '';
          if (sub) sub.textContent = phase || 'Envoi en cours…';
        },
        done(ok, message) {
          const sub = document.getElementById('vol-up-sub');
          const err = document.getElementById('vol-up-err');
          const closeBtn = document.getElementById('vol-up-close');
          const bar = document.getElementById('vol-up-bar');
          if (ok) {
            if (sub) sub.textContent = message || 'Terminé';
            if (bar) {
              bar.style.width = '100%';
              bar.classList.add('is-done');
            }
            if (closeBtn) closeBtn.hidden = false;
            setTimeout(() => bag.closeAppModal(), 900);
          } else {
            if (sub) sub.textContent = 'Échec de l’envoi';
            if (err) err.innerHTML = `<div class="error-box">${bag.esc(message || 'Erreur')}</div>`;
            if (closeBtn) closeBtn.hidden = false;
          }
        },
      };
    }

    async function uploadDropped(snapshotOrDt) {
      if (volUploadBusy) return;
      // Accept a pre-built snapshot (preferred) or raw DataTransfer (legacy)
      const snapshot = snapshotOrDt && Array.isArray(snapshotOrDt.rootEntries)
        ? snapshotOrDt
        : snapshotDataTransfer(snapshotOrDt);
      if (!snapshot.rootEntries.length && !snapshot.flatFiles.length) return;
      volUploadBusy = true;
      const errBox = document.getElementById('vol-err');
      if (errBox) errBox.innerHTML = '';
      const modal = openVolumeUploadModal();
      try {
        modal.setProgress({ done: 0, total: 1, label: '', phase: 'Analyse des fichiers…' });
        const payload = await collectDropEntries(snapshot, currentPath);
        if (!payload.files.length && !payload.dirs.length) {
          bag.closeAppModal();
          return;
        }
        // Tous types MIME / extensions — limite 300 Mo (upload binaire)
        const maxBytes = 300 * 1000 * 1000;
        for (const { file, relPath } of payload.files) {
          if (file.size > maxBytes) {
            throw new Error(`« ${relPath} » dépasse 300 Mo (limite d’upload)`);
          }
        }
        let done = 0;
        const total = payload.dirs.length + payload.files.length;
        modal.setProgress({
          done: 0,
          total,
          label: '',
          phase: `${payload.files.length} fichier(s) · ${payload.dirs.length} dossier(s)`,
        });
        for (const dir of payload.dirs) {
          done += 1;
          modal.setProgress({
            done,
            total,
            label: dir,
            phase: 'Création des dossiers…',
          });
          await bag.Api.volumeMkdir(volumeName, joinVolPath(currentPath, dir));
        }
        for (const { file, relPath } of payload.files) {
          done += 1;
          const typeHint = file.type ? ` (${file.type})` : '';
          const sizeHint = file.size >= 1000 * 1000
            ? ` · ${(file.size / (1000 * 1000)).toFixed(1)} Mo`
            : '';
          modal.setProgress({
            done,
            total,
            label: `${relPath}${typeHint}${sizeHint}`,
            phase: 'Envoi des fichiers…',
          });
          await bag.Api.volumeUploadFile(
            volumeName,
            joinVolPath(currentPath, relPath),
            file,
            { CreateOnly: false },
          );
        }
        modal.setProgress({ done: total, total, label: '', phase: 'Actualisation…' });
        await render(currentPath);
        modal.done(true, `${payload.files.length} fichier(s), ${payload.dirs.length} dossier(s) envoyés`);
      } catch (err) {
        modal.done(false, err.message || String(err));
        const box = document.getElementById('vol-err');
        if (box) box.innerHTML = `<div class="error-box">${bag.esc(err.message || String(err))}</div>`;
      } finally {
        volUploadBusy = false;
      }
    }

    function hasFilesType(dt) {
      try {
        return Array.from(dt.types || []).includes('Files');
      } catch {
        return false;
      }
    }

    function bindVolumeDrop(explorer) {
      let dragDepth = 0;
      const onDragEnter = (ev) => {
        if (!hasFilesType(ev.dataTransfer)) return;
        ev.preventDefault();
        dragDepth += 1;
        explorer.classList.add('is-dragover');
      };
      const onDragOver = (ev) => {
        if (!hasFilesType(ev.dataTransfer)) return;
        ev.preventDefault();
        ev.dataTransfer.dropEffect = volUploadBusy ? 'none' : 'copy';
      };
      const onDragLeave = () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) explorer.classList.remove('is-dragover');
      };
      const onDrop = (ev) => {
        if (!hasFilesType(ev.dataTransfer)) return;
        ev.preventDefault();
        ev.stopPropagation();
        dragDepth = 0;
        explorer.classList.remove('is-dragover');
        // Do not await here: snapshot must run in the same sync turn as the drop event
        const snapshot = snapshotDataTransfer(ev.dataTransfer);
        void uploadDropped(snapshot);
      };
      explorer.addEventListener('dragenter', onDragEnter);
      explorer.addEventListener('dragover', onDragOver);
      explorer.addEventListener('dragleave', onDragLeave);
      explorer.addEventListener('drop', onDrop);
    }

    async function render(path) {
      bag.hideVolContextMenu();
      bag.root.innerHTML = bag.shell(`Volume · ${volumeName}`, `
        ${bag.pageHeader(volumeName, false)}
        <div class="toolbar">
          ${bag.iconBtn({ tag: 'a', href: '#volumes', title: 'Retour', icon: 'back' })}
          <button type="button" class="btn btn-sm" id="vol-new-file">Nouveau fichier</button>
          <button type="button" class="btn btn-sm" id="vol-new-dir">Nouveau dossier</button>
          <div class="spacer"></div>
          <span class="muted">Glisser-déposer fichiers/dossiers · clic droit</span>
          <span class="muted mono">${bag.esc(volumeName)}</span>
        </div>
        <div id="vol-err"></div>
        ${bag.volumeBreadcrumbs(volumeName, path)}
        <div class="table-wrap vol-explorer" id="vol-explorer">
          <div class="vol-drop-hint">Déposez un ou plusieurs fichiers / dossiers ici</div>
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
      bindVolumeDrop(explorer);
      explorer.addEventListener('contextmenu', (ev) => {
        if (ev.target.closest('.vol-row[data-entry]')) return;
        openCtx(ev, null);
      });

      try {
        const data = await bag.Api.volumeBrowse(volumeName, path);
        currentPath = data.Path || path;
        bag.root.querySelectorAll('.vol-crumbs a').forEach((a) => {
          a.addEventListener('click', (e) => {
            e.preventDefault();
            goPath(a.getAttribute('data-path') || '/');
          });
        });
        const entries = data.Entries || [];
        const parentPath = currentPath === '/' ? null : currentPath.replace(/\/[^/]+\/?$/, '') || '/';
        let rows = '';
        if (parentPath != null) {
          rows += `<tr class="vol-row" data-dir="${bag.esc(parentPath)}">
            <td colspan="3"><a href="#" class="vol-link" data-dir="${bag.esc(parentPath)}">../</a></td>
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
            const size = isDir ? '—' : bag.formatBytes(e.Size || 0);
            return `<tr class="vol-row" data-entry="1" data-type="${isDir ? 'dir' : 'file'}" data-path="${bag.esc(e.Path)}" data-name="${bag.esc(e.Name)}">
              <td>
                <a href="#" class="vol-link" data-${isDir ? 'dir' : 'file'}="${bag.esc(e.Path)}">
                  <span class="vol-ico">${bag.ico(icon)}</span>${bag.esc(e.Name)}${isDir ? '/' : ''}
                </a>
              </td>
              <td class="mono">${bag.esc(size)}</td>
              <td class="muted">${bag.esc(when)}</td>
              <td class="actions"><div class="quick-actions">
                ${isDir ? '' : `<button type="button" class="btn btn-icon btn-sm" title="Aperçu" data-file="${bag.esc(e.Path)}"><span class="btn-ico">${bag.ico('logs')}</span></button>`}
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
            bag.openVolumeFilePreview(volumeName, el.getAttribute('data-file') || '');
          });
        });
      } catch (err) {
        tbody.innerHTML = `<tr><td colspan="4" class="empty">—</td></tr>`;
        if (errBox) errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
      }
    }

    await render(currentPath);
  }

  bag.containersUsingVolume = function containersUsingVolume(vol, containers) {
    const volName = String(vol?.Name || '');
    const hostPath = String(vol?.HostPath || vol?.Mountpoint || '');
    const isBind = !!(vol?._bind || String(vol?.Driver || '').toLowerCase() === 'bind');
    if (!volName && !hostPath) return [];
    return (containers || []).filter((c) => {
      if (vol?._nodeId != null && c?._nodeId != null && Number(vol._nodeId) !== Number(c._nodeId)) {
        return false;
      }
      const mounts = Array.isArray(c.Mounts) ? c.Mounts : [];
      return mounts.some((m) => {
        const type = String(m.Type || '').toLowerCase();
        if (isBind) {
          if (type && type !== 'bind') return false;
          const src = String(m.Source || m.SourcePath || '');
          return hostPath !== '' && (src === hostPath || src.startsWith(hostPath + '/'));
        }
        if (type && type !== 'volume') return false;
        return m.Name === volName;
      });
    });
  }

  bag.openVolumeUsersModal = function openVolumeUsersModal(vol, users) {
    const isBind = !!(vol?._bind || String(vol?.Driver || '').toLowerCase() === 'bind');
    bag.openResourceUsersModal({
      title: isBind ? 'Conteneurs utilisant ce bind' : 'Conteneurs utilisant ce volume',
      subtitle: isBind ? `${vol?.Name || ''} → ${vol?.HostPath || vol?.Mountpoint || ''}` : (vol?.Name || ''),
      users,
      extraCol: (c) => {
        const mounts = (c.Mounts || []).filter((m) => {
          if (isBind) {
            const src = String(m.Source || '');
            const host = String(vol?.HostPath || vol?.Mountpoint || '');
            return src === host || src.startsWith(host + '/');
          }
          return m.Name === vol?.Name;
        });
        return mounts.map((m) => m.Destination || m.Target || '').filter(Boolean).join(', ') || c.Image || '';
      },
    });
  }

  bag.hideVolContextMenu = function hideVolContextMenu() {
    const el = document.getElementById('vol-ctx');
    if (el) el.remove();
  }

  bag.showVolContextMenu = function showVolContextMenu(x, y, items) {
    bag.hideVolContextMenu();
    const menu = document.createElement('div');
    menu.id = 'vol-ctx';
    menu.className = 'vol-ctx';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = items.map((it) => {
      if (it === '—') return '<div class="vol-ctx-sep" role="separator"></div>';
      const danger = it.danger ? ' is-danger' : '';
      const disabled = it.disabled ? ' is-disabled' : '';
      return `<button type="button" class="vol-ctx-item${danger}${disabled}" role="menuitem" data-act="${bag.esc(it.id)}" ${it.disabled ? 'disabled' : ''}>${bag.esc(it.label)}</button>`;
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
        bag.hideVolContextMenu();
        document.removeEventListener('mousedown', onDoc, true);
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('scroll', onDoc, true);
      }
    };
    const onKey = (ev) => {
      if (ev.key === 'Escape') {
        bag.hideVolContextMenu();
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

}
