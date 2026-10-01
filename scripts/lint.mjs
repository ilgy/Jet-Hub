#!/usr/bin/env node
/**
 * Jet-Hub 的 lint 门禁（**零依赖**）。
 *
 * ## 为什么不是 eslint
 *
 * 这个仓库真正踩过的坑**不是通用风格问题**，而是几条非常具体的纪律：
 * 位置参数错位（新增 provider 时漏改测试替身，2 个用例静默错位）、
 * 构造期捕获 `fetch`（让运行时补丁对某条链路静默失效）、
 * 测试里留下 `.only`（CI 静默跳过大半用例）、
 * 面板/能力表/设置命名空间三方不同步（面板空壳 + 设置页崩溃）。
 * 通用规则集表达不出「为什么」，而一个能指明「违反了哪条纪律」的检查脚本更直接。
 *
 * 另一个现实原因：本仓库的 `node_modules` 链接自 `F:\.pnpm-store\v11`，
 * 而环境里的 pnpm（10.34.5）默认用 `v10` —— 装 eslint 需要先动 store 配置或整仓重装，
 * 风险大于收益。**零依赖脚本进 CI 不需要任何安装步骤**。
 *
 * ## 规则自检（重要）
 *
 * 每条正则规则都带一个**必须命中**的样本与一个**必须不命中**的样本，
 * 启动时先跑一遍自检。原因：正则写错时会「永远 0 违规」，看起来一片绿，
 * 实际门禁是死的 —— 这正是这个脚本要防的那类问题。
 *
 * 用法：`pnpm lint`（CI 里跑同一命令）；`pnpm lint --self-test` 只跑自检。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()

/** 棘轮基线：**只能下调**。下调后请顺手把这里的数字改掉，否则下一个人会把债加回来。 */
const BASELINE = {
  /** `src/` 里 `as unknown as` 的出现次数（类型债）。 */
  anyCastsInSrc: 26,
  /** `src/` 里 `console.log/warn/error` 的出现次数（应该走 ctx.logger）。 */
  consoleInSrc: 10,
}

/**
 * 逐行规则：`pattern` 命中即违规。
 * `mustMatch` / `mustNotMatch` 是自检样本（改正则时必须一起改，自检会强制）。
 */
const LINE_RULES = [
  {
    rule: 'no-focused-test',
    files: 'tests',
    pattern: /(describe|it|test)\.only\s*\(/,
    message: '测试里出现 `.only(` —— 提交后 CI 会**静默跳过**其余全部用例，请删掉',
    mustMatch: "describe.only('x', () => {})",
    mustNotMatch: "describe('x', () => {})",
  },
  {
    rule: 'no-ts-ignore',
    files: 'all',
    pattern: /@ts-ignore\b/,
    message: '不要用 `@ts-ignore` 压错误：请改 `@ts-expect-error`（错误消失时它会自己报错），并写清原因',
    mustMatch: '// @ts-ignore',
    mustNotMatch: '// @ts-expect-error 说明原因',
  },
  {
    rule: 'no-any-annotation',
    files: 'src',
    pattern: /:\s*any\b/,
    message: '`src/` 里不允许 `: any` 注解（历史基数为 0，别开这个头）',
    mustMatch: 'function f(x: any): void {}',
    mustNotMatch: 'function f(x: unknown): void {}',
  },
  {
    rule: 'no-fetch-capture',
    files: 'src',
    // 必须以**访问修饰符**开头并以行尾（可带 `;`）结束。
    // 只按键名 + `: typeof fetch = fetch` 匹配会误伤合法的函数默认参数
    // （`fetcher: typeof fetch = fetch,` —— 那恰恰是**修复方案**本身，不是问题）；
    // 不要求修饰符则无法与参数区分，故这里以「有修饰符的字段声明」为判定特征。
    // 已知边界：不带任何修饰符的类字段（裸 `fetchImpl: typeof fetch = fetch`）不会被抓到。
    pattern: /^\s*(?:private|protected|public|static|readonly)\s+[A-Za-z_$][\w$]*\s*:\s*typeof\s+fetch\s*=\s*fetch\s*;?\s*$/,
    message: '把裸 `fetch` 存进**字段**是构造期捕获：运行时装上的 fetch 补丁会静默失效 —— '
      + '改成 getter（`private get xImpl() { return this.options.fetcher ?? fetch }`）或函数默认参数',
    mustMatch: '  private fetchImpl: typeof fetch = fetch',
    mustNotMatch: '  fetcher: typeof fetch = fetch,',
  },
]

/** 收集违规。 */
const violations = []
/** 已运行的检查名（避免「看起来跑了 20 条其实一条都没生效」）。 */
const ran = []

function fail(rule, file, line, message) {
  violations.push({ rule, file, line, message })
}

/** 遍历目录下所有匹配后缀的文件（跳过产物目录）。 */
function walk(dir, exts, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'lib' || name === '.git' || name === 'dist') continue
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(full, exts, out)
    else if (exts.some((ext) => name.endsWith(ext))) out.push(full)
  }
  return out
}

const srcFiles = walk(join(ROOT, 'src'), ['.ts'])
const testFiles = walk(join(ROOT, 'tests'), ['.ts'])
const clientFiles = walk(join(ROOT, 'plugin-src'), ['.js', '.ts'])
const filesOf = (which) => (which === 'src' ? srcFiles : which === 'tests' ? testFiles : [...srcFiles, ...testFiles, ...clientFiles])

// ── 规则自检：正则不能是死的 ──────────────────────────────────────────
const selfTestProblems = []
for (const rule of LINE_RULES) {
  if (!rule.pattern.test(rule.mustMatch)) {
    selfTestProblems.push(`[${rule.rule}] 正则命不中它自己的正样本：${JSON.stringify(rule.mustMatch)}`)
  }
  if (rule.pattern.test(rule.mustNotMatch)) {
    selfTestProblems.push(`[${rule.rule}] 正则误命中负样本：${JSON.stringify(rule.mustNotMatch)}`)
  }
}
if (selfTestProblems.length > 0) {
  console.error('\n✗ lint 规则自检失败（门禁是死的，先修 scripts/lint.mjs 的正则）\n')
  for (const problem of selfTestProblems) console.error(`  ${problem}`)
  console.error('')
  process.exit(1)
}
if (process.argv.includes('--self-test')) {
  console.log(`✓ lint 规则自检通过（${LINE_RULES.length} 条正则规则）`)
  process.exit(0)
}

// ── 逐行规则 ──────────────────────────────────────────────────────────
for (const rule of LINE_RULES) {
  ran.push(rule.rule)
  for (const file of filesOf(rule.files)) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    for (const [index, line] of lines.entries()) {
      // 规则是全局正则吗？逐行测试时重置 lastIndex，避免 /g 造成的漏检。
      rule.pattern.lastIndex = 0
      if (rule.pattern.test(line)) fail(rule.rule, relative(ROOT, file), index + 1, rule.message)
    }
  }
}

// ── 棘轮规则 ──────────────────────────────────────────────────────────
/** 统计一条正则在所有文件里的总命中数。 */
function countMatches(files, pattern) {
  let total = 0
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const global = new RegExp(pattern.source, `g${pattern.flags.replace('g', '')}`)
    total += [...text.matchAll(global)].length
  }
  return total
}

ran.push('any-cast-ratchet')
{
  const found = countMatches(srcFiles, /as unknown as/)
  if (found > BASELINE.anyCastsInSrc) {
    fail('any-cast-ratchet', 'src/', 0,
      `\`as unknown as\` 从 ${BASELINE.anyCastsInSrc} 涨到 ${found}。它会绕过类型检查`
      + '（历史上让 `entry` 落进 `fetcher` 位置，导致运行时报 `fetcher is not a function`），请显式包装')
  }
}

ran.push('console-in-src-ratchet')
{
  const found = countMatches(srcFiles, /console\.(?:log|warn|error)\s*\(/)
  if (found > BASELINE.consoleInSrc) {
    fail('console-in-src-ratchet', 'src/', 0,
      `\`src/\` 里的 console.* 从 ${BASELINE.consoleInSrc} 涨到 ${found}，请用 \`ctx.logger\`（宿主日志才有上下文）`)
  }
}

// ── provider 三方等集 ─────────────────────────────────────────────────
ran.push('provider-panel-parity')
/** 等集检查的解析结果，仅用于汇报（便于发现「解析正则过期导致 0 违规」）。 */
const PARITY_COUNTS = { panel: 0, capabilities: 0, settings: 0 }
{
  /** 从客户端面板文件里取 `{ id: 'xxx', label: ... }` 的 id 集合。 */
  function panelProviderIds() {
    const text = readFileSync(join(ROOT, 'plugin-src', 'client', 'jet-hub.js'), 'utf8')
    const ids = new Set()
    for (const match of text.matchAll(/\{\s*id:\s*'([a-z][a-z0-9-]*)',\s*label:/g)) ids.add(match[1])
    return ids
  }

  /** 取积分能力表的键集合。 */
  function capabilityProviderIds() {
    const text = readFileSync(join(ROOT, 'plugin-src', 'client', 'credits-capabilities.js'), 'utf8')
    const start = text.indexOf('CREDITS_CAPABILITIES = Object.freeze({')
    if (start === -1) throw new Error('找不到 CREDITS_CAPABILITIES 定义')
    const body = text.slice(start)
    const ids = new Set()
    for (const match of body.matchAll(/^\s{2}'?([a-z][a-z0-9-]*)'?:\s*Object\.freeze\(/gm)) ids.add(match[1])
    return ids
  }

  /**
   * 取 `registerProviderSettings(...)` **调用**实参里的 `llm-*` 命名空间集合。
   *
   * ⚠️ 不能只找第一处 `registerProviderSettings(`：文件里先是这个函数的**定义**，
   * 定义体内没有任何 `llm-` 字面量。要取第一个实参列表里真的含 `'llm-` 的出现位置。
   */
  function settingsNamespaces() {
    const text = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
    const ns = new Set()
    let from = 0
    for (;;) {
      const start = text.indexOf('registerProviderSettings(', from)
      if (start === -1) break
      const end = text.indexOf(')', start)
      const body = end === -1 ? text.slice(start) : text.slice(start, end)
      from = start + 1
      if (!body.includes("'llm-")) continue
      for (const match of body.matchAll(/'llm-([a-z][a-z0-9-]*)'/g)) ns.add(match[1])
      break
    }
    return ns
  }

  const panel = panelProviderIds()
  const capabilities = capabilityProviderIds()
  const settings = settingsNamespaces()
  PARITY_COUNTS.panel = panel.size
  PARITY_COUNTS.capabilities = capabilities.size
  PARITY_COUNTS.settings = settings.size

  if (panel.size === 0) {
    fail('provider-panel-parity', 'plugin-src/client/jet-hub.js', 0, '没解析出任何 provider —— 解析正则可能已过期')
  }
  if (settings.size === 0) {
    fail('provider-panel-parity', 'src/index.ts', 0, '没解析出任何设置命名空间 —— 解析逻辑可能已过期')
  }

  for (const id of panel) {
    if (!capabilities.has(id)) {
      fail('provider-panel-parity', 'plugin-src/client/credits-capabilities.js', 0,
        `客户端面板有 provider "${id}"，但积分能力表里没有 —— 见 AGENTS.md「新增 provider 的完整清单」第 10 项`)
    }
    if (!settings.has(id)) {
      fail('provider-panel-parity', 'src/index.ts', 0,
        `客户端面板有 provider "${id}"，但 registerProviderSettings 里没有 'llm-${id}' —— 面板会出现无法配置的空壳`)
    }
  }
  for (const id of capabilities) {
    if (!panel.has(id)) {
      fail('provider-panel-parity', 'plugin-src/client/jet-hub.js', 0,
        `积分能力表里有 "${id}"，但客户端面板 PROVIDERS 里没有（能力表必须与面板等集）`)
    }
  }
}

// ── 汇报 ──────────────────────────────────────────────────────────────
if (violations.length > 0) {
  console.error(`\n✗ lint 未通过：${violations.length} 处违规\n`)
  for (const v of violations) {
    const where = v.line > 0 ? `${v.file}:${v.line}` : v.file
    console.error(`  [${v.rule}] ${where}\n      ${v.message}`)
  }
  console.error(`\n规则说明见 scripts/lint.mjs 文件头（本次执行 ${ran.length} 条检查）。\n`)
  process.exit(1)
}

console.log(`✓ lint 通过（${ran.length} 条检查，0 违规）`)
console.log(`  棘轮基线：src/ 的 \`as unknown as\` ≤ ${BASELINE.anyCastsInSrc}、console.* ≤ ${BASELINE.consoleInSrc}（只可下调）`)
console.log(`  provider 三方等集：面板 ${PARITY_COUNTS.panel} 个、能力表 ${PARITY_COUNTS.capabilities} 个、设置命名空间 ${PARITY_COUNTS.settings} 个`)
