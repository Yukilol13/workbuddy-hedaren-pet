---
name: hedaren-pet
description: 和大人（和珅）桌面宠物控制。当用户提到"和大人""和珅桌宠""桌宠""让和大人说话/出来/躲起来/干活""查国库/积分""和大人陪我聊/问和大人""跟和大人说""和大人府邸""打开府邸""颤栗值/官位""捕鱼开关""打开/关闭捕鱼""捕鱼一次"等，或想让桌面宠物跟随 WorkBuddy 工作状态、播放动作、查积分、人格对话（用 WorkBuddy 当前会话模型）、改设置时使用。也可用于安装/卸载桌宠。
---

# 和大人桌面宠物（WorkBuddy 通用版）

和珅风格的透明桌面宠物：Q 版两头身动画、可拖拽甩飞、气泡台词、跟随 WorkBuddy 工作状态（思考时掏出算盘点钞、等待授权时挂起）、查 WorkBuddy 积分国库、三层记忆人格对话（**由 WorkBuddy 当前会话模型亲自生成，不用任何外部模型/API Key**）、颤栗值/官位系统、和大人府邸设置窗口（配色与工作泡泡一致）、右键一次性捕鱼纯视觉玩法（开启后飞行满 2 秒播一次撒网动画即自动关闭）。

## 安装位置

- 项目目录：`{{PET_DIR}}`
- 状态目录：`{{STATE_DIR}}`（环境变量 `HEDAREN_PET_HOME` 可覆盖）
- 控制脚本：`{{PET_DIR}}/hedarenctl.js`
- Node：`{{NODE_EXE}}`

## 触发与用法

### 1）控制桌宠（优先用对话触发）

用户说"让和大人说 XXX""和大人出来""躲起来""干活""休息"时，执行对应命令：

```bash
{{NODE_EXE}} --no-warnings "{{PET_DIR}}/hedarenctl.js" say "皇上圣明，奴才在" 点击-拱手
{{NODE_EXE}} --no-warnings "{{PET_DIR}}/hedarenctl.js" play 银票打手
{{NODE_EXE}} --no-warnings "{{PET_DIR}}/hedarenctl.js" show
{{NODE_EXE}} --no-warnings "{{PET_DIR}}/hedarenctl.js" hide
{{NODE_EXE}} --no-warnings "{{PET_DIR}}/hedarenctl.js" work --task "写代码" --total 5 --done 2
{{NODE_EXE}} --no-warnings "{{PET_DIR}}/hedarenctl.js" idle
{{NODE_EXE}} --no-warnings "{{PET_DIR}}/hedarenctl.js" status
```

也可用已注册的 MCP 工具 `mcp__hedaren-pet__hedaren_pet`（action: status/say/play/show/hide/work/credits/chat_context/chat/submit_reply/memory/memory_search/mood/mood_reset/fish_play/fish_preview/mansion）。

### 2）查国库 / 积分

用户问"国库""积分""查账"时：

```bash
{{NODE_EXE}} --no-warnings "{{PET_DIR}}/hedarenctl.js" credits
```

数据源是 WorkBuddy 本地 `~/.workbuddy/workbuddy.db` 的积分消耗，**是已消耗积分，不是账号余额**。和大人小金库的"抽成"是娱乐效果。

### 3）和大人对话（用 WorkBuddy 当前会话模型，即你自己）

**关键**：跟和大人对话时，回复由**你（WorkBuddy 当前会话模型）亲自生成**，不走任何外部大模型 API（DeepSeek/方舟/豆包等一律不用），也不需要任何 API Key。分两步：

```bash
# 第一步：取上下文（人格设定 + 命中记忆 + 此刻心气/口吻 + 最近对话 + 皇上这句）
{{NODE_EXE}} --no-warnings "{{PET_DIR}}/hedarenctl.js" chat-context "朕的国库如何？"

# 第二步：你据上面材料，以和珅口吻亲自写一句简短回复（≤60字），写回桌宠
{{NODE_EXE}} --no-warnings "{{PET_DIR}}/hedarenctl.js" reply "朕的国库如何？" "回皇上，国库充盈，都在奴才账上呢。"
```

- **不要在 WorkBuddy 里另起一个外部模型调用**——你自己就是和大人要用的模型。读第一步输出的「人格/记忆/心气要求」，直接写出符合和珅人设的回复，再用 `reply`（或 `chat --reply`）写回。
- 三步记忆、颤栗值/官位、气泡台词、端点硬话术都由 `reply` 自动处理，无需你操心。
- 若皇上这句触发「胆战心惊」，上下文会标注，此时和大人只认错求饶（脚本也会强制固定话术）。
- 简写：`chat "问题" --reply "你的回复"` 等价于 `reply`。不带回复的裸 `chat` / 桌面聊天窗离线输入才会用本地预设话术兜底。
- MCP 等价：`action=chat_context` 取上下文 → `action=submit_reply`（`text`=皇上原话、`reply`=你写的回复）写回；`action=chat` 配 `reply` 是简写。
- 模型固定：`action=models` 只返回 `workbuddy` 一项；`set-model` 为空操作。没有模型下拉、没有外部 Key 配置。

记忆账本 / 检索：

```bash
{{NODE_EXE}} --no-warnings "{{PET_DIR}}/hedarenctl.js" memory
{{NODE_EXE}} --no-warnings "{{PET_DIR}}/hedarenctl.js" search "关键词"
```

### 4）启动 / 安装 / 卸载桌宠

```bash
{{NODE_EXE}} --no-warnings "{{PET_DIR}}/hedarenctl.js" start          # 启动窗口（无 Electron 会自动下载）
{{NODE_EXE}} --no-warnings "{{PET_DIR}}/install.js"                    # 首次一键安装（Electron + hooks + MCP）
{{NODE_EXE}} --no-warnings "{{PET_DIR}}/install.js" --uninstall        # 卸载（移除 hooks/MCP 注册）
```

**绑定启动（自动唤醒，默认关）**：自动唤醒开关在**和大人府邸 → 基本设置**（勾选「皇上开衙时，奴才自己来上朝」）。开关同时管理两处：`{{STATE_DIR}}/autostart.json`（`{ "enabled": false }`，改完立即生效）和 `~/.workbuddy/settings.json` 的 SessionStart hook 注册（增删后需重启 WorkBuddy 生效；只动含 `pet-hook.js` 的条目，不碰用户其它 hook）。开启后用户开新会话时若桌宠没在运行会自动出现（判活靠 `window.lock` 心跳 + 60 秒防抖锁）。若开了开关但开会话后桌宠没自动出现（WorkBuddy 回收 hook 子进程的版本），引导用户把 `start.bat` 快捷方式放进 `shell:startup` 开机自启兜底。

## 工作机制

- **工作状态联动**：WorkBuddy hooks（SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Notification/Stop/SessionEnd）调用 `hooks/pet-hook.js`，把事件写进 `desktop-state.json` 的 `work` 字段；桌宠窗口 900ms 轮询该文件，自动切换"工作/审批/待机"动画。**hooks 需重启 WorkBuddy 后生效。**
- **反向控制**：MCP server（`mcp-server.js`）让 Agent 主动驱动桌宠。
- **对话回复链路（WorkBuddy 模型）**：对话由 WorkBuddy 当前会话模型（Agent 你自己）生成——先 `chat-context`/`action=chat_context` 取上下文，再 `reply`/`action=submit_reply` 写回。**桌宠进程绝不调用任何外部大模型 API**。`pet-daemon.js` 守护进程**不再自动拉起**，由用户手动启停：托盘右键「守护进程：开启/关闭」，或 `hedarenctl.js daemon-start / daemon-stop / daemon-status`。守护进程负责轮询离线 pending（桌面聊天窗离线输入）、右键查账本/国库、30 秒自动国库刷新与亏空判定；关掉时这些功能不可用，但 WorkBuddy 对话链路（chat-context/reply）不经过守护进程，**不受影响**。
- **积分查询**：Node 内置 `node:sqlite` 只读 WorkBuddy 数据库，Python 脚本兜底。
- **通用 Electron**：`electron-runtime.js` 按 环境变量 → 项目内 vendor → 旧 DSH 目录 → 全局路径 → 镜像下载 的顺序解析，任何人都能用，无 DSH 也能跑。
- **颤栗值/官位**：mood.js 纯逻辑，随对话涨跌；满格「胆战心惊」只认错求饶、归零「心花怒放」。MCP `action=mood` / `mood_reset` 查/重置。
- **和大人府邸**：右键菜单/托盘的「和大人府邸」，或 MCP `action=mansion`，打开独立设置窗口（家底/官位/日记/设置）。配色与「工作中」的聊天泡泡一致（深色底+米色字+金色点缀）。府邸里**没有**捕鱼开关和模型下拉。
- **捕鱼玩法（一次性·定身判定·计数）**：开关**只在右键菜单**（「捕鱼一次：开/关」），府邸里没有。开启后飞行满 2 秒和大人**原地定身**，随机判定（约 80% 成功）后播「网住大肥鱼」动画——捕到则**捕鱼计数 +1**（府邸家底可见，气泡播报累计条数），随后**自动关闭**，下次要再捕需右键手动重新开启。MCP `action=fish_play` 配 `enabled=true` 开启（一次性）、`fish_preview` 预览。原 DSH 真实捕捉链已整体停用。
- **亏空判定（肚兜坐牢）**：府邸「基本设置」的亏空阈值以**积分**为单位——**当日消耗额超过阈值**时，和大人穿肚兜坐牢房并喊「小月莫愁」（每天最多一次；0=不判定）。判定由**守护进程**每 30 秒刷新国库触发，守护进程未开启时此功能不生效。
- **国库口径**：WorkBuddy 的剩余积分余额只在服务端（本地 DB 只记消耗），国库总余额 = 本地累计消耗总额（实时），府邸与「查国库」显示同一数字。
- **与 DSH 版共存**：本版独立 userData（`~/.workbuddy/hedaren-pet/electron-userdata/`），不与 DSH 老版抢单实例锁；窗口标题/托盘/进程命令行均带 `[WorkBuddy]`（或 `--pet-edition=workbuddy`）标识，可和 DSH 版一眼区分。

## 注意

- 所有命令用 `--no-warnings` 避免 node:sqlite 实验特性警告污染输出。
- 桌宠窗口是独立 Electron 进程，关掉 WorkBuddy 不影响它；要退出可点托盘图标。
- 状态文件可被多进程读写，采用"读-合并-写"策略，请勿手动编辑。
