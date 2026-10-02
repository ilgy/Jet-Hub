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
const productSource = readFileSync(resolve(here, '../../src/keyed-product.ts'), 'utf8')
const authSource = readFileSync(resolve(here, '../../src/keyed-auth.ts'), 'utf8')

/**
 * 「粘贴 API Key」族（`commandcode` / `opencode`）的 RPC 分派与客户端接线
 * （源码级回归）。
 *
 * ⚠️ 为什么用源码扫描而不是实例化端点：这里要锁的是**语义约定**
 * （本族与其余 provider 的区别恰恰在「不做某些事」），而「不做」这类约定在
 * 实例化测试里最难断言（少一次调用与漏接一个分支表现完全不同）。
 * 行为级验证在 `tests/unit/keyed.spec.ts` 与 `tests/unit/keyed-adapter.spec.ts`。
 */
describe('「粘贴 Key」族的 RPC 分派', () => {
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
   * ⚠️ 断言「本分支**不含**某个调用」时**必须**用这个：本族分支的注释里
   * 刻意写了「绝不能复用 `startLogin` 形状」，直接扫原文会让这句解释性文字
   * 把断言自己判红 —— 而它想抓的是「真的调了 startLogin」。
   */
  const codeOf = (branch: string): string => branch
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')

  it('account.create 有「粘贴 Key」族分支，且返回 loginMode "key" 与平台清单', () => {
    const branch = branchOf('} else if (keyedProductById(provider) !== undefined)')
    expect(branch).toMatch(/loginMode:\s*'key'/)
    // 平台清单由服务端下发（客户端不抄一份，见 src/types.ts 的理由）。
    expect(branch).toMatch(/platforms:\s*\[/)
    expect(branch).toMatch(/keyedProduct\.baseUrl/)
  })

  it('⚠️ account.create 的本族分支不发任何网络请求（没有 startLogin 可等）', () => {
    // 凭据由用户粘贴，创建阶段只建占位条目 —— 若这里出现 startLogin，
    // 说明有人误把它当成「登录式」provider 复用，而它没有 loginUrl 可返回。
    // ⚠️ 必须去注释后判定，否则本文件自身的那句注释会造成假红（见 codeOf）。
    const code = codeOf(branchOf('} else if (keyedProductById(provider) !== undefined)'))
    expect(code).not.toMatch(/startLogin/)
    expect(code).not.toMatch(/\bfetch\s*\(/)
    // 占位条目的 loginUrl 是空串（前端据此判 `loginMode` 而非 `loginUrl`）。
    expect(code).toMatch(/loginUrl:\s*''/)
  })

  it('⚠️ account.create 的本族分支恒 refreshable: false（Key 无法续期）', () => {
    const branch = branchOf('} else if (keyedProductById(provider) !== undefined)')
    expect(branch).toMatch(/refreshable:\s*false/)
  })

  it('login.submitKey 已接上，且拒绝非本族 provider', () => {
    const branch = branchOf("case 'login.submitKey'")
    // 服务端只认 `provider`（端点取产品表），从前端传的 platform/baseUrl 一律忽略。
    expect(branch).toMatch(/keyedProductById\(req\.provider\)/)
    expect(branch).toMatch(/auth\.validateApiKey/)
    expect(branch).toMatch(/auth\.persistApiKey/)
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

  it('login.submitKey 成功后广播目录变更（新 Key 可能带来新的模型权益）', () => {
    const branch = branchOf("case 'login.submitKey'")
    expect(branch).toMatch(/broadcastCatalogChanged\(ctx\)/)
  })

  it('⚠️ 账号昵称只含产品名 + Key 尾 4 位（绝不放 Key 前段）', () => {
    const branch = branchOf("case 'login.submitKey'")
    expect(branch).toMatch(/buildKeyedNickname\(/)
    // 不得出现「把 apiKey 本身写进 nickname」的写法。
    expect(branch).not.toMatch(/nickname:\s*req\.apiKey/)
    expect(branch).not.toMatch(/nickname:\s*credential\.access_token/)
  })

  it('account.refresh 对本族走有效性探测（经 `keyed` Map 分派，不改写凭据）', () => {
    // ⚠️ 本族不逐 id 写 `case`：放在 `default` 里查 Map，这样以后加平台
    // 不需要再动 refresh 的 switch（那正是历史上「漏改一处就出空壳面板」的成因）。
    expect(rpcSource).toMatch(/keyed\.get\(entry\.provider\)/)
    const start = rpcSource.indexOf('keyed.get(entry.provider)')
    const branch = rpcSource.slice(start, start + 1200)
    expect(branch).toMatch(/refreshAccountCredential\(entry\.credentialRef\)/)
  })

  it('⚠️ 未知 provider 仍然抛 Unknown provider（不能被 Map 查空吞掉）', () => {
    const start = rpcSource.indexOf('keyed.get(entry.provider)')
    const branch = rpcSource.slice(start, start + 1200)
    expect(branch).toMatch(/throw new Error\(`Unknown provider/)
  })

  it('RPC 门面把本族服务接进 registry（否则领域模块拿到 undefined）', () => {
    expect(rpcSource).toMatch(/keyed:\s*services\.keyed/)
  })
})

describe('「粘贴 Key」族的客户端接线', () => {
  it('面板列表含本族两个 provider（否则服务端注册了也无入口）', () => {
    expect(optionSource).toMatch(/\{\s*id:\s*'commandcode',\s*label:/)
    expect(optionSource).toMatch(/\{\s*id:\s*'opencode',\s*label:/)
  })

  it('⚠️ 客户端的 KEYED_PROVIDER_IDS 与服务端产品表等集', () => {
    // 三处名单（面板 id / 客户端判定集合 / 服务端产品表）必须一致 ——
    // 任一处漂移都会让某个 provider 在部分代码路径里「不存在」。
    const clientIds = [...optionSource.matchAll(/^const KEYED_PROVIDER_IDS = Object\.freeze\(\[([^\]]*)\]\)/gm)][0]?.[1]
    expect(clientIds, '未找到客户端 KEYED_PROVIDER_IDS').toBeDefined()
    const fromClient = [...clientIds!.matchAll(/'([a-z][a-z0-9-]*)'/g)].map(m => m[1]).sort()
    const fromStub = ['commandcode', 'opencode'].sort()
    expect(fromClient).toEqual(fromStub)
    // 服务端产品表里每个 id 都要真的出现一次。
    for (const id of fromClient) {
      expect(productSource, `服务端产品表缺少 ${id}`).toMatch(new RegExp(`id:\\s*'${id}'`))
    }
  })

  it('⚠️ createAccount 在 `if (loginUrl)` **之前**分流（本族的 loginUrl 是空串）', () => {
    const keyAt = optionSource.indexOf("res.loginMode === 'key'")
    expect(keyAt, '未找到 loginMode === "key" 的分流').toBeGreaterThan(-1)
    const loginUrlAt = optionSource.indexOf('if (loginUrl)', keyAt)
    expect(loginUrlAt, '分流之后必须还有 if (loginUrl) 分支').toBeGreaterThan(keyAt)
    // 分流块本身必须是 `return` 结束的，否则会继续落到 if (loginUrl) 报错。
    const branch = optionSource.slice(keyAt, loginUrlAt)
    expect(branch).toMatch(/return/)
  })

  it('⚠️ 本族不打开任何窗口、不轮询 login.poll（没有可打开的登录页）', () => {
    const keyAt = optionSource.indexOf("res.loginMode === 'key'")
    const loginUrlAt = optionSource.indexOf('if (loginUrl)', keyAt)
    const branch = optionSource.slice(keyAt, loginUrlAt)
    expect(branch).not.toMatch(/window\.open/)
    expect(branch).not.toMatch(/login\.poll/)
  })

  it('提交走 login.submitKey，且带上 provider / apiKey（不再传 platform/baseUrl）', () => {
    const start = optionSource.indexOf("rpcCall('login.submitKey'")
    expect(start).toBeGreaterThan(-1)
    const call = optionSource.slice(start, start + 400)
    // ⚠️ `provider` / `apiKey` 都是 ES 简写属性（`provider,`、`apiKey,`），
    // 不能按 `field:` 匹配。
    expect(call, '提交请求缺少 provider').toMatch(/^\s*provider,\s*$/m)
    expect(call, '提交请求缺少 apiKey').toMatch(/^\s*apiKey,\s*$/m)
    expect(call, '提交请求缺少 accountId').toMatch(/accountId:/)
    // ⚠️ 端点由服务端产品表决定，前端**不再**传可篡改的 baseUrl。
    expect(call, 'submitKey 不应再传 baseUrl').not.toMatch(/baseUrl:/)
  })

  it('表单渲染「添加 API Key」弹窗（Key 输入框 + 控制台链接）', () => {
    expect(optionSource).toMatch(/aria-label':\s*'添加 API Key'/)
    expect(optionSource).toMatch(/type:\s*'password'/)
    // 控制台链接（用户去哪儿拿 Key）。
    expect(optionSource).toMatch(/rel:\s*'noopener noreferrer'/)
  })

  it('⚠️ 表单不再渲染可改的端点/平台选择（本族一个 provider 对应一个固定端点）', () => {
    expect(optionSource, '不应再出现「自定义 base url」下拉项').not.toMatch(/自定义（自己填 base url）/)
    expect(optionSource, '不应再出现自定义 base url 输入框').not.toMatch(/placeholder:\s*'https:\/\/your-host\/v1'/)
  })

  it('⚠️ 表单说明必须如实说「校验打对话端点」，不能沿用旧的 /models 说法', () => {
    // 两个平台的 `/models` 都**不鉴权**，写「会先请求 /models 校验」是错的 ——
    // 会让人以为任意字符串都能通过（这正是 BYOK 时代留下的过时文案）。
    expect(optionSource).toMatch(/对话端点/)
    expect(optionSource).not.toMatch(/先请求该端点的 \/models 校验 Key/)
  })

  it('⚠️ 能力表登记本族为两项皆无（额度由用户自己接的平台决定）', () => {
    for (const id of ['commandcode', 'opencode']) {
      expect(capabilitiesSource, `${id} 缺少负能力登记`).toMatch(
        new RegExp(`${id}:\\s*Object\\.freeze\\(\\{\\s*balance:\\s*false,\\s*dailyCheckin:\\s*false\\s*\\}\\)`),
      )
    }
  })

  it('⚠️ 本族不在签到渠道列表里（否则「一键全部签到」每次都白跑一次）', () => {
    // `checkinProviders()` 从能力表推导，故只要能力表登记 false 就不会入列；
    // 这条守卫锁的是「推导机制本身没被绕过」。
    expect(capabilitiesSource).toMatch(/export function checkinProviders\(\)[\s\S]{0,400}CREDITS_CAPABILITIES/)
  })
})

describe('「粘贴 Key」族的校验判据（服务端源码级回归）', () => {
  it('⚠️ 校验打的是 chat 端点，不是 `GET /models`（后者不鉴权，任意 Key 都能过）', () => {
    // 这是本族最容易写错、且错了以后最难发现的一处：`/models` 对无 Key 的请求
    // 同样返回 200 + 完整模型列表，拿它当校验 → 任何字符串都「校验通过」。
    expect(authSource).toMatch(/keyedChatUrl\(baseUrl\)/)
    const probeAt = authSource.indexOf('export async function probeKeyedApiKey')
    expect(probeAt).toBeGreaterThan(-1)
    const probe = authSource.slice(probeAt, probeAt + 2000)
    expect(probe, '探测必须打 chat 端点').toMatch(/keyedChatUrl/)
    expect(probe, '探测不应在写凭据前用 /models 判成败').not.toMatch(/invalidIf[\s\S]{0,200}keyedModelsUrl/)
  })

  it('⚠️ 探测模型必须是免费档位（否则每粘贴一次 Key 就扣一次钱）', () => {
    for (const id of ['COMMANDCODE', 'OPENCODE']) {
      const at = productSource.indexOf(`export const ${id}: KeyedProduct`)
      expect(at, `未找到产品配置 ${id}`).toBeGreaterThan(-1)
      const entry = productSource.slice(at, at + 2500)
      // 免费档位：id 后缀命中 `-free` / `:free`。
      expect(entry, `${id} 的探测模型不在免费档位`).toMatch(/model:\s*'[^']*[-_:]free'/)
    }
  })

  it('⚠️ opencode 的鉴权判据必须连报文一起判（ModelError 也是 401，但与 Key 无关）', () => {
    const at = productSource.indexOf('export const OPENCODE: KeyedProduct')
    const entry = productSource.slice(at, at + 2500)
    expect(entry).toMatch(/invalidIf[\s\S]{0,200}AuthError/)
  })

  it('⚠️ commandcode 下架只支持 /messages 的模型（列出来却调不通比不列更糟）', () => {
    const at = productSource.indexOf('export const COMMANDCODE: KeyedProduct')
    const entry = productSource.slice(at, at + 3000)
    expect(entry).toMatch(/excludeModels/)
    // 实测那 10 个 claude 只能用 /messages 调。
    expect(entry).toMatch(/claude-sonnet-5-5/)
  })

  it('⚠️ opencode 下架走非 chat 端点的模型（jev-1.13 / gpt-* / claude-* / gemini-*）', () => {
    const at = productSource.indexOf('export const OPENCODE: KeyedProduct')
    const entry = productSource.slice(at, at + 6000)
    expect(entry).toMatch(/excludeModels/)
    // 四类非 chat 端点各取一个代表。
    expect(entry).toMatch(/jev-1\.13/)
    expect(entry).toMatch(/'gpt-5\.5'/)
    expect(entry).toMatch(/claude-sonnet-5/)
    expect(entry).toMatch(/gemini-3\.8-flash/)
  })

  it('⚠️ 官方文档声明免费但无 free 后缀的模型必须进白名单', () => {
    // 这是「确保会显示 免费的模型」这条需求的直接守卫：只靠后缀会漏掉
    // commandcode 的 stealth/space-bunny-alpha 与 opencode 的 big-pickle。
    expect(productSource).toMatch(/documentedFreeModels[\s\S]{0,120}stealth\/space-bunny-alpha/)
    expect(productSource).toMatch(/documentedFreeModels[\s\S]{0,120}big-pickle/)
  })
})
