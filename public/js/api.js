const Api = (() => {
  const TOKEN_KEY = 'dm_jwt';
  const ENDPOINT_KEY = 'dm_endpoint_id';

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }

  function setToken(token) {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  }

  function getEndpointId() {
    const n = parseInt(localStorage.getItem(ENDPOINT_KEY) || '1', 10);
    // 0 = « Tous les nœuds » (vue agrégée lecture seule)
    if (Number.isFinite(n) && n >= 0) return n;
    return 1;
  }

  function setEndpointId(id) {
    const n = parseInt(String(id), 10);
    if (Number.isFinite(n) && n >= 0) localStorage.setItem(ENDPOINT_KEY, String(n));
  }

  function isAllEndpoints() {
    return getEndpointId() === 0;
  }

  async function request(path, options = {}) {
    const headers = Object.assign({ Accept: 'application/json' }, options.headers || {});
    const token = getToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    if (options.body && !(options.body instanceof FormData) && !headers['Content-Type'] && !options.raw) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(path, Object.assign({}, options, { headers }));
    const text = await res.text();
    let data = null;
    if (options.text) {
      data = text;
    } else if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    if (!res.ok) {
      const msg = (data && data.message) || text || res.statusText;
      const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  const dockerOn = (endpointId, path, options = {}) => {
    const id = parseInt(String(endpointId), 10);
    if (!Number.isFinite(id) || id < 1) {
      return Promise.reject(new Error('Choisissez un nœud pour cette action'));
    }
    return request(`/api/endpoints/${id}/docker${path}`, options);
  };

  const docker = (path, options = {}) => {
    if (isAllEndpoints()) {
      return Promise.reject(new Error('Choisissez un nœud pour cette action'));
    }
    return dockerOn(getEndpointId(), path, options);
  };

  return {
    get ENDPOINT_ID() { return getEndpointId(); },
    getEndpointId,
    setEndpointId,
    isAllEndpoints,
    getToken,
    setToken,
    request,
    docker,
    dockerOn,
    status: () => request('/api/status'),
    host: () => request('/api/system/host'),
    metricsHistory: (scope = 'ep:1', opts = {}) => {
      const q = new URLSearchParams({ scope: String(scope || 'ep:1') });
      if (opts.hours != null) q.set('hours', String(opts.hours));
      else q.set('days', String(opts.days != null ? opts.days : 90));
      q.set('points', String(opts.points != null ? opts.points : 180));
      return request(`/api/metrics/history?${q.toString()}`);
    },
    metricsSample: (payload) =>
      request('/api/metrics/sample', { method: 'POST', body: JSON.stringify(payload) }),
    adminCheck: () => request('/api/users/admin/check'),
    adminInit: (Username, Password) =>
      request('/api/users/admin/init', { method: 'POST', body: JSON.stringify({ Username, Password }) }),
    auth: (Username, Password) =>
      request('/api/auth', { method: 'POST', body: JSON.stringify({ Username, Password }) }),
    me: () => request('/api/users/me'),
    settings: () => request('/api/settings'),
    updateSettings: (payload) =>
      request('/api/settings', { method: 'PUT', body: JSON.stringify(payload) }),
    /** Full ZIP backup (admin). Triggers browser download. */
    downloadBackup: async (format = 'zip') => {
      const q = format && format !== 'zip' ? `?format=${encodeURIComponent(format)}` : '';
      const headers = { Accept: format === 'sqlite' ? 'application/x-sqlite3' : 'application/zip' };
      const token = getToken();
      if (token) headers.Authorization = 'Bearer ' + token;
      const res = await fetch(`/api/backup${q}`, { headers });
      if (!res.ok) {
        let msg = res.statusText;
        try {
          const data = await res.json();
          if (data && data.message) msg = data.message;
        } catch (_) {
          try { msg = await res.text() || msg; } catch (__) {}
        }
        const err = new Error(msg || 'Backup impossible');
        err.status = res.status;
        throw err;
      }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const m = cd.match(/filename="?([^";]+)"?/i);
      const filename = (m && m[1]) || `wharfmaster-backup.${format === 'sqlite' ? 'sqlite' : 'zip'}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      return { filename, size: blob.size };
    },
    users: () => request('/api/users'),
    createUser: (Username, Password, Role = 2) =>
      request('/api/users', { method: 'POST', body: JSON.stringify({ Username, Password, Role }) }),
    deleteUser: (id) => request(`/api/users/${id}`, { method: 'DELETE' }),
    changePassword: (id, payload) =>
      request(`/api/users/${id}/passwd`, { method: 'PUT', body: JSON.stringify(payload) }),
    endpoints: () => request('/api/endpoints'),
    nodes: () => request('/api/nodes'),
    joinTokenMeta: () => request('/api/nodes/join-token'),
    createJoinToken: (payload = {}) =>
      request('/api/nodes/join-token', { method: 'POST', body: JSON.stringify(payload) }),
    rotateJoinToken: (payload = {}) =>
      request('/api/nodes/join-token/rotate', { method: 'POST', body: JSON.stringify(payload) }),
    unlinkNode: (id) => request(`/api/nodes/${id}`, { method: 'DELETE' }),
    updateNode: (id, payload) =>
      request(`/api/nodes/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
    disableNode: (id) => request(`/api/nodes/${id}/disable`, { method: 'POST', body: '{}' }),
    enableNode: (id) => request(`/api/nodes/${id}/enable`, { method: 'POST', body: '{}' }),
    pingNode: (id) => request(`/api/nodes/${id}/ping`, { method: 'POST', body: '{}' }),
    audit: (opts = {}) => {
      const q = new URLSearchParams();
      q.set('limit', String(opts.limit ?? 100));
      q.set('offset', String(opts.offset ?? 0));
      if (opts.action) q.set('action', opts.action);
      return request(`/api/audit?${q.toString()}`);
    },
    containerLogs: (id, opts = {}) => {
      const q = new URLSearchParams();
      const tail = opts.tail ?? 300;
      q.set('tail', String(tail));
      q.set('timestamps', opts.timestamps === false ? 'false' : 'true');
      q.set('stdout', opts.stdout === false ? 'false' : 'true');
      q.set('stderr', opts.stderr === false ? 'false' : 'true');
      q.set('annotate', opts.annotate === false ? 'false' : 'true');
      if (opts.since != null && Number(opts.since) > 0) q.set('since', String(Math.floor(Number(opts.since))));
      return request(
        `/api/endpoints/${getEndpointId()}/containers/${encodeURIComponent(id)}/logs?${q.toString()}`,
        { text: true },
      );
    },
    containerExec: (id, command, shell = '/bin/sh', cwd = '', opts = {}) =>
      request(`/api/endpoints/${getEndpointId()}/containers/${encodeURIComponent(id)}/exec`, {
        method: 'POST',
        body: JSON.stringify({
          command,
          shell,
          cwd,
          cols: opts.cols || 120,
          rows: opts.rows || 40,
          tty: opts.tty !== false,
        }),
      }),
    buildImage: (payload) =>
      request('/api/images/build', { method: 'POST', body: JSON.stringify(payload) }),
    searchImages: (q) =>
      request(`/api/images/search?q=${encodeURIComponent(q)}`),
    imageTags: (repo) =>
      request(`/api/images/tags?repo=${encodeURIComponent(repo)}`),
    dockerfiles: () => request('/api/dockerfiles'),
    dockerfile: (name) => request(`/api/dockerfiles/${encodeURIComponent(name)}`),
    saveDockerfile: (Name, Content) =>
      request('/api/dockerfiles', { method: 'POST', body: JSON.stringify({ Name, Content }) }),
    deleteDockerfile: (name) =>
      request(`/api/dockerfiles/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    stacks: () => request(`/api/stacks?endpointId=${getEndpointId()}`),
    stackUpdates: (refresh = false) =>
      request(`/api/stacks/updates?endpointId=${getEndpointId()}${refresh ? '&refresh=1' : ''}`),
    stackUpdate: (id, refresh = false) =>
      request(`/api/stacks/${id}/updates${refresh ? '?refresh=1' : ''}`),
    stack: (id) => request(`/api/stacks/${id}`),
    stackFile: (id) => request(`/api/stacks/${id}/file`),
    createStack: (Name, StackFileContent, Env = [], PullImages = false) =>
      request(`/api/stacks/create/standalone/string?endpointId=${getEndpointId()}`, {
        method: 'POST',
        body: JSON.stringify({ Name, StackFileContent, Env, PullImages: !!PullImages }),
      }),
    updateStack: (id, StackFileContent, Env = [], PullImages = false) =>
      request(`/api/stacks/${id}?endpointId=${getEndpointId()}`, {
        method: 'PUT',
        body: JSON.stringify({ StackFileContent, Env, prune: true, PullImages: !!PullImages }),
      }),
    deleteStack: (id) =>
      request(`/api/stacks/${id}?endpointId=${getEndpointId()}`, { method: 'DELETE' }),
    startStack: (id) =>
      request(`/api/stacks/${id}/start`, { method: 'POST' }),
    stopStack: (id) =>
      request(`/api/stacks/${id}/stop`, { method: 'POST' }),
    restartStack: (id) =>
      request(`/api/stacks/${id}/restart`, { method: 'POST' }),
    registries: () => request('/api/registries'),
    registry: (id) => request(`/api/registries/${id}`),
    createRegistry: (payload) =>
      request('/api/registries', { method: 'POST', body: JSON.stringify(payload) }),
    updateRegistry: (id, payload) =>
      request(`/api/registries/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
    deleteRegistry: (id) =>
      request(`/api/registries/${id}`, { method: 'DELETE' }),
    registryRepos: (id, q = '', n = 50) =>
      request(`/api/registries/${id}/repositories?q=${encodeURIComponent(q)}&n=${n}`),
    registryTags: (id, repo) =>
      request(`/api/registries/${id}/tags?repo=${encodeURIComponent(repo)}`),
    registryPull: (id, Repository, Tag = 'latest') =>
      request(`/api/registries/${id}/pull`, {
        method: 'POST',
        body: JSON.stringify({ Repository, Tag }),
      }),
    pingRegistry: (id) => request(`/api/registries/${id}/ping`),
    volumeBase: (name) => {
      const id = getEndpointId();
      if (!Number.isFinite(id) || id < 1) {
        throw new Error('Choisissez un nœud pour explorer ce volume');
      }
      return `/api/endpoints/${id}/volumes/${encodeURIComponent(name)}`;
    },
    volumeBrowse: (name, path = '/') =>
      request(`${Api.volumeBase(name)}/browse?path=${encodeURIComponent(path)}`),
    volumeFile: (name, path) =>
      request(`${Api.volumeBase(name)}/file?path=${encodeURIComponent(path)}`),
    volumeWriteFile: (name, Path, opts = {}) =>
      request(`${Api.volumeBase(name)}/file`, {
        method: 'POST',
        body: JSON.stringify({
          Path,
          Content: opts.Content ?? '',
          Encoding: opts.Encoding || 'text',
          CreateOnly: opts.CreateOnly === undefined ? true : !!opts.CreateOnly,
        }),
      }),
    /** Binary upload (File/Blob/ArrayBuffer) — up to 300 Mo. */
    volumeUploadFile: (name, Path, blob, opts = {}) => {
      const q = new URLSearchParams({ path: Path });
      if (opts.CreateOnly) q.set('createOnly', '1');
      return request(`${Api.volumeBase(name)}/upload?${q.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: blob,
        raw: true,
      });
    },
    volumeMkdir: (name, Path) =>
      request(`${Api.volumeBase(name)}/mkdir`, {
        method: 'POST',
        body: JSON.stringify({ Path }),
      }),
    volumeRename: (name, From, To) =>
      request(`${Api.volumeBase(name)}/rename`, {
        method: 'POST',
        body: JSON.stringify({ From, To }),
      }),
    volumeDeleteEntry: (name, Path) =>
      request(`${Api.volumeBase(name)}/entry?path=${encodeURIComponent(Path)}`, {
        method: 'DELETE',
      }),
    volumeDownloadUrl: (name, path) =>
      `${Api.volumeBase(name)}/download?path=${encodeURIComponent(path)}`,
    teams: (detail = true) =>
      request(detail ? '/api/teams?detail=1' : '/api/teams'),
    team: (id) => request(`/api/teams/${id}`),
    createTeam: (payload) =>
      request('/api/teams', { method: 'POST', body: JSON.stringify(payload) }),
    updateTeam: (id, payload) =>
      request(`/api/teams/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
    deleteTeam: (id) => request(`/api/teams/${id}`, { method: 'DELETE' }),
    addTeamMember: (teamId, UserId) =>
      request(`/api/teams/${teamId}/members`, { method: 'POST', body: JSON.stringify({ UserId }) }),
    removeTeamMember: (teamId, userId) =>
      request(`/api/teams/${teamId}/members/${userId}`, { method: 'DELETE' }),
    acls: (endpointId) => {
      const q = endpointId != null ? `?endpointId=${encodeURIComponent(endpointId)}` : '';
      return request(`/api/acls${q}`);
    },
    upsertAcl: (payload) =>
      request('/api/acls', { method: 'POST', body: JSON.stringify(payload) }),
    deleteAcl: (id) => request(`/api/acls/${id}`, { method: 'DELETE' }),
    schedules: (opts = {}) => {
      const q = new URLSearchParams();
      if (opts.stackId != null) q.set('stackId', String(opts.stackId));
      if (opts.endpointId != null) q.set('endpointId', String(opts.endpointId));
      const qs = q.toString();
      return request(`/api/schedules${qs ? '?' + qs : ''}`);
    },
    createSchedule: (payload) =>
      request('/api/schedules', { method: 'POST', body: JSON.stringify(payload) }),
    updateSchedule: (id, payload) =>
      request(`/api/schedules/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
    deleteSchedule: (id) => request(`/api/schedules/${id}`, { method: 'DELETE' }),
    runSchedule: (id) => request(`/api/schedules/${id}/run`, { method: 'POST', body: '{}' }),
    imageScans: (endpointId) =>
      request(`/api/endpoints/${endpointId}/images/scans`),
    imageScan: (endpointId, opts = {}) => {
      const q = new URLSearchParams();
      if (opts.ref) q.set('ref', opts.ref);
      if (opts.digest) q.set('digest', opts.digest);
      return request(`/api/endpoints/${endpointId}/images/scan?${q.toString()}`);
    },
    scanImage: (endpointId, payload) =>
      request(`/api/endpoints/${endpointId}/images/scan`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    /** Soft CVE check — never blocks deploy; Status=skipped on Trivy failure. */
    adviseImages: (endpointId, payload) =>
      request(`/api/endpoints/${endpointId}/images/advise`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
  };
})();
