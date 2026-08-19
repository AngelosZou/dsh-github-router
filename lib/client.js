/**
 * dsh-github-router — client half (hand-written factory bundle, no build step).
 *
 * One INDEPENDENT settings page (Settings → "GitHub 路由"), registered into
 * the `settings.section` slot exactly like dsh-notification does. The
 * configuration channel is the dsh-market pattern: the Host mounts
 * `/dsh-github-router/config` on the shared web server and this page talks
 * to it with plain same-origin fetch (GET = redacted view, POST = staged
 * writes with revision fencing). Edits are staged locally and written only
 * on save; a rejected write reloads the view so the next save fences
 * correctly.
 *
 * Layout: the common fields (token, proxy, route switches) sit up top; the
 * long tail (timeouts, retries, cache TTLs, mirrors, repos, git cache dir)
 * lives in a collapsed "Advanced settings" disclosure below.
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

    // ------------------------------------------------------------ specs
    // Flat scalar fields only: the client settings scope writes one field
    // per call (`scope.set(field, value)`), so nested schema objects are
    // deliberately absent from this page.
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
      { field: 'token', kind: 'text', spec: textSpec('token'), labelKey: 'field.token', hintKey: 'hint.token' },
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
    var NS = 'dsh-github-router';
    var zhDict = {
      'nav': 'GitHub 路由',
      'description': 'GitHub 读取的路由与缓存配置。',
      'advanced': '高级设置',
      'unavailable': '无法从宿主加载配置。',
      'save': '保存',
      'saving': '保存中…',
      'discard': '放弃修改',
      'failed': '保存失败，请重试。',
      'readOnly': '当前部署不允许修改设置。',
      'invalid': '无效值',
      'overridden': '已覆盖',
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
      'hint.token': '留空表示清除；优先使用 tokenEnv。',
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
      'unavailable': 'The configuration could not be loaded from the host.',
      'save': 'Save',
      'saving': 'Saving…',
      'discard': 'Discard',
      'failed': 'The save failed. Please retry.',
      'readOnly': 'This deployment does not allow settings edits.',
      'invalid': 'invalid',
      'overridden': 'overridden',
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
      'hint.token': 'Blank clears the value; prefer tokenEnv.',
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
    /**
     * The configuration channel is the dsh-market pattern: the Host mounts
     * `/dsh-github-router/config` on the shared web server, and this page
     * uses plain same-origin fetch (GET = redacted view, POST = writes).
     * The framework's settings scope is NOT used — its api-proxy serves
     * settings namespaces through a hardcoded allowlist that third-party
     * plugins cannot join.
     */

    /** One `/dsh-github-router/config` call (GET or POST). */
    function configCall(payload) {
      var init = payload === undefined
        ? { method: 'GET', cache: 'no-store' }
        : {
            method: 'POST',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          };
      return fetch('/dsh-github-router/config', init).then(function (response) {
        return response.json().then(function (envelope) {
          if (!envelope || envelope.ok !== true) {
            var message = envelope && envelope.error !== undefined ? String(envelope.error) : 'config call failed (HTTP ' + response.status + ')';
            throw new Error('dsh-github-router: ' + message);
          }
          return envelope.value;
        });
      });
    }

    /** Scope adapter over the plugin routes: same interface the form uses. */
    function RemoteScope() {
      var listeners = new Set();
      var snapshot = { status: 'loading', value: {}, base: {}, user: {}, revision: undefined, writable: false, mode: 'host' };

      function publish() {
        listeners.forEach(function (fn) { fn(); });
      }
      function accept(view) {
        snapshot = {
          status: 'ready',
          value: view && typeof view.value === 'object' ? view.value : {},
          base: view && typeof view.base === 'object' ? view.base : {},
          user: view && typeof view.user === 'object' ? view.user : {},
          revision: view && view.revision,
          writable: !!(view && view.writable),
          mode: 'host',
        };
        publish();
      }
      function fail(message) {
        snapshot = { status: 'unavailable', value: {}, base: {}, user: {}, revision: undefined, writable: false, mode: 'memory' };
        console.error('[dsh-github-router] config load failed', message);
        publish();
      }
      function load() {
        return configCall().then(accept, fail);
      }
      function write(op) {
        return configCall({ ops: [op], expectedRevision: snapshot.revision }).then(accept, function (error) {
          // A rejected write may mean the document moved (revision conflict)
          // or storage failed — re-read so the next save fences correctly.
          return load().then(function () { throw error; });
        });
      }

      load();
      return {
        getSnapshot: function () { return snapshot; },
        subscribe: function (fn) {
          listeners.add(fn);
          return function () { listeners.delete(fn); };
        },
        set: function (field, value) {
          return write({ op: 'set', path: [field], value: value });
        },
        unset: function (field) {
          return write({ op: 'unset', path: [field] });
        },
      };
    }

    /** A static scope stub for environments without fetch. */
    function unavailableScope() {
      var snapshot = { status: 'unavailable', value: {}, base: {}, user: {}, revision: undefined, writable: false, mode: 'memory' };
      return {
        getSnapshot: function () { return snapshot; },
        subscribe: function () { return function () {}; },
        set: function () { return Promise.resolve(); },
        unset: function () { return Promise.resolve(); },
      };
    }

    function GithubRouterForm(scope) {
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
            overridden = !stagedEntry.clear;
            if (!stagedEntry.clear) invalidField = f.spec.parse(stagedEntry.text) === undefined;
          } else {
            text = f.spec.format(sectionValue(f.field));
            overridden = stored(f.field);
          }
          if (invalidField) invalid = true;
          fields[f.field] = { text: text, overridden: overridden, invalid: invalidField };
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
            if (stored(field)) {
              writes.push({ field: field, run: function () { return scope.unset(field); } });
            }
            return;
          }
          if (stagedEntry.text === spec.format(sectionValue(field))) return;
          var write = spec.parse(stagedEntry.text);
          if (write === undefined) {
            blocked = true;
            return;
          }
          if (write.kind === 'clear') {
            writes.push({ field: field, run: function () { return scope.unset(field); } });
          } else {
            writes.push({ field: field, run: (function (value) { return function () { return scope.set(field, value); }; })(write.value) });
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
            return w.run().catch(function () { landed = false; });
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
          // The settings section shell synthesizes a `use<Key>` hook for
          // every entry of this `hooks` object (dsh-notification's
          // `hooks: { settings }` → `useSettings` is the working example).
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

    // ------------------------------------------------------------- page
    var pageStyle = { padding: '4px 0 24px' };
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

    function GithubRouterSection(props) {
      var state = props.useSettings(function (s) { return s; });
      var t = props.t;

      function renderField(f) {
        var fieldState = state.fields[f.field] || { text: '', overridden: false, invalid: false };
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
        return React.createElement(
          'label',
          { key: f.field, style: rowStyle, title: f.hintKey ? t(f.hintKey) : undefined },
          React.createElement('span', { style: labelStyle },
            t(f.labelKey),
            fieldState.overridden ? React.createElement('span', { style: { marginLeft: '6px', opacity: 0.6 } }, t('overridden')) : null,
          ),
          React.createElement('input', {
            type: f.kind === 'number' ? 'number' : 'text',
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
        { style: pageStyle },
        React.createElement('p', { style: { margin: '0 0 12px', opacity: 0.75, fontSize: '13px' } }, t('description')),
        !state.available ? React.createElement('div', { style: { color: '#c00', fontSize: '13px' } }, t('unavailable')) : null,
        state.available && !state.writable ? React.createElement('div', { style: { color: '#c00', fontSize: '13px' } }, t('readOnly')) : null,
        state.available ? React.createElement('div', { style: gridStyle }, PRIMARY_FIELDS.map(renderField)) : null,
        state.available ? React.createElement(
          'details',
          { style: { marginTop: '12px' } },
          React.createElement('summary', { style: { cursor: 'pointer', fontSize: '13px', opacity: 0.85 } }, t('advanced')),
          React.createElement('div', { style: Object.assign({ marginTop: '8px' }, gridStyle) }, ADVANCED_FIELDS.map(renderField)),
        ) : null,
        state.available ? React.createElement('footer', { style: footerStyle },
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
        ) : null,
      );
    }

    // ------------------------------------------------------------- plugin
    var name = 'dsh-github-router';
    var inject = ['slots', 'locale'];
    function apply(ctx) {
      console.info('[dsh-github-router] client bundle loaded');
      try {
        var t = ctx.locale.bind(NS);
        ctx.effect(function () {
          ctx.locale.register(NS, { zh: zhDict, en: enDict });
        }, 'dsh-github-router: locale dictionaries');
        var form = null;
        ctx.slots.inject('settings.section', function* () {
          yield ctx.slots.register({
            name: 'settings.section',
            id: 'dsh-github-router',
            order: 65,
            label: function () { return t('nav'); },
            locale: NS,
            inject: function () {
              if (form === null) {
                var scope = typeof fetch === 'function' ? new RemoteScope() : unavailableScope();
                form = new GithubRouterForm(scope);
              }
              return form.inject(t);
            },
          }, GithubRouterSection);
        });
        console.info('[dsh-github-router] settings section registered');
      } catch (error) {
        console.error('[dsh-github-router] client apply failed', error);
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
