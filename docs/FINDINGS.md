# 调研记录：为什么 CommandCode 在每个宿主里都得手动接

> 这份文档记录**外部事实**和**由此推出的设计约束**，不是教程。
> 每条都标了来源和核实日期。官方一旦变更，需要更新的是这份文档和 §6 列出的对应代码。
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
| **opencode** | 插件在启动时注册 provider（`commandcode` + `commandcode-claude` 两个） | 插件源码常量 / `~/.local/share/opencode/auth.json` | ✅ 插件自己就是注册方，直接知道自己注册了什么 |
| **pi** | `pi-commandcode-provider` 之类的 provider 扩展 | pi 的 OAuth 凭证 + 扩展配置 | ✅ `ctx.model.provider` 直接可用 |
| **Codex** | `config.toml` 里配 `model_providers.<id>.base_url` | 配置文件 | ✅ 插件能读配置 |
| **Grok Build** | `config.toml` 的 `[model.<id>]` 带 `base_url` | 配置文件 | ✅ 同上 |
| **DeepSeek Harness (dsh)** | `settings.yaml` 里配 provider 路由 | `apiKeyEnv` / `baseURL` | ✅ 同上 |

**共同规律**：路由信息**总是**落在配置文件或环境变量里——因为接入动作本身就是写这些地方。
所以"这一轮走没走 CommandCode"是**可判定**的，不需要猜。

---

## 2. Claude Code 的两个坑（本机实测）

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

## 4. 由此推定的判据（实现见 `core/cc-usage.mjs` 的 `routeDecision`）

按可靠性从高到低，逐一尝试：

1. **本地路由的环境变量映射**（最硬）
   `model.id` 去反查 `ANTHROPIC_DEFAULT_*_MODEL`，取配对的 `*_MODEL_NAME` 得到真实上游。
   这不是推测，是路由自己的配置。
2. **transcript 里最近一条真实消息的 `message.model`**
   （跳过 `isSidechain` 子代理和 `<synthetic>` 占位）
3. **账号用量活跃度**（兜底，账号级——在别的机器/宿主上用它也会让数字增长，所以只是兜底）
4. **`--model <子串>`** 用户手工补别名，覆盖以上全部

真实模型名拿到后对照 §3 的目录：

- 目录里**没有** → 确定没用 → 隐藏
- 目录里**有**且来自路由映射 → 确定在用 → 显示
- 目录里**有**但来自 transcript，且名字是 `claude-*` → **不猜**（原生 Anthropic 也叫这个名）
  → 退回第 3 条

---

## 5. 各宿主的常驻位（决定每个平台能做到什么形态）

| 宿主 | 有常驻位 | 机制 | 能塞自己的脚本 |
|---|---|---|---|
| **Claude Code** | ✅ | `settings.json` 的 `statusLine`，支持多行 + ANSI + `refreshInterval` | ✅ 外部命令 |
| **Grok Build** | ✅ | `[ui.status_line]` `type="command"` | ✅ 外部命令 |
| **opencode** | ✅ | 11 个官方 TUI 插槽（`sidebar_content` / `session_prompt_right` / …），SolidJS 组件 | ✅ 进程内插件 |
| **pi** | ✅ | `setWidget({ placement: "belowEditor" })` | ✅ 扩展 |
| **Codex** | ❌ | `tui.status_line` 是**封闭枚举**（31 个内置项，无外部脚本口子） | ❌ |
| **DeepSeek Harness** | ✅ | 侧边栏插槽 | ✅ 插件 |
| **ZCode** | ❌ | 无可插拔的常驻 UI 位 | ❌ |

Codex 的替代路径：`UserPromptSubmit` hook 输出 `systemMessage`（每轮自动弹一行，零 token）。
ZCode 的替代路径：只能按需调用命令（**会走模型、烧 token**）。

---

## 6. 待观察清单：官方改了什么，我们要跟着改什么

| 如果发生 | 要改的地方 |
|---|---|
| CommandCode 模型目录增删模型 | 无需改代码——目录是运行时拉的，缓存 24 小时（`~/.commandcode-usage/models.json`） |
| 模型目录接口路径或鉴权变了 | `ensureCatalog()` 里的 `/provider/v1/models` |
| 计费/额度接口（`/alpha/*`）字段改名 | `normalize()`；症状是数字变成 0 或空 |
| 官方开始提供**原生** provider（进了 models.dev） | §1 的接入方式变了，"路由信息在哪"随之变，`routeDecision` 要跟着调整 |
| Claude Code 的 statusLine JSON 增加了 provider 字段 | 可去掉 §4 的第 2、3 条兜底，直接读字段 |
| Claude Code 插件能自带 `statusLine` | 安装可以少一步（现在必须改用户 `settings.json`） |
| Codex 的 `status_line` 开放外部命令 | Codex 也能做常驻，不必用 hook 兜底 |
| 套餐档位/额度调整 | `PLANS` 表（`core/cc-usage.mjs` 顶部），来源是官方定价页 |
| 计费周期字段变化 | `activityOf()` 里的请求数对比（跨周期归零已按"变了就算活跃"处理） |

---

## 7. 这份记录里，哪些是实测、哪些是推断

**实测**（本机或具体接口上直接验证过）
- models.dev 不含 commandcode（`curl` 结果）
- CommandCode 模型目录 71 个、免鉴权（`curl` 结果）
- `model.id` 是本地别名、transcript 里是真实模型名（两份真实捕获对照）
- 环境变量映射成对出现（读 `~/.claude/settings.json`）
- 各宿主常驻位的有无与机制（读宿主的二进制 / 文档 / 源码）
- Windows 上 Node 启动耗时构成、Git Bash 29ms 地板（本机 25–30 次取中位数）

**推断**（机制清楚，但没单独跑一轮验证）
- statusLine 子进程能否继承 `ANTHROPIC_DEFAULT_*_MODEL_NAME`。
  机制上讲得通（statusLine 是宿主子进程，官方文档明确 `env` 设置对子进程生效），
  但没在真实的 statusLine 调用里 dump 过环境变量。
  **兜底方案**：拿不到就退到 transcript，功能不受影响。
