/**
 * 「粘贴 API Key」族 provider 的 LLM 适配器（`commandcode` / `opencode`）。
 *
 * ## 为什么独立一套而不是复用既有适配器
 *
 * 本族的协议层（消息序列化 / SSE 消费 / 错误归类）**完全复用**
 * `src/openai-compat.ts` —— 与 cline / qoder / loomy / raccoon 同做法。
 * 差异只有两处：
 *
 * 1. **凭据是用户粘贴的 API Key**：账号池里可能有多个 Key（多个账号共享额度），
 *    故 `base_url` 从**账号凭据**取（同一产品下用户可粘贴多个 Key）。
 * 2. **模型目录是各账号的并集**：每个 Key 的权益不同（实测 Command Code
 *    同一个模型 id 在一个 Key 上 200、在另一个 Key 上 403），目录必须合并播报。
 *
 * ## 「免费」怎么标（⚠️ 与用户预期直接相关）
 *
 * 两个平台的目录端点都**不下发任何价格字段**，因此「免费」只能靠
 * **模型 id 名字后缀**（`-free` / `:free` / `_free`）判定。
 *
 * ⚠️ **绝不能把「实测 200」写成免费标签** —— 那是**单个 Key 的权益**，
 * 不是平台公开事实。Command Code 上这个 Key 有 55 个模型能调通，但其中 52 个
 * 不带 `free` 后缀（deepseek / Kimi / GLM / Qwen …），换一个账号很可能 403。
 * 把它们标成「免费」会让别的用户在计费模型上毫无防备。
 *
 * 故本适配器只标后缀命中的模型，其余一律「未知」——
 * 与 `AGENTS.md` 的「无标记的语义是未知，绝不能反推」一致。
 *
 * ## 不播报的两种能力（宁缺毋滥）
 *
 * - **图片输入**：两个平台的 `/models` 不含多模态声明 ⇒ 一律按**文本**播报，
 *   让 DSH 把图片投影成文本占位符，绝不出现「声明支持却发出去 400」。
 * - **思考强度**：两个平台都不接受 `reasoning_effort`，不播报即永不注入。
 */

import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AccountPool, providerCatalogVisible } from './account-pool.js'
import { settingsNamespaceFor } from './settings-compat.js'
import type { Context } from '@deepseek-ai/cordis'
import {
  buildKeyedNickname,
  isKeyedExpired,
  keyedHeaders,
  type KeyedCredential,
  type KeyedModelEntry,
} from './keyed.js'
import { loadKeyedModels } from './keyed-auth.js'
import { keyedChatUrl, type KeyedProduct } from './keyed-product.js'
import {
  collectImages,
  consumeOpenAiSse,
  errorDetail,
  httpErrorCode,
  isTransportError,
  serializeMessages,
} from './openai-compat.js'

/** 换号次数上限（对齐 buddy / lobsterai / cline / trae 的 `MaxRotate = 3`）。 */
const KEYED_MAX_ROTATE = 3

/**
 * 输出上限兜底。
 *
 * ⚠️ 本族 `/models` 不下发 `maxOutputTokens`，不做兜底的话
 * DSH 注入的 `maxTokens` 会原样透传，而第三方网关对此非常敏感 ——
 * 实测 Command Code 的 `gpt-6-luna` 系列直接回
 * `400 Invalid 'max_output_tokens'`。32k 是保守上限。
 */
const KEYED_MAX_OUTPUT_TOKENS = 32_768

/** 目录缓存有效期（5 分钟）。 */
const KEYED_MODELS_TTL_MS = 5 * 60_000

/** 目录拉取失败后的冷却时间（30 秒）。 */
const KEYED_MODELS_RETRY_MS = 30_000

/** 限流标记的兜底时长（1 小时）。 */
const KEYED_RATE_LIMIT_FALLBACK_MS = 3_600_000

/** 把 DSH 注入的输出上限收进安全区间。 */
function clampKeyedMaxTokens(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined
  return Math.min(Math.floor(value), KEYED_MAX_OUTPUT_TOKENS)
}

/**
 * 账号指纹：账号 id + base_url 的有序拼接。
 *
 * 用途是「账号集变了就立刻重拉目录」—— 新贴一个 Key 不该等 5 分钟 TTL。
 */
function keyedModelSignature(items: readonly { accountId: string; credential: KeyedCredential }[]): string {
  return items
    .map(item => `${item.accountId}@${item.credential.base_url}`)
    .sort()
    .join('|')
}

/**
 * 两个目录是否**同一集合**（顺序无关）。
 *
 * ⚠️ **必须连 `free` 一起比**：平台把某个模型从收费改成免费时，id 集合一个字
 * 都没变，只比 id 就永远刷不出新的「（免费）」标记。
 */
function keyedSameModelIds(a: readonly KeyedModelEntry[] | undefined, b: readonly KeyedModelEntry[]): boolean {
  if (a === undefined || a.length !== b.length) return false
  const left = new Map(a.map(entry => [entry.id, entry.free]))
  for (const entry of b) {
    if (left.get(entry.id) !== entry.free) return false
  }
  return true
}

/**
 * ⚠️ **必须在函数内读 env**：写成模块顶层常量会在 import 时就定型，
 * 测试里 `process.env.X = ...` 完全不生效（见 `docs/agents/keyed.md` 记录的同类坑）。
 */
function resolveFirstTokenTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_KEYED_SSE_FIRST_TOKEN_TIMEOUT_MS ?? '', 10) || 120_000
}

function resolveChunkTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_KEYED_SSE_CHUNK_TIMEOUT_MS ?? '', 10) || 120_000
}

/** 展示名：免费的加「（免费）」角标。 */
function keyedModelLabel(model: KeyedModelEntry): string {
  return model.free ? `${model.id}（免费）` : model.id
}

/** 适配器选项。 */
export interface KeyedAdapterOptions {
  /** 产品配置（必填）。 */
  product: KeyedProduct
  /** 单凭据模式的默认 ref。 */
  credentialRef: CredentialRef
  resolveCredential: () => Promise<KeyedCredential | undefined>
  resolveCredentialForAccount?: (accountId: string) => Promise<KeyedCredential | undefined>
  listAccountEntries?: () => Promise<readonly { id: string; credentialRef: string }[]>
  refresh?: () => Promise<void>
  accountPool?: AccountPool
  /**
   * 警告输出（**必填**）。
   *
   * ⚠️ 刻意不用 `console.warn`：`src/` 的 `console.*` 是**只可下调**的棘轮
   * 基线，且宿主 `ctx.logger` 才带上下文（哪个插件、哪个账号）。
   */
  warn: (message: string) => void
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** ⚠️ 不要存成字段默认值 —— 见 `fetchImpl` getter 的注释。 */
  fetchImpl?: typeof fetch
  /** 目录拉取的可替换实现（测试用）。 */
  loadModels?: (options: { credential: KeyedCredential }) => Promise<{ models: KeyedModelEntry[]; warnings: string[] }>
  /** 目录**集合真变**时的回调（用于广播 `llm/adapters-updated`）。 */
  onCatalogChanged?: () => void
}

/**
 * 拉取一个账号的模型目录（导出以便单测直接打）。
 *
 * ⚠️ 与「多平台共用一套凭据」的设计不同：本族**没有**平台表补模型的逻辑 ——
 * 两个平台的目录端点都是可信的全量列表（85 个模型），不需要兜底追加。
 */
export async function loadKeyedModelsForProduct(
  product: KeyedProduct,
  credential: KeyedCredential,
  fetcher: typeof fetch = fetch,
): Promise<{ models: KeyedModelEntry[]; warnings: string[] }> {
  return await loadKeyedModels(product, credential, fetcher)
}

/**
 * 适配器本体。
 *
 * 一个实例服务**一个**产品（`commandcode` 与 `opencode` 各一个实例），
 * 这与「一个实例服务多个平台」的设计不同 —— 因为本族的端点由产品决定，
 * 不由用户选择。
 */
export class KeyedAdapter extends LlmAdapter {
  private remoteModels: KeyedModelEntry[] | undefined
  private remoteModelsAt = 0
  private lastAttemptAt = 0
  private lastAttemptFailed = false
  private attemptedSignature: string | undefined
  private remoteSignature: string | undefined
  private loading: Promise<void> | undefined
  /** 账号 → 该账号的模型集（选号亲和性用）。 */
  private readonly accountModels = new Map<string, readonly string[]>()

  constructor(private readonly options: KeyedAdapterOptions) {
    super()
  }

  private get product(): KeyedProduct {
    return this.options.product
  }

  /**
   * ⚠️ 必须是 getter，不能写成字段默认值。
   *
   * 构造期求值会把当时的 `globalThis.fetch` 冻进实例字段，
   * 使宿主后来安装的 fetch 补丁静默失效（上下文压缩代理靠这个补丁接管模型流量）。
   * lint 规则 `no-fetch-capture` 专门抓这个写法。
   */
  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch
  }

  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /**
   * 输入模态：一律文本。
   *
   * ⚠️ 不按 provider 一刀切地声明图片能力 —— 两个平台的目录里都没有多模态
   * 字段，声明了就可能「声明支持却发出去 400」。
   */
  private inputModalitiesFor(_model: string): readonly ('text' | 'image')[] {
    return ['text']
  }

  /** 收集全部账号的凭据（含已停用的：目录展示与选号是两件事）。 */
  private async resolveAllCredentials(): Promise<Array<{ accountId: string; credential: KeyedCredential }>> {
    const out: Array<{ accountId: string; credential: KeyedCredential }> = []
    const entries = await this.options.listAccountEntries?.() ?? []
    for (const entry of entries) {
      if (this.options.resolveCredentialForAccount === undefined) break
      const credential = await this.options.resolveCredentialForAccount(entry.id).catch(() => undefined)
      if (credential === undefined) continue
      out.push({ accountId: entry.id, credential })
    }
    if (out.length > 0) return out
    const single = await this.options.resolveCredential().catch(() => undefined)
    if (single === undefined) return []
    return [{ accountId: '', credential: single }]
  }

  /**
   * 确保目录已拉取（并在 TTL 内）。
   *
   * ⚠️ in-flight 共享：并发调用（如 composer 与设置页同时打开）只发一次请求。
   * `finally` 里的 `if (this.loading === task)` 是必须的 ——
   * 否则一个迟到的旧任务会把新任务的 loading 清掉，导致请求堆积。
   */
  private async ensureRemoteModels(): Promise<void> {
    if (this.loading !== undefined) {
      await this.loading
      return
    }
    const task = this.loadRemoteModelsOnce()
    this.loading = task
    try {
      await task
    } finally {
      if (this.loading === task) this.loading = undefined
    }
  }

  private async loadRemoteModelsOnce(): Promise<void> {
    const credentials = await this.resolveAllCredentials()
    if (credentials.length === 0) return
    const now = Date.now()
    const signature = keyedModelSignature(credentials)
    const fresh = this.remoteModels !== undefined
      && signature === this.remoteSignature
      && now - this.remoteModelsAt < KEYED_MODELS_TTL_MS
    if (fresh) return
    // 冷却只在**一次都没拉到**且指纹没变时生效：已经失败的请求不该被反复重试。
    if (this.lastAttemptFailed && signature === this.attemptedSignature && now - this.lastAttemptAt < KEYED_MODELS_RETRY_MS) return
    this.lastAttemptAt = now
    this.attemptedSignature = signature
    const loader = this.options.loadModels ?? (async (input: { credential: KeyedCredential }) =>
      await loadKeyedModelsForProduct(this.product, input.credential, this.fetchImpl))
    const union: KeyedModelEntry[] = []
    const seen = new Set<string>()
    const perAccount = new Map<string, readonly string[]>()
    for (const { accountId, credential } of credentials) {
      try {
        const { models, warnings } = await loader({ credential })
        for (const warning of warnings) this.options.warn(`[jet-hub] ${this.product.id}：${warning}`)
        if (accountId.length > 0) perAccount.set(accountId, models.map(model => model.id))
        for (const model of models) {
          if (seen.has(model.id)) continue
          seen.add(model.id)
          union.push(model)
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        this.options.warn(`[jet-hub] ${this.product.id} 模型目录拉取失败（账号 ${accountId || '(兜底)'}）：${detail}`)
      }
    }
    this.accountModels.clear()
    for (const [accountId, models] of perAccount) this.accountModels.set(accountId, models)
    if (union.length === 0) {
      // ⚠️ 保留旧目录：一次网络抖动不该让 composer 里的模型全消失。
      this.lastAttemptFailed = true
      return
    }
    const changed = !keyedSameModelIds(this.remoteModels, union)
    this.remoteModels = union
    this.remoteModelsAt = now
    this.remoteSignature = signature
    this.lastAttemptFailed = false
    if (changed) this.notifyCatalogChanged()
  }

  /** 广播目录变更。⚠️ 回调抛错只 warn，绝不能让通知失败反噬目录本身。 */
  private notifyCatalogChanged(): void {
    try {
      this.options.onCatalogChanged?.()
    } catch (error) {
      this.options.warn(`[jet-hub] ${this.product.id} 目录变更通知失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 设置页目录（**不受黑名单与门控影响**）。
   *
   * ⚠️ 用 `remoteModels` 原样（不按 `disabledModels` 过滤）：设置页是用户
   * 关掉模型后**唯一能重新打开**的地方。
   */
  listAllModels(): readonly { id: string; name: string }[] {
    const source = this.remoteModels ?? []
    if (this.remoteModels === undefined || Date.now() - this.remoteModelsAt >= KEYED_MODELS_TTL_MS) {
      void this.ensureRemoteModels()
    }
    return source.map(model => ({ id: model.id, name: keyedModelLabel(model) }))
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // ⚠️ 门控放在 ensureRemoteModels() **之前**：没有可用账号时省掉一次 HTTP。
    if (!await providerCatalogVisible(this.options.accountPool, this.product.id)) return []
    await this.ensureRemoteModels()
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id)
    return (this.remoteModels ?? [])
      .filter(model => disabled?.has(model.id) !== true)
      .map(model => ({
        provider: this.product.id,
        id: model.id,
        name: keyedModelLabel(model),
        inputModalities: this.inputModalitiesFor(model.id),
      }))
  }

  /**
   * 解析模型。
   *
   * ⚠️ **不声明** `reasoning` / `defaultMaxTokens` / `contextWindow`：
   * 两个平台的目录里没有这些字段，编造会让 DSH 下发上游不认的参数。
   */
  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { provider: id, id: model, name: model }
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{ model: LlmResolvedModelInfo; stream: (options: GenerateOptions) => AsyncIterable<StreamChunk> }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: options => this.stream(options),
    }
  }

  /**
   * 选号：账号池手动顺序 + 模型亲和性。
   *
   * 规则（顺序不可颠倒）：
   * 1. 该账号的模型集**含**目标模型 → 命中；
   * 2. 模型集**未知**（还没拉到 / 拉取失败）→ 也算命中（**保守放行**，
   *    否则目录拉挂时整个 provider 不可用）；
   * 3. 全都不命中 → 退回第一个可用账号，让上游报出真实错误
   *    （比「插件自己编一个错误」对用户有用得多）。
   *
   * ⚠️ **不做任何重排**：账号池的数组顺序**就是**用户拖拽出来的优先级，
   * 这是 `AGENTS.md` 的硬性约定。
   */
  private async pickCredential(modelId: string, excludeAccountIds?: ReadonlySet<string>): Promise<{ accountId: string; credential: KeyedCredential } | undefined> {
    const all = await this.resolveAllCredentials()
    if (all.length === 0) return undefined
    const notExcluded = all.filter(item => excludeAccountIds?.has(item.accountId) !== true)
    const candidates = notExcluded.length > 0 ? notExcluded : all
    if (modelId.length === 0) return candidates[0]
    for (const item of candidates) {
      const known = this.accountModels.get(item.accountId)
      if (known === undefined || known.includes(modelId)) return item
    }
    return candidates[0]
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 图片输入：本族一律未声明图片能力，直接拒绝而不是发出去让上游 400。
    const imageRefs = new Map<string, unknown>()
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs)
    }
    if (imageRefs.size > 0) {
      throw new LlmError(
        `${this.product.id}: 模型 "${options.model}" 未声明图片能力（该平台的目录不含多模态声明）`,
        'UNSUPPORTED_CONTENT',
      )
    }

    let picked = await this.pickCredential(options.model)
    if (picked === undefined || isKeyedExpired(picked.credential)) {
      await this.options.refresh?.()
      picked = await this.pickCredential(options.model)
    }
    if (picked === undefined) {
      throw new LlmError(
        `${this.product.id}: no usable credential; add an account with your API key first`,
        'MISSING_CREDENTIAL',
      )
    }

    const messages = serializeMessages(options.messages)
    const bodyObj: Record<string, unknown> = {
      model: options.model,
      messages: options.system !== undefined && options.system.length > 0
        ? [{ role: 'system', content: options.system }, ...messages]
        : messages,
      stream: true,
    }
    if (Array.isArray(options.tools) && options.tools.length > 0) {
      bodyObj.tools = options.tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }))
    }
    if (options.temperature !== undefined) bodyObj.temperature = options.temperature
    const maxTokens = clampKeyedMaxTokens(options.maxTokens)
    if (maxTokens !== undefined) bodyObj.max_tokens = maxTokens
    if (options.stop !== undefined && options.stop.length > 0) bodyObj.stop = options.stop
    const body = JSON.stringify(bodyObj)

    let { accountId, credential } = picked
    let response = await this.send(credential, body, options)
    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      const shouldRotate = isKeyedRotatableFailure(response.status, errorText)
      if (this.options.accountPool !== undefined && shouldRotate) {
        const tried = new Set<string>(accountId.length > 0 ? [accountId] : [])
        for (let attempt = 0; attempt < KEYED_MAX_ROTATE - 1; attempt++) {
          if (accountId.length > 0 && recordsKeyedRateLimit(response.status)) {
            await this.options.accountPool.updateModelRateLimit(accountId, options.model, Date.now() + KEYED_RATE_LIMIT_FALLBACK_MS)
          }
          const next = await this.pickCredential(options.model, tried)
          if (next === undefined || next.accountId.length === 0 || tried.has(next.accountId)) break
          tried.add(next.accountId)
          accountId = next.accountId
          credential = next.credential
          response = await this.send(credential, body, options)
          if (response.ok) break
        }
        if (!response.ok) {
          throw new LlmError(
            `${this.product.id}: 模型 ${options.model} 的所有账号均不可用（限流或额度耗尽），请稍后再试`,
            'QUOTA_EXCEEDED',
          )
        }
      } else {
        throw new LlmError(
          `${this.product.id}: ${errorDetail(errorText)}`,
          httpErrorCode(response.status, errorText),
          { status: response.status },
        )
      }
    }
    yield* this.consume(response, options)
  }

  private consume(response: Response, options: GenerateOptions): AsyncIterable<StreamChunk> {
    return consumeOpenAiSse(
      response,
      { ...options.signal === undefined ? {} : { signal: options.signal } },
      {
        label: this.product.id,
        firstTokenTimeoutMs: resolveFirstTokenTimeoutMs(),
        chunkTimeoutMs: resolveChunkTimeoutMs(),
      },
    )
  }

  private async send(credential: KeyedCredential, body: string, options: GenerateOptions): Promise<Response> {
    try {
      return await this.fetchImpl(keyedChatUrl(credential.base_url), {
        method: 'POST',
        headers: {
          ...keyedHeaders(credential),
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body,
        signal: options.signal,
      })
    } catch (error) {
      if (options.signal?.aborted === true) throw error
      if (isTransportError(error)) {
        throw new LlmError(
          `${this.product.id}: transport error: ${error instanceof Error ? error.message : String(error)}`,
          'TRANSPORT',
          { cause: error as Error },
        )
      }
      throw error
    }
  }

  /** 昵称构造函数（供 RPC 层用）。 */
  buildNickname(apiKey: string, fallbackId: string): string {
    return buildKeyedNickname(this.product.displayName, apiKey, fallbackId)
  }
}

/** 是否属于「额度耗尽 / 限流」类失败（可换号重试）。 */
export function isKeyedRotatableFailure(status: number, body: string): boolean {
  if (status === 429 || status === 402) return true
  const lower = body.toLowerCase()
  return KEYED_CREDIT_MARKERS.some(marker => lower.includes(marker))
}

/**
 * 额度相关文案标记。
 *
 * ⚠️ 覆盖中英双语：两个平台都在用英文错误（`insufficient balance`、
 * `quota exceeded`），但上游供应商的原始文案常常是中文。
 */
const KEYED_CREDIT_MARKERS: readonly string[] = [
  'insufficient',
  'quota',
  'rate limit',
  'too many requests',
  'balance',
  'credit',
  'payment required',
  'exceeded',
  '积分不足',
  '额度不足',
  '余额不足',
  '频率限制',
  '超出限制',
]

/**
 * 该状态码是否值得写进「限流」时间戳。
 *
 * ⚠️ 只有 429/402 —— 401 是 Key 无效（换号也许能救，但它不是限流，
 * 写进限流表会让一个正确的账号被白白搁置一小时）。
 */
export function recordsKeyedRateLimit(status: number): boolean {
  return status === 429 || status === 402
}

/** 注册适配器到 `ctx.llm`。 */
export function registerKeyedLlm(ctx: Context, options: KeyedAdapterOptions): KeyedAdapter {
  const product = options.product
  try {
    ctx.llm.registerConfigurableProviders([{
      provider: product.id,
      displayName: product.displayName,
      settingsNs: settingsNamespaceFor(ctx, `llm-${product.id}`),
      settingsPath: [],
    }])
  } catch (err: unknown) {
    const msg = `[Jet Hub] Failed to register configurable provider ${product.id}: ${String(err)}`
    if (options.warn) {
      options.warn(msg)
    } else {
      (ctx as { logger?: { warn?: (m: string) => void } }).logger?.warn?.(msg)
    }
  }
  const adapter = new KeyedAdapter(options)
  try {
    ctx.llm.registerAdapter([product.id], adapter)
  } catch (err: unknown) {
    const msg = `[Jet Hub] Failed to register adapter for ${product.id}: ${String(err)}`
    if (options.warn) {
      options.warn(msg)
    } else {
      (ctx as { logger?: { warn?: (m: string) => void } }).logger?.warn?.(msg)
    }
  }
  return adapter
}
