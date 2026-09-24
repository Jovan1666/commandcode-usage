#!/usr/bin/env node
/**
 * 给 Claude Code 装上 Command Code 额度状态栏。
 *
 * 为什么需要这一步：Claude Code 的插件机制不允许插件自带 statusLine
 * （插件 settings.json 只认 `agent` 和 `subagentStatusLine`），
 * 所以状态栏必须落到用户自己的 settings.json 里。装完就是永久 0 token。
 *
 *   node setup.mjs                 装上（默认三行，每 60s 顺带刷一次）
 *   node setup.mjs --merge         已经有状态栏时：两个合并，信息都保留
 *   node setup.mjs --force         已经有状态栏时：覆盖掉（先备份）
 *   node setup.mjs --rows 1        单行模式
 *   node setup.mjs --first         合并时把额度放在第一行（默认追加在下面）
 *   node setup.mjs --refresh 0     关掉定时刷新，只在事件触发时更新
 *   node setup.mjs --print         只打印将要写入的配置，不改任何文件
 *   node setup.mjs --remove        移除（合并模式下只摘掉额度那几行）
 *
 * 装的时候会把 cc-usage.mjs 复制一份到 config 目录（默认 ~/.claude/commandcode-usage.mjs），
 * 状态栏命令指向那份副本：插件缓存目录名里带版本号，升级就会换，命令里写死它等于埋一颗
 * 「某天这行安静消失」的雷。插件升级后重跑本脚本即可把副本刷新到新版本。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'cc-usage.mjs');

// CLAUDE_CONFIG_DIR 是 Claude Code 官方的配置目录覆盖项。
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const SETTINGS = path.join(CONFIG_DIR, 'settings.json');
const MERGED = path.join(CONFIG_DIR, 'commandcode-statusline.mjs');
// 记下合并前的原始状态栏命令，这样 --remove 能把用户原来的状态栏**还原**回去，
// 而不是直接删掉——把人家的配置弄丢是最不可原谅的一种 bug。
const SIDECAR = path.join(CONFIG_DIR, 'commandcode-statusline.json');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : (argv[i + 1] ?? true);
};
const has = (name) => argv.includes(name);

const rows = Number(flag('--rows', 3)) === 1 ? 1 : 3;
const refresh = Number(flag('--refresh', 60)) || 0;
const force = has('--force');
const merge = has('--merge');
const remove = has('--remove');
const printOnly = has('--print');
const oursFirst = has('--first');

function fail(message) {
  console.error(message);
  process.exit(1);
}

// 状态栏命令里不能出现版本号。插件升级会换掉缓存目录里的版本号目录（1.0.0 → 1.0.1），
// 命令里写死旧路径的结果不是报错，而是这一行安静地消失——所以装的时候把脚本复制到
// 一个不含版本的固定路径，命令指向副本。副本不会自己变新，升级后重跑本脚本即可。
const STABLE = path.join(CONFIG_DIR, 'commandcode-usage.mjs');

/** 绝对路径：状态栏脚本的 cwd 不是插件目录，相对路径会找不到自己。 */
let ourCommand = `node "${STABLE}" --statusline --rows ${rows}`;
// 合并脚本兜底用的也是副本路径；复制失败时会被改成插件目录里的原路径。
let quotaScriptPath = STABLE;

/**
 * 复制出固定路径的副本。复制失败就退回插件目录里的原路径——照样能跑，
 * 只是升级后要重跑本脚本，总比装不上强。
 */
function installStable() {
  try {
    fs.copyFileSync(SCRIPT, STABLE);
    return true;
  } catch {
    ourCommand = `node "${SCRIPT}" --statusline --rows ${rows}`;
    quotaScriptPath = SCRIPT;
    return false;
  }
}

// 这三个路径会被内联进生成的脚本；含单引号的路径在字符串里会坏掉，直接拒绝。
for (const p of [SCRIPT, MERGED, STABLE]) {
  if (p.includes("'")) fail(`路径里有单引号，无法安全生成合并脚本：${p}`);
}

let settings = {};
if (fs.existsSync(SETTINGS)) {
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  } catch (err) {
    fail(`${SETTINGS} 不是合法 JSON，先修好它再运行：${err.message}`);
  }
} else {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

if (!fs.existsSync(SCRIPT)) {
  fail(`找不到 cc-usage.mjs（预期在 ${SCRIPT}）。插件目录不完整，请重新安装。`);
}

const existing = settings.statusLine;
const existingCommand = typeof existing?.command === 'string' ? existing.command : null;
// 副本叫 commandcode-usage.mjs，不再是 cc-usage.mjs 的子串，两种名字都要认——
// 认不出来的话重跑 setup 会把副本当成"别人的状态栏"，要么拒绝安装，要么套一层合并。
const isOurs = ['cc-usage.mjs', path.basename(STABLE)].some((n) => existingCommand?.includes(n)) ?? false;
const isMerged = existingCommand?.includes(path.basename(MERGED)) ?? false;

/**
 * 合并前那个状态栏命令。
 * 已合并的优先从侧车文件读；侧车是后加的机制，老安装没有，
 * 这时候从已生成的合并脚本里反推——不然用户重装一次就卡死了。
 */
function mergedWith() {
  if (!isMerged) return existingCommand;
  try {
    const fromSidecar = JSON.parse(fs.readFileSync(SIDECAR, 'utf8')).mergedWith;
    if (fromSidecar) return fromSidecar;
  } catch { /* 侧车不存在就走反推 */ }
  try {
    // 不写正则：反斜杠在这种多层引号里很容易被吃掉，直接按引号切更稳。
    const src = fs.readFileSync(MERGED, 'utf8');
    for (const line of src.split('\n')) {
      const at = line.indexOf('run("');
      if (at === -1) continue;
      const close = line.indexOf('"),', at + 5);
      if (close === -1) continue;
      try {
        const cmd = JSON.parse(line.slice(at + 4, close + 1));
        if (!cmd.includes('cc-usage.mjs')) return cmd;
      } catch { /* 这行不是我们认识的形状，跳过 */ }
    }
  } catch { /* 读不到就认输 */ }
  return null;
}

const mergedSource = (otherCommand) => `#!/usr/bin/env node
// 由 commandcode-usage 的 setup.mjs 生成，请勿手改。
// 把已有状态栏和 Command Code 额度拼在一起。
//
// 两个脚本**并行**跑：串行的话就是两次 Node 启动串起来（实测 239ms），
// 并行只要一次多一点（约 130ms）。宿主每轮都会调用状态栏，这个差别值得。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let input = '';
try { input = fs.readFileSync(0, 'utf8'); } catch {}

// 每次运行都重新找一份额度脚本，而不是用安装那一刻的路径：插件升级会换掉缓存目录里的
// 版本号目录，写死的结果不是报错，而是这一行安静地消失。装的时候复制的那份固定路径
// 副本留作兜底，插件被卸掉也还能用。
const CACHE = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'commandcode-usage', 'commandcode-usage');
const FALLBACK = ${JSON.stringify(quotaScriptPath)};
function resolveQuotaScript() {
  try {
    const ranked = fs
      .readdirSync(CACHE, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const dir = path.join(CACHE, entry.name);
        const parts = String(entry.name).split('.').map(Number);
        const isVersion = parts.length >= 2 && parts.every((n) => Number.isInteger(n) && n >= 0);
        return { dir, version: isVersion ? parts : null, at: fs.statSync(dir).mtimeMs };
      });
    // 版本号大的优先，不是按目录时间。插件管理器复制文件时会保留时间戳，于是新版本的目录
    // 可能反而比旧的"更旧"——实测升级到 1.0.1 之后，1.0.0 的目录时间更晚，按时间排会挑回旧版本。
    ranked.sort((a, b) => {
      if (a.version && b.version) {
        for (let i = 0; i < 3; i += 1) {
          const diff = (b.version[i] || 0) - (a.version[i] || 0);
          if (diff) return diff;
        }
      } else if (Boolean(a.version) !== Boolean(b.version)) {
        return a.version ? -1 : 1; // 认得出版本号的排在前面
      }
      return b.at - a.at; // 都不是版本号（提交哈希目录之类）时才看时间
    });
    for (const { dir } of ranked) {
      const candidate = path.join(dir, 'scripts', 'cc-usage.mjs');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {}
  return FALLBACK;
}

const QUOTA_SCRIPT = resolveQuotaScript();
const QUOTA_COMMAND = QUOTA_SCRIPT && fs.existsSync(QUOTA_SCRIPT) ? 'node "' + QUOTA_SCRIPT + '" --statusline --rows ${rows}' : null;

const LOG = path.join(os.homedir(), '.claude', 'commandcode-statusline.log');
const LF = String.fromCharCode(10);
// 状态栏是渲染区，不是报错区：失败一个字节都不往 stdout/stderr 去，只写日志文件。
// 但也不能什么都不留——「这一行怎么不见了」得有地方可查。
function noteFailure(what, code, stderr) {
  try {
    const first = String(stderr || '').split(LF).find((line) => line.trim()) || '';
    const text = new Date().toISOString() + ' ' + what + ' 退出码 ' + code + (first ? ' ' + first.slice(0, 200) : '') + LF;
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 65536) fs.writeFileSync(LOG, text);
    else fs.appendFileSync(LOG, text);
  } catch {}
}

const run = (what, cmd) => new Promise((resolve) => {
  // shell:true 是为了让 "node /path/x.mjs" 这种整条命令原样跑起来，
  // 也让 Windows 上的 .cmd/.bat 包装脚本能被解析到。
  const child = spawn(cmd, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  child.on('error', (error) => { noteFailure(what, 'spawn', error.message); resolve(''); });
  child.on('close', (code) => {
    const text = out.trimEnd();
    if (!text) noteFailure(what, code, err);
    resolve(text);
  });
  child.stdin.end(input);
});

const quota = QUOTA_COMMAND ? run('额度', QUOTA_COMMAND) : Promise.resolve('');
const own = run('原状态栏', ${JSON.stringify(otherCommand)});

// Promise.all 保序，所以下面数组的顺序就是最终显示顺序。
const blocks = (await Promise.all([
  ${oursFirst ? "quota,\n  own," : "own,\n  quota,"}
])).filter(Boolean);

process.stdout.write(blocks.join(LF) + LF);
`;

function writeSettings(next) {
  fs.writeFileSync(SETTINGS, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

/* ------------------------------------------------------------------ 移除 */

if (remove) {
  if (isMerged) {
    const original = mergedWith();
    if (fs.existsSync(MERGED)) fs.rmSync(MERGED);
    if (fs.existsSync(SIDECAR)) fs.rmSync(SIDECAR);
    if (fs.existsSync(STABLE)) fs.rmSync(STABLE);
    // 把用户原来那个状态栏放回去，而不是留下一片空白。
    // 删掉别人的配置是最不可原谅的一类 bug，哪怕我们备份过。
    if (original) {
      settings.statusLine = { ...existing, command: original };
      writeSettings(settings);
      console.log(`已移除 Command Code 额度，你原来的状态栏已还原：
  ${original}`);
    } else {
      delete settings.statusLine;
      writeSettings(settings);
      console.log(`已移除。但没记录到你原来的状态栏命令，settings.json 里的 statusLine 已清空。
  备份在 ${SETTINGS}.bak-* 里可以找回。`);
    }
  } else if (isOurs) {
    delete settings.statusLine;
    writeSettings(settings);
    if (fs.existsSync(STABLE)) fs.rmSync(STABLE);
    console.log(`已移除。重启 Claude Code 后状态栏不再出现。\n  ${SETTINGS}`);
  } else {
    console.log(existing ? '当前状态栏不是本插件装的，没有动它。' : '本来就没有配状态栏。');
  }
  process.exit(0);
}

/* ------------------------------------------------------------------ 预览 */

// 合并决策要在预览之前算出来。以前这里只看 `merge && 别人的状态栏`，于是
// 「已经合并过、再跑一次 --print」会预告一个真跑时不会写下去的命令。
const mergeWithSelf = isOurs && !isMerged;
const useMerge = (merge || isMerged) && !force && !mergeWithSelf;

if (printOnly) {
  const other = useMerge ? mergedWith() : null;
  if (useMerge && !other) fail('要合并但读不到现有的状态栏命令。先确认 settings.json 里的 statusLine，或用 --force。');
  const script = other ? mergedSource(other) : null;
  console.log(
    JSON.stringify(
      {
        statusLine: {
          type: 'command',
          command: script ? `node "${MERGED}"` : ourCommand,
          ...(refresh > 0 ? { refreshInterval: refresh } : {}),
        },
        ...(script ? { __mergedScript: script } : {}),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

/* ------------------------------------------------------- 已有别人写的状态栏 */

if (existingCommand && !isOurs && !isMerged && !force && !merge) {
  console.error(
    [
      `${SETTINGS} 里已经有一个状态栏了，没有动它：`,
      `  ${existingCommand}`,
      '',
      '两个选择：',
      `  node "${path.join(HERE, 'setup.mjs')}" --merge   把额度追加到它下面，两边的信息都保留`,
      `  node "${path.join(HERE, 'setup.mjs')}" --force   换成纯额度状态栏（会先备份 settings.json）`,
      '',
      '想保留现有实现、只把额度接进去，用 --merge。',
    ].join('\n'),
  );
  process.exit(2);
}

/* ------------------------------------------------------------------ 写入 */

// （合并决策 mergeWithSelf / useMerge 在预览那一段就定了，这里不再重复。）
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
let backup = null;
const backupOnce = () => {
  if (!backup && existing) {
    backup = `${SETTINGS}.bak-${stamp}`;
    fs.copyFileSync(SETTINGS, backup);
  }
};

if (mergeWithSelf && merge && !force) {
  console.log('当前已经是本插件的状态栏，没有可合并的对象，按普通安装处理。');
}

if (useMerge) {
  // 合并模式下要跟的是「别人那个脚本」，不是我们自己的合并脚本（否则会自己套自己）。
  const other = mergedWith();
  if (!other) {
    fail('要合并但读不到现有的状态栏命令。先确认 settings.json 里的 statusLine，或用 --force。');
  }
  backupOnce();
  installStable();
  fs.writeFileSync(MERGED, mergedSource(other), 'utf8');
  fs.writeFileSync(SIDECAR, `${JSON.stringify({ mergedWith: other }, null, 2)}
`, 'utf8');
  settings.statusLine = {
    type: 'command',
    command: `node "${MERGED}"`,
    ...(refresh > 0 ? { refreshInterval: refresh } : {}),
  };
  writeSettings(settings);
  console.log(
    [
      '已合并：原有状态栏在下，Command Code 额度在上/下按 --first 决定。',
      `  合并脚本  ${MERGED}`,
      `  原状态栏  ${other}`,
      `  写入      ${SETTINGS}`,
      backup ? `  备份      ${backup}` : null,
      '',
      '重启 Claude Code（或新开一个会话）即可看到。额度部分跑在本地，不消耗 token。',
    ]
      .filter(Boolean)
      .join('\n'),
  );
} else {
  backupOnce();
  installStable();
  settings.statusLine = {
    type: 'command',
    command: ourCommand,
    ...(refresh > 0 ? { refreshInterval: refresh } : {}),
  };
  writeSettings(settings);
  if (fs.existsSync(MERGED)) fs.rmSync(MERGED);
  console.log(
    [
      isOurs ? '状态栏已更新。' : '状态栏已装好。',
      `  命令    ${ourCommand}${refresh > 0 ? `  （每 ${refresh}s 顺带刷一次）` : ''}`,
      `  写入    ${SETTINGS}`,
      backup ? `  备份    ${backup}` : null,
      '',
      '重启 Claude Code（或新开一个会话）即可看到。它跑在本地，不消耗 token。',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}
