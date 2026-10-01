/**
 * Jet Hub RPC —— 新手任务与 Loomy 永久锁（`onboarding.*` + `loomy.permanentLock`）。
 *
 * 从 `src/jet-hub-rpc.ts` 的巨型 `switch`（P1-⑤ 纯结构重构）按领域整体搬出，
 * **分支体逐字节保持原样**。
 *
 * `loomy.permanentLock` 与 `onboarding.*` 同属「Loomy / 小浣熊的奖励与解锁」这一
 * 领域，故归在同一文件；它广播 `llm/adapters-updated` 时是**就地 try/catch**，
 * 不走门面的 `broadcastCatalogChanged`（语义与文案都不同，勿合并）。
 */

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LOOMY } from '../loomy-product.js'
import type { LoomyCredential } from '../loomy.js'
import { RACCOON } from '../raccoon-product.js'
import type { RaccoonCredential } from '../raccoon.js'
import { LOOMY_TASK_POINTS, LOOMY_TASK_TITLES } from '../loomy-onboarding.js'
import type { RpcOnboardingStatusRequest, RpcOnboardingStatusResponse, RpcOnboardingClaimRequest, RpcOnboardingClaimResponse, RpcLoomyPermanentLockRequest, RpcLoomyPermanentLockResponse } from '../types.js'
import type { RpcResult, JetHubRpcContext, JetHubRpcServices } from './contracts.js'

/** `onboarding.* / loomy.permanentLock` 端点处理器所需依赖（由 `src/jet-hub-rpc.ts` 装配）。 */
export type OnboardingEndpointDeps = JetHubRpcContext
  & Pick<JetHubRpcServices, 'loomy' | 'raccoon'>

/** 处理 `onboarding.* / loomy.permanentLock` 端点方法。 */
export async function handleOnboardingMethod(
  method: string,
  payload: unknown,
  deps: OnboardingEndpointDeps,
  _signal: AbortSignal,
): Promise<RpcResult> {
  const { ctx, pool, loomy, raccoon, } = deps

  switch (method) {
      /**
       * 查询新手任务 / 一次性奖励状态（**Loomy** 的新手任务、**raccoon** 的登录奖励，只读）。
       *
       * ⚠️ 只读：**不得**在此触发任何 `complete`/`claim`（面板挂载时会调用它）。
       * ⚠️ 两个 provider 共用本端点，故判据是「属于其中之一」而非只认 Loomy。
       */
      case 'onboarding.status': {
        const req = payload as RpcOnboardingStatusRequest
        if (req.provider !== LOOMY.id && req.provider !== RACCOON.id) {
          return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } }
        }
        const account = pool.findAccount(req.accountId)
        if (account === undefined) {
          return { ok: false, error: { code: 'bad-request', message: '账号不存在' } }
        }
        const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef))
        if (!resolved) {
          return { ok: false, error: { code: 'bad-request', message: '凭据未配置' } }
        }
        if (req.provider === RACCOON.id) {
          // raccoon 只有**一项**一次性奖励（桌面端登录奖励 3000 分），
          // 把它映射成 Loomy 那套「任务」形状的一项，复用同一个 RPC 与 UI。
          // ⚠️ 已领状态靠**账单反查**（服务端没有单独的状态端点）。
          const credential = JSON.parse(resolved.value) as RaccoonCredential
          const status = await raccoon.fetchOnboardingStatus(credential)
          return {
            ok: true,
            value: {
              // ⚠️ `tasks` 是 `Record<key, boolean>`（完成状态），不是数组。
              tasks: { desktop_login_reward: status.claimed },
              earned: status.claimed ? status.points : 0,
              total: status.points,
              titles: { desktop_login_reward: '桌面端登录奖励（每号一次）' },
              points: { desktop_login_reward: status.points },
            } satisfies RpcOnboardingStatusResponse,
          }
        }
        const credential = JSON.parse(resolved.value) as LoomyCredential
        const state = await loomy.fetchOnboardingTasks(credential)
        return {
          ok: true,
          value: {
            tasks: state.tasks,
            earned: state.earned,
            total: state.total,
            titles: { ...LOOMY_TASK_TITLES },
            points: { ...LOOMY_TASK_POINTS },
          } satisfies RpcOnboardingStatusResponse,
        }
      }
      /**
       * Loomy「锁定永久积分」开关（读 / 写）。
       *
       * **用户需求**：锁定后选号只允许消耗今日赠送额度，永久积分不参与 ——
       * 只剩永久积分的账号在锁定期间等同于不可用（「锁定后没有临时积分后找
       * 可用账号就是没有可用账号」）。解锁后恢复「没临时积分就用永久积分」。
       *
       * ⚠️ 这是**全局**开关（不分账号），持久化在 `$DSH_HOME/jet-hub/state.json`
       * 的 `loomyPermanentLocked` 字段（或老契约的 settings 文档）。
       *
       * ⚠️ `locked` 省略时**只读**（供面板初始化），给出布尔值才写入。
       */
      case 'loomy.permanentLock': {
        const req = payload as RpcLoomyPermanentLockRequest
        if (req.locked === undefined) {
          return { ok: true, value: { locked: pool.loomyPermanentLocked() } satisfies RpcLoomyPermanentLockResponse }
        }
        if (typeof req.locked !== 'boolean') {
          return { ok: false, error: { code: 'bad-request', message: 'locked 必须是布尔值' } }
        }
        await pool.setLoomyPermanentLocked(req.locked)
        // ⚠️ 与 `model.setDisabled` 同理：本次写入会改变**选号结果**
        // （进而改变哪些账号会被使用），故广播一次让界面重新读取状态。
        // 包 try/catch：通知失败不能反噬已经落盘的开关。
        try {
          ctx.emit('llm/adapters-updated')
        } catch (error) {
          ctx.logger?.warn?.(`[jet-hub] 广播 llm/adapters-updated 失败（不影响已保存的开关）: ${String(error)}`)
        }
        return { ok: true, value: { locked: pool.loomyPermanentLocked() } satisfies RpcLoomyPermanentLockResponse }
      }
      /**
       * 领取新手任务 / 一次性奖励（**Loomy** 的新手任务、**raccoon** 的登录奖励，一次性）。
       *
       * ⚠️ 这是**写**操作，且**每号只能领一次** —— 与 `credits.claimAll`
       *（每日签到）语义完全不同，故独立端点。
       */
      case 'onboarding.claim': {
        const req = payload as RpcOnboardingClaimRequest
        // ⚠️ 两个 provider 共用本端点（Loomy 的新手任务 / raccoon 的登录奖励）。
        if (req.provider !== LOOMY.id && req.provider !== RACCOON.id) {
          return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } }
        }
        const account = pool.findAccount(req.accountId)
        if (account === undefined) {
          return { ok: false, error: { code: 'bad-request', message: '账号不存在' } }
        }
        const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef))
        if (!resolved) {
          return { ok: false, error: { code: 'bad-request', message: '凭据未配置' } }
        }
        if (req.provider === RACCOON.id) {
          // raccoon 的领取端点是**幂等**的：已领过返回 `granted:false`，
          // 此时 claimed 为空数组、skipped 含该项。
          //
          // ⚠️ **已领时 `earned` 必须报满分，不是 0**（真实缺陷，用户报障）。
          // `earned` 回答的是「该项目**累计**领到多少」，与「本次请求是否新增」
          // 无关。早期在 `already-claimed` 分支写 `earned: 0`，于是 UI 显示
          // 「✅ 1 个此前已完成 / 累计已领 0 / 3000」—— **自相矛盾**：
          // 既然「此前已完成」，那 3000 分显然已经拿到手了。
          const credential = JSON.parse(resolved.value) as RaccoonCredential
          const outcome = await raccoon.claimLoginReward(credential)
          if (outcome.kind === 'failed') {
            return { ok: false, error: { code: 'bad-request', message: outcome.message } }
          }
          const claimed = outcome.kind === 'claimed'
            ? [{ key: 'desktop_login_reward', title: '桌面端登录奖励', points: outcome.credit }]
            : []
          // 已领时的金额从**账单反查**取得（领取响应体里没有它），
          // 与 `onboarding.status` 同一数据源 —— 否则两处会显示不同的数字
          //（例如活动金额变化后，一处 3000、一处 3500）。
          // 只读 GET，且仅在「点按钮时已领」这一低频路径上发生。
          const points = outcome.kind === 'claimed'
            ? outcome.credit
            : (await raccoon.fetchOnboardingStatus(credential)).points
          return {
            ok: true,
            value: {
              claimed,
              skipped: outcome.kind === 'already-claimed' ? ['desktop_login_reward'] : [],
              // 该项目累计已领 = 满分（无论本次是否新增）。
              earned: points,
              total: points,
            } satisfies RpcOnboardingClaimResponse,
          }
        }
        const credential = JSON.parse(resolved.value) as LoomyCredential
        const result = await loomy.claimOnboardingTasks(credential)
        return {
          ok: true,
          value: {
            claimed: result.claimed.map((item) => ({
              key: item.key,
              title: LOOMY_TASK_TITLES[item.key] ?? item.key,
              points: item.points,
            })),
            skipped: result.skipped,
            earned: result.earned,
            total: result.total,
          } satisfies RpcOnboardingClaimResponse,
        }
      }
      default: return { ok: false, error: { code: 'bad-request', message: `unknown method: ${method}` } }
    }
  }
