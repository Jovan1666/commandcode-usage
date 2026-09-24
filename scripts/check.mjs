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
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE = path.join(ROOT, 'core', 'cc-usage.mjs');
const QUIET = process.argv.includes('--quiet');

// dsh 那半边是别人的既成代码，静态检查整体跳过它（它自己的套件覆盖）。
const DSH_SEGMENT = `${path.sep}dsh${path.sep}`;

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

record('gating', async () => {
  // 直接测判定函数，不跑整条流水线：整条要凭证、要联网，CI 上两样都没有。
  // 之前就是那样写的，于是本地过、CI 挂。
  const { decideRoute, normalizeModel } = await import(pathToFileURL(CORE).href);
  const catalog = ['deepseek-v4.1-flash', 'claude-opus-5', 'kimi-k2.7-code'];

  assert(normalizeModel('deepseek/deepseek-v4.1-flash') === 'deepseek-v4.1-flash', '归一化应去掉 vendor 前缀');
  assert(normalizeModel('claude-opus-5[1M]') === 'claude-opus-5', '归一化应去掉 [1M] 这类后缀');
  assert(normalizeModel('K2.7 Code') === 'k2.7-code', '归一化应把空白折成连字符');

  assert(decideRoute('deepseek/deepseek-v4.1-flash', catalog) === 'yes', '目录里有的模型 -> 在用');
  assert(decideRoute('totally-made-up-xyz', catalog) === 'no', '目录里没有 -> 不在用');
  assert(decideRoute(null, catalog) === 'unknown', '拿不到模型名 -> 未知，交给下一级判据');
  assert(decideRoute('deepseek-v4.1-flash', null) === 'unknown', '没有目录 -> 未知，不猜');

  // 裸 claude-* 名字原生 Anthropic 也有，必须回避而不是当成命中
  assert(decideRoute('claude-opus-5', catalog) === 'unknown', 'claude-* 有歧义 -> 不猜');
  assert(decideRoute('claude-opus-5', catalog, { trustedSource: true }) === 'yes',
    '来自本地路由映射的 claude-* 是确定的，应当显示');

  // 用户自己补的别名优先于目录
  assert(decideRoute('kimi-k2.7-code', catalog, { modelPatterns: ['k2.7-code'] }) === 'yes', '用户别名应命中');
  assert(decideRoute('deepseek-v4.1-flash', catalog, { modelPatterns: ['k2.7-code'] }) === 'no',
    '给了别名就按别名来，不再看目录');

  // 两种宿主的 stdin 形状不同，routeDecision 必须都认。
  // Codex 实测把 model 作为**字符串**给（"gpt-5.6-terra"），而且 transcript_path 是空的；
  // Claude Code 则给对象 { id, display_name }，真实模型要去 transcript 里找。
  const { routeDecision } = await import(pathToFileURL(CORE).href);
  // 显式传空的 env：不然结果取决于跑测试那台机器有没有设 cc-switch 的模型映射，
  // 那正是上一个版本「本地过 CI 挂」的原因。


  const codex = routeDecision(
    { model: 'gpt-5.6-terra', transcript_path: '' },
    { catalog: [...catalog, 'gpt-5.6-terra'], env: {} });
  assert(codex.decision === 'yes', 'Codex 的字符串 model 应当被认出来');

  const codexOutside = routeDecision({ model: 'gpt-5.6-terra', transcript_path: '' }, { catalog, env: {} });
  assert(codexOutside.decision === 'no', 'Codex 给的模型不在目录里就该隐藏');

  const codexNoModel = routeDecision({ transcript_path: '' }, { catalog, env: {} });
  assert(codexNoModel.decision === 'unknown', 'Codex 没给 model 时是未知，不是"不在用"');

  const claudeObj = routeDecision({ model: { id: 'claude-opus-5[1M]' }, transcript_path: '' }, { catalog, env: {} });
  assert(claudeObj.decision === 'unknown',
    'Claude Code 的对象形状不该被当成模型名——真实模型在 transcript 里');

  return '15 项判定断言';
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

record('plans', async () => {
  // 同一个仓库里有**两张套餐表**：core 的 PLANS，和 dsh 插件自己的 SUBSCRIPTION_PLANS。
  // 它们必须说同一件事——dsh 那个数还参与 capSuspect 的合理性校验，写小了会让
  // 那档用户的月度百分比整块消失。已经漂移过一次（Pro 写成 30，实际 80），
  // 所以这里加一道机器检查，而不是靠人记得同步。
  const core = fs.readFileSync(CORE, 'utf8');
  const dsh = fs.readFileSync(path.join(ROOT, 'plugins', 'dsh', 'quota.mjs'), 'utf8');

  const parseCore = () => {
    const body = core.slice(core.indexOf('const PLANS = {'), core.indexOf('};', core.indexOf('const PLANS = {')));
    const out = {};
    for (const m of body.matchAll(/'([a-z0-9-]+)':\s*\{([^}]*)\}/g)) {
      const rec = m[2];
      const monthly = /monthly:\s*(\d+|null)/.exec(rec);
      out[m[1]] = monthly && monthly[1] !== 'null' ? Number(monthly[1]) : null;
    }
    return out;
  };
  const parseDsh = () => {
    const body = dsh.slice(dsh.indexOf('const SUBSCRIPTION_PLANS = Object.freeze({'), dsh.indexOf('});', dsh.indexOf('const SUBSCRIPTION_PLANS')));
    const out = {};
    for (const m of body.matchAll(/'([a-z0-9-]+)':\s*\{([^}]*)\}/g)) {
      const mc = /monthlyCredits:\s*(\d+)/.exec(m[2]);
      out[m[1]] = mc ? Number(mc[1]) : null;
    }
    return out;
  };

  const a = parseCore();
  const b = parseDsh();
  assert(Object.keys(a).length >= 8, `core 套餐表只解析出 ${Object.keys(a).length} 条，正则可能失效了`);
  assert(Object.keys(b).length >= 7, `dsh 套餐表只解析出 ${Object.keys(b).length} 条，正则可能失效了`);

  const drift = [];
  for (const [id, coreValue] of Object.entries(a)) {
    if (!(id in b)) continue;
    if (a[id] !== b[id]) drift.push(`${id}: core=${coreValue} dsh=${b[id]}`);
  }
  assert(drift.length === 0, `两张套餐表对不上：${drift.join('；')}`);

  return `${Object.keys(a).length} 档，两表一致`;
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
    if (f.includes(DSH_SEGMENT)) continue;
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

/* ------------------------------------------- 3. Claude Code 组装脚本 */

record('installer', () => {
  let checked = 0;
  // setup.mjs 生成的合并脚本是唯一会碰到用户自己配置的东西，所以它必须做到三件事：
  //   1) 额度脚本按运行期解析——插件升级会换掉缓存目录里的版本号目录，写死就静默消失；
  //   2) 子进程失败时 stdout 一个字节都不多，用户原来那行照常显示；
  //   3) 失败原因落进日志文件，否则「这行怎么不见了」无处可查。
  const SETUP = path.join(ROOT, 'plugins', 'claude-code', 'scripts', 'setup.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-setup-'));
  const cfg = path.join(root, 'cfg');
  const home = path.join(root, 'home');
  const mergedFile = path.join(cfg, 'commandcode-statusline.mjs');
  const logFile = path.join(home, '.claude', 'commandcode-statusline.log');
  const cache = (...parts) => path.join(home, '.claude', 'plugins', 'cache', 'commandcode-usage', 'commandcode-usage', ...parts);
  const quotaStub = cache('9.9.9', 'scripts', 'cc-usage.mjs');
  const stub = (text) => `process.stdout.write(${JSON.stringify(text)} + String.fromCharCode(10));\n`;
  const put = (file, body) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  // 清掉可能存在的真实凭证，让这几项判定不依赖跑测试的人配了什么。
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    COMMAND_CODE_API_KEY: '',
    COMMANDCODE_API_KEY: '',
    CMD_API_KEY: '',
    COMMAND_CODE_API_BASE: '',
  };
  const runMerged = () => {
    const r = spawnSync(process.execPath, [mergedFile], { encoding: 'utf8', input: '{}', timeout: 20_000, env });
    return String(r.stdout || '').trim().split('\n').filter(Boolean);
  };

  try {
    fs.mkdirSync(cfg, { recursive: true });
    put(path.join(cfg, 'user-statusline.mjs'), stub('用户自己那行'));
    fs.writeFileSync(
      path.join(cfg, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: `node ${path.join(cfg, 'user-statusline.mjs')}` } }, null, 2),
    );
    const installed = spawnSync(process.execPath, [SETUP, '--merge', '--rows', '1'], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...env, CLAUDE_CONFIG_DIR: cfg },
    });
    assert(installed.status === 0, `--merge 应以 0 退出，实际 ${installed.status}: ${installed.stderr}`);
    checked += 1;

    // --print 是给人看「到底会写什么」的，所以它必须和真正写下去的一致：
    // 已合并过的状态再预览一次，也该说要写合并脚本，而不是换成额度命令。
    const preview = spawnSync(process.execPath, [SETUP, '--print', '--merge', '--rows', '1'], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...env, CLAUDE_CONFIG_DIR: cfg },
    });
    assert(preview.status === 0, `--print 应以 0 退出，实际 ${preview.status}: ${preview.stderr}`);
    const printed = JSON.parse(preview.stdout);
    assert(printed.statusLine.command.includes('commandcode-statusline.mjs'),
      `已合并状态下 --print 应预告合并脚本，实际 ${printed.statusLine.command}`);
    assert(typeof printed.__mergedScript === 'string' && printed.__mergedScript.includes('resolveQuotaScript'),
      '--print 应给出将要写入的合并脚本');
    checked += 1;

    // 1) 升级场景：安装时写死的那份脚本已经不在，缓存里只剩新版本目录
    put(quotaStub, stub('额度：新版本'));
    let lines = runMerged();
    assert(lines.length === 2, `升级后仍应是两行，实际 ${JSON.stringify(lines)}`);
    assert(lines[1] === '额度：新版本', `升级后应解析到新版本目录，实际 ${JSON.stringify(lines[1])}`);
    checked += 1;

    // 2) 额度脚本失败：用户那行照常显示，原因写进日志
    put(quotaStub, 'process.stderr.write("模拟 401");\nprocess.exit(1);\n');
    lines = runMerged();
    assert(lines.length === 1 && lines[0] === '用户自己那行', `失败时应只留用户那行，实际 ${JSON.stringify(lines)}`);
    assert(fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').includes('退出码 1'), '失败原因应写进日志文件');
    checked += 1;

    // 3) 插件整个消失：退回安装时复制的那份固定路径副本
    fs.rmSync(path.join(home, '.claude', 'plugins'), { recursive: true, force: true });
    put(path.join(cfg, 'commandcode-usage.mjs'), stub('额度：固定路径副本'));
    lines = runMerged();
    assert(lines.length === 2 && lines[1] === '额度：固定路径副本', `插件消失后应退回副本，实际 ${JSON.stringify(lines)}`);
    checked += 1;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  return `${checked} 项组装断言`;
});

/* ------------------------------------------------------------ 执行 */

console.log('Command Code Usage — 仓库检查\n');
let failed = 0;

for (const { name, fn } of suites) {
  failures = [];
  const started = Date.now();
  let summary = '';
  try {
    summary = (await fn()) ?? '';
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
