// 云函数：AI 补分类（给词库没命中的「未分类」兜底）
//
// 只做一件事：拿一批商户名 → 问模型 → 返回校验过的类目。
// 不碰流水本身：改不改、改哪条，全由小程序端在用户确认后自己写本地存储。
//
// ── Key 怎么配 ──
// 云开发控制台 → 云函数 aiCat → 配置 → 环境变量 → ZHIPU_API_KEY
// 真实 Key 不写进代码或仓库。
// 申请地址：https://bigmodel.cn/apikey/platform
//
// ── 模型：只用 glm-4.7-flash ──
// 智谱官方把它列为「免费模型」，不消耗账户余额、也不依赖任何「新用户赠送资源包」，
// 那些赠送包都是限时的，用完了就得续费——所以这里不做降级到收费模型的兜底，
// 免得哪天悄悄开始扣钱。想换模型：环境变量 AI_MODEL 覆盖（自己确认过它是不是免费再说）。
//
// 实测两个坑，都在这儿处理掉了：
//   1) 它是混合思考模型，不关思考会把 max_tokens 全花在 reasoning_content 上，
//      content 返回空字符串、finish_reason=length，看起来像「超时」。
//   2) 免费档很挤，偶发 429 / 1305，需要退避重试。
const cloud = require('wx-server-sdk')
const https = require('https')
const core = require('./core')

const ZHIPU_KEY = process.env.ZHIPU_API_KEY || ''
/* 默认就是永久免费那个；改成别的模型有可能开始计费，改之前自己确认 */
const MODEL = (process.env.AI_MODEL || 'glm-4.7-flash').trim()

const TIMEOUT = 25000
const MAX_TRY = 3

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

function chat(messages, timeoutMs) {
  return new Promise(function (resolve) {
    var body = JSON.stringify({
      model: MODEL,
      messages: messages,
      /* 关键：关掉思考。开着会把输出预算烧在推理上，正文为空 */
      thinking: { type: 'disabled' },
      temperature: 0.1,
      max_tokens: 1200
    })
    var t0 = Date.now()
    var req = https.request({
      hostname: 'open.bigmodel.cn',
      path: '/api/paas/v4/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + ZHIPU_KEY,
        'Content-Length': Buffer.byteLength(body)
      }
    }, function (res) {
      var data = ''
      res.setEncoding('utf8')
      res.on('data', function (c) { data += c })
      res.on('end', function () {
        var json = null
        try {
          json = JSON.parse(data)
        } catch (e) {
          json = { error: { message: '返回不是 JSON：' + data.slice(0, 80) } }
        }
        resolve({ status: res.statusCode, json: json, ms: Date.now() - t0 })
      })
    })
    req.on('error', function (e) {
      resolve({ status: -1, json: { error: { message: e.message } }, ms: Date.now() - t0 })
    })
    req.setTimeout(timeoutMs || TIMEOUT, function () {
      req.destroy(new Error('请求超时'))
    })
    req.write(body)
    req.end()
  })
}

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms) })
}

/* 429 / 1305 这类是「挤」，缓一下再来；其余错误不值得重试，但重试也不花钱，一并重试 */
function retriable(r) {
  if (r.status === 429) return true
  if (r.status === -1) return true
  var code = String((r.json && r.json.error && r.json.error.code) || '')
  return code === '1305' || code === '1302' || code === '1301'
}

async function askChunk(items, cats, index, total) {
  var messages = core.buildMessages(items, cats, { index: index, total: total })
  var lastErr = ''

  for (var attempt = 1; attempt <= MAX_TRY; attempt++) {
    var r = await chat(messages, TIMEOUT)
    var ch = r.json && r.json.choices && r.json.choices[0]
    var content = ch && ch.message && ch.message.content

    if (r.status === 200 && content) {
      var parsed = core.parseReply(content, items, cats)
      if (parsed.results.length) {
        return { results: parsed.results, dropped: parsed.dropped, ms: r.ms, tries: attempt }
      }
      /* 正文空 / 被截断：多半还是思考没关干净，重试一次 */
      lastErr = '返回无法解析（finish=' + (ch && ch.finish_reason) + '）'
      console.log('[aiCat] ' + lastErr)
    } else {
      var msg = (r.json && r.json.error && r.json.error.message) || ('HTTP ' + r.status)
      lastErr = 'HTTP ' + r.status + '：' + msg
      console.log('[aiCat] ' + lastErr)
      if (!retriable(r) && r.status !== -1) {
        /* 鉴权错、Key 失效这类，重试没意义，直接告诉调用方 */
        if (r.status === 401 || r.status === 403) {
          return { results: [], error: 'Key 无效或没权限：' + msg }
        }
      }
    }

    if (attempt < MAX_TRY) await sleep(1200 * attempt)
  }

  return { results: [], dropped: items.length, error: lastErr || '模型没给出可用结果' }
}

exports.main = async function (event) {
  if (!ZHIPU_KEY) {
    return { ok: false, error: '云函数没配 ZHIPU_API_KEY，去云开发控制台加环境变量' }
  }

  var items = Array.isArray(event && event.items) ? event.items : []
  if (!items.length) return { ok: false, error: '没有要分类的商户' }
  if (items.length > core.MAX_ITEMS) items = items.slice(0, core.MAX_ITEMS)

  var cats = core.normsCats(event.cats)
  if (!cats.expense.length) return { ok: false, error: '缺少类目清单' }

  var parts = core.chunks(items, core.CHUNK)
  var all = []
  var failed = 0
  var errors = []

  for (var i = 0; i < parts.length; i++) {
    var one = await askChunk(parts[i], cats, i + 1, parts.length)
    if (one.results.length) all = all.concat(one.results)
    else {
      failed++
      if (one.error) errors.push(one.error)
    }
  }

  if (!all.length) {
    return { ok: false, error: errors[0] || '模型没给出可用结果', model: MODEL }
  }

  return {
    ok: true,
    model: MODEL,
    results: all,
    chunks: parts.length,
    failedChunks: failed,
    dropped: items.length - all.length
  }
}
