/* 账户汇率提醒：仅保存配置与待提醒状态，实际展示由应用内页面负责。
 * rate_alerts_v1: { [accountId]: { accountId, currency, targetRate, direction,
 *   enabled, pending, lastTriggeredAt, triggerCount, updatedAt } }
 * 汇率口径与账户一致：1 外币 = 多少人民币。
 */
var KEY = 'rate_alerts_v1'
var VERSION = 1
var currency = require('./currency')
var _lastError = ''

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
  _lastError = message || '汇率提醒操作失败'
  return null
}

function readRaw() {
  if (!hasStorage()) throw new Error('当前环境无法读取汇率提醒')
  try {
    return wx.getStorageSync(KEY)
  } catch (e) {
    throw new Error('汇率提醒读取失败，请稍后重试')
  }
}

function positiveTime(value, label, allowNull) {
  if (allowNull && absent(value)) return null
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error(label + '无效')
  if (typeof value === 'string' && !value.trim()) throw new Error(label + '无效')
  var time = Number(value)
  if (!isFinite(time) || time <= 0 || !Number.isInteger(time)) throw new Error(label + '无效')
  return time
}

function normalizeRecord(raw, id) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('汇率提醒格式不对')
  var recordId = accountId(raw.accountId === undefined ? id : raw.accountId)
  if (!recordId || recordId !== id) throw new Error('汇率提醒账户 ID 无效')
  var code = currency.normalizeStrictCode(raw.currency)
  if (!code) throw new Error('汇率提醒币种不支持')
  if (code === 'CNY') throw new Error('CNY 不支持汇率提醒')
  var targetRate = currency.normalizeRate(raw.targetRate, code)
  if (targetRate === null) throw new Error('目标汇率必须是大于 0 的有效数字')
  if (raw.direction !== 'above' && raw.direction !== 'below') throw new Error('汇率提醒方向无效')
  if (typeof raw.enabled !== 'boolean' || typeof raw.pending !== 'boolean') throw new Error('汇率提醒开关状态无效')
  var triggerCount = raw.triggerCount
  if (typeof triggerCount !== 'number' || !Number.isInteger(triggerCount) || triggerCount < 0 || !isFinite(triggerCount)) {
    throw new Error('汇率提醒触发次数无效')
  }
  var lastTriggeredAt = positiveTime(raw.lastTriggeredAt, '汇率提醒触发时间', true)
  if (raw.pending && lastTriggeredAt === null) throw new Error('待提醒缺少触发时间')
  return {
    accountId: recordId,
    currency: code,
    targetRate: targetRate,
    direction: raw.direction,
    enabled: raw.enabled,
    pending: raw.pending,
    lastTriggeredAt: lastTriggeredAt,
    triggerCount: triggerCount,
    updatedAt: positiveTime(raw.updatedAt, '汇率提醒更新时间', false)
  }
}

function normalizeData(raw) {
  if (absent(raw)) return Object.create(null)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('汇率提醒数据应为账户对象')
  var out = Object.create(null)
  Object.keys(raw).forEach(function (id) {
    if (!accountId(id)) throw new Error('汇率提醒账户 ID 无效')
    out[id] = normalizeRecord(raw[id], id)
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

/* 单 key 写入后回读；失败恢复原值，避免静默丢失其他账户的提醒。 */
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
    _lastError = restored ? '汇率提醒保存失败，本次修改已撤销' : '汇率提醒保存中断且回滚失败，请立即核对本地数据'
    return false
  }
}

function get(id) {
  id = accountId(id)
  if (!id) return null
  var data = readAll()
  return own(data, id) ? clone(data[id]) : null
}

/* config 可只修改 enabled；新建时 direction 默认 above、enabled 默认 true。
 * 关闭会清除 pending；修改目标/方向不会绕过尚未确认的提醒。 */
function save(id, account, config) {
  _lastError = ''
  id = accountId(id)
  if (!id) return fail('汇率提醒缺少有效账户 ID')
  if (!account || typeof account !== 'object' || Array.isArray(account)) return fail('账户信息无效')
  if (accountId(account.id) !== id) return fail('账户 ID 与提醒账户不一致')
  var code = currency.normalizeStrictCode(account.currency)
  if (!code) return fail('账户币种不支持')
  if (code === 'CNY') return fail('CNY 不支持汇率提醒')
  if (currency.normalizeRate(account.rateToCny, code) === null) return fail('账户汇率必须是大于 0 的有效数字')
  if (config === undefined || config === null) config = {}
  if (typeof config !== 'object' || Array.isArray(config)) return fail('汇率提醒配置格式不对')

  var data
  try { data = readAll() } catch (e) { return fail(e.message) }
  var previous = own(data, id) ? data[id] : null
  if (previous && previous.currency !== code) previous = null
  var targetRate = previous ? previous.targetRate : null
  if (own(config, 'targetRate')) {
    targetRate = currency.normalizeRate(config.targetRate, code)
    if (targetRate === null) return fail('目标汇率必须是大于 0 的有效数字')
  }
  if (targetRate === null) return fail('请填写目标汇率')
  var direction = own(config, 'direction') ? config.direction : (previous ? previous.direction : 'above')
  if (direction !== 'above' && direction !== 'below') return fail('汇率提醒方向无效')
  var enabled = own(config, 'enabled') ? config.enabled : (previous ? previous.enabled : true)
  if (typeof enabled !== 'boolean') return fail('汇率提醒开关状态无效')

  var now = Date.now()
  var record = {
    accountId: id,
    currency: code,
    targetRate: targetRate,
    direction: direction,
    enabled: enabled,
    pending: enabled && previous ? previous.pending : false,
    lastTriggeredAt: previous ? previous.lastTriggeredAt : null,
    triggerCount: previous ? previous.triggerCount : 0,
    updatedAt: now
  }
  data[id] = record
  return writeAll(data) ? clone(record) : null
}

function listPending() {
  var data = readAll()
  return Object.keys(data).map(function (id) { return data[id] })
    .filter(function (item) { return item.enabled && item.pending })
    .sort(function (a, b) { return b.updatedAt - a.updatedAt })
    .map(clone)
}

/* previousRate 是变化前汇率，account.rateToCny 是变化后汇率。
 * 上涨：旧值 < 目标且新值 >= 目标；下跌：旧值 > 目标且新值 <= 目标。
 * 已 pending 或已关闭时不触发；同一轮跨越不会重复累计。 */
function evaluate(account, previousRate) {
  _lastError = ''
  if (!account || typeof account !== 'object' || Array.isArray(account)) return fail('账户信息无效')
  var id = accountId(account.id)
  if (!id) return fail('汇率提醒缺少有效账户 ID')
  var code = currency.normalizeStrictCode(account.currency)
  if (!code) return fail('账户币种不支持')
  if (code === 'CNY') return fail('CNY 不支持汇率提醒')
  var currentRate = currency.normalizeRate(account.rateToCny, code)
  var beforeRate = currency.normalizeRate(previousRate, code)
  if (currentRate === null || beforeRate === null) return fail('汇率必须是大于 0 的有效数字')
  if (currentRate === beforeRate) return get(id)

  var data
  try { data = readAll() } catch (e) { return fail(e.message) }
  var record = data[id]
  if (!own(data, id) || record.currency !== code) return null
  if (!record.enabled || record.pending) return clone(record)
  var crossed = record.direction === 'above'
    ? beforeRate < record.targetRate && currentRate >= record.targetRate
    : beforeRate > record.targetRate && currentRate <= record.targetRate
  if (!crossed) return clone(record)
  record.pending = true
  record.lastTriggeredAt = Date.now()
  record.triggerCount += 1
  record.updatedAt = record.lastTriggeredAt
  return writeAll(data) ? clone(record) : null
}

function ack(id) {
  _lastError = ''
  id = accountId(id)
  if (!id) return false
  var data
  try { data = readAll() } catch (e) { _lastError = e.message; return false }
  if (!own(data, id) || !data[id].pending) return false
  data[id].pending = false
  data[id].updatedAt = Date.now()
  return writeAll(data)
}

function remove(id) {
  _lastError = ''
  id = accountId(id)
  if (!id) return false
  var data
  try { data = readAll() } catch (e) { _lastError = e.message; return false }
  if (!own(data, id)) return false
  delete data[id]
  return writeAll(data)
}

function exportData() {
  return {
    app: '通用记账Book',
    kind: 'rate_alerts',
    version: VERSION,
    storageKey: KEY,
    exportedAt: Date.now(),
    rateAlerts: clone(readAll())
  }
}

function parsePayload(payload) {
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload) } catch (e) { throw new Error('汇率提醒备份不是有效 JSON') }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('汇率提醒备份格式不对')
  var data = payload
  if (own(payload, 'rateAlerts') || own(payload, 'alerts')) {
    if (payload.version !== undefined && payload.version !== VERSION) throw new Error('汇率提醒备份版本不支持')
    data = own(payload, 'rateAlerts') ? payload.rateAlerts : payload.alerts
  }
  return normalizeData(data)
}

function validAccounts(options) {
  if (options.accounts === undefined) return null
  if (!Array.isArray(options.accounts)) throw new Error('汇率提醒导入账户列表格式不对')
  var map = Object.create(null)
  options.accounts.forEach(function (raw) {
    if (typeof raw === 'string' || typeof raw === 'number') raw = { id: raw }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('汇率提醒导入账户列表格式不对')
    var id = accountId(raw.id)
    if (!id) throw new Error('汇率提醒导入账户 ID 无效')
    var code = ''
    if (raw.currency !== undefined && raw.currency !== null && raw.currency !== '') {
      code = currency.normalizeStrictCode(raw.currency)
      if (!code) throw new Error('汇率提醒导入账户币种无效')
    }
    map[id] = code
  })
  return map
}

/* 纯合并计划，不写存储。提供 accounts 时校验账户与币种，并清理孤儿/币种过期配置。 */
function planImport(payload, options) {
  options = options || {}
  var mode = options.mode === undefined ? 'merge' : options.mode
  if (mode !== 'merge' && mode !== 'replace') throw new Error('汇率提醒导入模式无效')
  var accountMap = validAccounts(options)
  var incoming = parsePayload(payload)
  var current = readAll()
  var merged = mode === 'merge' ? clone(current) : Object.create(null)
  var added = 0
  var updated = 0
  var unchanged = 0
  var removed = 0
  var skipped = 0

  function usable(id, item) {
    return !accountMap || (own(accountMap, id) && (!accountMap[id] || accountMap[id] === item.currency))
  }

  Object.keys(incoming).forEach(function (id) {
    var item = incoming[id]
    if (!usable(id, item)) { skipped++; return }
    if (!own(merged, id)) { merged[id] = item; added++ }
    else if (same(merged[id], item)) unchanged++
    else { merged[id] = item; updated++ }
  })
  Object.keys(merged).forEach(function (id) {
    if (!usable(id, merged[id])) { removed++; delete merged[id] }
  })
  var changes = same(current, merged) ? [] : [{ key: KEY, value: clone(merged) }]
  return {
    ok: true,
    mode: mode,
    value: clone(merged),
    changes: changes,
    added: added,
    updated: updated,
    unchanged: unchanged,
    removed: removed,
    skipped: skipped,
    total: Object.keys(merged).length
  }
}

module.exports = {
  KEY: KEY,
  STORAGE_KEY: KEY,
  VERSION: VERSION,
  get: get,
  save: save,
  listPending: listPending,
  evaluate: evaluate,
  ack: ack,
  remove: remove,
  exportData: exportData,
  planImport: planImport,
  error: function () { return _lastError }
}
