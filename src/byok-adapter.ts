/**
 * BYOK（Bring Your Own Key）LLM 适配器。
 *
 * ## 为什么单独一套而不是复用某个既有适配器
 *
 * BYOK 的目标是**任意** OpenAI 兼容端点，协议层（消息序列化 / SSE 消费 /
 * 错误归类）**完全复用** `src/openai-compat.ts` —— 与 cline / qoder / loomy /
 * raccoon 同做法。差异只有两处，但两处都足够根本：
 *
 * 1. **多平台共存**：一个 provider 路由（`byok`）下同时挂着智谱、百炼、硅氧…
 *    的 Key。`base_url` 来自**账号凭据**而非产品常量，故 `send()` 必须先选定
 *    账号再拼 URL —— 既有的 Cline 式「产品常量定端点」在这里不成立。
 * 2. **模型目录是各账号的并集**：每个平台有自己的 `/models`。目录必须把
 *    所有账号的模型合起来播报，否则用第二个账号的模型时 composer 里看不到。
 *
 * ## 模型 → 账号的亲和性（本适配器最关键的一处）
 *
 * `AccountPool.getAvailableAccount` **只按 provider / enabled / 限流** 过滤，
 * 它不知道「这个模型属于哪个平台的 Key」。若把选号完全交给它，就会出现
 * 「第一个账号是智谱、请求的却是百炼的模型」→ 上游 404/400，
 * 而报错文案与真实原因无关，用户完全无从判断。
 *
 * 故本适配器**自己**做模型亲和选号（{@link ByokAdapter.pickCredential}）：
 * 按账号池的**手动顺序**逐个看该账号的模型集是否含目标模型，
 * 命中即用；全都不命中时退回第一个可用账号，让上游报出真实错误。
 * 这与 Loomy 适配器「自己按余额分档选号」是同一类处理。
 *
 * ## 不播报的两种能力（宁缺毋滥）
 *
 * - **图片输入**：`GET /models` 不含多模态声明，各平台字段名互不相同，
 *   无法可靠判定 ⇒ 一律按**文本**播报。DSH 会把图片投影成文本占位符，
 *   绝不出现「声明支持却发出去 400」的形态（与 TRAE 分册同一约定）。
 * - **思考强度**：大多数第三方平台不认 `reasoning_effort`，且 DSH 只在
 *   适配器播报后才注入 ⇒ 不播报即永不注入，避免无谓的 400。
 */

import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AccountPool, providerCatalogVisible } from './account-pool.js'
import { settingsNamespaceFor } from './settings-compat.js'
import type { Context } from '@deepseek-ai/cordis'
import { BYOK, byokChatUrl, byokFreeModelsForPlatform, byokModelsUrl, byokPlatformById } from './byok-product.js'
import {
  byokHeaders,
  isByokExpired,
  parseByokFreeModelIds,
  parseByokModelList,
  type ByokCredential,
} from './byok.js'
import {
  collectImages,
  consumeOpenAiSse,
  errorDetail,
  httpErrorCode,
  isTransportError,
  serializeMessages,
} from './openai-compat.js'

/** 换号次数上限（对齐 buddy / lobsterai / cline / trae 的 `MaxRotate = 3`）。 */
const BYOK_MAX_ROTATE = 3

/**
 * 单次请求输出上限的安全边界。
 *
 * 第三方平台的真实上限差异极大（4k 到 100k+），且 `/models` **不下发**
 * `maxOutputTokens`。这里只做「防止 DSH 注入一个来自其它 provider 的
 * 荒谬大值」的兜底，取 32k —— 远低于绝大多数平台的上限，
 * 不会因我们而 4xx；真正需要更大值的用户可在会话里显式指定
 * （`options.maxTokens` 优先，且同样经过本夹取）。
 */
const BYOK_MAX_OUTPUT_TOKENS = 32_768

/** 收敛输出上限；非法值返回 `undefined`（**不编造数值**）。 */
function clampByokMaxTokens(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  const integer = Math.floor(value)
  if (integer <= 0) return undefined
  return Math.min(integer, BYOK_MAX_OUTPUT_TOKENS)
}

/**
 * 模型目录缓存有效期（毫秒）。
 *
 * ⚠️ 与其余适配器（cline / buddy / trae / lobsterai 一律是**首个成功结果
 * 永久缓存**）有意不同。BYOK 的目录有两个随时会变的来源，永久缓存会直接
 * 表现为用户报障「平台上了新模型，插件里看不到，重启才出现」：
 *
 * 1. 平台自己上新（智谱一年内从 glm-4.5 走到 glm-5.3 一整代）；
 * 2. **用户在插件里新增 / 删除账号** —— 第二个账号往往是别的平台，
 *    它的模型必须立刻出现在同一个 `byok` 路由下。
 *
 * 取 5 分钟：打开选择器这类高频读取几乎全部命中缓存，而新模型在一个
 * TTL 内一定会自动出现。
 */
const BYOK_MODELS_TTL_MS = 5 * 60_000

/**
 * 目录拉取**失败**后的重试冷却（毫秒）。
 *
 * 只在「一次都没拉到模型」且「账号指纹没变」时生效：没有它，池里还没
 * 账号 / Key 全错时，面板每渲染一次就是一轮网络请求。已经拿到过成功目录
 * 时不启用冷却 —— TTL 本身就是节流，再叠一层会让「刚新增账号」被上一次
 * 失败卡住 30 秒，那正是「更新不及时」的来源。
 */
const BYOK_MODELS_RETRY_MS = 30_000

/**
 * 目录指纹：账号 id + 各账号端点。
 *
 * `base_url` 参与而不仅是 id —— 同一个账号被换成另一个平台的 Key 时模型集
 * 完全不同。排序后再拼，故拖拽调序（集合不变）不会误判成「账号变了」。
 */
function byokModelSignature(
  items: readonly { accountId: string; credential: ByokCredential }[],
): string {
  return items
    .map(item => `${item.accountId}@${item.credential.base_url}`)
    .sort()
    .join('|')
}

/**
 * 两次目录的模型 id 集合是否相同（顺序无关）。
 *
 * 顺序无关是必须的：并集顺序随账号池顺序变，但那是**同一个目录**，
 * 不该把用户界面上的列表推倒重来。
 *
 * ⚠️ 必须连 `free` 一起比：平台把某个模型从收费改成免费（或反之）时
 * id 集合**一个字都没变**，只比 id 会让界面上少一个「免费」后缀且
 * 永远刷不出来 —— 与「只比 id 不看 TTL」是同一类漏判。
 */
function byokSameModelIds(a: readonly ByokModel[] | undefined, b: readonly ByokModel[]): boolean {
  if (a === undefined || a.length !== b.length) return false
  const left = new Map(a.map(model => [model.id, model.free === true]))
  for (const model of b) {
    if (left.get(model.id) !== (model.free === true)) return false
  }
  return true
}

/**
 * SSE 空闲超时（毫秒）。
 *
 * ⚠️ **必须在函数内读 env**：模块顶层常量会在 import 时定型，
 * 导致测试里设环境变量不生效（与 cline / lobsterai 同因）。
 */
function resolveFirstTokenTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_BYOK_SSE_FIRST_TOKEN_TIMEOUT_MS ?? '', 10) || 120_000
}
function resolveChunkTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_BYOK_SSE_CHUNK_TIMEOUT_MS ?? '', 10) || 120_000
}

/**
 * 模型在界面上的显示名。
 *
 * ⚠️ 后缀放在 `name` 而不是 `description`：本仓的约定是「计费相关的一切
 * 都进 `name`」（见 AGENTS.md 的 billing multiplier 一条），`description`
 * 在部分宿主界面里根本不渲染。
 *
 * ⚠️ 只在**确凿免费**时加后缀。绝大多数平台的 `/models` 不给价格字段，
 * 那些模型的 `free` 是 `undefined`（未知），**不能**标成「免费」——
 * 标错会让用户在最贵的那一档上跑而毫无防备。
 */
function byokModelLabel(model: ByokModel): string {
  return model.free === true ? `${model.id}（免费）` : model.id
}

/**
 * 拉取到的原始模型条目。
 *
 * BYOK 的 `/models` 通常只给 id；只有**平台自己报了价格**（OpenRouter /
 * Novita）或**平台表里配了 `freeModels`**（智谱）时，才会带上 `free`。
 * ⚠️ `free` 缺省的语义是**未知**，不是「收费」；见
 * {@link parseByokFreeModelIds}。
 */
export interface ByokModel {
  id: string
  /** 可判定为免费（价格字段确凿为 0，或平台表显式列出）。 */
  free?: boolean
}

/** `ByokAdapter` 的构造选项。 */
export interface ByokAdapterOptions {
  /** 默认凭据 ref（仅用于类型/日志，实际解析走下面的解析器）。 */
  credentialRef: CredentialRef
  /**
   * 兜底凭据解析（账号池全空时走这里）。
   *
   * 与 Cline 的 `resolveCredential` 同作用；**不是**主要路径 ——
   * 主要路径是 {@link ByokAdapterOptions.resolveCredentialForAccount}。
   */
  resolveCredential: () => Promise<ByokCredential | undefined>
  /**
   * 按账号 id 解析凭据（**不检查 enabled**，与池的
   * `resolveCredentialForAccount` 同语义）。
   */
  resolveCredentialForAccount?: (accountId: string) => Promise<ByokCredential | undefined>
  /**
   * 列出该 provider 下的全部账号条目（按池的手动顺序）。
   *
   * 缺省时退化为「只用 `resolveCredential()` 单账号」，目录也只有那一份。
   */
  listAccountEntries?: () => Promise<readonly { id: string; credentialRef: string }[]>
  /** 静默续期（BYOK 无续期端点，通常为空操作；保留以对齐适配器契约）。 */
  refresh?: () => Promise<void>
  /** 多账号池（用于限流时切换账号、模型黑名单、账号门控）。 */
  accountPool?: AccountPool
  /**
   * 目录加载失败的告警出口。
   *
   * ⚠️ **必填**，且刻意不用 `console.warn`：`src/` 的 `console.*` 是**只可下调**的
   * 棘轮基线（`scripts/lint.mjs` 的 `consoleInSrc`），新增一处就得从别处还回来。
   * 更重要的是宿主的 `ctx.logger` 才带上下文 —— 适配器拿不到 `ctx`，故由
   * `src/index.ts` 装配时绑定 `message => ctx.logger.warn(message)`。
   * 做成必填而不是可选带默认值：漏传会让目录加载失败**静默无痕**，
   * 而「模型列表突然空了但没有任何日志」是这类问题里最难查的一种。
   */
  warn: (message: string) => void
  /** 读取图片附件字节（本适配器**不声明**图片能力，故实际不会调用）。 */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
  /** 模型目录加载器覆盖（测试用）。 */
  loadModels?: (options: { credential: ByokCredential }) => Promise<{ models: ByokModel[]; warnings: string[] }>
  /**
   * 目录内容**发生变化**时的回调（新增或移除模型时触发一次）。
   *
   * 装配处绑到 `ctx.emit('llm/adapters-updated')`。没有它，自动刷新只更新了
   * 服务端内存，而客户端的 `ModelCatalogDirectory` 在 `status === 'ready'` 时
   * **短路返回缓存**、只在宿主事件上 `refresh()` ⇒ 用户仍然要重启才看得到
   * 新模型（与「关闭模型」是同一处坑，见 `broadcastCatalogChanged`）。
   *
   * 只做通知，**不改变拓扑**（不增删 provider / adapter），故 dsh-llm 的
   * invariant 监听不会误报。
   */
  onCatalogChanged?: () => void
}

/**
 * 默认目录加载：`GET {base_url}/models`。
 *
 * ⚠️ 该请求本身就是**Key 校验**（`login.submitKey` 也走这里），故返回的
 * 错误文案要能直接给用户看 —— 上游报文（`errorDetail`）优先，
 * 空报文才回落到状态码描述。
 */
export async function loadByokModels(
  credential: ByokCredential,
  fetcher: typeof fetch = fetch,
): Promise<{ models: ByokModel[]; warnings: string[] }> {
  const response = await fetcher(byokModelsUrl(credential.base_url), {
    method: 'GET',
    headers: byokHeaders(credential),
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
  const ids = parseByokModelList(parsed)
  const freeFromApi = parseByokFreeModelIds(parsed)
  const models: ByokModel[] = ids.map(id => freeFromApi.has(id) ? { id, free: true } : { id })
  const seen = new Set(ids)
  // 平台表里列出的「免费但 /models 不下发」的模型：已在列表里的**就地补标记**
  // （平台哪天把它加回 /models，也不该丢掉「免费」后缀），其余追加在末尾
  // —— 追加保证既有条目的顺序不变，避免目录抖动导致界面重排。
  for (const id of byokFreeModelsForPlatform(credential.platform)) {
    if (seen.has(id)) {
      const at = models.findIndex(model => model.id === id)
      if (at >= 0) models[at] = { id, free: true }
      continue
    }
    seen.add(id)
    models.push({ id, free: true })
  }
  return { models, warnings: [] }
}

/**
 * BYOK 模型适配器。
 *
 * 一个实例同时服务池中**全部** BYOK 账号（可能跨多个平台）。
 */
export class ByokAdapter extends LlmAdapter {
  /** 合并后的模型目录（**最后一次成功**的结果）。 */
  private remoteModels: ByokModel[] | undefined
  /** 上一次成功填充目录的时间（{@link BYOK_MODELS_TTL_MS} 的基准）。 */
  private remoteModelsAt = 0
  /** 上一次尝试拉取的时间（失败冷却基准）。 */
  private lastAttemptAt = 0
  /** 上一次尝试是否**一个模型都没拉到**（决定是否启用冷却）。 */
  private lastAttemptFailed = false
  /** 上一次尝试对应的账号指纹（指纹变了就不吃冷却）。 */
  private attemptedSignature: string | undefined
  /** 上一次**成功**目录对应的账号指纹。 */
  private remoteSignature: string | undefined
  /** 正在进行中的目录加载（避免并发重复请求）。 */
  private loading: Promise<void> | undefined
  /**
   * 账号 id → 该账号可用的模型 id 集合。
   *
   * 用于 {@link pickCredential} 的亲和性判定。`undefined` 表示
   * 「还没拉到 / 拉取失败」⇒ 该账号**不做模型过滤**（保守放行），
   * 否则一次目录抖动会让所有请求都选不到号。
   */
  private readonly accountModels = new Map<string, readonly string[]>()

  constructor(private readonly options: ByokAdapterOptions) {
    super()
  }

  /**
   * 注入的 fetch（测试用）；默认为全局 fetch。
   *
   * ⚠️ **必须是 getter**：构造期求值会把 `globalThis.fetch` 冻结成当时的引用，
   * 使运行时装上的 fetch 补丁（billion-context 压缩代理即靠此接管模型流量）
   * 对本适配器发出的请求失效 —— 表现为压缩静默不生效。
   * 由 lint 规则 `no-fetch-capture` 强制（与 8 个既有适配器同约定）。
   */
  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch
  }

  /** 描述本适配器拥有的 provider 路由。 */
  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : BYOK.id
    return { id, name: BYOK.displayName }
  }

  /**
   * 本适配器**只播报文本**输入。
   *
   * 见文件头「不播报的两种能力」：`GET /models` 不含多模态声明，
   * 各平台字段名互不相同（有的在 `/models`、有的只在文档里），
   * 无法可靠判定 ⇒ 按不支持的负能力处理，而不是猜。
   */
  private inputModalitiesFor(_model: string): readonly ('text' | 'image')[] {
    return ['text']
  }

  /**
   * 读取池中全部 BYOK 账号的凭据（按手动顺序）。
   *
   * 单账号凭据解析失败只跳过该账号（`warn` 由调用方决定），
   * **不影响其余账号** —— 一个 Key 贴错不该让整个面板的模型都没了。
   */
  private async resolveAllCredentials(): Promise<Array<{ accountId: string; credential: ByokCredential }>> {
    const out: Array<{ accountId: string; credential: ByokCredential }> = []
    const entries = this.options.listAccountEntries !== undefined
      ? await this.options.listAccountEntries()
      : []
    for (const entry of entries) {
      const credential = await this.options.resolveCredentialForAccount?.(entry.id)
      if (credential === undefined) continue
      out.push({ accountId: entry.id, credential })
    }
    if (out.length > 0) return out
    // 池为空 / 未接线：退回兜底单凭据路径（保证旧行为可用）。
    const single = await this.options.resolveCredential()
    if (single === undefined) return []
    return [{ accountId: '', credential: single }]
  }

  /**
   * 加载全部账号的模型目录并合并（并缓存每账号的模型集）。
   *
   * ⚠️ 缓存策略**不是**「首个成功即永久缓存」（cline / buddy / trae /
   * lobsterai 才是那样）。这里每次调用都先算一次账号指纹与时间戳：
   *
   * - 指纹变了（新增 / 删除账号、某账号换了端点）⇒ **立即**重拉，不受 TTL 限制；
   * - 只是过了 {@link BYOK_MODELS_TTL_MS} ⇒ 重拉（平台上新的模型自动出现）；
   * - 都没变 ⇒ 直接用缓存，**一次网络都不打**。
   *
   * 并发调用共享同一个 in-flight Promise；拉取失败**保留旧目录**并进入
   * {@link BYOK_MODELS_RETRY_MS} 冷却 —— 一次网络抖动不该让选择器里的模型
   * 全没了，也不该让面板每次渲染都打一轮网络。
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
      // 只有自己仍是当前任务时才清空：并发调用者可能已经接手。
      if (this.loading === task) this.loading = undefined
    }
  }

  /** {@link ensureRemoteModels} 的实际执行体（单个 in-flight）。 */
  private async loadRemoteModelsOnce(): Promise<void> {
    try {
      const credentials = await this.resolveAllCredentials()
      const signature = byokModelSignature(credentials)
      const now = Date.now()
      const fresh = this.remoteModels !== undefined
        && signature === this.remoteSignature
        && now - this.remoteModelsAt < BYOK_MODELS_TTL_MS
      if (fresh) return
      // 冷却只针对「上一次一个模型都没拉到、且账号没变」的情形。
      // 已经有成功目录时不吃冷却：TTL 本身就是节流，否则用户刚新增账号
      // 会被上一次失败卡住 30 秒 —— 那正是「更新不及时」。
      if (
        this.lastAttemptFailed
        && signature === this.attemptedSignature
        && now - this.lastAttemptAt < BYOK_MODELS_RETRY_MS
      ) {
        return
      }
      this.lastAttemptAt = now
      this.attemptedSignature = signature

      const seen = new Set<string>()
      const union: ByokModel[] = []
      const perAccount = new Map<string, readonly string[]>()
      for (const { accountId, credential } of credentials) {
        let models: ByokModel[]
        try {
          const loaded = await (this.options.loadModels ?? (async (o: { credential: ByokCredential }) =>
            loadByokModels(o.credential, this.fetchImpl)))({ credential })
          models = loaded.models
        } catch (error) {
          // 单个账号拉取失败：不缓存它的模型集（⇒ 不做模型过滤，保守放行），
          // 也不影响其它账号的目录。
          this.options.warn(
            `[jet-hub] byok 模型目录拉取失败（账号 ${accountId || '(兜底)'}）：${error instanceof Error ? error.message : String(error)}`,
          )
          continue
        }
        if (accountId.length > 0) {
          perAccount.set(accountId, models.map(m => m.id))
        }
        for (const model of models) {
          if (seen.has(model.id)) continue
          seen.add(model.id)
          union.push(model)
        }
      }

      // 账号已被删掉时同步清掉它的模型集，否则「换号」会一直按旧账号的
      // 亲和性选号，把请求打到错误的平台上。
      this.accountModels.clear()
      for (const [accountId, modelIds] of perAccount) {
        this.accountModels.set(accountId, modelIds)
      }

      if (union.length === 0) {
        // 一个模型都没拉到（池里还没账号 / 全部失败）：**不覆盖**旧目录，
        // 也不推进成功后时间戳 ⇒ 下次调用仍会（按冷却）重试。
        this.lastAttemptFailed = true
        return
      }

      const changed = !byokSameModelIds(this.remoteModels, union)
      this.remoteModels = union
      this.remoteModelsAt = now
      this.remoteSignature = signature
      this.lastAttemptFailed = false
      if (changed) this.notifyCatalogChanged()
    } catch (error) {
      this.lastAttemptFailed = true
      this.options.warn(`[jet-hub] byok 模型目录加载异常：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 通知宿主「目录可能变了」。
   *
   * ⚠️ 通知失败**不能**反噬已经拿到的目录：吞掉异常只记日志，
   * 与 `broadcastCatalogChanged` 同一取舍。
   */
  private notifyCatalogChanged(): void {
    try {
      this.options.onCatalogChanged?.()
    } catch (error) {
      this.options.warn(`[jet-hub] byok 目录变更通知失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 设置页目录：**同步**返回，且不受黑名单影响。
   *
   * ⚠️ 判据必须**同时**看时间戳，不能只看 `remoteModels === undefined`：
   * 只看 `undefined` 会让「平台上新模型」永远不自动出现（正是本适配器
   * 引入 TTL 要解决的那一种）。同步签名不能等网络，故这里只**触发**
   * 一次后台刷新，本次仍返回当前快照。
   */
  listAllModels(): readonly { id: string; name: string }[] {
    const source = this.remoteModels ?? []
    if (this.remoteModels === undefined || Date.now() - this.remoteModelsAt >= BYOK_MODELS_TTL_MS) {
      void this.ensureRemoteModels()
    }
    return source.map(model => ({ id: model.id, name: byokModelLabel(model) }))
  }

  /** 模型目录（受黑名单过滤 + 账号门控）。 */
  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // ⚠️ 门控必须放在 ensureRemoteModels **之前**：没有已登录账号时省一次 HTTP。
    if (!await providerCatalogVisible(this.options.accountPool, BYOK.id)) return []
    await this.ensureRemoteModels()
    const disabled = this.options.accountPool?.disabledModelsFor(BYOK.id)
    const source = this.remoteModels ?? []
    return source
      .filter(model => disabled?.has(model.id) !== true)
      .map(model => ({
        provider: BYOK.id,
        id: model.id,
        name: byokModelLabel(model),
        inputModalities: this.inputModalitiesFor(model.id),
      }))
  }

  /**
   * 解析模型元数据。
   *
   * ⚠️ **不声明 `reasoning`，也不声明 `defaultMaxTokens`**：`/models` 不含
   * 这两类信息，BYOK 也无法像 CodeBuddy 那样从产品兜底表取（用户可能接任何
   * 端点）。编造数值会直接导致「整轮对话起不来」（`INVALID_MODEL_MAX_TOKENS`）
   * 或被上游拒收。`context` 同样不声明 —— 未声明时 DSH 用会话自身配置。
   */
  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : BYOK.id
    return { provider: id, id: model, name: model }
  }

  /**
   * 绑定「模型元数据 + 一次 dispatch」到同一代。
   *
   * BYOK 的凭据/端点在 `stream()` 内选定，故这里只需转发模型解析。
   */
  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
    model: LlmResolvedModelInfo
    stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: options => this.stream(options),
    }
  }

  /**
   * 选定「最适合该模型」的账号凭据。
   *
   * 顺序 = 账号池的手动拖拽顺序（**不做任何重排**，与「账号顺序即选号优先级」
   * 铁律一致）。亲和性规则：
   *
   * 1. 该账号的模型集**含**目标模型 → 命中；
   * 2. 该账号的模型集**未知**（未拉到 / 拉失败）→ 也算命中（保守放行）；
   * 3. 全都不命中 → 退回第一个可用账号，让上游报出真实错误
   *    （比在本地编造「没有账号支持该模型」更诚实，也保留自定义端点
   *    `models` 覆盖为空时的可用性）。
   *
   * @param modelId - 目标模型；空串表示不关心模型（如目录聚合）。
   * @param excludeAccountIds - 已试过的账号，避免换号时原地打转。
   */
  private async pickCredential(
    modelId: string,
    excludeAccountIds?: ReadonlySet<string>,
  ): Promise<{ accountId: string; credential: ByokCredential } | undefined> {
    const all = await this.resolveAllCredentials()
    const notExcluded = all.filter(item => excludeAccountIds?.has(item.accountId) !== true)
    const pool = notExcluded.length > 0 ? notExcluded : all
    if (modelId.length === 0) return pool[0]
    for (const item of pool) {
      const known = this.accountModels.get(item.accountId)
      if (known === undefined || known.includes(modelId)) return item
    }
    return pool[0]
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 图片收集：本适配器播报 text-only，故 DSH 不会把图片放进 content。
    // 但仍按既有适配器同款扫描一次，若真出现图片则明确报错而不是静默丢弃。
    const imageRefs = new Map<string, unknown>()
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs)
    }
    if (imageRefs.size > 0) {
      throw new LlmError(
        `byok: 模型 "${options.model}" 未声明图片能力（自定义端点无法判定多模态支持）`,
        'UNSUPPORTED_CONTENT',
      )
    }

    // 1. 选定账号与凭据
    let picked = await this.pickCredential(options.model)
    if (picked === undefined || isByokExpired(picked.credential)) {
      await this.options.refresh?.()
      picked = await this.pickCredential(options.model)
    }
    if (picked === undefined || picked.credential.access_token.length === 0) {
      throw new LlmError('byok: no usable credential; add an account with your API key first', 'MISSING_CREDENTIAL')
    }
    let credential = picked.credential
    let currentAccountId = picked.accountId

    // 2. 构造 OpenAI 请求体（复用共享序列化）
    const messages = serializeMessages(options.messages)
    const bodyObj: Record<string, unknown> = {
      model: options.model,
      messages: options.system !== undefined && options.system.length > 0
        ? [{ role: 'system', content: options.system }, ...messages]
        : messages,
      stream: true,
    }
    if (options.tools !== undefined && options.tools.length > 0) {
      bodyObj.tools = options.tools.map(tool => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }))
    }
    if (options.temperature !== undefined) bodyObj.temperature = options.temperature
    const maxTokens = clampByokMaxTokens(options.maxTokens)
    if (maxTokens !== undefined) bodyObj.max_tokens = maxTokens
    if (options.stop !== undefined && options.stop.length > 0) bodyObj.stop = options.stop

    const body = JSON.stringify(bodyObj)

    // 3. 发送
    //
    // ⚠️ BYOK **不**做「401 就续期」重试：Key 是用户手工粘贴的，插件无从续期，
    // 重试只是白跑一次（幂等无副作用，但会拖慢失败反馈）。401/403 直接如实报错，
    // 让用户知道该重新粘贴 —— 与其它 provider「有 refresh 端点才重试」的取舍一致。
    let response = await this.send(credential, body, options)

    // 4. 非 2xx：限流 / 额度耗尽时换号重试（不同平台不同 Key 的额度互相独立）
    if (!response.ok) {
      let errorText = await response.text().catch(() => '')
      const shouldRotate = isByokRotatableFailure(response.status, errorText)
      if (this.options.accountPool !== undefined && shouldRotate) {
        const tried = new Set<string>()
        if (currentAccountId.length > 0) tried.add(currentAccountId)
        const maxRotate = BYOK_MAX_ROTATE - 1
        for (let round = 0; round < maxRotate; round++) {
          if (currentAccountId.length > 0 && recordsByokRateLimit(response.status)) {
            await this.options.accountPool.updateModelRateLimit(
              currentAccountId,
              options.model,
              Date.now() + BYOK_RATE_LIMIT_FALLBACK_MS,
            )
          }
          const next = await this.pickCredential(options.model, tried)
          if (next === undefined || next.accountId.length === 0 || tried.has(next.accountId)) break
          tried.add(next.accountId)
          credential = next.credential
          currentAccountId = next.accountId
          response = await this.send(credential, body, options)
          if (response.ok) {
            yield* this.consume(response, options)
            return
          }
          errorText = await response.text().catch(() => '')
          if (!isByokRotatableFailure(response.status, errorText)) break
        }
        throw new LlmError(
          `byok: 模型 ${options.model} 的所有账号均不可用（限流或额度耗尽），请稍后再试`,
          'QUOTA_EXCEEDED',
        )
      }
      throw new LlmError(
        `byok: ${errorDetail(errorText)}`,
        httpErrorCode(response.status, errorText),
        { status: response.status },
      )
    }

    // 5. 消费 SSE
    yield* this.consume(response, options)
  }

  /** 消费 OpenAI 兼容 SSE（共享实现）。 */
  private consume(response: Response, options: GenerateOptions): AsyncIterable<StreamChunk> {
    return consumeOpenAiSse(response, { ...options.signal === undefined ? {} : { signal: options.signal } }, {
      label: 'byok',
      firstTokenTimeoutMs: resolveFirstTokenTimeoutMs(),
      chunkTimeoutMs: resolveChunkTimeoutMs(),
    })
  }

  /** 发起一次 chat 请求；网络失败映射为可重试的 TRANSPORT 错误。 */
  private async send(
    credential: ByokCredential,
    body: string,
    options: GenerateOptions,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(byokChatUrl(credential.base_url), {
        method: 'POST',
        headers: {
          ...byokHeaders(credential),
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
          `byok: transport error: ${error instanceof Error ? error.message : String(error)}`,
          'TRANSPORT',
          { cause: error as Error },
        )
      }
      throw error
    }
  }
}

/** 限流标记的兜底时长（1 小时；与 buddy / lobsterai / cline 同口径）。 */
const BYOK_RATE_LIMIT_FALLBACK_MS = 3_600_000

/**
 * 该失败是否值得**换号重试**。
 *
 * 判据与 buddy / cline 系一致：429（频率限制）与 402（额度耗尽），
 * 外加文案命中（各平台措辞不同，中英双通道）。
 */
export function isByokRotatableFailure(status: number, body: string): boolean {
  if (status === 429 || status === 402) return true
  const lower = body.toLowerCase()
  return BYOK_CREDIT_MARKERS.some(marker => lower.includes(marker))
}

/** 额度/限流文案标记（小写比对）。 */
const BYOK_CREDIT_MARKERS: readonly string[] = [
  'insufficient', 'quota', 'rate limit', 'too many requests', 'balance',
  'credit', 'payment required', 'exceeded',
  '积分不足', '额度不足', '余额不足', '频率限制', '超出限制',
]

/**
 * 该失败是否应**记为模型的限流标记**（让 UI 亮出「限额重置」徽章）。
 *
 * 只覆盖真正表达「这个模型/账号此刻不可用」的状态码：429 与 402。
 * 文案命中的 4xx（如 400 + 含 "credit"）不记徽章 —— 徽章的含义必须是
 * 「受限」，而不是「这个账号出过错」。
 */
export function recordsByokRateLimit(status: number): boolean {
  return status === 429 || status === 402
}

/**
 * 在 `ctx.llm` 上注册 BYOK provider 路由与适配器。
 *
 * 返回实例：Jet Hub「显示列表」需要 `listAllModels()`（不受黑名单影响、
 * 带最终展示名）。`ctx.llm` 不透传自定义方法，须由调用方持有引用。
 */
export function registerByokLlm(ctx: Context, options: ByokAdapterOptions): ByokAdapter {
  ctx.llm.registerConfigurableProviders([
    {
      provider: BYOK.id,
      displayName: BYOK.displayName,
      settingsNs: settingsNamespaceFor(ctx, `llm-${BYOK.id}`),
      settingsPath: [],
    },
  ])
  const adapter = new ByokAdapter(options)
  ctx.llm.registerAdapter([BYOK.id], adapter)
  return adapter
}

/** 预设平台展示名（`custom` 或未知 id 时回落到原始 id）。用于昵称与错误文案。 */
export function byokPlatformLabel(platformId: string): string {
  return byokPlatformById(platformId)?.label ?? platformId
}
