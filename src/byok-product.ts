/**
 * BYOK（Bring Your Own Key）预设平台表。
 *
 * 背景：Jet-Hub 原有 13 个 provider **全部**走 OAuth / 设备码 / 扫码登录，
 * 没有任何「粘贴 API Key」的凭证录入形态。而国内一大批送额度的平台
 * （火山方舟、阿里百炼、智谱 GLM、百度千帆、硅基流动…）额度与 OpenAI 兼容
 * 端点都具备，**唯独登录是控制台网页 + 手工建 Key**，因此一个都接不进来。
 *
 * 本模块只承载**单纯的静态数据**：平台 id / 展示名 / `baseUrl` / 文档链接 /
 * 可选备注。任何网络行为都不在这里（在 `src/byok.ts`）。
 *
 * ## 为什么是一个通用 provider 而不是每平台一个
 *
 * 每平台各加一个 provider 会让 `PROVIDERS`（面板）/ 能力表 / 设置命名空间
 * **三方等集**（由 `scripts/lint.mjs` 的 `provider-panel-parity` 与
 * `tests/unit/plugin.spec.ts` 双重锁死）随平台数线性膨胀；且这些平台的
 * 协议层**完全同构**（都是 OpenAI 兼容），差异只有 `baseUrl` 一个字符串。
 * 故按「一个 provider + 平台下拉」收敛，新增平台只需在本表加一行。
 *
 * ## `baseUrl` 的校正依据
 *
 * 每个 `baseUrl` 都用「候选路径 vs 随机路径」**对照组**实测过：
 * 无鉴权打 `GET {baseUrl}/models`，若与随机路径
 * `/___dsh-probe-<nonce>-not-a-real-path___` **状态码不同**才算端点存在。
 *
 * ⚠️ **对照组会给出假阴性**：`open.bigmodel.cn` / `api.z.ai` /
 * `ark.cn-beijing.volces.com` / `api.deepseek.com` 等 origin 在**不带 Key**
 * 时对**任意**路径都返回 401（前置路由鉴权闸门拦在路由前），候选与对照
 * 同码 ⇒ 测不出。这类 origin 必须**带真实 Key** 复测（智谱带 Key 后
 * 立刻显出区分度：候选 200 / 随机 404）。
 */

/**
 * 预设平台配置。
 *
 * 刻意保持为**纯数据 + 无方法**：面板下拉、服务端校验、报错文案都要用它，
 * 且必须能被测试直接断言（不引入任何需要 mock 的依赖）。
 */
export interface ByokPlatform {
  /** 平台 id（稳定标识，落进凭据 JSON，**不可改名**）。 */
  id: string
  /** 面板下拉展示名。 */
  label: string
  /**
   * OpenAI 兼容 base url（**不含** `/chat/completions`）。
   *
   * 适配器拼 `{baseUrl}/models` 与 `{baseUrl}/chat/completions`。
   * ⚠️ 必须以 `https://` 或 `http://` 开头且**不以 `/` 结尾**
   * （拼接契约见 {@link byokChatUrl}）。
   */
  baseUrl: string
  /** 建 Key 的控制台地址（面板提示用户去哪儿拿 Key）。 */
  consoleUrl: string
  /** 额外提示（展示在下拉下方）。 */
  note?: string
  /**
   * 该平台是否**公开**模型目录（`GET /models` 无鉴权即 200）。
   *
   * 仅用于面板文案与测试断言，**不参与鉴权逻辑** —— 带 Key 的请求一律正常发。
   */
  publicCatalog?: boolean
  /**
   * 平台**不下发但确实能调**的免费模型（会与 `/models` 的结果按 id 合并）。
   *
   * ⚠️ 这个字段存在的唯一理由：`/models` 只列**计费**模型。智谱那一批
   * `*-flash` 长期免费，却**不在**
   * `GET https://open.bigmodel.cn/api/paas/v4/models` 的 11 个条目里
   * （实测：该接口只给 glm-4.5 ~ glm-5.3 系列）⇒ 用户余额为 0 时，
   * 插件里看到的**全是收费模型**，于是「是不是全收费？」成为必然的误解。
   *
   * 维护约定：**只加实测过 `POST /chat/completions`（`max_tokens:1`）
   * 返回 2xx 的 id**，不加「文档说免费」的 id。宁可少列（用户仍可在
   * `自定义` 里手填 base url），不可列错 —— 列错会让请求直接 4xx。
   * 同族的 `*-flashx` / `*-airx` 是**计费**型号，实测 429/1113，不得混入。
   */
  freeModels?: readonly string[]
}

/**
 * 预设平台清单。
 *
 * 顺序即面板下拉顺序：国产优先（额度对中国大陆用户最实用），
 * 其后国际/聚合。
 */
export const BYOK_PLATFORMS: readonly ByokPlatform[] = Object.freeze([
  {
    id: 'zhipu',
    label: '智谱 GLM（开放平台）',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    consoleUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    note: '国际站同一 Key 可用：api.z.ai/api/paas/v4',
    // 实测（余额为 0 的账号，max_tokens:1）：这 8 个 200，而 /models 里的
    // glm-4.5 ~ glm-5.3 全部 429/1113。同族 -flashx / -airx / glm-5.x-flash
    // 分别实测 429 与 400/1211，故不列入。
    freeModels: [
      'glm-4-flash',
      'glm-4-flash-250414',
      'glm-4.5-flash',
      'glm-z1-flash',
      'glm-4v-flash',
      'glm-4.1v-thinking-flash',
      'glm-4.6v-flash',
      'glm-4.7-flash',
    ],
  },
  {
    id: 'dashscope',
    label: '阿里云百炼（通义千问）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    consoleUrl: 'https://bailian.console.aliyun.com/',
    note: '新用户各模型有免费额度',
  },
  {
    id: 'volces',
    label: '火山方舟（豆包）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    consoleUrl: 'https://console.volcengine.com/ark',
    note: '新用户每个模型 50 万 tokens',
  },
  {
    id: 'qianfan',
    label: '百度千帆（文心）',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    consoleUrl: 'https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application',
  },
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    consoleUrl: 'https://cloud.siliconflow.cn/account/ak',
  },
  {
    id: 'moonshot',
    label: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    consoleUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/v1',
    consoleUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    baseUrl: 'https://api.minimax.chat/v1',
    consoleUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
  },
  {
    id: 'stepfun',
    label: '阶跃星辰 StepFun',
    baseUrl: 'https://api.stepfun.com/v1',
    consoleUrl: 'https://platform.stepfun.com/interface-key',
  },
  {
    id: 'longcat',
    label: '美团 LongCat',
    baseUrl: 'https://api.longcat.chat/openai/v1',
    consoleUrl: 'https://longcat.chat/platform/api_keys',
    note: '每日 10 万 tokens，凌晨自动重置',
  },
  {
    id: 'modelbest',
    label: '面壁智能 ModelBest',
    baseUrl: 'https://api.modelbest.cn/v1',
    consoleUrl: 'https://platform.modelbest.cn/',
  },
  {
    id: 'sensenova',
    label: '商汤日日新 SenseNova',
    baseUrl: 'https://api.sensenova.cn/v1/llm',
    consoleUrl: 'https://console.sensecore.cn/',
    note: '公测期间免费；base 路径随版本调整，如失败请改控制台所示地址',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    consoleUrl: 'https://openrouter.ai/keys',
    note: '免费模型 50 次/天',
    publicCatalog: true,
  },
  {
    id: 'chutes',
    label: 'Chutes.ai',
    baseUrl: 'https://llm.chutes.ai/v1',
    consoleUrl: 'https://chutes.ai/app/api',
    publicCatalog: true,
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    consoleUrl: 'https://console.groq.com/keys',
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    consoleUrl: 'https://cloud.cerebras.ai/',
  },
  {
    id: 'mistral',
    label: 'Mistral AI',
    baseUrl: 'https://api.mistral.ai/v1',
    consoleUrl: 'https://console.mistral.ai/api-keys/',
  },
  {
    id: 'together',
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    consoleUrl: 'https://api.together.ai/settings/api-keys',
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    consoleUrl: 'https://fireworks.ai/account/api-keys',
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    consoleUrl: 'https://build.nvidia.com/',
    publicCatalog: true,
  },
  {
    id: 'sambanova',
    label: 'SambaNova Cloud',
    baseUrl: 'https://api.sambanova.ai/v1',
    consoleUrl: 'https://cloud.sambanova.ai/apis',
    publicCatalog: true,
  },
  {
    id: 'novita',
    label: 'Novita AI',
    baseUrl: 'https://api.novita.ai/v3/openai',
    consoleUrl: 'https://novita.ai/settings/key-management',
    publicCatalog: true,
  },
  {
    id: 'nebius',
    label: 'Nebius AI Studio',
    baseUrl: 'https://api.studio.nebius.ai/v1',
    consoleUrl: 'https://studio.nebius.com/settings/api-keys',
  },
  {
    id: 'hyperbolic',
    label: 'Hyperbolic',
    baseUrl: 'https://api.hyperbolic.xyz/v1',
    consoleUrl: 'https://app.hyperbolic.xyz/settings',
  },
  {
    id: 'ollama',
    label: '本地 Ollama / LM Studio',
    baseUrl: 'http://127.0.0.1:11434/v1',
    consoleUrl: 'https://ollama.com/download',
    note: '本地服务，通常无需 Key（任意非空字符串即可）',
  },
  {
    id: 'custom',
    label: '自定义（手填 base url）',
    baseUrl: '',
    consoleUrl: '',
    note: '任何 OpenAI 兼容端点。Key 会被先打 /models 验证',
  },
] as const)

/** BYOK provider 的路由名（面板 id / 账号池 provider 字段 / 设置命名空间后缀）。 */
export const BYOK = Object.freeze({
  id: 'byok',
  displayName: '自定义 API Key（BYOK）',
  /**
   * 兜底凭据 ref。
   *
   * ⚠️ BYOK 是**多账号**设计（一个账号 = 一个「平台 + Key」组合），
   * 凭据一律写在 `<PREFIX>_ACCOUNT_<SUFFIX>`；本常量只用于
   * `accountPool.getAvailableAccount` 全空时的兜底解析路径，
   * 与 Cline 的 `CLINE.defaultCredentialRef` 同作用。
   */
  defaultCredentialRef: 'BYOK_ACCESS_TOKEN',
} as const)

/** 按 id 取平台；未命中返回 `undefined`（**不抛错**，调用方决定如何报错）。 */
export function byokPlatformById(id: string): ByokPlatform | undefined {
  return BYOK_PLATFORMS.find(platform => platform.id === id)
}

/**
 * 该平台**已知免费但 `/models` 不下发**的模型 id。
 *
 * 未命中平台 / 平台没配 `freeModels` 时返回空数组（不是 `undefined`）——
 * 调用方直接 `for (... of ...)` 展开，省一次空值判断。
 */
export function byokFreeModelsForPlatform(platformId: string): readonly string[] {
  return byokPlatformById(platformId)?.freeModels ?? []
}

/**
 * 解析用户实际要用的 base url。
 *
 * - 预设平台：用表里的 `baseUrl`；
 * - `custom` 平台或表里 `baseUrl` 为空的项：用调用方传来的 `customBaseUrl`。
 *
 * ⚠️ 该函数**只做字符串规整，不做安全校验**（是否 https、是否指向内网
 * 由用户自负 —— 本地 Ollama 场景必须允许 `http://127.0.0.1`）。
 * 规整内容：去首尾空白、去**尾部**斜杠（拼接契约要求）。
 *
 * @param platformId - 平台 id。
 * @param customBaseUrl - `custom` 平台的手填地址。
 * @returns 可用 base url；无法确定时返回 `undefined`。
 */
export function byokResolveBaseUrl(
  platformId: string,
  customBaseUrl?: string,
): string | undefined {
  const platform = byokPlatformById(platformId)
  const raw = platform !== undefined && platform.baseUrl.length > 0
    ? platform.baseUrl
    : customBaseUrl
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (trimmed.length === 0) return undefined
  return trimmed
}

/** 拼模型目录地址。 */
export function byokModelsUrl(baseUrl: string): string {
  return `${baseUrl}/models`
}

/** 拼对话补全地址。 */
export function byokChatUrl(baseUrl: string): string {
  return `${baseUrl}/chat/completions`
}

/**
 * 判定一个 base url 是否**明显不可用**（用于弹窗即时校验）。
 *
 * 只拦「没写协议头」这一种低级错误 —— 其余一律放行，让 `GET /models`
 * 的真实响应说话（用户可能在校验逻辑没覆盖的端点上仍然可用）。
 */
export function byokBaseUrlLooksValid(baseUrl: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(baseUrl.trim())
}
