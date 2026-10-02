/**
 * Jet Hub RPC —— 登录端点（`login.*`），含 Loomy 的短信登录两步式流程。
 *
 * 从 `src/jet-hub-rpc.ts` 的巨型 `switch`（P1-⑤ 纯结构重构）按领域整体搬出，
 * **分支体逐字节保持原样**。
 *
 * ⚠️ `pendingSmsMsgid` 是**每次注册端点一份**的内存中间态（`login.sendSms` 写、
 * `login.submitSms` 读），故必须由门面创建后注入，不能在模块里各持一份。
 */

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LOOMY } from '../loomy-product.js'
import type { LoomyCredential } from '../loomy.js'
import { keyedProductById } from '../keyed-product.js'
import { buildKeyedNickname } from '../keyed.js'
import type { RpcPollLoginRequest, RpcSendSmsRequest, RpcSendSmsResponse, RpcSubmitSmsRequest, RpcSubmitSmsResponse, RpcSubmitKeyRequest, RpcSubmitKeyResponse } from '../types.js'
import type { RpcResult, JetHubRpcContext, JetHubRpcServices, LoomyPendingSmsMsgid, JetHubModelHelpers } from './contracts.js'

/** `login.*` 端点处理器所需依赖（由 `src/jet-hub-rpc.ts` 装配）。 */
export type LoginEndpointDeps = JetHubRpcContext
  & Pick<JetHubRpcServices, 'loomy' | 'keyed'>
  & Pick<JetHubModelHelpers, 'broadcastCatalogChanged'>
  & { pendingSmsMsgid: LoomyPendingSmsMsgid }

/** 处理 `login.*` 端点方法。 */
export async function handleLoginMethod(
  method: string,
  payload: unknown,
  deps: LoginEndpointDeps,
  _signal: AbortSignal,
): Promise<RpcResult> {
  const { ctx, pool, loomy, keyed, broadcastCatalogChanged, pendingSmsMsgid, } = deps

  switch (method) {
      case 'login.poll': {
        const req = payload as RpcPollLoginRequest
        const accounts = await pool.listAllAccounts()
        const entry = accounts.find((a) => a.id === req.accountId)
        if (!entry) return { ok: true, value: { done: false } }
        // 检查凭据是否已实际写入（占位条目没有凭据）
        const ref = credentialRef(entry.credentialRef)
        const resolved = await ctx.credentials.resolve(ref)
        if (!resolved) return { ok: true, value: { done: false } }
        return { ok: true, value: { done: true, success: true } }
      }
      /**
       * 下发短信验证码（**仅 Loomy，备用登录路径**）。
       *
       * ⚠️ 主路径是**微信扫码**（`account.create` 返回本地弹窗页）。
       * 本端点与 `login.submitSms` 保留为**可独立调用的备用路径** ——
       * 不依赖 `account.create` 的中间态（早期版本从内存表取手机号，
       * 改微信登录后那张表不再被填充，会退化成坏死的死代码）。
       *
       * 手机号由**本端点自己接收**，故可脱离 `account.create` 单独使用。
       */
      case 'login.sendSms': {
        const req = payload as RpcSendSmsRequest
        if (req.provider !== LOOMY.id) {
          return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } }
        }
        const phone = typeof req.phone === 'string' ? req.phone.trim() : ''
        if (!/^1[3-9]\d{9}$/.test(phone)) {
          return { ok: false, error: { code: 'bad-request', message: '需要 11 位有效手机号（phone）' } }
        }
        const msgid = await loomy.sendSmsCode(phone)
        // 暂存在内存，供 submitSms 取用（一次性中间态，不写凭据存储）。
        pendingSmsMsgid.set(req.accountId, { phone, msgid })
        return { ok: true, value: { msgid } satisfies RpcSendSmsResponse }
      }
      /**
       * 提交短信验证码完成登录（**仅 Loomy，备用登录路径**）。
       *
       * 成功后：写凭据 → 回填账号昵称/有效期 → 清理中间态。
       */
      case 'login.submitSms': {
        const req = payload as RpcSubmitSmsRequest
        if (req.provider !== LOOMY.id) {
          return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } }
        }
        const pending = pendingSmsMsgid.get(req.accountId)
        if (pending === undefined || pending.msgid.length === 0) {
          return {
            ok: true,
            value: { done: false, error: '请先发送验证码' } satisfies RpcSubmitSmsResponse,
          }
        }
        const account = pool.findAccount(req.accountId)
        if (account === undefined) {
          return {
            ok: true,
            value: { done: false, error: '账号不存在（可能已被删除）' } satisfies RpcSubmitSmsResponse,
          }
        }
        try {
          const result = await loomy.loginWithSmsCode(pending.phone, req.code, pending.msgid, {
            refName: account.credentialRef,
          })
          const credential = JSON.parse(result.access) as LoomyCredential
          await pool.updateAccount(req.accountId, {
            // Loomy 无昵称接口，用手机号尾号让多账号可区分（比 `loomy-xxxx` 有用）。
            nickname: credential.phone.length >= 4
              ? `Loomy ${credential.phone.slice(-4)}`
              : req.accountId,
            expiresAt: result.expires > 0 ? result.expires : undefined,
            // ⚠️ 恒 false：Loomy 无续期端点。
            refreshable: false,
          })
          pendingSmsMsgid.delete(req.accountId)
          return { ok: true, value: { done: true } satisfies RpcSubmitSmsResponse }
        } catch (error) {
          // ⚠️ 登录失败**不删除占位条目**：用户可能只是验证码输错，
          // 保留条目让他能重试（`login.sendSms` 会重新发码）。
          return {
            ok: true,
            value: {
              done: false,
              error: error instanceof Error ? error.message : String(error),
            } satisfies RpcSubmitSmsResponse,
          }
        }
      }
      /**
       * 提交 API Key 完成「粘贴 Key」族账号创建（`commandcode` / `opencode`）。
       *
       * 与 `login.submitSms` 的两处关键差异：
       *
       * 1. **先校验再写凭据**。校验失败直接返回可读错误且**不写凭据** ——
       *    若先写后验，一个打不通的 Key 会留下「账号在、模型全空、
       *    报错与真实原因无关」的黑洞（模型目录门控按「凭据能否解析」
       *    判定，该账号**算已登录**，于是既不显示模型也不报错）。
       * 2. **base url 只认服务端的产品表**。本族一个 provider 对应**一个**平台，
       *    端点由 `keyedProductById(provider).baseUrl` 决定，**完全不采信**
       *    前端传的 `baseUrl` —— 否则前端可以拿一个展示名配上任意地址。
       *
       * ⚠️ 校验打的是 **chat 端点**（不是 `GET /models`）：两个平台的目录端点
       * 都**不鉴权**，拿它当校验会让任意字符串都被判「有效」。详见
       * `src/keyed-auth.ts`。
       *
       * ⚠️ 与 `submitSms` 一致：失败**不删**占位条目，用户可继续重试粘贴。
       */
      case 'login.submitKey': {
        const req = payload as RpcSubmitKeyRequest
        const product = keyedProductById(req.provider)
        const auth = product === undefined ? undefined : keyed.get(product.id)
        if (product === undefined || auth === undefined) {
          return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } }
        }
        const account = pool.findAccount(req.accountId)
        if (account === undefined) {
          return {
            ok: true,
            value: { done: false, error: '账号不存在（可能已被删除）' } satisfies RpcSubmitKeyResponse,
          }
        }
        try {
          // 1) 先校验：失败不写凭据、不留半成品。
          //    ⚠️ base url 由产品表决定，前端传值一律忽略。
          const check = await auth.validateApiKey(req.apiKey, product.baseUrl)
          if (!check.ok) {
            return {
              ok: true,
              value: { done: false, error: check.error ?? 'API Key 校验失败' } satisfies RpcSubmitKeyResponse,
            }
          }
          // 2) 校验通过后写凭据。
          const credential = await auth.persistApiKey(account.credentialRef, {
            apiKey: req.apiKey,
            baseUrl: product.baseUrl,
            // 把校验时拉到的模型集**缓存进凭据**：适配器首轮目录加载即便
            // 失败也能靠它给出可用列表。
            models: check.models,
            nickname: buildKeyedNickname(product.displayName, req.apiKey, req.accountId),
          })
          // 3) 回填账号昵称。
          //    ⚠️ 昵称只放**产品名 + Key 尾 4 位**（见 `buildKeyedNickname`）：
          //    账号卡片会展示它，放前段等于泄露凭据。
          //    ⚠️ `refreshable` 必须是 false（Key 无法续期），
          //    否则 `refreshAll()` 会把死 Key 一路刷到底。
          await pool.updateAccount(req.accountId, {
            nickname: credential.nickname ?? req.accountId,
            refreshable: false,
          })
          // 4) 目录已变化（新 Key 可能带来新的模型权益）→ 广播，让 composer 立即刷新。
          broadcastCatalogChanged(ctx)
          return {
            ok: true,
            value: { done: true, modelCount: check.models.length } satisfies RpcSubmitKeyResponse,
          }
        } catch (error) {
          // ⚠️ 写凭据本身失败（存储异常）也不删占位条目，与 submitSms 同取舍。
          return {
            ok: true,
            value: {
              done: false,
              error: error instanceof Error ? error.message : String(error),
            } satisfies RpcSubmitKeyResponse,
          }
        }
      }
      default: return { ok: false, error: { code: 'bad-request', message: `unknown method: ${method}` } }
    }
  }
