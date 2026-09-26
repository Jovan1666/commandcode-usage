---
description: Show Command Code plan usage (5-hour / weekly / monthly windows)
---

Run exactly this block (it already locates the script, so it works however the plugin was installed):

```bash
CC="${CLAUDE_PLUGIN_ROOT}/scripts/cc-usage.mjs"
if [ ! -f "$CC" ]; then
  # 兜底：从插件缓存里找（~/.claude/plugins/cache/commandcode-usage/commandcode-usage/<版本>/）。
  CC=$(find "$HOME/.claude" -maxdepth 6 -type f -name cc-usage.mjs -path '*commandcode*' -print -quit 2>/dev/null)
fi
[ -f "$CC" ] || { echo "找不到 cc-usage.mjs，插件可能未正确安装。"; exit 2; }
node "$CC" --compact
```

Show the output in a code block exactly as printed — don't reformat it, don't recalculate the
numbers, don't redraw the bars.

Then stop. The panel already says everything; add a sentence only if the user asks whether
it is enough to finish a task.
