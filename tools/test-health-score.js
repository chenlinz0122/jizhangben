// node tools/test-health-score.js
var assert = require('assert')
var fs = require('fs')
var path = require('path')
var healthScore = require('../utils/health-score')
var format = require('../utils/format')

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
  var day = ym + '-15'
  var row = {
    id: id,
    ym: ym,
    day: day,
    time: new Date(day + 'T12:00:00').getTime(),
    type: 'expense',
    amount: amount,
    category: '餐饮',
    merchant: '商户-' + id
  }
  Object.keys(extra || {}).forEach(function (key) { row[key] = extra[key] })
  return row
}

function byKey(result, key) {
  return result.breakdown.filter(function (entry) { return entry.key === key })[0]
}

function cleanScan(count) {
  return { total: count, largeAmount: 10000, today: '2026-11-28', issues: [] }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.keys(value).forEach(function (key) { deepFreeze(value[key]) })
  return Object.freeze(value)
}

test('API returns bounded score, five complete breakdown items, metrics and suggestions', function () {
  var result = healthScore.calculate([tx('a', '2026-11', 100)], { ym: '2026-11', healthScan: cleanScan(1) })
  assert.strictEqual(result.score, 58)
  assert.strictEqual(result.level, '一般')
  assert.strictEqual(result.breakdown.length, 5)
  assert.strictEqual(result.breakdown.reduce(function (sum, entry) { return sum + entry.max }, 0), 100)
  result.breakdown.forEach(function (entry) {
    assert.deepStrictEqual(Object.keys(entry).sort(), ['hint', 'key', 'label', 'max', 'score', 'valueText'])
    assert.ok(entry.score >= 0 && entry.score <= entry.max)
    assert.ok(entry.label && entry.valueText && entry.hint)
  })
  assert.ok(result.metrics && Array.isArray(result.suggestions) && result.suggestions.length)
  assert.ok(result.reportText.indexOf('月度财务健康报告') >= 0)
})

test('perfect healthy month reaches 100 and poor controls remain bounded', function () {
  var rows = [tx('income', '2026-11', 10000, { type: 'income', category: '工资' })]
  ;['餐饮', '交通', '购物', '居住'].forEach(function (category, index) {
    rows.push(tx('expense-' + index, '2026-11', 1000, { category: category }))
  })
  var perfect = healthScore.calculate(rows, { ym: '2026-11', budget: 5000, healthScan: cleanScan(5) })
  assert.strictEqual(perfect.score, 100)
  assert.strictEqual(perfect.level, '优秀')
  assert.strictEqual(byKey(perfect, 'savingsRate').score, 24)
  assert.strictEqual(byKey(perfect, 'budgetControl').score, 20)
  assert.strictEqual(byKey(perfect, 'categoryConcentration').score, 20)

  var poor = healthScore.calculate([
    tx('low-income', '2026-11', 1, { type: 'income', category: '工资' }),
    tx('huge-expense', '2026-11', 1000000, { category: '购物' })
  ], { ym: '2026-11', budget: 0.01, healthScan: cleanScan(2) })
  assert.ok(poor.score >= 0 && poor.score <= 100)
  assert.strictEqual(byKey(poor, 'savingsRate').score, 0)
  assert.strictEqual(byKey(poor, 'budgetControl').score, 0)
  assert.strictEqual(byKey(poor, 'categoryConcentration').score, 0)
})

test('no income gives savings neutral score without inventing a rate', function () {
  var result = healthScore.calculate([tx('a', '2026-11', 100), tx('b', '2026-11', 100, { category: '交通' })], {
    ym: '2026-11', budget: 1000, healthScan: cleanScan(2)
  })
  assert.strictEqual(result.metrics.incomeCents, 0)
  assert.strictEqual(result.metrics.savingsRate, null)
  assert.strictEqual(byKey(result, 'savingsRate').score, 12)
  assert.ok(byKey(result, 'savingsRate').valueText.indexOf('无收入') >= 0)
  assert.ok(byKey(result, 'savingsRate').hint.indexOf('中性') >= 0)
})

test('missing budget gives budget neutral score and explanation', function () {
  var result = healthScore.calculate([tx('a', '2026-11', 100)], { ym: '2026-11', budget: 0, healthScan: cleanScan(1) })
  assert.strictEqual(result.metrics.budgetCents, 0)
  assert.strictEqual(result.metrics.budgetUsage, null)
  assert.strictEqual(byKey(result, 'budgetControl').score, 10)
  assert.ok(byKey(result, 'budgetControl').valueText.indexOf('未设置') >= 0)
  assert.ok(byKey(result, 'budgetControl').hint.indexOf('中性') >= 0)
  assert.ok(result.suggestions.some(function (text) { return text.indexOf('设置月度预算') >= 0 }))
})

test('budget thresholds award full credit at 80 percent and zero at 150 percent', function () {
  var at80Rows = [tx('income', '2026-11', 1000, { type: 'income' }), tx('a', '2026-11', 50), tx('b', '2026-11', 30, { category: '交通' })]
  var rows = [tx('income', '2026-11', 1000, { type: 'income' }), tx('a', '2026-11', 80), tx('b', '2026-11', 70, { category: '交通' })]
  var at80 = healthScore.calculate(at80Rows, { ym: '2026-11', budget: 100, healthScan: cleanScan(3) })
  assert.strictEqual(byKey(at80, 'budgetControl').score, 20)
  var at150 = healthScore.calculate(rows, { ym: '2026-11', budget: 100, healthScan: cleanScan(3) })
  assert.strictEqual(at150.metrics.budgetUsage, 1.5)
  assert.strictEqual(byKey(at150, 'budgetControl').score, 0)
})

test('empty and malformed data are safe and never receive a health score', function () {
  ;[undefined, null, {}, 'bad'].forEach(function (input) {
    var result = healthScore.calculate(input, { ym: '2026-11' })
    assert.strictEqual(result.score, 0)
    assert.strictEqual(result.hasData, false)
    assert.strictEqual(result.level, '暂无数据')
    assert.strictEqual(result.metrics.txCount, 0)
    assert.strictEqual(result.metrics.incomeCents, 0)
    assert.strictEqual(result.metrics.netWorthCents, null)
    assert.strictEqual(result.breakdown.reduce(function (sum, entry) { return sum + entry.score }, 0), 0)
    assert.ok(result.reportText.indexOf('单月无法得出趋势') >= 0)
  })
  var result = healthScore.calculate([null, [], 'bad', tx('ok', '2026-11', 1)], { ym: '2026-11' })
  assert.strictEqual(result.metrics.txCount, 1)
})

test('category concentration measures largest categorized expense share deterministically', function () {
  var single = healthScore.calculate([tx('a', '2026-11', 100)], { ym: '2026-11', healthScan: cleanScan(1) })
  assert.strictEqual(single.metrics.topCategoryShare, 1)
  assert.strictEqual(single.metrics.categoryCount, 1)
  assert.strictEqual(byKey(single, 'categoryConcentration').score, 0)

  var spread = healthScore.calculate([
    tx('a', '2026-11', 100, { category: '餐饮' }),
    tx('b', '2026-11', 100, { category: '交通' }),
    tx('c', '2026-11', 100, { category: '购物' }),
    tx('d', '2026-11', 100, { category: '居住' })
  ], { ym: '2026-11', healthScan: cleanScan(4) })
  assert.strictEqual(spread.metrics.topCategoryShare, 0.25)
  assert.strictEqual(byKey(spread, 'categoryConcentration').score, 20)

  var tie = healthScore.calculate([
    tx('z', '2026-11', 100, { category: '交通' }),
    tx('a', '2026-11', 100, { category: '餐饮' })
  ], { ym: '2026-11', healthScan: cleanScan(2) })
  assert.strictEqual(tie.metrics.topCategory, '交通')
})

test('uncategorized ratio excludes transfers and handles blank categories', function () {
  var result = healthScore.calculate([
    tx('a', '2026-11', 10, { category: '未分类' }),
    tx('b', '2026-11', 10, { category: '   ' }),
    tx('c', '2026-11', 10, { category: '餐饮' }),
    tx('transfer', '2026-11', 99, { type: 'transfer', category: '转账' })
  ], { ym: '2026-11', healthScan: cleanScan(4) })
  assert.strictEqual(result.metrics.categorizationTxCount, 3)
  assert.strictEqual(result.metrics.uncategorizedCount, 2)
  assert.strictEqual(result.metrics.uncategorizedRatio, 2 / 3)
  assert.strictEqual(byKey(result, 'uncategorizedRatio').score, 5)
})

test('health scan is reused and severity issues reduce data health score', function () {
  var rows = [tx('a', '2026-11', 10), tx('b', '2026-11', 10)]
  var scan = {
    total: 2,
    issues: [
      { type: 'duplicate', severity: 'high', txIds: ['a', 'b'], records: rows },
      { type: 'amount', severity: 'high', txIds: ['a'], records: [rows[0]] },
      { type: 'uncategorized', severity: 'low', txIds: ['b'], records: [rows[1]] }
    ]
  }
  var result = healthScore.calculate(rows, { ym: '2026-11', healthScan: scan })
  assert.strictEqual(result.metrics.healthScanReused, true)
  assert.strictEqual(result.metrics.healthIssueCount, 3)
  assert.strictEqual(result.metrics.healthHighCount, 2)
  assert.strictEqual(result.metrics.healthLowCount, 1)
  assert.strictEqual(result.metrics.healthAffectedTxCount, 2)
  assert.strictEqual(byKey(result, 'dataHealth').score, 0)
  assert.ok(result.suggestions[0].indexOf('高风险') >= 0)
})

test('real health.scan detects duplicates, uncategorized records and future dates', function () {
  var rows = [
    tx('a', '2026-11', 10, { category: '未分类', merchant: '重复商户' }),
    tx('b', '2026-11', 10, { category: '未分类', merchant: '重复商户' }),
    tx('future', '2026-11', 20, { day: '2026-11-30', time: new Date('2026-11-30T12:00:00').getTime() })
  ]
  var result = healthScore.calculate(rows, { ym: '2026-11', now: new Date('2026-11-20T12:00:00').getTime() })
  assert.strictEqual(result.metrics.healthScanReused, false)
  assert.ok(result.metrics.healthHighCount >= 1)
  assert.ok(result.metrics.healthIssueCount >= 4)
  assert.strictEqual(result.metrics.healthAffectedTxCount, 3)
})

test('month filtering uses ym, day and time fallbacks and scopes supplied full scans', function () {
  var current = tx('current', '2026-11', 100, { type: 'income', category: '工资' })
  var previous = tx('previous', '2026-10', 900, { type: 'income', category: '工资' })
  var dayOnly = tx('day-only', '', 20, { ym: '', day: '2026-11-16' })
  var timeOnly = tx('time-only', '', 30, { ym: '', day: '', time: new Date('2026-11-17T12:00:00').getTime() })
  var fullScan = {
    total: 4,
    issues: [
      { type: 'amount', severity: 'high', txIds: ['previous'], records: [previous] },
      { type: 'large', severity: 'medium', txIds: ['current'], records: [current] }
    ]
  }
  var result = healthScore.calculate([current, previous, dayOnly, timeOnly], { ym: '2026-11', healthScan: fullScan })
  assert.strictEqual(result.metrics.txCount, 3)
  assert.strictEqual(result.metrics.incomeCents, 10000)
  assert.strictEqual(result.metrics.expenseCents, 5000)
  assert.strictEqual(result.metrics.healthIssueCount, 1)
  assert.strictEqual(result.metrics.healthIssueCount, 1)
  assert.ok(byKey(result, 'dataHealth').valueText.indexOf('1 项问题') >= 0)
})

test('amounts and budgets are calculated in integer cents', function () {
  var result = healthScore.calculate([
    tx('a', '2026-11', 0.1, { type: 'income', category: '工资' }),
    tx('b', '2026-11', 0.2, { type: 'income', category: '工资' }),
    tx('c', '2026-11', 0.1),
    tx('d', '2026-11', 0.2, { category: '交通' })
  ], { ym: '2026-11', budget: 0.3, healthScan: cleanScan(4) })
  assert.strictEqual(result.metrics.incomeCents, 30)
  assert.strictEqual(result.metrics.netExpenseCents, 30)
  assert.strictEqual(result.metrics.budgetCents, 30)
  assert.strictEqual(result.metrics.balanceCents, 0)
  assert.strictEqual(result.metrics.budgetUsage, 1)
})

test('refunds reduce net expense and transfers do not affect income or expense', function () {
  var result = healthScore.calculate([
    tx('income', '2026-11', 100, { type: 'income', category: '工资' }),
    tx('expense', '2026-11', 80),
    tx('refund', '2026-11', 30, { type: 'refund', category: '退款' }),
    tx('transfer', '2026-11', 999, { type: 'transfer', category: '转账' })
  ], { ym: '2026-11', budget: 100, healthScan: cleanScan(4) })
  assert.strictEqual(result.metrics.expenseCents, 8000)
  assert.strictEqual(result.metrics.refundCents, 3000)
  assert.strictEqual(result.metrics.netExpenseCents, 5000)
  assert.strictEqual(result.metrics.balanceCents, 5000)
  assert.strictEqual(result.metrics.savingsRate, 0.5)
})

test('net worth is a current snapshot and is never used to fabricate a monthly trend', function () {
  var rows = [tx('a', '2026-11', 10)]
  var positive = healthScore.calculate(rows, { ym: '2026-11', healthScan: cleanScan(1), accountNetWorthCents: 123456 })
  var negative = healthScore.calculate(rows, { ym: '2026-11', healthScan: cleanScan(1), accountNetWorthCents: -123456 })
  assert.strictEqual(positive.metrics.netWorthCents, 123456)
  assert.strictEqual(negative.metrics.netWorthCents, -123456)
  assert.strictEqual(positive.metrics.netWorthTrendAvailable, false)
  assert.strictEqual(positive.score, negative.score)
  assert.strictEqual(positive.breakdown.length, 5)
  assert.ok(positive.reportText.indexOf('当前净资产快照：¥1,234.56') >= 0)
  assert.ok(positive.reportText.indexOf('单月无法得出趋势') >= 0)
})

test('calculation is deterministic and does not modify frozen inputs or options', function () {
  var rows = [
    tx('b', '2026-11', 20, { category: '交通' }),
    tx('a', '2026-11', 10, { category: '未分类' }),
    tx('income', '2026-10', 100, { type: 'income', category: '工资' })
  ]
  var options = { ym: '2026-11', budget: 100, healthScan: cleanScan(2), accountNetWorthCents: 999 }
  var beforeRows = JSON.stringify(rows)
  var beforeOptions = JSON.stringify(options)
  deepFreeze(rows)
  deepFreeze(options)
  var first = healthScore.calculate(rows, options)
  var second = healthScore.calculate(rows, options)
  assert.deepStrictEqual(first, second)
  assert.strictEqual(JSON.stringify(rows), beforeRows)
  assert.strictEqual(JSON.stringify(options), beforeOptions)
})

test('invalid numeric values cannot create NaN or Infinity in output', function () {
  var result = healthScore.calculate([
    tx('nan', '2026-11', NaN),
    tx('infinite', '2026-11', Infinity, { type: 'income', category: '工资' }),
    tx('negative', '2026-11', -10)
  ], { ym: '2026-11', budget: 'bad', accountNetWorthCents: 'bad', healthScan: cleanScan(3) })
  assert.strictEqual(result.metrics.incomeCents, 0)
  assert.strictEqual(result.metrics.netExpenseCents, 0)
  assert.ok(isFinite(result.score))
  assert.ok(JSON.stringify(result).indexOf('NaN') < 0)
  assert.ok(JSON.stringify(result).indexOf('Infinity') < 0)
})

test('report text includes metrics, every dimension, suggestions and trend disclaimer', function () {
  var result = healthScore.calculate([
    tx('income', '2026-11', 1000, { type: 'income', category: '工资' }),
    tx('a', '2026-11', 200),
    tx('b', '2026-11', 100, { category: '未分类' })
  ], { ym: '2026-11', budget: 500, healthScan: cleanScan(3), accountNetWorthCents: 50000, scopeText: '测试账本' })
  ;['2026-11', '测试账本', '关键指标', '收入：¥1,000.00', '当前净资产快照：¥500.00', '分项评分', '建议', '单月无法得出趋势'].forEach(function (text) {
    assert.ok(result.reportText.indexOf(text) >= 0, text)
  })
  result.breakdown.forEach(function (entry) {
    assert.ok(result.reportText.indexOf(entry.label + '：' + entry.score + '/' + entry.max) >= 0)
  })
})

/* 页面控制器集成：使用真实 store/shared/accounts/health，只在内存模拟 wx。 */
var root = path.resolve(__dirname, '..')
var storage = {}
var clipboard = []
var toasts = []
var themeWatcher = null
var app = { globalData: {} }
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}
global.wx = {
  getStorageSync: function (key) { return key in storage ? clone(storage[key]) : '' },
  setStorageSync: function (key, value) { storage[key] = clone(value) },
  removeStorageSync: function (key) { delete storage[key] },
  getAppBaseInfo: function () { return { theme: 'light' } },
  onThemeChange: function (fn) { themeWatcher = fn },
  offThemeChange: function (fn) { if (themeWatcher === fn) themeWatcher = null },
  setNavigationBarTitle: function () {},
  setTabBarStyle: function () {},
  showToast: function (options) { toasts.push(options) },
  setClipboardData: function (options) { clipboard.push(options.data); options.success() },
  navigateBack: function () {},
  switchTab: function () {}
}
global.getApp = function () { return app }
var pageConfig = null
global.Page = function (config) { pageConfig = config }
var store = require('../utils/store')
require(path.join(root, 'pages/insights/insights.js'))
var page = Object.assign({}, pageConfig)
page.data = clone(pageConfig.data)
page.setData = function (patch, cb) {
  Object.keys(patch).forEach(function (key) { this.data[key] = patch[key] }, this)
  if (cb) cb()
}
var currentYm = format.ymOf(Date.now())
var previousYm = format.shiftMonth(currentYm, -1)
function pageTx(id, ym, amount, extra) {
  return tx(id, ym, amount, Object.assign({
    accountId: 'acc-main', byMe: true, ownerKey: 'me', shareBook: 'book-one'
  }, extra || {}))
}
function seedPage() {
  storage.txs_v1 = [
    pageTx('income', currentYm, 1000, { type: 'income', category: '工资' }),
    pageTx('mine-expense', currentYm, 200),
    pageTx('peer-expense', currentYm, 50, { byMe: false, ownerKey: 'peer', by: '成员', category: '购物' }),
    pageTx('foreign-expense', currentYm, 999, { byMe: false, ownerKey: 'foreign', shareBook: 'other-book' }),
    pageTx('previous-expense', previousYm, 25, { category: '交通' })
  ]
  storage.budget_v1 = 300
  storage.shared_book_v1 = { bookId: 'book-one', name: '测试账本', nickname: '我', joinedAt: Date.now() }
  storage.accounts_v1 = [{
    id: 'acc-main', name: '现金', type: 'cash', openingBalance: 100,
    includeInNetWorth: true, createdAt: Date.now()
  }]
  store.reload()
  clipboard = []
  toasts = []
  page.onLoad()
  page.onShow()
}

test('insights page defaults to current month and reads shared both, budget, scan and net worth', function () {
  seedPage()
  assert.strictEqual(page.data.ym, currentYm)
  assert.strictEqual(page.data.hasData, true)
  assert.strictEqual(page.data.txCount, 3)
  assert.strictEqual(page.data.incomeText, '¥1,000.00')
  assert.strictEqual(page.data.netExpenseText, '¥250.00')
  assert.strictEqual(page.data.balanceText, '¥750.00')
  assert.strictEqual(page.data.savingsRateText, '75.0%')
  assert.strictEqual(page.data.budgetText.indexOf('83.3%') >= 0, true)
  assert.strictEqual(page.data.netWorthText, '¥825.00')
  assert.strictEqual(page.data.scopeText, '共同账本全部可见成员')
  assert.strictEqual(page._result.metrics.healthScanReused, true)
  assert.strictEqual(page.data.breakdown.length, 5)
  assert.ok(page.data.breakdown.every(function (entry) { return entry.barStyle.indexOf('width: ') === 0 }))
})

test('insights page switches months, blocks future months and returns to current month', function () {
  seedPage()
  page.prevMonth()
  assert.strictEqual(page.data.ym, previousYm)
  assert.strictEqual(page.data.txCount, 1)
  assert.strictEqual(page.data.netExpenseText, '¥25.00')
  assert.strictEqual(page.data.netWorthText, '¥825.00')
  assert.strictEqual(page.data.canNext, true)
  page.nextMonth()
  assert.strictEqual(page.data.ym, currentYm)
  page.nextMonth()
  assert.strictEqual(page.data.ym, currentYm)
  page.prevMonth()
  page.pickMonth({ detail: { value: '9999-12' } })
  assert.strictEqual(page.data.ym, previousYm)
  page.currentMonth()
  assert.strictEqual(page.data.ym, currentYm)
})

test('insights page generates and copies complete report text', function () {
  seedPage()
  var text = page.data.reportText
  ;['月度财务健康报告', currentYm, '共同账本全部可见成员', '综合评分', '关键指标', '分项评分', '建议', '当前净资产快照'].forEach(function (part) {
    assert.ok(text.indexOf(part) >= 0, part)
  })
  page.copyReport()
  assert.deepStrictEqual(clipboard, [text])
  assert.strictEqual(toasts[0].title, '报告已复制')
})

test('insights page shows a safe empty state and disables theme watcher on unload', function () {
  seedPage()
  storage.txs_v1 = []
  store.reload()
  page.refresh()
  assert.strictEqual(page.data.loading, false)
  assert.strictEqual(page.data.hasData, false)
  assert.strictEqual(page.data.score, 0)
  assert.strictEqual(page.data.level, '暂无数据')
  assert.strictEqual(page.data.txCount, 0)
  assert.ok(page.data.suggestions[0].indexOf('暂无流水') >= 0)
  assert.ok(page.data.reportText.indexOf('暂无数据') >= 0)
  assert.ok(themeWatcher)
  page.onUnload()
  assert.strictEqual(themeWatcher, null)
})

test('insights template and styles include theme, dark mode, safe area and report actions', function () {
  var wxml = fs.readFileSync(path.join(root, 'pages/insights/insights.wxml'), 'utf8')
  var wxss = fs.readFileSync(path.join(root, 'pages/insights/insights.wxss'), 'utf8')
  var source = fs.readFileSync(path.join(root, 'pages/insights/insights.js'), 'utf8')
  var config = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))
  assert.ok(config.pages.indexOf('pages/insights/insights') >= 0)
  assert.ok(wxml.indexOf('theme-{{themeKey}} {{dark ? \'dark\' : \'\'}}') >= 0)
  assert.ok(wxml.indexOf('bindtap="copyReport"') >= 0)
  assert.ok(wxml.indexOf('wx:if="{{!hasData}}"') >= 0)
  assert.ok(wxml.indexOf('fields="month"') >= 0)
  assert.ok(wxss.indexOf('env(safe-area-inset-bottom)') >= 0)
  assert.ok(wxss.indexOf('.page.dark') >= 0)
  assert.ok(source.indexOf("shared.viewRows(store.all(), 'both')") >= 0)
  assert.ok(source.indexOf('health.scan(monthRows, now)') >= 0)
  assert.ok(source.indexOf('accounts.netWorth(rows)') >= 0)
  assert.ok(source.indexOf('store.budget()') >= 0)
})

console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项')
if (failed) process.exitCode = 1
