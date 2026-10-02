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
  /**
   * **平台官方文档明确声明为免费**的模型 id。
   *
   * ⚠️ 与 `excludeModels` 相反：这是**补充**「id 后缀判不出免费」的缺口，
   * 不是替代后缀规则。
   *
   * 为什么需要它：后缀规则（`-free` / `:free` / `_free`）**不可靠** ——
   * 实测 commandcode 的官方定价页把 `stealth/space-bunny-alpha` 列为
   * 「is free. Requests on this model cost no credits. on every plan」，
   * 但它的 id **一个 free 都没有**。只靠后缀会让用户看不到这个免费模型
   * （而「确保会显示 免费的模型」正是这个渠道的主要目的）。
   *
   * ⚠️ **只收官方文档 / 定价页白纸黑字写明的 id**，不收「实测能调通」——
   * 后者是**单个 Key 的权益**，写死会让别的用户在计费模型上毫无防备。
   * 每条都要在注释里留下依据出处，便于日后复核。
   */
  documentedFreeModels?: readonly string[]
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
 * ## ⚠️ 「免费」的信号有两个来源，后缀只是其中之一
 *
 * `[-_:]free$` 只命中 **3 个** id，而实测 200 的有 55 个（deepseek / Kimi / GLM /
 * Qwen 等一大批都不带后缀）。差别在于：那 52 个「实测 200」是**这个 Key 的
 * 权益**，不是平台的公开事实 —— 另一个账号很可能 403。
 * 故本适配器**绝不**把「实测能调通」写死成免费标签。
 *
 * 但**只靠后缀同样不够**：官方定价页
 * （`https://commandcode.ai/docs/resources/pricing-limits`）的 `Free` 分组
 * 明确列出 **4 个**免费模型，其中 `stealth/space-bunny-alpha` 的 id
 * **一个 free 都不带**（页面原文：「`stealth/space-bunny-alpha` is free.
 * Requests on this model cost no credits…on every plan.」）。
 * 只靠后缀会让用户看不到它，而「确保会显示 免费的模型」正是本渠道的主要目的。
 *
 * ⇒ 判据是**两者取并**：后缀命中 **或** 官方文档白名单（`documentedFreeModels`）。
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
  // ⚠️ 官方定价页 `https://commandcode.ai/docs/resources/pricing-limits` 的
  // `Free` 分组明确列出 4 个（页面原文逐字）：
  //   - `laguna-s-2.1-free is free. Requests on this model cost no credits.`
  //   - `ling-3.0-flash-sante:free is free, up to 100 requests a day.`
  //   - `ling-3.1-flash:free is free, up to 300 requests a day.`
  //   - `stealth/space-bunny-alpha is free. Requests on this model cost no credits.`
  // 前三个后缀就能命中，**第四个不能** —— 只靠后缀会漏掉它。
  // 本机实测四个都 `POST /chat/completions` → 200，且 `space-bunny-alpha`
  // 的 `supported_endpoints` 是 `["/chat/completions"]`（本适配器支持）。
  documentedFreeModels: Object.freeze([
    'stealth/space-bunny-alpha',
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
 * ## ⚠️ 免费模型里有一个「不带 -free 后缀」的
 *
 * 官方文档的计价表把 `Big Pickle` 的 Input/Output/Cached Read 三列全标成
 * **`Free`**，正文也写明「`Big Pickle` is a stealth model that's free on OpenCode
 * for a limited time」—— 但它的 id 是 `big-pickle`，**一个 free 都没有**。
 * 只靠后缀会让用户看不到它。故用 `documentedFreeModels` 补上。
 *
 * ## ⚠️ 大量模型**不走** `/chat/completions`
 *
 * 官方文档的端点列给出每个模型的真实端点，实测线上 85 个里有 **58 个**
 * 不在本适配器支持的 `/chat/completions` 上：
 *
 * | 端点 | 模型族 |
 * |---|---|
 * | `/zen/v1/responses` | `gpt-*`（含 6.x）、`grok-*`、`muse-spark-*` |
 * | `/zen/v1/messages` | `claude-*`、`qwen3.x-plus`、`qwen3.8-flash` |
 * | `/zen/v1/models/gemini-*` | `gemini-*` |
 * | `/zen/v1/systemone` | `jev-1.13*` |
 *
 * 列出来却调不通比不列更糟（用户点了模型、发出去、拿到 400，还会以为是自己
 * Key 的问题），故全部下架 —— 见 `excludeModels`。
 *
 * ⚠️ 注意 `muse-spark-1.2-contributor-free` / `muse-spark-1.3-contributor-free`
 * 虽是**免费**模型，但走 `/responses`，本适配器用不了，同样下架。
 */
export const OPENCODE: KeyedProduct = Object.freeze({
  id: 'opencode',
  displayName: 'OpenCode Zen',
  defaultCredentialRef: 'OPENCODE_API_KEY',
  baseUrl: 'https://opencode.ai/zen/v1',
  consoleUrl: 'https://opencode.ai/auth',
  docsUrl: 'https://opencode.ai/docs/zen/',
  probe: {
    // 官方文档表格里标注为 Free 且走 `/chat/completions` 的模型。
    model: 'nemotron-3.5-lightning-free',
    // ⚠️ 必须连报文一起判：无效 Key 是 `AuthError`，而「模型不该走这条协议」
    // 是 `ModelError` —— 两者可能都是 401，只看状态码会误判。
    //
    // ⚠️ 实测补充（重要）：**鉴权发生在路由之前**。用 bogus Key 打
    // `/chat/completions` 时，连 `jev-1.13-free`（走 systemone）也返回
    // `401 AuthError` 而不是 `ModelError` —— 故这条报文判据只在**真 Key**
    // 打到错协议时才会生效。端点归属因此只能靠官方文档表格，不能靠探针。
    invalidIf: (status: number, body: string) => status === 401 && body.includes('AuthError'),
  },
  excludeModels: Object.freeze([
    // `/zen/v1/messages`（Anthropic Messages 形状）
    'claude-fable-5',
    'claude-fable-5-1',
    'claude-haiku-4-5',
    'claude-opus-4-5',
    'claude-opus-4-6',
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-opus-5',
    'claude-opus-5-5',
    'claude-sonnet-4-5',
    'claude-sonnet-4-6',
    'claude-sonnet-5',
    // ⚠️ 下面两个**文档表格里没有**（线上目录比文档多 5 个 id 中的 2 个）。
    // 按同族推断走 `/messages`，采取保守下架（宁可少列，不让用户撞 400）。
    'claude-sonnet-4',
    'claude-sonnet-5-5',
    // `/zen/v1/messages`
    'qwen3.5-plus',
    'qwen3.6-plus',
    'qwen3.8-flash',
    // `/zen/v1/models/gemini-*`（Google 原生形状）
    'gemini-3-flash',
    'gemini-3.1-pro',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.6-flash',
    'gemini-3.7-flash',
    'gemini-3.8-flash',
    // `/zen/v1/responses`
    'gpt-5',
    'gpt-5-codex',
    'gpt-5-nano',
    'gpt-5.1',
    'gpt-5.1-codex',
    'gpt-5.1-codex-max',
    'gpt-5.1-codex-mini',
    'gpt-5.2',
    'gpt-5.2-codex',
    'gpt-5.3-codex',
    'gpt-5.3-codex-spark',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.4-nano',
    'gpt-5.4-pro',
    'gpt-5.5',
    'gpt-5.5-pro',
    'gpt-5.6-luna',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-6-astra',
    'gpt-6-luna',
    'gpt-6-sol',
    'gpt-6.1-sol',
    'grok-4.5',
    'grok-4.6',
    'grok-4.7',
    'grok-build-0.1',
    'muse-spark-1.2',
    'muse-spark-1.3',
    // ⚠️ 这两个是**免费**模型（`-free` 后缀），但走 `/responses`，
    // 本适配器用不了 —— 下架是无奈之举，不是「不愿意显示免费模型」。
    'muse-spark-1.2-contributor-free',
    'muse-spark-1.3-contributor-free',
    // `/zen/v1/systemone`（另一套请求/响应形状，`/systemone` 只有这两个模型在用）
    'jev-1.13',
    'jev-1.13-free',
  ]),
  // ⚠️ 官方文档的计价表把 `Big Pickle` 三列全标成 `Free`，正文写明
  // 「is a stealth model that's free on OpenCode for a limited time」，
  // 但它的 id **不带任何 free 后缀** —— 只靠后缀会漏掉它。
  documentedFreeModels: Object.freeze(['big-pickle']),
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
