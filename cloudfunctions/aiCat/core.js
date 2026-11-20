/* AI 补分类 · 纯逻辑层（不依赖云环境，可在本地直接测）
 *
 * 只干两件事：
 *   1. 把「未分类」的商户拼成提示词
 *   2. 把模型吐回来的东西校验成可信结果（只认固定类目，其余一律丢掉）
 *
 * 为什么这么严：模型会自由发挥（自创类目、把「转账」写成「转账支出」），
 * 一旦写进库，报表的分类合计就和支出总额对不上。宁可少补，不能补错。
 */

var CHUNK = 20          /* 一次问多少个商户，太多容易漏项、也更容易被限流 */
var MAX_ITEMS = 60      /* 一次点击最多处理多少个商户，防止额度被一把烧光 */

/* 统一成「支出 / 入账 / 不计收支」三个方向里的两个可用集合 */
function normsCats(cats) {
  var out = { expense: [], income: [] }
  ;(cats && cats.expense || []).forEach(function (c) { if (c && c !== '未分类') out.expense.push(c) })
  ;(cats && cats.income || []).forEach(function (c) { if (c && c !== '未分类') out.income.push(c) })
  return out
}

function buildMessages(items, cats, chunkNote) {
  var sys = [
    '你是个人记账的分类助手。',
    '任务：看商户名和商品说明，判断这笔流水该归到哪个记账类目。',
    '必须遵守：',
    '1. 只能从给定的类目清单里原样选一个，不许自创、不许改写、不许翻译。',
    '2. 拿不准就选兜底项：支出选「其他支出」，入账选「其他收入」。',
    '3. 商户名里带「转账」「红包」「还款」「提现」「零钱」这类字眼的，按清单里对应类目判，别硬塞进餐饮购物。',
    '4. 只输出一个 JSON 数组，形如 [{"i":1,"c":"餐饮"}]；不要代码块、不要解释、不要多余文字。',
    '5. 每个输入编号都必须出现在输出里。'
  ].join('\n')

  var lines = items.map(function (it) {
    var parts = ['#' + it.i]
    if (it.m) parts.push('商户：' + it.m)
    if (it.d) parts.push('说明：' + it.d)
    return parts.join(' | ')
  })

  var user = [
    chunkNote ? '（这是第 ' + chunkNote.index + '/' + chunkNote.total + ' 批，编号各自独立）' : '',
    '支出类目：' + cats.expense.join('、'),
    '入账类目：' + cats.income.join('、'),
    '',
    '待分类（全部是支出方向）：',
    lines.join('\n')
  ].filter(Boolean).join('\n')

  return [
    { role: 'system', content: sys },
    { role: 'user', content: user }
  ]
}

/* 模型偶尔会裹 ```json 或前后加话，这里把它剥干净只取数组 */
function pickJsonArray(text) {
  var s = String(text || '').trim()
  s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim()
  var a = s.indexOf('[')
  var b = s.lastIndexOf(']')
  if (a < 0 || b <= a) return null
  try {
    return JSON.parse(s.slice(a, b + 1))
  } catch (e) {
    return null
  }
}

/**
 * 校验模型输出，返回 [{ i, c }]
 * items: [{ i, m, d, t }]   t = 'expense' | 'income'
 * 只要对不上编号、或类目不在该方向的清单里，直接丢掉这一项
 */
function parseReply(text, items, cats) {
  var arr = pickJsonArray(text)
  if (!arr || !arr.length) return { results: [], dropped: items.length, reason: 'no-json' }

  var byI = {}
  items.forEach(function (it) { byI[it.i] = it })

  var out = []
  for (var k = 0; k < arr.length; k++) {
    var row = arr[k]
    if (!row || typeof row !== 'object') continue
    var i = Number(row.i)
    var c = String(row.c == null ? '' : row.c).trim()
    var it = byI[i]
    if (!it) continue
    var allow = it.t === 'income' ? cats.income : cats.expense
    if (allow.indexOf(c) < 0) continue
    if (out.some(function (x) { return x.i === i })) continue
    out.push({ i: i, c: c })
  }

  /* 模型偷懒只答一半的，也算丢掉：丢多少 = 总数 - 有效数 */
  return { results: out, dropped: items.length - out.length }
}

/* 按商户去重，挑出还能补的（词库没命中、且商户名够长）
 * 商户名是空的就没法沉淀规则，直接跳过，留给人工 */
function collectItems(txs) {
  var map = {}
  var noMerchant = 0
  for (var i = 0; i < txs.length; i++) {
    var t = txs[i]
    if (t.type !== 'expense') continue
    if (t.category !== '未分类') continue
    var key = String(t.merchant || '').trim()
    if (key.length < 2) { noMerchant++; continue }
    if (!map[key]) map[key] = { key: key, count: 0, amount: 0, desc: '' }
    map[key].count++
    map[key].amount += Number(t.amount || 0)
    if (!map[key].desc && t.desc) map[key].desc = String(t.desc).slice(0, 24)
  }

  var keys = Object.keys(map).sort(function (a, b) { return map[b].count - map[a].count })
  var items = keys.slice(0, MAX_ITEMS).map(function (k, idx) {
    return { i: idx + 1, m: map[k].key, d: map[k].desc, t: 'expense', key: map[k].key }
  })

  return {
    items: items,
    total: keys.length,
    overflow: keys.length > items.length,
    noMerchant: noMerchant
  }
}

function chunks(items, size) {
  var out = []
  var n = size || CHUNK
  for (var i = 0; i < items.length; i += n) out.push(items.slice(i, i + n))
  return out
}

module.exports = {
  CHUNK: CHUNK,
  MAX_ITEMS: MAX_ITEMS,
  normsCats: normsCats,
  buildMessages: buildMessages,
  pickJsonArray: pickJsonArray,
  parseReply: parseReply,
  collectItems: collectItems,
  chunks: chunks
}
