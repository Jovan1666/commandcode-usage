/**
 * Command Code 额度 —— opencode TUI 插件
 *
 * 在右侧栏加一节，60 秒刷新一次，显示 5 小时 / 每周 / 每月三条窗口。
 * 取数复用本插件的 cc-usage.mjs，插件只负责渲染。
 *
 * 刻意用手工建元素的 API（createElement / setProp / insert）而不是 JSX：
 * 这样是纯 JS，**不需要构建步骤**，用户拿到插件目录就能用。
 * 这与 opencode 内置侧栏小节的做法一致——动态取宿主自己的 solid 运行时，
 * 让响应式更新接进宿主的渲染器。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'cc-usage.mjs');


/**
 * 找一个真的 node 来跑核心脚本。
 *
 * 关键：opencode 是 Bun 编译出来的单个二进制，**它的 process.execPath 指向 opencode
 * 自己而不是 node**。直接拿 execPath 去执行脚本，会在 opencode 里递归启动它自己然后失败
 * （实测：插件能加载、插槽能注册，但取数永远返回空）。所以先在 PATH 里找 node。
 */
function nodeBinary() {
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, exe);
    if (existsSync(candidate)) return candidate;
  }
  return /node(\.exe)?$/i.test(process.execPath) ? process.execPath : null;
}

const POLL_MS = 60_000;
const RETRY_MS = 10_000;

/** 跑一次核心脚本，拿状态栏那行文本（去掉 ANSI，由这里重新上色）。 */
function readLine() {
  return new Promise((resolve) => {
    const node = nodeBinary();
    if (!node) return resolve(null);
    execFile(node, [SCRIPT, '--statusline', '--rows', '1', '--always'], {
      timeout: 15_000,
      windowsHide: true,
      env: { ...process.env, COLUMNS: '120' },
    }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(String(stdout).replace(/\x1b\[[0-9;]*m/g, '').trim());
    });
  });
}

const plugin = async (api) => {
  const solid = await import('@opentui/solid').catch(() => null);
  if (!solid) return;
  const solidjs = await import('solid-js').catch(() => null);
  if (!solidjs || typeof solidjs.createSignal !== 'function') return;

  const [line, setLine] = solidjs.createSignal(null);
  let disposed = false;
  let timer = null;

  api.slots.register({
    order: 200,
    slots: {
      sidebar_content() {
        const box = solid.createElement('box');
        solid.setProp(box, 'flexDirection', 'column');
        // insert 接收 accessor：里面读到的 signal 变化时自动重建子节点。
        solid.insert(box, () => {
          const text = line();
          if (!text) return [];
          return text
            .split('│')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((seg) => {
              const t = solid.createElement('text');
              solid.setProp(t, 'children', seg);
              return t;
            });
        });
        return box;
      },
    },
  });

  const tick = async () => {
    if (disposed) return;
    const next = await readLine();
    if (next) setLine(next);
    api.renderer.requestRender();
    if (!disposed) timer = setTimeout(tick, next ? POLL_MS : RETRY_MS);
  };
  void tick();


  api.lifecycle.onDispose(() => {
    disposed = true;
    if (timer) clearTimeout(timer);
  });
};

export default {
  id: 'commandcode-usage',
  tui: plugin,
};
