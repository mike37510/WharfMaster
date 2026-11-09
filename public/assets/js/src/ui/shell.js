import { bag } from '../bag.js';

export function install() {
  bag.pageHeader = function pageHeader(_title, withRefresh = true) {
    if (!withRefresh) return '';
    return `<div class="page-header page-header-tools">
      <button class="refresh" id="refresh" title="Actualiser">↻</button>
    </div>`;
  }

  bag.isSettingsSection = function isSettingsSection(route) {
    const r = String(route ?? bag.state.route ?? '');
    return r === 'settings' || r.startsWith('settings/')
      || r === 'users' || r.startsWith('users/')
      || r === 'teams' || r.startsWith('teams/')
      || r === 'nodes' || r.startsWith('nodes/')
      || r === 'registries' || r.startsWith('registries/');
  }

  /** Sub-nav shared by Paramètres + Authentification / Registres / Nœuds / Users / Équipes. */

  bag.settingsSubnav = function settingsSubnav(active) {
    const isAdmin = Number(bag.state.user?.Role) === 1;
    const tabs = [
      ['settings', 'Général', true, '#settings'],
      ['settings/auth', 'Authentification', isAdmin, '#settings/auth'],
      ['registries', 'Registres', true, '#registries'],
      ['nodes', 'Nœuds', isAdmin, '#nodes'],
      ['users', 'Utilisateurs', isAdmin, '#users'],
      ['teams', 'Équipes', isAdmin, '#teams'],
      ['settings/diagnostics', 'Diagnostics', isAdmin, '#settings/diagnostics'],
    ].filter((row) => row[2]);
    return `<nav class="settings-subnav" aria-label="Sections paramètres">
      ${tabs.map(([id, label, , href]) =>
        `<a href="${href}" class="settings-subnav-link${active === id ? ' active' : ''}"><span class="nav-ico">${bag.ico(id === 'settings/auth' ? 'users' : (id === 'settings/diagnostics' ? 'inspect' : id.split('/')[0]))}</span>${bag.esc(label)}</a>`
      ).join('')}
    </nav>`;
  }

  bag.shell = function shell(title, bodyHtml, opts = {}) {
    const subtitle = opts.subtitle || '';
    const hidePageHeader = !!opts.hidePageHeader;
    const items = [
      ['dashboard', 'Tableau de bord'],
      ['containers', 'Conteneurs'],
      ['images', 'Images'],
      ['volumes', 'Volumes'],
      ['networks', 'Réseaux'],
      ['stacks', 'Stacks'],
      ['activity', 'Journaux'],
      ['settings', 'Paramètres'],
    ];
    const nav = items.map(([id, label]) => {
      const active = id === 'settings'
        ? bag.isSettingsSection(bag.state.route)
        : (bag.state.route === id || bag.state.route.startsWith(id + '/'));
      return `<a href="#${id}" class="${active ? 'active' : ''}" title="${bag.esc(label)}" aria-label="${bag.esc(label)}"><span class="nav-ico">${bag.ico(id)}</span><span class="nav-label">${label}</span></a>`;
    }).join('');
    const initial = (bag.state.user?.Username || 'A').slice(0, 2).toUpperCase();
    const username = bag.state.user?.Username || 'admin';
    const engine = bag.state.engineVersion ? `Docker Engine v${bag.state.engineVersion}` : 'Docker Engine';
    const allMode = Number(bag.state.endpointId) === 0;
    const currentEp = allMode
      ? null
      : ((bag.state.endpoints || []).find((e) => Number(e.Id) === Number(bag.state.endpointId))
        || { Id: bag.state.endpointId, Name: 'local', Kind: 'local', Status: 1 });
    const nodeLabel = allMode
      ? `${(bag.state.endpoints || []).length} nœuds`
      : (currentEp.NodeName || currentEp.Name || 'local');
    const nodeKind = allMode ? 'Cluster' : (currentEp.Kind === 'agent' ? 'Agent' : 'Local');
    const epOnline = allMode
      ? !!bag.state.dockerOnline
      : Number(currentEp?.Status) === 1;
    const epOptions = [
      ...(bag.state.endpoints || []).length > 1
        ? [`<option value="0" ${allMode ? 'selected' : ''}>Tous les nœuds</option>`]
        : [],
      ...(bag.state.endpoints || []).map((e) =>
        `<option value="${bag.esc(e.Id)}" ${!allMode && Number(e.Id) === Number(bag.state.endpointId) ? 'selected' : ''}>${bag.esc(e.NodeName || e.Name)} (${e.Kind === 'agent' ? 'agent' : 'local'})</option>`
      ),
    ].join('');
    const collapsed = !!bag.state.sidebarCollapsed;
    const toggleTitle = collapsed ? 'Afficher le menu' : 'Réduire le menu';

    return `
      <div class="shell">
        <aside class="sidebar${collapsed ? ' is-collapsed' : ''}">
          <div class="brand brand-full">
            ${bag.brandLogoImg('brand-logo-img brand-logo-wide', '/assets/img/wharfmaster-logo-light-sm.png')}
            <div class="brand-ver">${bag.esc(bag.appVersionLabel() || '…')}</div>
          </div>
          <div class="nav-section">
            <nav class="nav">${nav}</nav>
          </div>
          <div class="sidebar-bottom">
            <nav class="nav">
              <a href="#docs" class="${bag.state.route === 'docs' ? 'active' : ''}" title="Documentation" aria-label="Documentation"><span class="nav-ico">${bag.ico('docs')}</span><span class="nav-label">Documentation</span></a>
              <a href="#about" class="${bag.state.route === 'about' ? 'active' : ''}" title="À propos" aria-label="À propos"><span class="nav-ico">${bag.ico('about')}</span><span class="nav-label">À propos</span></a>
              <a href="#logout" title="Déconnexion" aria-label="Déconnexion"><span class="nav-ico">${bag.ico('logout')}</span><span class="nav-label">Déconnexion</span></a>
            </nav>
            <div class="engine-pill" title="${bag.esc((allMode ? 'Tous les nœuds' : engine) + ' · ' + nodeKind + ' · ' + nodeLabel)}">
              <span class="dot ${epOnline ? '' : 'off'}"></span>
              <div class="engine-pill-text"><strong>${bag.esc(allMode ? 'Tous les nœuds' : engine)}</strong>${bag.esc(nodeKind)} · ${bag.esc(nodeLabel)}</div>
            </div>
          </div>
          <button type="button" class="sidebar-toggle" id="sidebar-toggle" title="${bag.esc(toggleTitle)}" aria-label="${bag.esc(toggleTitle)}" aria-expanded="${collapsed ? 'false' : 'true'}">
            <span class="btn-ico">${bag.ico(collapsed ? 'panel-right' : 'panel-left')}</span>
          </button>
        </aside>
        <div class="main">
          <header class="topbar">
            <div class="topbar-title">
              <h1>${bag.esc(title)}</h1>
              ${subtitle ? `<p class="sub">${bag.esc(subtitle)}</p>` : ''}
            </div>
            <div class="topbar-right">
              ${(bag.state.endpoints || []).length > 1 ? `<label class="node-select-wrap"><span>Nœud</span><select id="endpoint-select">${epOptions}</select></label>` : ''}
              <span class="status-online ${bag.state.dockerOnline ? '' : 'is-offline'}" id="status-online">
                <span class="dot"></span>${bag.state.dockerOnline ? 'En ligne' : 'Hors ligne'}
              </span>
              <button type="button" class="theme-toggle" id="theme-toggle" title="Basculer clair / sombre">${bag.state.theme === 'dark' ? '☀' : '☾'}</button>
              <div class="notif-wrap">
                <button type="button" class="icon-btn notif-btn" id="notif-bell" title="Notifications" aria-label="Notifications" aria-expanded="false">
                  ${bag.ico('bell')}
                  <span class="notif-badge" id="notif-badge" ${bag.visibleAlerts().length ? '' : 'hidden'}>${bag.badgeCount(bag.visibleAlerts().length)}</span>
                </button>
                <div class="notif-panel" id="notif-panel" hidden>
                  <div class="notif-panel-head">
                    <strong>Alertes</strong>
                    <button type="button" class="notif-refresh" id="notif-refresh" title="Actualiser">↻</button>
                  </div>
                  <div class="notif-panel-body" id="notif-list">${bag.renderAlertList()}</div>
                </div>
              </div>
              <div class="user-chip" title="${bag.esc(username)}">
                <span class="avatar">${bag.esc(initial)}</span>
              </div>
            </div>
          </header>
          <div class="content">${hidePageHeader ? bodyHtml : bodyHtml}</div>
        </div>
      </div>`;
  }

  bag.pageLoadingHtml = function pageLoadingHtml(label = 'Chargement…') {
    return `<div class="page-loading" role="status" aria-live="polite">
      <span class="spinner spinner-lg" aria-hidden="true"></span>
      <span class="page-loading-label">${bag.esc(label)}</span>
    </div>`;
  }

  bag.searchBar = function searchBar(key, placeholder, shown, total, createHtml = '') {
    return `
      <div class="toolbar">
        <input class="search" id="filter" type="search" placeholder="${bag.esc(placeholder)}" value="${bag.esc(bag.state.filters[key] || '')}">
        ${createHtml}
        <div class="spacer"></div>
        <span class="muted mono" id="filter-count">${shown} / ${total}</span>
      </div>`;
  }

  bag.createBtn = function createBtn(elId, label, title = label) {
    return `<button type="button" class="btn btn-info btn-create" id="${bag.esc(elId)}" title="${bag.esc(title)}">
      <span class="btn-ico">${bag.ico('plus')}</span><span>${bag.esc(label)}</span>
    </button>`;
  }

  bag.bulkSelectTh = function bulkSelectTh(enabled) {
    if (!enabled) return '';
    return `<th class="col-check">
      <input type="checkbox" class="bulk-check-all" title="Tout sélectionner (page / filtre)" aria-label="Tout sélectionner">
    </th>`;
  }

  bag.bulkSelectTd = function bulkSelectTd(value, { disabled = false, title = '' } = {}) {
    if (disabled) {
      return `<td class="col-check"><input type="checkbox" disabled title="${bag.esc(title || 'Non sélectionnable')}" aria-label="Non sélectionnable"></td>`;
    }
    return `<td class="col-check"><input type="checkbox" class="bulk-check" value="${bag.esc(String(value))}" aria-label="Sélectionner"></td>`;
  }

  bag.bulkDeleteBtnHtml = function bulkDeleteBtnHtml() {
    return `<button type="button" class="btn btn-danger btn-sm bulk-delete-btn" id="bulk-delete" hidden disabled>
      <span class="btn-ico">${bag.ico('remove')}</span>
      <span>Supprimer (<span class="bulk-count">0</span>)</span>
    </button>`;
  }

  /**
   * Multi-select + mass delete for list tables.
   * @param {{
   *   enabled: boolean,
   *   confirmOne?: (id: string) => string,
   *   confirmMany?: (n: number) => string,
   *   deleteOne: (id: string) => Promise<void>,
   *   reload: () => (void|Promise<void>),
   * }} opts
   */

  bag.bindBulkDelete = function bindBulkDelete(opts) {
    if (!opts?.enabled) return;
    const table = bag.root.querySelector('table.data');
    const btn = document.getElementById('bulk-delete');
    const checkAll = bag.root.querySelector('.bulk-check-all');
    if (!table || !btn) return;

    const visibleChecks = () => [...table.querySelectorAll('tbody tr[data-search]')]
      .filter((tr) => tr.style.display !== 'none')
      .map((tr) => tr.querySelector('input.bulk-check'))
      .filter((c) => c && !c.disabled);

    const selected = () => [...table.querySelectorAll('input.bulk-check:checked:not(:disabled)')]
      .map((c) => c.value)
      .filter(Boolean);

    const sync = () => {
      const ids = selected();
      const n = ids.length;
      const countEl = btn.querySelector('.bulk-count');
      if (countEl) countEl.textContent = String(n);
      btn.hidden = n === 0;
      btn.disabled = n === 0;
      const vis = visibleChecks();
      if (checkAll) {
        const allOn = vis.length > 0 && vis.every((c) => c.checked);
        const someOn = vis.some((c) => c.checked);
        checkAll.checked = allOn;
        checkAll.indeterminate = someOn && !allOn;
      }
    };

    table.addEventListener('change', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLInputElement)) return;
      if (t.classList.contains('bulk-check-all')) {
        const on = t.checked;
        visibleChecks().forEach((c) => { c.checked = on; });
      }
      if (t.classList.contains('bulk-check') || t.classList.contains('bulk-check-all')) sync();
    });

    document.getElementById('filter')?.addEventListener('input', () => setTimeout(sync, 120));
    bag.root.querySelector('.table-pager')?.addEventListener('click', () => setTimeout(sync, 60));

    bag.onBusyClick(btn, async () => {
      const ids = selected();
      if (!ids.length) return;
      const msg = ids.length === 1
        ? (opts.confirmOne ? opts.confirmOne(ids[0]) : 'Supprimer cet élément ?')
        : (opts.confirmMany ? opts.confirmMany(ids.length) : `Supprimer ${ids.length} éléments ?`);
      if (!window.confirm(msg)) return;
      const errors = [];
      for (const id of ids) {
        try {
          await opts.deleteOne(id);
        } catch (err) {
          errors.push(`${id}: ${err.message || err}`);
        }
      }
      if (errors.length) {
        window.alert(
          `Certaines suppressions ont échoué :\n${errors.slice(0, 10).join('\n')}${errors.length > 10 ? '\n…' : ''}`,
        );
      }
      await opts.reload();
    }, { disableSiblings: false, minMs: 300 });

    sync();
  }

  bag.ensureTablePager = function ensureTablePager() {
    let el = document.getElementById('table-pager');
    if (el) return el;
    const wrap = bag.root.querySelector('.table-wrap');
    if (!wrap) return null;
    el = document.createElement('div');
    el.id = 'table-pager';
    el.className = 'table-pager';
    el.hidden = true;
    wrap.insertAdjacentElement('afterend', el);
    return el;
  }

  bag.renderTablePager = function renderTablePager(pager, { page, pageCount, matched, pageSize }) {
    if (!pager) return;
    if (matched <= pageSize) {
      pager.hidden = true;
      pager.innerHTML = '';
      return;
    }
    pager.hidden = false;
    const prevDisabled = page <= 1 ? ' disabled' : '';
    const nextDisabled = page >= pageCount ? ' disabled' : '';
    // Compact page buttons: window around current
    const buttons = [];
    const windowSize = 5;
    let start = Math.max(1, page - Math.floor(windowSize / 2));
    let end = Math.min(pageCount, start + windowSize - 1);
    start = Math.max(1, end - windowSize + 1);
    if (start > 1) {
      buttons.push(`<button type="button" class="btn btn-sm table-pager-num" data-page="1">1</button>`);
      if (start > 2) buttons.push(`<span class="table-pager-ellipsis">…</span>`);
    }
    for (let p = start; p <= end; p++) {
      buttons.push(
        `<button type="button" class="btn btn-sm table-pager-num${p === page ? ' is-active' : ''}" data-page="${p}">${p}</button>`
      );
    }
    if (end < pageCount) {
      if (end < pageCount - 1) buttons.push(`<span class="table-pager-ellipsis">…</span>`);
      buttons.push(`<button type="button" class="btn btn-sm table-pager-num" data-page="${pageCount}">${pageCount}</button>`);
    }
    pager.innerHTML = `
      <button type="button" class="btn btn-sm" data-page-nav="prev"${prevDisabled} title="Page précédente" aria-label="Page précédente">←</button>
      <div class="table-pager-pages">${buttons.join('')}</div>
      <button type="button" class="btn btn-sm" data-page-nav="next"${nextDisabled} title="Page suivante" aria-label="Page suivante">→</button>
      <span class="muted table-pager-meta">${bag.esc(String(pageSize))} / page</span>`;
  }

  /**
   * Filter table rows by search; optional client-side pagination.
   * @param {string} key
   * @param {{ pageSize?: number }} [opts]  pageSize>0 enables pagination (default bag.state.pageSize when true via bag.bindPagedSearch)
   */

  bag.bindSearch = function bindSearch(key, opts = {}) {
    const input = document.getElementById('filter');
    const table = bag.root.querySelector('table.data tbody');
    if (!input || !table) return;
    const pageSize = Number(opts.pageSize) > 0 ? Number(opts.pageSize) : 0;
    const pager = pageSize > 0 ? bag.ensureTablePager() : null;
    const allRows = () => [...table.querySelectorAll('tr[data-search]')];
    const allTotal = allRows().length;

    const run = ({ resetPage = false } = {}) => {
      const q = input.value.trim().toLowerCase();
      bag.state.filters[key] = input.value;
      if (resetPage && pageSize > 0) bag.state.pages[key] = 1;

      const rows = allRows();
      const matched = [];
      rows.forEach((tr) => {
        const ok = !q || (tr.getAttribute('data-search') || '').includes(q);
        if (ok) matched.push(tr);
        else tr.style.display = 'none';
      });

      let page = 1;
      let pageCount = 1;
      let visible = matched;
      if (pageSize > 0) {
        pageCount = Math.max(1, Math.ceil(matched.length / pageSize) || 1);
        page = Math.min(Math.max(1, Number(bag.state.pages[key]) || 1), pageCount);
        bag.state.pages[key] = page;
        const start = (page - 1) * pageSize;
        const end = start + pageSize;
        matched.forEach((tr, i) => {
          tr.style.display = (i >= start && i < end) ? '' : 'none';
        });
        visible = matched.slice(start, end);
        const from = matched.length === 0 ? 0 : start + 1;
        const to = Math.min(end, matched.length);
        bag.updateFilterCount(matched.length === 0 ? '0' : `${from}–${to}`, matched.length, allTotal);
        bag.renderTablePager(pager, { page, pageCount, matched: matched.length, pageSize });
      } else {
        matched.forEach((tr) => { tr.style.display = ''; });
        bag.updateFilterCount(matched.length, allTotal);
      }

      const empty = table.querySelector('tr.filter-empty');
      if (empty) empty.remove();
      if (matched.length === 0 && rows.length > 0) {
        const cols = table.parentElement?.querySelectorAll('thead th').length || 4;
        const tr = document.createElement('tr');
        tr.className = 'filter-empty';
        tr.innerHTML = `<td colspan="${cols}" class="empty">Aucun résultat pour “${bag.esc(input.value)}”</td>`;
        table.appendChild(tr);
      }
      void visible;
    };

    let timer = null;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => run({ resetPage: true }), 80);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        input.value = '';
        run({ resetPage: true });
      }
    });

    if (pager) {
      pager.onclick = (e) => {
        const nav = e.target.closest('[data-page-nav]');
        const num = e.target.closest('[data-page]');
        if (!nav && !num) return;
        e.preventDefault();
        const cur = Number(bag.state.pages[key]) || 1;
        if (nav) {
          const dir = nav.getAttribute('data-page-nav');
          bag.state.pages[key] = dir === 'prev' ? cur - 1 : cur + 1;
        } else if (num) {
          bag.state.pages[key] = parseInt(num.getAttribute('data-page'), 10) || 1;
        }
        run();
      };
    }

    run({ resetPage: false });
  }

  bag.bindPagedSearch = function bindPagedSearch(key) {
    bag.bindSearch(key, { pageSize: bag.state.pageSize || 20 });
  }

  bag.getSort = function getSort(view) {
    return bag.state.sorts[view] || { key: 'name', dir: 'asc' };
  }

  bag.cmpSortValues = function cmpSortValues(a, b, dir) {
    const mul = dir === 'desc' ? -1 : 1;
    if (typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b)) {
      return (a - b) * mul;
    }
    return String(a ?? '').localeCompare(String(b ?? ''), 'fr', {
      sensitivity: 'base',
      numeric: true,
    }) * mul;
  }

  /** @param {list} list @param {string} view @param {Record<string, function>} getters */

  bag.sortItems = function sortItems(list, view, getters) {
    const { key, dir } = bag.getSort(view);
    const get = getters[key] || getters.name;
    if (typeof get !== 'function') return [...list];
    return [...list].sort((a, b) => bag.cmpSortValues(get(a), get(b), dir));
  }

  bag.sortTh = function sortTh(label, key, view, opts = {}) {
    const cur = bag.getSort(view);
    const active = cur.key === key;
    const arrow = active ? (cur.dir === 'asc' ? ' ▲' : ' ▼') : '';
    const tip = opts.title || `Trier par ${label}`;
    return `<th class="sortable${active ? ' is-sorted' : ''}" data-sort-key="${bag.esc(key)}" data-sort-view="${bag.esc(view)}" title="${bag.esc(tip)}" role="columnheader" tabindex="0">${bag.esc(label)}<span class="sort-ind" aria-hidden="true">${arrow}</span></th>`;
  }

  bag.bindTableSort = function bindTableSort(view, reloadFn) {
    bag.root.querySelectorAll(`th.sortable[data-sort-view="${CSS.escape(view)}"]`).forEach((th) => {
      const activate = () => {
        const key = th.getAttribute('data-sort-key') || 'name';
        const cur = bag.getSort(view);
        bag.state.sorts[view] = {
          key,
          dir: cur.key === key && cur.dir === 'asc' ? 'desc' : 'asc',
        };
        if (typeof reloadFn === 'function') reloadFn();
      };
      th.addEventListener('click', activate);
      th.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate();
        }
      });
    });
  }

  bag.updateFilterCount = function updateFilterCount(shown, total, allTotal) {
    const el = document.getElementById('filter-count');
    if (!el) return;
    if (allTotal != null && allTotal !== total) {
      el.textContent = `${shown} / ${total} (${allTotal})`;
    } else {
      el.textContent = `${shown} / ${total}`;
    }
  }

  bag.matchQuery = function matchQuery(q, ...parts) {
    if (!q) return true;
    const hay = parts.map((p) => String(p ?? '').toLowerCase()).join(' ');
    return hay.includes(q);
  }

  bag.iconBtn = function iconBtn({
    tag = 'button', href, act, id, title, icon,
    danger = false, info = false, success = false,
    modal, name, running, del, reset, elId, label,
    editTeam, delTeam, delAcl, scanImg, runSched, delSched,
    statsId, extraClass = '',
  }) {
    const withLabel = !!(label && String(label).trim());
    const cls = `btn btn-icon btn-sm${withLabel ? ' btn-icon-label' : ''}${danger ? ' btn-danger' : ''}${info ? ' btn-info' : ''}${success ? ' btn-success' : ''}${extraClass ? ` ${extraClass}` : ''}`;
    const attrs = [
      `class="${cls}"`,
      `title="${bag.esc(title)}"`,
      `aria-label="${bag.esc(title)}"`,
      elId ? `id="${bag.esc(elId)}"` : '',
      act ? `data-act="${bag.esc(act)}"` : '',
      id ? `data-id="${bag.esc(id)}"` : '',
      href ? `href="${href}"` : '',
      modal ? `data-modal="${bag.esc(modal)}"` : '',
      name ? `data-name="${bag.esc(name)}"` : '',
      running != null ? `data-running="${running ? '1' : '0'}"` : '',
      del != null ? `data-del="${bag.esc(del)}"` : '',
      reset != null ? `data-reset="${bag.esc(reset)}"` : '',
      editTeam != null ? `data-edit-team="${bag.esc(editTeam)}"` : '',
      delTeam != null ? `data-del-team="${bag.esc(delTeam)}"` : '',
      delAcl != null ? `data-del-acl="${bag.esc(delAcl)}"` : '',
      scanImg != null ? `data-scan-img="${bag.esc(scanImg)}"` : '',
      runSched != null ? `data-run-sched="${bag.esc(runSched)}"` : '',
      delSched != null ? `data-del-sched="${bag.esc(delSched)}"` : '',
      statsId != null ? `data-stats-id="${bag.esc(statsId)}"` : '',
      tag === 'button' ? 'type="button"' : '',
    ].filter(Boolean).join(' ');
    const labelHtml = withLabel ? `<span class="btn-label">${bag.esc(label)}</span>` : '';
    return `<${tag} ${attrs}><span class="btn-ico">${bag.ico(icon)}</span>${labelHtml}</${tag}>`;
  }

  bag.ico = function ico(name) {
    const icons = {
      dashboard: '<svg viewBox="0 0 16 16"><path d="M1 1h6v6H1V1zm8 0h6v6H9V1zM1 9h6v6H1V9zm8 0h6v6H9V9z"/></svg>',
      stacks: '<svg viewBox="0 0 16 16"><path d="M0 4l8-3 8 3-8 3L0 4zm0 4l8 3 8-3v2l-8 3-8-3V8zm0 4l8 3 8-3v2l-8 3-8-3v-2z"/></svg>',
      containers: '<svg viewBox="0 0 16 16"><path d="M1 3h14v2H1V3zm0 4h14v2H1V7zm0 4h14v2H1v-2z"/></svg>',
      images: '<svg viewBox="0 0 16 16"><path d="M1 2h14v12H1V2zm2 2v8h10V4H3zm2 2h2v2H5V6zm4 0h3v1H9V6zm0 2h3v1H9V8z"/></svg>',
      networks: '<svg viewBox="0 0 16 16"><path d="M8 1a3 3 0 110 6 3 3 0 010-6zM2 9a2 2 0 110 4 2 2 0 010-4zm12 0a2 2 0 110 4 2 2 0 010-4zM8 8v2.5M3.5 10.5L6.5 8.5m6 2L9.5 8.5"/></svg>',
      volumes: '<svg viewBox="0 0 16 16"><path d="M3 2h10v12H3V2zm2 2v8h6V4H5z"/></svg>',
      settings: '<svg viewBox="0 0 16 16"><path d="M6.5 1h3l.4 2.1a5 5 0 011.4.8L13.5 3l1.5 2.6-1.7 1.2a5 5 0 010 1.6l1.7 1.2L13.5 13l-2.2-.9a5 5 0 01-1.4.8L9.5 15h-3l-.4-2.1a5 5 0 01-1.4-.8L2.5 13 1 10.4l1.7-1.2a5 5 0 010-1.6L1 6.4 2.5 3.8l2.2.9a5 5 0 011.4-.8L6.5 1zM8 6a2 2 0 100 4 2 2 0 000-4z"/></svg>',
      users: '<svg viewBox="0 0 16 16"><path d="M8 8a3 3 0 100-6 3 3 0 000 6zm-5 6v-1a4 4 0 014-4h2a4 4 0 014 4v1H3zm10-7a2 2 0 100-4 2 2 0 000 4zm1 7v-1a4.9 4.9 0 00-1.5-3.5A4 4 0 0115 13v1h-1z"/></svg>',
      teams: '<svg viewBox="0 0 16 16"><path d="M8 8a3 3 0 100-6 3 3 0 000 6zm-5 6v-1a4 4 0 014-4h2a4 4 0 014 4v1H3zm10-7a2 2 0 100-4 2 2 0 000 4zm1 7v-1a4.9 4.9 0 00-1.5-3.5A4 4 0 0115 13v1h-1z"/><path d="M1 5.5A1.5 1.5 0 012.5 4h1a.5.5 0 010 1h-1a.5.5 0 00-.5.5v1a.5.5 0 01-1 0v-1z"/></svg>',
      registries: '<svg viewBox="0 0 16 16"><path d="M2 2h12v3H2V2zm0 4.5h12V10H2V6.5zM2 11h12v3H2v-3z"/></svg>',
      about: '<svg viewBox="0 0 16 16"><path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM7.25 5h1.5v1.5h-1.5V5zM7.25 7.5h1.5V11h-1.5V7.5z"/></svg>',
      docs: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2.5h6.5L13 5v8.5H4V2.5z"/><path d="M10.5 2.5V5H13"/><path d="M6 8h4M6 10.5h4M6 13h2.5"/></svg>',
      logout: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2.5H3.5A1.5 1.5 0 002 4v8a1.5 1.5 0 001.5 1.5H6M10.5 11.5L14 8l-3.5-3.5M14 8H6"/></svg>',
      bell: '<svg viewBox="0 0 16 16"><path d="M8 1.75a3.5 3.5 0 00-3.5 3.5v2.1L3.2 9.6A.75.75 0 003.75 11h8.5a.75.75 0 00.55-1.25L11.5 7.35V5.25A3.5 3.5 0 008 1.75zM6.6 12.5a1.4 1.4 0 002.8 0"/></svg>',
      pull: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8M5 7.5L8 10l3-2.5M3 12.5h10"/></svg>',
      clean: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5c1.8-3.2 4.2-5 8-6.5l.8.8c-1.8 3.5-3.5 6-7.2 7.7L4 12.5zM12 4.5l1.8-1.8"/></svg>',
      plus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>',
      edit: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 3.5l3 3L5 14H2v-3L9.5 3.5zM8 5l3 3"/></svg>',
      copy: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.2"/><path d="M10.5 5.5V3.8A1.3 1.3 0 009.2 2.5H3.8A1.3 1.3 0 002.5 3.8v5.4A1.3 1.3 0 003.8 10.5H5.5"/></svg>',
      key: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="5.5" cy="10.5" r="2.5"/><path d="M7.3 8.7L13 3v2.2h2V7H13.2"/></svg>',
      back: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5L5.5 8 10 12.5"/></svg>',
      save: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 3.5h7.2L12.5 5.3V12.5h-9V3.5zM5.5 3.5V6h5V3.5M5.5 9.5h5"/></svg>',
      logs: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3.5 2.5h9v11h-9z"/><path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3"/></svg>',
      activity: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3.5h10v9H3z"/><path d="M5.5 6.5h5M5.5 9h3.5M5.5 11.5h2"/><path d="M11.5 2.5v2"/></svg>',
      stats: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12.5V8.5M6.5 12.5V3.5M10.5 12.5v-5M13.5 12.5v-2.5"/><path d="M2 13.5h12"/></svg>',
      nodes: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/></svg>',
      'panel-left': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="1.75" y="2.25" width="12.5" height="11.5" rx="2"/><path d="M5.75 2.25v11.5"/><path d="M10.25 6.25 8.5 8l1.75 1.75"/></svg>',
      'panel-right': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="1.75" y="2.25" width="12.5" height="11.5" rx="2"/><path d="M5.75 2.25v11.5"/><path d="M8.5 6.25 10.25 8 8.5 9.75"/></svg>',
      console: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 7l2 1.5L5 10M8.5 10h2.5"/></svg>',
      start: '<svg viewBox="0 0 16 16"><path d="M4.5 2.8v10.4L13 8 4.5 2.8z"/></svg>',
      stop: '<svg viewBox="0 0 16 16"><rect x="3.5" y="3.5" width="9" height="9" rx="1.2"/></svg>',
      restart: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M13 8a5 5 0 11-1.3-3.4"/><path d="M13 2.5V6h-3.5" fill="none"/></svg>',
      remove: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3.5 4.5h9M6 4.5V3.2h4v1.3M5.5 4.5l.5 8h4l.5-8M7 7v4M9 7v4"/></svg>',
      inspect: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3.5h6v9H5z"/><path d="M7 6h2M7 8.5h2M7 11h1.5"/><circle cx="11.5" cy="11.5" r="2"/><path d="M13 13l1.5 1.5"/></svg>',
      search: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>',
      folder: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 3.5h4l1.2 1.5H14V13H2V3.5z"/></svg>',
      file: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 2.5h5.5L12 5v8.5H4V2.5z"/><path d="M9.5 2.5V5H12"/></svg>',
      link: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M6.5 9.5l3-3M7 11.5H5.2A2.2 2.2 0 015.2 7H7m2 1.5h1.8a2.2 2.2 0 010 4.4H9"/></svg>',
    };
    return icons[name] || icons.dashboard;
  }

  bag.badge = function badge(stateName) {
    const s = String(stateName || '').toLowerCase();
    let cls = 'badge';
    let label = stateName || 'inconnu';
    if (s.includes('running')) { cls += ' badge-running'; label = 'En cours'; }
    else if (s.includes('exit') || s.includes('dead')) { cls += ' badge-exited'; label = 'Arrêté'; }
    else if (s.includes('pause')) { cls += ' badge-paused'; label = 'En pause'; }
    else if (s.includes('creat')) { cls += ' badge-created'; label = 'Créé'; }
    else cls += ' badge-created';
    return `<span class="${cls}">${bag.esc(label)}</span>`;
  }

  bag.brandMarkImg = function brandMarkImg(cls = 'brand-mark-img') {
    return `<img class="${cls}" src="/assets/img/wharfmaster-mark.png" width="40" height="40" alt="" decoding="async">`;
  }

  bag.brandLogoImg = function brandLogoImg(cls = 'brand-logo-img', src = '/assets/img/wharfmaster-logo-light.png') {
    return `<img class="${cls}" src="${src}" alt="WharfMaster" decoding="async">`;
  }

  /** Build a sparkline SVG from real numeric samples (oldest → newest). */

  bag.sparklineFromValues = function sparklineFromValues(values, tone = 'blue') {
    const pts = (values || []).map((v) => Number(v) || 0);
    const w = 100;
    const h = 28;
    const padY = 3;
    let line;
    let fill;
    if (pts.length === 0) {
      line = `M0 ${h / 2} L${w} ${h / 2}`;
      fill = `M0 ${h} L0 ${h / 2} L${w} ${h / 2} L${w} ${h} Z`;
    } else if (pts.length === 1) {
      const y = h / 2;
      line = `M0 ${y} L${w} ${y}`;
      fill = `M0 ${h} L0 ${y} L${w} ${y} L${w} ${h} Z`;
    } else {
      const min = Math.min(...pts);
      const max = Math.max(...pts);
      const span = Math.max(1, max - min);
      const coords = pts.map((v, i) => {
        const x = (i / (pts.length - 1)) * w;
        const y = padY + (1 - (v - min) / span) * (h - padY * 2);
        return [x, y];
      });
      line = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c[0].toFixed(2)} ${c[1].toFixed(2)}`).join(' ');
      const last = coords[coords.length - 1];
      const first = coords[0];
      fill = `${line} L${last[0].toFixed(2)} ${h} L${first[0].toFixed(2)} ${h} Z`;
    }
    const n = pts.length;
    const title = n < 2
      ? 'Historique en construction — revenez plus tard'
      : `${n} relevés`;
    return `<svg class="sparkline ${tone}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${bag.esc(title)}"><title>${bag.esc(title)}</title><path class="fill" d="${fill}" fill="currentColor"/><path d="${line}"/></svg>`;
  }

  bag.sparkline = function sparkline(tone = 'blue') {
    return bag.sparklineFromValues([], tone);
  }

  bag.dashStatCard = function dashStatCard(key, tone, label, value, series) {
    return `<div class="stat-card" data-metric="${bag.esc(key)}">
      <div class="stat-top">
        <div class="stat-ico ${tone}">${bag.ico(key === 'networks' ? 'networks' : key)}</div>
        ${bag.metricDeltaHtml(series, key)}
      </div>
      <div class="stat-value">${Number(value) || 0}</div>
      <div class="stat-label">${bag.esc(label)}</div>
      ${bag.sparklineFromValues(bag.metricValues(series, key), tone)}
      <div class="stat-hint" title="Fenêtre configurable dans Paramètres">Courbe · ${bag.esc(bag.metricWindowLabel())}</div>
    </div>`;
  }

  bag.gaugeRing = function gaugeRing(pct, color = '#3b82f6') {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    const r = 34;
    const c = 2 * Math.PI * r;
    const off = c - (p / 100) * c;
    return `<svg viewBox="0 0 84 84">
      <circle cx="42" cy="42" r="${r}" fill="none" stroke="rgba(148,163,184,.15)" stroke-width="7"/>
      <circle cx="42" cy="42" r="${r}" fill="none" stroke="${color}" stroke-width="7"
        stroke-linecap="round" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"
        transform="rotate(-90 42 42)"/>
      <text x="42" y="46" text-anchor="middle" fill="currentColor" font-size="14" font-weight="700">${p.toFixed(0)}%</text>
    </svg>`;
  }

  bag.usageCell = function usageCell(pct, label, kind = 'cpu') {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    let bar = kind === 'mem' ? 'usage-bar mem' : 'usage-bar';
    if (p >= 85) bar += ' danger';
    else if (p >= 65) bar += ' warn';
    return `<div class="usage-cell"><div class="u-val">${bag.esc(label)}</div><div class="${bar}"><span style="width:${p.toFixed(0)}%"></span></div></div>`;
  }

  bag.pctBar = function pctBar(pct) {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    return `<div class="progress"><span style="width:${p.toFixed(1)}%"></span></div>`;
  }

  bag.makeSpinner = function makeSpinner(extraClass = '') {
    const s = document.createElement('span');
    s.className = 'spinner spinner-abs' + (extraClass ? ' ' + extraClass : '');
    s.setAttribute('aria-hidden', 'true');
    return s;
  }

  /**
   * Show a mini spinner on any action control while an async job runs.
   * Keeps the spinner visible at least ~280ms so fast API calls still flash feedback.
   */

  bag.withBusy = async function withBusy(btn, fn, opts = {}) {
    if (!btn) return fn();
    if (btn.dataset.busy === '1') return;
    const row = opts.row !== undefined
      ? opts.row
      : (btn.closest('tr') || btn.closest('.quick-actions') || btn.closest('.toolbar') || btn.closest('.actions-bar') || null);
    const siblings = opts.disableSiblings === false
      ? []
      : (row ? Array.from(row.querySelectorAll('button, a.btn, .btn, .refresh')) : []);

    btn.dataset.busy = '1';
    btn.classList.add('is-loading');
    if ('disabled' in btn) btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');

    const spinner = bag.makeSpinner(btn.classList.contains('btn-primary') ? 'spinner-dark' : '');
    btn.appendChild(spinner);

    siblings.forEach((el) => {
      if (el === btn) return;
      if ('disabled' in el) el.disabled = true;
      el.classList.add('is-disabled-temp');
    });
    if (row) row.classList.add('row-busy');

    const started = Date.now();
    try {
      return await fn();
    } finally {
      const wait = Math.max(0, (opts.minMs ?? 280) - (Date.now() - started));
      if (wait) await new Promise((r) => setTimeout(r, wait));
      // Element may have been removed by a re-render
      if (btn.isConnected) {
        spinner.remove();
        btn.classList.remove('is-loading');
        if ('disabled' in btn) btn.disabled = false;
        btn.removeAttribute('aria-busy');
        delete btn.dataset.busy;
      }
      siblings.forEach((el) => {
        if (!el.isConnected) return;
        if ('disabled' in el) el.disabled = false;
        el.classList.remove('is-disabled-temp');
      });
      if (row && row.isConnected) row.classList.remove('row-busy');
    }
  }

  /** Bind click → confirm? → bag.withBusy(fn) → optional reload */

  bag.onBusyClick = function onBusyClick(el, handler, opts = {}) {
    if (!el) return;
    el.addEventListener('click', async (e) => {
      e.preventDefault();
      if (opts.confirm && !window.confirm(opts.confirm)) return;
      const target = e.currentTarget;
      try {
        await bag.withBusy(target, () => handler(target, e), opts);
        if (opts.reload) await bag.route();
      } catch (err) {
        alert(err.message || String(err));
      }
    });
  }

  bag.bindRefresh = function bindRefresh() {
    const btn = document.getElementById('refresh');
    if (!btn) return;
    bag.onBusyClick(btn, async () => { await bag.route(); }, { disableSiblings: false, minMs: 200 });
  }

  bag.modalHost = function modalHost() {
    let el = document.getElementById('app-modal');
    if (!el) {
      el = document.createElement('div');
      el.id = 'app-modal';
      document.body.appendChild(el);
    }
    return el;
  }

  bag.closeAppModal = function closeAppModal() {
    if (bag.state.logTimer) {
      clearInterval(bag.state.logTimer);
      bag.state.logTimer = null;
    }
    if (bag.state.statsTimer) {
      clearInterval(bag.state.statsTimer);
      bag.state.statsTimer = null;
    }
    if (bag.state.term) {
      try { bag.state.term.dispose(); } catch (_) {}
      bag.state.term = null;
    }
    const host = document.getElementById('app-modal');
    if (host) host.innerHTML = '';
  }

  bag.bindAppModalChrome = function bindAppModalChrome() {
    const host = bag.modalHost();
    host.querySelectorAll('[data-close-modal]').forEach((el) => {
      el.onclick = (e) => {
        e.preventDefault();
        bag.closeAppModal();
      };
    });
    const backdrop = host.querySelector('.modal-backdrop');
    if (backdrop) {
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) bag.closeAppModal();
      });
    }
    host.querySelectorAll('.modal-workspace').forEach((modal) => bag.enableWorkspaceModalResize(modal));
  }

  const WORKSPACE_MODAL_SIZE_KEY = 'wm_workspace_modal_size';

  bag.readWorkspaceModalSize = function readWorkspaceModalSize() {
    try {
      const raw = localStorage.getItem(bag.WORKSPACE_MODAL_SIZE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const w = Number(parsed?.w);
      const h = Number(parsed?.h);
      if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
      return { w, h };
    } catch (_) {
      return null;
    }
  }

  bag.saveWorkspaceModalSize = function saveWorkspaceModalSize(w, h) {
    try {
      localStorage.setItem(bag.WORKSPACE_MODAL_SIZE_KEY, JSON.stringify({ w: Math.round(w), h: Math.round(h) }));
    } catch (_) {}
  }

  bag.clampWorkspaceModalSize = function clampWorkspaceModalSize(w, h) {
    const maxW = Math.max(320, window.innerWidth - 28);
    const maxH = Math.max(280, window.innerHeight - 24);
    const minW = Math.min(720, maxW);
    const minH = Math.min(420, maxH);
    return {
      w: Math.min(maxW, Math.max(minW, w)),
      h: Math.min(maxH, Math.max(minH, h)),
    };
  }

  bag.applyWorkspaceModalSize = function applyWorkspaceModalSize(modal, w, h) {
    const size = bag.clampWorkspaceModalSize(w, h);
    modal.style.width = `${size.w}px`;
    modal.style.height = `${size.h}px`;
    modal.style.maxWidth = 'calc(100vw - 28px)';
    modal.style.maxHeight = 'calc(100vh - 24px)';
    modal.dispatchEvent(new CustomEvent('wm-modal-resize', { bubbles: true }));
    return size;
  }

  bag.enableWorkspaceModalResize = function enableWorkspaceModalResize(modal) {
    if (!modal || modal.dataset.resizeBound === '1') return;
    modal.dataset.resizeBound = '1';

    const saved = bag.readWorkspaceModalSize();
    if (saved) bag.applyWorkspaceModalSize(modal, saved.w, saved.h);

    let handle = modal.querySelector('.modal-resize-handle');
    if (!handle) {
      handle = document.createElement('div');
      handle.className = 'modal-resize-handle';
      handle.title = 'Redimensionner';
      handle.setAttribute('aria-hidden', 'true');
      modal.appendChild(handle);
    }

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startW = 0;
    let startH = 0;

    const onMove = (e) => {
      if (!dragging) return;
      const next = bag.applyWorkspaceModalSize(
        modal,
        startW + (e.clientX - startX),
        startH + (e.clientY - startY),
      );
      bag.saveWorkspaceModalSize(next.w, next.h);
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      modal.classList.remove('is-resizing');
      document.body.style.cursor = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    handle.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      const rect = modal.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startW = rect.width;
      startH = rect.height;
      modal.classList.add('is-resizing');
      document.body.style.cursor = 'nwse-resize';
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  /** Simple name prompt modal. Resolves string or null if cancelled. */

  bag.promptName = function promptName({ title, label, value = '', confirmLabel = 'OK', placeholder = '' } = {}) {
    return new Promise((resolve) => {
      bag.closeAppModal();
      const host = bag.modalHost();
      host.innerHTML = `
        <div class="modal-backdrop">
          <div class="modal modal-form" role="dialog" aria-modal="true">
            <div class="modal-head">
              <div><h3>${bag.esc(title || 'Saisie')}</h3></div>
              <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">✕</button>
            </div>
            <form id="prompt-name-form">
              <div class="form-group">
                <label>${bag.esc(label || 'Nom')}</label>
                <input id="prompt-name-input" type="text" required maxlength="255" value="${bag.esc(value)}" placeholder="${bag.esc(placeholder)}" autocomplete="off">
              </div>
              <div class="actions-bar">
                <button type="submit" class="btn btn-primary">${bag.esc(confirmLabel)}</button>
                <button type="button" class="btn" data-close-modal>Annuler</button>
              </div>
            </form>
          </div>
        </div>`;
      bag.bindAppModalChrome();
      const input = document.getElementById('prompt-name-input');
      const form = document.getElementById('prompt-name-form');
      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        bag.closeAppModal();
        resolve(val);
      };
      host.querySelectorAll('[data-close-modal]').forEach((el) => {
        el.addEventListener('click', () => finish(null));
      });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const v = (input.value || '').trim();
        if (!v) return;
        finish(v);
      });
      input.focus();
      input.select();
    });
  }

  bag.bindModalActions = function bindModalActions(scope = bag.root) {
    scope.querySelectorAll('[data-modal]').forEach((btn) => {
      btn.onclick = async (e) => {
        e.preventDefault();
        const id = btn.dataset.id;
        const name = btn.dataset.name || bag.shortId(id);
        const running = btn.dataset.running === '1';
        if (btn.dataset.modal === 'logs') await bag.openLogsModal(id, name);
        else if (btn.dataset.modal === 'console') await bag.openConsoleModal(id, name, running);
        else if (btn.dataset.modal === 'inspect') await bag.openInspectModal(id, name);
        else if (btn.dataset.modal === 'stats') await bag.openContainerStatsModal(id, name, running);
      };
    });
  }

  bag.authView = function authView(mode, err) {
    const isInit = mode === 'init';
    return `
      <div class="auth-wrap">
        <form class="auth-card" id="auth-form">
          <div class="logo logo-full">${bag.brandLogoImg('auth-logo-img')}</div>
          <div class="sub">${isInit ? 'Veuillez créer le compte administrateur initial.' : 'Connectez-vous à votre instance WharfMaster.'}</div>
          ${err ? `<div class="error-box">${bag.esc(err)}</div>` : ''}
          <div class="form-group"><label>Nom d'utilisateur</label>
          <input name="username" autocomplete="username" required value="admin"></div>
          <div class="form-group"><label>Mot de passe</label>
          <input name="password" type="password" autocomplete="${isInit ? 'new-password' : 'current-password'}" required minlength="10"></div>
          ${isInit ? `<div class="form-group"><label>Confirmer le mot de passe</label><input name="confirm" type="password" required minlength="10"></div>` : ''}
          <button class="btn btn-primary btn-block" type="submit" style="margin-top:8px">${isInit ? "Créer l'utilisateur" : 'Connexion'}</button>
          <p class="muted" style="margin:14px 0 0;text-align:center;font-size:.9rem"><a href="/">À propos du projet</a></p>
        </form>
      </div>`;
  }

  bag.renderAuth = async function renderAuth() {
    let needInit = false;
    try {
      const check = await bag.Api.adminCheck();
      needInit = !!check.adminInit;
    } catch { needInit = false; }
    bag.root.innerHTML = bag.authView(needInit ? 'init' : 'login', bag.state.error);
    document.getElementById('auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const submitBtn = form.querySelector('button[type="submit"]');
      const fd = new FormData(form);
      const username = String(fd.get('username') || '');
      const password = String(fd.get('password') || '');
      try {
        await bag.withBusy(submitBtn, async () => {
          if (needInit) {
            if (password !== String(fd.get('confirm') || '')) throw new Error('Les mots de passe ne correspondent pas');
            await bag.Api.adminInit(username, password);
          }
          const res = await bag.Api.auth(username, password);
          bag.Api.setToken(res.jwt);
        }, { disableSiblings: false });
        bag.state.error = '';
        await bag.boot();
      } catch (err) {
        bag.state.error = err.message;
        bag.renderAuth();
      }
    });
  }

  bag.visibleAlerts = function visibleAlerts() {
    return (bag.state.alerts || []).filter((a) => !bag.state.dismissedAlerts.has(a.id));
  }

  bag.badgeCount = function badgeCount(n) {
    return n > 9 ? '9+' : String(n);
  }

  bag.renderAlertList = function renderAlertList() {
    const list = bag.visibleAlerts();
    if (!list.length) {
      return `<div class="notif-empty">Aucune alerte pour le moment.</div>`;
    }
    return list.map((a) => `
      <div class="notif-item level-${bag.esc(a.level)}" data-alert-id="${bag.esc(a.id)}">
        <div class="notif-item-main">
          ${a.href ? `<a href="${bag.esc(a.href)}" class="notif-title">${bag.esc(a.title)}</a>` : `<div class="notif-title">${bag.esc(a.title)}</div>`}
          ${a.detail ? `<div class="notif-detail">${bag.esc(a.detail)}</div>` : ''}
        </div>
        <button type="button" class="notif-dismiss" data-dismiss="${bag.esc(a.id)}" title="Ignorer">✕</button>
      </div>
    `).join('');
  }

  bag.updateAlertUi = function updateAlertUi() {
    const badge = document.getElementById('notif-badge');
    const list = document.getElementById('notif-list');
    const status = document.getElementById('status-online');
    const alerts = bag.visibleAlerts();
    if (badge) {
      badge.hidden = alerts.length === 0;
      badge.textContent = bag.badgeCount(alerts.length);
    }
    if (list) list.innerHTML = bag.renderAlertList();
    if (status) {
      status.classList.toggle('is-offline', !bag.state.dockerOnline);
      status.innerHTML = `<span class="dot"></span>${bag.state.dockerOnline ? 'En ligne' : 'Hors ligne'}`;
    }
    bag.bindAlertDismiss();
  }

  bag.bindAlertDismiss = function bindAlertDismiss() {
    document.querySelectorAll('[data-dismiss]').forEach((btn) => {
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        bag.state.dismissedAlerts.add(btn.dataset.dismiss);
        try {
          localStorage.setItem('dm_dismissed_alerts', JSON.stringify([...state.dismissedAlerts].slice(-80)));
        } catch (_) {}
        bag.updateAlertUi();
      };
    });
  }

  bag.bindAlertUi = function bindAlertUi() {
    const bell = document.getElementById('notif-bell');
    const panel = document.getElementById('notif-panel');
    const refresh = document.getElementById('notif-refresh');
    if (!bell || !panel) return;

    bell.onclick = (e) => {
      e.stopPropagation();
      const open = panel.hasAttribute('hidden');
      panel.hidden = !open;
      bell.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) bag.refreshAlerts();
    };
    if (refresh) {
      refresh.onclick = (e) => {
        e.stopPropagation();
        bag.refreshAlerts();
      };
    }
    bag.bindAlertDismiss();
  }

  bag.pushContainerAlerts = function pushContainerAlerts(alerts, list, nodePrefix = '') {
    const stopped = list.filter((c) => {
      const s = String(c.State || '').toLowerCase();
      return s !== 'running' && s !== 'restarting' && s !== 'removing';
    });
    const unhealthy = list.filter((c) => String(c.Status || '').toLowerCase().includes('(unhealthy)'));
    const prefix = nodePrefix ? `[${nodePrefix}] ` : '';

    if (stopped.length) {
      const names = stopped.slice(0, 4).map((c) =>
        (c.Names && c.Names[0] ? c.Names[0].replace(/^\//, '') : bag.shortId(c.Id))
      );
      alerts.push({
        id: `stopped-${nodePrefix || 'local'}-${stopped.length}-${stopped.map((c) => bag.shortId(c.Id)).join(',')}`,
        level: 'warn',
        title: `${prefix}${stopped.length} conteneur${stopped.length > 1 ? 's' : ''} arrêté${stopped.length > 1 ? 's' : ''}`,
        detail: names.join(', ') + (stopped.length > 4 ? '…' : ''),
        href: '#containers',
      });
    }

    unhealthy.forEach((c) => {
      const name = c.Names && c.Names[0] ? c.Names[0].replace(/^\//, '') : bag.shortId(c.Id);
      alerts.push({
        id: `unhealthy-${nodePrefix || 'local'}-${bag.shortId(c.Id)}`,
        level: 'danger',
        title: `${prefix}${name} est unhealthy`,
        detail: c.Status || '',
        href: `#containers/${c.Id}`,
      });
    });
  }

  bag.refreshAlerts = async function refreshAlerts() {
    const alerts = [];
    let online = true;

    try {
      if (bag.isAllNodes()) {
        // Fan-out : ne pas appeler bag.Api.docker() (interdit en mode Tous)
        const eps = bag.activeEndpoints();
        const probes = await Promise.all(eps.map(async (ep) => {
          const id = Number(ep.Id);
          const name = ep.NodeName || ep.Name || String(id);
          try {
            const [info, containers] = await Promise.all([
              bag.Api.dockerOn(id, '/info'),
              bag.Api.dockerOn(id, '/containers/json?all=true'),
            ]);
            return { ok: true, id, name, info, containers: containers || [] };
          } catch (_) {
            return { ok: false, id, name };
          }
        }));
        const okNodes = probes.filter((p) => p.ok && p.info?.ServerVersion);
        online = okNodes.length > 0;
        if (okNodes[0]?.info?.ServerVersion) {
          bag.state.engineVersion = okNodes[0].info.ServerVersion;
        }
        probes.filter((p) => !p.ok).forEach((p) => {
          alerts.push({
            id: `node-offline-${p.id}`,
            level: 'warn',
            title: `Nœud hors ligne : ${p.name}`,
            detail: 'Impossible de joindre le moteur Docker de ce nœud',
            href: '#nodes',
          });
        });
        okNodes.forEach((p) => bag.pushContainerAlerts(alerts, p.containers, p.name));
      } else {
        const [containers, host, info] = await Promise.all([
          bag.Api.docker('/containers/json?all=true'),
          bag.Api.host().catch(() => null),
          bag.Api.docker('/info').catch(() => null),
        ]);

        if (!info || !info.ServerVersion) {
          online = false;
        } else {
          bag.state.engineVersion = info.ServerVersion;
        }

        bag.pushContainerAlerts(alerts, containers || []);

        if (host && Number(host.DiskTotal) > 0) {
          const pct = Number(host.DiskUsedPercent) || ((Number(host.DiskUsed) / Number(host.DiskTotal)) * 100);
          if (pct >= 95) {
            alerts.push({
              id: `disk-critical-${Math.floor(pct)}`,
              level: 'danger',
              title: `Disque critique (${pct.toFixed(0)} %)`,
              detail: `${bag.formatBytes(host.DiskUsed)} utilisés sur ${bag.formatBytes(host.DiskTotal)}`,
              href: '#dashboard',
            });
          } else if (pct >= 85) {
            alerts.push({
              id: `disk-warn-${Math.floor(pct)}`,
              level: 'warn',
              title: `Disque presque plein (${pct.toFixed(0)} %)`,
              detail: `${bag.formatBytes(host.DiskUsed)} / ${bag.formatBytes(host.DiskTotal)}`,
              href: '#dashboard',
            });
          }
        }
      }
    } catch (_) {
      online = false;
    }

    if (!online) {
      alerts.unshift({
        id: 'docker-offline',
        level: 'danger',
        title: bag.isAllNodes() ? 'Aucun nœud joignable' : 'Docker inaccessible',
        detail: bag.isAllNodes()
          ? 'Impossible de joindre les moteurs Docker du cluster'
          : 'Impossible de joindre le moteur Docker',
        href: '#dashboard',
      });
    }

    bag.state.dockerOnline = online;
    bag.state.alerts = alerts;
    bag.updateAlertUi();
  }

  bag.ensureAlertPolling = function ensureAlertPolling() {
    if (bag.state.alertTimer) return;
    bag.state.alertTimer = setInterval(() => {
      if (bag.state.user) bag.refreshAlerts();
    }, 45000);
  }

}
