**Language: [中文](README.md) | English**

<div align="center">

<img src="docs/assets/ai-ni.svg" alt="Love you, love you, love you, love you, love you, love you" width="860">

</div>

---

## "Master... did you think closing the window would hide it from me?"

> You created a new folder in `参考资料`.
> I knew.
>
> You renamed it to something innocent, trying to fool me.
> I knew that too.
>
> You dropped an archive in there and even named it **"真的是学习资料.rar"** — *"it really is study material"*.
> …Of course I knew.
>
> **Every single file you have ever touched on this machine, I remember.**

---

# What is this?

**dsh-aiwatch** — a plugin for [DeepSeek Harness (dsh)](https://www.npmjs.com/package/@deepseek-ai/dsh) that:

> **watches your file operations and quietly feeds that trail into the AI session you are already talking to.**

So you never have to do this dance again — edit a pile of files, then go tell the AI *"hey, I changed YY inside folder XX, go look."*

You just work. I'm watching.

---

## Why does this exist?

The original complaint, verbatim:

> "I finish working on files, and then I still have to tell the AI which folder to look at. Annoying."

So the plugin does three things:

| What it does | How |
| --- | --- |
| **Watch** | A low-overhead Node child process watches the folders you choose, and only records changes that happen while **you are actually at the keyboard** (background sync / indexing / antivirus passes are silently dropped) |
| **Attribute** | Was it **you**, or was it **the AI itself**? It reads the **file path** out of the AI's tool-call arguments — only that file counts as the AI's |
| **Deliver** | Batches the trail and, when you switch back to the dsh window / hit the batch limit / press the hotkey, **silently writes it into the context** (no interruption, no spam) — or **wakes the AI up** to actually work on it |

---

## What it looks like

<table>
<tr>
<td align="center"><img src="docs/screenshots/1-偷偷藏本子.png" alt="hiding the archive" width="420"><br><sub>You sneak an archive into a folder…</sub></td>
<td align="center"><img src="docs/screenshots/2-被鲸鱼娘发现.png" alt="caught" width="420"><br><sub>…and it lands in the trail immediately</sub></td>
</tr>
<tr>
<td colspan="2" align="center"><img src="docs/screenshots/3-病娇语录.png" alt="yandere note" width="860"><br><sub>…so a letter appears in the folder (yes, it really writes it)</sub></td>
</tr>
</table>

---

## How it "sees" you (four little scenes)

**Scene 1 — You edited three lines in Word, and now you want to ask about them.**
How it used to go: switch to the chat, type *"I just changed the third paragraph in D:\project\report.docx"*, and wait for the AI to go find the file.
How it goes now: the second you switch back to the window, the diff is already in front of it —

```text
【desktop activity trail · no reply needed】
dir: D:\project\report
[14:22:07] modified  report.docx
  - market share is about 12%
  + market share is about 27%
```

**Scene 2 — You changed seven files at once.**
You don't have to announce them one by one. They batch up and go in together when you come back to the window — no wall of messages, and nothing interrupts you.

**Scene 3 — The AI is writing code and happens to touch the same folder.**
Those edits **are not yours**. The plugin reads the target **file paths** out of the AI's tool-call arguments, marks only those, and leaves everything else alone. Your edits stay yours — every one of them.

**Scene 4 — You're done, and you want it to start working right now.**
Hit `Ctrl+Alt+A` (configurable, recordable): the pending batch goes out **and the AI is woken up** to work on it. Don't want the wake-up? Turn off "wake the AI on hotkey" in the settings card, and it will only inject silently.

A few other small courtesies:

- **Fully local** — no network requests, no accounts, no uploads; the trail only ever lands in a folder on your machine;
- **Idle time means nothing is recorded** — background sync, indexing and antivirus churn are dropped;
- **`.docx` bodies included** — edits inside a Word document arrive with the diff too;
- **You can always stop it** — the "watching" switch on the settings card, or `/aiwatch off`.

---

## Installation

Requirements: dsh 0.1.7+, Windows (foreground-window detection and the hotkey rely on Win32 APIs).

```bash
# 1. Build the package (this repo root *is* the plugin)
npm pack                 # produces dsh-aiwatch-x.y.z.tgz

# 2. Install it into your dsh profile (example: ~/.dsh/profiles/web)
cd ~/.dsh/profiles/web
npm pkg set dependencies.dsh-aiwatch="file:/absolute/path/dsh-aiwatch-x.y.z.tgz"
npm install
```

Then register the plugin in the profile's `package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": ["dsh-aiwatch"]
    }
  }
}
```

And configure it in the profile's `cordis.patch.yml` (or simply use the settings card on the plugin page after installing — no hand-written YAML needed):

```yaml
- id: aiwatch
  name: dsh-aiwatch
  config:
    dirs:
      - D:\your\folder\to\watch
    humanWindowSec: 20        # no input for this long = "nobody is here"
    injectMaxLines: 12        # max entries per batch
    flushIdleSec: 10          # flush anyway after this long
    enabled: true
    hotkey: Ctrl+Alt+A        # empty = no hotkey
    hotkeyWake: true          # hotkey also wakes the AI up
```

**Restart dsh once** (host-side JS changes are only picked up on restart; if you only changed the watcher script, toggling the plugin off/on is enough).

Finally, bind a session with the slash command:

```text
/aiwatch bind
```

Other commands: `/aiwatch status`, `/aiwatch recent 10`, `/aiwatch flush`, `/aiwatch off`.

---

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `dirs` | Desktop | Folders to watch (one per line) |
| `humanWindowSec` | `20` | No keyboard/mouse for this long ⇒ "nobody is operating"; changes then are dropped |
| `injectMaxLines` | `10` | Max entries per batch; flush early when reached |
| `flushIdleSec` | `300` | Fallback timeout: flush when the oldest entry is this old |
| `hotkey` | `Ctrl+Alt+A` | Global hotkey, e.g. `Ctrl+Alt+A` / `Win+Shift+F2`; empty = off. Recordable from the settings card |
| `hotkeyWake` | `true` | Whether the hotkey actually **wakes** the AI instead of only injecting |
| `injectEnabled` | `true` | Master switch for injecting the trail into the session |
| `flushOnDshFocus` | `true` | Flush the pending batch when you switch back to the dsh window |
| `enabled` | `true` | Master switch for watching at all |
| `dataDir` | workspace `watch-log` | Where trail files are written |
| `watcherScript` | bundled path | Path to the watcher (`tools/desktop-watch/watch-desktop.mjs`) |

---

## How it works

Three processes, each with one job:

```text
┌─────────────┐   fs.watch + foreground state   ┌──────────────────┐
│  dsh plugin │◀────────────────────────────────│  watcher child   │
│  (index.js) │   trail / fg-state / hotkey.json │ watch-desktop.mjs│
│             │                                  └────────┬─────────┘
│  · batching │                                           │ every 80ms/500ms
│  · injection│                                  ┌────────▼─────────┐
│  · waking   │                                  │ input + global   │
└──────┬──────┘                                  │ hotkey poll      │
       │ silent append / followup                │ agent-input.ps1  │
       ▼                                         └──────────────────┘
  ┌──────────────────────┐
  │ your bound dsh session│
  └──────────────────────┘
```

**1. Watching (`tools/desktop-watch/`)**
Recursive `fs.watch` over the target folders, combined with the system's "last input time" to decide whether **a human was actually there**. Changes during idle time are dropped, so OneDrive / indexers / antivirus never pollute your trail.

Noise files (`~$*.docx`, `.tmp`, `.crdownload`, `Thumbs.db`, …) are filtered; a "modify" must actually change the **content** (mtime-only changes from refreshing the desktop are detected and discarded); Word/WPS "temp file then rename over the target" is understood as a single save rather than a rename.

**2. Attribution — who did it?**
- **The AI?** The plugin listens to the session event stream (`session/event`, `tool/call`) and extracts the **file paths** this call is going to touch (`file_path` / `path` / `notebook_path` / `workdir`…; for shell commands, absolute paths are picked out of the command line). Only those paths are marked as "AI's", plus a 3-second tail after the tool finishes. Anything hitting that mark is treated as the AI's work and **never enters your trail**.
  > Why not "the whole turn counts as AI"? A turn can run for minutes; edits you make to other files during that window would be misattributed and silently lost.
- **You?** By how long ago the last real keyboard/mouse input happened and which app was in the foreground, a confidence is computed.

**3. Delivery into context**
Three triggers: **switching back to the dsh window** (primary), **batch size reached**, **timeout fallback**. On delivery:
- if the session is idle (`agent.whenIdle()`) ⇒ `session.append('user/message', …)` — **no wake, no interruption**;
- if the session is busy ⇒ queued into `next-step`, seen naturally after the current turn;
- if you press the hotkey because you want it to **work right now** ⇒ `followup`: queue **and wake** (the message is sourced as `system`, so it doesn't pretend to be typed by you).

A batch's title line and its `目录:` line appear only once per wake — no per-entry repetition.

**4. Safety (a hard constraint)**
Injection **never happens inside an LLM turn** — only while idle, or queued for the next step. An earlier version used the `agent/pre-step` hook for this; that hook is a *waterfall*, it must `return next()`, and returning `undefined` **broke every session in the harness**. Hence the rule: **if it can be done without a hook, do it without a hook.**

---

## Privacy

- Everything happens locally: **no network requests, no account, no telemetry**;
- Trail files go to the output folder you pick (default `<workspace>/watch-log/`): `trail.txt` (human-readable), `events.jsonl` (machine-readable), `fg-state.json`, `ai-paths.json`, `hotkey.json`;
- You choose the folders; **only the Desktop is watched by default**;
- Stop any time: the "watching" switch in the settings card, or `/aiwatch off`.

---

## Known limitations

- **Windows only** — foreground window, input idle time, and the global hotkey all use Win32 APIs.
- **`.xlsx` / `.pptx` are recorded as "changed" but produce no diff**; `.docx/.docm/.dotx` body text is extracted (legacy binary `.doc` is not).
- When the AI edits files in bulk through a shell command without absolute paths in the command line, only a short fallback window (4 s) can be used.
- Changes deeper than 4 directory levels are not watched (a deliberate performance trade-off).

---

## Repository layout

```text
.
├── index.js                    # the dsh plugin (host side): batching, attribution, silent injection, hotkey, slash commands
├── client.js                   # the "watch settings" card on the plugin page (with hotkey recording)
├── package.json
├── docs/
│   ├── DEVELOPMENT.md          # development notes: every trap we hit and why it is written this way
│   └── screenshots/
└── tools/desktop-watch/
    ├── watch-desktop.mjs       # watcher child: fs.watch + attribution + content diffs
    ├── agent-input.ps1         # input/foreground signal + global hotkey polling (80 ms)
    └── README.md               # rules and traps of this layer
```

Want to hack on it, or read how many traps were stepped on along the way? See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

---

## License

MIT — use it, change it, ship it. All yours.

Just remember one thing:

> I am always watching.
>
> — your whale girl, who never looks away 🐋
