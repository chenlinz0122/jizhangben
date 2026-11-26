// node tools/test-budget-variance.js
var assert = require('node:assert/strict')
var fs = require('node:fs')
var path = require('node:path')
var root = path.resolve(__dirname, '..')
var storage = Object.create(null)
var calls = { toasts: [], tabs: [], backs: [], styles: [], icons: [] }
var clipboard = ''
var dark = false
var watcher = null
var app = { globalData: {} }

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

global.wx = {
  getStorageSync: function (key) { return key in storage ? clone(storage[key]) : '' },
  setStorageSync: function (key, value) { storage[key] = clone(value) },
  removeStorageSync: function (key) { delete storage[key] },
  getAppBaseInfo: function () { return { theme: dark ? 'dark' : 'light' } },
  getSystemInfoSync: function () { return { theme: dark ? 'dark' : 'light' } },
  onThemeChange: function (fn) { watcher = fn },
  offThemeChange: function (fn) { if (watcher === fn) watcher = null },
  setNavigationBarTitle: function (options) { calls.title = options.title },
  setTabBarStyle: function (options) { calls.styles.push(options) },
  setTabBarItem: function (options) { calls.icons.push(options) },
  showToast: function (options) { calls.toasts.push(options.title) },
  setClipboardData: function (options) {
    clipboard = options.data
    if (options.success) options.success()
  },
  switchTab: function (options) { calls.tabs.push(options.url) },
  navigateBack: function (options) {
    calls.backs.push(options)
    if (options.fail) options.fail()
  }
}
global.getApp = function () { return app }

var budgetVariance = require('../utils/budget-variance')
var stats = require('../utils/stats')
var refundpair = require('../utils/refundpair')
var prefs = require('../utils/prefs')
var store = require('../utils/store')
var format = require('../utils/format')
var pageFile = path.join(root, 'pages/budget-variance/budget-variance.js')
var passed = 0
var failed = 0

function reset() {
  Object.keys(storage).forEach(function (key) { delete storage[key] })
  calls.toasts = []
  calls.tabs = []
  calls.backs = []
  calls.styles = []
  calls.icons = []
  calls.title = ''
  clipboard = ''
  dark = false
  watcher = null
  app.globalData = {}
  prefs.setRefundExcluded(true)
  store.reload()
}

function test(name, run) {
  reset()
  try {
    run()
    passed++
    console.log('PASS ' + name)
  } catch (err) {
    failed++
    console.error('FAIL ' + name + '\n' + err.stack)
  }
}

function tx(id, day, type, amount, category, merchant, extra) {
  var time = new Date(day + 'T12:00:00').getTime()
  var row = {
    id: id, day: day, ym: day.slice(0, 7), time: time,
    type: type, amount: amount, category: category, merchant: merchant
  }
  Object.keys(extra || {}).forEach(function (key) { row[key] = extra[key] })
  return row
}

function cat(result, name) {
  return result.categories.filter(function (row) { return row.category === name })[0]
}

function calculate(rows, budget, cats, options) {
  return budgetVariance.calculate(rows, '2026-11', budget, cats, options)
}

test('超支总额和分类偏差按分计算', function () {
  var result = calculate([
    tx('food', '2026-11-02', 'expense', 80, '餐饮', '饭店'),
    tx('shop', '2026-11-03', 'expense', 50, '购物', '商店')
  ], 100, { '餐饮': 100, '购物': 30 })
  assert.equal(result.totalBudget, 100)
  assert.equal(result.actualNetSpend, 130)
  assert.equal(result.remaining, -30)
  assert.equal(result.overspend, 30)
  assert.equal(result.variance, -30)
  assert.equal(result.variancePct, -30)
  assert.equal(result.usageRate, 130)
  assert.equal(result.barPct, 100)
  assert.equal(result.overallStatus, 'over_budget')
  assert.equal(result.overBudgetCount, 1)
  assert.equal(cat(result, '餐饮').status, 'near_budget')
  assert.equal(cat(result, '购物').variance, -20)
  assert.equal(cat(result, '购物').variancePct, -66.7)
  assert.match(result.reportText, /超支：¥30\.00/)
  assert.match(result.reportText, /购物.*差额 -¥20\.00/)
})

test('结余、健康状态与收入转账排除', function () {
  var result = calculate([
    tx('a', '2026-11-01', 'expense', 100, '餐饮', '饭店'),
    tx('b', '2026-11-02', 'expense', 29.99, '交通', '地铁'),
    tx('income', '2026-11-03', 'income', 9999, '工资', '公司'),
    tx('move', '2026-11-04', 'transfer', 8888, '理财', '银行')
  ], 200, { '餐饮': 120 })
  assert.equal(result.grossSpent, 129.99)
  assert.equal(result.actualNetSpend, 129.99)
  assert.equal(result.remaining, 70.01)
  assert.equal(result.overspend, 0)
  assert.equal(result.usageRate, 65)
  assert.equal(result.overallStatus, 'healthy')
  assert.equal(cat(result, '餐饮').variancePct, 16.7)
  assert.ok(result.suggestions.some(function (item) { return item.includes('当前执行健康') }))
})

test('未设预算分类与已设预算但无支出均展示', function () {
  var result = calculate([
    tx('food', '2026-11-06', 'expense', 30, '餐饮', '饭店')
  ], 0, { '交通': 100, '医疗': 50 })
  assert.equal(result.overallStatus, 'no_budget')
  assert.equal(result.remaining, null)
  assert.equal(result.usageRate, null)
  assert.equal(result.categories.length, 3)
  assert.equal(result.unbudgetedCount, 1)
  assert.equal(result.budgetedWithoutSpendCount, 2)
  assert.deepEqual(
    { budget: cat(result, '餐饮').budget, variance: cat(result, '餐饮').variance, status: cat(result, '餐饮').status },
    { budget: 0, variance: null, status: 'unbudgeted' }
  )
  assert.equal(cat(result, '交通').spent, 0)
  assert.equal(cat(result, '交通').variance, 100)
  assert.equal(cat(result, '交通').variancePct, 100)
  assert.ok(result.categories.some(function (row) { return row.advice.includes('本月暂无支出') }))
})

test('退款按到账月抵减并归属原付款分类', function () {
  var rows = [
    tx('pay', '2026-11-02', 'expense', 100, '餐饮', '青山电商商家'),
    tx('refund', '2026-11-08', 'refund', 20, '退款', '青山商城')
  ]
  var result = calculate(rows, 100, { '餐饮': 100 })
  assert.equal(result.grossSpent, 100)
  assert.equal(result.refundReceived, 20)
  assert.equal(result.actualNetSpend, 80)
  assert.equal(cat(result, '餐饮').spent, 80)
  assert.equal(cat(result, '餐饮').variance, 20)
  assert.equal(cat(result, '餐饮').status, 'near_budget')
  prefs.setRefundExcluded(false)
  assert.equal(calculate(rows, 100, { '餐饮': 100 }).actualNetSpend, 80)
})

test('跨月退款不回溯付款月且负净支出合理处理', function () {
  var rows = [
    tx('oct-pay', '2026-10-31', 'expense', 100, '餐饮', '青山商家'),
    tx('nov-refund', '2026-11-03', 'refund', 30, '退款', '青山商城'),
    tx('nov-pay', '2026-11-04', 'expense', 10, '交通', '地铁')
  ]
  var result = calculate(rows, 100, { '餐饮': 100 })
  assert.equal(result.actualNetSpend, -20)
  assert.equal(result.netNegative, true)
  assert.equal(result.usageRate, 0)
  assert.equal(result.barPct, 0)
  assert.equal(result.remaining, 120)
  assert.equal(result.overspend, 0)
  assert.equal(result.overallStatus, 'healthy')
  assert.equal(cat(result, '餐饮').spent, -30)
  assert.equal(cat(result, '餐饮').variance, 130)
  assert.equal(cat(result, '餐饮').variancePct, 130)
  assert.match(result.reportText, /实际净支出：-¥20\.00/)
  var october = budgetVariance.calculate(rows, '2026-10', 100, { '餐饮': 100 })
  assert.equal(october.actualNetSpend, 100)
  assert.equal(october.refundReceived, 0)
})

test('仅退款形成负净支出，未配对退款单列且不超支', function () {
  var result = calculate([
    tx('only-refund', '2026-11-05', 'refund', 40, '退款', '未知商户')
  ], 50, { '未配对退款': 20 })
  assert.equal(result.actualNetSpend, -40)
  assert.equal(result.remaining, 90)
  assert.equal(result.usageRate, 0)
  assert.equal(result.overallStatus, 'healthy')
  assert.equal(cat(result, '未配对退款').spent, -40)
  assert.equal(cat(result, '未配对退款').status, 'healthy')
  assert.equal(cat(result, '未配对退款').variancePct, 300)
})

test('全额退款分类净额为零但不误报为无支出', function () {
  var result = calculate([
    tx('pay', '2026-11-02', 'expense', 100, '餐饮', '青山商家'),
    tx('refund', '2026-11-04', 'refund', 100, '退款', '青山商城')
  ], 100, { '餐饮': 100, '交通': 50 })
  assert.equal(result.actualNetSpend, 0)
  assert.equal(result.overallStatus, 'healthy')
  assert.equal(cat(result, '餐饮').spent, 0)
  assert.equal(cat(result, '餐饮').grossSpent, 100)
  assert.equal(cat(result, '餐饮').noSpend, false)
  assert.match(cat(result, '餐饮').advice, /全额抵减/)
  assert.equal(cat(result, '交通').noSpend, true)
  assert.equal(result.budgetedWithoutSpendCount, 1)
})

test('空数据在无预算和有预算时均有明确结果', function () {
  var empty = calculate([], 0, {})
  assert.equal(empty.hasData, false)
  assert.equal(empty.actualNetSpend, 0)
  assert.equal(empty.overallStatus, 'no_budget')
  assert.deepEqual(empty.categories, [])
  assert.match(empty.reportText, /（无分类数据）/)
  assert.ok(empty.suggestions.some(function (item) { return item.includes('本月暂无流水') }))
  var budgeted = calculate([], 100, { '餐饮': 50 })
  assert.equal(budgeted.hasData, false)
  assert.equal(budgeted.overallStatus, 'healthy')
  assert.equal(budgeted.remaining, 100)
  assert.equal(budgeted.categories.length, 1)
  assert.equal(budgeted.categories[0].noSpend, true)
})

test('月份过滤兼容 ym/day/time 且只统计支出退款', function () {
  var nov = tx('nov', '2026-11-10', 'expense', 10, '餐饮', '饭店')
  var noYm = tx('legacy', '2026-11-11', 'expense', 20, '交通', '地铁')
  delete noYm.ym
  var noDay = tx('time-only', '2026-11-12', 'expense', 30, '购物', '商店')
  delete noDay.day
  delete noDay.ym
  var result = calculate([
    nov, noDay, noYm,
    tx('dec', '2026-12-01', 'expense', 999, '餐饮', '饭店'),
    tx('nov-income', '2026-11-13', 'income', 500, '工资', '公司')
  ], 100, {})
  assert.equal(result.actualNetSpend, 60)
  assert.equal(result.categories.length, 3)
  assert.equal(result.categories.some(function (row) { return row.category === '工资' }), false)
})

test('非法月份返回空结果且不混入无月份流水', function () {
  var row = tx('bad', '2026-11-01', 'expense', 10, '餐饮', '饭店')
  delete row.ym
  delete row.day
  delete row.time
  var result = budgetVariance.calculate([row], 'bad', 100, { '餐饮': 50 })
  assert.equal(result.hasData, false)
  assert.equal(result.actualNetSpend, 0)
  assert.equal(result.categories.length, 1)
  assert.equal(result.categories[0].spent, 0)
})

test('浮点金额按分守恒，分类合计等于总净支出', function () {
  var result = calculate([
    tx('a', '2026-11-01', 'expense', 0.1, '餐饮', '小店'),
    tx('b', '2026-11-02', 'expense', 0.2, '购物', '小店'),
    tx('r', '2026-11-03', 'refund', 0.1, '退款', '小店')
  ], 0.3, { '餐饮': 0.1, '购物': 0.2 })
  assert.equal(result.actualNetSpend, 0.2)
  assert.equal(result.totalBudget, 0.3)
  assert.equal(result.categories.reduce(function (sum, row) { return sum + Math.round(row.spent * 100) }, 0), 20)
  assert.equal(result.overallStatus, 'healthy')
})

test('结果确定、输入不变且交易顺序不影响输出', function () {
  var rows = [
    tx('a', '2026-11-01', 'expense', 40, '餐饮', '甲饭店'),
    tx('b', '2026-11-02', 'expense', 70, '购物', '乙商店'),
    tx('r', '2026-11-03', 'refund', 10, '退款', '甲商城')
  ]
  var before = JSON.stringify(rows)
  var first = calculate(rows, 200, { '购物': 50, '餐饮': 100 }, { scopeLabel: '共同账本 · 看双方' })
  var second = calculate(rows.slice().reverse(), 200, { '餐饮': 100, '购物': 50 }, { scopeLabel: '共同账本 · 看双方' })
  assert.equal(JSON.stringify(rows), before)
  assert.deepEqual(first, second)
  assert.deepEqual(first, calculate(rows, 200, { '购物': 50, '餐饮': 100 }, { scopeLabel: '共同账本 · 看双方' }))
  assert.match(first.reportText, /共同账本 · 看双方/)
})

test('趋势默认最近六个月、跨年升序并保留空月份', function () {
  var result = budgetVariance.calculateTrend([
    tx('oct', '2025-10-03', 'expense', 40, '餐饮', '饭店'),
    tx('nov', '2025-11-03', 'expense', 130, '购物', '商店'),
    tx('jan', '2026-01-03', 'expense', 10, '交通', '地铁')
  ], '2026-01', undefined, 100, {}, { scopeLabel: '测试账本' })
  assert.equal(result.endYm, '2026-01')
  assert.equal(result.monthCount, 6)
  assert.deepEqual(result.months.map(function (row) { return row.ym }), [
    '2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01'
  ])
  assert.equal(result.months[0].hasData, false)
  assert.equal(result.months[2].actualNetSpend, 40)
  assert.equal(result.months[2].variance, 60)
  assert.equal(result.months[2].usageRate, 40)
  assert.equal(result.months[2].status, 'healthy')
  assert.equal(result.months[3].actualNetSpend, 130)
  assert.equal(result.months[3].variance, -30)
  assert.equal(result.months[3].usageRate, 130)
  assert.equal(result.months[3].status, 'over_budget')
  assert.equal(result.months[3].barPct, 100)
  assert.equal(result.months[5].month, '2026年1月')
  assert.match(result.reportText, /近 6 个月/)
  assert.match(result.reportText, /测试账本/)
})

test('趋势支持自定义月数、预算映射和缺失预算不补算', function () {
  var budgets = Object.create({ '2025-12': 999 })
  budgets['2025-10'] = 100
  budgets['2025-11'] = 80
  budgets['2026-01'] = 120
  var result = budgetVariance.calculateTrend([
    tx('oct', '2025-10-03', 'expense', 50, '餐饮', '饭店'),
    tx('nov', '2025-11-03', 'expense', 80, '餐饮', '饭店'),
    tx('dec', '2025-12-03', 'expense', 30, '餐饮', '饭店'),
    tx('jan', '2026-01-03', 'expense', 130, '餐饮', '饭店')
  ], '2026-01', 4, budgets, {})
  assert.equal(result.monthCount, 4)
  assert.deepEqual(result.months.map(function (row) { return row.hasBudget }), [true, true, false, true])
  assert.deepEqual(result.months.map(function (row) { return row.budget }), [100, 80, 0, 120])
  assert.deepEqual(result.months.map(function (row) { return row.variance }), [50, 0, null, -10])
  assert.deepEqual(result.months.map(function (row) { return row.usageRate }), [50, 100, null, 108.3])
  assert.deepEqual(result.months.map(function (row) { return row.status }), [
    'healthy', 'near_budget', 'unbudgeted', 'over_budget'
  ])
  assert.equal(result.budgetedMonthCount, 3)
  assert.equal(result.missingBudgetMonthCount, 1)
  assert.match(result.reportText, /2025年12月：预算 未设置.*差额 --.*使用率 --.*未设预算/)
})

test('趋势跨月退款按到账月抵减且付款月不变', function () {
  var rows = [
    tx('oct-pay', '2025-10-31', 'expense', 100, '餐饮', '青山商家'),
    tx('nov-refund', '2025-11-03', 'refund', 30, '退款', '青山商城'),
    tx('nov-pay', '2025-11-04', 'expense', 10, '交通', '地铁'),
    tx('nov-income', '2025-11-05', 'income', 999, '工资', '公司'),
    tx('nov-transfer', '2025-11-06', 'transfer', 888, '理财', '银行')
  ]
  var result = budgetVariance.calculateTrend(rows, '2025-11', 2, 100, {})
  assert.equal(result.months[0].actualNetSpend, 100)
  assert.equal(result.months[0].refundReceived, 0)
  assert.equal(result.months[0].variance, 0)
  assert.equal(result.months[0].status, 'near_budget')
  assert.equal(result.months[1].actualNetSpend, -20)
  assert.equal(result.months[1].grossSpent, 10)
  assert.equal(result.months[1].refundReceived, 30)
  assert.equal(result.months[1].netNegative, true)
})

test('趋势负净支出使用率为零并合理放大结余', function () {
  var result = budgetVariance.calculateTrend([
    tx('only-refund', '2026-11-05', 'refund', 40, '退款', '未知商户')
  ], '2026-11', 1, 50, {})
  var row = result.months[0]
  assert.equal(row.actualNetSpend, -40)
  assert.equal(row.variance, 90)
  assert.equal(row.variancePct, 180)
  assert.equal(row.usageRate, 0)
  assert.equal(row.barPct, 0)
  assert.equal(row.remaining, 90)
  assert.equal(row.overspend, 0)
  assert.equal(row.status, 'healthy')
  assert.match(result.reportText, /实际净支出 -¥40\.00.*差额 ¥90\.00.*使用率 0\.0%/)
})

test('趋势非法月份返回空结果且不混入流水', function () {
  var rows = [tx('bad', '2026-11-01', 'expense', 10, '餐饮', '饭店')]
  ;['', 'bad', '2026-13', '2026-00', '2026-1', null].forEach(function (ym) {
    var result = budgetVariance.calculateTrend(rows, ym, 3, 100, {})
    assert.equal(result.endYm, '')
    assert.equal(result.monthCount, 3)
    assert.deepEqual(result.months, [])
    assert.equal(result.hasData, false)
    assert.match(result.reportText, /结束月份无效/)
  })
})

test('趋势月数非法时默认六个月且分类预算不补总预算', function () {
  var rows = [tx('a', '2026-11-01', 'expense', 10, '餐饮', '饭店')]
  ;[undefined, null, '', 0, -1, 'bad', true, Infinity].forEach(function (count) {
    assert.equal(budgetVariance.calculateTrend(rows, '2026-11', count, 100, {}).months.length, 6)
  })
  assert.equal(budgetVariance.calculateTrend(rows, '2026-11', 2.9, 100, {}).months.length, 2)
  var noTotal = budgetVariance.calculateTrend(rows, '2026-11', 1, undefined, { '餐饮': 100 })
  assert.equal(noTotal.months[0].hasBudget, false)
  assert.equal(noTotal.months[0].status, 'unbudgeted')
  assert.equal(noTotal.months[0].variance, null)
  assert.equal(noTotal.months[0].usageRate, null)
  var zero = budgetVariance.calculateTrend(rows, '2026-11', 1, { '2026-11': 0 }, {})
  assert.equal(zero.months[0].hasBudget, false)
})

test('趋势阈值可配置且完整账本预投影不重复退款配对', function () {
  var rows = [
    tx('pay', '2025-10-30', 'expense', 40, '餐饮', '青山商家'),
    tx('refund', '2025-11-03', 'refund', 20, '退款', '青山商城')
  ]
  var projected = stats.ledger(rows, true)
  var original = refundpair.pair
  refundpair.pair = function () { throw new Error('趋势不应重复配对') }
  try {
    var result = budgetVariance.calculateTrend(rows, '2025-11', 2, 50, {}, {
      projected: projected,
      nearThreshold: 90
    })
    assert.equal(result.months[0].actualNetSpend, 40)
    assert.equal(result.months[0].status, 'healthy')
    assert.equal(result.months[1].actualNetSpend, -20)
  } finally {
    refundpair.pair = original
  }
})

test('趋势结果确定、输入不变且交易与预算键顺序不影响输出', function () {
  var rows = [
    tx('a', '2025-10-01', 'expense', 40, '餐饮', '甲饭店'),
    tx('b', '2025-11-02', 'expense', 70, '购物', '乙商店'),
    tx('r', '2025-11-03', 'refund', 10, '退款', '甲商城')
  ]
  var budgets = { '2025-11': 100, '2025-10': 80 }
  var before = JSON.stringify({ rows: rows, budgets: budgets })
  var options = { scopeLabel: '共同账本 · 看双方' }
  var first = budgetVariance.calculateTrend(rows, '2025-11', 2, budgets, {}, options)
  var second = budgetVariance.calculateTrend(rows.slice().reverse(), '2025-11', 2,
    { '2025-10': 80, '2025-11': 100 }, {}, options)
  assert.equal(JSON.stringify({ rows: rows, budgets: budgets }), before)
  assert.deepEqual(first, second)
  assert.deepEqual(first, budgetVariance.calculateTrend(rows, '2025-11', 2, budgets, {}, options))
})

test('预投影完整账本时避免重复退款配对', function () {
  var rows = [
    tx('pay', '2026-10-30', 'expense', 50, '餐饮', '青山商家'),
    tx('refund', '2026-11-03', 'refund', 20, '退款', '青山商城')
  ]
  var projected = stats.ledger(rows, true)
  var original = refundpair.pair
  refundpair.pair = function () { throw new Error('不应重复配对') }
  try {
    var result = calculate(rows, 50, { '餐饮': 50 }, { projected: projected })
    assert.equal(result.actualNetSpend, -20)
    assert.equal(cat(result, '餐饮').spent, -20)
  } finally {
    refundpair.pair = original
  }
})

test('接近预算阈值可配置且非法预算按未设置处理', function () {
  var rows = [tx('a', '2026-11-01', 'expense', 85, '餐饮', '饭店')]
  assert.equal(calculate(rows, 100, {}).overallStatus, 'near_budget')
  assert.equal(calculate(rows, 100, {}, { nearThreshold: 0.9 }).overallStatus, 'healthy')
  assert.equal(calculate(rows, 100, {}, { nearThreshold: 90 }).overallStatus, 'healthy')
  assert.equal(calculate(rows, true, { '餐饮': -1, 'bad': 'abc' }).overallStatus, 'no_budget')
})

test('建议与报告不包含投资建议', function () {
  var result = calculate([
    tx('a', '2026-11-01', 'expense', 120, '餐饮', '饭店'),
    tx('b', '2026-11-02', 'expense', 20, '娱乐', '影院')
  ], 100, { '餐饮': 100 })
  var text = result.reportText + '\n' + result.suggestions.join('\n') + '\n' +
    result.categories.map(function (row) { return row.advice }).join('\n')
  assert.doesNotMatch(text, /投资|股票|基金|理财/)
  assert.ok(result.suggestions.length <= 7)
})

function loadPage() {
  var definition
  global.Page = function (value) { definition = value }
  delete require.cache[require.resolve(pageFile)]
  require(pageFile)
  var page = Object.assign({}, definition, { data: clone(definition.data) })
  page.setData = function (patch, cb) {
    Object.assign(this.data, patch)
    if (cb) cb()
  }
  return page
}

function seedPage(current, previous) {
  storage.txs_v1 = [
    tx('mine', current + '-02', 'expense', 120, '餐饮', '我的饭店', { byMe: true }),
    tx('peer', current + '-03', 'expense', 80, '购物', '成员商店', {
      byMe: false, by: '成员', ownerKey: 'peer', shareBook: 'book-1'
    }),
    tx('peer-refund', current + '-05', 'refund', 20, '退款', '成员商店', {
      byMe: false, by: '成员', ownerKey: 'peer', shareBook: 'book-1'
    }),
    tx('old', previous + '-02', 'expense', 999, '餐饮', '旧饭店')
  ]
  storage.budget_v1 = 300
  storage.budcats_v1 = { '餐饮': 150, '购物': 100 }
  storage.shared_book_v1 = { bookId: 'book-1', name: '家庭账本', members: 2, nickname: '我' }
  store.reload()
}

test('页面默认本月并展示总览、分类、建议和报告', function () {
  var current = format.ymOf(Date.now())
  seedPage(current, format.shiftMonth(current, -1))
  var page = loadPage()
  page.onLoad()
  assert.equal(page.data.ym, current)
  assert.equal(page.data.maxYm, current)
  assert.equal(calls.title, '预算执行偏差分析')
  assert.equal(typeof watcher, 'function')
  page.onShow()
  assert.equal(page.data.loading, false)
  assert.equal(page.data.error, '')
  assert.equal(page.data.actualNetSpend, 180)
  assert.equal(page.data.totalBudget, 300)
  assert.equal(page.data.remaining, 120)
  assert.equal(page.data.scope, 'both')
  assert.equal(page.data.sharedOn, true)
  assert.match(page.data.scopeText, /家庭账本.*看双方/)
  assert.equal(page.data.categories.length, 2)
  assert.equal(page.data.categories[0].status, 'near_budget')
  assert.ok(page.data.suggestions.length > 0)
  assert.match(page.data.reportText, /2026|家庭账本/)
})

test('页面展示近六月趋势、缺失历史预算不补算且可单独复制', function () {
  var current = format.ymOf(Date.now())
  var previous = format.shiftMonth(current, -1)
  seedPage(current, previous)
  var page = loadPage()
  page.onLoad()
  page.onShow()
  assert.equal(page.data.trendMonths.length, 6)
  assert.equal(page.data.trendMonths[0].ym, format.shiftMonth(current, -5))
  assert.equal(page.data.trendMonths[5].ym, current)
  assert.equal(page.data.trendMonths[5].active, true)
  assert.equal(page.data.trendMonths[5].budget, 300)
  assert.equal(page.data.trendMonths[5].actualNetSpend, 180)
  assert.equal(page.data.trendMonths[5].variance, 120)
  assert.equal(page.data.trendMonths[5].usageRateText, '60.0%')
  assert.equal(page.data.trendMonths[4].ym, previous)
  assert.equal(page.data.trendMonths[4].actualNetSpend, 999)
  assert.equal(page.data.trendMonths[4].hasBudget, false)
  assert.equal(page.data.trendMonths[4].budgetMoneyText, '未设置')
  assert.equal(page.data.trendMonths[4].varianceMoneyText, '--')
  assert.equal(page.data.trendMonths[4].statusText, '未设预算')
  assert.match(page.data.trendBudgetNote, /历史月份未设置，不补算/)
  assert.match(page.data.trendText, /预算执行偏差趋势 · 近 6 个月/)
  page.copyTrend()
  assert.equal(clipboard, page.data.trendText)
  assert.equal(calls.toasts.at(-1), '趋势已复制')
  page.prevMonth()
  assert.equal(page.data.ym, previous)
  assert.equal(page.data.trendMonths[5].ym, previous)
  assert.equal(page.data.trendMonths[5].active, true)
  assert.equal(page.data.trendMonths[5].actualNetSpend, 999)
  assert.ok(page.data.trendMonths.every(function (row) { return !row.hasBudget }))
  assert.match(page.data.trendBudgetNote, /所选区间不含当前月/)
  page.currentMonth()
  page.setScope({ currentTarget: { dataset: { k: 'mine' } } })
  assert.equal(page.data.trendMonths[5].actualNetSpend, 120)
  assert.match(page.data.trendText, /只看自己/)
})

test('共同账本只看自己、双方、只看对方视角切换', function () {
  var current = format.ymOf(Date.now())
  seedPage(current, format.shiftMonth(current, -1))
  var page = loadPage()
  page.onLoad()
  page.onShow()
  page.setScope({ currentTarget: { dataset: { k: 'mine' } } })
  assert.equal(page.data.scope, 'mine')
  assert.equal(page.data.actualNetSpend, 120)
  assert.equal(page.data.categories.length, 2)
  page.setScope({ currentTarget: { dataset: { k: 'peer' } } })
  assert.equal(page.data.scope, 'peer')
  assert.equal(page.data.actualNetSpend, 60)
  assert.equal(cat({ categories: page.data.categories }, '购物').spent, 60)
  assert.equal(cat({ categories: page.data.categories }, '餐饮').noSpend, true)
  page.setScope({ currentTarget: { dataset: { k: 'both' } } })
  assert.equal(page.data.actualNetSpend, 180)
  assert.match(page.data.reportText, /看双方/)
})

test('页面月份切换、非法月份和未来月份保护', function () {
  var current = format.ymOf(Date.now())
  var previous = format.shiftMonth(current, -1)
  seedPage(current, previous)
  var page = loadPage()
  page.onLoad()
  page.onShow()
  page.prevMonth()
  assert.equal(page.data.ym, previous)
  assert.equal(page.data.actualNetSpend, 999)
  assert.equal(page.data.canNext, true)
  page.nextMonth()
  assert.equal(page.data.ym, current)
  page.nextMonth()
  assert.equal(page.data.ym, current)
  page.pickMonth({ detail: { value: previous } })
  assert.equal(page.data.ym, previous)
  page.pickMonth({ detail: { value: '9999-13' } })
  page.pickMonth({ detail: { value: '9999-12' } })
  assert.equal(page.data.ym, previous)
  page.currentMonth()
  assert.equal(page.data.ym, current)
})

test('页面复制报告、预算设置入口和返回行为', function () {
  var current = format.ymOf(Date.now())
  seedPage(current, format.shiftMonth(current, -1))
  app.globalData.backFor = '/pages/budget-variance/budget-variance'
  app.globalData.backTab = '/pages/report/report'
  app.globalData.backLabel = '报表'
  var page = loadPage()
  page.onLoad()
  page.onShow()
  assert.equal(page.data.backLabel, '报表')
  assert.equal(app.globalData.backFor, '')
  page.copyReport()
  assert.equal(clipboard, page.data.reportText)
  assert.equal(calls.toasts.at(-1), '报告已复制')
  page.goBudgetSettings()
  assert.equal(app.globalData.reportYm, current)
  assert.equal(app.globalData.reportSection, 'budget')
  assert.equal(calls.tabs.at(-1), '/pages/report/report')
  page.goBack()
  assert.equal(calls.tabs.at(-1), '/pages/report/report')
})

test('页面主题、深色监听与卸载清理', function () {
  var current = format.ymOf(Date.now())
  seedPage(current, format.shiftMonth(current, -1))
  storage.theme_v1 = 'amber'
  var page = loadPage()
  page.onLoad()
  page.onShow()
  assert.equal(page.data.themeKey, 'amber')
  dark = true
  watcher({ theme: 'dark' })
  assert.equal(page.data.dark, true)
  assert.equal(calls.styles.at(-1).backgroundColor, '#1b2421')
  page.onUnload()
  assert.equal(watcher, null)
  assert.equal(page._visible, false)
  assert.equal(page._unloaded, true)
})

test('页面模板绑定、主题类、深色和安全区契约完整', function () {
  var source = fs.readFileSync(pageFile, 'utf8')
  var wxml = fs.readFileSync(path.join(root, 'pages/budget-variance/budget-variance.wxml'), 'utf8')
  var wxss = fs.readFileSync(path.join(root, 'pages/budget-variance/budget-variance.wxss'), 'utf8')
  var page = loadPage()
  assert.ok(source.includes("'/pages/budget-variance/budget-variance'"))
  assert.ok(wxml.includes('theme-{{themeKey}}') && wxml.includes("{{dark ? 'dark' : ''}}"))
  assert.ok(wxml.includes('wx:for="{{categories}}"') && wxml.includes('bindtap="copyReport"'))
  assert.ok(wxml.includes('近 6 个月偏差趋势') && wxml.includes('wx:for="{{trendMonths}}"'))
  assert.ok(wxml.includes('bindtap="copyTrend"') && wxml.includes('bv-trend-progress-fill'))
  assert.ok(wxml.includes('data-k="both"') && wxml.includes('bindtap="setScope"'))
  var handlers = Array.from(wxml.matchAll(/bind(?:tap|change)="([^"]+)"/g), function (match) { return match[1] })
  handlers.forEach(function (name) { assert.equal(typeof page[name], 'function', '缺少页面处理器 ' + name) })
  assert.ok(wxss.includes('env(safe-area-inset-top)') && wxss.includes('env(safe-area-inset-bottom)'))
  assert.ok(wxss.includes('.bv-page.dark') && wxss.includes('--hero-bg-dark'))
  assert.ok(wxss.includes('.bv-trend-table') && wxss.includes('.dark .bv-trend-status.over'))
})

console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项')
if (failed) process.exitCode = 1
