/**
 * Jet Hub RPC —— 凭据备份端点（`backup.export` / `backup.import` / `backup.status`）。
 *
 * 从 `src/jet-hub-rpc.ts` 的巨型 `switch`（P1-⑤ 纯结构重构）按领域整体搬出，
 * **分支体逐字节保持原样**。
 */

import { exportBackup, importBackup } from '../backup.js'
import type { RpcBackupExportResponse, RpcBackupImportRequest, RpcBackupImportResponse, RpcBackupStatusResponse } from '../types.js'
import type { RpcResult, JetHubRpcContext, JetHubModelHelpers } from './contracts.js'

/** `backup.*` 端点处理器所需依赖（由 `src/jet-hub-rpc.ts` 装配）。 */
export type BackupEndpointDeps = JetHubRpcContext
  & Pick<JetHubModelHelpers, 'broadcastCatalogChanged'>

/** 处理 `backup.*` 端点方法。 */
export async function handleBackupMethod(
  method: string,
  payload: unknown,
  deps: BackupEndpointDeps,
  _signal: AbortSignal,
): Promise<RpcResult> {
  const { ctx, pool, broadcastCatalogChanged, } = deps

  switch (method) {
      // ── 账号备份（导出 / 导入）──
      //
      // 目的：更换 DSH 版本时迁移账号凭据。备份文件是**自包含**的 JSON
      // （账号索引 + 凭据原文 + 模型黑名单，见 src/backup.ts），与 DSH 版本
      // 无关 —— 导入时按**当前版本**的存储契约重建，天然跨版本。
      //
      // 安全约定：加密在浏览器侧完成（PBKDF2 + AES-GCM），RPC 只接收/返回
      // 明文载荷；明文 JSON 不经过本层持久化与日志。
      case 'backup.export': {
        const result = await exportBackup(pool, ctx.credentials)
        const value: RpcBackupExportResponse = {
          payload: result.payload,
          warnings: result.warnings,
        }
        return { ok: true, value }
      }
      // 导入 = 整体替换（还原快照，不是合并）。写入顺序刻意「先凭据、后账号池」：
      // 账号池整体替换成功后，门控（hasLoggedInAccount）与黑名单立即反映新状态；
      // 若凭据写入中途失败（非法 ref 等），只跳过该条、不中断整体。
      case 'backup.import': {
        const req = payload as RpcBackupImportRequest
        const result = await importBackup(ctx.credentials, pool, req.payload)
        // 导入会改变账号集合（门控依赖 hasLoggedInAccount）与模型黑名单，
        // 必须广播目录变更，否则界面仍显示旧目录。
        broadcastCatalogChanged(ctx)
        const value: RpcBackupImportResponse = {
          credentialsImported: result.credentialsImported,
          accountsImported: result.accountsImported,
          skipped: result.skipped,
          expiredAccounts: result.expiredAccounts,
          missingCredentials: result.missingCredentials,
        }
        return { ok: true, value }
      }
      // 账号池统计（导入前的覆盖提示用）：缺 expiresAt 的条目疑似 DSH 版本
      // 切换后自动恢复的产物（反推不读凭据值，故无有效期）。前端据此在
      // 确认导入前提示用户「有 N 个自动恢复的账号将被整体覆盖」。
      case 'backup.status': {
        const state = pool.getStateSnapshot()
        const value: RpcBackupStatusResponse = {
          accounts: state.accounts.length,
          withoutExpiry: state.accounts.filter((entry) => entry.expiresAt === undefined).length,
        }
        return { ok: true, value }
      }
      default: return { ok: false, error: { code: 'bad-request', message: `unknown method: ${method}` } }
    }
  }
