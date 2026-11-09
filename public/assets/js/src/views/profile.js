import { bag } from '../bag.js';

export function install() {
  bag.viewProfile = async function viewProfile() {
    const me = bag.state.user || {};
    const userId = Number(me.Id);
    const isLdap = String(me.AuthSource || '') === 'ldap';
    let tokens = [];
    try {
      tokens = await bag.Api.listUserTokens(userId);
    } catch (_) {
      tokens = [];
    }
    if (!Array.isArray(tokens)) tokens = [];

    const tokenRows = tokens.map((t) => {
      const hint = t.rawHint ? `…${t.rawHint}` : '';
      const prefix = `${t.prefix || 'ptr_'}${hint}`;
      return `<tr data-token-id="${bag.esc(t.id)}">
        <td>${bag.esc(t.description || '—')}</td>
        <td class="mono">${bag.esc(prefix)}</td>
        <td class="muted">${bag.esc(bag.fmtTs(t.dateCreated))}</td>
        <td class="muted">${t.lastUsed ? bag.esc(bag.fmtTs(t.lastUsed)) : '—'}</td>
        <td class="actions"><div class="quick-actions">
          ${bag.iconBtn({ del: t.id, title: 'Révoquer cette clé', icon: 'remove', danger: true })}
        </div></td>
      </tr>`;
    }).join('');

    bag.root.innerHTML = bag.shell('Profil', `
      ${bag.pageHeader('Profil', false)}
      <div id="profile-err"></div>
      <div class="panel" style="max-width:720px; margin-bottom:16px">
        <div class="section-title" style="margin-top:0">Compte</div>
        <dl class="kv" style="margin:0">
          <dt>Nom d'utilisateur</dt><dd><strong>${bag.esc(me.Username || '—')}</strong></dd>
          <dt>Rôle</dt><dd>${bag.esc(typeof bag.roleLabel === 'function' ? bag.roleLabel(me.Role) : (Number(me.Role) === 1 ? 'Administrateur' : 'Utilisateur'))}</dd>
          <dt>Authentification</dt><dd>${isLdap ? 'AD / LDAP' : 'Local'}</dd>
        </dl>
        <p class="muted" style="margin:14px 0 0">
          Les clés API créées ci-dessous agissent <strong>avec vos droits</strong>
          (rôle, ACL nœuds, partages) — pas plus, pas moins.
        </p>
      </div>

      ${isLdap ? '' : `
      <div class="panel" style="max-width:720px; margin-bottom:16px">
        <div class="section-title" style="margin-top:0">Mot de passe</div>
        <p class="muted" style="margin:0 0 14px">Modifier le mot de passe de votre compte local.</p>
        <div class="actions-bar">
          <button type="button" class="btn" id="profile-change-pass">Changer le mot de passe</button>
        </div>
      </div>`}

      <div class="panel" style="max-width:900px; margin-bottom:16px">
        <div class="section-title" style="margin-top:0">Clés API</div>
        <p class="muted" style="margin:0 0 14px">
          Utilisez l’en-tête <code>X-API-Key</code> pour appeler l’API sans session.
          La clé complète n’est affichée qu’une seule fois à la création.
        </p>
        <div class="toolbar" style="margin:0 0 12px">
          <button type="button" class="btn btn-primary" id="profile-new-token">Générer une clé</button>
          <div class="spacer"></div>
          <span class="muted mono">${tokens.length} clé${tokens.length === 1 ? '' : 's'}</span>
        </div>
        <div class="table-wrap"><table class="data">
          <thead><tr>
            <th>Description</th><th>Préfixe</th><th>Créée</th><th>Dernier usage</th><th></th>
          </tr></thead>
          <tbody>${tokenRows || `<tr><td colspan="5" class="empty">Aucune clé API</td></tr>`}</tbody>
        </table></div>
      </div>
      <div id="profile-modal"></div>
    `);

    const changePassBtn = document.getElementById('profile-change-pass');
    if (changePassBtn) {
      changePassBtn.onclick = () => {
        bag.showProfilePasswordModal(userId, me.Username || '');
      };
    }

    document.getElementById('profile-new-token').onclick = () => {
      bag.showCreateTokenModal(userId);
    };

    bag.root.querySelectorAll('[data-del]').forEach((btn) => {
      bag.onBusyClick(btn, async (el) => {
        await bag.Api.revokeUserToken(userId, el.dataset.del);
      }, { confirm: 'Révoquer cette clé API ? Les intégrations qui l’utilisent cesseront de fonctionner.', reload: true });
    });
  };

  bag.showProfilePasswordModal = function showProfilePasswordModal(userId, username) {
    const slot = document.getElementById('profile-modal');
    if (!slot) return;
    slot.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal" style="max-width:480px">
          <h3>Changer le mot de passe · ${bag.esc(username)}</h3>
          <div id="profile-form-err"></div>
          <div class="form-group">
            <label class="field-label">Mot de passe actuel</label>
            <input id="cur-password" type="password" autocomplete="current-password">
          </div>
          <div class="form-group">
            <label class="field-label">Nouveau mot de passe <span class="req">*</span></label>
            <input id="new-password" type="password" minlength="10" autocomplete="new-password">
          </div>
          <div class="form-group">
            <label class="field-label">Confirmer <span class="req">*</span></label>
            <input id="confirm-password" type="password" minlength="10" autocomplete="new-password">
          </div>
          <div class="actions-bar">
            <button class="btn btn-primary" id="save-pass">Mettre à jour</button>
            <button class="btn" id="cancel-profile-modal" style="margin-left:8px">Annuler</button>
          </div>
        </div>
      </div>`;
    document.getElementById('cancel-profile-modal').onclick = () => { slot.innerHTML = ''; };
    bag.onBusyClick(document.getElementById('save-pass'), async () => {
      const errBox = document.getElementById('profile-form-err');
      errBox.innerHTML = '';
      const password = document.getElementById('new-password').value;
      const confirm = document.getElementById('confirm-password').value;
      if (password !== confirm) {
        errBox.innerHTML = '<div class="error-box">Les mots de passe ne correspondent pas</div>';
        return;
      }
      try {
        await bag.Api.changePassword(userId, {
          Password: password,
          PasswordConfirm: confirm,
          CurrentPassword: document.getElementById('cur-password').value,
        });
        slot.innerHTML = '';
      } catch (err) {
        errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
      }
    }, { disableSiblings: false, minMs: 250 });
  };

  bag.showCreateTokenModal = function showCreateTokenModal(userId) {
    const slot = document.getElementById('profile-modal');
    if (!slot) return;
    slot.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal" style="max-width:520px">
          <h3>Générer une clé API</h3>
          <div id="profile-form-err"></div>
          <p class="muted" style="margin:0 0 12px">
            La clé héritera de <strong>vos</strong> droits actuels. Confirmez avec votre mot de passe.
          </p>
          <div class="form-group">
            <label class="field-label">Description</label>
            <input id="token-desc" maxlength="120" placeholder="ex. scripts CI, monitoring…" autocomplete="off">
          </div>
          <div class="form-group">
            <label class="field-label">Mot de passe <span class="req">*</span></label>
            <input id="token-password" type="password" autocomplete="current-password">
          </div>
          <div class="actions-bar">
            <button class="btn btn-primary" id="create-token">Créer</button>
            <button class="btn" id="cancel-profile-modal" style="margin-left:8px">Annuler</button>
          </div>
        </div>
      </div>`;
    document.getElementById('cancel-profile-modal').onclick = () => { slot.innerHTML = ''; };
    bag.onBusyClick(document.getElementById('create-token'), async () => {
      const errBox = document.getElementById('profile-form-err');
      errBox.innerHTML = '';
      const description = document.getElementById('token-desc').value.trim() || 'api-key';
      const password = document.getElementById('token-password').value;
      try {
        const created = await bag.Api.createUserToken(userId, { description, password });
        bag.showTokenCreatedModal(created);
      } catch (err) {
        errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
      }
    }, { disableSiblings: false, minMs: 250 });
  };

  bag.showTokenCreatedModal = function showTokenCreatedModal(created) {
    const slot = document.getElementById('profile-modal');
    if (!slot) return;
    const raw = String(created?.rawAPIKey || '');
    slot.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal" style="max-width:560px">
          <h3>Clé API créée</h3>
          <div class="info-box" style="margin-bottom:12px">
            Copiez-la maintenant — elle ne sera plus jamais affichée.
          </div>
          <div class="form-group">
            <label class="field-label">Clé</label>
            <div style="display:flex;gap:8px;align-items:stretch">
              <input id="token-raw" class="mono" readonly value="${bag.esc(raw)}" style="flex:1">
              <button type="button" class="btn" id="copy-token">Copier</button>
            </div>
          </div>
          <p class="muted" style="margin:0 0 14px;font-size:12px">
            Exemple : <code>curl -H "X-API-Key: ${bag.esc(raw.slice(0, 12))}…" https://…/api/stacks</code>
          </p>
          <div class="actions-bar">
            <button class="btn btn-primary" id="close-token-modal">J’ai copié la clé</button>
          </div>
        </div>
      </div>`;
    document.getElementById('copy-token').onclick = async () => {
      try {
        await navigator.clipboard.writeText(raw);
        const btn = document.getElementById('copy-token');
        if (btn) btn.textContent = 'Copié';
      } catch (_) {}
    };
    document.getElementById('close-token-modal').onclick = async () => {
      slot.innerHTML = '';
      await bag.viewProfile();
    };
  };
}
