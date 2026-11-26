// node tools/test-annual-report.js
var assert = require('assert')
var fs = require('fs')
var path = require('path')
var annualReport = require('../utils/annual-report')
var health = require('../utils/health')

var passed = 0
var failed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log('PASS ' + name)
  } catch (err) {
    failed++
    console.error('FAIL ' + name + '\n' + err.stack)
  }
}

function tx(id, ym, amount, extra) {
  var row = {
    id: id,
    ym: ym,
    day: ym + '-15',
    time: new Date(ym + '-15T12:00:00').getTime(),
    type: 'expense',
    amount: amount,
    category: '餐饮',
    merchant: '测试商户'
  }
  Object.keys(extra || {}).forEach(function (key) { row[key] = extra[key] })
  return row
}

function cleanScan(count, issues) {
  return { total: count, today: '2026-12-31', largeAmount: 10000, issues: issues || [] }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.keys(value).forEach(function (key) { deepFreeze(value[key]) })
  return Object.freeze(value)
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

test('calculate returns twelve months, totals, extremes, rankings and copyable text', function () {
  var result = annualReport.calculate([
    tx('income', '2026-01', 10000, { type: 'income', category: '工资' }),
    tx('food', '2026-02', 1000),
    tx('refund', '2026-02', 200, { type: 'refund', category: '退款' }),
    tx('transport', '2026-03', 300, { category: '交通' }),
    tx('previous', '2025-12', 999)
  ], { year: 2026, accountNetWorthCents: 123456 })
  assert.strictEqual(result.year, '2026')
  assert.strictEqual(result.months.length, 12)
  assert.strictEqual(result.totals.txCount, 4)
  assert.strictEqual(result.totals.incomeCents, 1000000)
  assert.strictEqual(result.totals.expenseCents, 130000)
  assert.strictEqual(result.totals.refundCents, 20000)
  assert.strictEqual(result.totals.netExpenseCents, 110000)
  assert.strictEqual(result.totals.balanceCents, 890000)
  assert.strictEqual(result.totals.savingsRate, 0.89)
  assert.strictEqual(result.totals.recordedMonths, 3)
  assert.strictEqual(result.totals.averageMonthlyExpenseCents, 36667)
  assert.strictEqual(result.totals.highestExpenseMonth.ym, '2026-02')
  assert.strictEqual(result.totals.lowestExpenseMonth.ym, '2026-01')
  assert.strictEqual(result.months[1].netExpenseText, '¥800.00')
  assert.strictEqual(result.months[0].netExpenseText, '¥0.00')
  assert.strictEqual(result.topCategories[0].name, '餐饮')
  assert.strictEqual(result.topCategories[0].amount, 1000)
  assert.strictEqual(result.topCategories[1].name, '交通')
  assert.strictEqual(result.netWorthCents, 123456)
  assert.strictEqual(result.netWorthTrendAvailable, false)
  ;['年度财务报告', '平均月支出', '支出分类 TOP', '月份明细', '无记录月份不参与趋势判断', '当前净资产快照：¥1,234.56'].forEach(function (part) {
    assert.ok(result.reportText.indexOf(part) >= 0, part)
  })
})

test('cross-year, day-only and time-only dates use the selected year without leaking totals', function () {
  var dayOnly = tx('day', '', 20)
  dayOnly.day = '2026-04-02'
  dayOnly.ym = ''
  var timeOnly = tx('time', '', 30, { category: '交通' })
  timeOnly.day = ''
  timeOnly.time = new Date(2026, 4, 3, 12).getTime()
  var result = annualReport.calculate([
    tx('old', '2025-12', 900), dayOnly, timeOnly,
    tx('new', '2027-01', 800), null, [], 'bad'
  ], { year: '2026' })
  assert.strictEqual(result.totals.txCount, 2)
  assert.strictEqual(result.totals.expenseCents, 5000)
  assert.strictEqual(result.totals.recordedMonths, 2)
  assert.strictEqual(result.months[3].txCount, 1)
  assert.strictEqual(result.months[4].txCount, 1)
  assert.strictEqual(result.months[0].hasData, false)
})

test('empty months stay empty and do not become zero-spend trend observations', function () {
  var result = annualReport.calculate([tx('a', '2026-02', 10)], { year: 2026 })
  assert.strictEqual(result.totals.recordedMonths, 1)
  assert.strictEqual(result.months[0].hasData, false)
  assert.strictEqual(result.months[0].trendHeight, 0)
  assert.strictEqual(result.months[0].trendText, '无记录')
  assert.strictEqual(result.months[1].trendHeight, 100)
  assert.strictEqual(result.totals.highestExpenseMonth.ym, '2026-02')
  assert.strictEqual(result.totals.lowestExpenseMonth.ym, '2026-02')
  var empty = annualReport.calculate([], { year: 2026 })
  assert.strictEqual(empty.hasData, false)
  assert.strictEqual(empty.totals.averageMonthlyExpenseCents, 0)
  assert.strictEqual(empty.totals.highestExpenseMonth, null)
  assert.strictEqual(empty.totals.lowestExpenseMonth, null)
  assert.strictEqual(empty.totals.savingsRate, null)
  assert.strictEqual(empty.health.averageSavingsRate, null)
  assert.strictEqual(empty.health.budgetCents, null)
  assert.strictEqual(empty.months.length, 12)
})

test('refunds occur in their own month, preserve negative net spending and never count as income', function () {
  var result = annualReport.calculate([
    tx('expense', '2026-01', 100),
    tx('refund', '2026-02', 150, { type: 'refund', category: '退款' }),
    tx('transfer', '2026-02', 999, { type: 'transfer', category: '账户转移' })
  ], { year: 2026 })
  assert.strictEqual(result.totals.incomeCents, 0)
  assert.strictEqual(result.totals.expenseCents, 10000)
  assert.strictEqual(result.totals.refundCents, 15000)
  assert.strictEqual(result.totals.netExpenseCents, -5000)
  assert.strictEqual(result.totals.balanceCents, 5000)
  assert.strictEqual(result.totals.savingsRate, null)
  assert.strictEqual(result.months[0].netExpenseCents, 10000)
  assert.strictEqual(result.months[1].netExpenseCents, -15000)
  assert.strictEqual(result.months[1].trendNegative, true)
  assert.strictEqual(result.totals.lowestExpenseMonth.ym, '2026-02')
})

test('category ranking uses gross occurrence amounts with deterministic alphabetical ties', function () {
  var result = annualReport.calculate([
    tx('z', '2026-01', 10, { category: '交通' }),
    tx('a', '2026-01', 10, { category: '餐饮' }),
    tx('b', '2026-02', 5, { category: '餐饮' }),
    tx('r', '2026-02', 3, { type: 'refund', category: '餐饮' }),
    tx('blank', '2026-02', 1, { category: '   ' }),
    tx('income', '2026-02', 500, { type: 'income', category: '工资' })
  ], { year: 2026 })
  assert.deepStrictEqual(result.topCategories.map(function (item) { return item.name }), ['餐饮', '交通', '未分类'])
  assert.strictEqual(result.topCategories[0].expenseCents, 1500)
  assert.strictEqual(result.topCategories[0].refundCents, 300)
  assert.strictEqual(result.topCategories[0].netExpenseCents, 1200)
  assert.strictEqual(result.topCategories[0].pct, 57.7)
  assert.strictEqual(result.topCategories[1].pct, 38.5)
  assert.strictEqual(result.topCategories[2].pct, 3.8)
})

test('budget statistics include only supplied positive budgets, including array input', function () {
  var budgets = []
  budgets[0] = 100
  budgets[2] = { budget: 200 }
  var result = annualReport.calculate([
    tx('income', '2026-01', 1000, { type: 'income' }),
    tx('a', '2026-01', 80),
    tx('b', '2026-02', 999),
    tx('c', '2026-03', 100),
    tx('r', '2026-03', 300, { type: 'refund' })
  ], { year: 2026, budgetByMonth: budgets })
  assert.strictEqual(result.health.budgetMonths, 2)
  assert.strictEqual(result.health.missingBudgetMonths, 10)
  assert.strictEqual(result.health.budgetCents, 30000)
  assert.strictEqual(result.health.budgetNetExpenseCents, 8000)
  assert.strictEqual(result.health.budgetUsage, 8000 / 30000)
  assert.strictEqual(result.health.overBudgetMonths, 0)
  assert.strictEqual(result.months[0].budgetUsage, 0.8)
  assert.strictEqual(result.months[1].budgetProvided, false)
  assert.strictEqual(result.months[2].budgetUsage, 0)
  assert.strictEqual(result.months[2].budgetText.indexOf('¥0.00 / ¥200.00') >= 0, true)
})

test('over-budget and zero/invalid budgets are separated and negative spending is clamped only for usage', function () {
  var result = annualReport.calculate([
    tx('a', '2026-01', 150), tx('b', '2026-02', 10), tx('c', '2026-03', 999)
  ], { year: 2026, budgetByMonth: { '2026-01': 100, '2026-02': 0, '2026-03': 'bad' } })
  assert.strictEqual(result.health.budgetMonths, 1)
  assert.strictEqual(result.health.overBudgetMonths, 1)
  assert.strictEqual(result.health.budgetUsage, 1.5)
  assert.strictEqual(result.months[0].budgetRemainingCents, -5000)
  assert.strictEqual(result.months[1].budgetProvided, false)
})

test('annual health averages monthly savings rates only across months with income', function () {
  var result = annualReport.calculate([
    tx('i1', '2026-01', 100, { type: 'income' }),
    tx('i2', '2026-02', 300, { type: 'income' }),
    tx('e2', '2026-02', 150),
    tx('e3', '2026-03', 500)
  ], { year: 2026 })
  assert.strictEqual(result.health.incomeMonths, 2)
  assert.strictEqual(result.months[0].savingsRate, 1)
  assert.strictEqual(result.months[1].savingsRate, 0.5)
  assert.strictEqual(result.months[2].savingsRate, null)
  assert.strictEqual(result.health.averageSavingsRate, 0.75)
  assert.strictEqual(result.totals.savingsRate, -0.625)
})

test('monthly health scans are summarized, scoped and deduplicated without losing affected transaction counts', function () {
  var a = tx('a', '2026-01', 10, { category: '未分类' })
  var b = tx('b', '2026-01', 10, { category: '未分类' })
  var outside = tx('outside', '2025-12', 10)
  var issue = { key: 'duplicate-one', type: 'duplicate', severity: 'high', txIds: ['a', 'b'], records: [a, b] }
  var fullScan = cleanScan(3, [issue, issue, { key: 'outside', type: 'large', severity: 'medium', txIds: ['outside'], records: [outside] }])
  var result = annualReport.calculate([a, b, outside], {
    year: 2026,
    healthScanByMonth: {
      '2026-01': fullScan,
      '2026-02': cleanScan(0)
    }
  })
  assert.strictEqual(result.health.txCount, 2)
  assert.strictEqual(result.health.issueCount, 1)
  assert.strictEqual(result.health.affectedTxCount, 2)
  assert.strictEqual(result.health.highCount, 1)
  assert.strictEqual(result.health.mediumCount, 0)
  assert.strictEqual(result.health.scanMonths, 2)
  assert.strictEqual(result.health.scanComplete, false)
  assert.strictEqual(result.health.scanReused, true)
  assert.strictEqual(result.health.types[0].label, '疑似重复')
})

test('real health scan fallback is deterministic and reports uncategorized records', function () {
  var rows = [tx('a', '2026-01', 10, { category: '未分类' })]
  var first = annualReport.calculate(rows, { year: 2026 })
  var second = annualReport.calculate(rows, { year: 2026 })
  assert.deepStrictEqual(first, second)
  assert.strictEqual(first.health.scanReused, false)
  assert.strictEqual(first.health.scanMonths, 12)
  assert.strictEqual(first.health.byType.uncategorized, 1)
  assert.strictEqual(first.health.issueCount, 1)
})

test('extreme and invalid amounts stay finite, bounded and deterministic', function () {
  var rows = [
    tx('huge-income', '2026-01', 1e308, { type: 'income' }),
    tx('huge-expense', '2026-01', 1e308),
    tx('huge-expense-two', '2026-02', 1e308),
    tx('nan', '2026-02', NaN),
    tx('infinity', '2026-02', Infinity),
    tx('negative', '2026-02', -10)
  ]
  var options = { year: 2026, budgetByMonth: { '2026-01': 1e308 }, accountNetWorthCents: 1e308 }
  var result = annualReport.calculate(rows, options)
  assert.strictEqual(result.totals.incomeCents, 9007199254740991)
  assert.strictEqual(result.totals.expenseCents, 9007199254740991)
  assert.strictEqual(result.health.budgetCents, 9007199254740991)
  assert.strictEqual(result.netWorthCents, 9007199254740991)
  assert.ok(isFinite(result.health.budgetUsage))
  assert.ok(isFinite(result.topCategories[0].pct))
  assert.strictEqual(JSON.stringify(result).indexOf('NaN') < 0, true)
  assert.strictEqual(JSON.stringify(result).indexOf('Infinity') < 0, true)
  assert.deepStrictEqual(result, annualReport.calculate(rows, options))
})

test('fractional amounts round per transaction to integer cents', function () {
  var result = annualReport.calculate([
    tx('i1', '2026-01', 0.1, { type: 'income' }),
    tx('i2', '2026-01', 0.2, { type: 'income' }),
    tx('e1', '2026-01', 0.1), tx('e2', '2026-01', 0.2),
    tx('r', '2026-01', 0.01, { type: 'refund' })
  ], { year: 2026, budgetByMonth: { '2026-01': 0.29 } })
  assert.strictEqual(result.totals.incomeCents, 30)
  assert.strictEqual(result.totals.expenseCents, 30)
  assert.strictEqual(result.totals.refundCents, 1)
  assert.strictEqual(result.totals.netExpenseCents, 29)
  assert.strictEqual(result.totals.balanceCents, 1)
  assert.strictEqual(result.months[0].budgetCents, 29)
})

test('calculation never mutates frozen transactions or nested options', function () {
  var rows = [tx('a', '2026-01', 10), tx('r', '2026-02', 3, { type: 'refund' })]
  var options = {
    year: 2026,
    budgetByMonth: { '2026-01': { budget: 100 } },
    healthScanByMonth: { '2026-01': cleanScan(1) },
    accountNetWorthCents: 999
  }
  var beforeRows = JSON.stringify(rows)
  var beforeOptions = JSON.stringify(options)
  deepFreeze(rows)
  deepFreeze(options)
  var first = annualReport.calculate(rows, options)
  var second = annualReport.calculate(rows, options)
  assert.deepStrictEqual(first, second)
  assert.strictEqual(JSON.stringify(rows), beforeRows)
  assert.strictEqual(JSON.stringify(options), beforeOptions)
})

test('invalid options and malformed transaction arrays safely return an empty report', function () {
  ;[undefined, null, {}, 'bad'].forEach(function (input) {
    var result = annualReport.calculate(input, { year: 'bad' })
    assert.strictEqual(result.hasData, false)
    assert.strictEqual(result.totals.txCount, 0)
    assert.strictEqual(result.months.length, 12)
    assert.ok(/^\d{4}$/.test(result.year))
  })
  assert.strictEqual(annualReport.calculate([], { year: 2026, accountNetWorthCents: 'bad' }).netWorthCents, null)
})

/* 页面控制器：真实 store/shared/accounts/health，仅用内存模拟 wx。 */
var root = path.resolve(__dirname, '..')
var storage = {}
var clipboard = []
var toasts = []
var themeWatcher = null
var app = { globalData: {} }
var systemTheme = 'light'
global.wx = {
  getStorageSync: function (key) { return key in storage ? clone(storage[key]) : '' },
  setStorageSync: function (key, value) { storage[key] = clone(value) },
  removeStorageSync: function (key) { delete storage[key] },
  getAppBaseInfo: function () { return { theme: systemTheme } },
  onThemeChange: function (fn) { themeWatcher = fn },
  offThemeChange: function (fn) { if (themeWatcher === fn) themeWatcher = null },
  setNavigationBarTitle: function () {},
  setTabBarStyle: function () {},
  showToast: function (options) { toasts.push(options) },
  setClipboardData: function (options) { clipboard.push(options.data); if (options.success) options.success() },
  navigateBack: function () {},
  switchTab: function () {}
}
global.getApp = function () { return app }
var pageConfig = null
global.Page = function (config) { pageConfig = config }
var store = require('../utils/store')
require(path.join(root, 'pages/annual/annual.js'))
var page = Object.assign({}, pageConfig)
page.data = clone(pageConfig.data)
page.setData = function (patch, cb) {
  Object.keys(patch).forEach(function (key) { this.data[key] = patch[key] }, this)
  if (cb) cb()
}
var thisYear = new Date().getFullYear()
var thisYm = thisYear + '-03'
function pageTx(id, ym, amount, extra) {
  return tx(id, ym, amount, Object.assign({
    accountId: 'acc-main', byMe: true, ownerKey: 'me', shareBook: 'book-one'
  }, extra || {}))
}
function seedPage() {
  storage.txs_v1 = [
    pageTx('income', thisYm, 1000, { type: 'income', category: '工资' }),
    pageTx('mine-expense', thisYm, 200),
    pageTx('refund', thisYm, 50, { type: 'refund', category: '退款' }),
    pageTx('peer-expense', thisYm, 50, { byMe: false, ownerKey: 'peer', by: '成员', category: '购物' }),
    pageTx('foreign-expense', thisYm, 999, { byMe: false, ownerKey: 'foreign', shareBook: 'other-book' }),
    pageTx('previous-expense', (thisYear - 1) + '-12', 25, { category: '交通' })
  ]
  storage.budget_v1 = 300
  storage.shared_book_v1 = { bookId: 'book-one', name: '测试账本', nickname: '我', joinedAt: Date.now() }
  storage.accounts_v1 = [{ id: 'acc-main', name: '现金', type: 'cash', openingBalance: 100, includeInNetWorth: true, createdAt: Date.now() }]
  store.reload()
  clipboard = []
  toasts = []
  page.onLoad()
  page.onShow()
}

test('annual page defaults to current year and reads store/shared both, budget, scans and net worth', function () {
  seedPage()
  assert.strictEqual(page.data.year, thisYear)
  assert.strictEqual(page.data.hasData, true)
  assert.strictEqual(page.data.txCount, 4)
  assert.strictEqual(page.data.incomeText, '¥1,000.00')
  assert.strictEqual(page.data.netExpenseText, '¥200.00')
  assert.strictEqual(page.data.balanceText, '¥800.00')
  assert.strictEqual(page.data.savingsRateText, '80.0%')
  assert.strictEqual(page.data.recordedMonthsText, '1 / 12')
  assert.strictEqual(page.data.months.length, 12)
  assert.strictEqual(page.data.months[0].trendText, '无记录')
  assert.strictEqual(page.data.health.budgetMonths, 1)
  assert.strictEqual(page.data.health.budgetUsageText, '66.7%')
  assert.strictEqual(page.data.netWorthText, '¥875.00')
  assert.strictEqual(page.data.scopeText, '共同账本全部可见成员')
  assert.strictEqual(page._report.health.scanReused, true)
  assert.strictEqual(page._report.health.scanMonths, 12)
  assert.ok(page.data.topCategories.every(function (item) { return item.barStyle.indexOf('width: ') === 0 }))
  assert.ok(page.data.months.every(function (item) { return item.trendStyle.indexOf('height: ') === 0 }))
})

test('annual page switches years, blocks future years and returns to current year', function () {
  seedPage()
  page.prevYear()
  assert.strictEqual(page.data.year, thisYear - 1)
  assert.strictEqual(page.data.txCount, 1)
  assert.strictEqual(page.data.netExpenseText, '¥25.00')
  assert.strictEqual(page.data.canNext, true)
  page.nextYear()
  assert.strictEqual(page.data.year, thisYear)
  page.nextYear()
  assert.strictEqual(page.data.year, thisYear)
  page.pickYear({ detail: { value: String(thisYear + 1) } })
  assert.strictEqual(page.data.year, thisYear)
  page.prevYear()
  page.pickYear({ detail: { value: 'bad' } })
  assert.strictEqual(page.data.year, thisYear - 1)
  page.currentYear()
  assert.strictEqual(page.data.year, thisYear)
})

test('annual page copies the complete report and handles copy failure', function () {
  seedPage()
  var text = page.data.reportText
  ;[thisYear + ' 年度财务报告', '共同账本全部可见成员', '年度总览', '年度健康概览', '支出分类 TOP', '月份明细', '当前净资产快照'].forEach(function (part) {
    assert.ok(text.indexOf(part) >= 0, part)
  })
  page.copyReport()
  assert.deepStrictEqual(clipboard, [text])
  assert.strictEqual(toasts[0].title, '年报已复制')
  var original = wx.setClipboardData
  wx.setClipboardData = function (options) { options.fail() }
  page.copyReport()
  assert.strictEqual(toasts[1].title, '复制失败，请重试')
  wx.setClipboardData = original
})

test('annual page has a safe empty state, catches errors and removes its theme watcher', function () {
  seedPage()
  storage.txs_v1 = []
  store.reload()
  page.refresh()
  assert.strictEqual(page.data.hasData, false)
  assert.strictEqual(page.data.txCount, 0)
  assert.strictEqual(page.data.balanceText, '¥0.00')
  assert.strictEqual(page.data.health.averageSavingsRateText, '--')
  assert.strictEqual(page.data.months.length, 12)
  var original = annualReport.calculate
  annualReport.calculate = function () { throw new Error('test failure') }
  page.refresh()
  assert.strictEqual(page.data.loading, false)
  assert.ok(page.data.error)
  annualReport.calculate = original
  systemTheme = 'dark'
  themeWatcher({ theme: 'dark' })
  assert.strictEqual(page.data.dark, true)
  assert.ok(themeWatcher)
  page.onUnload()
  assert.strictEqual(themeWatcher, null)
})

test('annual template and styles cover every section, theme, dark mode and safe area', function () {
  var wxml = fs.readFileSync(path.join(root, 'pages/annual/annual.wxml'), 'utf8')
  var wxss = fs.readFileSync(path.join(root, 'pages/annual/annual.wxss'), 'utf8')
  var source = fs.readFileSync(path.join(root, 'pages/annual/annual.js'), 'utf8')
  ;['年度总览', '12 月趋势', '支出分类 TOP', '月份明细', '年度健康概览', '复制年报文本', 'fields="year"', 'wx:if="{{!hasData}}"'].forEach(function (part) {
    assert.ok(wxml.indexOf(part) >= 0, part)
  })
  assert.ok(wxml.indexOf("theme-{{themeKey}} {{dark ? 'dark' : ''}}") >= 0)
  assert.ok(wxss.indexOf('env(safe-area-inset-bottom)') >= 0)
  assert.ok(wxss.indexOf('env(safe-area-inset-top)') >= 0)
  assert.ok(wxss.indexOf('.page.dark') >= 0)
  assert.ok(wxss.indexOf('var(--brand') >= 0)
  assert.ok(source.indexOf("shared.viewRows(store.all(), 'both')") >= 0)
  assert.ok(source.indexOf('health.scan(monthRows, now)') >= 0)
  assert.ok(source.indexOf('accounts.netWorth(rows)') >= 0)
  assert.ok(source.indexOf('store.budget()') >= 0)
  var stack = []
  var tags = wxml.match(/<\/?[a-zA-Z][^>]*>/g) || []
  tags.forEach(function (tag) {
    var name = /^<\/?([a-zA-Z][\w-]*)/.exec(tag)[1]
    if (tag.slice(0, 2) === '</') assert.strictEqual(stack.pop(), name, 'unbalanced tag ' + tag)
    else if (!/\/>$/.test(tag)) stack.push(name)
  })
  assert.deepStrictEqual(stack, [])
})

console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项')
if (failed) process.exitCode = 1
