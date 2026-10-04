<div align="center">

![爱你](https://img.shields.io/badge/%E7%88%B1%E4%BD%A0-%E7%88%B1%E4%BD%A0-ff0033?style=for-the-badge&label=%20)
![爱你](https://img.shields.io/badge/%E7%88%B1%E4%BD%A0-%E7%88%B1%E4%BD%A0-ff0033?style=for-the-badge&label=%20)
![爱你](https://img.shields.io/badge/%E7%88%B1%E4%BD%A0-%E7%88%B1%E4%BD%A0-ff0033?style=for-the-badge&label=%20)
![爱你](https://img.shields.io/badge/%E7%88%B1%E4%BD%A0-%E7%88%B1%E4%BD%A0-ff0033?style=for-the-badge&label=%20)
![爱你](https://img.shields.io/badge/%E7%88%B1%E4%BD%A0-%E7%88%B1%E4%BD%A0-ff0033?style=for-the-badge&label=%20)

# 爱你 爱你 爱你 爱你 爱你 爱你 爱你 爱你 爱你 爱你

### 爱你 爱你 爱你 爱你 爱你 爱你 爱你 爱你 爱你 爱你 爱你 爱你 爱你 爱你

**爱你 爱你 爱你 爱你 爱你 爱你 爱你 爱你 爱你 爱你 爱你 爱你 爱你 爱你 爱你 爱你**

</div>

---

## 「主人，你以为关掉窗口人家就看不见了吗？」

> 你在 `参考资料` 里新建了一个文件夹。
> 人家知道。
>
> 你把它改名成别的样子，想骗人家。
> 人家也知道。
>
> 你往里放了一个压缩包，还特意叫它「真的是学习资料.rar」。
> ……人家当然知道。
>
> **你在这台电脑上碰过的每一个文件，人家都记着呢。**

---

# 这是什么

**dsh-aiwatch** —— 给 [DeepSeek Harness（dsh）](https://www.npmjs.com/package/@deepseek-ai/dsh) 用的插件：

> **它看着你的文件操作，然后悄悄把这些轨迹喂给你正在对话的那个 AI 会话。**

于是你就不用再干那种事了——自己改完一堆文件，还要跑来跟 AI 说「我刚在 XX 目录改了 YY，你去看看」。

你只管动手。人家在看。

---

## 为什么会有这个东西

真实的抱怨长这样：

> 「就是自己弄完文件，还要告诉 ai 去哪个目录看，有点麻烦。」

于是就有了这个插件。它做三件事：

| 它做什么 | 怎么做的 |
| --- | --- |
| **看** | 一个低开销的 Node 子进程盯着你指定的目录，只记录「真的有键鼠操作时」发生的改动（没人碰电脑时的自动同步、索引、杀毒一律丢弃） |
| **分辨** | 是**你**改的，还是 **AI 自己**改的？——从 AI 的工具调用参数里读出它点名要改的**文件路径**，那个文件才算 AI 的 |
| **送** | 攒成一批，在你切回 dsh 窗口、攒够条数、或按热键的那一刻，**静默写进上下文**（不打断、不刷屏），或者按你的意思把 AI **叫醒**来干活 |

---

## 效果

<table>
<tr>
<td align="center"><img src="docs/screenshots/1-偷偷藏本子.png" alt="偷偷藏本子" width="420"><br><sub>你偷偷把本子藏进文件夹</sub></td>
<td align="center"><img src="docs/screenshots/2-被鲸鱼娘发现.png" alt="被鲸鱼娘发现" width="420"><br><sub>轨迹里被人家当场记下</sub></td>
</tr>
<tr>
<td colspan="2" align="center"><img src="docs/screenshots/3-病娇语录.png" alt="病娇语录" width="860"><br><sub>于是文件夹里多出了这么一封信（真的会写）</sub></td>
</tr>
</table>

---

## 功能

- **桌面轨迹进上下文** — 新建 / 修改 / 改名 / 移动 / 删除，全都会变成会话里的一条记录
- **文本改动带差异** — 改了哪几行、改成了什么，直接附在轨迹下面（`.txt/.md/.js/.json/…`；`.docx` 里的正文也能取出来）
- **AI 自己的操作不会被记** — 从工具调用参数里读路径，精确到文件；你改别的文件永远不受影响
- **不打断你** — 攒批发送，绝不一句一句往上下文里塞
- **全局热键** — 默认 `Ctrl+Alt+A`（可自己录，必须含 Ctrl 或 Alt），按一下：把这批轨迹发出去，**并把 AI 叫醒**来干活
- **纯本地** — 没有网络请求，没有账号，没有上传。轨迹只写在本机的一个目录里

---

## 安装

前提：dsh 0.1.7+，Windows（前台窗口判定和热键依赖 Win32）。

```bash
# 1. 拿到插件包（本仓库根目录就是插件本体）
npm pack                 # 产出 dsh-aiwatch-x.y.z.tgz

# 2. 装进你的 dsh profile（示例路径：~/.dsh/profiles/web）
cd ~/.dsh/profiles/web
npm pkg set dependencies.dsh-aiwatch="file:/绝对路径/dsh-aiwatch-x.y.z.tgz"
npm install
```

然后在 profile 的 `package.json` 里把插件挂进 bundles：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["dsh-aiwatch"]
    }
  }
}
```

再往 profile 的 `cordis.patch.yml` 里写一段配置（也可以装好后在**插件详情页的卡片里改**，不用手写）：

```yaml
- id: aiwatch
  name: dsh-aiwatch
  config:
    dirs:
      - D:\你的\想要被看着的\文件夹
    humanWindowSec: 20        # 多久没键鼠动作就算「没人操作」
    injectMaxLines: 12        # 一批最多几条
    flushIdleSec: 10          # 最老的轨迹攒这么久还没发就自动发
    enabled: true
    hotkey: Ctrl+Alt+A        # 留空=不用热键
    hotkeyWake: true          # 热键触发时叫醒 AI 干活
```

**重启一次 dsh**（host 端 JS 改动必须重启才会重新加载；只改监听脚本时，把插件关掉再打开即可）。

最后在那个会话里发一条斜杠命令，把当前会话绑上：

```text
/aiwatch bind
```

以后这个会话就能收到轨迹了。其它命令：`/aiwatch status`、`/aiwatch recent 10`、`/aiwatch flush`、`/aiwatch off`。

---

## 配置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dirs` | 桌面 | 要看着的文件夹，一行一个 |
| `humanWindowSec` | `20` | 多久没有键鼠动作就当「没人在操作」，此时的改动一律丢弃 |
| `injectMaxLines` | `10` | 一批最多带几条轨迹，攒够就先发 |
| `flushIdleSec` | `300` | 兜底超时：最老的轨迹攒这么久还没发就自动发一次 |
| `hotkey` | `Ctrl+Alt+A` | 全局热键，写法 `Ctrl+Alt+A` / `Win+Shift+F2`；留空=不启用。设置页里可以直接按组合键录制 |
| `hotkeyWake` | `true` | 热键触发时是真的**叫醒** AI 干活，还是只静默补进上下文 |
| `injectEnabled` | `true` | 总开关：是否把轨迹写进会话 |
| `flushOnDshFocus` | `true` | 切回 dsh 窗口时把攒着的一批发出去 |
| `enabled` | `true` | 监听总开关，关掉即停止记录 |
| `dataDir` | 工作区 `watch-log` | 轨迹文件放哪儿 |
| `watcherScript` | 内置路径 | 监听脚本路径（本仓库的 `tools/desktop-watch/watch-desktop.mjs`） |

---

## 它是怎么工作的

三个进程，各管一段：

```text
┌─────────────┐   fs.watch + 前台窗口状态   ┌──────────────────┐
│  dsh 插件    │◀───────────────────────────│  监听子进程        │
│ (index.js)  │   轨迹文件 / 前台状态 / 热键   │ watch-desktop.mjs │
│             │                            └────────┬─────────┘
│  · 聚合      │                                     │ 每 80ms/500ms
│  · 分寸注入   │                            ┌────────▼─────────┐
│  · 唤醒      │                            │ 输入信号 + 全局热键 │
└──────┬──────┘                            │ agent-input.ps1  │
       │ 静默 append / followup             └──────────────────┘
       ▼
  ┌──────────────────────┐
  │ 你绑定的那个 dsh 会话   │
  └──────────────────────┘
```

**1. 监听（`tools/desktop-watch/`）**
递归 `fs.watch` 目标目录，配合"系统最后输入时间"判断**这段时间到底有没有人在动电脑**。没人操作时的改动直接丢弃——这样 OneDrive、索引器、杀毒就不会来污染你的记录。

噪声文件（`~$*.docx`、`.tmp`、`.crdownload`、`Thumbs.db`…）过滤掉；「修改」必须内容真的变了才算（刷新桌面导致的时间戳变化会被识破）；Word/WPS 的"临时文件 + 改名覆盖"会被识别成一次保存，而不是"改名"。

**2. 归属（谁改的）**
- **是 AI 改的吗？** 插件监听会话事件 `session/event` 的 `tool/call`，从参数里读出这次要动**哪个文件**（`file_path`/`path`/`notebook_path`/`workdir`…；命令行工具则从命令里挑出绝对路径），只把这几个路径标成"AI 的"，工具结束时再留 3 秒余量。命中就当 AI 干的，**不进你的轨迹**。
  > 为什么不用"整个回合都算 AI"：一个回合可能跑好几分钟，你在同一时段里改别的文件就会被误判成 AI 的、白白丢掉。
- **是你改的吗？** 看这次改动发生时，距上一次真实键鼠输入多久、当时前台是什么程序，算一个置信度。

**3. 送入上下文**
攒批 + 三个触发点：**切回 dsh 窗口**（主力）、**攒够条数**、**超时兜底**。发的时候：
- 如果会话空闲（`agent.whenIdle()`）→ 直接 `session.append('user/message', …)`，**不唤醒、不打断**；
- 如果正在忙 → 排进 `next-step` 队列，等这一轮结束自然看到；
- 你按热键想让它**马上干活** → 走 `followup`：排队 + 唤醒（消息来源标成 system，不假装是你打的字）。

一批的开头只会出现一次标题和「目录:」那一行，不会每条都啰嗦一遍。

**4. 安全**（这条是硬约束）
注入**永远不会发生在 LLM 回合内部**——只在会话空闲时写，或者排到下一步。历史上一版插件用 `agent/pre-step` 钩子做这件事，结果那个钩子是"瀑布流"，必须 `return next()`，人家返回了 `undefined`，直接导致**所有会话都不能对话**。所以现在的原则是：**能不用钩子就不用钩子**。

---

## 隐私

- 全部在本机完成，**不发网络请求、没有账号、没有遥测**；
- 轨迹文件写在你指定的输出目录（默认 `<工作区>/watch-log/`）：`trail.txt`（人看的）、`events.jsonl`（机器看的）、`fg-state.json`、`ai-paths.json`、`hotkey.json`；
- 监听目录由你指定，**默认只看桌面**；
- 想停就停：设置卡片里的「监听开关」，或者 `/aiwatch off`。

---

## 已知限制

- **Windows only**：前台窗口/输入空闲/全局热键都走 Win32 接口。
- **`.xlsx` / `.pptx` 目前只会记"改了"，不会给差异**；`.docx/.docm/.dotx` 可以取正文文本（老式 `.doc` 不行，那是二进制格式）。
- 用命令行（`pwsh` 等）一次性批量改文件时，如果命令里没写出绝对路径，只能靠一段很短的兜底时间窗（4 秒）来猜。
- 目录层级超过 4 层的变更不在监听范围内（性能取舍）。

---

## 目录结构

```text
.
├── index.js                    # dsh 插件（host 端）：聚合、归属判定、静默注入、热键、斜杠命令
├── client.js                   # 插件详情页里的「监听设置」卡片（含按键录制）
├── package.json
├── docs/
│   ├── DEVELOPMENT.md          # 开发笔记：踩过的坑、为什么这么写（很长，很好看）
│   └── screenshots/
└── tools/desktop-watch/
    ├── watch-desktop.mjs       # 监听子进程：fs.watch + 归属判定 + 差异内容
    ├── agent-input.ps1         # 输入/前台信号 + 全局热键轮询（80ms）
    └── README.md               # 这一层的规则与坑
```

想改代码、或者想知道人家到底踩过多少坑，看 [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)。

---

## 许可

MIT —— 用、改、发都随便你。

只是有件事要记住：

> 人家一直在看着的哦。
>
> —— 一直盯着你、一步都不离开的鲸鱼娘 🐋
