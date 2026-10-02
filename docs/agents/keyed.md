# 「粘贴 API Key」族分册（`commandcode` / `opencode`）

> 本文件是 [AGENTS.md](../../AGENTS.md) 的**分册**。
> 主文件只留「规则 + 索引」；本分册保留完整的实测数据、判据推导与排查记录。

覆盖 `src/keyed-product.ts`（产品表）、`src/keyed.ts`（凭据与解析纯函数）、
`src/keyed-auth.ts`（校验与入库）、`src/keyed-adapter.ts`（LLM 适配器），
以及 `src/rpc/login.ts` 的 `login.submitKey`、`src/rpc/account.ts` 的本族分支、
客户端 `plugin-src/client/jet-hub.js` 的 `keyForm` 表单。

---

### ⚠️ 这一族为什么要存在：四条件筛选的结论

2026-10 按「**送积分 + 有可编程 API + 可扫码/跳转登录 + 有一键签到**」四条硬标准
核了 40 多个平台，**同时满足四条的新平台为零**，卡点几乎全在第三条登录链：
创建 API Key 这一步在几乎所有平台上都藏在控制台里，需要用户自己的账号密码。

由此确立的用户裁量：**放宽第三条**，新增一类「**粘贴 API Key**」的凭证录入形态，
把「有额度 + 有 OpenAI 兼容端点」但登录链不可程序化的平台接进来。

本族与「一个 provider 一个厂商」的其余渠道不同：**每个 provider 就是一个平台**
（端点由产品表决定，用户不能改），且**没有登录链、没有续期、没有签到与余额查询**。

---

### ⚠️ 校验判据：必须打 **chat 端点**，`GET /models` 完全不可信

这是本族最容易写错、且写错以后最难发现的一处。

| 平台 | `GET {base}/models` 无 Key | 有 bogus Key | 结论 |
| --- | --- | --- | --- |
| `api.commandcode.ai/provider/v1` | **200**（85 个模型） | **200** | 目录端点**不鉴权** |
| `opencode.ai/zen/v1` | **200**（85 个模型） | **200** | 目录端点**不鉴权** |

⇒ 拿 `/models` 当校验，**任何字符串都会被判「有效」**。用户会看到一个登录成功的
账号，然后每一轮对话都 401 —— 而报错文案与真实原因完全无关。

故 `KeyedAuth.validateApiKey()` 的顺序固定为：

```
1. keyedApiKeyLooksMalformed（结构预检，不发请求）
2. probeKeyedApiKey  →  POST {base}/chat/completions
                        { model: probe.model, messages: [...], max_tokens: 1, stream: false }
3. （成功后才）尽力 loadKeyedModels 拿模型数量
```

**第 3 步失败不影响第 2 步的结论** —— 探测已经证明 Key 是对的，目录拉不到只是少个计数。

#### ⚠️ 探测模型必须是**免费档位**

每次粘贴 Key 都会跑一次校验。用计费模型会让用户**为了配置插件而付钱**，
且用户完全无从预期。故 `KeyedProduct.probe.model` 一律取实测免费 / 零开销的模型
（由 `tests/unit/keyed.spec.ts` 断言后缀命中 `[-_:]free$`）。

#### ⚠️ opencode 的判据必须**连报文一起判**

`opencode` 对两种完全不同的情况都返回 **401**：

| 报文 | 含义 | 该判无效吗 |
| --- | --- | --- |
| `{"error":{"type":"AuthError","message":"Invalid API key."}}` | Key 无效 | ✅ 该判 |
| `{"error":{"type":"ModelError","message":"... not supported for format systemone"}}` | **模型不该走这条路径** | ❌ 不该判 |

只看状态码会把「模型选错了协议」误判成「Key 失效」，用户会一头雾水地反复重新粘贴
一个完全正确的 Key。故 `KeyedProduct.probe.invalidIf(status, body)` 是**函数**而不是数字。

`commandcode` 侧另有第三种情况：**403 是「账号无权限」**（不是 Key 失效），
同样不能判无效 —— 它的 `invalidIf` 只认 401。

### ⚠️ 「先验后写」的顺序不能反

`login.submitKey` 的顺序固定为：

```
findAccount → keyedProductById(provider) → auth.validateApiKey（不 ok 直接 return，不落库）
  → auth.persistApiKey → pool.updateAccount({ nickname, refreshable: false })
  → broadcastCatalogChanged → { done: true, modelCount }
```

**写在前面的后果是一个黑洞**：Key 存进 `ctx.credentials` 而校验失败时，
账号池里多出一条**有凭据但不可用**的条目 —— 它会被 `hasLoggedInAccount` 判为「已登录」，
于是**模型目录门控放行**（`listModels` 不再返回 `[]`），用户看到模型列表有内容、
选中后每次请求都 401。这类「看起来配置好了但一发就错」最难自查，
所以宁可失败时什么都不写。

失败时**不删占位条目**（与 Loomy 短信登录同取舍）：条目留在账号池里、无凭据，
用户点「新建账号」可再来一次。中途关掉表单同理。

#### ⚠️ 端点只认服务端产品表

`login.submitKey` **完全不采信**前端传的 `platform` / `baseUrl`：端点一律
`keyedProductById(provider).baseUrl`。否则前端可以拿一个展示名配上任意地址，
把凭据写进一个与用户所选渠道不符的端点。

---

### ⚠️ 「免费」只能靠 id 后缀 —— 绝不能把「实测能调通」标成免费

两个平台的 `/models` 条目**都没有任何价格字段**：

```json
{"id":"claude-sonnet-5-5","object":"model","created":1790910258,
 "owned_by":"command-code","name":"Claude Sonnet 5.5",
 "context_length":1000000,"supported_endpoints":["/messages"]}
```

本机用真实的 commandcode Key 逐个 `POST /chat/completions`（`max_tokens:1`）实测：

| 结果 | 数量 | 含义 |
| --- | --- | --- |
| **200** | **55** | 这个 Key 有权限 |
| **403** | 14 | 账号无权（全部 gpt-5.x/6.x + gemini-3.5-3.6-flash 等） |
| **400** | 16 | 10 个 claude 要走 `/messages`；2 个报 `max_output_tokens`；2 个报无可用 provider |

⚠️ **那 55 个 200 里只有 3 个带 `free` 后缀**，其余 52 个（deepseek / Kimi / GLM /
Qwen …）**不带后缀**。差别在于：这 52 个是**这个 Key 的权益**，不是平台公开事实 ——
换一个账号很可能 403。把它们标成「免费」会让别的用户在计费模型上**毫无防备**。

故 `keyedModelIdLooksFree()` **只认名字后缀**（`-free` / `:free` / `_free`），
其余一律 `free: false`，语义是「**未知**」而不是「收费」——
与主文件的「无标记的语义是未知，绝不能反推」一致。

`parseKeyedModelEntries` 同时保留「远端若真报零价则标免费」的判据
（`pricing.prompt/completion` 双零、`input/output_token_price_per_m` 双零、
布尔 `is_free`/`free`），是为了将来某天平台补上价格字段时能自动生效。

### 实测的免费模型清单（opencode，来自官方文档表格）

`https://opencode.ai/docs/zen/` 的 `<Name> | <id> | <endpoint> | <sdk>` 表格标注为 Free：

`jev-1.13-free`（`/systemone`）、`space-bunny-free`、`longcat-2.5-preview-free`、
`mimo-v2.6-flash-free`、`mimo-v2.5-free`、`ling-3.0-flash-fin-free`、
`nemotron-3-ultra-free`、`nemotron-3.5-lightning-free`（均 `/chat/completions`）。

`/models` 里有 **12 个** id 命中 `[-_:]free$`，比文档多 4 个
（`deepseek-v4-flash-free`、`muse-spark-1.3-contributor-free`、
`muse-spark-1.2-contributor-free`、`fledge-alpha-free`）——
故适配器按**后缀**放行而不是抄文档白名单（文档会滞后）。

---

### ⚠️ 下架不属于本协议的模型（列出来却调不通比不列更糟）

`KeyedProduct.excludeModels` 是**能力事实**，不是用户可切换的黑名单开关。

| provider | 下架 | 实测原因 |
| --- | --- | --- |
| commandcode | 10 个 claude（`claude-sonnet-5-5`、`claude-opus-5` …） | 用 chat 调返回 **400** `Model "claude-sonnet-5-5" must be called via /provider/v1/messages (Anthropic Messages shape).` |
| opencode | `jev-1.13`、`jev-1.13-free` | 走 `/zen/v1/systemone`（另一套请求/响应形状），且 `space-bunny-free` 走 systemone 会返回 401 ModelError |

下架时 `loadKeyedModels` 会产出一条 warning（`模型 X 不接受 /chat/completions…`），
便于排查「文档里有的模型怎么不见了」。

### ⚠️ commandcode 的 `supported_endpoints` 分布（85 个模型）

- `/chat/completions` + `/responses` —— **66 个**
- `/messages`（10 个 claude）—— **10 个** ⇒ 被下架
- 只给 `/chat/completions` —— **9 个** ⇒ 保留

⇒ 支持 chat 的共 **75 个**。这个字段是数据驱动的下架依据，不必硬编码模型名单；
本族当前按名单下架是为了让 warning 文案能说清「另一套协议」。

---

### ⚠️ 伪装客户端头**一律无效**，不要尝试

`opencode` 的免费档位在服务端按「**是否来自 OpenCode 客户端**」判定。实测全部失败：

| 尝试 | 结果 |
| --- | --- |
| 无 header | 403 `FreeTierError` |
| UA = `opencode/1.0.0` / `opencode-cli/0.5.0` / `OpenCode/1.0` / `Mozilla/5.0...` / `node` | 全部 403 `FreeTierError` |
| `x-opencode-client` / `x-opencode-version` / `x-zen-client` / `origin` / `referer` | 全部 403 `FreeTierError` |

⇒ **免费档位在插件内不可用**。带**有效 Key** 时不再走这条判定
（鉴权先于档位），故 `keyedHeaders()` **只有** `Authorization` + `Accept`
（外加请求时的 `Content-Type`），不伪造任何厂商身份头 ——
伪造既无用，又多一处会过期的伪装。

---

### ⚠️ 凭据模型与 `ctx.credentials` 的取值形状

`KeyedCredential` = `{ access_token, product, base_url, models?, nickname?, expire_time? }`。

- `base_url` **冗余存一份**而不每次从产品表现查：预设端点会随上游调整，
  而**已经登录的账号不该因为插件升级就换了端点**。
- ⚠️ `ctx.credentials.resolve(ref)` 返回的是 `{ value }` **包装**而不是裸字符串。
  把返回值直接当字符串用会让 `JSON.parse` 拿到
  `{"value":"...","source":"..."}` 而解析失败，表现为「**刚粘贴就报凭据缺失**」。
  必须取 `.value`（见 `KeyedAuth.resolveStored`）。
- ⚠️ `parseKeyedCredential` 在 `JSON.parse` 前必须清洗控制字符
  （`raw.replace(/[\u0000-\u001f]+/g, ' ')`）：用户从终端复制 Key 时经常带上
  `\r` / `\n`，否则抛 `SyntaxError: Bad control character in string literal in JSON`
  —— 而这份文本是**插件自己写进去的**，抛错会让人完全找不到方向。
- 判据必须**包含 `base_url`**：没有它拼不出端点，账号会变成「看得见但用不了」。

### ⚠️ 昵称只放 Key 尾 4 位

`buildKeyedNickname()` → `产品名 · 尾4位`（如 `Command Code · sui7`）。
昵称会出现在面板、截图与 bug 报告里，放前段等于泄露凭据前段。

### ⚠️ Key 结构预检只拦四类，**绝不做前缀 / 长度白名单**

实测两家平台的 Key 形态各异：`user_...`（commandcode）、`sk-...` / `oc_...` /
纯 hex（opencode）。白名单会把正确的 Key 挡在门外，且用户根本无从判断自己错在哪。

`keyedApiKeyLooksMalformed()` 只拦：空串、含换行、首尾带引号、含空格
（最后一类覆盖「从终端复制时带上了 `export KEY=` 前缀」）。

---

### ⚠️ 目录自动刷新（TTL + 账号指纹 + 集合真变才广播）

本族的目录**会变**：同一产品下用户可能粘贴多个 Key，各自的权益不同；
平台也会上新模型。故：

- `KEYED_MODELS_TTL_MS = 5 * 60_000` —— 超过 TTL 重拉；
- `keyedModelSignature()` = `账号id@base_url` 排序拼接 —— **指纹变了立刻重拉**
  （新贴一个 Key 不该等 5 分钟）；
- `keyedSameModelIds()` **必须连 `free` 一起比** —— 平台把某模型从收费改成免费时
  id 集合一个字都没变，只比 id 就永远刷不出「（免费）」角标；
- 只有集合**真变**时才 `notifyCatalogChanged()` → `broadcastCatalogChanged(ctx)`
  （否则每次 TTL 到期都造成一次事件风暴）；
- `union.length === 0` ⇒ **保留旧目录** + `lastAttemptFailed = true`，
  并进入 `KEYED_MODELS_RETRY_MS = 30_000` 冷却（一次网络抖动不该让 composer
  里的模型全消失，也不该被反复重试）。

⚠️ 事件广播是必须的：客户端 `ModelCatalogDirectory` 在 `status === 'ready'` 时
**短路返回缓存**，只在宿主事件上 refresh。少这一句，服务端内存里目录已是最新，
用户界面却要重启 DSH 才看得到 —— 与「关闭模型不生效」是同一处坑。

### ⚠️ 必须有 in-flight 共享（`ensureRemoteModels`）

并发调用（composer 与设置页同时打开）只发一次请求。
`finally` 里的 `if (this.loading === task)` 是必须的 —— 否则一个迟到的旧任务会把
新任务的 loading 清掉，导致请求堆积。

---

### 选号：账号池手动顺序 + 模型亲和性，**不做任何重排**

`pickCredential()` 的规则（顺序不可颠倒）：

1. 该账号的模型集**含**目标模型 → 命中；
2. 模型集**未知**（还没拉到 / 拉取失败）→ 也算命中（**保守放行**，
   否则目录拉挂时整个 provider 不可用）；
3. 全不命中 → 退回第一个可用账号，让上游报出真实错误
   （比「插件自己编一个错误」对用户有用得多）。

⚠️ **不做任何重排**：账号池的数组顺序**就是**用户拖拽出来的优先级
（主文件铁律「账号顺序 = 选号优先级」）。

换号上限 `KEYED_MAX_ROTATE = 3`，只在 429 / 402 或额度文案命中时触发；
写「限流」时间戳也只认 429 / 402 —— **401 是 Key 无效**，写进限流表会让一个
正确的账号被白白搁置一小时。

### ⚠️ 输出上限必须兜底到 32k

两家平台的 `/models` 都不下发 `maxOutputTokens`。不兜底的话 DSH 注入的
`maxTokens` 会原样透传，而第三方网关对此非常敏感 —— 实测 commandcode 的
`gpt-6-luna` 系列直接回 **400 `Invalid 'max_output_tokens'`**。
`clampKeyedMaxTokens()` 把值收进 `(0, 32_768]`；非法值（`0` / 负数 / `NaN`）
**不发该字段**而不是发 0。

### ⚠️ 不播报图片与思考强度（宁缺毋滥）

- **图片输入**：两家平台的 `/models` 都不含多模态声明 ⇒ 一律播报 `['text']`，
  让 DSH 把图片投影成文本占位符；收到真实图片附件时明确抛
  `UNSUPPORTED_CONTENT`，绝不出现「声明支持却发出去 400」。
- **思考强度**：两家都不接受 `reasoning_effort`，不播报即永不注入。
- `resolveModel` **不声明** `reasoning` / `defaultMaxTokens` / `contextWindow` ——
  目录里没有这些字段，编造会让 DSH 下发上游不认的参数。

---

### 关键文件与符号坐标

| 位置 | 内容 |
| --- | --- |
| `src/keyed-product.ts` | `KeyedProduct` 接口、`COMMANDCODE`、`OPENCODE`、`ALL_KEYED_PRODUCTS`、`keyedProductById`、`keyedModelsUrl`、`keyedChatUrl`、`keyedModelExcluded` |
| `src/keyed.ts` | `KeyedCredential`、`parseKeyedCredential`、`buildKeyedCredential`、`keyedHeaders`、`parseKeyedModelEntries`、`keyedModelIdLooksFree`、`buildKeyedNickname`、`keyedApiKeyLooksMalformed` |
| `src/keyed-auth.ts` | `probeKeyedApiKey`、`loadKeyedModels`、`KeyedAuth.validateApiKey` / `persistApiKey` / `resolveStored` / `refreshAccountCredential` |
| `src/keyed-adapter.ts` | `KeyedAdapter`、`loadKeyedModelsForProduct`、`isKeyedRotatableFailure`、`recordsKeyedRateLimit`、`registerKeyedLlm` |
| `src/rpc/account.ts` | `account.create` 的 `keyedProductById(provider) !== undefined` 分支；`account.refresh` 的 `default:` 分支查 `keyed.get(entry.provider)` |
| `src/rpc/login.ts` | `case 'login.submitKey'` |
| `src/jet-hub-rpc.ts` | `JetHubRpcServices.keyed: ReadonlyMap<string, KeyedAuth>` |
| `plugin-src/client/jet-hub.js` | `KEYED_PROVIDER_IDS`、`PROVIDERS` 末两项、`keyForm` state、`submitKey()`、`createAccount` 的 `loginMode === 'key'` 分流、表单 modal |

⚠️ **`account.refresh` 刻意不给本族写 `case`**：放在 `default:` 里查 `keyed` Map，
这样以后加平台不需要再动那个 switch。历史缺陷正是「逐个 `case` 漏写」
（`buddy-intl` / `workbuddy-cn` / `byok` 都因此让「刷新」按钮坏过）。
Map 查不到时**必须抛 `Unknown provider`**，不能静默成功
（由 `lobsterai-rpc-dispatch.spec.ts` 与 `provider-refresh-dispatch.spec.ts` 双向断言）。

---

### 排查清单

| 现象 | 先查 |
| --- | --- |
| 粘贴任何 Key 都「校验通过」，但对话全 401 | 校验是不是被打到了 `/models`（不鉴权） |
| 正确的 Key 却报「校验失败」 | `probe.invalidIf` 是否把 401 ModelError / 403 误判成 Key 失效 |
| 面板里模型比文档少 | `excludeModels`（协议不兼容）还是目录真的没下发 |
| 文档里有免费模型但列表不显示 | 该 id 是不是走了 `/systemone`（opencode）；后缀是否命中 `[-_:]free$` |
| 「（免费）」角标刷不出来 | `keyedSameModelIds` 是否漏比了 `free` 字段 |
| 模型列表一直空 | 目录门控（没有可解析凭据时 `listModels` 返回 `[]`）；或探测/目录都失败且旧目录为空 |
| 刚粘贴就报「凭据缺失」 | `resolveStored` 是否忘了取 `.value` 包装 |
| 账号卡片「刷新」报 `Unknown provider` | `keyed` Map 里有没有这个 provider（服务端没注册就是空壳） |
| 面板上根本看不到这个 provider | `PROVIDERS` / 能力表 / `llm-<id>` 命名空间三处是否等集（`pnpm lint` 会报） |
