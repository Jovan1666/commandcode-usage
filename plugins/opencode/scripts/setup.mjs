#!/usr/bin/env node
/**
 * 给 opencode 装上 Command Code 额度侧栏。
 *
 * opencode 的 TUI 插件要在 `~/.config/opencode/tui.json` 里按绝对 file:// 路径登记。
 * 装完之后侧栏常驻，跑在本地、不经过模型，所以不消耗 token。
 *
 *   node setup.mjs                 装上
 *   node setup.mjs --print         只打印要写入的内容，不改文件
 *   node setup.mjs --remove        移除
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, '..', 'src', 'index.mjs');

// XDG_CONFIG_HOME 是 opencode 的配置根；Windows 上默认没有，退回 ~/.config。
const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode');
const TUI_JSON = path.join(CONFIG_DIR, 'tui.json');
const SCHEMA = 'https://opencode.ai/tui.json';

const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);

// opencode 要的是绝对 file:// URL，不能是相对路径。
const ENTRY_URL = pathToFileURL(ENTRY).href;
// 认本插件写过的记录：入口文件的路径对得上，就一定是它写的（这份仓库的目录名叫什么
// 都行，插件被搬到别处也认得出）。路径对不上时退回按目录名认，这样按旧名字装的记录
// 也还认得出来。
const SELF_PATH = fileURLToPath(ENTRY_URL);
const MARKS = ['opencode-command-code-usage', 'commandcode-usage'];

function readConfig() {
  if (!fs.existsSync(TUI_JSON)) return { $schema: SCHEMA };
  try {
    return JSON.parse(fs.readFileSync(TUI_JSON, 'utf8'));
  } catch (err) {
    console.error(`${TUI_JSON} 不是合法 JSON，先修好它再运行：${err.message}`);
    process.exit(1);
  }
}

const config = readConfig();
const plugins = Array.isArray(config.plugin) ? config.plugin.filter((p) => typeof p === 'string') : [];
const mine = (p) => {
  try {
    if (fileURLToPath(p) === SELF_PATH) return true;
  } catch { /* 不是 file:// URL，按目录名认 */ }
  return MARKS.some((mark) => p.includes(mark));
};
const already = plugins.some(mine);

if (has('--print')) {
  console.log(JSON.stringify({ ...config, $schema: SCHEMA, plugin: [...plugins.filter((p) => !mine(p)), ENTRY_URL] }, null, 2));
  process.exit(0);
}

if (!fs.existsSync(ENTRY)) {
  console.error(`找不到 ${ENTRY}。插件目录不完整，请重新安装。`);
  process.exit(1);
}

if (has('--remove')) {
  if (!already) {
    console.log('tui.json 里没有本插件的记录，没有动它。');
    process.exit(0);
  }
  const next = { ...config, plugin: plugins.filter((p) => !mine(p)) };
  // 空的 plugin 数组留着没意义，去掉更干净。
  if (!next.plugin.length) delete next.plugin;
  fs.writeFileSync(TUI_JSON, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  console.log(`已移除。重启 opencode 后侧栏不再出现。\n  ${TUI_JSON}`);
  process.exit(0);
}

fs.mkdirSync(CONFIG_DIR, { recursive: true });
// 幂等：先剔除本插件已有的记录，再追加，避免重复登记。
const next = { ...config, $schema: config.$schema || SCHEMA, plugin: [...plugins.filter((p) => !mine(p)), ENTRY_URL] };
fs.writeFileSync(TUI_JSON, `${JSON.stringify(next, null, 2)}\n`, 'utf8');

console.log(
  [
    already ? '侧栏已更新。' : '侧栏已装好。',
    `  插件    ${ENTRY_URL}`,
    `  写入    ${TUI_JSON}`,
    '',
    '重启 opencode 后右侧栏会出现「Command Code」一节，每 60 秒刷新。',
    '它跑在本地、不经过模型，因此不消耗 token。',
  ].join('\n'),
);
