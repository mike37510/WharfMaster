import { bag } from '../bag.js';

export function install() {
  bag.nodeStatusLabel = function nodeStatusLabel(nodeOrStatus, disabled) {
    if (nodeOrStatus && typeof nodeOrStatus === 'object') {
      disabled = !!nodeOrStatus.Disabled;
      nodeOrStatus = nodeOrStatus.Status;
    }
    if (disabled) return '<span class="badge badge-muted">Désactivé</span>';
    const s = Number(nodeOrStatus);
    if (s === 1) return '<span class="badge badge-success">En ligne</span>';
    return '<span class="badge badge-warn">Hors ligne</span>';
  }

  bag.openEditNodeModal = function openEditNodeModal(node) {
    if (!node?.Id) return;
    bag.closeAppModal();
    const isAgent = node.Kind === 'agent';
    const host = bag.modalHost();
    host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-form" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3>Modifier le nœud</h3>
              <div class="modal-sub">${isAgent ? 'Agent distant' : 'Nœud local'} · #${bag.esc(node.Id)}</div>
            </div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">✕</button>
          </div>
          <div id="edit-node-err"></div>
          <div class="form-group">
            <label class="field-label">Nom <span class="req">*</span></label>
            <input id="n-name" value="${bag.esc(node.NodeName || node.Name || '')}" placeholder="serveur-atelier" autocomplete="off" spellcheck="false">
          </div>
          ${isAgent ? `
          <div class="form-group">
            <label class="field-label">URL agent <span class="req">*</span></label>
            <input id="n-agent-url" value="${bag.esc(node.AgentURL || node.URL || '')}" placeholder="https://192.168.1.5:9001" autocomplete="off" spellcheck="false">
            <p class="field-hint muted">Changer l’URL réinitialise l’empreinte TLS (re-pin au prochain ping).</p>
          </div>
          <label class="check-row"><input type="checkbox" id="n-clear-pin"> Forcer le reset de l’empreinte TLS</label>
          ` : ''}
          <div class="form-group">
            <label class="field-label">URL hôte des ports (optionnel)</label>
            <input id="n-public-url" value="${bag.esc(node.PublicURL || '')}" placeholder="https://nas.lan" autocomplete="off" spellcheck="false">
            <p class="field-hint muted">Surcharge l’« URL hôte des ports » globale pour les liens cliquables de ce nœud (pas l’URL WharfMaster).</p>
          </div>
          <div class="actions-bar">
            <button type="button" class="btn btn-primary" id="n-save">Enregistrer</button>
            <button type="button" class="btn" data-close-modal>Annuler</button>
          </div>
        </div>
      </div>`;
    bag.bindAppModalChrome();
    document.getElementById('n-name')?.focus();
    bag.onBusyClick(document.getElementById('n-save'), async () => {
      const errBox = document.getElementById('edit-node-err');
      errBox.innerHTML = '';
      const Name = document.getElementById('n-name').value.trim();
      const PublicURL = document.getElementById('n-public-url').value.trim();
      if (!Name || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(Name)) {
        errBox.innerHTML = `<div class="error-box">Nom invalide (lettres, chiffres, . _ - ; 1–64 caractères).</div>`;
        return;
      }
      const payload = { NodeName: Name, Name, PublicURL };
      if (isAgent) {
        const AgentURL = document.getElementById('n-agent-url').value.trim();
        if (!AgentURL || !/^https?:\/\//i.test(AgentURL)) {
          errBox.innerHTML = `<div class="error-box">URL agent invalide (http:// ou https://).</div>`;
          return;
        }
        payload.AgentURL = AgentURL.replace(/\/$/, '');
        if (document.getElementById('n-clear-pin')?.checked) payload.ClearTlsPin = true;
      }
      try {
        await bag.Api.updateNode(node.Id, payload);
        bag.closeAppModal();
        // Refresh endpoint switcher names
        try {
          const n = await bag.Api.nodes();
          bag.state.endpoints = n?.Items || bag.state.endpoints;
        } catch (_) {}
        await bag.viewNodes();
      } catch (err) {
        errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
      }
    }, { disableSiblings: false, minMs: 250 });
  }

  bag.openAddNodeModal = function openAddNodeModal(tokenMeta) {
    bag.closeAppModal();
    const draft = bag.state._joinDraft || { host: '', name: '', port: '9001' };
    const tokenBox = tokenMeta
      ? `<div class="info-box" style="margin-bottom:12px">
          Token actif : <code>${bag.esc(tokenMeta.Hint)}</code>
          · expire ${bag.esc(bag.formatAuditTime(tokenMeta.ExpiresAt))}
          · utilisations ${bag.esc(tokenMeta.UseCount)}${tokenMeta.MaxUses != null ? ' / ' + bag.esc(tokenMeta.MaxUses) : ''}
          <div class="muted" style="margin-top:6px">Le secret complet n’est affiché qu’à la génération / rotation.</div>
        </div>`
      : `<div class="info-box" style="margin-bottom:12px">Aucun token de jointure actif — générez-en un pour enrôler un nœud.</div>`;
    const host = bag.modalHost();
    host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-form modal-form-wide" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3>Ajouter un nœud</h3>
              <div class="modal-sub">IP / hostname distant → commande d’install HTTPS</div>
            </div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">✕</button>
          </div>
          <p class="muted" style="margin:0 0 12px">Indiquez l’IP (ou hostname) de la machine distante et le nom du nœud, puis générez le token : la commande d’install HTTPS sera prête à copier-coller.</p>
          ${tokenBox}
          <div id="join-form-err"></div>
          <div class="form-row-2" style="align-items:end">
            <div class="form-group" style="margin:0">
              <label class="field-label" for="join-node-host">IP / hostname de la machine</label>
              <input type="text" id="join-node-host" placeholder="192.168.1.5" value="${bag.esc(draft.host)}" autocomplete="off" spellcheck="false">
            </div>
            <div class="form-group" style="margin:0">
              <label class="field-label" for="join-node-name">Nom du nœud</label>
              <input type="text" id="join-node-name" placeholder="serveur-atelier" value="${bag.esc(draft.name)}" autocomplete="off" spellcheck="false">
            </div>
          </div>
          <div class="form-group" style="margin-top:12px;max-width:140px">
            <label class="field-label" for="join-node-port">Port agent</label>
            <input type="number" id="join-node-port" min="1" max="65535" value="${bag.esc(draft.port || '9001')}">
          </div>
          <div id="join-token-out" style="margin-top:12px"></div>
          <div class="actions-bar">
            <button type="button" class="btn btn-primary" id="gen-join-token">Générer la commande</button>
            <button type="button" class="btn" data-close-modal>Fermer</button>
          </div>
        </div>
      </div>`;
    bag.bindAppModalChrome();

    const readJoinDraft = () => {
      const h = (document.getElementById('join-node-host')?.value || '').trim();
      const name = (document.getElementById('join-node-name')?.value || '').trim();
      const portRaw = (document.getElementById('join-node-port')?.value || '9001').trim();
      const port = Number(portRaw) || 9001;
      bag.state._joinDraft = { host: h, name, port: String(port) };
      return { host: h, name, port };
    };

    const validateJoinDraft = () => {
      const errEl = document.getElementById('join-form-err');
      const { host: h, name, port } = readJoinDraft();
      let msg = '';
      if (!h) msg = 'Indiquez l’IP ou le hostname de la machine distante.';
      else if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name)) {
        msg = 'Nom de nœud invalide (lettres, chiffres, . _ - ; 1–64 caractères).';
      } else if (port < 1 || port > 65535) msg = 'Port agent invalide.';
      if (errEl) {
        errEl.innerHTML = msg ? `<div class="error-box">${bag.esc(msg)}</div>` : '';
      }
      return msg ? null : { host: h, name, port };
    };

    const showToken = (data) => {
      const out = document.getElementById('join-token-out');
      if (!out || !data?.Token) return;
      const cmd = data.InstallCommand || '';
      const adv = data.AdvertiseURL || '';
      out.innerHTML = `
        <div class="info-box">
          <div class="muted" style="margin-bottom:8px">
            Nœud <strong>${bag.esc(data.NodeName || '—')}</strong>
            · advertise <code>${bag.esc(adv)}</code>
            · expire ${bag.esc(bag.formatAuditTime(data.ExpiresAt))}
          </div>
          <strong>Commande à exécuter sur la machine distante</strong>
          <pre class="mono" id="join-cmd" style="white-space:pre-wrap;margin:8px 0;user-select:all">${bag.esc(cmd)}</pre>
          <p class="muted" style="margin:10px 0 6px">Ou déploiement manuel : ZIP avec Dockerfile, docker-compose, sources et <code>.env</code> prérempli.</p>
          <div class="toolbar" style="gap:8px;flex-wrap:wrap">
            <button type="button" class="btn btn-sm btn-primary" id="copy-join-cmd">Copier la commande</button>
            <button type="button" class="btn btn-sm btn-info" id="dl-agent-bundle">Télécharger le pack ZIP</button>
            <button type="button" class="btn btn-sm" id="show-join-token">Afficher le token</button>
          </div>
          <pre class="mono" id="join-token-raw" style="display:none;white-space:pre-wrap;margin:8px 0 0">${bag.esc(data.Token)}</pre>
        </div>`;
      document.getElementById('copy-join-cmd')?.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(cmd || data.Token);
          const btn = document.getElementById('copy-join-cmd');
          if (btn) {
            const prev = btn.textContent;
            btn.textContent = 'Copié';
            setTimeout(() => { btn.textContent = prev; }, 1400);
          }
        } catch (_) {}
      });
      document.getElementById('dl-agent-bundle')?.addEventListener('click', async () => {
        const btn = document.getElementById('dl-agent-bundle');
        const prev = btn?.textContent || '';
        if (btn) {
          btn.disabled = true;
          btn.textContent = 'Préparation…';
        }
        try {
          await bag.Api.downloadAgentBundle({
            Token: data.Token,
            NodeHost: data.NodeHost || '',
            NodeName: data.NodeName || '',
            NodePort: data.NodePort || 9001,
            PublicURL: data.PublicURL || '',
            AdvertiseURL: data.AdvertiseURL || '',
          });
          if (btn) btn.textContent = 'Téléchargé';
          setTimeout(() => { if (btn) { btn.textContent = prev; btn.disabled = false; } }, 1600);
        } catch (err) {
          if (btn) {
            btn.textContent = prev;
            btn.disabled = false;
          }
          const errEl = document.getElementById('join-form-err');
          if (errEl) {
            errEl.innerHTML = `<div class="error-box">${bag.esc(err.message || 'Téléchargement impossible')}</div>`;
          }
        }
      });
      document.getElementById('show-join-token')?.addEventListener('click', () => {
        const el = document.getElementById('join-token-raw');
        if (el) el.style.display = el.style.display === 'none' ? '' : 'none';
      });
    };

    ['join-node-host', 'join-node-name', 'join-node-port'].forEach((id) => {
      document.getElementById(id)?.addEventListener('change', readJoinDraft);
      document.getElementById(id)?.addEventListener('input', readJoinDraft);
    });
    document.getElementById('join-node-host')?.focus();

    bag.onBusyClick(document.getElementById('gen-join-token'), async () => {
      const draftOk = validateJoinDraft();
      if (!draftOk) return 'cancelled';
      const data = await bag.Api.createJoinToken({
        ttlSeconds: 86400,
        nodeHost: draftOk.host,
        nodeName: draftOk.name,
        nodePort: draftOk.port,
      });
      showToken(data);
      try {
        const t = await bag.Api.joinTokenMeta();
        bag.state._joinTokenMeta = t?.Active || null;
      } catch (_) {}
    }, { disableSiblings: false, minMs: 200 });
  }

  bag.viewNodes = async function viewNodes() {
    let nodes = [];
    let tokenMeta = null;
    let errMsg = '';
    try {
      const [n, t] = await Promise.all([bag.Api.nodes(), bag.Api.joinTokenMeta()]);
      nodes = n?.Items || [];
      tokenMeta = t?.Active || null;
      bag.state._joinTokenMeta = tokenMeta;
      bag.state.endpoints = nodes;
    } catch (err) {
      errMsg = err.message || String(err);
    }

    const shortSeen = (ts) => {
      const n = Number(ts) || 0;
      if (!n) return '—';
      try {
        const d = new Date(n * 1000);
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const hh = String(d.getHours()).padStart(2, '0');
        const mi = String(d.getMinutes()).padStart(2, '0');
        return `${dd}/${mm} ${hh}:${mi}`;
      } catch (_) {
        return bag.formatAuditTime(ts);
      }
    };

    const tlsCell = (n) => {
      if (n.Kind !== 'agent') return '<span class="muted">—</span>';
      if (!n.TlsExpiresAt) {
        return '<span class="muted" title="HTTPS autosigné — date inconnue tant que le nœud n’a pas répondu">?</span>';
      }
      const days = Number(n.TlsDaysLeft);
      const renew = String(n.TlsRenewBy || '').slice(0, 7); // YYYY-MM
      const expFull = bag.formatAuditTime(n.TlsExpiresAt);
      const tip = `TLS autosigné — expire ${expFull} · renouvellement auto ~30 j avant`;
      let cls = 'badge-success';
      let label = renew ? `OK · ${bag.esc(renew)}` : 'OK';
      if (Number.isFinite(days) && days <= 0) {
        cls = 'badge-danger';
        label = 'Expiré';
      } else if (Number.isFinite(days) && days <= 30) {
        cls = 'badge-warn';
        label = `${days} j`;
      }
      const pin = n.TlsFingerprintShort
        ? ` · pin ${bag.esc(n.TlsFingerprintShort)}`
        : (n.TlsPinned ? '' : ' · pin…');
      const pinTip = n.TlsFingerprint
        ? `${tip} · empreinte SHA-256 ${n.TlsFingerprint}`
        : `${tip} · empreinte pas encore épinglée (TOFU au prochain ping)`;
      return `<span class="badge badge-compact ${cls}" title="${bag.esc(pinTip)}">${label}${pin}</span>`;
    };

    const byId = new Map(nodes.map((n) => [String(n.Id), n]));
    const rows = nodes.map((n) => {
      const isLocal = n.Kind !== 'agent';
      const agentActions = isLocal
        ? ''
        : `
            <button type="button" class="btn btn-icon btn-sm" title="Ping" aria-label="Ping" data-ping="${bag.esc(n.Id)}"><span class="btn-ico">${bag.ico('activity')}</span></button>
            ${n.Disabled
              ? `<button type="button" class="btn btn-icon btn-sm btn-success" title="Activer" aria-label="Activer" data-enable="${bag.esc(n.Id)}"><span class="btn-ico">${bag.ico('start')}</span></button>`
              : `<button type="button" class="btn btn-icon btn-sm" title="Désactiver" aria-label="Désactiver" data-disable="${bag.esc(n.Id)}"><span class="btn-ico">${bag.ico('stop')}</span></button>`}
            <button type="button" class="btn btn-icon btn-sm btn-danger" title="Délier" aria-label="Délier" data-unlink="${bag.esc(n.Id)}"><span class="btn-ico">${bag.ico('remove')}</span></button>`;
      const actions = `<div class="quick-actions">
            <button type="button" class="btn btn-icon btn-sm btn-info" title="Modifier" aria-label="Modifier" data-edit-node="${bag.esc(n.Id)}"><span class="btn-ico">${bag.ico('edit')}</span></button>
            <button type="button" class="btn btn-icon btn-sm" title="Accès (users / équipes)" aria-label="Accès" data-access-node="${bag.esc(n.Id)}"><span class="btn-ico">${bag.ico('users')}</span></button>
            ${agentActions}
          </div>`;
      const url = n.AgentURL || n.URL || '—';
      return `<tr>
        <td><strong>${bag.esc(n.NodeName || n.Name)}</strong><div class="muted mono">#${bag.esc(n.Id)}</div></td>
        <td>${bag.esc(n.Kind === 'agent' ? 'Agent' : 'Local')}</td>
        <td class="mono cell-clip" title="${bag.esc(url)}">${bag.esc(url)}</td>
        <td>${bag.nodeStatusLabel(n)}</td>
        <td>${tlsCell(n)}</td>
        <td class="muted mono" title="${bag.esc(n.LastSeenAt ? bag.formatAuditTime(n.LastSeenAt) : '')}">${bag.esc(n.LastSeenAt ? shortSeen(n.LastSeenAt) : '—')}</td>
        <td class="actions">${actions}</td>
      </tr>`;
    }).join('');

    bag.root.innerHTML = bag.shell('Nœuds', `
      ${bag.pageHeader('Infrastructure multi-nœuds', false)}
      ${bag.settingsSubnav('nodes')}
      ${errMsg ? `<div class="error-box">${bag.esc(errMsg)}</div>` : ''}
      <div class="toolbar">
        ${bag.createBtn('create-node', 'Ajouter un nœud')}
        <div class="spacer"></div>
        <span class="muted mono">${nodes.length} nœud${nodes.length > 1 ? 's' : ''}</span>
      </div>
      <div class="table-wrap">
        <table class="data table-nodes">
          <thead><tr><th>Nom</th><th>Type</th><th>URL</th><th>Statut</th><th>TLS</th><th>Vu</th><th class="actions-col"></th></tr></thead>
          <tbody>${rows || `<tr><td colspan="7" class="empty">Aucun nœud — cliquez « Ajouter un nœud » pour enrôler un agent.</td></tr>`}</tbody>
        </table>
      </div>
    `, { subtitle: 'Joindre, accès users/équipes, agents Docker' });

    document.getElementById('create-node').onclick = () => bag.openAddNodeModal(tokenMeta || bag.state._joinTokenMeta);

    bag.root.querySelectorAll('[data-edit-node]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const node = byId.get(String(btn.dataset.editNode));
        if (node) bag.openEditNodeModal(node);
      });
    });
    bag.root.querySelectorAll('[data-access-node]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const node = byId.get(String(btn.dataset.accessNode));
        if (node) bag.openNodeAccessModal(node);
      });
    });

    bag.root.querySelectorAll('[data-ping]').forEach((btn) => {
      bag.onBusyClick(btn, async (el) => {
        await bag.Api.pingNode(el.dataset.ping);
        await bag.viewNodes();
      }, { disableSiblings: false, minMs: 150 });
    });
    bag.root.querySelectorAll('[data-disable]').forEach((btn) => {
      bag.onBusyClick(btn, async (el) => {
        await bag.Api.disableNode(el.dataset.disable);
        await bag.viewNodes();
      }, { disableSiblings: false, minMs: 150 });
    });
    bag.root.querySelectorAll('[data-enable]').forEach((btn) => {
      bag.onBusyClick(btn, async (el) => {
        await bag.Api.enableNode(el.dataset.enable);
        await bag.viewNodes();
      }, { disableSiblings: false, minMs: 150 });
    });
    bag.root.querySelectorAll('[data-unlink]').forEach((btn) => {
      bag.onBusyClick(btn, async (el) => {
        if (!confirm('Délier ce nœud ? L’agent devra rejoindre avec un nouveau token.')) return 'cancelled';
        await bag.Api.unlinkNode(el.dataset.unlink);
        if (Number(bag.Api.getEndpointId()) === Number(el.dataset.unlink)) {
          bag.Api.setEndpointId(1);
          bag.state.endpointId = 1;
        }
        await bag.viewNodes();
      }, { disableSiblings: false, minMs: 150 });
    });
  }

  bag.openNodeAccessModal = async function openNodeAccessModal(node) {
    if (!node?.Id) return;
    bag.closeAppModal();
    const host = bag.modalHost();
    host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-form modal-form-wide" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3>Accès · ${bag.esc(node.NodeName || node.Name)}</h3>
              <div class="modal-sub">Attribuer un utilisateur ou une équipe à ce nœud</div>
            </div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">✕</button>
          </div>
          <div id="node-acl-err"></div>
          <p class="muted" style="margin:0 0 12px">
            Rôles : <strong>lecture</strong> · <strong>opération</strong> (ses ressources) ·
            <strong>admin nœud</strong> (tout sur le nœud). Les admins globaux passent toujours.
          </p>
          <div class="panel" style="margin-bottom:14px;padding:12px">
            <div class="form-group" style="margin:0 0 10px">
              <label class="field-label">Rechercher un utilisateur ou une équipe</label>
              <input type="search" id="acl-search" placeholder="Nom d’utilisateur ou d’équipe…" autocomplete="off">
            </div>
            <div class="form-row-2" style="align-items:end;gap:10px">
              <div class="form-group" style="margin:0;flex:2">
                <label class="field-label">Sujet</label>
                <select id="acl-subject" class="select-block"></select>
              </div>
              <div class="form-group" style="margin:0;flex:1">
                <label class="field-label">Rôle</label>
                <select id="acl-role" class="select-block">
                  <option value="read">Lecture</option>
                  <option value="operate" selected>Opération</option>
                  <option value="admin">Admin nœud</option>
                </select>
              </div>
              <button type="button" class="btn btn-primary" id="acl-add">Attribuer</button>
            </div>
          </div>
          <div class="section-title" style="margin-top:0">Droits sur ce nœud</div>
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>Type</th><th>Sujet</th><th>Rôle</th><th></th></tr></thead>
              <tbody id="node-acl-rows"><tr><td colspan="4" class="muted">Chargement…</td></tr></tbody>
            </table>
          </div>
          <div class="actions-bar" style="margin-top:14px">
            <button type="button" class="btn" data-close-modal>Fermer</button>
          </div>
        </div>
      </div>`;
    bag.bindAppModalChrome();

    let users = [];
    let teams = [];
    let acls = [];

    const errBox = () => document.getElementById('node-acl-err');

    const fillSubjects = () => {
      const q = (document.getElementById('acl-search')?.value || '').trim().toLowerCase();
      const sel = document.getElementById('acl-subject');
      if (!sel) return;
      const opts = [];
      users.forEach((u) => {
        const label = String(u.Username || '');
        if (q && !label.toLowerCase().includes(q)) return;
        // Skip global admins — they already have full access
        if (Number(u.Role) === 1) return;
        opts.push(`<option value="user:${bag.esc(u.Id)}">${bag.esc(label)} · utilisateur</option>`);
      });
      teams.forEach((t) => {
        const label = String(t.Name || '');
        if (q && !label.toLowerCase().includes(q)) return;
        opts.push(`<option value="team:${bag.esc(t.Id)}">${bag.esc(label)} · équipe</option>`);
      });
      sel.innerHTML = opts.length
        ? opts.join('')
        : '<option value="">Aucun résultat</option>';
    };

    const renderAcls = () => {
      const tb = document.getElementById('node-acl-rows');
      if (!tb) return;
      if (!acls.length) {
        tb.innerHTML = `<tr><td colspan="4" class="empty">Aucun droit spécifique — défaut opération pour les users non-admin.</td></tr>`;
        return;
      }
      tb.innerHTML = acls.map((a) => {
        const typeLabel = a.SubjectType === 'team' ? 'Équipe' : 'Utilisateur';
        return `<tr>
          <td>${bag.esc(typeLabel)}</td>
          <td><strong>${bag.esc(a.SubjectName || ('#' + a.SubjectId))}</strong></td>
          <td>${bag.esc(bag.aclRoleLabel(a.Role))}</td>
          <td class="actions"><div class="quick-actions">
            <button type="button" class="btn btn-icon btn-sm btn-danger" title="Retirer" data-del-acl="${bag.esc(a.Id)}"><span class="btn-ico">${bag.ico('remove')}</span></button>
          </div></td>
        </tr>`;
      }).join('');
      tb.querySelectorAll('[data-del-acl]').forEach((btn) => {
        bag.onBusyClick(btn, async (el) => {
          if (!confirm('Retirer ce droit ?')) return 'cancelled';
          await bag.Api.deleteAcl(el.dataset.delAcl);
          await refreshAcls();
        }, { disableSiblings: false, minMs: 150 });
      });
    };

    const refreshAcls = async () => {
      const res = await bag.Api.acls(node.Id);
      acls = res?.Items || [];
      renderAcls();
    };

    try {
      const [u, tRes] = await Promise.all([bag.Api.users(), bag.Api.teams(true)]);
      users = u || [];
      teams = Array.isArray(tRes) ? tRes : (tRes?.Items || []);
      fillSubjects();
      await refreshAcls();
    } catch (err) {
      if (errBox()) errBox().innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
    }

    document.getElementById('acl-search')?.addEventListener('input', fillSubjects);
    document.getElementById('acl-search')?.focus();

    bag.onBusyClick(document.getElementById('acl-add'), async () => {
      const box = errBox();
      if (box) box.innerHTML = '';
      const raw = document.getElementById('acl-subject')?.value || '';
      const [stype, sid] = raw.split(':');
      if (!stype || !sid) {
        if (box) box.innerHTML = `<div class="error-box">Choisissez un utilisateur ou une équipe.</div>`;
        return;
      }
      try {
        await bag.Api.upsertAcl({
          EndpointId: Number(node.Id),
          SubjectType: stype,
          SubjectId: Number(sid),
          Role: document.getElementById('acl-role').value,
        });
        document.getElementById('acl-search').value = '';
        fillSubjects();
        await refreshAcls();
      } catch (err) {
        if (box) box.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
      }
    }, { disableSiblings: false, minMs: 200 });
  }

}
