/* 预算模板：内置示例 + 本机自定义模板，不直接改写当前预算。
 * 存储键：budget_templates_v1；备份导出同样使用该键。
 */
var category = require('./category')
var format = require('./format')

var KEY = 'budget_templates_v1'
var NAME_MAX = 40
var ID_MAX = 128
var AMOUNT_MAX = 999999999
var VALID_CATEGORIES = category.catsOf('expense')

var BUILTINS = [
  {
    id: 'builtin-basic-life',
    name: '基础生活',
    monthlyBudget: 5000,
    categoryBudgets: { '餐饮': 1600, '生活缴费': 600, '交通': 400, '医疗': 300, '其他支出': 300 },
    builtin: true,
    createdAt: 0
  },
  {
    id: 'builtin-50-30-20',
    name: '50/30/20 简化版',
    monthlyBudget: 10000,
    categoryBudgets: { '餐饮': 3000, '交通': 600, '生活缴费': 1400, '娱乐': 1500, '购物': 1500, '其他支出': 2000 },
    builtin: true,
    createdAt: 0
  },
  {
    id: 'builtin-travel-month',
    name: '旅行月',
    monthlyBudget: 8000,
    categoryBudgets: { '旅行': 5200, '餐饮': 1200, '交通': 800, '购物': 500, '娱乐': 300 },
    builtin: true,
    createdAt: 0
  }
]

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function text(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max || NAME_MAX)
}

function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

function amount(value) {
  if (value === '' || value === null || value === undefined || typeof value === 'boolean') return null
  if (typeof value === 'string' && !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) return null
  var n = Number(value)
  if (!isFinite(n) || n < 0 || n > AMOUNT_MAX) return null
  var rounded = Math.round(n * 100) / 100
  return rounded <= AMOUNT_MAX ? rounded : null
}

function createdAt(value) {
  var n = Number(value)
  return isFinite(n) && n >= 0 && Math.floor(n) === n ? n : 0
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (hasOwn(raw, 'id') && !validId(raw.id)) return null
  if (hasOwn(raw, 'builtin') && typeof raw.builtin !== 'boolean') return null
  var id = text(raw.id, ID_MAX)
  var rawName = String(raw.name == null ? '' : raw.name).trim()
  var name = text(raw.name, NAME_MAX)
  var monthly = amount(raw.monthlyBudget)
  var budgets = raw.categoryBudgets && typeof raw.categoryBudgets === 'object' && !Array.isArray(raw.categoryBudgets)
    ? raw.categoryBudgets : null
  if (!validId(id) || !name || rawName.length > NAME_MAX || monthly === null || !budgets) return null
  var knownBuiltin = BUILTINS.some(function (item) { return item.id === id })
  var builtin = raw.builtin === true && knownBuiltin
  if (knownBuiltin && !builtin) return null
  if (Object.keys(budgets).length > VALID_CATEGORIES.length) return null
  var normalizedBudgets = {}
  for (var i = 0; i < Object.keys(budgets).length; i++) {
    var key = Object.keys(budgets)[i]
    var n = amount(budgets[key])
    if (VALID_CATEGORIES.indexOf(key) < 0 || n === null) return null
    normalizedBudgets[key] = n
  }
  return {
    id: id,
    name: name,
    monthlyBudget: monthly,
    categoryBudgets: normalizedBudgets,
    builtin: builtin,
    createdAt: createdAt(raw.createdAt)
  }
}

function readStored() {
  var value
  try { value = wx.getStorageSync(KEY) } catch (e) { return [] }
  if (!Array.isArray(value)) return []
  var seen = Object.create(null)
  var out = []
  value.forEach(function (raw) {
    var item = normalize(raw)
    if (!item || item.builtin || BUILTINS.some(function (builtin) { return builtin.id === item.id }) || seen[item.id]) return
    seen[item.id] = true
    out.push(item)
  })
  return out
}

function write(items) {
  try {
    wx.setStorageSync(KEY, items)
    return true
  } catch (e) { return false }
}

function find(items, id) {
  id = String(id || '')
  for (var i = 0; i < items.length; i++) if (items[i].id === id) return i
  return -1
}

function newId() {
  var items = readStored()
  var base = 'bt-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
  var candidate = base
  var suffix = 1
  while (find(items, candidate) >= 0) candidate = base + '-' + suffix++
  return candidate
}

function list() {
  return BUILTINS.map(clone).concat(readStored())
}

function get(id) {
  var items = list()
  var index = find(items, id)
  return index < 0 ? null : clone(items[index])
}

function save(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  var items = readStored()
  var input = Object.assign({}, raw)
  if (hasOwn(input, 'id') && input.id !== undefined && input.id !== null &&
      (typeof input.id !== 'string' || !validId(input.id))) return null
  if (input.id && BUILTINS.some(function (item) { return item.id === input.id })) return null
  var suppliedId = text(input.id, ID_MAX)
  var existingIndex = find(items, suppliedId)
  if (!input.id) input.id = newId()
  if (!hasOwn(input, 'createdAt')) input.createdAt = existingIndex >= 0 ? items[existingIndex].createdAt : Date.now()
  var item = normalize(input)
  if (!item) return null
  if (existingIndex >= 0) items[existingIndex] = item
  else items.push(item)
  return write(items) ? clone(item) : null
}

function remove(id) {
  var items = readStored()
  var index = find(items, id)
  if (index < 0) return false
  items.splice(index, 1)
  return write(items)
}

function duplicate(id, options) {
  var source = get(id)
  if (!source) return null
  var copy = Object.assign({}, source, {
    id: newId(),
    name: text(source.name, NAME_MAX - 3) + ' 副本',
    builtin: false,
    createdAt: options && hasOwn(options, 'now') ? createdAt(options.now) : Date.now()
  })
  return save(copy)
}

/* 仅计算示例，不写入 store；income 为空时不假设收入，也不按收入自动缩放模板。 */
function preview(template, income) {
  var item = normalize(template)
  if (!item) return null
  var incomeAmount = income === '' || income === undefined ? null : amount(income)
  if (income !== '' && income !== undefined && income !== null && incomeAmount === null) return null
  var totalCents = Object.keys(item.categoryBudgets).reduce(function (sum, key) {
    return sum + Math.round(item.categoryBudgets[key] * 100)
  }, 0)
  var allocated = totalCents / 100
  var remaining = Math.round(item.monthlyBudget * 100 - totalCents) / 100
  var rows = Object.keys(item.categoryBudgets).map(function (key) {
    return {
      category: key,
      amount: item.categoryBudgets[key],
      amountText: '¥' + format.money(item.categoryBudgets[key]),
      percent: item.monthlyBudget > 0 ? Math.round(item.categoryBudgets[key] / item.monthlyBudget * 1000) / 10 : 0
    }
  })
  return {
    id: item.id,
    name: item.name,
    monthlyBudget: item.monthlyBudget,
    monthlyBudgetText: '¥' + format.money(item.monthlyBudget),
    income: incomeAmount,
    incomeText: incomeAmount === null ? '' : '¥' + format.money(incomeAmount),
    budgetRate: incomeAmount > 0 ? Math.round(item.monthlyBudget / incomeAmount * 1000) / 10 : null,
    allocated: allocated,
    allocatedText: '¥' + format.money(allocated),
    remaining: remaining,
    remainingText: (remaining < 0 ? '-' : '') + '¥' + format.money(Math.abs(remaining)),
    overAllocated: remaining < 0,
    rows: rows
  }
}

function exportData() {
  return {
    app: '通用记账Book',
    kind: 'budget_templates',
    version: 1,
    key: KEY,
    exportedAt: Date.now(),
    items: readStored()
  }
}

/* 合并自定义模板：同 ID 以备份覆盖，新增 ID 追加；内置 ID 永不写回存储。
   只生成计划，真正写入由账本备份统一提交。 */
function planImport(payload) {
  var rows = payload
  if (payload && !Array.isArray(payload)) {
    if (payload.kind !== 'budget_templates' || payload.version !== 1 || !Array.isArray(payload.items)) {
      throw new Error('预算模板备份格式不对')
    }
    rows = payload.items
  }
  if (!Array.isArray(rows)) throw new Error('预算模板备份格式不对')
  var items = readStored()
  var indexes = Object.create(null)
  items.forEach(function (item, i) { indexes[item.id] = i })
  var added = 0
  var updated = 0
  var skipped = 0
  var seen = Object.create(null)
  BUILTINS.forEach(function (item) { seen[item.id] = true })
  rows.forEach(function (raw) {
    var item = normalize(raw)
    if (!item || item.builtin || seen[item.id]) { skipped++; return }
    seen[item.id] = true
    if (indexes[item.id] === undefined) {
      indexes[item.id] = items.length
      items.push(item)
      added++
    } else {
      items[indexes[item.id]] = item
      updated++
    }
  })
  var current = readStored()
  var changes = JSON.stringify(current) === JSON.stringify(items)
    ? [] : [{ key: KEY, value: items }]
  return {
    ok: true,
    value: items,
    changes: changes,
    added: added,
    updated: updated,
    skipped: skipped,
    total: items.length
  }
}

function importData(payload) {
  var plan = planImport(payload)
  var saved = !plan.changes.length || write(plan.value)
  return {
    saved: saved,
    added: saved ? plan.added : 0,
    updated: saved ? plan.updated : 0,
    skipped: plan.skipped,
    total: plan.total
  }
}

module.exports = {
  KEY: KEY,
  NAME_MAX: NAME_MAX,
  AMOUNT_MAX: AMOUNT_MAX,
  BUILTINS: BUILTINS.map(clone),
  CATEGORIES: VALID_CATEGORIES.slice(),
  normalize: normalize,
  list: list,
  get: get,
  save: save,
  remove: remove,
  duplicate: duplicate,
  preview: preview,
  exportData: exportData,
  importData: importData,
  planImport: planImport
}
