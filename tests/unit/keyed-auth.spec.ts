/**
 * `KeyedAuth` 行为单测（重点：**校验打的是 chat 端点，不是 `GET /models`**）。
 *
 * 这条是本族最容易写错、错了以后最难发现的一处：两个平台的 `/models` 都**不鉴权**
 * （无 Key 同样 200 + 完整模型列表），拿它当校验会让任意字符串都「校验通过」——
 * 用户看到一个登录成功的账号，然后每一轮对话都 401。
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { KeyedAuth, loadKeyedModels, probeKeyedApiKey } from '../../src/keyed-auth.js'
import { COMMANDCODE, OPENCODE } from '../../src/keyed-product.js'
import { buildKeyedCredential } from '../../src/keyed.js'

/** 造一个记录请求的 fetch 替身。 */
function makeFetch(handler: (url: string, init: RequestInit | undefined) => Response) {
  const calls: Array<{ url: string; method: string; auth: string | undefined; body: unknown }> = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url)
    calls.push({
      url: href,
      method: init?.method ?? 'GET',
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    })
    return handler(href, init)
  }) as unknown as typeof fetch
  return { calls, impl }
}

describe('probeKeyedApiKey', () => {
  it('⚠️ 打的是 chat 端点（不是 /models）', async () => {
    const { calls, impl } = makeFetch(() => new Response('{}', { status: 200 }))
    await probeKeyedApiKey(COMMANDCODE, COMMANDCODE.baseUrl, 'k', impl)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.commandcode.ai/provider/v1/chat/completions')
    expect(calls[0]!.url).not.toMatch(/\/models$/)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.auth).toBe('Bearer k')
  })

  it('⚠️ 请求体用 max_tokens: 1 且 stream: false（校验不该消耗额度）', async () => {
    const { calls, impl } = makeFetch(() => new Response('{}', { status: 200 }))
    await probeKeyedApiKey(COMMANDCODE, COMMANDCODE.baseUrl, 'k', impl)
    expect(calls[0]!.body).toMatchObject({ max_tokens: 1, stream: false })
    expect((calls[0]!.body as { model: string }).model).toBe(COMMANDCODE.probe.model)
  })

  it('⚠️ 探测模型是免费档位（每次粘贴 Key 都会跑一次，用计费模型会真的扣钱）', async () => {
    const { calls, impl } = makeFetch(() => new Response('{}', { status: 200 }))
    await probeKeyedApiKey(OPENCODE, OPENCODE.baseUrl, 'k', impl)
    expect(String((calls[0]!.body as { model: string }).model)).toMatch(/[-_:]free$/)
  })

  it('200 判为有效', async () => {
    const { impl } = makeFetch(() => new Response('{}', { status: 200 }))
    expect((await probeKeyedApiKey(COMMANDCODE, COMMANDCODE.baseUrl, 'k', impl)).ok).toBe(true)
  })

  it('⚠️ opencode 的 ModelError（401）不算 Key 失效', async () => {
    // 实测：`space-bunny-free` 走 /systemone 会 401 ModelError，与 Key 无关。
    // 只看状态码会让用户莫名其妙地反复重新粘贴一个完全正确的 Key。
    const { impl } = makeFetch(() => new Response(
      JSON.stringify({ error: { type: 'ModelError', message: 'not supported for format systemone' } }),
      { status: 401 },
    ))
    const result = await probeKeyedApiKey(OPENCODE, OPENCODE.baseUrl, 'k', impl)
    expect(result.ok).toBe(true)
  })

  it('⚠️ opencode 的 AuthError（401）判为无效，且带上可读原因', async () => {
    const { impl } = makeFetch(() => new Response(
      JSON.stringify({ type: 'error', error: { type: 'AuthError', message: 'Invalid API key.' } }),
      { status: 401 },
    ))
    const result = await probeKeyedApiKey(OPENCODE, OPENCODE.baseUrl, 'sk-bogus', impl)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Invalid API key/)
  })

  it('commandcode 的 401 判为无效', async () => {
    const { impl } = makeFetch(() => new Response(
      JSON.stringify({ error: { message: "Invalid 'Authorization' header or token.", type: 'authentication_error' } }),
      { status: 401 },
    ))
    expect((await probeKeyedApiKey(COMMANDCODE, COMMANDCODE.baseUrl, 'bogus', impl)).ok).toBe(false)
  })

  it('⚠️ commandcode 的 403 不算 Key 失效（那是账号无权限）', async () => {
    const { impl } = makeFetch(() => new Response('{"error":{"message":"forbidden"}}', { status: 403 }))
    expect((await probeKeyedApiKey(COMMANDCODE, COMMANDCODE.baseUrl, 'k', impl)).ok).toBe(true)
  })

  it('网络异常返回可读错误而不是抛', async () => {
    const impl = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    const result = await probeKeyedApiKey(COMMANDCODE, COMMANDCODE.baseUrl, 'k', impl)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/无法连接/)
    expect(result.error).toMatch(/ECONNREFUSED/)
  })
})

describe('loadKeyedModels', () => {
  it('打 GET {base_url}/models 并解析 id', async () => {
    const { calls, impl } = makeFetch(() => new Response(
      JSON.stringify({ object: 'list', data: [{ id: 'a' }, { id: 'b-free' }] }),
      { status: 200 },
    ))
    const { models } = await loadKeyedModels(COMMANDCODE, buildKeyedCredential({ apiKey: 'k', product: 'commandcode', baseUrl: COMMANDCODE.baseUrl }), impl)
    expect(calls[0]!.method).toBe('GET')
    expect(calls[0]!.url).toBe('https://api.commandcode.ai/provider/v1/models')
    expect(models.map(m => m.id)).toEqual(['a', 'b-free'])
    expect(models[1]!.free).toBe(true)
    // ⚠️ 白名单**只补标记**，不会凭空追加目录里没有的 id。
    expect(models.map(m => m.id)).not.toContain('stealth/space-bunny-alpha')
  })

  it('⚠️ 下架不能用 /chat/completions 调的模型，并给出 warning', async () => {
    // 列出来却调不通比不列更糟：用户点了模型、发出去、拿到 400，
    // 还会以为是自己 Key 的问题。
    const { impl } = makeFetch(() => new Response(
      JSON.stringify({ data: [{ id: 'claude-sonnet-5-5' }, { id: 'deepseek/deepseek-v4-pro' }] }),
      { status: 200 },
    ))
    const { models, warnings } = await loadKeyedModels(COMMANDCODE, buildKeyedCredential({ apiKey: 'k', product: 'commandcode', baseUrl: COMMANDCODE.baseUrl }), impl)
    expect(models.map(m => m.id)).toEqual(['deepseek/deepseek-v4-pro'])
    expect(warnings.join('\n')).toMatch(/claude-sonnet-5-5/)
    expect(warnings.join('\n')).toMatch(/不接受 \/chat\/completions/)
  })

  it('⚠️ 官方声明免费但无 free 后缀的模型在目录里时被标出来', async () => {
    // `stealth/space-bunny-alpha` 官方定价页写明 free，但 id 不带后缀。
    const { impl } = makeFetch(() => new Response(
      JSON.stringify({ data: [{ id: 'stealth/space-bunny-alpha' }, { id: 'deepseek/deepseek-v4-pro' }] }),
      { status: 200 },
    ))
    const { models } = await loadKeyedModels(COMMANDCODE, buildKeyedCredential({ apiKey: 'k', product: 'commandcode', baseUrl: COMMANDCODE.baseUrl }), impl)
    expect(models.find(m => m.id === 'stealth/space-bunny-alpha')?.free).toBe(true)
    expect(models.find(m => m.id === 'deepseek/deepseek-v4-pro')?.free).toBe(false)
  })

  it('opencode 下架非 chat 模型（jev-1.13 走 /systemone）', async () => {
    const { impl } = makeFetch(() => new Response(
      JSON.stringify({ data: [{ id: 'jev-1.13-free' }, { id: 'space-bunny-free' }] }),
      { status: 200 },
    ))
    const { models } = await loadKeyedModels(OPENCODE, buildKeyedCredential({ apiKey: 'k', product: 'opencode', baseUrl: OPENCODE.baseUrl }), impl)
    expect(models.map(m => m.id)).toEqual(['space-bunny-free'])
  })

  it('⚠️ opencode 的 Big Pickle 免费但无后缀，在目录里时被标出来', async () => {
    const { impl } = makeFetch(() => new Response(
      JSON.stringify({ data: [{ id: 'big-pickle' }, { id: 'gpt-5.5' }] }),
      { status: 200 },
    ))
    const { models } = await loadKeyedModels(OPENCODE, buildKeyedCredential({ apiKey: 'k', product: 'opencode', baseUrl: OPENCODE.baseUrl }), impl)
    // `gpt-5.5` 走 /responses，被下架。
    expect(models.map(m => m.id)).toEqual(['big-pickle'])
    expect(models[0]!.free).toBe(true)
  })

  it('非 2xx 抛带状态码的错误', async () => {
    const { impl } = makeFetch(() => new Response('{"error":{"message":"boom"}}', { status: 500 }))
    await expect(loadKeyedModels(COMMANDCODE, buildKeyedCredential({ apiKey: 'k', product: 'commandcode', baseUrl: COMMANDCODE.baseUrl }), impl))
      .rejects.toThrow(/500/)
  })

  it('非 JSON 响应抛可读错误（指向「不是 OpenAI 兼容接口」）', async () => {
    const { impl } = makeFetch(() => new Response('<html>nope</html>', { status: 200 }))
    await expect(loadKeyedModels(COMMANDCODE, buildKeyedCredential({ apiKey: 'k', product: 'commandcode', baseUrl: COMMANDCODE.baseUrl }), impl))
      .rejects.toThrow(/不是合法 JSON/)
  })
})

/** 内存凭据存储替身（`credentialRef(name)` 返回 `{ name }` 形态）。 */
class FakeCredentials {
  private readonly store = new Map<string, string>()
  async resolve(ref: unknown) {
    const value = this.store.get(keyOf(ref))
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: unknown) {
    const has = this.store.has(keyOf(ref))
    return { configured: has, source: has ? 'fake' : undefined, writable: true }
  }
  async set(ref: unknown, value: string) { this.store.set(keyOf(ref), value) }
  async unset(ref: unknown) { this.store.delete(keyOf(ref)) }
  raw(ref: string): string | undefined { return this.store.get(ref) }
}

/** 取凭据 ref 的键名。 */
function keyOf(ref: unknown): string {
  if (typeof ref === 'string') return ref
  if (ref !== null && typeof ref === 'object' && 'name' in ref) {
    return String((ref as { name: unknown }).name)
  }
  return String(ref)
}

/**
 * 构造一个 `KeyedAuth`。
 *
 * ⚠️ 必须用真的 `new Context()` 并 `provide('credentials')`：`Service` 基类
 * 在构造期就会 `ctx.provide(...)`，用普通对象替身会直接
 * `Cannot read properties of undefined (reading 'provide')`。
 */
function makeAuth(product: typeof COMMANDCODE, fetcher: typeof fetch) {
  const ctx = new Context()
  const credentials = new FakeCredentials()
  ctx.provide('credentials', credentials as never)
  const auth = new KeyedAuth(ctx, { product, fetcher })
  return { auth, credentials }
}

describe('KeyedAuth', () => {
  it('⚠️ validateApiKey 打 chat 端点而不是 /models', async () => {
    const { calls, impl } = makeFetch((url) => url.endsWith('/models')
      ? new Response(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }), { status: 200 })
      : new Response('{}', { status: 200 }))
    const { auth } = makeAuth(COMMANDCODE, impl)
    const result = await auth.validateApiKey('k')
    expect(result.ok).toBe(true)
    // 第一次必须是 chat（判成败），/models 只用于补模型数量。
    expect(calls[0]!.url).toMatch(/\/chat\/completions$/)
    expect(calls.map(c => c.url)).toContain('https://api.commandcode.ai/provider/v1/models')
    expect(result.models).toEqual(['a', 'b'])
  })

  it('⚠️ 无 Key 也返回 200 的 /models 不能判「有效」（这是本族的核心陷阱）', async () => {
    // 替身模拟真实平台：/models 对任何 Key 都 200，chat 端点才鉴权。
    const { impl } = makeFetch((url) => url.endsWith('/models')
      ? new Response(JSON.stringify({ data: [{ id: 'a' }] }), { status: 200 })
      : new Response('{"error":{"message":"Invalid token"}}', { status: 401 }))
    const { auth } = makeAuth(COMMANDCODE, impl)
    const result = await auth.validateApiKey('totally-bogus')
    expect(result.ok, '无效 Key 不该因为 /models 200 就判有效').toBe(false)
  })

  it('Key 校验失败时不拉目录（省一次请求）', async () => {
    const { calls, impl } = makeFetch(() => new Response('{"error":{"message":"nope"}}', { status: 401 }))
    const { auth } = makeAuth(COMMANDCODE, impl)
    const result = await auth.validateApiKey('bogus')
    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('⚠️ 目录拉取失败不影响 Key 有效性结论', async () => {
    const { impl } = makeFetch((url) => url.endsWith('/models')
      ? new Response('boom', { status: 500 })
      : new Response('{}', { status: 200 }))
    const { auth } = makeAuth(COMMANDCODE, impl)
    const result = await auth.validateApiKey('k')
    expect(result.ok).toBe(true)
    expect(result.models).toEqual([])
  })

  it('结构明显错误的 Key 在发请求前就被拦下', async () => {
    const { calls, impl } = makeFetch(() => new Response('{}', { status: 200 }))
    const { auth } = makeAuth(COMMANDCODE, impl)
    expect((await auth.validateApiKey('')).error).toMatch(/不能为空/)
    expect((await auth.validateApiKey('has space')).error).toMatch(/空格/)
    expect(calls).toHaveLength(0)
  })

  it('⚠️ 显式传 baseUrl 时以调用方为准（当前 RPC 层传产品表地址）', async () => {
    const { calls, impl } = makeFetch(() => new Response('{}', { status: 200 }))
    const { auth } = makeAuth(COMMANDCODE, impl)
    await auth.validateApiKey('k', 'https://alt.example/v1/')
    expect(calls[0]!.url).toBe('https://alt.example/v1/chat/completions')
  })

  it('persistApiKey 写入 JSON 凭据（product 与 base_url 都落盘）', async () => {
    const { impl } = makeFetch(() => new Response('{}', { status: 200 }))
    const { auth, credentials } = makeAuth(OPENCODE, impl)
    const credential = await auth.persistApiKey('OPENCODE_ACCOUNT_1', {
      apiKey: 'sk-abc',
      baseUrl: OPENCODE.baseUrl,
      models: ['a'],
      nickname: 'OpenCode Zen · -abc',
    })
    expect(credential.product).toBe('opencode')
    expect(credential.base_url).toBe('https://opencode.ai/zen/v1')
    expect(credentials.raw('OPENCODE_ACCOUNT_1')).toContain('"product":"opencode"')
  })

  it('⚠️ refreshAccountCredential 成功也**不改写**凭据（无 expires_in 可写）', async () => {
    const { impl } = makeFetch(() => new Response('{}', { status: 200 }))
    const { auth, credentials } = makeAuth(COMMANDCODE, impl)
    await auth.persistApiKey('R1', { apiKey: 'k', baseUrl: COMMANDCODE.baseUrl, nickname: 'n' })
    const before = credentials.raw('R1')
    await auth.refreshAccountCredential('R1')
    expect(credentials.raw('R1')).toBe(before)
  })

  it('refreshAccountCredential 在凭据缺失时报「请重新粘贴」', async () => {
    const { impl } = makeFetch(() => new Response('{}', { status: 200 }))
    const { auth } = makeAuth(COMMANDCODE, impl)
    await expect(auth.refreshAccountCredential('MISSING')).rejects.toThrow(/请重新粘贴/)
  })

  it('refreshAccountCredential 在 Key 失效时报「请重新粘贴」并带上原因', async () => {
    const { impl } = makeFetch((url) => url.endsWith('/models')
      ? new Response('{}', { status: 200 })
      : new Response('{"error":{"message":"Invalid token"}}', { status: 401 }))
    const { auth } = makeAuth(COMMANDCODE, impl)
    await auth.persistApiKey('R1', { apiKey: 'dead', baseUrl: COMMANDCODE.baseUrl })
    await expect(auth.refreshAccountCredential('R1')).rejects.toThrow(/已失效，请重新粘贴/)
  })

  it('refreshAll 是空操作（本族没有续期端点）', async () => {
    const { calls, impl } = makeFetch(() => new Response('{}', { status: 200 }))
    const { auth } = makeAuth(COMMANDCODE, impl)
    await auth.refreshAll({})
    expect(calls).toHaveLength(0)
  })

  it('productId 暴露产品 id（供分派层使用）', () => {
    const { impl } = makeFetch(() => new Response('{}', { status: 200 }))
    expect(makeAuth(OPENCODE, impl).auth.productId).toBe('opencode')
  })

  it('⚠️ fetchImpl 是 getter（构造后装上的 fetch 补丁仍生效）', async () => {
    // 写成字段默认值会把构造期的 fetch 冻进去，使宿主的补丁静默失效。
    const ctx = new Context()
    ctx.provide('credentials', new FakeCredentials() as never)
    const auth = new KeyedAuth(ctx, { product: COMMANDCODE })
    const original = globalThis.fetch
    const spy = vi.fn(async () => new Response('{}', { status: 200 }))
    globalThis.fetch = spy as unknown as typeof fetch
    try {
      await auth.validateApiKey('k')
      expect(spy).toHaveBeenCalled()
    } finally {
      globalThis.fetch = original
    }
  })
})
