# BYOK（自带 API Key）分册

> 本文件是 [AGENTS.md](../../AGENTS.md) 的**分册**。
> 主文件只留「规则 + 索引」；本分册保留完整的实测数据、判据推导与排查记录。

覆盖 `src/byok.ts`、`src/byok-product.ts`、`src/byok-auth.ts`、`src/byok-adapter.ts`，
以及 `src/rpc/login.ts` 的 `login.submitKey`、`src/rpc/account.ts` 的 BYOK 分支、
客户端 `plugin-src/client/jet-hub.js` 的 `keyForm` 表单。

---

### ⚠️ BYOK 为什么要存在：四条件筛选的结论

2026-10 按「**送积分 + 有可编程 API + 可扫码/跳转登录 + 有一键签到**」四条硬标准
核了 40 多个平台，**同时满足四条的新平台为零**，卡点几乎全在第三条登录链：

| 平台 | 额度 | OpenAI 兼容 | 登录链能否在插件内完成 | 签到 |
| --- | --- | --- | --- | --- |
| 智谱 GLM / ZCode | ✓ | ✓ `/api/paas/v4` | ✗ **须控制台手工建 Key 再粘贴** | 客户端内 |
| 火山方舟 | ✓ 新用户 50 万 tokens | ✓ `/api/v3` | ✗ 同上 | ✗ |
| 阿里百炼 | ✓ 新用户 100 万 tokens | ✓ `/compatible-mode/v1` | ✗ 同上 | ✗ |
| 百度千帆 | ✓ | ✓ `/v2` | ✗ 同上 | ✗ |
| 腾讯元器 | ✓ 1 亿 tokens | ✗ **无兼容端点** | — | ✗ |
| MiniMax Code | ✓ 400 积分/天 | ✓ | ✗ | ✓ 但**只有客户端 UI，无公开 HTTP 端点** |
| Chutes.ai | 需先充 $5 | ✓ | ✓ **唯一登录链可全程序化（OAuth2 + PKCE）** | ✗ |
| OpenRouter | 半 | ✓ | ✗ | ✗ |
| Groq / Cerebras / Kimi / Cloudflare Workers AI / LongCat | ✓ | ✓ | ✗ | ✗ **服务端按日自动重置，没有「签到」这个动作** |

两条由此确立的认识：

1. **「每日额度」≠「签到」**。除 MiniMax Code 与 WorkBuddy/CodeBuddy 系外，
   几乎全部平台都是**服务端自动发放**，不存在用户主动领取的动作。
2. 唯一登录链可全程序化的 Chutes.ai **无签到且要先充 $5**，不满足「明确能直接登录使用」。

因此用户裁量**放宽第三条**：新增一类「**粘贴 API Key**」的凭证录入形态，
把「额度 + 兼容端点」但登录链不可程序化的平台统一接进来。
**BYOK 不是厂商，是一类通道** —— 面板上的 26 个平台共用同一个 `provider: 'byok'`。

---

### ⚠️ 校验判据：`GET /models`，且必须「2xx **且**至少一个模型 id」

`ByokAuth.validateApiKey()` 只做一件事：打一次 `GET {baseUrl}/models`。

- **只看 2xx 不够**：有些网关对任意路径都回 200，但正文是错误信封或空清单。
  故判据取**与**：2xx **且** `parseByokModelList(body).length > 0`。
- 空清单的报错文案要**指向真正的原因**：
  「Key 通过了鉴权但该端点没有返回任何模型（可能 base url 少了一段路径）」——
  这是实测最常见的一类配置错误（用户把 `/v1` 或 `/api/v3` 漏掉）。
- 该端点是**只读**的，不消耗额度、不产生费用，因此可以每次粘贴都跑。

### ⚠️ 「先验后写」的顺序不能反

`login.submitKey` 的顺序固定为：

```
findAccount → byokApiKeyLooksMalformed → byokResolveBaseUrl
  → byok.validateApiKey（不 ok 直接 return，不落库）
  → byok.persistApiKey → pool.updateAccount({ nickname, refreshable: false })
  → broadcastCatalogChanged → { done: true, modelCount }
```

**写在前面的后果是一个黑洞**：Key 存进 `ctx.credentials` 而校验失败时，
账号池里多出一条**有凭据但不可用**的条目 —— 它会被 `hasLoggedInAccount` 判为「已登录」，
于是**模型目录门控放行**（`listModels` 不再返回 `[]`），用户看到模型列表有内容、
选中后每次请求都 401。这类「看起来配置好了但一发就错」最难自查，
所以宁可失败时什么都不写。

失败时**不删占位条目**（与 Loomy 短信登录同取舍）：条目留在账号池里、无凭据，
用户点「新建账号」可再来一次。中途关掉表单同理。

---

### ⚠️ 探针方法论：端点是「存在」还是「路由兜底」

判定第三方端点的 base 路径时，**不能只看候选路径的状态码**。
大量 origin（火山 Ark、讯飞 Spark 等）对**任意**路径都返回同一个 401 / 403：

| 测法 | 候选路径 | 随机路径 | 结论 |
| --- | --- | --- | --- |
| 不带 Key | 401 | **401** | ✗ **无区分度，什么都没测出来** |
| 带 Key | 200 | **404 Route Not Found** | ✓ 端点确实存在 |

⇒ **「无区分度」≠「端点不存在」**，这类 origin 必须**带 Key 复测**。
`src/byok-product.ts` 里 19 个平台的 baseUrl 都是这样用「候选路径 vs 随机路径」
对照组逐个校正过的 —— 这也是**平台清单必须由服务端下发**的原因：
客户端抄一份必然漂移，而服务端本来就掌握平台解析权。

---

### ⚠️ 安全边界：预设平台一律用表里的 `baseUrl`

`byokResolveBaseUrl(platformId, customBaseUrl?)`：

- `platformId` 命中预设表 → **一律返回表里的 `baseUrl`，完全忽略前端传值**。
  前端只有 `platform === 'custom'`（或表里 `baseUrl` 为空）时才有话语权。
- 后端去首尾空白 + 去**尾部**斜杠；空串 / 全斜杠 → `undefined`（拒绝，而不是拼出 `//models`）。
- 这条边界的作用：即使前端被改、或被手工构造的 RPC 调用，也**不能**把请求引到
  预设平台之外的地方去（否则就变成一个「拿用户 Key 打任意地址」的转发器）。

`byokBaseUrlLooksValid()` = `/^https?:\/\/[^\s]+$/i` —— **只拦「没写协议头」**。
⚠️ **`http://127.0.0.1` 必须放行**（本地 Ollama 走 `http://127.0.0.1:11434/v1`），
所以绝不能加「必须 https」这类看似更安全的收紧。

---

### ⚠️ 模型目录解析要认三种信封（本地 Ollama 不在 OpenAI 规范里）

`parseByokModelList(body)` 依次尝试：

1. `{ data: [...] }` —— OpenAI 标准；
2. `{ models: [...] }` —— **Ollama 原生 `/v1/models` 用的是这个**；
3. 裸数组 —— 部分自建网关。

元素可以是对象（取 `id` → `name` → `model`）**或裸字符串**（Ollama 早期形态）。
去重保序。**这不是「兼容一下而已」**：BYOK 的 26 个平台里有本地推理这一档，
少认一种信封就等于该平台永远「没有模型」。

---

### ⚠️ Key 形态预检只拦结构性错误，不做前缀白名单

`byokApiKeyLooksMalformed()` 只拦四类**粘贴事故**：

| 情形 | 文案 |
| --- | --- |
| 空串 | `API Key 不能为空` |
| 含 `[\r\n]` | `API Key 里含换行，请只粘贴密钥本身` |
| 首尾带引号 | `API Key 首尾带引号，请去掉引号` |
| 含空白 | `API Key 里含空格，请只粘贴密钥本身（不要带 "export KEY=" 前缀）` |

⚠️ **绝不加长度或前缀白名单**。各家的 Key 形态千奇百怪（`sk-` / `ccgw-` /
`user_` / 纯 hex / JWT / 带点号的二段式），任何白名单都只会挡掉**合法**的 Key，
而挡不住错误的 Key —— 那是服务端 `/models` 校验的职责。

### 昵称只放尾 4 位

`buildByokNickname(platformLabel, apiKey, fallbackId)` = `` `${平台名} · ${key 尾 4 位}` ``。

⚠️ **绝不放 Key 前段**：昵称会出现在账号卡片、模型列表、日志里，
前段通常是可识别的平台前缀信息量更大。空 Key 时回落为平台名，再回落为账号 id。

---

### 请求头极简，且 401/403 **不触发续期**

`byokHeaders(credential)` 只产出 `Authorization: Bearer <key>` + `Accept`。

- 不带任何厂商身份头（`X-Product-Code` / `X-Domain` / `Cosy-ClientType` 等一律没有）——
  不同平台互不认对方的头，带了反而可能被判为异常客户端。
- 请求打在**凭据自己的 `base_url`** 上，而不是固定的产品端点。
- ⚠️ **401 / 403 直接如实报错，不做「401 就续期重试」**：
  BYOK **没有 refresh 端点、也没有 refresh_token 可轮换**。
  适配器只在**凭据缺失**或 `isByokExpired()` 为真时才调 `refresh()`。
  对 401 做续期是纯粹的浪费：探测一次还是 401，但用户会以为「系统在自救」。

`isByokExpired()` 默认**恒 false** —— 只有凭据里显式带了正有限数的 `expire_time` 才判定。

### 失败与换号

| 触发 | 行为 |
| --- | --- |
| 429 / 402，或响应文案命中额度标记（`BYOK_CREDIT_MARKERS`） | 换下一个账号（`BYOK_MAX_ROTATE = 3`） |
| 换完仍失败 | 抛 `QUOTA_EXCEEDED` |
| 非限流 4xx（如 400 参数错） | **不换号**，如实透出远端明细（换号只会掩盖真实错误） |
| 网络层失败 | `LlmError(..., 'TRANSPORT', { cause })` |
| `options.signal.aborted` | **原样抛**（用户主动取消不是错误） |
| 图片输入 | `LlmError(..., 'UNSUPPORTED_CONTENT')` —— 不臆造多模态能力 |

- ⚠️ **限流徽章只记 429 / 402**（`recordsByokRateLimit`），
  **不记**文案命中的那些 —— 文案随平台和语言漂移，不适合作为持久状态。
  冷却兜底 `BYOK_RATE_LIMIT_FALLBACK_MS = 3_600_000`。
- `resolveModel()` **故意不声明** `reasoning` / `defaultMaxTokens` / `context`：
  26 个平台的参数体系互不相同，凭空给默认值会在部分平台上直接把请求打死。
  `max_tokens` 只在调用方显式给出时下发，并 `clampByokMaxTokens` 到
  `BYOK_MAX_OUTPUT_TOKENS = 32_768`（`Math.floor` + `<= 0 → undefined` + `Math.min`）。

---

### ⚠️ 目录加载失败必须留下日志：`warn` 是**必填**注入

`ByokAdapterOptions.warn: (message: string) => void` **不做可选带默认值**。
`src/index.ts` 注入 `warn: message => ctx.logger.warn(message)`。

理由：适配器拿不到 `ctx`，早期版本用 `console.warn`，撞上 `scripts/lint.mjs` 的
`console.* ≤ 10` 棘轮基线（涨到 12）。改成可选带默认值最省事，
但漏传会让**目录加载失败静默无痕** —— 而「模型列表突然空了但没有任何日志」
正是这类问题里最难查的一种。宁可编译期强制。

---

### ⚠️ 客户端必须在 `if (loginUrl)` **之前**分流

`account.create` 的 BYOK 分支**不返回 `loginUrl`**（返回空串 + `loginMode: 'key'` +
`platforms`），因为 BYOK 没有可 `window.open` 的页面：Key 要用户自己去第三方控制台复制，
那张控制台跨域、且需要用户自己的账号密码。

⇒ 客户端 `createAccount` 里顺序必须是：

```
loginUrl = res.loginUrl
if (res.loginMode === 'key') { setKeyForm({...}); return }   // ← 必须在这里
if (loginUrl) { window.open(...); 轮询 login.poll }
else { 报「后端未返回登录地址」 }
```

落进 `if (loginUrl)` 的后果是 BYOK 永远报「后端未返回登录地址」——
而 `loginUrl` 明明是**空串**，这个报错文案会让排查方向完全跑偏。

平台清单（`platforms`）由 `account.create` 的响应下发（见 `RpcCreateAccountResponse.platforms`），
**故意不含任何凭据**：它只是公开的平台元数据，用户的 Key 直到 `login.submitKey`
才第一次出现，且只向后端单向传递。

### `account.refresh` 的 switch 是最容易漏的一处

**真实踩过三次**（`buddy-intl` / `workbuddy-cn` / `byok`）。漏了会落 `default`
抛 `Unknown provider: byok`，表现为账号卡片的「刷新」按钮点一下就报错。

BYOK 的 `case` 语义与 raccoon **相反**：

```ts
case BYOK.id:
  await byok.refreshAccountCredential(entry.credentialRef)
```

`ByokAuth.refreshAccountCredential()` 只能做**有效性探测**（打一次 `GET /models`），
**探测成功也不改写凭据** —— 免得制造「凭据被刷新过」的假象。
与 Loomy 同型（服务端无 refresh 端点），与 raccoon 的「真续期」相反。

---

### 排查清单（现象 → 定位）

| 现象 | 先查 |
| --- | --- |
| 面板点了「新建账号」没弹表单 | 客户端 `createAccount` 的 `loginMode === 'key'` 分流是否在 `if (loginUrl)` **之前** |
| 表单里平台下拉为空 | 服务端 `account.create` 是否正确下发 `platforms`（`BYOK_PLATFORMS.map`） |
| 提示「Key 通过了鉴权但该端点没有返回任何模型」 | base url 少了一段路径（`/v1`、`/api/v3`、`/compatible-mode/v1`） |
| 提示「模型目录不是合法 JSON（该端点可能不是 OpenAI 兼容接口）」 | 该地址不是兼容端点，或需要特定 UA / 走了 HTML 错误页 |
| 校验通过但一发就 401 | 该账号的凭据被外部改了；BYOK **不会**为 401 续期，需重新粘贴 |
| 账号卡片「刷新」报 `Unknown provider: byok` | `src/rpc/account.ts` 的 `account.refresh` switch 缺 `case BYOK.id:` |
| 模型列表空但账号已登录 | `ensureRemoteModels()` 全失败时**故意不缓存**空集（避免把临时故障固化成永久空列表），看 `ctx.logger.warn` 的「模型目录拉取失败」 |
| 单个平台一直失败、其它正常 | 该平台的 baseUrl 需要用「候选路径 vs 随机路径」对照组**带 Key** 重测 |

### 相关测试

- `tests/unit/byok.spec.ts` —— 纯函数层（平台表完整性、目录解析三信封、
  凭据解析必含 `base_url`、请求头、昵称不含 Key 前段、Key 形态预检）。
- `tests/unit/byok-adapter.spec.ts` —— 适配器行为（目录缓存 / in-flight 共享 /
  门控 / 失败不缓存 / `max_tokens` 截断 / 图片拒绝 / 401 不续期 / 429 换号 /
  换号判据 / TRANSPORT / aborted）。
- `tests/unit/byok-rpc-dispatch.spec.ts` —— 源码扫描式分派回归。
  ⚠️ 断言「本分支**不含**某调用」时必须先用 `codeOf(branch)` **剥掉注释**：
  BYOK 分支的注释里刻意写着「绝不能复用 `startLogin` 形状」，
  直接扫原文会让这句解释性文字把断言自己判红。

- **包名**：`dsh-codearts-auth`
- **入口**：`lib/index.js`（宿主侧）、`lib/client/jet-hub.js`（客户端 bundle）
- **语言**：TypeScript
- **许可**：MIT
