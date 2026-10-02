/**
 * 「粘贴 API Key」族的认证服务（用户手工粘贴 Key，无登录链、无续期）。
 *
 * ## 校验判据：必须打 chat 端点，不能用 `GET /models`
 *
 * 实测（2026-10，本机）两个平台的目录端点**都不鉴权**：
 * `api.commandcode.ai/provider/v1/models` 与 `opencode.ai/zen/v1/models`
 * 在**无 Key** 时同样返回 200 + 完整模型列表。
 * 若拿它当校验，任何字符串都会被判「有效」—— 用户会看到一个登录成功的账号，
 * 然后每一轮对话都 401。
 *
 * 故校验方式是**打一次真实的 chat 请求**（`max_tokens: 1`，探测模型取自
 * `KeyedProduct.probe`）。这是唯一能区分「Key 对」与「Key 错」的信号。
 *
 * ## 为什么探测模型必须是免费档位
 *
 * 每次粘贴 Key 都会跑一次校验。用计费模型会让用户**为了配置插件而付钱**，
 * 且用户完全无从预期。故 `probe.model` 一律取实测免费 / 零开销的模型
 * （见 `src/keyed-product.ts`）。
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { errorDetail } from './http-error.js'
import {
  buildKeyedCredential,
  keyedApiKeyLooksMalformed,
  parseKeyedCredential,
  parseKeyedModelEntries,
} from './keyed.js'
import type { KeyedCredential, KeyedKeyValidation, KeyedModelEntry } from './keyed.js'
import { keyedChatUrl, keyedModelExcluded, keyedModelsUrl, type KeyedProduct } from './keyed-product.js'

/** 认证服务选项。 */
export interface KeyedAuthOptions {
  /** 产品配置（必填：本族全部行为都由它参数化）。 */
  product: KeyedProduct
  /** 替换 fetch（测试用）。⚠️ 不要存成字段默认值 —— 见下方 getter 注释。 */
  fetcher?: typeof fetch
  /** 服务名覆盖（默认 `<productId>Auth`）。 */
  serviceName?: string
}

/** 一次探测的结果。 */
export interface KeyedProbeResult {
  ok: boolean
  /** 失败原因（面向用户的文案）。 */
  error?: string
}

/**
 * 探测某 Key 是否有效。
 *
 * 返回 `ok: true` 表示**上游没有以鉴权失败回应**；返回 `ok: false` 时
 * `error` 是可直接展示给用户的文案。
 *
 * ⚠️ 判据是 `product.probe.invalidIf(status, body)`，**不是**简单的
 * `status === 401`：opencode 对「模型不支持该协议形状」也返回 401
 * （`{"error":{"type":"ModelError"}}`），与 Key 有效性无关。
 */
export async function probeKeyedApiKey(
  product: KeyedProduct,
  baseUrl: string,
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<KeyedProbeResult> {
  const body = JSON.stringify({
    model: product.probe.model,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 1,
    stream: false,
  })
  let response: Response
  try {
    response = await fetcher(keyedChatUrl(baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body,
    })
  } catch (error) {
    return { ok: false, error: `无法连接 ${baseUrl}：${error instanceof Error ? error.message : String(error)}` }
  }
  const text = await response.text().catch(() => '')
  if (product.probe.invalidIf(response.status, text)) {
    const detail = errorDetail(text)
    return { ok: false, error: detail.length > 0 ? `API Key 校验失败（HTTP ${response.status}）：${detail}` : `API Key 校验失败（HTTP ${response.status}）` }
  }
  return { ok: true }
}

/**
 * 拉取模型目录（`GET {base_url}/models`）。
 *
 * 返回的条目已**剔除该产品下架的模型**（如 Command Code 只能走
 * `/messages` 的那 10 个 claude）—— 列出来却调不通比不列更糟。
 *
 * ⚠️ 剔除依据是产品表的 `excludeModels`，而不是「猜这个名字能不能用」。
 */
export async function loadKeyedModels(
  product: KeyedProduct,
  credential: KeyedCredential,
  fetcher: typeof fetch = fetch,
): Promise<{ models: KeyedModelEntry[]; warnings: string[] }> {
  const response = await fetcher(keyedModelsUrl(credential.base_url), {
    method: 'GET',
    headers: { Authorization: `Bearer ${credential.access_token}`, Accept: 'application/json' },
  })
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    throw new Error(`${response.status} ${errorDetail(text) || '（无报文）'}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('模型目录不是合法 JSON（该端点可能不是 OpenAI 兼容接口）')
  }
  const entries = parseKeyedModelEntries(parsed)
  const warnings: string[] = []
  const models = entries.filter(entry => {
    if (!keyedModelExcluded(product, entry.id)) return true
    warnings.push(`模型 ${entry.id} 不接受 /chat/completions（该产品要求另一套协议形状），已从目录里隐藏`)
    return false
  })
  return { models, warnings }
}

/** 导入 `KeyedModelEntry` 供外部使用。 */
export type { KeyedModelEntry } from './keyed.js'

/**
 * 认证服务：粘贴 Key → 校验 → 入库。
 *
 * ⚠️ 与其余 13 个 provider 的 auth 服务不同，本类**没有 `startLogin()`**：
 * Key 得用户自己去控制台复制，插件无从代劳（`account.create` 因此返回
 * `loginMode: 'key'` + 空 `loginUrl`）。
 */
export class KeyedAuth extends Service {
  constructor(
    ctx: Context,
    private readonly options: KeyedAuthOptions,
  ) {
    super(ctx, options.serviceName ?? `${options.product.id}Auth`)
  }

  // ⚠️ 必须是 getter：构造期求值会把当时的 `globalThis.fetch` 冻进字段，
  // 使宿主后来安装的 fetch 补丁（上下文压缩代理靠它接管流量）静默失效。
  private get fetchImpl(): typeof fetch {
    return this.options.fetcher ?? fetch
  }

  /** 产品 id。 */
  get productId(): string {
    return this.options.product.id
  }

  /**
   * 校验并返回模型目录快照。
   *
   * 顺序**不可颠倒**：先探测 Key（决定成败），成功后再尽力拉一次目录
   * （只用于 `modelCount` 展示与选号亲和性，失败不影响结论）。
   * 反过来的话，一个没有目录端点的平台会让正确的 Key 被判失败。
   */
  async validateApiKey(apiKey: string, baseUrl?: string): Promise<KeyedKeyValidation> {
    const product = this.options.product
    const malformed = keyedApiKeyLooksMalformed(apiKey)
    if (malformed !== undefined) return { ok: false, models: [], error: malformed }
    const resolved = baseUrl === undefined || baseUrl.trim().length === 0 ? product.baseUrl : baseUrl.trim().replace(/\/+$/, '')
    const probe = await probeKeyedApiKey(product, resolved, apiKey.trim(), this.fetchImpl)
    if (!probe.ok) return { ok: false, models: [], error: probe.error ?? 'API Key 校验失败' }
    let models: readonly string[] = []
    try {
      const loaded = await loadKeyedModels(product, buildKeyedCredential({ apiKey, product: product.id, baseUrl: resolved }), this.fetchImpl)
      models = loaded.models.map(entry => entry.id)
    } catch {
      // 目录拉取失败不影响 Key 有效性结论：探测已经证明 Key 是对的。
    }
    return { ok: true, models }
  }

  /** 写入凭据（登录流程的最后一步）。 */
  async persistApiKey(
    refName: string,
    input: { apiKey: string; baseUrl: string; models?: readonly string[]; nickname?: string },
  ): Promise<KeyedCredential> {
    const credential = buildKeyedCredential({
      apiKey: input.apiKey,
      product: this.options.product.id,
      baseUrl: input.baseUrl,
      ...input.models === undefined ? {} : { models: input.models },
      ...input.nickname === undefined ? {} : { nickname: input.nickname },
    })
    await this.ctx.credentials.set(credentialRef(refName), JSON.stringify(credential))
    return credential
  }

  /** 读取已存凭据。 */
  async resolveStored(refName: string): Promise<KeyedCredential | undefined> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(refName))
    if (resolved === undefined) return undefined
    // ⚠️ `ctx.credentials.resolve` 返回的是 `{ value }` 包装而不是裸字符串
    // （`CredentialValue`）—— 直接当字符串用会让 `JSON.parse` 拿到
    // `{"value":"...","source":"..."}` 而解析失败，表现为「刚粘贴就报凭据缺失」。
    return parseKeyedCredential(resolved.value)
  }

  /**
   * 按凭据 ref 复检。
   *
   * ⚠️ **成功也不改写凭据**。API Key 没有轮换机制，
   * 改写只会让一个能用的凭据变成另一个能用（或不能用）的凭据。
   * 本族的 key 是用户手工粘贴的，插件无从代为续期。
   */
  async refreshAccountCredential(refName: string): Promise<void> {
    const credential = await this.resolveStored(refName)
    if (credential === undefined) {
      throw new Error(`${this.options.product.displayName} 凭据缺失或无法解析，请重新粘贴 API Key`)
    }
    const probe = await probeKeyedApiKey(this.options.product, credential.base_url, credential.access_token, this.fetchImpl)
    if (!probe.ok) {
      throw new Error(`API Key 已失效，请重新粘贴：${probe.error ?? '未知原因'}`)
    }
  }

  /** 本族没有续期端点（API Key 不过期），故 `refreshAll` 是空操作。 */
  async refreshAll(_pool: unknown): Promise<void> {
    void _pool
  }
}

/** 本族凭据恒不可续期。 */
export function isKeyedRefreshable(): boolean {
  return false
}
