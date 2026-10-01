/**
 * `src/http-error.ts` 的行为锁。
 *
 * 这个模块存在的理由是**修一个真实缺陷**：5 份各自演化的 `httpErrorCode` 里，
 * 有 3 份完全不看报文，把 400 一律归为 `INVALID_REQUEST`。于是「提示词超出模型
 * 上下文窗口」这种 DSH 能自动恢复（`dsh-compaction-basic` 监听
 * `agent/request-error`，只对 `failure.code === CONTEXT_WINDOW_EXCEEDED` 压缩
 * 上下文并重试）的失败，在这几个 provider 上直接把裸错误抛给用户。
 *
 * 因此本用例重点锁三件事：
 * 1. **只看状态码**是不够的 —— 400 + 超限措辞必须归为 CONTEXT_WINDOW_EXCEEDED；
 * 2. **归一化 detail 会丢字段** —— 真实 WorkBuddy 报文的超限信息在 `extError.code`
 *    里，`errorDetail` 提取不到，所以判定必须同时看原始报文（`contextProbe: 'both'`）；
 * 3. **各 provider 的窄口径能逐字复刻** —— 迁移到共享层时不允许改变用户看到的文案。
 */

import { describe, expect, it } from 'vitest'
import {
  CONTEXT_PROBES,
  errorDetail,
  errorMessageText,
  httpErrorCode,
  isContextOverflow,
} from '../../src/http-error.js'

/** 实测报文（国际版 WorkBuddy，deepseek-v4.1-flash）：超限信息在 extError/displayMsg。 */
const WORKBUDDY_OVERFLOW_BODY = JSON.stringify({
  code: 11115,
  msg: 'prompt is too long: 1061554 tokens > 1048576 maximum',
  extError: {
    code: 'context_length_exceeded',
    type: 'invalid_request_error',
    message: 'Your request exceeded model token limit: 1048576 (requested: 1061554)',
  },
  displayMsg: { en: 'The request exceeds the model context limit. Please shorten the conversation.' },
})

describe('errorDetail：字段识别与窄口径复刻', () => {
  it('默认（并集）口径认 code / error.* / error_code / msg / 嵌套 error 字符串', () => {
    expect(errorDetail(JSON.stringify({
      code: 4001,
      error: { code: 'invalid_request_error', type: 'invalid_request_error', message: 'bad param' },
      error_code: 'TM.00001041',
      error_msg: 'quota exhausted',
      msg: 'extra msg',
    }))).toBe('code=4001 invalid_request_error invalid_request_error bad param TM.00001041 quota exhausted extra msg')
  })

  it('嵌套 error 是字符串时也要认（Cline 地域限制报文的形态）', () => {
    const body = JSON.stringify({ error: 'access forbidden: claude-sonnet is not available in your region', success: false })
    expect(errorDetail(body)).toBe('access forbidden: claude-sonnet is not available in your region')
  })

  it('buddy 窄口径：只认 error.code/type/message 与顶层 message，逐字复刻旧实现', () => {
    const body = JSON.stringify({
      code: 11115,
      msg: 'prompt is too long',
      error: { code: 'invalid_request_error', type: 'invalid_request_error', message: 'bad param' },
      message: 'top message',
    })
    const options = { codeLabel: false, errorType: true, nestedError: false, errorCodeFields: false, msgField: false }
    expect(errorDetail(body, options)).toBe('invalid_request_error invalid_request_error bad param top message')
  })

  it('CodeArts 窄口径：认 error_code/error_msg，但不认 msg 与嵌套 error', () => {
    const body = JSON.stringify({ error_code: 'TM.00001041', error_msg: '排队中', msg: 'ignored' })
    const options = { codeLabel: false, errorType: true, nestedError: false, errorCodeFields: true, msgField: false }
    expect(errorDetail(body, options)).toBe('TM.00001041 排队中')
  })

  it('非 JSON 报文原样返回（宁可给用户看原文，也不要丢信息）', () => {
    expect(errorDetail('<html>502 Bad Gateway</html>')).toBe('<html>502 Bad Gateway</html>')
  })

  it('认不出任何字段时回退原文', () => {
    expect(errorDetail('{"unexpected":true}')).toBe('{"unexpected":true}')
  })
})

describe('httpErrorCode：状态码映射', () => {
  it('401 / 403 → AUTH，429 → RATE_LIMIT，5xx → SERVER，其余 → HTTP_<status>', () => {
    expect(httpErrorCode(401)).toBe('AUTH')
    expect(httpErrorCode(403)).toBe('AUTH')
    expect(httpErrorCode(429)).toBe('RATE_LIMIT')
    expect(httpErrorCode(500)).toBe('SERVER')
    expect(httpErrorCode(503)).toBe('SERVER')
    expect(httpErrorCode(418)).toBe('HTTP_418')
  })

  it('400 + 超限措辞 → CONTEXT_WINDOW_EXCEEDED（触发自动压缩恢复）', () => {
    const body = JSON.stringify({ error: { message: 'prompt too long for this model' } })
    expect(httpErrorCode(400, body)).toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  it('400 + 普通报文 → INVALID_REQUEST', () => {
    const body = JSON.stringify({ error: { message: 'invalid tool schema' } })
    expect(httpErrorCode(400, body)).toBe('INVALID_REQUEST')
  })

  it('实测 WorkBuddy 400 报文（超限信息只在 extError.code）必须归为 CONTEXT_WINDOW_EXCEEDED', () => {
    expect(httpErrorCode(400, WORKBUDDY_OVERFLOW_BODY)).toBe('CONTEXT_WINDOW_EXCEEDED')
    // 各 provider 的窄口径也要保持命中（判定看的是原始报文，不是归一化文本）。
    const narrow = { codeLabel: false, errorType: true, nestedError: false, errorCodeFields: false, msgField: false }
    expect(httpErrorCode(400, WORKBUDDY_OVERFLOW_BODY, narrow)).toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  it("判定必须看**原始报文**：归一化 detail 提取到别的 message 时会丢掉超限信息", () => {
    // 报文同时有可提取的 `message`（展示用）与只存在于原文的 `extError.code`（判定用）。
    const body = JSON.stringify({
      code: 11115,
      message: '请求失败，请稍后重试',
      msg: 'prompt is too long: 1061554 tokens > 1048576 maximum',
      extError: { code: 'context_length_exceeded' },
    })
    const narrow = { codeLabel: false, errorType: true, nestedError: false, errorCodeFields: false, msgField: false }
    const detail = errorDetail(body, narrow)
    expect(detail).toBe('请求失败，请稍后重试')
    // 只看归一化文本 → 漏判（这就是 contextProbe 默认 'both' 的原因）。
    expect(httpErrorCode(400, body, { ...narrow, contextProbe: 'detail' })).toBe('INVALID_REQUEST')
    // 看原始报文 → 命中。
    expect(httpErrorCode(400, body, { ...narrow, contextProbe: 'body' })).toBe('CONTEXT_WINDOW_EXCEEDED')
    expect(httpErrorCode(400, body, narrow)).toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  it("contextProbe: 'body' 只看原文：畸形 detail 不影响判定", () => {
    const body = JSON.stringify({ code: 'x', message: 'ok' })
    expect(httpErrorCode(400, body, { contextProbe: 'body' })).toBe('INVALID_REQUEST')
    expect(httpErrorCode(400, JSON.stringify({ msg: 'input exceeds the model context window' }), { contextProbe: 'body' }))
      .toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  it('省略报文（纯状态码场景）时 400 只能归 INVALID_REQUEST —— 这正是缺陷成因', () => {
    expect(httpErrorCode(400)).toBe('INVALID_REQUEST')
  })

  it('quota 开关：打开时配额措辞归 QUOTA，关闭时不参与', () => {
    const body = JSON.stringify({ error_msg: 'Insufficient balance: your account has run out of quota' })
    expect(httpErrorCode(402, body, { quota: true })).toBe('QUOTA')
    expect(httpErrorCode(402, body)).toBe('HTTP_402')
  })

  it('quota 判定优先于 429（限流报文里同时出现配额措辞时按配额处理）', () => {
    const body = JSON.stringify({ error: { message: 'insufficient quota, rate limit reached' } })
    expect(httpErrorCode(429, body, { quota: true })).toBe('QUOTA')
    expect(httpErrorCode(429, body)).toBe('RATE_LIMIT')
  })

  it('CONTEXT_PROBES 三个取值都有定义（改动枚举时要同步判定分支）', () => {
    expect([...CONTEXT_PROBES]).toEqual(['body', 'detail', 'both'])
  })
})

describe('errorMessageText', () => {
  it('读 Error.message，非 Error 用 String 兜底', () => {
    expect(errorMessageText(new Error('boom'))).toBe('boom')
    expect(errorMessageText('plain')).toBe('plain')
  })

  it('message 访问器抛异常时不向外冒泡', () => {
    const hostile = { get message(): string { throw new Error('getter exploded') } }
    expect(() => errorMessageText(hostile)).not.toThrow()
  })
})
