/**
 * BYOK（Bring Your Own Key）凭据模型与协议纯函数。
 *
 * 本模块**不做任何 IO**：解析、构造、判定全部是纯函数，便于单测锁死。
 * 网络行为在 `src/byok-adapter.ts`（推理）与 `src/rpc/login.ts` 的
 * `login.submitKey`（写凭据前的 Key 校验）。
 *
 * ## 与既有 13 个 provider 的根本差异
 *
 * 其余 provider 的凭据都是**服务端下发**的（OAuth token / 设备码 / 扫码换票），
 * 形态由对方协议决定，本插件只能解析。BYOK 的凭据是**用户手工粘贴**的，
 * 因此：
 *
 * 1. **没有续期**：`refreshable` 恒为 `false`（Key 过期只能重新粘贴）；
 * 2. **没有过期时间**：绝大多数平台的 Key 无 `expires_in`，故
 *    `expire_time` 恒不写 → 不会被误判为「已过期」；
 * 3. **必须自带平台归属**：`platform` / `base_url` 落进凭据 JSON。
 *    `ProviderAccountEntry` 没有 `platform` 字段（加它要动 AGENTS.md 的
 *    10 处接线清单），而凭据本体本来就是「这个账号怎么发请求」的唯一真相源，
 *    故放这里最自然，也让**一个账号 = 一个「平台 + Key」组合**成立，
 *    用户可同时挂多个账号、靠账号池的拖拽顺序决定优先级。
 */

/**
 * 持久化到 `ctx.credentials` 的 BYOK 凭据 JSON。
 *
 * 对外字段名沿用本插件统一的 `access_token` / `expire_time` 命名
 * （与 `ClineCredential` / `QoderCredential` 一致），避免每个 provider
 * 一套命名让调用方难以复用。
 */
export interface ByokCredential {
  /** API Key（**原样保留**，不做任何前缀增删）。 */
  access_token: string
  /**
   * 平台 id（对应 `BYOK_PLATFORMS` 里的 `id`，或 `custom`）。
   *
   * ⚠️ 它决定请求打向哪个 `base_url`，也用于面板展示与错误文案。
   */
  platform: string
  /**
   * 实际使用的 OpenAI 兼容 base url（**已去尾部斜杠**）。
   *
   * 冗余存一份而**不是**每次从 `BYOK_PLATFORMS` 现查：预设平台的 `baseUrl`
   * 会随上游调整，而已经登录的账号不该因为插件升级就换了端点
   * （`custom` 平台更是只能存这里）。与 CodeBuddy 系「凭据 domain 不参与
   * 路由、产品配置说了算」的取舍相反 —— 那边是同一产品的区域漂移，
   * 这边是用户自己的端点选择，必须尊重用户的原始输入。
   */
  base_url: string
  /**
   * 单账号可选覆盖的模型清单（`custom` 平台或 `GET /models` 不可用时用）。
   *
   * 留空则一律走 `GET {base_url}/models` 动态拉取。
   */
  models?: readonly string[]
  /** 展示名（账号池昵称兜底）。 */
  nickname?: string
  /**
   * 过期时间（毫秒时间戳）。
   *
   * ⚠️ **几乎永远不写**：绝大多数 BYOK 平台的 Key 不过期。写了就必须
   * 保证准确，否则会出现「刚粘贴的 Key 被判定过期 → 静默走续期 →
   * 续期是空操作 → 报 MISSING_CREDENTIAL」的死循环。
   */
  expire_time?: number
}

/** 一次 `GET /models` 校验的结果。 */
export interface ByokKeyValidation {
  /** 校验是否通过（能列出至少一个模型）。 */
  ok: boolean
  /** 拉到的模型 id 列表（按远端顺序）。 */
  models: readonly string[]
  /** 失败原因（面向用户，可直接展示）。 */
  error?: string
}

/**
 * 从 `GET /models` 的响应体解析模型 id 列表。
 *
 * 兼容三种实际见到的形态（都实测过）：
 *
 * | 形态 | 例子 |
 * |---|---|
 * | `{object:"list", data:[{id}]}` | 智谱、Chutes、NVIDIA |
 * | `{data:[{id}]}` | OpenRouter、SambaNova、Novita |
 * | `{models:[{id}]}` / `{models:["id"]}` | 少数自建网关（Ollama 兼容层） |
 *
 * ⚠️ 元素既可能是对象（取 `id` / `name` / `model` 任一非空字符串），
 * 也可能是裸字符串 —— **两种都要接**，否则本地 Ollama / LM Studio 这类
 * 极简实现会列表为空、被误判成「Key 无效」。
 *
 * @param body - 已解析的响应 JSON。
 * @returns 去重后的模型 id 列表（保序）。
 */
export function parseByokModelList(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) return []
  const record = body as Record<string, unknown>
  const raw = Array.isArray(record.data) ? record.data
    : Array.isArray(record.models) ? record.models
    : Array.isArray(body) ? body
    : []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    const id = typeof item === 'string'
      ? item
      : typeof item === 'object' && item !== null
        ? readFirstString(item as Record<string, unknown>, ['id', 'name', 'model'])
        : undefined
    if (id === undefined) continue
    const key = id.trim()
    if (key.length === 0 || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

/** 从记录里读第一个非空字符串字段。 */
function readFirstString(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/**
 * 解析持久化凭据。
 *
 * 垃圾输入**返回 `undefined`**（而非抛错），由调用方判定 —— 与
 * `parseClineCredential` / `parseQoderCredential` 同约定。
 *
 * ⚠️ 判据必须包含 `base_url`：只校验 `access_token` 会让「平台未知」的
 * 半成品凭据通过，随后请求打到 `undefined/models` 上，报出的错与真实原因
 * 完全无关（这正是账号池「凭据可解析就视为已登录」门控要防的形态）。
 */
export function parseByokCredential(raw: string | undefined): ByokCredential | undefined {
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  const accessToken = readFirstString(record, ['access_token', 'api_key', 'accessToken'])
  const baseUrl = readFirstString(record, ['base_url', 'baseUrl'])
  if (accessToken === undefined || baseUrl === undefined) return undefined
  const platform = readFirstString(record, ['platform']) ?? 'custom'
  const nickname = readFirstString(record, ['nickname'])
  const expireTime = readNonNegativeNumber(record.expire_time)
  const models = Array.isArray(record.models)
    ? record.models.filter((m): m is string => typeof m === 'string' && m.trim().length > 0).map(m => m.trim())
    : undefined
  return {
    access_token: accessToken,
    platform,
    // 规整尾部斜杠：拼接契约要求 base 不带尾斜杠（见 byokChatUrl）。
    base_url: baseUrl.trim().replace(/\/+$/, ''),
    ...models === undefined || models.length === 0 ? {} : { models },
    ...nickname === undefined ? {} : { nickname },
    ...expireTime === undefined ? {} : { expire_time: expireTime },
  }
}

/** 读一个非负有限数字；其余（含 `0`/负数/`NaN`）返回 `undefined`。 */
function readNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return value
}

/**
 * 构造凭据 JSON（写盘前调用，保证字段顺序稳定、便于人眼核对）。
 */
export function buildByokCredential(input: {
  apiKey: string
  platform: string
  baseUrl: string
  models?: readonly string[]
  nickname?: string
}): ByokCredential {
  const models = input.models?.filter(m => m.trim().length > 0).map(m => m.trim())
  return {
    access_token: input.apiKey.trim(),
    platform: input.platform,
    base_url: input.baseUrl.trim().replace(/\/+$/, ''),
    ...models === undefined || models.length === 0 ? {} : { models },
    ...input.nickname === undefined || input.nickname.length === 0 ? {} : { nickname: input.nickname },
  }
}

/**
 * 推理与目录端点的请求头。
 *
 * BYOK 的目标是**任意** OpenAI 兼容端点，故只发最小必要集合：
 * `Authorization` + `Accept`。**不叠加任何 `X-*` 客户端标识头** ——
 * 那些是各厂商私有的（CodeBuddy 的 `X-Product-Code`、TRAE 的 `X-IDE-*`），
 * 发给第三方平台只会被当作未知头忽略，或更糟：被某些网关当成协议不匹配拒掉。
 */
export function byokHeaders(credential: ByokCredential): Record<string, string> {
  return {
    Authorization: `Bearer ${credential.access_token}`,
    Accept: 'application/json',
  }
}

/**
 * BYOK 凭据是否已「失效」。
 *
 * ⚠️ 恒为 `false`，除非凭据里**显式**写了合法的 `expire_time`。
 * 理由：Key 本身不会过期，而账号池的 `hasLoggedInAccount` 门控与适配器的
 * `resolveCredential` 都**按「能否解析」判定**；若这里退化成「写过就算过期」，
 * 用户一粘贴就会被判失效。
 */
export function isByokExpired(credential: ByokCredential, nowMs: number = Date.now()): boolean {
  return credential.expire_time !== undefined && credential.expire_time <= nowMs
}

/**
 * 生成账号池昵称：`平台名 · Key 尾 4 位`。
 *
 * ⚠️ **必须带 Key 尾号**：同一平台挂两个 Key 时，只写平台名会让账号卡片
 * 完全无法区分（与 Raccoon 追加手机号尾号、Loomy 追加尾号同策略）。
 *
 * ⚠️ **绝不放 Key 前段**：账号卡片与日志都会展示昵称，前段泄露等于泄露凭据
 * （与 `assertUsableApiKey` 的「key 永不进消息」同一条安全约束）。
 */
export function buildByokNickname(platformLabel: string, apiKey: string, fallbackId: string): string {
  const trimmed = apiKey.trim()
  if (trimmed.length === 0) return platformLabel.length > 0 ? platformLabel : fallbackId
  const tail = trimmed.slice(-4)
  return `${platformLabel} · ${tail}`
}

/**
 * 判定「哪些密钥串形态**一定不是**真 Key」，用于粘贴时的即时反馈。
 *
 * 只拦最明显的粘贴事故：空串、带换行、带引号（从 JSON 里连引号一起复制）、
 * 含空格（从 `export KEY=...` 里连变量名一起复制）。
 *
 * ⚠️ **不做任何长度/前缀白名单**：Key 形态千差万别（`sk-…` / `fa4204…`
 * 点号格式 / 纯 hex / `cpk_…` / 本地 Ollama 的任意串），任何前缀校验
 * 都会把合法 Key 拒之门外。判据只覆盖「结构性错误」。
 */
export function byokApiKeyLooksMalformed(apiKey: string): string | undefined {
  const raw = apiKey
  if (raw.trim().length === 0) return 'API Key 不能为空'
  if (/[\r\n]/.test(raw)) return 'API Key 里含换行，请只粘贴密钥本身'
  if (/^["']|["']$/.test(raw.trim())) return 'API Key 首尾带引号，请去掉引号'
  if (/\s/.test(raw.trim())) return 'API Key 里含空格，请只粘贴密钥本身（不要带 "export KEY=" 前缀）'
  return undefined
}
