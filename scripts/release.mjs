#!/usr/bin/env node
/**
 * 把 monorepo 里「两边应当一致」的文件分发到 7 个独立仓库。
 *
 * 背景：7 个插件各自一个仓库（各自的市场清单、README、CHANGELOG、发布节奏），
 * 但实现代码与测试只有一处真源，就是本仓库。手工复制会漏、会漂移——2026-09-26
 * 就漏过一次：桌面端的 provider 发现修复只进了本仓库，4★ 那个仓库仍是坏的。
 *
 * 两种差异，两种处理：
 *   - 机械差异（仓库自指 URL、Windows 换行）：按清单自动改写，--write 直接写。
 *   - 真实内容差异：只在报告里点名，**永不覆盖**。清单里标 review:true 的就是这类
 *     （独立仓库反而更新的那些）。人工合并回本仓库后，把标记去掉即可转为自动同步。
 *
 *   node scripts/release.mjs            检查（默认，退出码非 0 表示有漂移）
 *   node scripts/release.mjs --check     同上
 *   node scripts/release.mjs --write     写入机械差异（不动 review 项）
 *   node scripts/release.mjs --only dsh-commandcode-quota
 *   node scripts/release.mjs --dir <独立仓库工作区>   默认 ../cc-usage-repos
 *
 * 需要先把独立仓库 clone 到工作区（--dir），工具只读本地，不联网。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const hasFlag = (name) => argv.includes(name)
const flagValue = (name) => {
  const at = argv.indexOf(name)
  return at === -1 ? undefined : argv[at + 1]
}

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'release.json'), 'utf8'))
const workspace = flagValue('--dir') ?? process.env.CC_REPOS ?? path.resolve(ROOT, '..', 'cc-usage-repos')
const only = flagValue('--only')
const writeMode = hasFlag('--write')

const toLF = (text) => text.replace(/\r\n/g, '\n')
const toCRLF = (text) => toLF(text).replace(/\n/g, '\r\n')

/** 计算某个清单条目在独立仓库里应当是什么内容。 */
function expected(entry, plugin, coreSource) {
  if (entry.core !== undefined) {
    // 各适配器里的 core 副本就是 core/cc-usage.mjs 原文件本身（含 shebang）。
    // 注意这与 monorepo 内部不同：sync-core.mjs 写进 plugins/* 的是「banner + 去
    // shebang」的版本，那是给插件包内用的；独立仓库要的是能独立执行的原文。
    return { bytes: Buffer.from(coreSource, 'utf8'), kind: 'core 原文' }
  }
  const source = path.join(ROOT, plugin.dir, entry.path)
  if (!fs.existsSync(source)) return { missingSource: true }
  let bytes = fs.readFileSync(source)
  const notes = []
  if (entry.eol === 'crlf' || entry.url === true) {
    let text = toLF(bytes.toString('utf8'))
    if (entry.url === true) {
      const repoUrl = `https://github.com/Jovan1666/${plugin.repo}`
      const before = text
      text = text.split(config.monorepoUrl).join(repoUrl)
      notes.push(before === text ? 'URL 无需改写' : 'URL 已改写为仓库自指')
    }
    if (entry.eol === 'crlf') {
      text = toCRLF(text)
      notes.push('换行为 CRLF')
    }
    bytes = Buffer.from(text, 'utf8')
  }
  return { bytes, notes }
}

const coreSource = fs.readFileSync(path.join(ROOT, config.core), 'utf8')
const problems = []
let nOk = 0
let nMechanical = 0
let nReview = 0
let nDivergent = 0

console.log(`monorepo → 独立仓库分发检查（工作区：${workspace}）`)

for (const plugin of config.plugins) {
  if (only !== undefined && plugin.repo !== only) continue
  const repoDir = path.join(workspace, plugin.repo)
  console.log(`\n=== ${plugin.repo}`)

  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    console.log('  ✗ 工作区里没有这个仓库，先 clone')
    problems.push(`${plugin.repo}: 未 clone`)
    continue
  }
  if (plugin.disabled !== undefined) {
    console.log(`  ⏸  已停用：${plugin.disabled}`)
    continue
  }

  for (const raw of plugin.files) {
    const entry = typeof raw === 'string' ? { path: raw } : raw
    const label = entry.core ?? entry.path
    if (entry.divergent !== undefined) {
      // 有意不同：文件内容本就依赖仓库布局（"插件住在哪"、"这份副本是不是产物"），
      // 不是漂移，所以既不写也不报警，只在报告里说明理由。
      console.log(`  ＝ 有意不同  ${label}  ← ${entry.divergent}`)
      nDivergent += 1
      continue
    }
    if (entry.review === true) {
      const target = path.join(repoDir, entry.core ?? entry.path)
      const source = entry.core !== undefined ? path.join(ROOT, config.core) : path.join(ROOT, plugin.dir, entry.path)
      const same = fs.existsSync(target) && fs.existsSync(source)
        ? fs.readFileSync(target).equals(Buffer.from(fs.readFileSync(source).toString('utf8').replace(/^#!.*\n/, ''), 'utf8'))
        : false
      console.log(`  ⚠ review  ${label}${same ? '' : '  ← 两边内容不同，需人工合并（工具不覆盖）'}`)
      nReview += 1
      continue
    }

    const want = expected(entry, plugin, coreSource)
    if (want.missingSource) {
      console.log(`  ✗ 清单里的 ${label} 在 monorepo 里不存在`)
      problems.push(`${plugin.repo}: 清单引用了不存在的 ${label}`)
      continue
    }
    const target = path.join(repoDir, entry.core ?? entry.path)
    const have = fs.existsSync(target) ? fs.readFileSync(target) : null
    const suffix = want.notes && want.notes.length > 0 ? `  (${want.notes.join('；')})` : ''

    if (have !== null && have.equals(want.bytes)) {
      console.log(`  ok      ${label}${suffix}`)
      nOk += 1
      continue
    }

    if (writeMode) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, want.bytes)
      console.log(`  写入    ${label}${suffix}${have === null ? '（新建）' : ''}`)
    } else {
      console.log(`  漂移    ${label}${suffix}${have === null ? '（目标缺失）' : `  repo=${have.length}B 期望=${want.bytes.length}B`}`)
    }
    nMechanical += 1
  }
}

console.log(`\n合计：一致 ${nOk}｜可自动修复 ${nMechanical}｜需人工合并 ${nReview}｜有意不同 ${nDivergent}`)
if (problems.length > 0) {
  console.log('问题：')
  for (const problem of problems) console.log(`  - ${problem}`)
}
if (!writeMode && (nMechanical > 0 || problems.length > 0)) {
  console.log('\n运行 node scripts/release.mjs --write 写入可自动修复项（review 项永不被覆盖）。')
  process.exitCode = 1
}
