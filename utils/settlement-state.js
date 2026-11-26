/* 共同账本结算的本机状态：权重、分类覆盖、命名模板、已结清建议和操作历史。
 * 只写 settlement_v1，不读取或修改云端流水；导入采用整份替换，校验失败不写入。
 */
var KEY = 'settlement_v1'
var VERSION = 1
var MAX_HISTORY = 1000
var MAX_TEMPLATES = 100
var MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

function map() { return Object.create(null) }
function object(value) { return !!value && typeof value === 'object' && !Array.isArray(value) }
function validId(value) { return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 200 }
function validYm(value) { return typeof value === 'string' && MONTH_RE.test(value) }
function clone(value) { return JSON.parse(JSON.stringify(value)) }
function failure(error) { return { ok: false, error: error } }

function emptyRoot() { return { version: VERSION, books: {} } }

function readRoot() {
  try {
    var value = wx.getStorageSync(KEY)
    if (!object(value) || value.version !== VERSION || !object(value.books)) return emptyRoot()
    return value
  } catch (e) {
    return emptyRoot()
  }
}

function writeRoot(root) {
  try {
    wx.setStorageSync(KEY, root)
    return true
  } catch (e) {
    return false
  }
}

function bookState(root, bookId, create) {
  var book = Object.prototype.hasOwnProperty.call(root.books, bookId) ? root.books[bookId] : null
  if (!object(book)) {
    if (!create) return null
    book = { months: {}, history: [], templates: [] }
    Object.defineProperty(root.books, bookId, { value: book, enumerable: true, writable: true, configurable: true })
  }
  if (!object(book.months) || !Array.isArray(book.history)) {
    if (!create) return null
    book.months = {}
    book.history = []
  }
  if (!Array.isArray(book.templates) && create) book.templates = []
  return book
}

function monthState(root, bookId, ym, create) {
  var book = bookState(root, bookId, create)
  if (!book) return null
  var month = Object.prototype.hasOwnProperty.call(book.months, ym) ? book.months[ym] : null
  if (!object(month)) {
    if (!create) return null
    month = { weights: {}, categoryWeights: {}, settled: [] }
    Object.defineProperty(book.months, ym, { value: month, enumerable: true, writable: true, configurable: true })
  }
  if (!object(month.weights) || !Array.isArray(month.settled)) {
    if (!create) return null
    month.weights = {}
    month.settled = []
  }
  if (!object(month.categoryWeights) && create) month.categoryWeights = {}
  return month
}

/* 空对象表示恢复平均分摊；非空映射必须至少有一个正权重。 */
function normalizeWeights(value, strict) {
  if (!object(value)) return strict ? failure('权重格式不对') : { weights: {}, error: '' }
  var weights = map()
  var positive = false
  var keys = Object.keys(value)
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i].trim()
    var raw = value[keys[i]]
    var weight
    if (raw === '') weight = 0
    else if (typeof raw === 'number') weight = raw
    else if (typeof raw === 'string' && /^\+?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw.trim())) weight = Number(raw)
    else weight = NaN
    if (!validId(key) || !isFinite(weight) || weight < 0) {
      if (strict) return failure('权重必须为非负数，且成员标识有效')
      continue
    }
    weights[key] = weight
    if (weight > 0) positive = true
  }
  if (keys.length && !positive) {
    if (strict) return failure('至少一名成员的权重大于 0；恢复平均分摊请清空权重')
    weights = map()
  }
  return { weights: weights, error: '' }
}

function validCategory(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 100
}

function normalizeCategoryWeights(value, strict) {
  if (!object(value)) return strict ? failure('分类权重格式不对') : { weights: {}, error: '' }
  var weights = map()
  var keys = Object.keys(value)
  if (keys.length > 100) return strict ? failure('分类覆盖数量超限') : { weights: {}, error: '' }
  for (var i = 0; i < keys.length; i++) {
    var name = keys[i].trim()
    if (!validCategory(name)) {
      if (strict) return failure('分类名称无效')
      continue
    }
    if (!object(value[keys[i]]) || !Object.keys(value[keys[i]]).length) {
      if (strict) return failure('分类「' + name + '」的权重不能为空')
      continue
    }
    var normalized = normalizeWeights(value[keys[i]], true)
    if (normalized.error) {
      if (strict) return failure('分类「' + name + '」：' + normalized.error)
      continue
    }
    weights[name] = clone(normalized.weights)
  }
  return { weights: weights, error: '' }
}

function normalizeTransfer(value) {
  if (!object(value) || !validId(value.from) || !validId(value.to) ||
      value.from.trim() === value.to.trim() || !Number.isSafeInteger(value.amount) || value.amount <= 0) return null
  return {
    from: value.from.trim(),
    to: value.to.trim(),
    amount: value.amount,
    settledAt: Number.isSafeInteger(value.settledAt) && value.settledAt >= 0 ? value.settledAt : 0
  }
}

function transferId(transfer) { return JSON.stringify([transfer.from, transfer.to, transfer.amount]) }

function normalizeHistory(value) {
  if (!object(value) || !validYm(value.ym) || !validId(value.from) || !validId(value.to) ||
      value.from.trim() === value.to.trim() || !Number.isSafeInteger(value.amount) || value.amount <= 0 ||
      !Number.isSafeInteger(value.time) || value.time < 0 || (value.action !== 'settle' && value.action !== 'unsettle')) return null
  return {
    time: value.time,
    ym: value.ym,
    from: value.from.trim(),
    to: value.to.trim(),
    amount: value.amount,
    action: value.action,
    fromName: typeof value.fromName === 'string' ? value.fromName.trim().slice(0, 100) : '',
    toName: typeof value.toName === 'string' ? value.toName.trim().slice(0, 100) : ''
  }
}

function load(bookId, ym) {
  bookId = typeof bookId === 'string' ? bookId.trim() : ''
  if (!validId(bookId) || !validYm(ym)) return { weights: {}, categoryWeights: {}, settled: [], error: '账本标识或月份格式不对' }
  var month = monthState(readRoot(), bookId, ym, false)
  if (!month) return { weights: {}, categoryWeights: {}, settled: [] }
  var weights = normalizeWeights(month.weights, false).weights
  var categoryWeights = normalizeCategoryWeights(month.categoryWeights, false).weights
  var settled = []
  var seen = map()
  ;(month.settled || []).forEach(function (raw) {
    var item = normalizeTransfer(raw)
    var id = item && transferId(item)
    if (item && !seen[id]) { seen[id] = true; settled.push(item) }
  })
  return { weights: clone(weights), categoryWeights: clone(categoryWeights), settled: clone(settled) }
}

function saveCategoryWeights(bookId, ym, category, weights) {
  bookId = typeof bookId === 'string' ? bookId.trim() : ''
  category = typeof category === 'string' ? category.trim() : ''
  if (!validId(bookId) || !validYm(ym) || !validCategory(category)) return failure('账本标识、月份或分类名称不对')
  if (!object(weights) || !Object.keys(weights).length) return failure('分类权重不能为空')
  var normalized = normalizeWeights(weights, true)
  if (normalized.error) return failure(normalized.error)
  var root = clone(readRoot())
  var month = monthState(root, bookId, ym, true)
  Object.defineProperty(month.categoryWeights, category, {
    value: clone(normalized.weights), enumerable: true, writable: true, configurable: true
  })
  if (!writeRoot(root)) return failure('本机保存失败，请检查存储空间后重试')
  return { ok: true, category: category, weights: clone(normalized.weights) }
}

function removeCategoryWeights(bookId, ym, category) {
  bookId = typeof bookId === 'string' ? bookId.trim() : ''
  category = typeof category === 'string' ? category.trim() : ''
  if (!validId(bookId) || !validYm(ym) || !validCategory(category)) return failure('账本标识、月份或分类名称不对')
  var root = clone(readRoot())
  var month = monthState(root, bookId, ym, true)
  delete month.categoryWeights[category]
  if (!writeRoot(root)) return failure('本机保存失败，请检查存储空间后重试')
  return { ok: true, category: category }
}

function normalizeTemplate(value) {
  if (!object(value) || !validId(value.id) || typeof value.name !== 'string' ||
      !value.name.trim() || value.name.trim().length > 50) return null
  var normalized = normalizeWeights(value.weights, true)
  if (normalized.error) return null
  return {
    id: value.id.trim(),
    name: value.name.trim(),
    weights: clone(normalized.weights),
    createdAt: Number.isSafeInteger(value.createdAt) && value.createdAt >= 0 ? value.createdAt : 0
  }
}

function templateId() {
  return 'tpl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

function saveTemplate(bookId, name, weights) {
  bookId = typeof bookId === 'string' ? bookId.trim() : ''
  name = typeof name === 'string' ? name.trim() : ''
  if (!validId(bookId) || !name || name.length > 50) return failure('账本标识或模板名称不对')
  var normalized = normalizeWeights(weights, true)
  if (normalized.error) return failure(normalized.error)
  var root = clone(readRoot())
  var book = bookState(root, bookId, true)
  if (book.templates.length >= MAX_TEMPLATES) return failure('模板数量已达上限，请先删除不用的模板')
  var item = { id: templateId(), name: name, weights: clone(normalized.weights), createdAt: Date.now() }
  book.templates.push(item)
  if (!writeRoot(root)) return failure('本机保存失败，请检查存储空间后重试')
  return { ok: true, template: clone(item) }
}

function listTemplates(bookId) {
  bookId = typeof bookId === 'string' ? bookId.trim() : ''
  if (!validId(bookId)) return []
  var book = bookState(readRoot(), bookId, false)
  if (!book || !Array.isArray(book.templates)) return []
  var seen = map()
  return book.templates.map(normalizeTemplate).filter(function (item) {
    if (!item || seen[item.id]) return false
    seen[item.id] = true
    return true
  }).sort(function (a, b) { return b.createdAt - a.createdAt || a.id.localeCompare(b.id) })
}

function deleteTemplate(bookId, id) {
  bookId = typeof bookId === 'string' ? bookId.trim() : ''
  id = typeof id === 'string' ? id.trim() : ''
  if (!validId(bookId) || !validId(id)) return failure('账本标识或模板标识不对')
  var root = clone(readRoot())
  var book = bookState(root, bookId, true)
  var index = -1
  for (var i = 0; i < book.templates.length; i++) {
    if (book.templates[i] && book.templates[i].id === id) { index = i; break }
  }
  if (index < 0) return failure('模板不存在或已删除')
  book.templates.splice(index, 1)
  if (!writeRoot(root)) return failure('本机保存失败，请检查存储空间后重试')
  return { ok: true, id: id }
}

function applyTemplate(bookId, ym, id) {
  bookId = typeof bookId === 'string' ? bookId.trim() : ''
  id = typeof id === 'string' ? id.trim() : ''
  if (!validId(bookId) || !validYm(ym) || !validId(id)) return failure('账本标识、月份或模板标识不对')
  var root = clone(readRoot())
  var book = bookState(root, bookId, false)
  var item = book && Array.isArray(book.templates) ? book.templates.map(normalizeTemplate).filter(function (template) {
    return template && template.id === id
  })[0] : null
  if (!item) return failure('模板不存在或已删除')
  var month = monthState(root, bookId, ym, true)
  month.weights = clone(item.weights)
  if (!writeRoot(root)) return failure('本机保存失败，请检查存储空间后重试')
  return { ok: true, weights: clone(item.weights), template: clone(item) }
}

function saveWeights(bookId, ym, weights) {
  bookId = typeof bookId === 'string' ? bookId.trim() : ''
  if (!validId(bookId) || !validYm(ym)) return failure('账本标识或月份格式不对')
  var normalized = normalizeWeights(weights, true)
  if (normalized.error) return failure(normalized.error)
  var root = clone(readRoot())
  var month = monthState(root, bookId, ym, true)
  month.weights = clone(normalized.weights)
  if (!writeRoot(root)) return failure('本机保存失败，请检查存储空间后重试')
  return { ok: true, weights: clone(normalized.weights) }
}

function toggleSettled(bookId, ym, transfer) {
  bookId = typeof bookId === 'string' ? bookId.trim() : ''
  if (!validId(bookId) || !validYm(ym)) return failure('账本标识或月份格式不对')
  var item = normalizeTransfer(transfer)
  if (!item) return failure('转账标识无效：需提供双方、正整数分金额')
  var root = clone(readRoot())
  var month = monthState(root, bookId, ym, true)
  var id = transferId(item)
  var index = -1
  for (var i = 0; i < month.settled.length; i++) {
    var current = normalizeTransfer(month.settled[i])
    if (current && transferId(current) === id) { index = i; break }
  }
  var action = index >= 0 ? 'unsettle' : 'settle'
  var now = Date.now()
  if (index >= 0) month.settled.splice(index, 1)
  else month.settled.push({ from: item.from, to: item.to, amount: item.amount, settledAt: now })

  var book = root.books[bookId]
  if (!Array.isArray(book.history)) book.history = []
  book.history.push({
    time: now, ym: ym, from: item.from, to: item.to, amount: item.amount, action: action,
    fromName: typeof transfer.fromName === 'string' ? transfer.fromName.trim().slice(0, 100) : '',
    toName: typeof transfer.toName === 'string' ? transfer.toName.trim().slice(0, 100) : ''
  })
  if (book.history.length > MAX_HISTORY) book.history = book.history.slice(-MAX_HISTORY)
  if (!writeRoot(root)) return failure('本机保存失败，请检查存储空间后重试')
  return { ok: true, action: action, settled: action === 'settle' }
}

function history(bookId, limit) {
  bookId = typeof bookId === 'string' ? bookId.trim() : ''
  if (!validId(bookId)) return []
  var count = Number(limit)
  if (!Number.isFinite(count) || count <= 0) count = 50
  count = Math.min(MAX_HISTORY, Math.floor(count))
  var root = readRoot()
  var book = Object.prototype.hasOwnProperty.call(root.books, bookId) ? root.books[bookId] : null
  if (!object(book) || !Array.isArray(book.history)) return []
  var rows = []
  for (var i = book.history.length - 1; i >= 0 && rows.length < count; i--) {
    var item = normalizeHistory(book.history[i])
    if (item) rows.push(item)
  }
  return rows
}

function exportData() { return clone(readRoot()) }

function normalizeBackup(payload) {
  if (!object(payload) || payload.version !== VERSION || !object(payload.books)) return failure('结算备份格式不对或版本不支持')
  var root = emptyRoot()
  var bookIds = Object.keys(payload.books)
  if (bookIds.length > 100) return failure('结算备份账本数量超限')
  var counts = { books: 0, weights: 0, categoryWeights: 0, templates: 0, settled: 0, history: 0 }
  for (var b = 0; b < bookIds.length; b++) {
    var bookId = bookIds[b]
    var rawBook = payload.books[bookId]
    if (!validId(bookId) || !object(rawBook) || !object(rawBook.months) || !Array.isArray(rawBook.history)) return failure('结算备份账本格式不对')
    var book = { months: {}, history: [], templates: [] }
    Object.defineProperty(root.books, bookId, { value: book, enumerable: true, writable: true, configurable: true })
    if (rawBook.templates !== undefined) {
      if (!Array.isArray(rawBook.templates) || rawBook.templates.length > MAX_TEMPLATES) return failure('结算备份模板格式不对或数量超限')
      var templateIds = map()
      for (var t = 0; t < rawBook.templates.length; t++) {
        var template = normalizeTemplate(rawBook.templates[t])
        if (!template || templateIds[template.id]) return failure('结算备份模板格式不对')
        templateIds[template.id] = true
        book.templates.push(template)
      }
    }
    var months = Object.keys(rawBook.months)
    if (months.length > 1200) return failure('结算备份月份数量超限')
    for (var m = 0; m < months.length; m++) {
      var ym = months[m]
      var rawMonth = rawBook.months[ym]
      if (!validYm(ym) || !object(rawMonth) || !object(rawMonth.weights) || !Array.isArray(rawMonth.settled)) return failure('结算备份月份格式不对')
      var normalized = normalizeWeights(rawMonth.weights, true)
      if (normalized.error) return failure(ym + '：' + normalized.error)
      var categoryWeights = normalizeCategoryWeights(rawMonth.categoryWeights === undefined ? {} : rawMonth.categoryWeights, true)
      if (categoryWeights.error) return failure(ym + '：' + categoryWeights.error)
      var settled = []
      var seen = map()
      for (var s = 0; s < rawMonth.settled.length; s++) {
        var transfer = normalizeTransfer(rawMonth.settled[s])
        var id = transfer && transferId(transfer)
        if (!transfer) return failure(ym + '：已结清转账格式不对')
        if (!seen[id]) { seen[id] = true; settled.push(transfer) }
      }
      if (settled.length > 1000) return failure(ym + '：已结清转账数量超限')
      Object.defineProperty(book.months, ym, {
        value: { weights: clone(normalized.weights), categoryWeights: clone(categoryWeights.weights), settled: settled }, enumerable: true, writable: true, configurable: true
      })
      counts.weights += Object.keys(normalized.weights).length
      counts.categoryWeights += Object.keys(categoryWeights.weights).length
      counts.settled += settled.length
    }
    counts.templates += book.templates.length
    if (rawBook.history.length > MAX_HISTORY) return failure('结算备份历史数量超限')
    for (var h = 0; h < rawBook.history.length; h++) {
      var event = normalizeHistory(rawBook.history[h])
      if (!event) return failure('结算备份历史格式不对')
      book.history.push(event)
    }
    counts.history += book.history.length
    counts.books++
  }
  return { ok: true, root: root, imported: counts }
}

function importData(payload) {
  var normalized = normalizeBackup(payload)
  if (!normalized.ok) return normalized
  if (!writeRoot(normalized.root)) return failure('本机保存失败，请检查存储空间后重试')
  return { ok: true, imported: normalized.imported }
}

/* 账本恢复使用合并计划：月份默认权重以备份为准，分类覆盖按分类合并、备份优先，
   模板按 id 合并、备份优先；已结清记录取并集，历史去重合并。旧备份缺少新字段时可恢复。
   只验证和计算，不写盘；由 store.saveChanges 统一提交并参与回滚。 */
function planImport(payload) {
  var normalized = normalizeBackup(payload)
  if (!normalized.ok) return normalized
  var current = readRoot()
  var incoming = normalized.root
  var merged = emptyRoot()
  var bookIds = Object.keys(current.books).concat(Object.keys(incoming.books).filter(function (id) {
    return !Object.prototype.hasOwnProperty.call(current.books, id)
  }))
  for (var b = 0; b < bookIds.length; b++) {
    var bookId = bookIds[b]
    var oldBook = Object.prototype.hasOwnProperty.call(current.books, bookId) && object(current.books[bookId])
      ? current.books[bookId] : { months: {}, history: [] }
    var newBook = Object.prototype.hasOwnProperty.call(incoming.books, bookId) ? incoming.books[bookId] : { months: {}, history: [] }
    var book = { months: {}, history: [], templates: [] }
    var templateMap = map()
    ;(Array.isArray(oldBook.templates) ? oldBook.templates : []).concat(Array.isArray(newBook.templates) ? newBook.templates : []).forEach(function (raw) {
      var item = normalizeTemplate(raw)
      if (item) templateMap[item.id] = item
    })
    book.templates = Object.keys(templateMap).map(function (id) { return templateMap[id] })
      .sort(function (a, b) { return a.createdAt - b.createdAt || a.id.localeCompare(b.id) })
    var oldMonths = object(oldBook.months) ? oldBook.months : {}
    var newMonths = object(newBook.months) ? newBook.months : {}
    var months = Object.keys(oldMonths).concat(Object.keys(newMonths).filter(function (ym) {
      return !Object.prototype.hasOwnProperty.call(oldMonths, ym)
    }))
    for (var m = 0; m < months.length; m++) {
      var ym = months[m]
      var oldMonth = Object.prototype.hasOwnProperty.call(oldMonths, ym) && object(oldMonths[ym])
        ? oldMonths[ym] : { weights: {}, settled: [] }
      var newMonth = Object.prototype.hasOwnProperty.call(newMonths, ym) && object(newMonths[ym])
        ? newMonths[ym] : { weights: {}, settled: [] }
      var settled = []
      var seen = map()
      ;(oldMonth.settled || []).concat(newMonth.settled || []).forEach(function (raw) {
        var item = normalizeTransfer(raw)
        var id = item && transferId(item)
        if (item && !seen[id]) { seen[id] = true; settled.push(item) }
      })
      var categoryMap = map()
      ;[oldMonth.categoryWeights || {}, newMonth.categoryWeights || {}].forEach(function (source) {
        var normalized = normalizeCategoryWeights(source, false).weights
        Object.keys(normalized).forEach(function (name) { categoryMap[name] = clone(normalized[name]) })
      })
      Object.defineProperty(book.months, ym, {
        value: {
          weights: clone(Object.keys(newMonth.weights || {}).length ? newMonth.weights : oldMonth.weights || {}),
          categoryWeights: clone(categoryMap),
          settled: settled
        },
        enumerable: true, writable: true, configurable: true
      })
    }
    var historyMap = map()
    ;(Array.isArray(oldBook.history) ? oldBook.history : []).concat(Array.isArray(newBook.history) ? newBook.history : []).forEach(function (raw) {
      var item = normalizeHistory(raw)
      if (item) historyMap[JSON.stringify(item)] = item
    })
    book.history = Object.keys(historyMap).map(function (key) { return historyMap[key] })
      .sort(function (a, z) { return a.time - z.time }).slice(-MAX_HISTORY)
    Object.defineProperty(merged.books, bookId, { value: book, enumerable: true, writable: true, configurable: true })
  }
  return { ok: true, value: merged }
}

module.exports = {
  KEY: KEY,
  load: load,
  saveWeights: saveWeights,
  saveCategoryWeights: saveCategoryWeights,
  removeCategoryWeights: removeCategoryWeights,
  saveTemplate: saveTemplate,
  listTemplates: listTemplates,
  deleteTemplate: deleteTemplate,
  applyTemplate: applyTemplate,
  toggleSettled: toggleSettled,
  history: history,
  exportData: exportData,
  importData: importData,
  planImport: planImport
}
