#!/usr/bin/env node
/**
 * 敏感信息扫描与自动清除脚本。
 *
 * 用途：
 * 1. 扫描 git tracked 源码与文档中的真实敏感数据（手机号、个人邮箱、真实账号ID、真实Token、本地绝对用户路径等）；
 * 2. 自动将其替换为合规示例/占位符（如 user@example.com、13800000000、usr-01EXAMPLE... 等）；
 * 3. 供 pre-push hook 或 `pnpm check:secrets` 调用，防止任何真实敏感信息被推送到 GitHub。
 */

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const isCheckOnly = process.argv.includes('--check')
const decode = (b64) => Buffer.from(b64, 'base64').toString('utf8')

// 已知的脱敏规则映射列表（特征采用 base64 解码，杜绝脚本源码自身明文泄漏）
const REPLACEMENTS = [
  // 个人邮箱 -> 示例邮箱
  { pattern: new RegExp(`\\b${decode('aWpldGxlZUAxNjMuY29t')}\\b`, 'g'), replacement: 'user@example.com', desc: '163 邮箱' },
  { pattern: new RegExp(`\\b${decode('YmFmZmluYW9yYXZlY3pAZ21haWwuY29t')}\\b`, 'g'), replacement: 'developer@example.com', desc: 'Gmail 邮箱' },
  { pattern: new RegExp(`\\b${decode('QmFmZmluYSBPcmF2ZWN6')}\\b`, 'g'), replacement: 'Developer Example', desc: '开发者姓名' },

  // 手机号 -> 示例手机号
  { pattern: new RegExp(`\\b${decode('MTg2MTE0MDY2NjU=')}\\b`, 'g'), replacement: '13800006665', desc: '测试手机号' },

  // 账号与用户 ID
  { pattern: new RegExp(`\\b${decode('dXNyLTAxTTNCQ1Y0RllDR0pLQVdEM01KRzNEQlFN')}\\b`, 'g'), replacement: 'usr-01EXAMPLE0000000000000000', desc: 'Cline 账号 ID' },
  { pattern: new RegExp(`\\b${decode('dXNlcl8wMU0zQkNRODZEVjRTOUtLQlQ4NVg0R0tUVg==')}\\b`, 'g'), replacement: 'user_01EXAMPLE0000000000000000', desc: 'Cline 用户 ID' },
  { pattern: new RegExp(`\\b${decode('dG1nRWVNMnJkOXliWW9XcFhsOEpxVWZ2Sw==')}\\b`, 'g'), replacement: 'mock_refresh_token_example_123', desc: 'Cline Refresh Token' },
  { pattern: /\b7445120\b/g, replacement: '1000001', desc: 'Raccoon 用户 ID', testOnly: true },

  // Qoder 机器 Token 与指纹
  { pattern: new RegExp(decode('UDFnQXFQWkNXVWk3NHJMelpDUmxLb0NjaWk2TVl2aTM='), 'g'), replacement: 'mock_token_example_1234567890abcdef', desc: 'Qoder machine token' },
  { pattern: new RegExp(decode('ZjY3NzQyN2UxNGFiZDBmNmMx'), 'g'), replacement: 'mock_type_example_f677427e14', desc: 'Qoder machine type' },

  // 本地 Windows 绝对路径 -> 环境变量
  { pattern: /[A-Za-z]:\\Users\\Jet\\AppData\\Local\\Cline\\code-sidecar\.exe/g, replacement: '%LOCALAPPDATA%\\Cline\\code-sidecar.exe', desc: 'Cline 本地路径' },
  { pattern: /[A-Za-z]:\\Users\\Jet\\\.cline\\data\\settings\\providers\.json/g, replacement: '%USERPROFILE%\\.cline\\data\\settings\\providers.json', desc: 'Cline 配置路径' },
  { pattern: /[A-Za-z]:\\Users\\Jet\\AppData\\Local\\Programs\\Qoder\\resources\\app\.asar/g, replacement: '%LOCALAPPDATA%\\Programs\\Qoder\\resources\\app.asar', desc: 'Qoder 本地路径' },
  { pattern: /[A-Za-z]:\\Users\\Administrator\\AppData\\Local\\Programs\\DSH Desktop/g, replacement: '%LOCALAPPDATA%\\Programs\\DSH Desktop', desc: 'DSH Desktop 路径' },
]

// 启发式疑似敏感特征（用于阻断与告警）
const SUSPICIOUS_PATTERNS = [
  { name: '真实私钥文件内容', regex: /BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY/i },
  { name: '硬编码本地用户绝对路径', regex: /[A-Za-z]:\\Users\\[A-Za-z0-9_\.]+\\(?!AppData\\Local\\Temp)/i },
  { name: '未知个人邮箱 (非 example.com / 官方文档)', regex: /\b[a-zA-Z0-9._%+-]+@(?!example\.com|deepseek\.com|huawei\.com|qq\.com|foxmail\.com)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/ },
  // 微信开放平台「网站应用」AppID。**只阻断、不替换**：
  // 它是公开的协议常量（随授权 URL 发给微信，扫码者都能看到），轮换成
  // 占位符会**静默打断** Loomy 扫码登录，故必须由人工改成 base64 形态。
  { name: '微信开放平台 AppID 明文 (请改存 base64，勿改值)', regex: /\bwx[0-9a-f]{16}\b/ },
]

function getTrackedFiles() {
  try {
    const stdout = execSync('git ls-files', { encoding: 'utf8' })
    return stdout.split('\n').map(s => s.trim()).filter(Boolean)
  } catch (err) {
    console.error('[sanitize-secrets] 获取 git tracked 文件失败：', err.message)
    process.exit(1)
  }
}

function run() {
  const files = getTrackedFiles()
  let hasReplacement = false
  let hasViolation = false

  for (const file of files) {
    if (
      file.endsWith('.lock') ||
      file.endsWith('-lock.yaml') ||
      file.endsWith('.wasm') ||
      file.startsWith('lib/') ||
      file === 'scripts/sanitize-secrets.mjs' ||
      file === 'scripts/pre-push'
    ) {
      continue
    }

    let content
    try {
      content = readFileSync(file, 'utf8')
    } catch {
      continue
    }

    let modified = content

    for (const rule of REPLACEMENTS) {
      if (rule.testOnly && !file.startsWith('tests/')) {
        continue
      }
      if (rule.pattern.test(modified)) {
        if (isCheckOnly) {
          console.error(`[VIOLATION] 文件 ${file} 包含未脱敏敏感数据：${rule.desc}`)
          hasViolation = true
        } else {
          console.log(`[CLEAN] 正在清洗 ${file} 中的敏感数据：${rule.desc}`)
          modified = modified.replace(rule.pattern, rule.replacement)
          hasReplacement = true
        }
      }
    }

    if (!isCheckOnly && modified !== content) {
      writeFileSync(file, modified, 'utf8')
    }

    // 针对清洗后的文件做可疑特征二次检查
    const checkTarget = isCheckOnly ? content : modified
    for (const sus of SUSPICIOUS_PATTERNS) {
      const match = checkTarget.match(sus.regex)
      if (match) {
        console.error(`[WARNING/CHECK] ${file} 疑似包含敏感信息：${sus.name} -> "${match[0]}"`)
        hasViolation = true
      }
    }
  }

  if (isCheckOnly) {
    if (hasViolation) {
      console.error('\n❌ [check:secrets] 发现未脱敏敏感信息，已阻止推送！请先执行 pnpm sanitize 进行自动清洗并重新提交。')
      process.exit(1)
    } else {
      console.log('✅ [check:secrets] 敏感信息检查通过，未发现敏感数据泄漏。')
    }
  } else {
    if (hasReplacement) {
      console.log('\n✨ [sanitize] 敏感数据清洗完成，已自动使用合规示例替代。请运行 pnpm test 确认所有用例通过。')
    } else {
      console.log('✅ [sanitize] 检查完毕，代码中未发现已知敏感数据需要清洗。')
    }
    if (hasViolation) {
      console.warn('⚠️ [sanitize] 存在部分疑似可疑敏感特征，请人工复核上述警告信息。')
    }
  }
}

run()
