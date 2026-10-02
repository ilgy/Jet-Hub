/**
 * 「粘贴 API Key」族的产品表与纯函数单测。
 *
 * ⚠️ 这里锁的是**产品事实**（端点、控制台地址、下架模型、探测判据），
 * 它们全部来自 2026-10 的实测。改动前请先读 `src/keyed-product.ts` 的表头注释
 * 与 `docs/agents/keyed.md`。
 */

import { describe, expect, it } from 'vitest'
import {
  ALL_KEYED_PRODUCTS,
  COMMANDCODE,
  OPENCODE,
  isKeyedProvider,
  keyedChatUrl,
  keyedModelExcluded,
  keyedModelsUrl,
  keyedProductById,
  keyedProductLabel,
} from '../../src/keyed-product.js'
import {
  buildKeyedCredential,
  buildKeyedNickname,
  isKeyedExpired,
  keyedApiKeyLooksMalformed,
  keyedBaseUrlLooksValid,
  keyedCredentialRefName,
  keyedHeaders,
  keyedModelIdLooksFree,
  parseKeyedCredential,
  parseKeyedModelEntries,
  parseKeyedModelList,
} from '../../src/keyed.js'

describe('KeyedProduct 产品表', () => {
  it('两个平台都在表里，且 id / 展示名 / 端点齐备', () => {
    expect(ALL_KEYED_PRODUCTS.map(p => p.id)).toEqual(['commandcode', 'opencode'])
    for (const product of ALL_KEYED_PRODUCTS) {
      expect(product.displayName.length, product.id).toBeGreaterThan(0)
      expect(product.baseUrl, product.id).toMatch(/^https:\/\//)
      expect(product.baseUrl, product.id).not.toMatch(/\/$/)
      expect(product.consoleUrl, product.id).toMatch(/^https:\/\//)
      expect(product.defaultCredentialRef, product.id).toMatch(/^[A-Z][A-Z0-9_]+$/)
    }
  })

  it('端点按实测写死（写错会让所有请求 404）', () => {
    expect(COMMANDCODE.baseUrl).toBe('https://api.commandcode.ai/provider/v1')
    expect(OPENCODE.baseUrl).toBe('https://opencode.ai/zen/v1')
  })

  it('控制台地址按实测选可达的那个（commandcode.ai/keys、opencode.ai/auth）', () => {
    expect(COMMANDCODE.consoleUrl).toBe('https://commandcode.ai/keys')
    expect(OPENCODE.consoleUrl).toBe('https://opencode.ai/auth')
  })

  it('端点拼接不重复斜杠', () => {
    expect(keyedModelsUrl(COMMANDCODE.baseUrl)).toBe('https://api.commandcode.ai/provider/v1/models')
    expect(keyedChatUrl(OPENCODE.baseUrl)).toBe('https://opencode.ai/zen/v1/chat/completions')
  })

  it('byId / isKeyedProvider / label', () => {
    expect(keyedProductById('opencode')?.displayName).toBe('OpenCode Zen')
    expect(keyedProductById('byok')).toBeUndefined()
    expect(isKeyedProvider('commandcode')).toBe(true)
    expect(isKeyedProvider('mystery')).toBe(false)
    // 未知 id 回落到原始 id，而不是 undefined（错误文案里要用）。
    expect(keyedProductLabel('mystery')).toBe('mystery')
    expect(keyedProductLabel('commandcode')).toBe('Command Code')
  })

  it('⚠️ commandcode 下架 10 个只能用 /messages 调的 claude', () => {
    // 实测：用 /chat/completions 调会 400
    // `Model "claude-sonnet-5-5" must be called via /provider/v1/messages`。
    const excluded = COMMANDCODE.excludeModels ?? []
    expect(excluded).toHaveLength(10)
    expect(excluded).toContain('claude-sonnet-5-5')
    expect(excluded).toContain('claude-opus-5')
    expect(keyedModelExcluded(COMMANDCODE, 'claude-sonnet-5-5')).toBe(true)
    // 普通模型不受影响。
    expect(keyedModelExcluded(COMMANDCODE, 'deepseek/deepseek-v4-pro')).toBe(false)
  })

  it('⚠️ opencode 下架走 /systemone 的 jev-1.13（另一套请求形状）', () => {
    expect(keyedModelExcluded(OPENCODE, 'jev-1.13-free')).toBe(true)
    expect(keyedModelExcluded(OPENCODE, 'jev-1.13')).toBe(true)
    // 其余 free 模型走 /chat/completions，必须保留。
    expect(keyedModelExcluded(OPENCODE, 'nemotron-3.5-lightning-free')).toBe(false)
    expect(keyedModelExcluded(OPENCODE, 'space-bunny-free')).toBe(false)
  })

  it('⚠️ 探测模型必须是免费档位（每次粘贴 Key 都会跑一次）', () => {
    for (const product of ALL_KEYED_PRODUCTS) {
      expect(keyedModelIdLooksFree(product.probe.model), `${product.id} 的探测模型不是免费档位`).toBe(true)
      expect(keyedModelExcluded(product, product.probe.model), `${product.id} 的探测模型被自己下架了`).toBe(false)
    }
  })

  it('⚠️ opencode 的 invalidIf 必须连报文一起判（ModelError 也是 401）', () => {
    // 实测：`space-bunny-free` 走 /systemone 返回
    // 401 {"error":{"type":"ModelError","message":"...not supported for format systemone"}}
    // —— 与 Key 有效性无关；只看状态码会把「模型不该走这条路径」误判成「Key 失效」。
    expect(OPENCODE.probe.invalidIf(401, '{"error":{"type":"ModelError"}}')).toBe(false)
    expect(OPENCODE.probe.invalidIf(401, '{"error":{"type":"AuthError","message":"Invalid API key."}}')).toBe(true)
    // 2xx 永远算有效。
    expect(OPENCODE.probe.invalidIf(200, '{}')).toBe(false)
  })

  it('commandcode 的 invalidIf 是 401（实测真 Key 200 / bogus Key 401）', () => {
    expect(COMMANDCODE.probe.invalidIf(401, '{"error":{"message":"Invalid \'Authorization\' header or token."}}')).toBe(true)
    expect(COMMANDCODE.probe.invalidIf(200, '{}')).toBe(false)
    // ⚠️ 403 是「账号无权限」，不是 Key 失效 —— 不能判成无效。
    expect(COMMANDCODE.probe.invalidIf(403, '')).toBe(false)
  })
})

describe('模型目录解析', () => {
  it('解析 OpenAI 形状的 {data:[{id}]}（并保留 supported_endpoints）', () => {
    const entries = parseKeyedModelEntries({
      object: 'list',
      data: [
        { id: 'claude-sonnet-5-5', owned_by: 'command-code', supported_endpoints: ['/messages'] },
        { id: 'deepseek/deepseek-v4-pro', supported_endpoints: ['/chat/completions', '/responses'] },
      ],
    })
    expect(entries.map(e => e.id)).toEqual(['claude-sonnet-5-5', 'deepseek/deepseek-v4-pro'])
    expect(entries[0]!.endpoints).toEqual(['/messages'])
    expect(entries[1]!.endpoints).toEqual(['/chat/completions', '/responses'])
  })

  it('兼容 {models} 与裸数组、裸字符串', () => {
    expect(parseKeyedModelList({ models: [{ id: 'a' }, { name: 'b' }] })).toEqual(['a', 'b'])
    expect(parseKeyedModelList([{ model: 'c' }, 'd'])).toEqual(['c', 'd'])
  })

  it('去重保序，且跳过没有 id 的条目', () => {
    expect(parseKeyedModelList({ data: [{ id: 'a' }, { id: 'a' }, {}, { id: 'b' }] })).toEqual(['a', 'b'])
  })

  it('非目录形状一律返回空数组（不抛错）', () => {
    expect(parseKeyedModelList(null)).toEqual([])
    expect(parseKeyedModelList('nope')).toEqual([])
    expect(parseKeyedModelList({ error: 'x' })).toEqual([])
  })

  it('⚠️ 免费判据：id 后缀 -free / :free / _free（三个写法两个平台都在用）', () => {
    expect(keyedModelIdLooksFree('nemotron-3.5-lightning-free')).toBe(true)
    expect(keyedModelIdLooksFree('inclusionai/ling-3.1-flash:free')).toBe(true)
    expect(keyedModelIdLooksFree('some_model_free')).toBe(true)
    expect(keyedModelIdLooksFree('FREE')).toBe(false)
    expect(keyedModelIdLooksFree('glm-4-flash')).toBe(false)
    expect(keyedModelIdLooksFree('free-tier')).toBe(false)
  })

  it('⚠️ 没有后缀且远端无价格字段 ⇒ free: false，语义是「未知」不是「收费」', () => {
    // 这是本族最容易搞错的一处：commandcode 实测 55 个模型能调通，但其中 52 个
    // 不带 free 后缀 —— 那是**这个 Key 的权益**，不是平台公开事实。
    // 标成「免费」会让别的用户在计费模型上毫无防备。
    const entries = parseKeyedModelEntries({ data: [{ id: 'deepseek/deepseek-v4-pro' }] })
    expect(entries[0]!.free).toBe(false)
    expect(entries[0]!.endpoints).toEqual([])
  })

  it('远端若真报零价则自动标免费（为将来平台补上价格字段预留）', () => {
    const zero = parseKeyedModelEntries({ data: [{ id: 'x', pricing: { prompt: '0', completion: 0 } }] })
    expect(zero[0]!.free).toBe(true)
    const perM = parseKeyedModelEntries({ data: [{ id: 'y', input_token_price_per_m: 0, output_token_price_per_m: '0' }] })
    expect(perM[0]!.free).toBe(true)
    const flagged = parseKeyedModelEntries({ data: [{ id: 'z', is_free: true }] })
    expect(flagged[0]!.free).toBe(true)
    // ⚠️ 有价不是「免费」，也不是「收费」标签来源 —— 只是 free: false。
    const paid = parseKeyedModelEntries({ data: [{ id: 'w', pricing: { prompt: '0.001', completion: '0.002' } }] })
    expect(paid[0]!.free).toBe(false)
  })
})

describe('凭据模型', () => {
  it('parse 拒绝缺 access_token / base_url 的载荷（否则账号看得见但用不了）', () => {
    expect(parseKeyedCredential(undefined)).toBeUndefined()
    expect(parseKeyedCredential('')).toBeUndefined()
    expect(parseKeyedCredential('not json')).toBeUndefined()
    expect(parseKeyedCredential(JSON.stringify({ access_token: 'k' }))).toBeUndefined()
    expect(parseKeyedCredential(JSON.stringify({ base_url: 'https://x/v1' }))).toBeUndefined()
  })

  it('⚠️ 解析前清洗控制字符（用户从终端复制常带 \\r\\n，JSON.parse 会直接抛）', () => {
    const raw = JSON.stringify({ access_token: 'user_abc', product: 'commandcode', base_url: 'https://x/v1' })
    const dirty = raw.replace('user_abc', 'user_\nabc')
    // 原始文本确实解析不了（证明清洗是必要的，而不是多余的防御）。
    expect(() => JSON.parse(dirty)).toThrow()
    const parsed = parseKeyedCredential(dirty)
    expect(parsed?.access_token).toBe('user_ abc')
  })

  it('base_url 去尾斜杠，product 缺省 custom', () => {
    const parsed = parseKeyedCredential(JSON.stringify({ access_token: 'k', base_url: 'https://x/v1///' }))
    expect(parsed?.base_url).toBe('https://x/v1')
    expect(parsed?.product).toBe('custom')
  })

  it('build 与 parse 往返一致', () => {
    const built = buildKeyedCredential({ apiKey: '  sk-abc  ', product: 'opencode', baseUrl: 'https://x/v1/', models: ['a'], nickname: 'n' })
    expect(built.access_token).toBe('sk-abc')
    expect(built.base_url).toBe('https://x/v1')
    const parsed = parseKeyedCredential(JSON.stringify(built))
    expect(parsed).toEqual(built)
  })

  it('⚠️ 请求头只有 Authorization + Accept，不伪造任何厂商头', () => {
    // 实测：opencode 的免费档位在服务端按「是否来自 OpenCode 客户端」判定，
    // 伪造 x-opencode-client / x-zen-client / UA **一律无效**（仍 403）。
    const headers = keyedHeaders(buildKeyedCredential({ apiKey: 'k', product: 'opencode', baseUrl: 'https://x/v1' }))
    expect(Object.keys(headers).sort()).toEqual(['Accept', 'Authorization'])
    expect(headers.Authorization).toBe('Bearer k')
  })

  it('isKeyedExpired 只在显式写了过期时间时才可能为真', () => {
    const noExpiry = buildKeyedCredential({ apiKey: 'k', product: 'opencode', baseUrl: 'https://x/v1' })
    expect(isKeyedExpired(noExpiry, Date.now() + 10 ** 12)).toBe(false)
    expect(isKeyedExpired({ ...noExpiry, expire_time: 100 }, 200)).toBe(true)
    expect(isKeyedExpired({ ...noExpiry, expire_time: 300 }, 200)).toBe(false)
  })

  it('⚠️ 昵称只放 Key 尾 4 位（账号卡片会展示它，放前段等于泄露凭据）', () => {
    const nickname = buildKeyedNickname('Command Code', 'user_3NmPVTF9B9mpHLSEpWu6S3ssNnMivvffNQjYr9GqWVic7zDDzh8TM8HhKpcD5nsYhmov9DKSqeBX8NJ4NBKusui7', 'cmd-1')
    expect(nickname).toBe('Command Code · sui7')
    expect(nickname).not.toContain('user_3NmP')
    expect(buildKeyedNickname('OpenCode Zen', '', 'oc-1')).toBe('OpenCode Zen')
  })

  it('⚠️ Key 结构预检只拦四类，绝不做前缀/长度白名单', () => {
    // 实测 Key 形态：`user_...`、`sk-...`、`oc_...`、纯 hex、两段式。
    // 加白名单会把正确的 Key 挡在门外，且用户无从判断自己错在哪。
    expect(keyedApiKeyLooksMalformed('')).toBe('API Key 不能为空')
    expect(keyedApiKeyLooksMalformed('   ')).toBe('API Key 不能为空')
    expect(keyedApiKeyLooksMalformed('a\nb')).toMatch(/换行/)
    expect(keyedApiKeyLooksMalformed('"sk-abc"')).toMatch(/引号/)
    expect(keyedApiKeyLooksMalformed("'sk-abc'")).toMatch(/引号/)
    expect(keyedApiKeyLooksMalformed('export KEY=sk-abc')).toMatch(/空格/)
    // 合法形态全部放行。
    for (const ok of ['user_3NmPVTF9', 'sk-abc123', 'oc_xyz', 'deadbeefdeadbeef', 'a.b', 'ccgw-3f0e-9c1f']) {
      expect(keyedApiKeyLooksMalformed(ok), ok).toBeUndefined()
    }
  })

  it('单凭据 ref 名由产品 id 派生', () => {
    expect(keyedCredentialRefName('commandcode')).toBe('COMMANDCODE_API_KEY')
    expect(keyedCredentialRefName('opencode')).toBe('OPENCODE_API_KEY')
    expect(COMMANDCODE.defaultCredentialRef).toBe(keyedCredentialRefName('commandcode'))
    expect(OPENCODE.defaultCredentialRef).toBe(keyedCredentialRefName('opencode'))
  })

  it('base url 形状检查', () => {
    expect(keyedBaseUrlLooksValid('https://x/v1')).toBe(true)
    expect(keyedBaseUrlLooksValid('http://127.0.0.1:8080/v1')).toBe(true)
    expect(keyedBaseUrlLooksValid('x/v1')).toBe(false)
    expect(keyedBaseUrlLooksValid('ftp://x')).toBe(false)
    expect(keyedBaseUrlLooksValid('https://x y/v1')).toBe(false)
  })
})
