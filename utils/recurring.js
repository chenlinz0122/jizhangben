/* 周期账单：本地规则 + 用户点击后入账。这里不注册定时任务，也不做后台推送。
 * 所有日期都是本地日历日（YYYY-MM-DD）；月付 31 号在短月落到月末，
 * 周付 0=周日，年付沿用开始日期的月日，2 月 29 日在平年落到 2 月 28 日。
 */
var format = require('./format')
var config = require('./config')
var KEY = 'recurring_v1'
var REMINDER_KEY = 'recurring_reminder_v1'
var DEFAULT_LEAD_DAYS = 3
var TYPES = ['expense', 'income', 'transfer']
var INTERVALS = ['month', 'week', 'year']

function pad(n) { return n < 10 ? '0' + n : String(n) }

function dayOf(date) {
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

function parseDay(value) {
  if (value instanceof Date) value = dayOf(value)
  if (typeof value === 'number') value = format.dayOf(value)
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''))
  if (!m) return null
  var y = Number(m[1])
  var mo = Number(m[2])
  var d = Number(m[3])
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > 31) return null
  var date = new Date(0)
  date.setFullYear(y, mo - 1, d)
  date.setHours(12, 0, 0, 0)
  if (date.getFullYear() !== y || date.getMonth() + 1 !== mo || date.getDate() !== d) return null
  return date
}

function monthEnd(year, month) {
  var d = new Date(0)
  d.setFullYear(year, month + 1, 0)
  d.setHours(12, 0, 0, 0)
  return d.getDate()
}

function inMonth(year, month, wanted) {
  var d = new Date(0)
  d.setFullYear(year, month, Math.min(wanted, monthEnd(year, month)))
  d.setHours(12, 0, 0, 0)
  return d
}

function advance(date, interval, wantedDay) {
  if (interval === 'week') {
    var week = new Date(date.getTime())
    week.setDate(week.getDate() + 7)
    return week
  }
  var day = wantedDay || date.getDate()
  return interval === 'year'
    ? inMonth(date.getFullYear() + 1, date.getMonth(), day)
    : inMonth(date.getFullYear(), date.getMonth() + 1, day)
}

function scheduledOn(start, interval, dayOfMonth, dayOfWeek) {
  if (interval === 'week') {
    var delta = (dayOfWeek - start.getDay() + 7) % 7
    var week = new Date(start.getTime())
    week.setDate(week.getDate() + delta)
    return week
  }
  if (interval === 'month') return inMonth(start.getFullYear(), start.getMonth(), dayOfMonth)
  return inMonth(start.getFullYear(), start.getMonth(), dayOfMonth)
}

function firstOnOrAfter(from, interval, dayOfMonth, dayOfWeek) {
  var date = scheduledOn(from, interval, dayOfMonth, dayOfWeek)
  if (date < from) date = scheduledOn(advance(from, interval, dayOfMonth), interval, dayOfMonth, dayOfWeek)
  return dayOf(date)
}

function text(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max || 200)
}

function integer(value) {
  if (value === '' || value === null || value === undefined) return null
  var n = Number(value)
  return isFinite(n) && Math.floor(n) === n ? n : null
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function configuredReminderTemplateId() {
  try {
    var value = config && config.REMINDER ? config.REMINDER.recurringTemplateId : ''
    return value == null ? '' : String(value).trim().slice(0, 128)
  } catch (e) { return '' }
}

function reminderLeadDays(value, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return null
  var days = Number(value)
  return isFinite(days) && Math.floor(days) === days && days >= 0 && days <= 7 ? days : null
}

function reminderSubscribedAt(value) {
  if (value === undefined) return 0
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return null
  var at = Number(value)
  return isFinite(at) && Math.floor(at) === at && at >= 0 && at <= 9007199254740991 ? at : null
}

function normalizeReminderPrefs(raw) {
  raw = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  var leadDays = reminderLeadDays(raw.leadDays, DEFAULT_LEAD_DAYS)
  var subscribedAt = reminderSubscribedAt(raw.subscribedAt)
  return {
    enabled: raw.enabled === true,
    leadDays: leadDays === null ? DEFAULT_LEAD_DAYS : leadDays,
    subscribedAt: subscribedAt === null ? 0 : subscribedAt,
    templateId: configuredReminderTemplateId()
  }
}

function readReminderPrefs() {
  var value
  try { value = wx.getStorageSync(REMINDER_KEY) } catch (e) { value = null }
  return normalizeReminderPrefs(value)
}

/* 偏好单独存储，不回写周期账单备份；模板 ID 只认 config，避免保存过期模板。 */
function getReminderPrefs() {
  return readReminderPrefs()
}

function saveReminderPrefs(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return null
  var next = readReminderPrefs()
  if (hasOwn(patch, 'enabled')) {
    if (typeof patch.enabled !== 'boolean') return null
    next.enabled = patch.enabled
  }
  if (hasOwn(patch, 'leadDays')) {
    var leadDays = reminderLeadDays(patch.leadDays, null)
    if (leadDays === null) return null
    next.leadDays = leadDays
  }
  if (hasOwn(patch, 'subscribedAt')) {
    var subscribedAt = reminderSubscribedAt(patch.subscribedAt)
    if (subscribedAt === null) return null
    next.subscribedAt = subscribedAt
  }
  next.templateId = configuredReminderTemplateId()
  try {
    wx.setStorageSync(REMINDER_KEY, next)
    return next
  } catch (e) { return null }
}

/* 读出时隔离坏行；可补的字段（如下一期、星期）按开始日期修复。
 * 核心字段（id/名称/类型/金额/周期/开始日期）坏了就整行忽略，不让页面崩溃。 */
function normalize(raw, generatedId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  var id = text(raw.id, 128) || text(generatedId, 128)
  var name = text(raw.name, 80)
  var amount = Number(raw.amount)
  var type = text(raw.type, 20)
  var interval = text(raw.interval, 10)
  var start = parseDay(raw.startDate)
  if (!id || !name || TYPES.indexOf(type) < 0 || INTERVALS.indexOf(interval) < 0 ||
      !isFinite(amount) || amount <= 0 || !start) return null

  var cents = Math.round(amount * 100)
  if (cents <= 0) return null
  var dom = integer(raw.dayOfMonth)
  var dow = integer(raw.dayOfWeek)
  if (dom === null || dom < 1 || dom > 31) dom = start.getDate()
  if (dow === null || dow < 0 || dow > 6) dow = start.getDay()
  var next = parseDay(raw.nextDate)
  if (!next || next < start) next = scheduledOn(start, interval, dom, dow)
  if (next < start) next = scheduledOn(advance(start, interval), interval, dom, dow)
  var skipped = {}
  var sourceSkipped = raw.skipped && typeof raw.skipped === 'object' && !Array.isArray(raw.skipped) ? raw.skipped : {}
  Object.keys(sourceSkipped).forEach(function (date) {
    if (sourceSkipped[date] === true && parseDay(date)) skipped[date] = true
  })
  var last = text(raw.lastGenerated, 10)
  return {
    id: id,
    name: name,
    type: type,
    category: text(raw.category, 80) || '未分类',
    amount: cents / 100,
    merchant: text(raw.merchant, 120),
    note: text(raw.note, 500),
    accountId: text(raw.accountId, 120),
    fromAccountId: text(raw.fromAccountId, 120),
    toAccountId: text(raw.toAccountId, 120),
    interval: interval,
    dayOfMonth: dom,
    dayOfWeek: dow,
    startDate: dayOf(start),
    nextDate: dayOf(next),
    enabled: raw.enabled !== false,
    lastGenerated: parseDay(last) ? last : '',
    skipped: skipped
  }
}

function readAll() {
  var value
  try { value = wx.getStorageSync(KEY) } catch (e) { return [] }
  if (!Array.isArray(value)) return []
  var seen = Object.create(null)
  var out = []
  value.forEach(function (raw) {
    var item = normalize(raw)
    if (!item || seen[item.id]) return
    seen[item.id] = true
    out.push(item)
  })
  return out
}

function writeAll(items) {
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
  return 'rc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

function today(options) {
  return options && options.today ? dayOf(parseDay(options.today)) : format.dayOf(Date.now())
}

function list() {
  return readAll()
}

/* 新增或按 id 覆盖。调整周期/起始日/星期时，从今天重新找下一期，避免补出历史账单。
 * 第二参数 today 仅供测试注入日期；正常调用无需传。 */
function save(raw, options) {
  var items = readAll()
  var suppliedId = raw && text(raw.id, 128)
  var at = find(items, suppliedId)
  var input = Object.assign({}, raw || {})
  if (!input.id) input.id = newId()
  var old = at >= 0 ? items[at] : null
  var signature = ['interval', 'startDate', 'dayOfMonth', 'dayOfWeek']
  var changed = old && signature.some(function (key) { return input[key] !== undefined && input[key] !== old[key] })
  if (changed) {
    input.nextDate = null
    /* 让 normalize 用“今天”作为起点；仍然保留用户原来的开始日期。 */
    var from = parseDay(options && options.today ? options.today : format.dayOf(Date.now()))
    input.startDate = input.startDate || old.startDate
    input._scheduleFloor = dayOf(from < parseDay(input.startDate) ? parseDay(input.startDate) : from)
  }
  var item = normalize(input)
  if (!item) return null
  if (changed) item.nextDate = firstOnOrAfter(parseDay(input._scheduleFloor), item.interval, item.dayOfMonth, item.dayOfWeek)
  if (old) items[at] = item
  else items.push(item)
  return writeAll(items) ? item : null
}

function remove(id) {
  var items = readAll()
  var at = find(items, id)
  if (at < 0) return false
  items.splice(at, 1)
  return writeAll(items)
}

function toggle(id, enabled) {
  var items = readAll()
  var at = find(items, id)
  if (at < 0) return null
  items[at].enabled = enabled === undefined ? !items[at].enabled : !!enabled
  return writeAll(items) ? items[at] : null
}

/* 返回 <= asOf+withinDays 的启用项，附加 daysLeft； overdue 也包含在内。 */
function due(asOf, withinDays) {
  var from = parseDay(asOf) || parseDay(format.dayOf(Date.now()))
  var days = withinDays === undefined ? 7 : Number(withinDays)
  if (!isFinite(days) || days < 0) days = 7
  var end = new Date(from.getTime())
  end.setDate(end.getDate() + Math.floor(days))
  return readAll().filter(function (item) {
    if (!item.enabled || item.skipped[item.nextDate]) return false
    var date = parseDay(item.nextDate)
    return date && date <= end
  }).sort(function (a, b) {
    return a.nextDate === b.nextDate ? 0 : (a.nextDate < b.nextDate ? -1 : 1)
  }).map(function (item) {
    var copy = Object.assign({}, item, { skipped: Object.assign({}, item.skipped) })
    copy.dueDate = item.nextDate
    copy.daysLeft = Math.round((parseDay(item.nextDate) - from) / 86400000)
    return copy
  })
}

/* 与 due 共用窗口：包含逾期、今天和 leadDays 内的近期项，不包含停用或已跳过项。 */
function reminderItems(asOf) {
  var prefs = getReminderPrefs()
  return prefs.enabled ? due(asOf, prefs.leadDays) : []
}

function txId(item, date) { return 'r:' + item.id + ':' + date }

function toTransaction(item, date) {
  var at = parseDay(date).getTime()
  var tx = {
    id: txId(item, date),
    time: at,
    day: date,
    ym: date.slice(0, 7),
    type: item.type,
    amount: item.amount,
    category: item.category,
    merchant: item.merchant || item.name || '(周期账单)',
    desc: item.note || item.name,
    note: item.note,
    account: item.type === 'transfer' ? '' : (item.accountId || '周期账单'),
    accountId: item.accountId,
    fromAccount: item.fromAccountId,
    fromAccountId: item.fromAccountId,
    toAccount: item.toAccountId,
    toAccountId: item.toAccountId,
    status: '手动',
    source: '周期账单',
    byPlatform: 'manual',
    recurringId: item.id,
    recurringDate: date
  }
  return tx
}

function fail(item, date, status, error) {
  return { generated: false, duplicate: false, skipped: false, saved: false, item: item, date: date, status: status, error: error || '' }
}

/* 每次调用只处理当前 nextDate 一期。store.addOne 本身不去重，因此先查稳定 id；
 * 流水已写入但规则推进失败时，重试会认领已有流水，不会重复入账。 */
function generateOne(id, periodDate) {
  var items = readAll()
  var at = find(items, id)
  if (at < 0) return fail(null, periodDate || '', 'missing', 'NOT_FOUND')
  var item = items[at]
  var date = periodDate ? text(periodDate, 10) : item.nextDate
  if (!parseDay(date) || date < item.startDate) return fail(item, date, 'invalid-date', 'INVALID_DATE')
  if (!item.enabled) return fail(item, date, 'disabled', 'DISABLED')
  var store = require('./store')
  var ledger
  try { ledger = store.all() } catch (e) { return fail(item, date, 'store-failed', 'STORE_READ_FAILED') }
  if (date !== item.nextDate) {
    if (item.skipped[date]) return fail(item, date, 'skipped')
    var exists = ledger.some(function (tx) { return tx && tx.id === txId(item, date) })
    return exists ? Object.assign(fail(item, date, 'duplicate'), { duplicate: true, saved: true }) : fail(item, date, 'not-current', 'NOT_CURRENT_PERIOD')
  }
  if (item.skipped[date]) {
    item.nextDate = dayOf(advance(parseDay(date), item.interval, item.dayOfMonth))
    return Object.assign(fail(item, date, 'skipped'), { skipped: true, saved: writeAll(items) })
  }

  var wanted = txId(item, date)
  var duplicate = ledger.some(function (tx) { return tx && tx.id === wanted })
  if (!duplicate) {
    var result
    try { result = store.addOne(toTransaction(item, date)) } catch (e) { result = null }
    if (!result || result.saved !== true || result.partial) {
      return fail(item, date, 'store-failed', 'STORE_SAVE_FAILED')
    }
  }
  item.nextDate = dayOf(advance(parseDay(date), item.interval, item.dayOfMonth))
  item.lastGenerated = date
  if (!writeAll(items)) {
    return Object.assign(fail(item, date, duplicate ? 'duplicate' : 'generated', 'RECURRING_SAVE_FAILED'), {
      generated: !duplicate,
      duplicate: duplicate,
      txId: wanted
    })
  }
  return {
    generated: !duplicate,
    duplicate: duplicate,
    skipped: false,
    saved: true,
    item: item,
    date: date,
    txId: wanted,
    status: duplicate ? 'duplicate' : 'generated',
    error: ''
  }
}

/* 为每个到期项补当前一期，不追溯 nextDate 之前的多个历史周期。 */
function generateDue(asOf) {
  var end = parseDay(asOf) || parseDay(format.dayOf(Date.now()))
  var result = { generated: 0, duplicate: 0, skipped: 0, failed: 0, saved: true, items: [] }
  due(end).forEach(function (item) {
    var one = generateOne(item.id)
    result.items.push(one)
    if (one.status === 'generated') result.generated++
    else if (one.status === 'duplicate') result.duplicate++
    else if (one.status === 'skipped') result.skipped++
    else result.failed++
    if (!one.saved) result.saved = false
  })
  return result
}

function skipNext(id) {
  var items = readAll()
  var at = find(items, id)
  if (at < 0) return null
  var item = items[at]
  if (item.skipped[item.nextDate]) return item
  item.skipped[item.nextDate] = true
  item.nextDate = dayOf(advance(parseDay(item.nextDate), item.interval, item.dayOfMonth))
  return writeAll(items) ? item : null
}

function exportData() {
  return {
    app: '通用记账Book',
    kind: 'recurring',
    version: 1,
    exportedAt: Date.now(),
    items: list()
  }
}

/* 合并恢复，不清空现有周期项；同 id 以备份为准，坏行跳过。 */
function importData(payload) {
  var rows = payload
  if (payload && !Array.isArray(payload)) {
    if (payload.kind !== 'recurring' || payload.version !== 1 || !Array.isArray(payload.items)) {
      throw new Error('周期账单备份格式不对')
    }
    rows = payload.items
  }
  if (!Array.isArray(rows)) throw new Error('周期账单备份格式不对')
  var items = readAll()
  var indexes = Object.create(null)
  items.forEach(function (item, i) { indexes[item.id] = i })
  var added = 0
  var updated = 0
  var skipped = 0
  var seen = Object.create(null)
  rows.forEach(function (raw) {
    var item = normalize(raw)
    if (!item || seen[item.id]) { skipped++; return }
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
  var saved = writeAll(items)
  return { saved: saved, added: saved ? added : 0, updated: saved ? updated : 0, skipped: skipped, total: items.length }
}

module.exports = {
  KEY: KEY,
  REMINDER_KEY: REMINDER_KEY,
  normalize: normalize,
  list: list,
  save: save,
  remove: remove,
  toggle: toggle,
  due: due,
  getReminderPrefs: getReminderPrefs,
  saveReminderPrefs: saveReminderPrefs,
  reminderItems: reminderItems,
  generateOne: generateOne,
  generateDue: generateDue,
  skipNext: skipNext,
  exportData: exportData,
  importData: importData
}
