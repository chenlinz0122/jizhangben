/* 账户汇率审计历史。
 *
 * exchange_rates_v1: { accountId: [{ id, currency, rate, previousRate, createdAt }] }
 * rate / previousRate 均表示「1 外币 = 多少人民币」；首次记录 previousRate 为 null。
 * 历史只用于展示，不参与余额换算，也不会改写流水中的汇率快照。
 */
var KEY = 'exchange_rates_v1'
var MAX_PER_ACCOUNT = 100
var currency = require('./currency')
var _lastError = ''
var _idCounter = 0

function hasStorage() {
  return typeof wx !== 'undefined' && wx && typeof wx.getStorageSync === 'function'
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function absent(value) {
  return value === '' || value === undefined || value === null
}

function accountId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  var id = String(value).trim()
  return id && id.length <= 100 ? id : ''
}

function fail(message) {
  _lastError = message || '汇率历史操作失败'
  return null
}

function readRaw() {
  if (!hasStorage()) throw new Error('当前环境无法读取汇率历史')
  try {
    return wx.getStorageSync(KEY)
  } catch (e) {
    throw new Error('汇率历史读取失败，请稍后重试')
  }
}

function normalizeRecord(raw, id, index, strict) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('汇率记录格式不对')
  var code = currency.normalizeStrictCode(raw.currency)
  if (!code) throw new Error('汇率记录币种不支持')
  if (code === 'CNY') return null
  var rate = currency.normalizeRate(raw.rate, code)
  if (rate === null) throw new Error('外币汇率必须是大于 0 的有效数字')

  var rawTime = raw.createdAt === undefined ? raw.time : raw.createdAt
  var createdAt = Number(rawTime)
  if (!isFinite(createdAt) || createdAt <= 0) throw new Error('汇率记录时间无效')

  var recordId = raw.id === undefined || raw.id === null ? '' : String(raw.id).trim()
  if (!recordId && !strict) recordId = 'legacy_' + index + '_' + createdAt
  if (!recordId || recordId.length > 100) throw new Error('汇率记录 ID 无效')

  var previousRate = null
  if (!absent(raw.previousRate)) {
    previousRate = currency.normalizeRate(raw.previousRate, code)
    if (previousRate === null) throw new Error('原汇率必须是大于 0 的有效数字')
  }
  return { id: recordId, currency: code, rate: rate, previousRate: previousRate, createdAt: createdAt }
}

function sortRows(rows) {
  rows.sort(function (a, b) {
    /* 同一毫秒保持写入顺序，最新记录仍排在前面。 */
    return b.createdAt - a.createdAt
  })
  return rows.slice(0, MAX_PER_ACCOUNT)
}

function normalizeData(raw) {
  if (absent(raw)) return Object.create(null)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('汇率历史数据应为账户对象')
  var out = Object.create(null)
  Object.keys(raw).forEach(function (id) {
    if (!accountId(id) || !Array.isArray(raw[id])) throw new Error('汇率历史数据格式损坏，请先备份核对')
    var seen = Object.create(null)
    var rows = []
    raw[id].forEach(function (rawRecord, index) {
      var item = normalizeRecord(rawRecord, id, index, false)
      if (!item) return
      if (seen[item.id]) throw new Error('汇率历史包含重复记录 ID')
      seen[item.id] = true
      rows.push(item)
    })
    if (rows.length) out[id] = sortRows(rows)
  })
  return out
}

function readAll() {
  _lastError = ''
  return normalizeData(readRaw())
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/* 单 key 写入后回读校验；失败恢复原值，避免静默丢失审计记录。 */
function writeAll(data) {
  var before
  var beforePresent = false
  try {
    before = readRaw()
    beforePresent = !absent(before)
  } catch (e) {
    _lastError = e.message
    return false
  }
  var value = clone(data)
  if ((beforePresent && same(before, value)) || (!beforePresent && !Object.keys(value).length)) {
    _lastError = ''
    return true
  }
  try {
    wx.setStorageSync(KEY, value)
    if (!same(readRaw(), value)) throw new Error('storage verification failed')
    _lastError = ''
    return true
  } catch (e) {
    var restored = false
    try {
      if (beforePresent) wx.setStorageSync(KEY, before)
      else wx.removeStorageSync(KEY)
      restored = beforePresent ? same(readRaw(), before) : absent(readRaw())
    } catch (rollbackError) {}
    _lastError = restored ? '汇率历史保存失败，本次修改已撤销' : '汇率历史保存中断且回滚失败，请立即核对本地数据'
    return false
  }
}

function newId(rows) {
  var seen = Object.create(null)
  rows.forEach(function (item) { seen[item.id] = true })
  var id
  do {
    _idCounter++
    id = 'xr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8) + '_' + _idCounter.toString(36)
  } while (seen[id])
  return id
}

function list(id) {
  id = accountId(id)
  if (!id) return []
  var data = readAll()
  return own(data, id) ? clone(data[id]) : []
}

/* CNY 或与前一次相同的外币汇率不记录；返回 null 且 error() 为空表示无需记录。 */
function record(id, code, rate, previousRate, time) {
  _lastError = ''
  id = accountId(id)
  if (!id) return fail('汇率历史缺少有效账户 ID')
  code = currency.normalizeStrictCode(code)
  if (!code) return fail('账户币种不支持')
  if (code === 'CNY') return null
  rate = currency.normalizeRate(rate, code)
  if (rate === null) return fail('外币汇率必须是大于 0 的有效数字')
  if (time === undefined || time === null) time = Date.now()
  time = Number(time)
  if (!isFinite(time) || time <= 0) return fail('汇率记录时间无效')

  var data
  try { data = readAll() } catch (e) { return fail(e.message) }
  var rows = own(data, id) ? data[id] : []
  if (previousRate === undefined) {
    previousRate = rows.length && rows[0].currency === code ? rows[0].rate : null
  } else if (!absent(previousRate)) {
    previousRate = currency.normalizeRate(previousRate, code)
    if (previousRate === null) return fail('原汇率必须是大于 0 的有效数字')
  } else {
    previousRate = null
  }
  var latest = rows[0]
  if (previousRate === rate && (!latest || latest.currency === code)) return null

  var item = { id: newId(rows), currency: code, rate: rate, previousRate: previousRate, createdAt: time }
  data[id] = sortRows([item].concat(rows))
  return writeAll(data) ? item : null
}

function removeAccount(id) {
  _lastError = ''
  id = accountId(id)
  if (!id) return false
  var data
  try { data = readAll() } catch (e) { _lastError = e.message; return false }
  if (!own(data, id)) return false
  delete data[id]
  return writeAll(data)
}

/* 供账户删除事务保存/恢复精确快照；正常读取不需要调用。 */
function capture(id) {
  id = accountId(id)
  if (!id) throw new Error('汇率历史缺少有效账户 ID')
  var data = readAll()
  return { present: own(data, id), records: own(data, id) ? clone(data[id]) : [] }
}

function restore(id, snapshot) {
  _lastError = ''
  id = accountId(id)
  if (!id || !snapshot || typeof snapshot.present !== 'boolean' || !Array.isArray(snapshot.records)) {
    _lastError = '汇率历史回滚快照无效'
    return false
  }
  var data
  try { data = readAll() } catch (e) { _lastError = e.message; return false }
  if (snapshot.present) data[id] = sortRows(normalizeData((function () {
    var value = Object.create(null)
    value[id] = snapshot.records
    return value
  })())[id])
  else delete data[id]
  return writeAll(data)
}

function exportData() {
  return {
    app: '通用记账Book',
    kind: 'exchange_rates',
    version: 1,
    storageKey: KEY,
    exportedAt: Date.now(),
    exchangeRates: clone(readAll())
  }
}

function parsePayload(payload) {
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload) } catch (e) { throw new Error('汇率历史备份不是有效 JSON') }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('汇率历史备份格式不对')
  var data = payload
  if (own(payload, 'exchangeRates') || own(payload, 'rates')) {
    if (payload.version !== undefined && payload.version !== 1) throw new Error('汇率历史备份版本不支持')
    data = own(payload, 'exchangeRates') ? payload.exchangeRates : payload.rates
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('汇率历史备份格式不对')
  /* 导入记录必须有稳定 ID；存储读取才兼容旧记录缺失 ID。 */
  var out = Object.create(null)
  Object.keys(data).forEach(function (id) {
    if (!accountId(id) || !Array.isArray(data[id])) throw new Error('汇率历史备份格式不对')
    var seen = Object.create(null)
    out[id] = []
    data[id].forEach(function (raw) {
      var item = normalizeRecord(raw, id, 0, true)
      if (!item) return
      if (seen[item.id]) throw new Error('汇率历史备份包含重复记录 ID')
      seen[item.id] = true
      out[id].push(item)
    })
    out[id] = sortRows(out[id])
  })
  return out
}

/* 纯合并计划：同账户同 ID 以备份为准，不写存储；真正提交由账本备份主线程负责。 */
function planImport(payload, options) {
  options = options || {}
  var mode = options.mode === undefined ? 'merge' : options.mode
  if (mode !== 'merge' && mode !== 'replace') throw new Error('汇率历史导入模式无效')
  var incoming = parsePayload(payload)
  var current = readAll()
  var merged = mode === 'merge' ? clone(current) : Object.create(null)
  var added = 0
  var updated = 0
  var unchanged = 0

  Object.keys(incoming).forEach(function (id) {
    var rows = own(merged, id) ? merged[id] : []
    incoming[id].forEach(function (item) {
      var index = -1
      for (var i = 0; i < rows.length; i++) if (rows[i].id === item.id) { index = i; break }
      if (index < 0) { rows.push(item); added++ }
      else if (same(rows[index], item)) unchanged++
      else { rows[index] = item; updated++ }
    })
    if (rows.length) merged[id] = sortRows(rows)
    else delete merged[id]
  })

  var removed = 0
  if (options.accounts !== undefined) {
    if (!Array.isArray(options.accounts)) throw new Error('汇率历史导入账户列表格式不对')
    var ids = Object.create(null)
    options.accounts.forEach(function (item) {
      var id = accountId(item && item.id)
      if (id) ids[id] = true
    })
    Object.keys(merged).forEach(function (id) {
      if (!ids[id]) { removed += merged[id].length; delete merged[id] }
    })
  }
  Object.keys(merged).forEach(function (id) { merged[id] = sortRows(merged[id]) })
  var changes = same(current, merged) ? [] : [{ key: KEY, value: clone(merged) }]
  var total = 0
  Object.keys(merged).forEach(function (id) { total += merged[id].length })
  return {
    ok: true,
    mode: mode,
    value: clone(merged),
    changes: changes,
    added: added,
    updated: updated,
    unchanged: unchanged,
    removed: removed,
    total: total
  }
}

module.exports = {
  KEY: KEY,
  STORAGE_KEY: KEY,
  MAX_PER_ACCOUNT: MAX_PER_ACCOUNT,
  list: list,
  record: record,
  removeAccount: removeAccount,
  capture: capture,
  restore: restore,
  exportData: exportData,
  planImport: planImport,
  error: function () { return _lastError }
}
