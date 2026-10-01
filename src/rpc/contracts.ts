/**
 * Jet Hub RPC 领域处理器的**依赖契约**与共享结果类型。
 *
 * P1-⑤ 把 `src/jet-hub-rpc.ts` 的巨型 `switch` 按领域拆到 `src/rpc/*.ts` 后，
 * 领域模块需要「宿主 ctx / 账号池 / 各 provider 服务实例 / 区域族路由 / 公共助手」
 * 这几类能力。它们**只作为参数**传进来，不从门面反向取值。
 *
 * ⚠️ 为什么门面仍是唯一的公共助手之家：这些助手（`shortId` / `parseXxxCredential` /
 * `collectCreditsStatus` …）被大量单测与源码级断言直接引用，搬家会把断言变成
 * 找文件，而它们本身没有任何「领域」归属。
 *
 * 本文件里的 `typeof` 引用是**刻意**的：门面里助手签名一改，这里立刻编译错误，
 * 而不是等到运行期发现领域模块拿到 `undefined`。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AccountPool } from '../account-pool.js'
import type { JetHubRpcServices } from '../jet-hub-rpc.js'

/** 领域模块统一从本文件取服务集合类型（门面 → 契约 → 领域模块的单向引用）。 */
export type { JetHubRpcServices }
import type {
  broadcastCatalogChanged,
  buildRaccoonNickname,
  collectClaimResults,
  collectCreditBalances,
  collectCreditsStatus,
  computeClaimSummary,
  llmServiceOf,
  parseBuddyCredential,
  parseClineCredential,
  parseCodeArtsCredential,
  parseLobsteraiCredential,
  parseQoderCredential,
  parseTraeCredential,
  shortId,
} from '../jet-hub-rpc.js'
import type { BuddyAuth } from '../buddy-auth.js'
import type { QoderAuth } from '../qoder-auth.js'
import type { TraeAuth } from '../trae-auth.js'

/**
 * 端点处理器的统一返回形状。
 *
 * 与拆分前的 `handleMethod` 逐分支返回的字面量完全同构：`{ ok: true, value }`
 * 或 `{ ok: false, error: { code, message } }`（`details: {}` 只由传输层的
 * `reply()` 补，领域模块不得自己加）。
 */
export type RpcOk = { ok: true; value: unknown }
export type RpcFail = { ok: false; error: { code: string; message: string } }
export type RpcResult = RpcOk | RpcFail

/** 宿主 ctx 与账号池。 */
export interface JetHubRpcContext {
  ctx: Context
  pool: AccountPool
}

/**
 * Loomy 短信登录的**内存中间态**：`login.sendSms` 记下手机号与 msgid，
 * `login.submitSms` 据此提交验证码。
 *
 * ⚠️ 生命周期必须是「每次注册端点一份」，故由门面创建后注入。
 */
export type LoomyPendingSmsMsgid = Map<string, { phone: string; msgid: string }>

/**
 * 区域族路由：把 provider id 映射到对应区域的服务实例。
 *
 * `buddy` / `workbuddy*` 同内核不同 endpoint，`qoder` / `trae` 各自两区，
 * 故不接受「按 id 猜实例」的写法（早期写过 `if (provider === 'buddy')` 的硬编码）。
 */
export interface JetHubRegionRouting {
  buddyAuthForProduct(productId: string): BuddyAuth | undefined
  qoderAuthForProduct(productId: string): QoderAuth | undefined
  traeAuthForProduct(productId: string): TraeAuth | undefined
  isQoderProvider(provider: string): boolean
  isTraeProvider(provider: string): boolean
}

/** 门面的公共助手（凭据解析 / 随机短 id / 小浣熊昵称）。 */
export interface JetHubCredentialHelpers {
  shortId: typeof shortId
  parseBuddyCredential: typeof parseBuddyCredential
  parseCodeArtsCredential: typeof parseCodeArtsCredential
  parseLobsteraiCredential: typeof parseLobsteraiCredential
  parseQoderCredential: typeof parseQoderCredential
  parseTraeCredential: typeof parseTraeCredential
  parseClineCredential: typeof parseClineCredential
  buildRaccoonNickname: typeof buildRaccoonNickname
}

/** 门面的积分聚合助手（泛型，故用 `typeof` 取原签名而不是抄一遍）。 */
export interface JetHubCreditsHelpers {
  computeClaimSummary: typeof computeClaimSummary
  collectCreditsStatus: typeof collectCreditsStatus
  collectClaimResults: typeof collectClaimResults
  collectCreditBalances: typeof collectCreditBalances
}

/** 门面的模型目录助手。 */
export interface JetHubModelHelpers {
  llmServiceOf: typeof llmServiceOf
  broadcastCatalogChanged: typeof broadcastCatalogChanged
}

/**
 * 门面装配出的**全量**依赖对象：每个领域模块只声明（`Pick`）自己用得到的那几项。
 *
 * 一次性构造、按变量传递（而非每个调用点写对象字面量），既避免多余属性检查，
 * 也让「门面少装配了一项」成为编译错误。
 */
export type JetHubRpcDeps = JetHubRpcContext
  & JetHubRpcServices
  & JetHubRegionRouting
  & JetHubCredentialHelpers
  & JetHubCreditsHelpers
  & JetHubModelHelpers
  & { pendingSmsMsgid: LoomyPendingSmsMsgid }
