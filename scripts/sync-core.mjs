#!/usr/bin/env node
/**
 * 把 core/cc-usage.mjs 同步到各平台适配器里。
 *
 * core 是唯一维护点；适配器里的副本是产物，不手改。
 * 这样每个平台的仓库/目录都是自包含的（用户不用装 npm 包），
 * 同时修 bug 只需要改一处。
 *
 *   node scripts/sync-core.mjs          同步
 *   node scripts/sync-core.mjs --check  只检查是否一致（CI 用，不一致就非零退出）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'core', 'cc-usage.mjs');

// 每个适配器把副本放在哪。新增平台时在这里加一行。
const TARGETS = [
  'plugins/claude-code/scripts/cc-usage.mjs',
  'plugins/grok/scripts/cc-usage.mjs',
  'plugins/codex/scripts/cc-usage.mjs',
  'plugins/opencode/src/cc-usage.mjs',
  'plugins/pi/src/cc-usage.mjs',
  'plugins/zcode/scripts/cc-usage.mjs',
];

const BANNER = `// ⚠️ 此文件由 core/cc-usage.mjs 同步生成，请勿直接修改。
// 改动请提交到 core/cc-usage.mjs，然后运行：node scripts/sync-core.mjs
`;

const checkOnly = process.argv.includes('--check');
const source = fs.readFileSync(SOURCE, 'utf8').replace(/^#!.*\n/, '');
const expected = `${BANNER}${source}`;

let drift = 0;
for (const rel of TARGETS) {
  const target = path.join(ROOT, rel);
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;

  if (current === expected) {
    console.log(`  一致  ${rel}`);
    continue;
  }

  if (checkOnly) {
    console.error(`  漂移  ${rel}${current === null ? '（文件不存在）' : ''}`);
    drift += 1;
    continue;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, expected, 'utf8');
  console.log(`  写入  ${rel}`);
}

if (checkOnly && drift > 0) {
  console.error(`\n${drift} 个适配器与 core 不一致。运行 node scripts/sync-core.mjs 后再提交。`);
  process.exit(1);
}
console.log(checkOnly ? '\n全部一致。' : '\n同步完成。');
