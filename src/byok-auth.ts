/**
 * BYOK（Bring Your Own Key）认证服务。
 *
 * ## 职责边界
 *
 * 本服务**不做登录** —— 这是它与其余 13 个 `XxxAuth` 最根本的区别。
 * 其余 provider 的凭据由对方服务端下发，故都有一个 `startLogin()` /
 * `login()` 流程；BYOK 的凭据是用户自己粘贴的 Key，没有可执行的登录流程。
 *
 * 它只负责三件事：
 *
 * 1. {@link ByokAuth.validateApiKey} —— 写凭据**之前**打一次
 *    `GET {baseUrl}/models`，确认这个 Key 真的能用；
 * 2. {@link ByokAuth.persistApiKey} —— 把凭据写进 `ctx.credentials`；
 * 3. {@link ByokAuth.refreshAccountCredential} —— 账号卡片的「刷新」按钮：
 *    BYOK 无续期端点，故退化为**有效性探测**（与 Loomy 同型）。
 *
 * ## 为什么校验必须发生在写凭据之前
 *
 * 若先写后验，一个打不通的 Key 会留下一个「账号在、模型全空」的条目；
 * 而模型目录门控是按「凭据能否解析」判定的，该账号**算已登录** ⇒
 * 目录不显示却也不报错，用户完全不知道发生了什么。
 * 先验后写则失败路径清晰：返回可读错误、不写凭据、不留残留。
 *
 * ## 为什么恒不续期
 *
 * Key 由用户手工粘贴，第三方平台普遍不提供「用 Key 换新 Key」的端点。
 * 故 `isByokRefreshable` 恒为 `false`，`refreshAll()` 天然不会碰它
 * （`refreshAll` 只看 `refreshable`）。
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { buildByokCredential, parseByokCredential, type ByokCredential } from './byok.js'
import { loadByokModels } from './byok-adapter.js'
import { BYOK, byokBaseUrlLooksValid, byokResolveBaseUrl } from './byok-product.js'

/** `ByokAuth` 的构造选项。 */
export interface ByokAuthOptions {
  /** 注入的 fetch（测试用）。 */
  fetcher?: typeof fetch
  /** 服务名（默认 `byokAuth`）。 */
  serviceName?: string
}

/** Key 校验结果（`ok: false` 时 `error` 可直接展示给用户）。 */
export interface ByokKeyCheck {
  ok: boolean
  /** 拉到的模型 id 列表。 */
  models: readonly string[]
  /** 失败原因。 */
  error?: string
}

/**
 * BYOK 恒不可续期。
 *
 * ⚠️ 导出为函数（而非常量）以便与 `isClineRefreshable` / `isTraeRefreshable`
 * 的调用形态一致；语义上它没有入参依赖，恒为 `false`。
 */
export function isByokRefreshable(): boolean {
  return false
}

export class ByokAuth extends Service {
  constructor(ctx: Context, private readonly options: ByokAuthOptions = {}) {
    super(ctx, options.serviceName ?? `${BYOK.id}Auth`)
  }

  /** 注入的 fetch（测试用）；默认为全局 fetch。 */
  private get fetchImpl(): typeof fetch {
    return this.options.fetcher ?? fetch
  }

  /**
   * 校验一组「平台 + Key」能否真正使用。
   *
   * 判据是 `GET {baseUrl}/models` **返回 2xx 且至少含一个模型 id**：
   *
   * - 只判 HTTP 状态码不够 —— 有平台对无效 Key 返回 200 + 空清单；
   * - 只判「有报文」也不够 —— 错误报文同样是合法 JSON。
   *
   * @param platform - 预设平台 id（`custom` 时用 `customBaseUrl`）。
   * @param apiKey - 用户粘贴的 Key。
   * @param customBaseUrl - `custom` 平台的手填地址。
   */
  async validateApiKey(
    platform: string,
    apiKey: string,
    customBaseUrl?: string,
  ): Promise<ByokKeyCheck> {
    const baseUrl = byokResolveBaseUrl(platform, customBaseUrl)
    if (baseUrl === undefined) {
      return {
        ok: false,
        models: [],
        error: platform === 'custom'
          ? '请填写自定义 base url（例如 https://your-host/v1）'
          : `未知平台：${platform}`,
      }
    }
    if (platform === 'custom' && !byokBaseUrlLooksValid(baseUrl)) {
      return { ok: false, models: [], error: 'base url 必须以 http:// 或 https:// 开头' }
    }

    const credential = buildByokCredential({ apiKey, platform, baseUrl })
    try {
      const loaded = await loadByokModels(credential, this.fetchImpl)
      const ids = loaded.models.map(model => model.id)
      if (ids.length === 0) {
        return {
          ok: false,
          models: [],
          error: 'Key 通过了鉴权但该端点没有返回任何模型（可能 base url 少了一段路径）',
        }
      }
      return { ok: true, models: ids }
    } catch (error) {
      return {
        ok: false,
        models: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * 写入 BYOK 凭据。
   *
   * ⚠️ 调用方**必须先**通过 {@link ByokAuth.validateApiKey}；本方法不做网络
   * 校验（避免重复请求），只负责持久化。
   *
   * @returns 写入的凭据对象（供调用方拼昵称）。
   */
  async persistApiKey(
    refName: string,
    input: {
      apiKey: string
      platform: string
      baseUrl: string
      models?: readonly string[]
      nickname?: string
    },
  ): Promise<ByokCredential> {
    const credential = buildByokCredential(input)
    await this.ctx.credentials.set(credentialRef(refName), JSON.stringify(credential))
    return credential
  }

  /** 按 ref 读取已存凭据（账号池 `login.poll` 的判据同源）。 */
  async resolveStored(refName: string): Promise<ByokCredential | undefined> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(refName))
    if (resolved === undefined) return undefined
    return parseByokCredential(resolved.value)
  }

  /**
   * 「刷新」一个 BYOK 账号。
   *
   * BYOK 无续期端点，故这里只做**有效性探测**：用已存凭据打一次
   * `GET /models`，失败即抛「Key 已失效，请重新粘贴」。
   *
   * ⚠️ 探测**成功也不改写凭据**：没有新信息可写（无 `expires_in`），
   * 平白一次写盘只会制造「凭据被刷新过」的假象，并可能让账号池的
   * `expiresAt` 显示变成误导。
   */
  async refreshAccountCredential(refName: string): Promise<void> {
    const credential = await this.resolveStored(refName)
    if (credential === undefined) {
      throw new Error('BYOK 凭据缺失或无法解析，请重新粘贴 API Key')
    }
    const check = await this.validateApiKey(
      credential.platform,
      credential.access_token,
      credential.base_url,
    )
    if (!check.ok) {
      throw new Error(`API Key 已失效，请重新粘贴：${check.error ?? '未知原因'}`)
    }
  }

  /**
   * 批量续期：**空操作**。
   *
   * ⚠️ 之所以保留该方法而不是让调用方跳过，是为了与其余 provider 的
   * `refreshAll(pool)` 形态一致 —— `src/index.ts` 的续期循环逐 provider
   * 调用它，缺了就得在那里加特例分支。BYOK 的 `refreshable` 恒为 `false`，
   * 故即使被调用也无账号可处理。
   */
  async refreshAll(_pool: unknown): Promise<void> {
    // 刻意为空：见方法注释。
  }
}
