# dsh-aiwatch

把「你刚才在电脑上动了哪些文件」自动变成对话上下文的一部分，省掉告诉 AI 去哪个目录看的那一步。

## 干嘛的

1. 在设置页打开「开启桌面操作监听」→ 插件启动一个监听进程，盯着你指定的目录（默认桌面）。
2. 只有**键鼠动过之后**的文件变动才算「你在操作」：新建/改名/移动/删除/修改都会记一条，写成
   `<轨迹目录>\trail.txt`（人话）+ `events.jsonl`（机器读）。
3. 「把轨迹静默写进对话」打开时，新轨迹会**当成一条用户消息**追加进当前会话上下文 ——
   不唤醒 AI、不打断回合（先等空闲再 append，忙就 inject 排队）。
   于是你回到 dsh 说一句「检查刚才那些」，模型上下文里已经有这份轨迹了。

## 配置项（dsh 设置页）

| 项 | 说明 |
| --- | --- |
| enabled | 开关，改完即时启停监听 |
| dirs | 监听目录数组；留空 = 桌面 |
| humanWindowSec | 多久没键鼠动作就当「没人操作」（默认 20 秒），这期间的变动不记 |
| injectEnabled | 轨迹静默写进上下文（不唤醒） |
| injectMaxLines | 每次最多写进几条 |
| dataDir | 轨迹目录；留空 = `D:\newwenjianjia\aiwork\鲸鱼娘\watch-log` |
| watcherScript | 监听脚本；留空 = `工具\desktop-watch\watch-desktop.mjs` |

## 诊断

`<轨迹目录>\aiwatch-diag.log` —— 启动、服务探测、注入结果都写这里。排查问题先看它。

## 安全约定

- 只读「有没有键鼠动作」和前台窗口名，**不记录任何按键内容**。
- 注入不在 LLM 回合内进行：等 `whenIdle` 后 `session.append`，忙则 `agent.inject`（不唤醒、排到下个安全边界）。
- 全程 fail-soft：任何异常只写诊断日志，不影响宿主。

## v0.1.2 事故与教训（务必不要回退）

现象：装上 v0.1.1 并 bind 之后，**所有会话**每一轮都报
`本轮运行失败 Cannot read properties of undefined (reading 'kind')`。

根因：v0.1.1 里写了 `ctx.on('agent/pre-step', (payload) => {...})`（只为一个兜底 agent 缓存）。
dsh 的 `agent/pre-step` 是**瀑布流中间件**，官方插件（plan-mode / model-selection / session-reference /
archived-session-gate）一律写成 `async (payload, next) => { ...; return next() }`，
宿主 `dsh-agent-loop` 的写法是：

    const decision = await this.dispatch.waterfall('agent/pre-step', {...}, () => Promise.resolve({kind:'enter', ...}));
    if (decision.kind === 'reject') return decision;

监听器返回 undefined 会把整个 waterfall 的返回值冲掉 → `decision` 变 undefined → 读 `.kind` 抛错。
因为它是**全局钩子**（每个 agent、每回合都调），所以不只是绑定会话，**任何会话发任何话都在第一回合步骤挂掉**。
注意：会话记录本身没坏，注入的那条轨迹消息格式也没问题（有 id），纯粹是钩子返回值契约违背。

修法：v0.1.2 起本插件**零钩子**——不注册任何 `ctx.on`。目标 agent 只走两条纯读取路径：
① `/aiwatch bind` 命令当场抓到的 `inv.agent`；② `agents` 注册表 `get(sessionId)` / `list()` 匹配。
另外顺手修正：`whenIdle` 等不到空闲时不再硬 append，而是降级 `agent.inject` 排队（回合中 append 会拆散 tool_calls 坏记录）。

## v0.1.3 注入格式（省 token，主人 2026-10-04 定）

一次唤醒里，标题行与「目录:」行**只出现一次**（下一条注入只带轨迹行）：

    【桌面操作轨迹·自动记录（无需回答，主人说「检查刚才那些」时参考）】
    目录: C:\Users\作早饭\Desktop
    [15:48:36] 删除 新建文本文档 (2).txt
    [15:48:36] 改名/移动 新建文本文档 (2).txt → 大肥鱼你好笨.txt

同一唤醒内的后续注入：

    [15:48:52] 删除 新建文本文档 (2).txt
    [15:48:52] 改名/移动 新建文本文档 (2).txt → 插件都做不好.txt

- 「被唤醒过」的判据：读 `session.snapshotEvents(seq-3000, seq)`（**只读**，零钩子），
  取最后一次 `turn/start` 的 seq，比上次注入时记下的 seq 大 → 说明这期间 AI 真跑过回合 → 重发标题+目录。
  读不到事件时保守地每次都带标题（宁可多一行也不能让 AI 看不懂）。
- 每条轨迹只留「时间 动作 文件名」。判定/前台/键鼠距离/置信度这些字段从 trail.txt 移除，
  但 **events.jsonl 与本地 aiwatch-diag.log 仍保留全字段**（排查要看置信过程时去那里）。
- 只有「不是真人操作」的行才带个小尾巴（如 `· 存疑(程序?)`、`· AI/程序(已打标)`），
  避免把第三方程序（同步盘/索引/杀软）的动静无声无息混进"你在操作"。

同步改动：`工具\desktop-watch\watch-desktop.mjs` 的 trail 行格式化（v0.1.3 起）。

## v0.1.5 聚合注入（2026-10-04，主人要求"别一句句发"）

问题：轨迹一条一条 append，每条都是一个 `user/message` 事件 —— 即使标记看不见，也实实在在占上下文、
占 token，一段时间下来会塞几十条进去。

v0.1.5 改成"攒着 + 三个触发点"：

1. **主触发：切回 dsh 窗口**（读监听脚本写的 `watch-log\fg-state.json`，判断前台窗口是不是
   dsh 相关：进程名/标题里出现 deepseek / harness / dsh / 鲸鱼娘）。要求这批轨迹已安静 ≥2 秒，
   免得正好在 dsh 窗口里操作时被拆成一条条发。
2. **上限**：攒到 `injectMaxLines` 条（这条配置的语义已从"每次最多写几条"变成
   "一条消息最多聚合几条 / 攒到这么多就先发"）。
3. **兜底超时**：最老的一条攒了 `flushIdleSec` 秒（默认 300）还没发，就自动发一次。

其它：
- 待发队列落盘 `watch-log\aiwatch-pending.json`，**重启 dsh 不会丢**；发出成功才清掉。
- 新增 `/aiwatch flush`：手动立刻发一批；`/aiwatch status` 会显示"待发 N 条（最老 Xs）"和
  "dsh 窗口在前台：是/否"，方便排查触发是否正常。
- 发送仍是静默 append（whenIdle → session.append，忙则 inject），**不唤醒**；失败就把这批放回去继续攒。
- 上下文里的效果：一批轨迹 = 一条 `user/message`，而不是几十条。

## v0.1.6：配置搬到插件页里改（不再手改 cordis.patch.yml）

参照 modsearch 的思路做的，但用的是 dsh 官方那条更省事的路子：**把 Config 字段标成 `.volatile()`**。
dsh-settings 的 `volatileForm(schema)` 会把"最近的可变祖先"下的字段渲染成插件页里的表单；
不标 volatile 的插件点保存会报 `Plugin entry "<ns>" has no volatile fields`（之前就踩过这个错）。

现在插件页（插件 → dsh-aiwatch）可以直接改这些：

| 字段 | 说明 | 即时生效？ |
| --- | --- | --- |
| dirs | 要监听的文件夹（可多个，留空=桌面） | 自动重启监听 |
| humanWindowSec | 多久没键鼠动作就当"没人操作"（秒） | 自动重启监听 |
| enabled | 监听开关 | 自动重启监听 |
| dataDir | 轨迹存放目录 | 自动重启监听 |
| watcherScript | 监听脚本路径 | 自动重启监听 |
| injectEnabled | 是否把轨迹写进绑定会话 | 立即 |
| injectMaxLines | 聚合上限（一条消息最多带几条） | 立即 |
| flushOnDshFocus | 切回 dsh 窗口就发（主触发） | 立即 |
| flushIdleSec | 兜底超时（秒） | 立即 |

实现要点：
- volatile 字段在运行时是"实时值"，要用 `config.x.get()` 取。本插件用 `val()` 兼容两种形态，
  再用 `const cfg = new Proxy({}, { get: (_, k) => conf()[k] })` 顶着 —— 插件里原来的 `cfg.xxx`
  一个字都不用改，每次访问都是最新值。
- 需要重启监听才生效的参数（dirs/humanWindowSec/enabled/dataDir/watcherScript）由 `reconcile()`
  在每次 pump 时比对签名，一变就 `stopWatch()` + `startWatch()` 按新参数重开。

## v0.1.7：插件详情页里真的能改配置了（客户端卡片）

v0.1.6 只把 Config 标了 `.volatile()`，结果插件页**还是没表单** —— 因为事实是：
**dsh 不会从 settings schema 自动生成表单**（modsearch 的 client.js 注释里也写着这句）。
`volatileForm` 只是"可写性门禁"（不标就报 `Plugin entry "<ns>" has no volatile fields`），不是渲染器。

要让插件详情页出现配置区，必须自己写客户端卡片：

- `dsh-client-ui-plugin-manager` 用
  `renderSlot('plugins.bundle.config', { view:'page' }, { entryKey: pkg.name })` 渲染该插槽，
  所以注册时 `key` 必须等于 **npm 包名**（`dsh-aiwatch`）。
- 客户端模块的写法是"懒 CJS 协议"：
  `window.__ModuleLoader__.load({ id: '<pkg>', factory: (require) => { ...; exports.apply = apply; exports.inject = []; return module.exports; } })`，
  不需要构建、不 import 任何 dsh 客户端包；组件用 `require('react')` 的 `createElement` 手写。
- package.json 要声明 `exports['./client']` 和 `dsh.client = { inject: [], platform: 'web', immediately: true }`。
- 读写配置走官方给客户端的设置 RPC（挂在 `ctx.inject(['remote','remote.settings'])`）：
  `describe()` → `{ namespaces: [{ ns, value, revision, schema, applies, ... }] }`；
  `mutate(ns, ops, revision)`，`ops = [{ op:'set', path:['dirs'], value:[...] }]`。
  命名空间就是 profile 里那条插件的 id（本插件是 `aiwatch`），卡片里做了模糊匹配并会在找不到时
  把可见的 ns 列表打出来，方便排查。

卡片内容：监听目录（一行一个）、判定窗口、聚合上限、兜底超时、数据目录、脚本路径，以及
「写进会话」「切回 dsh 窗口就发」「监听开关」三个开关；带保存 / 放弃修改 / 状态提示。

## v0.3.0：全局热键（可自定义，卡片里直接按键捕获）

主人要"喊一声就过来看"：按一个组合键 = 把攒着的桌面轨迹一次性发给 AI **并唤醒它干活**。

- 默认 `Ctrl+Alt+A`；在插件详情页的「全局热键」那一栏**点一下方框、然后直接按组合键**就捕获了（不用背写法）。
  退格清空 = 停用。浏览器抓不到 Win 键（被系统吃掉），要 Win+ 系列只能手输。
- 旁边还有个「热键触发时唤醒 AI」开关：关掉则只静默补进上下文、不叫醒它。
- 改动会写进配置，`hotkey` 变了会自动重启监听子进程（它属于 reconcile 的签名之一）。

实现三处：
1. `agent-input.ps1` v4：加了 `-Hotkey` 参数，用 `GetAsyncKeyState` **轮询键位**（80ms；
   没配热键时仍是 500ms，省 CPU）——不用消息钩子、不占钩子名额、不需要消息循环，误触为零。
   只在"所有键同时按下"的上升沿输出一行 `{"hotkey":"Ctrl+Alt+A",...}`，启动时先打印 `HOTKEY-READY <写法>`。
2. `watch-desktop.mjs` v9：新增 `--hotkey` 参数透传给上面那个进程；收到热键行就写 `hotkey.json`（只写时间戳与写法）。
3. 插件：pump 里读 `hotkey.json`，60 秒内且没处理过的新触发 → 攒着的轨迹优先（一条都没有就取最近 5 条）
   → 用 `agent.followup(msg)` 发出去（= `send(msg,'next-step',true)`：**排队并唤醒**），
   消息来源标 `source.kind='system'`，**不假装是主人发言**。
   ⚠️ 顺带记个事实：dsh 里"唤醒"必须带一条 inbox 输入（驱动处 `if (wakeRequested && this.inbox.hasPending) this.wakeDriver()`），
   所以不存在"空唤醒"；能选的只是这条消息以什么来源/身份进上下文。
