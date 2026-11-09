import { bag } from '../bag.js';

export function install() {
  bag.shareBtn = function shareBtn(type, key, title = 'Partager') {
    return bag.iconBtn({
      title,
      icon: 'users',
      info: true,
      shareType: type,
      shareKey: key,
    });
  };

  bag.bindShareButtons = function bindShareButtons(scope = bag.root) {
    if (!scope) return;
    scope.querySelectorAll('[data-share-type]').forEach((btn) => {
      btn.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const type = btn.dataset.shareType;
        const key = btn.dataset.shareKey;
        if (!type || !key) return;
        await bag.openShareModal(type, key);
      };
    });
  };

  bag.openShareModal = async function openShareModal(type, key) {
    const endpointId = bag.Api.getEndpointId();
    if (!endpointId || bag.Api.isAllEndpoints()) {
      alert('Choisissez un nœud pour partager');
      return;
    }
    bag.closeAppModal();
    const host = bag.modalHost();
    const typeLabel = ({
      stack: 'stack',
      container: 'conteneur',
      volume: 'volume',
      network: 'réseau',
    })[type] || type;

    host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-form" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3>Partager ce ${bag.esc(typeLabel)}</h3>
              <div class="modal-sub mono">${bag.esc(key)}</div>
            </div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">✕</button>
          </div>
          <p class="muted" style="margin:0 0 14px">${
            type === 'stack'
              ? 'En plus des droits nœuds. Inclut aussi les conteneurs, volumes et réseaux Compose de cette stack.'
              : 'En plus des droits nœuds — le destinataire pourra utiliser cette ressource.'
          }</p>
          <div id="share-err"></div>
          <div class="form-group">
            <label class="field-label">Utilisateur</label>
            <div class="img-search" id="share-user-wrap">
              <input id="share-user-q" type="search" placeholder="Rechercher un utilisateur…" autocomplete="off" spellcheck="false">
              <div class="img-search-panel" id="share-user-panel" hidden>
                <div class="img-search-hint muted" id="share-user-hint">Saisissez un nom…</div>
                <div id="share-user-results"></div>
              </div>
            </div>
            <div class="img-selected" id="share-user-sel" hidden>
              <span class="img-selected-badge is-local">User</span>
              <code class="mono" id="share-user-ref"></code>
              <button type="button" class="icon-btn img-selected-clear" id="share-user-clear" title="Changer" aria-label="Changer">✕</button>
            </div>
          </div>
          <div class="actions-bar">
            <button type="button" class="btn btn-primary" id="share-add">Partager</button>
            <button type="button" class="btn" data-close-modal>Annuler</button>
          </div>
          <div class="section-title" style="margin-top:18px">Déjà partagé avec</div>
          <div id="share-list" class="muted">Chargement…</div>
        </div>
      </div>`;
    bag.bindAppModalChrome();

    const errBox = document.getElementById('share-err');
    const listEl = document.getElementById('share-list');
    const addBtn = document.getElementById('share-add');
    const qInput = document.getElementById('share-user-q');
    const panel = document.getElementById('share-user-panel');
    const resultsEl = document.getElementById('share-user-results');
    const hintEl = document.getElementById('share-user-hint');
    const wrap = document.getElementById('share-user-wrap');
    const selBox = document.getElementById('share-user-sel');
    const selRef = document.getElementById('share-user-ref');
    const clearBtn = document.getElementById('share-user-clear');

    let directory = [];
    let selected = null; // { Id, Username }

    const showErr = (msg) => {
      errBox.innerHTML = msg ? `<div class="error-box">${bag.esc(msg)}</div>` : '';
    };

    const hidePanel = () => { panel.hidden = true; };

    const clearSelection = () => {
      selected = null;
      selBox.hidden = true;
      wrap.classList.remove('is-picked');
      qInput.value = '';
      qInput.focus();
    };

    const pickUser = (u) => {
      selected = u;
      selRef.textContent = u.Username;
      selBox.hidden = false;
      wrap.classList.add('is-picked');
      qInput.value = '';
      hidePanel();
      showErr('');
    };

    const renderResults = (q) => {
      const needle = String(q || '').trim().toLowerCase();
      if (!needle) {
        resultsEl.innerHTML = '';
        hintEl.hidden = false;
        hintEl.textContent = directory.length
          ? 'Saisissez un nom…'
          : 'Aucun autre utilisateur';
        panel.hidden = false;
        return;
      }
      const matches = directory
        .filter((u) => String(u.Username || '').toLowerCase().includes(needle))
        .slice(0, 12);
      hintEl.hidden = true;
      if (!matches.length) {
        resultsEl.innerHTML = `<div class="img-search-hint muted">Aucun résultat pour « ${bag.esc(q)} »</div>`;
      } else {
        resultsEl.innerHTML = matches.map((u) => `
          <button type="button" class="img-search-item" data-uid="${bag.esc(u.Id)}">
            <div class="img-search-main">
              <span class="img-search-name">${bag.esc(u.Username)}</span>
            </div>
          </button>`).join('');
        resultsEl.querySelectorAll('[data-uid]').forEach((btn) => {
          btn.onclick = () => {
            const id = parseInt(btn.dataset.uid, 10);
            const u = directory.find((x) => Number(x.Id) === id);
            if (u) pickUser(u);
          };
        });
      }
      panel.hidden = false;
    };

    qInput.addEventListener('input', () => renderResults(qInput.value));
    qInput.addEventListener('focus', () => renderResults(qInput.value));
    qInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hidePanel();
    });
    clearBtn.onclick = () => clearSelection();
    document.addEventListener('click', function onDocClick(e) {
      if (!host.contains(e.target)) return;
      if (wrap.contains(e.target) || selBox.contains(e.target)) return;
      hidePanel();
    });

    const renderList = (shares) => {
      if (!shares.length) {
        listEl.innerHTML = '<span class="muted">Aucun partage pour l’instant.</span>';
        return;
      }
      listEl.innerHTML = `<table class="data"><tbody>${shares.map((s) => `
        <tr>
          <td>${bag.esc(s.GranteeUsername || s.GranteeUserId)}</td>
          <td class="actions">
            <button type="button" class="btn btn-icon btn-sm btn-danger" data-unshare="${bag.esc(s.Id)}" title="Retirer">
              <span class="btn-ico">${bag.ico('remove')}</span>
            </button>
          </td>
        </tr>`).join('')}</tbody></table>`;
      listEl.querySelectorAll('[data-unshare]').forEach((btn) => {
        btn.onclick = async () => {
          try {
            await bag.withBusy(btn, () => bag.Api.deleteShare(btn.dataset.unshare));
            await refresh();
          } catch (err) {
            showErr(err.message || String(err));
          }
        };
      });
    };

    const refresh = async () => {
      showErr('');
      try {
        const shares = await bag.Api.listShares(type, endpointId, key);
        renderList(Array.isArray(shares) ? shares : []);
      } catch (err) {
        listEl.innerHTML = '';
        showErr(err.message || String(err));
      }
    };

    try {
      const users = await bag.Api.usersDirectory();
      directory = Array.isArray(users) ? users : [];
    } catch (err) {
      directory = [];
      showErr(err.message || String(err));
    }

    addBtn.onclick = async () => {
      if (!selected?.Id) {
        showErr('Recherchez et sélectionnez un utilisateur');
        qInput.focus();
        return;
      }
      try {
        await bag.withBusy(addBtn, () => bag.Api.createShare({
          Type: type,
          EndpointId: endpointId,
          Key: key,
          GranteeUserId: selected.Id,
        }));
        clearSelection();
        await refresh();
      } catch (err) {
        showErr(err.message || String(err));
      }
    };

    await refresh();
    qInput.focus();
  };
}
