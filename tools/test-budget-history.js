// node tools/test-budget-history.js
var assert = require('assert')
var fs = require('fs')
var path = require('path')
var storage = Object.create(null)
var writes = 0
var failKey = ''
var clipboard = ''
var toasts = []
var titles = []
var themeListener = null
var stopped = false

function copy(value) { return JSON.parse(JSON.stringify(value)) }
function reset() {
  Object.keys(storage).forEach(function (key) { delete storage[key] })
  writes = 0
  failKey = ''
  clipboard = ''
  toasts = []
  titles = []
  themeListener = null
  stopped = false
}

global.wx = {
  getStorageSync: function (key) { return Object.prototype.hasOwnProperty.call(storage, key) ? copy(storage[key]) : '' },
  setStorageSync: function (key, value) {
    writes++
    if (failKey === key) throw new Error('injected storage failure')
    storage[key] = copy(value)
  },
  removeStorageSync: function (key) { delete storage[key] },
  showToast: function (options) { toasts.push(options.title) },
  setClipboardData: function (options) {
    clipboard = options.data
    if (options.success) options.success()
  },
  setNavigationBarTitle: function (options) { titles.push(options.title) },
  getAppBaseInfo: function () { return { theme: 'light' } },
  onThemeChange: function (listener) { themeListener = listener },
  offThemeChange: function () { stopped = true }
}

var history = require('../utils/budget-history')
var store = require('../utils/store')
var format = require('../utils/format')
var passed = 0
var failed = 0

function test(name, fn) {
  reset()
  try {
    store.reload()
    fn()
    passed++
    console.log('PASS ' + name)
  } catch (err) {
    failed++
    console.error('FAIL ' + name + '\n' + err.stack)
  }
}

test('record stores month snapshots in cents and overwrites the same month', function () {
  assert.strictEqual(history.KEY, 'budget_history_v1')
  assert.strictEqual(history.MAX_MONTHS, 120)
  var first = history.record('2026-01', '100.10', { '餐饮': '20.20', '交通': 0 }, 100)
  assert.deepStrictEqual(first, { budget: 100.1, catBudgets: { '餐饮': 20.2, '交通': 0 }, updatedAt: 100 })
  assert.deepStrictEqual(storage[history.KEY], { '2026-01': first })
  history.record('2026-02', 200, { '餐饮': 50 }, 200)
  var latest = history.record('2026-01', 300.05, { '餐饮': 80.01 }, 300)
  assert.strictEqual(history.list().length, 2)
  assert.deepStrictEqual(history.list().map(function (item) { return item.updatedAt }), [200, 300])
  assert.deepStrictEqual(history.get('2026-01'), latest)
  assert.strictEqual(history.get('2026-02').budget, 200)
  assert.strictEqual(history.get('2026-13'), null)
  assert.strictEqual(history.get(null), null)
  assert.deepStrictEqual(history.list(1).map(function (item) { return item.updatedAt }), [200])
  assert.deepStrictEqual(history.list(999), history.list())
  assert.deepStrictEqual(history.list(0), [])
  assert.deepStrictEqual(history.list('bad'), [])
  first.catBudgets['餐饮'] = 999
  latest.budget = 1
  assert.strictEqual(history.get('2026-01').budget, 300.05)
  assert.strictEqual(history.get('2026-01').catBudgets['餐饮'], 80.01)
})

test('retention keeps the newest 120 calendar months', function () {
  for (var i = 0; i < 121; i++) {
    var ym = format.shiftMonth('2000-01', i)
    assert.ok(history.record(ym, i + 1, {}, i + 1))
  }
  var rows = history.list()
  assert.strictEqual(rows.length, 120)
  assert.strictEqual(Object.keys(storage[history.KEY]).length, 120)
  assert.strictEqual(history.get('2000-01'), null)
  assert.strictEqual(history.get('2000-02').budget, 2)
  assert.strictEqual(rows[0].budget, 121)
  history.record('2000-02', 500, {}, 999)
  assert.strictEqual(history.get('2000-01'), null)
  assert.strictEqual(history.get('2000-02').updatedAt, 999)
  assert.strictEqual(history.list().length, 120)
})

test('diff compares current minus historical for totals and the category union', function () {
  history.record('2026-03', 100, { '餐饮': 30, '交通': 20 }, 1)
  var result = history.diff('2026-03', 120, { '餐饮': 50, '旅行': 10 })
  assert.strictEqual(result.historicalBudget, 100)
  assert.strictEqual(result.currentBudget, 120)
  assert.strictEqual(result.budgetDiff, 20)
  assert.deepStrictEqual(result.categories, [
    { category: '餐饮', budget: 30, currentBudget: 50, diff: 20 },
    { category: '交通', budget: 20, currentBudget: 0, diff: -20 },
    { category: '旅行', budget: 0, currentBudget: 10, diff: 10 }
  ])
  assert.deepStrictEqual(result.currentCatBudgets, { '餐饮': 50, '旅行': 10 })
  assert.strictEqual(history.diff('2026-04', 120, {}), null)
  assert.strictEqual(history.diff('2026-03', '120.001', {}), null)
  assert.strictEqual(history.diff('2026-03', 120, { '工资': 1 }), null)
})

test('invalid months, amounts, categories and times never write', function () {
  var badRecords = [
    ['2026-1', 1, {}], ['2026-13', 1, {}], [null, 1, {}], ['2026-01', -1, {}],
    ['2026-01', '1.001', {}], ['2026-01', '1e2', {}], ['2026-01', true, {}],
    ['2026-01', Infinity, {}], ['2026-01', history.AMOUNT_MAX + 0.01, {}],
    ['2026-01', 1, null], ['2026-01', 1, []], ['2026-01', 1, { '工资': 1 }],
    ['2026-01', 1, { '餐饮': -0.01 }], ['2026-01', 1, { '餐饮': '0.001' }],
    ['2026-01', 1, {}, 'bad'], ['2026-01', 1, {}, -1], ['2026-01', 1, {}, 1.5]
  ]
  badRecords.forEach(function (args) { assert.strictEqual(history.record.apply(null, args), null) })
  assert.strictEqual(writes, 0)
  assert.strictEqual(storage[history.KEY], undefined)
  assert.ok(history.record('2026-01', 0, {}, 0))
})

test('legacy snapshots and malformed stored rows are handled safely', function () {
  storage[history.KEY] = {
    '2025-01': { monthlyBudget: '12.34', categoryBudgets: { '餐饮': '2.30' }, time: '5' },
    '2025-02': {},
    '2025-03': { budget: '1.001', catBudgets: {} },
    '2025-04': { budget: 1, catBudgets: { '不存在': 2 } },
    'bad': { budget: 1, catBudgets: {} }
  }
  var rows = history.list()
  assert.strictEqual(rows.length, 2)
  assert.deepStrictEqual(rows[0], { ym: '2025-02', budget: 0, catBudgets: {}, updatedAt: 0 })
  assert.deepStrictEqual(rows[1], { ym: '2025-01', budget: 12.34, catBudgets: { '餐饮': 2.3 }, updatedAt: 5 })
  assert.strictEqual(history.diff('2025-02', 0, {}).budgetDiff, 0)
  failKey = history.KEY
  assert.strictEqual(history.record('2026-01', 10, {}, 10), null)
  assert.strictEqual(history.list().length, 2)
})

test('export and pure import plan round-trip, merge and keep newer snapshots', function () {
  history.record('2026-01', 100, { '餐饮': 10 }, 10)
  history.record('2026-02', 150, {}, 20)
  var backup = JSON.parse(JSON.stringify(history.exportData()))
  assert.strictEqual(backup.kind, 'budget_history')
  assert.strictEqual(backup.version, 1)
  assert.strictEqual(backup.key, history.KEY)
  assert.deepStrictEqual(backup.items, storage[history.KEY])
  backup.items['2026-01'] = { budget: 200, catBudgets: { '餐饮': 20 }, updatedAt: 30 }
  backup.items['2025-12'] = { budget: 50, catBudgets: {}, updatedAt: 5 }
  var beforeWrites = writes
  var plan = history.planImport(backup)
  assert.strictEqual(writes, beforeWrites, 'planImport 不写盘')
  assert.strictEqual(plan.ok, true)
  assert.strictEqual(plan.added, 1)
  assert.strictEqual(plan.updated, 2)
  assert.strictEqual(plan.total, 3)
  assert.strictEqual(plan.changes.length, 1)
  assert.strictEqual(plan.changes[0].key, history.KEY)
  assert.strictEqual(history.get('2026-01').budget, 100)
  plan.changes.forEach(function (change) { wx.setStorageSync(change.key, change.value) })
  assert.strictEqual(history.get('2026-01').budget, 200)
  assert.strictEqual(history.get('2026-02').budget, 150)
  assert.strictEqual(history.get('2025-12').budget, 50)
  var afterWrites = writes
  var older = history.planImport({ items: { '2026-01': { budget: 1, catBudgets: {}, updatedAt: 15 } } })
  assert.strictEqual(older.skipped, 1)
  assert.strictEqual(older.changes.length, 0)
  assert.strictEqual(writes, afterWrites)
  var legacy = history.planImport({ history: {
    '2025-11': { monthlyBudget: '88.88' },
    '2025-10': { budget: 0 }
  } })
  assert.strictEqual(legacy.added, 2)
  assert.strictEqual(legacy.value['2025-11'].updatedAt, 0)
  assert.deepStrictEqual(legacy.value['2025-10'].catBudgets, {})
})

test('import rejects malformed payloads and enforces the 120-month cap', function () {
  ;[null, 'bad', [], { kind: 'other', items: {} }, { version: 2, items: {} },
    { items: { '2026-01': { budget: -1 } } },
    { items: { '2026-01': { budget: 1, catBudgets: { '工资': 1 } } } },
    { items: { bad: { budget: 1 } } }].forEach(function (payload) {
    if (Array.isArray(payload)) return
    assert.throws(function () { history.planImport(payload) }, /预算历史备份格式不对/)
  })
  var rows = {}
  for (var i = 0; i < 130; i++) rows[format.shiftMonth('2000-01', i)] = { budget: i, updatedAt: i }
  var plan = history.planImport(rows)
  assert.strictEqual(plan.total, 120)
  assert.strictEqual(Object.keys(plan.value).length, 120)
  assert.strictEqual(plan.value['2000-01'], undefined)
  assert.strictEqual(plan.value['2000-11'].budget, 10)
  assert.strictEqual(writes, 0)
})

var pageDefinition
global.Page = function (definition) { pageDefinition = definition }
require('../pages/budget-history/budget-history.js')

function pageInstance() {
  var page = Object.assign({}, pageDefinition, { data: copy(pageDefinition.data) })
  page.setData = function (patch, callback) {
    Object.assign(this.data, patch)
    if (callback) callback()
  }
  return page
}

test('page shows empty state, archives current budget, compares and copies text', function () {
  var page = pageInstance()
  page.onLoad()
  page.onShow()
  assert.strictEqual(titles[titles.length - 1], '历史预算存档')
  assert.strictEqual(page.data.hasHistory, false)
  assert.strictEqual(page.data.currentMonth, format.ymOf(Date.now()))
  storage.budget_v1 = 300
  storage.budcats_v1 = { '餐饮': 100, '交通': 20 }
  store.reload()
  page.saveCurrent()
  assert.strictEqual(page.data.saving, false)
  assert.strictEqual(page.data.hasHistory, true)
  assert.strictEqual(page.data.items.length, 1)
  assert.strictEqual(page.data.items[0].budgetText, '¥300.00')
  assert.strictEqual(page.data.items[0].currentBudgetText, '¥300.00')
  assert.strictEqual(page.data.items[0].categories.length, 2)
  assert.strictEqual(page.data.items[0].budgetDiffText, '¥0.00')
  storage.budget_v1 = 350
  storage.budcats_v1 = { '餐饮': 120 }
  store.reload()
  page.refresh()
  assert.strictEqual(page.data.items[0].budgetDiffText, '¥50.00')
  assert.strictEqual(page.data.items[0].categoryDiffs.length, 2)
  page.copyHistory({ currentTarget: { dataset: { ym: page.data.items[0].ym } } })
  assert.ok(clipboard.indexOf('历史预算存档') >= 0)
  assert.ok(clipboard.indexOf('总预算差异（当前 − 历史）：¥50.00') >= 0)
  assert.ok(clipboard.indexOf('餐饮') >= 0 && clipboard.indexOf('交通') >= 0)
  assert.strictEqual(toasts[toasts.length - 1], '历史预算已复制')
  page.saveCurrent()
  assert.strictEqual(page.data.items.length, 1, '同月存档覆盖而不是追加')
  assert.strictEqual(history.get(page.data.currentMonth).budget, 350)
})

test('page follows theme changes, reports failures and unregisters watcher', function () {
  var page = pageInstance()
  page.onLoad()
  page.onShow()
  assert.strictEqual(page.data.dark, false)
  themeListener({ theme: 'dark' })
  assert.strictEqual(page.data.dark, true)
  failKey = history.KEY
  page.saveCurrent()
  assert.strictEqual(page.data.saving, false)
  assert.strictEqual(toasts[toasts.length - 1], '存档失败：请检查预算数据或本机空间')
  page.onUnload()
  assert.strictEqual(stopped, true)
})

test('page templates expose timeline, empty state, differences, copy, theme and safe area', function () {
  var base = path.resolve(__dirname, '../pages/budget-history/budget-history')
  var wxml = fs.readFileSync(base + '.wxml', 'utf8')
  var wxss = fs.readFileSync(base + '.wxss', 'utf8')
  assert.ok(wxml.indexOf('/pages/budget-history/budget-history') < 0, '页面文件不内嵌路由配置')
  assert.ok(wxml.indexOf('theme-{{themeKey}}') >= 0)
  assert.ok(wxml.indexOf("{{dark ? 'dark' : ''}}") >= 0)
  assert.ok(wxml.indexOf('bindtap="saveCurrent"') >= 0)
  assert.ok(wxml.indexOf('bindtap="copyHistory"') >= 0)
  assert.ok(wxml.indexOf('wx:if="{{!hasHistory}}"') >= 0)
  assert.ok(wxml.indexOf('历史分类预算') >= 0 && wxml.indexOf('与当前分类预算的差异') >= 0)
  assert.ok(wxss.indexOf('env(safe-area-inset-top)') >= 0)
  assert.ok(wxss.indexOf('env(safe-area-inset-bottom)') >= 0)
  assert.ok(wxss.indexOf('.bh-page.dark') >= 0)
})

console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项')
if (failed) process.exitCode = 1
