/**
 * 「粘贴 API Key」族 provider 的凭据模型与纯函数工具（无 IO、可直接单测）。
 *
 * ⚠️ 本文件的判据全部是**实测结论**，不是推测。改动前请先读
 * `docs/agents/keyed.md` 与 `src/keyed-product.ts` 的表头注释。
 */

/** 凭据本体（以 JSON 文本存进 `ctx.credentials`）。 */
export interface KeyedCredential {
  /** 用户粘贴的 API Key 原文。 */
  access_token: string
  /** 产品 id（`commandcode` / `opencode`）。 */
  product: string
  /**
   * 冗余存一份 base_url，而不每次从 `ALL_KEYED_PRODUCTS` 现查。
   *
   * 理由：预设平台的 baseUrl 会随上游调整，而**已经登录的账号不该因为插件
   * 升级就换了端点** —— 那会让老凭据突然打到一个它从未被验证过的地址。
   */
  base_url: string
  /** 用户粘贴时校验通过拿到的模型 id 快照（仅供展示与选号亲和性参考）。 */
  models?: readonly string[]
  /** 账号昵称（`面板名 · Key 尾 4 位`）。 */
  nickname?: string
  /** 过期时间戳（本族几乎永远不写：API Key 没有固定有效期）。 */
  expire_time?: number
}

/** Key 校验结果。 */
export interface KeyedKeyValidation {
  ok: boolean
  models: readonly string[]
  error?: string
}

/** 目录里的一个模型条目。 */
export interface KeyedModelEntry {
  id: string
  /**
   * 是否已知免费。
   *
   * ⚠️ **缺省语义是「未知」，绝不可反推成收费或免费**。详见
   * `parseKeyedFreeModelIds` 的注释。
   */
  free: boolean
  /**
   * 远端声明的可用端点（`supported_endpoints`）。空数组表示远端未声明。
   *
   * Command Code 的目录里 10 个 claude 模型只声明 `/messages`，用
   * `/chat/completions` 调会被拒 —— 这条数据让适配器**数据驱动**地下架它们，
   * 而不是把模型名硬编码成黑名单。
   */
  endpoints: readonly string[]
}

/** 本族的默认单凭据 ref 名（账号池模式一律用 `XXX_ACCOUNT_<ID>`）。 */
export function keyedCredentialRefName(productId: string): string {
  return `${productId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`
}

// ───────────────────────── 目录解析 ─────────────────────────

/** 取出候选条目数组（兼容 `{data}` / `{models}` / 裸数组三种形状）。 */
function keyedModelEntries(body: unknown): readonly unknown[] {
  if (Array.isArray(body)) return body
  if (typeof body !== 'object' || body === null) return []
  const record = body as Record<string, unknown>
  for (const key of ['data', 'models']) {
    const value = record[key]
    if (Array.isArray(value)) return value
  }
  return []
}

/** 从条目里取 id（兼容裸字符串与 `id` / `name` / `model` 三种键）。 */
function keyedEntryId(item: unknown): string | undefined {
  if (typeof item === 'string') return item.trim().length > 0 ? item.trim() : undefined
  if (typeof item !== 'object' || item === null) return undefined
  const record = item as Record<string, unknown>
  for (const key of ['id', 'name', 'model']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/** 从条目里取 `supported_endpoints`（远端不声明则为空数组）。 */
function keyedEntryEndpoints(item: unknown): readonly string[] {
  if (typeof item !== 'object' || item === null) return []
  const value = (item as Record<string, unknown>).supported_endpoints
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/**
 * 该模型 id 的**名字**是否表明它免费。
 *
 * ⚠️ 这是本族唯一可移植的免费信号，见 `src/keyed-product.ts` 的
 * `COMMANDCODE` 表头注释：两个平台的目录都**没有**任何价格字段，
 * 而「能调用成功」是**单个账号的权益**（同一个 id 在别的账号上会 403），
 * 把它写成全局标签会误导其他用户。
 *
 * 覆盖 `-free` / `:free` / `_free` 三种写法（实测两个平台都在用）。
 */
export function keyedModelIdLooksFree(modelId: string): boolean {
  return /[-_:]free$/i.test(modelId.trim())
}

/** 价格的「零」判据：数字 0 或字符串 `"0"` / `"0.0"` 等。 */
function keyedZeroPrice(value: unknown): boolean {
  if (typeof value === 'number') return value === 0
  if (typeof value !== 'string') return false
  const text = value.trim()
  return text.length > 0 && Number(text) === 0
}

/**
 * 条目是否通过**远端价格字段**自证免费。
 *
 * 本族两个平台的目录都不带价格字段，这条是为了将来某天平台补上时能自动生效
 * （以及供 `custom` 类端点复用）。三类判据：`pricing.prompt`+`completion`
 * 双零、`input/output_token_price_per_m` 双零、布尔 `is_free` / `free`。
 */
function keyedEntryLooksFree(item: unknown): boolean {
  if (typeof item !== 'object' || item === null) return false
  const record = item as Record<string, unknown>
  if (record.is_free === true || record.free === true) return true
  const pricing = record.pricing
  if (typeof pricing === 'object' && pricing !== null) {
    const pair = pricing as Record<string, unknown>
    if (keyedZeroPrice(pair.prompt) && keyedZeroPrice(pair.completion)) return true
  }
  if (keyedZeroPrice(record.input_token_price_per_m) && keyedZeroPrice(record.output_token_price_per_m)) {
    return true
  }
  return false
}

/**
 * 解析模型目录为条目数组（去重保序）。
 *
 * `free` = 名字后缀命中 **或** 远端价格字段自证。二者皆不命中即 `false`，
 * 语义是「未知」（见 `KeyedModelEntry.free`）。
 */
export function parseKeyedModelEntries(body: unknown): KeyedModelEntry[] {
  const out: KeyedModelEntry[] = []
  const seen = new Set<string>()
  for (const item of keyedModelEntries(body)) {
    const id = keyedEntryId(item)
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      free: keyedModelIdLooksFree(id) || keyedEntryLooksFree(item),
      endpoints: keyedEntryEndpoints(item),
    })
  }
  return out
}

/** 只要 id 的便捷入口。 */
export function parseKeyedModelList(body: unknown): string[] {
  return parseKeyedModelEntries(body).map(entry => entry.id)
}

// ───────────────────────── 凭据解析 ─────────────────────────

/**
 * 解析凭据 JSON。
 *
 * ⚠️ 先清洗控制字符再 `JSON.parse`：用户从终端复制 Key 时经常带上
 * `\r` / `\n` / 零宽字符，会让 `JSON.parse` 抛
 * `SyntaxError: Bad control character in string literal in JSON`
 * —— 而这份文本是**插件自己写进去的**，抛错会让人完全找不到方向。
 */
export function parseKeyedCredential(raw: string | undefined): KeyedCredential | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    try {
      parsed = JSON.parse(raw.replace(/[\u0000-\u001f]+/g, ' '))
    } catch {
      return undefined
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  const accessToken = typeof record.access_token === 'string' ? record.access_token.trim() : ''
  const baseUrl = typeof record.base_url === 'string' ? record.base_url.trim().replace(/\/+$/, '') : ''
  // ⚠️ 判据必须包含 base_url：没有它就无法拼出端点，账号会变成「看得见但用不了」。
  if (accessToken.length === 0 || baseUrl.length === 0) return undefined
  const product = typeof record.product === 'string' && record.product.trim().length > 0 ? record.product.trim() : 'custom'
  const models = Array.isArray(record.models)
    ? record.models.filter((item): item is string => typeof item === 'string')
    : undefined
  const nickname = typeof record.nickname === 'string' ? record.nickname : undefined
  const expireTime = typeof record.expire_time === 'number' ? record.expire_time : undefined
  return {
    access_token: accessToken,
    product,
    base_url: baseUrl,
    ...models === undefined ? {} : { models },
    ...nickname === undefined ? {} : { nickname },
    ...expireTime === undefined ? {} : { expire_time: expireTime },
  }
}

/** 组装凭据对象。 */
export function buildKeyedCredential(input: {
  apiKey: string
  product: string
  baseUrl: string
  models?: readonly string[]
  nickname?: string
}): KeyedCredential {
  return {
    access_token: input.apiKey.trim(),
    product: input.product,
    base_url: input.baseUrl.trim().replace(/\/+$/, ''),
    ...input.models === undefined ? {} : { models: input.models },
    ...input.nickname === undefined ? {} : { nickname: input.nickname },
  }
}

/**
 * 请求头。
 *
 * ⚠️ **只有这两个头**，不叠加任何厂商私有 `X-*`。
 * 实测：opencode 的免费档位在服务端按「是否来自 OpenCode 客户端」判定，
 * 伪造 `x-opencode-client` / `x-zen-client` / UA **一律无效**
 * （全部仍然 403 FreeTierError）—— 伪造头既无用又多一处会过期的伪装。
 */
export function keyedHeaders(credential: KeyedCredential): Record<string, string> {
  return {
    Authorization: `Bearer ${credential.access_token}`,
    Accept: 'application/json',
  }
}

/** 凭据是否已过期（本族几乎恒为 false）。 */
export function isKeyedExpired(credential: KeyedCredential, nowMs: number = Date.now()): boolean {
  return credential.expire_time !== undefined && credential.expire_time <= nowMs
}

/**
 * 账号昵称：`产品名 · Key 尾 4 位`。
 *
 * ⚠️ **只放尾部 4 位**。昵称会出现在面板与日志里，放前段等于把 Key 前缀
 * 泄露到截图和 bug 报告里。
 */
export function buildKeyedNickname(productLabel: string, apiKey: string, fallbackId: string): string {
  const trimmed = apiKey.trim()
  if (trimmed.length === 0) return productLabel.length > 0 ? productLabel : fallbackId
  return `${productLabel} · ${trimmed.slice(-4)}`
}

/**
 * 粘贴内容的**结构**预检（不做长度与前缀白名单）。
 *
 * ⚠️ 只拦四类「一眼就是复制错了」的输入。**绝不能**加 `sk-` 之类的前缀白名单：
 * 本族平台的 Key 形态各异（实测有 `user_...`、`sk-...`、`oc_...`、纯 hex、
 * 两段式），白名单会把正确的 Key 挡在门外，且用户根本无从判断自己错在哪。
 */
export function keyedApiKeyLooksMalformed(apiKey: string): string | undefined {
  const trimmed = apiKey.trim()
  if (trimmed.length === 0) return 'API Key 不能为空'
  if (/[\r\n]/.test(apiKey)) return 'API Key 里含换行，请只粘贴密钥本身'
  if (/^["']|["']$/.test(trimmed)) return 'API Key 首尾带引号，请去掉引号'
  if (/\s/.test(trimmed)) return 'API Key 里含空格，请只粘贴密钥本身（不要带 "export KEY=" 前缀）'
  return undefined
}

/** base url 形状检查（自定义端点用）。 */
export function keyedBaseUrlLooksValid(baseUrl: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(baseUrl.trim())
}
