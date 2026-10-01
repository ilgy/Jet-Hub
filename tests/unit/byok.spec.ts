import { describe, expect, it } from 'vitest'
import {
  buildByokCredential,
  buildByokNickname,
  byokApiKeyLooksMalformed,
  byokHeaders,
  isByokExpired,
  parseByokCredential,
  parseByokFreeModelIds,
  parseByokModelList,
} from '../../src/byok.js'
import {
  BYOK,
  BYOK_PLATFORMS,
  byokBaseUrlLooksValid,
  byokChatUrl,
  byokFreeModelsForPlatform,
  byokModelsUrl,
  byokPlatformById,
  byokResolveBaseUrl,
} from '../../src/byok-product.js'

/**
 * BYOK 的**纯函数**层（`src/byok.ts` + `src/byok-product.ts`）。
 *
 * ⚠️ 这一层全是纯函数、零 IO，故断言可以钉死到字符串级别 —— 而它们正是
 * 「凭据能否被解析」「Key 打到哪个地址」这两类**静默故障**的唯一判据：
 * 判错了不会抛错，只会表现为「账号在、模型全空」或「请求打到不存在的 host」。
 */

describe('BYOK 平台表', () => {
  it('每个平台的 base url 都不带尾斜杠、且以 http(s) 开头（拼接契约）', () => {
    for (const platform of BYOK_PLATFORMS) {
      // `custom` 是唯一允许空 baseUrl 的项（由用户手填）。
      if (platform.id === 'custom') {
        expect(platform.baseUrl, platform.id).toBe('')
        continue
      }
      expect(platform.baseUrl, platform.id).toMatch(/^https?:\/\//)
      expect(platform.baseUrl.endsWith('/'), `${platform.id} 的 baseUrl 带了尾斜杠`).toBe(false)
    }
  })

  it('平台 id 唯一（落进凭据 JSON，重复会导致选错端点）', () => {
    const ids = BYOK_PLATFORMS.map(platform => platform.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('预设平台都提供了控制台地址（面板要引导用户去建 Key）', () => {
    for (const platform of BYOK_PLATFORMS) {
      if (platform.id === 'custom') continue
      // ollama 是本地服务，「控制台」是下载页，同样非空。
      expect(platform.consoleUrl.length, platform.id).toBeGreaterThan(0)
    }
  })

  it('BYOK provider 常量：面板 id 为 byok，兜底 ref 独立', () => {
    expect(BYOK.id).toBe('byok')
    expect(BYOK.defaultCredentialRef).toBe('BYOK_ACCESS_TOKEN')
    // ⚠️ 兜底 ref 不得与任何账号 ref 前缀混淆（账号一律 `<PREFIX>_ACCOUNT_<SUFFIX>`）。
    expect(BYOK.defaultCredentialRef).not.toContain('_ACCOUNT_')
  })

  it('byokPlatformById 未命中返回 undefined 而不是抛错', () => {
    expect(byokPlatformById('zhipu')?.label).toBe('智谱 GLM（开放平台）')
    expect(byokPlatformById('nope-not-a-platform')).toBeUndefined()
  })

  it('freeModels 只出现在有 baseUrl 的平台，且 id 无空白、无重复', () => {
    for (const platform of BYOK_PLATFORMS) {
      if (platform.freeModels === undefined) continue
      expect(platform.id === 'custom', `${platform.id} 不能配 freeModels`).toBe(false)
      expect(platform.freeModels.length, platform.id).toBeGreaterThan(0)
      expect(new Set(platform.freeModels).size, platform.id).toBe(platform.freeModels.length)
      for (const id of platform.freeModels) {
        expect(id, platform.id).toBe(id.trim())
        expect(id.length, platform.id).toBeGreaterThan(0)
      }
    }
  })

  it('⚠️ 智谱的免费模型必须配在表里：/models 只列计费模型，不配就只剩收费模型', () => {
    // 实测依据：余额为 0 的账号打下面这 8 个都是 200（max_tokens:1），
    // 而 /models 里的 glm-4.5 ~ glm-5.3 全部 429（code 1113）。
    const free = byokFreeModelsForPlatform('zhipu')
    for (const id of [
      'glm-4-flash',
      'glm-4-flash-250414',
      'glm-4.5-flash',
      'glm-z1-flash',
      'glm-4v-flash',
      'glm-4.1v-thinking-flash',
      'glm-4.6v-flash',
      'glm-4.7-flash',
    ]) {
      expect(free, id).toContain(id)
    }
  })

  it('⚠️ 智谱的计费同族型号不得混进 freeModels（列错会让请求直接 4xx）', () => {
    // 实测：-flashx / -airx 是计费型号（429/1113），glm-5.x-flash 系列
    // 是 400/1211「模型不存在」。
    const free = byokFreeModelsForPlatform('zhipu')
    for (const id of ['glm-4-flashx', 'glm-4.5-flashx', 'glm-z1-flashx', 'glm-4.5-airx', 'glm-4-airx', 'glm-5-flash', 'glm-5.3-flash', 'glm-4.6-flash']) {
      expect(free, id).not.toContain(id)
    }
  })

  it('byokFreeModelsForPlatform：未命中平台 / 没配的平台返回空数组而不是 undefined', () => {
    expect(byokFreeModelsForPlatform('nope-not-a-platform')).toEqual([])
    expect(byokFreeModelsForPlatform('openrouter')).toEqual([])
  })

  it('byokResolveBaseUrl：预设平台用表里的地址（忽略前端传值）', () => {
    // ⚠️ 这是安全边界：`login.submitKey` 只对 `custom` 采信前端传的 baseUrl。
    // 若这里被改成「前端传值优先」，前端就能拿 `zhipu` 的展示名配任意地址。
    expect(byokResolveBaseUrl('zhipu', 'https://attacker.example/v1'))
      .toBe('https://open.bigmodel.cn/api/paas/v4')
  })

  it('byokResolveBaseUrl：custom 平台用调用方传值，并去掉尾部斜杠', () => {
    expect(byokResolveBaseUrl('custom', '  https://my-host.example/v1///  '))
      .toBe('https://my-host.example/v1')
  })

  it('byokResolveBaseUrl：custom 缺地址 / 空串一律 undefined', () => {
    expect(byokResolveBaseUrl('custom')).toBeUndefined()
    expect(byokResolveBaseUrl('custom', '   ')).toBeUndefined()
    expect(byokResolveBaseUrl('custom', '///')).toBeUndefined()
  })

  it('byokResolveBaseUrl：未知平台且无手填地址时 undefined', () => {
    expect(byokResolveBaseUrl('no-such-platform')).toBeUndefined()
  })

  it('地址拼接：/models 与 /chat/completions 都由 base 派生', () => {
    expect(byokModelsUrl('https://api.example/v1')).toBe('https://api.example/v1/models')
    expect(byokChatUrl('https://api.example/v1')).toBe('https://api.example/v1/chat/completions')
  })

  it('byokBaseUrlLooksValid 只拦「没写协议头」，不拦 http（本地 Ollama 必须允许）', () => {
    expect(byokBaseUrlLooksValid('https://api.example/v1')).toBe(true)
    expect(byokBaseUrlLooksValid('http://127.0.0.1:11434/v1')).toBe(true)
    expect(byokBaseUrlLooksValid('api.example/v1')).toBe(false)
    expect(byokBaseUrlLooksValid('ftp://api.example/v1')).toBe(false)
    expect(byokBaseUrlLooksValid('https://api example/v1')).toBe(false)
  })
})

describe('BYOK 模型目录解析', () => {
  it('解析 OpenAI 标准信封 {object,data:[{id}]}（智谱 / Chutes / NVIDIA）', () => {
    expect(parseByokModelList({
      object: 'list',
      data: [{ id: 'glm-4.6' }, { id: 'glm-4.5' }],
    })).toEqual(['glm-4.6', 'glm-4.5'])
  })

  it('解析 {data:[{id}]} 与 {models:[{id}]} 两种变体', () => {
    expect(parseByokModelList({ data: [{ id: 'a' }] })).toEqual(['a'])
    expect(parseByokModelList({ models: [{ id: 'b' }] })).toEqual(['b'])
  })

  it('裸数组也接（自建网关常见形态）', () => {
    expect(parseByokModelList([{ id: 'a' }, { id: 'b' }])).toEqual(['a', 'b'])
  })

  it('⚠️ 元素是裸字符串同样要接（本地 Ollama 的极简实现）', () => {
    // 只认对象会让这类端点「列表为空」→ 被 `validateApiKey` 误判成 Key 无效。
    expect(parseByokModelList({ models: ['llama3:8b', 'qwen2.5:7b'] }))
      .toEqual(['llama3:8b', 'qwen2.5:7b'])
  })

  it('元素缺 id 时回落到 name / model 字段', () => {
    expect(parseByokModelList({ data: [{ name: 'by-name' }, { model: 'by-model' }] }))
      .toEqual(['by-name', 'by-model'])
  })

  it('去重且保序', () => {
    expect(parseByokModelList({ data: [{ id: 'a' }, { id: 'a' }, { id: 'b' }] }))
      .toEqual(['a', 'b'])
  })

  it('垃圾元素被跳过，不影响其余条目', () => {
    expect(parseByokModelList({ data: [{ id: 'ok' }, {}, { id: '' }, null, 42, { id: '  spaced  ' }] }))
      .toEqual(['ok', 'spaced'])
  })

  it('非对象 / 无列表字段一律回空数组（不抛错）', () => {
    expect(parseByokModelList(null)).toEqual([])
    expect(parseByokModelList('nope')).toEqual([])
    expect(parseByokModelList({ object: 'list' })).toEqual([])
  })
})

describe('BYOK 免费模型判定', () => {
  it('OpenRouter 的 pricing.prompt/completion 全为 "0" 判为免费', () => {
    expect([...parseByokFreeModelIds({
      data: [
        { id: 'apodex/apodex-1.1-mini:free', pricing: { prompt: '0', completion: '0' } },
        { id: 'unbiased/pareto', pricing: { prompt: '0.0000008', completion: '0.0000032' } },
      ],
    })]).toEqual(['apodex/apodex-1.1-mini:free'])
  })

  it('⚠️ pricing 里的哨兵值 -1（image 不适用）不得被当成免费', () => {
    // 只看 prompt/completion；若改成「整个 pricing 对象全是 0」会在这里误判。
    expect([...parseByokFreeModelIds({
      data: [{ id: 'paid', pricing: { prompt: '0.000001', completion: '0.000002', image: '-1' } }],
    })]).toEqual([])
    expect([...parseByokFreeModelIds({
      data: [{ id: 'odd', pricing: { prompt: '-1', completion: '-1' } }],
    })]).toEqual([])
  })

  it('Novita 的 input/output_token_price_per_m 双 0 判为免费', () => {
    expect([...parseByokFreeModelIds({
      data: [
        { id: 'bunny', input_token_price_per_m: 0, output_token_price_per_m: 0 },
        { id: 'paid', input_token_price_per_m: 1500, output_token_price_per_m: 5000 },
      ],
    })]).toEqual(['bunny'])
  })

  it('⚠️ Novita 的 pricing 是嵌套对象，Number({}) 为 NaN ⇒ 不误判', () => {
    expect([...parseByokFreeModelIds({
      data: [{
        id: 'zai-org/glm-5.3-flash',
        input_token_price_per_m: 1500,
        output_token_price_per_m: 5000,
        pricing: { prompt: { price_per_m: 1500 }, completion: { price_per_m: 5000 } },
      }],
    })]).toEqual([])
  })

  it('只给一个价格字段（或字段缺失）时**不判免费** —— 缺失是未知，不是 0', () => {
    expect([...parseByokFreeModelIds({
      data: [
        { id: 'only-input', input_token_price_per_m: 0 },
        { id: 'only-output', output_token_price_per_m: 0 },
        { id: 'none' },
      ],
    })]).toEqual([])
  })

  it('显式 is_free / free 为 true 才认（false 与缺省都不认）', () => {
    expect([...parseByokFreeModelIds({
      data: [{ id: 'a', is_free: true }, { id: 'b', free: true }, { id: 'c', is_free: false }, { id: 'd', free: 'true' }],
    })]).toEqual(['a', 'b'])
  })

  it('⚠️ 智谱式目录（只有 id/object/created/owned_by）一个都不标', () => {
    // 这正是用户看到「全是收费的」的数据根因：接口根本不下发价格。
    expect([...parseByokFreeModelIds({
      object: 'list',
      data: [
        { id: 'glm-4.5', object: 'model', created: 1753632000, owned_by: 'z-ai' },
        { id: 'glm-5.3', object: 'model', created: 1753632000, owned_by: 'z-ai' },
      ],
    })]).toEqual([])
  })

  it('裸字符串条目没有价格信息 ⇒ 不标；非对象入参回空集合（不抛错）', () => {
    expect([...parseByokFreeModelIds({ models: ['llama3:8b'] })]).toEqual([])
    expect([...parseByokFreeModelIds(null)]).toEqual([])
    expect([...parseByokFreeModelIds('nope')]).toEqual([])
  })
})

describe('BYOK 凭据解析', () => {
  const valid = JSON.stringify({
    access_token: 'sk-test-key',
    platform: 'zhipu',
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
  })

  it('往返：build → parse 保持字段', () => {
    const built = buildByokCredential({
      apiKey: '  sk-abc  ',
      platform: 'zhipu',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4/',
      models: ['glm-4.6'],
      nickname: '智谱 GLM（开放平台） · c-abc',
    })
    expect(built.access_token).toBe('sk-abc')
    // ⚠️ 尾部斜杠必须被规整掉（拼接契约）。
    expect(built.base_url).toBe('https://open.bigmodel.cn/api/paas/v4')
    expect(parseByokCredential(JSON.stringify(built))).toEqual(built)
  })

  it('⚠️ 判据必须包含 base_url —— 缺它返回 undefined', () => {
    // 只校验 access_token 会让「平台未知」的半成品通过，随后请求打到
    // `undefined/models`，报出的错与真实原因完全无关。
    expect(parseByokCredential(JSON.stringify({ access_token: 'sk-x' }))).toBeUndefined()
    expect(parseByokCredential(JSON.stringify({ base_url: 'https://a/v1' }))).toBeUndefined()
  })

  it('垃圾输入返回 undefined 而不抛错（与 parseClineCredential 同约定）', () => {
    expect(parseByokCredential(undefined)).toBeUndefined()
    expect(parseByokCredential('')).toBeUndefined()
    expect(parseByokCredential('   ')).toBeUndefined()
    expect(parseByokCredential('not json at all')).toBeUndefined()
    expect(parseByokCredential('null')).toBeUndefined()
    expect(parseByokCredential('[1,2,3]')).toBeUndefined()
    expect(parseByokCredential('"a string"')).toBeUndefined()
  })

  it('字段别名：api_key / accessToken、baseUrl 都认', () => {
    expect(parseByokCredential(JSON.stringify({
      api_key: 'sk-1', baseUrl: 'https://a.example/v1',
    }))).toMatchObject({ access_token: 'sk-1', base_url: 'https://a.example/v1' })
    expect(parseByokCredential(JSON.stringify({
      accessToken: 'sk-2', base_url: 'https://b.example/v1',
    }))).toMatchObject({ access_token: 'sk-2', base_url: 'https://b.example/v1' })
  })

  it('缺 platform 时回落到 custom（而不是留 undefined）', () => {
    expect(parseByokCredential(JSON.stringify({
      access_token: 'sk-x', base_url: 'https://a.example/v1',
    }))?.platform).toBe('custom')
  })

  it('⚠️ 空 models 数组不写进凭据（避免留下无意义的空字段）', () => {
    expect(parseByokCredential(JSON.stringify({
      access_token: 'sk-x', base_url: 'https://a/v1', models: [],
    }))).not.toHaveProperty('models')
    expect(parseByokCredential(JSON.stringify({
      access_token: 'sk-x', base_url: 'https://a/v1', models: ['  ', 'm1', ''],
    }))?.models).toEqual(['m1'])
  })

  it('expire_time 只在为正有限数时才认（0 / 负数 / NaN 一律丢弃）', () => {
    const mk = (value: unknown) => parseByokCredential(JSON.stringify({
      access_token: 'sk-x', base_url: 'https://a/v1', expire_time: value,
    }))
    expect(mk(1893456000000)?.expire_time).toBe(1893456000000)
    expect(mk(0)?.expire_time).toBeUndefined()
    expect(mk(-1)?.expire_time).toBeUndefined()
    expect(mk('2030-01-01')?.expire_time).toBeUndefined()
  })

  it('落盘的凭据能通过完整往返（真实链路形态）', () => {
    const parsed = parseByokCredential(valid)
    expect(parsed).toEqual({
      access_token: 'sk-test-key',
      platform: 'zhipu',
      base_url: 'https://open.bigmodel.cn/api/paas/v4',
    })
  })
})

describe('BYOK 请求头与过期判定', () => {
  it('只发 Authorization + Accept，不叠加任何 X-* 客户端标识头', () => {
    // ⚠️ 那些 `X-*` 是各厂商私有的（CodeBuddy 的 X-Product-Code、TRAE 的 X-IDE-*），
    // 发给第三方平台只会被忽略，或更糟：被当成协议不匹配拒掉。
    const headers = byokHeaders({
      access_token: 'sk-x', platform: 'custom', base_url: 'https://a.example/v1',
    })
    expect(headers).toEqual({
      Authorization: 'Bearer sk-x',
      Accept: 'application/json',
    })
    expect(Object.keys(headers).some(key => key.toLowerCase().startsWith('x-'))).toBe(false)
  })

  it('⚠️ isByokExpired 恒为 false（Key 不过期，判过期会让刚粘贴的凭据立刻失效）', () => {
    const credential = buildByokCredential({
      apiKey: 'sk-x', platform: 'zhipu', baseUrl: 'https://a.example/v1',
    })
    expect(isByokExpired(credential)).toBe(false)
    // 极远的「当前时间」也不判过期。
    expect(isByokExpired(credential, Date.now() + 100 * 365 * 24 * 3600 * 1000)).toBe(false)
  })

  it('显式写了 expire_time 时才按它判定', () => {
    const credential = {
      access_token: 'sk-x', platform: 'custom', base_url: 'https://a.example/v1',
      expire_time: 1_000_000,
    }
    expect(isByokExpired(credential, 999_999)).toBe(false)
    expect(isByokExpired(credential, 1_000_000)).toBe(true)
    expect(isByokExpired(credential, 1_000_001)).toBe(true)
  })
})

describe('BYOK 昵称与 Key 形态预检', () => {
  it('昵称 = 平台名 · Key 尾 4 位（同平台多 Key 必须能区分）', () => {
    expect(buildByokNickname('智谱 GLM（开放平台）', 'abcd1234', 'byok-1'))
      .toBe('智谱 GLM（开放平台） · 1234')
  })

  it('⚠️ 昵称绝不放 Key 前段（账号卡片与日志都会展示它）', () => {
    const apiKey = 'sk-secret-prefix-must-not-leak-9876'
    const nickname = buildByokNickname('Groq', apiKey, 'byok-1')
    expect(nickname).toBe('Groq · 9876')
    expect(nickname).not.toContain('secret')
    expect(nickname).not.toContain('sk-')
  })

  it('空 Key 时昵称退回平台名；平台名也空则退回账号 id', () => {
    expect(buildByokNickname('Groq', '   ', 'byok-1')).toBe('Groq')
    expect(buildByokNickname('', '   ', 'byok-1')).toBe('byok-1')
  })

  it('形态预检：空串 / 换行 / 首尾引号 / 含空格都被拦下', () => {
    expect(byokApiKeyLooksMalformed('')).toBe('API Key 不能为空')
    expect(byokApiKeyLooksMalformed('   ')).toBe('API Key 不能为空')
    expect(byokApiKeyLooksMalformed('sk-a\nsk-b')).toContain('换行')
    expect(byokApiKeyLooksMalformed('sk-a\r\n')).toContain('换行')
    expect(byokApiKeyLooksMalformed('"sk-abc"')).toContain('引号')
    expect(byokApiKeyLooksMalformed("'sk-abc'")).toContain('引号')
    expect(byokApiKeyLooksMalformed('export KEY=sk-abc')).toContain('空格')
  })

  it('⚠️ 不做长度 / 前缀白名单（各平台 Key 形态千差万别）', () => {
    for (const key of [
      'sk-proj-abcdef',
      'fa4204c5e7504cfc8d23fa3564cc471c.8GKLYlK3mjpBQ9WD',
      '0123456789abcdef',
      'cpk_abcdefg',
      'ollama',            // 本地服务任意非空串
      'x',                 // 再短也合法
    ]) {
      expect(byokApiKeyLooksMalformed(key), key).toBeUndefined()
    }
  })
})
