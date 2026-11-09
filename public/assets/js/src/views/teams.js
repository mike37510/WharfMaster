import { bag } from '../bag.js';

export function install() {
  bag.viewTeams = async function viewTeams() {
    const [teamsRes, users] = await Promise.all([
      bag.Api.teams(true),
      bag.Api.users(),
    ]);
    const teams = Array.isArray(teamsRes) ? teamsRes : (teamsRes?.Items || []);
    const teamRows = teams.map((t) => {
      const members = (t.Members || []).map((m) => m.Username).join(', ') || '—';
      const search = `${t.Name} ${t.Description || ''} ${t.AdGroupDn || ''} ${members}`.toLowerCase();
      return `<tr data-search="${bag.esc(search)}">
        <td>${bag.esc(t.Name)}</td>
        <td class="muted">${bag.esc(t.Description || '—')}</td>
        <td class="mono muted" style="font-size:12px">${bag.esc(t.AdGroupDn || '—')}</td>
        <td>${bag.esc(members)}</td>
        <td class="actions"><div class="quick-actions">
          ${bag.iconBtn({ editTeam: t.Id, title: 'Éditer', icon: 'edit' })}
          ${bag.iconBtn({ delTeam: t.Id, title: 'Supprimer', icon: 'remove', danger: true })}
        </div></td>
      </tr>`;
    }).join('');

    bag.root.innerHTML = bag.shell('Équipes', `
      ${bag.pageHeader('Équipes', false)}
      ${bag.settingsSubnav('teams')}
      <div class="toolbar">
        <input class="search" id="filter" type="search" placeholder="Rechercher des équipes…" value="${bag.esc(bag.state.filters.teams || '')}">
        ${bag.createBtn('add-team', 'Nouvelle équipe')}
        <div class="spacer"></div>
        <span class="muted mono" id="filter-count">${teams.length} / ${teams.length}</span>
      </div>
      <div id="teams-err"></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Nom</th><th>Description</th><th>Groupe AD</th><th>Membres</th><th></th></tr></thead>
        <tbody>${teamRows || `<tr><td colspan="5" class="empty">Aucune équipe</td></tr>`}</tbody>
      </table></div>
      <div id="team-modal"></div>
    `, { subtitle: 'Groupes et membres (droits sur les nœuds)' });

    bag.bindSearch('teams');
    document.getElementById('add-team').onclick = () => bag.showTeamModal(null, users);
    bag.root.querySelectorAll('[data-edit-team]').forEach((btn) => {
      btn.onclick = async () => {
        const t = await bag.Api.team(btn.dataset.editTeam);
        bag.showTeamModal(t, users);
      };
    });
    bag.root.querySelectorAll('[data-del-team]').forEach((btn) => {
      bag.onBusyClick(btn, async (el) => {
        await bag.Api.deleteTeam(el.dataset.delTeam);
      }, { confirm: 'Supprimer cette équipe ?', reload: true });
    });
  }

  bag.showTeamModal = function showTeamModal(team, users) {
    const slot = document.getElementById('team-modal');
    let teamId = team ? Number(team.Id) : 0;
    let members = [...(team?.Members || [])].map((m) => ({
      Id: Number(m.Id),
      Username: m.Username || String(m.Id),
    }));
    const allUsers = users || [];

    const renderMembers = () => {
      const tb = document.getElementById('team-member-rows');
      if (!tb) return;
      if (!members.length) {
        tb.innerHTML = `<tr><td colspan="2" class="empty">Aucun membre — ajoutez un utilisateur ci-dessous.</td></tr>`;
        return;
      }
      tb.innerHTML = members.map((m) => `<tr>
        <td><strong>${bag.esc(m.Username)}</strong></td>
        <td class="actions"><div class="quick-actions">
          <button type="button" class="btn btn-icon btn-sm btn-danger" title="Retirer" data-rm-member="${bag.esc(m.Id)}">
            <span class="btn-ico">${bag.ico('remove')}</span>
          </button>
        </div></td>
      </tr>`).join('');
      tb.querySelectorAll('[data-rm-member]').forEach((btn) => {
        bag.onBusyClick(btn, async (el) => {
          const uid = Number(el.dataset.rmMember);
          const box = document.getElementById('team-form-err');
          if (box) box.innerHTML = '';
          try {
            if (teamId) await bag.Api.removeTeamMember(teamId, uid);
            members = members.filter((m) => Number(m.Id) !== uid);
            fillAddSelect();
            renderMembers();
          } catch (err) {
            if (box) box.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
          }
        }, { disableSiblings: false, minMs: 120 });
      });
    };

    const fillAddSelect = () => {
      const sel = document.getElementById('team-add-user');
      if (!sel) return;
      const q = (document.getElementById('team-user-search')?.value || '').trim().toLowerCase();
      const taken = new Set(members.map((m) => Number(m.Id)));
      const opts = allUsers
        .filter((u) => !taken.has(Number(u.Id)))
        .filter((u) => !q || String(u.Username || '').toLowerCase().includes(q))
        .map((u) => `<option value="${bag.esc(u.Id)}">${bag.esc(u.Username)}</option>`);
      sel.innerHTML = opts.length
        ? opts.join('')
        : '<option value="">Aucun utilisateur disponible</option>';
    };

    slot.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-form modal-form-wide" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3>${teamId ? 'Éditer l’équipe' : 'Nouvelle équipe'}</h3>
              <div class="modal-sub">Membres et groupe AD</div>
            </div>
            <button type="button" class="icon-btn" id="cancel-team" title="Fermer" aria-label="Fermer">✕</button>
          </div>
          <div id="team-form-err"></div>
          <div class="form-group">
            <label class="field-label">Nom <span class="req">*</span></label>
            <input id="team-name" value="${bag.esc(team?.Name || '')}" autocomplete="off">
          </div>
          <div class="form-group">
            <label class="field-label">Description</label>
            <input id="team-desc" value="${bag.esc(team?.Description || '')}" autocomplete="off">
          </div>
          <div class="form-group">
            <label class="field-label">DN / CN groupe Active Directory</label>
            <input id="team-ad" placeholder="CN=DockerOps,OU=Groups,DC=example,DC=com" value="${bag.esc(team?.AdGroupDn || '')}" autocomplete="off">
            <p class="field-hint muted">Optionnel : au login LDAP, les membres de ce groupe AD rejoignent l’équipe.</p>
          </div>
          <div class="section-title">Membres</div>
          <div class="panel" style="margin-bottom:12px;padding:12px">
            <div class="form-group" style="margin:0 0 10px">
              <label class="field-label">Rechercher un utilisateur</label>
              <input type="search" id="team-user-search" placeholder="Nom d’utilisateur…" autocomplete="off">
            </div>
            <div class="form-row-2" style="align-items:end;gap:10px">
              <div class="form-group" style="margin:0;flex:1">
                <label class="field-label">Utilisateur</label>
                <select id="team-add-user" class="select-block"></select>
              </div>
              <button type="button" class="btn btn-primary" id="team-add-btn">Ajouter</button>
            </div>
            ${!teamId ? '<p class="field-hint muted" style="margin:10px 0 0">Enregistrez d’abord l’équipe, ou ajoutez après création — les ajouts sont appliqués immédiatement une fois l’équipe créée.</p>' : ''}
          </div>
          <div class="table-wrap" style="margin-bottom:14px">
            <table class="data">
              <thead><tr><th>Utilisateur</th><th></th></tr></thead>
              <tbody id="team-member-rows"></tbody>
            </table>
          </div>
          <div class="actions-bar">
            <button class="btn btn-primary" id="save-team">${teamId ? 'Enregistrer' : 'Créer l’équipe'}</button>
            <button class="btn" id="cancel-team-2" style="margin-left:8px">Fermer</button>
          </div>
        </div>
      </div>`;

    const close = () => { slot.innerHTML = ''; };
    document.getElementById('cancel-team').onclick = async () => { close(); await bag.viewTeams(); };
    document.getElementById('cancel-team-2').onclick = async () => { close(); await bag.viewTeams(); };

    fillAddSelect();
    renderMembers();
    document.getElementById('team-user-search')?.addEventListener('input', fillAddSelect);

    bag.onBusyClick(document.getElementById('team-add-btn'), async () => {
      const box = document.getElementById('team-form-err');
      if (box) box.innerHTML = '';
      const uid = Number(document.getElementById('team-add-user')?.value || 0);
      if (!uid) {
        if (box) box.innerHTML = `<div class="error-box">Choisissez un utilisateur.</div>`;
        return;
      }
      const u = allUsers.find((x) => Number(x.Id) === uid);
      try {
        // Create team on the fly if needed so members can be added right away
        if (!teamId) {
          const Name = document.getElementById('team-name').value.trim();
          if (!Name) {
            if (box) box.innerHTML = `<div class="error-box">Indiquez un nom d’équipe avant d’ajouter des membres.</div>`;
            return;
          }
          const created = await bag.Api.createTeam({
            Name,
            Description: document.getElementById('team-desc').value.trim(),
            AdGroupDn: document.getElementById('team-ad').value.trim(),
          });
          teamId = Number(created?.Id || 0);
          if (!teamId) throw new Error('Création d’équipe échouée');
          const title = slot.querySelector('h3');
          if (title) title.textContent = 'Éditer l’équipe';
          const saveBtn = document.getElementById('save-team');
          if (saveBtn) saveBtn.textContent = 'Enregistrer';
        }
        await bag.Api.addTeamMember(teamId, uid);
        if (!members.some((m) => Number(m.Id) === uid)) {
          members.push({ Id: uid, Username: u?.Username || String(uid) });
        }
        document.getElementById('team-user-search').value = '';
        fillAddSelect();
        renderMembers();
      } catch (err) {
        if (box) box.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
      }
    }, { disableSiblings: false, minMs: 150 });

    bag.onBusyClick(document.getElementById('save-team'), async () => {
      const errBox = document.getElementById('team-form-err');
      errBox.innerHTML = '';
      const payload = {
        Name: document.getElementById('team-name').value.trim(),
        Description: document.getElementById('team-desc').value.trim(),
        AdGroupDn: document.getElementById('team-ad').value.trim(),
      };
      if (!payload.Name) {
        errBox.innerHTML = `<div class="error-box">Le nom est requis.</div>`;
        return;
      }
      try {
        if (teamId) {
          await bag.Api.updateTeam(teamId, payload);
        } else {
          await bag.Api.createTeam(payload);
        }
        close();
        await bag.viewTeams();
      } catch (err) {
        errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
      }
    }, { disableSiblings: false, minMs: 250 });
  }

  bag.aclRoleLabel = function aclRoleLabel(role) {
    const map = { read: 'Lecture', operate: 'Opération', admin: 'Admin nœud' };
    return map[role] || role || '—';
  }

}
