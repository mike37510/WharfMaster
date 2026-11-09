import { bag } from '../bag.js';

export function install() {
  bag.openCreateNetworkModal = async function openCreateNetworkModal() {
    bag.closeAppModal();
    const host = bag.modalHost();
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
    bag.bindAppModalChrome();
    document.getElementById('n-name')?.focus();
    bag.onBusyClick(document.getElementById('n-save'), async () => {
      const errBox = document.getElementById('create-err');
      errBox.innerHTML = '';
      const Name = document.getElementById('n-name').value.trim();
      const Driver = document.getElementById('n-driver').value;
      if (!Name) {
        errBox.innerHTML = `<div class="error-box">Le nom est requis.</div>`;
        return;
      }
      try {
        await bag.Api.docker('/networks/create', {
          method: 'POST',
          body: JSON.stringify({ Name, Driver, CheckDuplicate: true }),
        });
        bag.closeAppModal();
        await bag.route();
      } catch (err) {
        errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
      }
    }, { disableSiblings: false, minMs: 250 });
  }

  bag.viewNetworks = async function viewNetworks() {
    const all = bag.isAllNodes();
    let list = [];
    let containers = [];
    let partial = false;
    if (all) {
      const [aggNet, aggCtr] = await Promise.all([
        bag.dockerAll('/networks'),
        bag.dockerAll('/containers/json?all=true'),
      ]);
      list = aggNet.items;
      containers = aggCtr.items;
      partial = aggNet.failed > 0 || aggCtr.failed > 0;
    } else {
      const [nets, ctrs] = await Promise.all([
        bag.Api.docker('/networks'),
        bag.Api.docker('/containers/json?all=true'),
      ]);
      list = nets || [];
      containers = ctrs || [];
    }

    const usageByKey = new Map();
    list.forEach((n, idx) => {
      const users = bag.containersUsingNetwork(n, containers);
      const key = `${n._nodeId || 0}:${n.Id || idx}`;
      usageByKey.set(key, { net: n, users });
      n._usageCount = users.length;
      n._sortKey = key;
    });
    list = bag.sortItems(list, 'networks', {
      name: (n) => n.Name || '',
      id: (n) => n.Id || '',
      driver: (n) => n.Driver || '',
      usage: (n) => Number(n._usageCount) || 0,
      scope: (n) => n.Scope || '',
      node: (n) => n._nodeName || '',
      created: (n) => bag.createdSortKey(n.Created || n.CreatedAt),
    });
    const rows = list.map((n) => {
      const users = (usageByKey.get(n._sortKey) || {}).users || [];
      const key = n._sortKey;
      const usageCell = users.length
        ? `<button type="button" class="badge badge-inuse img-usage-btn" data-net-key="${bag.esc(key)}" title="Voir les conteneurs">${users.length}&nbsp;conteneur${users.length > 1 ? 's' : ''}</button>`
        : `<span class="badge badge-unused">Inutilisé</span>`;
      const search = `${n.Id} ${n.Name} ${n.Driver} ${n.Scope} ${n._nodeName || ''} ${users.length ? 'utilise used' : 'inutilise unused'}`.toLowerCase();
      const isBuiltin = ['bridge', 'host', 'none'].includes(n.Name);
      return `<tr data-search="${bag.esc(search)}">
      ${all ? '' : bag.bulkSelectTd(n.Id, { disabled: isBuiltin, title: 'Réseau système' })}
      ${all ? `<td class="muted">${bag.esc(n._nodeName || '—')}</td>` : ''}
      <td class="mono">${bag.esc(bag.shortId(n.Id))}</td>
      <td>${bag.esc(n.Name)}</td>
      <td>${bag.esc(n.Driver)}</td>
      <td>${usageCell}</td>
      <td>${bag.esc(n.Scope)}</td>
      <td>${bag.formatCreated(n.Created || n.CreatedAt)}</td>
      <td class="actions">${all ? '<span class="muted">—</span>' : `<div class="quick-actions">
        ${isBuiltin ? '' : bag.shareBtn('network', n.Name || n.Id)}
        ${isBuiltin ? '' : bag.iconBtn({ id: n.Id, title: 'Supprimer', icon: 'remove', danger: true })}
      </div>`}</td>
    </tr>`;
    }).join('');
    const colSpan = all ? 8 : 9;
    bag.root.innerHTML = bag.shell('Réseaux', `
      ${bag.pageHeader(all ? 'Réseaux — tous les nœuds' : 'Réseaux')}
      ${partial ? '<div class="info-box" style="margin-bottom:12px">Agrégat partiel : certains nœuds n’ont pas répondu.</div>' : ''}
      ${all ? bag.pickNodeGuardHtml() : ''}
      <div class="toolbar">
        <input class="search" id="filter" type="search" placeholder="Rechercher des réseaux…" value="${bag.esc(bag.state.filters.networks || '')}">
        ${all ? '' : `${bag.createBtn('create', 'Créer un réseau')}${bag.bulkDeleteBtnHtml()}`}
        <div class="spacer"></div>
        <span class="muted mono" id="filter-count">${list.length} / ${list.length}</span>
      </div>
      <div class="table-wrap"><table class="data">
        <thead><tr>
          ${bag.bulkSelectTh(!all)}
          ${all ? bag.sortTh('Nœud', 'node', 'networks') : ''}
          ${bag.sortTh('ID', 'id', 'networks')}
          ${bag.sortTh('Nom', 'name', 'networks')}
          ${bag.sortTh('Pilote', 'driver', 'networks')}
          ${bag.sortTh('Usage', 'usage', 'networks')}
          ${bag.sortTh('Portée', 'scope', 'networks')}
          ${bag.sortTh('Créé', 'created', 'networks')}
          <th></th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="${colSpan}" class="empty">Aucun réseau</td></tr>`}</tbody>
      </table></div>`, { subtitle: all ? 'Vue agrégée (lecture)' : 'Réseaux Docker' });
    bag.bindRefresh();
    bag.bindShareButtons();
    bag.bindPagedSearch('networks');
    bag.bindTableSort('networks', () => bag.viewNetworks());
    bag.root.querySelectorAll('[data-net-key]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const entry = usageByKey.get(btn.dataset.netKey);
        if (entry) bag.openNetworkUsersModal(entry.net, entry.users);
      });
    });
    if (!all) {
      document.getElementById('create').onclick = () => bag.openCreateNetworkModal();
      bag.root.querySelectorAll('.quick-actions button[data-id]').forEach((btn) => {
        const entry = [...usageByKey.values()].find((e) => e.net.Id === btn.dataset.id);
        const used = !!(entry && entry.users.length);
        bag.onBusyClick(btn, async (el) => {
          await bag.Api.docker(`/networks/${encodeURIComponent(el.dataset.id)}`, { method: 'DELETE' });
        }, {
          confirm: used
            ? 'Ce réseau est utilisé par des conteneurs. Supprimer quand même ?'
            : 'Supprimer ce réseau ?',
          reload: true,
        });
      });
      bag.bindBulkDelete({
        enabled: true,
        confirmOne: () => 'Supprimer ce réseau ?',
        confirmMany: (n) => `Supprimer ${n} réseaux ?`,
        deleteOne: (id) => bag.Api.docker(`/networks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
        reload: () => bag.viewNetworks(),
      });
    }
  }

  bag.containerNetworkEntries = function containerNetworkEntries(container) {
    const nets = container?.NetworkSettings?.Networks;
    if (!nets || typeof nets !== 'object') return [];
    return Object.entries(nets).map(([name, conf]) => ({
      name,
      id: conf?.NetworkID || conf?.NetworkId || '',
      ip: conf?.IPAddress || '',
    }));
  }

  bag.containersUsingNetwork = function containersUsingNetwork(net, containers) {
    const netId = bag.normalizeImageRef(net?.Id); // strip nothing harmful; ids are hex
    const netName = String(net?.Name || '');
    if (!netId && !netName) return [];
    return (containers || []).filter((c) => {
      if (net?._nodeId != null && c?._nodeId != null && Number(net._nodeId) !== Number(c._nodeId)) {
        return false;
      }
      return bag.containerNetworkEntries(c).some((e) => {
        if (netName && e.name === netName) return true;
        const eid = bag.normalizeImageRef(e.id);
        if (netId && eid && (netId === eid || netId.startsWith(eid) || eid.startsWith(netId))) return true;
        return false;
      });
    });
  }

  bag.networkEndpointForContainer = function networkEndpointForContainer(net, container) {
    return bag.containerNetworkEntries(container).find((e) => {
      if (e.name === net?.Name) return true;
      const eid = bag.normalizeImageRef(e.id);
      const nid = bag.normalizeImageRef(net?.Id);
      return nid && eid && (nid === eid || nid.startsWith(eid) || eid.startsWith(nid));
    }) || null;
  };

  bag.networkIpamSummary = function networkIpamSummary(net) {
    const confs = Array.isArray(net?.IPAM?.Config) ? net.IPAM.Config : [];
    const first = confs.find((c) => c && (c.Subnet || c.Gateway)) || confs[0] || {};
    const parts = [];
    if (first.Subnet) parts.push(String(first.Subnet));
    if (first.Gateway) parts.push(`gw ${first.Gateway}`);
    return parts.join(' · ');
  };

  /** Port chips without nested <a> (safe inside clickable schema cards). */
  bag.formatPortChips = function formatPortChips(ports) {
    if (!ports || !ports.length) return '<span class="muted">—</span>';
    const seen = new Set();
    const chips = [];
    for (const p of ports) {
      const pub = Number(p.PublicPort ?? p.publicPort) || 0;
      const priv = p.PrivatePort || p.privatePort;
      const type = (p.Type || p.type || 'tcp').toLowerCase();
      if (!priv) continue;
      const label = pub > 0 ? `${pub}:${priv}/${type}` : `${priv}/${type}`;
      const key = label;
      if (seen.has(key)) continue;
      seen.add(key);
      chips.push(`<span class="port-chip">${bag.esc(label)}</span>`);
    }
    return chips.length ? chips.join('') : '<span class="muted">—</span>';
  };

  bag.openNetworkUsersModal = function openNetworkUsersModal(net, users) {
    bag.closeAppModal();
    const host = bag.modalHost();
    const list = Array.isArray(users) ? users : [];
    const ipam = bag.networkIpamSummary(net);
    const hubMeta = [net?.Driver, ipam].filter(Boolean).join(' · ');

    const nodes = list.map((c) => {
      const name = (c.Names && c.Names[0] ? c.Names[0].replace(/^\//, '') : bag.shortId(c.Id));
      const entry = bag.networkEndpointForContainer(net, c);
      const ip = entry?.ip || '—';
      const st = String(c.State || '').toLowerCase();
      const running = st === 'running' || st === 'restarting';
      return `<button type="button" class="net-schema-node ${running ? 'is-up' : 'is-down'}" data-go-container="${bag.esc(c.Id)}" title="${bag.esc(name)}">
        <span class="net-schema-link" aria-hidden="true"></span>
        <span class="net-schema-node-name">${bag.esc(name)}</span>
        <span class="net-schema-node-ip mono">${bag.esc(ip)}</span>
        <span class="net-schema-node-ports">${bag.formatPortChips(c.Ports || [])}</span>
      </button>`;
    }).join('');

    const rows = list.map((c) => {
      const name = (c.Names && c.Names[0] ? c.Names[0].replace(/^\//, '') : bag.shortId(c.Id));
      const entry = bag.networkEndpointForContainer(net, c);
      return `<tr>
        <td><a class="res-user-link" href="#containers/${bag.esc(c.Id)}">${bag.esc(name)}</a></td>
        <td class="mono">${bag.esc(entry?.ip || '—')}</td>
        <td>${bag.formatPorts(c.Ports || [])}</td>
        <td>${bag.badge(c.State)}</td>
      </tr>`;
    }).join('');

    host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-form-wide" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3>Schéma réseau</h3>
              <p class="modal-sub mono">${bag.esc(net?.Name || '')} · ${bag.esc(bag.shortId(net?.Id))}</p>
            </div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">✕</button>
          </div>
          <div class="net-schema" aria-label="Schéma des conteneurs sur ce réseau">
            <div class="net-schema-hub">
              <div class="net-schema-hub-ico">${bag.ico('networks')}</div>
              <div class="net-schema-hub-name">${bag.esc(net?.Name || 'réseau')}</div>
              <div class="net-schema-hub-meta muted">${bag.esc(hubMeta || `${list.length} conteneur${list.length > 1 ? 's' : ''}`)}</div>
            </div>
            <div class="net-schema-nodes">
              ${nodes || '<div class="muted" style="padding:12px">Aucun conteneur connecté</div>'}
            </div>
          </div>
          <div class="section-title" style="margin-top:16px">Détail</div>
          <div class="table-wrap" style="margin:0">
            <table class="data">
              <thead><tr><th>Conteneur</th><th>IP</th><th>Ports</th><th>État</th></tr></thead>
              <tbody>${rows || `<tr><td colspan="4" class="empty">Aucun conteneur</td></tr>`}</tbody>
            </table>
          </div>
          <div class="actions-bar" style="margin-top:14px">
            <button type="button" class="btn" data-close-modal>Fermer</button>
          </div>
        </div>
      </div>`;
    bag.bindAppModalChrome();
    const goContainer = (id) => {
      bag.closeAppModal();
      location.hash = `#containers/${id}`;
    };
    host.querySelectorAll('[data-go-container]').forEach((btn) => {
      btn.addEventListener('click', () => goContainer(btn.dataset.goContainer));
    });
    host.querySelectorAll('a.res-user-link').forEach((a) => {
      a.addEventListener('click', () => bag.closeAppModal());
    });
  };

}
