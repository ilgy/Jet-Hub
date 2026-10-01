import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * ⚠️ 与 `raccoon-rpc-dispatch.spec.ts` 同一套读法：P1-⑤ 结构重构把
 * `handleMethod` 的分支按领域拆到 `src/rpc/*.ts`，只读门面会让断言假红。
 * 顺序保持重构前的相对顺序（credits 必须在 models 之前）。
 */
const RPC_SOURCE_FILES = [
  '../../src/jet-hub-rpc.ts',
  '../../src/rpc/account.ts',
  '../../src/rpc/login.ts',
  '../../src/rpc/onboarding.ts',
  '../../src/rpc/credits.ts',
  '../../src/rpc/models.ts',
  '../../src/rpc/backup.ts',
] as const

const rpcSource = RPC_SOURCE_FILES.map(rel => readFileSync(resolve(here, rel), 'utf8')).join('\n')

const optionSource = readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')
const capabilitiesSource = readFileSync(resolve(here, '../../plugin-src/client/credits-capabilities.js'), 'utf8')

/**
 * BYOK 的 RPC 分派与客户端接线（源码级回归）。
 *
 * ⚠️ 为什么用源码扫描而不是实例化端点：与 raccoon 那份同理 —— 这里要锁的是
 * **语义约定**（BYOK 与其余 13 个 provider 的区别恰恰在「不做某些事」），
 * 而「不做」这类约定在实例化测试里最难断言（少一次调用与漏接一个分支
 * 表现完全不同）。行为级验证在 `tests/unit/byok-adapter.spec.ts`。
 */
describe('BYOK 的 RPC 分派', () => {
  /** 先定位锚点再取切片，避免大跨度正则被注释字数变化扰动。 */
  const branchOf = (anchor: string, size = 3000): string => {
    const start = rpcSource.indexOf(anchor)
    expect(start, `未找到锚点：${anchor}`).toBeGreaterThan(-1)
    const sliced = rpcSource.slice(start, start + size)
    // ⚠️ 必须截到**下一个分支边界**为止，否则会把后续 `else` 的内容（例如
    // 相邻分支里的 `startLogin`）算进本分支，让「本分支不做某件事」的断言假红。
    // 分支边界是形如 `} else if (...)` / `} else {` 的行首结构。
    const boundary = sliced.slice(1).search(/\}\s*else\s*(?:if\s*\(|\{)/)
    return boundary === -1 ? sliced : sliced.slice(0, boundary + 1)
  }

  /**
   * 去掉注释后的分支文本。
   *
   * ⚠️ 断言「本分支**不含**某个调用」时**必须**用这个：BYOK 分支的注释里
   * 刻意写了「绝不能复用 `startLogin` 形状」，直接扫原文会让这句解释性文字
   * 把断言自己判红 —— 而它想抓的是「真的调了 startLogin」。
   */
  const codeOf = (branch: string): string => branch
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')

  it('account.create 有 byok 分支，且返回 loginMode "key" 与平台清单', () => {
    const branch = branchOf('} else if (provider === BYOK.id)')
    expect(branch).toMatch(/loginMode:\s*'key'/)
    // 平台清单由服务端下发（客户端不抄一份，见 src/types.ts 的理由）。
    expect(branch).toMatch(/platforms:\s*BYOK_PLATFORMS\.map/)
  })

  it('⚠️ account.create 的 byok 分支不发任何网络请求（没有 startLogin 可等）', () => {
    // BYOK 的凭据由用户粘贴，创建阶段只建占位条目 —— 若这里出现 startLogin，
    // 说明有人误把它当成「登录式」provider 复用，而它没有 loginUrl 可返回。
    // ⚠️ 必须去注释后判定，否则本文件自身的那句注释会造成假红（见 codeOf）。
    const code = codeOf(branchOf('} else if (provider === BYOK.id)'))
    expect(code).not.toMatch(/startLogin/)
    expect(code).not.toMatch(/\bfetch\s*\(/)
    // 占位条目的 loginUrl 是空串（前端据此判 `loginMode` 而非 `loginUrl`）。
    expect(code).toMatch(/loginUrl:\s*''/)
  })

  it('⚠️ account.create 的 byok 分支恒 refreshable: false（Key 无法续期）', () => {
    const branch = branchOf('} else if (provider === BYOK.id)')
    expect(branch).toMatch(/refreshable:\s*false/)
  })

  it('login.submitKey 已接上，且拒绝非 byok provider', () => {
    const branch = branchOf("case 'login.submitKey'")
    expect(branch).toMatch(/req\.provider !== BYOK\.id/)
    expect(branch).toMatch(/byok\.validateApiKey/)
    expect(branch).toMatch(/byok\.persistApiKey/)
  })

  it('⚠️ login.submitKey 先校验再写凭据（顺序反转会留下「账号在、模型全空」的黑洞）', () => {
    const branch = branchOf("case 'login.submitKey'")
    const validateAt = branch.indexOf('validateApiKey')
    const persistAt = branch.indexOf('persistApiKey')
    expect(validateAt).toBeGreaterThan(-1)
    expect(persistAt).toBeGreaterThan(-1)
    expect(
      validateAt,
      'validateApiKey 必须出现在 persistApiKey 之前',
    ).toBeLessThan(persistAt)
    // 校验失败必须提前 return（不留半成品凭据）。
    const between = branch.slice(validateAt, persistAt)
    expect(between).toMatch(/if\s*\(!check\.ok\)/)
    expect(between).toMatch(/return/)
  })

  it('⚠️ login.submitKey 失败路径不删占位条目（用户可继续重试粘贴）', () => {
    const branch = branchOf("case 'login.submitKey'")
    expect(branch).not.toMatch(/pool\.removeAccount/)
  })

  it('login.submitKey 成功后广播目录变更（新平台可能带来新模型）', () => {
    const branch = branchOf("case 'login.submitKey'")
    expect(branch).toMatch(/broadcastCatalogChanged\(ctx\)/)
  })

  it('⚠️ 账号昵称只含平台名 + Key 尾 4 位（绝不放 Key 前段）', () => {
    const branch = branchOf("case 'login.submitKey'")
    expect(branch).toMatch(/buildByokNickname\(/)
    // 不得出现「把 apiKey 本身写进 nickname」的写法。
    expect(branch).not.toMatch(/nickname:\s*req\.apiKey/)
    expect(branch).not.toMatch(/nickname:\s*credential\.access_token/)
  })

  it('account.refresh 的 switch 有 BYOK 分支（走有效性探测，不改写凭据）', () => {
    expect(rpcSource).toMatch(/case BYOK\.id:/)
    const start = rpcSource.indexOf('case BYOK\.id:')
    const branch = rpcSource.slice(start, start + 1200)
    expect(branch).toMatch(/byok\.refreshAccountCredential/)
  })

  it('RPC 门面把 byok 服务接进 registry（否则领域模块拿到 undefined）', () => {
    expect(rpcSource).toMatch(/byok:\s*services\.byok/)
  })
})

describe('BYOK 的客户端接线', () => {
  it('面板列表含 byok（否则服务端注册了也无入口）', () => {
    expect(optionSource).toMatch(/\{\s*id:\s*'byok',\s*label:/)
  })

  it('⚠️ createAccount 在 `if (loginUrl)` **之前**分流（BYOK 的 loginUrl 是空串）', () => {
    const keyAt = optionSource.indexOf("res.loginMode === 'key'")
    expect(keyAt, '未找到 loginMode === "key" 的分流').toBeGreaterThan(-1)
    const loginUrlAt = optionSource.indexOf('if (loginUrl)', keyAt)
    expect(loginUrlAt, '分流之后必须还有 if (loginUrl) 分支').toBeGreaterThan(keyAt)
    // 分流块本身必须是 `return` 结束的，否则会继续落到 if (loginUrl) 报错。
    const branch = optionSource.slice(keyAt, loginUrlAt)
    expect(branch).toMatch(/return/)
  })

  it('⚠️ BYOK 不打开任何窗口、不轮询 login.poll（没有可打开的登录页）', () => {
    const keyAt = optionSource.indexOf("res.loginMode === 'key'")
    const loginUrlAt = optionSource.indexOf('if (loginUrl)', keyAt)
    const branch = optionSource.slice(keyAt, loginUrlAt)
    expect(branch).not.toMatch(/window\.open/)
    expect(branch).not.toMatch(/login\.poll/)
  })

  it('提交走 login.submitKey，且带上 platform / apiKey / baseUrl', () => {
    const start = optionSource.indexOf("rpcCall('login.submitKey'")
    expect(start).toBeGreaterThan(-1)
    const call = optionSource.slice(start, start + 400)
    // ⚠️ `provider` / `apiKey` 都是 ES 简写属性（`provider,`、`apiKey,`），
    // 不能按 `field:` 匹配。
    expect(call, '提交请求缺少 provider').toMatch(/^\s*provider,\s*$/m)
    expect(call, '提交请求缺少 apiKey').toMatch(/^\s*apiKey,\s*$/m)
    for (const field of ['accountId', 'platform', 'baseUrl']) {
      expect(call, `提交请求缺少字段 ${field}`).toMatch(new RegExp(`${field}:`))
    }
  })

  it('表单渲染“添加 API Key”弹窗（含平台下拉、Key 输入框与控制台链接）', () => {
    expect(optionSource).toMatch(/aria-label':\s*'添加 API Key'/)
    expect(optionSource).toMatch(/type:\s*'password'/)
    expect(optionSource).toMatch(/自定义（自己填 base url）/)
    // 控制台链接（用户去哪儿拿 Key）。
    expect(optionSource).toMatch(/rel:\s*'noopener noreferrer'/)
  })

  it('⚠️ 能力表登记 byok 为两项皆无（额度由用户自己接的平台决定）', () => {
    expect(capabilitiesSource).toMatch(/byok:\s*Object\.freeze\(\{\s*balance:\s*false,\s*dailyCheckin:\s*false\s*\}\)/)
  })

  it('⚠️ byok 不在签到渠道列表里（否则「一键全部签到」每次都白跑一次）', () => {
    // `checkinProviders()` 从能力表推导，故只要能力表登记 false 就不会入列；
    // 这条守卫锁的是「推导机制本身没被绕过」。
    expect(capabilitiesSource).toMatch(/export function checkinProviders\(\)[\s\S]{0,400}CREDITS_CAPABILITIES/)
  })
})
