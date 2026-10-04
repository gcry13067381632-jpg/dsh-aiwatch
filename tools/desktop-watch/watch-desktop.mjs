// watch-desktop.mjs (v8) — 只在「键鼠动过之后」才把文件变动当真；没人操作时一律静默丢弃
// 用法: node watch-desktop.mjs [--dir <目录>] [--out <输出目录>] [--human-ms 2500] [--human-window 20000] [--debounce 400] [--keep-program 0] [--diff 1]
// 打标: 在 <输出目录>/ai-hold.json 写 {"until": 毫秒时间戳} → 该时间前的事件判为「AI/程序(已打标)」
//
// v4 变更（2026-10-04，主人发现"刷新桌面报一堆修改"）：
//   ① 「修改」必须内容真的变了才算 —— 比对 大小+最后写入时间(mtime)，两者都没变的就是
//      「只是被读取/刷新」（资源管理器重建图标、解析 .lnk、读 Office 缩略图会让 NTFS 更新
//      最后访问时间，Windows 也把这种变更通知报给 fs.watch）。这类一律静默忽略。
//   ② 噪音文件（~$ 临时、Thumbs.db、desktop.ini、.tmp/.part/.crdownload）不再写进 trail.txt。
//   ③ 启动时先给监听目录拍一份（路径 → 大小:mtime）基线，用于上面 ① 的比对。
//
// v5 变更（2026-10-04，主人要"编辑内容入站"）：
//   文本类文件（txt/md/json/js/py/ps1/yaml/csv… 按扩展名，且能干净解码、无 NUL 字节、≤1MB）
//   在被真实修改后，除了那一行「修改 xxx」，还会把**差异内容**跟在下面（缩进 2 空格）：
//
//     [16:12:03] 修改 笔记.txt
//       - 旧的一行
//       + 新的一行
//
//   差异算法：行级 LCS（超 40 万格改用前后缀裁剪的粗摘要），最多给 24 行、每行最多 160 字符，
//   超了补一行「…（还有 N 行变更已省略）」。首次见到某文件时先记内容快照，之后每次真实修改都 diff。
//
// v6 变更（2026-10-04，主人问"doc 文件呢"）：
//   .docx/.docm 也纳入：它本质是个 zip，正文在 word/document.xml，本脚本自己解 zip（zlib.inflateRawSync）
//   把纯文字抽出来（段落按行），之后和 txt 一样做行级差异 —— Word 里改了哪几段，AI 一样看得到。
//   老式 .doc（97-2003 的 OLE 二进制）**不支持**（得调 Word/WPS 转换，太重）；.pdf/.xlsx/.pptx 暂不支持。
//   样式/图片/修订一律不管，只取正文文字。
//
// v7 变更（2026-10-04，主人实测"改了 docx 但没入站文本"）：
//   编辑器（Word/WPS）保存不是"就地写"，而是**先写 `xxx~7B1A3.tmp`、再改名覆盖目标**。
//   于是 fs.watch 报的是「删除 .tmp + 新建 目标名」，v6 把它配成"改名/移动"，而差异只在「修改」时才算 → 改动白丢。
//   v7 三处修：
//     ① 那个配对如果**旧名字是临时/噪音文件**、或**新名字本来就有内容快照** → 判定为「保存覆盖」，
//        按「修改」处理并正常算差异（不再显示成"改名/移动"）。
//     ② 删除的轨迹行**延迟 2.5 秒**才写：期间同名的文件又出现（保存/改名）就当没删过，
//        免得满屏假的"删除 + 新建"（真删除照旧会记，只是晚 2.5 秒）。
//     ③ 删除时**不再清掉** sigs/texts 里的快照 —— 保存覆盖还要拿旧内容比差异，快照丢了差异就没了。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const HOME = process.env.USERPROFILE || 'C:\\Users\\作早饭';
const WATCH_DIR = argOf('dir', path.join(HOME, 'Desktop'));
const OUT_DIR = argOf('out', 'D:\\newwenjianjia\\aiwork\\鲸鱼娘\\watch-log');
const HUMAN_MS = Number(argOf('human-ms', '2500'));          // 离键鼠多近算「高置信真人」
const HUMAN_WINDOW = Number(argOf('human-window', '20000')); // 超过这个时长没键鼠动静 → 一律当程序噪音
const DEBOUNCE_MS = Number(argOf('debounce', '400'));
const KEEP_PROGRAM = argOf('keep-program', '0') === '1';     // 1=程序事件也写进轨迹（调试用）
const SNAP_MAX = Number(argOf('snap-max', '20000'));         // 启动基线扫描的条目上限
const DO_DIFF = argOf('diff', '1') === '1';                  // 1=文本文件改动把差异内容也记下来
const TEXT_MAX = 1024 * 1024;                                // 超过 1MB 的文本不做内容比对
const DIFF_MAX_LINES = 12;                                   // 一条轨迹里最多给几行差异
const DIFF_MAX_COLS = 120;                                   // 差异每行最多多少字符
const DIFF_MAX_CHARS = 900;                                  // 一条轨迹的差异总量上限（超了截断）

const EVENTS = path.join(OUT_DIR, 'events.jsonl');
const TRAIL = path.join(OUT_DIR, 'trail.txt');
const LOCK = path.join(OUT_DIR, 'watcher.lock');
const AI_HOLD = path.join(OUT_DIR, 'ai-hold.json');
/** 当前前台窗口状态：给插件判断"主人是不是切回 dsh 窗口了"（聚合注入的主触发） */
const FG_STATE = path.join(OUT_DIR, 'fg-state.json');
/** AI 点名的文件清单（插件从工具调用参数里读出来的"它正在改哪个文件"） */
const AI_PATHS = path.join(OUT_DIR, 'ai-paths.json');
/** 全局热键（写法如 Ctrl+Alt+A；留空=不启用），触发后把时间戳落盘给插件 */
const HOTKEY = argOf('hotkey', '');
const HOTKEY_FILE = path.join(OUT_DIR, 'hotkey.json');
fs.mkdirSync(OUT_DIR, { recursive: true });

const NOISE = [/(^|[\\/])~\$/, /\.tmp$/i, /\.crdownload$/i, /\.part$/i, /(^|[\\/])Thumbs\.db$/i, /desktop\.ini$/i];
const FG_HUMAN = /explorer|totalcmd|Files|DoubleCommander|XYplorer/i;
const FG_TOOL = /WindowsTerminal|pwsh|powershell|cmd|Code|notepad|sublime|devenv|idea|chrome|msedge|firefox/i;
// 文本类扩展名（能当"可编辑文本"看的）
const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.log', '.json', '.jsonl', '.ndjson', '.csv', '.tsv', '.ini', '.cfg', '.conf', '.toml', '.properties', '.env', '.yml', '.yaml', '.xml', '.html', '.htm', '.css', '.scss', '.less', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.py', '.pyw', '.ps1', '.psm1', '.bat', '.cmd', '.sh', '.bash', '.zsh', '.fish', '.sql', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.java', '.kt', '.go', '.rs', '.rb', '.php', '.pl', '.lua', '.r', '.m', '.swift', '.asm', '.vbs', '.ahk', '.srt', '.ass', '.vtt', '.lrc', '.tex', '.gradle', '.gitignore', '.editorconfig', '.npmrc', '.dshrc']);

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const append = (f, s) => { try { fs.appendFileSync(f, s, 'utf8'); } catch { /* ignore */ } };

// ── 单例锁：同一个输出目录只允许一个监听进程 ──
// 为什么需要：插件重挂载（改配置/关开插件）时如果旧子进程没死干净，就会有两个监听在跑、往同一份
// trail.txt 里重复写；更坑的是"插件以为关了、孤儿还在记"（2026-10-04 实际踩到）。
// 判据：锁文件里记的 PID 还活着（process.kill(pid,0) 不抛）→ 本进程直接退出。
function claimSingleInstance() {
  try {
    const prev = Number(String(fs.readFileSync(LOCK, 'utf8')).trim().split(/\s+/)[0]) || 0;
    if (prev > 0 && prev !== process.pid) {
      let alive = false;
      try { process.kill(prev, 0); alive = true; } catch { alive = false; }
      if (alive) { log('已有监听进程在跑 (PID ' + prev + ')，本进程退出（防重复记录）'); process.exit(0); }
    }
  } catch { /* 没有锁文件，正常 */ }
  try { fs.writeFileSync(LOCK, String(process.pid), 'utf8'); } catch { /* ignore */ }
  process.on('exit', () => {
    try { if (String(fs.readFileSync(LOCK, 'utf8')).trim() === String(process.pid)) fs.unlinkSync(LOCK); } catch { /* ignore */ }
  });
}
claimSingleInstance();

let lastInput = null; // {ts, idleMs, fg, title}
const idleNow = () => (lastInput ? lastInput.idleMs + (Date.now() - lastInput.ts) : Infinity);

function aiHoldUntil() {
  try { const o = JSON.parse(fs.readFileSync(AI_HOLD, 'utf8')); return Number(o && o.until) || 0; } catch { return 0; }
}

// ── 低开销键鼠信号进程：有输入/换窗口才输出 ──
const ps = spawn('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'agent-input.ps1'), '-Hotkey', String(HOTKEY || '')], { stdio: ['ignore', 'pipe', 'pipe'] });
let psBuf = '';
ps.stdout.on('data', (d) => {
  psBuf += d.toString('utf8');
  let i;
  while ((i = psBuf.indexOf('\n')) >= 0) {
    const line = psBuf.slice(0, i).trim();
    psBuf = psBuf.slice(i + 1);
    if (!line) continue;
    if (line.indexOf('HOTKEY-READY') === 0) { log('热键已就绪: ' + line.slice(13).trim() + '（按一下=把攒着的轨迹发出去并唤醒 AI）'); continue; }
    let obj = null;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj) continue;
    if (obj.hotkey) {
      // 热键触发：落盘给插件（只写时间戳，插件自己决定发什么、要不要唤醒）
      try { fs.writeFileSync(HOTKEY_FILE, JSON.stringify({ at: Number(obj.ts) || Date.now(), spec: String(obj.hotkey) }), 'utf8'); } catch { /* ignore */ }
      log('热键触发: ' + obj.hotkey);
      continue;
    }
    lastInput = obj;
    // 顺手把"现在前台是谁"落盘：插件的聚合注入靠它判断主人有没有切回 dsh 窗口
    try { fs.writeFileSync(FG_STATE, JSON.stringify({ fg: obj.fg || '', title: obj.title || '', idleMs: obj.idleMs, ts: obj.ts, seenAt: Date.now() }), 'utf8'); } catch { /* ignore */ }
  }
});
ps.stderr.on('data', (d) => log('[input]', d.toString().trim().slice(0, 160)));
ps.on('exit', (c) => log('[input] 信号进程退出 code=' + c));

// ── 判定：没人碰键鼠 = 不关心 ──
function judge(isNoise, aiMarked) {
  const idle = idleNow();
  const fg = (lastInput && lastInput.fg) || '';
  // AI 点名的文件 / AI 正在跑工具 → 直接判为 AI 干的（events.jsonl 里也如实标记，别写成"真人"）
  if (aiMarked) {
    return { idle: Math.round(idle), fg, conf: 0, verdict: 'AI/程序(已打标)', quiet: false };
  }
  if (Date.now() < aiHoldUntil()) {
    return { idle: Math.round(idle), fg, conf: 0, verdict: 'AI/程序(已打标)', quiet: false };
  }
  if (!(idle <= HUMAN_WINDOW)) {
    return { idle: Math.round(idle), fg, conf: 0, verdict: '程序(无人操作)', quiet: !KEEP_PROGRAM };
  }
  let conf = 0;
  if (idle < 1500) conf += 0.5; else if (idle < HUMAN_MS) conf += 0.35; else if (idle < 10000) conf += 0.12; else conf += 0.03;
  if (FG_HUMAN.test(fg)) conf += 0.25; else if (FG_TOOL.test(fg)) conf += 0.12;
  if (isNoise) conf -= 0.35;
  conf = Math.max(0, Math.min(1, conf));
  const verdict = conf >= 0.6 ? '真人(高)' : conf >= 0.35 ? '真人(中)' : '存疑(程序?)';
  return { idle: Math.round(idle), fg, conf: Number(conf.toFixed(2)), verdict, quiet: false };
}

function statOf(abs) {
  try { const st = fs.statSync(abs); return { exists: true, isDir: st.isDirectory(), size: st.size, mtime: st.mtimeMs }; }
  catch { return { exists: false, isDir: false, size: 0, mtime: 0 }; }
}
function kindOf(evType, st) {
  if (!st.exists) return 'deleted';
  if (evType === 'rename') return st.isDir ? 'dir-created' : 'created';
  return 'modified';
}
const KIND_CN = { created: '新建', 'dir-created': '新建文件夹', modified: '修改', deleted: '删除', renamed: '改名/移动' };

const lastEmit = new Map();
const recentDeleted = new Map();
const sigs = new Map();          // abs → '大小:mtime'（判「内容到底有没有变」）
const texts = new Map();         // abs → 上一次的文本内容（用来算差异）
let quietCount = 0, noopCount = 0, noiseCount = 0, diffCount = 0, aiCount = 0;

const sig = (st) => st.size + ':' + st.mtimeMs;
const clip = (s) => (s.length > DIFF_MAX_COLS ? s.slice(0, DIFF_MAX_COLS) + '…' : s);

// ── 文本读写 ──
function isTextCandidate(abs) {
  const ext = path.extname(abs).toLowerCase();
  if (TEXT_EXT.has(ext)) return true;
  return ext === ''; // 没有扩展名（README、Makefile 之类）也当候选，读的时候再判二进制
}
function decodeText(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { /* 继续 */ }
  try { return new TextDecoder('gbk').decode(buf); } catch { /* 继续 */ }
  return buf.toString('utf8');
}
function readText(abs, size) {
  if (size > TEXT_MAX) return null;
  try {
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) return null;           // 有 NUL = 二进制，不算文本
    return decodeText(buf);
  } catch { return null; }
}

/** 差异行数/字符总量双重封顶（大文档只留个头，别把整篇灌进上下文） */
function capDiff(lines) {
  const out = [];
  let total = 0;
  for (const line of lines) {
    if (total + line.length + 1 > DIFF_MAX_CHARS) { out.push('  …（差异过长已截断）'); break; }
    out.push(line);
    total += line.length + 1;
  }
  return out.length ? out : null;
}

// ── 行级差异（返回要跟着轨迹行一起写的几行文本）──
function diffLines(oldText, newText) {
  const A = oldText.replace(/\r\n/g, '\n').split('\n');
  const B = newText.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  if (A.length * B.length > 400000) {
    // 文件太大：只做前后缀裁剪的粗粒度摘要
    let s = 0;
    while (s < A.length && s < B.length && A[s] === B[s]) s++;
    let e = 0;
    while (e < A.length - s && e < B.length - s && A[A.length - 1 - e] === B[B.length - 1 - e]) e++;
    const del = A.length - s - e, add = B.length - s - e;
    if (del === 0 && add === 0) return null;
    out.push(`  @@ 第 ${s + 1} 行起：${del} 行 → ${add} 行（文件较大，只给摘要）`);
    for (const x of A.slice(s, s + 6)) out.push('  - ' + clip(x));
    for (const x of B.slice(s, s + 6)) out.push('  + ' + clip(x));
    return capDiff(out.slice(0, DIFF_MAX_LINES + 1));
  }
  const n = A.length, m = B.length;
  const dp = new Int32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = A[i] === B[j] ? dp[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    }
  }
  let i = 0, j = 0;
  let shown = 0, omitted = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { i++; j++; continue; }
    const op = j >= m ? '-' : i >= n ? '+' : (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1] ? '-' : '+');
    if (shown < DIFF_MAX_LINES) {
      out.push(op === '-' ? '  - ' + clip(A[i]) : '  + ' + clip(B[j]));
      shown++;
    } else omitted++;
    if (op === '-') i++; else j++;
  }
  if (omitted) out.push(`  …（还有 ${omitted} 行变更已省略）`);
  return capDiff(out);
}

// ── .docx 正文提取（docx = zip，正文在 word/document.xml；自己解 zip，不依赖任何库）──
const DOCX_EXT = new Set(['.docx', '.docm', '.dotx']);
const DOCX_MAX_ZIP = 12 * 1024 * 1024;   // 压缩包上限
const DOCX_MAX_TEXT = 200000;            // 抽出来的正文上限（字符）

function zipEntry(buf, wantName) {
  // 从尾部找 End of Central Directory（zip 注释最长 64KB）
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && off + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (name === wantName) {
      if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) return null;
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(start, Math.min(start + compSize, buf.length));
      if (method === 0) return data;
      if (method === 8) { try { return zlib.inflateRawSync(data); } catch { return null; } }
      return null;
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function docxText(abs) {
  try {
    const st = fs.statSync(abs);
    if (st.size > DOCX_MAX_ZIP) return null;
    const xml = zipEntry(fs.readFileSync(abs), 'word/document.xml');
    if (!xml) return null;
    let s = xml.toString('utf8');
    s = s.replace(/<\/w:p>/g, '\n').replace(/<w:tab\b[^>]*\/>/g, '\t').replace(/<w:br\b[^>]*\/>/g, '\n');
    s = s.replace(/<[^>]*>/g, '');                     // 去掉所有标签，只留文字
    s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').trim();
    if (s.length > DOCX_MAX_TEXT) s = s.slice(0, DOCX_MAX_TEXT) + '\n…（正文过长已截断）';
    return s;
  } catch { return null; }
}

/** 取一份「可比对的内容快照」：.docx 抽正文，其余文本类按原样读；不能当文本看的一律 null */
function readSnapshot(abs, size) {
  if (DOCX_EXT.has(path.extname(abs).toLowerCase())) return docxText(abs);
  if (!isTextCandidate(abs)) return null;
  return readText(abs, size);
}

// 启动基线：记录 路径 → 大小:mtime，文本类文件顺带存一份内容
(function seedSigs() {
  let n = 0, tn = 0;
  const walk = (dir, depth) => {
    if (n >= SNAP_MAX) return;
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (n >= SNAP_MAX) return;
      const abs = path.join(dir, it.name);
      if (it.isDirectory()) { if (depth < 4) walk(abs, depth + 1); continue; }
      const st = statOf(abs);
      if (!st.exists) continue;
      sigs.set(abs, sig(st));
      n++;
      if (DO_DIFF) { const t = readSnapshot(abs, st.size); if (t !== null) { texts.set(abs, t); tn++; } }
    }
  };
  walk(WATCH_DIR, 0);
  log(`基线: 已记录 ${n} 个文件的大小/写入时间${DO_DIFF ? `（其中 ${tn} 个文本类文件存了内容快照，含 .docx 正文，用来算编辑差异）` : ''}`);
})();

/** 删除事件延迟多久才写进轨迹：给「改名/保存覆盖」留配对窗口，免得冒出一堆假的"删除 + 新建" */
const DELETE_GRACE_MS = 2500;
const pendingDelete = new Map(); // abs → { timer, name }

function cancelPendingDelete(abs) {
  const p = pendingDelete.get(abs);
  if (!p) return;
  clearTimeout(p.timer);
  pendingDelete.delete(abs);
}

function scheduleDeleteTrail(abs, name, aiAtDelete) {
  cancelPendingDelete(abs);
  const timer = setTimeout(() => {
    pendingDelete.delete(abs);
    // 删除的轨迹行是延迟写的，所以这里必须**重新**判断一次"这是不是 AI 干的"：
    // 删除那一刻是 AI 标记 → 跳过；或者延迟期间标记还有效（点名文件 / 时间兜底）→ 也跳过。
    // （2026-10-04 实测踩到：新建被拦住了，删除却漏出去，就是因为这里没带 AI 判断。）
    const marked = aiAtDelete === true || Date.now() < aiHoldUntil() || aiPathMarked(abs);
    const jj = judge(false, marked);
    if (jj.quiet) { quietCount++; return; }
    if (marked && !KEEP_PROGRAM) {
      aiCount++;
      if (aiCount % 20 === 0) log(`（已静默忽略 ${aiCount} 条 AI 自己回合里产生的变动）`);
      return;
    }
    flushTrail('deleted', name, jj, null, Date.now());
  }, DELETE_GRACE_MS);
  pendingDelete.set(abs, { timer, name });
}

/**
 * 真正把一条轨迹写进 trail.txt。
 * trail 是喂给 AI 的：只留「时间 动作 文件」，判定/前台/键鼠距离/置信只在「不是真人操作」时标一下；
 * 文本类文件的差异行跟在下面（缩进 2 空格），插件按条目整块注入，不会被截断。
 */
function flushTrail(kind, name, j, diffOut, atMs) {
  const t = new Date(atMs).toTimeString().slice(0, 8);
  const kindCn = KIND_CN[kind] || kind;
  const flag = /真人/.test(String(j.verdict)) ? '' : ` · ${j.verdict}`;
  const head = `[${t}] ${kindCn} ${name}${flag}`;
  append(TRAIL, (diffOut ? [head, ...diffOut].join('\n') : head) + '\n');
  log(`${head} · 前台:${j.fg || '?'} · 距键鼠${(j.idle / 1000).toFixed(1)}s · 置信${j.conf}${diffOut ? ` · 差异 ${diffOut.length} 行` : ''}`);
}

/**
 * 这个路径是不是 AI 点名在改的？（插件从工具调用参数里读出来的，精确到文件；
 * 命中目录前缀也算 —— workdir/cwd 这种标的是整个目录）
 */
function aiPathMarked(abs) {
  try {
    const o = JSON.parse(fs.readFileSync(AI_PATHS, 'utf8'));
    const map = (o && o.paths) || {};
    const now = Date.now();
    const p = String(abs).replace(/\//g, '\\').toLowerCase();
    for (const key of Object.keys(map)) {
      if (!(Number(map[key]) > now)) continue;
      if (p === key || p.startsWith(key + '\\')) return true;
    }
    return false;
  } catch { return false; }
}

function emit(kind, abs, st) {
  const now = Date.now();
  const aiNow = now < aiHoldUntil() || aiPathMarked(abs);   // AI 正在干活（点名文件 / 短时间兜底）
  let name = path.relative(WATCH_DIR, abs) || path.basename(abs);
  let finalKind = kind;
  let savedOver = false;   // true = 编辑器"写临时文件再改名覆盖"的保存 → 要按「修改」处理并给差异

  if (kind === 'modified' && st.isDir) return; // 目录 mtime 噪音

  if (kind === 'deleted') {
    recentDeleted.set(abs, { ts: now, size: st.size, name });
    // 注意：这里**不删** sigs/texts 里的快照 —— 编辑器"删掉再重建 / 写 tmp 再改名覆盖"时还要拿旧内容算差异。
    // 快照多留一点最多费点内存，丢了差异就没法补。
    // 轨迹行延迟 DELETE_GRACE_MS 再写：中途文件又回来（保存/改名）就当没删过。
    if (!NOISE.some((r) => r.test(name))) scheduleDeleteTrail(abs, name, aiNow);
  } else if (kind === 'created') {
    cancelPendingDelete(abs);   // 同一个名字马上又出现了 → 那是保存覆盖/改名，不是删除
    for (const [oldAbs, info] of recentDeleted) {
      if (oldAbs === abs) continue;
      if (now - info.ts < 2500 && (info.size === st.size || info.size === 0 || st.size === 0)) {
        // 编辑器（Word/WPS/部分编辑器）保存是「先写 xxx~7B1A3.tmp，再改名覆盖目标」：
        // 旧名字是临时/噪音文件，或新名字本来就有内容快照 → 这其实是"保存/覆盖"，按「修改」处理并算差异，
        // 不能当成"改名/移动"，否则文本改动就白记了（2026-10-04 主人实测踩到）。
        const oldIsTemp = NOISE.some((r) => r.test(info.name));
        if (oldIsTemp || texts.has(abs) || finalKind === 'modified') {
          savedOver = true;
          finalKind = 'modified';
        } else {
          finalKind = 'renamed';
          name = `${info.name} → ${name}`;
        }
        cancelPendingDelete(oldAbs);   // 旧名字是"改名走了"，不是被删除
        recentDeleted.delete(oldAbs);
        break;
      }
    }
  }
  for (const [k, v] of recentDeleted) if (now - v.ts > 10000) recentDeleted.delete(k);

  const isNoise = NOISE.some((r) => r.test(name));
  const prev = lastEmit.get(abs + '|' + finalKind);
  if (prev && now - prev < DEBOUNCE_MS) return;
  if (finalKind === 'modified') {
    const cAt = lastEmit.get(abs + '|created') || lastEmit.get(abs + '|renamed') || 0;
    if (now - cAt < 1200) return;
  }
  lastEmit.set(abs + '|' + finalKind, now);

  // ── 「修改」必须内容真的变了：大小 + 最后写入时间都没变 = 只是被读取/刷新 ──
  let diffOut = null;
  if (finalKind === 'modified' && savedOver) {
    // 保存覆盖（tmp → 目标）：目标本来就有内容快照，直接拿旧内容比
    sigs.set(abs, sig(st));
    if (DO_DIFF) {
      const nowText = readSnapshot(abs, st.size);
      if (nowText !== null) {
        const before = texts.get(abs);
        texts.set(abs, nowText);
        if (typeof before === 'string') {
          try { diffOut = diffLines(before, nowText); } catch { diffOut = null; }
        }
      }
    }
  } else if (finalKind === 'modified') {
    const cur = sig(st);
    const old = sigs.get(abs);
    sigs.set(abs, cur);
    if (old !== undefined && old === cur) {
      noopCount++;
      append(EVENTS, JSON.stringify({ ts: now, iso: new Date(now).toISOString(), kind: finalKind, name, abs, size: st.size, noop: true, reason: '内容未变(仅被读取/刷新)' }) + '\n');
      if (noopCount % 20 === 0) log(`（已静默忽略 ${noopCount} 次「只是被读取/刷新」的假修改、${noiseCount} 次噪音文件）`);
      return;
    }
    // 真实修改 → 文本类文件（含 .docx 正文）算差异；但 AI 自己回合里写的文件不算差异（省 token）
    if (DO_DIFF && !aiNow) {
      const nowText = readSnapshot(abs, st.size);
      if (nowText !== null) {
        const before = texts.get(abs);
        texts.set(abs, nowText);
        if (typeof before === 'string') {
          try { diffOut = diffLines(before, nowText); } catch { diffOut = null; }
        }
      }
    }
  } else if (finalKind === 'created' || finalKind === 'renamed') {
    sigs.set(abs, sig(st));
    if (DO_DIFF) { const t = readSnapshot(abs, st.size); texts.set(abs, t === null ? '' : t); }
  }

  // ── 噪音文件（~$ / Thumbs.db / desktop.ini / .tmp …）不进给 AI 看的轨迹 ──
  if (isNoise) {
    noiseCount++;
    append(EVENTS, JSON.stringify({ ts: now, iso: new Date(now).toISOString(), kind: finalKind, name, abs, size: st.size, noop: true, reason: '噪音文件' }) + '\n');
    if (noiseCount % 20 === 0) log(`（已静默忽略 ${noopCount} 次「只是被读取/刷新」的假修改、${noiseCount} 次噪音文件）`);
    return;
  }

  const j = judge(false, aiNow);
  const rec = { ts: now, iso: new Date(now).toISOString(), kind: finalKind, name, abs, size: st.size, ...j };
  if (diffOut) { rec.diff = diffOut.join('\n'); diffCount++; }
  append(EVENTS, JSON.stringify(rec) + '\n');

  if (j.quiet) {
    quietCount++;
    if (quietCount % 20 === 0) log(`（已静默丢弃 ${quietCount} 条无人操作的变动）`);
    return;
  }

  // AI 自己干活时产生的变动不进"给 AI 看的轨迹"：否则 AI 写的文件会被当成主人编辑再喂回 AI，白烧 token
  //（2026-10-04 踩过：人家往被监听的文件夹里写文档，整篇差异被灌回上下文）。events.jsonl 里仍留痕。
  if (aiNow && !KEEP_PROGRAM) {
    aiCount++;
    if (aiCount % 20 === 0) log(`（已静默忽略 ${aiCount} 条 AI 自己回合里产生的变动）`);
    return;
  }

  // 删除的轨迹行由 scheduleDeleteTrail 延迟确认（中途又回来 = 保存/改名，不记删除）
  if (finalKind === 'deleted') return;
  flushTrail(finalKind, name, j, diffOut, now);
}

log('监听目录: ' + WATCH_DIR);
log(`规则: 距键鼠 ≤${HUMAN_WINDOW / 1000}s 才算「你在操作」；没人碰键鼠时的变动静默丢弃；「修改」需内容真变；文本文件改动附差异内容${DO_DIFF ? '' : '（--diff 0 = 已关闭）'}`);
log('输出目录: ' + OUT_DIR);
log('前台窗口状态写入: ' + FG_STATE + '（插件据此判断"切回 dsh 窗口"→ 聚合发出轨迹）');
log('热键: ' + (HOTKEY ? HOTKEY + '（触发后写 ' + HOTKEY_FILE + '）' : '未启用'));

try {
  fs.watch(WATCH_DIR, { recursive: true }, (evType, filename) => {
    if (!filename) return;
    const abs = path.join(WATCH_DIR, String(filename));
    const st = statOf(abs);
    emit(kindOf(evType, st), abs, st);
  });
} catch (e) {
  log('启动监听失败: ' + String((e && e.message) || e));
  process.exit(1);
}
