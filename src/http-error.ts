/**
 * 共享的 HTTP 错误分类与报文归一化。
 *
 * **为什么需要这个模块**：同一套「状态码 → harness 错误码」和「错误体 → 可读文本」
 * 的逻辑，此前在 5 个地方各写了一份（`llm-adapter.ts` / `buddy-adapter.ts` /
 * `lobsterai-adapter.ts` / `openai-compat.ts` / `trae-adapter.ts`），差异是**实质的**
 * 而不是风格的：认的字段不同（`code`/`msg`/`error_code`/`error.type`/`error` 字符串）、
 * 400 的判定口径不同（有的完全不看报文）。后果已经真实发生过：
 *
 * - **400 → CONTEXT_WINDOW_EXCEEDED 覆盖不全**：buddy / codearts / raccoon 会把
 *   「上下文超限」的 400 归为 `CONTEXT_WINDOW_EXCEEDED`（触发 DSH 的
 *   `dsh-compaction-basic` 自动压缩上下文并重试），而 lobsterai / cline / loomy /
 *   qoder / trae 一律归为 `INVALID_REQUEST` —— 长会话一旦越过窗口，这几个 provider
 *   直接把裸错误抛给用户，行为与其他 provider 分叉。
 * - **同一份修复要逐个文件跟**：新 provider 照抄旧的 `httpErrorCode(status)` 就又漏一次。
 *
 * **设计约束（来自 AGENTS.md）**：`buddy-adapter.ts` / `lobsterai-adapter.ts` 不得改用
 * `openai-compat.ts` 的共享实现 —— 那两个适配器已由大量单测与线上流量验证，改动风险
 * 不可控。因此本模块是**独立于 openai-compat 的中立层**：各适配器只导入、
 * 不再各抄一份；provider 之间的真实差异全部收敛成**显式选项**，默认值取各实现
 * 认得的字段**并集**（比任何单一旧实现都更宽，只会多认出错误、不会漏认）。
 *
 * @see isContextWindowExceededError - DSH 提供的超限措辞分类器（本模块的判据来源）
 */

import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  QUOTA_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'

/**
 * 错误体字段的识别开关。
 *
 * 全部默认 `true`（并集口径）。传 `false` 可以精确复刻某个旧实现的窄口径，
 * 但**只在有实测报文证明多认字段会误判时才关**：漏认的代价是用户看到一坨
 * 裸 JSON，或错误码分类错误。
 */
export interface ErrorDetailOptions {
  /**
   * 是否把顶层 `code` 渲染成 `code=<v>`。
   *
   * 为什么要带标签而不是裸值：上游 `code` 常常是 4001/11115 这种数字，
   * 拼进文案后无法与 message 里的数字区分（trae 的 `code=4001` 就靠这个标签
   * 关联到文档里的解释）。
   */
  codeLabel?: boolean
  /** 是否认 `error.type`（OpenAI 风格 `invalid_request_error` 等）。 */
  errorType?: boolean
  /**
   * 是否认 `data.error`：既可能是字符串，也可能是带 `.message` 的对象。
   *
   * 这条有实测依据：Cline 的部分错误体是 `{error: "<文案>", success: false}`
   * （如地域限制 `{"error":"access forbidden: … is not available in your region"}`），
   * 只认 code/message/msg 会把整个 JSON 原样返回，用户看到一坨不可读的裸 JSON。
   */
  nestedError?: boolean
  /** 是否认 `data.error_code` / `data.error_msg`（CodeArts 系形态）。 */
  errorCodeFields?: boolean
  /** 是否认 OpenAI 兼容服务常用的 `data.msg`（部分聚合站用 `msg` 而非 `message`）。 */
  msgField?: boolean
}

/**
 * 从错误体提取可读 detail 文本。
 *
 * 提取失败（非 JSON）时返回**原文**：宁可让用户看到原始报文，也不要丢掉信息。
 * 这与 `httpErrorCode` 的判定口径分开 —— 判定看完整报文（见
 * {@link HttpErrorCodeOptions.contextProbe}），展示看归一化短文本。
 *
 * @param body - 上游响应体原文
 * @param options - 字段识别开关（默认全开 = 并集口径）
 */
export function errorDetail(body: string, options: ErrorDetailOptions = {}): string {
  const {
    codeLabel = true,
    errorType = true,
    nestedError = true,
    errorCodeFields = true,
    msgField = true,
  } = options
  try {
    const data = JSON.parse(body) as Record<string, unknown>
    const error = typeof data.error === 'object' && data.error !== null
      ? data.error as Record<string, unknown>
      : undefined
    // 嵌套 `error` 只在它是**字符串**时单独补一份：是对象时它的 `message`
    // 已经在上面的 `error.message` 位参与拼接，再拼一次就是重复文案。
    const nested = typeof data.error === 'string' ? data.error : undefined
    const parts = [
      codeLabel && (typeof data.code === 'number' || typeof data.code === 'string')
        ? `code=${String(data.code)}`
        : undefined,
      typeof error?.code === 'string' ? error.code : undefined,
      errorType && typeof error?.type === 'string' ? error.type : undefined,
      typeof error?.message === 'string' ? error.message : undefined,
      errorCodeFields && typeof data.error_code === 'string' ? data.error_code : undefined,
      errorCodeFields && typeof data.error_msg === 'string' ? data.error_msg : undefined,
      typeof data.message === 'string' ? data.message : undefined,
      msgField && typeof data.msg === 'string' ? data.msg : undefined,
      nestedError && typeof nested === 'string' ? nested : undefined,
    ].filter((value): value is string => value !== undefined)
    if (parts.length > 0) return parts.join(' ')
  } catch {
    // 非 JSON 错误体：直接用原文。
  }
  return body
}

/** 400 判定所看文本的来源。 */
export const CONTEXT_PROBES = ['body', 'detail', 'both'] as const

/**
 * `contextProbe` 的取值：
 * - `'body'`：只看原始报文；
 * - `'detail'`：只看 {@link errorDetail} 归一化后的文本；
 * - `'both'`（默认）：两者都看 —— 原始报文是归一化文本的**超集**（归一化只挑几个
 *   字段拼接），但报文里 `\uXXXX` 转义等畸形写法可能破坏正则边界，故两者都试。
 */
export type ContextProbe = typeof CONTEXT_PROBES[number]

/** {@link httpErrorCode} 的选项。 */
export interface HttpErrorCodeOptions extends ErrorDetailOptions {
  /** 400 判定所看文本的来源；默认 `'both'`。 */
  contextProbe?: ContextProbe
  /**
   * 是否把「配额/余额耗尽」也归一化为 `QUOTA`。
   *
   * 默认 `false`：并非所有 provider 都需要该分类（buddy 走自己的额度文案路径）。
   * CodeArts（`llm-adapter.ts`）与 OpenAI 兼容系按需打开。
   */
  quota?: boolean
}

/**
 * 判断报文是否表示「提示词超出模型上下文窗口」。
 *
 * 这是 400 分支里唯一需要看报文才能做的区分：归为 `CONTEXT_WINDOW_EXCEEDED`
 * 才能触发 DSH 的 context-overflow 自动压缩恢复（`dsh-compaction-basic` 监听
 * `agent/request-error`，只对 `failure.code === CONTEXT_WINDOW_EXCEEDED` 的失败
 * 压缩上下文并重试）；归为 `INVALID_REQUEST` 则直接把裸错误抛给用户。
 *
 * @param body - 上游响应体原文（可省略，省略时只看 detail）
 * @param detail - 归一化后的 detail 文本
 * @param probe - 看哪些文本
 */
export function isContextOverflow(
  body: string | undefined,
  detail: string,
  probe: ContextProbe,
): boolean {
  if (probe === 'body') return body === undefined ? false : isContextWindowExceededError(body)
  if (probe === 'detail') return isContextWindowExceededError(detail)
  return isContextWindowExceededError(detail)
    || (body !== undefined && isContextWindowExceededError(body))
}

/**
 * 将 HTTP 状态码映射为 harness 错误码（provider 中立的统一口径）。
 *
 * 口径（与 DSH deepseek 适配器的词汇一致）：
 * - 401 / 403 → `AUTH`
 * - 配额/余额耗尽（`quota: true` 时）→ `QUOTA`
 * - 429 → `RATE_LIMIT`
 * - 400 → 命中上下文超限措辞则 `CONTEXT_WINDOW_EXCEEDED`，否则 `INVALID_REQUEST`
 * - ≥500 → `SERVER`
 * - 其余 → `HTTP_<status>`
 *
 * ⚠️ `body` 虽然可选（纯状态码场景），但**只要能拿到报文就必须传**：省略它等于
 * 放弃 400 的区分能力，那正是 P0 缺陷的成因。
 *
 * @param status - HTTP 状态码
 * @param body - 上游响应体原文（强烈建议传）
 * @param options - 识别开关与上下文判定口径
 */
export function httpErrorCode(
  status: number,
  body?: string,
  options: HttpErrorCodeOptions = {},
): string {
  if (status === 401 || status === 403) return 'AUTH'
  const detail = body === undefined ? '' : errorDetail(body, options)
  if (options.quota === true && detail.length > 0 && isQuotaExceededError(detail)) {
    return QUOTA_EXCEEDED_CODE
  }
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    // 先判上下文超限，再退回通用 INVALID_REQUEST。
    if (isContextOverflow(body, detail, options.contextProbe ?? 'both')) {
      return CONTEXT_WINDOW_EXCEEDED_CODE
    }
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/** 安全读取 Error.message，避免访问器抛异常。 */
export function errorMessageText(error: unknown): string {
  if (error instanceof Error) return error.message
  try { return String(error) } catch { return 'unknown error' }
}
