import { bag } from '../bag.js';

export function install() {
  bag.registryHost = function registryHost(reg) {
    return String(reg?.URL || '').replace(/^https?:\/\//i, '').replace(/\/$/, '');
  }

  bag.registryImageRef = function registryImageRef(reg, repo, tag) {
    const t = tag || 'latest';
    if (bag.registryKind(reg) === 'hub') return `${repo}:${t}`;
    return `${bag.registryHost(reg)}/${repo}:${t}`;
  }

  bag.openCreateRegistryModal = function openCreateRegistryModal() {
    bag.openRegistryModal(null);
  }

  bag.openEditRegistryModal = function openEditRegistryModal(reg) {
    bag.openRegistryModal(reg);
  }

  /** @param {object|null} existing */

  bag.openRegistryModal = function openRegistryModal(existing) {
    const isEdit = !!(existing && existing.Id);
    bag.closeAppModal();
    const host = bag.modalHost();
    const type = bag.registryKind(existing) === 'hub' ? 'hub' : 'v2';
    host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-form" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3>${isEdit ? 'Modifier le registre' : 'Ajouter un registre'}</h3>
              <div class="modal-sub">Docker Hub ou Registry V2 (http/https)</div>
            </div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">✕</button>
          </div>
          <div id="create-err"></div>
          <div class="form-group">
            <label class="field-label">Nom <span class="req">*</span></label>
            <input id="r-name" placeholder="Mon registre" autocomplete="off" value="${bag.esc(existing?.Name || '')}">
          </div>
          <div class="form-group">
            <label class="field-label">Type</label>
            <select id="r-type" class="select-block">
              <option value="hub"${type === 'hub' ? ' selected' : ''}>Docker Hub</option>
              <option value="v2"${type === 'v2' ? ' selected' : ''}>Registry V2</option>
            </select>
          </div>
          <div class="form-group" id="r-url-wrap">
            <label class="field-label">URL <span class="req">*</span></label>
            <input id="r-url" placeholder="http://192.168.1.10:5000 ou https://registry.example.com" autocomplete="off" value="${bag.esc(type === 'hub' ? 'https://docker.io' : (existing?.URL || ''))}">
            <p class="field-hint muted">Ex. registre local : <code>http://192.168.1.254:5000</code></p>
          </div>
          <div class="form-group">
            <label class="field-label">Utilisateur / e-mail</label>
            <input id="r-user" placeholder="user ou email@domaine.tld" autocomplete="username" value="${bag.esc(existing?.Username || '')}">
          </div>
          <div class="form-group">
            <label class="field-label">Mot de passe / jeton (PAT)</label>
            <input id="r-pass" type="password" placeholder="${isEdit ? 'Laisser vide pour ne pas changer' : 'optionnel'}" autocomplete="${isEdit ? 'new-password' : 'current-password'}">
            <p class="field-hint muted">E-mail + jeton acceptés (Docker Hub, Harness/Gitness, Registry V2).</p>
            ${isEdit && existing?.Authentication ? '<p class="field-hint muted">Un secret est déjà enregistré. Laissez vide pour le conserver.</p>' : ''}
          </div>
          ${isEdit ? `<div class="form-group">
            <label class="field-inline" style="gap:8px;cursor:pointer">
              <input type="checkbox" id="r-clear-pass">
              <span>Effacer le mot de passe enregistré</span>
            </label>
          </div>` : ''}
          <div class="actions-bar">
            <button type="button" class="btn btn-primary" id="r-save">${isEdit ? 'Enregistrer' : 'Ajouter'}</button>
            <button type="button" class="btn" data-close-modal>Annuler</button>
          </div>
        </div>
      </div>`;
    bag.bindAppModalChrome();
    const typeSel = document.getElementById('r-type');
    const urlWrap = document.getElementById('r-url-wrap');
    const urlInput = document.getElementById('r-url');
    const syncType = () => {
      const hub = typeSel.value === 'hub';
      urlWrap.hidden = hub;
      if (hub) urlInput.value = 'https://docker.io';
      else if (urlInput.value === 'https://docker.io') urlInput.value = existing?.URL && bag.registryKind(existing) !== 'hub' ? existing.URL : '';
    };
    typeSel.addEventListener('change', syncType);
    syncType();
    document.getElementById('r-name')?.focus();
    bag.onBusyClick(document.getElementById('r-save'), async () => {
      const errBox = document.getElementById('create-err');
      errBox.innerHTML = '';
      const Name = document.getElementById('r-name').value.trim();
      const Type = document.getElementById('r-type').value;
      const URL = Type === 'hub' ? 'https://docker.io' : document.getElementById('r-url').value.trim();
      const Username = document.getElementById('r-user').value.trim();
      const Password = document.getElementById('r-pass').value;
      const ClearPassword = !!document.getElementById('r-clear-pass')?.checked;
      if (!Name || !URL) {
        errBox.innerHTML = `<div class="error-box">Le nom et l’URL sont requis.</div>`;
        return;
      }
      try {
        if (isEdit) {
          const payload = { Name, URL, Type, Username };
          if (ClearPassword) payload.ClearPassword = true;
          else if (Password) payload.Password = Password;
          await bag.Api.updateRegistry(existing.Id, payload);
        } else {
          await bag.Api.createRegistry({ Name, URL, Type, Username, Password });
        }
        bag.closeAppModal();
        await bag.route();
      } catch (err) {
        errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
      }
    }, { disableSiblings: false, minMs: 300 });
  }

  bag.viewRegistries = async function viewRegistries() {
    const list = await bag.Api.registries();
    const rows = (list || []).map((r) => {
      const kind = bag.registryKind(r);
      const search = `${r.Name} ${r.URL} ${kind} ${r.Username || ''}`.toLowerCase();
      const typeLabel = kind === 'hub' ? 'Docker Hub' : 'Registry V2';
      return `<tr data-search="${bag.esc(search)}">
        <td><a href="#registries/${r.Id}">${bag.esc(r.Name)}</a></td>
        <td class="mono">${bag.esc(r.URL)}</td>
        <td>${bag.esc(typeLabel)}</td>
        <td>${r.Authentication ? bag.esc(r.Username || 'authentifié') : '<span class="muted">anonyme</span>'}</td>
        <td class="actions"><div class="quick-actions">
          ${bag.iconBtn({ tag: 'a', href: `#registries/${r.Id}`, title: 'Parcourir', icon: 'search' })}
          ${bag.iconBtn({ act: 'edit-reg', id: r.Id, title: 'Modifier', icon: 'edit', info: true })}
          ${bag.iconBtn({ del: r.Id, title: 'Supprimer', icon: 'remove', danger: true })}
        </div></td>
      </tr>`;
    }).join('');
    bag.root.innerHTML = bag.shell('Registres', `
      ${bag.pageHeader('Registres')}
      ${bag.settingsSubnav('registries')}
      <div class="toolbar">
        <input class="search" id="filter" type="search" placeholder="Rechercher des registres…" value="${bag.esc(bag.state.filters.registries || '')}">
        ${bag.createBtn('create-registry', 'Ajouter un registre')}
        <div class="spacer"></div>
        <span class="muted mono" id="filter-count">${(list || []).length} / ${(list || []).length}</span>
      </div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Nom</th><th>URL</th><th>Type</th><th>Auth</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5" class="empty">Aucun registre</td></tr>`}</tbody>
      </table></div>`, { subtitle: 'Connexion aux registres d’images' });
    bag.bindRefresh();
    bag.bindSearch('registries');
    document.getElementById('create-registry').onclick = () => bag.openCreateRegistryModal();
    const byId = new Map((list || []).map((r) => [String(r.Id), r]));
    bag.root.querySelectorAll('[data-act="edit-reg"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const reg = byId.get(String(btn.dataset.id));
        if (reg) bag.openEditRegistryModal(reg);
      });
    });
    bag.root.querySelectorAll('[data-del]').forEach((btn) => {
      bag.onBusyClick(btn, async (el) => {
        await bag.Api.deleteRegistry(el.dataset.del);
      }, { confirm: 'Supprimer ce registre ?', reload: true });
    });
  }

  bag.viewRegistryBrowse = async function viewRegistryBrowse(id) {
    const reg = await bag.Api.registry(id);
    let selectedRepo = '';
    let searchTimer = null;

    bag.root.innerHTML = bag.shell(`Registre · ${reg.Name}`, `
      ${bag.pageHeader(reg.Name, false)}
      ${bag.settingsSubnav('registries')}
      <div class="toolbar">
        ${bag.iconBtn({ tag: 'a', href: '#registries', title: 'Retour', icon: 'back' })}
        ${bag.iconBtn({ elId: 'reg-edit', title: 'Modifier la config', icon: 'edit', info: true })}
        <div class="spacer"></div>
        <span class="muted mono">${bag.esc(reg.URL)} · ${bag.registryKind(reg) === 'hub' ? 'Docker Hub' : 'V2'}</span>
      </div>
      <div id="reg-err"></div>
      <div class="reg-browse">
        <div class="reg-pane">
          <div class="reg-pane-head">
            <label class="field-label">Dépôts</label>
            <input class="search" id="reg-q" type="search" placeholder="${bag.registryKind(reg) === 'hub' ? 'Rechercher sur Docker Hub…' : 'Filtrer le catalogue…'}" autocomplete="off">
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
    document.getElementById('reg-edit')?.addEventListener('click', () => bag.openEditRegistryModal(reg));

    async function loadTags(repo) {
      selectedRepo = repo;
      repoLabel.textContent = repo ? `· ${repo}` : '';
      tagsEl.innerHTML = `<div class="muted" style="padding:12px">Chargement des tags…</div>`;
      try {
        const data = await bag.Api.registryTags(id, repo);
        const tags = data?.Tags || [];
        if (!tags.length) {
          tagsEl.innerHTML = `<div class="muted" style="padding:12px">Aucun tag</div>`;
          return;
        }
        tagsEl.innerHTML = tags.map((t) => {
          const ref = bag.registryImageRef(reg, repo, t.Name);
          const meta = [
            t.Size ? bag.formatBytes(t.Size) : '',
            t.LastUpdated ? new Date(t.LastUpdated).toLocaleDateString() : '',
          ].filter(Boolean).join(' · ');
          return `<div class="reg-item">
            <div class="reg-item-main">
              <div class="mono">${bag.esc(t.Name)}</div>
              ${meta ? `<div class="muted" style="font-size:12px">${bag.esc(meta)}</div>` : ''}
            </div>
            <div class="quick-actions">
              <button type="button" class="btn btn-icon btn-sm" title="Pull ${bag.esc(ref)}" aria-label="Pull" data-repo="${bag.esc(repo)}" data-tag="${bag.esc(t.Name)}">
                <span class="btn-ico">${bag.ico('pull')}</span>
              </button>
            </div>
          </div>`;
        }).join('');
        tagsEl.querySelectorAll('[data-repo][data-tag]').forEach((btn) => {
          bag.onBusyClick(btn, async (el) => {
            errBox.innerHTML = '';
            const repository = el.getAttribute('data-repo') || '';
            const tag = el.getAttribute('data-tag') || 'latest';
            const ref = bag.registryImageRef(reg, repository, tag);
            try {
              await bag.Api.registryPull(id, repository, tag);
              errBox.innerHTML = `<div class="info-box">Pull terminé : <code>${bag.esc(ref)}</code></div>`;
            } catch (err) {
              errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
            }
          }, { disableSiblings: false, minMs: 300 });
        });
      } catch (err) {
        tagsEl.innerHTML = `<div class="error-box" style="margin:12px">${bag.esc(err.message)}</div>`;
      }
    }

    async function loadRepos(q) {
      reposEl.innerHTML = `<div class="muted" style="padding:12px">Recherche…</div>`;
      try {
        const data = await bag.Api.registryRepos(id, q, 60);
        const repos = data?.Repositories || [];
        if (!repos.length) {
          const hint = bag.registryKind(reg) === 'hub' && !q
            ? 'Saisissez un terme pour rechercher sur Docker Hub (ex. nginx), ou ajoutez des identifiants pour lister vos dépôts.'
            : (q
              ? 'Aucun dépôt ne correspond au filtre.'
              : 'Aucun dépôt trouvé. Vérifiez e-mail/jeton, ou saisissez le chemin du dépôt si le registre n’expose pas de catalogue.');
          reposEl.innerHTML = `<div class="muted" style="padding:12px">${bag.esc(hint)}</div>`;
          return;
        }
        reposEl.innerHTML = repos.map((r) => `
          <button type="button" class="reg-item reg-item-btn${selectedRepo === r.Name ? ' active' : ''}" data-repo="${bag.esc(r.Name)}">
            <div class="reg-item-main">
              <div class="mono">${bag.esc(r.Name)}${r.Official ? ' <span class="img-selected-badge is-hub">Officiel</span>' : ''}</div>
              ${r.Description ? `<div class="muted reg-item-desc">${bag.esc(r.Description)}</div>` : ''}
            </div>
            ${r.StarCount || r.PullCount ? `<div class="muted" style="font-size:11px;flex-shrink:0">★ ${bag.esc(String(r.StarCount || 0))}</div>` : ''}
          </button>`).join('');
        reposEl.querySelectorAll('[data-repo]').forEach((btn) => {
          btn.addEventListener('click', () => {
            reposEl.querySelectorAll('.reg-item-btn').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            loadTags(btn.getAttribute('data-repo') || '');
          });
        });
      } catch (err) {
        reposEl.innerHTML = `<div class="error-box" style="margin:12px">${bag.esc(err.message)}</div>`;
      }
    }

    qInput?.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => loadRepos(qInput.value.trim()), 320);
    });
    await loadRepos('');
  }

  bag.registryKind = function registryKind(reg) {
    if (!reg) return 'v2';
    if (reg.RegistryKind) return String(reg.RegistryKind);
    if (reg.Type === 'hub' || Number(reg.Type) === 6) return 'hub';
    if (reg.Type === 'v2' || Number(reg.Type) === 3) return 'v2';
    return String(reg.Type || 'v2');
  }

}
