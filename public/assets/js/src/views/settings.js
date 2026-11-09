import { bag } from '../bag.js';

export function install() {
  bag.viewSettings = async function viewSettings() {
    await bag.loadPublicUrl();
    let settings = {};
    try { settings = await bag.Api.settings(); } catch (_) { settings = {}; }
    bag.state.publicUrl = settings.PublicURL || settings.HostURL || bag.state.publicUrl || '';
    if (settings.TrivyEnabled != null) bag.state.trivyEnabled = !!settings.TrivyEnabled;
    const fallback = `${window.location.protocol}//${window.location.hostname}`;
    const chartHours = bag.metricChartHours();
    const retentionDays = bag.metricRetentionDays();
    const isAdmin = Number(bag.state.user?.Role) === 1;
    bag.root.innerHTML = bag.shell('Paramètres', `
      ${bag.pageHeader('Paramètres', false)}
      ${bag.settingsSubnav('settings')}
      <div id="settings-err"></div>
      <div class="panel" style="max-width:720px; margin-bottom:16px">
        <div class="section-title" style="margin-top:0">Apparence</div>
        <p class="muted" style="margin:0 0 14px">Basculer entre le thème clair et sombre. La préférence est enregistrée dans ce navigateur.</p>
        <div class="toolbar" style="margin:0">
          <button type="button" class="btn ${bag.state.theme === 'dark' ? 'btn-info' : ''}" id="theme-dark">Sombre</button>
          <button type="button" class="btn ${bag.state.theme === 'light' ? 'btn-info' : ''}" id="theme-light">Clair</button>
        </div>
      </div>
      <div class="panel" style="max-width:720px; margin-bottom:16px">
        <div class="section-title" style="margin-top:0">URL publique / hôte</div>
        <p class="muted" style="margin:0 0 14px">
          URL de base utilisée pour ouvrir les ports publiés (liens dans Conteneurs).
          Laisser vide pour utiliser l'hôte du navigateur (<code>${bag.esc(fallback)}</code>).
        </p>
        <div class="form-group">
          <label class="field-label">URL publique</label>
          <input id="public-url" type="text" placeholder="https://docker.example.com" value="${bag.esc(bag.state.publicUrl)}">
        </div>
        <div class="info-box">
          Exemple : avec l'URL publique <code>https://nas.lan</code>, un port publié <code>8080</code> devient
          <code>https://nas.lan:8080</code>.
        </div>
      </div>
      <div class="panel" style="max-width:720px; margin-bottom:16px">
        <div class="section-title" style="margin-top:0">Historique &amp; courbes</div>
        <p class="muted" style="margin:0 0 14px">
          Relevés du tableau de bord et des conteneurs (CPU / RAM / réseau) stockés en SQLite.
          Les courbes utilisent la même fenêtre glissante et la même rétention partout.
        </p>
        <div class="form-group">
          <label class="field-label" for="metrics-chart-hours">Fenêtre des courbes (heures)</label>
          <input id="metrics-chart-hours" type="number" min="1" max="168" step="1" value="${bag.esc(chartHours)}" placeholder="72">
          <p class="field-hint muted">Ex. 72 = dernières 72 h sur le dashboard et les modales conteneur (1–168).</p>
        </div>
        <div class="form-group">
          <label class="field-label" for="metrics-retention-days">Rétention en base (jours)</label>
          <input id="metrics-retention-days" type="number" min="7" max="365" step="1" value="${bag.esc(retentionDays)}" placeholder="90">
          <p class="field-hint muted">Conservation des relevés (7–365). Défaut 90 jours — partagée dashboard / conteneurs.</p>
        </div>
      </div>
      ${isAdmin ? `
      <div class="panel" style="max-width:720px; margin-bottom:16px">
        <div class="section-title" style="margin-top:0">Scan CVE (Trivy)</div>
        <p class="muted" style="margin:0 0 14px">
          Active ou désactive les scans CVE : à l’ouverture de la page Images (cache 24&nbsp;h, comme la vérif. de mises à jour),
          et avis non bloquant à la création de conteneurs / stacks.
          ${settings.TrivyInstalled === false
            ? '<br><span class="badge badge-warn">Binaire Trivy non détecté sur cette instance</span>'
            : ''}
        </p>
        <label class="field-label" style="display:flex;align-items:center;gap:8px;margin-bottom:0">
          <input type="checkbox" id="trivy-enabled" ${settings.TrivyEnabled !== false ? 'checked' : ''}>
          Activer le scan CVE Trivy
        </label>
      </div>` : ''}
      <div class="panel" style="max-width:720px">
        <div class="actions-bar">
          <button class="btn btn-primary" id="save-settings">Enregistrer</button>
        </div>
      </div>
      ${isAdmin ? `
      <div class="panel" style="max-width:720px; margin-top:16px">
        <div class="section-title" style="margin-top:0">Sauvegarde / reprise</div>
        <p class="muted" style="margin:0 0 14px">
          Archive ZIP pour repartir après un incident : base SQLite (utilisateurs, nœuds, stacks, registres, paramètres, audit, métriques),
          fichiers Compose, Dockerfiles enregistrés, secret JWT. Les volumes Docker et images ne sont pas inclus.
        </p>
        <div class="info-box" style="margin-bottom:14px">
          Conservez le fichier hors serveur — il contient des secrets. Un guide <code>RESTORE.md</code> est dans l’archive.
        </div>
        <div class="actions-bar" style="gap:8px;flex-wrap:wrap">
          <button type="button" class="btn btn-primary" id="backup-full">Télécharger le backup complet</button>
          <button type="button" class="btn" id="backup-sqlite" title="Base seule">SQLite uniquement</button>
        </div>
        <p class="muted" id="backup-status" style="margin:10px 0 0;font-size:12px"></p>
      </div>` : ''}
    `);
    document.getElementById('theme-dark').onclick = () => {
      bag.state.theme = bag.applyTheme('dark');
      bag.route();
    };
    document.getElementById('theme-light').onclick = () => {
      bag.state.theme = bag.applyTheme('light');
      bag.route();
    };
    bag.onBusyClick(document.getElementById('save-settings'), async () => {
      const value = document.getElementById('public-url').value.trim();
      const hours = parseInt(document.getElementById('metrics-chart-hours').value, 10);
      const days = parseInt(document.getElementById('metrics-retention-days').value, 10);
      const errBox = document.getElementById('settings-err');
      errBox.innerHTML = '';
      if (!Number.isFinite(hours) || hours < 1 || hours > 168) {
        errBox.innerHTML = `<div class="error-box">Fenêtre des courbes : entre 1 et 168 heures.</div>`;
        return;
      }
      if (!Number.isFinite(days) || days < 7 || days > 365) {
        errBox.innerHTML = `<div class="error-box">Rétention : entre 7 et 365 jours.</div>`;
        return;
      }
      const trivyEl = document.getElementById('trivy-enabled');
      const payload = {
        PublicURL: value,
        MetricsChartHours: hours,
        MetricsRetentionDays: days,
      };
      if (trivyEl) payload.TrivyEnabled = !!trivyEl.checked;
      try {
        const saved = await bag.Api.updateSettings(payload);
        bag.state.publicUrl = saved.PublicURL || '';
        bag.state.metricsChartHours = Number(saved.MetricsChartHours) || hours;
        bag.state.metricsRetentionDays = Number(saved.MetricsRetentionDays) || days;
        if (saved.TrivyEnabled != null) bag.state.trivyEnabled = !!saved.TrivyEnabled;
        bag.metricCache.scope = '';
        bag.metricCache.series = [];
        errBox.innerHTML = `<div class="info-box">Paramètres enregistrés.</div>`;
      } catch (err) {
        errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
      }
    }, { disableSiblings: false, minMs: 250 });

    const backupStatus = document.getElementById('backup-status');
    const runBackup = async (format) => {
      const errBox = document.getElementById('settings-err');
      if (errBox) errBox.innerHTML = '';
      if (backupStatus) backupStatus.textContent = 'Préparation de l’archive…';
      try {
        const res = await bag.Api.downloadBackup(format);
        if (backupStatus) {
          backupStatus.textContent = `Téléchargé : ${res.filename} (${bag.formatBytes(res.size)})`;
        }
      } catch (err) {
        if (backupStatus) backupStatus.textContent = '';
        if (errBox) errBox.innerHTML = `<div class="error-box">${bag.esc(err.message || 'Backup impossible')}</div>`;
      }
    };
    const fullBtn = document.getElementById('backup-full');
    const sqliteBtn = document.getElementById('backup-sqlite');
    if (fullBtn) bag.onBusyClick(fullBtn, () => runBackup('zip'), { disableSiblings: false, minMs: 300 });
    if (sqliteBtn) bag.onBusyClick(sqliteBtn, () => runBackup('sqlite'), { disableSiblings: false, minMs: 300 });
  }

  bag.viewSettingsAuth = async function viewSettingsAuth() {
    if (Number(bag.state.user?.Role) !== 1) {
      location.hash = '#settings';
      return;
    }
    let settings = {};
    try { settings = await bag.Api.settings(); } catch (_) { settings = {}; }
    const ldap = settings.Ldap || {};
    const method = Number(settings.AuthenticationMethod) === 2 || ldap.Enabled ? 'ldap' : 'local';
    bag.root.innerHTML = bag.shell('Authentification', `
      ${bag.pageHeader('Authentification', false)}
      ${bag.settingsSubnav('settings/auth')}
      <div id="settings-err"></div>
      <div class="panel" style="max-width:720px; margin-bottom:16px">
        <div class="section-title" style="margin-top:0">Méthode</div>
        <p class="muted" style="margin:0 0 14px">
          Mode actuel : <strong>${method === 'ldap' ? 'Active Directory / LDAP' : 'Comptes locaux'}</strong>.
          Les comptes locaux (admin bootstrap) restent utilisables même avec LDAP activé.
        </p>
        <label class="field-label" style="display:flex;align-items:center;gap:8px;margin-bottom:0">
          <input type="checkbox" id="ldap-enabled" ${ldap.Enabled ? 'checked' : ''}> Activer l’authentification Active Directory / LDAP
        </label>
      </div>
      <div class="panel" style="max-width:720px">
        <div class="section-title" style="margin-top:0">Active Directory / LDAP</div>
        <p class="muted" style="margin:0 0 14px">
          Connectez WharfMaster à votre domaine. Mappez les groupes AD via le champ « Groupe AD » des équipes.
        </p>
        <div class="form-group">
          <label class="field-label">Hôte</label>
          <input id="ldap-host" value="${bag.esc(ldap.Host || '')}" placeholder="dc.example.com">
        </div>
        <div class="form-group" style="display:flex;gap:12px;flex-wrap:wrap">
          <div style="flex:1;min-width:120px">
            <label class="field-label">Port</label>
            <input id="ldap-port" type="number" value="${bag.esc(ldap.Port || 389)}">
          </div>
          <label class="field-label" style="display:flex;align-items:center;gap:6px;margin-top:22px">
            <input type="checkbox" id="ldap-tls" ${ldap.UseTls ? 'checked' : ''}> StartTLS
          </label>
          <label class="field-label" style="display:flex;align-items:center;gap:6px;margin-top:22px">
            <input type="checkbox" id="ldap-ssl" ${ldap.UseSsl ? 'checked' : ''}> LDAPS
          </label>
        </div>
        <div class="form-group">
          <label class="field-label">Base DN</label>
          <input id="ldap-base" value="${bag.esc(ldap.BaseDn || '')}" placeholder="DC=example,DC=com">
        </div>
        <div class="form-group">
          <label class="field-label">Bind DN (compte service)</label>
          <input id="ldap-bind" value="${bag.esc(ldap.BindDn || '')}" placeholder="CN=svc-wharf,OU=Service,DC=example,DC=com">
        </div>
        <div class="form-group">
          <label class="field-label">Mot de passe bind ${ldap.BindPasswordSet ? '<span class="muted">(laisser vide pour conserver)</span>' : ''}</label>
          <input id="ldap-pass" type="password" autocomplete="new-password" placeholder="${ldap.BindPasswordSet ? '••••••••' : ''}">
        </div>
        <div class="form-group">
          <label class="field-label">Filtre utilisateur</label>
          <input id="ldap-filter" value="${bag.esc(ldap.UserFilter || '(sAMAccountName={username})')}">
        </div>
        <div class="form-group">
          <label class="field-label">Attribut username</label>
          <input id="ldap-attr" value="${bag.esc(ldap.UsernameAttr || 'sAMAccountName')}">
        </div>
        <div class="actions-bar">
          <button class="btn btn-primary" id="save-auth">Enregistrer</button>
        </div>
      </div>
    `, { subtitle: 'Connexion locale et Active Directory' });

    bag.onBusyClick(document.getElementById('save-auth'), async () => {
      const errBox = document.getElementById('settings-err');
      errBox.innerHTML = '';
      const ldapPass = document.getElementById('ldap-pass').value;
      const payload = {
        Ldap: {
          Enabled: document.getElementById('ldap-enabled').checked,
          Host: document.getElementById('ldap-host').value.trim(),
          Port: parseInt(document.getElementById('ldap-port').value, 10) || 389,
          UseTls: document.getElementById('ldap-tls').checked,
          UseSsl: document.getElementById('ldap-ssl').checked,
          BaseDn: document.getElementById('ldap-base').value.trim(),
          BindDn: document.getElementById('ldap-bind').value.trim(),
          UserFilter: document.getElementById('ldap-filter').value.trim(),
          UsernameAttr: document.getElementById('ldap-attr').value.trim(),
        },
      };
      if (ldapPass) payload.Ldap.BindPassword = ldapPass;
      try {
        await bag.Api.updateSettings(payload);
        errBox.innerHTML = `<div class="info-box">Paramètres d’authentification enregistrés.</div>`;
      } catch (err) {
        errBox.innerHTML = `<div class="error-box">${bag.esc(err.message)}</div>`;
      }
    }, { disableSiblings: false, minMs: 250 });
  }

  bag.loadPublicUrl = async function loadPublicUrl() {
    try {
      const s = await bag.Api.settings();
      bag.state.publicUrl = s.PublicURL || s.HostURL || '';
      if (s.MetricsChartHours != null) bag.state.metricsChartHours = Number(s.MetricsChartHours) || 72;
      if (s.MetricsRetentionDays != null) bag.state.metricsRetentionDays = Number(s.MetricsRetentionDays) || 90;
      if (s.TrivyEnabled != null) bag.state.trivyEnabled = !!s.TrivyEnabled;
    } catch (_) {
      bag.state.publicUrl = '';
    }
  }

}
