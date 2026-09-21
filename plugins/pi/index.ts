/**
 * Command Code 额度 —— pi 扩展
 *
 * 在输入框上方常驻一行，显示 5 小时 / 每周 / 每月三条窗口。
 * 取数复用本插件的 cc-usage.mjs（同一份核心），扩展只负责取回来显示。
 *
 *   /ccq-bar            查看状态
 *   /ccq-bar on|off     显示 / 隐藏
 *   /ccq-bar refresh    立刻刷新
 *
 * 装法（二选一）：
 *   pi install <本目录>                     或
 *   cp index.ts ~/.pi/agent/extensions/commandcode-usage.ts
 *
 * 跑在本地、不经过模型，所以不消耗 token。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET_KEY = 'commandcode-usage';
const REFRESH_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;

// 入口可能在扩展目录里，也可能在插件目录里，两处都找一下。
const HERE = dirname(fileURLToPath(import.meta.url));
const CANDIDATES = [join(HERE, 'cc-usage.mjs'), join(HERE, 'src', 'cc-usage.mjs')];

interface CtxLike {
  ui?: {
    setWidget(key: string, content: string[] | undefined, options?: { placement: 'aboveEditor' | 'belowEditor' }): void;
    notify?(message: string, type?: 'info' | 'warning' | 'error'): void;
  };
}

interface PiLike {
  on(event: string, handler: (_event: unknown, ctx: CtxLike) => void | Promise<void>): void;
  registerCommand(name: string, opts: { description: string; handler: (_args: string, ctx: CtxLike) => void | Promise<void> }): void;
}

/**
 * 找一个真的 node 来跑核心脚本。
 *
 * 不能用 process.execPath：宿主如果是 Bun 编译出来的单个二进制，它指向的是宿主自己
 * 而不是 node，拿去执行脚本会递归启动宿主然后失败。先在 PATH 里找 node。
 */
function nodeBinary(): string | null {
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of String(process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, exe);
    if (existsSync(candidate)) return candidate;
  }
  return /node(\.exe)?$/i.test(process.execPath) ? process.execPath : null;
}

function scriptPath(): string | null {
  // 两种布局都可能：扩展直接放在插件目录里，或放在 src/ 下。
  for (const candidate of CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** 跑一次核心脚本，拿状态栏那几行。 */
function readLines(): Promise<string[] | null> {
  const script = scriptPath();
  if (!script) return Promise.resolve(null);
  return new Promise((resolve) => {
    const node = nodeBinary();
    if (!node) return resolve(null);
    execFile(node, [script, '--statusline', '--rows', '1', '--always'], {
      timeout: FETCH_TIMEOUT_MS,
      windowsHide: true,
      env: { ...process.env, COLUMNS: '120' },
    }, (err: Error | null, stdout: string) => {
      if (err) return resolve(null);
      const text = String(stdout).replace(/\x1b\[[0-9;]*m/g, '').trim();
      resolve(text ? text.split('\n') : []);
    });
  });
}

export default function commandCodeUsage(pi: PiLike): void {
  let enabled = true;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;
  let lastLines: string[] | null = null;
  let lastCtx: CtxLike | null = null;

  const paint = (ctx: CtxLike | null) => {
    if (!ctx?.ui?.setWidget) return;
    if (!enabled || !lastLines) {
      ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: 'belowEditor' });
      return;
    }
    ctx.ui.setWidget(WIDGET_KEY, lastLines, { placement: 'belowEditor' });
  };

  async function refresh(ctx: CtxLike | null): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        lastLines = await readLines();
        paint(ctx ?? lastCtx);
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  function startTimer() {
    if (timer) clearInterval(timer);
    timer = setInterval(() => { void refresh(null); }, REFRESH_MS);
  }

  pi.on('session_start', (_e, ctx) => {
    lastCtx = ctx;
    void refresh(ctx);
    startTimer();
  });

  // 一轮对话刚结束时最该看一眼额度，所以这里补刷一次（定时器之外）。
  pi.on('agent_settled', (_e, ctx) => {
    lastCtx = ctx;
    if (enabled) void refresh(ctx);
  });

  pi.on('session_shutdown', () => {
    if (timer) clearInterval(timer);
    timer = null;
  });

  pi.registerCommand('ccq-bar', {
    description: 'Command Code 额度行：on | off | toggle | refresh | status',
    handler: async (args, ctx) => {
      const cmd = (args || '').trim().split(/\s+/)[0] || 'status';
      if (cmd === 'on') {
        enabled = true;
        await refresh(ctx);
        startTimer();
        ctx.ui?.notify?.('Command Code 额度行已开启', 'info');
      } else if (cmd === 'off') {
        enabled = false;
        paint(ctx);
        if (timer) clearInterval(timer);
        timer = null;
        ctx.ui?.notify?.('Command Code 额度行已关闭', 'info');
      } else if (cmd === 'toggle') {
        enabled = !enabled;
        if (enabled) { await refresh(ctx); startTimer(); } else { paint(ctx); if (timer) clearInterval(timer); timer = null; }
        ctx.ui?.notify?.(`Command Code 额度行已${enabled ? '开启' : '关闭'}`, 'info');
      } else if (cmd === 'refresh') {
        await refresh(ctx);
        ctx.ui?.notify?.('已刷新', 'info');
      } else {
        ctx.ui?.notify?.(
          scriptPath()
            ? `Command Code 额度行\n  状态: ${enabled ? '开启' : '关闭'}\n  数据: ${lastLines ? lastLines.join(' / ') : '尚未取到'}`
            : 'Command Code 额度行\n  找不到 cc-usage.mjs——插件目录可能不完整',
          'info',
        );
      }
    },
  });
}
