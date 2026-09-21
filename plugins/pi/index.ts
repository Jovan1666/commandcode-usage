/**
 * Command Code 额度 —— pi 扩展
 *
 * 在编辑器下方常驻一行（也就是 pi 默认 footer 之上），显示 5 小时 / 每周 / 每月三条窗口。
 * 取数复用本插件的 cc-usage.mjs（同一份核心），扩展只负责取回来显示。
 *
 *   /ccq-bar            查看状态
 *   /ccq-bar on|off     显示 / 隐藏
 *   /ccq-bar refresh    立刻刷新
 *
 * 装法（二选一）：
 *   pi install <本目录>
 *
 * 手动装要把 index.ts 和 cc-usage.mjs 一起放过去——只拷 index.ts 的话脚本找不到，
 * widget 会静默为空：
 *   cp index.ts cc-usage.mjs ~/.pi/agent/extensions/   (再按需改扩展目录名)
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

/** pi 传进来的 TUI 句柄。只留这个，不留 ctx——见 installWidget 上面的注释。 */
interface TuiLike {
  requestRender(force?: boolean): void;
}

type WidgetFactory = (tui: TuiLike, theme: unknown) => { render(): string[]; invalidate(): void };

interface CtxLike {
  ui?: {
    setWidget(key: string, content: string[] | WidgetFactory | undefined, options?: { placement: 'aboveEditor' | 'belowEditor' }): void;
    notify?(message: string, type?: 'info' | 'warning' | 'error'): void;
  };
}

interface PiLike {
  on(event: string, handler: (_event: unknown, ctx: CtxLike) => void | Promise<void>): void;
  registerCommand(
    name: string,
    opts: { description: string; handler: (args: string, ctx: CtxLike) => void | Promise<void> },
  ): void;
}

function scriptPath(): string | null {
  // 两种布局都可能：扩展直接放在插件目录里，或放在 src/ 下。
  for (const candidate of CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
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
  let lines: string[] | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;

  // 只留 TUI 句柄，**不留在事件回调里拿到的 ctx**。
  // pi 明确禁止跨会话持有 ctx：newSession / fork / switchSession / reload 之后它就成了
  // 过期对象，再用会直接抛 "This extension ctx is stale after session replacement or reload"。
  // 组件工厂收到的 tui 属于渲染器，可以长期持有——刷新时只碰它。
  let tui: TuiLike | null = null;

  /**
   * 装或更新 widget。必须在**本次事件自己拿到的** ctx 上调用，不能拿旧的。
   * 用组件工厂（而不是字符串数组）是为了拿到 tui 句柄，之后刷新数据就不必再碰 ctx。
   */
  const installWidget = (ctx: CtxLike) => {
    if (!enabled) {
      ctx.ui?.setWidget?.(WIDGET_KEY, undefined);
      return;
    }
    ctx.ui?.setWidget?.(WIDGET_KEY, (handle) => {
      tui = handle;
      return { render: () => lines ?? [], invalidate: () => {} };
    }, { placement: 'belowEditor' });
  };

  async function refresh(): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const next = await readLines();
        if (next) lines = next;
        // 只让渲染器重画，不接触 ctx。
        tui?.requestRender();
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  function startTimer() {
    if (timer) clearInterval(timer);
    timer = setInterval(() => { void refresh(); }, REFRESH_MS);
  }

  pi.on('session_start', (_e, ctx) => {
    installWidget(ctx);
    void refresh();
    startTimer();
  });

  // 一轮对话刚结束时最该看一眼额度，所以这里补刷一次（定时器之外）。
  pi.on('agent_settled', () => {
    if (enabled) void refresh();
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
        await refresh();
        installWidget(ctx);
        startTimer();
        ctx.ui?.notify?.('Command Code 额度行已开启', 'info');
      } else if (cmd === 'off') {
        enabled = false;
        installWidget(ctx);
        if (timer) clearInterval(timer);
        timer = null;
        ctx.ui?.notify?.('Command Code 额度行已关闭', 'info');
      } else if (cmd === 'toggle') {
        enabled = !enabled;
        if (enabled) await refresh();
        installWidget(ctx);
        if (enabled) startTimer();
        else if (timer) { clearInterval(timer); timer = null; }
        ctx.ui?.notify?.(`Command Code 额度行已${enabled ? '开启' : '关闭'}`, 'info');
      } else if (cmd === 'refresh') {
        await refresh();
        ctx.ui?.notify?.('已刷新', 'info');
      } else {
        ctx.ui?.notify?.(
          scriptPath()
            ? `Command Code 额度行\n  状态: ${enabled ? '开启' : '关闭'}\n  数据: ${lines ? lines.join(' / ') : '尚未取到'}`
            : 'Command Code 额度行\n  找不到 cc-usage.mjs——插件目录可能不完整',
          'info',
        );
      }
    },
  });
}
