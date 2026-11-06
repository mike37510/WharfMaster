const Api = (() => {
  const TOKEN_KEY = 'dm_jwt';
  const ENDPOINT_ID = 1;

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }

  function setToken(token) {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
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

  const docker = (path, options = {}) =>
    request(`/api/endpoints/${ENDPOINT_ID}/docker${path}`, options);

  return {
    ENDPOINT_ID,
    getToken,
    setToken,
    request,
    docker,
    status: () => request('/api/status'),
    host: () => request('/api/system/host'),
    adminCheck: () => request('/api/users/admin/check'),
    adminInit: (Username, Password) =>
      request('/api/users/admin/init', { method: 'POST', body: JSON.stringify({ Username, Password }) }),
    auth: (Username, Password) =>
      request('/api/auth', { method: 'POST', body: JSON.stringify({ Username, Password }) }),
    me: () => request('/api/users/me'),
    settings: () => request('/api/settings'),
    updateSettings: (payload) =>
      request('/api/settings', { method: 'PUT', body: JSON.stringify(payload) }),
    users: () => request('/api/users'),
    createUser: (Username, Password, Role = 2) =>
      request('/api/users', { method: 'POST', body: JSON.stringify({ Username, Password, Role }) }),
    deleteUser: (id) => request(`/api/users/${id}`, { method: 'DELETE' }),
    changePassword: (id, payload) =>
      request(`/api/users/${id}/passwd`, { method: 'PUT', body: JSON.stringify(payload) }),
    endpoints: () => request('/api/endpoints'),
    containerLogs: (id, tail = 300) =>
      request(`/api/endpoints/${ENDPOINT_ID}/containers/${encodeURIComponent(id)}/logs?tail=${tail}&timestamps=true`, { text: true }),
    containerExec: (id, command, shell = '/bin/sh', cwd = '') =>
      request(`/api/endpoints/${ENDPOINT_ID}/containers/${encodeURIComponent(id)}/exec`, {
        method: 'POST',
        body: JSON.stringify({ command, shell, cwd }),
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
    stacks: () => request(`/api/stacks?endpointId=${ENDPOINT_ID}`),
    stack: (id) => request(`/api/stacks/${id}`),
    stackFile: (id) => request(`/api/stacks/${id}/file`),
    createStack: (Name, StackFileContent, Env = []) =>
      request(`/api/stacks/create/standalone/string?endpointId=${ENDPOINT_ID}`, {
        method: 'POST',
        body: JSON.stringify({ Name, StackFileContent, Env }),
      }),
    updateStack: (id, StackFileContent, Env = []) =>
      request(`/api/stacks/${id}?endpointId=${ENDPOINT_ID}`, {
        method: 'PUT',
        body: JSON.stringify({ StackFileContent, Env, prune: true }),
      }),
    deleteStack: (id) =>
      request(`/api/stacks/${id}?endpointId=${ENDPOINT_ID}`, { method: 'DELETE' }),
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
    volumeBrowse: (name, path = '/') =>
      request(`/api/volumes/${encodeURIComponent(name)}/browse?path=${encodeURIComponent(path)}`),
    volumeFile: (name, path) =>
      request(`/api/volumes/${encodeURIComponent(name)}/file?path=${encodeURIComponent(path)}`),
    volumeWriteFile: (name, Path, opts = {}) =>
      request(`/api/volumes/${encodeURIComponent(name)}/file`, {
        method: 'POST',
        body: JSON.stringify({ Path, Content: opts.Content ?? '', Encoding: opts.Encoding || 'text', CreateOnly: opts.CreateOnly !== false }),
      }),
    volumeMkdir: (name, Path) =>
      request(`/api/volumes/${encodeURIComponent(name)}/mkdir`, {
        method: 'POST',
        body: JSON.stringify({ Path }),
      }),
    volumeRename: (name, From, To) =>
      request(`/api/volumes/${encodeURIComponent(name)}/rename`, {
        method: 'POST',
        body: JSON.stringify({ From, To }),
      }),
    volumeDeleteEntry: (name, Path) =>
      request(`/api/volumes/${encodeURIComponent(name)}/entry?path=${encodeURIComponent(Path)}`, {
        method: 'DELETE',
      }),
    volumeDownloadUrl: (name, path) =>
      `/api/volumes/${encodeURIComponent(name)}/download?path=${encodeURIComponent(path)}`,
  };
})();
