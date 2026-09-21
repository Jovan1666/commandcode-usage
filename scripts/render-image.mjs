#!/usr/bin/env node
/**
 * 把状态栏的实际输出渲染成一张可截图的 HTML。
 *
 *   node scripts/render-image.mjs            写到 docs/images/_statusline.html
 *   node scripts/render-image.mjs --out x.html
 *
 * 为什么要有这个：README 里唯一值得配图的是状态栏**带颜色的多行版式**，
 * 而颜色是代码块表达不了的。把它做成脚本而不是一次性转换，是为了版式一变
 * 就能重新生成——dsh 那边的截图当初就是手搓的，后来差点没法复现。
 *
 * 截图（Playwright，本机已装）：
 *   browser_resize 900x400 → 打开这个 HTML → 截图 → **肉眼看一眼**再提交。
 * 提交 PNG，不提交这个 HTML。
 *
 * 数据一律用 --demo（内置账号是 demo-user / demo@example.com，确定性、不联网），
 * 所以图里不会出现真实账号信息。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE = path.join(ROOT, 'core', 'cc-usage.mjs');
const outIndex = process.argv.indexOf('--out');
const OUT = outIndex === -1
  ? path.join(ROOT, 'docs', 'images', '_statusline.html')
  : path.resolve(process.argv[outIndex + 1]);

/** 跑一次 core，拿到带 ANSI 的原始输出。 */
function statusline(scenario, cols) {
  return execFileSync(process.execPath, [CORE, '--statusline', '--rows', '3', '--demo', scenario], {
    encoding: 'utf8',
    env: { ...process.env, COLUMNS: String(cols), FORCE_COLOR: '1' },
  }).replace(/\n+$/, '');
}

// core 的 makeColors() 只会产出这几个码，所以一个简单映射就够，不需要完整的 ANSI 解析器。
const CLASS = { 1: 'a1', 2: 'a2', 31: 'a31', 32: 'a32', 33: 'a33', 34: 'a34', 35: 'a35', 36: 'a36', 90: 'a90' };

function ansiToHtml(text) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let out = '';
  let open = [];
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    out += esc(text.slice(last, m.index));
    last = m.index + m[0].length;
    const code = Number(m[1] || '0');
    if (code === 0) {
      out += '</span>'.repeat(open.length);
      open = [];
    } else if (CLASS[code]) {
      out += `<span class="${CLASS[code]}">`;
      open.push(code);
    }
  }
  out += esc(text.slice(last));
  out += '</span>'.repeat(open.length);
  return out;
}

const FRAMES = [
  { scenario: 'normal', caption: '用量正常' },
  { scenario: 'hot', caption: '用量吃紧（同样三行，颜色自己变）' },
];

const blocks = FRAMES.map(({ scenario, caption }) => {
  const body = ansiToHtml(statusline(scenario, 100));
  return `<section><h2>${caption}</h2><pre>${body}</pre></section>`;
}).join('\n');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `<!doctype html><meta charset="utf-8">
<title>Command Code status line</title>
<style>
  /* 只画一个中性的终端外壳：背景 + 等宽字。不画任何宿主的 logo 或界面，
     免得把"脚本的输出"伪装成"某个客户端的截图"。 */
  :root {
    --bg:#0b0d12; --fg:#d7dae0; --track:#3d4456;
    --green:#4ec97a; --yellow:#e6b445; --red:#e5534b; --gray:#8b93a7;
  }
  body { margin:0; padding:22px; background:var(--bg); color:var(--fg); }
  h2 { font:600 11px/1 system-ui,sans-serif; color:var(--gray); margin:0 0 7px;
       text-transform:uppercase; letter-spacing:.08em; }
  section { margin-bottom:18px; }
  pre {
    margin:0; padding:10px 13px; background:#12151c; border:1px solid #222732; border-radius:7px;
    /* 方块进度条必须每格严格 1ch 宽，否则会错位/粘连 */
    font-family:"Cascadia Mono","Consolas","Sarasa Mono SC","Microsoft YaHei Mono",monospace;
    font-size:13px; line-height:1.45; white-space:pre; font-variant-ligatures:none;
  }
  .a1{font-weight:700}
  /* [2m 是「降亮度」，不是「变透明」——用显式颜色，别用 opacity，
     否则 ░ 在深色底上会消失，整条进度条读起来像满格 */
  .a2{color:var(--track)}
  .a31{color:var(--red)} .a32{color:var(--green)} .a33{color:var(--yellow)}
  .a34{color:#5b9bff} .a35{color:#c678dd} .a36{color:#4dc4d4} .a90{color:var(--gray)}
</style>
${blocks}
`, 'utf8');

console.log(`已写入 ${OUT}`);
console.log('接下来用 Playwright 截图（900x400, fullPage, scale=device），然后肉眼看一眼再提交。');
