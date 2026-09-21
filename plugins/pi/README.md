# Command Code 额度 —— pi 扩展

在编辑器下方常驻一行（pi 默认 footer 之上），显示 5 小时 / 每周 / 每月三条窗口和各自的重置时间。

```
────────────────────────────────────────────────────────────  ← 输入框
CC GOAT │ 5h ██▎░░░░░░░ 23% 3h3m后重置 │ 周 █▌░░░░░░░░ 16% 09-27重置 │ 月 ▊░░░░░░░░░ 8% $64.55
~                                                              ← pi 的默认 footer（不动它）
0.0%/1.0M (auto)                    (anthropic) claude-opus-4-8 • medium
```

跑在本地、不经过模型，所以**查额度不消耗额度**。pi 的默认 footer 原样保留——
这一行是加在它上面的 `belowEditor` widget。

## 安装

```sh
pi install git:github.com/Jovan1666/commandcode-usage
# 或从本地克隆装
pi install ./commandcode-usage/plugins/pi
```

手动装也可以，但**要把 `index.ts` 和 `src/cc-usage.mjs` 一起拷过去**——
只拷 `index.ts` 的话脚本定位不到，widget 会静默为空，不会报错：

```sh
mkdir -p ~/.pi/agent/extensions/commandcode-usage
cp plugins/pi/index.ts plugins/pi/src/cc-usage.mjs ~/.pi/agent/extensions/commandcode-usage/
```

## 命令

```
/ccq-bar             查看状态（配置 + 当前数据）
/ccq-bar on|off      显示 / 隐藏
/ccq-bar toggle      切换
/ccq-bar refresh     立刻刷新
```

## 行为

- 启动时取一次，之后每 60 秒一次，另外**每轮对话结束后补刷一次**
  （额度最值得看的时刻恰好是一轮刚结束）
- 重叠的刷新会被去重，不会叠加
- 取数失败时保留上一次的好数据，不显示错误——widget 上挂红字比旧数字更没用
- 切到不是 Command Code 的模型时整行消失（判据见仓库的 `docs/FINDINGS.md`）

## 改这份代码前必须知道的一件事

**pi 明确禁止跨会话持有 `ctx`。** 用旧 ctx 调用任何 UI 方法会直接抛：

```
Error: This extension ctx is stale after session replacement or reload.
```

所以这里的写法是刻意的：

- `setWidget` 用**组件工厂**形式，从工厂参数里拿到 `tui` 句柄并长期持有
- 刷新数据后只调 `tui.requestRender()`，**不碰 ctx**
- 每次要调 `setWidget` 时，都用**本次事件自己拿到的** ctx

最初的版本把 `ctx` 存进变量、在定时器里复用，pi 直接用上面那个错误崩掉了——
这一点在 pi 的类型定义里看不出来，只有真跑才会暴露。

## 已知边界

- pi 的 widget **不会自动截断**：`render()` 返回的行比终端宽会中断整个 TUI。
  这里靠 `cc-usage.mjs` 自己的宽度降级阶梯（`COLUMNS` 环境变量）保证不超宽。
- 非 TUI 模式（`pi -p` / `--mode json`）下 `ctx.hasUI` 为 false，widget 是空操作；
  数据仍会取，但没人看得见。

MIT 许可——见仓库根的 [LICENSE](../../LICENSE)。
