import { bag } from '../bag.js';

export function install() {
  bag.viewActivity = async function viewActivity() {
    const actionFilter = bag.state.filters.activityAction || '';
    let data;
    try {
      data = await bag.Api.audit({ limit: 150, action: actionFilter || undefined });
    } catch (err) {
      bag.root.innerHTML = bag.shell('Journaux', `${bag.pageHeader('Journaux d’activité', false)}<div class="error-box">${bag.esc(err.message)}</div>`, {
        subtitle: 'Qui se connecte, qui fait quoi',
      });
      return;
    }
    const items = data?.Items || [];
    const total = Number(data?.Total) || items.length;
    const isAdmin = Number(bag.state.user?.Role) === 1;
    const rows = items.map((ev) => {
      const who = ev.Username || (ev.UserId ? `#${ev.UserId}` : '—');
      const search = `${ev.Action} ${ev.Message} ${who} ${ev.Ip}`.toLowerCase();
      return `<tr data-search="${bag.esc(search)}">
        <td class="muted cell-nowrap">${bag.esc(bag.formatAuditTime(ev.CreatedAt))}</td>
        <td>${bag.esc(who)}</td>
        <td>${bag.auditActionBadge(ev.Action)}</td>
        <td>${bag.esc(ev.Message || '')}</td>
        <td class="mono muted">${bag.esc(ev.Ip || '—')}</td>
      </tr>`;
    }).join('');

    bag.root.innerHTML = bag.shell('Journaux', `
      ${bag.pageHeader('Journaux d’activité')}
      <div class="toolbar">
        <input class="search" id="filter" type="search" placeholder="Filtrer les événements…" value="${bag.esc(bag.state.filters.activity || '')}">
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

    bag.bindRefresh();
    bag.bindSearch('activity');
    const sel = document.getElementById('audit-action-filter');
    if (sel) {
      sel.onchange = () => {
        bag.state.filters.activityAction = sel.value || '';
        bag.route();
      };
    }
  }

  bag.formatAuditTime = function formatAuditTime(ts) {
    const n = Number(ts) || 0;
    if (!n) return '—';
    try {
      return new Date(n * 1000).toLocaleString();
    } catch (_) {
      return String(ts);
    }
  }

  bag.auditActionBadge = function auditActionBadge(action) {
    const a = String(action || '');
    let tone = 'neutral';
    if (a.includes('fail') || a.includes('rate_limited') || a.includes('delete') || a.includes('remove')) tone = 'danger';
    else if (a.includes('login.ok') || a.includes('create') || a.includes('start')) tone = 'success';
    else if (a.includes('update') || a.includes('stop') || a.includes('restart') || a.includes('password')) tone = 'warn';
    return `<span class="audit-action tone-${tone}">${bag.esc(a)}</span>`;
  }

}
