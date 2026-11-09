import { bag } from '../bag.js';

export function install() {
  bag.viewUsers = async function viewUsers() {
    const users = await bag.Api.users();
    const list = users || [];
    const rows = list.map((u) => {
      const isSelf = Number(u.Id) === Number(bag.state.user?.Id);
      const src = u.AuthSource === 'ldap' ? 'AD/LDAP' : 'Local';
      const search = `${u.Id} ${u.Username} ${bag.roleLabel(u.Role)} ${src}`.toLowerCase();
      return `<tr data-search="${bag.esc(search)}">
        <td>${bag.esc(u.Id)}</td>
        <td>${bag.esc(u.Username)}${isSelf ? ' <span class="muted">(vous)</span>' : ''}</td>
        <td>${bag.esc(bag.roleLabel(u.Role))}</td>
        <td>${bag.esc(src)}</td>
        <td class="actions"><div class="quick-actions">
          ${u.AuthSource === 'ldap' ? '' : bag.iconBtn({ reset: u.Id, name: u.Username, title: 'Réinitialiser le mot de passe', icon: 'key' })}
          ${isSelf ? '' : bag.iconBtn({ del: u.Id, title: 'Supprimer', icon: 'remove', danger: true })}
        </div></td>
      </tr>`;
    }).join('');

    bag.root.innerHTML = bag.shell('Utilisateurs', `
      ${bag.pageHeader('Gestion des utilisateurs', false)}
      ${bag.settingsSubnav('users')}
      <div class="toolbar">
        <input class="search" id="filter" type="search" placeholder="Rechercher des utilisateurs…" value="${bag.esc(bag.state.filters.users || '')}">
        ${bag.createBtn('add-user', 'Ajouter un utilisateur')}
        <div class="spacer"></div>
        <span class="muted mono" id="filter-count">${list.length} / ${list.length}</span>
      </div>
      <div id="users-err"></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Id</th><th>Nom d'utilisateur</th><th>Rôle</th><th>Auth</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5" class="empty">Aucun utilisateur</td></tr>`}</tbody>
      </table></div>
      <div id="user-modal"></div>
    `);

    bag.bindSearch('users');
    document.getElementById('add-user').onclick = () => bag.showUserModal();
    bag.root.querySelectorAll('[data-del]').forEach((btn) => {
      bag.onBusyClick(btn, async (el) => {
        await bag.Api.deleteUser(el.dataset.del);
      }, { confirm: 'Supprimer cet utilisateur ?', reload: true });
    });
    bag.root.querySelectorAll('[data-reset]').forEach((btn) => {
      btn.onclick = () => bag.showResetPasswordModal(btn.dataset.reset, btn.dataset.name);
    });
  }

  bag.showUserModal = function showUserModal() {
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
    bag.onBusyClick(document.getElementById('save-user'), async () => {
      const username = document.getElementById('new-username').value.trim();
      const password = document.getElementById('new-password').value;
      const role = Number(document.getElementById('new-role').value);
      const errBox = document.getElementById('user-form-err');
      errBox.innerHTML = '';
      try {
        await bag.Api.createUser(username, password, role);
        slot.innerHTML = '';
        await bag.viewUsers();
      } catch (err) {
        errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
      }
    }, { disableSiblings: false, minMs: 250 });
  }

  bag.showResetPasswordModal = function showResetPasswordModal(userId, username) {
    const slot = document.getElementById('user-modal');
    const isSelf = Number(userId) === Number(bag.state.user?.Id);
    slot.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal" style="max-width:480px">
          <h3>Réinitialiser le mot de passe · ${bag.esc(username)}</h3>
          <div id="user-form-err"></div>
          ${isSelf ? `<div class="form-group">
            <label class="field-label">Mot de passe actuel</label>
            <input id="cur-password" type="password" autocomplete="current-password">
          </div>` : ''}
          <div class="form-group">
            <label class="field-label">Nouveau mot de passe <span class="req">*</span></label>
            <input id="new-password" type="password" minlength="10" autocomplete="new-password">
          </div>
          <div class="form-group">
            <label class="field-label">Confirmer le nouveau mot de passe <span class="req">*</span></label>
            <input id="confirm-password" type="password" minlength="10" autocomplete="new-password">
          </div>
          <div class="actions-bar">
            <button class="btn btn-primary" id="save-pass">Mettre à jour</button>
            <button class="btn" id="cancel-user" style="margin-left:8px">Annuler</button>
          </div>
        </div>
      </div>`;
    document.getElementById('cancel-user').onclick = () => { slot.innerHTML = ''; };
    bag.onBusyClick(document.getElementById('save-pass'), async () => {
      const errBox = document.getElementById('user-form-err');
      errBox.innerHTML = '';
      const password = document.getElementById('new-password').value;
      const confirm = document.getElementById('confirm-password').value;
      if (password !== confirm) {
        errBox.innerHTML = '<div class="error-box">Les mots de passe ne correspondent pas</div>';
        return;
      }
      const payload = { Password: password, PasswordConfirm: confirm };
      if (isSelf) payload.CurrentPassword = document.getElementById('cur-password').value;
      try {
        await bag.Api.changePassword(userId, payload);
        slot.innerHTML = '';
      } catch (err) {
        errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
      }
    }, { disableSiblings: false, minMs: 250 });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (document.querySelector('#app-modal .modal-backdrop')) bag.closeAppModal();
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

  bag.roleLabel = function roleLabel(role) {
    return Number(role) === 1 ? 'Administrateur' : 'Utilisateur';
  }

}
