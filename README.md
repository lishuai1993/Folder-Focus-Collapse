# Folder Focus Collapse

# English

Folder Focus Collapse keeps the file explorer focused on the note you are working on. When a note is activated, folders outside its path collapse, the active row is brought into view at a stable position, and the row is highlighted so it can be found at a glance. It is a derivative of [Auto Folder Collapse](obsidian://show-plugin?id=auto-folder-collapse): the accordion and inactivity behaviour of the original plugin are preserved, while activation-driven focusing, anchoring, scrolling, highlighting, and bilingual settings are new work introduced by this plugin.

# 一、Features added by this plugin

## 1.1 Collapse when a note is activated

Three independent triggers decide when the tree collapses around the active note:

- **Click in the editor** — clicking into the note body or moving the caret focuses the tree on that note.
- **Switch tabs** — the active leaf changing triggers the same collapse, including clicking a file in the explorer.
- **Open a file** — quick switcher, search, and hotkeys can trigger it too. Both tab-switch and file-open triggers are off by default to avoid churn.

The scope of a collapse is controlled by the keep mode:

| Keep mode | Folders left open |
| :--- | :--- |
| Active file path only | Only the ancestor chain of the active note. |
| Path + sibling folders | The ancestor chain plus the direct subfolders of the note's parent folder. |
| Path + current folder subtree | The entire subtree of the note's parent folder. |

For `Projects/Research/Papers/note.md`, the three modes keep respectively `Projects/Research/Papers`, that chain plus the direct children of `Papers`, or the whole `Papers` subtree. None of the modes opens folders on its own; they only decide what survives a collapse. A note at the vault root keeps the whole tree in subtree mode.

The effect is a tree that shows only the current working context. Unrelated folders stop competing for space and attention, so there is no repeated scrolling or scanning through layers to find the note; keeping the ancestor chain open preserves where the note sits in the vault.

## 1.2 Anchor-first scrolling

After collapsing, the plugin positions the active row instead of merely making it visible. The container is divided into a comfort band from 10% to 78% of its height; the first top-level folder of the active path is treated as an anchor and kept at its pre-collapse screen position whenever the active row still fits in the band. When the ancestor chain is too long for that, the plugin concedes the minimum amount of scroll, and only then falls back to centering the row at a configurable ratio (40% by default, adjustable from 30% to 55%).

Four mutually exclusive scroll modes are available:

| Scroll mode | Behaviour |
| :--- | :--- |
| Anchor first (default) | Keeps the top-level folder fixed and centres only when the chain no longer fits. |
| Always center | Places the active row at the configured height on every activation. |
| Only keep visible | Scrolls only when the row is completely out of view, using native `scrollIntoView`. |
| No scrolling | Collapses only and never writes the scroll position. |

The write happens in the next animation frame, with up to two retries while the row is still mounting. A 250 ms correction window fixes native auto-reveal if it arrives late and pushes the row out of the comfort band, and never fights a result that is already comfortable. Each file-explorer pane is positioned independently, so split view works per pane.

Anchor-first scrolling is not only about bringing the row into view. Its main effect is keeping the tree above the target row visually stable: when the collapse changes the tree height, the top-level folder does not jump up or down, so the sidebar does not visibly shift. Spatial memory stays intact, users do not have to re-establish where things are, and attention is not pulled away by a large scroll. When anchoring cannot cover a long ancestor chain, the centre ratio still lands the row in the natural upper-middle viewing area.

## 1.3 Active-file highlight

Three highlight styles make the active row easy to spot without relying on scroll position alone:

- **Accent fill** (default) — theme accent background, contrasting text, rounded corners, semibold label.
- **Left bar** — native background plus a 3 px accent marker on the left edge.
- **Theme default** — no injected style.

Styles are scoped to the file explorer and are added or removed as the setting changes or the plugin unloads.

The highlight is not decoration. Its effect is to make the active row the one immediately identifiable element in the list: even when the row sits above the visual centre, the accent fill lets it stand out without scanning row by row. Together with stable positioning, this means users confirm the active note by appearance rather than by scrolling or searching.

## 1.4 Bilingual settings and in-place updates

The settings tab can follow Obsidian's language automatically or be forced to Chinese or English. Switching the language re-renders every section, setting name, description, and notice. Other settings update in place: for example, changing the scroll mode greys out or restores the centre-position slider without re-rendering the page, so the scroll position and keyboard focus are preserved. A reset button restores every setting to its default.

## 1.5 Diagnostics and compatibility

- An in-memory debug log records events, per-frame tree height, folder changes, scroll writes, and reveal decisions. It can be exported with the command **Export file-explorer switch debug log**; measurements do not write to disk.
- A bypass mode disables all collapsing and observes native behaviour only, for side-by-side comparison with Obsidian's own auto-reveal.
- The internal `view.fileItems` API is preferred; a DOM fallback handles builds where the API is missing.
- Multiple file-explorer panes are supported, and the plugin cleans up listeners and injected classes on unload.
- Settings from earlier versions (`revealActiveFile` and `revealStrategy`) are migrated automatically to the unified `revealMode`.

# 二、Implementation optimization

## 2.1 Single-frame collapse

The collapse is scheduled in a microtask before the next paint, so the explorer never shows the old tree. When the internal folder API is available, `setCollapsed` is used and the `is-collapsed` class is applied immediately as a fast path; the expanded ancestors are mounted in the same frame. A 300 ms accordion-suppression window prevents these programmatic changes from being interpreted as manual gestures.

This is an implementation optimization rather than a user-facing feature. The effect is that a switch completes in one visual step: no old tree, no intermediate height, and no flash of an expanded-then-collapsed chain.

# 三、Features provided by the original plugin

## 3.1 Recursive child collapse

Collapsing a folder also collapses all of its descendant folders.

## 3.2 Exclusive accordion

Expanding a folder collapses every other folder.

## 3.3 Inactivity auto-collapse

After a configurable idle period (5 minutes by default), all expanded folders collapse. The duration is adjustable from 1 to 60 minutes.

## 3.4 Settings compatibility

The original keys `autoCollapseEnabled`, `inactivityMinutes`, and `exclusiveAccordionEnabled` are retained, so existing values carry over.

# 四、Settings reference

| Key | Default | Description |
| :--- | :--- | :--- |
| `uiLanguage` | `auto` | Settings language: follow Obsidian, Chinese, or English. |
| `collapseOnEditorClick` | on | Collapse when clicking into the editor. |
| `collapseOnActiveLeafChange` | off | Collapse when the active tab changes. |
| `collapseOnFileOpen` | off | Collapse when a file opens through other routes. |
| `keepMode` | `path` | Which folders survive a collapse. |
| `revealMode` | `anchor` | Anchor first / always center / only keep visible / no scrolling. |
| `revealCenterRatio` | 40 | Height ratio used when centring (30–55). |
| `activeFileHighlight` | `accent` | Accent fill / left bar / theme default. |
| `exclusiveAccordionEnabled` | on | Collapse other folders when one is expanded. |
| `autoCollapseEnabled` | on | Collapse folders after inactivity. |
| `inactivityMinutes` | 5 | Idle minutes before collapsing (1–60). |
| `debugLogging` | off | Record the switch debug log in memory. |
| `debugBypass` | off | Observe native behaviour without changing the tree. |

# 五、Installation

1. Copy the `folder-focus-collapse` folder into `<vault>/.obsidian/plugins/`.
2. Reload Obsidian and enable **Folder Focus Collapse** in Settings → Community plugins.
3. If Auto Folder Collapse is installed, disable it: both plugins control the same tree and must not run together.

# 六、Compatibility

- Obsidian 1.0.0 or later; desktop and mobile.
- The plugin prefers Obsidian's internal folder API and falls back to DOM handling when that API is unavailable.
- Existing Auto Folder Collapse settings are read through the shared keys; no manual migration is required.

# 七、License

MIT. This project is derived from [Auto Folder Collapse](obsidian://show-plugin?id=auto-folder-collapse) by Dario Casciato; see [LICENSE](LICENSE) for the license text and [NOTICE](NOTICE) for the attribution notice.

---

# 中文说明

Folder Focus Collapse 让文件树始终围绕你正在编辑的那篇笔记。笔记被激活时，路径之外的目录自动收拢，当前文件行被带到视口中一个稳定的位置，并以醒目的高亮标出。本插件基于 [Auto Folder Collapse](obsidian://show-plugin?id=auto-folder-collapse) 二次开发：原插件的手风琴与闲置折叠行为完整保留，激活聚焦、锚点定位、滚动、高亮与中英文设置均为本插件新增。

# 一、本插件新增的功能

## 1.1 笔记激活时收拢

三种互相独立的触发方式决定何时围绕当前笔记收拢目录：

- **点击正文**：点击正文或移动光标进入当前笔记时，文件树聚焦到该笔记所在路径。
- **切换标签页**：活动标签页变化时同样收拢，点击文件树中的文件也会触发。
- **打开文件**：快速切换、搜索、快捷键等打开文件的方式也可以触发。后两者默认关闭，避免频繁收拢。

收拢范围由「保持展开的目录」决定：

| 保留模式 | 保持展开的目录 |
| :--- | :--- |
| 仅当前文件路径 | 只保留当前笔记的祖先目录链。 |
| 路径 + 同级目录 | 祖先目录链，以及笔记所在父目录的直接子文件夹。 |
| 路径 + 当前目录整层 | 笔记所在父目录的整棵子树。 |

以 `工作管理/技术沉淀/深度学习框架/笔记.md` 为例，三种模式分别保留 `工作管理/技术沉淀/深度学习框架`、该链条加上 `深度学习框架` 的直接子文件夹，或 `深度学习框架` 的整棵子树。三种模式都不会主动展开目录，只决定收拢后哪些目录保持原样。笔记位于库根目录时，整层模式保留整棵树。

这一设计的效果是让文件树只呈现当前工作上下文：无关目录不再占据左侧空间与注意力，用户不需要反复滚动或在多层目录中寻找笔记；同时祖先链保持展开，笔记在库中的位置关系不会丢失。

## 1.2 锚点优先的滚动定位

收拢后不是简单地「让当前文件可见」，而是把它放到一个稳定位置。文件树容器按高度划分出 10% 至 78% 的舒适带；当前路径的首段顶层目录作为锚点，尽量保持在收拢前的屏幕高度。祖先链过长、锚点无法兼顾时，先做最小让步，仍不满足才回退到按比例居中（默认 40%，可在 30% 至 55% 之间调整）。

滚动方式共四档，彼此互斥：

| 滚动方式 | 行为 |
| :--- | :--- |
| 顶部锚定优先（默认） | 锁住顶层目录的位置，链条放不下时才居中。 |
| 始终居中 | 每次激活都把当前文件放到设定的高度。 |
| 仅保证可见 | 只在当前文件完全不可见时贴近边缘，使用原生 `scrollIntoView`。 |
| 不滚动（只收拢） | 只执行收拢，完全不改变滚动位置。 |

滚动写入发生在下一帧；文件行尚未挂载时最多重试两帧。写入后 250 毫秒内监听原生滚动：如果原生「自动显示当前文件」晚到并把文件行推出舒适带，只纠正一次；如果结果已经舒适，则不再与其争夺。分屏中的每个文件树面板独立定位。

锚点优先的滚动定位不只是把文件行带进视口。它的核心效果是保持目标文件行上方那段文件树在屏幕上的位置稳定：收拢改变树高时，顶层目录不会突然上跳或下移，整个左侧栏不产生明显跳动。用户的空间记忆因此保持连续，不需要重新建立「文件在哪里」的位置感，注意力也不会被大幅滚动分散。祖先链过长、锚点无法兼顾时，居中比例仍让文件落在视线自然区域的中部偏上。

## 1.3 当前文件高亮

三档高亮让当前文件在不依赖滚动位置的情况下也能被一眼找到：

- **强调色底**（默认）：使用主题强调色作为背景，配对比文字、圆角与半粗字重。
- **左侧强调条**：保留原生底色，在左侧加 3 像素强调色竖条。
- **保持主题**：不注入任何样式。

样式仅作用于文件树内的当前文件行，随设置变更或插件卸载成对增删。

高亮不是装饰。它的效果是让当前文件行成为列表中唯一可以立即识别的元素：即使文件落在偏上位置、不在视线正中心，强调色底也能让它在整列文件中脱颖而出，无需逐行扫视。与稳定的定位配合，用户依靠外观即可确认当前笔记，而不必再通过滚动或寻找来确认。

## 1.4 双语设置与原地更新

设置页可以跟随 Obsidian 语言，也可以固定为中文或英文。切换语言会重排全部分区标题、设置项、释义与提示文字。其余设置原地更新：例如切换滚动方式时，「居中位置」滑杆只会置灰或恢复，不重建整个设置页，因此滚动位置与键盘焦点都能保留。设置页底部提供恢复默认设置。

## 1.5 调试与兼容能力

- 内存中的调试日志记录事件、逐帧树高、目录变更、滚动写入与定位决策，可通过命令「导出文件树切换调试日志」一次落盘；测量期间不写磁盘，避免日志本身干扰。
- 旁路模式停止一切收拢，只观测原生行为，便于与 Obsidian 自带的自动定位逐帧对照。
- 优先使用内部 `view.fileItems` 接口，接口缺失时回退到 DOM 方式。
- 支持多个文件树面板；插件卸载时清理监听器与注入的样式类。
- 旧版本设置（`revealActiveFile` 与 `revealStrategy`）会自动迁移为统一的 `revealMode`。

# 二、算法与实现优化

## 2.1 单帧完成收拢

收拢在微任务内完成，赶在下一帧绘制之前生效，文件树不会先显示旧形态再跳变。走内部接口时调用 `setCollapsed` 并立即补上 `is-collapsed` 类作为快路径，展开的祖先目录在同一帧内挂载完成。整个过程设置 300 毫秒的手风琴抑制窗口，程序化的展开与折叠不会被误判为手动操作。

这属于算法与实现层面的优化，不是一项独立功能。它的效果是让一次切换在视觉上一步到位：不出现旧树形态、不出现中间树高，也不会闪过先展开后折叠的链条。

# 三、原插件已有的功能

## 3.1 递归折叠子目录

折叠一个目录时，其内部所有已展开的子目录一并折叠。

## 3.2 手风琴模式

手动展开一个目录时，折叠其它目录。

## 3.3 闲置自动折叠

一段时间没有操作后折叠全部已展开的目录，默认 5 分钟，可在 1 至 60 分钟之间调整。

## 3.4 设置兼容

沿用原插件的 `autoCollapseEnabled`、`inactivityMinutes`、`exclusiveAccordionEnabled` 三个键，原有取值直接生效。

# 四、设置项一览

| 键 | 默认 | 说明 |
| :--- | :--- | :--- |
| `uiLanguage` | `auto` | 设置页语言：跟随 Obsidian、中文或英文。 |
| `collapseOnEditorClick` | 开 | 点击正文时收拢。 |
| `collapseOnActiveLeafChange` | 关 | 切换标签页时收拢。 |
| `collapseOnFileOpen` | 关 | 通过其它方式打开文件时收拢。 |
| `keepMode` | `path` | 收拢时保留哪些目录。 |
| `revealMode` | `anchor` | 顶部锚定优先 / 始终居中 / 仅保证可见 / 不滚动。 |
| `revealCenterRatio` | 40 | 居中时的行高比例（30–55）。 |
| `activeFileHighlight` | `accent` | 强调色底 / 左侧强调条 / 保持主题。 |
| `exclusiveAccordionEnabled` | 开 | 展开一个目录时折叠其它目录。 |
| `autoCollapseEnabled` | 开 | 闲置后自动折叠。 |
| `inactivityMinutes` | 5 | 闲置时长（1–60 分钟）。 |
| `debugLogging` | 关 | 在内存中记录切换调试日志。 |
| `debugBypass` | 关 | 只观测原生行为，不改动文件树。 |

# 五、安装

1. 把 `folder-focus-collapse` 目录复制到 `<库>/.obsidian/plugins/`。
2. 重载 Obsidian，在「设置 → 第三方插件」中启用 **Folder Focus Collapse**。
3. 如果安装了 Auto Folder Collapse，请将其停用：两者控制同一棵文件树，不能同时运行。

# 六、兼容性

- 支持 Obsidian 1.0.0 及以上版本，桌面端与移动端通用。
- 优先使用 Obsidian 内部目录接口，接口不可用时自动回退到 DOM 处理。
- 原 Auto Folder Collapse 的设置通过共享键读取，无需手动迁移。

# 七、许可证

MIT。本项目派生自 Dario Casciato 的 [Auto Folder Collapse](obsidian://show-plugin?id=auto-folder-collapse)，许可证正文见 [LICENSE](LICENSE)，完整署名见 [NOTICE](NOTICE)。
