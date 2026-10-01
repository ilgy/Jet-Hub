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
`src/byok-product.ts` 里 25 个平台的 baseUrl 都是这样用「候选路径 vs 随机路径」
对照组逐个校正过的 —— 这也是**平台清单必须由服务端下发**的原因：
客户端抄一份必然漂移，而服务端本来就掌握平台解析权。

#### 25 个预设平台的全量复核（2026-10-02，零异常）

判据按 `publicCatalog` 分两类，各自只有一条有区分度的标准：

| 类别 | 平台 | 判据 | 实测结果 |
| --- | --- | --- | --- |
| `publicCatalog: true`（5 个） | `openrouter` / `chutes` / `nvidia` / `sambanova` / `novita` | 不带 Key 返回**可解析的非空模型列表** | 200，分别 463 / 14 / 81 / 7 / 121 个模型 ✅ |
| 其余（20 个） | `zhipu` … `ollama` | 不带 Key **必须被拒**（非 2xx） | 401（18 个）/ 403（`qianfan`、`cerebras`） ✅ |

⚠️ **三个「无区分度」origin 的正确解读**（都不是 base 路径写错）：
`volces`（`ark.cn-beijing.volces.com`）与 `deepseek`（`api.deepseek.com`）在
**前置网关**（`istio-envoy` / `server: （无）`）就把请求挡下并回 401，
候选路径、随机路径、甚至 `chat/completions` 的**信封完全一致** ⇒
状态码层面永远测不出端点存在性。两者的 base 路径只能**查官方文档确认**
（`/api/v3`、`/v1` 均与官方 OpenAI 兼容示例一致）。
第三个 `ollama` 更值得记一笔：`127.0.0.1:11434` 上**未必是 Ollama** ——
实测该端口被第三方本地代理 `cmdcode2api.exe` 占用，它对**任意**路径都回
`405/401 missing Authorization header`（真 Ollama 不需要鉴权、未知路径回 404）。
⇒ 本地端口类预设平台的「无区分度」**先查端口占用**（`Get-NetTCPConnection -LocalPort 11434`），
不要据此改 base 路径。

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

### ⚠️ 模型目录会**自动刷新**，不是「首个成功即永久缓存」

其余 13 个 provider 的适配器（cline / buddy / trae / lobsterai …）都是
**首个成功结果永久缓存**：`ensureRemoteModels()` 开头一句
`if (this.remoteModels !== undefined) return`。BYOK **不能**这样，它的目录有
两个随时会变的来源，永久缓存会直接表现为用户报障「平台上了新模型，插件里
看不到，重启才出现」：

1. 平台自己上新 —— 智谱一年内从 `glm-4.5` 走到 `glm-5.3`；
2. **用户在插件里新增 / 删除账号** —— 第二个账号往往指向另一个平台，
   它的模型必须立刻出现在同一个 `byok` 路由下。

三条机制，缺一不可：

| 机制 | 常量 / 入口 | 作用 |
| --- | --- | --- |
| TTL 重验证 | `BYOK_MODELS_TTL_MS = 5 * 60_000` | 过期即重拉，平台上新的模型自己出现 |
| 账号指纹 | `byokModelSignature(items)` | `accountId@base_url` 排序后 `|` 拼接；指纹变了**立即**重拉，不看 TTL |
| 变更广播 | `ByokAdapterOptions.onCatalogChanged` | 目录集合真的变了才通知宿主，`src/index.ts` 绑到 `broadcastCatalogChanged(ctx)` |

⚠️ **第三条第 2 半句最容易被漏掉**：只更新服务端内存不够。客户端的
`ModelCatalogDirectory` 在 `status === 'ready'` 时**短路返回缓存**，只在
`llm/adapters-updated` / `settings/document-updated` /
`credentials/reference-updated` 上 refresh ⇒ 不 `emit` 的话用户仍然要重启
DSH（与「关闭模型不生效」是同一处坑，见 `src/jet-hub-rpc.ts` 的
`broadcastCatalogChanged`）。

配套取舍：

- **只在模型 id 集合真的变化时**才回调（`byokSameModelIds(a, b)` 做**顺序无关**
  比较）。否则 TTL 每 5 分钟到点就是一轮无意义的事件风暴；顺序无关则是因为
  并集顺序随账号池拖拽顺序变，但那是**同一个目录**，不该把界面列表推倒重来。
- 拉取失败**保留旧目录**（`if (union.length === 0) return` 在赋值之前），
  一次网络抖动不该让选择器里的模型全没了。
- 失败冷却 `BYOK_MODELS_RETRY_MS = 30_000`，且**只在「一次都没拉到」且「指纹没变」**
  时生效。已经有成功目录时不吃冷却：TTL 本身就是节流，再叠一层会让「刚新增
  账号」被上一次失败卡住 30 秒 —— 那正是「更新不及时」的来源。
- `listAllModels()` 的判据必须**同时**看时间戳，不能只看
  `remoteModels === undefined`（只看 `undefined` 就退化成永久缓存）。
  它是同步签名（设置页契约），故只**触发**后台刷新，本次仍返回当前快照。
- `notifyCatalogChanged()` 内部 try/catch：宿主事件抛异常不能反噬已经拿到的目录。
- BYOK 凭据里的 `models?: readonly string[]`（`src/byok.ts:51-55`）**适配器从不读**，
  目录一律走 `GET /models`；那个字段只是历史遗留的解析宽容度。
- ⚠️ `byokSameModelIds(a, b)` 必须**连 `free` 一起比**：平台把某个模型从收费改成
  免费（或反之）时 id 集合**一个字都没变**，只比 id 会让界面上的「（免费）」后缀
  永远刷不出来 —— 与「只比 id 不看 TTL」是同一类漏判。改这个函数时别顺手「简化」
  回 `Set<id>`。

---

### ⚠️ 「免费」能不能显示：取决于平台**是否下发价格**，不能反推

用户问「没有显示是不是免费的，我怎么知道？」—— 规范答案分两半，缺哪一半都会答错：

**第一半：`/models` 通常根本没有价格字段。** 实测智谱
`GET https://open.bigmodel.cn/api/paas/v4/models` → 200 / 848 B，每个条目只有
`id` / `object` / `created` / `owned_by`。全表搜不到 price / pricing / free /
cost / billing / quota 任何一个字段。所以「列表里没有免费标记」**不是漏做**，
是 OpenAI 兼容的 `/models` 规范里压根没有这一项。**任何把「无标记」解释成
「收费」或「免费」的做法都是编造。**

**第二半：能拿到价格时必须真的标出来。** `parseByokFreeModelIds(body)`
（`src/byok.ts`）只认三类**有据可查**的写法：

| 形态 | 例子 | 判据 |
|---|---|---|
| `pricing:{prompt,completion}` | OpenRouter（464 个里 21 个命中） | 两者都存在且数值为 `0` |
| `input_token_price_per_m` / `output_token_price_per_m` | Novita（121 个里 7 个命中） | 两者都存在且数值为 `0` |
| `is_free` / `free` | 少数自建网关 | 严格 `=== true` |

⚠️ 三条硬约束，改动时逐条对照：

1. **只认确凿的 0**。字段缺失 = **未知**，不是 0（`byokZeroPrice` 对 `undefined`
   与不可解析字符串都返回 false）。标错「免费」会让用户在最贵的那一档上跑。
2. **OpenRouter 的 `pricing` 里有 `image:"-1"` 这类哨兵值**，故只读
   `prompt` / `completion` 两个字段，**不能**改成「整个 pricing 对象全是 0 才免费」。
3. **Novita 的 `pricing` 是嵌套对象**（`pricing.prompt.price_per_m: 1500`），
   `Number({})` 是 `NaN` 而非 `0` ⇒ 两条规则不会互相误触；但它同时给了扁平的
   `input_token_price_per_m`，所以 Novita 走第二条规则。

标记进的是 `name` 后缀「（免费）」，**不是 `description`**（本仓约定：计费相关
一律进 `name`，见 AGENTS.md 的 billing multiplier 一条），且**只加到展示名**——
`id` 必须保持裸 id，否则请求会打到不存在的模型上。

---

### ⚠️ 智谱的免费模型**不在** `/models` 里，必须靠平台表补

这是「全是收费的？」这个误解的**数据根因**：实测一个余额为 0 的智谱账号，

```
POST /chat/completions  max_tokens:1
glm-4.5 / 4.5-air / 4.6 / 4.7 / glm-5 / 5-turbo / 5.1 / 5.2 / 5.3 / 5.3-flash / 5.3-flashx
  → 全部 429 {"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}
glm-4-flash / glm-4.5-flash / glm-4-flash-250414 / glm-z1-flash
  → 全部 200（同样余额 0）
```

即：**免费模型能调，但接口一个都不下发**。只信 `/models` 的插件里就只剩收费模型。
故 `ByokPlatform` 多了 `freeModels?: readonly string[]`（`src/byok-product.ts`），
`loadByokModels` 把它**合并**进目录：接口已列出的就地补 `free: true`（顺序不变），
没列出的追加在末尾。

维护约定：**只加实测过 `POST /chat/completions`（`max_tokens:1`）返回 2xx 的 id**，
不加「文档说免费」的 id。宁可少列（用户仍可在「自定义」里手填 base url），不可列错
—— 列错会让请求直接 4xx。

`freeModels` 还是**平台表里唯一的非 URL 静态数据**，故测试钉了两条不变量：
只允许出现在有 `baseUrl` 的平台、id 无空白无重复。

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
| 平台上新了模型但选择器里没有 | 目录 TTL（5 分钟）还没到；若**永久**看不到，查 `src/index.ts` 是否漏了 `onCatalogChanged: () => broadcastCatalogChanged(ctx)` |
| 新增了第二个账号但模型没变多 | 同上；另确认客户端在收到 `llm/adapters-updated` 后确有 refresh（`ModelCatalogDirectory` 在 `ready` 时短路返回缓存） |
| 单个平台一直失败、其它正常 | 该平台的 baseUrl 需要用「候选路径 vs 随机路径」对照组**带 Key** 重测 |
| 账号卡片「有效期」显示「不适用（API Key 无固定有效期）」 | **正常**：BYOK 凭据没有 `expiresAt`，不是凭据损坏 |
| 列表里没有「（免费）」后缀 | **先看该平台的 `/models` 到底有没有价格字段**（智谱/NVIDIA/SambaNova 都没有 ⇒ 无标记是正常的，语义是「未知」）。OpenRouter 这类给了 `pricing` 的平台没标出来才是缺陷 |
| 余额为 0，付费模型全 429「余额不足或无可用资源包」 | **正常**：预付费平台余额耗尽即拒服务。查该平台是否配了 `freeModels`（智谱已配 3 个，见上文）——免费模型是唯一还能用的部分 |
| 免费模型报 403「您无权访问 xxx」 | 该 id 不在这个账号的权限内（如 `glm-4.6-flash`）；从 `freeModels` 里去掉，别留着 |

### 相关测试

- `tests/unit/byok.spec.ts` —— 纯函数层（平台表完整性、目录解析三信封、
  凭据解析必含 `base_url`、请求头、昵称不含 Key 前段、Key 形态预检、
  **免费判定 8 例：OpenRouter `pricing` 双 0 / `-1` 哨兵不误判 /
  Novita 双 0 / Novita 嵌套 pricing 不误判 / 只给一个价格字段不判 /
  `is_free` 严格 `=== true` / 智谱式目录一个都不标 / 裸字符串与垃圾入参**）。
  ⚠️ 平台表那两条 `freeModels` 不变量（只在有 `baseUrl` 的平台、
  id 无空白无重复）是**结构约束**，加平台时会被它们拦住。
- `tests/unit/byok-adapter.spec.ts` —— 适配器行为（目录缓存 / **目录自动刷新
  五例：TTL 重拉、指纹变更立即重拉、`onCatalogChanged` 只在集合真变时触发、
  **只有 `free` 标记变了也要通知**、失败保留旧目录** / in-flight 共享 / 门控 /
  失败不缓存但有 30s 冷却 / `max_tokens` 截断 / 图片拒绝 / 401 不续期 /
  429 换号 / 换号判据 / TRANSPORT / aborted / **`loadByokModels` 的免费合并
  五例：表内追加、就地补标记不改顺序、按接口价格标 free、不下发价格不标、
  非 2xx 文案**）。
  ⚠️ 用例用 `vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime`：TTL 与
  冷却都以 `Date.now()` 为基准，只 fake `Date` 就不会干扰 Promise 微任务。
- `tests/unit/byok-rpc-dispatch.spec.ts` —— 源码扫描式分派回归。
  ⚠️ 断言「本分支**不含**某调用」时必须先用 `codeOf(branch)` **剥掉注释**：
  BYOK 分支的注释里刻意写着「绝不能复用 `startLogin` 形状」，
  直接扫原文会让这句解释性文字把断言自己判红。

- **包名**：`dsh-codearts-auth`
- **入口**：`lib/index.js`（宿主侧）、`lib/client/jet-hub.js`（客户端 bundle）
- **语言**：TypeScript
- **许可**：MIT
