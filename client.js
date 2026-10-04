// dsh-aiwatch 的浏览器端：插件详情页里的「监听设置」卡片（2026-10-04）
//
// 为什么要有这个文件：dsh **不会**从 settings schema 自动生成表单（modsearch 的注释里也写了这句），
// 插件要在「插件列表 → 某个插件」的详情页里出现配置区，必须自己注册一个组件到插槽
// `plugins.bundle.config`（`dsh-client-ui-plugin-manager` 用 renderSlot('plugins.bundle.config',
// {view:'page'}, {entryKey: pkg.name}) 渲染它，key 必须等于 npm 包名）。
//
// 配置的读写走 dsh 官方给客户端的设置 RPC：ctx.remote.settings.describe() / mutate(ns, ops, revision)。
// 主机端（index.js）把 Config 字段都标了 `.volatile()`，所以这些字段是可写的（没标就会报
// `Plugin entry "<ns>" has no volatile fields`）。
//
// 写法照抄 modsearch 的"懒 CJS 协议"：window.__ModuleLoader__.load({id, factory})，
// factory 返回 cordis 插件的 exports —— 不需要构建、不 import 任何 dsh 客户端包。
// 组件只用手写 DOM + react.createElement（不依赖 primitives 的具体组件名），换 dsh 版本也不容易坏。
window.__ModuleLoader__.load({
  id: 'dsh-aiwatch',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    // 插件详情页按 npm 包名派发插槽
    var PKG = 'dsh-aiwatch';
    // 设置命名空间就是 profile 里那条插件的 id（cordis.patch.yml 里写的是 aiwatch）；两个都试
    var NS_CANDIDATES = ['aiwatch', 'dsh-aiwatch'];

    // 卡片的字段表：顺序即显示顺序。
    // ⚠️ def = 该字段在 index.js 里的 schema 默认值。**必须有**：配置文件里没写这个键时，
    //    describe() 给的 value 就是 undefined，不兜默认值就会显示成"关/空"（实际运行时是默认值），
    //    而且一按保存就会把错的值写进配置（2026-10-04 踩到：enabled 显示成关，保存就会真关掉监听）。
    var FIELDS = [
      { key: 'dirs', label: '要监听的文件夹', hint: '一行一个；留空 = 桌面', type: 'list', def: [] },
      { key: 'humanWindowSec', label: '判定窗口（秒）', hint: '多久没有键鼠动作就当「没人操作」', type: 'number', def: 20 },
      { key: 'injectMaxLines', label: '聚合上限（条）', hint: '一条消息最多带几条轨迹，攒到这么多就先发', type: 'number', def: 10 },
      { key: 'flushIdleSec', label: '兜底超时（秒）', hint: '最老的轨迹攒这么久还没发就自动发一次', type: 'number', def: 300 },
      { key: 'dataDir', label: '轨迹存放目录', hint: '留空 = 工作区 watch-log', type: 'text', def: '' },
      { key: 'watcherScript', label: '监听脚本路径', hint: '留空 = 工具\\desktop-watch\\watch-desktop.mjs', type: 'text', def: '' },
      { key: 'hotkey', label: '全局热键', hint: '点「录制」再按组合键（必须含 Ctrl 或 Alt，例如 Ctrl+Alt+A；只按 Shift+字母会和打大写字母冲突）；清除=停用；Win 系列需手输', type: 'keys', def: 'Ctrl+Alt+A' },
      { key: 'hotkeyWake', label: '热键触发时唤醒 AI', hint: '关掉则只静默补进上下文、不叫醒它', type: 'bool', def: true },
      { key: 'injectEnabled', label: '把轨迹静默写进绑定会话', hint: '不唤醒 AI', type: 'bool', def: true },
      { key: 'flushOnDshFocus', label: '切回 dsh 窗口就发', hint: '聚合注入的主触发', type: 'bool', def: true },
      { key: 'enabled', label: '监听开关', hint: '关掉即停止记录桌面轨迹', type: 'bool', def: true },
    ];

    var S = {
      box: { padding: '4px 0 12px' },
      title: { fontSize: '14px', fontWeight: 600, margin: '0 0 4px' },
      sub: { fontSize: '12px', opacity: 0.6, margin: '0 0 12px' },
      row: { display: 'flex', alignItems: 'flex-start', gap: '12px', margin: '0 0 10px' },
      label: { width: '190px', flex: '0 0 auto', fontSize: '13px', paddingTop: '6px' },
      hint: { fontSize: '11px', opacity: 0.55, marginTop: '4px' },
      col: { flex: '1 1 auto', minWidth: 0 },
      input: {
        width: '100%', boxSizing: 'border-box', padding: '6px 8px', fontSize: '13px',
        color: 'inherit', background: 'transparent', border: '1px solid rgba(128,128,128,.45)',
        borderRadius: '6px', outline: 'none',
      },
      area: { minHeight: '54px', fontFamily: 'inherit', resize: 'vertical' },
      bar: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '14px' },
      btn: {
        padding: '6px 14px', fontSize: '13px', borderRadius: '6px', cursor: 'pointer',
        border: '1px solid rgba(128,128,128,.45)', background: 'transparent', color: 'inherit',
      },
      note: { fontSize: '12px', opacity: 0.7 },
      err: { fontSize: '12px', color: '#e5484d', whiteSpace: 'pre-wrap' },
    };

    /** 设置里这个字段的有效值：没写就用 schema 默认值，别当成 false/空 */
    function effective(key, value) {
      var field = FIELDS.filter(function (f) { return f.key === key; })[0];
      if (value === undefined || value === null) return field ? field.def : value;
      return value;
    }

    /** 把设置里的值转成卡片自己的草稿形态（列表 -> 多行文本，数字 -> 字符串） */
    function toDraft(key, value) {
      var field = FIELDS.filter(function (f) { return f.key === key; })[0];
      var v = effective(key, value);
      if (!field) return v;
      if (field.type === 'list') return Array.isArray(v) ? v.join('\n') : (v == null ? '' : String(v));
      if (v == null) return field.type === 'bool' ? false : '';
      return field.type === 'bool' ? v !== false : String(v);
    }

    /** 草稿 -> 真正要写进配置的值 */
    function fromDraft(key, draft) {
      var field = FIELDS.filter(function (f) { return f.key === key; })[0];
      if (!field) return draft;
      if (field.type === 'list') {
        return String(draft || '').split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
      }
      if (field.type === 'bool') return draft === true;
      if (field.type === 'number') {
        var n = Number(String(draft).trim());
        return isFinite(n) ? n : 0;
      }
      return String(draft == null ? '' : draft);
    }

    function sameValue(a, b) {
      return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
    }

    /**
     * 解开 dsh 远程调用的信封：成功是 `{ ok: true, value: ... }`，失败是 `{ ok: false, error: { message } }`。
     * （踩过的坑：直接读 `res.namespaces` 会拿到 undefined，于是误判成"没有命名空间"。）
     */
    function unwrap(response) {
      if (response && typeof response === 'object' && 'ok' in response) {
        if (response.ok === false) {
          throw new Error(response.error && response.error.message ? response.error.message : '远程调用失败');
        }
        return response.value;
      }
      return response;
    }

    /** 把键盘事件转成热键写法："Ctrl+Alt+A"。浏览器拿不到 Win 键（被系统吃掉），所以要 Win 的得手输 */
    var KEY_NAMES = {
      ' ': 'Space', 'Enter': 'Enter', 'Escape': 'Esc', 'Tab': 'Tab',
      'ArrowUp': 'Up', 'ArrowDown': 'Down', 'ArrowLeft': 'Left', 'ArrowRight': 'Right',
      'Home': 'Home', 'End': 'End', 'PageUp': 'PgUp', 'PageDown': 'PgDn',
      'Insert': 'Ins', 'Delete': 'Del', 'Backspace': 'Backspace',
    };
    function specFromEvent(e) {
      var key = String(e.key || '');
      if (/^(Control|Alt|Shift|Meta)$/i.test(key)) return '';          // 还在按修饰键
      var main = '';
      if (/^[a-zA-Z]$/.test(key)) main = key.toUpperCase();
      else if (/^[0-9]$/.test(key)) main = key;
      else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) main = key.toUpperCase();
      else main = KEY_NAMES[key] || '';
      if (!main) return '';
      var mods = [];
      if (e.ctrlKey) mods.push('Ctrl');
      if (e.altKey) mods.push('Alt');
      if (e.shiftKey) mods.push('Shift');
      if (!e.ctrlKey && !e.altKey) return '';                          // 必须含 Ctrl 或 Alt：Shift+字母 会和打大写字母冲突
      return mods.join('+') + '+' + main;
    }

    function makeCard(react, rpc) {
      var h = react.createElement;

      return function AiwatchSettingsCard() {
        var loadingState = react.useState({ phase: 'loading' });
        var state = loadingState[0];
        var setState = loadingState[1];
        var noteState = react.useState('');
        var note = noteState[0];
        var setNote = noteState[1];

        var captureState = react.useState(false);
        var capturing = captureState[0];
        var setCapturing = captureState[1];

        // 录制模式：直接挂页面级 keydown（比"点只读输入框拿焦点"可靠），并拦住按键别让页面响应
        react.useEffect(function () {
          if (!capturing) return undefined;
          var onKey = function (e) {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'Escape') { setCapturing(false); return; }
            if (e.key === 'Backspace' || e.key === 'Delete') { setField('hotkey', ''); setCapturing(false); return; }
            var spec = specFromEvent(e);
            if (spec) { setField('hotkey', spec); setCapturing(false); }
          };
          document.addEventListener('keydown', onKey, true);
          return function () { document.removeEventListener('keydown', onKey, true); };
        }, [capturing]);

        var load = react.useCallback(function () {
          setNote('');
          setState({ phase: 'loading' });
          Promise.resolve(rpc.describe()).then(unwrap).then(function (view) {
            var list = (view && view.namespaces) || [];
            var hit = null;
            for (var i = 0; i < list.length; i++) {
              var ns = String(list[i] && list[i].ns || '');
              if (NS_CANDIDATES.indexOf(ns) >= 0) { hit = list[i]; break; }
              if (!hit && ns.indexOf('aiwatch') >= 0) hit = list[i];
            }
            if (!hit) {
              setState({
                phase: 'error',
                message: '没找到本插件的配置入口。现在能看到的命名空间：' +
                  (list.map(function (n) { return n.ns; }).join(', ') || '(空)'),
              });
              return;
            }
            var value = hit.value || {};
            var draft = {};
            FIELDS.forEach(function (f) { draft[f.key] = toDraft(f.key, value[f.key]); });
            setState({ phase: 'ready', ns: String(hit.ns), revision: hit.revision, value: value, draft: draft });
          }).catch(function (error) {
            setState({ phase: 'error', message: '读取配置失败：' + (error && error.message ? error.message : String(error)) });
          });
        }, []);

        react.useEffect(function () { load(); }, [load]);

        function setField(key, next) {
          setState(function (prev) {
            if (prev.phase !== 'ready') return prev;
            var draft = Object.assign({}, prev.draft);
            draft[key] = next;
            return Object.assign({}, prev, { draft: draft });
          });
        }

        function save() {
          if (state.phase !== 'ready') return;
          var ops = [];
          FIELDS.forEach(function (f) {
            // 用"有效值"比对：配置里没写的键（拿的是默认值）不会被误判成"改动"，也就不会写回错值
            var before = effective(f.key, state.value[f.key]);
            var after = fromDraft(f.key, state.draft[f.key]);
            if (!sameValue(before, after)) ops.push({ op: 'set', path: [f.key], value: after });
          });
          if (!ops.length) { setNote('没有改动'); return; }
          setNote('保存中…');
          Promise.resolve(rpc.mutate(state.ns, ops, state.revision)).then(unwrap).then(function () {
            setNote('已保存（' + ops.length + ' 项）');
            load();
          }).catch(function (error) {
            setNote('');
            setState(function (prev) {
              return Object.assign({}, prev, {
                message: '保存失败：' + (error && error.message ? error.message : String(error)),
              });
            });
          });
        }

        function discard() {
          if (state.phase !== 'ready') return;
          var draft = {};
          FIELDS.forEach(function (f) { draft[f.key] = toDraft(f.key, state.value[f.key]); });
          setState(Object.assign({}, state, { draft: draft }));
          setNote('已放弃修改');
        }

        var children = [h('div', { key: 'title', style: S.title }, '监听设置'), h('div', { key: 'sub', style: S.sub }, '改完点保存即时生效（目录/开关这类会自动重启监听）')];

        if (state.phase === 'loading') {
          children.push(h('div', { key: 'loading', style: S.note }, '加载中…'));
        } else if (state.phase === 'error') {
          children.push(h('div', { key: 'error', style: S.err }, state.message));
          children.push(h('div', { key: 'retry', style: S.bar }, h('button', { type: 'button', style: S.btn, onClick: load }, '重试')));
        } else {
          FIELDS.forEach(function (f) {
            var draftValue = state.draft[f.key];
            var control;
            if (f.type === 'bool') {
              control = h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', paddingTop: '6px' } },
                h('input', { type: 'checkbox', checked: draftValue === true, onChange: function (e) { setField(f.key, e.target.checked); } }),
                h('span', null, draftValue === true ? '开' : '关'));
            } else if (f.type === 'keys') {
              // 录制式热键输入：点「录制」→ 整页等着你按键 → 自动填进去（比点只读框拿焦点可靠）
              control = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
                h('input', {
                  style: Object.assign({}, S.input, { flex: '1 1 auto' }),
                  type: 'text',
                  readOnly: true,
                  value: draftValue || '',
                  placeholder: capturing ? '现在按组合键…（Esc 取消）' : '未设置（点右边「录制」）',
                }),
                h('button', {
                  type: 'button',
                  style: Object.assign({}, S.btn, capturing ? { borderColor: '#4c8dff', color: '#4c8dff' } : null),
                  onClick: function () { setCapturing(!capturing); },
                }, capturing ? '按键中…' : '录制'),
                draftValue ? h('button', {
                  type: 'button', style: S.btn,
                  onClick: function () { setField(f.key, ''); },
                }, '清除') : null,
              );
            } else if (f.type === 'list') {
              control = h('textarea', {
                style: Object.assign({}, S.input, S.area),
                value: draftValue, spellCheck: false,
                onChange: function (e) { setField(f.key, e.target.value); },
              });
            } else {
              control = h('input', {
                style: S.input,
                type: f.type === 'number' ? 'number' : 'text',
                value: draftValue, spellCheck: false,
                onChange: function (e) { setField(f.key, e.target.value); },
              });
            }
            children.push(h('div', { key: f.key, style: S.row },
              h('div', { style: S.label }, f.label, f.hint ? h('div', { style: S.hint }, f.hint) : null),
              h('div', { style: S.col }, control)));
          });
          children.push(h('div', { key: 'bar', style: S.bar },
            h('button', { type: 'button', style: S.btn, onClick: save }, '保存'),
            h('button', { type: 'button', style: S.btn, onClick: discard }, '放弃修改'),
            h('span', { style: S.note }, note || (state.message || ''))));
        }

        return h('div', { style: S.box }, children);
      };
    }

    function apply(ctx) {
      if (typeof ctx.inject !== 'function') return;
      // remote.settings 是可选的：没有它（非 web 环境）就静静不注册卡片
      ctx.inject(['remote', 'remote.settings'], function (rscope) {
        var rpc = rscope.remote.settings;
        ctx.inject(['slots'], function (scope) {
          var react;
          try {
            react = require('react');
          } catch (error) {
            console.error('[aiwatch] 设置卡片跳过：' + error);
            return;
          }
          var Card = makeCard(react, rpc);
          // 插件详情页（dsh 0.1.6-alpha.2 起）；旧版宿主只声明 settings.plugin.item，这里也补一份
          scope.slots.inject('plugins.bundle.config', function* () {
            yield scope.slots.register({ name: 'plugins.bundle.config', key: PKG }, Card);
          });
          scope.slots.inject('settings.plugin.item', function* () {
            yield scope.slots.register({ name: 'settings.plugin.item', id: 'aiwatch', key: 'aiwatch', order: 31 }, Card);
          });
        });
      });
    }

    exports.apply = apply;
    exports.inject = [];
    return module.exports;
  },
});
