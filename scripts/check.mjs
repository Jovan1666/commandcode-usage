#!/usr/bin/env node
/**
 * 一条命令给出整个仓库的结论。
 *
 *   node scripts/check.mjs            全部检查
 *   node scripts/check.mjs --quiet    每个套件只打一行
 *
 * CI 直接调这个文件，所以本地和线上是同一套判定——不会出现"本地过了 CI 挂"。
 * 不联网、不需要真实凭证。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE = path.join(ROOT, 'core', 'cc-usage.mjs');
const QUIET = process.argv.includes('--quiet');

const suites = [];
const record = (name, fn) => suites.push({ name, fn });

/* ---------------------------------------------------------------- 工具 */

let failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

/** 跑一次 core（不联网）并返回去掉 ANSI 的 stdout。 */
function runCore(args, env = {}) {
  const r = spawnSync(process.execPath, [CORE, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
  if (r.error) throw r.error;
  return String(r.stdout || '').replace(/\x1b\[[0-9;]*m/g, '');
}

/** 显示宽度：CJK/全角算 2，其余算 1，与 core 内部口径一致。 */
function displayWidth(text) {
  let w = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    w += cp >= 0x1100 && (
      cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)
    ) ? 2 : 1;
  }
  return w;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.devdeps') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/* ------------------------------------------------------- 1. 同步一致性 */

record('sync', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'sync-core.mjs'), '--check'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const drift = out.split('\n').filter((l) => l.includes('漂移'));
  // 这是最要紧的一条：改了 core 忘了同步，各平台的副本就会各自漂移。
  assert(r.status === 0, `core 与适配器副本不一致：\n    ${drift.join('\n    ') || out.trim()}`);
  const count = out.split('\n').filter((l) => l.includes('一致')).length;
  return `${count} 个适配器与 core 一致`;
});

/* ----------------------------------------------------- 2. 状态栏渲染 */

record('statusline', () => {
  let checked = 0;

  // 按量计费套餐的输出是确定的（金额固定、没有时间），可以逐字断言。
  const provider = runCore(['--statusline', '--rows', '1', '--demo', 'provider'], { COLUMNS: '140' }).trim();
  assert(provider === 'CC Provider │ 余额 $47.66',
    `按量计费套餐应只显示余额，实际得到：${JSON.stringify(provider)}`);
  checked += 1;

  for (const scenario of ['normal', 'hot', 'max']) {
    const line = runCore(['--statusline', '--rows', '1', '--demo', scenario], { COLUMNS: '140' }).trim();
    const name = `--demo ${scenario}`;
    assert(line.startsWith('CC '), `${name}: 应以 "CC " 开头，实际 ${JSON.stringify(line.slice(0, 20))}`);
    assert(line.split('│').length === 4, `${name}: 单行模式应有 4 段（套餐名 + 三条窗口），实际 ${line.split('│').length}`);
    assert(/\d+%/.test(line), `${name}: 应含百分比`);
    assert(line.includes('重置'), `${name}: 三条窗口都该带重置时间`);
    // 绝不带 ANSI：钩子的 systemMessage 是纯文本，带上会原样显示成乱码。
    assert(!/\x1b\[/.test(runCore(['--statusline', '--rows', '1', '--demo', scenario])), `${name}: 不应输出 ANSI`);
    checked += 1;

    const three = runCore(['--statusline', '--demo', scenario], { COLUMNS: '140' }).trim();
    assert(three.split('\n').length === 3, `${name}: 三行模式应输出 3 行`);
    checked += 1;
  }

  // 宽度自适应：任何终端宽度下都不能折行（折行会让整个底部错位）。
  for (const cols of ['200', '140', '120', '110', '100', '95', '90', '80']) {
    const line = runCore(['--statusline', '--rows', '1', '--demo'], { COLUMNS: cols }).trim();
    const w = displayWidth(line);
    assert(w <= Number(cols), `COLUMNS=${cols}: 行宽 ${w} 超了`);
    assert(!line.includes('\n'), `COLUMNS=${cols}: 不该折行`);
    checked += 1;
  }

  return `${checked} 项渲染断言`;
});

/* -------------------------------------------------------- 3. 隐藏逻辑 */

record('gating', () => {
  const tmp = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'ccq-check-'));
  const write = (name, obj) => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, JSON.stringify(obj), 'utf8');
    return p.replace(/\\/g, '/');
  };
  // 目录里有的模型（取自 /provider/v1/models 的已知条目）
  const inside = write('in.jsonl', { role: 'assistant', message: { model: 'deepseek/deepseek-v4.1-flash' } });
  // 目录里没有的
  const outside = write('out.jsonl', { role: 'assistant', message: { model: 'totally-made-up-xyz' } });

  // 用 stdin 喂 transcript，才能走到逐轮判定
  const withStdin = (transcript) => {
    const r = spawnSync(process.execPath, [CORE, '--statusline', '--rows', '1'], {
      encoding: 'utf8',
      input: JSON.stringify({ session_id: 'check', transcript_path: transcript }),
      env: { ...process.env, COLUMNS: '140' },
      timeout: 30_000,
    });
    return String(r.stdout || '').replace(/\x1b\[[0-9;]*m/g, '').trim();
  };

  const shown = withStdin(inside);
  assert(shown.startsWith('CC '), `目录内的模型应显示额度，实际：${JSON.stringify(shown.slice(0, 40))}`);

  const hidden = withStdin(outside);
  assert(hidden === '', `目录外的模型应完全隐藏，实际：${JSON.stringify(hidden.slice(0, 60))}`);

  fs.rmSync(tmp, { recursive: true, force: true });
  return '目录内显示 / 目录外隐藏';
});

/* ------------------------------------------------------- 4. 阈值与钩子 */

record('threshold+hook', () => {
  const under = runCore(['--statusline', '--threshold', '70', '--demo']).trim();
  assert(under === '', `未过阈值不该有输出，实际：${JSON.stringify(under.slice(0, 40))}`);

  const over = runCore(['--statusline', '--threshold', '30', '--demo']).trim();
  assert(over.startsWith('CC '), '过了阈值应输出面板');

  // 钩子必须吐合法 JSON，且 systemMessage 是纯文本
  const hook = runCore(['--hook', '--always', '--demo']).trim();
  let parsed = null;
  try { parsed = JSON.parse(hook); } catch { /* 下面断言会报 */ }
  assert(parsed && typeof parsed.systemMessage === 'string', `钩子应输出 {"systemMessage": …}，实际：${hook.slice(0, 60)}`);
  assert(parsed && !/\x1b\[/.test(parsed.systemMessage), 'systemMessage 不能含 ANSI（会原样显示成乱码）');
  assert(parsed && !parsed.hookSpecificOutput, '钩子不该用 additionalContext——那会进模型上下文、每轮烧 token');

  return '阈值静默 + 钩子 JSON 形状';
});

/* ------------------------------------------------------------ 5. 其它输出 */

record('formats', () => {
  let n = 0;
  for (const [args, marker, name] of [
    [['--demo'], 'Command Code', '终端面板'],
    [['--md', '--demo'], '|', 'Markdown'],
    [['--compact', '--demo'], 'CC GOAT', '单行摘要'],
  ]) {
    const out = runCore(args);
    assert(out.includes(marker), `${name} 应包含 ${JSON.stringify(marker)}`);
    n += 1;
  }
  const json = runCore(['--json', '--demo']);
  let doc = null;
  try { doc = JSON.parse(json); } catch { /* 断言会报 */ }
  assert(doc && doc.plan && doc.windows && doc.monthly, '--json 应是自洽快照');
  n += 1;

  // 不联网的 demo 不该碰网络；--help 不该跑主流程
  assert(runCore(['--help']).includes('--statusline'), '--help 应列出 --statusline');
  n += 1;
  return `${n} 种输出`;
});

/* ------------------------------------------------------- 6. 全仓静态检查 */

record('static', () => {
  const files = walk(ROOT);
  let json = 0;
  let js = 0;

  for (const f of files) {
    if (f.endsWith('.json')) {
      try { JSON.parse(fs.readFileSync(f, 'utf8')); json += 1; }
      catch (err) { assert(false, `JSON 非法: ${path.relative(ROOT, f)} — ${err.message}`); }
    }
  }

  // 语法检查跳过 dsh 的旧文件（它们是别人的既成代码，由它自己的套件覆盖）
  for (const f of files) {
    if (!/\.(mjs|cjs|js)$/.test(f)) continue;
    if (f.includes(`${path.sep}dsh${path.sep}`)) continue;
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8', timeout: 20_000 });
    assert(r.status === 0, `语法错误: ${path.relative(ROOT, f)}`);
    js += 1;
  }

  return `${json} 个 JSON + ${js} 个 JS`;
});

/* -------------------------------------------------------- 7. 密钥与隐私 */

record('secrets', () => {
  // 别让 API key、本机绝对路径或邮箱被提交进去——这是要公开发布的仓库。
  const patterns = [
    [/user_[A-Za-z0-9_-]{16,}/, 'Command Code key'],
    [/sk-[A-Za-z0-9]{20,}/, 'OpenAI 风格 key'],
    [/ghp_[A-Za-z0-9]{20,}/, 'GitHub token'],
    [/github_pat_[A-Za-z0-9_]{20,}/, 'GitHub PAT'],
    [/C:[\\/]Users[\\/](?!admin[\\/]\.claude)[A-Za-z0-9._-]+/, '个人绝对路径'],
    [/[A-Za-z0-9._%+-]+@(?!example\.com|users\.noreply)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, '邮箱'],
  ];
  let scanned = 0;
  for (const f of walk(ROOT)) {
    if (/\.(png|jpg|ico|woff2?|lock)$/.test(f)) continue;
    // 本文件自己的规则里就写着这些形态，跳过它
    if (f === fileURLToPath(import.meta.url)) continue;
    const text = fs.readFileSync(f, 'utf8');
    for (const [re, label] of patterns) {
      const hit = text.match(re);
      if (hit) assert(false, `${label} 出现在 ${path.relative(ROOT, f)}: ${hit[0].slice(0, 24)}…`);
    }
    scanned += 1;
  }
  return `${scanned} 个文件已扫描`;
});

/* ------------------------------------------------------------- 8. dsh */

record('dsh', () => {
  const dsh = path.join(ROOT, 'plugins', 'dsh');
  const devdeps = path.join(dsh, '.devdeps', 'node_modules', 'react');
  if (!fs.existsSync(devdeps)) {
    return '跳过（未装 .devdeps 里的 react；见 plugins/dsh/README.md）';
  }
  const r = spawnSync(process.execPath, [path.join(dsh, 'scripts', 'verify.mjs'), '--quiet'], {
    cwd: dsh,
    encoding: 'utf8',
    timeout: 180_000,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const tail = out.trim().split('\n').slice(-3).join(' | ');
  assert(r.status === 0, `dsh 套件失败：${tail}`);
  return tail || '通过';
});

/* ------------------------------------------------------------ 执行 */

console.log('Command Code Usage — 仓库检查\n');
let failed = 0;

for (const { name, fn } of suites) {
  failures = [];
  const started = Date.now();
  let summary = '';
  try {
    summary = fn() ?? '';
  } catch (err) {
    failures.push(`套件抛错：${err instanceof Error ? err.message : String(err)}`);
  }
  const ms = Date.now() - started;

  if (failures.length === 0) {
    console.log(`${QUIET ? '' : '  ok    '}${name.padEnd(14)} ${summary}  (${ms}ms)`);
  } else {
    failed += 1;
    console.log(`${QUIET ? '' : '  FAIL  '}${name.padEnd(14)} —  (${ms}ms)`);
    for (const f of failures) console.log(`          ${f}`);
  }
}

console.log('');
if (failed > 0) {
  console.log(`${failed} 个套件失败。`);
  process.exit(1);
}
console.log(`${suites.length} 个套件全部通过。`);
