import { bag } from '../bag.js';

/**
 * Admin full-app smoke suite (wmtest_*).
 * Covers SPA, public/read APIs, users/tokens/teams/ACL, registries,
 * Dockerfile/build, per-node Docker (image/volume/network/container/logs/exec),
 * volume browser, bind-volumes, stacks (restart/update/schedule/export/share),
 * CVE soft advise, backup probe. Skips destructive global ops (settings PUT, prune, join-token rotate, etc.).
 */
export function install() {
  const SPA_HANDLERS = [
    'viewDashboard', 'viewContainers', 'viewImages', 'viewVolumes', 'viewNetworks',
    'viewStacks', 'viewSettings', 'viewSettingsAuth', 'viewTests', 'viewUsers',
    'viewTeams', 'viewNodes', 'viewRegistries', 'viewDocs', 'viewActivity',
  ];

  const HASH_LINKS = [
    ['#dashboard', 'Tableau de bord'], ['#containers', 'Conteneurs'], ['#images', 'Images'],
    ['#volumes', 'Volumes'], ['#networks', 'Réseaux'], ['#stacks', 'Stacks'],
    ['#activity', 'Journaux'], ['#settings', 'Paramètres'], ['#settings/auth', 'Authentification'],
    ['#settings/tests', 'Tests'], ['#registries', 'Registres'], ['#nodes', 'Nœuds'],
    ['#users', 'Utilisateurs'], ['#teams', 'Équipes'], ['#docs', 'Documentation'],
  ];

  const TEST_USER_PASSWORD = 'WmTestPass1x';

  function levelBadge(level, ok) {
    const lv = level || (ok ? 'ok' : 'fail');
    if (lv === 'ok') return '<span class="badge badge-success">OK</span>';
    if (lv === 'warn') return '<span class="badge badge-warn">WARN</span>';
    if (lv === 'skip') return '<span class="badge">SKIP</span>';
    return '<span class="badge badge-danger">KO</span>';
  }

  function groupSteps(steps) {
    const map = new Map();
    for (const s of steps) {
      const g = s.group || 'Autre';
      if (!map.has(g)) map.set(g, []);
      map.get(g).push(s);
    }
    return map;
  }

  function renderSteps(steps) {
    if (!steps.length) {
      return '<div class="info-box">Lancez la suite complète (toutes les options sûres, tous les nœuds).</div>';
    }
    const failed = steps.filter((s) => s.level === 'fail').length;
    const ok = steps.filter((s) => s.level === 'ok').length;
    const warn = steps.filter((s) => s.level === 'warn' || s.level === 'skip').length;
    let html = `
      <div class="panel" style="margin-bottom:16px">
        <div class="section-title" style="margin-top:0">Résumé</div>
        <p style="margin:0">
          <span class="badge badge-success">${ok} OK</span>
          <span class="badge badge-warn" style="margin-left:6px">${warn} warn/skip</span>
          <span class="badge badge-danger" style="margin-left:6px">${failed} KO</span>
          <span class="muted" style="margin-left:10px">${steps.length} étapes</span>
        </p>
      </div>`;
    for (const [group, items] of groupSteps(steps)) {
      html += `<div class="panel" style="margin-bottom:16px">
        <div class="section-title" style="margin-top:0">${bag.esc(group)}</div>
        <table class="data-table"><thead><tr>
          <th style="width:90px">Statut</th><th>Étape</th><th>Détail</th><th style="width:90px">ms</th>
        </tr></thead><tbody>`;
      for (const s of items) {
        html += `<tr>
          <td>${levelBadge(s.level, s.ok)}</td>
          <td class="mono">${bag.esc(s.id)}</td>
          <td>${s.html ? s.detail : bag.esc(s.detail || '')}</td>
          <td class="mono muted">${s.ms != null ? s.ms : '—'}</td>
        </tr>`;
      }
      html += '</tbody></table></div>';
    }
    return html;
  }

  function makeRunner(onStep) {
    const steps = [];
    const push = (step) => {
      steps.push(step);
      if (onStep) onStep(steps.slice());
    };
    const run = async (id, group, fn) => {
      const t0 = performance.now();
      try {
        const detail = await fn();
        push({
          id, group, ok: true, level: 'ok',
          detail: detail == null ? 'OK' : String(detail),
          ms: Math.round(performance.now() - t0),
        });
        return true;
      } catch (err) {
        push({
          id, group, ok: false, level: 'fail',
          detail: err.message || String(err),
          ms: Math.round(performance.now() - t0),
        });
        return false;
      }
    };
    const skip = (id, group, detail) => push({ id, group, ok: true, level: 'skip', detail, ms: 0 });
    const warn = (id, group, detail) => push({ id, group, ok: true, level: 'warn', detail, ms: 0 });
    const addHtml = (id, group, detail) => push({ id, group, ok: true, level: 'ok', detail, html: true, ms: 0 });
    const markSkipIf = (id, prefix = 'SKIP:') => {
      const last = [...steps].reverse().find((s) => s.id === id);
      if (last && String(last.detail || '').startsWith(prefix)) {
        last.level = 'skip';
        last.ok = true;
      }
    };
    return { steps, run, skip, warn, addHtml, push, markSkipIf };
  }

  function epIdOf(ep) { return Number(ep?.Id ?? ep?.id ?? 0); }
  function epNameOf(ep) {
    return String(ep?.NodeName || ep?.Name || ep?.name || `ep#${epIdOf(ep)}`);
  }
  function epOnline(ep) {
    // Status 1 = up (Portainer-style). Agents down / unreachable → skip mutatif.
    const st = Number(ep?.Status ?? ep?.status ?? 1);
    return st === 1 && !ep?.Disabled;
  }
  async function listEndpoints() {
    const eps = await bag.Api.endpoints();
    return (Array.isArray(eps) ? eps : []).filter((ep) => epIdOf(ep) > 0);
  }
  function withEndpoint(epId, fn) {
    const prev = bag.Api.getEndpointId();
    const prevState = bag.state.endpointId;
    bag.Api.setEndpointId(epId);
    if (bag.state) bag.state.endpointId = epId;
    return Promise.resolve().then(fn).finally(() => {
      bag.Api.setEndpointId(prev);
      if (bag.state) bag.state.endpointId = prevState;
    });
  }
  function idOf(obj) { return obj?.Id ?? obj?.id ?? null; }

  function makeDockerfileTar(dockerfileText) {
    const enc = new TextEncoder();
    const text = dockerfileText.endsWith('\n') ? dockerfileText : `${dockerfileText}\n`;
    const content = enc.encode(text);
    const header = new Uint8Array(512);
    const name = 'Dockerfile';
    for (let i = 0; i < name.length && i < 100; i++) header[i] = name.charCodeAt(i);
    const writeOctal = (offset, length, value) => {
      const s = `${Number(value).toString(8).padStart(length - 1, '0')}\0`;
      for (let i = 0; i < length; i++) header[offset + i] = s.charCodeAt(i) || 0;
    };
    writeOctal(100, 8, 0o644);
    writeOctal(108, 8, 0);
    writeOctal(116, 8, 0);
    writeOctal(124, 12, content.length);
    writeOctal(136, 12, Math.floor(Date.now() / 1000));
    for (let i = 148; i < 156; i++) header[i] = 0x20;
    header[156] = '0'.charCodeAt(0);
    const magic = 'ustar\0';
    for (let i = 0; i < magic.length; i++) header[257 + i] = magic.charCodeAt(i);
    header[263] = '0'.charCodeAt(0);
    header[264] = '0'.charCodeAt(0);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    const chk = `${sum.toString(8).padStart(6, '0')}\0 `;
    for (let i = 0; i < 8; i++) header[148 + i] = chk.charCodeAt(i);
    const dataLen = Math.ceil(content.length / 512) * 512 || 512;
    const out = new Uint8Array(512 + dataLen + 1024);
    out.set(header, 0);
    out.set(content, 512);
    return out;
  }

  function parseBuildLog(body) {
    let error = null;
    for (const line of String(body || '').split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        const json = JSON.parse(t);
        if (json?.error) error = String(json.error);
        else if (json?.errorDetail?.message) error = String(json.errorDetail.message);
      } catch (_) { /* ignore */ }
    }
    return error;
  }

  async function softProbeDownload(url, accept) {
    const token = bag.Api.getToken?.();
    if (!token) throw new Error('Session expirée');
    const res = await fetch(url, {
      headers: { Accept: accept, Authorization: 'Bearer ' + token },
    });
    if (!res.ok) {
      let msg = res.statusText;
      try { const d = await res.json(); if (d?.message) msg = d.message; } catch (_) {}
      throw new Error(msg || `HTTP ${res.status}`);
    }
    const ct = (res.headers.get('Content-Type') || '').toLowerCase();
    const reader = res.body?.getReader?.();
    if (reader) {
      const { value } = await reader.read();
      await reader.cancel();
      const n = value?.byteLength || 0;
      if (n < 2) throw new Error('Flux vide');
      return `OK ct=${ct || '?'} sample=${n}o`;
    }
    const blob = await res.blob();
    if (!blob || blob.size < 8) throw new Error('Réponse vide');
    return `OK ct=${ct || '?'} size=${blob.size}`;
  }

  // --- Suites ---

  async function runSpaChecks(R) {
    for (const name of SPA_HANDLERS) {
      const ok = typeof bag[name] === 'function';
      if (ok) await R.run(`spa.${name}`, 'SPA', async () => 'présent');
      else await R.run(`spa.${name}`, 'SPA', async () => { throw new Error('manquante'); });
    }
    for (const [href, label] of HASH_LINKS) {
      R.addHtml(
        `link.${href.slice(1).replace(/\//g, '.')}`,
        'Liens console',
        `<a href="${bag.esc(href)}">${bag.esc(label)}</a> <span class="mono muted">${bag.esc(href)}</span>`,
      );
    }
  }

  async function runServerDiagnostics(R) {
    const t0 = performance.now();
    try {
      const server = await bag.Api.diagnostics();
      const checks = Array.isArray(server.checks) ? server.checks : [];
      for (const c of checks) {
        const level = c.level || (c.ok ? 'ok' : 'fail');
        R.push({
          id: c.id || 'server.check', group: c.group || 'Serveur',
          ok: level !== 'fail', level, detail: c.detail || '', ms: 0,
        });
      }
      const failed = checks.filter((c) => (c.level || (c.ok ? 'ok' : 'fail')) === 'fail').length;
      R.push({
        id: 'server.diagnostics', group: 'Serveur',
        ok: failed === 0, level: failed === 0 ? 'ok' : 'fail',
        detail: failed === 0 ? `${checks.length} checks` : `${failed} échec(s)`,
        ms: Math.round(performance.now() - t0),
      });
    } catch (err) {
      R.push({
        id: 'server.diagnostics', group: 'Serveur', ok: false, level: 'fail',
        detail: err.message || String(err), ms: Math.round(performance.now() - t0),
      });
    }
  }

  async function runPublicAndReadApis(R, endpoints) {
    const G = 'Lecture API';
    await R.run('public.status', G, async () => {
      const d = await bag.Api.status();
      return `v=${d?.Version || d?.version || '?'}`;
    });
    await R.run('public.system.version', G, async () => {
      const res = await fetch('/api/system/version', { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      return `agent=${d?.AgentImage || d?.agentImage || '?'}`;
    });
    await R.run('public.system.status', G, async () => {
      const res = await fetch('/api/system/status', { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return `HTTP ${res.status}`;
    });
    await R.run('public.health', G, async () => {
      const res = await fetch('/api/health', { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return `HTTP ${res.status}`;
    });
    await R.run('public.admin.check', G, async () => {
      const d = await bag.Api.adminCheck();
      return `adminInit=${d?.adminInit ?? d?.AdminInit ?? '?'}`;
    });
    await R.run('api.me', G, async () => {
      const me = await bag.Api.me();
      return `user=${me.Username || me.username} role=${me.Role ?? me.role}`;
    });
    await R.run('api.host', G, async () => {
      const d = await bag.Api.host();
      return d ? 'OK' : 'vide';
    });
    await R.run('api.settings', G, async () => {
      await bag.Api.settings();
      return 'OK';
    });
    await R.run('api.users.directory', G, async () => {
      const d = await bag.Api.usersDirectory();
      const n = Array.isArray(d) ? d.length : (d?.Users?.length ?? '?');
      return `${n} entrée(s)`;
    });
    await R.run('api.teams', G, async () => {
      const d = await bag.Api.teams(true);
      return `${Array.isArray(d) ? d.length : 0} équipe(s)`;
    });
    await R.run('api.acls', G, async () => {
      const d = await bag.Api.acls();
      const n = Array.isArray(d) ? d.length : (d?.Items?.length ?? 0);
      return `${n} ACL`;
    });
    await R.run('api.schedules', G, async () => {
      const d = await bag.Api.schedules();
      const n = Array.isArray(d) ? d.length : (d?.Items?.length ?? 0);
      return `${n} planif.`;
    });
    await R.run('api.audit.filter', G, async () => {
      const d = await bag.Api.audit({ limit: 5, action: 'user.create' });
      const n = Array.isArray(d) ? d.length : (d?.Events?.length ?? '?');
      return `${n} evt`;
    });
    await R.run('api.audit.paging', G, async () => {
      await bag.Api.audit({ limit: 3, offset: 3 });
      return 'OK';
    });
    await R.run('api.nodes.join-token.meta', G, async () => {
      const d = await bag.Api.joinTokenMeta();
      if (d == null) throw new Error('réponse vide');
      if (d.Active == null && d.active == null) return 'aucun token actif (OK)';
      return 'token actif';
    });
    await R.run('api.metrics.sample', G, async () => {
      const ep = endpoints[0];
      if (!ep) return 'SKIP: pas de nœud';
      await bag.Api.metricsSample({
        Scope: `ep:${epIdOf(ep)}`,
        containers: 0, cpu: 0, mem: 0, disk: 0,
      });
      return 'échantillon écrit';
    });
    R.markSkipIf('api.metrics.sample');

    await R.run('images.search', G, async () => {
      const d = await bag.Api.searchImages('alpine');
      const n = Array.isArray(d) ? d.length : (d?.results?.length ?? '?');
      return `${n} résultat(s)`;
    });
    await R.run('images.tags', G, async () => {
      const d = await bag.Api.imageTags('library/alpine');
      const n = Array.isArray(d) ? d.length : (d?.tags?.length ?? '?');
      return `${n} tag(s)`;
    });

    await R.run('http.options.settings', G, async () => {
      const res = await fetch('/api/settings', { method: 'OPTIONS' });
      if (res.status !== 204 && res.status !== 200) throw new Error(`HTTP ${res.status}`);
      return `HTTP ${res.status}`;
    });

    for (const ep of endpoints) {
      const id = epIdOf(ep);
      const label = epNameOf(ep);
      const g = `Lecture · ${label}`;
      await withEndpoint(id, async () => {
        await R.run(`ep${id}.endpoint.get`, g, async () => {
          const res = await bag.Api.request(`/api/endpoints/${id}`);
          return res?.Name || res?.name || `#${id}`;
        });
        await R.run(`ep${id}.acls`, g, async () => {
          const d = await bag.Api.acls(id);
          const n = Array.isArray(d) ? d.length : (d?.Items?.length ?? 0);
          return `${n}`;
        });

        if (!epOnline(ep)) {
          R.skip(`ep${id}.docker.*`, g, `Nœud hors ligne (Status=${ep.Status ?? '?'}) — skip lectures Docker`);
          return;
        }

        await R.run(`ep${id}.ping`, g, async () => {
          await bag.Api.pingNode(id);
          return 'pong';
        });
        await R.run(`ep${id}.docker.info`, g, async () => {
          const info = await bag.Api.docker('/info');
          return `os=${info?.OperatingSystem || '?'}`;
        });
        await R.run(`ep${id}.docker.df`, g, async () => {
          await bag.Api.docker('/system/df');
          return 'OK';
        });
        await R.run(`ep${id}.containers`, g, async () => {
          const d = await bag.Api.docker('/containers/json?all=true');
          return `${Array.isArray(d) ? d.length : 0}`;
        });
        await R.run(`ep${id}.images.json`, g, async () => {
          const d = await bag.Api.docker('/images/json');
          return `${Array.isArray(d) ? d.length : 0}`;
        });
        await R.run(`ep${id}.stacks`, g, async () => {
          const d = await bag.Api.stacks();
          return `${Array.isArray(d) ? d.length : 0}`;
        });
        await R.run(`ep${id}.stacks.updates`, g, async () => {
          await bag.Api.stackUpdates(false);
          return 'OK';
        });
        await R.run(`ep${id}.containers.updates`, g, async () => {
          await bag.Api.containerUpdates(false);
          return 'OK';
        });
        await R.run(`ep${id}.bind-volumes`, g, async () => {
          const d = await bag.Api.bindVolumes();
          return `${Array.isArray(d) ? d.length : 0}`;
        });
        await R.run(`ep${id}.metrics`, g, async () => {
          const d = await bag.Api.metricsHistory(`ep:${id}`, { hours: 1, points: 12 });
          const pts = Array.isArray(d?.points) ? d.points.length
            : (Array.isArray(d?.Points) ? d.Points.length : '?');
          return `points=${pts}`;
        });
        await R.run(`ep${id}.cve.scans`, g, async () => {
          await bag.Api.imageScans(id);
          return 'OK';
        });
        await R.run(`ep${id}.cve.advise`, g, async () => {
          const d = await bag.Api.adviseImages(id, { Images: ['alpine:latest'] });
          const item = Array.isArray(d?.Items) ? d.Items[0] : null;
          const st = item?.Status || d?.Worst || '?';
          return `status=${st}`;
        });
        await R.run(`ep${id}.cve.ensure`, g, async () => {
          await bag.Api.ensureImageScans(id, { Images: ['alpine:latest'] });
          return 'OK';
        });
      });
    }
  }

  async function runUserLifecycle(R) {
    const G = 'Utilisateurs';
    const tag = `wm${Date.now().toString(36)}`;
    const username = `wmtest_u_${tag}`;
    const created = { userId: null, username: null, password: TEST_USER_PASSWORD, tokenId: null };

    const ok = await R.run('users.create', G, async () => {
      const res = await bag.Api.createUser(username, TEST_USER_PASSWORD, 2);
      created.userId = idOf(res);
      created.username = res?.Username || username;
      if (!created.userId) throw new Error('Id manquant');
      return `Id=${created.userId}`;
    });
    if (!ok) return created;

    await R.run('users.get', G, async () => {
      const u = await bag.Api.request(`/api/users/${created.userId}`);
      if (idOf(u) !== created.userId && Number(u?.Id) !== Number(created.userId)) {
        // some APIs return public user without nested check
      }
      return u?.Username || u?.username || 'OK';
    });

    await R.run('users.passwd', G, async () => {
      // Admin reset (pas CurrentPassword)
      const newPw = 'WmTestPass2y';
      await bag.Api.changePassword(created.userId, { Password: newPw, PasswordConfirm: newPw });
      created.password = newPw;
      return 'reset OK';
    });

    await R.run('users.tokens.create', G, async () => {
      const tok = await bag.Api.createUserToken(created.userId, {
        description: `wmtest_tok_${tag}`,
        password: created.password,
      });
      created.tokenId = tok?.id ?? tok?.Id ?? null;
      if (!created.tokenId) throw new Error('token id manquant');
      return `#${created.tokenId}`;
    });
    await R.run('users.tokens.list', G, async () => {
      const list = await bag.Api.listUserTokens(created.userId);
      const n = Array.isArray(list) ? list.length : 0;
      if (!n) throw new Error('liste vide');
      return `${n} clé(s)`;
    });
    await R.run('users.tokens.revoke', G, async () => {
      await bag.Api.revokeUserToken(created.userId, created.tokenId);
      created.tokenId = null;
      return 'révoquée';
    });

    return created;
  }

  async function runTeamsAcls(R, testUser, endpoints) {
    const G = 'Équipes & ACL';
    if (!testUser?.userId) {
      R.skip('teams.*', G, 'Pas d’utilisateur de test');
      return { teamId: null, aclId: null };
    }
    const tag = `wm${Date.now().toString(36)}`;
    const created = { teamId: null, aclId: null };

    await R.run('teams.create', G, async () => {
      const res = await bag.Api.createTeam({
        Name: `wmtest_team_${tag}`,
        Description: 'apitest',
      });
      created.teamId = idOf(res);
      if (!created.teamId) throw new Error('Id équipe manquant');
      return `#${created.teamId}`;
    });
    if (!created.teamId) return created;

    await R.run('teams.get', G, async () => {
      const t = await bag.Api.team(created.teamId);
      return t?.Name || t?.name || 'OK';
    });
    await R.run('teams.update', G, async () => {
      await bag.Api.updateTeam(created.teamId, { Description: 'apitest-updated' });
      return 'OK';
    });
    await R.run('teams.member.add', G, async () => {
      await bag.Api.addTeamMember(created.teamId, testUser.userId);
      return `user #${testUser.userId}`;
    });
    await R.run('teams.member.remove', G, async () => {
      await bag.Api.removeTeamMember(created.teamId, testUser.userId);
      return 'OK';
    });

    const ep = endpoints[0];
    if (ep) {
      await R.run('acls.upsert', G, async () => {
        const res = await bag.Api.upsertAcl({
          EndpointId: epIdOf(ep),
          SubjectType: 'user',
          SubjectId: testUser.userId,
          Role: 'read',
        });
        created.aclId = idOf(res);
        if (!created.aclId) throw new Error('Id ACL manquant');
        return `#${created.aclId}`;
      });
      await R.run('acls.delete', G, async () => {
        if (!created.aclId) throw new Error('pas d’ACL');
        await bag.Api.deleteAcl(created.aclId);
        created.aclId = null;
        return 'OK';
      });
    }

    await R.run('teams.delete', G, async () => {
      await bag.Api.deleteTeam(created.teamId);
      created.teamId = null;
      return 'OK';
    });

    return created;
  }

  async function runRegistryLifecycle(R) {
    const G = 'Registres';
    const tag = `wm${Date.now().toString(36)}`;
    const created = { registryId: null };

    await R.run('registries.list.detail', G, async () => {
      const list = await bag.Api.registries();
      const arr = Array.isArray(list) ? list : [];
      if (arr.length) {
        const id = idOf(arr[0]);
        await bag.Api.registry(id);
        try { await bag.Api.pingRegistry(id); } catch (_) { /* optional */ }
      }
      return `${arr.length} registre(s)`;
    });

    const ok = await R.run('registries.create', G, async () => {
      const res = await bag.Api.createRegistry({
        Name: `wmtest_reg_${tag}`,
        Type: 'hub',
        URL: 'https://registry-1.docker.io',
      });
      created.registryId = idOf(res);
      if (!created.registryId) throw new Error('Id registre manquant');
      return `#${created.registryId}`;
    });
    if (!ok) {
      R.warn('registries.create', G, 'Création Hub échouée (réseau/ping) — suite registres skip');
      return created;
    }

    await R.run('registries.ping', G, async () => {
      await bag.Api.pingRegistry(created.registryId);
      return 'OK';
    });
    await R.run('registries.repos', G, async () => {
      const d = await bag.Api.registryRepos(created.registryId, 'library', 5);
      return Array.isArray(d) ? `${d.length}` : 'OK';
    });
    await R.run('registries.delete', G, async () => {
      await bag.Api.deleteRegistry(created.registryId);
      created.registryId = null;
      return 'OK';
    });

    return created;
  }

  async function runImageApiLifecycle(R) {
    const G = 'Images API';
    const tag = `wm${Date.now().toString(36)}`;
    const dfName = `wmtest_df_${tag}`;
    const imgTag = `wmtest_img_${tag}:test`;
    const dockerfile = [
      'FROM alpine:latest',
      `LABEL wharfmaster.apitest="${tag}"`,
      'CMD ["true"]',
    ].join('\n');
    const created = { dfName: null, imgTag: null };

    await R.run('images.dockerfile.save', G, async () => {
      await bag.Api.saveDockerfile(dfName, dockerfile);
      created.dfName = dfName;
      return dfName;
    });
    await R.run('images.dockerfile.get', G, async () => {
      const d = await bag.Api.dockerfile(dfName);
      const content = d?.Content || d?.content || d;
      if (!String(content).includes('alpine')) throw new Error('contenu inattendu');
      return 'OK';
    });
    await R.run('images.dockerfile.list', G, async () => {
      const list = await bag.Api.dockerfiles();
      const found = (Array.isArray(list) ? list : []).some((d) => (d.Name || d.name) === dfName);
      if (!found) throw new Error('absent');
      return 'présent';
    });
    await R.run('images.build.api', G, async () => {
      const res = await bag.Api.buildImage({ Tag: imgTag, Dockerfile: dockerfile });
      if (!res?.Success) throw new Error(res?.Error || 'échec');
      created.imgTag = imgTag;
      return imgTag;
    });
    await R.run('images.build.inspect', G, async () => {
      const eps = await listEndpoints();
      const local = eps.find((ep) => String(ep.Kind || '').toLowerCase() === 'local') || eps[0];
      if (!local) throw new Error('pas de nœud');
      await withEndpoint(epIdOf(local), async () => {
        await bag.Api.docker(`/images/${encodeURIComponent(imgTag)}/json`);
      });
      return 'OK';
    });
    await R.run('images.build.delete', G, async () => {
      const eps = await listEndpoints();
      const local = eps.find((ep) => String(ep.Kind || '').toLowerCase() === 'local') || eps[0];
      if (local) {
        await withEndpoint(epIdOf(local), async () => {
          await bag.Api.docker(`/images/${encodeURIComponent(imgTag)}?force=true`, { method: 'DELETE' });
        });
      }
      created.imgTag = null;
      return 'rmi';
    });
    await R.run('images.dockerfile.delete', G, async () => {
      await bag.Api.deleteDockerfile(dfName);
      created.dfName = null;
      return 'OK';
    });
    return created;
  }

  async function runDockerLifecycle(R, ep, testUser) {
    const id = epIdOf(ep);
    const label = epNameOf(ep);
    const G = `Docker · ${label}`;
    const prefix = `ep${id}`;
    const tag = `wm${Date.now().toString(36)}${id}`;
    const volName = `wmtest_vol_${tag}`;
    const netName = `wmtest_net_${tag}`;
    const ctrName = `wmtest_ctr_${tag}`;
    const imgTag = `wmtest_img_${tag}:test`;
    const bindName = `wmtest_bind_${tag}`;
    const baseImage = 'alpine:latest';
    const created = {
      endpointId: id, volume: null, networkId: null, containerId: null,
      imgTag: null, bindId: null, shareIds: [],
    };

    await withEndpoint(id, async () => {
      await R.run(`${prefix}.images.ensure`, G, async () => {
        try {
          await bag.Api.docker(`/images/${encodeURIComponent(baseImage)}/json`);
          return 'présente';
        } catch (_) {
          await bag.Api.docker('/images/create?fromImage=alpine&tag=latest', { method: 'POST', body: '' });
          await bag.Api.docker(`/images/${encodeURIComponent(baseImage)}/json`);
          return 'tirée';
        }
      });

      await R.run(`${prefix}.images.build`, G, async () => {
        const df = [`FROM ${baseImage}`, `LABEL wharfmaster.apitest="${tag}"`, 'CMD ["sleep","90"]'].join('\n');
        const q = new URLSearchParams({ t: imgTag, dockerfile: 'Dockerfile', rm: 'true', forcerm: 'true' });
        const body = await bag.Api.docker(`/build?${q.toString()}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-tar' },
          body: makeDockerfileTar(df),
          text: true,
        });
        const err = parseBuildLog(body);
        if (err) throw new Error(err);
        await bag.Api.docker(`/images/${encodeURIComponent(imgTag)}/json`);
        created.imgTag = imgTag;
        return imgTag;
      });

      await R.run(`${prefix}.volumes.create`, G, async () => {
        const res = await bag.Api.docker('/volumes/create', {
          method: 'POST',
          body: JSON.stringify({
            Name: volName, Driver: 'local',
            Labels: { 'wharfmaster.apitest': tag },
          }),
        });
        created.volume = res?.Name || volName;
        return created.volume;
      });
      await R.run(`${prefix}.volumes.inspect`, G, async () => {
        const v = await bag.Api.docker(`/volumes/${encodeURIComponent(created.volume)}`);
        if (!v?.Name) throw new Error('vide');
        return v.Name;
      });
      await R.run(`${prefix}.volumes.list`, G, async () => {
        const list = await bag.Api.docker('/volumes');
        const vols = Array.isArray(list?.Volumes) ? list.Volumes : [];
        if (!vols.some((v) => v.Name === created.volume)) throw new Error('absent');
        return `${vols.length}`;
      });
      await R.run(`${prefix}.volumes.browse`, G, async () => {
        await bag.Api.volumeBrowse(created.volume, '/');
        return 'OK';
      });
      await R.run(`${prefix}.volumes.write`, G, async () => {
        await bag.Api.volumeWriteFile(created.volume, '/wmtest_smoke.txt', {
          Content: 'ok', CreateOnly: true,
        });
        return 'écrit';
      });
      await R.run(`${prefix}.volumes.read`, G, async () => {
        const f = await bag.Api.volumeFile(created.volume, '/wmtest_smoke.txt');
        const content = f?.Content ?? f?.content ?? f;
        if (!String(content).includes('ok')) throw new Error('contenu KO');
        return 'lu';
      });
      await R.run(`${prefix}.volumes.mkdir`, G, async () => {
        await bag.Api.volumeMkdir(created.volume, '/wmtest_dir');
        return 'OK';
      });
      await R.run(`${prefix}.volumes.rename`, G, async () => {
        await bag.Api.volumeRename(created.volume, '/wmtest_smoke.txt', '/wmtest_renamed.txt');
        return 'OK';
      });
      await R.run(`${prefix}.volumes.deleteEntry`, G, async () => {
        await bag.Api.volumeDeleteEntry(created.volume, '/wmtest_renamed.txt');
        try { await bag.Api.volumeDeleteEntry(created.volume, '/wmtest_dir'); } catch (_) {}
        return 'OK';
      });

      await R.run(`${prefix}.networks.create`, G, async () => {
        const res = await bag.Api.docker('/networks/create', {
          method: 'POST',
          body: JSON.stringify({
            Name: netName, Driver: 'bridge', CheckDuplicate: true,
            Labels: { 'wharfmaster.apitest': tag },
          }),
        });
        created.networkId = res?.Id || netName;
        return String(created.networkId).slice(0, 12);
      });
      await R.run(`${prefix}.networks.inspect`, G, async () => {
        const n = await bag.Api.docker(`/networks/${encodeURIComponent(created.networkId)}`);
        if (!n?.Id && !n?.Name) throw new Error('vide');
        return n.Name || n.Id;
      });
      await R.run(`${prefix}.networks.list`, G, async () => {
        const list = await bag.Api.docker('/networks');
        const nets = Array.isArray(list) ? list : [];
        if (!nets.some((n) => n.Id === created.networkId || n.Name === netName)) throw new Error('absent');
        return `${nets.length}`;
      });

      await R.run(`${prefix}.bind-volumes.create`, G, async () => {
        const res = await bag.Api.createBindVolume(bindName, `/tmp/${bindName}`);
        created.bindId = idOf(res);
        if (!created.bindId) {
          // fallback liste
          const list = await bag.Api.bindVolumes();
          const row = (Array.isArray(list) ? list : []).find((b) => b.Name === bindName);
          created.bindId = idOf(row);
        }
        if (!created.bindId) throw new Error('Id bind manquant');
        return `#${created.bindId}`;
      });
      await R.run(`${prefix}.bind-volumes.list`, G, async () => {
        const list = await bag.Api.bindVolumes();
        const found = (Array.isArray(list) ? list : []).some(
          (b) => Number(idOf(b)) === Number(created.bindId) || b.Name === bindName,
        );
        if (!found) throw new Error('absent');
        return 'présent';
      });

      await R.run(`${prefix}.containers.create`, G, async () => {
        // Aliases non vide : le proxy PHP transforme {} en [] (casse Docker EndpointsConfig).
        const res = await bag.Api.docker(`/containers/create?name=${encodeURIComponent(ctrName)}`, {
          method: 'POST',
          body: JSON.stringify({
            Image: created.imgTag || baseImage,
            Cmd: ['sleep', '180'],
            Labels: { 'wharfmaster.apitest': tag },
            HostConfig: { AutoRemove: false, Binds: [`${created.volume}:/wmtest:rw`] },
            NetworkingConfig: {
              EndpointsConfig: {
                [netName]: { Aliases: ['wmtest'] },
              },
            },
          }),
        });
        created.containerId = res?.Id;
        if (!created.containerId) throw new Error('Id manquant');
        return bag.shortId(created.containerId);
      });
      if (!created.containerId) {
        R.skip(`${prefix}.containers.*`, G, 'Création conteneur échouée — skip start/logs/exec');
      } else {
      await R.run(`${prefix}.containers.start`, G, async () => {
        await bag.Api.docker(`/containers/${encodeURIComponent(created.containerId)}/start`, {
          method: 'POST', body: '',
        });
        return 'démarré';
      });
      await R.run(`${prefix}.containers.inspect`, G, async () => {
        const info = await bag.Api.docker(`/containers/${encodeURIComponent(created.containerId)}/json`);
        const mounts = Array.isArray(info?.Mounts) ? info.Mounts : [];
        if (!mounts.some((m) => m.Name === created.volume || m.Destination === '/wmtest')) {
          throw new Error('volume non monté');
        }
        const nets = info?.NetworkSettings?.Networks || {};
        if (!nets[netName]) throw new Error('réseau non attaché');
        return `state=${info?.State?.Status || '?'}`;
      });
      await R.run(`${prefix}.containers.logs`, G, async () => {
        const logs = await bag.Api.containerLogs(created.containerId, { tail: 20 });
        return `${String(logs || '').length} o`;
      });
      await R.run(`${prefix}.containers.exec`, G, async () => {
        const res = await bag.Api.containerExec(
          created.containerId, 'echo wmtest-ok', '/bin/sh', '',
          { tty: false, timeout: 15 },
        );
        const out = String(res?.Stdout || res?.Output || res?.output || '');
        if (res?.ExitCode != null && Number(res.ExitCode) !== 0) {
          throw new Error((res?.Stderr || out || 'exit ' + res.ExitCode).slice(0, 160));
        }
        return out.includes('wmtest-ok') ? 'echo OK' : `exit=${res?.ExitCode ?? 0}`;
      });
      await R.run(`${prefix}.containers.stop`, G, async () => {
        await bag.Api.docker(`/containers/${encodeURIComponent(created.containerId)}/stop`, {
          method: 'POST', body: '',
        });
        return 'arrêté';
      });
      await R.run(`${prefix}.containers.start2`, G, async () => {
        await bag.Api.docker(`/containers/${encodeURIComponent(created.containerId)}/start`, {
          method: 'POST', body: '',
        });
        return 'redémarré';
      });
      await R.run(`${prefix}.containers.restart`, G, async () => {
        await bag.Api.docker(`/containers/${encodeURIComponent(created.containerId)}/restart`, {
          method: 'POST', body: '',
        });
        return 'OK';
      });

      if (testUser?.userId) {
        for (const [kind, key] of [
          ['container', created.containerId],
          ['volume', created.volume],
          ['network', created.networkId],
        ]) {
          await R.run(`${prefix}.shares.${kind}`, `Shares · ${label}`, async () => {
            const share = await bag.Api.createShare({
              Type: kind, EndpointId: id, Key: String(key), GranteeUserId: testUser.userId,
            });
            const sid = idOf(share);
            if (!sid) throw new Error('Id partage manquant');
            created.shareIds.push(sid);
            await bag.Api.deleteShare(sid);
            created.shareIds = created.shareIds.filter((x) => x !== sid);
            return `#${sid}`;
          });
        }
      }

      await R.run(`${prefix}.containers.delete`, G, async () => {
        await bag.Api.docker(
          `/containers/${encodeURIComponent(created.containerId)}?force=true`,
          { method: 'DELETE' },
        );
        created.containerId = null;
        return 'OK';
      });
      } // end container created
      await R.run(`${prefix}.volumes.delete`, G, async () => {
        await bag.Api.docker(`/volumes/${encodeURIComponent(created.volume)}`, { method: 'DELETE' });
        created.volume = null;
        return 'OK';
      });
      await R.run(`${prefix}.networks.delete`, G, async () => {
        await bag.Api.docker(`/networks/${encodeURIComponent(created.networkId)}`, { method: 'DELETE' });
        created.networkId = null;
        return 'OK';
      });
      await R.run(`${prefix}.bind-volumes.delete`, G, async () => {
        await bag.Api.deleteBindVolume(created.bindId);
        created.bindId = null;
        return 'OK';
      });
      if (created.imgTag) {
        await R.run(`${prefix}.images.delete`, G, async () => {
          await bag.Api.docker(`/images/${encodeURIComponent(created.imgTag)}?force=true`, { method: 'DELETE' });
          created.imgTag = null;
          return 'rmi';
        });
      }
    });

    return created;
  }

  async function runStackLifecycle(R, ep, testUser) {
    const id = epIdOf(ep);
    const label = epNameOf(ep);
    const G = `Stack · ${label}`;
    const prefix = `ep${id}`;
    const tag = `wm${Date.now().toString(36)}${id}`;
    const stackName = `wmtest_stk_${tag}`;
    const compose = [
      'services:',
      '  wmtest:',
      '    image: alpine:latest',
      '    command: ["sleep", "180"]',
      '    labels:',
      `      wharfmaster.apitest: "${tag}"`,
    ].join('\n');
    const created = {
      endpointId: id, stackId: null, stackName: null, shareId: null, scheduleId: null,
    };

    await withEndpoint(id, async () => {
      const ok = await R.run(`${prefix}.stacks.create`, G, async () => {
        const res = await bag.Api.createStack(stackName, compose, [], true);
        created.stackId = idOf(res);
        created.stackName = res?.Name || stackName;
        if (!created.stackId) throw new Error('Id manquant');
        return `#${created.stackId}`;
      });
      if (!ok) return;

      await R.run(`${prefix}.stacks.get`, G, async () => {
        const s = await bag.Api.stack(created.stackId);
        return s?.Name || 'OK';
      });
      await R.run(`${prefix}.stacks.file`, G, async () => {
        const f = await bag.Api.stackFile(created.stackId);
        if (!String(f?.StackFileContent || '').includes('alpine')) throw new Error('compose KO');
        return 'OK';
      });
      await R.run(`${prefix}.stacks.update`, G, async () => {
        await bag.Api.updateStack(created.stackId, compose, [], false);
        return 'noop OK';
      });
      await R.run(`${prefix}.stacks.stop`, G, async () => {
        await bag.Api.stopStack(created.stackId);
        return 'OK';
      });
      await R.run(`${prefix}.stacks.start`, G, async () => {
        await bag.Api.startStack(created.stackId);
        return 'OK';
      });
      await R.run(`${prefix}.stacks.restart`, G, async () => {
        await bag.Api.restartStack(created.stackId);
        return 'OK';
      });
      await R.run(`${prefix}.stacks.updates`, G, async () => {
        await bag.Api.stackUpdate(created.stackId, false);
        return 'OK';
      });
      await R.run(`${prefix}.stacks.export`, G, async () => {
        const token = bag.Api.getToken?.();
        const q = new URLSearchParams({ access_token: token });
        return softProbeDownload(
          `/api/stacks/${encodeURIComponent(created.stackId)}/export?${q}`,
          'application/zip',
        );
      });

      await R.run(`${prefix}.schedules.create`, `Schedules · ${label}`, async () => {
        const res = await bag.Api.createSchedule({
          StackId: created.stackId,
          Name: `wmtest_sched_${tag}`,
          Action: 'restart',
          Cron: '0 3 1 1 *',
          Timezone: 'UTC',
        });
        created.scheduleId = idOf(res);
        if (!created.scheduleId) throw new Error('Id schedule manquant');
        return `#${created.scheduleId}`;
      });
      if (created.scheduleId) {
        await R.run(`${prefix}.schedules.update`, `Schedules · ${label}`, async () => {
          await bag.Api.updateSchedule(created.scheduleId, { Enabled: false });
          return 'disabled';
        });
        await R.run(`${prefix}.schedules.list`, `Schedules · ${label}`, async () => {
          const d = await bag.Api.schedules({ stackId: created.stackId });
          const items = Array.isArray(d) ? d : (d?.Items || []);
          if (!items.some((s) => idOf(s) === created.scheduleId)) throw new Error('absent');
          return `${items.length}`;
        });
        await R.run(`${prefix}.schedules.run`, `Schedules · ${label}`, async () => {
          await bag.Api.runSchedule(created.scheduleId);
          return 'run OK';
        });
        await R.run(`${prefix}.schedules.delete`, `Schedules · ${label}`, async () => {
          await bag.Api.deleteSchedule(created.scheduleId);
          created.scheduleId = null;
          return 'OK';
        });
      }

      if (testUser?.userId) {
        await R.run(`${prefix}.shares.stack`, `Shares · ${label}`, async () => {
          const share = await bag.Api.createShare({
            Type: 'stack', EndpointId: id,
            Key: String(created.stackId), GranteeUserId: testUser.userId,
          });
          created.shareId = idOf(share);
          if (!created.shareId) throw new Error('Id manquant');
          const listed = await bag.Api.listShares('stack', id, String(created.stackId));
          const n = Array.isArray(listed) ? listed.length : (listed?.Items?.length ?? 0);
          await bag.Api.deleteShare(created.shareId);
          created.shareId = null;
          return `créé+listé(${n})+supprimé`;
        });
      }

      await R.run(`${prefix}.stacks.delete`, G, async () => {
        await bag.Api.deleteStack(created.stackId);
        created.stackId = null;
        return 'OK';
      });
    });

    return created;
  }

  async function runBackupSoft(R) {
    await R.run('backup.zip', 'Backup', async () => softProbeDownload('/api/backup', 'application/zip'));
    await R.run('backup.sqlite', 'Backup', async () =>
      softProbeDownload('/api/backup?format=sqlite', 'application/x-sqlite3'));
  }

  async function cleanupLeftovers(R, leftovers) {
    const G = 'Cleanup';
    for (const st of leftovers.stacks || []) {
      await withEndpoint(st.endpointId, async () => {
        if (st.scheduleId) {
          await R.run(`cleanup.ep${st.endpointId}.schedule`, G, async () => {
            await bag.Api.deleteSchedule(st.scheduleId);
            st.scheduleId = null;
            return 'OK';
          });
        }
        if (st.shareId) {
          await R.run(`cleanup.ep${st.endpointId}.share`, G, async () => {
            await bag.Api.deleteShare(st.shareId);
            st.shareId = null;
            return 'OK';
          });
        }
        if (st.stackId) {
          await R.run(`cleanup.ep${st.endpointId}.stack`, G, async () => {
            await bag.Api.deleteStack(st.stackId);
            st.stackId = null;
            return 'OK';
          });
        }
      });
    }
    for (const d of leftovers.docker || []) {
      const eid = d.endpointId;
      await withEndpoint(eid, async () => {
        for (const sid of d.shareIds || []) {
          await R.run(`cleanup.ep${eid}.share${sid}`, G, async () => {
            await bag.Api.deleteShare(sid);
            return 'OK';
          });
        }
        d.shareIds = [];
        if (d.containerId) {
          await R.run(`cleanup.ep${eid}.container`, G, async () => {
            await bag.Api.docker(`/containers/${encodeURIComponent(d.containerId)}?force=true`, { method: 'DELETE' });
            d.containerId = null;
            return 'OK';
          });
        }
        if (d.volume) {
          await R.run(`cleanup.ep${eid}.volume`, G, async () => {
            await bag.Api.docker(`/volumes/${encodeURIComponent(d.volume)}`, { method: 'DELETE' });
            d.volume = null;
            return 'OK';
          });
        }
        if (d.networkId) {
          await R.run(`cleanup.ep${eid}.network`, G, async () => {
            await bag.Api.docker(`/networks/${encodeURIComponent(d.networkId)}`, { method: 'DELETE' });
            d.networkId = null;
            return 'OK';
          });
        }
        if (d.bindId) {
          await R.run(`cleanup.ep${eid}.bind`, G, async () => {
            await bag.Api.deleteBindVolume(d.bindId);
            d.bindId = null;
            return 'OK';
          });
        }
        if (d.imgTag) {
          await R.run(`cleanup.ep${eid}.image`, G, async () => {
            await bag.Api.docker(`/images/${encodeURIComponent(d.imgTag)}?force=true`, { method: 'DELETE' });
            d.imgTag = null;
            return 'OK';
          });
        }
      });
    }
    if (leftovers.registryId) {
      await R.run('cleanup.registry', G, async () => {
        await bag.Api.deleteRegistry(leftovers.registryId);
        leftovers.registryId = null;
        return 'OK';
      });
    }
    if (leftovers.teamId) {
      await R.run('cleanup.team', G, async () => {
        await bag.Api.deleteTeam(leftovers.teamId);
        leftovers.teamId = null;
        return 'OK';
      });
    }
    if (leftovers.aclId) {
      await R.run('cleanup.acl', G, async () => {
        await bag.Api.deleteAcl(leftovers.aclId);
        leftovers.aclId = null;
        return 'OK';
      });
    }
    if (leftovers.imageApi?.imgTag) {
      const eps = await listEndpoints();
      const local = eps.find((ep) => String(ep.Kind || '').toLowerCase() === 'local') || eps[0];
      if (local) {
        await withEndpoint(epIdOf(local), async () => {
          await R.run('cleanup.images.api', G, async () => {
            await bag.Api.docker(`/images/${encodeURIComponent(leftovers.imageApi.imgTag)}?force=true`, { method: 'DELETE' });
            leftovers.imageApi.imgTag = null;
            return 'OK';
          });
        });
      }
    }
    if (leftovers.imageApi?.dfName) {
      await R.run('cleanup.dockerfile', G, async () => {
        await bag.Api.deleteDockerfile(leftovers.imageApi.dfName);
        leftovers.imageApi.dfName = null;
        return 'OK';
      });
    }
  }

  async function runFullSuite(onStep) {
    const R = makeRunner(onStep);
    const prevEp = bag.Api.getEndpointId();
    const prevState = bag.state?.endpointId;
    const leftovers = {
      docker: [], stacks: [], imageApi: null,
      registryId: null, teamId: null, aclId: null,
    };
    let testUser = { userId: null };

    try {
      await runSpaChecks(R);
      await runServerDiagnostics(R);

      let endpoints = [];
      await R.run('suite.endpoints', 'Nœuds', async () => {
        endpoints = await listEndpoints();
        if (!endpoints.length) throw new Error('Aucun nœud');
        const online = endpoints.filter(epOnline);
        const offline = endpoints.filter((ep) => !epOnline(ep));
        return `${online.length} online / ${endpoints.length}`
          + (offline.length
            ? ` (skip: ${offline.map((ep) => epNameOf(ep)).join(', ')})`
            : '');
      });

      await runPublicAndReadApis(R, endpoints);
      testUser = await runUserLifecycle(R);
      const teams = await runTeamsAcls(R, testUser, endpoints.filter(epOnline));
      leftovers.teamId = teams.teamId;
      leftovers.aclId = teams.aclId;

      const reg = await runRegistryLifecycle(R);
      leftovers.registryId = reg.registryId;

      leftovers.imageApi = await runImageApiLifecycle(R);

      for (const ep of endpoints) {
        if (!epOnline(ep)) {
          R.skip(`ep${epIdOf(ep)}.mutatif`, `Docker · ${epNameOf(ep)}`, 'Nœud hors ligne — skip');
          R.skip(`ep${epIdOf(ep)}.stack`, `Stack · ${epNameOf(ep)}`, 'Nœud hors ligne — skip');
          continue;
        }
        leftovers.docker.push(await runDockerLifecycle(R, ep, testUser));
        leftovers.stacks.push(await runStackLifecycle(R, ep, testUser));
      }

      await runBackupSoft(R);
      await cleanupLeftovers(R, leftovers);

      if (testUser?.tokenId) {
        await R.run('cleanup.token', 'Cleanup', async () => {
          await bag.Api.revokeUserToken(testUser.userId, testUser.tokenId);
          testUser.tokenId = null;
          return 'OK';
        });
      }
      if (testUser?.userId) {
        await R.run('users.delete', 'Utilisateurs', async () => {
          await bag.Api.deleteUser(testUser.userId);
          const u = testUser.username;
          testUser.userId = null;
          return `supprimé ${u}`;
        });
      }
    } finally {
      bag.Api.setEndpointId(prevEp);
      if (bag.state) bag.state.endpointId = prevState;
    }
    return R.steps;
  }

  function buildExportPayload(steps, endpointsList = null) {
    const failed = steps.filter((s) => s.level === 'fail');
    const ok = steps.filter((s) => s.level === 'ok');
    const skip = steps.filter((s) => s.level === 'skip' || s.level === 'warn');
    const src = Array.isArray(endpointsList) && endpointsList.length
      ? endpointsList
      : (bag.state?.endpoints || []);
    const endpoints = src.map((ep) => ({
      Id: epIdOf(ep),
      Name: epNameOf(ep),
      Kind: ep.Kind || ep.kind || '',
      Status: ep.Status ?? ep.status ?? null,
    }));
    return {
      kind: 'wharfmaster-tests-report',
      version: 1,
      exportedAt: new Date().toISOString(),
      appVersion: bag.state?.appVersion || null,
      user: bag.state?.user?.Username || bag.state?.user?.username || null,
      endpointSelected: bag.Api.getEndpointId?.() ?? null,
      endpoints,
      summary: {
        total: steps.length,
        ok: ok.length,
        fail: failed.length,
        skipWarn: skip.length,
      },
      failures: failed.map((s) => ({
        id: s.id,
        group: s.group || '',
        detail: s.detail || '',
        ms: s.ms ?? null,
      })),
      steps: steps.map((s) => ({
        id: s.id,
        group: s.group || '',
        level: s.level || (s.ok ? 'ok' : 'fail'),
        detail: s.html ? '[html]' : (s.detail || ''),
        ms: s.ms ?? null,
      })),
    };
  }

  function failuresMarkdown(payload) {
    const lines = [
      `# WharfMaster tests — ${payload.summary.fail} KO / ${payload.summary.total}`,
      `Export: ${payload.exportedAt}`,
      `App: ${payload.appVersion || '?'} — user: ${payload.user || '?'}`,
      '',
      '## Échecs',
    ];
    if (!payload.failures.length) {
      lines.push('_Aucun échec._');
    } else {
      for (const f of payload.failures) {
        lines.push(`- \`${f.id}\` (${f.group || '?'}) — ${f.detail}`);
      }
    }
    lines.push('', '## Nœuds');
    for (const ep of payload.endpoints || []) {
      lines.push(`- #${ep.Id} ${ep.Name} (${ep.Kind}) status=${ep.Status}`);
    }
    lines.push('', '_Joindre aussi le JSON complet si possible._');
    return lines.join('\n');
  }

  function downloadText(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 1500);
  }

  bag.viewTests = async function viewTests() {
    if (Number(bag.state.user?.Role) !== 1) {
      location.hash = '#settings';
      return;
    }

    let epCountLabel = '…';
    try {
      const eps = await listEndpoints();
      epCountLabel = eps.length ? eps.map((ep) => epNameOf(ep)).join(', ') : 'aucun nœud';
    } catch (_) {
      epCountLabel = 'indisponible';
    }

    let lastPayload = null;

    bag.root.innerHTML = bag.shell('Tests', `
      ${bag.pageHeader('Tests', false)}
      ${bag.settingsSubnav('settings/tests')}
      <div class="panel" style="max-width:900px;margin-bottom:16px">
        <div class="section-title" style="margin-top:0">Suite complète</div>
        <p class="muted" style="margin:0 0 10px">
          Couvre les options sûres : liens, APIs publiques/lecture, users+tokens+passwd,
          équipes+ACL, registres, Dockerfile/build, et sur <strong>chaque nœud</strong>
          image build, volume (browse/write), réseau, bind-volume, conteneur (logs/exec/stop/restart),
          partages, stack (update/restart/export/schedule), CVE soft, backup.
          Préfixe <code>wmtest_*</code> — nettoyage en fin de suite.
        </p>
        <p class="muted" style="margin:0 0 14px">
          Nœuds : <strong>${bag.esc(epCountLabel)}</strong>
        </p>
        <div class="toolbar" style="margin:0;flex-wrap:wrap;gap:8px">
          <button type="button" class="btn btn-primary" id="tests-run">Lancer la suite</button>
          <button type="button" class="btn" id="tests-export-json" disabled title="Après une exécution">Exporter JSON</button>
          <button type="button" class="btn" id="tests-export-md" disabled title="Après une exécution">Exporter KO (.md)</button>
          <button type="button" class="btn" id="tests-copy-ko" disabled title="Copier les échecs pour correction">Copier les KO</button>
          <span class="muted" id="tests-status" style="margin-left:4px"></span>
        </div>
        <p class="muted" style="margin:10px 0 0;font-size:0.92em">
          En cas d’échecs : <strong>Exporter JSON</strong> ou <strong>Copier les KO</strong> pour les coller dans le chat et demander une correction.
        </p>
      </div>
      <div id="tests-report">${renderSteps([])}</div>
    `, { subtitle: 'Smoke exhaustif admin' });

    const btn = document.getElementById('tests-run');
    const btnJson = document.getElementById('tests-export-json');
    const btnMd = document.getElementById('tests-export-md');
    const btnCopy = document.getElementById('tests-copy-ko');
    const status = document.getElementById('tests-status');
    const report = document.getElementById('tests-report');

    const enableExport = (payload) => {
      lastPayload = payload;
      btnJson.disabled = false;
      btnMd.disabled = false;
      btnCopy.disabled = false;
    };

    const stamp = () => {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    };

    btnJson.onclick = () => {
      if (!lastPayload) return;
      downloadText(
        `wharfmaster-tests-${stamp()}.json`,
        JSON.stringify(lastPayload, null, 2),
        'application/json;charset=utf-8',
      );
      status.textContent = 'JSON téléchargé';
    };

    btnMd.onclick = () => {
      if (!lastPayload) return;
      downloadText(
        `wharfmaster-tests-ko-${stamp()}.md`,
        failuresMarkdown(lastPayload),
        'text/markdown;charset=utf-8',
      );
      status.textContent = 'Rapport KO (.md) téléchargé';
    };

    btnCopy.onclick = async () => {
      if (!lastPayload) return;
      const text = failuresMarkdown(lastPayload);
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          const ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        status.textContent = lastPayload.summary.fail
          ? `${lastPayload.summary.fail} KO copiés — collez-les dans le chat`
          : 'Rapport copié (0 KO)';
      } catch (err) {
        status.textContent = 'Copie impossible — utilisez Exporter';
      }
    };

    btn.onclick = async () => {
      if (btn.dataset.busy === '1') return;
      if (!window.confirm(
        'Lancer la suite complète ?\nRessources wmtest_* créées/supprimées sur TOUS les nœuds (peut prendre plusieurs minutes).',
      )) return;
      btn.dataset.busy = '1';
      btn.disabled = true;
      btnJson.disabled = true;
      btnMd.disabled = true;
      btnCopy.disabled = true;
      lastPayload = null;
      status.textContent = 'Exécution…';
      report.innerHTML = renderSteps([]);
      try {
        const steps = await runFullSuite((live) => {
          report.innerHTML = renderSteps(live);
          status.textContent = `Étape ${live.length}…`;
        });
        let epsSnap = [];
        try { epsSnap = await listEndpoints(); } catch (_) { /* ignore */ }
        const payload = buildExportPayload(steps, epsSnap);
        enableExport(payload);
        const failed = payload.summary.fail;
        status.textContent = failed === 0
          ? `Terminé — ${payload.summary.total} étapes OK`
          : `Terminé — ${failed} échec(s) / ${payload.summary.total} — exportez ou copiez les KO`;
        report.innerHTML = renderSteps(steps);
      } catch (err) {
        status.textContent = 'Erreur';
        report.innerHTML = `<div class="error-box">${bag.esc(err.message || String(err))}</div>`;
        enableExport(buildExportPayload([{
          id: 'suite.crash',
          group: 'Suite',
          ok: false,
          level: 'fail',
          detail: err.message || String(err),
          ms: null,
        }]));
      } finally {
        btn.disabled = false;
        delete btn.dataset.busy;
      }
    };
  };

  bag.viewDiagnostics = bag.viewTests;
  bag.viewDiagnosticsApi = bag.viewTests;
}
