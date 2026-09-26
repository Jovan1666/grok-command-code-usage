# 调研记录：为什么 CommandCode 在每个宿主里都得手动接

> 这份文档记录**外部事实**和**由此推出的设计约束**，不是教程。
> 每条都标了来源和核实日期。官方一旦变更，需要更新的是这份文档和 §6 列出的对应代码。
>
> 本文是共享实现（`scripts/cc-usage.mjs`）的调研记录，拆自 `Jovan1666/commandcode-usage`。
>
> 最后核实：2026-09-21

---

## 1. CommandCode 不是"原生可用"的 provider

这是整件事的起点，也是一开始最容易判断错的地方。

**核实结果**：`models.dev`（opencode、pi 等宿主共用的模型目录，222 个 provider）里
**没有 commandcode**。它收录的是模型厂商本身（`deepseek`、`zai`、`moonshotai`、
`anthropic`、`openai`）和少数一方订阅产品（`opencode`、`opencode-go`），
但不收录 CommandCode 这类转售订阅。

```
含 command 的 provider: []          ← 一个都没有
含 opencode 的 provider: ['opencode', 'opencode-go']
providers 总数: 222
```

（核实方式：`curl -s https://models.dev/api.json`）

**推论**：宿主不会"自带" CommandCode。用户必须自己在每个宿主里把它接上，
而**接入方式就是路由配置**——这正是本插件判断"这一轮在不在用它"的信息来源。

### 1.1 各宿主的接入方式，以及路由信息存在哪

| 宿主 | 接入方式 | 路由信息落在哪 | 能否被插件读到 |
|---|---|---|---|
| **Claude Code** | 改 `ANTHROPIC_BASE_URL` 指向代理，再用别名把模型名映射过去 | `settings.json` 的 `env`：`ANTHROPIC_DEFAULT_<档位>_MODEL`（本地假名）与 `..._MODEL_NAME`（真实上游）成对出现 | ✅ 这两个变量 statusLine 子进程能继承到 |
| **opencode** | provider 由用户配置（社区插件注册 `commandcode` / `commandcode-claude` 两个） | `~/.config/opencode/opencode.json(c)` 的 provider 段；key 也可能在 `~/.local/share/opencode/auth.json` | ✅ 本仓库的适配器不读 provider，key 走 core 的通用凭证发现 |
| **pi** | `pi-commandcode-provider` 之类的 provider 扩展 | pi 的 provider 配置（`~/.pi/agent/settings.json`）或环境变量 | ✅ key 走 core 的通用凭证发现；本仓库的扩展不读 `ctx.model` |
| **Codex** | `config.toml` 里配 `model_providers.<id>.base_url` | 配置文件 | ✅ 插件能读配置 |
| **Grok Build** | `config.toml` 的 `[model.<id>]` 带 `base_url` | 配置文件 | ✅ 同上 |
| **DeepSeek Harness (dsh)** | `settings.yaml` 里配 provider 路由 | `apiKeyEnv` / `baseURL` | ✅ 同上 |

**共同规律**：路由信息**总是**落在配置文件或环境变量里——因为接入动作本身就是写这些地方。
所以"这一轮走没走 CommandCode"是**可判定**的，不需要猜。

---

## 2. Claude Code 的三个坑（本机实测）

### 2.1 statusLine 的 `model.id` 是**本地别名**，不是真实上游

本机（走本地路由）实测捕获：

```json
// statusLine 通过 stdin 收到的
"model": { "id": "claude-opus-5[1M]", "display_name": "Opus 5" }

// 但 transcript 里记的上游真实模型是
{"role":"assistant","message":{"model":"deepseek/deepseek-v4.1-flash"}}
```

来源：`~/.claude/settings.json` 的 env 块

```
ANTHROPIC_DEFAULT_OPUS_MODEL      = claude-opus-5[1M]
ANTHROPIC_DEFAULT_OPUS_MODEL_NAME = deepseek/deepseek-v4.1-flash
```

**结论**：拿 `model.id` 去匹配模型目录**必然失败**，因为它是路由伪造的别名。

### 2.2 statusLine 的 JSON 里**没有** provider / base_url / endpoint 字段

官方字段表逐条核对过（https://code.claude.com/docs/en/statusline）：
`model` / `workspace` / `cost` / `context_window` / `rate_limits` / `prompt_cache` /
`session_id` / `transcript_path` … 全是会话状态，**没有任何一个字段描述请求发去了哪**。

另外：`rate_limits` 只对 claude.ai 一方订阅出现，第三方套餐**永远不会有**——
所以"顺手拿官方额度字段"这条路对 CommandCode 是死的。

### 2.3 `context_window` 是**账本**，不是自动压缩的预算（2026-09-21 验证）

同一次会话里两处同时抓：`context_window.context_window_size` 报 **1,000,000**
（settings.json 里设了 `contextWindowTokens`），而自动压缩实际在 **约 18.8 万** token 处 fire。

| 上下文（transcript 里的输入 token） | 状态栏 `📊` 那格 | 自动压缩 |
|---|---|---|
| 61,510 | 6% | 未触发 |
| 158,194 | **16%** | 未触发 |
| **188,166** | ~19% | **fire**（`trigger=auto`，压完剩 34,267） |

158,194 对应 16% ⇒ 那个百分比的分母是**账本窗口（100 万）**，不是压缩点：
**压缩发生在该数字约 19% 的时候**。拿它估"还剩多少余量"会严重高估。

`autoCompactWindow` 改不动它。同一天四次对照，压缩点分别是 187,946 / 188,166 / 188,262
（不设）与 187,779（`autoCompactWindow = 100000`）——设定值差一半，压缩点纹丝不动
（`CLAUDE_CODE_AUTO_COMPACT_WINDOW` 同样无效）。真正生效的窗口约 20 万，
与 `.claude.json` 里的 GrowthBook 缓存 `tengu_hawthorn_window = 200000` 吻合。

两点方法上的收获：

- 判"压没压"要看 transcript 里的 `compact_boundary` 事件（`compactMetadata.trigger` 与
  `preTokens`），**别读界面措辞**——底栏那行百分比在 tmux 抓屏里经常根本不渲染，
  照它推断会得出完全相反的结论。
- 这是"本机 + 本机这条代理路由"的实测。报出的模型名与上游真实模型不同时（见 §2.1），
  生效窗口跟哪个走尚无结论。

---

## 3. 模型目录：能拉到，但不能只靠它

**事实**：`GET https://api.commandcode.ai/provider/v1/models` **免鉴权可匿名访问**，
返回 71 个模型，`owned_by: "command-code"`。核实日期 2026-09-21。

```
claude-sonnet-5 | claude-sonnet-4-6 | claude-fable-5-1 | claude-opus-5 | claude-opus-4-8
gpt-5.6-sol | gpt-5.6-terra | gpt-5.6-luna | gpt-5.5 | gpt-5.4 | gpt-5.3-codex
deepseek-v4-pro | deepseek-v4-flash | deepseek-v4.1-flash
...
```

**为什么不能只靠它**：拿真实的 transcript 模型名去比对，**精确命中率只有约 36%**：

| transcript 里的名字 | 命中 |
|---|---|
| `deepseek/deepseek-v4.1-flash` | ✅ |
| `claude-opus-4-8` | ✅ |
| `xiaomi/mimo-v2.5-pro` | ✅ |
| `glm-5.2` | ❌ 目录里是 `zai-org/GLM-5.2` |
| `K2.7 Code` | ❌ 目录里是 `moonshotai/Kimi-K2.7-Code` |
| `K3` | ❌ 目录里是 `moonshotai/Kimi-K3` |

而且**同名不同源**：同一个模型名 `glm-5.2` 在同一份会话记录里被两种后端服务过
（`message.id` 前缀分别是 `chatcmpl-*` 和 `cht000d…@dx…`）。
→ **模型名 ≠ provider**，名字匹配只能当辅助。

---

## 4. 由此推定的判据（实现见 `scripts/cc-usage.mjs` 的 `routeDecision`）

按可靠性从高到低，逐一尝试：

1. **本地路由的环境变量映射**（最硬）
   `model.id` 去反查 `ANTHROPIC_DEFAULT_*_MODEL`，取配对的 `*_MODEL_NAME` 得到真实上游。
   这不是推测，是路由自己的配置。
2. **宿主直接给的模型名**（`model` 是字符串时）。Codex 的钩子就是这样，而且它给的
   直接是真实模型名——这条对 Codex 是必需的，因为它的 `transcript_path` 是空的（见 §5.1）。
3. **transcript 里最近一条真实消息的 `message.model`**
   （跳过 `isSidechain` 子代理和 `<synthetic>` 占位）
4. **账号用量活跃度**（兜底，账号级——在别的机器/宿主上用它也会让数字增长，所以只是兜底）
5. **`--model <子串>`** 用户手工补别名，覆盖以上全部

真实模型名拿到后对照 §3 的目录：

- 目录里**没有** → 确定没用 → 隐藏
- 目录里**有**且来自路由映射 → 确定在用 → 显示
- 目录里**有**但来自 transcript，且名字是 `claude-*` → **不猜**（原生 Anthropic 也叫这个名）
  → 退回第 4 条（账号用量活跃度）

---

## 5. 各宿主的常驻位（决定每个平台能做到什么形态）

| 宿主 | 有常驻位 | 机制 | 能塞自己的脚本 |
|---|---|---|---|
| **Claude Code** | ✅ | `settings.json` 的 `statusLine`，支持多行 + ANSI + `refreshInterval` | ✅ 外部命令 |
| **Grok Build** | ✅ | `[ui.status_line]` `type="command"`（**已抓屏确认**；Windows 上要多一层 `.cmd`，见 §5.2） | ✅ 外部命令 |
| **opencode** | ✅ | 11 个官方 TUI 插槽（`sidebar_content` / `session_prompt_right` / …），SolidJS 组件 | ✅ 进程内插件 |
| **pi** | ✅ | `setWidget` 的组件工厂重载 + `placement: "belowEditor"`（**已抓屏确认**） | ✅ 扩展 |
| **Codex** | ❌ | `tui.status_line` 是**封闭枚举**（31 个内置项，无外部脚本口子） | ❌ |
| | | 替代：`UserPromptSubmit` 钩子每轮弹一行（**已实测可触发**，见 §5.1） | ✅ 钩子 |
| **DeepSeek Harness** | ✅ | 侧边栏插槽（**已抓屏确认**，位置在「设置」上方） | ✅ 插件 |
| **ZCode** | ❌ | 无可插拔的常驻 UI 位 | ❌ |

Codex 的替代路径：`UserPromptSubmit` hook 输出 `systemMessage`（每轮自动弹一行，零 token）。
ZCode 的替代路径：只能按需调用命令（**会走模型、烧 token**）。

---

### 5.1 Codex 钩子的实测细节（2026-09-21 验证）

`codex exec` 端到端跑通，钩子确实触发了。四条只靠读文档得不出来的结论：

**① 必须用完整的 MatcherGroup 嵌套形状。**

```toml
# ✅ 能触发
hooks.UserPromptSubmit = [{ matcher = ".*", hooks = [{ type = "command", command = "node …" }] }]

# ❌ 配置能加载、但不会触发
hooks.UserPromptSubmit = [{ command = "node …" }]
```

扁平写法 serde 是接受的（`codex doctor` 也报配置正常），但不会被注册成真正的钩子组。
**只看"配置能不能加载"会得出错误结论**——这一点值得单独记下来。

**② 钩子需要信任。** 二进制里有 `HookStateToml { enabled, trusted_hash }`，
并且存在 `--dangerously-bypass-hook-trust` 这个 flag——两者一起证实了信任是硬门槛。
插件市场安装时 Codex 会提示授权；绕过只用于测试。

**③ 钩子 stdin 的字段与 Claude Code 不同。**

| 字段 | Codex 实测 | 影响 |
|---|---|---|
| `model` | `"gpt-5.6-terra"`（**字符串**） | 直接就是真实模型名，比 Claude Code 的本地别名干净 |
| `transcript_path` | 存在但**为空** | 走不了"读会话记录"那条判据 |
| `session_id` / `cwd` / `turn_id` / `permission_mode` / `prompt` | 都有 | — |

所以判据里必须专门认「`model` 是字符串」这种形状，否则 Codex 会永远判成"未知"
（本仓库的 `routeDecision` 就是这么修的）。

**④ `codex exec` 会读 stdin。** 非交互调用时 stdin 不关会一直挂住
（输出停在 `Reading additional input from stdin...`），表现为超时而不是报错。
自动化里记得 `< /dev/null`。

---

### 5.2 Grok 在 Windows 上起不动"带绝对路径参数"的命令（2026-09-21 验证）

Grok 的状态栏命令在 POSIX 上是交给 `sh -c` 跑的，Windows 上没有 sh。但**失败原因不是没有 sh**：

```
[status line: could not start the script: 文件名、目录名或卷标语法不正确。 (os error 123)]
```

`os error 123` 是 `ERROR_INVALID_NAME`，从 CreateProcess 出来的。先用 `grok --cwd <真实
Windows 路径>` 把"工作目录是 POSIX 路径"这个变量排掉，再逐个变量对测（grok 1.0.30）：

| command 写法 | 结果 |
|---|---|
| `C:/Windows/System32/hostname.exe` | ✅ 渲染出主机名 |
| `C:/Windows/System32/cmd.exe /c echo HIB` | ✅ 渲染出 `HIB` |
| `"C:/Windows/System32/hostname.exe"` | ❌ os error 123 |
| `D:/…/node.exe --version` | ✅ |
| `C:/Windows/System32/cmd.exe /c echo a b c d e` | ✅ |
| `C:/Windows/System32/cmd.exe /c echo a:b` | ✅ |
| `…/Temp/sp ace/cc-usage.cmd`（**路径含空格，不加引号**） | ✅ 渲染出额度行 |
| `"…/Temp/sp ace/cc-usage.cmd"`（同一条路径加上引号） | ❌ os error 123 |
| `C:/Windows/System32/cmd.exe /c echo C:/Windows/Temp` | ❌ os error 123 |
| `node C:/…/cc-usage.mjs --statusline --rows 1` | ❌ os error 123 |
| `D:/…/node.exe C:/…/cc-usage.mjs --statusline --rows 1` | ❌ os error 123 |

四条结论，都是实测：

1. **Grok 先拿整条 `command` 当一个路径试**，是存在的文件就直接执行。所以空格不是
   问题：`…/sp ace/cc-usage.cmd` 这种裸写照样跑起来。
2. 不是路径，才按空白切成"程序 + 参数"。程序名可以是裸的绝对路径；但**参数里出现盘符
   绝对路径**（正反斜杠一样）就 123。相对参数没事，多个普通参数没事，单个冒号也没事。
3. **加引号一定 123**——引号成了路径的一部分，整条既不是合法路径、切出来的程序名也非法。
   官方文档那句"路径含空格就照 prompt 里那样加引号"在 Windows 上不成立，含空格的路径
   **不加引号反而是对的**。
4. 所以 Windows 上 `command` 写**一条不加引号的裸路径**最稳，哪怕路径里有空格。

做法：`setup.mjs` 在 Windows 上生成一个 `cc-usage.cmd` 放在 `cc-usage.mjs` 旁边，
`config.toml` 里只写这个批处理的路径，node 调用写在批处理内部、用 `%~dp0` 定位脚本。
这样 `--rows` 之类的参数照常生效，插件目录被搬走也不用重装。

写批处理时踩到的两个坑，都写进生成器里了：

- **批处理必须纯 ASCII。** cmd.exe 用 OEM 代码页读它，一句 UTF-8 中文 `rem` 会变成它要去
  执行的命令，整行状态栏消失（第一次实测就是这么挂的）。
- **不要在 `( … )` 块里 `echo %PATH%`。** PATH 里的 `Program Files (x86)`、NVIDIA 目录
  带括号，会把块提前闭合，报 `\NVIDIA was unexpected at this time.`。诊断代码自己把
  包装搞崩过一次。

要区分开的是：**路径里有空格不是问题，引号才是。** 这条一开始判断反了，是最后补测才
纠正过来的——Grok 既然先拿整条命令当路径试，一个带空格的裸路径本来就是合法路径。所以
`setup.mjs` 只写一条不加引号的裸路径，不需要对安装位置提任何要求。

## 6. 待观察清单：官方改了什么，我们要跟着改什么

| 如果发生 | 要改的地方 |
|---|---|
| CommandCode 模型目录增删模型 | 无需改代码——目录是运行时拉的，缓存 24 小时（`~/.commandcode-usage/models.json`） |
| 模型目录接口路径或鉴权变了 | `ensureCatalog()` 里的 `/provider/v1/models` |
| 计费/额度接口（`/alpha/*`）字段改名 | `normalize()`；症状是数字变成 0 或空 |
| 官方开始提供**原生** provider（进了 models.dev） | §1 的接入方式变了，"路由信息在哪"随之变，`routeDecision` 要跟着调整 |
| Claude Code 的 statusLine JSON 增加了 provider 字段 | 可去掉 §4 的第 2、3 条兜底，直接读字段 |
| Claude Code 插件能自带 `statusLine` | 安装可以少一步（现在必须改用户 `settings.json`） |
| Codex 的 `status_line` 开放外部命令 | Codex 也能做常驻，不必用 hook 兜底（现在只能每轮弹一行） |
| 套餐档位/额度调整 | `PLANS` 表（`scripts/cc-usage.mjs` 顶部），来源是官方定价页 |
| 计费周期字段变化 | `activityOf()` 里的请求数对比（跨周期归零已按"变了就算活跃"处理） |
| Claude Code 让 `context_window` 反映压缩预算，或 `autoCompactWindow` 开始生效 | §2.3 的结论作废；那时"离压缩还有多少"可以直接读字段 |

---

## 7. 这份记录里，哪些是实测、哪些是推断

**实测**（本机或具体接口上直接验证过）
- models.dev 不含 commandcode（`curl` 结果）
- CommandCode 模型目录 71 个、免鉴权（`curl` 结果）
- `model.id` 是本地别名、transcript 里是真实模型名（两份真实捕获对照）
- 环境变量映射成对出现（读 `~/.claude/settings.json`）
- 各宿主常驻位的有无与机制（读宿主的二进制 / 文档 / 源码）
- Windows 上 Node 启动耗时构成、Git Bash 29ms 地板（本机 25–30 次取中位数）

**实测（续）**
- Codex 的 `UserPromptSubmit` 钩子确实会触发；必须用嵌套的 MatcherGroup 形状，
  扁平形状配置能加载但不生效（见 §5.1）
- Codex 钩子的 stdin 给 `model` 字符串、`transcript_path` 为空
- **pi 的 widget 真的渲染出来了**（tmux 抓屏确认，位置在输入框与默认 footer 之间）
- pi 的扩展 API 与官方类型逐条对上：入口 `ExtensionFactory`、
  `setWidget` 的组件工厂重载、`WidgetPlacement`、`session_start`/`agent_settled`/`session_shutdown`
- **dsh 的卡片真的渲染出来了**（Playwright 抓屏确认，位置在侧栏「设置」上方），
  数字与本仓库 core 完全一致
- Claude Code 的 `context_window`（账本，本机 100 万）与自动压缩的实际触发点
  （约 18.8 万）差五倍；`autoCompactWindow` 是空操作（见 §2.3）

**实测踩到的坑：dsh 插件的版本门槛很硬，而且症状具有误导性**

本机原来装的是 **dsh `0.1.1-rc.2`**，而插件要求 `^0.1.5-rc.1`。启动时直接崩：

```
Error: failed to apply loader entry commandcode-quota:
Cannot read properties of undefined (reading 'register')
    at plugins/dsh/index.js:385
```

`ctx.connection.fetch` 在那个版本里根本不存在，于是 `.register` 读到了 undefined。

两点值得记：

1. **插件的 141 项离线校验全过，却掩盖了这个不兼容**——那些校验不需要 dsh 运行。
   "测试全绿"和"集成能用"是两件事。
2. **版本要求写在 README 的徽章和要求段里，很容易被忽略**。装之前先跑 `dsh --version`
   对一下，比看报错快。升到 `0.1.5-rc.2` 后一切正常。

**实测踩到的坑：pi 禁止跨会话持有 ctx**

用旧 `ctx` 调任何 UI 方法会抛
`This extension ctx is stale after session replacement or reload`——**这一点在类型定义里看不出来，
只有真跑才会暴露**。正确写法是用 `setWidget` 的组件工厂形式拿 `tui` 句柄长期持有，
刷新时只调 `tui.requestRender()`，绝不碰 ctx。

**推断**（机制清楚，但没单独跑一轮验证）
- statusLine 子进程能否继承 `ANTHROPIC_DEFAULT_*_MODEL_NAME`。
  机制上讲得通（statusLine 是宿主子进程，官方文档明确 `env` 设置对子进程生效），
  但没在真实的 statusLine 调用里 dump 过环境变量。
  **兜底方案**：拿不到就退到 transcript，功能不受影响。

**决定：dsh 继续不共用 core**（2026-09-21 复核，非疏漏）

`plugins/dsh/quota.mjs` 是一个自成一体的数据层：自带凭据发现、端点表、套餐表、
`CLI_VERSION`，以及被 `client.js` / `index.js` / `cli/` 依赖的那套导出契约。
core 那边是两千行的状态栏／路由引擎，导出（`collectUsage` / `normalize` /
`routeDecision` / `statuslineMode` …）与 dsh 需要的东西对不上。硬换过去要重写
宿主半边的契约，换来的只是"少一个维护点"；而最容易漂移的那部分——两张套餐表——
已经由 `plans` 套件逐档比对（`scripts/check.mjs`）。

会推翻这个决定的条件：core 抽出 dsh 也用得上的**数据层**（凭据 + 额度窗口），
而不是现在这个"状态栏引擎"；或者 dsh 自己那套离线校验不再是它的契约。
