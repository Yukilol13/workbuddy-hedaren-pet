# 和大人桌面宠物 · WorkBuddy 版

> 皇上，奴才和珅，在您桌面上候着呢。您敲代码，奴才给您算账；您歇着，奴才给您盯着国库。不用另配钥匙，不用外头的模型，WorkBuddy 认识奴才就够了。**不依赖 DSH，装了 WorkBuddy 就能用。**

Q 版两头身清朝权臣：全套动画表情、可拖拽甩飞、气泡台词、跟随工作状态（思考时掏算盘点钞、等授权时挂起）、查积分国库、三层记忆人格对话、和大人府邸、右键一次性撒网捕鱼。

由 [Yukilol13/dsh-hedaren-pet](https://github.com/Yukilol13/dsh-hedaren-pet) v0.3.1 改造——功能照旧全须全尾，宿主从 DSH 换成 WorkBuddy 的 hooks + MCP + 本地数据库。

---

## 给 Agent 的安装说明（照做即可）

**前提**：本机装了 WorkBuddy 就行。node 不用另装、也不用管版本——安装器和 hook 都会自动找 WorkBuddy 自带的那份（找不到才退到系统 node，再退到项目自带的 Electron 内置 Node）。

```bash
# 1) 把仓库放到任意目录，进入项目根
cd workbuddy-hedaren-pet

# 2) 一键安装（幂等，可重复跑）
#    Windows 双击 install.bat；macOS/Linux 或命令行：
node --no-warnings install.js
```

安装器替您办四件事，一件都不少：

1. **Electron 运行时**——环境变量 → 项目内 `vendor/electron/` → 旧 DSH 目录 → 全局路径 → 国内镜像下载（约 100MB，只下一次，之后复用）
2. **工作状态 hooks**——合并进 `~/.workbuddy/settings.json`
3. **MCP server**——注册进 `~/.workbuddy/mcp.json`
4. **对话 Skill**——装进 `~/.workbuddy/skills/hedaren-pet/`

```bash
# 3) 重启 WorkBuddy（hooks 和 MCP 才认账）

# 4) 启动桌宠窗口（Windows 双击 start.bat 最省事）
node --no-warnings start.js

# 5) 验一验
node --no-warnings hedarenctl.js status
```

装完之后，在 WorkBuddy 里说「安装和大人桌宠」「让和大人出来」都能使唤他。

> **换电脑不会翻车的缘故**：hooks 和 MCP 里不再写死 `.../versions/22.22.2-6/node.exe` 这种带版本号的路径（以前就是栽在这——别人的电脑用户名不同、WorkBuddy 版本不同，那条路径直接是死的，于是报 node 版本不一致）。现在 hook 走 `bin/hedaren-node.cmd` 包装脚本，**每次执行时才去读 WorkBuddy 的 `versions/current` 指针**找当前在用的 node；MCP 那条路径桌宠每次启动都会自愈一遍。哪台机器、哪个版本都对得上。

> **两条要交代的规矩**：
> - **自动唤醒默认是关的**——想让和大人每次开新会话自己上朝，去「和大人府邸 → 基本设置」勾上「皇上开衙时，奴才自己来上朝」（改完重启 WorkBuddy 生效）。默认不注册 SessionStart hook，省一次进程启动。
> - **守护进程不自动跑**——托盘右键「守护进程：开启/关闭」或 `hedarenctl.js daemon-start / daemon-stop` 手动启停，不开也不影响任何主功能。管的是：桌面聊天窗离线回复、右键查账本国库、30 秒自动刷国库和肚兜亏空判定。**跟和大人说话走的是 WorkBuddy 会话模型，不经过它**。

卸载：`node --no-warnings install.js --uninstall`（只摘 hooks/MCP，不动您的记忆账本）。

---

## 日常使唤

| 皇上说 | 奴才就 |
|---|---|
| 让和大人说「皇上圣明」 | 气泡里应声，还带拱手动作 |
| 和大人出来 / 躲起来 | 露脸 / 退下 |
| 让和大人干活 / 休息 | 切工作态 / 待机 |
| 查一下国库 | 报今日、近七日、累计积分，顺带抽成进小金库（娱乐） |
| 跟和大人说「朕最近如何是好」 | 用 WorkBuddy 当前会话模型亲自回话，颤栗值官位全带上 |
| 播放银票打手 | 演一段 |

命令行等价：

```bash
node --no-warnings hedarenctl.js say "皇上圣明" 点击-拱手
node --no-warnings hedarenctl.js play 银票打手
node --no-warnings hedarenctl.js show | hide | status
node --no-warnings hedarenctl.js work --task "写代码" --total 5 --done 2
node --no-warnings hedarenctl.js credits
node --no-warnings hedarenctl.js mansion          # 打开府邸
```

MCP 工具 `mcp__hedaren-pet__hedaren_pet` 一把抓：`status / say / play / show / hide / work / credits / chat_context / submit_reply / memory / memory_search / mood / mood_reset / fish_play / fish_preview / mansion`。

---

## 和大人府邸

右键桌宠或托盘点「和大人府邸 [WorkBuddy]」，一处看全家底：

- **家底**：国库总余额（实时）、今日消耗、和大人资产、累计抽成、捕鱼数量
- **胆气与官位**：颤栗值、官位、心气，一键归回原样
- **基本设置**：显示、大小、甩飞阈值、亏空阈值、**自动唤醒开关**
- **和大人日记**：主账散账一览，散账可焚（主账烧不得）

配色跟「工作中」的聊天泡泡一个调子：深底、米字、金边。

---

## 几样小玩法

- **捕鱼（一次性）**：右键「捕鱼一次：开」，把和大人甩出去飞满 2 秒，他就定身撒网——约八成网着大肥鱼，计数 +1，播完自动关。想再捕，再点一次。
- **肚兜坐牢（亏空判定）**：府邸里设个积分阈值，**当日消耗额**过了线，和大人就换肚兜坐牢形象喊「小月莫愁」（每天最多一回，0 = 不判）。这判定靠守护进程定时刷国库，守护进程关着就不灵。
- **与 DSH 老版共存**：独立 userData、独立状态目录、窗口标题带 `[WorkBuddy]`、进程带 `--pet-edition=workbuddy`，两版互不抢锁，桌面上重叠时退一个就行。

---

## 里头的家什

```
core.js            核心引擎（状态/国库/对话上下文/记忆/控制）
mcp-server.js      MCP server（Agent 反向使唤桌宠）
hedarenctl.js      命令行控制器（Skill 走这条）
install.js         一键安装/卸载
node-runtime.js    node 运行时探测（不写死版本号，跨机器通用）
start.js / start.bat / install.bat  启动与安装入口
bin/hedaren-node   运行时包装脚本（hook 每次执行时现找 node）
pet-daemon.js      守护进程（默认不起，手动启停：离线回复/账本/国库轮询）
electron-runtime.js  通用 Electron 探测/下载/纯 JS 解压
app/               Electron 窗口本体（动画/气泡/聊天/托盘/府邸）
hooks/             工作状态 hook 桥（pet-hook.js）
persona.md         和珅人格提示词
skill-template/    对话 Skill 模板
index.js / dshpet.js  原 DSH 插件源码（归档，不加载）
```

**状态目录**：`~/.workbuddy/hedaren-pet/`（`HEDAREN_PET_HOME` 可改），里头装着状态、国库、记忆、日志。多进程读写走「读-合并-写」，别手改。

**对话是怎么回的**：`chat-context` 交出人格 + 命中记忆 + 此刻心气 → WorkBuddy 当前会话模型（Agent 自己）写一句和珅腔的回复 → `reply` 写回桌宠。全程不碰任何外部大模型 API，也不要 API Key。

---

## 注意事项

- 桌宠是独立 Electron 进程，关掉 WorkBuddy 不影响它；要退，点托盘「退出桌宠」。
- `node:sqlite` 在 Node 22 是实验特性，命令都带 `--no-warnings`。
- 国库口径是 WorkBuddy **本地累计消耗**（服务端不开放余额接口），府邸与「查国库」同一个数字。

MIT License · 原作 Yukilol13 · WorkBuddy 通用版改造
