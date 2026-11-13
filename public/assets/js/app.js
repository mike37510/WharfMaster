(() => {
  // public/assets/js/src/bag.js
  var bag = {};

  // public/assets/js/src/api.js
  var Api = /* @__PURE__ */ (() => {
    const TOKEN_KEY = "dm_jwt";
    const ENDPOINT_KEY = "dm_endpoint_id";
    function getToken() {
      return localStorage.getItem(TOKEN_KEY) || "";
    }
    function setToken(token) {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    }
    function getEndpointId() {
      const n = parseInt(localStorage.getItem(ENDPOINT_KEY) || "1", 10);
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
      const headers = Object.assign({ Accept: "application/json" }, options.headers || {});
      const token = getToken();
      if (token) headers.Authorization = "Bearer " + token;
      if (options.body && !(options.body instanceof FormData) && !headers["Content-Type"] && !options.raw) {
        headers["Content-Type"] = "application/json";
      }
      const res = await fetch(path, Object.assign({}, options, { headers }));
      const text = await res.text();
      let data = null;
      if (options.text) {
        data = text;
      } else if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      if (!res.ok) {
        const msg = data && data.message || text || res.statusText;
        const err = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return data;
    }
    const dockerOn = (endpointId, path, options = {}) => {
      const id = parseInt(String(endpointId), 10);
      if (!Number.isFinite(id) || id < 1) {
        return Promise.reject(new Error("Choisissez un n\u0153ud pour cette action"));
      }
      return request(`/api/endpoints/${id}/docker${path}`, options);
    };
    const docker = (path, options = {}) => {
      if (isAllEndpoints()) {
        return Promise.reject(new Error("Choisissez un n\u0153ud pour cette action"));
      }
      return dockerOn(getEndpointId(), path, options);
    };
    return {
      get ENDPOINT_ID() {
        return getEndpointId();
      },
      getEndpointId,
      setEndpointId,
      isAllEndpoints,
      getToken,
      setToken,
      request,
      docker,
      dockerOn,
      status: () => request("/api/status"),
      host: () => request("/api/system/host"),
      metricsHistory: (scope = "ep:1", opts = {}) => {
        const q = new URLSearchParams({ scope: String(scope || "ep:1") });
        if (opts.hours != null) q.set("hours", String(opts.hours));
        else q.set("days", String(opts.days != null ? opts.days : 90));
        q.set("points", String(opts.points != null ? opts.points : 180));
        if (opts.until != null && Number(opts.until) > 0) q.set("until", String(Math.floor(Number(opts.until))));
        return request(`/api/metrics/history?${q.toString()}`);
      },
      metricsSample: (payload) => request("/api/metrics/sample", { method: "POST", body: JSON.stringify(payload) }),
      adminCheck: () => request("/api/users/admin/check"),
      adminInit: (Username, Password) => request("/api/users/admin/init", { method: "POST", body: JSON.stringify({ Username, Password }) }),
      auth: (Username, Password) => request("/api/auth", { method: "POST", body: JSON.stringify({ Username, Password }) }),
      me: () => request("/api/users/me"),
      settings: () => request("/api/settings"),
      updateSettings: (payload) => request("/api/settings", { method: "PUT", body: JSON.stringify(payload) }),
      diagnostics: () => request("/api/system/diagnostics"),
      /** Full ZIP backup (admin). Triggers browser download. */
      downloadBackup: async (format = "zip") => {
        const q = format && format !== "zip" ? `?format=${encodeURIComponent(format)}` : "";
        const headers = { Accept: format === "sqlite" ? "application/x-sqlite3" : "application/zip" };
        const token = getToken();
        if (token) headers.Authorization = "Bearer " + token;
        const res = await fetch(`/api/backup${q}`, { headers });
        if (!res.ok) {
          let msg = res.statusText;
          try {
            const data = await res.json();
            if (data && data.message) msg = data.message;
          } catch (_) {
            try {
              msg = await res.text() || msg;
            } catch (__) {
            }
          }
          const err = new Error(msg || "Backup impossible");
          err.status = res.status;
          throw err;
        }
        const blob = await res.blob();
        const cd = res.headers.get("Content-Disposition") || "";
        const m = cd.match(/filename="?([^";]+)"?/i);
        const filename = m && m[1] || `wharfmaster-backup.${format === "sqlite" ? "sqlite" : "zip"}`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2e3);
        return { filename, size: blob.size };
      },
      users: () => request("/api/users"),
      usersDirectory: () => request("/api/users/directory"),
      createUser: (Username, Password, Role = 2) => request("/api/users", { method: "POST", body: JSON.stringify({ Username, Password, Role }) }),
      deleteUser: (id) => request(`/api/users/${id}`, { method: "DELETE" }),
      changePassword: (id, payload) => request(`/api/users/${id}/passwd`, { method: "PUT", body: JSON.stringify(payload) }),
      listUserTokens: (id) => request(`/api/users/${id}/tokens`),
      createUserToken: (id, payload) => request(`/api/users/${id}/tokens`, { method: "POST", body: JSON.stringify(payload) }),
      revokeUserToken: (id, tid) => request(`/api/users/${id}/tokens/${tid}`, { method: "DELETE" }),
      listShares: (type, endpointId, key) => {
        const q = new URLSearchParams({
          type: String(type),
          endpointId: String(endpointId),
          key: String(key)
        });
        return request(`/api/shares?${q.toString()}`);
      },
      createShare: (payload) => request("/api/shares", { method: "POST", body: JSON.stringify(payload) }),
      deleteShare: (id) => request(`/api/shares/${id}`, { method: "DELETE" }),
      endpoints: () => request("/api/endpoints"),
      nodes: () => request("/api/nodes"),
      joinTokenMeta: () => request("/api/nodes/join-token"),
      createJoinToken: (payload = {}) => request("/api/nodes/join-token", { method: "POST", body: JSON.stringify(payload) }),
      rotateJoinToken: (payload = {}) => request("/api/nodes/join-token/rotate", { method: "POST", body: JSON.stringify(payload) }),
      /** ZIP pack (Dockerfile, compose, sources, .env) for manual agent deploy. */
      downloadAgentBundle: async (payload = {}) => {
        const headers = {
          Accept: "application/zip",
          "Content-Type": "application/json"
        };
        const token = getToken();
        if (token) headers.Authorization = "Bearer " + token;
        const res = await fetch("/api/nodes/agent-bundle", {
          method: "POST",
          headers,
          body: JSON.stringify(payload)
        });
        if (!res.ok) {
          let msg = res.statusText;
          try {
            const data = await res.json();
            if (data && data.message) msg = data.message;
          } catch (_) {
            try {
              msg = await res.text() || msg;
            } catch (__) {
            }
          }
          const err = new Error(msg || "T\xE9l\xE9chargement pack agent impossible");
          err.status = res.status;
          throw err;
        }
        const blob = await res.blob();
        const cd = res.headers.get("Content-Disposition") || "";
        const m = cd.match(/filename="?([^";]+)"?/i);
        const nameHint = String(payload.NodeName || payload.nodeName || "agent").replace(/[^\w.-]+/g, "-");
        const filename = m && m[1] || `wharfmaster-agent-${nameHint}.zip`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2e3);
        return { filename, size: blob.size };
      },
      unlinkNode: (id) => request(`/api/nodes/${id}`, { method: "DELETE" }),
      updateNode: (id, payload) => request(`/api/nodes/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
      disableNode: (id) => request(`/api/nodes/${id}/disable`, { method: "POST", body: "{}" }),
      enableNode: (id) => request(`/api/nodes/${id}/enable`, { method: "POST", body: "{}" }),
      pingNode: (id) => request(`/api/nodes/${id}/ping`, { method: "POST", body: "{}" }),
      audit: (opts = {}) => {
        const q = new URLSearchParams();
        q.set("limit", String(opts.limit ?? 100));
        q.set("offset", String(opts.offset ?? 0));
        if (opts.action) q.set("action", opts.action);
        return request(`/api/audit?${q.toString()}`);
      },
      containerLogs: (id, opts = {}) => {
        const q = new URLSearchParams();
        const tail = opts.tail ?? 300;
        q.set("tail", String(tail));
        q.set("timestamps", opts.timestamps === false ? "false" : "true");
        q.set("stdout", opts.stdout === false ? "false" : "true");
        q.set("stderr", opts.stderr === false ? "false" : "true");
        q.set("annotate", opts.annotate === false ? "false" : "true");
        if (opts.since != null && Number(opts.since) > 0) q.set("since", String(Math.floor(Number(opts.since))));
        return request(
          `/api/endpoints/${getEndpointId()}/containers/${encodeURIComponent(id)}/logs?${q.toString()}`,
          { text: true }
        );
      },
      containerExec: (id, command, shell = "/bin/sh", cwd = "", opts = {}) => request(`/api/endpoints/${getEndpointId()}/containers/${encodeURIComponent(id)}/exec`, {
        method: "POST",
        body: JSON.stringify({
          command,
          shell,
          cwd,
          cols: opts.cols || 120,
          rows: opts.rows || 40,
          tty: opts.tty !== false,
          timeout: opts.timeout || 45
        }),
        signal: opts.signal
      }),
      createConsoleSession: (id, opts = {}) => request(`/api/endpoints/${getEndpointId()}/containers/${encodeURIComponent(id)}/console`, {
        method: "POST",
        body: JSON.stringify({
          shell: opts.shell || "/bin/sh",
          cols: opts.cols || 120,
          rows: opts.rows || 40,
          user: opts.user || void 0
        })
      }),
      resizeConsole: (execId, h, w, endpointId = null) => {
        const ep = endpointId != null ? endpointId : getEndpointId();
        return request(
          `/api/endpoints/${ep}/console/${encodeURIComponent(execId)}/resize?h=${encodeURIComponent(h)}&w=${encodeURIComponent(w)}`,
          { method: "POST" }
        );
      },
      containerUpdates: (refresh = false) => request(
        `/api/endpoints/${getEndpointId()}/containers/updates${refresh ? "?refresh=1" : ""}`
      ),
      containerUpdateStatus: (id, refresh = false) => request(
        `/api/endpoints/${getEndpointId()}/containers/${encodeURIComponent(id)}/updates${refresh ? "?refresh=1" : ""}`
      ),
      /** Pull image + recreate container (standalone). Prefer stack upgrade when Compose-managed. */
      updateContainerImage: (id, pull = true) => request(
        `/api/endpoints/${getEndpointId()}/containers/${encodeURIComponent(id)}/update`,
        { method: "POST", body: JSON.stringify({ Pull: !!pull }) }
      ),
      buildImage: (payload) => request("/api/images/build", { method: "POST", body: JSON.stringify(payload) }),
      searchImages: (q) => request(`/api/images/search?q=${encodeURIComponent(q)}`),
      imageTags: (repo) => request(`/api/images/tags?repo=${encodeURIComponent(repo)}`),
      dockerfiles: () => request("/api/dockerfiles"),
      dockerfile: (name) => request(`/api/dockerfiles/${encodeURIComponent(name)}`),
      saveDockerfile: (Name, Content) => request("/api/dockerfiles", { method: "POST", body: JSON.stringify({ Name, Content }) }),
      deleteDockerfile: (name) => request(`/api/dockerfiles/${encodeURIComponent(name)}`, { method: "DELETE" }),
      stacks: () => request(`/api/stacks?endpointId=${getEndpointId()}`),
      stackUpdates: (refresh = false) => request(`/api/stacks/updates?endpointId=${getEndpointId()}${refresh ? "&refresh=1" : ""}`),
      stackUpdate: (id, refresh = false) => request(`/api/stacks/${id}/updates${refresh ? "?refresh=1" : ""}`),
      stack: (id) => request(`/api/stacks/${id}`),
      stackFile: (id) => request(`/api/stacks/${id}/file`),
      /** Download stack ZIP (compose + .env + volume/bind data). */
      downloadStackExport: async (id) => {
        const token = getToken();
        if (!token) throw new Error("Session expir\xE9e \u2014 reconnectez-vous");
        const q = new URLSearchParams({ access_token: token });
        const url = `/api/stacks/${encodeURIComponent(id)}/export?${q.toString()}`;
        const probe = await fetch(url, {
          method: "GET",
          headers: {
            Accept: "application/zip",
            Authorization: "Bearer " + token
          }
        });
        if (!probe.ok) {
          let msg = probe.statusText;
          try {
            const data = await probe.json();
            if (data && data.message) msg = data.message;
          } catch (_) {
            try {
              msg = await probe.text() || msg;
            } catch (__) {
            }
          }
          const err = new Error(msg || "Export impossible");
          err.status = probe.status;
          throw err;
        }
        const cd = probe.headers.get("Content-Disposition") || "";
        const m = cd.match(/filename="?([^";]+)"?/i);
        const filename = m && m[1] || `stack-${id}-export.zip`;
        const ct = (probe.headers.get("Content-Type") || "").toLowerCase();
        if (!ct.includes("zip") && !ct.includes("octet-stream")) {
          let msg = "R\xE9ponse d\u2019export invalide";
          try {
            const data = await probe.json();
            if (data && data.message) msg = data.message;
          } catch (_) {
          }
          throw new Error(msg);
        }
        const blob = await probe.blob();
        if (!blob || blob.size < 22) {
          throw new Error("Archive vide ou invalide");
        }
        if (window.navigator && typeof window.navigator.msSaveOrOpenBlob === "function") {
          window.navigator.msSaveOrOpenBlob(blob, filename);
          return { filename, size: blob.size };
        }
        const obj = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = obj;
        a.download = filename;
        a.rel = "noopener";
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          a.remove();
          URL.revokeObjectURL(obj);
        }, 1500);
        return { filename, size: blob.size };
      },
      createStack: (Name, StackFileContent, Env = [], PullImages = false) => request(`/api/stacks/create/standalone/string?endpointId=${getEndpointId()}`, {
        method: "POST",
        body: JSON.stringify({ Name, StackFileContent, Env, PullImages: !!PullImages })
      }),
      updateStack: (id, StackFileContent, Env = [], PullImages = false) => request(`/api/stacks/${id}?endpointId=${getEndpointId()}`, {
        method: "PUT",
        body: JSON.stringify({ StackFileContent, Env, prune: true, PullImages: !!PullImages })
      }),
      deleteStack: (id) => request(`/api/stacks/${id}?endpointId=${getEndpointId()}`, { method: "DELETE" }),
      startStack: (id) => request(`/api/stacks/${id}/start`, { method: "POST" }),
      stopStack: (id) => request(`/api/stacks/${id}/stop`, { method: "POST" }),
      restartStack: (id) => request(`/api/stacks/${id}/restart`, { method: "POST" }),
      registries: () => request("/api/registries"),
      registry: (id) => request(`/api/registries/${id}`),
      createRegistry: (payload) => request("/api/registries", { method: "POST", body: JSON.stringify(payload) }),
      updateRegistry: (id, payload) => request(`/api/registries/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
      deleteRegistry: (id) => request(`/api/registries/${id}`, { method: "DELETE" }),
      registryRepos: (id, q = "", n = 50) => request(`/api/registries/${id}/repositories?q=${encodeURIComponent(q)}&n=${n}`),
      registryTags: (id, repo) => request(`/api/registries/${id}/tags?repo=${encodeURIComponent(repo)}`),
      registryPull: (id, Repository, Tag = "latest") => request(`/api/registries/${id}/pull`, {
        method: "POST",
        body: JSON.stringify({ Repository, Tag })
      }),
      pingRegistry: (id) => request(`/api/registries/${id}/ping`),
      bindVolumes: () => request(`/api/endpoints/${getEndpointId()}/bind-volumes`),
      createBindVolume: (Name, HostPath) => request(`/api/endpoints/${getEndpointId()}/bind-volumes`, {
        method: "POST",
        body: JSON.stringify({ Name, HostPath })
      }),
      deleteBindVolume: (id) => request(`/api/endpoints/${getEndpointId()}/bind-volumes/${encodeURIComponent(id)}`, {
        method: "DELETE"
      }),
      volumeBase: (name) => {
        const id = getEndpointId();
        if (!Number.isFinite(id) || id < 1) {
          throw new Error("Choisissez un n\u0153ud pour explorer ce volume");
        }
        return `/api/endpoints/${id}/volumes/${encodeURIComponent(name)}`;
      },
      volumeBrowse: (name, path = "/") => request(`${Api.volumeBase(name)}/browse?path=${encodeURIComponent(path)}`),
      volumeFile: (name, path) => request(`${Api.volumeBase(name)}/file?path=${encodeURIComponent(path)}`),
      volumeWriteFile: (name, Path, opts = {}) => request(`${Api.volumeBase(name)}/file`, {
        method: "POST",
        body: JSON.stringify({
          Path,
          Content: opts.Content ?? "",
          Encoding: opts.Encoding || "text",
          CreateOnly: opts.CreateOnly === void 0 ? true : !!opts.CreateOnly
        })
      }),
      /** Binary upload (File/Blob/ArrayBuffer) — up to 300 Mo. */
      volumeUploadFile: (name, Path, blob, opts = {}) => {
        const q = new URLSearchParams({ path: Path });
        if (opts.CreateOnly) q.set("createOnly", "1");
        return request(`${Api.volumeBase(name)}/upload?${q.toString()}`, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: blob,
          raw: true
        });
      },
      volumeMkdir: (name, Path) => request(`${Api.volumeBase(name)}/mkdir`, {
        method: "POST",
        body: JSON.stringify({ Path })
      }),
      volumeRename: (name, From, To) => request(`${Api.volumeBase(name)}/rename`, {
        method: "POST",
        body: JSON.stringify({ From, To })
      }),
      volumeDeleteEntry: (name, Path) => request(`${Api.volumeBase(name)}/entry?path=${encodeURIComponent(Path)}`, {
        method: "DELETE"
      }),
      volumeDownloadUrl: (name, path) => `${Api.volumeBase(name)}/download?path=${encodeURIComponent(path)}`,
      teams: (detail = true) => request(detail ? "/api/teams?detail=1" : "/api/teams"),
      team: (id) => request(`/api/teams/${id}`),
      createTeam: (payload) => request("/api/teams", { method: "POST", body: JSON.stringify(payload) }),
      updateTeam: (id, payload) => request(`/api/teams/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
      deleteTeam: (id) => request(`/api/teams/${id}`, { method: "DELETE" }),
      addTeamMember: (teamId, UserId) => request(`/api/teams/${teamId}/members`, { method: "POST", body: JSON.stringify({ UserId }) }),
      removeTeamMember: (teamId, userId) => request(`/api/teams/${teamId}/members/${userId}`, { method: "DELETE" }),
      acls: (endpointId) => {
        const q = endpointId != null ? `?endpointId=${encodeURIComponent(endpointId)}` : "";
        return request(`/api/acls${q}`);
      },
      upsertAcl: (payload) => request("/api/acls", { method: "POST", body: JSON.stringify(payload) }),
      deleteAcl: (id) => request(`/api/acls/${id}`, { method: "DELETE" }),
      schedules: (opts = {}) => {
        const q = new URLSearchParams();
        if (opts.stackId != null) q.set("stackId", String(opts.stackId));
        if (opts.endpointId != null) q.set("endpointId", String(opts.endpointId));
        const qs = q.toString();
        return request(`/api/schedules${qs ? "?" + qs : ""}`);
      },
      createSchedule: (payload) => request("/api/schedules", { method: "POST", body: JSON.stringify(payload) }),
      updateSchedule: (id, payload) => request(`/api/schedules/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
      deleteSchedule: (id) => request(`/api/schedules/${id}`, { method: "DELETE" }),
      runSchedule: (id) => request(`/api/schedules/${id}/run`, { method: "POST", body: "{}" }),
      imageScans: (endpointId) => request(`/api/endpoints/${endpointId}/images/scans`),
      /** Soft batch ensure — cache TTL same as image update checks (24 h). */
      ensureImageScans: (endpointId, payload) => request(`/api/endpoints/${endpointId}/images/scans/ensure`, {
        method: "POST",
        body: JSON.stringify(payload)
      }),
      imageScan: (endpointId, opts = {}) => {
        const q = new URLSearchParams();
        if (opts.ref) q.set("ref", opts.ref);
        if (opts.digest) q.set("digest", opts.digest);
        return request(`/api/endpoints/${endpointId}/images/scan?${q.toString()}`);
      },
      scanImage: (endpointId, payload) => request(`/api/endpoints/${endpointId}/images/scan`, {
        method: "POST",
        body: JSON.stringify(payload)
      }),
      /** Soft CVE check — never blocks deploy; Status=skipped on Trivy failure. */
      adviseImages: (endpointId, payload) => request(`/api/endpoints/${endpointId}/images/advise`, {
        method: "POST",
        body: JSON.stringify(payload)
      })
    };
  })();

  // public/assets/js/src/core.js
  function installCore() {
    bag.Api = Api;
    bag.root = document.getElementById("app");
    bag.THEME_KEY = "dm_theme";
    bag.SIDEBAR_KEY = "wm_sidebar_collapsed";
    bag.THEMES = ["dark", "aurora", "beacon", "light"];
    bag.readTheme = function readTheme() {
      const saved = localStorage.getItem(bag.THEME_KEY);
      if (bag.THEMES.includes(saved)) return saved;
      return "aurora";
    };
    bag.applyTheme = function applyTheme(theme) {
      const t = bag.THEMES.includes(theme) ? theme : "aurora";
      document.documentElement.setAttribute("data-theme", t);
      localStorage.setItem(bag.THEME_KEY, t);
      return t;
    };
    bag.themeToggleLabel = function themeToggleLabel(theme) {
      if (theme === "light") return "\u263E";
      if (theme === "aurora") return "\u2726";
      if (theme === "beacon") return "\u2691";
      return "\u2600";
    };
    bag.themeToggleTitle = function themeToggleTitle(theme) {
      if (theme === "light") return "Th\xE8me clair \u2014 cliquer pour basculer";
      if (theme === "aurora") return "Th\xE8me Harbor Glass \u2014 cliquer pour basculer";
      if (theme === "beacon") return "Th\xE8me Beacon \u2014 cliquer pour basculer";
      return "Th\xE8me sombre \u2014 cliquer pour basculer";
    };
    bag.readSidebarCollapsed = function readSidebarCollapsed() {
      return localStorage.getItem(bag.SIDEBAR_KEY) === "1";
    };
    bag.applySidebarCollapsed = function applySidebarCollapsed(collapsed) {
      const on = !!collapsed;
      document.documentElement.setAttribute("data-sidebar", on ? "collapsed" : "expanded");
      localStorage.setItem(bag.SIDEBAR_KEY, on ? "1" : "0");
      return on;
    };
    bag.applyTheme(bag.readTheme());
    bag.applySidebarCollapsed(bag.readSidebarCollapsed());
    bag.state = {
      user: null,
      route: location.hash.slice(1) || "dashboard",
      error: "",
      filters: {
        containers: "",
        images: "",
        volumes: "",
        networks: "",
        stacks: "",
        registries: "",
        users: "",
        teams: "",
        dashboard: ""
      },
      pages: {
        containers: 1,
        images: 1,
        volumes: 1,
        networks: 1,
        stacks: 1
      },
      sorts: {
        containers: { key: "name", dir: "asc" },
        images: { key: "name", dir: "asc" },
        volumes: { key: "name", dir: "asc" },
        networks: { key: "name", dir: "asc" },
        stacks: { key: "name", dir: "asc" }
      },
      pageSize: 20,
      theme: bag.readTheme(),
      sidebarCollapsed: bag.readSidebarCollapsed(),
      containerTab: "overview",
      logTimer: null,
      statsTimer: null,
      containerStatsTimer: null,
      term: null,
      publicUrl: "",
      portsHostUrl: "",
      metricsChartHours: 72,
      metricsRetentionDays: 90,
      trivyEnabled: true,
      dashFilter: "all",
      engineVersion: "",
      appVersion: "",
      endpoints: [],
      endpointId: 1,
      alerts: [],
      dockerOnline: true,
      alertTimer: null,
      metricTimer: null,
      dismissedAlerts: new Set(JSON.parse(localStorage.getItem("dm_dismissed_alerts") || "[]"))
    };
    bag.metricCache = { scope: "", series: [] };
    bag.toggleTheme = function toggleTheme() {
      const cur = bag.THEMES.indexOf(bag.state.theme);
      const next = bag.THEMES[(cur >= 0 ? cur + 1 : 0) % bag.THEMES.length];
      bag.state.theme = bag.applyTheme(next);
      const btn = document.getElementById("theme-toggle");
      if (btn) {
        btn.textContent = bag.themeToggleLabel(bag.state.theme);
        btn.title = bag.themeToggleTitle(bag.state.theme);
      }
    };
    bag.toggleSidebar = function toggleSidebar() {
      bag.state.sidebarCollapsed = bag.applySidebarCollapsed(!bag.state.sidebarCollapsed);
      const aside = document.querySelector(".sidebar");
      if (aside) aside.classList.toggle("is-collapsed", bag.state.sidebarCollapsed);
      const btn = document.getElementById("sidebar-toggle");
      if (btn) {
        btn.title = bag.state.sidebarCollapsed ? "Afficher le menu" : "R\xE9duire le menu";
        btn.setAttribute("aria-label", btn.title);
        btn.setAttribute("aria-expanded", bag.state.sidebarCollapsed ? "false" : "true");
        btn.innerHTML = `<span class="btn-ico">${bag.ico(bag.state.sidebarCollapsed ? "panel-right" : "panel-left")}</span>`;
      }
    };
    document.addEventListener("click", (e) => {
      const t = e.target.closest("#theme-toggle");
      if (t) {
        e.preventDefault();
        bag.toggleTheme();
      }
      const s = e.target.closest("#sidebar-toggle");
      if (s) {
        e.preventDefault();
        bag.toggleSidebar();
      }
    });
    document.addEventListener("change", (e) => {
      const sel = e.target.closest("#endpoint-select");
      if (!sel) return;
      const id = parseInt(sel.value, 10);
      if (!Number.isFinite(id) || id < 0) return;
      bag.Api.setEndpointId(id);
      bag.state.endpointId = id;
      bag.route();
    });
    bag.isAllNodes = function isAllNodes() {
      return Number(bag.state.endpointId) === 0 || bag.Api.isAllEndpoints();
    };
    bag.activeEndpoints = function activeEndpoints() {
      return (bag.state.endpoints || []).filter((e) => {
        const id = Number(e.Id ?? e.id);
        if (!Number.isFinite(id) || id < 1) return false;
        return Number(e.Status) !== 0;
      });
    };
    bag.refreshEndpointsList = async function refreshEndpointsList() {
      try {
        const list = await bag.Api.endpoints();
        if (Array.isArray(list) && list.length) bag.state.endpoints = list;
      } catch (_) {
      }
    };
    bag.sampleAcrossNodes = function sampleAcrossNodes(items, limit = 24) {
      const byNode = /* @__PURE__ */ new Map();
      (items || []).forEach((it) => {
        const key = String(it._nodeId ?? it._nodeName ?? "?");
        if (!byNode.has(key)) byNode.set(key, []);
        byNode.get(key).push(it);
      });
      const queues = [...byNode.values()];
      const out = [];
      let i = 0;
      while (out.length < limit && queues.some((q) => q.length)) {
        const q = queues[i % queues.length];
        if (q.length) out.push(q.shift());
        i += 1;
      }
      return out;
    };
    bag.dockerAll = async function dockerAll(path, { pick, refresh = true } = {}) {
      if (refresh) await bag.refreshEndpointsList();
      const eps = bag.activeEndpoints();
      if (!eps.length) {
        return { items: [], results: [], failed: 0, okCount: 0, total: 0, perNode: [] };
      }
      const results = await Promise.all(eps.map(async (ep) => {
        const id = Number(ep.Id ?? ep.id);
        const name = ep.NodeName || ep.Name || String(id);
        try {
          const data = await bag.Api.dockerOn(id, path);
          return { ok: true, id, name, data };
        } catch (err) {
          return { ok: false, id, name, error: err, message: err?.message || String(err) };
        }
      }));
      const failed = results.filter((r) => !r.ok).length;
      const ok = results.filter((r) => r.ok);
      let items = [];
      const perNode = [];
      if (typeof pick === "function") {
        ok.forEach((r) => {
          const arr = pick(r.data) || [];
          const list = Array.isArray(arr) ? arr : [];
          perNode.push({ id: r.id, name: r.name, count: list.length });
          list.forEach((item) => {
            items.push(Object.assign({}, item, { _nodeId: r.id, _nodeName: r.name }));
          });
        });
      } else {
        ok.forEach((r) => {
          const arr = Array.isArray(r.data) ? r.data : [];
          perNode.push({ id: r.id, name: r.name, count: arr.length });
          arr.forEach((item) => {
            items.push(Object.assign({}, item, { _nodeId: r.id, _nodeName: r.name }));
          });
        });
      }
      items.sort((a, b) => String(a._nodeName || "").localeCompare(String(b._nodeName || ""), "fr"));
      return {
        items,
        results,
        failed,
        okCount: ok.length,
        total: eps.length,
        perNode,
        failedNames: results.filter((r) => !r.ok).map((r) => r.name)
      };
    };
    bag.requireSingleNodeMsg = function requireSingleNodeMsg() {
      return "Choisissez un n\u0153ud dans le s\xE9lecteur pour cette action.";
    };
    bag.pickNodeGuardHtml = function pickNodeGuardHtml() {
      if (!bag.isAllNodes()) return "";
      return `<div class="info-box" style="margin-bottom:12px">${bag.esc(bag.requireSingleNodeMsg())}</div>`;
    };
    bag.loadEndpoints = async function loadEndpoints() {
      try {
        const list = await bag.Api.endpoints();
        bag.state.endpoints = Array.isArray(list) ? list : [];
        const preferred = bag.Api.getEndpointId();
        if (preferred === 0 && bag.state.endpoints.length > 1) {
          bag.state.endpointId = 0;
          bag.Api.setEndpointId(0);
        } else {
          const exists = bag.state.endpoints.some((e) => Number(e.Id) === Number(preferred));
          bag.state.endpointId = exists ? preferred : Number(bag.state.endpoints[0]?.Id) || 1;
          bag.Api.setEndpointId(bag.state.endpointId);
        }
      } catch (_) {
        bag.state.endpoints = bag.state.endpoints || [];
        bag.state.endpointId = bag.Api.getEndpointId();
      }
    };
    bag.esc = function esc(s) {
      return String(s ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[c]);
    };
    bag.shortId = function shortId(id) {
      return String(id || "").replace(/^sha256:/, "").slice(0, 12);
    };
    bag.openResourceUsersModal = function openResourceUsersModal({ title, subtitle, users, extraCol }) {
      bag.closeAppModal();
      const host = bag.modalHost();
      const showNode = (users || []).some((c) => c._nodeName);
      const rows = (users || []).map((c) => {
        const name = c.Names && c.Names[0] ? c.Names[0].replace(/^\//, "") : bag.shortId(c.Id);
        const node = c._nodeName ? `<td class="muted">${bag.esc(c._nodeName)}</td>` : "";
        const extra = extraCol ? `<td class="mono cell-clip" title="${bag.esc(extraCol(c) || "")}">${bag.esc(extraCol(c) || "\u2014")}</td>` : "";
        return `<tr>
        ${node}
        <td><a class="res-user-link" href="#containers/${bag.esc(c.Id)}">${bag.esc(name)}</a></td>
        ${extra}
        <td>${bag.badge(c.State)}</td>
        <td class="muted cell-nowrap">${bag.esc(bag.formatUptime(c.Status))}</td>
      </tr>`;
      }).join("");
      const colCount = (showNode ? 1 : 0) + 1 + (extraCol ? 1 : 0) + 2;
      host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3>${bag.esc(title)}</h3>
              <p class="modal-sub mono">${bag.esc(subtitle || "")}</p>
            </div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">\u2715</button>
          </div>
          <div class="table-wrap" style="margin:0">
            <table class="data">
              <thead><tr>${showNode ? "<th>N\u0153ud</th>" : ""}<th>Nom</th>${extraCol ? "<th>D\xE9tail</th>" : ""}<th>\xC9tat</th><th>Statut</th></tr></thead>
              <tbody>${rows || `<tr><td colspan="${colCount}" class="empty">Aucun conteneur</td></tr>`}</tbody>
            </table>
          </div>
          <div class="actions-bar" style="margin-top:14px">
            <button type="button" class="btn" data-close-modal>Fermer</button>
          </div>
        </div>
      </div>`;
      bag.bindAppModalChrome();
      host.querySelectorAll("a.res-user-link").forEach((a) => {
        a.addEventListener("click", () => bag.closeAppModal());
      });
    };
    bag.stopTimers = function stopTimers() {
      if (bag.state.logTimer) {
        clearInterval(bag.state.logTimer);
        bag.state.logTimer = null;
      }
      if (bag.state.statsTimer) {
        clearInterval(bag.state.statsTimer);
        bag.state.statsTimer = null;
      }
      if (bag.state.term) {
        try {
          bag.state.term.dispose();
        } catch (_) {
        }
        bag.state.term = null;
      }
      if (typeof bag.stopContainerStatsPoll === "function") bag.stopContainerStatsPoll();
      bag.stopDashMetricSampler();
    };
    bag.formatUptime = function formatUptime(status) {
      const s = String(status || "");
      if (/^up\s+/i.test(s)) {
        const m = s.match(/up\s+(?:about\s+)?(.+)/i);
        if (!m) return s;
        return m[1].replace(/seconds?/ig, "s").replace(/minutes?/ig, "min").replace(/hours?/ig, "h").replace(/days?/ig, "j").replace(/weeks?/ig, "sem").replace(/months?/ig, "mois").replace(/an hour/ig, "1 h").replace(/a minute/ig, "1 min");
      }
      return "\u2014";
    };
    bag.computeStats = function computeStats(st, memTotal) {
      const cpuDelta = (st.cpu_stats?.cpu_usage?.total_usage || 0) - (st.precpu_stats?.cpu_usage?.total_usage || 0);
      const sysDelta = (st.cpu_stats?.system_cpu_usage || 0) - (st.precpu_stats?.system_cpu_usage || 0);
      const online = st.cpu_stats?.online_cpus || st.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
      let cpuPct = 0;
      if (sysDelta > 0) cpuPct = cpuDelta / sysDelta * online * 100;
      const memStats = st.memory_stats || {};
      const cache = Number(memStats.stats?.cache || memStats.stats?.inactive_file || 0) || 0;
      const rawUsage = Number(memStats.usage || 0) || 0;
      const usage = Math.max(0, rawUsage - cache);
      const limit = Number(memStats.limit || memTotal || 1) || 1;
      const memPct = usage / limit * 100;
      let netRx = 0;
      let netTx = 0;
      const nets = st.networks || {};
      Object.values(nets).forEach((n) => {
        if (!n || typeof n !== "object") return;
        netRx += Number(n.rx_bytes || 0) || 0;
        netTx += Number(n.tx_bytes || 0) || 0;
      });
      const pids = Number(st.pids_stats?.current || 0) || 0;
      return {
        cpuPct,
        memPct,
        memUsage: usage,
        memLimit: limit,
        netRx,
        netTx,
        pids,
        networks: nets,
        readAt: st.read || null
      };
    };
    bag.formatBitRate = function formatBitRate(bytesPerSec) {
      const v = Math.max(0, Number(bytesPerSec) || 0);
      if (v < 1024) return `${v.toFixed(0)} B/s`;
      if (v < 1024 ** 2) return `${(v / 1024).toFixed(1)} KB/s`;
      if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)} MB/s`;
      return `${(v / 1024 ** 3).toFixed(2)} GB/s`;
    };
    bag.hostBase = function hostBase(endpointId) {
      const normalize = (u) => String(u || "").trim().replace(/\/$/, "");
      const configured = normalize(bag.state.portsHostUrl);
      const manager = normalize(bag.state.publicUrl);
      const eid = endpointId != null ? Number(endpointId) : Number(bag.state.endpointId);
      if (Number.isFinite(eid) && eid > 0) {
        const ep = (bag.state.endpoints || []).find((e) => Number(e.Id) === eid);
        const nodeUrl = normalize(ep?.PublicURL);
        if (nodeUrl && (!manager || nodeUrl !== manager)) return nodeUrl;
      }
      if (configured) return configured;
      const { protocol, hostname } = window.location;
      return `${protocol}//${hostname}`;
    };
    bag.portHref = function portHref(pub, endpointId) {
      const base = bag.hostBase(endpointId);
      try {
        const u = new URL(base.includes("://") ? base : `https://${base}`);
        u.port = String(pub);
        return u.toString().replace(/\/$/, "");
      } catch {
        return `${base.replace(/\/$/, "")}:${pub}`;
      }
    };
    bag.formatPorts = function formatPorts(ports, endpointId) {
      if (!ports || !ports.length) return '<span class="muted">\u2014</span>';
      const seen = /* @__PURE__ */ new Set();
      const chips = [];
      for (const p of ports) {
        const pubRaw = p.PublicPort ?? p.publicPort;
        const pub = Number(pubRaw) || 0;
        const priv = p.PrivatePort || p.privatePort;
        const type = (p.Type || p.type || "tcp").toLowerCase();
        if (!priv) continue;
        if (pub > 0) {
          const key = `${pub}:${priv}/${type}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const href = bag.portHref(pub, endpointId);
          chips.push(
            `<a class="port-link" href="${bag.esc(href)}" target="_blank" rel="noopener" title="${bag.esc(href)}">${bag.esc(pub)}:${bag.esc(priv)}/${bag.esc(type)} \u2197</a>`
          );
        } else {
          const key = `int:${priv}/${type}`;
          if (seen.has(key)) continue;
          seen.add(key);
          chips.push(`<span class="port-chip" title="Port interne (non publi\xE9)">${bag.esc(priv)}/${bag.esc(type)}</span>`);
        }
      }
      return chips.length ? `<div class="ports">${chips.join("")}</div>` : '<span class="muted">\u2014</span>';
    };
    bag.portsFromInspect = function portsFromInspect(info) {
      const ports = [];
      const bindings = info?.NetworkSettings?.Ports || {};
      for (const [key, hosts] of Object.entries(bindings)) {
        const [priv, type] = key.split("/");
        if (!hosts) {
          ports.push({ PrivatePort: Number(priv), Type: type });
          continue;
        }
        for (const h of hosts) {
          ports.push({
            PrivatePort: Number(priv),
            PublicPort: Number(h.HostPort),
            Type: type,
            IP: h.HostIp
          });
        }
      }
      return ports;
    };
    bag.ensureSession = async function ensureSession() {
      if (!bag.Api.getToken()) return false;
      try {
        bag.state.user = await bag.Api.me();
        if (!bag.state.engineVersion) {
          bag.Api.docker("/info").then((info) => {
            if (info?.ServerVersion) bag.state.engineVersion = info.ServerVersion;
          }).catch(() => {
          });
        }
        return true;
      } catch {
        bag.Api.setToken("");
        bag.state.user = null;
        return false;
      }
    };
    bag.formatBytes = function formatBytes(n) {
      const v = Number(n) || 0;
      if (v < 1024) return `${v} B`;
      if (v < 1024 ** 2) return `${(v / 1024).toFixed(1)} KB`;
      if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)} MB`;
      return `${(v / 1024 ** 3).toFixed(1)} GB`;
    };
    bag.relativeTime = function relativeTime(ts) {
      const diff = Math.max(0, Date.now() - ts);
      const min = Math.floor(diff / 6e4);
      if (min < 1) return "\xE0 l'instant";
      if (min < 60) return `il y a ${min} min`;
      const h = Math.floor(min / 60);
      if (h < 48) return `il y a ${h} h`;
      const d = Math.floor(h / 24);
      return `il y a ${d} j`;
    };
    bag.shellQuote = function shellQuote(s) {
      return `'${String(s).replace(/'/g, `'\\''`)}'`;
    };
    bag.endpointLabel = function endpointLabel(endpointId) {
      const ep = (bag.state.endpoints || []).find((e) => Number(e.Id) === Number(endpointId));
      if (!ep) return String(endpointId || "\u2014");
      return ep.NodeName || ep.Name || String(ep.Id);
    };
    bag.fmtTs = function fmtTs(ts) {
      if (!ts) return "\u2014";
      try {
        return new Date(Number(ts) * 1e3).toLocaleString();
      } catch (_) {
        return String(ts);
      }
    };
    bag.parseCreatedDate = function parseCreatedDate(value) {
      if (value == null || value === "" || value === 0 || value === "0") return null;
      if (typeof value === "number" || /^\d+(\.\d+)?$/.test(String(value).trim())) {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return null;
        const d2 = new Date(n < 1e12 ? n * 1e3 : n);
        return Number.isNaN(d2.getTime()) ? null : d2;
      }
      const d = new Date(String(value));
      return Number.isNaN(d.getTime()) ? null : d;
    };
    bag.createdSortKey = function createdSortKey(value) {
      const d = bag.parseCreatedDate(value);
      return d ? d.getTime() : 0;
    };
    bag.formatCreated = function formatCreated(value) {
      const d = bag.parseCreatedDate(value);
      if (!d) return "\u2014";
      const full = d.toLocaleString();
      const rel = bag.relativeTime(d.getTime());
      return `<span class="cell-nowrap" title="${bag.esc(rel)}">${bag.esc(full)}</span>`;
    };
    bag.route = async function route() {
      bag.stopTimers();
      bag.closeAppModal();
      bag.state.route = (location.hash.slice(1) || "dashboard").replace(/^\/+/, "");
      if (bag.state.route === "logout") {
        bag.Api.setToken("");
        bag.state.user = null;
        bag.state.publicUrl = "";
        bag.state.portsHostUrl = "";
        if (bag.state.alertTimer) {
          clearInterval(bag.state.alertTimer);
          bag.state.alertTimer = null;
        }
        location.hash = "";
        await bag.boot();
        return;
      }
      if (!await bag.ensureSession()) {
        await bag.renderAuth();
        return;
      }
      try {
        if (!bag.state._settingsLoaded) {
          await bag.loadPublicUrl();
          bag.state._settingsLoaded = true;
        }
        await bag.loadEndpoints();
        if (bag.state.route === "users" && Number(bag.state.user?.Role) !== 1) {
          location.hash = "#dashboard";
          return;
        }
        if (bag.state.route === "nodes" && Number(bag.state.user?.Role) !== 1) {
          location.hash = "#dashboard";
          return;
        }
        if (bag.state.route !== "dashboard") {
          bag.root.innerHTML = bag.shell("Chargement", bag.pageLoadingHtml());
        }
        if (bag.state.route === "dashboard") await bag.viewDashboard();
        else if (bag.state.route === "containers" || bag.state.route === "containers/new") {
          await bag.viewContainers();
          if (bag.state.route === "containers/new" && !bag.isAllNodes()) {
            await bag.openCreateContainerModal();
          }
        } else if (bag.state.route.startsWith("containers/")) {
          if (bag.isAllNodes()) {
            bag.root.innerHTML = bag.shell("Conteneur", `${bag.pageHeader("D\xE9tail")} ${bag.pickNodeGuardHtml()}`);
          } else {
            const parts = bag.state.route.split("/");
            const id = parts[1];
            const tab = parts[2] || "overview";
            await bag.viewContainerDetail(id, tab);
          }
        } else if (bag.state.route === "images/build" || bag.state.route.startsWith("images/build/")) {
          if (bag.isAllNodes()) {
            bag.root.innerHTML = bag.shell("Build", `${bag.pageHeader("Dockerfile / Build")} ${bag.pickNodeGuardHtml()}`);
          } else {
            const name = bag.state.route.startsWith("images/build/") ? decodeURIComponent(bag.state.route.slice("images/build/".length)) : "";
            await bag.openBuildImageView(name);
          }
        } else if (bag.state.route === "images" || bag.state.route === "images/pull") {
          await bag.viewImages();
          if (bag.state.route === "images/pull" && !bag.isAllNodes()) {
            await bag.openPullImageModal();
          }
        } else if (bag.state.route === "volumes") await bag.viewVolumes();
        else if (bag.state.route.startsWith("volumes/")) {
          if (bag.isAllNodes()) {
            bag.root.innerHTML = bag.shell("Volume", `${bag.pageHeader("Explorer")} ${bag.pickNodeGuardHtml()}`);
          } else {
            const name = decodeURIComponent(bag.state.route.slice("volumes/".length).split("?")[0]);
            await bag.viewVolumeBrowse(name);
          }
        } else if (bag.state.route === "networks") await bag.viewNetworks();
        else if (bag.state.route === "stacks" || bag.state.route === "stacks/new") await bag.viewStacks();
        else if (bag.state.route.startsWith("stacks/")) {
          await bag.viewStackDetail(bag.state.route.split("/")[1]);
        } else if (bag.state.route === "activity") await bag.viewActivity();
        else if (bag.state.route === "nodes") {
          if (Number(bag.state.user?.Role) !== 1) {
            location.hash = "#dashboard";
            return;
          }
          await bag.viewNodes();
        } else if (bag.state.route === "profile") await bag.viewProfile();
        else if (bag.state.route === "settings" || bag.state.route === "settings/") await bag.viewSettings();
        else if (bag.state.route === "settings/auth") await bag.viewSettingsAuth();
        else if (bag.state.route === "settings/diagnostics/api") {
          if (Number(bag.state.user?.Role) !== 1) {
            location.hash = "#settings";
            return;
          }
          await bag.viewDiagnosticsApi();
        } else if (bag.state.route === "settings/diagnostics") {
          location.hash = "#settings";
          return;
        } else if (bag.state.route === "users") {
          if (Number(bag.state.user?.Role) !== 1) {
            location.hash = "#dashboard";
            return;
          }
          await bag.viewUsers();
        } else if (bag.state.route === "teams") {
          if (Number(bag.state.user?.Role) !== 1) {
            location.hash = "#dashboard";
            return;
          }
          await bag.viewTeams();
        } else if (bag.state.route === "registries") await bag.viewRegistries();
        else if (bag.state.route.startsWith("registries/")) await bag.viewRegistryBrowse(bag.state.route.split("/")[1]);
        else if (bag.state.route === "docs") await bag.viewDocs();
        else if (bag.state.route === "about") {
          location.hash = "#dashboard";
          return;
        } else await bag.viewDashboard();
      } catch (err) {
        bag.root.innerHTML = bag.shell("Erreur", `${bag.pageHeader("Erreur", false)}<div class="error-box">${bag.esc(err.message)}</div>`);
      }
      bag.bindAlertUi();
      bag.ensureAlertPolling();
      bag.refreshAlerts();
    };
    bag.ensureAppVersion = async function ensureAppVersion() {
      if (bag.state.appVersion) return bag.state.appVersion;
      try {
        const st = await bag.Api.status();
        const v = String(st?.Version || st?.version || "").trim();
        if (v) bag.state.appVersion = v.replace(/^v/i, "");
      } catch (_) {
      }
      return bag.state.appVersion || "";
    };
    bag.appVersionLabel = function appVersionLabel() {
      const v = bag.state.appVersion || "";
      return v ? `v${v}` : "";
    };
    bag.boot = async function boot() {
      await bag.ensureAppVersion();
      if (!await bag.ensureSession()) {
        await bag.renderAuth();
        return;
      }
      bag.state._settingsLoaded = false;
      await bag.loadPublicUrl();
      bag.state._settingsLoaded = true;
      await bag.route();
    };
  }

  // public/assets/js/src/metrics/index.js
  function install() {
    bag.metricChartHours = function metricChartHours() {
      const h = Number(bag.state.metricsChartHours);
      return Number.isFinite(h) && h >= 1 ? Math.min(168, Math.floor(h)) : 72;
    };
    bag.metricRetentionDays = function metricRetentionDays() {
      const d = Number(bag.state.metricsRetentionDays);
      return Number.isFinite(d) && d >= 7 ? Math.min(365, Math.floor(d)) : 90;
    };
    bag.metricWindowLabel = function metricWindowLabel() {
      const h = bag.metricChartHours();
      if (h === 24) return "24 h glissantes";
      if (h % 24 === 0) {
        const days = h / 24;
        return `${days} j glissant${days > 1 ? "s" : ""}`;
      }
      return `${h} h glissantes`;
    };
    bag.metricScopeKey = function metricScopeKey2() {
      return bag.Api.isAllEndpoints() ? "all" : `ep:${bag.Api.getEndpointId()}`;
    };
    bag.getMetricSeries = function getMetricSeries() {
      return bag.metricCache.scope === bag.metricScopeKey() ? bag.metricCache.series : [];
    };
    bag.loadMetricHistory = async function loadMetricHistory(scope = metricScopeKey()) {
      try {
        const hours = bag.metricChartHours();
        const points = Math.min(288, Math.max(48, Math.ceil(hours * 60 / 5)));
        const data = await bag.Api.metricsHistory(scope, { hours, points });
        if (data?.ChartHours != null) bag.state.metricsChartHours = Number(data.ChartHours) || bag.state.metricsChartHours;
        if (data?.RetentionDays != null) bag.state.metricsRetentionDays = Number(data.RetentionDays) || bag.state.metricsRetentionDays;
        const series = Array.isArray(data?.Series) ? data.Series : [];
        bag.metricCache.scope = scope;
        bag.metricCache.series = series;
        return series;
      } catch (_) {
        if (bag.metricCache.scope !== scope) {
          bag.metricCache.scope = scope;
          bag.metricCache.series = [];
        }
        return bag.metricCache.series;
      }
    };
    bag.pushMetricSample = async function pushMetricSample(counts) {
      const scope = bag.metricScopeKey();
      const clampPct = (v) => Math.max(0, Math.min(100, Number(v) || 0));
      const payload = {
        Scope: scope,
        containers: Number(counts.containers) || 0,
        images: Number(counts.images) || 0,
        volumes: Number(counts.volumes) || 0,
        networks: Number(counts.networks) || 0
      };
      if (counts.cpu != null) payload.cpu = clampPct(counts.cpu);
      if (counts.mem != null) payload.mem = clampPct(counts.mem);
      if (counts.disk != null) payload.disk = clampPct(counts.disk);
      try {
        await bag.Api.metricsSample(payload);
      } catch (_) {
      }
      return bag.loadMetricHistory(scope);
    };
    bag.resourceChart = function resourceChart(series, opts = {}) {
      const w = 320;
      const h = 88;
      const padY = 4;
      const keys = opts.keys || [
        { key: "cpu", color: "#3b82f6", label: "CPU" },
        { key: "mem", color: "#22c55e", label: "M\xE9moire" },
        { key: "disk", color: "#fb923c", label: "Disque" }
      ];
      let maxY = Number(opts.maxY);
      if (!Number.isFinite(maxY) || maxY <= 0) {
        maxY = 100;
        keys.forEach(({ key }) => {
          const vals = bag.metricValues(series, key);
          vals.forEach((v) => {
            if (v > maxY && opts.autoScale) maxY = v;
          });
        });
        if (!opts.autoScale) maxY = 100;
      }
      maxY = Math.max(1, maxY);
      const yAt = (v) => padY + (1 - Math.max(0, Math.min(maxY, Number(v) || 0)) / maxY) * (h - padY * 2);
      const wrapId = opts.wrapId || "host-wave-wrap";
      const n = Math.max(1, (series || []).length);
      const paths = keys.map(({ key, color }) => {
        const vals = bag.metricValues(series, key);
        if (!vals.length) {
          return `<path d="M0 ${yAt(0).toFixed(2)} L${w} ${yAt(0).toFixed(2)}" fill="none" stroke="${color}" stroke-width="2" stroke-opacity="0.35"/>`;
        }
        const coords = vals.map((v, i) => {
          const x = vals.length === 1 ? w / 2 : i / (vals.length - 1) * w;
          return [x, yAt(v)];
        });
        if (coords.length === 1) {
          const y = coords[0][1];
          return `<path d="M0 ${y.toFixed(2)} L${w} ${y.toFixed(2)}" fill="none" stroke="${color}" stroke-width="2.4"/>`;
        }
        const d = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c[0].toFixed(2)} ${c[1].toFixed(2)}`).join(" ");
        return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`;
      }).join("");
      const labels = keys.map((k) => k.label).join(" / ");
      const isPct = !opts.maxY && !opts.autoScale;
      const title = n < 2 ? "Historique en construction" : `\xC9volution ${labels} \u2014 ${n} relev\xE9s`;
      const legend = keys.map(
        ({ color, label }) => `<span class="wave-leg"><i style="background:${color}"></i>${bag.esc(label)}</span>`
      ).join("");
      const topLbl = isPct ? "100%" : String(Math.round(maxY));
      const midLbl = isPct ? "50%" : String(Math.round(maxY / 2));
      const botLbl = isPct ? "0%" : "0";
      const yTop = yAt(maxY).toFixed(1);
      const yMid = yAt(maxY / 2).toFixed(1);
      const yBot = yAt(0).toFixed(1);
      return `<div class="wave-wrap" id="${bag.esc(wrapId)}">
      <div class="wave-head"><span class="stat-hint" title="Fen\xEAtre configurable dans Param\xE8tres">Courbes \xB7 ${bag.esc(bag.metricWindowLabel())} \xB7 r\xE9tention ${bag.esc(String(bag.metricRetentionDays()))} j</span></div>
      <div class="wave-plot">
        <div class="wave-y" aria-hidden="true">
          <span>${bag.esc(topLbl)}</span>
          <span>${bag.esc(midLbl)}</span>
          <span>${bag.esc(botLbl)}</span>
        </div>
        <svg class="wave-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${bag.esc(title)}">
          <title>${bag.esc(title)}</title>
          <line x1="0" y1="${yTop}" x2="${w}" y2="${yTop}" class="wave-grid"/>
          <line x1="0" y1="${yMid}" x2="${w}" y2="${yMid}" class="wave-grid"/>
          <line x1="0" y1="${yBot}" x2="${w}" y2="${yBot}" class="wave-grid"/>
          ${paths}
        </svg>
      </div>
      <div class="wave-legend">${legend}</div>
    </div>`;
    };
    bag.hostResourceChart = function hostResourceChart(series) {
      return bag.resourceChart(series, {
        wrapId: "host-wave-wrap",
        keys: [
          { key: "cpu", color: "#3b82f6", label: "CPU" },
          { key: "mem", color: "#22c55e", label: "M\xE9moire" },
          { key: "disk", color: "#fb923c", label: "Disque" }
        ]
      });
    };
    bag.containerResourceChart = function containerResourceChart(series) {
      return bag.resourceChart(series, {
        wrapId: "ctr-wave-wrap",
        keys: [
          { key: "cpu", color: "#3b82f6", label: "CPU" },
          { key: "mem", color: "#22c55e", label: "M\xE9moire" },
          { key: "disk", color: "#a78bfa", label: "R\xE9seau" }
        ]
      });
    };
    bag.containerMetricScope = function containerMetricScope(containerId) {
      const ep = bag.Api.isAllEndpoints() ? 0 : bag.Api.getEndpointId();
      const id = String(containerId || "").replace(/^sha256:/, "");
      return `ctr:${ep}:${id.slice(0, 64)}`;
    };
    bag.netLoadScore = function netLoadScore(rxRate, txRate) {
      const bps = Math.max(0, Number(rxRate) || 0) + Math.max(0, Number(txRate) || 0);
      const mbps = bps / (1024 * 1024);
      if (mbps <= 0) return 0;
      if (mbps < 1) return Math.min(40, mbps * 40);
      if (mbps < 5) return 40 + (mbps - 1) / 4 * 25;
      if (mbps < 20) return 65 + (mbps - 5) / 15 * 20;
      return Math.min(100, 85 + (mbps - 20) / 40 * 15);
    };
    bag.resourceLoadLevel = function resourceLoadLevel(cpuPct, memPct, netPct) {
      const cpu = Number(cpuPct) || 0;
      const mem = Number(memPct) || 0;
      const net = Number(netPct) || 0;
      const max = Math.max(cpu, mem, net);
      if (max >= 85) return "hot";
      if (max >= 65) return "warn";
      return "ok";
    };
    bag.applyStatsIconLevel = function applyStatsIconLevel(containerId, level, title) {
      const btn = bag.root.querySelector(`[data-stats-id="${CSS.escape(String(containerId))}"]`);
      if (!btn) return;
      btn.classList.remove("is-stats-ok", "is-stats-warn", "is-stats-hot", "is-stats-off");
      const cls = level === "hot" ? "is-stats-hot" : level === "warn" ? "is-stats-warn" : level === "off" ? "is-stats-off" : "is-stats-ok";
      btn.classList.add(cls);
      if (title) {
        btn.title = title;
        btn.setAttribute("aria-label", title);
      }
    };
    bag.pushContainerMetricSample = async function pushContainerMetricSample(containerId, cpu, mem, net) {
      const clamp = (v) => Math.max(0, Math.min(100, Number(v) || 0));
      try {
        await bag.Api.metricsSample({
          Scope: bag.containerMetricScope(containerId),
          cpu: clamp(cpu),
          mem: clamp(mem),
          disk: clamp(net),
          containers: 1
        });
      } catch (_) {
      }
    };
    bag.loadContainerMetricHistory = async function loadContainerMetricHistory(containerId) {
      try {
        const hours = bag.metricChartHours();
        const points = Math.min(288, Math.max(48, Math.ceil(hours * 60 / 5)));
        const data = await bag.Api.metricsHistory(bag.containerMetricScope(containerId), { hours, points });
        if (data?.ChartHours != null) bag.state.metricsChartHours = Number(data.ChartHours) || bag.state.metricsChartHours;
        if (data?.RetentionDays != null) bag.state.metricsRetentionDays = Number(data.RetentionDays) || bag.state.metricsRetentionDays;
        return Array.isArray(data?.Series) ? data.Series : [];
      } catch (_) {
        return [];
      }
    };
    bag.stopContainerStatsPoll = function stopContainerStatsPoll() {
      if (bag.state.containerStatsTimer) {
        clearInterval(bag.state.containerStatsTimer);
        bag.state.containerStatsTimer = null;
      }
    };
    bag.startContainerStatsPoll = function startContainerStatsPoll(containers) {
      bag.stopContainerStatsPoll();
      const list = containers || [];
      const tick = () => {
        if (bag.state.route !== "containers" && bag.state.route !== "container") {
          bag.stopContainerStatsPoll();
          return;
        }
        void bag.refreshContainerStatsIcons(list);
      };
      tick();
      bag.state.containerStatsTimer = setInterval(tick, 1e4);
    };
    bag.visibleContainerIds = function visibleContainerIds() {
      const ids = /* @__PURE__ */ new Set();
      bag.root.querySelectorAll("tbody tr[data-container-id]").forEach((tr) => {
        if (tr.style.display === "none") return;
        const id = tr.getAttribute("data-container-id");
        if (id) ids.add(id);
      });
      if (ids.size === 0) {
        bag.root.querySelectorAll("[data-stats-id]").forEach((el) => {
          const id = el.getAttribute("data-stats-id");
          if (id) ids.add(id);
        });
      }
      return ids;
    };
    bag.refreshContainerStatsIcons = async function refreshContainerStatsIcons(containers) {
      if (bag.state.route !== "containers" && bag.state.route !== "container") return;
      const visible = bag.visibleContainerIds();
      const onPage = (containers || []).filter((c) => visible.size === 0 || visible.has(c.Id));
      const running = onPage.filter((c) => {
        const st = String(c.State || "").toLowerCase();
        return st === "running" || st === "restarting";
      });
      onPage.forEach((c) => {
        const st = String(c.State || "").toLowerCase();
        if (st !== "running" && st !== "restarting") {
          bag.applyStatsIconLevel(c.Id, "off", "Conteneur arr\xEAt\xE9 \u2014 pas de charge");
        }
      });
      if (!bag.state.containerStatsPrev) bag.state.containerStatsPrev = {};
      const queue = [...running];
      const workers = 3;
      const runOne = async () => {
        while (queue.length) {
          if (bag.state.route !== "containers" && bag.state.route !== "container") return;
          const c = queue.shift();
          if (!c) return;
          try {
            const st = await bag.Api.docker(`/containers/${c.Id}/stats?stream=false`);
            const computed = bag.computeStats(st, 0);
            const now = Date.now();
            const prev = bag.state.containerStatsPrev[c.Id];
            let rate = { rx: 0, tx: 0 };
            if (prev && prev.at > 0) {
              const dt = Math.max(0.5, (now - prev.at) / 1e3);
              rate = {
                rx: Math.max(0, (computed.netRx - prev.netRx) / dt),
                tx: Math.max(0, (computed.netTx - prev.netTx) / dt)
              };
            }
            bag.state.containerStatsPrev[c.Id] = {
              netRx: computed.netRx,
              netTx: computed.netTx,
              at: now
            };
            const net = bag.netLoadScore(rate.rx, rate.tx);
            const level = bag.resourceLoadLevel(computed.cpuPct, computed.memPct, net);
            const title = `CPU ${computed.cpuPct.toFixed(0)}% \xB7 RAM ${computed.memPct.toFixed(0)}% \xB7 R\xE9seau ${bag.formatBitRate(rate.rx + rate.tx)}`;
            bag.applyStatsIconLevel(c.Id, level, title);
            void bag.pushContainerMetricSample(c.Id, computed.cpuPct, computed.memPct, net);
          } catch (_) {
            bag.applyStatsIconLevel(c.Id, "off", "Stats indisponibles");
          }
        }
      };
      await Promise.all(Array.from({ length: workers }, () => runOne()));
    };
    bag.metricValues = function metricValues(series, key) {
      return (series || []).map((p) => Number(p?.[key]) || 0);
    };
    bag.metricDeltaHtml = function metricDeltaHtml(series, key) {
      const vals = bag.metricValues(series, key);
      if (vals.length < 2) {
        return '<span class="stat-delta is-flat" title="Pas encore d\u2019historique">\xB7</span>';
      }
      const d = vals[vals.length - 1] - vals[vals.length - 2];
      if (d === 0) return '<span class="stat-delta is-flat" title="Stable">=</span>';
      if (d > 0) return `<span class="stat-delta is-up" title="Depuis le dernier relev\xE9">+${d}</span>`;
      return `<span class="stat-delta is-down" title="Depuis le dernier relev\xE9">${d}</span>`;
    };
    bag.stopDashMetricSampler = function stopDashMetricSampler() {
      if (bag.state.metricTimer) {
        clearInterval(bag.state.metricTimer);
        bag.state.metricTimer = null;
      }
    };
    bag.startDashMetricSampler = function startDashMetricSampler() {
      bag.stopDashMetricSampler();
      bag.state.metricTimer = setInterval(() => {
        if (bag.state.route !== "dashboard") {
          bag.stopDashMetricSampler();
          return;
        }
        void bag.refreshDashMetricSample();
      }, 6e4);
    };
    bag.sampleHostResourcePercents = async function sampleHostResourcePercents(containers, memTotalHint) {
      const list = containers || [];
      const running = list.filter((c) => String(c.State).toLowerCase() === "running").slice(0, 8);
      let cpuPct = 0;
      let memPct = 0;
      let memUsage = 0;
      let memTotal = Number(memTotalHint) || 0;
      const stats = await Promise.all(running.map(async (c) => {
        try {
          return await bag.Api.docker(`/containers/${c.Id}/stats?stream=false`);
        } catch {
          return null;
        }
      }));
      const computed = stats.filter(Boolean).map((st) => bag.computeStats(st, memTotal));
      if (computed.length) {
        cpuPct = computed.reduce((a, s) => a + s.cpuPct, 0);
        memUsage = computed.reduce((a, s) => a + s.memUsage, 0);
        if (!memTotal) {
          memTotal = computed.reduce((a, s) => Math.max(a, s.memLimit || 0), 0);
        }
        memPct = memTotal ? memUsage / memTotal * 100 : computed.reduce((a, s) => a + s.memPct, 0) / computed.length;
      }
      let diskPct = 0;
      try {
        const host = await bag.Api.host();
        const diskTotal = Number(host?.DiskTotal) || 0;
        const diskUsed = Number(host?.DiskUsed) || 0;
        diskPct = diskTotal > 0 ? Math.min(100, diskUsed / diskTotal * 100) : 0;
      } catch (_) {
      }
      return { cpu: cpuPct, mem: memPct, disk: diskPct };
    };
    bag.refreshDashMetricSample = async function refreshDashMetricSample() {
      try {
        let counts;
        if (bag.isAllNodes()) {
          const [cAgg, iAgg, vAgg, nAgg] = await Promise.all([
            bag.dockerAll("/containers/json?all=true", { pick: (d) => Array.isArray(d) ? d : [], refresh: false }),
            bag.dockerAll("/images/json", { pick: (d) => Array.isArray(d) ? d : [], refresh: false }),
            bag.dockerAll("/volumes", { pick: (d) => d?.Volumes || [], refresh: false }),
            bag.dockerAll("/networks", { pick: (d) => Array.isArray(d) ? d : [], refresh: false })
          ]);
          counts = {
            containers: (cAgg.items || []).length,
            images: (iAgg.items || []).length,
            volumes: (vAgg.items || []).length,
            networks: (nAgg.items || []).length
          };
        } else {
          const [c, i, v, n, info] = await Promise.all([
            bag.Api.docker("/containers/json?all=true"),
            bag.Api.docker("/images/json"),
            bag.Api.docker("/volumes"),
            bag.Api.docker("/networks"),
            bag.Api.docker("/info").catch(() => ({}))
          ]);
          const hostPct = await bag.sampleHostResourcePercents(c || [], Number(info?.MemTotal) || 0);
          counts = {
            containers: (c || []).length,
            images: (i || []).length,
            volumes: (v?.Volumes || []).length,
            networks: (n || []).length,
            cpu: hostPct.cpu,
            mem: hostPct.mem,
            disk: hostPct.disk
          };
        }
        const series = await bag.pushMetricSample(counts);
        bag.updateDashStatCards(series, counts);
        bag.updateHostResourceChart(series, counts);
      } catch (_) {
      }
    };
    bag.updateDashStatCards = function updateDashStatCards(series, counts) {
      bag._dashMetricSeries = series;
      const map = [
        ["containers", "blue"],
        ["images", "purple"],
        ["volumes", "green"],
        ["networks", "orange"]
      ];
      map.forEach(([key, tone]) => {
        const card = document.querySelector(`.stat-card[data-metric="${key}"]`);
        if (!card) return;
        const val = card.querySelector(".stat-value");
        const delta = card.querySelector(".stat-delta");
        const sparkBtn = card.querySelector(".sparkline-btn");
        const spark = sparkBtn?.querySelector(".sparkline") || card.querySelector(".sparkline");
        if (val && counts && counts[key] != null) val.textContent = String(counts[key]);
        if (delta) delta.outerHTML = bag.metricDeltaHtml(series, key);
        if (spark) spark.outerHTML = bag.sparklineFromValues(bag.metricValues(series, key), tone);
      });
    };
    bag.bindDashMetricSparklines = function bindDashMetricSparklines(series) {
      bag._dashMetricSeries = series || bag.getMetricSeries();
      bag.root.querySelectorAll("[data-metric-detail]").forEach((btn) => {
        if (btn.dataset.boundDetail === "1") return;
        btn.dataset.boundDetail = "1";
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const key = btn.dataset.metricDetail;
          bag.openMetricDetailModal(key, bag._dashMetricSeries || bag.getMetricSeries());
        });
      });
    };
    bag.formatMetricRange = function formatMetricRange(fromSec, untilSec) {
      const fmt = (sec) => {
        try {
          return new Date(sec * 1e3).toLocaleString("fr-FR", {
            day: "2-digit",
            month: "short",
            hour: "2-digit",
            minute: "2-digit"
          });
        } catch {
          return String(sec);
        }
      };
      return `${fmt(fromSec)} \u2192 ${fmt(untilSec)}`;
    };
    bag.openMetricDetailModal = function openMetricDetailModal(key, series) {
      const meta = bag.dashMetricMeta?.[key] || {
        label: key,
        tone: "blue",
        color: "#38bdf8",
        href: `#${key}`
      };
      const retentionDays = bag.metricRetentionDays();
      const defaultHours = bag.metricChartHours();
      const windowChoices = Array.from(new Set([
        defaultHours,
        24,
        48,
        72,
        168,
        Math.min(retentionDays * 24, 720)
      ].filter((h) => h >= 1 && h <= retentionDays * 24))).sort((a, b) => a - b);
      let hours = defaultHours;
      let until = Math.floor(Date.now() / 1e3);
      let loading = false;
      const windowLabel = (h) => {
        if (h === 24) return "24 h";
        if (h % 24 === 0) {
          const d = h / 24;
          return `${d} j`;
        }
        return `${h} h`;
      };
      const renderBody = (pts, fromSec, untilSec) => {
        const vals = bag.metricValues(pts, key);
        const n = vals.length;
        const last = n ? vals[n - 1] : 0;
        const max = n ? Math.max(...vals) : 0;
        const min = n ? Math.min(...vals) : 0;
        const avg = n ? vals.reduce((a, b) => a + b, 0) / n : 0;
        const delta = n >= 2 ? vals[n - 1] - vals[n - 2] : 0;
        const chart = bag.resourceChart(pts, {
          wrapId: "metric-detail-wave",
          keys: [{ key, color: meta.color, label: meta.label }],
          maxY: Math.max(max, 1) * 1.15
        });
        const now = Math.floor(Date.now() / 1e3);
        const floor = now - retentionDays * 86400;
        const canPrev = until - hours > floor + 60;
        const canNext = until < now - 90;
        const chips = windowChoices.map(
          (h) => `<button type="button" class="btn btn-sm metric-win-chip${h === hours ? " is-active" : ""}" data-metric-hours="${h}">${bag.esc(windowLabel(h))}</button>`
        ).join("");
        return `
          <div class="metric-detail-nav">
            <div class="metric-detail-nav-row">
              <button type="button" class="btn btn-sm" data-metric-prev ${canPrev ? "" : "disabled"} title="Fen\xEAtre pr\xE9c\xE9dente">\u2190 Pr\xE9c.</button>
              <button type="button" class="btn btn-sm" data-metric-live ${canNext ? "" : "disabled"} title="Revenir \xE0 maintenant">Maintenant</button>
              <button type="button" class="btn btn-sm" data-metric-next ${canNext ? "" : "disabled"} title="Fen\xEAtre suivante">Suiv. \u2192</button>
            </div>
            <div class="metric-detail-nav-row metric-win-chips">${chips}</div>
            <p class="muted metric-detail-range">${bag.esc(bag.formatMetricRange(fromSec, untilSec))} \xB7 r\xE9tention ${retentionDays} j</p>
          </div>
          <div class="metric-detail-kpis">
            <div class="metric-kpi"><span class="muted">${canNext ? "Fin fen\xEAtre" : "Actuel"}</span><strong>${last}</strong></div>
            <div class="metric-kpi"><span class="muted">Min</span><strong>${min}</strong></div>
            <div class="metric-kpi"><span class="muted">Max</span><strong>${max}</strong></div>
            <div class="metric-kpi"><span class="muted">Moyenne</span><strong>${avg.toFixed(1)}</strong></div>
            <div class="metric-kpi"><span class="muted">\u0394 dernier</span><strong class="${delta > 0 ? "ok" : delta < 0 ? "bad" : ""}">${delta > 0 ? "+" : ""}${delta}</strong></div>
            <div class="metric-kpi"><span class="muted">Relev\xE9s</span><strong>${n}</strong></div>
          </div>
          <div class="metric-detail-chart">${chart}</div>`;
      };
      bag.closeAppModal();
      const host = bag.modalHost();
      host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-form-wide" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div class="metric-detail-head">
              <div class="stat-ico ${bag.esc(meta.tone)}">${bag.ico(key === "networks" ? "networks" : key)}</div>
              <div>
                <h3>${bag.esc(meta.label)}</h3>
                <div class="modal-sub" id="metric-detail-sub">Historique \xB7 navigation sur ${retentionDays} j de r\xE9tention</div>
              </div>
            </div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">\u2715</button>
          </div>
          <div id="metric-detail-body">
            <div class="muted" style="padding:12px 0">Chargement\u2026</div>
          </div>
          <div class="actions-bar">
            <a class="btn btn-primary" href="${bag.esc(meta.href)}">Ouvrir ${bag.esc(meta.label)}</a>
            <button type="button" class="btn" data-close-modal>Fermer</button>
          </div>
        </div>
      </div>`;
      bag.bindAppModalChrome();
      const bodyEl = () => document.getElementById("metric-detail-body");
      const subEl = () => document.getElementById("metric-detail-sub");
      const bindNav = () => {
        const root = bodyEl();
        if (!root) return;
        root.querySelector("[data-metric-prev]")?.addEventListener("click", () => {
          until = Math.max(
            Math.floor(Date.now() / 1e3) - retentionDays * 86400 + hours,
            until - hours
          );
          void load();
        });
        root.querySelector("[data-metric-next]")?.addEventListener("click", () => {
          until = Math.min(Math.floor(Date.now() / 1e3), until + hours);
          void load();
        });
        root.querySelector("[data-metric-live]")?.addEventListener("click", () => {
          until = Math.floor(Date.now() / 1e3);
          void load();
        });
        root.querySelectorAll("[data-metric-hours]").forEach((btn) => {
          btn.addEventListener("click", () => {
            const h = parseInt(btn.getAttribute("data-metric-hours") || "", 10);
            if (!Number.isFinite(h) || h < 1) return;
            hours = h;
            void load();
          });
        });
      };
      const paint = (pts, fromSec, untilSec) => {
        const el = bodyEl();
        if (!el) return;
        el.innerHTML = renderBody(pts, fromSec, untilSec);
        if (subEl()) {
          subEl().textContent = `Fen\xEAtre ${windowLabel(hours)} \xB7 r\xE9tention ${retentionDays} j`;
        }
        bindNav();
      };
      const load = async () => {
        if (loading) return;
        loading = true;
        const el = bodyEl();
        if (el) el.innerHTML = `<div class="muted" style="padding:12px 0">Chargement\u2026</div>`;
        try {
          const scope = bag.metricScopeKey();
          const points = Math.min(720, Math.max(48, Math.ceil(hours * 60 / 5)));
          const now = Math.floor(Date.now() / 1e3);
          if (until > now) until = now;
          const data = await bag.Api.metricsHistory(scope, { hours, until, points });
          const pts = Array.isArray(data?.Series) ? data.Series : [];
          const fromSec = Number(data?.From) || until - hours * 3600;
          const untilSec = Number(data?.Until) || until;
          until = untilSec;
          paint(pts, fromSec, untilSec);
        } catch (err) {
          if (el) {
            el.innerHTML = `<div class="error-box">${bag.esc(err.message || String(err))}</div>`;
          }
        } finally {
          loading = false;
        }
      };
      if (Array.isArray(series) && series.length) {
        const fromSec = until - hours * 3600;
        paint(series, fromSec, until);
      }
      void load();
    };
    bag.updateHostResourceChart = function updateHostResourceChart(series, counts) {
      const wrap = document.getElementById("host-wave-wrap");
      if (wrap) wrap.outerHTML = bag.hostResourceChart(series);
      if (!counts) return;
      const gauges = document.querySelectorAll(".panel-card .gauge-row .gauge");
      if (gauges.length >= 3) {
        if (counts.cpu != null) {
          gauges[0].querySelector("svg")?.replaceWith(
            (() => {
              const t = document.createElement("div");
              t.innerHTML = bag.gaugeRing(counts.cpu, "#3b82f6");
              return t.firstElementChild;
            })()
          );
        }
        if (counts.mem != null) {
          gauges[1].querySelector("svg")?.replaceWith(
            (() => {
              const t = document.createElement("div");
              t.innerHTML = bag.gaugeRing(counts.mem, "#22c55e");
              return t.firstElementChild;
            })()
          );
        }
        if (counts.disk != null) {
          gauges[2].querySelector("svg")?.replaceWith(
            (() => {
              const t = document.createElement("div");
              t.innerHTML = bag.gaugeRing(counts.disk, "#fb923c");
              return t.firstElementChild;
            })()
          );
        }
      }
    };
  }

  // public/assets/js/src/cve.js
  function install2() {
    bag.trivyOn = function trivyOn() {
      return bag.state.trivyEnabled !== false;
    };
    bag.cveBadge = function cveBadge(summary) {
      if (!summary || typeof summary !== "object") return '<span class="muted">\u2014</span>';
      const c = Number(summary.CRITICAL || 0);
      const h = Number(summary.HIGH || 0);
      const m = Number(summary.MEDIUM || 0);
      if (c > 0) return `<span class="badge badge-danger" title="Critical ${c}">C${c}</span>`;
      if (h > 0) return `<span class="badge badge-warn" title="High ${h}">H${h}</span>`;
      if (m > 0) return `<span class="badge badge-info" title="Medium ${m}">M${m}</span>`;
      if (Number(summary.TOTAL || 0) > 0) return `<span class="badge">L${Number(summary.LOW || 0)}</span>`;
      return `<span class="badge badge-success" title="Aucune CVE">CVE OK</span>`;
    };
    bag.cveStatusTd = function cveStatusTd(ref, scan) {
      if (!ref) return '<td><span class="muted">\u2014</span></td>';
      if (!scan) {
        return `<td data-cve-cell="${bag.esc(ref)}"><span class="muted cve-pending">\u2026</span></td>`;
      }
      if (scan.Status === "skipped" || scan.Warning) {
        return `<td data-cve-cell="${bag.esc(ref)}"><span class="muted" title="${bag.esc(scan.Warning || "Scan ignor\xE9")}">\u2014</span></td>`;
      }
      return `<td data-cve-cell="${bag.esc(ref)}"><button type="button" class="cve-pill-btn" data-cve-ref="${bag.esc(ref)}" title="D\xE9tail CVE">${bag.cveBadge(scan.Summary)}</button></td>`;
    };
    bag.fillCveCell = function fillCveCell(cell, item) {
      if (!cell || !item) return;
      const ref = item.ImageRef || cell.dataset.cveCell || "";
      if (item.Status === "skipped" || item.Warning) {
        cell.innerHTML = `<span class="muted" title="${bag.esc(item.Warning || "Scan ignor\xE9")}">\u2014</span>`;
        return;
      }
      cell.innerHTML = `<button type="button" class="cve-pill-btn" data-cve-ref="${bag.esc(ref)}" title="D\xE9tail CVE">${bag.cveBadge(item.Summary)}</button>`;
    };
    bag.bindCveDetailButtons = function bindCveDetailButtons(scope) {
      (scope || document).querySelectorAll("[data-cve-ref]").forEach((btn) => {
        if (btn.dataset.cveBound === "1") return;
        btn.dataset.cveBound = "1";
        btn.addEventListener("click", () => bag.openCveScanModal(btn.dataset.cveRef));
      });
    };
    bag.ensureImagesCveColumn = async function ensureImagesCveColumn(root, refs) {
      let res;
      try {
        res = await bag.Api.ensureImageScans(bag.Api.getEndpointId(), { Images: refs });
      } catch (_) {
        bag.root.querySelectorAll("[data-cve-cell]").forEach((cell) => {
          if (cell.querySelector(".cve-pending")) {
            cell.innerHTML = '<span class="muted" title="Scan indisponible">\u2014</span>';
          }
        });
        return;
      }
      const byRef = /* @__PURE__ */ new Map();
      (res?.Items || []).forEach((it) => {
        if (it.ImageRef) byRef.set(it.ImageRef, it);
      });
      bag.root.querySelectorAll("[data-cve-cell]").forEach((cell) => {
        const ref = cell.dataset.cveCell;
        const it = byRef.get(ref);
        if (it) bag.fillCveCell(cell, it);
        else if (cell.querySelector(".cve-pending")) {
          cell.innerHTML = '<span class="muted">\u2014</span>';
        }
      });
      bag.bindCveDetailButtons(bag.root);
    };
    bag.openCveScanModal = async function openCveScanModal(ref) {
      if (!ref) return;
      const host = document.getElementById("scan-modal") || (() => {
        const el = document.createElement("div");
        el.id = "scan-modal";
        bag.root?.appendChild(el);
        return el;
      })();
      host.innerHTML = `<div class="info-box">Chargement CVE <code>${bag.esc(ref)}</code>\u2026</div>`;
      try {
        let res = null;
        try {
          res = await bag.Api.imageScan(bag.Api.getEndpointId(), { ref });
        } catch (_) {
          res = await bag.Api.scanImage(bag.Api.getEndpointId(), { Image: ref, Force: false });
        }
        const findings = (res.Findings || []).slice(0, 40);
        const rowsF = findings.map((f) => `<tr>
        <td>${bag.esc(f.Severity)}</td>
        <td class="mono">${bag.esc(f.Cve)}</td>
        <td>${bag.esc(f.Package)} ${bag.esc(f.Version || "")}</td>
        <td class="muted">${bag.esc((f.Title || "").slice(0, 120))}</td>
      </tr>`).join("");
        host.innerHTML = `
        <div class="modal-backdrop">
          <div class="modal modal-form-wide" style="max-width:820px">
            <h3>Scan CVE \xB7 ${bag.esc(ref)}</h3>
            <p>${bag.cveBadge(res.Summary)} \xB7 ${bag.esc(String(res.Summary?.TOTAL || 0))} finding(s)${res.FromCache ? ' <span class="muted">(cache)</span>' : ""}</p>
            <div class="table-wrap" style="max-height:360px;overflow:auto">
              <table class="data"><thead><tr><th>S\xE9v\xE9rit\xE9</th><th>CVE</th><th>Paquet</th><th>Titre</th></tr></thead>
              <tbody>${rowsF || `<tr><td colspan="4" class="empty">Aucune vuln\xE9rabilit\xE9</td></tr>`}</tbody></table>
            </div>
            <div class="actions-bar"><button class="btn" id="close-scan">Fermer</button></div>
          </div>
        </div>`;
        document.getElementById("close-scan").onclick = () => {
          host.innerHTML = "";
        };
      } catch (err) {
        host.innerHTML = `<div class="error-box">${bag.esc(err.message || "Erreur CVE")}</div>`;
      }
    };
    bag.cveAdviseBeforeDeploy = async function cveAdviseBeforeDeploy(payload, errBox) {
      if (!bag.trivyOn()) {
        return { proceed: true, advise: null };
      }
      if (errBox) {
        errBox.innerHTML = `<div class="info-box">V\xE9rification CVE (non bloquante)\u2026</div>`;
      }
      let advise = null;
      try {
        advise = await bag.Api.adviseImages(bag.Api.getEndpointId(), payload);
      } catch (err) {
        if (errBox) {
          errBox.innerHTML = `<div class="info-box">Scan CVE indisponible (${bag.esc(err.message || "erreur")}) \u2014 d\xE9ploiement non bloqu\xE9.</div>`;
        }
        return { proceed: true, advise: null };
      }
      const items = Array.isArray(advise?.Items) ? advise.Items : [];
      if (!items.length) {
        if (errBox) errBox.innerHTML = "";
        return { proceed: true, advise };
      }
      const lines = items.map((it) => {
        if (it.Status === "skipped" || it.Warning) {
          return `<li><code>${bag.esc(it.ImageRef || "?")}</code> \u2014 <span class="muted">${bag.esc(it.Warning || "scan ignor\xE9")}</span></li>`;
        }
        return `<li><code>${bag.esc(it.ImageRef || "?")}</code> ${bag.cveBadge(it.Summary)}${it.FromCache ? ' <span class="muted">(cache)</span>' : ""}</li>`;
      });
      const worst = String(advise?.Worst || "ok");
      const skippedOnly = items.every((it) => it.Status === "skipped" || it.Warning);
      let boxClass = "info-box";
      let title = "Scan CVE";
      if (worst === "critical" || worst === "high") {
        boxClass = "error-box";
        title = "CVE critiques / \xE9lev\xE9es d\xE9tect\xE9es";
      } else if (worst === "findings") {
        boxClass = "info-box";
        title = "CVE d\xE9tect\xE9es (s\xE9v\xE9rit\xE9 moyenne ou basse)";
      } else if (skippedOnly || worst === "skipped") {
        boxClass = "info-box";
        title = "Scan CVE partiel ou indisponible";
      } else {
        title = "Scan CVE : aucune vuln\xE9rabilit\xE9 critique";
      }
      if (errBox) {
        errBox.innerHTML = `<div class="${boxClass}"><strong>${bag.esc(title)}</strong><ul style="margin:8px 0 0;padding-left:18px">${lines.join("")}</ul><p class="muted" style="margin:8px 0 0;font-size:12px">Le d\xE9ploiement n\u2019est jamais bloqu\xE9 par Trivy.</p></div>`;
      }
      if (worst === "critical" || worst === "high") {
        const ok = window.confirm(
          "Des CVE Critical/High ont \xE9t\xE9 trouv\xE9es sur une ou plusieurs images.\n\nContinuer le d\xE9ploiement ?"
        );
        return { proceed: ok, advise };
      }
      return { proceed: true, advise };
    };
  }

  // public/assets/js/src/ui/shell.js
  function install3() {
    bag.pageHeader = function pageHeader(_title, withRefresh = true) {
      if (!withRefresh) return "";
      return `<div class="page-header page-header-tools">
      <button class="refresh" id="refresh" title="Actualiser">\u21BB</button>
    </div>`;
    };
    bag.isSettingsSection = function isSettingsSection(route) {
      const r = String(route ?? bag.state.route ?? "");
      return r === "settings" || r.startsWith("settings/") || r === "users" || r.startsWith("users/") || r === "teams" || r.startsWith("teams/") || r === "nodes" || r.startsWith("nodes/") || r === "registries" || r.startsWith("registries/");
    };
    bag.settingsSubnav = function settingsSubnav(active) {
      const isAdmin = Number(bag.state.user?.Role) === 1;
      const tabs = [
        ["settings", "G\xE9n\xE9ral", true, "#settings"],
        ["settings/auth", "Authentification", isAdmin, "#settings/auth"],
        ["registries", "Registres", true, "#registries"],
        ["nodes", "N\u0153uds", isAdmin, "#nodes"],
        ["users", "Utilisateurs", isAdmin, "#users"],
        ["teams", "\xC9quipes", isAdmin, "#teams"],
        ["settings/diagnostics/api", "Tests API", isAdmin, "#settings/diagnostics/api"]
      ].filter((row) => row[2]);
      return `<nav class="settings-subnav" aria-label="Sections param\xE8tres">
      ${tabs.map(([id, label, , href]) => {
        const isActive = active === id;
        const ico = id === "settings/auth" ? "users" : id.startsWith("settings/diagnostics") ? "inspect" : id.split("/")[0];
        return `<a href="${href}" class="settings-subnav-link${isActive ? " active" : ""}"><span class="nav-ico">${bag.ico(ico)}</span>${bag.esc(label)}</a>`;
      }).join("")}
    </nav>`;
    };
    bag.shell = function shell(title, bodyHtml, opts = {}) {
      const subtitle = opts.subtitle || "";
      const hidePageHeader = !!opts.hidePageHeader;
      const items = [
        ["dashboard", "Tableau de bord"],
        ["stacks", "Stacks"],
        ["containers", "Conteneurs"],
        ["volumes", "Volumes"],
        ["images", "Images"],
        ["networks", "R\xE9seaux"],
        ["activity", "Journaux"],
        ["settings", "Param\xE8tres"]
      ];
      const nav = items.map(([id, label]) => {
        const active = id === "settings" ? bag.isSettingsSection(bag.state.route) : bag.state.route === id || bag.state.route.startsWith(id + "/");
        return `<a href="#${id}" class="${active ? "active" : ""}" title="${bag.esc(label)}" aria-label="${bag.esc(label)}"><span class="nav-ico">${bag.ico(id)}</span><span class="nav-label">${label}</span></a>`;
      }).join("");
      const initial = (bag.state.user?.Username || "A").slice(0, 2).toUpperCase();
      const username = bag.state.user?.Username || "admin";
      const engine = bag.state.engineVersion ? `Docker Engine v${bag.state.engineVersion}` : "Docker Engine";
      const allMode = Number(bag.state.endpointId) === 0;
      const currentEp = allMode ? null : (bag.state.endpoints || []).find((e) => Number(e.Id) === Number(bag.state.endpointId)) || { Id: bag.state.endpointId, Name: "local", Kind: "local", Status: 1 };
      const nodeLabel = allMode ? `${(bag.state.endpoints || []).length} n\u0153uds` : currentEp.NodeName || currentEp.Name || "local";
      const nodeKind = allMode ? "Cluster" : currentEp.Kind === "agent" ? "Agent" : "Local";
      const epOnline = allMode ? !!bag.state.dockerOnline : Number(currentEp?.Status) === 1;
      const epOptions = [
        ...(bag.state.endpoints || []).length > 1 ? [`<option value="0" ${allMode ? "selected" : ""}>Tous les n\u0153uds</option>`] : [],
        ...(bag.state.endpoints || []).map(
          (e) => `<option value="${bag.esc(e.Id)}" ${!allMode && Number(e.Id) === Number(bag.state.endpointId) ? "selected" : ""}>${bag.esc(e.NodeName || e.Name)} (${e.Kind === "agent" ? "agent" : "local"})</option>`
        )
      ].join("");
      const collapsed = !!bag.state.sidebarCollapsed;
      const toggleTitle = collapsed ? "Afficher le menu" : "R\xE9duire le menu";
      return `
      <div class="shell">
        <aside class="sidebar${collapsed ? " is-collapsed" : ""}">
          <div class="brand brand-full">
            ${bag.brandLogoImg("brand-logo-img brand-logo-wide", "/assets/img/wharfmaster-logo-light-sm.png")}
            <div class="brand-ver">${bag.esc(bag.appVersionLabel() || "\u2026")}</div>
          </div>
          <div class="nav-section">
            <nav class="nav">${nav}</nav>
          </div>
          <div class="sidebar-bottom">
            <nav class="nav">
              <a href="#docs" class="${bag.state.route === "docs" ? "active" : ""}" title="Documentation" aria-label="Documentation"><span class="nav-ico">${bag.ico("docs")}</span><span class="nav-label">Documentation</span></a>
              <a href="#logout" title="D\xE9connexion" aria-label="D\xE9connexion"><span class="nav-ico">${bag.ico("logout")}</span><span class="nav-label">D\xE9connexion</span></a>
            </nav>
            <div class="engine-pill" title="${bag.esc((allMode ? "Tous les n\u0153uds" : engine) + " \xB7 " + nodeKind + " \xB7 " + nodeLabel)}">
              <span class="dot ${epOnline ? "" : "off"}"></span>
              <div class="engine-pill-text"><strong>${bag.esc(allMode ? "Tous les n\u0153uds" : engine)}</strong>${bag.esc(nodeKind)} \xB7 ${bag.esc(nodeLabel)}</div>
            </div>
          </div>
          <button type="button" class="sidebar-toggle" id="sidebar-toggle" title="${bag.esc(toggleTitle)}" aria-label="${bag.esc(toggleTitle)}" aria-expanded="${collapsed ? "false" : "true"}">
            <span class="btn-ico">${bag.ico(collapsed ? "panel-right" : "panel-left")}</span>
          </button>
        </aside>
        <div class="main">
          <header class="topbar">
            <div class="topbar-title">
              <h1>${bag.esc(title)}</h1>
              ${subtitle ? `<p class="sub">${bag.esc(subtitle)}</p>` : ""}
            </div>
            <div class="topbar-right">
              ${(bag.state.endpoints || []).length > 1 ? `<label class="node-select-wrap"><span>N\u0153ud</span><select id="endpoint-select">${epOptions}</select></label>` : ""}
              <span class="status-online ${bag.state.dockerOnline ? "" : "is-offline"}" id="status-online">
                <span class="dot"></span>${bag.state.dockerOnline ? "En ligne" : "Hors ligne"}
              </span>
              <button type="button" class="theme-toggle" id="theme-toggle" title="${bag.esc(bag.themeToggleTitle(bag.state.theme))}">${bag.themeToggleLabel(bag.state.theme)}</button>
              <div class="notif-wrap">
                <button type="button" class="icon-btn notif-btn" id="notif-bell" title="Notifications" aria-label="Notifications" aria-expanded="false">
                  ${bag.ico("bell")}
                  <span class="notif-badge" id="notif-badge" ${bag.visibleAlerts().length ? "" : "hidden"}>${bag.badgeCount(bag.visibleAlerts().length)}</span>
                </button>
                <div class="notif-panel" id="notif-panel" hidden>
                  <div class="notif-panel-head">
                    <strong>Alertes</strong>
                    <button type="button" class="notif-refresh" id="notif-refresh" title="Actualiser">\u21BB</button>
                  </div>
                  <div class="notif-panel-body" id="notif-list">${bag.renderAlertList()}</div>
                </div>
              </div>
              <a href="#profile" class="user-chip${bag.state.route === "profile" ? " is-active" : ""}" title="Profil \xB7 ${bag.esc(username)}" aria-label="Profil">
                <span class="avatar">${bag.esc(initial)}</span>
              </a>
            </div>
          </header>
          <div class="content">${hidePageHeader ? bodyHtml : bodyHtml}</div>
        </div>
      </div>`;
    };
    bag.pageLoadingHtml = function pageLoadingHtml(label = "Chargement\u2026") {
      return `<div class="page-loading" role="status" aria-live="polite">
      <span class="spinner spinner-lg" aria-hidden="true"></span>
      <span class="page-loading-label">${bag.esc(label)}</span>
    </div>`;
    };
    bag.searchBar = function searchBar(key, placeholder, shown, total, createHtml = "") {
      return `
      <div class="toolbar">
        <input class="search" id="filter" type="search" placeholder="${bag.esc(placeholder)}" value="${bag.esc(bag.state.filters[key] || "")}">
        ${createHtml}
        <div class="spacer"></div>
        <span class="muted mono" id="filter-count">${shown} / ${total}</span>
      </div>`;
    };
    bag.createBtn = function createBtn(elId, label, title = label) {
      return `<button type="button" class="btn btn-info btn-create" id="${bag.esc(elId)}" title="${bag.esc(title)}">
      <span class="btn-ico">${bag.ico("plus")}</span><span>${bag.esc(label)}</span>
    </button>`;
    };
    bag.bulkSelectTh = function bulkSelectTh(enabled) {
      if (!enabled) return "";
      return `<th class="col-check">
      <input type="checkbox" class="bulk-check-all" title="Tout s\xE9lectionner (page / filtre)" aria-label="Tout s\xE9lectionner">
    </th>`;
    };
    bag.bulkSelectTd = function bulkSelectTd(value, { disabled = false, title = "" } = {}) {
      if (disabled) {
        return `<td class="col-check"><input type="checkbox" disabled title="${bag.esc(title || "Non s\xE9lectionnable")}" aria-label="Non s\xE9lectionnable"></td>`;
      }
      return `<td class="col-check"><input type="checkbox" class="bulk-check" value="${bag.esc(String(value))}" aria-label="S\xE9lectionner"></td>`;
    };
    bag.bulkDeleteBtnHtml = function bulkDeleteBtnHtml() {
      return `<button type="button" class="btn btn-danger btn-sm bulk-delete-btn" id="bulk-delete" hidden disabled>
      <span class="btn-ico">${bag.ico("remove")}</span>
      <span>Supprimer (<span class="bulk-count">0</span>)</span>
    </button>`;
    };
    bag.bindBulkDelete = function bindBulkDelete(opts) {
      if (!opts?.enabled) return;
      const table = bag.root.querySelector("table.data");
      const btn = document.getElementById("bulk-delete");
      const checkAll = bag.root.querySelector(".bulk-check-all");
      if (!table || !btn) return;
      const visibleChecks = () => [...table.querySelectorAll("tbody tr[data-search]")].filter((tr) => tr.style.display !== "none").map((tr) => tr.querySelector("input.bulk-check")).filter((c) => c && !c.disabled);
      const selected = () => [...table.querySelectorAll("input.bulk-check:checked:not(:disabled)")].map((c) => c.value).filter(Boolean);
      const labelFor = (id) => {
        if (typeof opts.labelOne === "function") {
          const custom = opts.labelOne(id);
          if (custom) return custom;
        }
        const row = table.querySelector(`tr[data-resource-id="${CSS.escape(id)}"]`);
        const name = row?.dataset?.resourceName || "";
        return name && name !== "<none>" ? name : bag.shortId(id) || id;
      };
      const formatError = (id, err) => {
        const label = labelFor(id);
        if (typeof opts.formatError === "function") {
          return opts.formatError(id, label, err);
        }
        let msg = String(err?.message || err || "\xE9chec");
        msg = msg.replace(/sha256:[a-f0-9]{12,}/gi, label);
        return `${label} \u2014 ${msg}`;
      };
      const sync = () => {
        const ids = selected();
        const n = ids.length;
        const countEl = btn.querySelector(".bulk-count");
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
      table.addEventListener("change", (e) => {
        const t = e.target;
        if (!(t instanceof HTMLInputElement)) return;
        if (t.classList.contains("bulk-check-all")) {
          const on = t.checked;
          visibleChecks().forEach((c) => {
            c.checked = on;
          });
        }
        if (t.classList.contains("bulk-check") || t.classList.contains("bulk-check-all")) sync();
      });
      document.getElementById("filter")?.addEventListener("input", () => setTimeout(sync, 120));
      bag.root.querySelector(".table-pager")?.addEventListener("click", () => setTimeout(sync, 60));
      bag.onBusyClick(btn, async () => {
        const ids = selected();
        if (!ids.length) return;
        const msg = ids.length === 1 ? opts.confirmOne ? opts.confirmOne(ids[0]) : "Supprimer cet \xE9l\xE9ment ?" : opts.confirmMany ? opts.confirmMany(ids.length) : `Supprimer ${ids.length} \xE9l\xE9ments ?`;
        if (!window.confirm(msg)) return;
        const focus = { y: window.scrollY || window.pageYOffset || 0, id: "", name: "" };
        const errors = [];
        let ok = 0;
        let pending = [...ids];
        const passes = opts.retryFailed ? 2 : 1;
        for (let pass = 0; pass < passes; pass++) {
          const retry = [];
          for (const id of pending) {
            try {
              await opts.deleteOne(id);
              ok += 1;
            } catch (err) {
              if (pass < passes - 1) retry.push(id);
              else errors.push(formatError(id, err));
            }
          }
          pending = retry;
          if (!pending.length) break;
        }
        if (errors.length) {
          const head = ok > 0 ? `${ok} supprim\xE9(s), ${errors.length} \xE9chec(s) (les autres ont \xE9t\xE9 trait\xE9s) :` : `Aucune suppression \u2014 ${errors.length} \xE9chec(s) :`;
          window.alert(
            `${head}
${errors.slice(0, 10).join("\n")}${errors.length > 10 ? "\n\u2026" : ""}`
          );
        }
        bag.rememberListFocus(focus);
        await opts.reload();
        bag.restoreListFocus(focus);
      }, { disableSiblings: false, minMs: 300 });
      sync();
    };
    bag.ensureTablePager = function ensureTablePager() {
      let el = document.getElementById("table-pager");
      if (el) return el;
      const wrap = bag.root.querySelector(".table-wrap");
      if (!wrap) return null;
      el = document.createElement("div");
      el.id = "table-pager";
      el.className = "table-pager";
      el.hidden = true;
      wrap.insertAdjacentElement("afterend", el);
      return el;
    };
    bag.renderTablePager = function renderTablePager(pager, { page, pageCount, matched, pageSize }) {
      if (!pager) return;
      if (matched <= pageSize) {
        pager.hidden = true;
        pager.innerHTML = "";
        return;
      }
      pager.hidden = false;
      const prevDisabled = page <= 1 ? " disabled" : "";
      const nextDisabled = page >= pageCount ? " disabled" : "";
      const buttons = [];
      const windowSize = 5;
      let start = Math.max(1, page - Math.floor(windowSize / 2));
      let end = Math.min(pageCount, start + windowSize - 1);
      start = Math.max(1, end - windowSize + 1);
      if (start > 1) {
        buttons.push(`<button type="button" class="btn btn-sm table-pager-num" data-page="1">1</button>`);
        if (start > 2) buttons.push(`<span class="table-pager-ellipsis">\u2026</span>`);
      }
      for (let p = start; p <= end; p++) {
        buttons.push(
          `<button type="button" class="btn btn-sm table-pager-num${p === page ? " is-active" : ""}" data-page="${p}">${p}</button>`
        );
      }
      if (end < pageCount) {
        if (end < pageCount - 1) buttons.push(`<span class="table-pager-ellipsis">\u2026</span>`);
        buttons.push(`<button type="button" class="btn btn-sm table-pager-num" data-page="${pageCount}">${pageCount}</button>`);
      }
      pager.innerHTML = `
      <button type="button" class="btn btn-sm" data-page-nav="prev"${prevDisabled} title="Page pr\xE9c\xE9dente" aria-label="Page pr\xE9c\xE9dente">\u2190</button>
      <div class="table-pager-pages">${buttons.join("")}</div>
      <button type="button" class="btn btn-sm" data-page-nav="next"${nextDisabled} title="Page suivante" aria-label="Page suivante">\u2192</button>
      <span class="muted table-pager-meta">${bag.esc(String(pageSize))} / page</span>`;
    };
    bag.bindSearch = function bindSearch(key, opts = {}) {
      const input = document.getElementById("filter");
      const table = bag.root.querySelector("table.data tbody");
      if (!input || !table) return;
      const pageSize = Number(opts.pageSize) > 0 ? Number(opts.pageSize) : 0;
      const pager = pageSize > 0 ? bag.ensureTablePager() : null;
      const allRows = () => [...table.querySelectorAll("tr[data-search]")];
      const allTotal = allRows().length;
      const run = ({ resetPage = false } = {}) => {
        const q = input.value.trim().toLowerCase();
        bag.state.filters[key] = input.value;
        if (resetPage && pageSize > 0) bag.state.pages[key] = 1;
        const rows = allRows();
        const matched = [];
        rows.forEach((tr) => {
          const ok = !q || (tr.getAttribute("data-search") || "").includes(q);
          if (ok) matched.push(tr);
          else tr.style.display = "none";
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
            tr.style.display = i >= start && i < end ? "" : "none";
          });
          visible = matched.slice(start, end);
          const from = matched.length === 0 ? 0 : start + 1;
          const to = Math.min(end, matched.length);
          bag.updateFilterCount(matched.length === 0 ? "0" : `${from}\u2013${to}`, matched.length, allTotal);
          bag.renderTablePager(pager, { page, pageCount, matched: matched.length, pageSize });
        } else {
          matched.forEach((tr) => {
            tr.style.display = "";
          });
          bag.updateFilterCount(matched.length, allTotal);
        }
        const empty = table.querySelector("tr.filter-empty");
        if (empty) empty.remove();
        if (matched.length === 0 && rows.length > 0) {
          const cols = table.parentElement?.querySelectorAll("thead th").length || 4;
          const tr = document.createElement("tr");
          tr.className = "filter-empty";
          tr.innerHTML = `<td colspan="${cols}" class="empty">Aucun r\xE9sultat pour \u201C${bag.esc(input.value)}\u201D</td>`;
          table.appendChild(tr);
        }
        void visible;
      };
      let timer = null;
      input.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(() => run({ resetPage: true }), 80);
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          input.value = "";
          run({ resetPage: true });
        }
      });
      if (pager) {
        pager.onclick = (e) => {
          const nav = e.target.closest("[data-page-nav]");
          const num = e.target.closest("[data-page]");
          if (!nav && !num) return;
          e.preventDefault();
          const cur = Number(bag.state.pages[key]) || 1;
          if (nav) {
            const dir = nav.getAttribute("data-page-nav");
            bag.state.pages[key] = dir === "prev" ? cur - 1 : cur + 1;
          } else if (num) {
            bag.state.pages[key] = parseInt(num.getAttribute("data-page"), 10) || 1;
          }
          run();
        };
      }
      run({ resetPage: false });
    };
    bag.bindPagedSearch = function bindPagedSearch(key) {
      bag.bindSearch(key, { pageSize: bag.state.pageSize || 20 });
    };
    bag.getSort = function getSort(view) {
      return bag.state.sorts[view] || { key: "name", dir: "asc" };
    };
    bag.cmpSortValues = function cmpSortValues(a, b, dir) {
      const mul = dir === "desc" ? -1 : 1;
      if (typeof a === "number" && typeof b === "number" && Number.isFinite(a) && Number.isFinite(b)) {
        return (a - b) * mul;
      }
      return String(a ?? "").localeCompare(String(b ?? ""), "fr", {
        sensitivity: "base",
        numeric: true
      }) * mul;
    };
    bag.sortItems = function sortItems(list, view, getters) {
      const { key, dir } = bag.getSort(view);
      const get = getters[key] || getters.name;
      if (typeof get !== "function") return [...list];
      return [...list].sort((a, b) => bag.cmpSortValues(get(a), get(b), dir));
    };
    bag.sortTh = function sortTh(label, key, view, opts = {}) {
      const cur = bag.getSort(view);
      const active = cur.key === key;
      const arrow = active ? cur.dir === "asc" ? " \u25B2" : " \u25BC" : "";
      const tip = opts.title || `Trier par ${label}`;
      return `<th class="sortable${active ? " is-sorted" : ""}" data-sort-key="${bag.esc(key)}" data-sort-view="${bag.esc(view)}" title="${bag.esc(tip)}" role="columnheader" tabindex="0">${bag.esc(label)}<span class="sort-ind" aria-hidden="true">${arrow}</span></th>`;
    };
    bag.bindTableSort = function bindTableSort(view, reloadFn) {
      bag.root.querySelectorAll(`th.sortable[data-sort-view="${CSS.escape(view)}"]`).forEach((th) => {
        const activate = () => {
          const key = th.getAttribute("data-sort-key") || "name";
          const cur = bag.getSort(view);
          bag.state.sorts[view] = {
            key,
            dir: cur.key === key && cur.dir === "asc" ? "desc" : "asc"
          };
          if (typeof reloadFn === "function") reloadFn();
        };
        th.addEventListener("click", activate);
        th.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            activate();
          }
        });
      });
    };
    bag.updateFilterCount = function updateFilterCount(shown, total, allTotal) {
      const el = document.getElementById("filter-count");
      if (!el) return;
      if (allTotal != null && allTotal !== total) {
        el.textContent = `${shown} / ${total} (${allTotal})`;
      } else {
        el.textContent = `${shown} / ${total}`;
      }
    };
    bag.matchQuery = function matchQuery(q, ...parts) {
      if (!q) return true;
      const hay = parts.map((p) => String(p ?? "").toLowerCase()).join(" ");
      return hay.includes(q);
    };
    bag.iconBtn = function iconBtn({
      tag = "button",
      href,
      act,
      id,
      title,
      icon,
      danger = false,
      info = false,
      success = false,
      modal,
      name,
      running,
      del,
      reset,
      elId,
      label,
      editTeam,
      delTeam,
      delAcl,
      scanImg,
      runSched,
      delSched,
      statsId,
      shareType,
      shareKey,
      extraClass = ""
    }) {
      const withLabel = !!(label && String(label).trim());
      const cls = `btn btn-icon btn-sm${withLabel ? " btn-icon-label" : ""}${danger ? " btn-danger" : ""}${info ? " btn-info" : ""}${success ? " btn-success" : ""}${extraClass ? ` ${extraClass}` : ""}`;
      const attrs = [
        `class="${cls}"`,
        `title="${bag.esc(title)}"`,
        `aria-label="${bag.esc(title)}"`,
        elId ? `id="${bag.esc(elId)}"` : "",
        act ? `data-act="${bag.esc(act)}"` : "",
        id ? `data-id="${bag.esc(id)}"` : "",
        href ? `href="${href}"` : "",
        modal ? `data-modal="${bag.esc(modal)}"` : "",
        name ? `data-name="${bag.esc(name)}"` : "",
        running != null ? `data-running="${running ? "1" : "0"}"` : "",
        del != null ? `data-del="${bag.esc(del)}"` : "",
        reset != null ? `data-reset="${bag.esc(reset)}"` : "",
        editTeam != null ? `data-edit-team="${bag.esc(editTeam)}"` : "",
        delTeam != null ? `data-del-team="${bag.esc(delTeam)}"` : "",
        delAcl != null ? `data-del-acl="${bag.esc(delAcl)}"` : "",
        scanImg != null ? `data-scan-img="${bag.esc(scanImg)}"` : "",
        runSched != null ? `data-run-sched="${bag.esc(runSched)}"` : "",
        delSched != null ? `data-del-sched="${bag.esc(delSched)}"` : "",
        statsId != null ? `data-stats-id="${bag.esc(statsId)}"` : "",
        shareType != null ? `data-share-type="${bag.esc(shareType)}"` : "",
        shareKey != null ? `data-share-key="${bag.esc(shareKey)}"` : "",
        tag === "button" ? 'type="button"' : ""
      ].filter(Boolean).join(" ");
      const labelHtml = withLabel ? `<span class="btn-label">${bag.esc(label)}</span>` : "";
      return `<${tag} ${attrs}><span class="btn-ico">${bag.ico(icon)}</span>${labelHtml}</${tag}>`;
    };
    bag.moreActions = function moreActions(primaryHtml, moreHtml) {
      return `<div class="quick-actions">
      ${primaryHtml}
      <div class="qa-more">
        <button type="button" class="btn btn-icon btn-sm" data-qa-toggle title="Plus d\u2019actions" aria-label="Plus d\u2019actions" aria-expanded="false" aria-haspopup="true">
          <span class="btn-ico">${bag.ico("more")}</span>
        </button>
        <div class="qa-more-menu" hidden role="menu">${moreHtml}</div>
      </div>
    </div>`;
    };
    bag.closeMoreActions = function closeMoreActions(scope = document) {
      scope.querySelectorAll(".qa-more.is-open").forEach((el) => {
        el.classList.remove("is-open");
        const toggle = el.querySelector("[data-qa-toggle]");
        const menu = el.querySelector(".qa-more-menu");
        if (toggle) toggle.setAttribute("aria-expanded", "false");
        if (menu) menu.hidden = true;
      });
    };
    bag.bindMoreActions = function bindMoreActions(scope = bag.root) {
      if (!scope) return;
      scope.querySelectorAll("[data-qa-toggle]").forEach((btn) => {
        btn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const wrap = btn.closest(".qa-more");
          if (!wrap) return;
          const willOpen = !wrap.classList.contains("is-open");
          bag.closeMoreActions(scope);
          if (!willOpen) return;
          wrap.classList.add("is-open");
          btn.setAttribute("aria-expanded", "true");
          const menu = wrap.querySelector(".qa-more-menu");
          if (menu) menu.hidden = false;
        };
      });
      scope.querySelectorAll(".qa-more-menu").forEach((menu) => {
        menu.addEventListener("click", () => {
          setTimeout(() => bag.closeMoreActions(scope), 0);
        });
      });
      if (!bag._moreActionsDocBound) {
        bag._moreActionsDocBound = true;
        document.addEventListener("click", (e) => {
          if (e.target.closest?.(".qa-more")) return;
          bag.closeMoreActions();
        });
        document.addEventListener("keydown", (e) => {
          if (e.key === "Escape") bag.closeMoreActions();
        });
      }
    };
    bag.ico = function ico(name) {
      const icons = {
        dashboard: '<svg viewBox="0 0 16 16"><path d="M1 1h6v6H1V1zm8 0h6v6H9V1zM1 9h6v6H1V9zm8 0h6v6H9V9z"/></svg>',
        stacks: '<svg viewBox="0 0 16 16"><path d="M0 4l8-3 8 3-8 3L0 4zm0 4l8 3 8-3v2l-8 3-8-3V8zm0 4l8 3 8-3v2l-8 3-8-3v-2z"/></svg>',
        /* Mockup-style resource icons (cube / picture / cylinder / nodes) */
        containers: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3.2L20 7.4v9.2L12 20.8 4 16.6V7.4L12 3.2z" fill="currentColor" opacity=".22"/><path d="M12 3.2L20 7.4v9.2L12 20.8 4 16.6V7.4L12 3.2z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 12.2L20 7.4M12 12.2L4 7.4M12 12.2V20.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
        images: '<svg viewBox="0 0 24 24" fill="none"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" fill="currentColor" opacity=".2" stroke="currentColor" stroke-width="1.6"/><circle cx="9" cy="10" r="2" fill="currentColor"/><path d="M4.5 16.5l4.2-4.2a1.4 1.4 0 012 0L14 16l2.2-2.2a1.4 1.4 0 012 0l1.3 1.3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        volumes: '<svg viewBox="0 0 24 24" fill="none"><ellipse cx="12" cy="6.5" rx="6.5" ry="2.6" fill="currentColor" opacity=".25" stroke="currentColor" stroke-width="1.6"/><path d="M5.5 6.5v11c0 1.4 2.9 2.6 6.5 2.6s6.5-1.2 6.5-2.6v-11" stroke="currentColor" stroke-width="1.6"/><ellipse cx="12" cy="12" rx="6.5" ry="2.6" stroke="currentColor" stroke-width="1.4" opacity=".7"/><ellipse cx="12" cy="17.5" rx="6.5" ry="2.6" stroke="currentColor" stroke-width="1.4" opacity=".55"/></svg>',
        networks: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="6.5" r="2.6" fill="currentColor" opacity=".25" stroke="currentColor" stroke-width="1.6"/><circle cx="6.2" cy="16.8" r="2.6" fill="currentColor" opacity=".25" stroke="currentColor" stroke-width="1.6"/><circle cx="17.8" cy="16.8" r="2.6" fill="currentColor" opacity=".25" stroke="currentColor" stroke-width="1.6"/><path d="M10.2 8.4L7.6 14.4M13.8 8.4l2.6 6M8.8 16.8h6.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
        settings: '<svg viewBox="0 0 16 16"><path d="M6.5 1h3l.4 2.1a5 5 0 011.4.8L13.5 3l1.5 2.6-1.7 1.2a5 5 0 010 1.6l1.7 1.2L13.5 13l-2.2-.9a5 5 0 01-1.4.8L9.5 15h-3l-.4-2.1a5 5 0 01-1.4-.8L2.5 13 1 10.4l1.7-1.2a5 5 0 010-1.6L1 6.4 2.5 3.8l2.2.9a5 5 0 011.4-.8L6.5 1zM8 6a2 2 0 100 4 2 2 0 000-4z"/></svg>',
        users: '<svg viewBox="0 0 16 16"><path d="M8 8a3 3 0 100-6 3 3 0 000 6zm-5 6v-1a4 4 0 014-4h2a4 4 0 014 4v1H3zm10-7a2 2 0 100-4 2 2 0 000 4zm1 7v-1a4.9 4.9 0 00-1.5-3.5A4 4 0 0115 13v1h-1z"/></svg>',
        teams: '<svg viewBox="0 0 16 16"><path d="M8 8a3 3 0 100-6 3 3 0 000 6zm-5 6v-1a4 4 0 014-4h2a4 4 0 014 4v1H3zm10-7a2 2 0 100-4 2 2 0 000 4zm1 7v-1a4.9 4.9 0 00-1.5-3.5A4 4 0 0115 13v1h-1z"/><path d="M1 5.5A1.5 1.5 0 012.5 4h1a.5.5 0 010 1h-1a.5.5 0 00-.5.5v1a.5.5 0 01-1 0v-1z"/></svg>',
        registries: '<svg viewBox="0 0 16 16"><path d="M2 2h12v3H2V2zm0 4.5h12V10H2V6.5zM2 11h12v3H2v-3z"/></svg>',
        about: '<svg viewBox="0 0 16 16"><path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM7.25 5h1.5v1.5h-1.5V5zM7.25 7.5h1.5V11h-1.5V7.5z"/></svg>',
        docs: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2.5h6.5L13 5v8.5H4V2.5z"/><path d="M10.5 2.5V5H13"/><path d="M6 8h4M6 10.5h4M6 13h2.5"/></svg>',
        logout: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2.5H3.5A1.5 1.5 0 002 4v8a1.5 1.5 0 001.5 1.5H6M10.5 11.5L14 8l-3.5-3.5M14 8H6"/></svg>',
        bell: '<svg viewBox="0 0 16 16"><path d="M8 1.75a3.5 3.5 0 00-3.5 3.5v2.1L3.2 9.6A.75.75 0 003.75 11h8.5a.75.75 0 00.55-1.25L11.5 7.35V5.25A3.5 3.5 0 008 1.75zM6.6 12.5a1.4 1.4 0 002.8 0"/></svg>',
        pull: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8M5 7.5L8 10l3-2.5M3 12.5h10"/></svg>',
        download: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v7.5M5 7l3 2.5L11 7M3 12.5h10"/><path d="M3.5 14h9"/></svg>',
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
        "panel-left": '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="1.75" y="2.25" width="12.5" height="11.5" rx="2"/><path d="M5.75 2.25v11.5"/><path d="M10.25 6.25 8.5 8l1.75 1.75"/></svg>',
        "panel-right": '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="1.75" y="2.25" width="12.5" height="11.5" rx="2"/><path d="M5.75 2.25v11.5"/><path d="M8.5 6.25 10.25 8 8.5 9.75"/></svg>',
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
        more: '<svg viewBox="0 0 16 16"><circle cx="3.5" cy="8" r="1.35"/><circle cx="8" cy="8" r="1.35"/><circle cx="12.5" cy="8" r="1.35"/></svg>'
      };
      return icons[name] || icons.dashboard;
    };
    bag.badge = function badge(stateName) {
      const s = String(stateName || "").toLowerCase();
      let cls = "badge badge-status";
      let label = stateName || "inconnu";
      if (s.includes("running") || s === "restarting") {
        cls += " badge-running";
        label = s === "restarting" || s.includes("restart") ? "Restarting" : "Running";
      } else if (s.includes("exit") || s.includes("dead") || s === "stopped" || s.includes("stop")) {
        cls += " badge-stopped";
        label = "Stopped";
      } else if (s.includes("pause")) {
        cls += " badge-paused";
        label = "Paused";
      } else if (s.includes("creat")) {
        cls += " badge-created";
        label = "Created";
      } else if (s.includes("remov") || s.includes("delet")) {
        cls += " badge-exited";
        label = "Removed";
      } else {
        cls += " badge-created";
      }
      return `<span class="${cls}" title="${bag.esc(String(stateName || label))}"><span class="badge-dot" aria-hidden="true"></span>${bag.esc(label)}</span>`;
    };
    bag.brandMarkImg = function brandMarkImg(cls = "brand-mark-img") {
      return `<img class="${cls}" src="/assets/img/wharfmaster-mark.png" width="40" height="40" alt="" decoding="async">`;
    };
    bag.brandLogoImg = function brandLogoImg(cls = "brand-logo-img", src = "/assets/img/wharfmaster-logo-light.png") {
      return `<img class="${cls}" src="${src}" alt="WharfMaster" decoding="async">`;
    };
    bag.sparklineFromValues = function sparklineFromValues(values, tone = "blue") {
      const pts = (values || []).map((v) => Math.max(0, Number(v) || 0));
      const w = 100;
      const h = 28;
      const padY = 3;
      let line;
      let fill;
      if (pts.length === 0) {
        line = `M0 ${h / 2} L${w} ${h / 2}`;
        fill = `M0 ${h} L0 ${h / 2} L${w} ${h / 2} L${w} ${h} Z`;
      } else {
        const max = Math.max(...pts, 1);
        const yAt = (v) => padY + (1 - Math.min(1, v / max)) * (h - padY * 2);
        const coords = pts.map((v, i) => {
          const x = pts.length === 1 ? w / 2 : i / (pts.length - 1) * w;
          return [x, yAt(v)];
        });
        if (coords.length === 1) {
          const y = coords[0][1];
          line = `M0 ${y.toFixed(2)} L${w} ${y.toFixed(2)}`;
          fill = `M0 ${h} L0 ${y.toFixed(2)} L${w} ${y.toFixed(2)} L${w} ${h} Z`;
        } else {
          line = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c[0].toFixed(2)} ${c[1].toFixed(2)}`).join(" ");
          const last2 = coords[coords.length - 1];
          const first = coords[0];
          fill = `${line} L${last2[0].toFixed(2)} ${h} L${first[0].toFixed(2)} ${h} Z`;
        }
      }
      const n = pts.length;
      const last = n ? pts[n - 1] : 0;
      const title = n < 2 ? "Historique en construction \u2014 revenez plus tard" : `${n} relev\xE9s \xB7 dernier ${last} \xB7 max ${Math.max(...pts, 0)}`;
      return `<svg class="sparkline ${tone}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${bag.esc(title)}"><title>${bag.esc(title)}</title><path class="fill" d="${fill}" fill="currentColor"/><path d="${line}"/></svg>`;
    };
    bag.sparkline = function sparkline(tone = "blue") {
      return bag.sparklineFromValues([], tone);
    };
    bag.dashMetricMeta = {
      containers: { label: "Conteneurs", tone: "blue", color: "#38bdf8", href: "#containers" },
      images: { label: "Images", tone: "purple", color: "#c084fc", href: "#images" },
      volumes: { label: "Volumes", tone: "green", color: "#4ade80", href: "#volumes" },
      networks: { label: "R\xE9seaux", tone: "orange", color: "#fb923c", href: "#networks" }
    };
    bag.dashStatCard = function dashStatCard(key, tone, label, value, series) {
      const icoKey = key === "networks" ? "networks" : key;
      return `<div class="stat-card stat-card-row" data-metric="${bag.esc(key)}" data-tone="${bag.esc(tone)}">
      <div class="stat-ico ${tone}" aria-hidden="true">${bag.ico(icoKey)}</div>
      <div class="stat-mid">
        <div class="stat-value">${Number(value) || 0}</div>
        <div class="stat-label">${bag.esc(label)}</div>
      </div>
      <div class="stat-right">
        ${bag.metricDeltaHtml(series, key)}
        <button type="button" class="sparkline-btn" data-metric-detail="${bag.esc(key)}" title="Voir l\u2019historique d\xE9taill\xE9" aria-label="Ouvrir l\u2019historique ${bag.esc(label)}">
          ${bag.sparklineFromValues(bag.metricValues(series, key), tone)}
        </button>
      </div>
    </div>`;
    };
    bag.dashHeroHtml = function dashHeroHtml(opts = {}) {
      const title = opts.title || "Bienvenue sur WharfMaster !";
      const parts = String(title).split(/WharfMaster/);
      const heading = parts.length > 1 ? `${bag.esc(parts[0])}<span class="dash-hero-brand">WharfMaster</span>${bag.esc(parts.slice(1).join("WharfMaster"))}` : bag.esc(title);
      const sub = opts.subtitle || "Une interface moderne pour g\xE9rer votre environnement Docker.";
      return `<section class="dash-hero" aria-label="Bienvenue">
      <div class="dash-hero-bg" role="presentation"></div>
      <div class="dash-hero-veil" aria-hidden="true"></div>
      <div class="dash-hero-body">
        <h2 class="dash-hero-title">${heading}</h2>
        <p class="dash-hero-sub">${bag.esc(sub)}</p>
      </div>
    </section>`;
    };
    bag.gaugeRing = function gaugeRing(pct, color = "#3b82f6") {
      const p = Math.max(0, Math.min(100, Number(pct) || 0));
      const r = 34;
      const c = 2 * Math.PI * r;
      const off = c - p / 100 * c;
      return `<svg viewBox="0 0 84 84">
      <circle cx="42" cy="42" r="${r}" fill="none" stroke="rgba(148,163,184,.15)" stroke-width="7"/>
      <circle cx="42" cy="42" r="${r}" fill="none" stroke="${color}" stroke-width="7"
        stroke-linecap="round" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"
        transform="rotate(-90 42 42)"/>
      <text x="42" y="46" text-anchor="middle" fill="currentColor" font-size="14" font-weight="700">${p.toFixed(0)}%</text>
    </svg>`;
    };
    bag.usageCell = function usageCell(pct, label, kind = "cpu") {
      const p = Math.max(0, Math.min(100, Number(pct) || 0));
      let bar = kind === "mem" ? "usage-bar mem" : "usage-bar";
      if (p >= 85) bar += " danger";
      else if (p >= 65) bar += " warn";
      return `<div class="usage-cell"><div class="u-val">${bag.esc(label)}</div><div class="${bar}"><span style="width:${p.toFixed(0)}%"></span></div></div>`;
    };
    bag.pctBar = function pctBar(pct) {
      const p = Math.max(0, Math.min(100, Number(pct) || 0));
      return `<div class="progress"><span style="width:${p.toFixed(1)}%"></span></div>`;
    };
    bag.makeSpinner = function makeSpinner(extraClass = "") {
      const s = document.createElement("span");
      s.className = "spinner spinner-abs" + (extraClass ? " " + extraClass : "");
      s.setAttribute("aria-hidden", "true");
      return s;
    };
    bag.withBusy = async function withBusy(btn, fn, opts = {}) {
      if (!btn) return fn();
      if (btn.dataset.busy === "1") return;
      const row = opts.row !== void 0 ? opts.row : btn.closest("tr") || btn.closest(".quick-actions") || btn.closest(".toolbar") || btn.closest(".actions-bar") || null;
      const siblings = opts.disableSiblings === false ? [] : row ? Array.from(row.querySelectorAll("button, a.btn, .btn, .refresh")) : [];
      btn.dataset.busy = "1";
      btn.classList.add("is-loading");
      if ("disabled" in btn) btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
      const spinner = bag.makeSpinner(btn.classList.contains("btn-primary") ? "spinner-dark" : "");
      btn.appendChild(spinner);
      siblings.forEach((el) => {
        if (el === btn) return;
        if ("disabled" in el) el.disabled = true;
        el.classList.add("is-disabled-temp");
      });
      if (row) row.classList.add("row-busy");
      const started = Date.now();
      try {
        return await fn();
      } finally {
        const wait = Math.max(0, (opts.minMs ?? 280) - (Date.now() - started));
        if (wait) await new Promise((r) => setTimeout(r, wait));
        if (btn.isConnected) {
          spinner.remove();
          btn.classList.remove("is-loading");
          if ("disabled" in btn) btn.disabled = false;
          btn.removeAttribute("aria-busy");
          delete btn.dataset.busy;
        }
        siblings.forEach((el) => {
          if (!el.isConnected) return;
          if ("disabled" in el) el.disabled = false;
          el.classList.remove("is-disabled-temp");
        });
        if (row && row.isConnected) row.classList.remove("row-busy");
      }
    };
    bag.captureListFocus = function captureListFocus(fromEl) {
      const tr = fromEl?.closest?.("tr") || null;
      const id = String(
        fromEl?.dataset?.id || fromEl?.dataset?.name || fromEl?.dataset?.updId || tr?.dataset?.stackId || tr?.dataset?.containerId || tr?.dataset?.resourceId || ""
      );
      const name = String(
        fromEl?.dataset?.name || tr?.dataset?.resourceName || ""
      );
      return {
        y: window.scrollY || window.pageYOffset || 0,
        id,
        name
      };
    };
    bag.rememberListFocus = function rememberListFocus(focusOrEl) {
      const focus = focusOrEl && focusOrEl.nodeType ? bag.captureListFocus(focusOrEl) : focusOrEl || null;
      bag.pendingListFocus = focus;
      return focus;
    };
    bag.restoreListFocus = function restoreListFocus(focus) {
      const f = focus || bag.pendingListFocus;
      bag.pendingListFocus = null;
      if (!f) return;
      const run = () => {
        const root = bag.root;
        let row = null;
        if (root && f.id) {
          const id = String(f.id);
          row = root.querySelector(`tr[data-stack-id="${CSS.escape(id)}"]`) || root.querySelector(`tr[data-container-id="${CSS.escape(id)}"]`) || root.querySelector(`tr[data-resource-id="${CSS.escape(id)}"]`) || root.querySelector(`[data-id="${CSS.escape(id)}"]`)?.closest("tr") || root.querySelector(`[data-upd-id="${CSS.escape(id)}"]`)?.closest("tr");
        }
        if (!row && root && f.name) {
          const name = String(f.name);
          row = root.querySelector(`tr[data-resource-name="${CSS.escape(name)}"]`) || root.querySelector(`[data-name="${CSS.escape(name)}"]`)?.closest("tr");
        }
        if (row) {
          row.scrollIntoView({ block: "nearest", inline: "nearest" });
          row.classList.add("row-flash");
          window.setTimeout(() => {
            if (row.isConnected) row.classList.remove("row-flash");
          }, 1400);
          return;
        }
        window.scrollTo(0, f.y || 0);
      };
      requestAnimationFrame(() => requestAnimationFrame(run));
    };
    bag.onBusyClick = function onBusyClick(el, handler, opts = {}) {
      if (!el) return;
      el.addEventListener("click", async (e) => {
        e.preventDefault();
        if (opts.confirm && !window.confirm(opts.confirm)) return;
        const target = e.currentTarget;
        const focus = bag.captureListFocus(target);
        try {
          const result = await bag.withBusy(target, () => handler(target, e), opts);
          if (result === "navigated") return;
          if (opts.reload) {
            bag.rememberListFocus(focus);
            if (typeof opts.reload === "function") await opts.reload();
            else await bag.route();
            bag.restoreListFocus(focus);
          }
        } catch (err) {
          alert(err.message || String(err));
        }
      });
    };
    bag.bindRefresh = function bindRefresh() {
      const btn = document.getElementById("refresh");
      if (!btn) return;
      bag.onBusyClick(btn, async () => {
        await bag.route();
      }, { disableSiblings: false, minMs: 200 });
    };
    bag.modalHost = function modalHost() {
      let el = document.getElementById("app-modal");
      if (!el) {
        el = document.createElement("div");
        el.id = "app-modal";
        document.body.appendChild(el);
      }
      return el;
    };
    bag.closeAppModal = function closeAppModal() {
      if (bag.state.logTimer) {
        clearInterval(bag.state.logTimer);
        bag.state.logTimer = null;
      }
      if (bag.state.statsTimer) {
        clearInterval(bag.state.statsTimer);
        bag.state.statsTimer = null;
      }
      if (typeof bag.closeConsoleSession === "function") {
        bag.closeConsoleSession();
      } else if (bag.state.term) {
        try {
          bag.state.term.dispose();
        } catch (_) {
        }
        bag.state.term = null;
      }
      const host = document.getElementById("app-modal");
      if (host) host.innerHTML = "";
    };
    bag.bindAppModalChrome = function bindAppModalChrome() {
      const host = bag.modalHost();
      host.querySelectorAll("[data-close-modal]").forEach((el) => {
        el.onclick = (e) => {
          e.preventDefault();
          bag.closeAppModal();
        };
      });
      const backdrop = host.querySelector(".modal-backdrop");
      if (backdrop) {
        backdrop.addEventListener("click", (e) => {
          if (e.target === backdrop) bag.closeAppModal();
        });
      }
      host.querySelectorAll(".modal-workspace").forEach((modal) => bag.enableWorkspaceModalResize(modal));
    };
    const WORKSPACE_MODAL_SIZE_KEY = "wm_workspace_modal_size";
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
    };
    bag.saveWorkspaceModalSize = function saveWorkspaceModalSize(w, h) {
      try {
        localStorage.setItem(bag.WORKSPACE_MODAL_SIZE_KEY, JSON.stringify({ w: Math.round(w), h: Math.round(h) }));
      } catch (_) {
      }
    };
    bag.clampWorkspaceModalSize = function clampWorkspaceModalSize(w, h) {
      const maxW = Math.max(320, window.innerWidth - 28);
      const maxH = Math.max(280, window.innerHeight - 24);
      const minW = Math.min(720, maxW);
      const minH = Math.min(420, maxH);
      return {
        w: Math.min(maxW, Math.max(minW, w)),
        h: Math.min(maxH, Math.max(minH, h))
      };
    };
    bag.applyWorkspaceModalSize = function applyWorkspaceModalSize(modal, w, h) {
      const size = bag.clampWorkspaceModalSize(w, h);
      modal.style.width = `${size.w}px`;
      modal.style.height = `${size.h}px`;
      modal.style.maxWidth = "calc(100vw - 28px)";
      modal.style.maxHeight = "calc(100vh - 24px)";
      modal.dispatchEvent(new CustomEvent("wm-modal-resize", { bubbles: true }));
      return size;
    };
    bag.enableWorkspaceModalResize = function enableWorkspaceModalResize(modal) {
      if (!modal || modal.dataset.resizeBound === "1") return;
      modal.dataset.resizeBound = "1";
      const saved = bag.readWorkspaceModalSize();
      if (saved) bag.applyWorkspaceModalSize(modal, saved.w, saved.h);
      let handle = modal.querySelector(".modal-resize-handle");
      if (!handle) {
        handle = document.createElement("div");
        handle.className = "modal-resize-handle";
        handle.title = "Redimensionner";
        handle.setAttribute("aria-hidden", "true");
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
          startH + (e.clientY - startY)
        );
        bag.saveWorkspaceModalSize(next.w, next.h);
      };
      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        modal.classList.remove("is-resizing");
        document.body.style.cursor = "";
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      handle.addEventListener("pointerdown", (e) => {
        if (e.button != null && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        dragging = true;
        const rect = modal.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        startW = rect.width;
        startH = rect.height;
        modal.classList.add("is-resizing");
        document.body.style.cursor = "nwse-resize";
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      });
    };
    bag.promptName = function promptName({ title, label, value = "", confirmLabel = "OK", placeholder = "" } = {}) {
      return new Promise((resolve) => {
        bag.closeAppModal();
        const host = bag.modalHost();
        host.innerHTML = `
        <div class="modal-backdrop">
          <div class="modal modal-form" role="dialog" aria-modal="true">
            <div class="modal-head">
              <div><h3>${bag.esc(title || "Saisie")}</h3></div>
              <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">\u2715</button>
            </div>
            <form id="prompt-name-form">
              <div class="form-group">
                <label>${bag.esc(label || "Nom")}</label>
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
        const input = document.getElementById("prompt-name-input");
        const form = document.getElementById("prompt-name-form");
        let done = false;
        const finish = (val) => {
          if (done) return;
          done = true;
          bag.closeAppModal();
          resolve(val);
        };
        host.querySelectorAll("[data-close-modal]").forEach((el) => {
          el.addEventListener("click", () => finish(null));
        });
        form.addEventListener("submit", (e) => {
          e.preventDefault();
          const v = (input.value || "").trim();
          if (!v) return;
          finish(v);
        });
        input.focus();
        input.select();
      });
    };
    bag.bindModalActions = function bindModalActions(scope = bag.root) {
      scope.querySelectorAll("[data-modal]").forEach((btn) => {
        btn.onclick = async (e) => {
          e.preventDefault();
          const id = btn.dataset.id;
          const name = btn.dataset.name || bag.shortId(id);
          const running = btn.dataset.running === "1";
          if (btn.dataset.modal === "logs") await bag.openLogsModal(id, name);
          else if (btn.dataset.modal === "console") await bag.openConsoleModal(id, name, running);
          else if (btn.dataset.modal === "inspect") await bag.openInspectModal(id, name);
          else if (btn.dataset.modal === "stats") await bag.openContainerStatsModal(id, name, running);
        };
      });
    };
    bag.authView = function authView(mode, err) {
      const isInit = mode === "init";
      return `
      <div class="auth-wrap">
        <form class="auth-card" id="auth-form">
          <div class="logo logo-full">${bag.brandLogoImg("auth-logo-img")}</div>
          <div class="sub">${isInit ? "Veuillez cr\xE9er le compte administrateur initial." : "Connectez-vous \xE0 votre instance WharfMaster."}</div>
          ${err ? `<div class="error-box">${bag.esc(err)}</div>` : ""}
          <div class="form-group"><label>Nom d'utilisateur</label>
          <input name="username" autocomplete="username" required value="admin"></div>
          <div class="form-group"><label>Mot de passe</label>
          <input name="password" type="password" autocomplete="${isInit ? "new-password" : "current-password"}" required minlength="10"></div>
          ${isInit ? `<div class="form-group"><label>Confirmer le mot de passe</label><input name="confirm" type="password" required minlength="10"></div>` : ""}
          <button class="btn btn-primary btn-block" type="submit" style="margin-top:8px">${isInit ? "Cr\xE9er l'utilisateur" : "Connexion"}</button>
          <p class="muted" style="margin:14px 0 0;text-align:center;font-size:.9rem"><a href="/">\xC0 propos du projet</a></p>
        </form>
      </div>`;
    };
    bag.renderAuth = async function renderAuth() {
      let needInit = false;
      try {
        const check = await bag.Api.adminCheck();
        needInit = !!check.adminInit;
      } catch {
        needInit = false;
      }
      bag.root.innerHTML = bag.authView(needInit ? "init" : "login", bag.state.error);
      document.getElementById("auth-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const form = e.target;
        const submitBtn = form.querySelector('button[type="submit"]');
        const fd = new FormData(form);
        const username = String(fd.get("username") || "");
        const password = String(fd.get("password") || "");
        try {
          await bag.withBusy(submitBtn, async () => {
            if (needInit) {
              if (password !== String(fd.get("confirm") || "")) throw new Error("Les mots de passe ne correspondent pas");
              await bag.Api.adminInit(username, password);
            }
            const res = await bag.Api.auth(username, password);
            bag.Api.setToken(res.jwt);
          }, { disableSiblings: false });
          bag.state.error = "";
          await bag.boot();
        } catch (err) {
          bag.state.error = err.message;
          bag.renderAuth();
        }
      });
    };
    bag.visibleAlerts = function visibleAlerts() {
      return (bag.state.alerts || []).filter((a) => !bag.state.dismissedAlerts.has(a.id));
    };
    bag.badgeCount = function badgeCount(n) {
      return n > 9 ? "9+" : String(n);
    };
    bag.renderAlertList = function renderAlertList() {
      const list = bag.visibleAlerts();
      if (!list.length) {
        return `<div class="notif-empty">Aucune alerte pour le moment.</div>`;
      }
      return list.map((a) => `
      <div class="notif-item level-${bag.esc(a.level)}" data-alert-id="${bag.esc(a.id)}">
        <div class="notif-item-main">
          ${a.href ? `<a href="${bag.esc(a.href)}" class="notif-title">${bag.esc(a.title)}</a>` : `<div class="notif-title">${bag.esc(a.title)}</div>`}
          ${a.detail ? `<div class="notif-detail">${bag.esc(a.detail)}</div>` : ""}
        </div>
        <button type="button" class="notif-dismiss" data-dismiss="${bag.esc(a.id)}" title="Ignorer">\u2715</button>
      </div>
    `).join("");
    };
    bag.updateAlertUi = function updateAlertUi() {
      const badge = document.getElementById("notif-badge");
      const list = document.getElementById("notif-list");
      const status = document.getElementById("status-online");
      const alerts = bag.visibleAlerts();
      if (badge) {
        badge.hidden = alerts.length === 0;
        badge.textContent = bag.badgeCount(alerts.length);
      }
      if (list) list.innerHTML = bag.renderAlertList();
      if (status) {
        status.classList.toggle("is-offline", !bag.state.dockerOnline);
        status.innerHTML = `<span class="dot"></span>${bag.state.dockerOnline ? "En ligne" : "Hors ligne"}`;
      }
      bag.bindAlertDismiss();
    };
    bag.bindAlertDismiss = function bindAlertDismiss() {
      document.querySelectorAll("[data-dismiss]").forEach((btn) => {
        btn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          bag.state.dismissedAlerts.add(btn.dataset.dismiss);
          try {
            localStorage.setItem("dm_dismissed_alerts", JSON.stringify([...state.dismissedAlerts].slice(-80)));
          } catch (_) {
          }
          bag.updateAlertUi();
        };
      });
    };
    bag.bindAlertUi = function bindAlertUi() {
      const bell = document.getElementById("notif-bell");
      const panel = document.getElementById("notif-panel");
      const refresh = document.getElementById("notif-refresh");
      if (!bell || !panel) return;
      bell.onclick = (e) => {
        e.stopPropagation();
        const open = panel.hasAttribute("hidden");
        panel.hidden = !open;
        bell.setAttribute("aria-expanded", open ? "true" : "false");
        if (open) bag.refreshAlerts();
      };
      if (refresh) {
        refresh.onclick = (e) => {
          e.stopPropagation();
          bag.refreshAlerts();
        };
      }
      bag.bindAlertDismiss();
    };
    bag.pushContainerAlerts = function pushContainerAlerts(alerts, list, nodePrefix = "") {
      const stopped = list.filter((c) => {
        const s = String(c.State || "").toLowerCase();
        return s !== "running" && s !== "restarting" && s !== "removing";
      });
      const unhealthy = list.filter((c) => String(c.Status || "").toLowerCase().includes("(unhealthy)"));
      const prefix = nodePrefix ? `[${nodePrefix}] ` : "";
      if (stopped.length) {
        const names = stopped.slice(0, 4).map(
          (c) => c.Names && c.Names[0] ? c.Names[0].replace(/^\//, "") : bag.shortId(c.Id)
        );
        alerts.push({
          id: `stopped-${nodePrefix || "local"}-${stopped.length}-${stopped.map((c) => bag.shortId(c.Id)).join(",")}`,
          level: "warn",
          title: `${prefix}${stopped.length} conteneur${stopped.length > 1 ? "s" : ""} arr\xEAt\xE9${stopped.length > 1 ? "s" : ""}`,
          detail: names.join(", ") + (stopped.length > 4 ? "\u2026" : ""),
          href: "#containers"
        });
      }
      unhealthy.forEach((c) => {
        const name = c.Names && c.Names[0] ? c.Names[0].replace(/^\//, "") : bag.shortId(c.Id);
        alerts.push({
          id: `unhealthy-${nodePrefix || "local"}-${bag.shortId(c.Id)}`,
          level: "danger",
          title: `${prefix}${name} est unhealthy`,
          detail: c.Status || "",
          href: `#containers/${c.Id}`
        });
      });
    };
    bag.refreshAlerts = async function refreshAlerts() {
      const alerts = [];
      let online = true;
      try {
        if (bag.isAllNodes()) {
          const eps = bag.activeEndpoints();
          const probes = await Promise.all(eps.map(async (ep) => {
            const id = Number(ep.Id);
            const name = ep.NodeName || ep.Name || String(id);
            try {
              const [info, containers] = await Promise.all([
                bag.Api.dockerOn(id, "/info"),
                bag.Api.dockerOn(id, "/containers/json?all=true")
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
              level: "warn",
              title: `N\u0153ud hors ligne : ${p.name}`,
              detail: "Impossible de joindre le moteur Docker de ce n\u0153ud",
              href: "#nodes"
            });
          });
          okNodes.forEach((p) => bag.pushContainerAlerts(alerts, p.containers, p.name));
        } else {
          const [containers, host, info] = await Promise.all([
            bag.Api.docker("/containers/json?all=true"),
            bag.Api.host().catch(() => null),
            bag.Api.docker("/info").catch(() => null)
          ]);
          if (!info || !info.ServerVersion) {
            online = false;
          } else {
            bag.state.engineVersion = info.ServerVersion;
          }
          bag.pushContainerAlerts(alerts, containers || []);
          if (host && Number(host.DiskTotal) > 0) {
            const pct = Number(host.DiskUsedPercent) || Number(host.DiskUsed) / Number(host.DiskTotal) * 100;
            if (pct >= 95) {
              alerts.push({
                id: `disk-critical-${Math.floor(pct)}`,
                level: "danger",
                title: `Disque critique (${pct.toFixed(0)} %)`,
                detail: `${bag.formatBytes(host.DiskUsed)} utilis\xE9s sur ${bag.formatBytes(host.DiskTotal)}`,
                href: "#dashboard"
              });
            } else if (pct >= 85) {
              alerts.push({
                id: `disk-warn-${Math.floor(pct)}`,
                level: "warn",
                title: `Disque presque plein (${pct.toFixed(0)} %)`,
                detail: `${bag.formatBytes(host.DiskUsed)} / ${bag.formatBytes(host.DiskTotal)}`,
                href: "#dashboard"
              });
            }
          }
        }
      } catch (_) {
        online = false;
      }
      if (!online) {
        alerts.unshift({
          id: "docker-offline",
          level: "danger",
          title: bag.isAllNodes() ? "Aucun n\u0153ud joignable" : "Docker inaccessible",
          detail: bag.isAllNodes() ? "Impossible de joindre les moteurs Docker du cluster" : "Impossible de joindre le moteur Docker",
          href: "#dashboard"
        });
      }
      bag.state.dockerOnline = online;
      bag.state.alerts = alerts;
      bag.updateAlertUi();
    };
    bag.ensureAlertPolling = function ensureAlertPolling() {
      if (bag.state.alertTimer) return;
      bag.state.alertTimer = setInterval(() => {
        if (bag.state.user) bag.refreshAlerts();
      }, 45e3);
    };
  }

  // public/assets/js/src/ui/share.js
  function install4() {
    bag.shareBtn = function shareBtn(type, key, title = "Partager") {
      return bag.iconBtn({
        title,
        icon: "users",
        info: true,
        shareType: type,
        shareKey: key
      });
    };
    bag.bindShareButtons = function bindShareButtons(scope = bag.root) {
      if (!scope) return;
      scope.querySelectorAll("[data-share-type]").forEach((btn) => {
        btn.onclick = async (e) => {
          e.preventDefault();
          e.stopPropagation();
          const type = btn.dataset.shareType;
          const key = btn.dataset.shareKey;
          if (!type || !key) return;
          await bag.openShareModal(type, key);
        };
      });
    };
    bag.openShareModal = async function openShareModal(type, key) {
      const endpointId = bag.Api.getEndpointId();
      if (!endpointId || bag.Api.isAllEndpoints()) {
        alert("Choisissez un n\u0153ud pour partager");
        return;
      }
      bag.closeAppModal();
      const host = bag.modalHost();
      const typeLabel = {
        stack: "stack",
        container: "conteneur",
        volume: "volume",
        network: "r\xE9seau"
      }[type] || type;
      host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-form" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3>Partager ce ${bag.esc(typeLabel)}</h3>
              <div class="modal-sub mono">${bag.esc(key)}</div>
            </div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">\u2715</button>
          </div>
          <p class="muted" style="margin:0 0 14px">${type === "stack" ? "En plus des droits n\u0153uds. Inclut aussi les conteneurs, volumes et r\xE9seaux Compose de cette stack." : "En plus des droits n\u0153uds \u2014 le destinataire pourra utiliser cette ressource."}</p>
          <div id="share-err"></div>
          <div class="form-group">
            <label class="field-label">Utilisateur</label>
            <div class="img-search" id="share-user-wrap">
              <input id="share-user-q" type="search" placeholder="Rechercher un utilisateur\u2026" autocomplete="off" spellcheck="false">
              <div class="img-search-panel" id="share-user-panel" hidden>
                <div class="img-search-hint muted" id="share-user-hint">Saisissez un nom\u2026</div>
                <div id="share-user-results"></div>
              </div>
            </div>
            <div class="img-selected" id="share-user-sel" hidden>
              <span class="img-selected-badge is-local">User</span>
              <code class="mono" id="share-user-ref"></code>
              <button type="button" class="icon-btn img-selected-clear" id="share-user-clear" title="Changer" aria-label="Changer">\u2715</button>
            </div>
          </div>
          <div class="actions-bar">
            <button type="button" class="btn btn-primary" id="share-add">Partager</button>
            <button type="button" class="btn" data-close-modal>Annuler</button>
          </div>
          <div class="section-title" style="margin-top:18px">D\xE9j\xE0 partag\xE9 avec</div>
          <div id="share-list" class="muted">Chargement\u2026</div>
        </div>
      </div>`;
      bag.bindAppModalChrome();
      const errBox = document.getElementById("share-err");
      const listEl = document.getElementById("share-list");
      const addBtn = document.getElementById("share-add");
      const qInput = document.getElementById("share-user-q");
      const panel = document.getElementById("share-user-panel");
      const resultsEl = document.getElementById("share-user-results");
      const hintEl = document.getElementById("share-user-hint");
      const wrap = document.getElementById("share-user-wrap");
      const selBox = document.getElementById("share-user-sel");
      const selRef = document.getElementById("share-user-ref");
      const clearBtn = document.getElementById("share-user-clear");
      let directory = [];
      let selected = null;
      const showErr = (msg) => {
        errBox.innerHTML = msg ? `<div class="error-box">${bag.esc(msg)}</div>` : "";
      };
      const hidePanel = () => {
        panel.hidden = true;
      };
      const clearSelection = () => {
        selected = null;
        selBox.hidden = true;
        wrap.classList.remove("is-picked");
        qInput.value = "";
        qInput.focus();
      };
      const pickUser = (u) => {
        selected = u;
        selRef.textContent = u.Username;
        selBox.hidden = false;
        wrap.classList.add("is-picked");
        qInput.value = "";
        hidePanel();
        showErr("");
      };
      const renderResults = (q) => {
        const needle = String(q || "").trim().toLowerCase();
        if (!needle) {
          resultsEl.innerHTML = "";
          hintEl.hidden = false;
          hintEl.textContent = directory.length ? "Saisissez un nom\u2026" : "Aucun autre utilisateur";
          panel.hidden = false;
          return;
        }
        const matches = directory.filter((u) => String(u.Username || "").toLowerCase().includes(needle)).slice(0, 12);
        hintEl.hidden = true;
        if (!matches.length) {
          resultsEl.innerHTML = `<div class="img-search-hint muted">Aucun r\xE9sultat pour \xAB ${bag.esc(q)} \xBB</div>`;
        } else {
          resultsEl.innerHTML = matches.map((u) => `
          <button type="button" class="img-search-item" data-uid="${bag.esc(u.Id)}">
            <div class="img-search-main">
              <span class="img-search-name">${bag.esc(u.Username)}</span>
            </div>
          </button>`).join("");
          resultsEl.querySelectorAll("[data-uid]").forEach((btn) => {
            btn.onclick = () => {
              const id = parseInt(btn.dataset.uid, 10);
              const u = directory.find((x) => Number(x.Id) === id);
              if (u) pickUser(u);
            };
          });
        }
        panel.hidden = false;
      };
      qInput.addEventListener("input", () => renderResults(qInput.value));
      qInput.addEventListener("focus", () => renderResults(qInput.value));
      qInput.addEventListener("keydown", (e) => {
        if (e.key === "Escape") hidePanel();
      });
      clearBtn.onclick = () => clearSelection();
      document.addEventListener("click", function onDocClick(e) {
        if (!host.contains(e.target)) return;
        if (wrap.contains(e.target) || selBox.contains(e.target)) return;
        hidePanel();
      });
      const renderList = (shares) => {
        if (!shares.length) {
          listEl.innerHTML = '<span class="muted">Aucun partage pour l\u2019instant.</span>';
          return;
        }
        listEl.innerHTML = `<table class="data"><tbody>${shares.map((s) => `
        <tr>
          <td>${bag.esc(s.GranteeUsername || s.GranteeUserId)}</td>
          <td class="actions">
            <button type="button" class="btn btn-icon btn-sm btn-danger" data-unshare="${bag.esc(s.Id)}" title="Retirer">
              <span class="btn-ico">${bag.ico("remove")}</span>
            </button>
          </td>
        </tr>`).join("")}</tbody></table>`;
        listEl.querySelectorAll("[data-unshare]").forEach((btn) => {
          btn.onclick = async () => {
            try {
              await bag.withBusy(btn, () => bag.Api.deleteShare(btn.dataset.unshare));
              await refresh();
            } catch (err) {
              showErr(err.message || String(err));
            }
          };
        });
      };
      const refresh = async () => {
        showErr("");
        try {
          const shares = await bag.Api.listShares(type, endpointId, key);
          renderList(Array.isArray(shares) ? shares : []);
        } catch (err) {
          listEl.innerHTML = "";
          showErr(err.message || String(err));
        }
      };
      try {
        const users = await bag.Api.usersDirectory();
        directory = Array.isArray(users) ? users : [];
      } catch (err) {
        directory = [];
        showErr(err.message || String(err));
      }
      addBtn.onclick = async () => {
        if (!selected?.Id) {
          showErr("Recherchez et s\xE9lectionnez un utilisateur");
          qInput.focus();
          return;
        }
        try {
          await bag.withBusy(addBtn, () => bag.Api.createShare({
            Type: type,
            EndpointId: endpointId,
            Key: key,
            GranteeUserId: selected.Id
          }));
          clearSelection();
          await refresh();
        } catch (err) {
          showErr(err.message || String(err));
        }
      };
      await refresh();
      qInput.focus();
    };
  }

  // public/assets/js/src/views/dashboard.js
  function install5() {
    bag.viewDashboard = async function viewDashboard() {
      if (bag.isAllNodes()) {
        await bag.viewDashboardAll();
        return;
      }
      const filter = bag.state.dashFilter || "all";
      bag.root.innerHTML = bag.shell("Tableau de bord", bag.pageLoadingHtml("Chargement du tableau de bord\u2026"), {
        subtitle: "Vue d\u2019ensemble de votre environnement Docker",
        hidePageHeader: true
      });
      const [containers, images, volumes, networks, stacks, info, df, host] = await Promise.all([
        bag.Api.docker("/containers/json?all=true"),
        bag.Api.docker("/images/json"),
        bag.Api.docker("/volumes"),
        bag.Api.docker("/networks"),
        bag.Api.stacks(),
        bag.Api.docker("/info").catch(() => ({})),
        bag.Api.docker("/system/df").catch(() => ({})),
        bag.Api.host().catch(() => ({}))
      ]);
      const list = containers || [];
      const imgs = images || [];
      const volList = volumes.Volumes || [];
      const running = list.filter((c) => String(c.State).toLowerCase() === "running").length;
      const stopped = list.length - running;
      const memTotal = Number(info.MemTotal) || 0;
      if (info.ServerVersion) bag.state.engineVersion = info.ServerVersion;
      const layersSize = Number(df?.LayersSize) || 0;
      const imagesSize = (df?.Images || []).reduce((a, i) => a + (Number(i.Size) || 0), 0);
      const volumesSize = volList.reduce((a, v) => a + (Number(v.UsageData?.Size) || 0), 0);
      const dockerDisk = layersSize || imagesSize + volumesSize;
      const diskTotal = Number(host?.DiskTotal) || 0;
      const diskUsed = Number(host?.DiskUsed) || 0;
      const diskPct = diskTotal > 0 ? Math.min(100, diskUsed / diskTotal * 100) : 0;
      const statsMap = {};
      let cpuPct = 0;
      let memPct = 0;
      let memUsage = 0;
      const sampleIds = list.filter((c) => String(c.State).toLowerCase() === "running").slice(0, 8);
      await Promise.all(sampleIds.map(async (c) => {
        try {
          const st = await bag.Api.docker(`/containers/${c.Id}/stats?stream=false`);
          const computed = bag.computeStats(st, memTotal);
          statsMap[c.Id] = computed;
        } catch (_) {
        }
      }));
      const vals = Object.values(statsMap);
      if (vals.length) {
        cpuPct = vals.reduce((a, s) => a + s.cpuPct, 0);
        memUsage = vals.reduce((a, s) => a + s.memUsage, 0);
        memPct = memTotal ? memUsage / memTotal * 100 : vals.reduce((a, s) => a + s.memPct, 0) / vals.length;
      }
      const filtered = list.filter((c) => {
        const st = String(c.State).toLowerCase();
        if (filter === "running") return st === "running";
        if (filter === "stopped") return st !== "running";
        return true;
      }).slice(0, 12);
      const containerRows = filtered.map((c) => {
        const name = c.Names && c.Names[0] ? c.Names[0].replace(/^\//, "") : bag.shortId(c.Id);
        const isRun = String(c.State).toLowerCase() === "running";
        return `<tr data-search="${bag.esc(`${name} ${c.Image} ${c.State}`.toLowerCase())}">
        <td><a class="name-with-dot" href="#containers/${bag.esc(c.Id)}"><span class="sdot ${isRun ? "on" : ""}"></span>${bag.esc(name)}</a></td>
        <td class="mono cell-clip" title="${bag.esc(c.Image)}">${bag.esc(c.Image)}</td>
        <td>${bag.badge(c.State)}</td>
        <td class="muted cell-nowrap">${bag.esc(bag.formatUptime(c.Status))}</td>
      </tr>`;
      }).join("");
      const topImages = [...imgs].sort((a, b) => (b.Created || 0) - (a.Created || 0)).slice(0, 5).map((img) => {
        const tags = img.RepoTags && img.RepoTags[0] ? img.RepoTags[0] : "<none>:<none>";
        const age = img.Created ? bag.relativeTime(img.Created * 1e3) : "\u2014";
        return `<tr>
        <td class="mono">${bag.esc(tags)}</td>
        <td>${bag.esc(bag.formatBytes(img.Size))}</td>
        <td class="muted">${bag.esc(age)}</td>
      </tr>`;
      }).join("");
      const activity = list.slice(0, 6).map((c) => {
        const name = c.Names && c.Names[0] ? c.Names[0].replace(/^\//, "") : bag.shortId(c.Id);
        const isRun = String(c.State).toLowerCase() === "running";
        const txt = isRun ? `D\xE9marrage du conteneur ${name}` : `Arr\xEAt du conteneur ${name}`;
        return `<li>
        <span class="dot ${isRun ? "green" : "orange"}"></span>
        <span class="txt">${bag.esc(txt)}</span>
        <span class="when">${bag.esc(bag.formatUptime(c.Status) === "\u2014" ? "r\xE9cent" : bag.formatUptime(c.Status))}</span>
      </li>`;
      }).join("");
      const metricSeries = await bag.pushMetricSample({
        containers: list.length,
        images: imgs.length,
        volumes: volList.length,
        networks: (networks || []).length,
        cpu: cpuPct,
        mem: memPct,
        disk: diskPct
      });
      bag.root.innerHTML = bag.shell("Tableau de bord", `
      ${bag.dashHeroHtml()}
      <div class="stat-grid dash-hero-stats">
        ${bag.dashStatCard("containers", "blue", "Conteneurs", list.length, metricSeries)}
        ${bag.dashStatCard("images", "purple", "Images", imgs.length, metricSeries)}
        ${bag.dashStatCard("volumes", "green", "Volumes", volList.length, metricSeries)}
        ${bag.dashStatCard("networks", "orange", "R\xE9seaux", (networks || []).length, metricSeries)}
      </div>

      <div class="dash-layout">
        <div class="dash-col">
          <div class="panel-card">
            <div class="panel-head">
              <h3>Conteneurs</h3>
              <div class="filter-tabs" id="dash-filters">
                <button type="button" data-f="all" class="${filter === "all" ? "active" : ""}">Tous ${list.length}</button>
                <button type="button" data-f="running" class="${filter === "running" ? "active" : ""}">En cours ${running}</button>
                <button type="button" data-f="stopped" class="${filter === "stopped" ? "active" : ""}">Arr\xEAt\xE9s ${stopped}</button>
              </div>
              <input class="search mini-search" id="filter" type="search" placeholder="Rechercher un conteneur\u2026" value="${bag.esc(bag.state.filters.dashboard || "")}">
            </div>
            <div class="table-wrap" style="border:0;box-shadow:none;border-radius:0">
              <table class="data">
                <thead><tr><th>Nom</th><th>Image</th><th>Statut</th><th>Uptime</th></tr></thead>
                <tbody>${containerRows || `<tr><td colspan="4" class="empty">Aucun conteneur</td></tr>`}</tbody>
              </table>
            </div>
          </div>

          <div class="panel-card">
            <div class="panel-head">
              <h3>Images</h3>
              <a href="#images">Voir tout \u2192</a>
            </div>
            <div class="table-wrap" style="border:0;box-shadow:none;border-radius:0">
              <table class="data">
                <thead><tr><th>Nom</th><th>Taille</th><th>Cr\xE9\xE9e le</th></tr></thead>
                <tbody>${topImages || `<tr><td colspan="3" class="empty">Aucune image</td></tr>`}</tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="dash-col">
          <div class="panel-card">
            <div class="panel-head"><h3>Ressources h\xF4te</h3></div>
            <div class="gauge-row">
              <div class="gauge">${bag.gaugeRing(cpuPct, "#3b82f6")}<div class="g-label">CPU</div></div>
              <div class="gauge">${bag.gaugeRing(memPct, "#22c55e")}<div class="g-label">M\xE9moire</div><div class="g-sub">${bag.formatBytes(memUsage)} / ${bag.formatBytes(memTotal)}</div></div>
              <div class="gauge">${bag.gaugeRing(diskPct, "#fb923c")}<div class="g-label">Disque</div><div class="g-sub">${diskTotal ? `${bag.formatBytes(diskUsed)} / ${bag.formatBytes(diskTotal)}` : "\u2014"}${dockerDisk ? `<div class="g-hint">Docker ${bag.formatBytes(dockerDisk)}</div>` : ""}</div></div>
            </div>
            ${bag.hostResourceChart(metricSeries)}
          </div>

          <div class="panel-card">
            <div class="panel-head"><h3>Activit\xE9 r\xE9cente</h3></div>
            <ul class="activity-list">${activity || '<li><span class="txt muted">Aucune activit\xE9</span></li>'}</ul>
          </div>

          <div class="panel-card">
            <div class="panel-head"><h3>Actions rapides</h3></div>
            <div class="quick-grid">
              <a class="quick-tile blue" href="#containers/new"><span class="qi">${bag.ico("start")}</span>Cr\xE9er un conteneur</a>
              <a class="quick-tile purple" href="#stacks/new"><span class="qi">${bag.ico("plus")}</span>Cr\xE9er une stack</a>
              <a class="quick-tile green" href="#images/build"><span class="qi">${bag.ico("plus")}</span>Dockerfile / Build</a>
              ${Number(bag.state.user?.Role) === 1 ? `<button type="button" class="quick-tile orange" id="dash-prune">
                <span class="qi">${bag.ico("clean")}</span>Nettoyer les orphelins
              </button>` : `<div class="quick-tile muted-tile"><span class="qi">${bag.ico("containers")}</span>Ressources personnelles</div>`}
            </div>
          </div>
        </div>
      </div>
    `, { subtitle: "Vue d\u2019ensemble de votre environnement Docker", hidePageHeader: true });
      bag.bindSearch("dashboard");
      bag.startDashMetricSampler();
      bag.bindDashMetricSparklines(metricSeries);
      document.getElementById("dash-filters")?.querySelectorAll("button").forEach((btn) => {
        btn.onclick = () => {
          bag.state.dashFilter = btn.dataset.f;
          bag.route();
        };
      });
      document.getElementById("dash-prune")?.addEventListener("click", () => bag.openPruneOrphansModal());
    };
    bag.viewDashboardAll = async function viewDashboardAll() {
      const filter = bag.state.dashFilter || "all";
      bag.root.innerHTML = bag.shell("Tableau de bord", bag.pageLoadingHtml("Agr\xE9gation de tous les n\u0153uds\u2026"), {
        subtitle: "Vue agr\xE9g\xE9e \u2014 tous les n\u0153uds",
        hidePageHeader: true
      });
      const [cAgg, iAgg, vAgg, nAgg] = await Promise.all([
        bag.dockerAll("/containers/json?all=true"),
        bag.dockerAll("/images/json"),
        bag.dockerAll("/volumes", { pick: (d) => d?.Volumes || [] }),
        bag.dockerAll("/networks")
      ]);
      const list = cAgg.items;
      const imgs = iAgg.items;
      const volList = vAgg.items;
      const nets = nAgg.items;
      const partial = cAgg.failed + iAgg.failed + vAgg.failed + nAgg.failed > 0;
      const running = list.filter((c) => String(c.State).toLowerCase() === "running").length;
      const stopped = list.length - running;
      const perNodeHint = (cAgg.perNode || []).map((n) => `${n.name}: ${n.count}`).join(" \xB7 ");
      const filteredAll = list.filter((c) => {
        const st = String(c.State).toLowerCase();
        if (filter === "running") return st === "running";
        if (filter === "stopped") return st !== "running";
        return true;
      });
      const filtered = bag.sampleAcrossNodes(filteredAll, 32);
      const containerRows = filtered.map((c) => {
        const name = c.Names && c.Names[0] ? c.Names[0].replace(/^\//, "") : bag.shortId(c.Id);
        const isRun = String(c.State).toLowerCase() === "running";
        return `<tr data-search="${bag.esc(`${name} ${c.Image} ${c.State} ${c._nodeName}`.toLowerCase())}">
        <td class="muted">${bag.esc(c._nodeName || "\u2014")}</td>
        <td><a class="name-with-dot" href="#containers/${bag.esc(c.Id)}" data-switch-node="${bag.esc(c._nodeId)}"><span class="sdot ${isRun ? "on" : ""}"></span>${bag.esc(name)}</a></td>
        <td class="mono cell-clip" title="${bag.esc(c.Image)}">${bag.esc(c.Image)}</td>
        <td>${bag.badge(c.State)}</td>
        <td class="muted cell-nowrap">${bag.esc(bag.formatUptime(c.Status))}</td>
      </tr>`;
      }).join("");
      const topImages = bag.sampleAcrossNodes(
        [...imgs].sort((a, b) => (b.Created || 0) - (a.Created || 0)),
        12
      ).map((img) => {
        const tags = img.RepoTags && img.RepoTags[0] ? img.RepoTags[0] : "<none>:<none>";
        const age = img.Created ? bag.relativeTime(img.Created * 1e3) : "\u2014";
        return `<tr>
        <td class="muted">${bag.esc(img._nodeName || "\u2014")}</td>
        <td class="mono">${bag.esc(tags)}</td>
        <td>${bag.esc(bag.formatBytes(img.Size))}</td>
        <td class="muted">${bag.esc(age)}</td>
      </tr>`;
      }).join("");
      const countById = Object.fromEntries((cAgg.perNode || []).map((n) => [n.id, n.count]));
      const failedSet = new Set(cAgg.failedNames || []);
      const nodeRows = (bag.state.endpoints || []).map((ep) => {
        const id = Number(ep.Id ?? ep.id);
        const st = Number(ep.Status);
        const cCount = countById[id];
        let label = st === 1 ? "En ligne" : st === 0 ? "D\xE9sactiv\xE9" : "Hors ligne";
        let cls = st === 1 ? "badge-success" : st === 0 ? "badge-muted" : "badge-warn";
        if (failedSet.has(ep.NodeName || ep.Name)) {
          label = "Erreur agr\xE9gat";
          cls = "badge-warn";
        } else if (cCount != null) {
          label = `En ligne \xB7 ${cCount}`;
          cls = "badge-success";
        }
        const url = ep.AgentURL || ep.URL || "\u2014";
        return `<tr>
        <td title="${bag.esc(ep.NodeName || ep.Name)}"><strong>${bag.esc(ep.NodeName || ep.Name)}</strong></td>
        <td>${bag.esc(ep.Kind === "agent" ? "Agent" : "Local")}</td>
        <td><span class="badge ${cls}" title="${bag.esc(label)}">${bag.esc(label)}</span></td>
        <td class="mono cell-clip" title="${bag.esc(url)}">${bag.esc(url)}</td>
      </tr>`;
      }).join("");
      const failMsg = (cAgg.failedNames || []).length ? ` N\u0153uds sans r\xE9ponse : ${(cAgg.failedNames || []).map(bag.esc).join(", ")}.` : "";
      const metricSeriesAll = await bag.pushMetricSample({
        containers: list.length,
        images: imgs.length,
        volumes: volList.length,
        networks: nets.length
      });
      bag.root.innerHTML = bag.shell("Tableau de bord", `
      ${bag.dashHeroHtml({
        subtitle: "Vue agr\xE9g\xE9e de tous vos n\u0153uds Docker \u2014 une interface moderne."
      })}
      ${partial ? `<div class="info-box" style="margin-bottom:12px">Agr\xE9gat partiel.${failMsg}</div>` : ""}
      <div class="stat-grid dash-hero-stats">
        ${bag.dashStatCard("containers", "blue", "Conteneurs", list.length, metricSeriesAll)}
        ${bag.dashStatCard("images", "purple", "Images", imgs.length, metricSeriesAll)}
        ${bag.dashStatCard("volumes", "green", "Volumes", volList.length, metricSeriesAll)}
        ${bag.dashStatCard("networks", "orange", "R\xE9seaux", nets.length, metricSeriesAll)}
      </div>
      ${perNodeHint ? `<div class="muted" style="margin:12px 0 10px">R\xE9partition conteneurs \u2014 ${bag.esc(perNodeHint)}</div>` : ""}

      <div class="dash-layout">
        <div class="dash-col">
          <div class="panel-card">
            <div class="panel-head">
              <h3>Conteneurs</h3>
              <a href="#containers">Voir tout \u2192</a>
              <div class="filter-tabs" id="dash-filters">
                <button type="button" data-f="all" class="${filter === "all" ? "active" : ""}">Tous ${list.length}</button>
                <button type="button" data-f="running" class="${filter === "running" ? "active" : ""}">En cours ${running}</button>
                <button type="button" data-f="stopped" class="${filter === "stopped" ? "active" : ""}">Arr\xEAt\xE9s ${stopped}</button>
              </div>
              <input class="search mini-search" id="filter" type="search" placeholder="Rechercher\u2026" value="${bag.esc(bag.state.filters.dashboard || "")}">
            </div>
            <div class="table-wrap" style="border:0;box-shadow:none;border-radius:0">
              <table class="data">
                <thead><tr><th>N\u0153ud</th><th>Nom</th><th>Image</th><th>Statut</th><th>Uptime</th></tr></thead>
                <tbody>${containerRows || `<tr><td colspan="5" class="empty">Aucun conteneur</td></tr>`}</tbody>
              </table>
            </div>
          </div>
          <div class="panel-card">
            <div class="panel-head"><h3>Images</h3><a href="#images">Voir tout \u2192</a></div>
            <div class="table-wrap" style="border:0;box-shadow:none;border-radius:0">
              <table class="data">
                <thead><tr><th>N\u0153ud</th><th>Nom</th><th>Taille</th><th>Cr\xE9\xE9e</th></tr></thead>
                <tbody>${topImages || `<tr><td colspan="4" class="empty">Aucune image</td></tr>`}</tbody>
              </table>
            </div>
          </div>
        </div>
        <div class="dash-col">
          <div class="panel-card">
            <div class="panel-head"><h3>N\u0153uds</h3></div>
            <div class="table-wrap" style="border:0;box-shadow:none;border-radius:0">
              <table class="data">
                <thead><tr><th>Nom</th><th>Type</th><th>Statut</th><th>URL</th></tr></thead>
                <tbody>${nodeRows || `<tr><td colspan="4" class="empty">Aucun n\u0153ud</td></tr>`}</tbody>
              </table>
            </div>
          </div>
          <div class="panel-card">
            <div class="panel-head"><h3>Actions</h3></div>
            <div class="info-box">${bag.esc(bag.requireSingleNodeMsg())}</div>
          </div>
        </div>
      </div>
    `, { subtitle: "Vue agr\xE9g\xE9e \u2014 tous les n\u0153uds", hidePageHeader: true });
      bag.bindSearch("dashboard");
      bag.startDashMetricSampler();
      bag.bindDashMetricSparklines(metricSeriesAll);
      document.getElementById("dash-filters")?.querySelectorAll("button").forEach((btn) => {
        btn.onclick = () => {
          bag.state.dashFilter = btn.dataset.f;
          bag.route();
        };
      });
      bag.root.querySelectorAll("[data-switch-node]").forEach((a) => {
        a.addEventListener("click", () => {
          const id = parseInt(a.getAttribute("data-switch-node"), 10);
          if (Number.isFinite(id) && id > 0) {
            bag.Api.setEndpointId(id);
            bag.state.endpointId = id;
          }
        });
      });
    };
    bag.openPruneOrphansModal = async function openPruneOrphansModal() {
      bag.closeAppModal();
      const host = bag.modalHost();
      host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-form" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3>Nettoyer les orphelins</h3>
              <div class="modal-sub">Supprime les ressources Docker inutilis\xE9es</div>
            </div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">\u2715</button>
          </div>
          <div id="prune-err"></div>
          <div class="info-box">
            Conteneurs arr\xEAt\xE9s, images dangling, r\xE9seaux inutilis\xE9s et cache de build.
            Les volumes ne sont pas touch\xE9s.
          </div>
          <label class="check-row"><input type="checkbox" id="prune-images-all"> Inclure toutes les images non utilis\xE9es (pas seulement dangling)</label>
          <div id="prune-result" hidden></div>
          <div class="actions-bar">
            <button type="button" class="btn btn-primary" id="prune-run">Nettoyer</button>
            <button type="button" class="btn" data-close-modal>Fermer</button>
          </div>
        </div>
      </div>`;
      bag.bindAppModalChrome();
      bag.onBusyClick(document.getElementById("prune-run"), async () => {
        const errBox = document.getElementById("prune-err");
        const resultBox = document.getElementById("prune-result");
        if (errBox) errBox.innerHTML = "";
        if (resultBox) {
          resultBox.hidden = true;
          resultBox.innerHTML = "";
        }
        const allImages = document.getElementById("prune-images-all")?.checked;
        try {
          const [containers, images, networks, build] = await Promise.all([
            bag.Api.docker("/containers/prune", { method: "POST", body: "{}" }),
            bag.Api.docker(`/images/prune${allImages ? "?filters=" + encodeURIComponent(JSON.stringify({ dangling: ["false"] })) : ""}`, {
              method: "POST",
              body: "{}"
            }),
            bag.Api.docker("/networks/prune", { method: "POST", body: "{}" }),
            bag.Api.docker("/build/prune", { method: "POST", body: JSON.stringify({ all: true }) }).catch(() => ({ SpaceReclaimed: 0 }))
          ]);
          const cCount = (containers?.ContainersDeleted || []).length;
          const iCount = (images?.ImagesDeleted || []).filter(Boolean).length;
          const nCount = (networks?.NetworksDeleted || []).length;
          const space = (Number(containers?.SpaceReclaimed) || 0) + (Number(images?.SpaceReclaimed) || 0) + (Number(build?.SpaceReclaimed) || 0);
          if (resultBox) {
            resultBox.hidden = false;
            resultBox.innerHTML = `<div class="info-box">
            <strong>Nettoyage termin\xE9</strong><br>
            Conteneurs : ${cCount}<br>
            Images : ${iCount}<br>
            R\xE9seaux : ${nCount}<br>
            Espace r\xE9cup\xE9r\xE9 : ${bag.esc(bag.formatBytes(space))}
          </div>`;
          }
        } catch (err) {
          if (errBox) errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
        }
      }, { disableSiblings: false, minMs: 300 });
    };
  }

  // public/assets/js/src/views/containers.js
  function install6() {
    bag.openCreateContainerModal = async function openCreateContainerModal() {
      bag.closeAppModal();
      const host = bag.modalHost();
      host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-form modal-form-wide" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3>Cr\xE9er un conteneur</h3>
              <div class="modal-sub">Recherche locale puis Docker Hub</div>
            </div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">\u2715</button>
          </div>
          <div id="create-err"></div>
          <div class="form-group">
            <label class="field-label">Image <span class="req">*</span></label>
            ${bag.imageSearchFieldsHtml("c")}
          </div>
          <div class="form-group">
            <label class="field-label">Nom</label>
            <input id="c-name" placeholder="mon-conteneur (optionnel)" autocomplete="off">
          </div>
          <div class="form-group">
            <label class="field-label">Ports</label>
            <input id="c-ports" placeholder="8080:80 (publi\xE9) ou 80 (interne) \u2014 ligne / virgule" autocomplete="off">
            <p class="field-hint muted" style="margin-top:6px"><code>8080:80</code> fixe \xB7 <code>0:80</code> port h\xF4te al\xE9atoire \xB7 <code>80</code> / <code>80,443</code> interne seulement.</p>
          </div>
          <div class="form-group">
            <div class="field-label-row">
              <label class="field-label">Volumes</label>
              <button type="button" class="btn btn-sm" id="c-vol-add" title="Ajouter un volume">
                <span class="btn-ico">${bag.ico("plus")}</span><span>Ajouter</span>
              </button>
            </div>
            <div class="vol-mount-list" id="c-vol-list">
              <div class="muted" id="c-vol-empty" style="font-size:13px">Aucun volume li\xE9</div>
            </div>
          </div>
          <div class="form-group">
            <label class="field-label">Commande</label>
            <input id="c-cmd" placeholder="optionnel" autocomplete="off">
          </div>
          <label class="check-row"><input type="checkbox" id="c-start" checked> D\xE9marrer apr\xE8s cr\xE9ation</label>
          <div class="actions-bar">
            <button type="button" class="btn btn-primary" id="c-save">Cr\xE9er</button>
            <button type="button" class="btn" data-close-modal>Annuler</button>
          </div>
        </div>
      </div>`;
      bag.bindAppModalChrome();
      const imagePicker = bag.bindImageSearchPicker("c", host);
      const volListEl = document.getElementById("c-vol-list");
      let volumeNames = [];
      function collectVolumeBinds() {
        const binds = [];
        const errors = [];
        volListEl?.querySelectorAll(".vol-mount-row").forEach((row, i) => {
          const vol = row.querySelector(".vol-name")?.value?.trim() || "";
          const dest = row.querySelector(".vol-dest")?.value?.trim() || "";
          const ro = row.querySelector(".vol-ro")?.checked;
          if (!vol && !dest) return;
          if (!vol) {
            errors.push(`Ligne ${i + 1} : volume requis`);
            return;
          }
          if (!dest || !dest.startsWith("/")) {
            errors.push(`Ligne ${i + 1} : chemin conteneur absolu requis (ex. /data)`);
            return;
          }
          binds.push(ro ? `${vol}:${dest}:ro` : `${vol}:${dest}`);
        });
        return { binds, errors };
      }
      function syncVolEmpty() {
        const empty = document.getElementById("c-vol-empty");
        const rows = volListEl?.querySelectorAll(".vol-mount-row") || [];
        if (empty) empty.hidden = rows.length > 0;
      }
      function addVolumeRow(prefill = {}) {
        const empty = document.getElementById("c-vol-empty");
        if (empty) empty.hidden = true;
        const row = document.createElement("div");
        row.className = "vol-mount-row";
        const opts = volumeNames.length ? volumeNames.map((n) => `<option value="${bag.esc(n)}"${prefill.name === n ? " selected" : ""}>${bag.esc(n)}</option>`).join("") : '<option value="">Aucun volume disponible</option>';
        row.innerHTML = `
        <select class="vol-name select-block" title="Volume Docker" ${volumeNames.length ? "" : "disabled"}>
          <option value="">Volume\u2026</option>
          ${opts}
        </select>
        <input class="vol-dest" placeholder="/chemin/conteneur" value="${bag.esc(prefill.dest || "")}" autocomplete="off" spellcheck="false">
        <label class="vol-ro-label" title="Lecture seule"><input type="checkbox" class="vol-ro"${prefill.ro ? " checked" : ""}> RO</label>
        <button type="button" class="icon-btn vol-remove" title="Retirer" aria-label="Retirer">\u2715</button>`;
        if (prefill.name && volumeNames.includes(prefill.name)) {
          row.querySelector(".vol-name").value = prefill.name;
        }
        row.querySelector(".vol-remove")?.addEventListener("click", () => {
          row.remove();
          syncVolEmpty();
        });
        volListEl?.appendChild(row);
        row.querySelector(".vol-dest")?.focus();
      }
      document.getElementById("c-vol-add")?.addEventListener("click", () => addVolumeRow());
      (async () => {
        try {
          const data = await bag.Api.docker("/volumes");
          volumeNames = (data?.Volumes || []).map((v) => v.Name).filter(Boolean).sort((a, b) => a.localeCompare(b));
          volListEl?.querySelectorAll(".vol-name").forEach((sel) => {
            const cur = sel.value;
            sel.innerHTML = `<option value="">Volume\u2026</option>` + volumeNames.map((n) => `<option value="${bag.esc(n)}">${bag.esc(n)}</option>`).join("");
            if (cur && volumeNames.includes(cur)) sel.value = cur;
            sel.disabled = volumeNames.length === 0;
          });
        } catch (_) {
          volumeNames = [];
        }
      })();
      imagePicker.focus();
      bag.onBusyClick(document.getElementById("c-save"), async () => {
        const errBox = document.getElementById("create-err");
        errBox.innerHTML = "";
        const { image, source } = imagePicker.getSelected();
        const name = document.getElementById("c-name").value.trim();
        const cmd = document.getElementById("c-cmd").value.trim();
        const start = document.getElementById("c-start").checked;
        if (!image) {
          errBox.innerHTML = `<div class="error-box">S\xE9lectionnez une image dans les r\xE9sultats de recherche.</div>`;
          imagePicker.focus();
          return;
        }
        const { ExposedPorts, PortBindings } = bag.parsePortBindings(document.getElementById("c-ports").value);
        const { binds, errors: volErrors } = collectVolumeBinds();
        if (volErrors.length) {
          errBox.innerHTML = `<div class="error-box">${bag.esc(volErrors.join("\n"))}</div>`;
          return;
        }
        const payload = {
          Image: image,
          HostConfig: {
            RestartPolicy: { Name: "unless-stopped" },
            PublishAllPorts: false
          }
        };
        if (Object.keys(PortBindings).length) payload.HostConfig.PortBindings = PortBindings;
        if (Object.keys(ExposedPorts).length) payload.ExposedPorts = ExposedPorts;
        if (binds.length) payload.HostConfig.Binds = binds;
        if (cmd) payload.Cmd = cmd.split(/\s+/);
        const q = name ? `?name=${encodeURIComponent(name)}` : "";
        try {
          if (source !== "local") {
            try {
              const { fromImage, tag } = bag.parseImageRef(image);
              await bag.Api.docker(`/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag.replace(/^@/, ""))}`, { method: "POST" });
            } catch (_) {
            }
          }
          const gate = await bag.cveAdviseBeforeDeploy({ Image: image }, errBox);
          if (!gate.proceed) {
            if (errBox && !errBox.innerHTML) {
              errBox.innerHTML = `<div class="info-box">Cr\xE9ation annul\xE9e.</div>`;
            }
            return;
          }
          const created = await bag.Api.docker(`/containers/create${q}`, {
            method: "POST",
            body: JSON.stringify(payload)
          });
          if (start && created?.Id) {
            await bag.Api.docker(`/containers/${created.Id}/start`, { method: "POST" });
          }
          bag.closeAppModal();
          if (location.hash === "#containers/new") location.hash = "#containers";
          else await bag.route();
        } catch (err) {
          errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
        }
      }, { disableSiblings: false, minMs: 300 });
    };
    bag.openContainerStatsModal = async function openContainerStatsModal(id, name, runningHint) {
      bag.closeAppModal();
      const host = bag.modalHost();
      let running = !!runningHint;
      let history = await bag.loadContainerMetricHistory(id);
      host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-form modal-form-wide modal-cstats" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3>Ressources</h3>
              <div class="modal-sub mono">${bag.esc(name)} \xB7 ${bag.esc(bag.shortId(id))}</div>
            </div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">\u2715</button>
          </div>
          <div class="cstats-toolbar">
            <span class="logs-status" id="cstats-status"><span class="dot"></span><span class="label">Chargement\u2026</span></span>
            <div class="spacer"></div>
            <span class="muted" style="font-size:12px" title="Identique au dashboard (Param\xE8tres)">${bag.esc(bag.metricWindowLabel())} \xB7 r\xE9tention ${bag.esc(String(bag.metricRetentionDays()))} j</span>
            <button type="button" class="btn btn-sm" id="cstats-refresh">Actualiser</button>
          </div>
          <div id="cstats-chart" class="cstats-chart">${bag.containerResourceChart(history)}</div>
          <div id="cstats-body" class="cstats-body">
            <div class="muted" style="padding:1.5rem;text-align:center">Collecte des m\xE9triques\u2026</div>
          </div>
        </div>
      </div>`;
      bag.bindAppModalChrome();
      const body = document.getElementById("cstats-body");
      const chartEl = document.getElementById("cstats-chart");
      const statusEl = document.getElementById("cstats-status");
      let prev = null;
      let prevAt = 0;
      let lastPersistAt = 0;
      const setStatus = (cls, label) => {
        if (!statusEl) return;
        statusEl.className = `logs-status ${cls || ""}`.trim();
        const lbl = statusEl.querySelector(".label");
        if (lbl) lbl.textContent = label;
      };
      const refreshChart = async (force = false, livePoint = null) => {
        if (force || !history.length) {
          history = await bag.loadContainerMetricHistory(id);
        }
        const series = livePoint ? history.concat([livePoint]) : history;
        if (chartEl) chartEl.innerHTML = bag.containerResourceChart(series);
      };
      const render = (computed, rate, netScore) => {
        const cpu = Math.max(0, Number(computed.cpuPct) || 0);
        const mem = Math.max(0, Number(computed.memPct) || 0);
        const level = bag.resourceLoadLevel(cpu, mem, netScore);
        bag.applyStatsIconLevel(
          id,
          level,
          `CPU ${cpu.toFixed(0)}% \xB7 RAM ${mem.toFixed(0)}% \xB7 R\xE9seau ${bag.formatBitRate((rate?.rx || 0) + (rate?.tx || 0))}`
        );
        const netRows = Object.entries(computed.networks || {}).map(([iface, n]) => {
          const rx = Number(n?.rx_bytes || 0) || 0;
          const tx = Number(n?.tx_bytes || 0) || 0;
          return `<tr>
          <td class="mono">${bag.esc(iface)}</td>
          <td class="mono">${bag.esc(bag.formatBytes(rx))}</td>
          <td class="mono">${bag.esc(bag.formatBytes(tx))}</td>
        </tr>`;
        }).join("");
        body.innerHTML = `
        <div class="cstats-gauges">
          <div class="gauge">${bag.gaugeRing(cpu, "#3b82f6")}<div class="g-label">CPU</div><div class="g-sub">${cpu.toFixed(1)} %</div></div>
          <div class="gauge">${bag.gaugeRing(mem, "#22c55e")}<div class="g-label">RAM</div><div class="g-sub">${bag.esc(bag.formatBytes(computed.memUsage))} / ${bag.esc(bag.formatBytes(computed.memLimit))}</div></div>
          <div class="gauge">${bag.gaugeRing(netScore, "#a78bfa")}<div class="g-label">R\xE9seau</div><div class="g-sub">\u2193 ${bag.esc(bag.formatBitRate(rate?.rx || 0))} \xB7 \u2191 ${bag.esc(bag.formatBitRate(rate?.tx || 0))}</div></div>
        </div>
        <div class="cstats-meta muted">PID ${bag.esc(String(computed.pids || 0))} \xB7 live \xB7 historique ${bag.esc(bag.metricWindowLabel())}</div>
        <div class="section-title" style="margin-top:14px">Interfaces r\xE9seau</div>
        <div class="table-wrap" style="margin:0">
          <table class="data">
            <thead><tr><th>Interface</th><th>Re\xE7u</th><th>\xC9mis</th></tr></thead>
            <tbody>${netRows || '<tr><td colspan="3" class="muted">Aucune interface</td></tr>'}</tbody>
          </table>
        </div>`;
      };
      const tick = async () => {
        if (!document.getElementById("cstats-body")) {
          if (bag.state.statsTimer) {
            clearInterval(bag.state.statsTimer);
            bag.state.statsTimer = null;
          }
          return;
        }
        try {
          if (!running) {
            try {
              const info = await bag.Api.docker(`/containers/${id}/json`);
              running = String(info.State?.Status || "").toLowerCase() === "running";
              if (!name || name === bag.shortId(id)) {
                name = (info.Name || "").replace(/^\//, "") || name;
              }
            } catch (_) {
            }
          }
          if (!running) {
            setStatus("is-paused", "Conteneur arr\xEAt\xE9");
            bag.applyStatsIconLevel(id, "off", "Conteneur arr\xEAt\xE9 \u2014 pas de charge");
            body.innerHTML = `<div class="info-box">D\xE9marrez le conteneur pour voir CPU, RAM et r\xE9seau en direct.</div>`;
            return;
          }
          setStatus("is-live", "En direct");
          const st = await bag.Api.docker(`/containers/${id}/stats?stream=false`);
          const now = Date.now();
          const computed = bag.computeStats(st, 0);
          let rate = { rx: 0, tx: 0 };
          if (prev && prevAt > 0) {
            const dt = Math.max(0.5, (now - prevAt) / 1e3);
            rate = {
              rx: Math.max(0, (computed.netRx - prev.netRx) / dt),
              tx: Math.max(0, (computed.netTx - prev.netTx) / dt)
            };
          }
          prev = computed;
          prevAt = now;
          const netScore = bag.netLoadScore(rate.rx, rate.tx);
          render(computed, rate, netScore);
          const livePoint = {
            t: now,
            cpu: Math.max(0, Number(computed.cpuPct) || 0),
            mem: Math.max(0, Number(computed.memPct) || 0),
            disk: netScore,
            containers: 1,
            images: 0,
            volumes: 0,
            networks: 0
          };
          if (!lastPersistAt || now - lastPersistAt > 6e4) {
            lastPersistAt = now;
            await bag.pushContainerMetricSample(id, computed.cpuPct, computed.memPct, netScore);
            await refreshChart(true, livePoint);
          } else {
            await refreshChart(false, livePoint);
          }
        } catch (err) {
          setStatus("is-error", "Erreur");
          body.innerHTML = `<div class="error-box">${bag.esc(err.message || "Stats indisponibles")}</div>`;
        }
      };
      document.getElementById("cstats-refresh")?.addEventListener("click", async () => {
        await refreshChart(true);
        await tick();
      });
      await tick();
      bag.state.statsTimer = setInterval(tick, 2e3);
    };
    bag.openInspectModal = async function openInspectModal(id, name) {
      bag.closeAppModal();
      const host = bag.modalHost();
      host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-xl modal-workspace modal-inspect" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3>Inspecter</h3>
              <div class="modal-sub mono">${bag.esc(name)} \xB7 ${bag.esc(bag.shortId(id))}</div>
            </div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">\u2715</button>
          </div>
          <div class="toolbar">
            <button class="btn btn-sm" id="inspect-refresh">Actualiser</button>
            <button class="btn btn-sm" id="inspect-copy">Copier JSON</button>
            <div class="spacer"></div>
            <span class="muted" id="inspect-meta">Chargement\u2026</span>
          </div>
          <pre class="logs" id="inspect-view">Chargement\u2026</pre>
        </div>
      </div>`;
      bag.bindAppModalChrome();
      const view = document.getElementById("inspect-view");
      const meta = document.getElementById("inspect-meta");
      let rawJson = "";
      const load = async () => {
        try {
          const info = await bag.Api.docker(`/containers/${id}/json`);
          const resolved = (info.Name || "").replace(/^\//, "") || name;
          name = resolved;
          const sub = host.querySelector(".modal-sub");
          if (sub) sub.textContent = `${resolved} \xB7 ${bag.shortId(id)}`;
          rawJson = JSON.stringify(info, null, 2);
          view.textContent = rawJson;
          if (meta) meta.textContent = `${bag.formatBytes(rawJson.length)} \xB7 JSON`;
        } catch (err) {
          rawJson = "";
          view.textContent = err.message;
          if (meta) meta.textContent = "Erreur";
        }
      };
      await load();
      bag.onBusyClick(document.getElementById("inspect-refresh"), load, { disableSiblings: false, minMs: 200 });
      document.getElementById("inspect-copy")?.addEventListener("click", async () => {
        if (!rawJson) return;
        try {
          await navigator.clipboard.writeText(rawJson);
        } catch (_) {
        }
      });
    };
    bag.openLogsModal = async function openLogsModal(id, name) {
      bag.closeAppModal();
      const host = bag.modalHost();
      const safeName = String(name || id).replace(/[^\w.-]+/g, "_");
      host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-xl modal-workspace modal-logs" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3>Logs conteneur</h3>
              <div class="modal-sub mono">${bag.esc(name)} \xB7 ${bag.esc(bag.shortId(id))}</div>
            </div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">\u2715</button>
          </div>
          <div class="logs-panel">
            <div class="logs-toolbar">
              <div class="field-inline">
                <label for="log-tail">Tail</label>
                <select id="log-tail">
                  <option value="100">100</option>
                  <option value="300" selected>300</option>
                  <option value="1000">1000</option>
                  <option value="all">Tout</option>
                </select>
              </div>
              <label class="logs-check"><input type="checkbox" id="log-follow" checked> Suivre</label>
              <label class="logs-check"><input type="checkbox" id="log-timestamps" checked> Horodatage</label>
              <div class="field-inline logs-search-wrap">
                <label for="log-search">Recherche</label>
                <input type="search" id="log-search" placeholder="Filtrer\u2026" autocomplete="off">
              </div>
              <button type="button" class="btn btn-sm" id="refresh-logs">Actualiser</button>
              <button type="button" class="btn btn-sm" id="copy-logs">Copier</button>
              <button type="button" class="btn btn-sm" id="download-logs">T\xE9l\xE9charger</button>
              <div class="logs-status" id="log-status">
                <span class="dot"></span>
                <span class="label">Chargement\u2026</span>
              </div>
            </div>
            <div class="logs log-view" id="log-view" tabindex="0">Chargement des journaux\u2026</div>
          </div>
        </div>
      </div>`;
      bag.bindAppModalChrome();
      const view = document.getElementById("log-view");
      const statusEl = document.getElementById("log-status");
      const followEl = document.getElementById("log-follow");
      const tsEl = document.getElementById("log-timestamps");
      const tailEl = document.getElementById("log-tail");
      const searchEl = document.getElementById("log-search");
      const session = {
        buffer: "",
        lastIso: null,
        stickBottom: true,
        loading: false,
        err: null
      };
      const setStatus = (mode, text) => {
        if (!statusEl) return;
        statusEl.classList.remove("is-live", "is-paused", "is-error");
        if (mode) statusEl.classList.add(mode);
        const label = statusEl.querySelector(".label");
        if (label) label.textContent = text;
      };
      const paint = () => {
        const filter = searchEl?.value || "";
        if (session.err && !session.buffer) {
          view.innerHTML = `<div class="log-empty log-error">${bag.esc(session.err)}</div>`;
          return;
        }
        view.innerHTML = bag.renderLogLines(session.buffer, filter);
        if (session.stickBottom) view.scrollTop = view.scrollHeight;
      };
      const advanceCursor = (chunk) => {
        const lines = String(chunk || "").split(/\r\n|\n|\r/);
        for (const line of lines) {
          if (!line) continue;
          const iso = bag.parseLogTimestamp(line);
          if (iso && (!session.lastIso || iso > session.lastIso)) session.lastIso = iso;
        }
      };
      const fetchLogs = async ({ incremental = false } = {}) => {
        if (session.loading) return;
        session.loading = true;
        const timestamps = !!tsEl?.checked;
        const tail = tailEl?.value || "300";
        const opts = {
          timestamps,
          annotate: true,
          stdout: true,
          stderr: true
        };
        if (incremental && timestamps && session.lastIso) {
          const since = Math.floor(Date.parse(session.lastIso) / 1e3);
          if (Number.isFinite(since) && since > 0) {
            opts.since = since;
            opts.tail = "all";
          } else {
            opts.tail = tail;
          }
        } else {
          opts.tail = tail;
        }
        try {
          const text = await bag.Api.containerLogs(id, opts);
          session.err = null;
          if (incremental && session.buffer && opts.since) {
            if (text) {
              const incoming = String(text);
              const filtered = incoming.split(/\r\n|\n|\r/).filter((line) => {
                if (!line) return false;
                const iso = bag.parseLogTimestamp(line);
                if (!iso) return true;
                return iso > session.lastIso;
              }).join("\n");
              if (filtered) {
                session.buffer = session.buffer.replace(/\s*$/, "") + (session.buffer ? "\n" : "") + filtered;
                advanceCursor(filtered);
              }
            }
          } else {
            session.buffer = String(text || "");
            session.lastIso = null;
            advanceCursor(session.buffer);
          }
          paint();
          const when = (/* @__PURE__ */ new Date()).toLocaleTimeString();
          if (followEl?.checked) setStatus("is-live", `En direct \xB7 ${when}`);
          else setStatus("is-paused", `\xC0 jour \xB7 ${when}`);
        } catch (err) {
          session.err = err.message || String(err);
          if (!session.buffer) paint();
          setStatus("is-error", session.err);
        } finally {
          session.loading = false;
        }
      };
      view.addEventListener("scroll", () => {
        const gap = view.scrollHeight - view.scrollTop - view.clientHeight;
        session.stickBottom = gap < 40;
      });
      searchEl?.addEventListener("input", () => paint());
      tsEl?.addEventListener("change", async () => {
        session.lastIso = null;
        await fetchLogs({ incremental: false });
      });
      tailEl?.addEventListener("change", async () => {
        session.lastIso = null;
        await fetchLogs({ incremental: false });
      });
      followEl?.addEventListener("change", () => {
        if (followEl.checked) setStatus("is-live", "En direct\u2026");
        else setStatus("is-paused", "Suivi en pause");
      });
      bag.onBusyClick(document.getElementById("refresh-logs"), async () => {
        session.lastIso = null;
        await fetchLogs({ incremental: false });
      }, { disableSiblings: false, minMs: 200 });
      document.getElementById("copy-logs")?.addEventListener("click", async () => {
        const plain = bag.stripLogAnnotations(session.buffer);
        try {
          await navigator.clipboard.writeText(plain);
          setStatus(followEl?.checked ? "is-live" : "is-paused", "Copi\xE9 dans le presse-papiers");
        } catch (_) {
          setStatus("is-error", "Impossible de copier");
        }
      });
      document.getElementById("download-logs")?.addEventListener("click", () => {
        bag.downloadTextFile(`${safeName}-logs.txt`, bag.stripLogAnnotations(session.buffer));
      });
      await fetchLogs({ incremental: false });
      if (bag.state.logTimer) {
        clearInterval(bag.state.logTimer);
        bag.state.logTimer = null;
      }
      bag.state.logTimer = setInterval(() => {
        if (!followEl?.checked) return;
        fetchLogs({ incremental: !!tsEl?.checked && !!session.lastIso });
      }, 1800);
    };
    bag.openConsoleModal = async function openConsoleModal(id, name, runningHint) {
      bag.closeAppModal();
      let running = !!runningHint;
      if (runningHint == null) {
        try {
          const info = await bag.Api.docker(`/containers/${id}/json`);
          running = String(info.State?.Status || "").toLowerCase() === "running";
          name = (info.Name || "").replace(/^\//, "") || name;
        } catch (_) {
        }
      }
      const host = bag.modalHost();
      host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-xl modal-workspace modal-console" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3>Console</h3>
              <div class="modal-sub mono">${bag.esc(name)} \xB7 ${bag.esc(bag.shortId(id))}</div>
            </div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">\u2715</button>
          </div>
          <div class="console-panel">
            <div class="console-toolbar">
              <div class="field-inline">
                <label for="shell-bin">Commande</label>
                <select id="shell-bin">
                  <option value="/bin/bash">/bin/bash</option>
                  <option value="/bin/sh" selected>/bin/sh</option>
                  <option value="/bin/ash">/bin/ash</option>
                </select>
              </div>
              <button class="btn btn-info btn-sm" id="console-connect" ${running ? "" : "disabled"}>Connecter</button>
              <button class="btn btn-sm" id="console-disconnect" disabled>D\xE9connecter</button>
              <div class="console-status" id="console-status">
                <span class="dot"></span>
                <span class="label">${running ? "Pr\xEAt \xE0 connecter" : "Le conteneur n'est pas d\xE9marr\xE9"}</span>
              </div>
            </div>
            <div class="console-wrap" id="term">
              <div class="console-placeholder" id="console-placeholder">
                <div style="font-size:28px;opacity:.5">\u2B1B</div>
                <p>${running ? "Choisissez un shell puis cliquez sur <strong>Connecter</strong> pour ouvrir une console dans ce conteneur." : "D\xE9marrez le conteneur avant d'ouvrir la console."}</p>
              </div>
            </div>
            <div class="console-hint">TTY interactif (WebSocket) \xB7 comme un vrai shell \xB7 Ctrl+C / vi / top support\xE9s</div>
          </div>
        </div>
      </div>`;
      bag.bindAppModalChrome();
      if (running) bag.setupConsole(id, name);
    };
    bag.viewContainers = async function viewContainers() {
      const all = bag.isAllNodes();
      let list = [];
      let partial = false;
      let perNodeHint = "";
      let failMsg = "";
      if (all) {
        const agg = await bag.dockerAll("/containers/json?all=true");
        list = agg.items;
        partial = agg.failed > 0;
        perNodeHint = (agg.perNode || []).map((n) => `${n.name}: ${n.count}`).join(" \xB7 ");
        failMsg = (agg.failedNames || []).length ? ` N\u0153uds sans r\xE9ponse : ${(agg.failedNames || []).join(", ")}.` : "";
      } else {
        list = await bag.Api.docker("/containers/json?all=true") || [];
      }
      const containerName = (c) => c.Names && c.Names[0] ? c.Names[0].replace(/^\//, "") : bag.shortId(c.Id);
      list = bag.sortItems(list, "containers", {
        name: containerName,
        image: (c) => c.Image || "",
        state: (c) => String(c.State || ""),
        node: (c) => c._nodeName || "",
        ports: (c) => bag.formatPorts(c.Ports || [], c._nodeId || c.EndpointId),
        created: (c) => bag.createdSortKey(c.Created)
      });
      const rows = list.map((c) => {
        const name = containerName(c);
        const st = String(c.State || "").toLowerCase();
        const isRunning = st === "running" || st === "restarting";
        const rowCls = isRunning ? "" : "row-stopped";
        const search = `${name} ${c.Image} ${c.Id} ${c.State} ${c._nodeName || ""}`.toLowerCase();
        const actions = all ? `<span class="muted">\u2014</span>` : `<div class="quick-actions">
          ${bag.iconBtn({ act: "start", id: c.Id, title: "D\xE9marrer", icon: "start", success: !isRunning })}
          ${bag.iconBtn({ act: "stop", id: c.Id, title: "Arr\xEAter", icon: "stop", danger: isRunning })}
          ${bag.iconBtn({ act: "restart", id: c.Id, title: "Red\xE9marrer", icon: "restart" })}
          ${bag.iconBtn({
          modal: "stats",
          id: c.Id,
          name,
          running: isRunning,
          title: isRunning ? "CPU / RAM / R\xE9seau" : "Conteneur arr\xEAt\xE9",
          icon: "stats",
          statsId: c.Id,
          extraClass: isRunning ? "is-stats-ok" : "is-stats-off"
        })}
          ${bag.iconBtn({ modal: "logs", id: c.Id, name, running: isRunning, title: "Logs", icon: "logs" })}
          ${bag.iconBtn({ modal: "console", id: c.Id, name, running: isRunning, title: "Console", icon: "console" })}
          ${bag.iconBtn({ modal: "inspect", id: c.Id, name, running: isRunning, title: "Inspecter", icon: "inspect" })}
          ${bag.iconBtn({ title: "Partager", icon: "users", info: true, shareType: "container", shareKey: name || c.Id })}
          ${bag.iconBtn({ act: "remove", id: c.Id, title: "Supprimer", icon: "remove", danger: true })}
        </div>`;
        return `<tr class="${rowCls}" data-search="${bag.esc(search)}" data-container-id="${bag.esc(c.Id)}">
        ${all ? "" : bag.bulkSelectTd(c.Id)}
        ${all ? `<td class="muted">${bag.esc(c._nodeName || "\u2014")}</td>` : ""}
        <td class="name-cell">
          <strong><a href="#containers/${bag.esc(c.Id)}" ${all ? `data-switch-node="${bag.esc(c._nodeId)}"` : ""}>${bag.esc(name)}</a></strong>
          <span class="id">${bag.esc(bag.shortId(c.Id))}</span>
        </td>
        <td class="mono cell-clip cell-image" title="${bag.esc(c.Image || "")}">
          <span class="img-with-upd">
            ${all ? "" : `<span class="img-upd-slot" data-cupd="${bag.esc(c.Id)}">
              <span class="img-upd is-loading img-upd-dot-only" title="V\xE9rification de l\u2019image\u2026"><span class="img-upd-dot"></span></span>
            </span>`}
            <span class="img-name">${bag.esc(c.Image || "")}</span>
          </span>
        </td>
        <td>${bag.badge(c.State)}</td>
        <td>${bag.formatPorts(c.Ports || [], c._nodeId || c.EndpointId)}</td>
        <td>${bag.formatCreated(c.Created)}</td>
        <td class="actions">${actions}</td>
      </tr>`;
      }).join("");
      const colSpan = all ? 7 : 8;
      bag.root.innerHTML = bag.shell("Conteneurs", `
      ${bag.pageHeader(all ? "Conteneurs \u2014 tous les n\u0153uds" : "Liste des conteneurs")}
      ${partial ? `<div class="info-box" style="margin-bottom:12px">Agr\xE9gat partiel.${bag.esc(failMsg)}</div>` : ""}
      ${all && perNodeHint ? `<div class="muted" style="margin-bottom:10px">R\xE9partition \u2014 ${bag.esc(perNodeHint)}</div>` : ""}
      ${all ? bag.pickNodeGuardHtml() : ""}
      <div class="toolbar">
        <input class="search" id="filter" type="search" placeholder="Rechercher des conteneurs\u2026" value="${bag.esc(bag.state.filters.containers || "")}">
        ${all ? "" : `${bag.createBtn("create-container", "Cr\xE9er un conteneur")}${bag.bulkDeleteBtnHtml()}`}
        <div class="spacer"></div>
        ${all ? "" : `<span class="muted" style="font-size:12px">\u25CF vert = \xE0 jour \xB7 \u25CF orange = mise \xE0 jour dispo \xB7 cache 24 h</span>
        <button type="button" class="btn btn-sm" id="container-upd-refresh" title="Rev\xE9rifier les images maintenant">Rafra\xEEchir images</button>`}
        <span class="muted mono" id="filter-count">${list.length} / ${list.length}</span>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr>
            ${bag.bulkSelectTh(!all)}
            ${all ? bag.sortTh("N\u0153ud", "node", "containers") : ""}
            ${bag.sortTh("Nom", "name", "containers")}
            ${bag.sortTh("Image", "image", "containers")}
            ${bag.sortTh("\xC9tat", "state", "containers")}
            ${bag.sortTh("Ports publi\xE9s", "ports", "containers")}
            ${bag.sortTh("Cr\xE9\xE9", "created", "containers")}
            <th>Actions</th>
          </tr></thead>
          <tbody>${rows || `<tr><td colspan="${colSpan}" class="empty">Aucun conteneur</td></tr>`}</tbody>
        </table>
      </div>`, { subtitle: all ? "Vue agr\xE9g\xE9e (lecture)" : "G\xE9rez vos conteneurs Docker" });
      bag.bindRefresh();
      bag.bindShareButtons();
      bag.bindMoreActions();
      bag.bindPagedSearch("containers");
      bag.bindTableSort("containers", () => bag.viewContainers());
      if (!all) {
        bag.bindModalActions();
        document.getElementById("create-container").onclick = () => bag.openCreateContainerModal();
        bag.root.querySelectorAll("[data-act]").forEach((btn) => {
          const act = btn.dataset.act;
          bag.onBusyClick(btn, async (el) => {
            await bag.containerAction(el.dataset.id, act);
          }, {
            confirm: act === "remove" ? "Supprimer ce conteneur ?" : null,
            reload: true
          });
        });
        bag.bindBulkDelete({
          enabled: true,
          confirmOne: () => "Supprimer ce conteneur ?",
          confirmMany: (n) => `Supprimer ${n} conteneurs ?`,
          deleteOne: (id) => bag.containerAction(id, "remove"),
          reload: () => bag.viewContainers()
        });
        document.getElementById("container-upd-refresh")?.addEventListener("click", () => {
          bag.root.querySelectorAll("[data-cupd]").forEach((slot) => {
            slot.innerHTML = `<span class="img-upd is-loading img-upd-dot-only" title="V\xE9rification\u2026"><span class="img-upd-dot"></span></span>`;
          });
          bag.loadContainerUpdateIndicators(true);
        });
        bag.loadContainerUpdateIndicators(false);
        bag.startContainerStatsPoll(list);
      } else {
        bag.root.querySelectorAll("[data-switch-node]").forEach((a) => {
          a.addEventListener("click", () => {
            const id = parseInt(a.getAttribute("data-switch-node"), 10);
            if (Number.isFinite(id) && id > 0) {
              bag.Api.setEndpointId(id);
              bag.state.endpointId = id;
            }
          });
        });
      }
      bag.restoreListFocus();
    };
    bag.loadContainerUpdateIndicators = async function loadContainerUpdateIndicators(refresh = false) {
      if (!refresh) bag.paintCachedUpdateIndicators("containers", "data-cupd");
      try {
        const data = await bag.Api.containerUpdates(!!refresh);
        const map = data?.Updates || {};
        bag.writeImageUpdateCache("containers", map);
        const fromCache = !!data?.FromCache;
        const checkedAt = Number(data?.CheckedAt || 0);
        Object.keys(map).forEach((id) => {
          const slot = bag.root.querySelector(`[data-cupd="${CSS.escape(String(id))}"]`);
          if (!slot) return;
          const u = map[id] || {};
          const ver = bag.formatImageUpdateVersions(u);
          let title = ver || u.Detail || u.Error || "Aucun contr\xF4le";
          if (u.Image) title = `${u.Image}
${title}`;
          if (fromCache && checkedAt) {
            title += `
(cache \xB7 v\xE9rifi\xE9 ${new Date(checkedAt * 1e3).toLocaleString()})`;
          }
          slot.innerHTML = bag.stackUpdatePill(u.Status, u.UpdateCount || 0, title, {
            action: "container",
            id,
            dotOnly: true
          });
        });
        bag.root.querySelectorAll("[data-cupd] .img-upd.is-loading").forEach((el) => {
          el.className = "img-upd is-unknown img-upd-dot-only";
          el.title = "Contr\xF4le indisponible";
        });
        bag.bindImageUpdateActions(bag.root);
      } catch {
        bag.root.querySelectorAll("[data-cupd]").forEach((slot) => {
          slot.innerHTML = bag.stackUpdatePill("unknown", 0, "Contr\xF4le indisponible", { dotOnly: true });
        });
      }
    };
    bag.viewContainerDetail = async function viewContainerDetail(id, tab) {
      const requested = tab || "overview";
      const openAsModal = requested === "logs" || requested === "console" || requested === "inspect";
      bag.state.containerTab = openAsModal ? "overview" : requested;
      const info = await bag.Api.docker(`/containers/${id}/json`);
      const name = (info.Name || "").replace(/^\//, "");
      const ports = bag.portsFromInspect(info);
      const running = String(info.State?.Status || "").toLowerCase() === "running";
      const tabs = [
        ["overview", "Aper\xE7u"],
        ["logs", "Logs conteneur"],
        ["console", "Console"],
        ["inspect", "Inspecter"]
      ].map(
        ([t, label]) => `<button class="tab ${bag.state.containerTab === t ? "active" : ""}" data-tab="${t}">${label}</button>`
      ).join("");
      const body = `
        <div class="panel">
          <dl class="kv">
            <dt>Nom</dt><dd>${bag.esc(name)}</dd>
            <dt>ID</dt><dd class="mono">${bag.esc(info.Id)}</dd>
            <dt>Image</dt><dd class="mono">${bag.esc(info.Config?.Image || "")}</dd>
            <dt>Mise \xE0 jour</dt><dd id="container-upd-summary"><span class="img-upd is-loading" title="V\xE9rification\u2026"><span class="img-upd-dot"></span><span class="img-upd-lbl">\u2026</span></span></dd>
            <dt>Statut</dt><dd>${bag.badge(info.State?.Status || "")}</dd>
            <dt>Cr\xE9\xE9 le</dt><dd>${bag.esc(info.Created || "")}</dd>
            <dt>Adresse IP</dt><dd class="mono">${bag.esc(info.NetworkSettings?.IPAddress || Object.values(info.NetworkSettings?.Networks || {})[0]?.IPAddress || "\u2014")}</dd>
            <dt>Ports publi\xE9s</dt><dd>${bag.formatPorts(ports, bag.state.endpointId)}</dd>
            <dt>Commande</dt><dd class="mono">${bag.esc((info.Config?.Cmd || []).join(" "))}</dd>
          </dl>
        </div>`;
      bag.root.innerHTML = bag.shell(`Conteneur \xB7 ${name}`, `
      ${bag.pageHeader(name, false)}
      <div class="toolbar">
        ${bag.iconBtn({ tag: "a", href: "#containers", title: "Retour", icon: "back" })}
        <div class="quick-actions">
          ${bag.iconBtn({ act: "start", title: "D\xE9marrer", icon: "start", success: !running })}
          ${bag.iconBtn({ act: "stop", title: "Arr\xEAter", icon: "stop", danger: running })}
          ${bag.iconBtn({ act: "restart", title: "Red\xE9marrer", icon: "restart" })}
          ${bag.iconBtn({
        modal: "stats",
        id,
        name,
        running,
        title: running ? "CPU / RAM / R\xE9seau" : "Conteneur arr\xEAt\xE9",
        icon: "stats",
        statsId: id,
        extraClass: running ? "is-stats-ok" : "is-stats-off"
      })}
          ${bag.iconBtn({ modal: "logs", id, name, running, title: "Logs", icon: "logs" })}
          ${bag.iconBtn({ modal: "console", id, name, running, title: "Console", icon: "console" })}
          ${bag.iconBtn({ modal: "inspect", id, name, running, title: "Inspecter", icon: "inspect" })}
          ${bag.iconBtn({ title: "Partager", icon: "users", info: true, shareType: "container", shareKey: name || id })}
          ${bag.iconBtn({ act: "remove", title: "Supprimer", icon: "remove", danger: true })}
        </div>
        <div class="spacer"></div>
        ${bag.formatPorts(ports, bag.state.endpointId)}
      </div>
      <div class="tabs">${tabs}</div>
      ${body}
    `, { subtitle: "D\xE9tail du conteneur" });
      bag.bindModalActions();
      bag.bindShareButtons();
      bag.bindMoreActions();
      bag.startContainerStatsPoll([{ Id: id, State: running ? "running" : "exited" }]);
      bag.root.querySelectorAll(".tab").forEach((el) => {
        el.onclick = async () => {
          const t = el.dataset.tab;
          if (t === "logs") {
            await bag.openLogsModal(id, name);
            return;
          }
          if (t === "console") {
            await bag.openConsoleModal(id, name, running);
            return;
          }
          if (t === "inspect") {
            await bag.openInspectModal(id, name);
            return;
          }
          location.hash = `#containers/${id}/${t}`;
        };
      });
      bag.root.querySelectorAll("[data-act]").forEach((btn) => {
        bag.onBusyClick(btn, async (el) => {
          const focus = bag.captureListFocus(el);
          await bag.containerAction(id, el.dataset.act);
          if (el.dataset.act === "remove") {
            location.hash = "#containers";
            return "navigated";
          }
          bag.rememberListFocus(focus);
          return;
        }, {
          confirm: btn.dataset.act === "remove" ? "Supprimer ce conteneur ?" : null,
          reload: btn.dataset.act !== "remove"
        });
      });
      try {
        const upd = await bag.Api.containerUpdateStatus(id);
        const sum = document.getElementById("container-upd-summary");
        if (sum) {
          sum.innerHTML = bag.stackUpdatePill(
            upd.Status,
            upd.UpdateCount || 0,
            (() => {
              const ver = bag.formatImageUpdateVersions(upd);
              let tip = ver || upd.Detail || `${upd.Checked || 0} contr\xF4le(s)`;
              if (upd.Image) tip = `${upd.Image}
${tip}`;
              return tip;
            })(),
            { action: "container", id }
          );
          bag.bindImageUpdateActions(sum);
        }
      } catch (err) {
        const sum = document.getElementById("container-upd-summary");
        if (sum) sum.innerHTML = bag.stackUpdatePill("unknown", 0, err.message || "Erreur");
      }
      if (requested === "logs") await bag.openLogsModal(id, name);
      else if (requested === "console") await bag.openConsoleModal(id, name, running);
      else if (requested === "inspect") await bag.openInspectModal(id, name);
    };
    bag.setConsoleStatus = function setConsoleStatus(mode, text) {
      const el = document.getElementById("console-status");
      if (!el) return;
      el.classList.remove("is-connected", "is-busy");
      if (mode) el.classList.add(mode);
      const label = el.querySelector(".label");
      if (label) label.textContent = text;
    };
    bag.setupConsole = function setupConsole(containerId, containerName) {
      const connectBtn = document.getElementById("console-connect");
      const disconnectBtn = document.getElementById("console-disconnect");
      const shellSelect = document.getElementById("shell-bin");
      if (!connectBtn) return;
      bag.onBusyClick(connectBtn, async () => {
        await bag.mountConsole(containerId, containerName);
        connectBtn.disabled = true;
        shellSelect.disabled = true;
        disconnectBtn.disabled = false;
      }, { disableSiblings: false });
      disconnectBtn.onclick = () => {
        bag.closeConsoleSession();
        const wrap = document.getElementById("term");
        if (wrap) {
          wrap.innerHTML = `<div class="console-placeholder" id="console-placeholder">
          <div style="font-size:28px;opacity:.5">\u2B1B</div>
          <p>D\xE9connect\xE9. Cliquez sur <strong>Connecter</strong> pour une nouvelle session.</p>
        </div>`;
        }
        connectBtn.disabled = false;
        shellSelect.disabled = false;
        disconnectBtn.disabled = true;
        bag.setConsoleStatus("", "Pr\xEAt \xE0 connecter");
      };
    };
    bag.closeConsoleSession = function closeConsoleSession() {
      if (bag.state.consoleWs) {
        try {
          bag.state.consoleWs.close();
        } catch (_) {
        }
        bag.state.consoleWs = null;
      }
      if (bag.state.consoleResizeTimer) {
        clearTimeout(bag.state.consoleResizeTimer);
        bag.state.consoleResizeTimer = null;
      }
      if (bag.state.term) {
        try {
          bag.state.term.dispose();
        } catch (_) {
        }
        bag.state.term = null;
      }
      bag.state.consoleExecId = null;
    };
    bag.mountConsole = async function mountConsole(containerId, containerName) {
      const wrap = document.getElementById("term");
      if (!wrap) return;
      if (typeof Terminal === "undefined") {
        wrap.innerHTML = '<div class="error-box" style="margin:12px">\xC9chec du chargement de xterm</div>';
        return;
      }
      bag.closeConsoleSession();
      const placeholder = document.getElementById("console-placeholder");
      if (placeholder) placeholder.remove();
      wrap.innerHTML = "";
      const shellSelect = document.getElementById("shell-bin");
      const shortName = (containerName || bag.shortId(containerId)).replace(/[^a-zA-Z0-9_.-]/g, "") || "container";
      const term = new Terminal({
        cursorBlink: true,
        cursorStyle: "bar",
        cursorWidth: 2,
        fontFamily: '"IBM Plex Mono", "JetBrains Mono", Menlo, Monaco, Consolas, monospace',
        fontSize: 14,
        lineHeight: 1.4,
        letterSpacing: 0.3,
        theme: {
          background: "#0b1220",
          foreground: "#e2e8f0",
          cursor: "#38bdf8",
          cursorAccent: "#0b1220",
          selectionBackground: "#1e3a5f",
          black: "#0b1220",
          red: "#f87171",
          green: "#4ade80",
          yellow: "#fbbf24",
          blue: "#60a5fa",
          magenta: "#c084fc",
          cyan: "#22d3ee",
          white: "#e2e8f0",
          brightBlack: "#64748b",
          brightRed: "#fca5a5",
          brightGreen: "#86efac",
          brightYellow: "#fde68a",
          brightBlue: "#93c5fd",
          brightMagenta: "#d8b4fe",
          brightCyan: "#67e8f9",
          brightWhite: "#f8fafc"
        },
        convertEol: true,
        allowTransparency: false,
        scrollback: 8e3
      });
      let fit = null;
      try {
        const FitCtor = window.FitAddon && window.FitAddon.FitAddon || (window.FitAddon && window.FitAddon.prototype ? window.FitAddon : null);
        if (FitCtor) {
          fit = new FitCtor();
          term.loadAddon(fit);
        }
      } catch (_) {
      }
      term.open(wrap);
      if (fit) {
        fit.fit();
        requestAnimationFrame(() => {
          try {
            fit.fit();
          } catch (_) {
          }
        });
      }
      bag.state.term = term;
      term.focus();
      bag.setConsoleStatus("is-busy", "Cr\xE9ation de la session\u2026");
      let session;
      try {
        session = await bag.Api.createConsoleSession(containerId, {
          shell: shellSelect?.value || "/bin/sh",
          cols: Math.max(40, term.cols || 120),
          rows: Math.max(10, term.rows || 40)
        });
      } catch (err) {
        term.writeln(`\x1B[31m${err.message || err}\x1B[0m`);
        bag.setConsoleStatus("", "Erreur");
        throw err;
      }
      const execId = session.Id || session.id;
      const ticket = session.Token || session.token;
      const endpointId = session.EndpointId || bag.Api.getEndpointId();
      bag.state.consoleExecId = execId;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${proto}//${location.host}/api/websocket/exec?id=${encodeURIComponent(execId)}&endpointId=${encodeURIComponent(endpointId)}&token=${encodeURIComponent(ticket)}`;
      bag.setConsoleStatus("is-busy", "Connexion WebSocket\u2026");
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      bag.state.consoleWs = ws;
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("D\xE9lai de connexion WebSocket d\xE9pass\xE9")), 15e3);
        ws.onopen = () => {
          clearTimeout(t);
          resolve();
        };
        ws.onerror = () => {
          clearTimeout(t);
          reject(new Error("\xC9chec WebSocket (proxy Upgrade ?)"));
        };
      });
      term.writeln(`\x1B[90mConnect\xE9 \xE0 ${shortName} via ${session.Shell || shellSelect?.value || "/bin/sh"} (TTY)\x1B[0m`);
      bag.setConsoleStatus("is-connected", `Connect\xE9 \xB7 ${session.Shell || shellSelect?.value || "/bin/sh"}`);
      const sendResize = () => {
        const h = Math.max(10, term.rows || 40);
        const w = Math.max(40, term.cols || 120);
        bag.Api.resizeConsole(execId, h, w).catch(() => {
        });
      };
      sendResize();
      ws.onmessage = (ev) => {
        if (!bag.state.term) return;
        if (typeof ev.data === "string") {
          term.write(ev.data);
          return;
        }
        const bytes = new Uint8Array(ev.data);
        let s = "";
        for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        term.write(s);
      };
      ws.onclose = () => {
        bag.state.consoleWs = null;
        if (bag.state.term) {
          term.writeln("\r\n\x1B[33m[session termin\xE9e]\x1B[0m");
          bag.setConsoleStatus("", "D\xE9connect\xE9");
        }
      };
      ws.onerror = () => {
        term.writeln("\r\n\x1B[31m[erreur WebSocket]\x1B[0m");
      };
      term.onData((data) => {
        if (!bag.state.consoleWs || bag.state.consoleWs.readyState !== WebSocket.OPEN) return;
        bag.state.consoleWs.send(data);
      });
      const onResize = () => {
        try {
          fit && fit.fit();
        } catch (_) {
        }
        if (bag.state.consoleResizeTimer) clearTimeout(bag.state.consoleResizeTimer);
        bag.state.consoleResizeTimer = setTimeout(sendResize, 120);
      };
      window.addEventListener("resize", onResize);
      const modalEl = wrap.closest(".modal-workspace");
      if (modalEl) modalEl.addEventListener("wm-modal-resize", onResize);
      term.onResize?.(() => {
        if (bag.state.consoleResizeTimer) clearTimeout(bag.state.consoleResizeTimer);
        bag.state.consoleResizeTimer = setTimeout(sendResize, 120);
      });
      term.onDispose?.(() => {
        window.removeEventListener("resize", onResize);
        if (bag.state.consoleWs) {
          try {
            bag.state.consoleWs.close();
          } catch (_) {
          }
          bag.state.consoleWs = null;
        }
      });
    };
    bag.containerAction = async function containerAction(id, act) {
      if (act === "start") await bag.Api.docker(`/containers/${id}/start`, { method: "POST" });
      if (act === "stop") await bag.Api.docker(`/containers/${id}/stop`, { method: "POST" });
      if (act === "restart") await bag.Api.docker(`/containers/${id}/restart`, { method: "POST" });
      if (act === "remove") await bag.Api.docker(`/containers/${id}?force=true`, { method: "DELETE" });
    };
    bag.parseLogTimestamp = function parseLogTimestamp(line) {
      const s = line.charCodeAt(0) === 30 ? line.slice(1) : line;
      const m = s.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s/);
      return m ? m[1] : null;
    };
    bag.stripLogAnnotations = function stripLogAnnotations(text) {
      return String(text || "").replace(/\x1e/g, "");
    };
    bag.detectLogLevel = function detectLogLevel(line, fromStderr) {
      const s = String(line || "");
      if (!s) return fromStderr ? "error" : null;
      let m = s.match(/(?:^|[^\w])(?:level|severity|severityname|severity_name|severityNum|severity_num|sev|severityity)\s*[=:]\s*"?([a-zA-Z]+)"?/i);
      if (m) {
        const lvl = bag.classifyLevelToken(m[1]);
        if (lvl) return lvl;
      }
      m = s.match(/"level"\s*:\s*"([^"]+)"/i);
      if (m) {
        const lvl = bag.classifyLevelToken(m[1]);
        if (lvl) return lvl;
      }
      m = s.match(/[\[(<]\s*(FATAL|CRIT(?:ICAL)?|PANIC|EMERG(?:ENCY)?|ALERT|ERROR|ERR|SEVERE|WARN(?:ING)?|INFO(?:RMATION)?|NOTICE|DEBUG|TRACE|VERBOSE|SUCCESS|OK)\s*[\])>]/i);
      if (m) {
        const lvl = bag.classifyLevelToken(m[1]);
        if (lvl) return lvl;
      }
      m = s.match(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\s+(?:[\[(<])?\s*(FATAL|CRIT(?:ICAL)?|PANIC|EMERG(?:ENCY)?|ALERT|ERROR|ERR|SEVERE|WARN(?:ING)?|INFO(?:RMATION)?|NOTICE|DEBUG|TRACE|VERBOSE)\b/i);
      if (m) {
        const lvl = bag.classifyLevelToken(m[1]);
        if (lvl) return lvl;
      }
      const head = s.slice(0, 160);
      m = head.match(/(?:^|[\s|:\[\]])(FATAL|CRITICAL|PANIC|EMERGENCY|ALERT|ERROR|SEVERE|WARNING|WARN|INFORMATION|INFO|NOTICE|DEBUG|TRACE|VERBOSE|SUCCESS)\b(?=[\s|:\]\)>,-]|$)/i);
      if (m) {
        const lvl = bag.classifyLevelToken(m[1]);
        if (lvl) return lvl;
      }
      if (/\b(?:exception|traceback|stack\s*trace|fatal\s+error|segmentation\s+fault)\b/i.test(s)) return "error";
      if (/\b(?:failed|failure|cannot|unable to)\b/i.test(s) && /\b(?:error|err)\b/i.test(s)) return "error";
      if (fromStderr) return "error";
      return null;
    };
    bag.classifyLevelToken = function classifyLevelToken(tok) {
      const t = String(tok || "").toLowerCase();
      if (["fatal", "crit", "critical", "panic", "emerg", "emergency", "alert", "severe"].includes(t)) return "fatal";
      if (["error", "err", "errr"].includes(t)) return "error";
      if (["warn", "warning"].includes(t)) return "warn";
      if (["info", "information", "notice"].includes(t)) return "info";
      if (["debug", "trace", "verbose"].includes(t)) return "debug";
      if (["success", "ok"].includes(t)) return "success";
      return null;
    };
    bag.renderLogLines = function renderLogLines(text, filter) {
      const raw = String(text || "");
      if (!raw) {
        return '<div class="log-empty">(aucun journal)</div>';
      }
      const q = (filter || "").trim().toLowerCase();
      const lines = raw.split(/\r\n|\n|\r/);
      let html = "";
      let shown = 0;
      for (const line of lines) {
        if (line === "" && shown === 0 && lines.length === 1) continue;
        const fromStderr = line.charCodeAt(0) === 30;
        const clean = fromStderr ? line.slice(1) : line;
        if (q && !clean.toLowerCase().includes(q)) continue;
        shown += 1;
        const level = bag.detectLogLevel(clean, fromStderr);
        const cls = level ? `log-line log-${level}` : "log-line";
        if (q) {
          const idx = clean.toLowerCase().indexOf(q);
          const before = bag.esc(clean.slice(0, idx));
          const match = bag.esc(clean.slice(idx, idx + q.length));
          const after = bag.esc(clean.slice(idx + q.length));
          html += `<div class="${cls}">${before}<mark class="log-hit">${match}</mark>${after}</div>`;
        } else {
          html += `<div class="${cls}">${bag.esc(clean)}</div>`;
        }
      }
      if (!shown) {
        return `<div class="log-empty">Aucun r\xE9sultat pour \xAB ${bag.esc(filter)} \xBB</div>`;
      }
      return html;
    };
    bag.downloadTextFile = function downloadTextFile(filename, text) {
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    };
  }

  // public/assets/js/src/views/images.js
  function install7() {
    bag.parseImageRef = function parseImageRef(ref) {
      const raw = String(ref || "").trim();
      if (!raw) return { fromImage: "", tag: "latest" };
      if (raw.includes("@")) {
        const [fromImage, digest] = raw.split("@");
        return { fromImage, tag: digest ? `@${digest}` : "latest" };
      }
      const idx = raw.lastIndexOf(":");
      if (idx > 0 && !raw.slice(idx + 1).includes("/")) {
        return { fromImage: raw.slice(0, idx), tag: raw.slice(idx + 1) || "latest" };
      }
      return { fromImage: raw, tag: "latest" };
    };
    bag.parsePortBindings = function parsePortBindings(portsText) {
      const ExposedPorts = {};
      const PortBindings = {};
      String(portsText || "").split(/[\n,]+/).map((s) => s.trim()).filter(Boolean).forEach((line) => {
        const m = line.match(/^(?:(\d+(?:-\d+)?):)?(\d+(?:-\d+)?)(?:\/(tcp|udp|sctp))?$/i);
        if (!m) return;
        const proto = (m[3] || "tcp").toLowerCase();
        const containerPort = `${m[2]}/${proto}`;
        ExposedPorts[containerPort] = {};
        if (m[1] !== void 0 && m[1] !== "") {
          PortBindings[containerPort] = [{ HostPort: String(m[1]) }];
        }
      });
      return { ExposedPorts, PortBindings };
    };
    bag.formatPullCount = function formatPullCount(n) {
      const v = Number(n) || 0;
      if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
      if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
      if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
      return String(v);
    };
    bag.imageSearchFieldsHtml = function imageSearchFieldsHtml(prefix) {
      return `
      <div class="img-search" id="${prefix}-img-wrap">
        <input id="${prefix}-image-q" type="search" placeholder="Rechercher une image (ex. nginx, redis\u2026)" autocomplete="off" spellcheck="false">
        <div class="img-search-panel" id="${prefix}-image-panel" hidden>
          <div class="img-search-hint muted" id="${prefix}-image-hint">Saisissez au moins 1 caract\xE8re\u2026</div>
          <div id="${prefix}-image-results"></div>
        </div>
      </div>
      <div class="img-selected" id="${prefix}-image-sel" hidden>
        <span class="img-selected-badge" id="${prefix}-image-badge">Local</span>
        <code class="mono" id="${prefix}-image-ref"></code>
        <button type="button" class="icon-btn img-selected-clear" id="${prefix}-image-clear" title="Changer d\u2019image" aria-label="Changer">\u2715</button>
      </div>
      <div class="form-group" id="${prefix}-tag-wrap" hidden style="margin-top:12px;margin-bottom:0">
        <label class="field-label">Tag</label>
        <select id="${prefix}-tag" class="select-block"></select>
      </div>`;
    };
    bag.bindImageSearchPicker = function bindImageSearchPicker(prefix, modalRoot) {
      let selectedImage = "";
      let selectedSource = "";
      let searchTimer = null;
      let searchSeq = 0;
      const qInput = document.getElementById(`${prefix}-image-q`);
      const panel = document.getElementById(`${prefix}-image-panel`);
      const resultsEl = document.getElementById(`${prefix}-image-results`);
      const hintEl = document.getElementById(`${prefix}-image-hint`);
      const selBox = document.getElementById(`${prefix}-image-sel`);
      const selRef = document.getElementById(`${prefix}-image-ref`);
      const selBadge = document.getElementById(`${prefix}-image-badge`);
      const tagWrap = document.getElementById(`${prefix}-tag-wrap`);
      const tagSel = document.getElementById(`${prefix}-tag`);
      const wrap = document.getElementById(`${prefix}-img-wrap`);
      function hidePanel() {
        if (panel) panel.hidden = true;
      }
      function showSelection(ref, source) {
        selectedImage = ref;
        selectedSource = source;
        if (selRef) selRef.textContent = ref;
        if (selBadge) {
          selBadge.textContent = source === "local" ? "Local" : "Docker Hub";
          selBadge.className = "img-selected-badge" + (source === "local" ? " is-local" : " is-hub");
        }
        if (selBox) selBox.hidden = false;
        if (qInput) qInput.value = "";
        hidePanel();
        wrap?.classList.add("is-picked");
      }
      function clearSelection() {
        selectedImage = "";
        selectedSource = "";
        if (selBox) selBox.hidden = true;
        if (tagWrap) tagWrap.hidden = true;
        if (tagSel) tagSel.innerHTML = "";
        wrap?.classList.remove("is-picked");
        qInput?.focus();
      }
      async function pickLocal(name) {
        showSelection(name, "local");
        if (tagWrap) tagWrap.hidden = true;
      }
      async function pickHub(repo) {
        showSelection(`${repo}:latest`, "hub");
        if (tagWrap) tagWrap.hidden = false;
        if (tagSel) tagSel.innerHTML = `<option value="latest">latest</option>`;
        try {
          const data = await bag.Api.imageTags(repo);
          const tags = Array.isArray(data?.Tags) ? data.Tags : [];
          if (!tags.length || !tagSel) return;
          const names = tags.map((t) => t.Name).filter(Boolean);
          if (!names.includes("latest")) names.unshift("latest");
          const uniq = [...new Set(names)];
          tagSel.innerHTML = uniq.map((t) => `<option value="${bag.esc(t)}">${bag.esc(t)}</option>`).join("");
          tagSel.value = uniq.includes("latest") ? "latest" : uniq[0];
          selectedImage = `${repo}:${tagSel.value}`;
          if (selRef) selRef.textContent = selectedImage;
        } catch (_) {
        }
      }
      tagSel?.addEventListener("change", () => {
        if (!selectedImage) return;
        const { fromImage } = bag.parseImageRef(selectedImage);
        selectedImage = `${fromImage}:${tagSel.value || "latest"}`;
        if (selRef) selRef.textContent = selectedImage;
      });
      document.getElementById(`${prefix}-image-clear`)?.addEventListener("click", clearSelection);
      function renderResults(data, query) {
        const local = Array.isArray(data?.Local) ? data.Local : [];
        const remote = Array.isArray(data?.Remote) ? data.Remote : [];
        if (!local.length && !remote.length) {
          if (hintEl) {
            hintEl.hidden = false;
            hintEl.textContent = `Aucun r\xE9sultat pour \xAB ${query} \xBB`;
          }
          if (resultsEl) resultsEl.innerHTML = "";
          return;
        }
        if (hintEl) hintEl.hidden = true;
        let html = "";
        if (local.length) {
          html += `<div class="img-search-section">Local</div>`;
          html += local.map((r) => `
          <button type="button" class="img-search-item" data-src="local" data-name="${bag.esc(r.Name)}">
            <span class="img-search-main">
              <span class="img-search-name mono">${bag.esc(r.Name)}</span>
              <span class="img-search-desc muted">${bag.esc(r.Description || "Image locale")}</span>
            </span>
            <span class="img-search-meta"><span class="img-selected-badge is-local">Local</span></span>
          </button>`).join("");
        }
        if (remote.length) {
          html += `<div class="img-search-section">Docker Hub</div>`;
          html += remote.map((r) => `
          <button type="button" class="img-search-item" data-src="hub" data-name="${bag.esc(r.Name)}">
            <span class="img-search-main">
              <span class="img-search-name mono">${bag.esc(r.Name)}${r.Official ? ' <span class="img-selected-badge is-hub">Officiel</span>' : ""}</span>
              <span class="img-search-desc muted">${bag.esc(r.Description || "")}</span>
            </span>
            <span class="img-search-meta muted">\u2605 ${bag.esc(String(r.StarCount || 0))} \xB7 ${bag.esc(bag.formatPullCount(r.PullCount))} pulls</span>
          </button>`).join("");
        }
        if (data?.HubError) {
          html += `<div class="img-search-hint muted">Docker Hub : ${bag.esc(data.HubError)}</div>`;
        }
        if (resultsEl) {
          resultsEl.innerHTML = html;
          resultsEl.querySelectorAll(".img-search-item").forEach((btn) => {
            btn.addEventListener("click", () => {
              const name = btn.getAttribute("data-name") || "";
              const src = btn.getAttribute("data-src") || "";
              if (src === "local") pickLocal(name);
              else pickHub(name);
            });
          });
        }
      }
      async function runSearch(query) {
        const seq = ++searchSeq;
        const q = query.trim();
        if (!q) {
          if (hintEl) {
            hintEl.hidden = false;
            hintEl.textContent = "Saisissez au moins 1 caract\xE8re\u2026";
          }
          if (resultsEl) resultsEl.innerHTML = "";
          if (panel) panel.hidden = false;
          return;
        }
        if (panel) panel.hidden = false;
        if (hintEl) {
          hintEl.hidden = false;
          hintEl.textContent = "Recherche\u2026";
        }
        if (resultsEl) resultsEl.innerHTML = "";
        try {
          const data = await bag.Api.searchImages(q);
          if (seq !== searchSeq) return;
          renderResults(data, q);
        } catch (err) {
          if (seq !== searchSeq) return;
          if (hintEl) {
            hintEl.hidden = false;
            hintEl.textContent = err.message || "Erreur de recherche";
          }
          if (resultsEl) resultsEl.innerHTML = "";
        }
      }
      qInput?.addEventListener("focus", () => {
        if (!selectedImage && panel) panel.hidden = false;
      });
      qInput?.addEventListener("input", () => {
        if (selectedImage) clearSelection();
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => runSearch(qInput.value), 280);
      });
      qInput?.addEventListener("keydown", (e) => {
        if (e.key === "Escape") hidePanel();
      });
      modalRoot?.querySelector(".modal")?.addEventListener("mousedown", (e) => {
        if (wrap && !wrap.contains(e.target)) hidePanel();
      });
      return {
        focus: () => qInput?.focus(),
        getSelected() {
          if (selectedSource === "hub" && tagSel && tagWrap && !tagWrap.hidden) {
            const { fromImage } = bag.parseImageRef(selectedImage || "x");
            selectedImage = `${fromImage}:${tagSel.value || "latest"}`;
            if (selRef) selRef.textContent = selectedImage;
          }
          return { image: selectedImage.trim(), source: selectedSource };
        }
      };
    };
    bag.defaultDockerfile = function defaultDockerfile() {
      return `FROM alpine:latest

  LABEL maintainer="docker-manager"

  RUN apk add --no-cache curl

  WORKDIR /app

  CMD ["sh"]
  `;
    };
    bag.formatBuildLog = function formatBuildLog(raw) {
      const lines = String(raw || "").split(/\r?\n/).filter(Boolean);
      const out = [];
      for (const line of lines) {
        try {
          const j = JSON.parse(line);
          if (j.stream) out.push(j.stream.replace(/\n$/, ""));
          else if (j.status) out.push([j.status, j.progress, j.id].filter(Boolean).join(" "));
          else if (j.error) out.push("ERROR: " + j.error);
          else if (j.aux) out.push(JSON.stringify(j.aux));
          else out.push(line);
        } catch {
          out.push(line);
        }
      }
      return out.join("\n") || "(aucune sortie)";
    };
    bag.openBuildImageView = async function openBuildImageView(existingName = "") {
      let content = bag.defaultDockerfile();
      let saveName = existingName || "";
      if (existingName) {
        try {
          const df = await bag.Api.dockerfile(existingName);
          content = df.Content || content;
          saveName = df.Name || existingName;
        } catch (_) {
        }
      }
      let savedList = [];
      try {
        savedList = await bag.Api.dockerfiles();
      } catch (_) {
      }
      const savedOptions = savedList.map(
        (d) => `<option value="${bag.esc(d.Name)}" ${d.Name === saveName ? "selected" : ""}>${bag.esc(d.Name)}</option>`
      ).join("");
      bag.root.innerHTML = bag.shell("Builder une image", `
      <div class="build-layout">
        <div class="panel-card">
          <div class="panel-head">
            <h3>Dockerfile</h3>
          </div>
          <div id="build-err"></div>
          <div class="form-group">
            <label class="field-label">Fichier enregistr\xE9</label>
            <div class="build-file-row">
              <select id="df-saved" class="select-block" title="Dockerfiles enregistr\xE9s">
                <option value="">Nouveau Dockerfile</option>
                ${savedOptions}
              </select>
              ${bag.iconBtn({ elId: "df-del", title: "Supprimer le fichier s\xE9lectionn\xE9", icon: "remove", danger: true })}
            </div>
          </div>
          <div class="form-row-2">
            <div class="form-group">
              <label class="field-label">Tag de l'image <span class="req">*</span></label>
              <input id="build-tag" placeholder="mon-app:latest" value="${bag.esc(saveName ? `${saveName}:latest` : "mon-app:latest")}">
            </div>
            <div class="form-group">
              <label class="field-label">Enregistrer sous</label>
              <input id="build-saveas" placeholder="nom-du-dockerfile" value="${bag.esc(saveName)}">
            </div>
          </div>
          <div class="form-group">
            <label class="field-label">Dockerfile</label>
            <textarea id="build-df" class="code-area" spellcheck="false">${bag.esc(content)}</textarea>
          </div>
          <div class="actions-bar" style="margin-top:12px">
            <button type="button" class="btn btn-primary" id="build-run">Compiler (build)</button>
            <button type="button" class="btn" id="build-save">Enregistrer</button>
            <a class="btn" href="#images">Retour</a>
          </div>
        </div>
        <div class="panel-card">
          <div class="panel-head"><h3>Sortie du build</h3></div>
          <pre class="logs build-log" id="build-log">En attente d\u2019un build\u2026</pre>
        </div>
      </div>
    `, { subtitle: "\xC9crire un Dockerfile et compiler une image locale" });
      const loadSaved = async (name) => {
        if (!name) {
          document.getElementById("build-df").value = bag.defaultDockerfile();
          document.getElementById("build-saveas").value = "";
          return;
        }
        try {
          const df = await bag.Api.dockerfile(name);
          document.getElementById("build-df").value = df.Content || "";
          document.getElementById("build-saveas").value = df.Name || name;
          const tag = document.getElementById("build-tag");
          if (tag && (!tag.value || tag.value.endsWith(":latest"))) tag.value = `${df.Name || name}:latest`;
        } catch (err) {
          alert(err.message);
        }
      };
      const dfSel = document.getElementById("df-saved");
      const dfDel = document.getElementById("df-del");
      const syncDfDel = () => {
        if (!dfDel) return;
        const hasSaved = !!dfSel?.value;
        dfDel.disabled = !hasSaved;
        dfDel.style.opacity = hasSaved ? "1" : "0.4";
        dfDel.title = hasSaved ? "Supprimer le fichier s\xE9lectionn\xE9" : "S\xE9lectionnez un fichier enregistr\xE9";
      };
      dfSel.onchange = (e) => {
        loadSaved(e.target.value);
        syncDfDel();
      };
      syncDfDel();
      dfDel.onclick = async () => {
        const name = dfSel.value;
        if (!name) return;
        if (!confirm(`Supprimer le Dockerfile \xAB ${name} \xBB ?`)) return;
        try {
          await bag.Api.deleteDockerfile(name);
          location.hash = "#images/build";
          await bag.openBuildImageView();
        } catch (err) {
          alert(err.message);
        }
      };
      document.getElementById("build-save").onclick = async () => {
        const errBox = document.getElementById("build-err");
        errBox.innerHTML = "";
        const name = document.getElementById("build-saveas").value.trim();
        const content2 = document.getElementById("build-df").value;
        if (!name) {
          errBox.innerHTML = `<div class="error-box">Indiquez un nom pour enregistrer le Dockerfile.</div>`;
          return;
        }
        try {
          await bag.Api.saveDockerfile(name, content2);
          errBox.innerHTML = `<div class="info-box">Dockerfile \xAB ${bag.esc(name)} \xBB enregistr\xE9.</div>`;
          const sel = document.getElementById("df-saved");
          if (sel && ![...sel.options].some((o) => o.value === name)) {
            const opt = document.createElement("option");
            opt.value = name;
            opt.textContent = name;
            sel.appendChild(opt);
          }
          if (sel) sel.value = name;
        } catch (err) {
          errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
        }
      };
      bag.onBusyClick(document.getElementById("build-run"), async () => {
        const errBox = document.getElementById("build-err");
        const log = document.getElementById("build-log");
        errBox.innerHTML = "";
        const tag = document.getElementById("build-tag").value.trim();
        const dockerfile = document.getElementById("build-df").value;
        const saveAs = document.getElementById("build-saveas").value.trim();
        if (!tag) {
          errBox.innerHTML = `<div class="error-box">Le tag de l\u2019image est requis.</div>`;
          return;
        }
        log.textContent = "Build en cours\u2026";
        try {
          const res = await bag.Api.buildImage({ Tag: tag, Dockerfile: dockerfile, SaveAs: saveAs || void 0 });
          log.textContent = bag.formatBuildLog(res.Log);
          if (!res.Success) {
            errBox.innerHTML = `<div class="error-box">${bag.esc(res.Error || "\xC9chec du build")}</div>`;
          } else {
            errBox.innerHTML = `<div class="info-box">Image <code>${bag.esc(tag)}</code> compil\xE9e avec succ\xE8s.</div>`;
          }
          log.scrollTop = log.scrollHeight;
        } catch (err) {
          const raw = err.data?.Log || err.message;
          log.textContent = bag.formatBuildLog(raw);
          errBox.innerHTML = `<div class="error-box">${bag.esc(err.data?.Error || err.message)}</div>`;
        }
      }, { disableSiblings: false, minMs: 400 });
    };
    bag.openPullImageModal = async function openPullImageModal() {
      bag.closeAppModal();
      const host = bag.modalHost();
      host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-form modal-form-wide" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3>Pull une image</h3>
              <div class="modal-sub">Recherche locale puis Docker Hub</div>
            </div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">\u2715</button>
          </div>
          <div id="create-err"></div>
          <div class="form-group">
            <label class="field-label">Image <span class="req">*</span></label>
            ${bag.imageSearchFieldsHtml("p")}
          </div>
          <div class="actions-bar">
            <button type="button" class="btn btn-primary" id="i-save">Pull</button>
            <button type="button" class="btn" data-close-modal>Annuler</button>
          </div>
        </div>
      </div>`;
      bag.bindAppModalChrome();
      const imagePicker = bag.bindImageSearchPicker("p", host);
      imagePicker.focus();
      bag.onBusyClick(document.getElementById("i-save"), async () => {
        const errBox = document.getElementById("create-err");
        errBox.innerHTML = "";
        const { image } = imagePicker.getSelected();
        if (!image) {
          errBox.innerHTML = `<div class="error-box">S\xE9lectionnez une image dans les r\xE9sultats de recherche.</div>`;
          imagePicker.focus();
          return;
        }
        const { fromImage, tag } = bag.parseImageRef(image);
        try {
          await bag.Api.docker(`/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag.replace(/^@/, ""))}`, { method: "POST" });
          bag.closeAppModal();
          if (location.hash === "#images/pull") location.hash = "#images";
          else await bag.route();
        } catch (err) {
          errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
        }
      }, { disableSiblings: false, minMs: 300 });
    };
    bag.viewImages = async function viewImages() {
      const all = bag.isAllNodes();
      let list = [];
      let containers = [];
      let partial = false;
      let scanByRef = /* @__PURE__ */ new Map();
      const cveOn = bag.trivyOn();
      if (all) {
        const [aggImg, aggCtr] = await Promise.all([
          bag.dockerAll("/images/json"),
          bag.dockerAll("/containers/json?all=true")
        ]);
        list = aggImg.items;
        containers = aggCtr.items;
        partial = aggImg.failed > 0 || aggCtr.failed > 0;
      } else {
        const tasks = [
          bag.Api.docker("/images/json"),
          bag.Api.docker("/containers/json?all=true")
        ];
        if (cveOn) tasks.push(bag.Api.imageScans(bag.Api.getEndpointId()).catch(() => ({ Items: [] })));
        const [imgs, ctrs, scans] = await Promise.all(tasks);
        list = imgs || [];
        containers = ctrs || [];
        if (cveOn) {
          (scans?.Items || []).forEach((s) => {
            if (s.ImageRef) scanByRef.set(s.ImageRef, s);
            if (s.Digest) scanByRef.set(s.Digest, s);
          });
        }
      }
      const usageByKey = /* @__PURE__ */ new Map();
      list.forEach((img, idx) => {
        const users = bag.containersUsingImage(img, containers);
        const key = `${img._nodeId || 0}:${img.Id || idx}`;
        usageByKey.set(key, { img, users, key });
        img._usageCount = users.length;
        img._tagsLabel = bag.imageTagsLabel(img);
        img._sortKey = key;
        const tags = (img.RepoTags || []).filter((t) => t && t !== "<none>:<none>");
        img._primaryTag = tags[0] || "";
        const dig = (img.RepoDigests || [])[0] || "";
        const digestOnly = dig.includes("@") ? dig.split("@")[1] : "";
        img._scan = scanByRef.get(img._primaryTag) || scanByRef.get(digestOnly) || null;
      });
      list = bag.sortItems(list, "images", {
        name: (img) => img._tagsLabel || "",
        id: (img) => img.Id || "",
        size: (img) => Number(img.Size) || 0,
        usage: (img) => Number(img._usageCount) || 0,
        node: (img) => img._nodeName || "",
        created: (img) => bag.createdSortKey(img.Created)
      });
      const rows = list.map((img) => {
        const tags = img._tagsLabel || bag.imageTagsLabel(img);
        const sizeMb = ((img.Size || 0) / (1024 * 1024)).toFixed(1);
        const entry = usageByKey.get(img._sortKey) || { users: [] };
        const users = entry.users || [];
        const key = img._sortKey;
        const usageCell = users.length ? `<button type="button" class="badge badge-inuse img-usage-btn" data-img-key="${bag.esc(key)}" title="Voir les conteneurs">${users.length}&nbsp;conteneur${users.length > 1 ? "s" : ""}</button>` : `<span class="badge badge-unused">Inutilis\xE9</span>`;
        const cveCell = !cveOn || all ? "" : bag.cveStatusTd(img._primaryTag, img._scan);
        const search = `${bag.shortId(img.Id)} ${tags} ${img._nodeName || ""} ${users.length ? "utilise used" : "inutilise unused"}`.toLowerCase();
        return `<tr data-search="${bag.esc(search)}" data-resource-id="${bag.esc(img.Id)}" data-resource-name="${bag.esc(tags)}">
        ${all ? "" : bag.bulkSelectTd(img.Id)}
        ${all ? `<td class="muted">${bag.esc(img._nodeName || "\u2014")}</td>` : ""}
        <td class="mono">${bag.esc(bag.shortId(img.Id))}</td>
        <td>${bag.esc(tags)}</td>
        <td>${usageCell}</td>
        ${cveCell}
        <td>${bag.esc(sizeMb)} MB</td>
        <td>${bag.formatCreated(img.Created)}</td>
        <td class="actions">${all ? '<span class="muted">\u2014</span>' : `<div class="quick-actions">
          ${bag.iconBtn({ id: img.Id, title: "Supprimer", icon: "remove", danger: true })}
        </div>`}</td>
      </tr>`;
      }).join("");
      const colSpan = (all ? 7 : 8) + (cveOn && !all ? 1 : 0);
      bag.root.innerHTML = bag.shell("Images", `
      ${bag.pageHeader(all ? "Images \u2014 tous les n\u0153uds" : "Images")}
      ${partial ? '<div class="info-box" style="margin-bottom:12px">Agr\xE9gat partiel : certains n\u0153uds n\u2019ont pas r\xE9pondu.</div>' : ""}
      ${all ? bag.pickNodeGuardHtml() : ""}
      ${bag.searchBar(
        "images",
        "Rechercher des images\u2026",
        list.length,
        list.length,
        all ? "" : `${bag.createBtn("build-image", "Dockerfile / Build")}${bag.createBtn("pull-image", "Pull une image")}${bag.bulkDeleteBtnHtml()}`
      )}
      <div class="table-wrap"><table class="data">
        <thead><tr>
          ${bag.bulkSelectTh(!all)}
          ${all ? bag.sortTh("N\u0153ud", "node", "images") : ""}
          ${bag.sortTh("ID", "id", "images")}
          ${bag.sortTh("Tags", "name", "images")}
          ${bag.sortTh("Usage", "usage", "images")}
          ${cveOn && !all ? "<th>CVE</th>" : ""}
          ${bag.sortTh("Taille", "size", "images")}
          ${bag.sortTh("Cr\xE9\xE9", "created", "images")}
          <th></th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="${colSpan}" class="empty">Aucune image</td></tr>`}</tbody>
      </table></div>
      <div id="scan-modal"></div>`, { subtitle: all ? "Vue agr\xE9g\xE9e (lecture)" : "Images Docker locales" });
      bag.bindRefresh();
      bag.bindPagedSearch("images");
      bag.bindTableSort("images", () => bag.viewImages());
      bag.root.querySelectorAll(".img-usage-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const entry = usageByKey.get(btn.dataset.imgKey);
          if (entry) bag.openImageUsersModal(entry.img, entry.users);
        });
      });
      if (!all) {
        document.getElementById("build-image").onclick = () => {
          location.hash = "#images/build";
        };
        document.getElementById("pull-image").onclick = () => bag.openPullImageModal();
        bag.bindCveDetailButtons(bag.root);
        if (cveOn) {
          const refs = [...new Set(list.map((img) => img._primaryTag).filter(Boolean))];
          if (refs.length) {
            bag.ensureImagesCveColumn(bag.root, refs).catch(() => {
            });
          }
        }
        const labelById = new Map(
          list.map((img) => [img.Id, img._tagsLabel && img._tagsLabel !== "<none>" ? img._tagsLabel : bag.shortId(img.Id)])
        );
        const deleteRefById = new Map(
          list.map((img) => {
            const tag = (img._primaryTag || "").trim();
            return [img.Id, tag || img.Id];
          })
        );
        const deleteImage = async (id) => {
          const ref = deleteRefById.get(id) || id;
          try {
            await bag.Api.docker(`/images/${encodeURIComponent(ref)}?force=true`, { method: "DELETE" });
          } catch (err) {
            const label = labelById.get(id) || bag.shortId(id) || id;
            let msg = String(err?.message || err || "\xE9chec");
            msg = msg.replace(/sha256:[a-f0-9]{12,}/gi, label);
            const wrapped = new Error(msg);
            wrapped.status = err?.status;
            wrapped.data = err?.data;
            throw wrapped;
          }
        };
        bag.root.querySelectorAll(".quick-actions button[data-id]").forEach((btn) => {
          const entry = [...usageByKey.values()].find((e) => e.img.Id === btn.dataset.id);
          const used = !!(entry && entry.users.length);
          const label = labelById.get(btn.dataset.id) || bag.shortId(btn.dataset.id);
          bag.onBusyClick(btn, async (el) => {
            await deleteImage(el.dataset.id);
          }, {
            confirm: used ? `L\u2019image \xAB ${label} \xBB est utilis\xE9e par des conteneurs. Forcer la suppression ?` : `Supprimer l\u2019image \xAB ${label} \xBB ?`,
            reload: true
          });
        });
        bag.bindBulkDelete({
          enabled: true,
          confirmOne: (id) => `Supprimer l\u2019image \xAB ${labelById.get(id) || bag.shortId(id)} \xBB ?`,
          confirmMany: (n) => `Supprimer ${n} images (force) ? Les \xE9checs seront ignor\xE9s pour continuer.`,
          labelOne: (id) => labelById.get(id) || bag.shortId(id),
          retryFailed: true,
          deleteOne: (id) => deleteImage(id),
          reload: () => bag.viewImages()
        });
      }
      bag.restoreListFocus();
    };
    bag.imageTagsLabel = function imageTagsLabel(img) {
      const tags = (img?.RepoTags || []).filter((t) => t && t !== "<none>:<none>");
      return tags.length ? tags.join(", ") : "<none>";
    };
    bag.imageMatchesContainer = function imageMatchesContainer(img, container) {
      const imgId = bag.normalizeImageRef(img?.Id);
      const cImgId = bag.normalizeImageRef(container?.ImageID);
      if (imgId && cImgId && (imgId === cImgId || imgId.startsWith(cImgId) || cImgId.startsWith(imgId))) {
        return true;
      }
      const refs = [...img?.RepoTags || [], ...img?.RepoDigests || []].filter((t) => t && t !== "<none>:<none>");
      const cref = String(container?.Image || "");
      if (cref && refs.includes(cref)) return true;
      const short = bag.normalizeImageRef(cref);
      if (imgId && short && /^[a-f0-9]{12,}$/.test(short) && imgId.startsWith(short)) return true;
      return false;
    };
    bag.containersUsingImage = function containersUsingImage(img, containers) {
      return (containers || []).filter((c) => {
        if (img?._nodeId != null && c?._nodeId != null && Number(img._nodeId) !== Number(c._nodeId)) {
          return false;
        }
        return bag.imageMatchesContainer(img, c);
      });
    };
    bag.normalizeImageRef = function normalizeImageRef(id) {
      return String(id || "").replace(/^sha256:/i, "").toLowerCase();
    };
    bag.openImageUsersModal = function openImageUsersModal(img, users) {
      bag.openResourceUsersModal({
        title: "Conteneurs utilisant cette image",
        subtitle: `${bag.imageTagsLabel(img)} \xB7 ${bag.shortId(img.Id)}`,
        users,
        extraCol: (c) => c.Image || ""
      });
    };
  }

  // public/assets/js/src/views/volumes.js
  function install8() {
    bag.openCreateVolumeModal = async function openCreateVolumeModal() {
      bag.closeAppModal();
      const isAdmin = Number(bag.state.user?.Role) === 1;
      const host = bag.modalHost();
      host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-form" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div><h3>Cr\xE9er un volume</h3></div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">\u2715</button>
          </div>
          <div id="create-err"></div>
          ${isAdmin ? `
          <div class="form-group">
            <label class="field-label">Type</label>
            <select id="v-type">
              <option value="volume" selected>Volume Docker</option>
              <option value="bind">Bind (chemin h\xF4te)</option>
            </select>
          </div>` : ""}
          <div class="form-group">
            <label class="field-label">Nom <span class="req">*</span></label>
            <input id="v-name" placeholder="mon-volume" autocomplete="off">
          </div>
          <div class="form-group" id="v-driver-wrap">
            <label class="field-label">Pilote</label>
            <input id="v-driver" value="local" autocomplete="off">
          </div>
          <div class="form-group" id="v-bind-wrap" hidden>
            <label class="field-label">Chemin h\xF4te <span class="req">*</span></label>
            <input id="v-host" class="mono" placeholder="/data/mon-app" autocomplete="off">
            <p class="field-hint muted">Chemin absolu sur le n\u0153ud Docker. Le dossier n\u2019est pas cr\xE9\xE9 automatiquement.</p>
          </div>
          <div class="actions-bar">
            <button type="button" class="btn btn-primary" id="v-save">Cr\xE9er</button>
            <button type="button" class="btn" data-close-modal>Annuler</button>
          </div>
        </div>
      </div>`;
      bag.bindAppModalChrome();
      const typeEl = document.getElementById("v-type");
      const syncType = () => {
        const isBind = typeEl?.value === "bind";
        const driverWrap = document.getElementById("v-driver-wrap");
        const bindWrap = document.getElementById("v-bind-wrap");
        if (driverWrap) driverWrap.hidden = !!isBind;
        if (bindWrap) bindWrap.hidden = !isBind;
      };
      typeEl?.addEventListener("change", syncType);
      syncType();
      document.getElementById("v-name")?.focus();
      bag.onBusyClick(document.getElementById("v-save"), async () => {
        const errBox = document.getElementById("create-err");
        errBox.innerHTML = "";
        const Name = document.getElementById("v-name").value.trim();
        const isBind = typeEl?.value === "bind";
        if (!Name) {
          errBox.innerHTML = `<div class="error-box">Le nom est requis.</div>`;
          return;
        }
        try {
          if (isBind) {
            const HostPath = document.getElementById("v-host").value.trim();
            if (!HostPath || !HostPath.startsWith("/")) {
              errBox.innerHTML = `<div class="error-box">Chemin h\xF4te absolu requis (ex. /data/app).</div>`;
              return;
            }
            await bag.Api.createBindVolume(Name, HostPath);
          } else {
            const Driver = document.getElementById("v-driver").value.trim() || "local";
            await bag.Api.docker("/volumes/create", { method: "POST", body: JSON.stringify({ Name, Driver }) });
          }
          bag.closeAppModal();
          await bag.route();
        } catch (err) {
          errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
        }
      }, { disableSiblings: false, minMs: 250 });
    };
    bag.bindsFromContainers = function bindsFromContainers(containers) {
      const out = [];
      const seenPath = /* @__PURE__ */ new Set();
      (containers || []).forEach((c) => {
        const project = String(c?.Labels?.["com.docker.compose.project"] || "").trim();
        const mounts = Array.isArray(c?.Mounts) ? c.Mounts : [];
        mounts.forEach((m) => {
          if (String(m?.Type || "").toLowerCase() !== "bind") return;
          let src = String(m?.Source || "").replace(/\\/g, "/").trim();
          if (!src.startsWith("/")) return;
          src = src.replace(/\/+$/, "") || "/";
          if (src.startsWith("/var/lib/docker/") || src.startsWith("/run/docker/")) return;
          const pathKey = `${c?._nodeId || 0}:${src.toLowerCase()}`;
          if (seenPath.has(pathKey)) return;
          seenPath.add(pathKey);
          const base = src.split("/").filter(Boolean).pop() || "bind";
          const prefix = project || "runtime";
          const name = `${prefix}-${base}`.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "bind";
          out.push({
            Name: name,
            Driver: "bind",
            HostPath: src,
            Mountpoint: src,
            Source: "runtime",
            StackName: project,
            CreatedAt: 0,
            _bind: true,
            _nodeId: c?._nodeId,
            _nodeName: c?._nodeName
          });
        });
      });
      return out;
    };
    bag.mergeVolumeLists = function mergeVolumeLists(namedVolumes, bindList) {
      const volumes = [...namedVolumes || []];
      const named = new Set(volumes.map((v) => String(v.Name || "").toLowerCase()));
      const paths = new Set(
        volumes.filter((v) => v._bind || String(v.Driver || "").toLowerCase() === "bind").map((v) => String(v.HostPath || v.Mountpoint || "").toLowerCase()).filter(Boolean)
      );
      (bindList || []).forEach((b) => {
        const key = String(b.Name || "").toLowerCase();
        const path = String(b.HostPath || b.Mountpoint || "").toLowerCase();
        if (path && paths.has(path)) return;
        if (key && named.has(key) && !path) return;
        if (key && named.has(key) && path) {
          if (paths.has(path)) return;
        }
        volumes.push(b);
        if (key) named.add(key);
        if (path) paths.add(path);
      });
      return volumes;
    };
    bag.bindDriverLabel = function bindDriverLabel(v) {
      const src = String(v?.Source || "").toLowerCase();
      if (src === "stack") return "bind \xB7 stack";
      if (src === "runtime") return "bind \xB7 conteneur";
      if (src === "manual") return "bind \xB7 d\xE9clar\xE9";
      return "bind";
    };
    bag.viewVolumes = async function viewVolumes() {
      const all = bag.isAllNodes();
      const isAdmin = Number(bag.state.user?.Role) === 1;
      let volumes = [];
      let containers = [];
      let partial = false;
      if (all) {
        const [aggVol, aggCtr] = await Promise.all([
          bag.dockerAll("/volumes", { pick: (d) => d?.Volumes || [] }),
          bag.dockerAll("/containers/json?all=true")
        ]);
        volumes = bag.mergeVolumeLists(aggVol.items, bag.bindsFromContainers(aggCtr.items));
        containers = aggCtr.items;
        partial = aggVol.failed > 0 || aggCtr.failed > 0;
      } else {
        const [data, ctrs, binds] = await Promise.all([
          bag.Api.docker("/volumes"),
          bag.Api.docker("/containers/json?all=true"),
          bag.Api.bindVolumes().catch(() => ({ Volumes: [] }))
        ]);
        containers = ctrs || [];
        const bindList = [
          ...binds?.Volumes || [],
          ...bag.bindsFromContainers(containers)
        ];
        volumes = bag.mergeVolumeLists(data.Volumes || [], bindList);
      }
      const usageByKey = /* @__PURE__ */ new Map();
      volumes.forEach((v, idx) => {
        const users = bag.containersUsingVolume(v, containers);
        const key = `${v._nodeId || 0}:${v.Name || idx}`;
        usageByKey.set(key, { vol: v, users });
        v._usageCount = users.length;
        v._sortKey = key;
      });
      volumes = bag.sortItems(volumes, "volumes", {
        name: (v) => v.Name || "",
        driver: (v) => v.Driver || "",
        usage: (v) => Number(v._usageCount) || 0,
        mount: (v) => v.Mountpoint || v.HostPath || "",
        node: (v) => v._nodeName || "",
        created: (v) => bag.createdSortKey(v.CreatedAt || v.created_at || v.Created)
      });
      const rows = volumes.map((v) => {
        const users = (usageByKey.get(v._sortKey) || {}).users || [];
        const key = v._sortKey;
        const isBind = !!(v._bind || String(v.Driver || "").toLowerCase() === "bind");
        const mount = v.HostPath || v.Mountpoint || "";
        const usageCell = users.length ? `<button type="button" class="badge badge-inuse img-usage-btn" data-vol-key="${bag.esc(key)}" title="Voir les conteneurs">${users.length}&nbsp;conteneur${users.length > 1 ? "s" : ""}</button>` : `<span class="badge badge-unused">Inutilis\xE9</span>`;
        const driverLabel = isBind ? bag.bindDriverLabel(v) : v.Driver || "";
        const search = `${v.Name} ${driverLabel} ${mount} ${v.StackName || ""} ${v._nodeName || ""} ${users.length ? "utilise used" : "inutilise unused"} bind`.toLowerCase();
        const canDelete = !all && (!isBind || isAdmin && v.Source !== "runtime");
        const actions = all ? '<span class="muted">\u2014</span>' : `<div class="quick-actions">
        ${bag.iconBtn({ tag: "a", href: `#volumes/${encodeURIComponent(v.Name)}`, title: "Explorer", icon: "search" })}
        ${!isBind ? bag.shareBtn("volume", v.Name) : ""}
        ${canDelete ? bag.iconBtn({
          name: v.Name,
          title: isBind ? "Retirer la d\xE9claration bind" : "Supprimer",
          icon: "remove",
          danger: true,
          del: isBind ? String(v.Id || "") : ""
        }) : ""}
      </div>`;
        return `<tr data-search="${bag.esc(search)}" data-resource-id="${bag.esc(v.Name)}" data-resource-name="${bag.esc(v.Name)}" data-bind="${isBind ? "1" : "0"}" data-bind-id="${bag.esc(isBind ? v.Id || "" : "")}">
      ${all ? "" : bag.bulkSelectTd(v.Name, { disabled: isBind, title: isBind ? "Les binds se retirent unitairement" : "" })}
      ${all ? `<td class="muted">${bag.esc(v._nodeName || "\u2014")}</td>` : ""}
      <td class="name-cell">
        <strong>${all ? bag.esc(v.Name) : `<a href="#volumes/${encodeURIComponent(v.Name)}">${bag.esc(v.Name)}</a>`}</strong>
        ${isBind ? `<span class="id">${v.StackName ? bag.esc(v.StackName) : v.Source === "runtime" ? "conteneur" : "bind"}</span>` : ""}
      </td>
      <td>${bag.esc(driverLabel)}</td>
      <td>${usageCell}</td>
      <td class="mono cell-clip" title="${bag.esc(mount)}">${bag.esc(mount)}</td>
      <td>${bag.formatCreated(v.CreatedAt || v.created_at || v.Created)}</td>
      <td class="actions">${actions}</td>
    </tr>`;
      }).join("");
      const colSpan = all ? 7 : 8;
      bag.root.innerHTML = bag.shell("Volumes", `
      ${bag.pageHeader(all ? "Volumes \u2014 tous les n\u0153uds" : "Volumes")}
      ${partial ? '<div class="info-box" style="margin-bottom:12px">Agr\xE9gat partiel : certains n\u0153uds n\u2019ont pas r\xE9pondu.</div>' : ""}
      ${all ? bag.pickNodeGuardHtml() : ""}
      <div class="toolbar">
        <input class="search" id="filter" type="search" placeholder="Rechercher des volumes\u2026" value="${bag.esc(bag.state.filters.volumes || "")}">
        ${all ? "" : `${bag.createBtn("create", isAdmin ? "Cr\xE9er / d\xE9clarer" : "Cr\xE9er un volume")}${bag.bulkDeleteBtnHtml()}`}
        <div class="spacer"></div>
        ${all ? "" : '<span class="muted" style="font-size:12px">bind = chemin h\xF4te \xB7 sync stacks + conteneurs</span>'}
        <span class="muted mono" id="filter-count">${volumes.length} / ${volumes.length}</span>
      </div>
      <div class="table-wrap"><table class="data">
        <thead><tr>
          ${bag.bulkSelectTh(!all)}
          ${all ? bag.sortTh("N\u0153ud", "node", "volumes") : ""}
          ${bag.sortTh("Nom", "name", "volumes")}
          ${bag.sortTh("Pilote", "driver", "volumes")}
          ${bag.sortTh("Usage", "usage", "volumes")}
          ${bag.sortTh("Point de montage", "mount", "volumes")}
          ${bag.sortTh("Cr\xE9\xE9", "created", "volumes")}
          <th></th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="${colSpan}" class="empty">Aucun volume</td></tr>`}</tbody>
      </table></div>`, { subtitle: all ? "Vue agr\xE9g\xE9e (lecture)" : "Volumes Docker et binds" });
      bag.bindRefresh();
      bag.bindShareButtons();
      bag.bindPagedSearch("volumes");
      bag.bindTableSort("volumes", () => bag.viewVolumes());
      bag.root.querySelectorAll("[data-vol-key]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const entry = usageByKey.get(btn.dataset.volKey);
          if (entry) bag.openVolumeUsersModal(entry.vol, entry.users);
        });
      });
      if (!all) {
        document.getElementById("create").onclick = () => bag.openCreateVolumeModal();
        bag.bindBulkDelete({
          enabled: true,
          confirmOne: () => "Supprimer ce volume ?",
          confirmMany: (n) => `Supprimer ${n} volumes ?`,
          deleteOne: (name) => bag.Api.docker(`/volumes/${encodeURIComponent(name)}`, { method: "DELETE" }),
          reload: () => bag.viewVolumes()
        });
        bag.root.querySelectorAll(".quick-actions button[data-name]").forEach((btn) => {
          const entry = [...usageByKey.values()].find((e) => e.vol.Name === btn.dataset.name);
          const used = !!(entry && entry.users.length);
          const isBind = !!(entry?.vol?._bind || String(entry?.vol?.Driver || "").toLowerCase() === "bind");
          bag.onBusyClick(btn, async (el) => {
            if (isBind) {
              const bindId = el.dataset.del || entry?.vol?.Id;
              if (!bindId) throw new Error("Bind introuvable");
              await bag.Api.deleteBindVolume(bindId);
              return;
            }
            await bag.Api.docker(`/volumes/${encodeURIComponent(el.dataset.name)}`, { method: "DELETE" });
          }, {
            confirm: isBind ? "Retirer cette d\xE9claration bind de la liste ? (le dossier h\xF4te n\u2019est pas supprim\xE9)" : used ? "Ce volume est utilis\xE9 par des conteneurs. Supprimer quand m\xEAme ?" : "Supprimer ce volume ?",
            reload: true
          });
        });
      }
      bag.restoreListFocus();
    };
    bag.volumeBreadcrumbs = function volumeBreadcrumbs(volumeName, path) {
      const parts = String(path || "/").split("/").filter(Boolean);
      let acc = "";
      const crumbs = [`<a href="#volumes/${encodeURIComponent(volumeName)}" data-path="/">/</a>`];
      parts.forEach((p) => {
        acc += "/" + p;
        crumbs.push(`<a href="#volumes/${encodeURIComponent(volumeName)}?path=${encodeURIComponent(acc)}" data-path="${bag.esc(acc)}">${bag.esc(p)}</a>`);
      });
      return `<nav class="vol-crumbs">${crumbs.join('<span class="muted"> / </span>')}</nav>`;
    };
    bag.openVolumeFilePreview = async function openVolumeFilePreview(volumeName, path) {
      bag.closeAppModal();
      const host = bag.modalHost();
      host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-form modal-form-wide" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3 class="mono">${bag.esc(path)}</h3>
              <div class="modal-sub">Aper\xE7u du fichier</div>
            </div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">\u2715</button>
          </div>
          <div id="vol-file-body"><div class="muted">Chargement\u2026</div></div>
          <div class="actions-bar">
            <a class="btn btn-primary" id="vol-dl" href="#">T\xE9l\xE9charger</a>
            <button type="button" class="btn" data-close-modal>Fermer</button>
          </div>
        </div>
      </div>`;
      bag.bindAppModalChrome();
      const body = document.getElementById("vol-file-body");
      const dl = document.getElementById("vol-dl");
      try {
        const file = await bag.Api.volumeFile(volumeName, path);
        const token = bag.Api.getToken();
        dl.href = bag.Api.volumeDownloadUrl(volumeName, path);
        dl.onclick = async (e) => {
          e.preventDefault();
          try {
            const res = await fetch(bag.Api.volumeDownloadUrl(volumeName, path), {
              headers: token ? { Authorization: "Bearer " + token } : {}
            });
            if (!res.ok) {
              const t = await res.text();
              throw new Error(t || res.statusText);
            }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = file.Name || "file";
            a.click();
            URL.revokeObjectURL(url);
          } catch (err) {
            alert(err.message);
          }
        };
        if (file.Binary) {
          body.innerHTML = `<div class="info-box">Fichier binaire (${bag.esc(bag.formatBytes(file.Size))})${file.Truncated ? " \u2014 aper\xE7u tronqu\xE9" : ""}. Utilisez T\xE9l\xE9charger.</div>`;
        } else {
          body.innerHTML = `
          <div class="muted" style="margin-bottom:8px;font-size:12px">${bag.esc(bag.formatBytes(file.Size))}${file.Truncated ? " \u2014 aper\xE7u tronqu\xE9 \xE0 512 Ko" : ""}</div>
          <pre class="logs vol-file-preview">${bag.esc(file.Content || "")}</pre>`;
        }
      } catch (err) {
        body.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
        dl.hidden = true;
      }
    };
    bag.viewVolumeBrowse = async function viewVolumeBrowse(volumeName) {
      const params = new URLSearchParams(location.hash.split("?")[1] || "");
      let currentPath = params.get("path") || "/";
      if (!currentPath.startsWith("/")) currentPath = "/" + currentPath;
      function joinVolPath(dir, name) {
        const base = dir === "/" ? "" : dir.replace(/\/$/, "");
        return `${base}/${name}`.replace(/\/+/g, "/");
      }
      function goPath(p) {
        location.hash = `#volumes/${encodeURIComponent(volumeName)}${p === "/" ? "" : `?path=${encodeURIComponent(p)}`}`;
      }
      async function downloadEntry(path, name) {
        const token = bag.Api.getToken();
        const res = await fetch(bag.Api.volumeDownloadUrl(volumeName, path), {
          headers: token ? { Authorization: "Bearer " + token } : {}
        });
        if (!res.ok) {
          const t = await res.text();
          throw new Error(t || res.statusText);
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = name || "file";
        a.click();
        URL.revokeObjectURL(url);
      }
      async function runVolAction(action, entry) {
        bag.hideVolContextMenu();
        try {
          if (action === "open") {
            if (!entry) return;
            if (entry.type === "dir") goPath(entry.path);
            else await bag.openVolumeFilePreview(volumeName, entry.path);
            return;
          }
          if (action === "refresh") {
            await render(currentPath);
            return;
          }
          if (action === "new-file") {
            const name = await bag.promptName({
              title: "Nouveau fichier",
              label: "Nom du fichier",
              placeholder: "exemple.txt",
              confirmLabel: "Cr\xE9er"
            });
            if (!name) return;
            if (/[\\/]/.test(name)) {
              alert("Le nom ne doit pas contenir de chemin.");
              return;
            }
            await bag.Api.volumeWriteFile(volumeName, joinVolPath(currentPath, name), { Content: "", CreateOnly: true });
            await render(currentPath);
            return;
          }
          if (action === "new-dir") {
            const name = await bag.promptName({
              title: "Nouveau dossier",
              label: "Nom du dossier",
              placeholder: "mon-dossier",
              confirmLabel: "Cr\xE9er"
            });
            if (!name) return;
            if (/[\\/]/.test(name)) {
              alert("Le nom ne doit pas contenir de chemin.");
              return;
            }
            await bag.Api.volumeMkdir(volumeName, joinVolPath(currentPath, name));
            await render(currentPath);
            return;
          }
          if (action === "rename" && entry) {
            const name = await bag.promptName({
              title: "Renommer",
              label: "Nouveau nom",
              value: entry.name,
              confirmLabel: "Renommer"
            });
            if (!name || name === entry.name) return;
            if (/[\\/]/.test(name)) {
              alert("Le nom ne doit pas contenir de chemin.");
              return;
            }
            const parent = entry.path.replace(/\/[^/]+\/?$/, "") || "/";
            const to = joinVolPath(parent === "" ? "/" : parent, name);
            await bag.Api.volumeRename(volumeName, entry.path, to);
            await render(currentPath);
            return;
          }
          if (action === "download" && entry && entry.type !== "dir") {
            await downloadEntry(entry.path, entry.name);
            return;
          }
          if (action === "delete" && entry) {
            const label = entry.type === "dir" ? `le dossier \xAB ${entry.name} \xBB et son contenu` : `\xAB ${entry.name} \xBB`;
            if (!confirm(`Supprimer ${label} ?`)) return;
            await bag.Api.volumeDeleteEntry(volumeName, entry.path);
            await render(currentPath);
          }
        } catch (err) {
          alert(err.message || String(err));
        }
      }
      function openCtx(ev, entry) {
        ev.preventDefault();
        ev.stopPropagation();
        const items = [];
        if (entry) {
          items.push({ id: "open", label: entry.type === "dir" ? "Ouvrir" : "Aper\xE7u" });
          items.push({ id: "rename", label: "Renommer\u2026" });
          if (entry.type !== "dir") items.push({ id: "download", label: "T\xE9l\xE9charger" });
          items.push("\u2014");
          items.push({ id: "delete", label: "Supprimer", danger: true });
          items.push("\u2014");
        }
        items.push({ id: "new-file", label: "Nouveau fichier\u2026" });
        items.push({ id: "new-dir", label: "Nouveau dossier\u2026" });
        items.push({ id: "refresh", label: "Actualiser" });
        const menu = bag.showVolContextMenu(ev.clientX, ev.clientY, items);
        menu.querySelectorAll("[data-act]").forEach((btn) => {
          btn.addEventListener("click", () => runVolAction(btn.getAttribute("data-act"), entry));
        });
      }
      function fileToBase64(file) {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const bytes = new Uint8Array(reader.result || new ArrayBuffer(0));
            let binary = "";
            const chunk = 32768;
            for (let i = 0; i < bytes.length; i += chunk) {
              binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
            }
            resolve(btoa(binary));
          };
          reader.onerror = () => reject(new Error("Lecture fichier impossible"));
          reader.readAsArrayBuffer(file);
        });
      }
      function readAllDirectoryEntries(reader) {
        return new Promise((resolve, reject) => {
          const all = [];
          const readBatch = () => {
            reader.readEntries((batch) => {
              if (!batch.length) {
                resolve(all);
                return;
              }
              all.push(...batch);
              readBatch();
            }, reject);
          };
          readBatch();
        });
      }
      function snapshotDataTransfer(dataTransfer) {
        const rootEntries = [];
        const flatFiles = [];
        const items = dataTransfer && dataTransfer.items ? Array.from(dataTransfer.items) : [];
        for (let i = 0; i < items.length; i += 1) {
          const item = items[i];
          if (!item || item.kind !== "file") continue;
          let entry = null;
          try {
            if (typeof item.webkitGetAsEntry === "function") entry = item.webkitGetAsEntry();
          } catch (_) {
          }
          if (entry) {
            rootEntries.push(entry);
            continue;
          }
          try {
            const f = typeof item.getAsFile === "function" ? item.getAsFile() : null;
            if (f) flatFiles.push(f);
          } catch (_) {
          }
        }
        if (!rootEntries.length && !flatFiles.length) {
          Array.from(dataTransfer && dataTransfer.files || []).forEach((f) => flatFiles.push(f));
        }
        return { rootEntries, flatFiles };
      }
      async function collectDropEntries(snapshot, destDir) {
        const files = [];
        const dirs = /* @__PURE__ */ new Set();
        const rootEntries = snapshot && snapshot.rootEntries || [];
        const flatFiles = snapshot && snapshot.flatFiles || [];
        async function walkEntry(entry, parentRel) {
          if (!entry) return;
          const rel = parentRel ? `${parentRel}/${entry.name}` : entry.name;
          if (entry.isFile) {
            const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
            files.push({ relPath: rel, file });
            return;
          }
          if (entry.isDirectory) {
            dirs.add(rel);
            const reader = entry.createReader();
            const children = await readAllDirectoryEntries(reader);
            for (const child of children) {
              await walkEntry(child, rel);
            }
          }
        }
        if (rootEntries.length) {
          for (const entry of rootEntries) {
            await walkEntry(entry, "");
          }
        } else {
          flatFiles.forEach((file) => {
            const rel = file.webkitRelativePath || file.name;
            files.push({ relPath: rel, file });
          });
        }
        files.forEach(({ relPath }) => {
          const parts = String(relPath).split("/");
          let acc = "";
          for (let i = 0; i < parts.length - 1; i += 1) {
            acc = acc ? `${acc}/${parts[i]}` : parts[i];
            dirs.add(acc);
          }
        });
        const sortedDirs = Array.from(dirs).sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
        return { destDir, dirs: sortedDirs, files };
      }
      let volUploadBusy = false;
      function openVolumeUploadModal() {
        bag.closeAppModal();
        const host = bag.modalHost();
        host.innerHTML = `
        <div class="modal-backdrop vol-up-backdrop" data-no-dismiss="1">
          <div class="modal modal-form vol-up-modal" role="dialog" aria-modal="true" aria-labelledby="vol-up-title">
            <div class="modal-head">
              <div>
                <h3 id="vol-up-title">Envoi vers le volume</h3>
                <p class="modal-sub" id="vol-up-sub">Pr\xE9paration\u2026</p>
              </div>
            </div>
            <div class="vol-up-body">
              <div class="progress vol-up-bar-wrap"><span id="vol-up-bar" style="width:0%"></span></div>
              <div class="vol-up-meta">
                <span id="vol-up-count">0 / 0</span>
                <span id="vol-up-pct">0 %</span>
              </div>
              <p class="muted mono vol-up-file" id="vol-up-file"></p>
              <div id="vol-up-err"></div>
            </div>
            <div class="actions-bar">
              <button type="button" class="btn btn-primary" id="vol-up-close" hidden>Fermer</button>
            </div>
          </div>
        </div>`;
        document.getElementById("vol-up-close")?.addEventListener("click", () => bag.closeAppModal());
        return {
          setProgress({ done, total, label, phase }) {
            const pct = total > 0 ? Math.min(100, Math.round(done / total * 100)) : 0;
            const bar = document.getElementById("vol-up-bar");
            const count = document.getElementById("vol-up-count");
            const pctEl = document.getElementById("vol-up-pct");
            const fileEl = document.getElementById("vol-up-file");
            const sub = document.getElementById("vol-up-sub");
            if (bar) bar.style.width = `${pct}%`;
            if (count) count.textContent = `${done} / ${total}`;
            if (pctEl) pctEl.textContent = `${pct} %`;
            if (fileEl) fileEl.textContent = label || "";
            if (sub) sub.textContent = phase || "Envoi en cours\u2026";
          },
          done(ok, message) {
            const sub = document.getElementById("vol-up-sub");
            const err = document.getElementById("vol-up-err");
            const closeBtn = document.getElementById("vol-up-close");
            const bar = document.getElementById("vol-up-bar");
            if (ok) {
              if (sub) sub.textContent = message || "Termin\xE9";
              if (bar) {
                bar.style.width = "100%";
                bar.classList.add("is-done");
              }
              if (closeBtn) closeBtn.hidden = false;
              setTimeout(() => bag.closeAppModal(), 900);
            } else {
              if (sub) sub.textContent = "\xC9chec de l\u2019envoi";
              if (err) err.innerHTML = `<div class="error-box">${bag.esc(message || "Erreur")}</div>`;
              if (closeBtn) closeBtn.hidden = false;
            }
          }
        };
      }
      async function uploadDropped(snapshotOrDt) {
        if (volUploadBusy) return;
        const snapshot = snapshotOrDt && Array.isArray(snapshotOrDt.rootEntries) ? snapshotOrDt : snapshotDataTransfer(snapshotOrDt);
        if (!snapshot.rootEntries.length && !snapshot.flatFiles.length) return;
        volUploadBusy = true;
        const errBox = document.getElementById("vol-err");
        if (errBox) errBox.innerHTML = "";
        const modal = openVolumeUploadModal();
        try {
          modal.setProgress({ done: 0, total: 1, label: "", phase: "Analyse des fichiers\u2026" });
          const payload = await collectDropEntries(snapshot, currentPath);
          if (!payload.files.length && !payload.dirs.length) {
            bag.closeAppModal();
            return;
          }
          const maxBytes = 300 * 1e3 * 1e3;
          for (const { file, relPath } of payload.files) {
            if (file.size > maxBytes) {
              throw new Error(`\xAB ${relPath} \xBB d\xE9passe 300 Mo (limite d\u2019upload)`);
            }
          }
          let done = 0;
          const total = payload.dirs.length + payload.files.length;
          modal.setProgress({
            done: 0,
            total,
            label: "",
            phase: `${payload.files.length} fichier(s) \xB7 ${payload.dirs.length} dossier(s)`
          });
          for (const dir of payload.dirs) {
            done += 1;
            modal.setProgress({
              done,
              total,
              label: dir,
              phase: "Cr\xE9ation des dossiers\u2026"
            });
            await bag.Api.volumeMkdir(volumeName, joinVolPath(currentPath, dir));
          }
          for (const { file, relPath } of payload.files) {
            done += 1;
            const typeHint = file.type ? ` (${file.type})` : "";
            const sizeHint = file.size >= 1e3 * 1e3 ? ` \xB7 ${(file.size / (1e3 * 1e3)).toFixed(1)} Mo` : "";
            modal.setProgress({
              done,
              total,
              label: `${relPath}${typeHint}${sizeHint}`,
              phase: "Envoi des fichiers\u2026"
            });
            await bag.Api.volumeUploadFile(
              volumeName,
              joinVolPath(currentPath, relPath),
              file,
              { CreateOnly: false }
            );
          }
          modal.setProgress({ done: total, total, label: "", phase: "Actualisation\u2026" });
          await render(currentPath);
          modal.done(true, `${payload.files.length} fichier(s), ${payload.dirs.length} dossier(s) envoy\xE9s`);
        } catch (err) {
          modal.done(false, err.message || String(err));
          const box = document.getElementById("vol-err");
          if (box) box.innerHTML = `<div class="error-box">${bag.esc(err.message || String(err))}</div>`;
        } finally {
          volUploadBusy = false;
        }
      }
      function hasFilesType(dt) {
        try {
          return Array.from(dt.types || []).includes("Files");
        } catch {
          return false;
        }
      }
      function bindVolumeDrop(explorer) {
        let dragDepth = 0;
        const onDragEnter = (ev) => {
          if (!hasFilesType(ev.dataTransfer)) return;
          ev.preventDefault();
          dragDepth += 1;
          explorer.classList.add("is-dragover");
        };
        const onDragOver = (ev) => {
          if (!hasFilesType(ev.dataTransfer)) return;
          ev.preventDefault();
          ev.dataTransfer.dropEffect = volUploadBusy ? "none" : "copy";
        };
        const onDragLeave = () => {
          dragDepth = Math.max(0, dragDepth - 1);
          if (dragDepth === 0) explorer.classList.remove("is-dragover");
        };
        const onDrop = (ev) => {
          if (!hasFilesType(ev.dataTransfer)) return;
          ev.preventDefault();
          ev.stopPropagation();
          dragDepth = 0;
          explorer.classList.remove("is-dragover");
          const snapshot = snapshotDataTransfer(ev.dataTransfer);
          void uploadDropped(snapshot);
        };
        explorer.addEventListener("dragenter", onDragEnter);
        explorer.addEventListener("dragover", onDragOver);
        explorer.addEventListener("dragleave", onDragLeave);
        explorer.addEventListener("drop", onDrop);
      }
      async function render(path) {
        bag.hideVolContextMenu();
        bag.root.innerHTML = bag.shell(`Volume \xB7 ${volumeName}`, `
        ${bag.pageHeader(volumeName, false)}
        <div class="toolbar">
          ${bag.iconBtn({ tag: "a", href: "#volumes", title: "Retour", icon: "back" })}
          <button type="button" class="btn btn-sm" id="vol-new-file">Nouveau fichier</button>
          <button type="button" class="btn btn-sm" id="vol-new-dir">Nouveau dossier</button>
          <div class="spacer"></div>
          <span class="muted">Glisser-d\xE9poser fichiers/dossiers \xB7 clic droit</span>
          <span class="muted mono">${bag.esc(volumeName)}</span>
        </div>
        <div id="vol-err"></div>
        ${bag.volumeBreadcrumbs(volumeName, path)}
        <div class="table-wrap vol-explorer" id="vol-explorer">
          <div class="vol-drop-hint">D\xE9posez un ou plusieurs fichiers / dossiers ici</div>
          <table class="data">
            <thead><tr><th>Nom</th><th>Taille</th><th>Modifi\xE9</th><th></th></tr></thead>
            <tbody id="vol-rows"><tr><td colspan="4" class="muted">Chargement\u2026</td></tr></tbody>
          </table>
        </div>`, { subtitle: "Explorateur de fichiers" });
        document.getElementById("vol-new-file").onclick = () => runVolAction("new-file");
        document.getElementById("vol-new-dir").onclick = () => runVolAction("new-dir");
        const explorer = document.getElementById("vol-explorer");
        const tbody = document.getElementById("vol-rows");
        const errBox = document.getElementById("vol-err");
        bindVolumeDrop(explorer);
        explorer.addEventListener("contextmenu", (ev) => {
          if (ev.target.closest(".vol-row[data-entry]")) return;
          openCtx(ev, null);
        });
        try {
          const data = await bag.Api.volumeBrowse(volumeName, path);
          currentPath = data.Path || path;
          bag.root.querySelectorAll(".vol-crumbs a").forEach((a) => {
            a.addEventListener("click", (e) => {
              e.preventDefault();
              goPath(a.getAttribute("data-path") || "/");
            });
          });
          const entries = data.Entries || [];
          const parentPath = currentPath === "/" ? null : currentPath.replace(/\/[^/]+\/?$/, "") || "/";
          let rows = "";
          if (parentPath != null) {
            rows += `<tr class="vol-row" data-dir="${bag.esc(parentPath)}">
            <td colspan="3"><a href="#" class="vol-link" data-dir="${bag.esc(parentPath)}">../</a></td>
            <td></td>
          </tr>`;
          }
          if (!entries.length) {
            rows += `<tr><td colspan="4" class="empty">Dossier vide \u2014 clic droit pour cr\xE9er</td></tr>`;
          } else {
            rows += entries.map((e) => {
              const isDir = e.Type === "dir";
              const icon = isDir ? "folder" : e.Type === "link" ? "link" : "file";
              const when = e.ModTime ? new Date(e.ModTime * 1e3).toLocaleString() : "\u2014";
              const size = isDir ? "\u2014" : bag.formatBytes(e.Size || 0);
              return `<tr class="vol-row" data-entry="1" data-type="${isDir ? "dir" : "file"}" data-path="${bag.esc(e.Path)}" data-name="${bag.esc(e.Name)}">
              <td>
                <a href="#" class="vol-link" data-${isDir ? "dir" : "file"}="${bag.esc(e.Path)}">
                  <span class="vol-ico">${bag.ico(icon)}</span>${bag.esc(e.Name)}${isDir ? "/" : ""}
                </a>
              </td>
              <td class="mono">${bag.esc(size)}</td>
              <td class="muted">${bag.esc(when)}</td>
              <td class="actions"><div class="quick-actions">
                ${isDir ? "" : `<button type="button" class="btn btn-icon btn-sm" title="Aper\xE7u" data-file="${bag.esc(e.Path)}"><span class="btn-ico">${bag.ico("logs")}</span></button>`}
              </div></td>
            </tr>`;
            }).join("");
          }
          tbody.innerHTML = rows;
          tbody.querySelectorAll(".vol-row[data-entry]").forEach((row) => {
            row.addEventListener("contextmenu", (ev) => {
              openCtx(ev, {
                path: row.getAttribute("data-path"),
                name: row.getAttribute("data-name"),
                type: row.getAttribute("data-type")
              });
            });
          });
          tbody.querySelectorAll("[data-dir]").forEach((el) => {
            el.addEventListener("click", (ev) => {
              ev.preventDefault();
              goPath(el.getAttribute("data-dir") || "/");
            });
          });
          tbody.querySelectorAll("[data-file]").forEach((el) => {
            el.addEventListener("click", (ev) => {
              ev.preventDefault();
              bag.openVolumeFilePreview(volumeName, el.getAttribute("data-file") || "");
            });
          });
        } catch (err) {
          tbody.innerHTML = `<tr><td colspan="4" class="empty">\u2014</td></tr>`;
          if (errBox) errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
        }
      }
      await render(currentPath);
    };
    bag.containersUsingVolume = function containersUsingVolume(vol, containers) {
      const volName = String(vol?.Name || "");
      const hostPath = String(vol?.HostPath || vol?.Mountpoint || "");
      const isBind = !!(vol?._bind || String(vol?.Driver || "").toLowerCase() === "bind");
      if (!volName && !hostPath) return [];
      return (containers || []).filter((c) => {
        if (vol?._nodeId != null && c?._nodeId != null && Number(vol._nodeId) !== Number(c._nodeId)) {
          return false;
        }
        const mounts = Array.isArray(c.Mounts) ? c.Mounts : [];
        return mounts.some((m) => {
          const type = String(m.Type || "").toLowerCase();
          if (isBind) {
            if (type && type !== "bind") return false;
            const src = String(m.Source || m.SourcePath || "");
            return hostPath !== "" && (src === hostPath || src.startsWith(hostPath + "/"));
          }
          if (type && type !== "volume") return false;
          return m.Name === volName;
        });
      });
    };
    bag.openVolumeUsersModal = function openVolumeUsersModal(vol, users) {
      const isBind = !!(vol?._bind || String(vol?.Driver || "").toLowerCase() === "bind");
      bag.openResourceUsersModal({
        title: isBind ? "Conteneurs utilisant ce bind" : "Conteneurs utilisant ce volume",
        subtitle: isBind ? `${vol?.Name || ""} \u2192 ${vol?.HostPath || vol?.Mountpoint || ""}` : vol?.Name || "",
        users,
        extraCol: (c) => {
          const mounts = (c.Mounts || []).filter((m) => {
            if (isBind) {
              const src = String(m.Source || "");
              const host = String(vol?.HostPath || vol?.Mountpoint || "");
              return src === host || src.startsWith(host + "/");
            }
            return m.Name === vol?.Name;
          });
          return mounts.map((m) => m.Destination || m.Target || "").filter(Boolean).join(", ") || c.Image || "";
        }
      });
    };
    bag.hideVolContextMenu = function hideVolContextMenu() {
      const el = document.getElementById("vol-ctx");
      if (el) el.remove();
    };
    bag.showVolContextMenu = function showVolContextMenu(x, y, items) {
      bag.hideVolContextMenu();
      const menu = document.createElement("div");
      menu.id = "vol-ctx";
      menu.className = "vol-ctx";
      menu.setAttribute("role", "menu");
      menu.innerHTML = items.map((it) => {
        if (it === "\u2014") return '<div class="vol-ctx-sep" role="separator"></div>';
        const danger = it.danger ? " is-danger" : "";
        const disabled = it.disabled ? " is-disabled" : "";
        return `<button type="button" class="vol-ctx-item${danger}${disabled}" role="menuitem" data-act="${bag.esc(it.id)}" ${it.disabled ? "disabled" : ""}>${bag.esc(it.label)}</button>`;
      }).join("");
      document.body.appendChild(menu);
      const pad = 8;
      const rect = menu.getBoundingClientRect();
      let left = x;
      let top = y;
      if (left + rect.width > window.innerWidth - pad) left = window.innerWidth - rect.width - pad;
      if (top + rect.height > window.innerHeight - pad) top = window.innerHeight - rect.height - pad;
      if (left < pad) left = pad;
      if (top < pad) top = pad;
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
      const onDoc = (ev) => {
        if (!menu.contains(ev.target)) {
          bag.hideVolContextMenu();
          document.removeEventListener("mousedown", onDoc, true);
          document.removeEventListener("keydown", onKey, true);
          document.removeEventListener("scroll", onDoc, true);
        }
      };
      const onKey = (ev) => {
        if (ev.key === "Escape") {
          bag.hideVolContextMenu();
          document.removeEventListener("mousedown", onDoc, true);
          document.removeEventListener("keydown", onKey, true);
        }
      };
      setTimeout(() => {
        document.addEventListener("mousedown", onDoc, true);
        document.addEventListener("keydown", onKey, true);
        document.addEventListener("scroll", onDoc, true);
      }, 0);
      return menu;
    };
  }

  // public/assets/js/src/views/networks.js
  function install9() {
    bag.openCreateNetworkModal = async function openCreateNetworkModal() {
      bag.closeAppModal();
      const host = bag.modalHost();
      host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-form" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div><h3>Cr\xE9er un r\xE9seau</h3></div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">\u2715</button>
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
            <button type="button" class="btn btn-primary" id="n-save">Cr\xE9er</button>
            <button type="button" class="btn" data-close-modal>Annuler</button>
          </div>
        </div>
      </div>`;
      bag.bindAppModalChrome();
      document.getElementById("n-name")?.focus();
      bag.onBusyClick(document.getElementById("n-save"), async () => {
        const errBox = document.getElementById("create-err");
        errBox.innerHTML = "";
        const Name = document.getElementById("n-name").value.trim();
        const Driver = document.getElementById("n-driver").value;
        if (!Name) {
          errBox.innerHTML = `<div class="error-box">Le nom est requis.</div>`;
          return;
        }
        try {
          await bag.Api.docker("/networks/create", {
            method: "POST",
            body: JSON.stringify({ Name, Driver, CheckDuplicate: true })
          });
          bag.closeAppModal();
          await bag.route();
        } catch (err) {
          errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
        }
      }, { disableSiblings: false, minMs: 250 });
    };
    bag.viewNetworks = async function viewNetworks() {
      const all = bag.isAllNodes();
      let list = [];
      let containers = [];
      let partial = false;
      if (all) {
        const [aggNet, aggCtr] = await Promise.all([
          bag.dockerAll("/networks"),
          bag.dockerAll("/containers/json?all=true")
        ]);
        list = aggNet.items;
        containers = aggCtr.items;
        partial = aggNet.failed > 0 || aggCtr.failed > 0;
      } else {
        const [nets, ctrs] = await Promise.all([
          bag.Api.docker("/networks"),
          bag.Api.docker("/containers/json?all=true")
        ]);
        list = nets || [];
        containers = ctrs || [];
      }
      const usageByKey = /* @__PURE__ */ new Map();
      list.forEach((n, idx) => {
        const users = bag.containersUsingNetwork(n, containers);
        const key = `${n._nodeId || 0}:${n.Id || idx}`;
        usageByKey.set(key, { net: n, users });
        n._usageCount = users.length;
        n._sortKey = key;
      });
      list = bag.sortItems(list, "networks", {
        name: (n) => n.Name || "",
        id: (n) => n.Id || "",
        driver: (n) => n.Driver || "",
        usage: (n) => Number(n._usageCount) || 0,
        scope: (n) => n.Scope || "",
        node: (n) => n._nodeName || "",
        created: (n) => bag.createdSortKey(n.Created || n.CreatedAt)
      });
      const rows = list.map((n) => {
        const users = (usageByKey.get(n._sortKey) || {}).users || [];
        const key = n._sortKey;
        const usageCell = users.length ? `<button type="button" class="badge badge-inuse img-usage-btn" data-net-key="${bag.esc(key)}" title="Voir les conteneurs">${users.length}&nbsp;conteneur${users.length > 1 ? "s" : ""}</button>` : `<span class="badge badge-unused">Inutilis\xE9</span>`;
        const search = `${n.Id} ${n.Name} ${n.Driver} ${n.Scope} ${n._nodeName || ""} ${users.length ? "utilise used" : "inutilise unused"}`.toLowerCase();
        const isBuiltin = ["bridge", "host", "none"].includes(n.Name);
        return `<tr data-search="${bag.esc(search)}" data-resource-id="${bag.esc(n.Id)}" data-resource-name="${bag.esc(n.Name || "")}">
      ${all ? "" : bag.bulkSelectTd(n.Id, { disabled: isBuiltin, title: "R\xE9seau syst\xE8me" })}
      ${all ? `<td class="muted">${bag.esc(n._nodeName || "\u2014")}</td>` : ""}
      <td class="mono">${bag.esc(bag.shortId(n.Id))}</td>
      <td>${bag.esc(n.Name)}</td>
      <td>${bag.esc(n.Driver)}</td>
      <td>${usageCell}</td>
      <td>${bag.esc(n.Scope)}</td>
      <td>${bag.formatCreated(n.Created || n.CreatedAt)}</td>
      <td class="actions">${all ? '<span class="muted">\u2014</span>' : `<div class="quick-actions">
        ${isBuiltin ? "" : bag.shareBtn("network", n.Name || n.Id)}
        ${isBuiltin ? "" : bag.iconBtn({ id: n.Id, title: "Supprimer", icon: "remove", danger: true })}
      </div>`}</td>
    </tr>`;
      }).join("");
      const colSpan = all ? 8 : 9;
      bag.root.innerHTML = bag.shell("R\xE9seaux", `
      ${bag.pageHeader(all ? "R\xE9seaux \u2014 tous les n\u0153uds" : "R\xE9seaux")}
      ${partial ? '<div class="info-box" style="margin-bottom:12px">Agr\xE9gat partiel : certains n\u0153uds n\u2019ont pas r\xE9pondu.</div>' : ""}
      ${all ? bag.pickNodeGuardHtml() : ""}
      <div class="toolbar">
        <input class="search" id="filter" type="search" placeholder="Rechercher des r\xE9seaux\u2026" value="${bag.esc(bag.state.filters.networks || "")}">
        ${all ? "" : `${bag.createBtn("create", "Cr\xE9er un r\xE9seau")}${bag.bulkDeleteBtnHtml()}`}
        <div class="spacer"></div>
        <span class="muted mono" id="filter-count">${list.length} / ${list.length}</span>
      </div>
      <div class="table-wrap"><table class="data">
        <thead><tr>
          ${bag.bulkSelectTh(!all)}
          ${all ? bag.sortTh("N\u0153ud", "node", "networks") : ""}
          ${bag.sortTh("ID", "id", "networks")}
          ${bag.sortTh("Nom", "name", "networks")}
          ${bag.sortTh("Pilote", "driver", "networks")}
          ${bag.sortTh("Usage", "usage", "networks")}
          ${bag.sortTh("Port\xE9e", "scope", "networks")}
          ${bag.sortTh("Cr\xE9\xE9", "created", "networks")}
          <th></th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="${colSpan}" class="empty">Aucun r\xE9seau</td></tr>`}</tbody>
      </table></div>`, { subtitle: all ? "Vue agr\xE9g\xE9e (lecture)" : "R\xE9seaux Docker" });
      bag.bindRefresh();
      bag.bindShareButtons();
      bag.bindPagedSearch("networks");
      bag.bindTableSort("networks", () => bag.viewNetworks());
      bag.root.querySelectorAll("[data-net-key]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const entry = usageByKey.get(btn.dataset.netKey);
          if (entry) bag.openNetworkUsersModal(entry.net, entry.users);
        });
      });
      if (!all) {
        document.getElementById("create").onclick = () => bag.openCreateNetworkModal();
        bag.root.querySelectorAll(".quick-actions button[data-id]").forEach((btn) => {
          const entry = [...usageByKey.values()].find((e) => e.net.Id === btn.dataset.id);
          const used = !!(entry && entry.users.length);
          bag.onBusyClick(btn, async (el) => {
            await bag.Api.docker(`/networks/${encodeURIComponent(el.dataset.id)}`, { method: "DELETE" });
          }, {
            confirm: used ? "Ce r\xE9seau est utilis\xE9 par des conteneurs. Supprimer quand m\xEAme ?" : "Supprimer ce r\xE9seau ?",
            reload: true
          });
        });
        bag.bindBulkDelete({
          enabled: true,
          confirmOne: () => "Supprimer ce r\xE9seau ?",
          confirmMany: (n) => `Supprimer ${n} r\xE9seaux ?`,
          deleteOne: (id) => bag.Api.docker(`/networks/${encodeURIComponent(id)}`, { method: "DELETE" }),
          reload: () => bag.viewNetworks()
        });
      }
      bag.restoreListFocus();
    };
    bag.containerNetworkEntries = function containerNetworkEntries(container) {
      const nets = container?.NetworkSettings?.Networks;
      if (!nets || typeof nets !== "object") return [];
      return Object.entries(nets).map(([name, conf]) => ({
        name,
        id: conf?.NetworkID || conf?.NetworkId || "",
        ip: conf?.IPAddress || ""
      }));
    };
    bag.containersUsingNetwork = function containersUsingNetwork(net, containers) {
      const netId = bag.normalizeImageRef(net?.Id);
      const netName = String(net?.Name || "");
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
    };
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
      return parts.join(" \xB7 ");
    };
    bag.formatPortChips = function formatPortChips(ports) {
      if (!ports || !ports.length) return '<span class="muted">\u2014</span>';
      const seen = /* @__PURE__ */ new Set();
      const chips = [];
      for (const p of ports) {
        const pub = Number(p.PublicPort ?? p.publicPort) || 0;
        const priv = p.PrivatePort || p.privatePort;
        const type = (p.Type || p.type || "tcp").toLowerCase();
        if (!priv) continue;
        const label = pub > 0 ? `${pub}:${priv}/${type}` : `${priv}/${type}`;
        const key = label;
        if (seen.has(key)) continue;
        seen.add(key);
        chips.push(`<span class="port-chip">${bag.esc(label)}</span>`);
      }
      return chips.length ? chips.join("") : '<span class="muted">\u2014</span>';
    };
    bag.openNetworkUsersModal = function openNetworkUsersModal(net, users) {
      bag.closeAppModal();
      const host = bag.modalHost();
      const list = Array.isArray(users) ? users : [];
      const ipam = bag.networkIpamSummary(net);
      const hubMeta = [net?.Driver, ipam].filter(Boolean).join(" \xB7 ");
      const nodes = list.map((c) => {
        const name = c.Names && c.Names[0] ? c.Names[0].replace(/^\//, "") : bag.shortId(c.Id);
        const entry = bag.networkEndpointForContainer(net, c);
        const ip = entry?.ip || "\u2014";
        const st = String(c.State || "").toLowerCase();
        const running = st === "running" || st === "restarting";
        return `<button type="button" class="net-schema-node ${running ? "is-up" : "is-down"}" data-go-container="${bag.esc(c.Id)}" title="${bag.esc(name)}">
        <span class="net-schema-link" aria-hidden="true"></span>
        <span class="net-schema-node-name">${bag.esc(name)}</span>
        <span class="net-schema-node-ip mono">${bag.esc(ip)}</span>
        <span class="net-schema-node-ports">${bag.formatPortChips(c.Ports || [])}</span>
      </button>`;
      }).join("");
      const rows = list.map((c) => {
        const name = c.Names && c.Names[0] ? c.Names[0].replace(/^\//, "") : bag.shortId(c.Id);
        const entry = bag.networkEndpointForContainer(net, c);
        return `<tr>
        <td><a class="res-user-link" href="#containers/${bag.esc(c.Id)}">${bag.esc(name)}</a></td>
        <td class="mono">${bag.esc(entry?.ip || "\u2014")}</td>
        <td>${bag.formatPorts(c.Ports || [], c._nodeId || bag.state.endpointId)}</td>
        <td>${bag.badge(c.State)}</td>
      </tr>`;
      }).join("");
      host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-form-wide" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3>Sch\xE9ma r\xE9seau</h3>
              <p class="modal-sub mono">${bag.esc(net?.Name || "")} \xB7 ${bag.esc(bag.shortId(net?.Id))}</p>
            </div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">\u2715</button>
          </div>
          <div class="net-schema" aria-label="Sch\xE9ma des conteneurs sur ce r\xE9seau">
            <div class="net-schema-hub">
              <div class="net-schema-hub-ico">${bag.ico("networks")}</div>
              <div class="net-schema-hub-name">${bag.esc(net?.Name || "r\xE9seau")}</div>
              <div class="net-schema-hub-meta muted">${bag.esc(hubMeta || `${list.length} conteneur${list.length > 1 ? "s" : ""}`)}</div>
            </div>
            <div class="net-schema-nodes">
              ${nodes || '<div class="muted" style="padding:12px">Aucun conteneur connect\xE9</div>'}
            </div>
          </div>
          <div class="section-title" style="margin-top:16px">D\xE9tail</div>
          <div class="table-wrap" style="margin:0">
            <table class="data">
              <thead><tr><th>Conteneur</th><th>IP</th><th>Ports</th><th>\xC9tat</th></tr></thead>
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
      host.querySelectorAll("[data-go-container]").forEach((btn) => {
        btn.addEventListener("click", () => goContainer(btn.dataset.goContainer));
      });
      host.querySelectorAll("a.res-user-link").forEach((a) => {
        a.addEventListener("click", () => bag.closeAppModal());
      });
    };
  }

  // public/assets/js/src/views/stacks.js
  function install10() {
    bag.viewStacks = async function viewStacks() {
      const all = bag.isAllNodes();
      if (bag.state.route === "stacks/new") {
        if (all) {
          bag.root.innerHTML = bag.shell("Stacks", `
          ${bag.pageHeader("Cr\xE9er une stack")}
          ${bag.pickNodeGuardHtml()}
        `, { subtitle: "Projets Compose" });
          return;
        }
        bag.showStackEditor();
        return;
      }
      const stacks = await bag.Api.stacks();
      let list = stacks || [];
      const stackStatusLabel = (st) => Number(st) === 1 ? "running" : "exited";
      list = bag.sortItems(list, "stacks", {
        name: (s) => s.Name || "",
        state: (s) => stackStatusLabel(s.Status),
        owner: (s) => s.CreatedBy || "",
        node: (s) => bag.endpointLabel(s.EndpointId),
        id: (s) => Number(s.Id) || 0,
        created: (s) => bag.createdSortKey(s.CreationDate)
      });
      const rows = list.map((s) => {
        const node = bag.endpointLabel(s.EndpointId);
        const stLabel = stackStatusLabel(s.Status);
        const search = `${s.Id} ${s.Name} ${node} ${s.CreatedBy || ""} ${stLabel}`.toLowerCase();
        const isRunning = stLabel === "running";
        const actions = `<div class="quick-actions">
        ${bag.iconBtn({ act: "start", id: s.Id, title: "D\xE9marrer", icon: "start", success: !isRunning })}
        ${bag.iconBtn({ act: "stop", id: s.Id, title: "Arr\xEAter", icon: "stop", danger: isRunning })}
        ${bag.iconBtn({ act: "restart", id: s.Id, title: "Red\xE9marrer", icon: "restart" })}
        ${bag.iconBtn({ act: "edit", id: s.Id, name: s.Name, title: "\xC9diteur", icon: "edit", info: true })}
        ${bag.iconBtn({ act: "redeploy", id: s.Id, title: "Pull images + red\xE9ployer", icon: "pull" })}
        ${bag.iconBtn({ tag: "a", href: `#stacks/${s.Id}`, title: "D\xE9tail", icon: "inspect" })}
        ${bag.iconBtn({ title: "Partager", icon: "users", info: true, shareType: "stack", shareKey: String(s.Id) })}
        ${bag.iconBtn({ act: "remove", id: s.Id, title: "Supprimer", icon: "remove", danger: true })}
      </div>`;
        const rowCls = isRunning ? "" : "row-stopped";
        return `<tr class="${rowCls}" data-search="${bag.esc(search)}" data-stack-id="${bag.esc(s.Id)}">
      ${bag.bulkSelectTd(s.Id)}
      ${all ? `<td class="muted">${bag.esc(node)}</td>` : ""}
      <td class="name-cell">
        <strong><a href="#stacks/${s.Id}">${bag.esc(s.Name)}</a></strong>
        <span class="id">#${bag.esc(s.Id)}</span>
      </td>
      <td>${bag.badge(stLabel)}</td>
      <td class="mono cell-clip cell-image" title="Images Compose">
        <span class="img-with-upd">
          <span class="img-upd-slot" data-upd="${bag.esc(s.Id)}">
            <span class="img-upd is-loading img-upd-dot-only" title="V\xE9rification des images\u2026"><span class="img-upd-dot"></span></span>
          </span>
          <span class="img-name" data-upd-imgs="${bag.esc(s.Id)}">\u2026</span>
        </span>
      </td>
      <td>${bag.esc(s.CreatedBy || "")}</td>
      <td>${bag.formatCreated(s.CreationDate)}</td>
      <td class="actions">${actions}</td>
    </tr>`;
      }).join("");
      const colSpan = all ? 8 : 7;
      bag.root.innerHTML = bag.shell("Stacks", `
      ${bag.pageHeader(all ? "Stacks \u2014 tous les n\u0153uds" : "Stacks")}
      ${all ? bag.pickNodeGuardHtml() : ""}
      <div class="toolbar">
        <input class="search" id="filter" type="search" placeholder="Rechercher des stacks\u2026" value="${bag.esc(bag.state.filters.stacks || "")}">
        ${all ? "" : `<a class="btn btn-info btn-create" href="#stacks/new" title="Cr\xE9er une stack">
          <span class="btn-ico">${bag.ico("plus")}</span><span>Cr\xE9er une stack</span>
        </a>`}
        ${bag.bulkDeleteBtnHtml()}
        <div class="spacer"></div>
        <span class="muted" style="font-size:12px">\u25CF vert = \xE0 jour \xB7 \u25CF orange = mise \xE0 jour dispo \xB7 cache 24 h</span>
        <button type="button" class="btn btn-sm" id="stack-upd-refresh" title="Rev\xE9rifier les images maintenant">Rafra\xEEchir images</button>
        <span class="muted mono" id="filter-count">${list.length} / ${list.length}</span>
      </div>
      <div class="table-wrap"><table class="data">
        <thead><tr>
          ${bag.bulkSelectTh(true)}
          ${all ? bag.sortTh("N\u0153ud", "node", "stacks") : ""}
          ${bag.sortTh("Nom", "name", "stacks")}
          ${bag.sortTh("\xC9tat", "state", "stacks")}
          <th title="Images du registre">Image</th>
          ${bag.sortTh("Cr\xE9\xE9 par", "owner", "stacks")}
          ${bag.sortTh("Cr\xE9\xE9", "created", "stacks")}
          <th>Actions</th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="${colSpan}" class="empty">Aucune stack disponible.</td></tr>`}</tbody>
      </table></div>`, { subtitle: all ? "Vue agr\xE9g\xE9e" : "Projets Compose" });
      bag.bindRefresh();
      bag.bindShareButtons();
      bag.bindMoreActions();
      bag.bindPagedSearch("stacks");
      bag.bindTableSort("stacks", () => bag.viewStacks());
      bag.root.querySelectorAll("[data-act]").forEach((btn) => {
        const act = btn.dataset.act;
        const confirmMsg = act === "remove" ? "Supprimer la stack et ses conteneurs ?" : null;
        bag.onBusyClick(btn, async (el) => {
          const id = el.dataset.id;
          if (act === "edit") {
            const [stack, file] = await Promise.all([bag.Api.stack(id), bag.Api.stackFile(id)]);
            bag.showStackEditor({
              Id: stack.Id,
              Name: stack.Name || el.dataset.name || "",
              content: file.StackFileContent || "",
              Env: stack.Env || []
            });
            return "navigated";
          }
          if (act === "redeploy") {
            await bag.upgradeStackImages(id);
            return;
          }
          if (act === "start") await bag.Api.startStack(id);
          else if (act === "stop") await bag.Api.stopStack(id);
          else if (act === "restart") await bag.Api.restartStack(id);
          else if (act === "remove") await bag.Api.deleteStack(id);
        }, {
          confirm: confirmMsg || (act === "redeploy" ? "Pull des images et red\xE9ploiement de la stack ?" : null),
          reload: act !== "edit"
        });
      });
      bag.bindBulkDelete({
        enabled: true,
        confirmOne: () => "Supprimer cette stack et ses conteneurs ?",
        confirmMany: (n) => `Supprimer ${n} stacks et leurs conteneurs ?`,
        deleteOne: (id) => bag.Api.deleteStack(id),
        reload: () => bag.viewStacks()
      });
      document.getElementById("stack-upd-refresh")?.addEventListener("click", () => {
        bag.root.querySelectorAll("[data-upd-imgs]").forEach((el) => {
          el.textContent = "\u2026";
          el.title = "";
        });
        bag.root.querySelectorAll("[data-upd]").forEach((slot) => {
          slot.innerHTML = `<span class="img-upd is-loading img-upd-dot-only" title="V\xE9rification\u2026"><span class="img-upd-dot"></span></span>`;
        });
        bag.loadStackUpdateIndicators(true);
      });
      bag.loadStackUpdateIndicators(false);
      bag.restoreListFocus();
    };
    bag.formatImageListLabel = function formatImageListLabel(images) {
      const names = (images || []).map((i) => (typeof i === "string" ? i : i?.Image || "").trim()).filter(Boolean);
      if (!names.length) return "\u2014";
      if (names.length === 1) return names[0];
      if (names.length === 2) return `${names[0]}, ${names[1]}`;
      return `${names[0]} +${names.length - 1}`;
    };
    bag.formatImageVersionLabel = function formatImageVersionLabel(name, version) {
      const n = String(name || "").trim();
      const v = String(version || "").trim();
      if (n && v) return `${n} ${v}`;
      if (n) return n;
      if (v) return v;
      return "\u2014";
    };
    bag.formatImageUpdateVersions = function formatImageUpdateVersions(u) {
      if (!u || typeof u !== "object") return "";
      if (u.Detail && /même tag| : .+ → | : à jour| : épinglée/.test(String(u.Detail))) {
        return String(u.Detail);
      }
      const name = String(u.ImageName || "").trim() || String(u.Image || "").replace(/:.*$/, "");
      const cur = String(u.LocalVersion || "").trim() || "\u2014";
      const next = String(u.RemoteVersion || "").trim() || "\u2014";
      const st = u.Status || "unknown";
      if (st === "update") {
        if (/nouveau build/i.test(next) || /installé/i.test(cur)) {
          return `${name || "image"} : ${cur} \u2192 ${next}`;
        }
        return `${name || "image"} : ${cur} \u2192 ${next}`;
      }
      if (st === "fresh") return `${name || "image"} : \xE0 jour (${cur})`;
      if (st === "pinned") return `${name || "image"} : \xE9pingl\xE9e (${cur})`;
      if (u.Detail) return String(u.Detail);
      return name ? `${name} (${cur})` : "";
    };
    bag.stackUpdatePill = function stackUpdatePill(status, updateCount, title, opts = {}) {
      const st = status || "unknown";
      const cls = st === "update" ? "is-update" : st === "fresh" || st === "pinned" ? "is-fresh" : "is-unknown";
      const label = st === "update" ? updateCount > 1 ? `${updateCount} mises \xE0 jour` : "Mise \xE0 jour" : st === "fresh" || st === "pinned" ? "\xC0 jour" : "\u2014";
      const tip = st === "update" && opts.action ? `${title || label}

Cliquer pour tirer les images et red\xE9ployer` : title || label;
      const dotOnly = !!opts.dotOnly;
      const inner = dotOnly ? `<span class="img-upd-dot"></span>` : `<span class="img-upd-dot"></span><span class="img-upd-lbl">${bag.esc(label)}</span>`;
      const extraCls = dotOnly ? " img-upd-dot-only" : "";
      if (st === "update" && opts.action && opts.id != null) {
        return `<button type="button" class="img-upd ${cls} img-upd-action${extraCls}"
        data-upd-action="${bag.esc(opts.action)}" data-upd-id="${bag.esc(String(opts.id))}"
        title="${bag.esc(tip)}" aria-label="${bag.esc(label)}">${inner}</button>`;
      }
      return `<span class="img-upd ${cls}${extraCls}" title="${bag.esc(tip)}">${inner}</span>`;
    };
    bag.upgradeStackImages = async function upgradeStackImages(stackId) {
      const id = String(stackId || "");
      if (!id) throw new Error("Stack introuvable");
      const [stack, file] = await Promise.all([bag.Api.stack(id), bag.Api.stackFile(id)]);
      await bag.Api.updateStack(id, file.StackFileContent || "", stack.Env || [], true);
      return stack;
    };
    bag.findStackForContainer = async function findStackForContainer(containerId) {
      try {
        const info = await bag.Api.docker(`/containers/${encodeURIComponent(containerId)}/json`);
        const project = String(info?.Config?.Labels?.["com.docker.compose.project"] || "").trim();
        if (!project) return null;
        const stacks = await bag.Api.stacks();
        const want = project.toLowerCase();
        return (stacks || []).find((s) => String(s.Name || "").toLowerCase() === want) || null;
      } catch (_) {
        return null;
      }
    };
    bag.upgradeImageUpdateTarget = async function upgradeImageUpdateTarget(action, id) {
      if (action === "stack") {
        await bag.upgradeStackImages(id);
        return { kind: "stack", id };
      }
      if (action === "container") {
        const stack = await bag.findStackForContainer(id);
        if (stack?.Id != null) {
          await bag.upgradeStackImages(stack.Id);
          return { kind: "stack", id: stack.Id, via: "container", name: stack.Name };
        }
        await bag.Api.updateContainerImage(id, true);
        return { kind: "container", id };
      }
      throw new Error("Action de mise \xE0 jour inconnue");
    };
    bag.bindImageUpdateActions = function bindImageUpdateActions(scope = bag.root) {
      if (!scope) return;
      scope.querySelectorAll("[data-upd-action]").forEach((btn) => {
        if (btn.dataset.updBound === "1") return;
        btn.dataset.updBound = "1";
        const action = btn.dataset.updAction;
        const confirmMsg = action === "stack" ? "Tirer les nouvelles images et red\xE9ployer cette stack ? Les services seront recr\xE9\xE9s." : "Tirer l\u2019image et mettre \xE0 jour ce conteneur ? (stack Compose si li\xE9e, sinon recr\xE9e le conteneur)";
        bag.onBusyClick(btn, async (el) => {
          const kind = el.dataset.updAction;
          const targetId = el.dataset.updId;
          const focus = bag.captureListFocus(el);
          await bag.upgradeImageUpdateTarget(kind, targetId);
          const route = String(bag.state.route || "");
          if (route.startsWith("stacks/") && route !== "stacks/new") {
            const sid = route.split("/")[1];
            if (sid) {
              await bag.viewStackDetail(sid);
              bag.restoreListFocus(focus);
            }
            return;
          }
          if (route === "stacks") {
            await bag.loadStackUpdateIndicators(true);
            bag.restoreListFocus(focus);
            return;
          }
          if (route.startsWith("containers/") && route !== "containers/new") {
            bag.rememberListFocus(focus);
            await bag.route();
            bag.restoreListFocus(focus);
            return;
          }
          if (route === "containers") {
            await bag.loadContainerUpdateIndicators(true);
            bag.restoreListFocus(focus);
          }
        }, { confirm: confirmMsg, minMs: 400 });
      });
    };
    bag.imageUpdateCacheKey = function imageUpdateCacheKey(kind) {
      return `wm_img_upd_${kind}_${bag.Api.getEndpointId()}`;
    };
    bag.readImageUpdateCache = function readImageUpdateCache(kind) {
      try {
        const raw = sessionStorage.getItem(bag.imageUpdateCacheKey(kind));
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : null;
      } catch (_) {
        return null;
      }
    };
    bag.writeImageUpdateCache = function writeImageUpdateCache(kind, map) {
      try {
        sessionStorage.setItem(bag.imageUpdateCacheKey(kind), JSON.stringify(map || {}));
      } catch (_) {
      }
    };
    bag.paintCachedUpdateIndicators = function paintCachedUpdateIndicators(kind, slotAttr) {
      const map = bag.readImageUpdateCache(kind);
      if (!map) return;
      Object.keys(map).forEach((id) => {
        const slot = bag.root.querySelector(`[${slotAttr}="${CSS.escape(String(id))}"]`);
        if (!slot) return;
        const u = map[id] || {};
        if (!u.Status || u.Status === "unknown") return;
        let title = bag.formatImageUpdateVersions(u) || u.Detail || "R\xE9sultat en cache";
        if (u.Image) title = `${u.Image}
${title}`;
        if (kind === "stacks" && Array.isArray(u.Images)) {
          title = u.Images.map((i) => {
            const ver = bag.formatImageUpdateVersions(i);
            return `${i.Service}: ${ver || i.Detail || i.Status} (${i.Image})`;
          }).join("\n") || title;
        }
        title += "\n(cache local \xB7 actualisation\u2026)";
        slot.innerHTML = bag.stackUpdatePill(u.Status, u.UpdateCount || 0, title, {
          action: kind === "stacks" ? "stack" : "container",
          id,
          dotOnly: true
        });
      });
    };
    bag.loadStackUpdateIndicators = async function loadStackUpdateIndicators(refresh = false) {
      if (!refresh) bag.paintCachedUpdateIndicators("stacks", "data-upd");
      try {
        const data = await bag.Api.stackUpdates(!!refresh);
        const map = data?.Updates || {};
        bag.writeImageUpdateCache("stacks", map);
        Object.keys(map).forEach((id) => {
          const slot = bag.root.querySelector(`[data-upd="${CSS.escape(String(id))}"]`);
          const nameEl = bag.root.querySelector(`[data-upd-imgs="${CSS.escape(String(id))}"]`);
          if (!slot) return;
          const u = map[id] || {};
          const imgs = u.Images || [];
          const imgLabel = bag.formatImageListLabel(imgs);
          const lines = imgs.map((i) => {
            const ver = bag.formatImageUpdateVersions(i);
            return `${i.Service}: ${ver || i.Detail || i.Status} (${i.Image})`;
          });
          let title = lines.length ? lines.join("\n") : u.Error || "Aucun contr\xF4le";
          if (u.FromCache && u.CheckedAt) {
            title += `
(cache \xB7 v\xE9rifi\xE9 ${new Date(u.CheckedAt * 1e3).toLocaleString()})`;
          }
          if (nameEl) {
            nameEl.textContent = imgLabel;
            nameEl.title = lines.length ? imgs.map((i) => `${i.Service}: ${i.Image}`).join("\n") : imgLabel;
            const cell = nameEl.closest("td");
            if (cell) cell.title = nameEl.title || imgLabel;
          }
          slot.innerHTML = bag.stackUpdatePill(u.Status, u.UpdateCount || 0, title, {
            action: "stack",
            id,
            dotOnly: true
          });
        });
        bag.root.querySelectorAll("[data-upd] .img-upd.is-loading").forEach((el) => {
          el.className = "img-upd is-unknown img-upd-dot-only";
          el.title = "Contr\xF4le indisponible";
        });
        bag.root.querySelectorAll("[data-upd-imgs]").forEach((el) => {
          if (el.textContent === "\u2026") el.textContent = "\u2014";
        });
        bag.bindImageUpdateActions(bag.root);
      } catch {
        bag.root.querySelectorAll("[data-upd-imgs]").forEach((el) => {
          el.textContent = "\u2014";
        });
        bag.root.querySelectorAll("[data-upd]").forEach((slot) => {
          slot.innerHTML = bag.stackUpdatePill("unknown", 0, "Contr\xF4le indisponible", { dotOnly: true });
        });
      }
    };
    bag.parseDotEnv = function parseDotEnv(text) {
      const pairs = [];
      String(text || "").split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return;
        const body = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
        const eq = body.indexOf("=");
        if (eq <= 0) return;
        const name = body.slice(0, eq).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return;
        let value = body.slice(eq + 1).trim();
        if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
          value = value.slice(1, -1);
        }
        pairs.push({ name, value });
      });
      return pairs;
    };
    bag.lintComposeYaml = function lintComposeYaml(text) {
      const found = [];
      if (typeof CodeMirror === "undefined") return found;
      const Pos = CodeMirror.Pos;
      const lines = String(text || "").split(/\r?\n/);
      const unit = 2;
      const stack = [0];
      let inBlock = false;
      let blockBase = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (!trimmed) continue;
        const leadMatch = line.match(/^[ \t]*/);
        const lead = leadMatch ? leadMatch[0] : "";
        if (lead.includes("	")) {
          found.push({
            from: Pos(i, 0),
            to: Pos(i, lead.length || 1),
            message: "Tabulation interdite dans l\u2019indentation \u2014 utilisez des espaces",
            severity: "error"
          });
          continue;
        }
        const indent = lead.length;
        if (inBlock) {
          if (indent > blockBase) continue;
          inBlock = false;
        }
        if (trimmed.startsWith("#")) continue;
        if (trimmed === "---" || trimmed === "...") continue;
        if (indent % unit !== 0) {
          found.push({
            from: Pos(i, 0),
            to: Pos(i, Math.max(indent, 1)),
            message: `Indentation invalide : ${indent} espace${indent > 1 ? "s" : ""} (attendu un multiple de ${unit})`,
            severity: "error"
          });
        }
        const prev = stack[stack.length - 1];
        if (indent > prev) {
          if (indent !== prev + unit) {
            found.push({
              from: Pos(i, 0),
              to: Pos(i, Math.max(indent, 1)),
              message: `Saut d\u2019indentation : ${prev} \u2192 ${indent} (attendu ${prev + unit})`,
              severity: "error"
            });
          }
          stack.push(indent);
        } else if (indent < prev) {
          while (stack.length > 1 && stack[stack.length - 1] > indent) stack.pop();
          if (stack[stack.length - 1] !== indent) {
            found.push({
              from: Pos(i, 0),
              to: Pos(i, Math.max(indent, 1)),
              message: `Niveau d\u2019indentation incoh\xE9rent (${indent} espaces)`,
              severity: "error"
            });
            stack.push(indent);
          }
        }
        if (/:\s*[|>][-+0-9]*\s*(#.*)?$/.test(trimmed) || /^[|>][-+0-9]*\s*(#.*)?$/.test(trimmed)) {
          inBlock = true;
          blockBase = indent;
        }
      }
      const yaml = window.jsyaml;
      if (yaml && typeof yaml.load === "function" && String(text || "").trim()) {
        try {
          yaml.load(text);
        } catch (e) {
          const mark = e && e.mark;
          const line = mark && Number.isFinite(mark.line) ? mark.line : 0;
          const col = mark && Number.isFinite(mark.column) ? mark.column : 0;
          const msg = e && (e.reason || e.message) || "YAML invalide";
          const already = found.some((f) => f.from.line === line && f.severity === "error");
          if (!already) {
            found.push({
              from: Pos(line, col),
              to: Pos(line, col + 1),
              message: msg,
              severity: "error"
            });
          }
        }
      }
      return found;
    };
    bag.updateYamlStatus = function updateYamlStatus(el, annotations) {
      if (!el) return;
      const errs = (annotations || []).filter((a) => a.severity !== "warning");
      if (!errs.length) {
        el.className = "yaml-status is-ok";
        el.innerHTML = `<span class="yaml-dot"></span>YAML valide`;
        return;
      }
      const first = errs[0];
      const line = first.from && first.from.line != null ? first.from.line + 1 : "?";
      el.className = "yaml-status is-err";
      el.innerHTML = `<span class="yaml-dot"></span><strong>${errs.length} erreur${errs.length > 1 ? "s" : ""}</strong>
      \u2014 ligne ${bag.esc(String(line))} : ${bag.esc(first.message || "invalide")}${errs.length > 1 ? "\u2026" : ""}`;
    };
    bag.mountYamlEditor = function mountYamlEditor(textarea, statusEl) {
      if (!textarea || typeof CodeMirror === "undefined") return null;
      if (!CodeMirror._wharfYamlLint) {
        CodeMirror.registerHelper("lint", "yaml", (text) => bag.lintComposeYaml(text));
        CodeMirror._wharfYamlLint = true;
      }
      const cm = CodeMirror.fromTextArea(textarea, {
        mode: "yaml",
        theme: "wharf",
        lineNumbers: true,
        lineWrapping: true,
        indentUnit: 2,
        tabSize: 2,
        indentWithTabs: false,
        smartIndent: true,
        matchBrackets: true,
        styleActiveLine: true,
        gutters: ["CodeMirror-linenumbers", "CodeMirror-lint-markers"],
        lint: {
          getAnnotations: (text, updateLinting, opts, editor) => {
            const anns = bag.lintComposeYaml(text);
            updateLinting(editor, anns);
            bag.updateYamlStatus(statusEl, anns);
          },
          async: true
        },
        extraKeys: {
          Tab: (cmInst) => {
            if (cmInst.somethingSelected()) cmInst.indentSelection("add");
            else cmInst.replaceSelection("  ", "end");
          }
        }
      });
      bag.updateYamlStatus(statusEl, bag.lintComposeYaml(cm.getValue()));
      requestAnimationFrame(() => {
        try {
          cm.refresh();
        } catch (_) {
        }
      });
      return {
        getValue: () => cm.getValue(),
        setValue: (v) => cm.setValue(v),
        hasErrors: () => bag.lintComposeYaml(cm.getValue()).some((a) => a.severity !== "warning"),
        focus: () => cm.focus(),
        cm
      };
    };
    bag.showStackEditor = function showStackEditor(existing) {
      const isEdit = !!existing;
      const defaultCompose = `services:
  web:
    image: nginx:alpine
    ports:
      - "8090:80"
  `;
      const initialEnv = Array.isArray(existing?.Env) ? existing.Env : [];
      bag.root.innerHTML = bag.shell(isEdit ? "Modifier la stack" : "Cr\xE9er une stack", `
      ${bag.pageHeader(isEdit ? "Modifier la stack" : "Cr\xE9er une stack", false)}
      <div id="stack-err"></div>
      <div class="form-group">
        <label class="field-label">Nom <span class="req">*</span></label>
        <input id="stack-name" ${isEdit ? "disabled" : ""} value="${bag.esc(existing?.Name || "")}" placeholder="ex. ma-stack">
      </div>

      <div class="form-group">
        <label class="field-label">Fichier Compose <span class="req">*</span></label>
        <div class="code-editor code-editor-yaml">
          <div class="code-editor-bar">
            <span class="yaml-hint muted">YAML \xB7 indentation 2 espaces</span>
            ${bag.iconBtn({ elId: "copy-compose", title: "Copier", icon: "copy" })}
          </div>
          <textarea id="stack-file">${bag.esc(existing?.content || defaultCompose)}</textarea>
          <div class="yaml-status" id="yaml-status" aria-live="polite"></div>
        </div>
      </div>

      <div class="section-title">Variables d\u2019environnement</div>
      <div class="info-box">
        \xC9crites dans <code>.env</code> du projet Compose et inject\xE9es au d\xE9ploiement (<code>\${VAR}</code> dans le YAML).
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
          <input type="checkbox" id="stack-pull" ${isEdit ? "checked" : ""}>
          <span>Forcer le pull des images depuis le registre</span>
        </label>
        <p class="field-hint muted">Utile pour une mise \xE0 jour (<code>latest</code> ou tag flottant). Lance <code>docker compose up --pull always</code>.</p>
      </div>

      <div class="actions-bar">
        <button class="btn btn-primary" id="stack-save">${isEdit ? "Mettre \xE0 jour la stack" : "D\xE9ployer la stack"}</button>
        <button type="button" class="btn" id="stack-cancel" style="margin-left:8px">Annuler</button>
      </div>
    `);
      const envList = document.getElementById("env-list");
      const envEmpty = document.getElementById("env-empty");
      function syncEnvEmpty() {
        const rows = envList?.querySelectorAll(".env-row") || [];
        if (envEmpty) envEmpty.hidden = rows.length > 0;
      }
      function addEnvRow(name = "", value = "") {
        const row = document.createElement("div");
        row.className = "env-row";
        row.innerHTML = `
        <input class="env-name" placeholder="NOM" value="${bag.esc(name)}" autocomplete="off" spellcheck="false">
        <input class="env-value" placeholder="valeur" value="${bag.esc(value)}" autocomplete="off" spellcheck="false">
        <button type="button" class="icon-btn env-remove" title="Retirer" aria-label="Retirer">\u2715</button>`;
        row.querySelector(".env-remove")?.addEventListener("click", () => {
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
        envList?.querySelectorAll(".env-row").forEach((row, i) => {
          const name = row.querySelector(".env-name")?.value?.trim() || "";
          const value = row.querySelector(".env-value")?.value ?? "";
          if (!name && value === "") return;
          if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
            errors.push(`Variable ${i + 1} : nom invalide (ex. MYSQL_PASSWORD)`);
            return;
          }
          Env.push({ name, value });
        });
        return { Env, errors };
      }
      function mergeEnvPairs(pairs, { replace = false } = {}) {
        if (replace) envList.innerHTML = "";
        const existing2 = /* @__PURE__ */ new Map();
        envList?.querySelectorAll(".env-row").forEach((row) => {
          const n = row.querySelector(".env-name")?.value?.trim();
          if (n) existing2.set(n, row);
        });
        pairs.forEach(({ name, value }) => {
          if (existing2.has(name)) {
            existing2.get(name).querySelector(".env-value").value = value;
          } else {
            addEnvRow(name, value);
          }
        });
        syncEnvEmpty();
      }
      initialEnv.forEach((p) => {
        const name = p.name || p.Name || "";
        const value = p.value ?? p.Value ?? "";
        if (name) addEnvRow(name, value);
      });
      syncEnvEmpty();
      document.getElementById("add-env")?.addEventListener("click", () => {
        const row = addEnvRow();
        row.querySelector(".env-name")?.focus();
      });
      document.getElementById("load-env")?.addEventListener("click", () => {
        document.getElementById("env-file")?.click();
      });
      document.getElementById("env-file")?.addEventListener("change", async (e) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;
        try {
          const text = await file.text();
          const pairs = bag.parseDotEnv(text);
          if (!pairs.length) {
            const errBox = document.getElementById("stack-err");
            if (errBox) errBox.innerHTML = `<div class="error-box">Aucune variable trouv\xE9e dans ce fichier.</div>`;
            return;
          }
          mergeEnvPairs(pairs);
        } catch (err) {
          const errBox = document.getElementById("stack-err");
          if (errBox) errBox.innerHTML = `<div class="error-box">${bag.esc(err.message || "Lecture .env impossible")}</div>`;
        }
      });
      const yamlStatus = document.getElementById("yaml-status");
      const yamlEditor = bag.mountYamlEditor(document.getElementById("stack-file"), yamlStatus);
      const readCompose = () => yamlEditor ? yamlEditor.getValue() : document.getElementById("stack-file")?.value || "";
      document.getElementById("copy-compose").onclick = async () => {
        try {
          await navigator.clipboard.writeText(readCompose());
        } catch (_) {
        }
      };
      bag.onBusyClick(document.getElementById("stack-save"), async () => {
        const name = document.getElementById("stack-name").value.trim();
        const content = readCompose();
        const errBox = document.getElementById("stack-err");
        if (errBox) errBox.innerHTML = "";
        if (yamlEditor?.hasErrors()) {
          const anns = bag.lintComposeYaml(content);
          bag.updateYamlStatus(yamlStatus, anns);
          const first = anns.find((a) => a.severity !== "warning") || anns[0];
          const line = first?.from?.line != null ? first.from.line + 1 : "?";
          if (errBox) {
            errBox.innerHTML = `<div class="error-box">Compose YAML invalide (ligne ${bag.esc(String(line))}) : ${bag.esc(first?.message || "corrigez l\u2019indentation")}</div>`;
            window.scrollTo({ top: 0, behavior: "smooth" });
          }
          return;
        }
        const { Env, errors } = collectEnv();
        if (errors.length) {
          if (errBox) errBox.innerHTML = `<div class="error-box">${bag.esc(errors.join("\n"))}</div>`;
          return;
        }
        const pullImages = !!document.getElementById("stack-pull")?.checked;
        try {
          const gate = await bag.cveAdviseBeforeDeploy({ Compose: content }, errBox);
          if (!gate.proceed) {
            if (errBox) {
              errBox.innerHTML = (errBox.innerHTML || "") + `<div class="info-box" style="margin-top:8px">D\xE9ploiement annul\xE9.</div>`;
              window.scrollTo({ top: 0, behavior: "smooth" });
            }
            return;
          }
          if (isEdit) {
            bag.rememberListFocus({ id: String(existing.Id), name: existing.Name || name || "", y: 0 });
            await bag.Api.updateStack(existing.Id, content, Env, pullImages);
          } else {
            await bag.Api.createStack(name, content, Env, pullImages);
          }
          const cur = (location.hash || "").replace(/^#/, "") || "stacks";
          if (cur === "stacks") await bag.viewStacks();
          else location.hash = "#stacks";
        } catch (err) {
          if (errBox) {
            errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
            window.scrollTo({ top: 0, behavior: "smooth" });
          } else {
            alert(err.message);
          }
        }
      }, { disableSiblings: false, minMs: 400 });
      document.getElementById("stack-cancel")?.addEventListener("click", () => {
        const cur = (location.hash || "").replace(/^#/, "") || "stacks";
        if (cur === "stacks") {
          bag.viewStacks();
          return;
        }
        location.hash = "#stacks";
      });
    };
    bag.schedActionLabel = function schedActionLabel(action) {
      const map = { start: "D\xE9marrer", stop: "Arr\xEAter", restart: "Red\xE9marrer" };
      return map[action] || action || "\u2014";
    };
    bag.DOW_LABELS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
    bag.pad2 = function pad2(n) {
      return String(Number(n) || 0).padStart(2, "0");
    };
    bag.buildFriendlyCron = function buildFriendlyCron({ preset, hour, minute, dow, custom }) {
      const h = Math.max(0, Math.min(23, Number(hour) || 0));
      const m = Math.max(0, Math.min(59, Number(minute) || 0));
      const d = Math.max(0, Math.min(6, Number(dow) || 0));
      switch (preset) {
        case "hourly":
          return `${m} * * * *`;
        case "daily":
          return `${m} ${h} * * *`;
        case "weekdays":
          return `${m} ${h} * * 1-5`;
        case "weekly":
          return `${m} ${h} * * ${d}`;
        case "custom":
          return String(custom || "").trim();
        default:
          return `${m} ${h} * * *`;
      }
    };
    bag.describeCron = function describeCron(cron) {
      const parts = String(cron || "").trim().split(/\s+/);
      if (parts.length !== 5) return cron || "\u2014";
      const [mi, hh, dom, mon, dow] = parts;
      const hm = (h, m) => `${bag.pad2(h)}:${bag.pad2(m)} UTC`;
      if (mi !== "*" && hh === "*" && dom === "*" && mon === "*" && dow === "*") {
        return `Toutes les heures \xE0 xx:${bag.pad2(mi)} UTC`;
      }
      if (/^\d+$/.test(mi) && /^\d+$/.test(hh) && dom === "*" && mon === "*" && dow === "*") {
        return `Tous les jours \xE0 ${hm(hh, mi)}`;
      }
      if (/^\d+$/.test(mi) && /^\d+$/.test(hh) && dom === "*" && mon === "*" && dow === "1-5") {
        return `Lun\u2013Ven \xE0 ${hm(hh, mi)}`;
      }
      if (/^\d+$/.test(mi) && /^\d+$/.test(hh) && dom === "*" && mon === "*" && /^\d+$/.test(dow)) {
        return `Chaque ${bag.DOW_LABELS[Number(dow)] || dow} \xE0 ${hm(hh, mi)}`;
      }
      return cron;
    };
    bag.openScheduleModal = function openScheduleModal(stack, onSaved) {
      const slot = document.getElementById("sched-modal");
      if (!slot) return;
      const hourOpts = Array.from(
        { length: 24 },
        (_, h) => `<option value="${h}" ${h === 22 ? "selected" : ""}>${bag.pad2(h)} h</option>`
      ).join("");
      const minOpts = [0, 5, 10, 15, 20, 30, 45].map(
        (m) => `<option value="${m}">:${bag.pad2(m)}</option>`
      ).join("");
      const dowOpts = bag.DOW_LABELS.map(
        (label, i) => `<option value="${i}" ${i === 1 ? "selected" : ""}>${label}</option>`
      ).join("");
      slot.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-form" style="max-width:520px" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3>Nouvelle planification</h3>
              <div class="modal-sub">Stack \xB7 ${bag.esc(stack.Name || "")}</div>
            </div>
            <button type="button" class="icon-btn" id="cancel-sched" title="Fermer" aria-label="Fermer">\u2715</button>
          </div>
          <div id="sched-form-err"></div>
          <div class="form-group">
            <label class="field-label">Nom</label>
            <input id="sched-name" placeholder="Ex. Arr\xEAt le soir" autocomplete="off">
          </div>
          <div class="form-group">
            <label class="field-label">Action</label>
            <select id="sched-action" class="select-block">
              <option value="stop">Arr\xEAter la stack</option>
              <option value="start">D\xE9marrer la stack</option>
              <option value="restart">Red\xE9marrer la stack</option>
            </select>
          </div>
          <div class="form-group">
            <label class="field-label">Quand ?</label>
            <select id="sched-preset" class="select-block">
              <option value="daily" selected>Tous les jours</option>
              <option value="weekdays">Jours ouvr\xE9s (lun\u2013ven)</option>
              <option value="weekly">Une fois par semaine</option>
              <option value="hourly">Toutes les heures</option>
              <option value="custom">Personnalis\xE9 (cron)</option>
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
          <div class="info-box" id="sched-summary" style="margin-top:4px">\u2014</div>
          <div class="actions-bar">
            <button class="btn btn-primary" id="save-sched">Cr\xE9er</button>
            <button class="btn" id="cancel-sched-2" style="margin-left:8px">Annuler</button>
          </div>
        </div>
      </div>`;
      const syncUi = () => {
        const preset = document.getElementById("sched-preset")?.value || "daily";
        const hourWrap = document.getElementById("sched-hour-wrap");
        const timeRow = document.getElementById("sched-time-row");
        const dowWrap = document.getElementById("sched-dow-wrap");
        const customWrap = document.getElementById("sched-custom-wrap");
        const isCustom = preset === "custom";
        const isHourly = preset === "hourly";
        if (customWrap) customWrap.hidden = !isCustom;
        if (timeRow) timeRow.hidden = isCustom;
        if (hourWrap) hourWrap.hidden = isHourly || isCustom;
        if (dowWrap) dowWrap.hidden = preset !== "weekly";
        const cron = bag.buildFriendlyCron({
          preset,
          hour: document.getElementById("sched-hour")?.value,
          minute: document.getElementById("sched-minute")?.value,
          dow: document.getElementById("sched-dow")?.value,
          custom: document.getElementById("sched-cron")?.value
        });
        const action = bag.schedActionLabel(document.getElementById("sched-action")?.value);
        const sum = document.getElementById("sched-summary");
        if (sum) {
          sum.innerHTML = isCustom && !cron ? '<span class="muted">Saisissez une expression cron.</span>' : `<strong>${bag.esc(action)}</strong> \u2014 ${bag.esc(bag.describeCron(cron))}` + (isCustom ? "" : ` <span class="muted mono">(${bag.esc(cron)})</span>`);
        }
      };
      ["sched-preset", "sched-hour", "sched-minute", "sched-dow", "sched-action"].forEach((id) => {
        document.getElementById(id)?.addEventListener("change", syncUi);
      });
      document.getElementById("sched-cron")?.addEventListener("input", syncUi);
      syncUi();
      const close = () => {
        slot.innerHTML = "";
      };
      document.getElementById("cancel-sched").onclick = close;
      document.getElementById("cancel-sched-2").onclick = close;
      bag.onBusyClick(document.getElementById("save-sched"), async () => {
        const errBox = document.getElementById("sched-form-err");
        errBox.innerHTML = "";
        const name = document.getElementById("sched-name").value.trim();
        const action = document.getElementById("sched-action").value;
        const cron = bag.buildFriendlyCron({
          preset: document.getElementById("sched-preset").value,
          hour: document.getElementById("sched-hour").value,
          minute: document.getElementById("sched-minute").value,
          dow: document.getElementById("sched-dow").value,
          custom: document.getElementById("sched-cron").value
        });
        if (!name) {
          errBox.innerHTML = `<div class="error-box">Indiquez un nom.</div>`;
          return;
        }
        if (!cron) {
          errBox.innerHTML = `<div class="error-box">Indiquez quand ex\xE9cuter l\u2019action.</div>`;
          return;
        }
        try {
          await bag.Api.createSchedule({
            StackId: stack.Id,
            Name: name,
            Action: action,
            Cron: cron
          });
          close();
          if (typeof onSaved === "function") await onSaved();
        } catch (err) {
          errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
        }
      }, { disableSiblings: false, minMs: 250 });
    };
    bag.viewStackDetail = async function viewStackDetail(id) {
      if (id === "new") {
        bag.showStackEditor();
        return;
      }
      const [stack, file] = await Promise.all([bag.Api.stack(id), bag.Api.stackFile(id)]);
      const stLabel = Number(stack.Status) === 1 ? "running" : "exited";
      const stackRunning = stLabel === "running";
      bag.root.innerHTML = bag.shell(`Stack \xB7 ${stack.Name}`, `
      ${bag.pageHeader(stack.Name, false)}
      <div class="toolbar">
        ${bag.iconBtn({ tag: "a", href: "#stacks", title: "Retour", icon: "back" })}
        <div class="quick-actions">
          ${bag.iconBtn({ act: "start", id: stack.Id, title: "D\xE9marrer", icon: "start", success: !stackRunning })}
          ${bag.iconBtn({ act: "stop", id: stack.Id, title: "Arr\xEAter", icon: "stop", danger: stackRunning })}
          ${bag.iconBtn({ act: "restart", id: stack.Id, title: "Red\xE9marrer", icon: "restart" })}
          ${bag.iconBtn({ elId: "edit", title: "\xC9diteur", icon: "edit", info: true })}
          ${bag.iconBtn({ title: "Partager", icon: "users", info: true, shareType: "stack", shareKey: String(stack.Id) })}
          ${bag.iconBtn({ elId: "stack-pull-redeploy", title: "Pull images + red\xE9ployer", icon: "pull" })}
          ${bag.iconBtn({ act: "remove", id: stack.Id, title: "Supprimer", icon: "remove", danger: true })}
        </div>
      </div>
      <div id="stack-detail-err"></div>
      <div class="panel" style="margin-bottom:1rem">
        <dl class="kv">
          <dt>Id</dt><dd>${stack.Id}</dd>
          <dt>Type</dt><dd>Compose</dd>
          <dt>Statut</dt><dd>${bag.badge(stLabel)}</dd>
          <dt>Images</dt><dd id="stack-upd-summary"><span class="img-upd is-loading" title="V\xE9rification\u2026"><span class="img-upd-dot"></span><span class="img-upd-lbl">\u2026</span></span></dd>
          <dt>N\u0153ud</dt><dd>${bag.esc(bag.endpointLabel(stack.EndpointId))} <span class="muted">(#${bag.esc(stack.EndpointId)})</span></dd>
        </dl>
      </div>
      <div class="section-title">Conteneurs</div>
      <div class="table-wrap" style="margin-bottom:1rem">
        <table class="data" id="stack-containers-table">
          <thead><tr><th>Service</th><th>Nom</th><th>\xC9tat</th><th>Image</th><th>Ports</th><th></th></tr></thead>
          <tbody><tr><td colspan="6" class="muted">Chargement\u2026</td></tr></tbody>
        </table>
      </div>
      <div class="section-title">Images des services</div>
      <div class="table-wrap" style="margin-bottom:1rem">
        <table class="data" id="stack-upd-table">
          <thead><tr><th>Service</th><th>Image</th><th>\xC9tat</th><th>Actuel</th><th>Propos\xE9</th></tr></thead>
          <tbody><tr><td colspan="5" class="muted">V\xE9rification des digests\u2026</td></tr></tbody>
        </table>
      </div>
      <div class="section-title">Fichier Compose</div>
      <pre class="compose-preview cm-s-wharf" id="compose-preview" style="margin-bottom:1rem"></pre>
      <div class="section-title">Planifications</div>
      <div class="toolbar" style="margin-bottom:8px">
        ${bag.createBtn("add-schedule", "Nouvelle planification")}
      </div>
      <div class="table-wrap" style="margin-bottom:1rem">
        <table class="data" id="stack-sched-table">
          <thead><tr><th>Nom</th><th>Action</th><th>Quand</th><th>Prochain</th><th>Dernier</th><th></th></tr></thead>
          <tbody><tr><td colspan="6" class="muted">Chargement\u2026</td></tr></tbody>
        </table>
      </div>
      <div class="section-title">Export</div>
      <div class="toolbar" style="margin-bottom:8px; flex-wrap:wrap; gap:10px; align-items:center">
        <button type="button" class="btn btn-primary" id="stack-export">Exporter compose + volumes</button>
        <span class="muted" style="font-size:12.5px">ZIP : docker-compose, .env, donn\xE9es des volumes et binds</span>
      </div>
      <div id="stack-export-status" style="margin-bottom:1rem"></div>
      <div id="sched-modal"></div>`);
      const preview = document.getElementById("compose-preview");
      const composeText = file.StackFileContent || "";
      if (preview) {
        if (typeof CodeMirror !== "undefined" && CodeMirror.runMode) {
          CodeMirror.runMode(composeText, "yaml", preview);
        } else {
          preview.textContent = composeText;
        }
      }
      const editBtn = document.getElementById("edit");
      if (editBtn) {
        editBtn.onclick = () => bag.showStackEditor({ Id: stack.Id, Name: stack.Name, content: file.StackFileContent, Env: stack.Env || [] });
      }
      bag.onBusyClick(document.getElementById("stack-export"), async () => {
        const status = document.getElementById("stack-export-status");
        const setStatus = (html) => {
          if (status) status.innerHTML = html;
        };
        setStatus(`<div class="info-box">Pr\xE9paration de l\u2019export (compose + volumes)\u2026 cela peut prendre un moment.</div>`);
        try {
          const res = await bag.Api.downloadStackExport(stack.Id);
          const sizeMo = res?.size ? ` (${(res.size / (1e3 * 1e3)).toFixed(1)} Mo)` : "";
          setStatus(`<div class="info-box">Export t\xE9l\xE9charg\xE9${res?.filename ? ` : <span class="mono">${bag.esc(res.filename)}</span>` : ""}${sizeMo}.</div>`);
        } catch (err) {
          setStatus(`<div class="error-box">${bag.esc(err.message || String(err))}</div>`);
          throw err;
        }
      }, { minMs: 400, disableSiblings: false });
      bag.onBusyClick(document.getElementById("stack-pull-redeploy"), async (el) => {
        const errBox = document.getElementById("stack-detail-err");
        const focus = bag.captureListFocus(el);
        if (errBox) errBox.innerHTML = "";
        try {
          await bag.Api.updateStack(stack.Id, file.StackFileContent || "", stack.Env || [], true);
          if (errBox) errBox.innerHTML = `<div class="info-box">Images tir\xE9es et stack red\xE9ploy\xE9e.</div>`;
          await bag.viewStackDetail(id);
          bag.restoreListFocus(focus);
        } catch (err) {
          if (errBox) errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
        }
      }, { minMs: 400 });
      bag.bindShareButtons();
      bag.bindMoreActions();
      bag.root.querySelectorAll("[data-act]").forEach((btn) => {
        const act = btn.dataset.act;
        const confirmMsg = act === "remove" ? "Supprimer la stack et ses conteneurs ?" : null;
        bag.onBusyClick(btn, async (el) => {
          const sid = el.dataset.id;
          const focus = bag.captureListFocus(el);
          if (act === "start") await bag.Api.startStack(sid);
          else if (act === "stop") await bag.Api.stopStack(sid);
          else if (act === "restart") await bag.Api.restartStack(sid);
          else if (act === "remove") {
            await bag.Api.deleteStack(sid);
            location.hash = "#stacks";
            return "navigated";
          }
          await bag.viewStackDetail(id);
          bag.restoreListFocus(focus);
        }, { confirm: confirmMsg, minMs: 300 });
      });
      const renderSchedules = async () => {
        const tb = document.querySelector("#stack-sched-table tbody");
        if (!tb) return;
        try {
          const res = await bag.Api.schedules({ stackId: stack.Id });
          const items = res.Items || [];
          if (!items.length) {
            tb.innerHTML = `<tr><td colspan="6" class="muted">Aucune planification</td></tr>`;
            return;
          }
          tb.innerHTML = items.map((s) => `<tr>
          <td>${bag.esc(s.Name)}${s.Enabled ? "" : ' <span class="muted">(off)</span>'}</td>
          <td>${bag.esc(bag.schedActionLabel(s.Action))}</td>
          <td><span title="${bag.esc(s.Cron)}">${bag.esc(bag.describeCron(s.Cron))}</span></td>
          <td class="muted">${bag.esc(bag.fmtTs(s.NextRunAt))}</td>
          <td class="muted">${bag.esc(s.LastStatus || "\u2014")} ${s.LastRunAt ? "\xB7 " + bag.fmtTs(s.LastRunAt) : ""}</td>
          <td class="actions"><div class="quick-actions">
            ${bag.iconBtn({ runSched: s.Id, title: "Ex\xE9cuter maintenant", icon: "start", success: true })}
            ${bag.iconBtn({ delSched: s.Id, title: "Supprimer", icon: "remove", danger: true })}
          </div></td>
        </tr>`).join("");
          tb.querySelectorAll("[data-run-sched]").forEach((btn) => {
            bag.onBusyClick(btn, async (el) => {
              await bag.Api.runSchedule(el.dataset.runSched);
              await renderSchedules();
            }, { minMs: 300 });
          });
          tb.querySelectorAll("[data-del-sched]").forEach((btn) => {
            bag.onBusyClick(btn, async (el) => {
              await bag.Api.deleteSchedule(el.dataset.delSched);
              await renderSchedules();
            }, { confirm: "Supprimer cette planification ?", minMs: 250 });
          });
        } catch (err) {
          tb.innerHTML = `<tr><td colspan="6" class="error-box">${bag.esc(err.message)}</td></tr>`;
        }
      };
      document.getElementById("add-schedule").onclick = () => bag.openScheduleModal(stack, renderSchedules);
      renderSchedules();
      const renderStackContainers = async () => {
        const tb = document.querySelector("#stack-containers-table tbody");
        if (!tb) return;
        try {
          const ep = Number(stack.EndpointId) || bag.Api.getEndpointId();
          const project = String(stack.Name || "").trim();
          const filters = encodeURIComponent(JSON.stringify({
            label: [`com.docker.compose.project=${project}`]
          }));
          let list = await bag.Api.dockerOn(ep, `/containers/json?all=true&filters=${filters}`);
          if (!Array.isArray(list)) list = [];
          if (!list.length && project) {
            const all = await bag.Api.dockerOn(ep, "/containers/json?all=true");
            const want = project.toLowerCase();
            list = (Array.isArray(all) ? all : []).filter((c) => {
              const labels = c.Labels || {};
              return String(labels["com.docker.compose.project"] || "").toLowerCase() === want;
            });
          }
          list.sort((a, b) => {
            const sa = String((a.Labels || {})["com.docker.compose.service"] || "");
            const sb = String((b.Labels || {})["com.docker.compose.service"] || "");
            return sa.localeCompare(sb) || String(a.Names?.[0] || "").localeCompare(String(b.Names?.[0] || ""));
          });
          if (!list.length) {
            tb.innerHTML = `<tr><td colspan="6" class="muted">Aucun conteneur pour le projet Compose \xAB ${bag.esc(project)} \xBB</td></tr>`;
            return;
          }
          tb.innerHTML = list.map((c) => {
            const name = c.Names && c.Names[0] ? c.Names[0].replace(/^\//, "") : bag.shortId(c.Id);
            const labels = c.Labels || {};
            const service = labels["com.docker.compose.service"] || "\u2014";
            const st = String(c.State || "").toLowerCase();
            const isRunning = st === "running" || st === "restarting";
            const openHref = `#containers/${bag.esc(c.Id)}`;
            return `<tr data-container-id="${bag.esc(c.Id)}">
            <td class="mono">${bag.esc(service)}</td>
            <td class="name-cell">
              <strong><a href="${openHref}" data-switch-node="${bag.esc(ep)}">${bag.esc(name)}</a></strong>
              <span class="id">${bag.esc(bag.shortId(c.Id))}</span>
            </td>
            <td>${bag.badge(c.State)}</td>
            <td class="mono">${bag.esc(c.Image || "")}</td>
            <td>${bag.formatPorts(c.Ports || [], ep)}</td>
            <td class="actions"><div class="quick-actions">
              ${bag.iconBtn({ act: "start", id: c.Id, title: "D\xE9marrer", icon: "start", success: !isRunning })}
              ${bag.iconBtn({ act: "stop", id: c.Id, title: "Arr\xEAter", icon: "stop", danger: isRunning })}
              ${bag.iconBtn({ act: "restart", id: c.Id, title: "Red\xE9marrer", icon: "restart" })}
              ${bag.iconBtn({
              modal: "stats",
              id: c.Id,
              name,
              running: isRunning,
              title: isRunning ? "CPU / RAM / R\xE9seau" : "Conteneur arr\xEAt\xE9",
              icon: "stats",
              statsId: c.Id,
              extraClass: isRunning ? "is-stats-ok" : "is-stats-off"
            })}
              ${bag.iconBtn({ modal: "logs", id: c.Id, name, running: isRunning, title: "Logs", icon: "logs" })}
              ${bag.iconBtn({ modal: "console", id: c.Id, name, running: isRunning, title: "Console", icon: "console" })}
              ${bag.iconBtn({ modal: "inspect", id: c.Id, name, running: isRunning, title: "Inspecter", icon: "inspect" })}
              ${bag.iconBtn({ title: "Partager", icon: "users", info: true, shareType: "container", shareKey: name || c.Id })}
              ${bag.iconBtn({ act: "remove", id: c.Id, title: "Supprimer", icon: "remove", danger: true })}
            </div></td>
          </tr>`;
          }).join("");
          const nid = Number(stack.EndpointId) || bag.Api.getEndpointId();
          if (Number.isFinite(nid) && nid > 0) bag.Api.setEndpointId(nid);
          tb.querySelectorAll("[data-switch-node]").forEach((a) => {
            a.addEventListener("click", () => {
              const n = parseInt(a.getAttribute("data-switch-node"), 10);
              if (Number.isFinite(n) && n > 0) bag.Api.setEndpointId(n);
            });
          });
          bag.bindModalActions(tb);
          bag.bindShareButtons(tb);
          tb.querySelectorAll("[data-act]").forEach((btn) => {
            const act = btn.dataset.act;
            bag.onBusyClick(btn, async (el) => {
              const n = Number(stack.EndpointId) || bag.Api.getEndpointId();
              if (Number.isFinite(n) && n > 0) bag.Api.setEndpointId(n);
              await bag.containerAction(el.dataset.id, act);
              await renderStackContainers();
            }, {
              confirm: act === "remove" ? "Supprimer ce conteneur ?" : null,
              minMs: 300
            });
          });
        } catch (err) {
          tb.innerHTML = `<tr><td colspan="6" class="error-box">${bag.esc(err.message || "Impossible de lister les conteneurs")}</td></tr>`;
        }
      };
      void renderStackContainers();
      try {
        const upd = await bag.Api.stackUpdate(id);
        const sum = document.getElementById("stack-upd-summary");
        if (sum) {
          sum.innerHTML = bag.stackUpdatePill(
            upd.Status,
            upd.UpdateCount || 0,
            `${upd.Checked || 0} image(s) contr\xF4l\xE9e(s)`,
            { action: "stack", id }
          );
        }
        const tb = document.querySelector("#stack-upd-table tbody");
        const imgs = upd.Images || [];
        if (tb) {
          if (!imgs.length) {
            tb.innerHTML = `<tr><td colspan="5" class="muted">Aucune image \xE0 contr\xF4ler</td></tr>`;
          } else {
            tb.innerHTML = imgs.map((i) => {
              const ver = bag.formatImageUpdateVersions(i);
              const name = i.ImageName || String(i.Image || "").replace(/:.*$/, "");
              const tip = [i.Image, ver].filter(Boolean).join("\n");
              const actuel = String(i.LocalVersion || "").trim() || "\u2014";
              const propose = i.Status === "update" ? String(i.RemoteVersion || "").trim() || "\u2014" : "\u2014";
              return `<tr>
            <td class="mono">${bag.esc(i.Service)}</td>
            <td class="mono">${bag.esc(i.Image)}</td>
            <td>${bag.stackUpdatePill(i.Status, i.Status === "update" ? 1 : 0, tip, {
                action: i.Status === "update" ? "stack" : null,
                id
              })}</td>
            <td class="mono">${bag.esc(actuel)}</td>
            <td class="mono">${bag.esc(propose)}</td>
          </tr>`;
            }).join("");
          }
        }
        bag.bindImageUpdateActions(bag.root);
      } catch (err) {
        const sum = document.getElementById("stack-upd-summary");
        if (sum) sum.innerHTML = bag.stackUpdatePill("unknown", 0, err.message || "Erreur");
        const tb = document.querySelector("#stack-upd-table tbody");
        if (tb) tb.innerHTML = `<tr><td colspan="5" class="error-box">${bag.esc(err.message || "Contr\xF4le impossible")}</td></tr>`;
      }
    };
  }

  // public/assets/js/src/views/registries.js
  function install11() {
    bag.registryHost = function registryHost(reg) {
      return String(reg?.URL || "").replace(/^https?:\/\//i, "").replace(/\/$/, "");
    };
    bag.registryImageRef = function registryImageRef(reg, repo, tag) {
      const t = tag || "latest";
      if (bag.registryKind(reg) === "hub") return `${repo}:${t}`;
      return `${bag.registryHost(reg)}/${repo}:${t}`;
    };
    bag.openCreateRegistryModal = function openCreateRegistryModal() {
      bag.openRegistryModal(null);
    };
    bag.openEditRegistryModal = function openEditRegistryModal(reg) {
      bag.openRegistryModal(reg);
    };
    bag.openRegistryModal = function openRegistryModal(existing) {
      const isEdit = !!(existing && existing.Id);
      bag.closeAppModal();
      const host = bag.modalHost();
      const type = bag.registryKind(existing) === "hub" ? "hub" : "v2";
      host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-form" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3>${isEdit ? "Modifier le registre" : "Ajouter un registre"}</h3>
              <div class="modal-sub">Docker Hub ou Registry V2 (http/https)</div>
            </div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">\u2715</button>
          </div>
          <div id="create-err"></div>
          <div class="form-group">
            <label class="field-label">Nom <span class="req">*</span></label>
            <input id="r-name" placeholder="Mon registre" autocomplete="off" value="${bag.esc(existing?.Name || "")}">
          </div>
          <div class="form-group">
            <label class="field-label">Type</label>
            <select id="r-type" class="select-block">
              <option value="hub"${type === "hub" ? " selected" : ""}>Docker Hub</option>
              <option value="v2"${type === "v2" ? " selected" : ""}>Registry V2</option>
            </select>
          </div>
          <div class="form-group" id="r-url-wrap">
            <label class="field-label">URL <span class="req">*</span></label>
            <input id="r-url" placeholder="http://192.168.1.10:5000 ou https://registry.example.com" autocomplete="off" value="${bag.esc(type === "hub" ? "https://docker.io" : existing?.URL || "")}">
            <p class="field-hint muted">Ex. registre local : <code>http://192.168.1.254:5000</code></p>
          </div>
          <div class="form-group">
            <label class="field-label">Utilisateur / e-mail</label>
            <input id="r-user" placeholder="user ou email@domaine.tld" autocomplete="username" value="${bag.esc(existing?.Username || "")}">
          </div>
          <div class="form-group">
            <label class="field-label">Mot de passe / jeton (PAT)</label>
            <input id="r-pass" type="password" placeholder="${isEdit ? "Laisser vide pour ne pas changer" : "optionnel"}" autocomplete="${isEdit ? "new-password" : "current-password"}">
            <p class="field-hint muted">E-mail + jeton accept\xE9s (Docker Hub, Harness/Gitness, Registry V2).</p>
            ${isEdit && existing?.Authentication ? '<p class="field-hint muted">Un secret est d\xE9j\xE0 enregistr\xE9. Laissez vide pour le conserver.</p>' : ""}
          </div>
          ${isEdit ? `<div class="form-group">
            <label class="field-inline" style="gap:8px;cursor:pointer">
              <input type="checkbox" id="r-clear-pass">
              <span>Effacer le mot de passe enregistr\xE9</span>
            </label>
          </div>` : ""}
          <div class="actions-bar">
            <button type="button" class="btn btn-primary" id="r-save">${isEdit ? "Enregistrer" : "Ajouter"}</button>
            <button type="button" class="btn" data-close-modal>Annuler</button>
          </div>
        </div>
      </div>`;
      bag.bindAppModalChrome();
      const typeSel = document.getElementById("r-type");
      const urlWrap = document.getElementById("r-url-wrap");
      const urlInput = document.getElementById("r-url");
      const syncType = () => {
        const hub = typeSel.value === "hub";
        urlWrap.hidden = hub;
        if (hub) urlInput.value = "https://docker.io";
        else if (urlInput.value === "https://docker.io") urlInput.value = existing?.URL && bag.registryKind(existing) !== "hub" ? existing.URL : "";
      };
      typeSel.addEventListener("change", syncType);
      syncType();
      document.getElementById("r-name")?.focus();
      bag.onBusyClick(document.getElementById("r-save"), async () => {
        const errBox = document.getElementById("create-err");
        errBox.innerHTML = "";
        const Name = document.getElementById("r-name").value.trim();
        const Type = document.getElementById("r-type").value;
        const URL2 = Type === "hub" ? "https://docker.io" : document.getElementById("r-url").value.trim();
        const Username = document.getElementById("r-user").value.trim();
        const Password = document.getElementById("r-pass").value;
        const ClearPassword = !!document.getElementById("r-clear-pass")?.checked;
        if (!Name || !URL2) {
          errBox.innerHTML = `<div class="error-box">Le nom et l\u2019URL sont requis.</div>`;
          return;
        }
        try {
          if (isEdit) {
            const payload = { Name, URL: URL2, Type, Username };
            if (ClearPassword) payload.ClearPassword = true;
            else if (Password) payload.Password = Password;
            await bag.Api.updateRegistry(existing.Id, payload);
          } else {
            await bag.Api.createRegistry({ Name, URL: URL2, Type, Username, Password });
          }
          bag.closeAppModal();
          await bag.route();
        } catch (err) {
          errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
        }
      }, { disableSiblings: false, minMs: 300 });
    };
    bag.viewRegistries = async function viewRegistries() {
      const list = await bag.Api.registries();
      const rows = (list || []).map((r) => {
        const kind = bag.registryKind(r);
        const search = `${r.Name} ${r.URL} ${kind} ${r.Username || ""}`.toLowerCase();
        const typeLabel = kind === "hub" ? "Docker Hub" : "Registry V2";
        return `<tr data-search="${bag.esc(search)}">
        <td><a href="#registries/${r.Id}">${bag.esc(r.Name)}</a></td>
        <td class="mono">${bag.esc(r.URL)}</td>
        <td>${bag.esc(typeLabel)}</td>
        <td>${r.Authentication ? bag.esc(r.Username || "authentifi\xE9") : '<span class="muted">anonyme</span>'}</td>
        <td class="actions"><div class="quick-actions">
          ${bag.iconBtn({ tag: "a", href: `#registries/${r.Id}`, title: "Parcourir", icon: "search" })}
          ${bag.iconBtn({ act: "edit-reg", id: r.Id, title: "Modifier", icon: "edit", info: true })}
          ${bag.iconBtn({ del: r.Id, title: "Supprimer", icon: "remove", danger: true })}
        </div></td>
      </tr>`;
      }).join("");
      bag.root.innerHTML = bag.shell("Registres", `
      ${bag.pageHeader("Registres")}
      ${bag.settingsSubnav("registries")}
      <div class="toolbar">
        <input class="search" id="filter" type="search" placeholder="Rechercher des registres\u2026" value="${bag.esc(bag.state.filters.registries || "")}">
        ${bag.createBtn("create-registry", "Ajouter un registre")}
        <div class="spacer"></div>
        <span class="muted mono" id="filter-count">${(list || []).length} / ${(list || []).length}</span>
      </div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Nom</th><th>URL</th><th>Type</th><th>Auth</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5" class="empty">Aucun registre</td></tr>`}</tbody>
      </table></div>`, { subtitle: "Connexion aux registres d\u2019images" });
      bag.bindRefresh();
      bag.bindSearch("registries");
      document.getElementById("create-registry").onclick = () => bag.openCreateRegistryModal();
      const byId = new Map((list || []).map((r) => [String(r.Id), r]));
      bag.root.querySelectorAll('[data-act="edit-reg"]').forEach((btn) => {
        btn.addEventListener("click", () => {
          const reg = byId.get(String(btn.dataset.id));
          if (reg) bag.openEditRegistryModal(reg);
        });
      });
      bag.root.querySelectorAll("[data-del]").forEach((btn) => {
        bag.onBusyClick(btn, async (el) => {
          await bag.Api.deleteRegistry(el.dataset.del);
        }, { confirm: "Supprimer ce registre ?", reload: true });
      });
    };
    bag.viewRegistryBrowse = async function viewRegistryBrowse(id) {
      const reg = await bag.Api.registry(id);
      let selectedRepo = "";
      let searchTimer = null;
      bag.root.innerHTML = bag.shell(`Registre \xB7 ${reg.Name}`, `
      ${bag.pageHeader(reg.Name, false)}
      ${bag.settingsSubnav("registries")}
      <div class="toolbar">
        ${bag.iconBtn({ tag: "a", href: "#registries", title: "Retour", icon: "back" })}
        ${bag.iconBtn({ elId: "reg-edit", title: "Modifier la config", icon: "edit", info: true })}
        <div class="spacer"></div>
        <span class="muted mono">${bag.esc(reg.URL)} \xB7 ${bag.registryKind(reg) === "hub" ? "Docker Hub" : "V2"}</span>
      </div>
      <div id="reg-err"></div>
      <div class="reg-browse">
        <div class="reg-pane">
          <div class="reg-pane-head">
            <label class="field-label">D\xE9p\xF4ts</label>
            <input class="search" id="reg-q" type="search" placeholder="${bag.registryKind(reg) === "hub" ? "Rechercher sur Docker Hub\u2026" : "Filtrer le catalogue\u2026"}" autocomplete="off">
          </div>
          <div class="reg-list" id="reg-repos"><div class="muted" style="padding:12px">Chargement\u2026</div></div>
        </div>
        <div class="reg-pane">
          <div class="reg-pane-head">
            <label class="field-label">Tags <span class="muted" id="reg-repo-label"></span></label>
          </div>
          <div class="reg-list" id="reg-tags"><div class="muted" style="padding:12px">S\xE9lectionnez un d\xE9p\xF4t</div></div>
        </div>
      </div>`, { subtitle: "Parcourir les images" });
      const errBox = document.getElementById("reg-err");
      const reposEl = document.getElementById("reg-repos");
      const tagsEl = document.getElementById("reg-tags");
      const repoLabel = document.getElementById("reg-repo-label");
      const qInput = document.getElementById("reg-q");
      document.getElementById("reg-edit")?.addEventListener("click", () => bag.openEditRegistryModal(reg));
      async function loadTags(repo) {
        selectedRepo = repo;
        repoLabel.textContent = repo ? `\xB7 ${repo}` : "";
        tagsEl.innerHTML = `<div class="muted" style="padding:12px">Chargement des tags\u2026</div>`;
        try {
          const data = await bag.Api.registryTags(id, repo);
          const tags = data?.Tags || [];
          if (!tags.length) {
            tagsEl.innerHTML = `<div class="muted" style="padding:12px">Aucun tag</div>`;
            return;
          }
          tagsEl.innerHTML = tags.map((t) => {
            const ref = bag.registryImageRef(reg, repo, t.Name);
            const meta = [
              t.Size ? bag.formatBytes(t.Size) : "",
              t.LastUpdated ? new Date(t.LastUpdated).toLocaleDateString() : ""
            ].filter(Boolean).join(" \xB7 ");
            return `<div class="reg-item">
            <div class="reg-item-main">
              <div class="mono">${bag.esc(t.Name)}</div>
              ${meta ? `<div class="muted" style="font-size:12px">${bag.esc(meta)}</div>` : ""}
            </div>
            <div class="quick-actions">
              <button type="button" class="btn btn-icon btn-sm" title="Pull ${bag.esc(ref)}" aria-label="Pull" data-repo="${bag.esc(repo)}" data-tag="${bag.esc(t.Name)}">
                <span class="btn-ico">${bag.ico("pull")}</span>
              </button>
            </div>
          </div>`;
          }).join("");
          tagsEl.querySelectorAll("[data-repo][data-tag]").forEach((btn) => {
            bag.onBusyClick(btn, async (el) => {
              errBox.innerHTML = "";
              const repository = el.getAttribute("data-repo") || "";
              const tag = el.getAttribute("data-tag") || "latest";
              const ref = bag.registryImageRef(reg, repository, tag);
              try {
                await bag.Api.registryPull(id, repository, tag);
                errBox.innerHTML = `<div class="info-box">Pull termin\xE9 : <code>${bag.esc(ref)}</code></div>`;
              } catch (err) {
                errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
              }
            }, { disableSiblings: false, minMs: 300 });
          });
        } catch (err) {
          tagsEl.innerHTML = `<div class="error-box" style="margin:12px">${bag.esc(err.message)}</div>`;
        }
      }
      async function loadRepos(q) {
        reposEl.innerHTML = `<div class="muted" style="padding:12px">Recherche\u2026</div>`;
        try {
          const data = await bag.Api.registryRepos(id, q, 60);
          const repos = data?.Repositories || [];
          if (!repos.length) {
            const hint = bag.registryKind(reg) === "hub" && !q ? "Saisissez un terme pour rechercher sur Docker Hub (ex. nginx), ou ajoutez des identifiants pour lister vos d\xE9p\xF4ts." : q ? "Aucun d\xE9p\xF4t ne correspond au filtre." : "Aucun d\xE9p\xF4t trouv\xE9. V\xE9rifiez e-mail/jeton, ou saisissez le chemin du d\xE9p\xF4t si le registre n\u2019expose pas de catalogue.";
            reposEl.innerHTML = `<div class="muted" style="padding:12px">${bag.esc(hint)}</div>`;
            return;
          }
          reposEl.innerHTML = repos.map((r) => `
          <button type="button" class="reg-item reg-item-btn${selectedRepo === r.Name ? " active" : ""}" data-repo="${bag.esc(r.Name)}">
            <div class="reg-item-main">
              <div class="mono">${bag.esc(r.Name)}${r.Official ? ' <span class="img-selected-badge is-hub">Officiel</span>' : ""}</div>
              ${r.Description ? `<div class="muted reg-item-desc">${bag.esc(r.Description)}</div>` : ""}
            </div>
            ${r.StarCount || r.PullCount ? `<div class="muted" style="font-size:11px;flex-shrink:0">\u2605 ${bag.esc(String(r.StarCount || 0))}</div>` : ""}
          </button>`).join("");
          reposEl.querySelectorAll("[data-repo]").forEach((btn) => {
            btn.addEventListener("click", () => {
              reposEl.querySelectorAll(".reg-item-btn").forEach((b) => b.classList.remove("active"));
              btn.classList.add("active");
              loadTags(btn.getAttribute("data-repo") || "");
            });
          });
        } catch (err) {
          reposEl.innerHTML = `<div class="error-box" style="margin:12px">${bag.esc(err.message)}</div>`;
        }
      }
      qInput?.addEventListener("input", () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => loadRepos(qInput.value.trim()), 320);
      });
      await loadRepos("");
    };
    bag.registryKind = function registryKind(reg) {
      if (!reg) return "v2";
      if (reg.RegistryKind) return String(reg.RegistryKind);
      if (reg.Type === "hub" || Number(reg.Type) === 6) return "hub";
      if (reg.Type === "v2" || Number(reg.Type) === 3) return "v2";
      return String(reg.Type || "v2");
    };
  }

  // public/assets/js/src/views/nodes.js
  function install12() {
    bag.nodeStatusLabel = function nodeStatusLabel(nodeOrStatus, disabled) {
      if (nodeOrStatus && typeof nodeOrStatus === "object") {
        disabled = !!nodeOrStatus.Disabled;
        nodeOrStatus = nodeOrStatus.Status;
      }
      if (disabled) return '<span class="badge badge-muted">D\xE9sactiv\xE9</span>';
      const s = Number(nodeOrStatus);
      if (s === 1) return '<span class="badge badge-success">En ligne</span>';
      return '<span class="badge badge-warn">Hors ligne</span>';
    };
    bag.openEditNodeModal = function openEditNodeModal(node) {
      if (!node?.Id) return;
      bag.closeAppModal();
      const isAgent = node.Kind === "agent";
      const host = bag.modalHost();
      host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-form" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3>Modifier le n\u0153ud</h3>
              <div class="modal-sub">${isAgent ? "Agent distant" : "N\u0153ud local"} \xB7 #${bag.esc(node.Id)}</div>
            </div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">\u2715</button>
          </div>
          <div id="edit-node-err"></div>
          <div class="form-group">
            <label class="field-label">Nom <span class="req">*</span></label>
            <input id="n-name" value="${bag.esc(node.NodeName || node.Name || "")}" placeholder="serveur-atelier" autocomplete="off" spellcheck="false">
          </div>
          ${isAgent ? `
          <div class="form-group">
            <label class="field-label">URL agent <span class="req">*</span></label>
            <input id="n-agent-url" value="${bag.esc(node.AgentURL || node.URL || "")}" placeholder="https://192.168.1.5:9001" autocomplete="off" spellcheck="false">
            <p class="field-hint muted">Changer l\u2019URL r\xE9initialise l\u2019empreinte TLS (re-pin au prochain ping).</p>
          </div>
          <label class="check-row"><input type="checkbox" id="n-clear-pin"> Forcer le reset de l\u2019empreinte TLS</label>
          ` : ""}
          <div class="form-group">
            <label class="field-label">URL h\xF4te des ports (optionnel)</label>
            <input id="n-public-url" value="${bag.esc(node.PublicURL || "")}" placeholder="https://nas.lan" autocomplete="off" spellcheck="false">
            <p class="field-hint muted">Surcharge l\u2019\xAB URL h\xF4te des ports \xBB globale pour les liens cliquables de ce n\u0153ud (pas l\u2019URL WharfMaster).</p>
          </div>
          <div class="actions-bar">
            <button type="button" class="btn btn-primary" id="n-save">Enregistrer</button>
            <button type="button" class="btn" data-close-modal>Annuler</button>
          </div>
        </div>
      </div>`;
      bag.bindAppModalChrome();
      document.getElementById("n-name")?.focus();
      bag.onBusyClick(document.getElementById("n-save"), async () => {
        const errBox = document.getElementById("edit-node-err");
        errBox.innerHTML = "";
        const Name = document.getElementById("n-name").value.trim();
        const PublicURL = document.getElementById("n-public-url").value.trim();
        if (!Name || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(Name)) {
          errBox.innerHTML = `<div class="error-box">Nom invalide (lettres, chiffres, . _ - ; 1\u201364 caract\xE8res).</div>`;
          return;
        }
        const payload = { NodeName: Name, Name, PublicURL };
        if (isAgent) {
          const AgentURL = document.getElementById("n-agent-url").value.trim();
          if (!AgentURL || !/^https?:\/\//i.test(AgentURL)) {
            errBox.innerHTML = `<div class="error-box">URL agent invalide (http:// ou https://).</div>`;
            return;
          }
          payload.AgentURL = AgentURL.replace(/\/$/, "");
          if (document.getElementById("n-clear-pin")?.checked) payload.ClearTlsPin = true;
        }
        try {
          await bag.Api.updateNode(node.Id, payload);
          bag.closeAppModal();
          try {
            const n = await bag.Api.nodes();
            bag.state.endpoints = n?.Items || bag.state.endpoints;
          } catch (_) {
          }
          await bag.viewNodes();
        } catch (err) {
          errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
        }
      }, { disableSiblings: false, minMs: 250 });
    };
    bag.openAddNodeModal = function openAddNodeModal(tokenMeta) {
      bag.closeAppModal();
      const draft = bag.state._joinDraft || { host: "", name: "", port: "9001" };
      const tokenBox = tokenMeta ? `<div class="info-box" style="margin-bottom:12px">
          Token actif : <code>${bag.esc(tokenMeta.Hint)}</code>
          \xB7 expire ${bag.esc(bag.formatAuditTime(tokenMeta.ExpiresAt))}
          \xB7 utilisations ${bag.esc(tokenMeta.UseCount)}${tokenMeta.MaxUses != null ? " / " + bag.esc(tokenMeta.MaxUses) : ""}
          <div class="muted" style="margin-top:6px">Le secret complet n\u2019est affich\xE9 qu\u2019\xE0 la g\xE9n\xE9ration / rotation.</div>
        </div>` : `<div class="info-box" style="margin-bottom:12px">Aucun token de jointure actif \u2014 g\xE9n\xE9rez-en un pour enr\xF4ler un n\u0153ud.</div>`;
      const host = bag.modalHost();
      host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-form modal-form-wide" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3>Ajouter un n\u0153ud</h3>
              <div class="modal-sub">IP / hostname distant \u2192 commande d\u2019install HTTPS</div>
            </div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">\u2715</button>
          </div>
          <p class="muted" style="margin:0 0 12px">Indiquez l\u2019IP (ou hostname) de la machine distante et le nom du n\u0153ud, puis g\xE9n\xE9rez le token : la commande d\u2019install HTTPS sera pr\xEAte \xE0 copier-coller.</p>
          ${tokenBox}
          <div id="join-form-err"></div>
          <div class="form-row-2" style="align-items:end">
            <div class="form-group" style="margin:0">
              <label class="field-label" for="join-node-host">IP / hostname de la machine</label>
              <input type="text" id="join-node-host" placeholder="192.168.1.5" value="${bag.esc(draft.host)}" autocomplete="off" spellcheck="false">
            </div>
            <div class="form-group" style="margin:0">
              <label class="field-label" for="join-node-name">Nom du n\u0153ud</label>
              <input type="text" id="join-node-name" placeholder="serveur-atelier" value="${bag.esc(draft.name)}" autocomplete="off" spellcheck="false">
            </div>
          </div>
          <div class="form-group" style="margin-top:12px;max-width:140px">
            <label class="field-label" for="join-node-port">Port agent</label>
            <input type="number" id="join-node-port" min="1" max="65535" value="${bag.esc(draft.port || "9001")}">
          </div>
          <div id="join-token-out" style="margin-top:12px"></div>
          <div class="actions-bar">
            <button type="button" class="btn btn-primary" id="gen-join-token">G\xE9n\xE9rer la commande</button>
            <button type="button" class="btn" data-close-modal>Fermer</button>
          </div>
        </div>
      </div>`;
      bag.bindAppModalChrome();
      const readJoinDraft = () => {
        const h = (document.getElementById("join-node-host")?.value || "").trim();
        const name = (document.getElementById("join-node-name")?.value || "").trim();
        const portRaw = (document.getElementById("join-node-port")?.value || "9001").trim();
        const port = Number(portRaw) || 9001;
        bag.state._joinDraft = { host: h, name, port: String(port) };
        return { host: h, name, port };
      };
      const validateJoinDraft = () => {
        const errEl = document.getElementById("join-form-err");
        const { host: h, name, port } = readJoinDraft();
        let msg = "";
        if (!h) msg = "Indiquez l\u2019IP ou le hostname de la machine distante.";
        else if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name)) {
          msg = "Nom de n\u0153ud invalide (lettres, chiffres, . _ - ; 1\u201364 caract\xE8res).";
        } else if (port < 1 || port > 65535) msg = "Port agent invalide.";
        if (errEl) {
          errEl.innerHTML = msg ? `<div class="error-box">${bag.esc(msg)}</div>` : "";
        }
        return msg ? null : { host: h, name, port };
      };
      const showToken = (data) => {
        const out = document.getElementById("join-token-out");
        if (!out || !data?.Token) return;
        const cmd = data.InstallCommand || "";
        const adv = data.AdvertiseURL || "";
        out.innerHTML = `
        <div class="info-box">
          <div class="muted" style="margin-bottom:8px">
            N\u0153ud <strong>${bag.esc(data.NodeName || "\u2014")}</strong>
            \xB7 advertise <code>${bag.esc(adv)}</code>
            \xB7 expire ${bag.esc(bag.formatAuditTime(data.ExpiresAt))}
          </div>
          <strong>Commande \xE0 ex\xE9cuter sur la machine distante</strong>
          <pre class="mono" id="join-cmd" style="white-space:pre-wrap;margin:8px 0;user-select:all">${bag.esc(cmd)}</pre>
          <p class="muted" style="margin:10px 0 6px">Ou d\xE9ploiement manuel : ZIP avec Dockerfile, docker-compose, sources et <code>.env</code> pr\xE9rempli.</p>
          <div class="toolbar" style="gap:8px;flex-wrap:wrap">
            <button type="button" class="btn btn-sm btn-primary" id="copy-join-cmd">Copier la commande</button>
            <button type="button" class="btn btn-sm btn-info" id="dl-agent-bundle">T\xE9l\xE9charger le pack ZIP</button>
            <button type="button" class="btn btn-sm" id="show-join-token">Afficher le token</button>
          </div>
          <pre class="mono" id="join-token-raw" style="display:none;white-space:pre-wrap;margin:8px 0 0">${bag.esc(data.Token)}</pre>
        </div>`;
        document.getElementById("copy-join-cmd")?.addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(cmd || data.Token);
            const btn = document.getElementById("copy-join-cmd");
            if (btn) {
              const prev = btn.textContent;
              btn.textContent = "Copi\xE9";
              setTimeout(() => {
                btn.textContent = prev;
              }, 1400);
            }
          } catch (_) {
          }
        });
        document.getElementById("dl-agent-bundle")?.addEventListener("click", async () => {
          const btn = document.getElementById("dl-agent-bundle");
          const prev = btn?.textContent || "";
          if (btn) {
            btn.disabled = true;
            btn.textContent = "Pr\xE9paration\u2026";
          }
          try {
            await bag.Api.downloadAgentBundle({
              Token: data.Token,
              NodeHost: data.NodeHost || "",
              NodeName: data.NodeName || "",
              NodePort: data.NodePort || 9001,
              PublicURL: data.PublicURL || "",
              AdvertiseURL: data.AdvertiseURL || ""
            });
            if (btn) btn.textContent = "T\xE9l\xE9charg\xE9";
            setTimeout(() => {
              if (btn) {
                btn.textContent = prev;
                btn.disabled = false;
              }
            }, 1600);
          } catch (err) {
            if (btn) {
              btn.textContent = prev;
              btn.disabled = false;
            }
            const errEl = document.getElementById("join-form-err");
            if (errEl) {
              errEl.innerHTML = `<div class="error-box">${bag.esc(err.message || "T\xE9l\xE9chargement impossible")}</div>`;
            }
          }
        });
        document.getElementById("show-join-token")?.addEventListener("click", () => {
          const el = document.getElementById("join-token-raw");
          if (el) el.style.display = el.style.display === "none" ? "" : "none";
        });
      };
      ["join-node-host", "join-node-name", "join-node-port"].forEach((id) => {
        document.getElementById(id)?.addEventListener("change", readJoinDraft);
        document.getElementById(id)?.addEventListener("input", readJoinDraft);
      });
      document.getElementById("join-node-host")?.focus();
      bag.onBusyClick(document.getElementById("gen-join-token"), async () => {
        const draftOk = validateJoinDraft();
        if (!draftOk) return "cancelled";
        const data = await bag.Api.createJoinToken({
          ttlSeconds: 86400,
          nodeHost: draftOk.host,
          nodeName: draftOk.name,
          nodePort: draftOk.port
        });
        showToken(data);
        try {
          const t = await bag.Api.joinTokenMeta();
          bag.state._joinTokenMeta = t?.Active || null;
        } catch (_) {
        }
      }, { disableSiblings: false, minMs: 200 });
    };
    bag.viewNodes = async function viewNodes() {
      let nodes = [];
      let tokenMeta = null;
      let errMsg = "";
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
        if (!n) return "\u2014";
        try {
          const d = new Date(n * 1e3);
          const dd = String(d.getDate()).padStart(2, "0");
          const mm = String(d.getMonth() + 1).padStart(2, "0");
          const hh = String(d.getHours()).padStart(2, "0");
          const mi = String(d.getMinutes()).padStart(2, "0");
          return `${dd}/${mm} ${hh}:${mi}`;
        } catch (_) {
          return bag.formatAuditTime(ts);
        }
      };
      const tlsCell = (n) => {
        if (n.Kind !== "agent") return '<span class="muted">\u2014</span>';
        if (!n.TlsExpiresAt) {
          return '<span class="muted" title="HTTPS autosign\xE9 \u2014 date inconnue tant que le n\u0153ud n\u2019a pas r\xE9pondu">?</span>';
        }
        const days = Number(n.TlsDaysLeft);
        const renew = String(n.TlsRenewBy || "").slice(0, 7);
        const expFull = bag.formatAuditTime(n.TlsExpiresAt);
        const tip = `TLS autosign\xE9 \u2014 expire ${expFull} \xB7 renouvellement auto ~30 j avant`;
        let cls = "badge-success";
        let label = renew ? `OK \xB7 ${bag.esc(renew)}` : "OK";
        if (Number.isFinite(days) && days <= 0) {
          cls = "badge-danger";
          label = "Expir\xE9";
        } else if (Number.isFinite(days) && days <= 30) {
          cls = "badge-warn";
          label = `${days} j`;
        }
        const pin = n.TlsFingerprintShort ? ` \xB7 pin ${bag.esc(n.TlsFingerprintShort)}` : n.TlsPinned ? "" : " \xB7 pin\u2026";
        const pinTip = n.TlsFingerprint ? `${tip} \xB7 empreinte SHA-256 ${n.TlsFingerprint}` : `${tip} \xB7 empreinte pas encore \xE9pingl\xE9e (TOFU au prochain ping)`;
        return `<span class="badge badge-compact ${cls}" title="${bag.esc(pinTip)}">${label}${pin}</span>`;
      };
      const byId = new Map(nodes.map((n) => [String(n.Id), n]));
      const rows = nodes.map((n) => {
        const isLocal = n.Kind !== "agent";
        const agentActions = isLocal ? "" : `
            <button type="button" class="btn btn-icon btn-sm" title="Ping" aria-label="Ping" data-ping="${bag.esc(n.Id)}"><span class="btn-ico">${bag.ico("activity")}</span></button>
            ${n.Disabled ? `<button type="button" class="btn btn-icon btn-sm btn-success" title="Activer" aria-label="Activer" data-enable="${bag.esc(n.Id)}"><span class="btn-ico">${bag.ico("start")}</span></button>` : `<button type="button" class="btn btn-icon btn-sm" title="D\xE9sactiver" aria-label="D\xE9sactiver" data-disable="${bag.esc(n.Id)}"><span class="btn-ico">${bag.ico("stop")}</span></button>`}
            <button type="button" class="btn btn-icon btn-sm btn-danger" title="D\xE9lier" aria-label="D\xE9lier" data-unlink="${bag.esc(n.Id)}"><span class="btn-ico">${bag.ico("remove")}</span></button>`;
        const actions = `<div class="quick-actions">
            <button type="button" class="btn btn-icon btn-sm btn-info" title="Modifier" aria-label="Modifier" data-edit-node="${bag.esc(n.Id)}"><span class="btn-ico">${bag.ico("edit")}</span></button>
            <button type="button" class="btn btn-icon btn-sm" title="Acc\xE8s (users / \xE9quipes)" aria-label="Acc\xE8s" data-access-node="${bag.esc(n.Id)}"><span class="btn-ico">${bag.ico("users")}</span></button>
            ${agentActions}
          </div>`;
        const url = n.AgentURL || n.URL || "\u2014";
        return `<tr>
        <td><strong>${bag.esc(n.NodeName || n.Name)}</strong><div class="muted mono">#${bag.esc(n.Id)}</div></td>
        <td>${bag.esc(n.Kind === "agent" ? "Agent" : "Local")}</td>
        <td class="mono cell-clip" title="${bag.esc(url)}">${bag.esc(url)}</td>
        <td>${bag.nodeStatusLabel(n)}</td>
        <td>${tlsCell(n)}</td>
        <td class="muted mono" title="${bag.esc(n.LastSeenAt ? bag.formatAuditTime(n.LastSeenAt) : "")}">${bag.esc(n.LastSeenAt ? shortSeen(n.LastSeenAt) : "\u2014")}</td>
        <td class="actions">${actions}</td>
      </tr>`;
      }).join("");
      bag.root.innerHTML = bag.shell("N\u0153uds", `
      ${bag.pageHeader("Infrastructure multi-n\u0153uds", false)}
      ${bag.settingsSubnav("nodes")}
      ${errMsg ? `<div class="error-box">${bag.esc(errMsg)}</div>` : ""}
      <div class="toolbar">
        ${bag.createBtn("create-node", "Ajouter un n\u0153ud")}
        <div class="spacer"></div>
        <span class="muted mono">${nodes.length} n\u0153ud${nodes.length > 1 ? "s" : ""}</span>
      </div>
      <div class="table-wrap">
        <table class="data table-nodes">
          <thead><tr><th>Nom</th><th>Type</th><th>URL</th><th>Statut</th><th>TLS</th><th>Vu</th><th class="actions-col"></th></tr></thead>
          <tbody>${rows || `<tr><td colspan="7" class="empty">Aucun n\u0153ud \u2014 cliquez \xAB Ajouter un n\u0153ud \xBB pour enr\xF4ler un agent.</td></tr>`}</tbody>
        </table>
      </div>
    `, { subtitle: "Joindre, acc\xE8s users/\xE9quipes, agents Docker" });
      document.getElementById("create-node").onclick = () => bag.openAddNodeModal(tokenMeta || bag.state._joinTokenMeta);
      bag.root.querySelectorAll("[data-edit-node]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const node = byId.get(String(btn.dataset.editNode));
          if (node) bag.openEditNodeModal(node);
        });
      });
      bag.root.querySelectorAll("[data-access-node]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const node = byId.get(String(btn.dataset.accessNode));
          if (node) bag.openNodeAccessModal(node);
        });
      });
      bag.root.querySelectorAll("[data-ping]").forEach((btn) => {
        bag.onBusyClick(btn, async (el) => {
          await bag.Api.pingNode(el.dataset.ping);
          await bag.viewNodes();
        }, { disableSiblings: false, minMs: 150 });
      });
      bag.root.querySelectorAll("[data-disable]").forEach((btn) => {
        bag.onBusyClick(btn, async (el) => {
          await bag.Api.disableNode(el.dataset.disable);
          await bag.viewNodes();
        }, { disableSiblings: false, minMs: 150 });
      });
      bag.root.querySelectorAll("[data-enable]").forEach((btn) => {
        bag.onBusyClick(btn, async (el) => {
          await bag.Api.enableNode(el.dataset.enable);
          await bag.viewNodes();
        }, { disableSiblings: false, minMs: 150 });
      });
      bag.root.querySelectorAll("[data-unlink]").forEach((btn) => {
        bag.onBusyClick(btn, async (el) => {
          if (!confirm("D\xE9lier ce n\u0153ud ? L\u2019agent devra rejoindre avec un nouveau token.")) return "cancelled";
          await bag.Api.unlinkNode(el.dataset.unlink);
          if (Number(bag.Api.getEndpointId()) === Number(el.dataset.unlink)) {
            bag.Api.setEndpointId(1);
            bag.state.endpointId = 1;
          }
          await bag.viewNodes();
        }, { disableSiblings: false, minMs: 150 });
      });
    };
    bag.openNodeAccessModal = async function openNodeAccessModal(node) {
      if (!node?.Id) return;
      bag.closeAppModal();
      const host = bag.modalHost();
      host.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-form modal-form-wide" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3>Acc\xE8s \xB7 ${bag.esc(node.NodeName || node.Name)}</h3>
              <div class="modal-sub">Attribuer un utilisateur ou une \xE9quipe \xE0 ce n\u0153ud</div>
            </div>
            <button type="button" class="icon-btn" data-close-modal title="Fermer" aria-label="Fermer">\u2715</button>
          </div>
          <div id="node-acl-err"></div>
          <p class="muted" style="margin:0 0 12px">
            R\xF4les : <strong>lecture</strong> \xB7 <strong>op\xE9ration</strong> (ses ressources) \xB7
            <strong>admin n\u0153ud</strong> (tout sur le n\u0153ud). Les admins globaux passent toujours.
          </p>
          <div class="panel" style="margin-bottom:14px;padding:12px">
            <div class="form-group" style="margin:0 0 10px">
              <label class="field-label">Rechercher un utilisateur ou une \xE9quipe</label>
              <input type="search" id="acl-search" placeholder="Nom d\u2019utilisateur ou d\u2019\xE9quipe\u2026" autocomplete="off">
            </div>
            <div class="form-row-2" style="align-items:end;gap:10px">
              <div class="form-group" style="margin:0;flex:2">
                <label class="field-label">Sujet</label>
                <select id="acl-subject" class="select-block"></select>
              </div>
              <div class="form-group" style="margin:0;flex:1">
                <label class="field-label">R\xF4le</label>
                <select id="acl-role" class="select-block">
                  <option value="read">Lecture</option>
                  <option value="operate" selected>Op\xE9ration</option>
                  <option value="admin">Admin n\u0153ud</option>
                </select>
              </div>
              <button type="button" class="btn btn-primary" id="acl-add">Attribuer</button>
            </div>
          </div>
          <div class="section-title" style="margin-top:0">Droits sur ce n\u0153ud</div>
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>Type</th><th>Sujet</th><th>R\xF4le</th><th></th></tr></thead>
              <tbody id="node-acl-rows"><tr><td colspan="4" class="muted">Chargement\u2026</td></tr></tbody>
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
      const errBox = () => document.getElementById("node-acl-err");
      const fillSubjects = () => {
        const q = (document.getElementById("acl-search")?.value || "").trim().toLowerCase();
        const sel = document.getElementById("acl-subject");
        if (!sel) return;
        const opts = [];
        users.forEach((u) => {
          const label = String(u.Username || "");
          if (q && !label.toLowerCase().includes(q)) return;
          if (Number(u.Role) === 1) return;
          opts.push(`<option value="user:${bag.esc(u.Id)}">${bag.esc(label)} \xB7 utilisateur</option>`);
        });
        teams.forEach((t) => {
          const label = String(t.Name || "");
          if (q && !label.toLowerCase().includes(q)) return;
          opts.push(`<option value="team:${bag.esc(t.Id)}">${bag.esc(label)} \xB7 \xE9quipe</option>`);
        });
        sel.innerHTML = opts.length ? opts.join("") : '<option value="">Aucun r\xE9sultat</option>';
      };
      const renderAcls = () => {
        const tb = document.getElementById("node-acl-rows");
        if (!tb) return;
        if (!acls.length) {
          tb.innerHTML = `<tr><td colspan="4" class="empty">Aucun droit sp\xE9cifique \u2014 d\xE9faut op\xE9ration pour les users non-admin.</td></tr>`;
          return;
        }
        tb.innerHTML = acls.map((a) => {
          const typeLabel = a.SubjectType === "team" ? "\xC9quipe" : "Utilisateur";
          return `<tr>
          <td>${bag.esc(typeLabel)}</td>
          <td><strong>${bag.esc(a.SubjectName || "#" + a.SubjectId)}</strong></td>
          <td>${bag.esc(bag.aclRoleLabel(a.Role))}</td>
          <td class="actions"><div class="quick-actions">
            <button type="button" class="btn btn-icon btn-sm btn-danger" title="Retirer" data-del-acl="${bag.esc(a.Id)}"><span class="btn-ico">${bag.ico("remove")}</span></button>
          </div></td>
        </tr>`;
        }).join("");
        tb.querySelectorAll("[data-del-acl]").forEach((btn) => {
          bag.onBusyClick(btn, async (el) => {
            if (!confirm("Retirer ce droit ?")) return "cancelled";
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
        teams = Array.isArray(tRes) ? tRes : tRes?.Items || [];
        fillSubjects();
        await refreshAcls();
      } catch (err) {
        if (errBox()) errBox().innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
      }
      document.getElementById("acl-search")?.addEventListener("input", fillSubjects);
      document.getElementById("acl-search")?.focus();
      bag.onBusyClick(document.getElementById("acl-add"), async () => {
        const box = errBox();
        if (box) box.innerHTML = "";
        const raw = document.getElementById("acl-subject")?.value || "";
        const [stype, sid] = raw.split(":");
        if (!stype || !sid) {
          if (box) box.innerHTML = `<div class="error-box">Choisissez un utilisateur ou une \xE9quipe.</div>`;
          return;
        }
        try {
          await bag.Api.upsertAcl({
            EndpointId: Number(node.Id),
            SubjectType: stype,
            SubjectId: Number(sid),
            Role: document.getElementById("acl-role").value
          });
          document.getElementById("acl-search").value = "";
          fillSubjects();
          await refreshAcls();
        } catch (err) {
          if (box) box.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
        }
      }, { disableSiblings: false, minMs: 200 });
    };
  }

  // public/assets/js/src/views/settings.js
  function install13() {
    bag.viewSettings = async function viewSettings() {
      await bag.loadPublicUrl();
      let settings = {};
      try {
        settings = await bag.Api.settings();
      } catch (_) {
        settings = {};
      }
      bag.state.publicUrl = settings.PublicURL || bag.state.publicUrl || "";
      bag.state.portsHostUrl = settings.PortsHostURL || settings.HostURL || bag.state.portsHostUrl || "";
      if (settings.TrivyEnabled != null) bag.state.trivyEnabled = !!settings.TrivyEnabled;
      const fallback = `${window.location.protocol}//${window.location.hostname}`;
      const chartHours = bag.metricChartHours();
      const retentionDays = bag.metricRetentionDays();
      const isAdmin = Number(bag.state.user?.Role) === 1;
      bag.root.innerHTML = bag.shell("Param\xE8tres", `
      ${bag.pageHeader("Param\xE8tres", false)}
      ${bag.settingsSubnav("settings")}
      <div id="settings-err"></div>
      <div class="panel" style="max-width:720px; margin-bottom:16px">
        <div class="section-title" style="margin-top:0">URLs (r\xF4les distincts)</div>
        <p class="muted" style="margin:0 0 14px">
          Deux adresses diff\xE9rentes : celle de la console WharfMaster (script d\u2019ajout de n\u0153uds),
          et celle de l\u2019h\xF4te Docker pour les liens de ports publi\xE9s.
        </p>
        <div class="form-group">
          <label class="field-label">URL WharfMaster</label>
          <input id="public-url" type="text" placeholder="https://dockermanager.example.com" value="${bag.esc(bag.state.publicUrl)}">
          <p class="field-hint muted">Utilis\xE9e dans la commande <code>install.sh</code> / <code>--url</code> pour enr\xF4ler un agent. Vide = origine du navigateur.</p>
        </div>
        <div class="form-group">
          <label class="field-label">URL h\xF4te des ports</label>
          <input id="ports-host-url" type="text" placeholder="https://nas.lan" value="${bag.esc(bag.state.portsHostUrl)}">
          <p class="field-hint muted">Base des liens cliquables dans Conteneurs / Stacks. Un n\u0153ud peut surcharger via son \xAB URL publique \xBB. Vide = <code>${bag.esc(fallback)}</code>.</p>
        </div>
        <div class="info-box">
          Exemple ports : <code>https://nas.lan</code> + port <code>8080</code> \u2192 <code>https://nas.lan:8080</code>.
          Exemple agent : <code>https://dockermanager.example.com</code> dans <code>curl \u2026/agent/install.sh</code>.
        </div>
      </div>
      <div class="panel" style="max-width:720px; margin-bottom:16px">
        <div class="section-title" style="margin-top:0">Historique &amp; courbes</div>
        <p class="muted" style="margin:0 0 14px">
          Relev\xE9s du tableau de bord et des conteneurs (CPU / RAM / r\xE9seau) stock\xE9s en SQLite.
          Les courbes utilisent la m\xEAme fen\xEAtre glissante et la m\xEAme r\xE9tention partout.
        </p>
        <div class="form-group">
          <label class="field-label" for="metrics-chart-hours">Fen\xEAtre des courbes (heures)</label>
          <input id="metrics-chart-hours" type="number" min="1" max="168" step="1" value="${bag.esc(chartHours)}" placeholder="72">
          <p class="field-hint muted">Ex. 72 = derni\xE8res 72 h sur le dashboard et les modales conteneur (1\u2013168).</p>
        </div>
        <div class="form-group">
          <label class="field-label" for="metrics-retention-days">R\xE9tention en base (jours)</label>
          <input id="metrics-retention-days" type="number" min="7" max="365" step="1" value="${bag.esc(retentionDays)}" placeholder="90">
          <p class="field-hint muted">Conservation des relev\xE9s (7\u2013365). D\xE9faut 90 jours \u2014 partag\xE9e dashboard / conteneurs.</p>
        </div>
      </div>
      ${isAdmin ? `
      <div class="panel" style="max-width:720px; margin-bottom:16px">
        <div class="section-title" style="margin-top:0">Scan CVE (Trivy)</div>
        <p class="muted" style="margin:0 0 14px">
          Active ou d\xE9sactive les scans CVE : \xE0 l\u2019ouverture de la page Images (cache 24&nbsp;h, comme la v\xE9rif. de mises \xE0 jour),
          et avis non bloquant \xE0 la cr\xE9ation de conteneurs / stacks.
          ${settings.TrivyInstalled === false ? '<br><span class="badge badge-warn">Binaire Trivy non d\xE9tect\xE9 sur cette instance</span>' : ""}
        </p>
        <label class="field-label" style="display:flex;align-items:center;gap:8px;margin-bottom:0">
          <input type="checkbox" id="trivy-enabled" ${settings.TrivyEnabled !== false ? "checked" : ""}>
          Activer le scan CVE Trivy
        </label>
      </div>` : ""}
      <div class="panel" style="max-width:720px">
        <div class="actions-bar">
          <button class="btn btn-primary" id="save-settings">Enregistrer</button>
        </div>
      </div>
      ${isAdmin ? `
      <div class="panel" style="max-width:720px; margin-top:16px">
        <div class="section-title" style="margin-top:0">Sauvegarde / reprise</div>
        <p class="muted" style="margin:0 0 14px">
          Archive ZIP pour repartir apr\xE8s un incident : base SQLite (utilisateurs, n\u0153uds, stacks, registres, param\xE8tres, audit, m\xE9triques),
          fichiers Compose, Dockerfiles enregistr\xE9s, secret JWT. Les volumes Docker et images ne sont pas inclus.
        </p>
        <div class="info-box" style="margin-bottom:14px">
          Conservez le fichier hors serveur \u2014 il contient des secrets. Un guide <code>RESTORE.md</code> est dans l\u2019archive.
        </div>
        <div class="actions-bar" style="gap:8px;flex-wrap:wrap">
          <button type="button" class="btn btn-primary" id="backup-full">T\xE9l\xE9charger le backup complet</button>
          <button type="button" class="btn" id="backup-sqlite" title="Base seule">SQLite uniquement</button>
        </div>
        <p class="muted" id="backup-status" style="margin:10px 0 0;font-size:12px"></p>
      </div>` : ""}
    `);
      bag.onBusyClick(document.getElementById("save-settings"), async () => {
        const publicUrl = document.getElementById("public-url").value.trim();
        const portsHostUrl = document.getElementById("ports-host-url").value.trim();
        const hours = parseInt(document.getElementById("metrics-chart-hours").value, 10);
        const days = parseInt(document.getElementById("metrics-retention-days").value, 10);
        const errBox = document.getElementById("settings-err");
        errBox.innerHTML = "";
        if (!Number.isFinite(hours) || hours < 1 || hours > 168) {
          errBox.innerHTML = `<div class="error-box">Fen\xEAtre des courbes : entre 1 et 168 heures.</div>`;
          return;
        }
        if (!Number.isFinite(days) || days < 7 || days > 365) {
          errBox.innerHTML = `<div class="error-box">R\xE9tention : entre 7 et 365 jours.</div>`;
          return;
        }
        const trivyEl = document.getElementById("trivy-enabled");
        const payload = {
          PublicURL: publicUrl,
          PortsHostURL: portsHostUrl,
          MetricsChartHours: hours,
          MetricsRetentionDays: days
        };
        if (trivyEl) payload.TrivyEnabled = !!trivyEl.checked;
        try {
          const saved = await bag.Api.updateSettings(payload);
          bag.state.publicUrl = saved.PublicURL || "";
          bag.state.portsHostUrl = saved.PortsHostURL || saved.HostURL || "";
          bag.state.metricsChartHours = Number(saved.MetricsChartHours) || hours;
          bag.state.metricsRetentionDays = Number(saved.MetricsRetentionDays) || days;
          if (saved.TrivyEnabled != null) bag.state.trivyEnabled = !!saved.TrivyEnabled;
          bag.metricCache.scope = "";
          bag.metricCache.series = [];
          errBox.innerHTML = `<div class="info-box">Param\xE8tres enregistr\xE9s.</div>`;
        } catch (err) {
          errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
        }
      }, { disableSiblings: false, minMs: 250 });
      const backupStatus = document.getElementById("backup-status");
      const runBackup = async (format) => {
        const errBox = document.getElementById("settings-err");
        if (errBox) errBox.innerHTML = "";
        if (backupStatus) backupStatus.textContent = "Pr\xE9paration de l\u2019archive\u2026";
        try {
          const res = await bag.Api.downloadBackup(format);
          if (backupStatus) {
            backupStatus.textContent = `T\xE9l\xE9charg\xE9 : ${res.filename} (${bag.formatBytes(res.size)})`;
          }
        } catch (err) {
          if (backupStatus) backupStatus.textContent = "";
          if (errBox) errBox.innerHTML = `<div class="error-box">${bag.esc(err.message || "Backup impossible")}</div>`;
        }
      };
      const fullBtn = document.getElementById("backup-full");
      const sqliteBtn = document.getElementById("backup-sqlite");
      if (fullBtn) bag.onBusyClick(fullBtn, () => runBackup("zip"), { disableSiblings: false, minMs: 300 });
      if (sqliteBtn) bag.onBusyClick(sqliteBtn, () => runBackup("sqlite"), { disableSiblings: false, minMs: 300 });
    };
    bag.viewSettingsAuth = async function viewSettingsAuth() {
      if (Number(bag.state.user?.Role) !== 1) {
        location.hash = "#settings";
        return;
      }
      let settings = {};
      try {
        settings = await bag.Api.settings();
      } catch (_) {
        settings = {};
      }
      const ldap = settings.Ldap || {};
      const method = Number(settings.AuthenticationMethod) === 2 || ldap.Enabled ? "ldap" : "local";
      bag.root.innerHTML = bag.shell("Authentification", `
      ${bag.pageHeader("Authentification", false)}
      ${bag.settingsSubnav("settings/auth")}
      <div id="settings-err"></div>
      <div class="panel" style="max-width:720px; margin-bottom:16px">
        <div class="section-title" style="margin-top:0">M\xE9thode</div>
        <p class="muted" style="margin:0 0 14px">
          Mode actuel : <strong>${method === "ldap" ? "Active Directory / LDAP" : "Comptes locaux"}</strong>.
          Les comptes locaux (admin bootstrap) restent utilisables m\xEAme avec LDAP activ\xE9.
        </p>
        <label class="field-label" style="display:flex;align-items:center;gap:8px;margin-bottom:0">
          <input type="checkbox" id="ldap-enabled" ${ldap.Enabled ? "checked" : ""}> Activer l\u2019authentification Active Directory / LDAP
        </label>
      </div>
      <div class="panel" style="max-width:720px">
        <div class="section-title" style="margin-top:0">Active Directory / LDAP</div>
        <p class="muted" style="margin:0 0 14px">
          Connectez WharfMaster \xE0 votre domaine. Mappez les groupes AD via le champ \xAB Groupe AD \xBB des \xE9quipes.
        </p>
        <div class="form-group">
          <label class="field-label">H\xF4te</label>
          <input id="ldap-host" value="${bag.esc(ldap.Host || "")}" placeholder="dc.example.com">
        </div>
        <div class="form-group" style="display:flex;gap:12px;flex-wrap:wrap">
          <div style="flex:1;min-width:120px">
            <label class="field-label">Port</label>
            <input id="ldap-port" type="number" value="${bag.esc(ldap.Port || 389)}">
          </div>
          <label class="field-label" style="display:flex;align-items:center;gap:6px;margin-top:22px">
            <input type="checkbox" id="ldap-tls" ${ldap.UseTls ? "checked" : ""}> StartTLS
          </label>
          <label class="field-label" style="display:flex;align-items:center;gap:6px;margin-top:22px">
            <input type="checkbox" id="ldap-ssl" ${ldap.UseSsl ? "checked" : ""}> LDAPS
          </label>
        </div>
        <div class="form-group">
          <label class="field-label">Base DN</label>
          <input id="ldap-base" value="${bag.esc(ldap.BaseDn || "")}" placeholder="DC=example,DC=com">
        </div>
        <div class="form-group">
          <label class="field-label">Bind DN (compte service)</label>
          <input id="ldap-bind" value="${bag.esc(ldap.BindDn || "")}" placeholder="CN=svc-wharf,OU=Service,DC=example,DC=com">
        </div>
        <div class="form-group">
          <label class="field-label">Mot de passe bind ${ldap.BindPasswordSet ? '<span class="muted">(laisser vide pour conserver)</span>' : ""}</label>
          <input id="ldap-pass" type="password" autocomplete="new-password" placeholder="${ldap.BindPasswordSet ? "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" : ""}">
        </div>
        <div class="form-group">
          <label class="field-label">Filtre utilisateur</label>
          <input id="ldap-filter" value="${bag.esc(ldap.UserFilter || "(sAMAccountName={username})")}">
        </div>
        <div class="form-group">
          <label class="field-label">Attribut username</label>
          <input id="ldap-attr" value="${bag.esc(ldap.UsernameAttr || "sAMAccountName")}">
        </div>
        <div class="actions-bar">
          <button class="btn btn-primary" id="save-auth">Enregistrer</button>
        </div>
      </div>
    `, { subtitle: "Connexion locale et Active Directory" });
      bag.onBusyClick(document.getElementById("save-auth"), async () => {
        const errBox = document.getElementById("settings-err");
        errBox.innerHTML = "";
        const ldapPass = document.getElementById("ldap-pass").value;
        const payload = {
          Ldap: {
            Enabled: document.getElementById("ldap-enabled").checked,
            Host: document.getElementById("ldap-host").value.trim(),
            Port: parseInt(document.getElementById("ldap-port").value, 10) || 389,
            UseTls: document.getElementById("ldap-tls").checked,
            UseSsl: document.getElementById("ldap-ssl").checked,
            BaseDn: document.getElementById("ldap-base").value.trim(),
            BindDn: document.getElementById("ldap-bind").value.trim(),
            UserFilter: document.getElementById("ldap-filter").value.trim(),
            UsernameAttr: document.getElementById("ldap-attr").value.trim()
          }
        };
        if (ldapPass) payload.Ldap.BindPassword = ldapPass;
        try {
          await bag.Api.updateSettings(payload);
          errBox.innerHTML = `<div class="info-box">Param\xE8tres d\u2019authentification enregistr\xE9s.</div>`;
        } catch (err) {
          errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
        }
      }, { disableSiblings: false, minMs: 250 });
    };
    bag.loadPublicUrl = async function loadPublicUrl() {
      try {
        const s = await bag.Api.settings();
        bag.state.publicUrl = s.PublicURL || "";
        bag.state.portsHostUrl = s.PortsHostURL || s.HostURL || "";
        if (s.MetricsChartHours != null) bag.state.metricsChartHours = Number(s.MetricsChartHours) || 72;
        if (s.MetricsRetentionDays != null) bag.state.metricsRetentionDays = Number(s.MetricsRetentionDays) || 90;
        if (s.TrivyEnabled != null) bag.state.trivyEnabled = !!s.TrivyEnabled;
      } catch (_) {
        bag.state.publicUrl = "";
        bag.state.portsHostUrl = "";
      }
    };
  }

  // public/assets/js/src/views/diagnostics.js
  function install14() {
    const SPA_HANDLERS = [
      "viewDashboard",
      "viewContainers",
      "viewImages",
      "viewVolumes",
      "viewNetworks",
      "viewStacks",
      "viewSettings",
      "viewSettingsAuth",
      "viewDiagnostics",
      "viewDiagnosticsApi",
      "viewUsers",
      "viewTeams",
      "viewNodes",
      "viewRegistries",
      "viewDocs",
      "viewActivity"
    ];
    const HASH_LINKS = [
      ["#dashboard", "Tableau de bord"],
      ["#containers", "Conteneurs"],
      ["#images", "Images"],
      ["#volumes", "Volumes"],
      ["#networks", "R\xE9seaux"],
      ["#stacks", "Stacks"],
      ["#activity", "Journaux"],
      ["#settings", "Param\xE8tres"],
      ["#settings/auth", "Authentification"],
      ["#settings/diagnostics/api", "Tests API"],
      ["#registries", "Registres"],
      ["#nodes", "N\u0153uds"],
      ["#users", "Utilisateurs"],
      ["#teams", "\xC9quipes"],
      ["#docs", "Documentation"]
    ];
    function levelBadge(level, ok) {
      const lv = level || (ok ? "ok" : "fail");
      if (lv === "ok") return '<span class="badge badge-success">OK</span>';
      if (lv === "warn") return '<span class="badge badge-warn">WARN</span>';
      return '<span class="badge badge-danger">KO</span>';
    }
    function groupChecks(checks) {
      const map = /* @__PURE__ */ new Map();
      for (const c of checks) {
        const g = c.group || "Autre";
        if (!map.has(g)) map.set(g, []);
        map.get(g).push(c);
      }
      return map;
    }
    function renderReport(checks, summary) {
      const groups = groupChecks(checks);
      const failed = summary?.failed ?? checks.filter((c) => !c.ok || c.level === "fail").length;
      const warns = summary?.warnings ?? checks.filter((c) => c.level === "warn").length;
      const total = summary?.total ?? checks.length;
      const okCount = total - failed - warns;
      let html = `
      <div class="panel" style="margin-bottom:16px">
        <div class="section-title" style="margin-top:0">R\xE9sum\xE9</div>
        <p style="margin:0">
          <span class="badge badge-success">${okCount} OK</span>
          <span class="badge badge-warn" style="margin-left:6px">${warns} warn</span>
          <span class="badge badge-danger" style="margin-left:6px">${failed} KO</span>
          <span class="muted" style="margin-left:10px">${total} checks</span>
        </p>
      </div>`;
      for (const [group, items] of groups) {
        html += `<div class="panel" style="margin-bottom:16px">
        <div class="section-title" style="margin-top:0">${bag.esc(group)}</div>
        <table class="data-table"><thead><tr>
          <th style="width:90px">Statut</th><th>Check</th><th>D\xE9tail</th>
        </tr></thead><tbody>`;
        for (const c of items) {
          html += `<tr>
          <td>${levelBadge(c.level, c.ok)}</td>
          <td class="mono">${bag.esc(c.id)}</td>
          <td>${c.html ? c.detail : bag.esc(c.detail || "")}</td>
        </tr>`;
        }
        html += "</tbody></table></div>";
      }
      return html;
    }
    async function runClientApiSmoke() {
      const checks = [];
      const add = (id, ok, detail, level) => {
        checks.push({ id, group: "API client", ok, level: level || (ok ? "ok" : "fail"), detail });
      };
      const tryCall = async (id, fn, okDetail) => {
        try {
          const data = await fn();
          add(id, true, okDetail(data));
        } catch (err) {
          add(id, false, err.message || String(err));
        }
      };
      await tryCall("api.me", () => bag.Api.me(), (d) => `Connect\xE9 : ${d.Username || d.username || "?"}`);
      await tryCall("api.settings", () => bag.Api.settings(), () => "Param\xE8tres lisibles");
      await tryCall("api.endpoints", () => bag.Api.endpoints(), (d) => {
        const n = Array.isArray(d) ? d.length : d?.length ?? 0;
        return `${n} endpoint(s)`;
      });
      await tryCall("api.nodes", () => bag.Api.nodes(), (d) => {
        const n = Array.isArray(d) ? d.length : Array.isArray(d?.Nodes) ? d.Nodes.length : "?";
        return `N\u0153uds : ${n}`;
      });
      if (!bag.Api.isAllEndpoints()) {
        await tryCall(
          "api.docker.containers",
          () => bag.Api.docker("/containers/json?all=true"),
          (d) => `${Array.isArray(d) ? d.length : 0} conteneur(s)`
        );
      } else {
        add("api.docker.containers", true, "Mode \xAB tous les n\u0153uds \xBB \u2014 skip docker local", "warn");
      }
      await tryCall(
        "api.stacks",
        () => bag.Api.stacks(),
        (d) => `${Array.isArray(d) ? d.length : d?.Stacks?.length ?? "?"} stack(s)`
      );
      return checks;
    }
    function runSpaHandlerChecks() {
      return SPA_HANDLERS.map((name) => {
        const ok = typeof bag[name] === "function";
        return {
          id: `spa.${name}`,
          group: "Handlers SPA",
          ok,
          level: ok ? "ok" : "fail",
          detail: ok ? "fonction pr\xE9sente" : "manquante"
        };
      });
    }
    function runHashLinkChecks() {
      return HASH_LINKS.map(([href, label]) => ({
        id: `link.${href.slice(1).replace(/\//g, ".")}`,
        group: "Liens console",
        ok: true,
        level: "ok",
        html: true,
        detail: `<a href="${bag.esc(href)}">${bag.esc(label)}</a> <span class="mono muted">${bag.esc(href)}</span>`
      }));
    }
    bag.viewDiagnostics = async function viewDiagnostics() {
      if (Number(bag.state.user?.Role) !== 1) {
        location.hash = "#settings";
        return;
      }
      bag.root.innerHTML = bag.shell("Diagnostics", `
      ${bag.pageHeader("Diagnostics", false)}
      ${bag.settingsSubnav("settings/diagnostics")}
      <div class="panel" style="max-width:820px;margin-bottom:16px">
        <div class="section-title" style="margin-top:0">Contr\xF4le post-migration</div>
        <p class="muted" style="margin:0 0 14px">
          V\xE9rifie runtime, Docker, assets, API et handlers SPA (lecture seule \u2014 aucune action destructive).
        </p>
        <button type="button" class="btn btn-primary" id="diag-run">Lancer les tests</button>
        <span class="muted" id="diag-status" style="margin-left:12px"></span>
      </div>
      <div id="diag-report"><div class="info-box">Cliquez sur <strong>Lancer les tests</strong> pour g\xE9n\xE9rer le rapport.</div></div>
    `, { subtitle: "V\xE9rification de l\u2019instance" });
      const btn = document.getElementById("diag-run");
      const status = document.getElementById("diag-status");
      const report = document.getElementById("diag-report");
      btn.onclick = async () => {
        btn.disabled = true;
        status.textContent = "Ex\xE9cution\u2026";
        report.innerHTML = '<div class="info-box">Collecte des checks\u2026</div>';
        const all = [];
        let summary = null;
        try {
          const server = await bag.Api.diagnostics();
          all.push(...server.checks || []);
          summary = server.summary || null;
        } catch (err) {
          all.push({
            id: "api.diagnostics",
            group: "Serveur",
            ok: false,
            level: "fail",
            detail: err.message || String(err)
          });
        }
        try {
          all.push(...await runClientApiSmoke());
        } catch (err) {
          all.push({
            id: "api.smoke",
            group: "API client",
            ok: false,
            level: "fail",
            detail: err.message || String(err)
          });
        }
        all.push(...runSpaHandlerChecks());
        all.push(...runHashLinkChecks());
        if (!summary) {
          const failed2 = all.filter((c) => !c.ok || c.level === "fail").length;
          const warnings = all.filter((c) => c.level === "warn").length;
          summary = { total: all.length, failed: failed2, warnings };
        } else {
          const clientExtra = all.length - (summary.total || 0);
          if (clientExtra > 0) {
            const failed2 = all.filter((c) => !c.ok || c.level === "fail").length;
            const warnings = all.filter((c) => c.level === "warn").length;
            summary = { total: all.length, failed: failed2, warnings };
          }
        }
        report.innerHTML = renderReport(all, summary);
        const failed = summary.failed || 0;
        status.textContent = failed === 0 ? `Termin\xE9 \u2014 ${summary.total} checks` : `Termin\xE9 \u2014 ${failed} \xE9chec(s)`;
        btn.disabled = false;
      };
    };
  }

  // public/assets/js/src/views/diagnostics-api.js
  function install15() {
    function levelBadge(level, ok) {
      const lv = level || (ok ? "ok" : "fail");
      if (lv === "ok") return '<span class="badge badge-success">OK</span>';
      if (lv === "warn") return '<span class="badge badge-warn">WARN</span>';
      if (lv === "skip") return '<span class="badge">SKIP</span>';
      return '<span class="badge badge-danger">KO</span>';
    }
    function renderSteps(steps) {
      if (!steps.length) {
        return '<div class="info-box">Lancez la suite pour tester cr\xE9ation + suppression via l\u2019API.</div>';
      }
      const failed = steps.filter((s) => s.level === "fail").length;
      const ok = steps.filter((s) => s.level === "ok").length;
      const warn = steps.filter((s) => s.level === "warn" || s.level === "skip").length;
      let html = `
      <div class="panel" style="margin-bottom:16px">
        <div class="section-title" style="margin-top:0">R\xE9sum\xE9</div>
        <p style="margin:0">
          <span class="badge badge-success">${ok} OK</span>
          <span class="badge badge-warn" style="margin-left:6px">${warn} warn/skip</span>
          <span class="badge badge-danger" style="margin-left:6px">${failed} KO</span>
          <span class="muted" style="margin-left:10px">${steps.length} \xE9tapes</span>
        </p>
      </div>
      <div class="panel">
        <div class="section-title" style="margin-top:0">Journal</div>
        <table class="data-table"><thead><tr>
          <th style="width:90px">Statut</th><th>\xC9tape</th><th>D\xE9tail</th><th style="width:90px">ms</th>
        </tr></thead><tbody>`;
      for (const s of steps) {
        html += `<tr>
        <td>${levelBadge(s.level, s.ok)}</td>
        <td class="mono">${bag.esc(s.id)}</td>
        <td>${bag.esc(s.detail || "")}</td>
        <td class="mono muted">${s.ms != null ? s.ms : "\u2014"}</td>
      </tr>`;
      }
      html += "</tbody></table></div>";
      return html;
    }
    async function runApiLifecycleSmoke(onStep) {
      const steps = [];
      const push = (step) => {
        steps.push(step);
        if (onStep) onStep(steps.slice());
      };
      const run = async (id, fn) => {
        const t0 = performance.now();
        try {
          const detail = await fn();
          push({
            id,
            ok: true,
            level: "ok",
            detail: detail == null ? "OK" : String(detail),
            ms: Math.round(performance.now() - t0)
          });
          return true;
        } catch (err) {
          push({
            id,
            ok: false,
            level: "fail",
            detail: err.message || String(err),
            ms: Math.round(performance.now() - t0)
          });
          return false;
        }
      };
      const skip = (id, detail) => {
        push({ id, ok: true, level: "skip", detail, ms: 0 });
      };
      const tag = `wm${Date.now().toString(36)}`;
      const volName = `apitest_vol_${tag}`;
      const netName = `apitest_net_${tag}`;
      const ctrName = `apitest_ctr_${tag}`;
      const imageRef = "alpine:latest";
      const created = {
        volume: null,
        networkId: null,
        containerId: null
      };
      await run("auth.me", async () => {
        const me = await bag.Api.me();
        return `user=${me.Username || me.username || "?"} role=${me.Role ?? me.role ?? "?"}`;
      });
      await run("endpoints.list", async () => {
        const eps = await bag.Api.endpoints();
        const n = Array.isArray(eps) ? eps.length : 0;
        if (!n) throw new Error("Aucun endpoint");
        return `${n} endpoint(s)`;
      });
      const dockerOk = !bag.Api.isAllEndpoints() && !!bag.Api.getEndpointId();
      if (!dockerOk) {
        skip("docker.*", "Choisissez un n\u0153ud pr\xE9cis (pas \xAB tous \xBB) pour les tests Docker");
      }
      if (dockerOk) {
        await run("images.ensure", async () => {
          try {
            await bag.Api.docker(`/images/${encodeURIComponent(imageRef)}/json`);
            return `${imageRef} d\xE9j\xE0 pr\xE9sente`;
          } catch (_) {
            await bag.Api.docker(`/images/create?fromImage=alpine&tag=latest`, {
              method: "POST",
              body: ""
            });
            await bag.Api.docker(`/images/${encodeURIComponent(imageRef)}/json`);
            return `${imageRef} tir\xE9e`;
          }
        });
        await run("images.list", async () => {
          const imgs = await bag.Api.docker("/images/json");
          return `${Array.isArray(imgs) ? imgs.length : 0} image(s)`;
        });
        await run("volumes.create", async () => {
          const res = await bag.Api.docker("/volumes/create", {
            method: "POST",
            body: JSON.stringify({
              Name: volName,
              Driver: "local",
              Labels: { "wharfmaster.apitest": tag }
            })
          });
          created.volume = res?.Name || volName;
          return created.volume;
        });
        await run("volumes.inspect", async () => {
          const v = await bag.Api.docker(`/volumes/${encodeURIComponent(created.volume)}`);
          if (!v?.Name) throw new Error("inspect volume vide");
          return v.Name;
        });
        await run("volumes.delete", async () => {
          await bag.Api.docker(`/volumes/${encodeURIComponent(created.volume)}`, { method: "DELETE" });
          const n = created.volume;
          created.volume = null;
          return `supprim\xE9 ${n}`;
        });
        await run("networks.create", async () => {
          const res = await bag.Api.docker("/networks/create", {
            method: "POST",
            body: JSON.stringify({
              Name: netName,
              Driver: "bridge",
              CheckDuplicate: true,
              Labels: { "wharfmaster.apitest": tag }
            })
          });
          created.networkId = res?.Id || netName;
          return `Id=${bag.shortId?.(created.networkId) || String(created.networkId).slice(0, 12)}`;
        });
        await run("networks.inspect", async () => {
          const n = await bag.Api.docker(`/networks/${encodeURIComponent(created.networkId)}`);
          if (!n?.Name && !n?.Id) throw new Error("inspect r\xE9seau vide");
          return n.Name || n.Id;
        });
        await run("networks.delete", async () => {
          await bag.Api.docker(`/networks/${encodeURIComponent(created.networkId)}`, { method: "DELETE" });
          created.networkId = null;
          return "supprim\xE9";
        });
        await run("containers.create", async () => {
          const res = await bag.Api.docker(`/containers/create?name=${encodeURIComponent(ctrName)}`, {
            method: "POST",
            body: JSON.stringify({
              Image: imageRef,
              Cmd: ["sleep", "120"],
              Labels: { "wharfmaster.apitest": tag },
              HostConfig: { AutoRemove: false }
            })
          });
          created.containerId = res?.Id;
          if (!created.containerId) throw new Error("Id conteneur manquant");
          return bag.shortId(created.containerId);
        });
        await run("containers.start", async () => {
          await bag.Api.docker(`/containers/${encodeURIComponent(created.containerId)}/start`, {
            method: "POST",
            body: ""
          });
          return "d\xE9marr\xE9";
        });
        await run("containers.inspect", async () => {
          const info = await bag.Api.docker(`/containers/${encodeURIComponent(created.containerId)}/json`);
          const state2 = info?.State?.Status || "?";
          return `state=${state2}`;
        });
        await run("containers.delete", async () => {
          await bag.Api.docker(
            `/containers/${encodeURIComponent(created.containerId)}?force=true`,
            { method: "DELETE" }
          );
          created.containerId = null;
          return "supprim\xE9 (force)";
        });
      }
      if (created.containerId && dockerOk) {
        await run("cleanup.container", async () => {
          await bag.Api.docker(
            `/containers/${encodeURIComponent(created.containerId)}?force=true`,
            { method: "DELETE" }
          );
          created.containerId = null;
          return "OK";
        });
      }
      if (created.volume && dockerOk) {
        await run("cleanup.volume", async () => {
          await bag.Api.docker(`/volumes/${encodeURIComponent(created.volume)}`, { method: "DELETE" });
          created.volume = null;
          return "OK";
        });
      }
      if (created.networkId && dockerOk) {
        await run("cleanup.network", async () => {
          await bag.Api.docker(`/networks/${encodeURIComponent(created.networkId)}`, { method: "DELETE" });
          created.networkId = null;
          return "OK";
        });
      }
      return steps;
    }
    bag.viewDiagnosticsApi = async function viewDiagnosticsApi() {
      if (Number(bag.state.user?.Role) !== 1) {
        location.hash = "#settings";
        return;
      }
      const epLabel = bag.Api.isAllEndpoints() ? "tous les n\u0153uds (Docker skip)" : bag.endpointLabel?.(bag.Api.getEndpointId()) || `endpoint #${bag.Api.getEndpointId()}`;
      bag.root.innerHTML = bag.shell("Tests API", `
      ${bag.pageHeader("Tests API Docker", false)}
      ${bag.settingsSubnav("settings/diagnostics/api")}
      <div class="panel" style="max-width:860px;margin-bottom:16px">
        <div class="section-title" style="margin-top:0">Cycle cr\xE9ation \u2192 suppression</div>
        <p class="muted" style="margin:0 0 10px">
          V\xE9rifie le proxy Docker Engine (via endpoints Portainer) : image, volume, r\xE9seau, conteneur.
          Pas de stacks Compose ni d\u2019utilisateurs (hors API Docker).
          Chaque ressource cr\xE9\xE9e est <strong>supprim\xE9e</strong> ensuite (pr\xE9fixe <code>apitest_*</code>).
        </p>
        <p class="muted" style="margin:0 0 14px">
          N\u0153ud courant : <strong>${bag.esc(epLabel)}</strong>
        </p>
        <div class="toolbar" style="margin:0">
          <button type="button" class="btn btn-primary" id="api-smoke-run">Lancer la suite API</button>
          <span class="muted" id="api-smoke-status" style="margin-left:12px"></span>
        </div>
      </div>
      <div id="api-smoke-report">${renderSteps([])}</div>
    `, { subtitle: "Smoke test destructif contr\xF4l\xE9" });
      const btn = document.getElementById("api-smoke-run");
      const status = document.getElementById("api-smoke-status");
      const report = document.getElementById("api-smoke-report");
      btn.onclick = async () => {
        if (btn.dataset.busy === "1") return;
        const ok = window.confirm(
          "Lancer les tests API ?\nDes ressources temporaires seront cr\xE9\xE9es puis supprim\xE9es sur le n\u0153ud s\xE9lectionn\xE9."
        );
        if (!ok) return;
        btn.dataset.busy = "1";
        btn.disabled = true;
        status.textContent = "Ex\xE9cution\u2026";
        report.innerHTML = renderSteps([]);
        try {
          const steps = await runApiLifecycleSmoke((live) => {
            report.innerHTML = renderSteps(live);
            status.textContent = `\xC9tape ${live.length}\u2026`;
          });
          const failed = steps.filter((s) => s.level === "fail").length;
          status.textContent = failed === 0 ? `Termin\xE9 \u2014 ${steps.length} \xE9tapes OK` : `Termin\xE9 \u2014 ${failed} \xE9chec(s) / ${steps.length}`;
          report.innerHTML = renderSteps(steps);
        } catch (err) {
          status.textContent = "Erreur";
          report.innerHTML = `<div class="error-box">${bag.esc(err.message || String(err))}</div>`;
        } finally {
          btn.disabled = false;
          delete btn.dataset.busy;
        }
      };
    };
  }

  // public/assets/js/src/views/docs.js
  function install16() {
    bag.renderMarkdown = function renderMarkdown(src) {
      const lines = String(src || "").replace(/\r\n/g, "\n").split("\n");
      const html = [];
      let i = 0;
      let inCode = false;
      let codeLang = "";
      let codeBuf = [];
      let listType = null;
      let inTable = false;
      const flushList = () => {
        if (listType) {
          html.push(`</${listType}>`);
          listType = null;
        }
      };
      const flushTable = () => {
        if (inTable) {
          html.push("</tbody></table></div>");
          inTable = false;
        }
      };
      const inline = (text) => {
        let t = bag.esc(text);
        t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
        t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
        t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
          const safe = String(href).startsWith("http") || String(href).startsWith("/") || String(href).startsWith("#") ? href : "#";
          const ext = String(safe).startsWith("http") ? ' target="_blank" rel="noopener"' : "";
          return `<a href="${bag.esc(safe)}"${ext}>${label}</a>`;
        });
        return t;
      };
      const splitRow = (line) => line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      while (i < lines.length) {
        const line = lines[i];
        if (line.startsWith("```")) {
          flushList();
          flushTable();
          if (!inCode) {
            inCode = true;
            codeLang = line.slice(3).trim();
            codeBuf = [];
          } else {
            html.push(`<pre class="docs-code"><code class="lang-${bag.esc(codeLang)}">${bag.esc(codeBuf.join("\n"))}</code></pre>`);
            inCode = false;
            codeLang = "";
            codeBuf = [];
          }
          i += 1;
          continue;
        }
        if (inCode) {
          codeBuf.push(line);
          i += 1;
          continue;
        }
        if (/^\|/.test(line) && line.includes("|")) {
          flushList();
          const cells = splitRow(line);
          const next = lines[i + 1] || "";
          const isSep = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(next);
          if (!inTable) {
            html.push('<div class="table-wrap docs-table"><table class="data"><thead><tr>');
            cells.forEach((c) => {
              html.push(`<th>${inline(c)}</th>`);
            });
            html.push("</tr></thead><tbody>");
            inTable = true;
            if (isSep) {
              i += 2;
              continue;
            }
            i += 1;
            continue;
          }
          if (isSep) {
            i += 1;
            continue;
          }
          html.push("<tr>");
          cells.forEach((c) => {
            html.push(`<td>${inline(c)}</td>`);
          });
          html.push("</tr>");
          i += 1;
          continue;
        }
        flushTable();
        if (/^---+$/.test(line.trim())) {
          flushList();
          html.push('<hr class="docs-hr">');
          i += 1;
          continue;
        }
        const hm = line.match(/^(#{1,3})\s+(.*)$/);
        if (hm) {
          flushList();
          const lvl = hm[1].length;
          const id = hm[2].toLowerCase().replace(/[^a-z0-9àâäéèêëïîôùûüç]+/gi, "-").replace(/^-|-$/g, "");
          html.push(`<h${lvl} id="${bag.esc(id)}" class="docs-h${lvl}">${inline(hm[2])}</h${lvl}>`);
          i += 1;
          continue;
        }
        const ul = line.match(/^[-*]\s+(.*)$/);
        if (ul) {
          if (listType !== "ul") {
            flushList();
            html.push('<ul class="docs-list">');
            listType = "ul";
          }
          html.push(`<li>${inline(ul[1])}</li>`);
          i += 1;
          continue;
        }
        const ol = line.match(/^\d+\.\s+(.*)$/);
        if (ol) {
          if (listType !== "ol") {
            flushList();
            html.push('<ol class="docs-list">');
            listType = "ol";
          }
          html.push(`<li>${inline(ol[1])}</li>`);
          i += 1;
          continue;
        }
        if (line.trim() === "") {
          flushList();
          i += 1;
          continue;
        }
        flushList();
        html.push(`<p class="docs-p">${inline(line)}</p>`);
        i += 1;
      }
      flushList();
      flushTable();
      if (inCode) {
        html.push(`<pre class="docs-code"><code>${bag.esc(codeBuf.join("\n"))}</code></pre>`);
      }
      return html.join("\n");
    };
    bag.viewDocs = async function viewDocs() {
      bag.root.innerHTML = bag.shell("Documentation", `
      ${bag.pageHeader("Documentation", false)}
      <div class="panel-card docs-panel">
        <div class="muted" id="docs-loading">Chargement du guide\u2026</div>
        <div class="docs-body" id="docs-body" hidden></div>
      </div>
    `, { subtitle: "Guide produit & API" });
      try {
        const res = await fetch("/docs/DOCUMENTATION.md?v=2.3.1", { headers: { Accept: "text/plain" } });
        if (!res.ok) throw new Error("Impossible de charger la documentation (" + res.status + ")");
        const md = await res.text();
        const el = document.getElementById("docs-body");
        const loading = document.getElementById("docs-loading");
        if (el) {
          el.innerHTML = bag.renderMarkdown(md);
          el.hidden = false;
        }
        if (loading) loading.remove();
      } catch (err) {
        const loading = document.getElementById("docs-loading");
        if (loading) loading.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
      }
    };
  }

  // public/assets/js/src/views/activity.js
  function install17() {
    bag.viewActivity = async function viewActivity() {
      const actionFilter = bag.state.filters.activityAction || "";
      let data;
      try {
        data = await bag.Api.audit({ limit: 150, action: actionFilter || void 0 });
      } catch (err) {
        bag.root.innerHTML = bag.shell("Journaux", `${bag.pageHeader("Journaux d\u2019activit\xE9", false)}<div class="error-box">${bag.esc(err.message)}</div>`, {
          subtitle: "Qui se connecte, qui fait quoi"
        });
        return;
      }
      const items = data?.Items || [];
      const total = Number(data?.Total) || items.length;
      const isAdmin = Number(bag.state.user?.Role) === 1;
      const rows = items.map((ev) => {
        const who = ev.Username || (ev.UserId ? `#${ev.UserId}` : "\u2014");
        const search = `${ev.Action} ${ev.Message} ${who} ${ev.Ip}`.toLowerCase();
        return `<tr data-search="${bag.esc(search)}">
        <td class="muted cell-nowrap">${bag.esc(bag.formatAuditTime(ev.CreatedAt))}</td>
        <td>${bag.esc(who)}</td>
        <td>${bag.auditActionBadge(ev.Action)}</td>
        <td>${bag.esc(ev.Message || "")}</td>
        <td class="mono muted">${bag.esc(ev.Ip || "\u2014")}</td>
      </tr>`;
      }).join("");
      bag.root.innerHTML = bag.shell("Journaux", `
      ${bag.pageHeader("Journaux d\u2019activit\xE9")}
      <div class="toolbar">
        <input class="search" id="filter" type="search" placeholder="Filtrer les \xE9v\xE9nements\u2026" value="${bag.esc(bag.state.filters.activity || "")}">
        <select id="audit-action-filter" class="audit-filter">
          <option value="">Toutes les actions</option>
          <option value="auth" ${actionFilter === "auth" ? "selected" : ""}>Connexions</option>
          <option value="user" ${actionFilter === "user" ? "selected" : ""}>Utilisateurs</option>
          <option value="stack" ${actionFilter === "stack" ? "selected" : ""}>Stacks</option>
          <option value="docker" ${actionFilter === "docker" ? "selected" : ""}>Docker</option>
          <option value="settings" ${actionFilter === "settings" ? "selected" : ""}>Param\xE8tres</option>
          <option value="api_key" ${actionFilter === "api_key" ? "selected" : ""}>Cl\xE9s API</option>
        </select>
        <div class="spacer"></div>
        <span class="muted mono" id="filter-count">${items.length} / ${total}</span>
      </div>
      <p class="muted audit-hint">${isAdmin ? "Histor des connexions et actions r\xE9alis\xE9es dans WharfMaster (admin : vue globale)." : "Vos connexions et actions dans WharfMaster."}</p>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Date</th><th>Utilisateur</th><th>Action</th><th>D\xE9tail</th><th>IP</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5" class="empty">Aucun \xE9v\xE9nement pour le moment \u2014 connectez-vous ou lancez une action.</td></tr>`}</tbody>
      </table></div>
    `, { subtitle: "Qui se connecte, qui fait quoi" });
      bag.bindRefresh();
      bag.bindSearch("activity");
      const sel = document.getElementById("audit-action-filter");
      if (sel) {
        sel.onchange = () => {
          bag.state.filters.activityAction = sel.value || "";
          bag.route();
        };
      }
    };
    bag.formatAuditTime = function formatAuditTime(ts) {
      const n = Number(ts) || 0;
      if (!n) return "\u2014";
      try {
        return new Date(n * 1e3).toLocaleString();
      } catch (_) {
        return String(ts);
      }
    };
    bag.auditActionBadge = function auditActionBadge(action) {
      const a = String(action || "");
      let tone = "neutral";
      if (a.includes("fail") || a.includes("rate_limited") || a.includes("delete") || a.includes("remove")) tone = "danger";
      else if (a.includes("login.ok") || a.includes("create") || a.includes("start")) tone = "success";
      else if (a.includes("update") || a.includes("stop") || a.includes("restart") || a.includes("password")) tone = "warn";
      return `<span class="audit-action tone-${tone}">${bag.esc(a)}</span>`;
    };
  }

  // public/assets/js/src/views/users.js
  function install18() {
    bag.viewUsers = async function viewUsers() {
      const users = await bag.Api.users();
      const list = users || [];
      const rows = list.map((u) => {
        const isSelf = Number(u.Id) === Number(bag.state.user?.Id);
        const src = u.AuthSource === "ldap" ? "AD/LDAP" : "Local";
        const search = `${u.Id} ${u.Username} ${bag.roleLabel(u.Role)} ${src}`.toLowerCase();
        return `<tr data-search="${bag.esc(search)}">
        <td>${bag.esc(u.Id)}</td>
        <td>${bag.esc(u.Username)}${isSelf ? ' <span class="muted">(vous)</span>' : ""}</td>
        <td>${bag.esc(bag.roleLabel(u.Role))}</td>
        <td>${bag.esc(src)}</td>
        <td class="actions"><div class="quick-actions">
          ${u.AuthSource === "ldap" ? "" : bag.iconBtn({ reset: u.Id, name: u.Username, title: "R\xE9initialiser le mot de passe", icon: "key" })}
          ${isSelf ? "" : bag.iconBtn({ del: u.Id, title: "Supprimer", icon: "remove", danger: true })}
        </div></td>
      </tr>`;
      }).join("");
      bag.root.innerHTML = bag.shell("Utilisateurs", `
      ${bag.pageHeader("Gestion des utilisateurs", false)}
      ${bag.settingsSubnav("users")}
      <div class="toolbar">
        <input class="search" id="filter" type="search" placeholder="Rechercher des utilisateurs\u2026" value="${bag.esc(bag.state.filters.users || "")}">
        ${bag.createBtn("add-user", "Ajouter un utilisateur")}
        <div class="spacer"></div>
        <span class="muted mono" id="filter-count">${list.length} / ${list.length}</span>
      </div>
      <div id="users-err"></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Id</th><th>Nom d'utilisateur</th><th>R\xF4le</th><th>Auth</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5" class="empty">Aucun utilisateur</td></tr>`}</tbody>
      </table></div>
      <div id="user-modal"></div>
    `);
      bag.bindSearch("users");
      document.getElementById("add-user").onclick = () => bag.showUserModal();
      bag.root.querySelectorAll("[data-del]").forEach((btn) => {
        bag.onBusyClick(btn, async (el) => {
          await bag.Api.deleteUser(el.dataset.del);
        }, { confirm: "Supprimer cet utilisateur ?", reload: true });
      });
      bag.root.querySelectorAll("[data-reset]").forEach((btn) => {
        btn.onclick = () => bag.showResetPasswordModal(btn.dataset.reset, btn.dataset.name);
      });
    };
    bag.showUserModal = function showUserModal() {
      const slot = document.getElementById("user-modal");
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
            <label class="field-label">R\xF4le</label>
            <select id="new-role">
              <option value="2">Utilisateur</option>
              <option value="1">Administrateur</option>
            </select>
          </div>
          <div class="actions-bar">
            <button class="btn btn-primary" id="save-user">Cr\xE9er l'utilisateur</button>
            <button class="btn" id="cancel-user" style="margin-left:8px">Annuler</button>
          </div>
        </div>
      </div>`;
      document.getElementById("cancel-user").onclick = () => {
        slot.innerHTML = "";
      };
      bag.onBusyClick(document.getElementById("save-user"), async () => {
        const username = document.getElementById("new-username").value.trim();
        const password = document.getElementById("new-password").value;
        const role = Number(document.getElementById("new-role").value);
        const errBox = document.getElementById("user-form-err");
        errBox.innerHTML = "";
        try {
          await bag.Api.createUser(username, password, role);
          slot.innerHTML = "";
          await bag.viewUsers();
        } catch (err) {
          errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
        }
      }, { disableSiblings: false, minMs: 250 });
    };
    bag.showResetPasswordModal = function showResetPasswordModal(userId, username) {
      const slot = document.getElementById("user-modal");
      const isSelf = Number(userId) === Number(bag.state.user?.Id);
      slot.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal" style="max-width:480px">
          <h3>R\xE9initialiser le mot de passe \xB7 ${bag.esc(username)}</h3>
          <div id="user-form-err"></div>
          ${isSelf ? `<div class="form-group">
            <label class="field-label">Mot de passe actuel</label>
            <input id="cur-password" type="password" autocomplete="current-password">
          </div>` : ""}
          <div class="form-group">
            <label class="field-label">Nouveau mot de passe <span class="req">*</span></label>
            <input id="new-password" type="password" minlength="10" autocomplete="new-password">
          </div>
          <div class="form-group">
            <label class="field-label">Confirmer le nouveau mot de passe <span class="req">*</span></label>
            <input id="confirm-password" type="password" minlength="10" autocomplete="new-password">
          </div>
          <div class="actions-bar">
            <button class="btn btn-primary" id="save-pass">Mettre \xE0 jour</button>
            <button class="btn" id="cancel-user" style="margin-left:8px">Annuler</button>
          </div>
        </div>
      </div>`;
      document.getElementById("cancel-user").onclick = () => {
        slot.innerHTML = "";
      };
      bag.onBusyClick(document.getElementById("save-pass"), async () => {
        const errBox = document.getElementById("user-form-err");
        errBox.innerHTML = "";
        const password = document.getElementById("new-password").value;
        const confirm2 = document.getElementById("confirm-password").value;
        if (password !== confirm2) {
          errBox.innerHTML = '<div class="error-box">Les mots de passe ne correspondent pas</div>';
          return;
        }
        const payload = { Password: password, PasswordConfirm: confirm2 };
        if (isSelf) payload.CurrentPassword = document.getElementById("cur-password").value;
        try {
          await bag.Api.changePassword(userId, payload);
          slot.innerHTML = "";
        } catch (err) {
          errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
        }
      }, { disableSiblings: false, minMs: 250 });
    };
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (document.querySelector("#app-modal .modal-backdrop")) bag.closeAppModal();
        const panel = document.getElementById("notif-panel");
        const bell = document.getElementById("notif-bell");
        if (panel && !panel.hidden) {
          panel.hidden = true;
          if (bell) bell.setAttribute("aria-expanded", "false");
        }
      }
    });
    document.addEventListener("click", (e) => {
      const wrap = e.target.closest(".notif-wrap");
      if (wrap) return;
      const panel = document.getElementById("notif-panel");
      const bell = document.getElementById("notif-bell");
      if (panel && !panel.hidden) {
        panel.hidden = true;
        if (bell) bell.setAttribute("aria-expanded", "false");
      }
    });
    bag.roleLabel = function roleLabel(role) {
      return Number(role) === 1 ? "Administrateur" : "Utilisateur";
    };
  }

  // public/assets/js/src/views/profile.js
  function install19() {
    bag.viewProfile = async function viewProfile() {
      const me = bag.state.user || {};
      const userId = Number(me.Id);
      const isLdap = String(me.AuthSource || "") === "ldap";
      let tokens = [];
      try {
        tokens = await bag.Api.listUserTokens(userId);
      } catch (_) {
        tokens = [];
      }
      if (!Array.isArray(tokens)) tokens = [];
      const tokenRows = tokens.map((t) => {
        const hint = t.rawHint ? `\u2026${t.rawHint}` : "";
        const prefix = `${t.prefix || "ptr_"}${hint}`;
        return `<tr data-token-id="${bag.esc(t.id)}">
        <td>${bag.esc(t.description || "\u2014")}</td>
        <td class="mono">${bag.esc(prefix)}</td>
        <td class="muted">${bag.esc(bag.fmtTs(t.dateCreated))}</td>
        <td class="muted">${t.lastUsed ? bag.esc(bag.fmtTs(t.lastUsed)) : "\u2014"}</td>
        <td class="actions"><div class="quick-actions">
          ${bag.iconBtn({ del: t.id, title: "R\xE9voquer cette cl\xE9", icon: "remove", danger: true })}
        </div></td>
      </tr>`;
      }).join("");
      bag.root.innerHTML = bag.shell("Profil", `
      ${bag.pageHeader("Profil", false)}
      <div id="profile-err"></div>
      <div class="panel" style="max-width:720px; margin-bottom:16px">
        <div class="section-title" style="margin-top:0">Compte</div>
        <dl class="kv" style="margin:0">
          <dt>Nom d'utilisateur</dt><dd><strong>${bag.esc(me.Username || "\u2014")}</strong></dd>
          <dt>R\xF4le</dt><dd>${bag.esc(typeof bag.roleLabel === "function" ? bag.roleLabel(me.Role) : Number(me.Role) === 1 ? "Administrateur" : "Utilisateur")}</dd>
          <dt>Authentification</dt><dd>${isLdap ? "AD / LDAP" : "Local"}</dd>
        </dl>
        <p class="muted" style="margin:14px 0 0">
          Les cl\xE9s API cr\xE9\xE9es ci-dessous agissent <strong>avec vos droits</strong>
          (r\xF4le, ACL n\u0153uds, partages) \u2014 pas plus, pas moins.
        </p>
      </div>

      ${isLdap ? "" : `
      <div class="panel" style="max-width:720px; margin-bottom:16px">
        <div class="section-title" style="margin-top:0">Mot de passe</div>
        <p class="muted" style="margin:0 0 14px">Modifier le mot de passe de votre compte local.</p>
        <div class="actions-bar">
          <button type="button" class="btn" id="profile-change-pass">Changer le mot de passe</button>
        </div>
      </div>`}

      <div class="panel" style="max-width:900px; margin-bottom:16px">
        <div class="section-title" style="margin-top:0">Cl\xE9s API</div>
        <p class="muted" style="margin:0 0 14px">
          Utilisez l\u2019en-t\xEAte <code>X-API-Key</code> pour appeler l\u2019API sans session.
          La cl\xE9 compl\xE8te n\u2019est affich\xE9e qu\u2019une seule fois \xE0 la cr\xE9ation.
        </p>
        <div class="toolbar" style="margin:0 0 12px">
          <button type="button" class="btn btn-primary" id="profile-new-token">G\xE9n\xE9rer une cl\xE9</button>
          <div class="spacer"></div>
          <span class="muted mono">${tokens.length} cl\xE9${tokens.length === 1 ? "" : "s"}</span>
        </div>
        <div class="table-wrap"><table class="data">
          <thead><tr>
            <th>Description</th><th>Pr\xE9fixe</th><th>Cr\xE9\xE9e</th><th>Dernier usage</th><th></th>
          </tr></thead>
          <tbody>${tokenRows || `<tr><td colspan="5" class="empty">Aucune cl\xE9 API</td></tr>`}</tbody>
        </table></div>
      </div>
      <div id="profile-modal"></div>
    `);
      const changePassBtn = document.getElementById("profile-change-pass");
      if (changePassBtn) {
        changePassBtn.onclick = () => {
          bag.showProfilePasswordModal(userId, me.Username || "");
        };
      }
      document.getElementById("profile-new-token").onclick = () => {
        bag.showCreateTokenModal(userId);
      };
      bag.root.querySelectorAll("[data-del]").forEach((btn) => {
        bag.onBusyClick(btn, async (el) => {
          await bag.Api.revokeUserToken(userId, el.dataset.del);
        }, { confirm: "R\xE9voquer cette cl\xE9 API ? Les int\xE9grations qui l\u2019utilisent cesseront de fonctionner.", reload: true });
      });
    };
    bag.showProfilePasswordModal = function showProfilePasswordModal(userId, username) {
      const slot = document.getElementById("profile-modal");
      if (!slot) return;
      slot.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal" style="max-width:480px">
          <h3>Changer le mot de passe \xB7 ${bag.esc(username)}</h3>
          <div id="profile-form-err"></div>
          <div class="form-group">
            <label class="field-label">Mot de passe actuel</label>
            <input id="cur-password" type="password" autocomplete="current-password">
          </div>
          <div class="form-group">
            <label class="field-label">Nouveau mot de passe <span class="req">*</span></label>
            <input id="new-password" type="password" minlength="10" autocomplete="new-password">
          </div>
          <div class="form-group">
            <label class="field-label">Confirmer <span class="req">*</span></label>
            <input id="confirm-password" type="password" minlength="10" autocomplete="new-password">
          </div>
          <div class="actions-bar">
            <button class="btn btn-primary" id="save-pass">Mettre \xE0 jour</button>
            <button class="btn" id="cancel-profile-modal" style="margin-left:8px">Annuler</button>
          </div>
        </div>
      </div>`;
      document.getElementById("cancel-profile-modal").onclick = () => {
        slot.innerHTML = "";
      };
      bag.onBusyClick(document.getElementById("save-pass"), async () => {
        const errBox = document.getElementById("profile-form-err");
        errBox.innerHTML = "";
        const password = document.getElementById("new-password").value;
        const confirm2 = document.getElementById("confirm-password").value;
        if (password !== confirm2) {
          errBox.innerHTML = '<div class="error-box">Les mots de passe ne correspondent pas</div>';
          return;
        }
        try {
          await bag.Api.changePassword(userId, {
            Password: password,
            PasswordConfirm: confirm2,
            CurrentPassword: document.getElementById("cur-password").value
          });
          slot.innerHTML = "";
        } catch (err) {
          errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
        }
      }, { disableSiblings: false, minMs: 250 });
    };
    bag.showCreateTokenModal = function showCreateTokenModal(userId) {
      const slot = document.getElementById("profile-modal");
      if (!slot) return;
      slot.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal" style="max-width:520px">
          <h3>G\xE9n\xE9rer une cl\xE9 API</h3>
          <div id="profile-form-err"></div>
          <p class="muted" style="margin:0 0 12px">
            La cl\xE9 h\xE9ritera de <strong>vos</strong> droits actuels. Confirmez avec votre mot de passe.
          </p>
          <div class="form-group">
            <label class="field-label">Description</label>
            <input id="token-desc" maxlength="120" placeholder="ex. scripts CI, monitoring\u2026" autocomplete="off">
          </div>
          <div class="form-group">
            <label class="field-label">Mot de passe <span class="req">*</span></label>
            <input id="token-password" type="password" autocomplete="current-password">
          </div>
          <div class="actions-bar">
            <button class="btn btn-primary" id="create-token">Cr\xE9er</button>
            <button class="btn" id="cancel-profile-modal" style="margin-left:8px">Annuler</button>
          </div>
        </div>
      </div>`;
      document.getElementById("cancel-profile-modal").onclick = () => {
        slot.innerHTML = "";
      };
      bag.onBusyClick(document.getElementById("create-token"), async () => {
        const errBox = document.getElementById("profile-form-err");
        errBox.innerHTML = "";
        const description = document.getElementById("token-desc").value.trim() || "api-key";
        const password = document.getElementById("token-password").value;
        try {
          const created = await bag.Api.createUserToken(userId, { description, password });
          bag.showTokenCreatedModal(created);
        } catch (err) {
          errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
        }
      }, { disableSiblings: false, minMs: 250 });
    };
    bag.showTokenCreatedModal = function showTokenCreatedModal(created) {
      const slot = document.getElementById("profile-modal");
      if (!slot) return;
      const raw = String(created?.rawAPIKey || "");
      slot.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal" style="max-width:560px">
          <h3>Cl\xE9 API cr\xE9\xE9e</h3>
          <div class="info-box" style="margin-bottom:12px">
            Copiez-la maintenant \u2014 elle ne sera plus jamais affich\xE9e.
          </div>
          <div class="form-group">
            <label class="field-label">Cl\xE9</label>
            <div style="display:flex;gap:8px;align-items:stretch">
              <input id="token-raw" class="mono" readonly value="${bag.esc(raw)}" style="flex:1">
              <button type="button" class="btn" id="copy-token">Copier</button>
            </div>
          </div>
          <p class="muted" style="margin:0 0 14px;font-size:12px">
            Exemple : <code>curl -H "X-API-Key: ${bag.esc(raw.slice(0, 12))}\u2026" https://\u2026/api/stacks</code>
          </p>
          <div class="actions-bar">
            <button class="btn btn-primary" id="close-token-modal">J\u2019ai copi\xE9 la cl\xE9</button>
          </div>
        </div>
      </div>`;
      document.getElementById("copy-token").onclick = async () => {
        try {
          await navigator.clipboard.writeText(raw);
          const btn = document.getElementById("copy-token");
          if (btn) btn.textContent = "Copi\xE9";
        } catch (_) {
        }
      };
      document.getElementById("close-token-modal").onclick = async () => {
        slot.innerHTML = "";
        await bag.viewProfile();
      };
    };
  }

  // public/assets/js/src/views/teams.js
  function install20() {
    bag.viewTeams = async function viewTeams() {
      const [teamsRes, users] = await Promise.all([
        bag.Api.teams(true),
        bag.Api.users()
      ]);
      const teams = Array.isArray(teamsRes) ? teamsRes : teamsRes?.Items || [];
      const teamRows = teams.map((t) => {
        const members = (t.Members || []).map((m) => m.Username).join(", ") || "\u2014";
        const search = `${t.Name} ${t.Description || ""} ${t.AdGroupDn || ""} ${members}`.toLowerCase();
        return `<tr data-search="${bag.esc(search)}">
        <td>${bag.esc(t.Name)}</td>
        <td class="muted">${bag.esc(t.Description || "\u2014")}</td>
        <td class="mono muted" style="font-size:12px">${bag.esc(t.AdGroupDn || "\u2014")}</td>
        <td>${bag.esc(members)}</td>
        <td class="actions"><div class="quick-actions">
          ${bag.iconBtn({ editTeam: t.Id, title: "\xC9diter", icon: "edit" })}
          ${bag.iconBtn({ delTeam: t.Id, title: "Supprimer", icon: "remove", danger: true })}
        </div></td>
      </tr>`;
      }).join("");
      bag.root.innerHTML = bag.shell("\xC9quipes", `
      ${bag.pageHeader("\xC9quipes", false)}
      ${bag.settingsSubnav("teams")}
      <div class="toolbar">
        <input class="search" id="filter" type="search" placeholder="Rechercher des \xE9quipes\u2026" value="${bag.esc(bag.state.filters.teams || "")}">
        ${bag.createBtn("add-team", "Nouvelle \xE9quipe")}
        <div class="spacer"></div>
        <span class="muted mono" id="filter-count">${teams.length} / ${teams.length}</span>
      </div>
      <div id="teams-err"></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Nom</th><th>Description</th><th>Groupe AD</th><th>Membres</th><th></th></tr></thead>
        <tbody>${teamRows || `<tr><td colspan="5" class="empty">Aucune \xE9quipe</td></tr>`}</tbody>
      </table></div>
      <div id="team-modal"></div>
    `, { subtitle: "Groupes et membres (droits sur les n\u0153uds)" });
      bag.bindSearch("teams");
      document.getElementById("add-team").onclick = () => bag.showTeamModal(null, users);
      bag.root.querySelectorAll("[data-edit-team]").forEach((btn) => {
        btn.onclick = async () => {
          const t = await bag.Api.team(btn.dataset.editTeam);
          bag.showTeamModal(t, users);
        };
      });
      bag.root.querySelectorAll("[data-del-team]").forEach((btn) => {
        bag.onBusyClick(btn, async (el) => {
          await bag.Api.deleteTeam(el.dataset.delTeam);
        }, { confirm: "Supprimer cette \xE9quipe ?", reload: true });
      });
    };
    bag.showTeamModal = function showTeamModal(team, users) {
      const slot = document.getElementById("team-modal");
      let teamId = team ? Number(team.Id) : 0;
      let members = [...team?.Members || []].map((m) => ({
        Id: Number(m.Id),
        Username: m.Username || String(m.Id)
      }));
      const allUsers = users || [];
      const renderMembers = () => {
        const tb = document.getElementById("team-member-rows");
        if (!tb) return;
        if (!members.length) {
          tb.innerHTML = `<tr><td colspan="2" class="empty">Aucun membre \u2014 ajoutez un utilisateur ci-dessous.</td></tr>`;
          return;
        }
        tb.innerHTML = members.map((m) => `<tr>
        <td><strong>${bag.esc(m.Username)}</strong></td>
        <td class="actions"><div class="quick-actions">
          <button type="button" class="btn btn-icon btn-sm btn-danger" title="Retirer" data-rm-member="${bag.esc(m.Id)}">
            <span class="btn-ico">${bag.ico("remove")}</span>
          </button>
        </div></td>
      </tr>`).join("");
        tb.querySelectorAll("[data-rm-member]").forEach((btn) => {
          bag.onBusyClick(btn, async (el) => {
            const uid = Number(el.dataset.rmMember);
            const box = document.getElementById("team-form-err");
            if (box) box.innerHTML = "";
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
        const sel = document.getElementById("team-add-user");
        if (!sel) return;
        const q = (document.getElementById("team-user-search")?.value || "").trim().toLowerCase();
        const taken = new Set(members.map((m) => Number(m.Id)));
        const opts = allUsers.filter((u) => !taken.has(Number(u.Id))).filter((u) => !q || String(u.Username || "").toLowerCase().includes(q)).map((u) => `<option value="${bag.esc(u.Id)}">${bag.esc(u.Username)}</option>`);
        sel.innerHTML = opts.length ? opts.join("") : '<option value="">Aucun utilisateur disponible</option>';
      };
      slot.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal modal-form modal-form-wide" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h3>${teamId ? "\xC9diter l\u2019\xE9quipe" : "Nouvelle \xE9quipe"}</h3>
              <div class="modal-sub">Membres et groupe AD</div>
            </div>
            <button type="button" class="icon-btn" id="cancel-team" title="Fermer" aria-label="Fermer">\u2715</button>
          </div>
          <div id="team-form-err"></div>
          <div class="form-group">
            <label class="field-label">Nom <span class="req">*</span></label>
            <input id="team-name" value="${bag.esc(team?.Name || "")}" autocomplete="off">
          </div>
          <div class="form-group">
            <label class="field-label">Description</label>
            <input id="team-desc" value="${bag.esc(team?.Description || "")}" autocomplete="off">
          </div>
          <div class="form-group">
            <label class="field-label">DN / CN groupe Active Directory</label>
            <input id="team-ad" placeholder="CN=DockerOps,OU=Groups,DC=example,DC=com" value="${bag.esc(team?.AdGroupDn || "")}" autocomplete="off">
            <p class="field-hint muted">Optionnel : au login LDAP, les membres de ce groupe AD rejoignent l\u2019\xE9quipe.</p>
          </div>
          <div class="section-title">Membres</div>
          <div class="panel" style="margin-bottom:12px;padding:12px">
            <div class="form-group" style="margin:0 0 10px">
              <label class="field-label">Rechercher un utilisateur</label>
              <input type="search" id="team-user-search" placeholder="Nom d\u2019utilisateur\u2026" autocomplete="off">
            </div>
            <div class="form-row-2" style="align-items:end;gap:10px">
              <div class="form-group" style="margin:0;flex:1">
                <label class="field-label">Utilisateur</label>
                <select id="team-add-user" class="select-block"></select>
              </div>
              <button type="button" class="btn btn-primary" id="team-add-btn">Ajouter</button>
            </div>
            ${!teamId ? '<p class="field-hint muted" style="margin:10px 0 0">Enregistrez d\u2019abord l\u2019\xE9quipe, ou ajoutez apr\xE8s cr\xE9ation \u2014 les ajouts sont appliqu\xE9s imm\xE9diatement une fois l\u2019\xE9quipe cr\xE9\xE9e.</p>' : ""}
          </div>
          <div class="table-wrap" style="margin-bottom:14px">
            <table class="data">
              <thead><tr><th>Utilisateur</th><th></th></tr></thead>
              <tbody id="team-member-rows"></tbody>
            </table>
          </div>
          <div class="actions-bar">
            <button class="btn btn-primary" id="save-team">${teamId ? "Enregistrer" : "Cr\xE9er l\u2019\xE9quipe"}</button>
            <button class="btn" id="cancel-team-2" style="margin-left:8px">Fermer</button>
          </div>
        </div>
      </div>`;
      const close = () => {
        slot.innerHTML = "";
      };
      document.getElementById("cancel-team").onclick = async () => {
        close();
        await bag.viewTeams();
      };
      document.getElementById("cancel-team-2").onclick = async () => {
        close();
        await bag.viewTeams();
      };
      fillAddSelect();
      renderMembers();
      document.getElementById("team-user-search")?.addEventListener("input", fillAddSelect);
      bag.onBusyClick(document.getElementById("team-add-btn"), async () => {
        const box = document.getElementById("team-form-err");
        if (box) box.innerHTML = "";
        const uid = Number(document.getElementById("team-add-user")?.value || 0);
        if (!uid) {
          if (box) box.innerHTML = `<div class="error-box">Choisissez un utilisateur.</div>`;
          return;
        }
        const u = allUsers.find((x) => Number(x.Id) === uid);
        try {
          if (!teamId) {
            const Name = document.getElementById("team-name").value.trim();
            if (!Name) {
              if (box) box.innerHTML = `<div class="error-box">Indiquez un nom d\u2019\xE9quipe avant d\u2019ajouter des membres.</div>`;
              return;
            }
            const created = await bag.Api.createTeam({
              Name,
              Description: document.getElementById("team-desc").value.trim(),
              AdGroupDn: document.getElementById("team-ad").value.trim()
            });
            teamId = Number(created?.Id || 0);
            if (!teamId) throw new Error("Cr\xE9ation d\u2019\xE9quipe \xE9chou\xE9e");
            const title = slot.querySelector("h3");
            if (title) title.textContent = "\xC9diter l\u2019\xE9quipe";
            const saveBtn = document.getElementById("save-team");
            if (saveBtn) saveBtn.textContent = "Enregistrer";
          }
          await bag.Api.addTeamMember(teamId, uid);
          if (!members.some((m) => Number(m.Id) === uid)) {
            members.push({ Id: uid, Username: u?.Username || String(uid) });
          }
          document.getElementById("team-user-search").value = "";
          fillAddSelect();
          renderMembers();
        } catch (err) {
          if (box) box.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
        }
      }, { disableSiblings: false, minMs: 150 });
      bag.onBusyClick(document.getElementById("save-team"), async () => {
        const errBox = document.getElementById("team-form-err");
        errBox.innerHTML = "";
        const payload = {
          Name: document.getElementById("team-name").value.trim(),
          Description: document.getElementById("team-desc").value.trim(),
          AdGroupDn: document.getElementById("team-ad").value.trim()
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
    };
    bag.aclRoleLabel = function aclRoleLabel(role) {
      const map = { read: "Lecture", operate: "Op\xE9ration", admin: "Admin n\u0153ud" };
      return map[role] || role || "\u2014";
    };
  }

  // public/assets/js/src/main.js
  installCore();
  bag.applyTheme(bag.readTheme());
  bag.applySidebarCollapsed(bag.readSidebarCollapsed());
  install();
  install2();
  install3();
  install4();
  install5();
  install6();
  install7();
  install8();
  install9();
  install10();
  install11();
  install12();
  install13();
  install14();
  install15();
  install16();
  install17();
  install18();
  install19();
  install20();
  window.addEventListener("hashchange", () => bag.route());
  bag.boot();
})();
