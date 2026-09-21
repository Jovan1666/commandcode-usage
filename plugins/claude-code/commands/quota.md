---
description: Show Command Code plan usage (5-hour / weekly / monthly windows)
---

Run exactly this block (it already locates the script, so it works however the plugin was installed):

```bash
CC="${CLAUDE_PLUGIN_ROOT}/scripts/cc-usage.mjs"
if [ ! -f "$CC" ]; then
  for d in "$HOME/.claude" "$HOME/.codex" "$HOME/.grok" "$HOME/.zcode" "$HOME/.dsh"; do
    CC=$(find "$d" -maxdepth 6 -type f -name cc-usage.mjs -path '*commandcode*' -print -quit 2>/dev/null)
    [ -n "$CC" ] && break
  done
fi
[ -f "$CC" ] || { echo "找不到 cc-usage.mjs，插件可能未正确安装。"; exit 2; }
node "$CC" --compact
```

Show the output in a code block exactly as printed — don't reformat it, don't recalculate the
numbers, don't redraw the bars.

Then stop. The panel already says everything; add a sentence only if the user asks whether
it is enough to finish a task.
