# Command Code 额度

在 **Grok Build 的状态栏**里直接看到你的 **Command Code** 套餐还剩多少——
5 小时、每周、每月三条窗口，带重置时间。

跑在你本机、不经过模型，所以**查额度不消耗额度**。

```
CC GOAT │ 5h █▎░░░░░░░░ 12% 4h27m后重置 │ 周 █▏░░░░░░░░ 11% 09-27重置 │ 月 ▋░░░░░░░░░ 6% $66.03 10-20重置
```

[English](README.md) · [核实记录](docs/FINDINGS.md)

[![Check](https://github.com/Jovan1666/grok-command-code-usage/actions/workflows/check.yml/badge.svg)](https://github.com/Jovan1666/grok-command-code-usage/actions/workflows/check.yml)

---

## 安装

```sh
grok plugin marketplace add Jovan1666/grok-command-code-usage
grok plugin install commandcode-usage
```

然后最后一步，在插件自己的目录里跑——状态栏那一行就是它装上的：

```sh
node scripts/setup.mjs
```

全程不需要你填 API key——脚本自己去找，见[凭证](#凭证)。

### 为什么装完还要跑一个 setup

Grok 的插件机制（skills / commands / agents / hooks / MCP）里没有状态栏这一项：
状态栏是**用户自己配置**里的 `[ui.status_line]`，所以最后一步是个脚本，替你写这一条设置，
写进 `~/.grok/config.toml`（设了 `GROK_HOME` 就是 `$GROK_HOME/config.toml`）。

它会先备份；发现你已经有一个别人写的状态栏时**拒绝覆盖**，要你显式加 `--force`；
`--remove` 会把它拿掉——小节回到 Grok 的默认值 `type = "disabled"`，原来那份仍留在
`.bak-*` 备份里：

| 参数 | 作用 |
|---|---|
| （不带） | 单行，每 5 分钟刷新一次 |
| `--rows 3` | 三行 |
| `--refresh 0` | 不要定时刷新（只在会话状态变化时更新） |
| `--force` | 覆盖已有的其它状态栏（会先备份成 `config.toml.bak-<时间戳>`） |
| `--print` | 只打印要写入的内容，不改任何文件 |
| `--remove` | 移除（回到 `type = "disabled"`） |

Grok 只在启动时读 `[ui.status_line]`，所以要**重启 Grok** 才生效。

Windows 上这个脚本会多写一个文件：`cc-usage.mjs` 旁边的一个小 `cc-usage.cmd`，
配置里只写这个批处理的路径、不带别的。Grok 是用 `CreateProcess` 起 `command` 的，参数里
出现绝对路径会以 `os error 123` 失败，给程序名加引号同样失败，所以只有"一条裸的可执行
路径"这一种写法活得下来——`node` 调用写在批处理里面，且配置里不加引号，所以安装路径
里带空格也照样能起。（`cc-usage.cmd` 是脚本生成的产物，不在本仓库里。）

## 显示什么

| 窗口 | 含义 | GOAT 档 |
|---|---|---|
| 5 小时 | 滚动突发上限——一次长会话掏不空整个月 | $14 |
| 每周 | 滚动 7 天上限 | $35 |
| 月度 | 计费周期内的额度 | $70 |

每条显示**已用百分比**、进度条、**重置时间**（一天内给倒计时，超过一天给日期）。
月度那条额外显示剩余金额。

颜色跟着用量走：低于 60% 绿、到 85% 黄、再高变红。（终端面板和 HTML 面板用更早的
50 / 80 分档——状态栏是那个为"余光扫一眼"调过的，所以报警更晚。）

没有滚动窗口的套餐（Provider、Enterprise）只显示余额。
没有 API 权限的套餐（Go）在状态栏里什么都不显示——不报错、也不留空位；
但你主动要终端面板时它会**如实报错**，因为那是你直接问的问题，沉默反而是错的。

## 没在用的时候它会自己藏起来

如果你配了 Command Code 却切到了别的模型，常驻的额度条就是噪音。
脚本会**逐轮**判断这个会话到底有没有走它：

1. **本地路由自己的映射** —— `cc-switch` 这类工具会把
   `ANTHROPIC_DEFAULT_OPUS_MODEL` / `..._MODEL_NAME` 成对写进环境变量，
   脚本读这对值就知道真实上游是谁。这是路由自己的配置，不是推测。
   （这条属于[推断而非实测](docs/FINDINGS.md)——万一拿不到，脚本会往下走而不是乱猜。）
2. **会话记录** —— 这一轮真实跑在哪个模型上。Grok 把它逐条记在 `updates.jsonl` 的
   `modelId` 字段里，脚本只读文件尾部，不整份扫。
3. **账号活跃度** —— 兜底，只在前两条都给不出结论时用。

拿到的真实模型名去对照 Command Code 的公开模型目录（`/provider/v1/models`，免鉴权）。
不在目录里 → 隐藏。

有些模型名天然有歧义（`claude-opus-5` 原生 Anthropic 和 Command Code 目录里都有），
这种情况**故意不猜**——用 `--model <子串>` 自己补。

## 命令

Grok 还会有一个 `/quota` 命令，打印紧凑面板。
**这个会经过模型**——它是提示词模板，要花一轮对话；状态栏才是免费的那条路，
`/quota` 是给"想让数字留在对话记录里"用的。

## 凭证

自动查找，顺序如下：

1. `COMMAND_CODE_API_KEY` / `COMMANDCODE_API_KEY` / `CMD_API_KEY`
2. 名字里含 `commandcode` 的任何环境变量
3. `~/.commandcode/auth.json`（官方 CLI 的登录态）
4. Grok 自己配置里的 Command Code provider 路由（`~/.grok/config.toml`）——直接写的
   `apiKey`，或用 `apiKeyEnv = "名字"` 指向一个环境变量

全都找不到时状态栏**直接不渲染**——它不会把错误打到你的编辑器里。
`--verbose` 会告诉你最后用的是哪个来源（key 打码）。

## 目录结构

```
plugin.json                    Grok 的插件清单（命令目录 → commands/）
commands/quota.md              /quota 命令
scripts/cc-usage.mjs           唯一实现——只有它会去碰接口
scripts/setup.mjs              把 [ui.status_line] 写进你的 config.toml
scripts/check.mjs              CI 跑的那份发布检查
docs/FINDINGS.md               核实了什么，以及官方变更时要跟着改什么
.grok-plugin/marketplace.json  市场清单
```

## 环境要求

- Node 18+（脚本用；此外什么都不需要——本仓库没有任何依赖）
- 有 API 权限的 Command Code 套餐——$1 的 Go 档没有

## 关于"按当前速度会超限"的预警

脚本会算一个速度外推。**状态栏里永远不显示它**；终端面板、`--compact`、`--md`、
`--html` 仍会打印，`--json` 里也一直有。

不让它进状态栏是有原因的：短样本外推几乎每次都会说"你要超了"——5 小时窗口刚开 25 分钟时，
一段正常的使用就能推出 140%——而一条永远亮着的警告等于没有警告。这些面板本来就是你主动
要来看的，多一行不碍事。

## 参与开发

```sh
node scripts/check.mjs          # 全部检查：渲染、隐藏逻辑、阈值、输出格式、密钥、安装器
node scripts/check.mjs --quiet  # 每个套件只打一行
```

这就是 CI 跑的那份脚本，本地过了线上就是绿的。它不联网、也不需要凭证。

**`scripts/cc-usage.mjs` 就是唯一实现**，直接改它。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
