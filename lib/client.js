/**
 * dsh-github-router — client half (hand-written factory bundle, no build step).
 *
 * One plugin configuration CARD inside the framework's Settings → Plugins →
 * configurable tab, registered into the `settings.plugin.item` slot keyed by
 * the settings namespace — the framework mechanism for plugins distributed
 * outside the repository (DSH ≥ 0.1.0-rc.7): the Host registers the
 * namespace, the browser registers the card under the same key, and the tab
 * pairs the two. No plugin-owned HTTP route exists anymore; reads and writes
 * ride the framework settings transport (`ctx.settingsScope`).
 *
 * The form keeps the staged-editing model: edits are staged locally and
 * written only on save; each write goes through the bound settings scope
 * (revision fencing, recovery reads on failure) and the card verifies the
 * user layer afterwards, keeping drafts that did not land. Secret fields
 * (the GitHub token) never ride a response, so the token control is
 * write-only: it starts blank, a typed value writes the token, and a blank
 * draft clears a configured one — the configured state comes from the
 * describe mirror's secret slot list.
 *
 * The module requires only `react` and
 * `@deepseek-ai/dsh-client-runtime/client` (the browser subpath — the bare
 * package name resolves to the Node half). All copy goes through the
 * framework locale service under the `dsh-github-router` namespace.
 */
window.__ModuleLoader__.load({
  id: 'dsh-github-router',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');
    var runtime = require('@deepseek-ai/dsh-client-runtime/client');

    var NAMESPACE = 'dsh-github-router';
    var NS = 'dsh-github-router';

    // ------------------------------------------------------------ specs
    function textSpec(field) {
      return {
        field: field,
        format: function (value) { return typeof value === 'string' ? value : ''; },
        parse: function (text) {
          var trimmed = String(text).trim();
          return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed };
        },
      };
    }
    function numberSpec(field) {
      return {
        field: field,
        format: function (value) { return typeof value === 'number' ? String(value) : ''; },
        parse: function (text) {
          var trimmed = String(text).trim();
          if (trimmed === '') return { kind: 'clear' };
          var parsed = Number(trimmed);
          return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : undefined;
        },
      };
    }
    function boolSpec(field) {
      return {
        field: field,
        format: function (value) { return value === true ? 'true' : 'false'; },
        parse: function (text) {
          var trimmed = String(text).trim();
          if (trimmed === '') return { kind: 'clear' };
          if (trimmed === 'true') return { kind: 'set', value: true };
          if (trimmed === 'false') return { kind: 'set', value: false };
          return undefined;
        },
      };
    }
    function csvSpec(field) {
      return {
        field: field,
        format: function (value) { return Array.isArray(value) ? value.join(', ') : ''; },
        parse: function (text) {
          var trimmed = String(text).trim();
          if (trimmed === '') return { kind: 'clear' };
          return {
            kind: 'set',
            value: trimmed.split(',').map(function (part) { return part.trim(); }).filter(function (part) { return part.length > 0; }),
          };
        },
      };
    }

    // ------------------------------------------------------ field catalog
    var PRIMARY_FIELDS = [
      { field: 'token', kind: 'secret', spec: textSpec('token'), labelKey: 'field.token', hintKey: 'hint.token' },
      { field: 'tokenEnv', kind: 'text', spec: textSpec('tokenEnv'), labelKey: 'field.tokenEnv', hintKey: 'hint.tokenEnv' },
      { field: 'proxy', kind: 'text', spec: textSpec('proxy'), labelKey: 'field.proxy', hintKey: 'hint.proxy' },
      { field: 'routesApi', kind: 'bool', spec: boolSpec('routesApi'), labelKey: 'field.routesApi', hintKey: null },
      { field: 'routesGh', kind: 'bool', spec: boolSpec('routesGh'), labelKey: 'field.routesGh', hintKey: null },
      { field: 'routesGit', kind: 'bool', spec: boolSpec('routesGit'), labelKey: 'field.routesGit', hintKey: null },
      { field: 'routesHtml', kind: 'bool', spec: boolSpec('routesHtml'), labelKey: 'field.routesHtml', hintKey: null },
    ];
    var ADVANCED_FIELDS = [
      { field: 'directTimeoutMs', kind: 'number', spec: numberSpec('directTimeoutMs'), labelKey: 'field.directTimeoutMs', hintKey: null },
      { field: 'proxyTimeoutMs', kind: 'number', spec: numberSpec('proxyTimeoutMs'), labelKey: 'field.proxyTimeoutMs', hintKey: null },
      { field: 'retries', kind: 'number', spec: numberSpec('retries'), labelKey: 'field.retries', hintKey: null },
      { field: 'maxBytes', kind: 'number', spec: numberSpec('maxBytes'), labelKey: 'field.maxBytes', hintKey: 'hint.maxBytes' },
      { field: 'cacheTtlMeta', kind: 'number', spec: numberSpec('cacheTtlMeta'), labelKey: 'field.cacheTtlMeta', hintKey: 'hint.cacheTtlMeta' },
      { field: 'cacheTtlContent', kind: 'number', spec: numberSpec('cacheTtlContent'), labelKey: 'field.cacheTtlContent', hintKey: 'hint.cacheTtlContent' },
      { field: 'routesMirror', kind: 'bool', spec: boolSpec('routesMirror'), labelKey: 'field.routesMirror', hintKey: 'hint.routesMirror' },
      { field: 'mirrors', kind: 'text', spec: csvSpec('mirrors'), labelKey: 'field.mirrors', hintKey: 'hint.mirrors' },
      { field: 'repos', kind: 'text', spec: csvSpec('repos'), labelKey: 'field.repos', hintKey: 'hint.repos' },
      { field: 'gitCacheDir', kind: 'text', spec: textSpec('gitCacheDir'), labelKey: 'field.gitCacheDir', hintKey: 'hint.gitCacheDir' },
    ];
    var FIELDS = PRIMARY_FIELDS.concat(ADVANCED_FIELDS);
    var SPECS = {};
    FIELDS.forEach(function (f) { SPECS[f.field] = f.spec; });

    // ------------------------------------------------------------- i18n
    var zhDict = {
      'nav': 'GitHub 路由',
      'description': 'GitHub 读取的路由与缓存配置。',
      'advanced': '高级设置',
      'save': '保存',
      'saving': '保存中…',
      'discard': '放弃修改',
      'failed': '保存失败，请重试。',
      'readOnly': '当前部署不允许修改设置。',
      'invalid': '无效值',
      'overridden': '已覆盖',
      'configured': '已配置',
      'field.token': 'GitHub Token',
      'field.tokenEnv': 'Token 环境变量',
      'field.proxy': '代理地址',
      'field.directTimeoutMs': '直连超时（毫秒）',
      'field.proxyTimeoutMs': '代理超时（毫秒）',
      'field.retries': '重试次数（429/5xx）',
      'field.maxBytes': '响应字节上限',
      'field.cacheTtlMeta': '元数据缓存（秒）',
      'field.cacheTtlContent': '内容缓存（秒）',
      'field.routesApi': 'api.github.com 路由',
      'field.routesGh': 'gh CLI 路由',
      'field.routesGit': 'git 协议路由',
      'field.routesHtml': '页面 HTML 路由',
      'field.routesMirror': '镜像路由（默认关闭）',
      'field.mirrors': '镜像基址（逗号分隔）',
      'field.repos': '本地仓库白名单（逗号分隔）',
      'field.gitCacheDir': 'git 缓存目录',
      'hint.token': '仅写入：留空并保存 = 清除已配置的 token；优先使用 tokenEnv。',
      'hint.tokenEnv': '指向 token 的环境变量名，例如 GITHUB_TOKEN。',
      'hint.proxy': '空 = 继承环境代理；direct = 永不代理；其余为代理 URL。',
      'hint.maxBytes': '每个响应体的字节上限（16384..8388608）。',
      'hint.cacheTtlMeta': 'PR/issue 元数据缓存秒数（0 = 不缓存）。',
      'hint.cacheTtlContent': '文件/提交/diff 等近似不可变内容的缓存秒数。',
      'hint.routesMirror': '镜像为第三方，会看到请求路径；仅在知情时开启。',
      'hint.mirrors': '例如 https://ghproxy.net；多个用逗号分隔。',
      'hint.repos': '授权只读 git 路由读取的本地仓库路径（仅 log/diff/show）。',
      'hint.gitCacheDir': '空 = <DSH_HOME>/storages/dsh-github-router/git。',
    };
    var enDict = {
      'nav': 'GitHub Router',
      'description': 'Routing and cache configuration for GitHub reads.',
      'advanced': 'Advanced settings',
      'save': 'Save',
      'saving': 'Saving…',
      'discard': 'Discard',
      'failed': 'The save failed. Please retry.',
      'readOnly': 'This deployment does not allow settings edits.',
      'invalid': 'invalid',
      'overridden': 'overridden',
      'configured': 'configured',
      'field.token': 'GitHub token',
      'field.tokenEnv': 'Token env var',
      'field.proxy': 'Proxy URL',
      'field.directTimeoutMs': 'Direct timeout (ms)',
      'field.proxyTimeoutMs': 'Proxy timeout (ms)',
      'field.retries': 'Retries (429/5xx)',
      'field.maxBytes': 'Response byte cap',
      'field.cacheTtlMeta': 'Metadata cache (s)',
      'field.cacheTtlContent': 'Content cache (s)',
      'field.routesApi': 'api.github.com route',
      'field.routesGh': 'gh CLI route',
      'field.routesGit': 'git protocol route',
      'field.routesHtml': 'Page HTML route',
      'field.routesMirror': 'Mirror route (off by default)',
      'field.mirrors': 'Mirror bases (comma-separated)',
      'field.repos': 'Local repo allowlist (comma-separated)',
      'field.gitCacheDir': 'Git cache directory',
      'hint.token': 'Write-only: a blank save clears the configured token; prefer tokenEnv.',
      'hint.tokenEnv': 'Environment variable naming the token, e.g. GITHUB_TOKEN.',
      'hint.proxy': "Empty = inherit ambient proxy env; 'direct' = never proxy; anything else is a proxy URL.",
      'hint.maxBytes': 'Byte cap per response body (16384..8388608).',
      'hint.cacheTtlMeta': 'Cache seconds for PR/issue metadata (0 = no cache).',
      'hint.cacheTtlContent': 'Cache seconds for near-immutable content (files, commits, diffs).',
      'hint.routesMirror': 'Mirrors are third parties that see requested paths; enable only knowingly.',
      'hint.mirrors': 'E.g. https://ghproxy.net; separate several with commas.',
      'hint.repos': 'Local repositories granted for read-only git-route reads (log/diff/show only).',
      'hint.gitCacheDir': 'Empty = <DSH_HOME>/storages/dsh-github-router/git.',
    };

    // ------------------------------------------------------------- form
    /** JSON-shaped deep equality for verifying writes against the user layer. */
    function sameJson(a, b) {
      return JSON.stringify(a) === JSON.stringify(b);
    }

    /**
     * Stages one card's edits over the plugin's settings namespace and writes
     * them on save. The scope is the framework-bound settings scope
     * (`ctx.settingsScope.bind({ namespace })`): its snapshot carries the
     * redacted resolved section (`status`/`value`/`base`/`user`/`revision`/
     * `writable`), and `set`/`unset` write one field each with revision
     * fencing and recovery reads. The describe mirror supplements the
     * snapshot with the secret slot list, the only signal that a redacted
     * field (the token) is configured.
     */
    function GithubRouterForm(scope, mirror) {
      var staged = new Map(); // field -> { text, clear }
      var saving = false;
      var failed = false;
      var store = runtime.createSnapshotStore({
        available: false,
        writable: false,
        dirty: false,
        invalid: false,
        saving: false,
        failed: false,
        fields: {},
      });

      function snap() { return scope.getSnapshot(); }
      function sectionValue(field) {
        var s = snap();
        return s.value === undefined || s.value === null ? undefined : s.value[field];
      }
      function baseValue(field) {
        var s = snap();
        return s.base === undefined || s.base === null ? undefined : s.base[field];
      }
      function stored(field) {
        var s = snap();
        return !!(s.user && typeof s.user === 'object' && Object.prototype.hasOwnProperty.call(s.user, field));
      }
      /** Whether a redacted secret slot holds a value (from the describe mirror). */
      function secretSet(field) {
        if (mirror === null || typeof mirror.namespace !== 'function') return false;
        var row = mirror.namespace(NAMESPACE);
        if (row === undefined || !Array.isArray(row.secrets)) return false;
        for (var i = 0; i < row.secrets.length; i++) {
          var slot = row.secrets[i];
          if (Array.isArray(slot.path) && slot.path.length === 1 && slot.path[0] === field) return slot.set === true;
        }
        return false;
      }

      function publish() {
        var s = snap();
        var fields = {};
        var invalid = false;
        FIELDS.forEach(function (f) {
          var stagedEntry = staged.get(f.field);
          var text;
          var overridden;
          var invalidField = false;
          if (stagedEntry !== undefined) {
            text = stagedEntry.text;
            if (stagedEntry.clear) {
              overridden = false;
            } else {
              var parsedStaged = f.spec.parse(stagedEntry.text);
              // The badge previews the save outcome: a staged blank that
              // parses to a clear is not an override anymore.
              overridden = parsedStaged !== undefined && parsedStaged.kind === 'set';
              invalidField = parsedStaged === undefined;
            }
          } else {
            text = f.kind === 'secret' ? '' : f.spec.format(sectionValue(f.field));
            overridden = f.kind === 'secret' ? secretSet(f.field) : stored(f.field);
          }
          if (invalidField) invalid = true;
          fields[f.field] = {
            text: text,
            overridden: overridden,
            invalid: invalidField,
            configured: f.kind === 'secret' && stagedEntry === undefined ? secretSet(f.field) : undefined,
          };
        });
        store.set({
          available: s.status === 'ready',
          writable: !!s.writable,
          dirty: staged.size > 0,
          invalid: invalid,
          saving: saving,
          failed: failed,
          fields: fields,
        });
      }
      scope.subscribe(publish);
      if (mirror !== null && typeof mirror.subscribe === 'function') mirror.subscribe(publish);
      publish();

      function edit(field, text) {
        staged.set(field, { text: String(text), clear: false });
        failed = false;
        publish();
      }
      function resetField(field) {
        staged.set(field, { text: SPECS[field].format(baseValue(field)), clear: true });
        failed = false;
        publish();
      }
      function discard() {
        if (staged.size === 0 && !failed) return;
        staged.clear();
        failed = false;
        publish();
      }
      function save() {
        if (saving || staged.size === 0) return;
        var writes = [];
        var blocked = false;
        staged.forEach(function (stagedEntry, field) {
          var spec = SPECS[field];
          if (stagedEntry.clear) {
            if (field === 'token') {
              // A blank draft clears the token only when one is configured.
              if (secretSet(field)) {
                writes.push({
                  field: field,
                  run: function () { return scope.unset(field).then(function () { return !secretSet(field); }); },
                });
              }
              return;
            }
            if (stored(field)) {
              writes.push({
                field: field,
                run: function () { return scope.unset(field).then(function () { return !stored(field); }); },
              });
            }
            return;
          }
          if (field === 'token') {
            var tokenText = stagedEntry.text.trim();
            if (tokenText === '') {
              // A blank draft clears the token when one is configured.
              if (secretSet(field)) {
                writes.push({
                  field: field,
                  run: function () { return scope.unset(field).then(function () { return !secretSet(field); }); },
                });
              }
              return;
            }
            writes.push({
              field: field,
              run: (function (value) {
                return function () { return scope.set(field, value).then(function () { return secretSet(field); }); };
              })(tokenText),
            });
            return;
          }
          if (stagedEntry.text === spec.format(sectionValue(field))) return;
          var write = spec.parse(stagedEntry.text);
          if (write === undefined) {
            blocked = true;
            return;
          }
          if (write.kind === 'clear') {
            writes.push({
              field: field,
              run: function () { return scope.unset(field).then(function () { return !stored(field); }); },
            });
          } else {
            writes.push({
              field: field,
              run: (function (value) {
                return function () {
                  return scope.set(field, value).then(function () {
                    var current = snap().user;
                    return !!(current && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, field) && sameJson(current[field], value));
                  });
                };
              })(write.value),
            });
          }
        });
        if (blocked || writes.length === 0) return;
        saving = true;
        failed = false;
        publish();
        var landed = true;
        var chain = Promise.resolve();
        writes.forEach(function (w) {
          chain = chain.then(function () {
            return w.run().then(function (ok) { if (ok !== true) landed = false; }, function () { landed = false; });
          });
        });
        chain.then(function () {
          if (landed) staged.clear();
          saving = false;
          failed = !landed;
          publish();
        });
      }

      function inject(t) {
        return {
          // The slots runtime synthesizes a `use<Key>` hook for every entry
          // of this `hooks` object (the shipped plugin cards' `hooks` →
          // `useBashCard` contract).
          hooks: { settings: store },
          t: t,
          edit: edit,
          resetField: resetField,
          save: save,
          discard: discard,
        };
      }
      return { inject: inject, store: store, save: save, edit: edit, discard: discard, resetField: resetField };
    }

    // ------------------------------------------------------------- card
    var cardStyle = { padding: '4px 0 16px' };
    var gridStyle = {
      display: 'grid',
      gridTemplateColumns: 'minmax(180px, 1fr) minmax(180px, 1fr)',
      gap: '8px 16px',
    };
    var rowStyle = { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '13px' };
    var labelStyle = { color: 'var(--color-text-secondary, #666)' };
    var inputStyle = {
      padding: '4px 6px',
      border: '1px solid var(--color-border, #ccc)',
      borderRadius: '4px',
      background: 'var(--color-bg-input, transparent)',
      color: 'inherit',
    };
    var boolRowStyle = { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px' };
    var footerStyle = { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px' };
    var buttonStyle = {
      padding: '4px 12px',
      border: '1px solid var(--color-border, #ccc)',
      borderRadius: '4px',
      background: 'var(--color-bg-button, transparent)',
      color: 'inherit',
      cursor: 'pointer',
    };

    function GithubRouterCard(props) {
      var state = props.useSettings(function (s) { return s; });
      var t = props.t;

      // The framework cards render nothing until their namespace is served;
      // this card follows the same posture.
      if (!state.available) return null;

      function renderField(f) {
        var fieldState = state.fields[f.field] || { text: '', overridden: false, invalid: false, configured: false };
        if (f.kind === 'bool') {
          return React.createElement(
            'label',
            { key: f.field, style: boolRowStyle, title: f.hintKey ? t(f.hintKey) : undefined },
            React.createElement('input', {
              type: 'checkbox',
              checked: fieldState.text === 'true',
              disabled: !state.writable,
              onChange: function (event) { props.edit(f.field, event.target.checked ? 'true' : 'false'); },
            }),
            t(f.labelKey),
          );
        }
        var marker;
        if (f.kind === 'secret') {
          marker = fieldState.configured === true
            ? React.createElement('span', { style: { marginLeft: '6px', opacity: 0.6 } }, t('configured'))
            : null;
        } else {
          marker = fieldState.overridden
            ? React.createElement('span', { style: { marginLeft: '6px', opacity: 0.6 } }, t('overridden'))
            : null;
        }
        return React.createElement(
          'label',
          { key: f.field, style: rowStyle, title: f.hintKey ? t(f.hintKey) : undefined },
          React.createElement('span', { style: labelStyle }, t(f.labelKey), marker),
          React.createElement('input', {
            type: f.kind === 'number' ? 'number' : f.kind === 'secret' ? 'password' : 'text',
            value: fieldState.text,
            disabled: !state.writable,
            style: inputStyle,
            onChange: function (event) { props.edit(f.field, event.target.value); },
          }),
          fieldState.invalid ? React.createElement('span', { style: { color: '#c00' } }, t('invalid')) : null,
        );
      }

      return React.createElement(
        'section',
        { style: cardStyle },
        React.createElement('p', { style: { margin: '0 0 12px', opacity: 0.75, fontSize: '13px' } }, t('description')),
        !state.writable ? React.createElement('div', { style: { color: '#c00', fontSize: '13px', marginBottom: '8px' } }, t('readOnly')) : null,
        React.createElement('div', { style: gridStyle }, PRIMARY_FIELDS.map(renderField)),
        React.createElement(
          'details',
          { style: { marginTop: '12px' } },
          React.createElement('summary', { style: { cursor: 'pointer', fontSize: '13px', opacity: 0.85 } }, t('advanced')),
          React.createElement('div', { style: Object.assign({ marginTop: '8px' }, gridStyle) }, ADVANCED_FIELDS.map(renderField)),
        ),
        React.createElement('footer', { style: footerStyle },
          React.createElement('button', {
            style: buttonStyle,
            disabled: !state.dirty || state.invalid || state.saving,
            onClick: props.save,
          }, state.saving ? t('saving') : t('save')),
          React.createElement('button', {
            style: buttonStyle,
            disabled: !state.dirty || state.saving,
            onClick: props.discard,
          }, t('discard')),
          state.failed ? React.createElement('span', { style: { color: '#c00', fontSize: '13px' } }, t('failed')) : null,
        ),
      );
    }

    // ------------------------------------------------------------- plugin
    var name = 'dsh-github-router';
    var inject = ['slots', 'locale', 'settingsScope', 'connection'];
    function apply(ctx) {
      console.info('[dsh-github-router] client bundle loaded');
      try {
        var t = ctx.locale.bind(NS);
        ctx.effect(function () {
          ctx.locale.register(NS, { zh: zhDict, en: enDict });
        }, 'dsh-github-router: locale dictionaries');
        var scope = ctx.settingsScope.bind({ namespace: NAMESPACE });
        var mirror = typeof ctx.settingsScope.describe === 'function' ? ctx.settingsScope.describe() : null;
        var form = new GithubRouterForm(scope, mirror);
        ctx.slots.inject('settings.plugin.item', function* () {
          yield ctx.slots.register({
            name: 'settings.plugin.item',
            key: NAMESPACE,
            locale: NS,
            inject: function () { return form.inject(t); },
          }, GithubRouterCard);
        });
        console.info('[dsh-github-router] settings card registered');
      } catch (error) {
        console.error('[dsh-github-router] client apply failed', error);
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
