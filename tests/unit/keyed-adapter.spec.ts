/**
 * `KeyedAdapter` 行为单测。
 *
 * 覆盖三类最容易出错的语义：
 *
 * 1. **免费标记只来自 id 后缀**（不能把「实测能调通」当成免费 —— 那是单个
 *    Key 的权益）；
 * 2. **目录自动刷新**（TTL / 账号指纹变更立即重拉 / 集合真变才广播 /
 *    失败保留旧目录）；
 * 3. **选号亲和性 + 账号池手动顺序**（不做任何重排，`AGENTS.md` 铁律）。
 */

import { describe, expect, it, vi } from 'vitest'
import { KeyedAdapter, isKeyedRotatableFailure, recordsKeyedRateLimit, registerKeyedLlm } from '../../src/keyed-adapter.js'
import { COMMANDCODE, OPENCODE } from '../../src/keyed-product.js'
import type { KeyedCredential, KeyedModelEntry } from '../../src/keyed.js'
import type { GenerateOptions, LlmModelInfo } from '@deepseek-ai/dsh-llm'

/** 造一份凭据。 */
function credential(product: string, key = 'k'): KeyedCredential {
  return {
    access_token: key,
    product,
    base_url: product === 'commandcode' ? COMMANDCODE.baseUrl : OPENCODE.baseUrl,
  }
}

/** 造一个只返回固定目录的 loader，并记录调用次数。 */
function makeLoader(models: readonly string[], options: { fail?: boolean } = {}) {
  const calls: string[] = []
  const loader = async ({ credential: cred }: { credential: KeyedCredential }) => {
    calls.push(cred.access_token)
    if (options.fail === true) throw new Error('boom')
    return {
      models: models.map(id => ({ id, free: /[-_:]free$/.test(id), endpoints: [] as readonly string[] })) as KeyedModelEntry[],
      warnings: [] as string[],
    }
  }
  return { calls, loader }
}

/** 构造适配器（默认单账号，无账号池）。 */
function makeAdapter(overrides: {
  product?: typeof COMMANDCODE
  models?: readonly string[]
  fail?: boolean
  loadModels?: (options: { credential: KeyedCredential }) => Promise<{ models: KeyedModelEntry[]; warnings: string[] }>
  accountPool?: never
  entries?: readonly { id: string; credentialRef: string }[]
  warn?: (message: string) => void
  onCatalogChanged?: () => void
} = {}) {
  const product = overrides.product ?? COMMANDCODE
  const { calls, loader } = makeLoader(overrides.models ?? ['a', 'b-free'], { fail: overrides.fail })
  const warnings: string[] = []
  const adapter = new KeyedAdapter({
    product,
    credentialRef: 'X' as never,
    resolveCredential: async () => credential(product.id),
    resolveCredentialForAccount: async () => credential(product.id),
    listAccountEntries: async () => overrides.entries ?? [],
    accountPool: overrides.accountPool,
    warn: overrides.warn ?? ((message: string) => { warnings.push(message) }),
    loadModels: overrides.loadModels ?? loader,
    ...overrides.onCatalogChanged === undefined ? {} : { onCatalogChanged: overrides.onCatalogChanged },
  })
  return { adapter, calls, warnings }
}

describe('KeyedAdapter 目录与展示名', () => {
  it('⚠️ 只有 id 后缀命中 free 的才标「（免费）」，其余保持裸 id', async () => {
    // 这条是用户可感知的核心：把「实测能调通」标成免费会误导别的账号。
    const { adapter } = makeAdapter({ models: ['glm-5.3', 'laguna-s-2.1-free', 'ling-3.1-flash:free'] })
    const models = await adapter.listModels('commandcode')
    expect(models.map(m => m.name)).toEqual(['glm-5.3', 'laguna-s-2.1-free（免费）', 'ling-3.1-flash:free（免费）'])
  })

  it('listAllModels 同样带免费角标（设置页要看到与 composer 一致的名字）', async () => {
    const { adapter } = makeAdapter({ models: ['a', 'b-free'] })
    await adapter.listModels('commandcode')
    expect(adapter.listAllModels()).toEqual([
      { id: 'a', name: 'a' },
      { id: 'b-free', name: 'b-free（免费）' },
    ])
  })

  it('providerInfo 用产品展示名，未知入参落回自己的 id', () => {
    const { adapter } = makeAdapter()
    expect(adapter.providerInfo('commandcode')).toEqual({ id: 'commandcode', name: 'Command Code' })
    expect(adapter.providerInfo('')).toEqual({ id: 'commandcode', name: 'Command Code' })
  })

  it('⚠️ 一律播报 text-only（两个平台的目录都没有多模态声明）', async () => {
    const { adapter } = makeAdapter()
    const models = await adapter.listModels('commandcode')
    for (const model of models as readonly LlmModelInfo[]) {
      expect(model.inputModalities).toEqual(['text'])
    }
  })

  it('resolveModel 不编造 reasoning / defaultMaxTokens / contextWindow', async () => {
    const { adapter } = makeAdapter()
    const resolved = await adapter.resolveModel('commandcode', 'glm-5.3')
    expect(resolved).toEqual({ provider: 'commandcode', id: 'glm-5.3', name: 'glm-5.3' })
  })
})

describe('KeyedAdapter 目录自动刷新', () => {
  it('TTL 内不重复拉取，超时后重拉', async () => {
    const now = { value: 1_000_000 }
    vi.spyOn(Date, 'now').mockImplementation(() => now.value)
    try {
      const { adapter, calls } = makeAdapter()
      await adapter.listModels('commandcode')
      expect(calls).toHaveLength(1)
      // TTL（5 分钟）内：不再请求。
      now.value += 60_000
      await adapter.listModels('commandcode')
      expect(calls).toHaveLength(1)
      // 超过 TTL：重拉。
      now.value += 5 * 60_000
      await adapter.listModels('commandcode')
      expect(calls).toHaveLength(2)
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('⚠️ 账号指纹变更时**立即**重拉（新贴一个 Key 不该等 5 分钟）', async () => {
    const entries: { id: string; credentialRef: string }[] = [{ id: 'a', credentialRef: 'r1' }]
    const seen: string[] = []
    const adapter = new KeyedAdapter({
      product: COMMANDCODE,
      credentialRef: 'X' as never,
      resolveCredential: async () => credential('commandcode'),
      resolveCredentialForAccount: async (id: string) => credential('commandcode', id),
      listAccountEntries: async () => entries,
      warn: () => {},
      loadModels: async ({ credential: cred }) => {
        seen.push(cred.access_token)
        return { models: [{ id: `m-${cred.access_token}`, free: false, endpoints: [] }], warnings: [] }
      },
    })
    await adapter.listModels('commandcode')
    expect(seen).toEqual(['a'])
    // 加一个账号 ⇒ 指纹变了 ⇒ 立刻重拉（不等 TTL）。
    entries.push({ id: 'b', credentialRef: 'r2' })
    await adapter.listModels('commandcode')
    expect(seen).toEqual(['a', 'a', 'b'])
  })

  it('⚠️ 只在模型集合**真的变了**（含 free 标记）时才广播', async () => {
    let models: KeyedModelEntry[] = [{ id: 'a', free: false, endpoints: [] }]
    const changed = vi.fn()
    const adapter = new KeyedAdapter({
      product: COMMANDCODE,
      credentialRef: 'X' as never,
      resolveCredential: async () => credential('commandcode'),
      listAccountEntries: async () => [],
      warn: () => {},
      loadModels: async () => ({ models, warnings: [] }),
      onCatalogChanged: changed,
    })
    await adapter.listModels('commandcode')
    // 首次建立目录也算「变化」。
    expect(changed).toHaveBeenCalledTimes(1)
    // 内容相同 ⇒ 不广播（否则每次 TTL 到期都会造成一次事件风暴）。
    await adapter.listAllModels()
    await adapter.listModels('commandcode')
    expect(changed).toHaveBeenCalledTimes(1)
    // id 集合不变但 free 标记变了 ⇒ 必须广播（否则「（免费）」角标永远刷不出来）。
    models = [{ id: 'a', free: true, endpoints: [] }]
    // ⚠️ 断言必须放在 `restoreAllMocks()` **之前**：`changed` 是 `vi.fn()`，
    // `vi.restoreAllMocks()` 会连它的调用记录一起清掉（读到 0 次，假红）。
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 10 * 60_000)
    let afterFreeFlip = 0
    try {
      await adapter.listModels('commandcode')
      afterFreeFlip = changed.mock.calls.length
    } finally {
      vi.restoreAllMocks()
    }
    expect(afterFreeFlip).toBe(2)
  })

  it('⚠️ 一次失败**保留旧目录**（网络抖动不该让模型全消失）', async () => {
    let shouldFail = false
    const adapter = new KeyedAdapter({
      product: COMMANDCODE,
      credentialRef: 'X' as never,
      resolveCredential: async () => credential('commandcode'),
      listAccountEntries: async () => [],
      warn: () => {},
      loadModels: async () => {
        if (shouldFail) throw new Error('network down')
        return { models: [{ id: 'stable', free: false, endpoints: [] }], warnings: [] }
      },
    })
    await adapter.listModels('commandcode')
    expect(adapter.listAllModels().map(m => m.id)).toEqual(['stable'])
    shouldFail = true
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 10 * 60_000)
    try {
      await adapter.listModels('commandcode')
    } finally {
      vi.restoreAllMocks()
    }
    expect(adapter.listAllModels().map(m => m.id)).toEqual(['stable'])
  })

  it('拉取失败只 warn 不抛（面板不该因为一个账号拉不到就整块报错）', async () => {
    const { adapter, warnings } = makeAdapter({ fail: true })
    await expect(adapter.listModels('commandcode')).resolves.toEqual([])
    expect(warnings.join('\n')).toMatch(/模型目录拉取失败/)
  })

  it('⚠️ 失败后 30 秒内不重试（避免每次面板刷新都打一遍网络）', async () => {
    const now = { value: 1_000_000 }
    vi.spyOn(Date, 'now').mockImplementation(() => now.value)
    try {
      const { adapter, calls } = makeAdapter({ fail: true })
      await adapter.listModels('commandcode')
      expect(calls).toHaveLength(1)
      now.value += 1_000
      await adapter.listModels('commandcode')
      expect(calls, '冷却期内不应重试').toHaveLength(1)
      now.value += 30_000
      await adapter.listModels('commandcode')
      expect(calls, '冷却过后应重试').toHaveLength(2)
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('目录变更回调抛错不会反噬目录本身', async () => {
    const { adapter, warnings } = makeAdapter({
      onCatalogChanged: () => { throw new Error('listener exploded') },
    })
    const models = await adapter.listModels('commandcode')
    expect(models.length).toBeGreaterThan(0)
    expect(warnings.join('\n')).toMatch(/目录变更通知失败/)
  })
})

describe('KeyedAdapter 选号', () => {
  it('⚠️ 按账号池手动顺序选号，且优先选「模型集含该模型」的账号', async () => {
    const sent: string[] = []
    const adapter = new KeyedAdapter({
      product: COMMANDCODE,
      credentialRef: 'X' as never,
      resolveCredential: async () => credential('commandcode'),
      resolveCredentialForAccount: async (id: string) => credential('commandcode', id),
      listAccountEntries: async () => [{ id: 'only-b', credentialRef: 'r1' }, { id: 'has-a', credentialRef: 'r2' }],
      warn: () => {},
      loadModels: async ({ credential: cred }) => ({
        models: [{ id: cred.access_token === 'has-a' ? 'model-a' : 'model-b', free: false, endpoints: [] }],
        warnings: [],
      }),
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string }
        sent.push(`${new URL(String(url)).host} ${String(body.model)} ${(init?.headers as Record<string, string>).Authorization}`)
        return sseResponse('hello')
      }) as typeof fetch,
    })
    // 先建立 per-account 模型集。
    await adapter.listModels('commandcode')
    // 请求 model-a：第一个账号（only-b）不含它，应跳到 has-a。
    const options = generateOptions('model-a')
    for await (const _chunk of adapter.stream(options)) { /* 消费完 */ }
    expect(sent[0]).toContain('Bearer has-a')
  })

  it('⚠️ 模型集未知时保守放行（目录拉挂不该让整个 provider 不可用）', async () => {
    const sent: string[] = []
    const adapter = new KeyedAdapter({
      product: COMMANDCODE,
      credentialRef: 'X' as never,
      resolveCredential: async () => credential('commandcode'),
      resolveCredentialForAccount: async (id: string) => credential('commandcode', id),
      listAccountEntries: async () => [{ id: 'first', credentialRef: 'r1' }],
      warn: () => {},
      loadModels: async () => { throw new Error('directory down') },
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        sent.push((init?.headers as Record<string, string>).Authorization)
        return sseResponse('ok')
      }) as typeof fetch,
    })
    for await (const _chunk of adapter.stream(generateOptions('anything'))) { /* 消费完 */ }
    expect(sent).toEqual(['Bearer first'])
  })

  it('无凭据时抛 MISSING_CREDENTIAL', async () => {
    const adapter = new KeyedAdapter({
      product: COMMANDCODE,
      credentialRef: 'X' as never,
      resolveCredential: async () => undefined,
      listAccountEntries: async () => [],
      warn: () => {},
      loadModels: async () => ({ models: [], warnings: [] }),
    })
    await expect(async () => {
      for await (const _chunk of adapter.stream(generateOptions('m'))) { /* noop */ }
    }).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })
})

describe('KeyedAdapter 请求体与错误分类', () => {
  it('⚠️ 把 maxTokens 收进 32k 上限（实测上游对超大 max_output_tokens 回 400）', async () => {
    let captured: Record<string, unknown> = {}
    const adapter = new KeyedAdapter({
      product: COMMANDCODE,
      credentialRef: 'X' as never,
      resolveCredential: async () => credential('commandcode'),
      listAccountEntries: async () => [],
      warn: () => {},
      loadModels: async () => ({ models: [], warnings: [] }),
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        captured = JSON.parse(String(init?.body)) as Record<string, unknown>
        return sseResponse('x')
      }) as typeof fetch,
    })
    for await (const _chunk of adapter.stream(generateOptions('m', { maxTokens: 999_999 }))) { /* 消费完 */ }
    expect(captured.max_tokens).toBe(32_768)
    // 非法值一律不发该字段（不发 ≠ 发 0）。
    for await (const _chunk of adapter.stream(generateOptions('m', { maxTokens: 0 }))) { /* 消费完 */ }
    expect(captured).not.toHaveProperty('max_tokens')
  })

  it('图片输入直接拒绝（本族未声明图片能力）', async () => {
    const adapter = new KeyedAdapter({
      product: COMMANDCODE,
      credentialRef: 'X' as never,
      resolveCredential: async () => credential('commandcode'),
      listAccountEntries: async () => [],
      warn: () => {},
      loadModels: async () => ({ models: [], warnings: [] }),
    })
    // ⚠️ `collectImages` 认的是 `attachment.attachmentId`（见 openai-compat.ts），
    // 造测试数据必须照它的形状，否则图片根本没被识别、断言测的是别的东西。
    const options = {
      ...generateOptions('m'),
      messages: [{
        role: 'user',
        content: [{ type: 'image', attachment: { attachmentId: 'att-1' } }],
      }],
    } as unknown as GenerateOptions
    await expect(async () => {
      for await (const _chunk of adapter.stream(options)) { /* noop */ }
    }).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })

  it('⚠️ 401 不算可换号失败（无效 Key 换号也救不了，且不该写限流表）', () => {
    expect(isKeyedRotatableFailure(401, 'Unauthorized')).toBe(false)
    expect(recordsKeyedRateLimit(401)).toBe(false)
  })

  it('429 / 402 或额度文案算可换号失败', () => {
    expect(isKeyedRotatableFailure(429, '')).toBe(true)
    expect(isKeyedRotatableFailure(402, '')).toBe(true)
    expect(isKeyedRotatableFailure(400, 'insufficient balance')).toBe(true)
    expect(isKeyedRotatableFailure(400, '额度不足')).toBe(true)
    expect(isKeyedRotatableFailure(400, 'invalid model')).toBe(false)
    expect(recordsKeyedRateLimit(429)).toBe(true)
    expect(recordsKeyedRateLimit(402)).toBe(true)
  })

  it('非鉴权类错误按原状态码抛（保留上游错误码便于排查）', async () => {
    const adapter = new KeyedAdapter({
      product: COMMANDCODE,
      credentialRef: 'X' as never,
      resolveCredential: async () => credential('commandcode'),
      listAccountEntries: async () => [],
      warn: () => {},
      loadModels: async () => ({ models: [], warnings: [] }),
      fetchImpl: (async () => new Response('{"error":{"message":"model not found"}}', { status: 400 })) as typeof fetch,
    })
    await expect(async () => {
      for await (const _chunk of adapter.stream(generateOptions('nope'))) { /* noop */ }
    }).rejects.toThrow(/model not found/)
  })
})

describe('registerKeyedLlm', () => {
  it('按产品注册 provider 与 settings namespace', () => {
    const registered: unknown[] = []
    const providers: unknown[] = []
    const ctx = {
      llm: {
        registerConfigurableProviders: (list: unknown[]) => { providers.push(...list) },
        registerAdapter: (ids: readonly string[], adapter: unknown) => { registered.push({ ids, adapter }) },
      },
      schema: { get: () => undefined },
    }
    const adapter = registerKeyedLlm(ctx as never, {
      product: OPENCODE,
      credentialRef: 'X' as never,
      resolveCredential: async () => undefined,
      warn: () => {},
    })
    expect(providers).toEqual([{
      provider: 'opencode-zen',
      displayName: 'OpenCode Zen',
      settingsNs: 'llm-opencode-zen',
      settingsPath: [],
    }])
    expect(registered).toEqual([{ ids: ['opencode-zen'], adapter }])
  })

  it('⚠️ 当 ctx.llm.registerConfigurableProviders 抛错时捕获并记录日志，不阻断插件启动', () => {
    const warns: string[] = []
    const registered: unknown[] = []
    const ctx = {
      llm: {
        registerConfigurableProviders: () => {
          throw new Error('configurable provider "opencode-zen" is already declared')
        },
        registerAdapter: (ids: readonly string[], adapter: unknown) => { registered.push({ ids, adapter }) },
      },
      schema: { get: () => undefined },
    }
    expect(() => registerKeyedLlm(ctx as never, {
      product: OPENCODE,
      credentialRef: 'X' as never,
      resolveCredential: async () => undefined,
      warn: (msg) => warns.push(msg),
    })).not.toThrow()
    expect(warns.length).toBe(1)
    expect(warns[0]).toContain('configurable provider opencode-zen')
    expect(registered.length).toBe(1)
  })
})

/** 造一个最小 SSE 响应（一帧正文 + 结束）。 */
function sseResponse(text: string): Response {
  const body = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
    'data: [DONE]',
    '',
  ].join('\n')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** 造最小 `GenerateOptions`。 */
function generateOptions(model: string, extra: { maxTokens?: number } = {}): GenerateOptions {
  return {
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    ...extra.maxTokens === undefined ? {} : { maxTokens: extra.maxTokens },
  } as unknown as GenerateOptions
}
