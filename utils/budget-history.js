/* 历史预算存档：金额参数/返回值均为元，校验和计算全程按分。
 * 存储键 budget_history_v1，值直接为 { 'YYYY-MM': { budget, catBudgets, updatedAt } }。
 * diff 的差额 = 当前预算 - 历史预算；正数表示当前额度增加。
 * planImport 只读存储并返回 changes，真正写入由账本备份统一提交。
 */
var category = require('./category')

var KEY = 'budget_history_v1'
var MAX_MONTHS = 120
var AMOUNT_MAX = 999999999
var VALID_CATEGORIES = category.catsOf('expense')

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function validYm(value) {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
}

/* 拒绝三分钱、指数、布尔值等输入；浮点误差仅用于校验，不接受额外精度。 */
function amountCents(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null
  if (typeof value === 'string' && !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) return null
  if (typeof value !== 'string' && typeof value !== 'number') return null
  var n = Number(value)
  if (!isFinite(n) || n < 0 || n > AMOUNT_MAX) return null
  var cents = Math.round(n * 100)
  if (!isFinite(cents) || cents < 0 || cents > AMOUNT_MAX * 100) return null
  if (Math.abs(n * 100 - cents) > 1e-7) return null
  return cents
}

function timestamp(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean' || (typeof value !== 'number' && typeof value !== 'string')) return null
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return null
  var n = Number(value)
  return isFinite(n) && n >= 0 && Math.floor(n) === n && n <= 9007199254740991 ? n : fallback
}

function normalizeCatBudgets(value, legacy) {
  if (value === undefined && legacy) return {}
  if (!isObject(value)) return null
  var keys = Object.keys(value)
  if (keys.length > VALID_CATEGORIES.length) return null
  var out = {}
  for (var i = 0; i < keys.length; i++) {
    var name = keys[i]
    var cents = amountCents(value[name])
    if (VALID_CATEGORIES.indexOf(name) < 0 || cents === null) return null
    out[name] = cents / 100
  }
  return out
}

/* legacy 仅用于读取旧存档/旧备份：缺金额视为 0，缺分类视为 {}，缺时间视为 0。 */
function normalizeSnapshot(raw, legacy) {
  if (!isObject(raw)) return null
  var ym = raw.ym === undefined && legacy ? raw.month : raw.ym
  if (!validYm(ym)) return null
  var budgetValue = raw.budget
  if (budgetValue === undefined && legacy) budgetValue = raw.monthlyBudget
  if (budgetValue === undefined && legacy) budgetValue = 0
  var budget = amountCents(budgetValue)
  if (budget === null) return null
  var catsValue = raw.catBudgets
  if (catsValue === undefined && legacy) catsValue = raw.categoryBudgets
  var cats = normalizeCatBudgets(catsValue, legacy)
  if (!cats) return null
  var timeValue = raw.updatedAt
  if (timeValue === undefined && legacy) timeValue = raw.time
  var updatedAt = timestamp(timeValue, legacy ? 0 : null)
  if (updatedAt === null) return null
  return { budget: budget / 100, catBudgets: cats, updatedAt: updatedAt }
}

function orderedMap(map, descending) {
  var keys = Object.keys(map).sort()
  if (descending) keys.reverse()
  var out = {}
  keys.forEach(function (ym) { out[ym] = clone(map[ym]) })
  return out
}

function prune(map) {
  var keys = Object.keys(map).sort()
  if (keys.length <= MAX_MONTHS) return orderedMap(map, false)
  var kept = Object.create(null)
  keys.slice(keys.length - MAX_MONTHS).forEach(function (ym) { kept[ym] = map[ym] })
  return orderedMap(kept, false)
}

function readStored() {
  var raw
  try { raw = wx.getStorageSync(KEY) } catch (e) { return {} }
  if (!isObject(raw)) return {}
  var out = Object.create(null)
  Object.keys(raw).forEach(function (ym) {
    var item = normalizeSnapshot(Object.assign({}, raw[ym], { ym: ym }), true)
    if (item) out[ym] = item
  })
  return prune(out)
}

function write(map) {
  try {
    wx.setStorageSync(KEY, prune(map))
    return true
  } catch (e) { return false }
}

function record(ym, budget, categoryBudgets, time) {
  var item = normalizeSnapshot({
    ym: ym,
    budget: budget,
    catBudgets: categoryBudgets,
    updatedAt: time === undefined ? Date.now() : time
  }, false)
  if (!item) return null
  var map = readStored()
  map[ym] = item
  if (!write(map)) return null
  return clone(item)
}

function list(limit) {
  var map = orderedMap(readStored(), true)
  var count = MAX_MONTHS
  if (limit !== undefined && limit !== null && limit !== '') {
    var n = Number(limit)
    if (!isFinite(n) || n <= 0) return []
    count = Math.min(MAX_MONTHS, Math.floor(n))
  }
  return Object.keys(map).slice(0, count).map(function (ym) {
    return Object.assign({ ym: ym }, map[ym])
  })
}

function get(ym) {
  if (!validYm(ym)) return null
  var item = readStored()[ym]
  return item ? clone(item) : null
}

function diff(ym, currentBudget, currentCatBudgets) {
  var historical = get(ym)
  if (!historical) return null
  var current = normalizeSnapshot({
    ym: ym,
    budget: currentBudget,
    catBudgets: currentCatBudgets,
    updatedAt: 0
  }, false)
  if (!current) return null
  var names = Object.create(null)
  Object.keys(historical.catBudgets).forEach(function (name) { names[name] = true })
  Object.keys(current.catBudgets).forEach(function (name) { names[name] = true })
  var categories = VALID_CATEGORIES.filter(function (name) { return names[name] }).map(function (name) {
    var oldCents = Math.round((historical.catBudgets[name] || 0) * 100)
    var newCents = Math.round((current.catBudgets[name] || 0) * 100)
    return {
      category: name,
      budget: oldCents / 100,
      currentBudget: newCents / 100,
      diff: (newCents - oldCents) / 100
    }
  })
  var oldTotal = Math.round(historical.budget * 100)
  var newTotal = Math.round(current.budget * 100)
  return {
    ym: ym,
    historicalBudget: oldTotal / 100,
    currentBudget: newTotal / 100,
    budgetDiff: (newTotal - oldTotal) / 100,
    catBudgets: clone(historical.catBudgets),
    currentCatBudgets: clone(current.catBudgets),
    categories: categories
  }
}

function exportData() {
  return {
    app: '通用记账Book',
    kind: 'budget_history',
    version: 1,
    key: KEY,
    exportedAt: Date.now(),
    items: orderedMap(readStored(), false)
  }
}

function incomingRows(payload) {
  var rows = payload
  if (isObject(payload)) {
    if (hasOwn(payload, 'kind') && payload.kind !== 'budget_history') throw new Error('预算历史备份格式不对')
    if (hasOwn(payload, 'version') && payload.version !== 1) throw new Error('预算历史备份格式不对')
    if (hasOwn(payload, 'key') && payload.key !== KEY) throw new Error('预算历史备份格式不对')
    if (hasOwn(payload, 'items')) rows = payload.items
    else if (hasOwn(payload, 'history')) rows = payload.history
    else if (hasOwn(payload, 'budgetHistory')) rows = payload.budgetHistory
  }
  if (Array.isArray(rows)) return rows.map(function (raw) { return { raw: raw, ym: raw && raw.ym } })
  if (!isObject(rows)) throw new Error('预算历史备份格式不对')
  return Object.keys(rows).map(function (ym) {
    var raw = rows[ym]
    return { raw: isObject(raw) ? Object.assign({}, raw, { ym: ym }) : raw, ym: ym }
  })
}

/* 同月保留 updatedAt 较新的一份；时间相同则后出现的备份内容覆盖。 */
function planImport(payload) {
  var rows = incomingRows(payload)
  var current = readStored()
  var merged = Object.create(null)
  Object.keys(current).forEach(function (ym) { merged[ym] = current[ym] })
  var added = 0
  var updated = 0
  var skipped = 0
  rows.forEach(function (entry) {
    var item = normalizeSnapshot(entry.raw, true)
    if (!item || !validYm(entry.ym) || (entry.raw && entry.raw.ym !== undefined && entry.raw.ym !== entry.ym)) {
      throw new Error('预算历史备份格式不对')
    }
    var existing = merged[entry.ym]
    if (existing && existing.updatedAt > item.updatedAt) { skipped++; return }
    if (existing) updated++
    else added++
    merged[entry.ym] = item
  })
  var value = prune(merged)
  var changes = JSON.stringify(orderedMap(current, false)) === JSON.stringify(value)
    ? [] : [{ key: KEY, value: value }]
  return {
    ok: true,
    value: value,
    changes: changes,
    added: added,
    updated: updated,
    skipped: skipped,
    total: Object.keys(value).length
  }
}

module.exports = {
  KEY: KEY,
  MAX_MONTHS: MAX_MONTHS,
  AMOUNT_MAX: AMOUNT_MAX,
  CATEGORIES: VALID_CATEGORIES.slice(),
  normalizeSnapshot: normalizeSnapshot,
  record: record,
  list: list,
  get: get,
  diff: diff,
  exportData: exportData,
  planImport: planImport
}
