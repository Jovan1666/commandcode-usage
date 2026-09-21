#!/usr/bin/env node
/**
 * 给 Grok Build 装上 Command Code 额度状态栏。
 *
 * Grok 的插件机制（skills / commands / agents / hooks / MCP）不包含状态栏，
 * 状态栏是 config.toml 里的 `[ui.status_line]`，所以这一步必须落到用户自己的配置里。
 * 装完就是永久 0 token——脚本跑在本地，不经过模型。
 *
 *   node setup.mjs                 装上（单行，每 5 分钟顺带刷一次）
 *   node setup.mjs --rows 3        三行
 *   node setup.mjs --refresh 0     不要定时刷新（只在会话状态变化时更新）
 *   node setup.mjs --force         覆盖已有的其它状态栏（会先备份）
 *   node setup.mjs --print         只打印要写入的内容，不改文件
 *   node setup.mjs --remove        移除，恢复成没配状态栏的样子
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'cc-usage.mjs');

// GROK_HOME 是 Grok 官方的配置目录覆盖项。
const CONFIG_DIR = process.env.GROK_HOME || path.join(os.homedir(), '.grok');
const CONFIG = path.join(CONFIG_DIR, 'config.toml');
const SECTION = 'ui.status_line';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : (argv[i + 1] ?? true);
};
const has = (name) => argv.includes(name);

const rows = Number(flag('--rows', 1)) === 3 ? 3 : 1;
const refresh = Number(flag('--refresh', 300)) || 0;
const force = has('--force');
const remove = has('--remove');
const printOnly = has('--print');

function fail(message) {
  console.error(message);
  process.exit(1);
}

// TOML 字符串里反斜杠要转义，Windows 路径直接写会很脏；用正斜杠，Node 认。
const SCRIPT_POSIX = SCRIPT.split(path.sep).join('/');
if (SCRIPT_POSIX.includes('"')) fail(`路径里有双引号，无法安全写进 TOML：${SCRIPT_POSIX}`);

const COMMAND = `node "${SCRIPT_POSIX}" --statusline --rows ${rows}`;

/** 把窗口宽度告诉脚本；Grok 只设 COLUMNS，脚本据此自适应。 */
const SECTION_BODY = [
  'type = "command"',
  `command = ${JSON.stringify(COMMAND)}`,
  ...(refresh > 0 ? [`refresh_interval = ${refresh}`] : []),
].join('\n');

/* -------------------------------------------------------------- TOML 读写 */

/** 替换或追加一个 `[section]` 小节，其余内容原样保留。 */
function upsertSection(text, section, body) {
  const lines = text.split(/\r?\n/);
  const header = `[${section}]`;
  const start = lines.findIndex((line) => line.trim() === header);

  if (start === -1) {
    const head = text.replace(/\s*$/, '');
    return `${head}${head ? '\n\n' : ''}${header}\n${body}\n`;
  }

  // 小节到下一个 `[` 开头的行为止
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) { end = i; break; }
  }
  const next = [...lines.slice(0, start), header, ...body.split('\n'), '', ...lines.slice(end)];
  return `${next.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '')}\n`;
}

/** 取出一个 `[section]` 小节的内容（不含表头），没有就返回 null。 */
function readSection(text, section) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `[${section}]`);
  if (start === -1) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

/** 该行是不是本插件写的 command（而不是别人的）。 */
const isOurs = (body) => Boolean(body) && body.includes('cc-usage.mjs');

/* ------------------------------------------------------------------ 主流程 */

if (!fs.existsSync(SCRIPT)) {
  fail(`找不到 cc-usage.mjs（预期在 ${SCRIPT}）。插件目录不完整，请重新安装。`);
}

let config = fs.existsSync(CONFIG) ? fs.readFileSync(CONFIG, 'utf8') : '';
const existing = readSection(config, SECTION);

if (printOnly) {
  console.log(`# ${CONFIG}\n[${SECTION}]\n${SECTION_BODY}\n`);
  process.exit(0);
}

if (remove) {
  if (!existing) {
    console.log('本来就没有配状态栏。');
    process.exit(0);
  }
  if (!isOurs(existing)) {
    console.log('当前状态栏不是本插件装的，没有动它。');
    process.exit(0);
  }
  // 恢复成 Grok 的默认（disabled），而不是留一段空小节。
  const next = upsertSection(config, SECTION, 'type = "disabled"');
  fs.writeFileSync(CONFIG, next, 'utf8');
  console.log(`已移除。重启 Grok 后状态栏不再出现。\n  ${CONFIG}`);
  process.exit(0);
}

// 别人写的状态栏不能默默盖掉——那是用户的配置，不是我们的地盘。
if (existing && !isOurs(existing) && !force) {
  console.error(
    [
      `${CONFIG} 里已经有一个状态栏了，没有动它：`,
      `[${SECTION}]`,
      existing.trim(),
      '',
      '要换成 Command Code 额度的话：',
      `  node "${path.join(HERE, 'setup.mjs')}" --force    （会先备份成 config.toml.bak-<时间戳>）`,
    ].join('\n'),
  );
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
let backup = null;
if (existing) {
  backup = `${CONFIG}.bak-${stamp}`;
  fs.copyFileSync(CONFIG, backup);
}

fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.writeFileSync(CONFIG, upsertSection(config, SECTION, SECTION_BODY), 'utf8');

console.log(
  [
    isOurs(existing) ? '状态栏已更新。' : '状态栏已装好。',
    `  命令    ${COMMAND}`,
    `  写入    ${CONFIG}`,
    backup ? `  备份    ${backup}` : null,
    '',
    'Grok 只在启动时读 [ui.status_line]，所以要重启 Grok 才生效。',
    '它跑在本地、不经过模型，因此不消耗 token。',
  ]
    .filter(Boolean)
    .join('\n'),
);
