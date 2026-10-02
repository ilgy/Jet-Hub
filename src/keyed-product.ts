/**
 * 「粘贴 API Key」类 provider 的产品配置（`commandcode` / `opencode`）。
 *
 * ## 与其余 13 个 provider 的根本差异
 *
 * 其余 provider 的凭据都是**服务端下发**的（OAuth token / 设备码 / 扫码换票），
 * 形态由对方协议决定；这里两个 provider 的凭据是**用户手工粘贴**的 API Key，
 * 因此没有 `startLogin()`、没有续期端点、没有过期时间。
 *
 * 本文件是这一族 provider 的**唯一真相源**：面板标签、端点、控制台地址、
 * Key 校验探测模型、需要下架的模型集都在这里。适配器
 * （`src/keyed-adapter.ts`）与认证服务（`src/keyed-auth.ts`）都**参数化**
 * 接收 `KeyedProduct`，不硬编码任何产品名 —— 新增同类 provider 只需在本表
 * 加一条 + 走 AGENTS.md 的 10 项接线清单。
 *
 * ## 为什么两个平台的端点都**不能**用 `GET /models` 校验 Key
 *
 * 实测（2026-10，本机）：
 *
 * | 平台 | `GET {base}/models` 无 Key | 结论 |
 * |---|---|---|
 * | commandcode | **200**（85 个模型） | 目录端点不鉴权 ⇒ 不能当校验 |
 * | opencode | **200**（85 个模型） | 同上 |
 *
 * 二者都**只**在 chat 端点鉴权，故 Key 校验必须打一次真实的 chat 请求
 * （`max_tokens: 1`）。这也解释了为什么本表需要 `probe` 配置。
 */

/**
 * 一个「粘贴 API Key」provider 的产品配置。
 *
 * 全部字段都参与运行：`baseUrl` 拼端点、`consoleUrl` 给用户取 Key、
 * `probe` 决定 Key 校验判定、`excludeModels` 决定目录里下架哪些模型。
 */
export interface KeyedProduct {
  /** provider id（＝ `PROVIDERS` 面板项 id ＝ 适配器路由名）。 */
  id: string
  /** 面板展示名。 */
  displayName: string
  /** 单凭据模式的默认 ref 名（账号池模式一律用 `XXX_ACCOUNT_<ID>`）。 */
  defaultCredentialRef: string
  /** OpenAI 兼容 base url（已去尾部斜杠）。 */
  baseUrl: string
  /** 用户去这里创建 / 复制 API Key。 */
  consoleUrl: string
  /** 官方文档（面板的「去取 Key」旁链）。 */
  docsUrl?: string
  /**
   * 探测模型（Key 校验用）。
   *
   * ⚠️ **必须是免费档位或最小开销的模型**：校验每次粘贴都会跑一次，
   * 用计费模型会真的扣用户的钱。
   */
  probe: {
    /** 探测用的模型 id。 */
    model: string
    /**
     * 该响应是否表示「Key 无效」。
     *
     * ⚠️ **不能只看状态码**：opencode 对无效 Key 返回
     * `401 {"error":{"type":"AuthError"}}`，但对**不支持的模型**同样返回
     * `401 {"error":{"type":"ModelError"}}`（实测 `space-bunny-free` 走
     * `/systemone`）。只看状态码会把「模型不该走这条路径」误判成「Key 失效」，
     * 用户会一头雾水地反复重新粘贴一个完全正确的 Key。
     */
    invalidIf: (status: number, body: string) => boolean
  }
  /**
   * 目录里**下架**的模型 id（这些模型不能用 `/chat/completions` 调用）。
   *
   * ⚠️ 不是「黑名单开关」，而是**能力事实**：列出来却调不通比不列更糟
   * （用户点了模型、发出去、拿到 400，还会以为是自己 Key 的问题）。
   */
  excludeModels?: readonly string[]
  /** 面板上显示的补充说明。 */
  note?: string
}

/**
 * Command Code（`api.commandcode.ai`）。
 *
 * ## 实测事实（2026-10）
 *
 * - `GET https://api.commandcode.ai/provider/v1/models` → **200 且不鉴权**，
 *   85 个模型；条目键 = `id, object, created, owned_by, name, context_length,
 *   supported_endpoints`，**无任何价格 / free 字段**。
 * - `supported_endpoints` 分布：`/chat/completions` 75 个、`/messages` 10 个
 *   （全部是 claude）。
 * - 真 Key 逐个 `POST /chat/completions`（`max_tokens:1`）：**200 共 55 个**、
 *   403 共 14 个（gpt-5.x/6.x 等，账号无权）、400 共 16 个（claude 换端点 +
 *   `max_output_tokens` 参数问题）。
 *
 * ## ⚠️ 「免费」不能只看后缀 —— 但后缀是唯一可移植的信号
 *
 * `[-_:]free$` 只命中 3 个 id，而实测 200 的有 55 个（deepseek / Kimi / GLM /
 * Qwen 等一大批都不带后缀）。差别在于：那 52 个「实测 200」是**这个 Key 的
 * 权益**，不是平台的公开事实 —— 另一个账号很可能 403。
 * 故本适配器**只**用后缀规则标「免费」，其余一律「未知」，绝不把某个账号的
 * 权益写死成全局标签（写死了会让别的用户在计费模型上毫无防备）。
 */
export const COMMANDCODE: KeyedProduct = Object.freeze({
  id: 'commandcode',
  displayName: 'Command Code',
  defaultCredentialRef: 'COMMANDCODE_API_KEY',
  baseUrl: 'https://api.commandcode.ai/provider/v1',
  consoleUrl: 'https://commandcode.ai/keys',
  docsUrl: 'https://commandcode.ai/docs',
  probe: {
    // 实测：真 Key → 200，bogus Key → 401。
    model: 'inclusionai/ling-3.1-flash:free',
    invalidIf: (status: number) => status === 401,
  },
  // claude 那 10 个只支持 `/messages`（Anthropic Messages 形状）。本适配器
  // 只实现 OpenAI 兼容形状，列出来必然调用失败 —— 实测报错为
  // 400 `Model "claude-sonnet-5-5" must be called via /provider/v1/messages`。
  excludeModels: Object.freeze([
    'claude-sonnet-5-5',
    'claude-sonnet-5',
    'claude-sonnet-4-6',
    'claude-fable-5-1',
    'claude-fable-5',
    'claude-opus-5-5',
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-haiku-4-5-20251001',
  ]),
  note: '在 commandcode.ai/keys 创建 API Key 后粘贴。逐个模型可用性由账号权益决定（同目录下部分模型会返回 403）。',
})

/**
 * OpenCode Zen（`opencode.ai/zen/v1`）。
 *
 * ## 实测事实（2026-10）
 *
 * - `GET https://opencode.ai/zen/v1/models` → **200 且不鉴权**（bogus Key 同样
 *   200），85 个模型；条目只有 `id/object/created/owned_by`。
 * - **没有任何「只验 Key」端点**：`/me`、`/key`、`/keys`、`/usage`、
 *   `/credits`、`/auth`、`/user`、`/account` 全部 404。
 * - 无 Key 时免费档位返回
 *   `403 {"type":"error","error":{"type":"FreeTierError","message":"...can only be used from within OpenCode"}}`；
 *   无效 Key 返回 `401 {"error":{"type":"AuthError","message":"Invalid API key."}}`。
 *   ⚠️ 即**鉴权先于档位判定**：403 FreeTierError 是「匿名请求」的待遇，
 *   带上有效 Key 后不再走免费档位限制。
 * - UA 伪装（`opencode/1.0.0`、`opencode-cli/0.5.0`）与自定义头
 *   （`x-opencode-client` / `x-opencode-version` / `x-zen-client`）**都无法**
 *   绕过匿名态的 FreeTierError —— 故本适配器不伪造任何客户端标识头。
 *
 * ## 12 个 `-free` 模型里有 1 个不能用
 *
 * `jev-1.13-free` 走的是 `/zen/v1/systemone`（另一套请求/响应形状），
 * 官方文档表格明确标注；走 `/chat/completions` 会被拒。故下架
 * `jev-1.13` 与 `jev-1.13-free` 两个 id（`/systemone` 只有这两个模型在用）。
 */
export const OPENCODE: KeyedProduct = Object.freeze({
  id: 'opencode',
  displayName: 'OpenCode Zen',
  defaultCredentialRef: 'OPENCODE_API_KEY',
  baseUrl: 'https://opencode.ai/zen/v1',
  consoleUrl: 'https://opencode.ai/auth',
  docsUrl: 'https://opencode.ai/docs/zen/',
  probe: {
    // 官方文档表格里标注为 Free 的模型（`... | nemotron-3.5-lightning-free | /chat/completions`）。
    model: 'nemotron-3.5-lightning-free',
    // ⚠️ 必须连报文一起判：`space-bunny-free` 也能返回 401，但那是 ModelError
    // （「这个模型不支持 systemone 格式」），与 Key 有效性无关。
    invalidIf: (status: number, body: string) => status === 401 && body.includes('AuthError'),
  },
  excludeModels: Object.freeze(['jev-1.13', 'jev-1.13-free']),
  note: '在 opencode.ai/auth 登录后创建 API Key 再粘贴。带 -free 后缀的模型免额度，其余按 Zen 余额计费。',
})

/** 本族全部 provider（顺序即面板顺序）。 */
export const ALL_KEYED_PRODUCTS: readonly KeyedProduct[] = Object.freeze([COMMANDCODE, OPENCODE])

/** 按 id 取产品配置。 */
export function keyedProductById(id: string): KeyedProduct | undefined {
  return ALL_KEYED_PRODUCTS.find(product => product.id === id)
}

/** 该 id 是否属于本族。 */
export function isKeyedProvider(id: string): boolean {
  return keyedProductById(id) !== undefined
}

/** 目录端点：`{base_url}/models`。 */
export function keyedModelsUrl(baseUrl: string): string {
  return `${baseUrl}/models`
}

/** 推理端点：`{base_url}/chat/completions`。 */
export function keyedChatUrl(baseUrl: string): string {
  return `${baseUrl}/chat/completions`
}

/** 产品展示名（未知 id 回落到原始 id）。用于昵称与错误文案。 */
export function keyedProductLabel(productId: string): string {
  return keyedProductById(productId)?.displayName ?? productId
}

/** 该模型 id 是否被本产品下架（不能用 `/chat/completions` 调）。 */
export function keyedModelExcluded(product: KeyedProduct, modelId: string): boolean {
  return product.excludeModels?.includes(modelId) === true
}
