import { describe, expect, it, vi } from 'vitest'
import {
  ByokAdapter,
  isByokRotatableFailure,
  loadByokModels,
  recordsByokRateLimit,
  type ByokAdapterOptions,
} from '../../src/byok-adapter.js'
import { buildByokCredential, type ByokCredential } from '../../src/byok.js'
import { BYOK } from '../../src/byok-product.js'
import { LlmError } from '@deepseek-ai/dsh-llm'

/**
 * `ByokAdapter` 的行为测试。
 *
 * 全程离线：目录加载用 `loadModels` 覆盖，网络用 `fetchImpl` 覆盖。
 *
 * ⚠️ 本适配器与其余 13 个 provider 的本质区别决定了测试重点：
 * 它**不做续期重试**（401/403 如实报错）、**不声明** `defaultMaxTokens` /
 * `reasoning` / `inputModalities`（`/models` 不含这些信息，编造会让整轮对话
 * 起不来或让上游拒收），且**模型目录按账号亲和性选号**。
 */

const cred: ByokCredential = buildByokCredential({
  apiKey: 'sk-test-key',
  platform: 'zhipu',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  models: ['glm-4.6'],
})

/** 构造适配器（默认注入凭据 + 固定目录，完全离线）。 */
function makeAdapter(overrides: Partial<ByokAdapterOptions> = {}): ByokAdapter {
  return new ByokAdapter({
    credentialRef: { name: BYOK.defaultCredentialRef } as never,
    resolveCredential: async () => cred,
    loadModels: async () => ({ models: [{ id: 'glm-4.6' }, { id: 'glm-4.5' }], warnings: [] }),
    // 告警出口是必填项：默认吞掉，需要断言的用例用 overrides 覆盖。
    warn: () => {},
    ...overrides,
  })
}

/** 标准 OpenAI SSE 帧。 */
function sseResponse(frames: string[]): Response {
  return new Response(frames.map(f => `data: ${f}\n\n`).join('') + 'data: [DONE]\n\n', {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

/** 收集一次 stream 的全部 chunk。 */
async function collect(
  adapter: ByokAdapter,
  options: Record<string, unknown> = {},
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const chunk of adapter.stream({
    model: 'glm-4.6',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    ...options,
  } as never)) {
    out.push(chunk as unknown as Record<string, unknown>)
  }
  return out
}

describe('ByokAdapter 模型目录', () => {
  it('listAllModels 同步返回（设置页契约），首次调用触发异步加载', async () => {
    const adapter = makeAdapter()
    // 首次调用：远端还没拉到，返回空表但已启动加载。
    expect(adapter.listAllModels()).toEqual([])
    await adapter.listModels(BYOK.id)
    expect(adapter.listAllModels()).toEqual([
      { id: 'glm-4.6', name: 'glm-4.6' },
      { id: 'glm-4.5', name: 'glm-4.5' },
    ])
  })

  it('listModels 播报 text-only 输入能力（无法判定多模态 ⇒ 按负能力处理）', async () => {
    const adapter = makeAdapter()
    const models = await adapter.listModels(BYOK.id)
    expect(models).toHaveLength(2)
    for (const model of models) {
      expect(model.inputModalities).toEqual(['text'])
    }
  })

  it('⚠️ resolveModel 不声明 defaultMaxTokens / reasoning / context（远端无此信息）', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel(BYOK.id, 'glm-4.6')
    expect(resolved).toEqual({ provider: BYOK.id, id: 'glm-4.6', name: 'glm-4.6' })
    // 声明 `defaultMaxTokens: 0` / 负数会让 DSH 抛 INVALID_MODEL_MAX_TOKENS。
    expect(resolved).not.toHaveProperty('defaultMaxTokens')
    expect(resolved).not.toHaveProperty('reasoning')
    expect(resolved).not.toHaveProperty('context')
  })

  it('并发调用共享同一个 in-flight 加载（不重复请求远端）', async () => {
    let calls = 0
    const adapter = makeAdapter({
      loadModels: async () => {
        calls += 1
        return { models: [{ id: 'm' }], warnings: [] }
      },
    })
    await Promise.all([adapter.listModels(BYOK.id), adapter.listModels(BYOK.id)])
    expect(calls).toBe(1)
  })

  it('单账号目录拉取失败只警告，不阻塞其余账号（一个 Key 贴错不该清空整个面板）', async () => {
    const warn = vi.fn()
    const adapter = makeAdapter({
      listAccountEntries: async () => [
        { id: 'byok-bad', credentialRef: 'BYOK_ACCOUNT_BAD' },
        { id: 'byok-ok', credentialRef: 'BYOK_ACCOUNT_OK' },
      ],
      resolveCredentialForAccount: async (accountId) => (accountId === 'byok-bad' ? undefined : cred),
      loadModels: async () => ({ models: [{ id: 'glm-4.6' }], warnings: [] }),
      warn,
    })
    // byok-bad 解析不出凭据 ⇒ 被跳过，不影响结果。
    expect(await adapter.listModels(BYOK.id)).toHaveLength(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('目录全部拉取失败时不缓存，但会进入冷却（不是永久空表，也不是每渲染一次打一轮）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const warn = vi.fn()
      let calls = 0
      const adapter = makeAdapter({
        loadModels: async () => {
          calls += 1
          throw new Error('boom')
        },
        warn,
      })
      expect(await adapter.listModels(BYOK.id)).toEqual([])
      expect(calls).toBe(1)
      // ⚠️ 冷却期内不再打网络：没有它，面板每渲染一次就是一轮请求。
      expect(await adapter.listModels(BYOK.id)).toEqual([])
      expect(calls).toBe(1)
      // 冷却过去后重试 —— 不是「失败了就永久空表」。
      vi.setSystemTime(Date.now() + 30_000 + 1)
      expect(await adapter.listModels(BYOK.id)).toEqual([])
      expect(calls).toBe(2)
      // ⚠️ 失败必须留下痕迹：走注入的 `warn`（宿主 `ctx.logger`），
      // 而不是 `console.warn`（棘轮基线只可下调、且没有宿主上下文）。
      expect(warn).toHaveBeenCalled()
      expect(String(warn.mock.calls[0]?.[0])).toContain('模型目录拉取失败')
    } finally {
      vi.useRealTimers()
    }
  })

  it('没有已登录账号时目录为空（门控），且不消耗一次远端请求', async () => {
    let calls = 0
    const adapter = makeAdapter({
      accountPool: {
        hasLoggedInAccount: async () => false,
        disabledModelsFor: () => undefined,
      } as never,
      loadModels: async () => {
        calls += 1
        return { models: [{ id: 'm' }], warnings: [] }
      },
    })
    expect(await adapter.listModels(BYOK.id)).toEqual([])
    expect(calls).toBe(0)
  })
})

describe('ByokAdapter 目录自动刷新', () => {
  /**
   * ⚠️ 这一组是 BYOK 与其余 13 个 provider 的**有意差异**：
   * cline / buddy / trae / lobsterai 都是「首个成功结果永久缓存」，
   * BYOK 不能 —— 它的目录有两个随时会变的来源：
   *
   * 1. 平台自己上新模型（智谱一年内从 glm-4.5 走到 glm-5.3 一整代）；
   * 2. **用户在插件里新增 / 删除账号**（第二个账号往往指向另一个平台）。
   *
   * 缓存策略三档：TTL 内命中缓存；指纹变化（增删账号 / 换端点）**立即**重拉；
   * 集合真的变了才广播 `llm/adapters-updated`（否则客户端仍要重启才看得到）。
   */
  it('TTL 内重复读取不打网络，过期后自动重拉（平台上新的模型会自己出现）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      let calls = 0
      let ids = ['glm-4.5']
      const adapter = makeAdapter({
        loadModels: async () => {
          calls += 1
          return { models: ids.map(id => ({ id })), warnings: [] }
        },
      })
      expect(await adapter.listModels(BYOK.id)).toHaveLength(1)
      expect(calls).toBe(1)
      // TTL 内：命中缓存，一次网络都不打。
      expect(await adapter.listModels(BYOK.id)).toHaveLength(1)
      expect(calls).toBe(1)
      // 平台上了新模型，时间推进过一个 TTL。
      ids = ['glm-4.5', 'glm-5.3']
      vi.setSystemTime(Date.now() + 5 * 60_000 + 1)
      expect(await adapter.listModels(BYOK.id)).toHaveLength(2)
      expect(calls).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('⚠️ 新增账号时指纹变化 ⇒ 立即重拉，**不受 TTL 限制**（时间不推进也要刷新）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const accounts: Array<{ id: string; credentialRef: string }> = [
        { id: 'byok-a', credentialRef: 'BYOK_ACCOUNT_A' },
      ]
      let calls = 0
      const adapter = makeAdapter({
        listAccountEntries: async () => accounts,
        resolveCredentialForAccount: async (accountId) => buildByokCredential({
          apiKey: 'key-x',
          platform: 'custom',
          baseUrl: accountId === 'byok-a' ? 'https://a.example/v1' : 'https://b.example/v1',
        }),
        loadModels: async ({ credential }) => {
          calls += 1
          // 每个平台给一组自己的模型：新增账号后并集必须变长。
          return {
            models: [{ id: credential.base_url.includes('a.example') ? 'model-a' : 'model-b' }],
            warnings: [],
          }
        },
      })
      expect(await adapter.listModels(BYOK.id)).toHaveLength(1)
      expect(calls).toBe(1)
      // 时间**完全没推进**：TTL 内本应命中缓存。
      expect(await adapter.listModels(BYOK.id)).toHaveLength(1)
      expect(calls).toBe(1)
      // 用户又贴了一个别的平台的 Key ⇒ 新账号的模型必须立刻出现。
      accounts.push({ id: 'byok-b', credentialRef: 'BYOK_ACCOUNT_B' })
      expect(await adapter.listModels(BYOK.id)).toHaveLength(2)
      expect(calls).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('onCatalogChanged 只在模型 id 集合真的变化时触发（不是每次重拉都触发）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const onCatalogChanged = vi.fn()
      const ids = ['glm-4.5']
      const adapter = makeAdapter({
        loadModels: async () => ({ models: ids.map(id => ({ id })), warnings: [] }),
        onCatalogChanged,
      })
      await adapter.listModels(BYOK.id)
      expect(onCatalogChanged).toHaveBeenCalledTimes(1)
      // 缓存命中：没有重拉，自然没有通知。
      await adapter.listModels(BYOK.id)
      expect(onCatalogChanged).toHaveBeenCalledTimes(1)
      // 重拉了但集合没变 ⇒ **不通知**（否则 TTL 到点就是一轮无意义的事件风暴）。
      vi.setSystemTime(Date.now() + 5 * 60_000 + 1)
      await adapter.listModels(BYOK.id)
      expect(onCatalogChanged).toHaveBeenCalledTimes(1)
      ids.push('glm-5.3')
      vi.setSystemTime(Date.now() + 5 * 60_000 + 1)
      await adapter.listModels(BYOK.id)
      expect(onCatalogChanged).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('⚠️ 重拉失败时保留旧目录（一次网络抖动不该让选择器里的模型全没了）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const warn = vi.fn()
      let failing = false
      const adapter = makeAdapter({
        loadModels: async () => {
          if (failing) throw new Error('boom')
          return { models: [{ id: 'glm-4.5' }], warnings: [] }
        },
        warn,
      })
      expect(await adapter.listModels(BYOK.id)).toHaveLength(1)
      failing = true
      vi.setSystemTime(Date.now() + 5 * 60_000 + 1)
      expect(await adapter.listModels(BYOK.id)).toHaveLength(1)
      expect(warn).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('目录变更通知本身抛异常时不反噬目录（只警告）', async () => {
    const warn = vi.fn()
    const adapter = makeAdapter({
      loadModels: async () => ({ models: [{ id: 'glm-4.5' }], warnings: [] }),
      onCatalogChanged: () => {
        throw new Error('emit failed')
      },
      warn,
    })
    expect(await adapter.listModels(BYOK.id)).toHaveLength(1)
    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls[0]?.[0])).toContain('目录变更通知失败')
  })
})

describe('ByokAdapter 请求构造', () => {
  it('请求打在凭据自己的 base_url 上（每个账号可指向不同平台）', async () => {
    let url = ''
    const adapter = makeAdapter({
      fetchImpl: (async (input: string | URL) => {
        url = String(input)
        return sseResponse(['{"choices":[{"delta":{"content":"hi"}}]}'])
      }) as unknown as typeof fetch,
    })
    await collect(adapter)
    expect(url).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions')
  })

  it('请求体是标准 OpenAI 形态：model / messages / stream，max_tokens 只在有值时下发', async () => {
    let body: Record<string, unknown> = {}
    const adapter = makeAdapter({
      fetchImpl: (async (_input: string, init: RequestInit) => {
        body = JSON.parse(String(init.body)) as Record<string, unknown>
        return sseResponse(['{"choices":[{"delta":{"content":"hi"}}]}'])
      }) as unknown as typeof fetch,
    })
    await collect(adapter, { system: 'be terse', temperature: 0.5, stop: ['\n\n'] })
    expect(body.model).toBe('glm-4.6')
    expect(body.stream).toBe(true)
    expect(body.temperature).toBe(0.5)
    expect(body.stop).toEqual(['\n\n'])
    // system 被并进 messages 首条（OpenAI 兼容端点无独立 system 字段）。
    expect((body.messages as Array<{ role: string }>)[0].role).toBe('system')
    // ⚠️ 未给 maxTokens 就**不发**该字段，不编造数值。
    expect(body).not.toHaveProperty('max_tokens')
  })

  it('max_tokens 做了取整与上限截断，非法值一律不发', async () => {
    const capture = async (maxTokens: number | undefined): Promise<Record<string, unknown>> => {
      let body: Record<string, unknown> = {}
      const adapter = makeAdapter({
        fetchImpl: (async (_input: string, init: RequestInit) => {
          body = JSON.parse(String(init.body)) as Record<string, unknown>
          return sseResponse(['{"choices":[{"delta":{"content":"hi"}}]}'])
        }) as unknown as typeof fetch,
      })
      await collect(adapter, { maxTokens })
      return body
    }
    expect((await capture(100)).max_tokens).toBe(100)
    expect((await capture(100.7)).max_tokens).toBe(100)
    expect((await capture(10_000_000)).max_tokens).toBe(32_768)
    expect(await capture(0)).not.toHaveProperty('max_tokens')
    expect(await capture(-5)).not.toHaveProperty('max_tokens')
    expect(await capture(Number.NaN)).not.toHaveProperty('max_tokens')
    expect(await capture(Number.POSITIVE_INFINITY)).not.toHaveProperty('max_tokens')
  })

  it('tools 转成 OpenAI function 形态', async () => {
    let body: Record<string, unknown> = {}
    const adapter = makeAdapter({
      fetchImpl: (async (_input: string, init: RequestInit) => {
        body = JSON.parse(String(init.body)) as Record<string, unknown>
        return sseResponse(['{"choices":[{"delta":{"content":"hi"}}]}'])
      }) as unknown as typeof fetch,
    })
    await collect(adapter, {
      tools: [{ name: 'get_weather', description: 'w', parameters: { type: 'object', properties: {} } }],
    })
    expect(body.tools).toEqual([{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'w',
        parameters: { type: 'object', properties: {} },
      },
    }])
  })

  it('⚠️ 出现图片时明确报 UNSUPPORTED_CONTENT（而不是静默丢弃）', async () => {
    const adapter = makeAdapter()
    await expect(collect(adapter, {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png' } },
        ],
      }],
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })

  it('凭据缺失时抛 MISSING_CREDENTIAL', async () => {
    const adapter = makeAdapter({ resolveCredential: async () => undefined })
    await expect(collect(adapter)).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })
})

describe('ByokAdapter 失败与换号', () => {
  it('⚠️ 401 不会「先续期再重试」—— 直接如实报错（Key 无法续期，重试是白跑）', async () => {
    let refreshCalls = 0
    let sends = 0
    const adapter = makeAdapter({
      refresh: async () => { refreshCalls += 1 },
      fetchImpl: (async () => {
        sends += 1
        return new Response('{"error":{"message":"invalid api key"}}', { status: 401 })
      }) as unknown as typeof fetch,
    })
    await expect(collect(adapter)).rejects.toMatchObject({
      code: 'AUTH',
      // ⚠️ `status` 不在 Error 自身，而在 `failure` 上（`LlmError` 会把可序列化
      // 事实冻结进 `failure`，DSH 的重试策略读的就是它）。
      failure: { code: 'AUTH', status: 401 },
    })
    expect(sends).toBe(1)
    // refresh 只在「凭据缺失/已过期」时调用，401 不触发。
    expect(refreshCalls).toBe(0)
  })

  it('限流（429）且池中还有别的账号时换号重试', async () => {
    const used: string[] = []
    const adapter = makeAdapter({
      listAccountEntries: async () => [
        { id: 'byok-a', credentialRef: 'BYOK_ACCOUNT_A' },
        { id: 'byok-b', credentialRef: 'BYOK_ACCOUNT_B' },
      ],
      resolveCredentialForAccount: async (accountId) => buildByokCredential({
        apiKey: accountId === 'byok-a' ? 'key-a' : 'key-b',
        platform: 'custom',
        baseUrl: 'https://a.example/v1',
      }),
      accountPool: {
        disabledModelsFor: () => undefined,
        updateModelRateLimit: async () => {},
      } as never,
      fetchImpl: (async (_input: string, init: RequestInit) => {
        const key = /Bearer (\S+)/.exec(String((init.headers as Record<string, string>).Authorization))?.[1]
        used.push(key ?? '')
        if (key === 'key-a') return new Response('{"error":{"message":"rate limit exceeded"}}', { status: 429 })
        return sseResponse(['{"choices":[{"delta":{"content":"ok"}}]}'])
      }) as unknown as typeof fetch,
    })
    const chunks = await collect(adapter)
    expect(used).toEqual(['key-a', 'key-b'])
    expect(chunks.length).toBeGreaterThan(0)
  })

  it('所有账号都限流时抛 QUOTA_EXCEEDED', async () => {
    const adapter = makeAdapter({
      listAccountEntries: async () => [
        { id: 'byok-a', credentialRef: 'BYOK_ACCOUNT_A' },
        { id: 'byok-b', credentialRef: 'BYOK_ACCOUNT_B' },
      ],
      resolveCredentialForAccount: async () => cred,
      accountPool: {
        disabledModelsFor: () => undefined,
        updateModelRateLimit: async () => {},
      } as never,
      fetchImpl: (async () => new Response('{"error":{"message":"rate limit"}}', { status: 429 })) as unknown as typeof fetch,
    })
    await expect(collect(adapter)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
  })

  it('非限流的 4xx 不换号，直接报出远端错误明细', async () => {
    let sends = 0
    const adapter = makeAdapter({
      fetchImpl: (async () => {
        sends += 1
        return new Response('{"error":{"message":"model not found"}}', { status: 404 })
      }) as unknown as typeof fetch,
    })
    const error = await collect(adapter).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LlmError)
    // 非标准状态码由 `httpErrorCode` 回落成 `HTTP_<status>`，明细取自远端报文。
    expect((error as LlmError).code).toBe('HTTP_404')
    expect((error as LlmError).message).toContain('model not found')
    expect(sends).toBe(1)
  })

  it('网络失败映射为 TRANSPORT 错误（可重试）', async () => {
    const adapter = makeAdapter({
      fetchImpl: (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch,
    })
    await expect(collect(adapter)).rejects.toMatchObject({ code: 'TRANSPORT' })
  })

  it('调用方主动取消时原样抛出（不包装成 TRANSPORT，避免误重试）', async () => {
    const controller = new AbortController()
    const adapter = makeAdapter({
      fetchImpl: (async () => {
        controller.abort()
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch,
    })
    await expect(collect(adapter, { signal: controller.signal })).rejects.toThrow(TypeError)
  })
})

describe('ByokAdapter 换号判据', () => {
  it('isByokRotatableFailure：429 / 402 一律可换号', () => {
    expect(isByokRotatableFailure(429, '')).toBe(true)
    expect(isByokRotatableFailure(402, '')).toBe(true)
  })

  it('isByokRotatableFailure：中英文额度文案命中即可换号', () => {
    for (const body of [
      'insufficient balance',
      'quota exceeded',
      'too many requests',
      '余额不足',
      '额度不足',
      '频率限制',
    ]) {
      expect(isByokRotatableFailure(400, body), body).toBe(true)
    }
    expect(isByokRotatableFailure(400, 'model not found')).toBe(false)
  })

  it('⚠️ recordsByokRateLimit 只认 429 / 402（徽章含义是「受限」而不是「出过错」）', () => {
    expect(recordsByokRateLimit(429)).toBe(true)
    expect(recordsByokRateLimit(402)).toBe(true)
    // 文案命中但状态码是 400：可换号，但不点亮「限额重置」徽章。
    expect(recordsByokRateLimit(400)).toBe(false)
    expect(recordsByokRateLimit(500)).toBe(false)
  })
})

describe('loadByokModels', () => {
  const fetcher = (status: number, body: string): typeof fetch =>
    (async () => new Response(body, { status })) as unknown as typeof fetch

  it('2xx 且是 JSON 时返回模型列表', async () => {
    const loaded = await loadByokModels(cred, fetcher(200, '{"data":[{"id":"glm-4.6"}]}'))
    expect(loaded.models).toEqual([{ id: 'glm-4.6' }])
  })

  it('非 2xx 时抛出「状态码 + 远端明细」的文案（要能直接给用户看）', async () => {
    await expect(loadByokModels(cred, fetcher(401, '{"error":{"message":"invalid api key"}}')))
      .rejects.toThrow(/401.*invalid api key/)
  })

  it('非 2xx 且无报文时回落到「（无报文）」而不是空串', async () => {
    await expect(loadByokModels(cred, fetcher(500, '')))
      .rejects.toThrow('500 （无报文）')
  })

  it('⚠️ 2xx 但不是 JSON 时给出「可能不是 OpenAI 兼容接口」的定向提示', async () => {
    await expect(loadByokModels(cred, fetcher(200, '<html>not an api</html>')))
      .rejects.toThrow('模型目录不是合法 JSON（该端点可能不是 OpenAI 兼容接口）')
  })

  it('请求打在 {base_url}/models 上，并带 Bearer 头', async () => {
    let url = ''
    let auth = ''
    const adapter = (async (input: string, init: RequestInit) => {
      url = input
      auth = String((init.headers as Record<string, string>).Authorization)
      return new Response('{"data":[{"id":"m"}]}', { status: 200 })
    }) as unknown as typeof fetch
    await loadByokModels(cred, adapter)
    expect(url).toBe('https://open.bigmodel.cn/api/paas/v4/models')
    expect(auth).toBe('Bearer sk-test-key')
  })
})
