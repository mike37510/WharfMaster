import { bag } from '../bag.js';

export function install() {
  bag.viewStacks = async function viewStacks() {
    const all = bag.isAllNodes();
    if (bag.state.route === 'stacks/new') {
      if (all) {
        bag.root.innerHTML = bag.shell('Stacks', `
          ${bag.pageHeader('Créer une stack')}
          ${bag.pickNodeGuardHtml()}
        `, { subtitle: 'Projets Compose' });
        return;
      }
      bag.showStackEditor();
      return;
    }
    const stacks = await bag.Api.stacks();
    let list = stacks || [];
    const stackStatusLabel = (st) => (Number(st) === 1 ? 'running' : 'exited');
    list = bag.sortItems(list, 'stacks', {
      name: (s) => s.Name || '',
      state: (s) => stackStatusLabel(s.Status),
      owner: (s) => s.CreatedBy || '',
      node: (s) => bag.endpointLabel(s.EndpointId),
      id: (s) => Number(s.Id) || 0,
      created: (s) => bag.createdSortKey(s.CreationDate),
    });
    const rows = list.map((s) => {
      const node = bag.endpointLabel(s.EndpointId);
      const stLabel = stackStatusLabel(s.Status);
      const search = `${s.Id} ${s.Name} ${node} ${s.CreatedBy || ''} ${stLabel}`.toLowerCase();
      // Actions toujours disponibles (API liée à l’id stack / son nœud)
      const isRunning = stLabel === 'running';
      const actions = `<div class="quick-actions">
        ${bag.iconBtn({ act: 'start', id: s.Id, title: 'Démarrer', icon: 'start', success: !isRunning })}
        ${bag.iconBtn({ act: 'stop', id: s.Id, title: 'Arrêter', icon: 'stop', danger: isRunning })}
        ${bag.iconBtn({ act: 'restart', id: s.Id, title: 'Redémarrer', icon: 'restart' })}
        ${bag.iconBtn({ act: 'edit', id: s.Id, name: s.Name, title: 'Éditeur', icon: 'edit', info: true })}
        ${bag.iconBtn({ act: 'redeploy', id: s.Id, title: 'Pull images + redéployer', icon: 'pull' })}
        ${bag.iconBtn({ tag: 'a', href: `#stacks/${s.Id}`, title: 'Détail', icon: 'inspect' })}
        ${bag.iconBtn({ title: 'Partager', icon: 'users', info: true, shareType: 'stack', shareKey: String(s.Id) })}
        ${bag.iconBtn({ act: 'remove', id: s.Id, title: 'Supprimer', icon: 'remove', danger: true })}
      </div>`;
      const rowCls = isRunning ? '' : 'row-stopped';
      return `<tr class="${rowCls}" data-search="${bag.esc(search)}" data-stack-id="${bag.esc(s.Id)}">
      ${bag.bulkSelectTd(s.Id)}
      ${all ? `<td class="muted">${bag.esc(node)}</td>` : ''}
      <td class="name-cell">
        <strong><a href="#stacks/${s.Id}">${bag.esc(s.Name)}</a></strong>
        <span class="id">#${bag.esc(s.Id)}</span>
      </td>
      <td>${bag.badge(stLabel)}</td>
      <td class="mono cell-clip cell-image" title="Images Compose">
        <span class="img-with-upd">
          <span class="img-upd-slot" data-upd="${bag.esc(s.Id)}">
            <span class="img-upd is-loading img-upd-dot-only" title="Vérification des images…"><span class="img-upd-dot"></span></span>
          </span>
          <span class="img-name" data-upd-imgs="${bag.esc(s.Id)}">…</span>
        </span>
      </td>
      <td>${bag.esc(s.CreatedBy || '')}</td>
      <td>${bag.formatCreated(s.CreationDate)}</td>
      <td class="actions">${actions}</td>
    </tr>`;
    }).join('');
    const colSpan = all ? 8 : 7;
    bag.root.innerHTML = bag.shell('Stacks', `
      ${bag.pageHeader(all ? 'Stacks — tous les nœuds' : 'Stacks')}
      ${all ? bag.pickNodeGuardHtml() : ''}
      <div class="toolbar">
        <input class="search" id="filter" type="search" placeholder="Rechercher des stacks…" value="${bag.esc(bag.state.filters.stacks || '')}">
        ${all ? '' : `<a class="btn btn-info btn-create" href="#stacks/new" title="Créer une stack">
          <span class="btn-ico">${bag.ico('plus')}</span><span>Créer une stack</span>
        </a>`}
        ${bag.bulkDeleteBtnHtml()}
        <div class="spacer"></div>
        <span class="muted" style="font-size:12px">● vert = à jour · ● orange = mise à jour dispo · cache 24 h</span>
        <button type="button" class="btn btn-sm" id="stack-upd-refresh" title="Revérifier les images maintenant">Rafraîchir images</button>
        <span class="muted mono" id="filter-count">${list.length} / ${list.length}</span>
      </div>
      <div class="table-wrap"><table class="data">
        <thead><tr>
          ${bag.bulkSelectTh(true)}
          ${all ? bag.sortTh('Nœud', 'node', 'stacks') : ''}
          ${bag.sortTh('Nom', 'name', 'stacks')}
          ${bag.sortTh('État', 'state', 'stacks')}
          <th title="Images du registre">Image</th>
          ${bag.sortTh('Créé par', 'owner', 'stacks')}
          ${bag.sortTh('Créé', 'created', 'stacks')}
          <th>Actions</th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="${colSpan}" class="empty">Aucune stack disponible.</td></tr>`}</tbody>
      </table></div>`, { subtitle: all ? 'Vue agrégée' : 'Projets Compose' });
    bag.bindRefresh();
    bag.bindShareButtons();
    bag.bindMoreActions();
    bag.bindPagedSearch('stacks');
    bag.bindTableSort('stacks', () => bag.viewStacks());
    bag.root.querySelectorAll('[data-act]').forEach((btn) => {
      const act = btn.dataset.act;
      const confirmMsg = act === 'remove' ? 'Supprimer la stack et ses conteneurs ?' : null;
      bag.onBusyClick(btn, async (el) => {
        const id = el.dataset.id;
        if (act === 'edit') {
          const [stack, file] = await Promise.all([bag.Api.stack(id), bag.Api.stackFile(id)]);
          bag.showStackEditor({
            Id: stack.Id,
            Name: stack.Name || el.dataset.name || '',
            content: file.StackFileContent || '',
            Env: stack.Env || [],
          });
          return 'navigated';
        }
        if (act === 'redeploy') {
          await bag.upgradeStackImages(id);
          return;
        }
        if (act === 'start') await bag.Api.startStack(id);
        else if (act === 'stop') await bag.Api.stopStack(id);
        else if (act === 'restart') await bag.Api.restartStack(id);
        else if (act === 'remove') await bag.Api.deleteStack(id);
      }, {
        confirm: confirmMsg
          || (act === 'redeploy' ? 'Pull des images et redéploiement de la stack ?' : null),
        reload: act !== 'edit',
      });
    });
    bag.bindBulkDelete({
      enabled: true,
      confirmOne: () => 'Supprimer cette stack et ses conteneurs ?',
      confirmMany: (n) => `Supprimer ${n} stacks et leurs conteneurs ?`,
      deleteOne: (id) => bag.Api.deleteStack(id),
      reload: () => bag.viewStacks(),
    });
    document.getElementById('stack-upd-refresh')?.addEventListener('click', () => {
      bag.root.querySelectorAll('[data-upd-imgs]').forEach((el) => { el.textContent = '…'; el.title = ''; });
      bag.root.querySelectorAll('[data-upd]').forEach((slot) => {
        slot.innerHTML = `<span class="img-upd is-loading img-upd-dot-only" title="Vérification…"><span class="img-upd-dot"></span></span>`;
      });
      bag.loadStackUpdateIndicators(true);
    });
    bag.loadStackUpdateIndicators(false);
    bag.restoreListFocus();
  }

  /** Compact image label for list cells (same idea for stacks & containers). */
  bag.formatImageListLabel = function formatImageListLabel(images) {
    const names = (images || [])
      .map((i) => (typeof i === 'string' ? i : (i?.Image || '')).trim())
      .filter(Boolean);
    if (!names.length) return '—';
    if (names.length === 1) return names[0];
    if (names.length === 2) return `${names[0]}, ${names[1]}`;
    return `${names[0]} +${names.length - 1}`;
  }

  bag.stackUpdatePill = function stackUpdatePill(status, updateCount, title, opts = {}) {
    const st = status || 'unknown';
    const cls = st === 'update' ? 'is-update' : (st === 'fresh' || st === 'pinned' ? 'is-fresh' : 'is-unknown');
    const label = st === 'update'
      ? (updateCount > 1 ? `${updateCount} mises à jour` : 'Mise à jour')
      : (st === 'fresh' || st === 'pinned' ? 'À jour' : '—');
    const tip = st === 'update' && opts.action
      ? `${title || label}\n\nCliquer pour tirer les images et redéployer`
      : (title || label);
    const dotOnly = !!opts.dotOnly;
    const inner = dotOnly
      ? `<span class="img-upd-dot"></span>`
      : `<span class="img-upd-dot"></span><span class="img-upd-lbl">${bag.esc(label)}</span>`;
    const extraCls = dotOnly ? ' img-upd-dot-only' : '';
    if (st === 'update' && opts.action && opts.id != null) {
      return `<button type="button" class="img-upd ${cls} img-upd-action${extraCls}"
        data-upd-action="${bag.esc(opts.action)}" data-upd-id="${bag.esc(String(opts.id))}"
        title="${bag.esc(tip)}" aria-label="${bag.esc(label)}">${inner}</button>`;
    }
    return `<span class="img-upd ${cls}${extraCls}" title="${bag.esc(tip)}">${inner}</span>`;
  }

  /** Pull images + redeploy a stack (Compose up --pull). */
  bag.upgradeStackImages = async function upgradeStackImages(stackId) {
    const id = String(stackId || '');
    if (!id) throw new Error('Stack introuvable');
    const [stack, file] = await Promise.all([bag.Api.stack(id), bag.Api.stackFile(id)]);
    await bag.Api.updateStack(id, file.StackFileContent || '', stack.Env || [], true);
    return stack;
  }

  /** Resolve Compose stack for a container via com.docker.compose.project. */
  bag.findStackForContainer = async function findStackForContainer(containerId) {
    try {
      const info = await bag.Api.docker(`/containers/${encodeURIComponent(containerId)}/json`);
      const project = String(info?.Config?.Labels?.['com.docker.compose.project'] || '').trim();
      if (!project) return null;
      const stacks = await bag.Api.stacks();
      const want = project.toLowerCase();
      return (stacks || []).find((s) => String(s.Name || '').toLowerCase() === want) || null;
    } catch (_) {
      return null;
    }
  }

  /**
   * One-click image upgrade:
   * - stack → pull + redeploy Compose
   * - container → upgrade parent stack if Compose, else pull + recreate
   */
  bag.upgradeImageUpdateTarget = async function upgradeImageUpdateTarget(action, id) {
    if (action === 'stack') {
      await bag.upgradeStackImages(id);
      return { kind: 'stack', id };
    }
    if (action === 'container') {
      const stack = await bag.findStackForContainer(id);
      if (stack?.Id != null) {
        await bag.upgradeStackImages(stack.Id);
        return { kind: 'stack', id: stack.Id, via: 'container', name: stack.Name };
      }
      await bag.Api.updateContainerImage(id, true);
      return { kind: 'container', id };
    }
    throw new Error('Action de mise à jour inconnue');
  }

  bag.bindImageUpdateActions = function bindImageUpdateActions(scope = bag.root) {
    if (!scope) return;
    scope.querySelectorAll('[data-upd-action]').forEach((btn) => {
      if (btn.dataset.updBound === '1') return;
      btn.dataset.updBound = '1';
      const action = btn.dataset.updAction;
      const confirmMsg = action === 'stack'
        ? 'Tirer les nouvelles images et redéployer cette stack ? Les services seront recréés.'
        : 'Tirer l’image et mettre à jour ce conteneur ? (stack Compose si liée, sinon recrée le conteneur)';
      bag.onBusyClick(btn, async (el) => {
        const kind = el.dataset.updAction;
        const targetId = el.dataset.updId;
        const focus = bag.captureListFocus(el);
        await bag.upgradeImageUpdateTarget(kind, targetId);
        const route = String(bag.state.route || '');
        if (route.startsWith('stacks/') && route !== 'stacks/new') {
          const sid = route.split('/')[1];
          if (sid) {
            await bag.viewStackDetail(sid);
            bag.restoreListFocus(focus);
          }
          return;
        }
        if (route === 'stacks') {
          await bag.loadStackUpdateIndicators(true);
          bag.restoreListFocus(focus);
          return;
        }
        if (route.startsWith('containers/') && route !== 'containers/new') {
          bag.rememberListFocus(focus);
          await bag.route();
          bag.restoreListFocus(focus);
          return;
        }
        if (route === 'containers') {
          await bag.loadContainerUpdateIndicators(true);
          bag.restoreListFocus(focus);
        }
      }, { confirm: confirmMsg, minMs: 400 });
    });
  }

  bag.loadStackUpdateIndicators = async function loadStackUpdateIndicators(refresh = false) {
    try {
      const data = await bag.Api.stackUpdates(!!refresh);
      const map = data?.Updates || {};
      Object.keys(map).forEach((id) => {
        const slot = bag.root.querySelector(`[data-upd="${CSS.escape(String(id))}"]`);
        const nameEl = bag.root.querySelector(`[data-upd-imgs="${CSS.escape(String(id))}"]`);
        if (!slot) return;
        const u = map[id] || {};
        const imgs = u.Images || [];
        const imgLabel = bag.formatImageListLabel(imgs);
        const lines = imgs.map((i) => `${i.Service}: ${i.Detail || i.Status} (${i.Image})`);
        let title = lines.length ? lines.join('\n') : (u.Error || 'Aucun contrôle');
        if (u.FromCache && u.CheckedAt) {
          title += `\n(cache · vérifié ${new Date(u.CheckedAt * 1000).toLocaleString()})`;
        }
        if (nameEl) {
          nameEl.textContent = imgLabel;
          nameEl.title = lines.length
            ? imgs.map((i) => `${i.Service}: ${i.Image}`).join('\n')
            : imgLabel;
          const cell = nameEl.closest('td');
          if (cell) cell.title = nameEl.title || imgLabel;
        }
        slot.innerHTML = bag.stackUpdatePill(u.Status, u.UpdateCount || 0, title, {
          action: 'stack',
          id,
          dotOnly: true,
        });
      });
      bag.root.querySelectorAll('[data-upd] .img-upd.is-loading').forEach((el) => {
        el.className = 'img-upd is-unknown img-upd-dot-only';
        el.title = 'Contrôle indisponible';
      });
      bag.root.querySelectorAll('[data-upd-imgs]').forEach((el) => {
        if (el.textContent === '…') el.textContent = '—';
      });
      bag.bindImageUpdateActions(bag.root);
    } catch {
      bag.root.querySelectorAll('[data-upd-imgs]').forEach((el) => { el.textContent = '—'; });
      bag.root.querySelectorAll('[data-upd]').forEach((slot) => {
        slot.innerHTML = bag.stackUpdatePill('unknown', 0, 'Contrôle indisponible', { dotOnly: true });
      });
    }
  }

  bag.parseDotEnv = function parseDotEnv(text) {
    const pairs = [];
    String(text || '').split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const body = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
      const eq = body.indexOf('=');
      if (eq <= 0) return;
      const name = body.slice(0, eq).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return;
      let value = body.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      pairs.push({ name, value });
    });
    return pairs;
  }

  /** Lint Compose YAML: indentation rules + js-yaml parse. */

  bag.lintComposeYaml = function lintComposeYaml(text) {
    const found = [];
    if (typeof CodeMirror === 'undefined') return found;
    const Pos = CodeMirror.Pos;
    const lines = String(text || '').split(/\r?\n/);
    const unit = 2;
    const stack = [0];
    let inBlock = false;
    let blockBase = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) continue;

      const leadMatch = line.match(/^[ \t]*/);
      const lead = leadMatch ? leadMatch[0] : '';
      if (lead.includes('\t')) {
        found.push({
          from: Pos(i, 0),
          to: Pos(i, lead.length || 1),
          message: 'Tabulation interdite dans l’indentation — utilisez des espaces',
          severity: 'error',
        });
        continue;
      }

      const indent = lead.length;

      // Content of | or > block scalars: any deeper indent is allowed
      if (inBlock) {
        if (indent > blockBase) continue;
        inBlock = false;
      }

      if (trimmed.startsWith('#')) continue;
      if (trimmed === '---' || trimmed === '...') continue;

      if (indent % unit !== 0) {
        found.push({
          from: Pos(i, 0),
          to: Pos(i, Math.max(indent, 1)),
          message: `Indentation invalide : ${indent} espace${indent > 1 ? 's' : ''} (attendu un multiple de ${unit})`,
          severity: 'error',
        });
      }

      const prev = stack[stack.length - 1];
      if (indent > prev) {
        if (indent !== prev + unit) {
          found.push({
            from: Pos(i, 0),
            to: Pos(i, Math.max(indent, 1)),
            message: `Saut d’indentation : ${prev} → ${indent} (attendu ${prev + unit})`,
            severity: 'error',
          });
        }
        stack.push(indent);
      } else if (indent < prev) {
        while (stack.length > 1 && stack[stack.length - 1] > indent) stack.pop();
        if (stack[stack.length - 1] !== indent) {
          found.push({
            from: Pos(i, 0),
            to: Pos(i, Math.max(indent, 1)),
            message: `Niveau d’indentation incohérent (${indent} espaces)`,
            severity: 'error',
          });
          stack.push(indent);
        }
      }

      // Enter block scalar after key: | or key: >
      if (/:\s*[|>][-+0-9]*\s*(#.*)?$/.test(trimmed) || /^[|>][-+0-9]*\s*(#.*)?$/.test(trimmed)) {
        inBlock = true;
        blockBase = indent;
      }
    }

    const yaml = window.jsyaml;
    if (yaml && typeof yaml.load === 'function' && String(text || '').trim()) {
      try {
        yaml.load(text);
      } catch (e) {
        const mark = e && e.mark;
        const line = mark && Number.isFinite(mark.line) ? mark.line : 0;
        const col = mark && Number.isFinite(mark.column) ? mark.column : 0;
        const msg = (e && (e.reason || e.message)) || 'YAML invalide';
        const already = found.some((f) => f.from.line === line && f.severity === 'error');
        if (!already) {
          found.push({
            from: Pos(line, col),
            to: Pos(line, col + 1),
            message: msg,
            severity: 'error',
          });
        }
      }
    }
    return found;
  }

  bag.updateYamlStatus = function updateYamlStatus(el, annotations) {
    if (!el) return;
    const errs = (annotations || []).filter((a) => a.severity !== 'warning');
    if (!errs.length) {
      el.className = 'yaml-status is-ok';
      el.innerHTML = `<span class="yaml-dot"></span>YAML valide`;
      return;
    }
    const first = errs[0];
    const line = (first.from && first.from.line != null) ? first.from.line + 1 : '?';
    el.className = 'yaml-status is-err';
    el.innerHTML = `<span class="yaml-dot"></span><strong>${errs.length} erreur${errs.length > 1 ? 's' : ''}</strong>
      — ligne ${bag.esc(String(line))} : ${bag.esc(first.message || 'invalide')}${errs.length > 1 ? '…' : ''}`;
  }

  /**
   * Replace a textarea with a CodeMirror YAML editor.
   * @returns {{ getValue: () => string, setValue: (v: string) => void, hasErrors: () => boolean, focus: () => void } | null}
   */

  bag.mountYamlEditor = function mountYamlEditor(textarea, statusEl) {
    if (!textarea || typeof CodeMirror === 'undefined') return null;
    if (!CodeMirror._wharfYamlLint) {
      CodeMirror.registerHelper('lint', 'yaml', (text) => bag.lintComposeYaml(text));
      CodeMirror._wharfYamlLint = true;
    }
    const cm = CodeMirror.fromTextArea(textarea, {
      mode: 'yaml',
      theme: 'wharf',
      lineNumbers: true,
      lineWrapping: true,
      indentUnit: 2,
      tabSize: 2,
      indentWithTabs: false,
      smartIndent: true,
      matchBrackets: true,
      styleActiveLine: true,
      gutters: ['CodeMirror-linenumbers', 'CodeMirror-lint-markers'],
      lint: {
        getAnnotations: (text, updateLinting, opts, editor) => {
          const anns = bag.lintComposeYaml(text);
          updateLinting(editor, anns);
          bag.updateYamlStatus(statusEl, anns);
        },
        async: true,
      },
      extraKeys: {
        Tab: (cmInst) => {
          if (cmInst.somethingSelected()) cmInst.indentSelection('add');
          else cmInst.replaceSelection('  ', 'end');
        },
      },
    });
    // Initial status
    bag.updateYamlStatus(statusEl, bag.lintComposeYaml(cm.getValue()));
    requestAnimationFrame(() => { try { cm.refresh(); } catch (_) {} });
    return {
      getValue: () => cm.getValue(),
      setValue: (v) => cm.setValue(v),
      hasErrors: () => bag.lintComposeYaml(cm.getValue()).some((a) => a.severity !== 'warning'),
      focus: () => cm.focus(),
      cm,
    };
  }

  bag.showStackEditor = function showStackEditor(existing) {
    const isEdit = !!existing;
    const defaultCompose = `services:
  web:
    image: nginx:alpine
    ports:
      - "8090:80"
  `;
    const initialEnv = Array.isArray(existing?.Env) ? existing.Env : [];
    bag.root.innerHTML = bag.shell(isEdit ? 'Modifier la stack' : 'Créer une stack', `
      ${bag.pageHeader(isEdit ? 'Modifier la stack' : 'Créer une stack', false)}
      <div id="stack-err"></div>
      <div class="form-group">
        <label class="field-label">Nom <span class="req">*</span></label>
        <input id="stack-name" ${isEdit ? 'disabled' : ''} value="${bag.esc(existing?.Name || '')}" placeholder="ex. ma-stack">
      </div>

      <div class="form-group">
        <label class="field-label">Fichier Compose <span class="req">*</span></label>
        <div class="code-editor code-editor-yaml">
          <div class="code-editor-bar">
            <span class="yaml-hint muted">YAML · indentation 2 espaces</span>
            ${bag.iconBtn({ elId: 'copy-compose', title: 'Copier', icon: 'copy' })}
          </div>
          <textarea id="stack-file">${bag.esc(existing?.content || defaultCompose)}</textarea>
          <div class="yaml-status" id="yaml-status" aria-live="polite"></div>
        </div>
      </div>

      <div class="section-title">Variables d’environnement</div>
      <div class="info-box">
        Écrites dans <code>.env</code> du projet Compose et injectées au déploiement (<code>\${VAR}</code> dans le YAML).
      </div>
      <div class="toolbar env-toolbar">
        <button type="button" class="btn btn-sm" id="add-env">+ Ajouter une variable</button>
        <button type="button" class="btn btn-sm" id="load-env">Charger un fichier .env</button>
        <input type="file" id="env-file" accept=".env,text/plain,*/*" hidden>
      </div>
      <div class="env-list" id="env-list"></div>
      <div class="muted" id="env-empty" style="font-size:13px;margin-top:6px">Aucune variable</div>

      <div class="form-group" style="margin-top:18px">
        <label class="field-inline" style="gap:8px;cursor:pointer">
          <input type="checkbox" id="stack-pull" ${isEdit ? 'checked' : ''}>
          <span>Forcer le pull des images depuis le registre</span>
        </label>
        <p class="field-hint muted">Utile pour une mise à jour (<code>latest</code> ou tag flottant). Lance <code>docker compose up --pull always</code>.</p>
      </div>

      <div class="actions-bar">
        <button class="btn btn-primary" id="stack-save">${isEdit ? 'Mettre à jour la stack' : 'Déployer la stack'}</button>
        <button type="button" class="btn" id="stack-cancel" style="margin-left:8px">Annuler</button>
      </div>
    `);

    const envList = document.getElementById('env-list');
    const envEmpty = document.getElementById('env-empty');

    function syncEnvEmpty() {
      const rows = envList?.querySelectorAll('.env-row') || [];
      if (envEmpty) envEmpty.hidden = rows.length > 0;
    }

    function addEnvRow(name = '', value = '') {
      const row = document.createElement('div');
      row.className = 'env-row';
      row.innerHTML = `
        <input class="env-name" placeholder="NOM" value="${bag.esc(name)}" autocomplete="off" spellcheck="false">
        <input class="env-value" placeholder="valeur" value="${bag.esc(value)}" autocomplete="off" spellcheck="false">
        <button type="button" class="icon-btn env-remove" title="Retirer" aria-label="Retirer">✕</button>`;
      row.querySelector('.env-remove')?.addEventListener('click', () => {
        row.remove();
        syncEnvEmpty();
      });
      envList?.appendChild(row);
      syncEnvEmpty();
      return row;
    }

    function collectEnv() {
      const Env = [];
      const errors = [];
      envList?.querySelectorAll('.env-row').forEach((row, i) => {
        const name = row.querySelector('.env-name')?.value?.trim() || '';
        const value = row.querySelector('.env-value')?.value ?? '';
        if (!name && value === '') return;
        if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          errors.push(`Variable ${i + 1} : nom invalide (ex. MYSQL_PASSWORD)`);
          return;
        }
        Env.push({ name, value });
      });
      return { Env, errors };
    }

    function mergeEnvPairs(pairs, { replace = false } = {}) {
      if (replace) envList.innerHTML = '';
      const existing = new Map();
      envList?.querySelectorAll('.env-row').forEach((row) => {
        const n = row.querySelector('.env-name')?.value?.trim();
        if (n) existing.set(n, row);
      });
      pairs.forEach(({ name, value }) => {
        if (existing.has(name)) {
          existing.get(name).querySelector('.env-value').value = value;
        } else {
          addEnvRow(name, value);
        }
      });
      syncEnvEmpty();
    }

    initialEnv.forEach((p) => {
      const name = p.name || p.Name || '';
      const value = p.value ?? p.Value ?? '';
      if (name) addEnvRow(name, value);
    });
    syncEnvEmpty();

    document.getElementById('add-env')?.addEventListener('click', () => {
      const row = addEnvRow();
      row.querySelector('.env-name')?.focus();
    });
    document.getElementById('load-env')?.addEventListener('click', () => {
      document.getElementById('env-file')?.click();
    });
    document.getElementById('env-file')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      try {
        const text = await file.text();
        const pairs = bag.parseDotEnv(text);
        if (!pairs.length) {
          const errBox = document.getElementById('stack-err');
          if (errBox) errBox.innerHTML = `<div class="error-box">Aucune variable trouvée dans ce fichier.</div>`;
          return;
        }
        mergeEnvPairs(pairs);
      } catch (err) {
        const errBox = document.getElementById('stack-err');
        if (errBox) errBox.innerHTML = `<div class="error-box">${bag.esc(err.message || 'Lecture .env impossible')}</div>`;
      }
    });

    const yamlStatus = document.getElementById('yaml-status');
    const yamlEditor = bag.mountYamlEditor(document.getElementById('stack-file'), yamlStatus);
    const readCompose = () => (yamlEditor ? yamlEditor.getValue() : (document.getElementById('stack-file')?.value || ''));

    document.getElementById('copy-compose').onclick = async () => {
      try { await navigator.clipboard.writeText(readCompose()); } catch (_) {}
    };
    bag.onBusyClick(document.getElementById('stack-save'), async () => {
      const name = document.getElementById('stack-name').value.trim();
      const content = readCompose();
      const errBox = document.getElementById('stack-err');
      if (errBox) errBox.innerHTML = '';
      if (yamlEditor?.hasErrors()) {
        const anns = bag.lintComposeYaml(content);
        bag.updateYamlStatus(yamlStatus, anns);
        const first = anns.find((a) => a.severity !== 'warning') || anns[0];
        const line = first?.from?.line != null ? first.from.line + 1 : '?';
        if (errBox) {
          errBox.innerHTML = `<div class="error-box">Compose YAML invalide (ligne ${bag.esc(String(line))}) : ${bag.esc(first?.message || 'corrigez l’indentation')}</div>`;
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
        return;
      }
      const { Env, errors } = collectEnv();
      if (errors.length) {
        if (errBox) errBox.innerHTML = `<div class="error-box">${bag.esc(errors.join('\n'))}</div>`;
        return;
      }
      const pullImages = !!document.getElementById('stack-pull')?.checked;
      try {
        const gate = await bag.cveAdviseBeforeDeploy({ Compose: content }, errBox);
        if (!gate.proceed) {
          if (errBox) {
            errBox.innerHTML = (errBox.innerHTML || '') + `<div class="info-box" style="margin-top:8px">Déploiement annulé.</div>`;
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }
          return;
        }
        if (isEdit) {
          bag.rememberListFocus({ id: String(existing.Id), name: existing.Name || name || '', y: 0 });
          await bag.Api.updateStack(existing.Id, content, Env, pullImages);
        } else {
          await bag.Api.createStack(name, content, Env, pullImages);
        }
        const cur = (location.hash || '').replace(/^#/, '') || 'stacks';
        if (cur === 'stacks') await bag.viewStacks();
        else location.hash = '#stacks';
      } catch (err) {
        if (errBox) {
          errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
          window.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
          alert(err.message);
        }
      }
    }, { disableSiblings: false, minMs: 400 });

    document.getElementById('stack-cancel')?.addEventListener('click', () => {
      // Toujours revenir à la liste. Si le hash est déjà #stacks (édition via crayon),
      // forcer le re-render car hashchange ne partira pas.
      const cur = (location.hash || '').replace(/^#/, '') || 'stacks';
      if (cur === 'stacks') {
        bag.viewStacks();
        return;
      }
      location.hash = '#stacks';
    });
  }

  bag.schedActionLabel = function schedActionLabel(action) {
    const map = { start: 'Démarrer', stop: 'Arrêter', restart: 'Redémarrer' };
    return map[action] || action || '—';
  }

  bag.DOW_LABELS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

  bag.pad2 = function pad2(n) {
    return String(Number(n) || 0).padStart(2, '0');
  }

  /** Build a 5-field UTC cron from the friendly schedule form. */

  bag.buildFriendlyCron = function buildFriendlyCron({ preset, hour, minute, dow, custom }) {
    const h = Math.max(0, Math.min(23, Number(hour) || 0));
    const m = Math.max(0, Math.min(59, Number(minute) || 0));
    const d = Math.max(0, Math.min(6, Number(dow) || 0));
    switch (preset) {
      case 'hourly':
        return `${m} * * * *`;
      case 'daily':
        return `${m} ${h} * * *`;
      case 'weekdays':
        return `${m} ${h} * * 1-5`;
      case 'weekly':
        return `${m} ${h} * * ${d}`;
      case 'custom':
        return String(custom || '').trim();
      default:
        return `${m} ${h} * * *`;
    }
  }

  bag.describeCron = function describeCron(cron) {
    const parts = String(cron || '').trim().split(/\s+/);
    if (parts.length !== 5) return cron || '—';
    const [mi, hh, dom, mon, dow] = parts;
    const hm = (h, m) => `${bag.pad2(h)}:${bag.pad2(m)} UTC`;
    if (mi !== '*' && hh === '*' && dom === '*' && mon === '*' && dow === '*') {
      return `Toutes les heures à xx:${bag.pad2(mi)} UTC`;
    }
    if (/^\d+$/.test(mi) && /^\d+$/.test(hh) && dom === '*' && mon === '*' && dow === '*') {
      return `Tous les jours à ${hm(hh, mi)}`;
    }
    if (/^\d+$/.test(mi) && /^\d+$/.test(hh) && dom === '*' && mon === '*' && dow === '1-5') {
      return `Lun–Ven à ${hm(hh, mi)}`;
    }
    if (/^\d+$/.test(mi) && /^\d+$/.test(hh) && dom === '*' && mon === '*' && /^\d+$/.test(dow)) {
      return `Chaque ${bag.DOW_LABELS[Number(dow)] || dow} à ${hm(hh, mi)}`;
    }
    return cron;
  }

  bag.openScheduleModal = function openScheduleModal(stack, onSaved) {
    const slot = document.getElementById('sched-modal');
    if (!slot) return;
    const hourOpts = Array.from({ length: 24 }, (_, h) =>
      `<option value="${h}" ${h === 22 ? 'selected' : ''}>${bag.pad2(h)} h</option>`
    ).join('');
    const minOpts = [0, 5, 10, 15, 20, 30, 45].map((m) =>
      `<option value="${m}">:${bag.pad2(m)}</option>`
    ).join('');
    const dowOpts = bag.DOW_LABELS.map((label, i) =>
      `<option value="${i}" ${i === 1 ? 'selected' : ''}>${label}</option>`
    ).join('');

    slot.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-form" style="max-width:520px" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3>Nouvelle planification</h3>
              <div class="modal-sub">Stack · ${bag.esc(stack.Name || '')}</div>
            </div>
            <button type="button" class="icon-btn" id="cancel-sched" title="Fermer" aria-label="Fermer">✕</button>
          </div>
          <div id="sched-form-err"></div>
          <div class="form-group">
            <label class="field-label">Nom</label>
            <input id="sched-name" placeholder="Ex. Arrêt le soir" autocomplete="off">
          </div>
          <div class="form-group">
            <label class="field-label">Action</label>
            <select id="sched-action" class="select-block">
              <option value="stop">Arrêter la stack</option>
              <option value="start">Démarrer la stack</option>
              <option value="restart">Redémarrer la stack</option>
            </select>
          </div>
          <div class="form-group">
            <label class="field-label">Quand ?</label>
            <select id="sched-preset" class="select-block">
              <option value="daily" selected>Tous les jours</option>
              <option value="weekdays">Jours ouvrés (lun–ven)</option>
              <option value="weekly">Une fois par semaine</option>
              <option value="hourly">Toutes les heures</option>
              <option value="custom">Personnalisé (cron)</option>
            </select>
          </div>
          <div class="form-row-2" id="sched-time-row" style="align-items:end;gap:10px">
            <div class="form-group" style="margin:0;flex:1" id="sched-hour-wrap">
              <label class="field-label">Heure (UTC)</label>
              <select id="sched-hour" class="select-block">${hourOpts}</select>
            </div>
            <div class="form-group" style="margin:0;flex:1">
              <label class="field-label">Minute</label>
              <select id="sched-minute" class="select-block">${minOpts}</select>
            </div>
          </div>
          <div class="form-group" id="sched-dow-wrap" hidden>
            <label class="field-label">Jour de la semaine</label>
            <select id="sched-dow" class="select-block">${dowOpts}</select>
          </div>
          <div class="form-group" id="sched-custom-wrap" hidden>
            <label class="field-label">Expression cron (UTC)</label>
            <input id="sched-cron" class="mono" placeholder="0 22 * * *" autocomplete="off" spellcheck="false">
            <p class="field-hint muted">5 champs : minute heure jour mois jour-semaine</p>
          </div>
          <div class="info-box" id="sched-summary" style="margin-top:4px">—</div>
          <div class="actions-bar">
            <button class="btn btn-primary" id="save-sched">Créer</button>
            <button class="btn" id="cancel-sched-2" style="margin-left:8px">Annuler</button>
          </div>
        </div>
      </div>`;

    const syncUi = () => {
      const preset = document.getElementById('sched-preset')?.value || 'daily';
      const hourWrap = document.getElementById('sched-hour-wrap');
      const timeRow = document.getElementById('sched-time-row');
      const dowWrap = document.getElementById('sched-dow-wrap');
      const customWrap = document.getElementById('sched-custom-wrap');
      const isCustom = preset === 'custom';
      const isHourly = preset === 'hourly';
      if (customWrap) customWrap.hidden = !isCustom;
      if (timeRow) timeRow.hidden = isCustom;
      if (hourWrap) hourWrap.hidden = isHourly || isCustom;
      if (dowWrap) dowWrap.hidden = preset !== 'weekly';
      const cron = bag.buildFriendlyCron({
        preset,
        hour: document.getElementById('sched-hour')?.value,
        minute: document.getElementById('sched-minute')?.value,
        dow: document.getElementById('sched-dow')?.value,
        custom: document.getElementById('sched-cron')?.value,
      });
      const action = bag.schedActionLabel(document.getElementById('sched-action')?.value);
      const sum = document.getElementById('sched-summary');
      if (sum) {
        sum.innerHTML = isCustom && !cron
          ? '<span class="muted">Saisissez une expression cron.</span>'
          : `<strong>${bag.esc(action)}</strong> — ${bag.esc(bag.describeCron(cron))}`
            + (isCustom ? '' : ` <span class="muted mono">(${bag.esc(cron)})</span>`);
      }
    };

    ['sched-preset', 'sched-hour', 'sched-minute', 'sched-dow', 'sched-action'].forEach((id) => {
      document.getElementById(id)?.addEventListener('change', syncUi);
    });
    document.getElementById('sched-cron')?.addEventListener('input', syncUi);
    syncUi();

    const close = () => { slot.innerHTML = ''; };
    document.getElementById('cancel-sched').onclick = close;
    document.getElementById('cancel-sched-2').onclick = close;

    bag.onBusyClick(document.getElementById('save-sched'), async () => {
      const errBox = document.getElementById('sched-form-err');
      errBox.innerHTML = '';
      const name = document.getElementById('sched-name').value.trim();
      const action = document.getElementById('sched-action').value;
      const cron = bag.buildFriendlyCron({
        preset: document.getElementById('sched-preset').value,
        hour: document.getElementById('sched-hour').value,
        minute: document.getElementById('sched-minute').value,
        dow: document.getElementById('sched-dow').value,
        custom: document.getElementById('sched-cron').value,
      });
      if (!name) {
        errBox.innerHTML = `<div class="error-box">Indiquez un nom.</div>`;
        return;
      }
      if (!cron) {
        errBox.innerHTML = `<div class="error-box">Indiquez quand exécuter l’action.</div>`;
        return;
      }
      try {
        await bag.Api.createSchedule({
          StackId: stack.Id,
          Name: name,
          Action: action,
          Cron: cron,
        });
        close();
        if (typeof onSaved === 'function') await onSaved();
      } catch (err) {
        errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
      }
    }, { disableSiblings: false, minMs: 250 });
  }

  bag.viewStackDetail = async function viewStackDetail(id) {
    if (id === 'new') {
      bag.showStackEditor();
      return;
    }
    const [stack, file] = await Promise.all([bag.Api.stack(id), bag.Api.stackFile(id)]);
    const stLabel = Number(stack.Status) === 1 ? 'running' : 'exited';
    const stackRunning = stLabel === 'running';
    bag.root.innerHTML = bag.shell(`Stack · ${stack.Name}`, `
      ${bag.pageHeader(stack.Name, false)}
      <div class="toolbar">
        ${bag.iconBtn({ tag: 'a', href: '#stacks', title: 'Retour', icon: 'back' })}
        <div class="quick-actions">
          ${bag.iconBtn({ act: 'start', id: stack.Id, title: 'Démarrer', icon: 'start', success: !stackRunning })}
          ${bag.iconBtn({ act: 'stop', id: stack.Id, title: 'Arrêter', icon: 'stop', danger: stackRunning })}
          ${bag.iconBtn({ act: 'restart', id: stack.Id, title: 'Redémarrer', icon: 'restart' })}
          ${bag.iconBtn({ elId: 'edit', title: 'Éditeur', icon: 'edit', info: true })}
          ${bag.iconBtn({ title: 'Partager', icon: 'users', info: true, shareType: 'stack', shareKey: String(stack.Id) })}
          ${bag.iconBtn({ elId: 'stack-pull-redeploy', title: 'Pull images + redéployer', icon: 'pull' })}
          ${bag.iconBtn({ act: 'remove', id: stack.Id, title: 'Supprimer', icon: 'remove', danger: true })}
        </div>
      </div>
      <div id="stack-detail-err"></div>
      <div class="panel" style="margin-bottom:1rem">
        <dl class="kv">
          <dt>Id</dt><dd>${stack.Id}</dd>
          <dt>Type</dt><dd>Compose</dd>
          <dt>Statut</dt><dd>${bag.badge(stLabel)}</dd>
          <dt>Images</dt><dd id="stack-upd-summary"><span class="img-upd is-loading" title="Vérification…"><span class="img-upd-dot"></span><span class="img-upd-lbl">…</span></span></dd>
          <dt>Nœud</dt><dd>${bag.esc(bag.endpointLabel(stack.EndpointId))} <span class="muted">(#${bag.esc(stack.EndpointId)})</span></dd>
        </dl>
      </div>
      <div class="section-title">Conteneurs</div>
      <div class="table-wrap" style="margin-bottom:1rem">
        <table class="data" id="stack-containers-table">
          <thead><tr><th>Service</th><th>Nom</th><th>État</th><th>Image</th><th>Ports</th><th></th></tr></thead>
          <tbody><tr><td colspan="6" class="muted">Chargement…</td></tr></tbody>
        </table>
      </div>
      <div class="section-title">Images des services</div>
      <div class="table-wrap" style="margin-bottom:1rem">
        <table class="data" id="stack-upd-table">
          <thead><tr><th>Service</th><th>Image</th><th>État</th><th>Détail</th></tr></thead>
          <tbody><tr><td colspan="4" class="muted">Vérification des digests…</td></tr></tbody>
        </table>
      </div>
      <div class="section-title">Fichier Compose</div>
      <pre class="compose-preview cm-s-wharf" id="compose-preview" style="margin-bottom:1rem"></pre>
      <div class="section-title">Planifications</div>
      <div class="toolbar" style="margin-bottom:8px">
        ${bag.createBtn('add-schedule', 'Nouvelle planification')}
      </div>
      <div class="table-wrap" style="margin-bottom:1rem">
        <table class="data" id="stack-sched-table">
          <thead><tr><th>Nom</th><th>Action</th><th>Quand</th><th>Prochain</th><th>Dernier</th><th></th></tr></thead>
          <tbody><tr><td colspan="6" class="muted">Chargement…</td></tr></tbody>
        </table>
      </div>
      <div class="section-title">Export</div>
      <div class="toolbar" style="margin-bottom:8px; flex-wrap:wrap; gap:10px; align-items:center">
        <button type="button" class="btn btn-primary" id="stack-export">Exporter compose + volumes</button>
        <span class="muted" style="font-size:12.5px">ZIP : docker-compose, .env, données des volumes et binds</span>
      </div>
      <div id="stack-export-status" style="margin-bottom:1rem"></div>
      <div id="sched-modal"></div>`);
    const preview = document.getElementById('compose-preview');
    const composeText = file.StackFileContent || '';
    if (preview) {
      if (typeof CodeMirror !== 'undefined' && CodeMirror.runMode) {
        CodeMirror.runMode(composeText, 'yaml', preview);
      } else {
        preview.textContent = composeText;
      }
    }
    const editBtn = document.getElementById('edit');
    if (editBtn) {
      editBtn.onclick = () =>
        bag.showStackEditor({ Id: stack.Id, Name: stack.Name, content: file.StackFileContent, Env: stack.Env || [] });
    }
    bag.onBusyClick(document.getElementById('stack-export'), async () => {
      const status = document.getElementById('stack-export-status');
      const setStatus = (html) => { if (status) status.innerHTML = html; };
      setStatus(`<div class="info-box">Préparation de l’export (compose + volumes)… cela peut prendre un moment.</div>`);
      try {
        const res = await bag.Api.downloadStackExport(stack.Id);
        const sizeMo = res?.size ? ` (${(res.size / (1000 * 1000)).toFixed(1)} Mo)` : '';
        setStatus(`<div class="info-box">Export téléchargé${res?.filename ? ` : <span class="mono">${bag.esc(res.filename)}</span>` : ''}${sizeMo}.</div>`);
      } catch (err) {
        setStatus(`<div class="error-box">${bag.esc(err.message || String(err))}</div>`);
        throw err;
      }
    }, { minMs: 400, disableSiblings: false });
    bag.onBusyClick(document.getElementById('stack-pull-redeploy'), async (el) => {
      const errBox = document.getElementById('stack-detail-err');
      const focus = bag.captureListFocus(el);
      if (errBox) errBox.innerHTML = '';
      try {
        await bag.Api.updateStack(stack.Id, file.StackFileContent || '', stack.Env || [], true);
        if (errBox) errBox.innerHTML = `<div class="info-box">Images tirées et stack redéployée.</div>`;
        await bag.viewStackDetail(id);
        bag.restoreListFocus(focus);
      } catch (err) {
        if (errBox) errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
      }
    }, { minMs: 400 });
    bag.bindShareButtons();
    bag.bindMoreActions();
    bag.root.querySelectorAll('[data-act]').forEach((btn) => {
      const act = btn.dataset.act;
      const confirmMsg = act === 'remove' ? 'Supprimer la stack et ses conteneurs ?' : null;
      bag.onBusyClick(btn, async (el) => {
        const sid = el.dataset.id;
        const focus = bag.captureListFocus(el);
        if (act === 'start') await bag.Api.startStack(sid);
        else if (act === 'stop') await bag.Api.stopStack(sid);
        else if (act === 'restart') await bag.Api.restartStack(sid);
        else if (act === 'remove') {
          await bag.Api.deleteStack(sid);
          location.hash = '#stacks';
          return 'navigated';
        }
        await bag.viewStackDetail(id);
        bag.restoreListFocus(focus);
      }, { confirm: confirmMsg, minMs: 300 });
    });
    const renderSchedules = async () => {
      const tb = document.querySelector('#stack-sched-table tbody');
      if (!tb) return;
      try {
        const res = await bag.Api.schedules({ stackId: stack.Id });
        const items = res.Items || [];
        if (!items.length) {
          tb.innerHTML = `<tr><td colspan="6" class="muted">Aucune planification</td></tr>`;
          return;
        }
        tb.innerHTML = items.map((s) => `<tr>
          <td>${bag.esc(s.Name)}${s.Enabled ? '' : ' <span class="muted">(off)</span>'}</td>
          <td>${bag.esc(bag.schedActionLabel(s.Action))}</td>
          <td><span title="${bag.esc(s.Cron)}">${bag.esc(bag.describeCron(s.Cron))}</span></td>
          <td class="muted">${bag.esc(bag.fmtTs(s.NextRunAt))}</td>
          <td class="muted">${bag.esc(s.LastStatus || '—')} ${s.LastRunAt ? '· ' + bag.fmtTs(s.LastRunAt) : ''}</td>
          <td class="actions"><div class="quick-actions">
            ${bag.iconBtn({ runSched: s.Id, title: 'Exécuter maintenant', icon: 'start', success: true })}
            ${bag.iconBtn({ delSched: s.Id, title: 'Supprimer', icon: 'remove', danger: true })}
          </div></td>
        </tr>`).join('');
        tb.querySelectorAll('[data-run-sched]').forEach((btn) => {
          bag.onBusyClick(btn, async (el) => {
            await bag.Api.runSchedule(el.dataset.runSched);
            await renderSchedules();
          }, { minMs: 300 });
        });
        tb.querySelectorAll('[data-del-sched]').forEach((btn) => {
          bag.onBusyClick(btn, async (el) => {
            await bag.Api.deleteSchedule(el.dataset.delSched);
            await renderSchedules();
          }, { confirm: 'Supprimer cette planification ?', minMs: 250 });
        });
      } catch (err) {
        tb.innerHTML = `<tr><td colspan="6" class="error-box">${bag.esc(err.message)}</td></tr>`;
      }
    };
    document.getElementById('add-schedule').onclick = () => bag.openScheduleModal(stack, renderSchedules);
    renderSchedules();

    const renderStackContainers = async () => {
      const tb = document.querySelector('#stack-containers-table tbody');
      if (!tb) return;
      try {
        const ep = Number(stack.EndpointId) || bag.Api.getEndpointId();
        const project = String(stack.Name || '').trim();
        const filters = encodeURIComponent(JSON.stringify({
          label: [`com.docker.compose.project=${project}`],
        }));
        let list = await bag.Api.dockerOn(ep, `/containers/json?all=true&filters=${filters}`);
        if (!Array.isArray(list)) list = [];
        // Fallback: match project label case-insensitively if Docker filter returned nothing
        if (!list.length && project) {
          const all = await bag.Api.dockerOn(ep, '/containers/json?all=true');
          const want = project.toLowerCase();
          list = (Array.isArray(all) ? all : []).filter((c) => {
            const labels = c.Labels || {};
            return String(labels['com.docker.compose.project'] || '').toLowerCase() === want;
          });
        }
        list.sort((a, b) => {
          const sa = String((a.Labels || {})['com.docker.compose.service'] || '');
          const sb = String((b.Labels || {})['com.docker.compose.service'] || '');
          return sa.localeCompare(sb) || String(a.Names?.[0] || '').localeCompare(String(b.Names?.[0] || ''));
        });
        if (!list.length) {
          tb.innerHTML = `<tr><td colspan="6" class="muted">Aucun conteneur pour le projet Compose « ${bag.esc(project)} »</td></tr>`;
          return;
        }
        tb.innerHTML = list.map((c) => {
          const name = (c.Names && c.Names[0] ? c.Names[0].replace(/^\//, '') : bag.shortId(c.Id));
          const labels = c.Labels || {};
          const service = labels['com.docker.compose.service'] || '—';
          const st = String(c.State || '').toLowerCase();
          const isRunning = st === 'running' || st === 'restarting';
          const openHref = `#containers/${bag.esc(c.Id)}`;
          return `<tr data-container-id="${bag.esc(c.Id)}">
            <td class="mono">${bag.esc(service)}</td>
            <td class="name-cell">
              <strong><a href="${openHref}" data-switch-node="${bag.esc(ep)}">${bag.esc(name)}</a></strong>
              <span class="id">${bag.esc(bag.shortId(c.Id))}</span>
            </td>
            <td>${bag.badge(c.State)}</td>
            <td class="mono">${bag.esc(c.Image || '')}</td>
            <td>${bag.formatPorts(c.Ports || [], ep)}</td>
            <td class="actions"><div class="quick-actions">
              ${bag.iconBtn({ act: 'start', id: c.Id, title: 'Démarrer', icon: 'start', success: !isRunning })}
              ${bag.iconBtn({ act: 'stop', id: c.Id, title: 'Arrêter', icon: 'stop', danger: isRunning })}
              ${bag.iconBtn({ act: 'restart', id: c.Id, title: 'Redémarrer', icon: 'restart' })}
              ${bag.iconBtn({
                modal: 'stats', id: c.Id, name, running: isRunning,
                title: isRunning ? 'CPU / RAM / Réseau' : 'Conteneur arrêté',
                icon: 'stats', statsId: c.Id,
                extraClass: isRunning ? 'is-stats-ok' : 'is-stats-off',
              })}
              ${bag.iconBtn({ modal: 'logs', id: c.Id, name, running: isRunning, title: 'Logs', icon: 'logs' })}
              ${bag.iconBtn({ modal: 'console', id: c.Id, name, running: isRunning, title: 'Console', icon: 'console' })}
              ${bag.iconBtn({ modal: 'inspect', id: c.Id, name, running: isRunning, title: 'Inspecter', icon: 'inspect' })}
              ${bag.iconBtn({ title: 'Partager', icon: 'users', info: true, shareType: 'container', shareKey: name || c.Id })}
              ${bag.iconBtn({ act: 'remove', id: c.Id, title: 'Supprimer', icon: 'remove', danger: true })}
            </div></td>
          </tr>`;
        }).join('');
        const nid = Number(stack.EndpointId) || bag.Api.getEndpointId();
        if (Number.isFinite(nid) && nid > 0) bag.Api.setEndpointId(nid);
        tb.querySelectorAll('[data-switch-node]').forEach((a) => {
          a.addEventListener('click', () => {
            const n = parseInt(a.getAttribute('data-switch-node'), 10);
            if (Number.isFinite(n) && n > 0) bag.Api.setEndpointId(n);
          });
        });
        bag.bindModalActions(tb);
        bag.bindShareButtons(tb);
        tb.querySelectorAll('[data-act]').forEach((btn) => {
          const act = btn.dataset.act;
          bag.onBusyClick(btn, async (el) => {
            const n = Number(stack.EndpointId) || bag.Api.getEndpointId();
            if (Number.isFinite(n) && n > 0) bag.Api.setEndpointId(n);
            await bag.containerAction(el.dataset.id, act);
            await renderStackContainers();
          }, {
            confirm: act === 'remove' ? 'Supprimer ce conteneur ?' : null,
            minMs: 300,
          });
        });
      } catch (err) {
        tb.innerHTML = `<tr><td colspan="6" class="error-box">${bag.esc(err.message || 'Impossible de lister les conteneurs')}</td></tr>`;
      }
    };
    void renderStackContainers();

    try {
      const upd = await bag.Api.stackUpdate(id);
      const sum = document.getElementById('stack-upd-summary');
      if (sum) {
        sum.innerHTML = bag.stackUpdatePill(
          upd.Status,
          upd.UpdateCount || 0,
          `${upd.Checked || 0} image(s) contrôlée(s)`,
          { action: 'stack', id },
        );
      }
      const tb = document.querySelector('#stack-upd-table tbody');
      const imgs = upd.Images || [];
      if (tb) {
        if (!imgs.length) {
          tb.innerHTML = `<tr><td colspan="4" class="muted">Aucune image à contrôler</td></tr>`;
        } else {
          tb.innerHTML = imgs.map((i) => `<tr>
            <td class="mono">${bag.esc(i.Service)}</td>
            <td class="mono">${bag.esc(i.Image)}</td>
            <td>${bag.stackUpdatePill(i.Status, i.Status === 'update' ? 1 : 0, i.Detail || '', {
              action: i.Status === 'update' ? 'stack' : null,
              id,
            })}</td>
            <td class="muted">${bag.esc(i.Detail || '')}</td>
          </tr>`).join('');
        }
      }
      bag.bindImageUpdateActions(bag.root);
    } catch (err) {
      const sum = document.getElementById('stack-upd-summary');
      if (sum) sum.innerHTML = bag.stackUpdatePill('unknown', 0, err.message || 'Erreur');
      const tb = document.querySelector('#stack-upd-table tbody');
      if (tb) tb.innerHTML = `<tr><td colspan="4" class="error-box">${bag.esc(err.message || 'Contrôle impossible')}</td></tr>`;
    }
  }

}
