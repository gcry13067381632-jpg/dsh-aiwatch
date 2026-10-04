/**
 * dsh-aiwatch — 桌面操作轨迹 → 静默进「你绑定的那个会话」（不唤醒 AI）
 *
 * 关键设计：
 *   ① 会话必须先绑定：在 dsh 里输入 `/aiwatch bind` → 把**当前会话**设为接收会话（存 watch-log/aiwatch-bind.json）。
 *      没绑定就不往任何会话写，避免乱塞。
 *   ② 注入不在 LLM 回合内：
 *      · 权威判据 agent.whenIdle()（空闲立即返回、回合活跃时等 turn/end）——与 qqbot safeAppendUserMessage 同源；
 *      · 等不到空闲 → 降级 agent.inject 排队（回合安全、不唤醒），绝不回合中硬塞（会拆散 tool_calls 坏记录）。
 *   ③ 省 token 的注入格式（v0.1.3 起，主人要求）：
 *      · 标题行 + 「目录:」行 **只在一次唤醒里出现一次**；
 *        唤醒判定 = 读 session.snapshotEvents 回看最近 3000 条，取最后一次 `turn/start` 的 seq，
 *        比上次注入时记录的 seq 更大 → 这之间 AI 真跑过回合 → 下一条注入重新带标题与目录。
 *      · 每条轨迹只留 `[时间] 动作 文件名`，砍掉 前台/距键鼠/置信 这些字段。
 *   ④ 按「条目」注入（v0.1.4 起）：trail 里一条 = 一行 `[时间] …` 开头，后面可以跟缩进的差异行
 *      （文本文件/.docx 被编辑时，watch-desktop.mjs 会把改了哪几行记在下面）。取尾部按条目切，
 *      绝不把一块差异从中间截断；尾巴上没写完的一条留到下一轮再取。
 *   ⑤ **聚合注入**（v0.1.5 起，主人要求"别一句句发、别塞好几个 user/message 进上下文"）：
 *      轨迹先在内存里攒着（落盘 aiwatch-pending.json 防重启丢），三个触发点之一满足才**一次性**发出：
 *        · 主触发：**你切回 dsh 窗口/点进 dsh 界面**（读监听脚本写的 fg-state.json 判断前台是不是 dsh 相关）
 *          ——要求这批已经安静 ≥2 秒，避免"人在 dsh 窗口里"被拆成一条条发；
 *        · 上限：攒到 injectMaxLines 条；
 *        · 兜底：最老的一条攒了 flushIdleSec 秒还没发（默认 5 分钟）。
 *      这样上下文里就是"一批轨迹 = 一条 user/message"，而不是几十条。
 *   ⑥ 只有「键鼠动过之后」的文件变动才算你在操作（humanWindowSec）；「修改」还得内容真的变了才算
 *      （只是被读取/刷新不算），噪音文件也不记。
 *   ⑦ 配置在插件页里直接改（v0.1.6 起）：Config 的字段全部标了 `.volatile()`，dsh 的插件页会渲染成表单，
 *      改完即时生效、不用手改 cordis.patch.yml。volatile 字段在运行时是"实时值"（`.get()` 取），
 *      所以本插件用 `val()` + Proxy 每次访问都读最新值；改了「目录/判定窗口/开关/数据目录/脚本路径」，
 *      pump() 里的 reconcile() 会发现并自动重启监听子进程。
 *
 * ⚠️ v0.1.2 教训（务必不要回退）：
 *   绝不注册 ctx.on('agent/pre-step')。dsh 的 agent/pre-step 是**瀑布流中间件**，
 *   监听器必须 `async (payload, next) => { ... ; return next() }` 把结果传下去；
 *   只写 `(payload) => {}` 返回 undefined 会让宿主 `decision.kind` 读到 undefined 抛异常 →
 *   「本轮运行失败 Cannot read properties of undefined (reading 'kind')」，
 *   而且它是全局钩子，**所有会话的每一回合都会挂**。本插件因此零钩子：
 *   目标 agent 只从 ① 绑定命令拿到的 inv.agent ② agents 注册表 这两条纯读取路径来。
 *
 * 命令：/aiwatch bind | off | status | recent [条数] | flush
 * 安全：全程 fail-soft，异常只写 <dataDir>\aiwatch-diag.log。
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Schema from '@deepseek-ai/schemastery';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '0.1.6';
const WORKSPACE = 'D:\\newwenjianjia\\aiwork\\鲸鱼娘';
const DEFAULT_DATA = path.join(WORKSPACE, 'watch-log');
const DEFAULT_WATCHER = path.join(WORKSPACE, '工具', 'desktop-watch', 'watch-desktop.mjs');
const DESKTOP = path.join(process.env.USERPROFILE || 'C:\\Users\\作早饭', 'Desktop');
const IDLE_WAIT_MS = 6000;
const HEADER = '【桌面操作轨迹·自动记录（无需回答，主人说「检查刚才那些」时参考）】';
/** 回看多少条事件找 turn/start（qqbot 实测：窗口太小会漏判长回合） */
const TURN_LOOKBACK = 3000;
/** 一个条目开头的样子：[HH:MM:SS] … */
const ENTRY_RE = /^\[\d\d:\d\d:\d\d\]/;
/** 攒着的轨迹安静多久后，"切回 dsh 窗口"才允许触发发送（防被拆成一条条） */
const FOCUS_SETTLE_MS = 2000;
/** fg-state.json 多久没更新就当过期不可信 */
const FG_STALE_MS = 90 * 1000;
/** 待发队列的硬上限（超过就丢最老的，防止极端情况无限膨胀） */
const PENDING_MAX = 400;

export const name = 'dsh-aiwatch';
export const inject = ['agents', 'commands'];

export const Config = Schema.object({
  dirs: Schema.array(Schema.string()).default([]).description('要监听的文件夹（可填多个；留空 = 桌面）').volatile(),
  humanWindowSec: Schema.number().default(20).description('多久没有键盘/鼠标动作就当「没人操作」，这段期间的文件变动不记录（秒）').volatile(),
  injectEnabled: Schema.boolean().default(true).description('把真人操作轨迹静默写进「已绑定会话」（不唤醒 AI）').volatile(),
  injectMaxLines: Schema.number().default(10).description('聚合上限：一条消息最多带几条轨迹（攒到这么多就先发）').volatile(),
  flushOnDshFocus: Schema.boolean().default(true).description('切回 dsh 窗口时立刻把攒着的轨迹一次性发出去（主触发）').volatile(),
  flushIdleSec: Schema.number().default(300).description('兜底：最老的轨迹攒了这么多秒还没发就自动发一次（秒）').volatile(),
  enabled: Schema.boolean().default(true).description('监听开关（关掉即停止记录桌面轨迹）').volatile(),
  hotkey: Schema.string().default('Ctrl+Alt+A').description('全局热键：按一下就把攒着的轨迹发出去并唤醒 AI（写法如 Ctrl+Alt+A、Win+Shift+F2；留空=不启用）').volatile(),
  hotkeyWake: Schema.boolean().default(true).description('热键触发时真的唤醒 AI 干活（关掉则只静默补进上下文）').volatile(),
  dataDir: Schema.string().default('').description('轨迹存放目录；留空 = 工作区 watch-log').volatile(),
  watcherScript: Schema.string().default('').description('监听脚本路径；留空 = 工具\\desktop-watch\\watch-desktop.mjs').volatile(),
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (e) => String((e && e.message) || e).slice(0, 200);

export function apply(ctx, config) {
  const raw = config || {};
  /** volatile 字段在运行时是"实时值"（有 .get()），普通字段就是普通值 —— 两种都兼容 */
  const val = (field, fallback) => {
    try { if (field && typeof field.get === 'function') { const v = field.get(); return v === undefined ? fallback : v; } } catch { /* ignore */ }
    return field === undefined ? fallback : field;
  };
  /** 每次访问都重新读一遍配置，于是设置页里改完立刻生效 */
  const conf = () => {
    const n = (k, d) => { const v = Number(val(raw[k], d)); return v > 0 ? v : d; };
    const list = val(raw.dirs, []);
    return {
      enabled: val(raw.enabled, true) !== false,
      dirs: (Array.isArray(list) && list.length ? list : [DESKTOP]).map(String),
      hotkey: String(val(raw.hotkey, 'Ctrl+Alt+A') || '').trim(),
      hotkeyWake: val(raw.hotkeyWake, true) !== false,
      humanWindowSec: n('humanWindowSec', 20),
      injectEnabled: val(raw.injectEnabled, true) !== false,
      injectMaxLines: n('injectMaxLines', 10),
      flushOnDshFocus: val(raw.flushOnDshFocus, true) !== false,
      flushIdleSec: n('flushIdleSec', 300),
      dataDir: String(val(raw.dataDir, '') || '') || DEFAULT_DATA,
      watcherScript: String(val(raw.watcherScript, '') || '') || DEFAULT_WATCHER,
    };
  };
  // 用 Proxy 顶着：插件里所有 `cfg.xxx` 都是"现读现取"，不用改一堆调用点
  const cfg = new Proxy({}, { get: (_t, k) => conf()[k] });

  const state = {
    child: null, timer: null, offset: 0, agents: new Map(), bound: null, busy: false, target: '',
    lastTurnSeq: null,   // 上次注入时「目标会话最后一次 turn/start 的 seq」→ 变大即表示这之间被唤醒过
    lastHoldTurnSeq: null, // 上次写 ai-hold 时的回合序号（用于判断"刚开了新回合"）
    aiToolsInFlight: 0,  // 正在执行的"会写文件的工具"数量（诊断/收尾用）
    aiCallPaths: new Map(), // 工具调用 id → 它点名的路径（tool/result 时补一段收尾余量）
    aiToolSeen: false,   // 是否已收到过本会话的工具事件（诊断用，确认事件监听真的生效）
    lastHotkeyAt: 0,     // 上次处理过的热键时间戳（防重复触发）
    lastSpawnAt: 0,      // 上次拉起监听进程的时间（自愈重启的退避用）
    sentKeys: new Set(), // 已发过的轨迹条目指纹（热键兜底取历史时用来去重）
    sentOrder: [],       // 上面那个的先进先出顺序（超 400 条就丢最老的）
    pending: [],         // 攒着还没发的轨迹条目
    pendingSince: 0,     // 这批是从什么时候开始攒的
    busyFlush: false,
    fgLogged: '',
  };
  const trailFile = () => path.join(cfg.dataDir, 'trail.txt');
  const bindFile = () => path.join(cfg.dataDir, 'aiwatch-bind.json');
  const pendingFile = () => path.join(cfg.dataDir, 'aiwatch-pending.json');
  const fgStateFile = () => path.join(cfg.dataDir, 'fg-state.json');
  const aiHoldFile = () => path.join(cfg.dataDir, 'ai-hold.json');

  const diag = (line) => {
    try {
      fs.mkdirSync(cfg.dataDir, { recursive: true });
      fs.appendFileSync(path.join(cfg.dataDir, 'aiwatch-diag.log'), `[${new Date().toISOString()}] ${line}\n`, 'utf8');
    } catch { /* ignore */ }
  };
  const log = (m) => { try { ctx.logger?.info?.(`[aiwatch] ${m}`); } catch { /* ignore */ } diag(m); };

  const readBind = () => { try { return JSON.parse(fs.readFileSync(bindFile(), 'utf8')); } catch { return {}; } };
  const saveBind = (o) => { try { fs.mkdirSync(cfg.dataDir, { recursive: true }); fs.writeFileSync(bindFile(), JSON.stringify(o, null, 2), 'utf8'); } catch { /* ignore */ } };
  state.target = String(readBind().sessionId || '');

  // ── 待发队列的落盘 / 读回（防重启丢轨迹）──
  function loadPending() {
    try {
      const o = JSON.parse(fs.readFileSync(pendingFile(), 'utf8'));
      if (Array.isArray(o.items) && o.items.length) {
        state.pending = o.items.map(String).slice(-PENDING_MAX);
        state.pendingSince = Number(o.at) || Date.now();
        log('启动时读回未发出的轨迹 ' + state.pending.length + ' 条');
      }
    } catch { /* 没有就算了 */ }
  }
  function savePending() {
    try {
      fs.mkdirSync(cfg.dataDir, { recursive: true });
      if (!state.pending.length) { try { fs.unlinkSync(pendingFile()); } catch { /* ignore */ } return; }
      fs.writeFileSync(pendingFile(), JSON.stringify({ at: state.pendingSince || Date.now(), items: state.pending }), 'utf8');
    } catch { /* ignore */ }
  }

  try {
    const svc = ['agents', 'commands'].map((k) => {
      let v = null;
      try { v = typeof ctx.get === 'function' ? ctx.get(k) : ctx[k]; } catch { v = undefined; }
      return `${k}=${v ? 'Y' : 'N'}`;
    }).join(' ');
    log(`v${VERSION} 加载完成 | 服务: ${svc} | 绑定会话: ${(state.target || '(未绑定，用 /aiwatch bind)').slice(0, 8)}`);
    log('本版本零钩子（不注册任何 ctx.on）；轨迹按批聚合发出（切回 dsh 窗口 / 攒满 / 超时）');
  } catch (e) { log('能力探测异常: ' + errText(e)); }

  // ── 监听子进程 ──
  function startWatch() {
    if (state.child) return;
    try {
      const args = [cfg.watcherScript, '--dir', cfg.dirs[0], '--out', cfg.dataDir, '--human-window', String(cfg.humanWindowSec * 1000), '--hotkey', cfg.hotkey];
      state.child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      state.child.stdout?.on('data', (d) => { for (const l of String(d).split('\n')) if (l.trim()) log('[watch] ' + l.trim().slice(0, 180)); });
      state.child.stderr?.on('data', (d) => log('[watch:err] ' + String(d).trim().slice(0, 180)));
      state.child.on('exit', (c) => { log('监听进程退出 code=' + c); state.child = null; });
    } catch (e) { log('启动监听失败: ' + errText(e)); return; }
    state.lastSpawnAt = Date.now();   // 自愈重启的退避计时（防"起不来"时疯狂重启）
    try { state.offset = fs.statSync(trailFile()).size; } catch { state.offset = 0; }
    log('监听已启动: ' + cfg.dirs.join(' , ') + ' | 输出 ' + cfg.dataDir);
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(() => { void pump(); }, 3000);
  }
  function stopWatch() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    if (state.child) { try { state.child.kill(); } catch { /* ignore */ } state.child = null; log('监听已停止'); }
  }

  /**
   * 设置页里改了"需要重启监听才生效"的参数（目录/判定窗口/开关/数据目录/脚本路径）→ 自动重启监听子进程。
   * 其它参数（聚合上限、超时、切窗口触发、注入开关）本来就是现读现取的，不用重启。
   */
  const sigOf = () => JSON.stringify([cfg.enabled, cfg.dirs, cfg.humanWindowSec, cfg.dataDir, cfg.watcherScript, cfg.hotkey]);
  let runningSig = '';
  function reconcile() {
    const sig = sigOf();
    if (sig === runningSig) {
      // 自愈：参数没变、但监听进程已经不在了（被杀 / 抢锁失败 / 崩了）→ 自己拉起来。
      // 为什么需要：2026-10-04 踩到——某次重载读到旧快照把监听停了，之后"开了却没在听"，
      // 主人改了监听目录却毫无动静。加 20 秒退避，避免起不来时疯狂重启。
      if (cfg.enabled && !state.child && Date.now() - state.lastSpawnAt > 20000) {
        log('监听进程不在了（配置仍是开）→ 自动重新拉起');
        runningSig = '';
      } else return;
    }
    runningSig = sig;
    log('配置变了 → 按新参数重启监听（目录: ' + cfg.dirs.join(' , ') + ' | 判定窗口: ' + cfg.humanWindowSec + 's | 开关: ' + (cfg.enabled ? '开' : '关') + '）');
    stopWatch();
    if (cfg.enabled) startWatch(); else log('监听已关（config.enabled=false）');
  }

  /**
   * 把轨迹文本切成「条目」：一条 = 一行 `[时间] …` 开头，后面可以跟缩进的差异行。
   * （文本文件被编辑时，监听脚本会把改了哪些行跟在轨迹行下面，不能按"行"切，否则会把差异拦腰截断。）
   */
  function splitEntries(text) {
    const out = [];
    let cur = null;
    for (const rawLine of String(text).split('\n')) {
      const line = rawLine.replace(/\s+$/, '');
      if (ENTRY_RE.test(line)) {
        if (cur) out.push(cur.join('\n'));
        cur = [line];
      } else if (cur && line.trim()) {
        cur.push(line);
      }
    }
    if (cur) out.push(cur.join('\n'));
    return out;
  }

  /** 读轨迹文件尾部（最多 256KB）并取最后 n 条 */
  function tailEntries(n) {
    try {
      const size = fs.statSync(trailFile()).size;
      const from = Math.max(0, size - 256 * 1024);
      const len = size - from;
      if (len <= 0) return [];
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(trailFile(), 'r');
      try { fs.readSync(fd, buf, 0, len, from); } finally { fs.closeSync(fd); }
      return splitEntries(buf.toString('utf8')).slice(-n);
    } catch { return []; }
  }

  /** 前台窗口是不是"和 dsh 有关"（浏览器里开着 dsh、或 dsh 客户端）——信息由监听脚本写进 fg-state.json */
  function dshWindowFocused() {
    try {
      const st = fs.statSync(fgStateFile());
      if (Date.now() - st.mtimeMs > FG_STALE_MS) return false;   // 太久没更新，不可信
      const o = JSON.parse(fs.readFileSync(fgStateFile(), 'utf8'));
      const fg = String(o.fg || '');
      const title = String(o.title || '');
      const hit = /deepseek|harness/i.test(fg) || /deepseek|harness|\bdsh\b|鲸鱼娘/i.test(title);
      if (hit && state.fgLogged !== fg + '|' + title) {
        state.fgLogged = fg + '|' + title;
        log('检测到 dsh 相关窗口在前台: ' + fg + ' | ' + title);
      }
      return hit;
    } catch { return false; }
  }

  /**
   * 目标 agent（纯读取，绝不注册钩子）：
   *   ① 绑定命令当场抓住的 agent（进程内一直有效）
   *   ② agents 注册表 get(sessionId)
   *   ③ agents 注册表 list() 里按 session.id 匹配
   */
  function targetAgent() {
    const sid = state.target;
    if (!sid) return null;
    if (state.bound && String(state.bound?.session?.id || '') === sid) return state.bound;
    try {
      const reg = typeof ctx.get === 'function' ? ctx.get('agents') : ctx.agents;
      if (reg && typeof reg.get === 'function') {
        const a = reg.get(sid);
        if (a) { state.bound = a; log('目标 agent 来自 agents.get()'); return a; }
      }
      if (reg && typeof reg.list === 'function') {
        const items = reg.list() || [];
        for (const it of items) {
          if (!it) continue;
          const aid = String(it?.session?.id || it?.id || '');
          if (aid === sid) { state.bound = it; log('目标 agent 来自 agents.list()'); return it; }
        }
      }
    } catch (e) { log('解析目标 agent 异常: ' + errText(e)); }
    return null;
  }

  /** 目标会话最近一次 LLM 回合的开启序号（null = 读不到事件）——决定要不要重发标题 */
  function lastTurnStartSeq(agent) {
    try {
      const s = agent?.session;
      const seq = typeof s?.seq === 'number' ? s.seq : -1;
      if (seq <= 0 || typeof s.snapshotEvents !== 'function') return null;
      const tail = s.snapshotEvents(Math.max(0, seq - TURN_LOOKBACK), seq);
      let lastStart = -1;
      for (const ev of tail) if (ev && ev.type === 'turn/start') lastStart = ev.seq;
      return lastStart;
    } catch { return null; }
  }

  /** 目标会话此刻是否处在 LLM 回合中（turn/start 已开、turn/end 未闭合；qqbot 同款只读判据） */
  function sessionTurnActive(agent) {
    try {
      const s = agent?.session;
      const seq = typeof s?.seq === 'number' ? s.seq : -1;
      if (seq <= 0 || typeof s.snapshotEvents !== 'function') return false;
      const tail = s.snapshotEvents(Math.max(0, seq - TURN_LOOKBACK), seq);
      let lastStart = -1;
      let lastEnd = -1;
      for (const ev of tail) {
        if (ev.type === 'turn/start') lastStart = ev.seq;
        else if (ev.type === 'turn/end') lastEnd = ev.seq;
      }
      return lastStart > lastEnd;
    } catch { return false; }
  }

  const aiHoldUntil = () => { try { return Number(JSON.parse(fs.readFileSync(aiHoldFile(), 'utf8')).until) || 0; } catch { return 0; } };

  /** 写 ai-hold.json：告诉监听脚本「这段时间里的文件变动是 AI 干的」 */
  function markAiHold(until, why) {
    try {
      if (until <= aiHoldUntil() + 300) return;        // 已有更长的标记就别缩短
      fs.writeFileSync(aiHoldFile(), JSON.stringify({ until, why: 'aiwatch: ' + String(why || '') }), 'utf8');
    } catch { /* ignore */ }
  }

  // ── 更准的做法：从工具调用的参数里读出"它到底改的是哪个文件"，只标那几个文件 ──
  const aiPathsFile = () => path.join(cfg.dataDir, 'ai-paths.json');
  const normPath = (p) => String(p).trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  /** 参数里这些键基本就是目标路径 */
  const PATH_KEYS = /^(file_path|filepath|path|file|filename|notebook_path|target|dest|destination|workdir|cwd|dir|directory|files|paths)$/i;
  /** 这些键里放的是命令/脚本，只能从文本里捞绝对路径 */
  const CMD_KEYS = /^(command|cmd|script|code|args|input|shell)$/i;

  function markAiPaths(paths, until) {
    try {
      if (!paths || !paths.length) return;
      let map = {};
      try { const o = JSON.parse(fs.readFileSync(aiPathsFile(), 'utf8')); if (o && o.paths && typeof o.paths === 'object') map = o.paths; } catch { /* 没有就算了 */ }
      const now = Date.now();
      for (const k of Object.keys(map)) if (!(Number(map[k]) > now)) delete map[k];   // 顺手清过期的
      for (const p of paths) { const k = normPath(p); map[k] = Math.max(Number(map[k]) || 0, until); }
      const keys = Object.keys(map);
      if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete map[k];
      fs.writeFileSync(aiPathsFile(), JSON.stringify({ paths: map }), 'utf8');
    } catch { /* ignore */ }
  }

  /** 工具调用的参数对象（不同宿主版本字段名可能不同，都试一遍） */
  const argsOf = (event) => {
    const d = (event && event.data) || {};
    let a = d.args !== undefined ? d.args : (d.arguments !== undefined ? d.arguments : (d.input !== undefined ? d.input : (d.call && (d.call.args !== undefined ? d.call.args : d.call.arguments))));
    if (typeof a === 'string') { try { a = JSON.parse(a); } catch { return { command: a }; } }
    return (a && typeof a === 'object') ? a : {};
  };

  /** 从工具参数里收集"被点名的路径"（只认明确是路径的键；命令类键里捞绝对路径） */
  function collectPaths(obj) {
    const out = new Set();
    const walk = (v, depth) => {
      if (depth > 4 || v === null || v === undefined) return;
      if (typeof v === 'string') return;                    // 裸字符串不猜（很可能是文件内容）
      if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
      if (typeof v !== 'object') return;
      for (const [k, val] of Object.entries(v)) {
        if (typeof val === 'string' && PATH_KEYS.test(k)) { out.add(val.trim()); continue; }
        if (typeof val === 'string' && CMD_KEYS.test(k)) {
          // 命令文本按空白/引号/分隔符切开，再挑出真正的绝对路径（别贪吃后续参数）
          for (const tok of String(val).split(/[\s"'`;|&()<>]+/)) {
            const t = tok.replace(/[,:]+$/, '');
            if (/^[A-Za-z]:[\\/]/.test(t)) out.add(t);
          }
          continue;
        }
        if (val && typeof val === 'object') walk(val, depth + 1);
      }
    };
    walk(obj, 0);
    return [...out].filter(Boolean);
  }

  /** 会写文件的工具名（只有这些工具在跑时才打开 AI 标记） */
  const FILE_TOOLS = /^(write|edit|multi_edit|apply_patch|notebook_edit|pwsh|bash|sh|powershell|cmd)/i;
  const toolNameOf = (event) => {
    const d = (event && event.data) || {};
    return String(d.name || d.tool || d.toolName || (d.call && (d.call.name || d.call.tool)) || '');
  };

  /**
   * 精确标记"AI 正在写文件"：只听会话事件里「会写文件的工具正在跑」的那段时间。
   *
   * 为什么不用"整回合都是 AI"（第一版就是这么写的，被主人否了）：一个回合可能跑好几分钟，
   * 主人在同一时间段里改同一个文件夹的文件，就会被误标成 AI 的 → 轨迹被丢掉，那才是真丢数据。
   * 为什么可以用 ctx.on('session/event')：它是**普通广播事件**（qqbot 的出站就是这么听的：
   * `ctx.on('session/event', outboundHandler)`，回调返回 undefined 完全正常），
   * 不是 agent/pre-step 那种必须 return next() 的瀑布流；而且这里全程 try/catch，绝不冒到宿主。
   * 事件形状：handler(session, event)，会话 id 在 session.header.id；event.type ∈ tool/call、tool/result、
   * assistant/message（思考在 data.message.content[] 里 type==='reasoning' 的块）。
   */
  function watchAiTools() {
    try {
      if (typeof ctx.on !== 'function') return;
      ctx.on('session/event', (session, event) => {
        try {
          const sid = String((session && session.header && session.header.id) || '');
          if (!sid || sid !== state.target) return;
          const type = String((event && event.type) || '');
          if (type === 'tool/call') {
            const name = toolNameOf(event);
            if (!name || !FILE_TOOLS.test(name)) return;
            if (!state.aiToolSeen) { state.aiToolSeen = true; log('已收到本会话的工具调用事件，按文件标记生效（首个: ' + name + '）'); }
            state.aiToolsInFlight++;
            const callId = String((event.data && (event.data.callId || event.data.id)) || '');
            const paths = collectPaths(argsOf(event));
            if (paths.length) {
              if (callId) state.aiCallPaths.set(callId, paths);
              markAiPaths(paths, Date.now() + 15000);   // 只标它点名的文件/目录，不标时间
              log('AI 正在改 ' + paths.slice(0, 3).join(' , ') + (paths.length > 3 ? ' 等 ' + paths.length + ' 个' : '') + '（工具 ' + name + '）');
            } else if (/^(pwsh|bash|sh|powershell|cmd)/i.test(name)) {
              // 命令行工具没解析出路径：只留 4 秒兜底，尽量不影响主人自己动手
              markAiHold(Date.now() + 4000, '命令行工具(路径未知): ' + name);
            }
          } else if (type === 'tool/result') {
            const callId = String((event.data && (event.data.callId || event.data.id)) || '');
            const paths = state.aiCallPaths.get(callId);
            if (paths) { markAiPaths(paths, Date.now() + 3000); state.aiCallPaths.delete(callId); }   // 收尾余量
            if (state.aiToolsInFlight > 0) state.aiToolsInFlight--;
          }
        } catch { /* ignore */ }
      });
      log('已开始监听会话事件：只在"会写文件的工具正在跑"时标记 AI（比整回合精确）');
    } catch (e) { log('监听会话事件失败（不影响其它功能）: ' + errText(e)); }
  }

  // ── 全局热键：主人按一下 = 把攒着的轨迹发出去，并（可选）真的唤醒 AI 干活 ──
  const hotkeyFile = () => path.join(cfg.dataDir, 'hotkey.json');
  function readHotkey() {
    try { const o = JSON.parse(fs.readFileSync(hotkeyFile(), 'utf8')); return { at: Number(o.at) || 0, spec: String(o.spec || '') }; }
    catch { return { at: 0, spec: '' }; }
  }

  // ── 记住"哪些轨迹条目已经发过了"：热键兜底要取历史条目时，用它把发过的滤掉，免得重复注入 ──
  const entryKey = (e) => String(e).replace(/\s+/g, ' ').slice(0, 60);
  function rememberSent(entries) {
    try {
      for (const e of entries) {
        const k = entryKey(e);
        if (state.sentKeys.has(k)) continue;
        state.sentKeys.add(k);
        state.sentOrder.push(k);
      }
      while (state.sentOrder.length > 400) state.sentKeys.delete(state.sentOrder.shift());
    } catch { /* ignore */ }
  }

  /**
   * 热键被按下：
   *   · 攒着的一批轨迹优先；一条都没有就取最近几条（至少让 AI 知道"主人叫你过来看"）；
   *   · hotkeyWake 打开时走 agent.followup(msg) —— 那是 send(msg,'next-step',true)：排进 inbox **并唤醒**开始干活。
   *     注意：dsh 里"唤醒"必须带一条 inbox 输入（驱动处是 `if (wakeRequested && this.inbox.hasPending) wakeDriver()`），
   *     所以不存在"空唤醒"；但这条消息的来源标成 source.kind='system'，不假装是主人发言。
   */
  async function onHotkey(spec) {
    if (state.busyFlush) return;
    state.busyFlush = true;
    try {
      // 只发"攒着还没发的"：绝不翻历史（翻历史必然重复——那些早就发过了，而且重启后去重记忆会清空）
      const batch = state.pending.slice(0, Math.max(cfg.injectMaxLines, 20));
      const fromPending = batch.length > 0;
      if (!batch.length) batch.push('（最近没有新的桌面操作，只是把你叫过来）');
      const text = [HEADER, '目录: ' + cfg.dirs.join(' , '), '（主人刚按了热键 ' + spec + ' 叫你过来看这些）', ...batch].join('\n');
      let msg = null;
      try {
        const mod = await import('@deepseek-ai/dsh-llm');
        // 主人 2026-10-04 定：热键这条也按"用户消息"身份走（和普通注入一致，网页里就是一条正常发言）；
        // 正文里写清"主人刚按了热键 X 叫你过来看这些"，所以不会被误当成主人手打的字。
        if (mod && typeof mod.createUserMessage === 'function') msg = mod.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
      } catch { /* 宿主未暴露 → 手构造 */ }
      if (!msg) msg = { role: 'user', id: randomUUID(), content: [{ type: 'text', text }], source: { kind: 'user' } };

      const agent = targetAgent();
      if (!agent) { log('热键 ' + spec + ' 触发，但绑定会话不在内存：请在该会话里发一条消息或重新 /aiwatch bind'); return; }
      if (cfg.hotkeyWake !== false && typeof agent.followup === 'function') {
        agent.followup(msg);                     // 排队 + 唤醒（来源按主人要求用 user 身份）
        rememberSent(batch);
        log('热键 ' + spec + '：已发出 ' + batch.length + ' 条并唤醒 AI 处理');
      } else {
        await injectEntries(batch, '热键 ' + spec + '（不唤醒）');
        log('热键 ' + spec + '：已静默写入 ' + batch.length + ' 条（未唤醒）');
      }
      if (fromPending) {
        state.pending = state.pending.slice(batch.length);
        state.pendingSince = state.pending.length ? Date.now() : 0;
        savePending();
      }
    } catch (e) { log('热键处理异常: ' + errText(e)); } finally { state.busyFlush = false; }
  }

  /** 把一批轨迹（1 条 user/message）静默写进绑定会话 */
  async function injectEntries(entries, why) {
    if (!entries.length) return false;
    if (!state.target) { log('未绑定会话（在 dsh 里输入 /aiwatch bind），本批 ' + entries.length + ' 条先留着'); return false; }
    const agent = targetAgent();
    if (!agent) { log('绑定会话不在内存（' + state.target.slice(0, 8) + '…）：请在该会话里再发一条消息或重新 /aiwatch bind，本批不注入'); return false; }

    // 唤醒判定：这期间目标会话跑过新的回合 → 这次注入重新带标题与目录
    const turnSeq = lastTurnStartSeq(agent);
    const newWake = turnSeq === null ? true : (state.lastTurnSeq === null || turnSeq > state.lastTurnSeq);
    const head = newWake ? [HEADER, '目录: ' + cfg.dirs.join(' , ')] : [];
    const text = [...head, ...entries].join('\n');

    let msg = null;
    try {
      const mod = await import('@deepseek-ai/dsh-llm');
      if (mod && typeof mod.createUserMessage === 'function') {
        msg = mod.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
      }
    } catch { /* 宿主未暴露 → 手构造 */ }
    if (!msg) msg = { role: 'user', id: randomUUID(), content: [{ type: 'text', text }], source: { kind: 'system' } };

    const s = agent.session;
    if (s && typeof s.append === 'function') {
      // 必须等回合真空闲：回合中 append 会拆散 tool_calls 污染记录
      let idle = typeof agent.whenIdle !== 'function';
      if (!idle) {
        try { await Promise.race([agent.whenIdle().then(() => { idle = true; }), sleep(IDLE_WAIT_MS)]); }
        catch { idle = false; }
      }
      // whenIdle 没等到时，用只读的回合判据复核一次；确实已结束就照常 append
      if (!idle && !sessionTurnActive(agent)) idle = true;
      if (idle) {
        try {
          s.append('user/message', msg, { surfaceOp: 'append' });
          rememberSent(entries);
          if (turnSeq !== null) state.lastTurnSeq = turnSeq;
          log(`已静默写入绑定会话(append) ${entries.length} 条${newWake ? '（带标题+目录）' : '（同一次唤醒内，省略标题）'} | 触发: ${why || '?'}`);
          return true;
        } catch (e) { log('append 失败: ' + errText(e)); }
      } else {
        log('回合未空闲：降级 inject 排队（不唤醒、不硬塞）');
      }
    }
    try {
      if (typeof agent.inject === 'function') {
        agent.inject(msg);
        rememberSent(entries);
        if (turnSeq !== null) state.lastTurnSeq = turnSeq;
        log(`已排队注入绑定会话(inject) ${entries.length} 条 | 触发: ${why || '?'}`);
        return true;
      }
    } catch (e) { log('inject 失败: ' + errText(e)); }
    log('该会话不支持注入，本批 ' + entries.length + ' 条留着');
    return false;
  }

  /** 到点没到点？到点就把攒着的轨迹整批发出去（主触发=切回 dsh 窗口；兜底=攒满/超时） */
  async function maybeFlush(force) {
    if (state.busyFlush || !state.pending.length) return;
    const now = Date.now();
    const aged = state.pendingSince ? now - state.pendingSince : 0;
    const focus = cfg.flushOnDshFocus && aged >= FOCUS_SETTLE_MS && dshWindowFocused();
    const maxed = state.pending.length >= cfg.injectMaxLines;
    const timedOut = aged >= cfg.flushIdleSec * 1000;
    if (!force && !focus && !maxed && !timedOut) return;

    const why = force ? '手动 flush' : focus ? '切回 dsh 窗口' : maxed ? '攒满 ' + cfg.injectMaxLines + ' 条' : '超时 ' + Math.round(aged / 1000) + 's';
    state.busyFlush = true;
    const batch = state.pending.slice(0, cfg.injectMaxLines);
    const rest = state.pending.slice(cfg.injectMaxLines);
    try {
      const ok = await injectEntries(batch, why);
      if (ok) {
        state.pending = rest;
        state.pendingSince = rest.length ? now : 0;
        savePending();
      } else {
        log('本批 ' + batch.length + ' 条没发出去（' + why + '），继续攒着等下次');
      }
    } catch (e) { log('聚合发送异常: ' + errText(e)); } finally { state.busyFlush = false; }
  }

  /** 看热键文件有没有新触发（60 秒内算数，处理过就不重复） */
  function maintainHotkey() {
    if (!cfg.hotkey) return;
    const hk = readHotkey();
    if (!hk.at || hk.at <= state.lastHotkeyAt) return;
    if (Date.now() - hk.at > 60000) { state.lastHotkeyAt = hk.at; return; }   // 太旧了（比如插件刚重启）
    state.lastHotkeyAt = hk.at;
    void onHotkey(hk.spec || cfg.hotkey);
  }

  async function pump() {
    reconcile();                                    // 设置页改了参数 → 该重启监听就重启
    maintainHotkey();                               // 主人按了热键 → 发一批 + 唤醒
    if (state.busy || !cfg.injectEnabled) return;
    state.busy = true;
    try {
      let size = 0;
      try { size = fs.statSync(trailFile()).size; } catch { size = 0; }
      if (size < state.offset) state.offset = 0;
      if (size > state.offset) {
        const buf = Buffer.alloc(size - state.offset);
        const fd = fs.openSync(trailFile(), 'r');
        try { fs.readSync(fd, buf, 0, buf.length, state.offset); } finally { fs.closeSync(fd); }
        const chunk = buf.toString('utf8');
        // 尾巴上如果有没写完的一行/一条，留给下一轮，别把差异块截一半
        let text = chunk;
        if (!chunk.endsWith('\n')) {
          const cut = chunk.lastIndexOf('\n');
          if (cut < 0) { await maybeFlush(false); return; }   // 一条都还没写完
          text = chunk.slice(0, cut + 1);
          state.offset = size - Buffer.byteLength(chunk.slice(cut + 1), 'utf8');
        } else {
          state.offset = size;
        }
        const entries = splitEntries(text);
        if (entries.length) {
          if (!state.pending.length) state.pendingSince = Date.now();
          state.pending.push(...entries);
          if (state.pending.length > PENDING_MAX) {
            state.pending = state.pending.slice(-PENDING_MAX);
            log('待发队列超过 ' + PENDING_MAX + ' 条，丢掉最老的（提示：是不是长期没切回 dsh？）');
          }
          savePending();
        }
      }
      // 有没有新轨迹都要跑一次：超时兜底全靠它
      await maybeFlush(false);
    } catch (e) { log('pump 异常: ' + errText(e)); } finally { state.busy = false; }
  }

  // ── dsh 斜杠命令 ──
  try {
    if (ctx.commands && typeof ctx.commands.register === 'function') {
      ctx.commands.register({
        name: 'aiwatch',
        description: '桌面操作轨迹监听：bind=绑定当前会话 / off=解绑 / status=看状态 / recent=立刻取最近轨迹 / flush=立刻把攒着的发出去',
        input: { hint: 'bind | off | status | recent [条数] | flush' },
        handler: async (inv) => {
          const raw = String(inv?.rawInput || '').trim().toLowerCase();
          const sid = String(inv?.agent?.session?.id || '');
          if (!raw || raw === 'status') {
            const a = targetAgent();
            const turn = a ? (sessionTurnActive(a) ? '回合进行中' : '空闲') : '会话不在内存';
            const aged = state.pendingSince ? Math.round((Date.now() - state.pendingSince) / 1000) : 0;
            return { kind: 'success', text: `v${VERSION} 监听：${cfg.enabled ? '开' : '关'} | 目录：${cfg.dirs.join(', ')} | 判定窗口：${cfg.humanWindowSec}s | 热键：${cfg.hotkey || '(未启用)'}${cfg.hotkeyWake ? '（唤醒）' : '（只发不唤醒）'} | 绑定会话：${state.target || '(未绑定 → 用 /aiwatch bind)'} | 回合：${turn} | 待发：${state.pending.length} 条（最老 ${aged}s） | dsh 窗口在前台：${dshWindowFocused() ? '是' : '否'} | 轨迹文件：${trailFile()}` };
          }
          if (raw === 'bind') {
            if (!sid) return { kind: 'error', text: '拿不到当前会话 id，无法绑定' };
            state.target = sid;
            state.bound = inv?.agent || null;
            state.agents.set(sid, inv?.agent || null);
            state.lastTurnSeq = null; // 下条注入重新带标题+目录，让 AI 知道这是什么
            saveBind({ sessionId: sid, at: Date.now() });
            log('已绑定接收会话: ' + sid + '（agent ' + (state.bound ? '已持有' : '未持有') + '）');
            return { kind: 'success', text: `✅ 已把当前会话设为轨迹接收会话（${sid.slice(0, 8)}…）。之后桌面上的真人操作会先攒着，你切回 dsh 窗口（或攒满 ${cfg.injectMaxLines} 条 / 超过 ${Math.round(cfg.flushIdleSec / 60)} 分钟）时一次性静默写进来，不唤醒你。回来说一句「检查刚才那些」就能用。` };
          }
          if (raw === 'off') {
            state.target = '';
            state.bound = null;
            state.lastTurnSeq = null;
            saveBind({ sessionId: '' });
            log('已解绑接收会话');
            return { kind: 'success', text: '已解绑：不再往任何会话写轨迹（轨迹文件仍在记）。' };
          }
          if (raw === 'flush') {
            if (!state.pending.length) return { kind: 'success', text: '现在没有攒着的轨迹。' };
            await maybeFlush(true);
            return { kind: 'success', text: state.pending.length ? `发了 ${cfg.injectMaxLines} 条，还剩 ${state.pending.length} 条（可再 flush 一次）。` : '已把攒着的轨迹全部发出（静默写入，不唤醒）。' };
          }
          if (raw.startsWith('recent')) {
            const n = Math.min(50, Number(raw.split(/\s+/)[1]) || 10);
            const entries = tailEntries(n);
            if (!entries.length) return { kind: 'success', text: '最近没有轨迹（先在桌面上动几个文件试试）。' };
            const agent = inv?.agent;
            if (agent) { state.bound = agent; if (sid) state.agents.set(sid, agent); }
            if (agent && typeof agent.followup === 'function') {
              try {
                agent.followup({ role: 'user', id: randomUUID(), content: [{ type: 'text', text: '【桌面操作轨迹·最近 ' + entries.length + ' 条】\n目录: ' + cfg.dirs.join(' , ') + '\n' + entries.join('\n') }], source: { kind: 'user' } });
                return { kind: 'success', text: '已把最近 ' + entries.length + ' 条轨迹交给你（这条会唤醒处理）。' };
              } catch (e) { log('followup 失败: ' + errText(e)); }
            }
            return { kind: 'success', text: '最近轨迹：\n' + entries.join('\n') };
          }
          return { kind: 'error', text: '用法：/aiwatch bind | off | status | recent [条数] | flush' };
        },
      });
      log('已注册 dsh 斜杠命令 /aiwatch');
    } else {
      log('commands 服务不可用 → 斜杠命令未注册');
    }
  } catch (e) { log('注册命令失败: ' + errText(e)); }

  loadPending();
  watchAiTools();                                   // 精确标记 AI 写文件的时段（只读地听会话事件）
  runningSig = sigOf();                             // 记下启动时的参数签名，之后的变化交给 reconcile
  if (cfg.enabled) startWatch(); else log('监听未开启（config.enabled=false）');

  return () => { stopWatch(); savePending(); };
}
