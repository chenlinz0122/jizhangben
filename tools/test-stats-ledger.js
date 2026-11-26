// node tools/test-stats-ledger.js
var assert = require('assert')
var storage = Object.create(null)
global.wx = {
  getStorageSync: function (key) { return storage[key] || '' },
  setStorageSync: function (key, value) { storage[key] = value }
}
var stats = require('../utils/stats')
var prefs = require('../utils/prefs')
var refundpair = require('../utils/refundpair')
var pass = 0
var fails = []
var fixtures = []

function test(name, fn) {
  prefs.setRefundExcluded(true)
  try { fn(); pass++; console.log('PASS ' + name) } catch (e) {
    fails.push(name)
    console.error('FAIL ' + name + '\n' + e.stack)
  }
}

function tx(id, day, type, amount, cat, merchant, extra) {
  var row = {
    id: id, day: day, ym: day.slice(0, 7), time: new Date(day + 'T12:00:00').getTime(),
    type: type, amount: amount, category: cat, merchant: merchant
  }
  Object.keys(extra || {}).forEach(function (key) { row[key] = extra[key] })
  return row
}

function cents(n) { return Math.round(Number(n) * 100) }
function sum(rows, key) {
  return rows.reduce(function (total, row) { return total + cents(row[key]) }, 0) / 100
}
function named(rows, name) { return rows.filter(function (row) { return row.name === name })[0] }
function adjustments(rows) { return rows.filter(function (row) { return row.refundAdjustment }) }
function remember(rows) { fixtures.push(rows); return rows }
function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.keys(value).forEach(function (key) { freeze(value[key]) })
  return Object.freeze(value)
}

var partial = remember([
  tx('pay', '2026-11-03', 'expense', 100, '餐饮', '青山电商商家', { by: '本人', byMe: true }),
  tx('refund', '2026-11-05', 'refund', 20, '退款', '青山商城', {
    by: '本人', byMe: true, ownerKey: 'owner', shareBook: 'book', shareId: 'shared-refund',
    shareSourceId: 'source-refund', shareVersion: 3, source: 'bill', desc: '部分退款', extra: { kept: true }
  }),
  tx('salary', '2026-11-10', 'income', 50, '工资', '公司'),
  tx('transfer', '2026-11-12', 'transfer', 10, '理财', '银行')
])

test('partial refund preserves raw payments, metadata and input objects', function () {
  var before = JSON.stringify(partial)
  freeze(partial)
  var rows = stats.ledger(partial, true)
  assert.notStrictEqual(rows[0], partial[0])
  assert.deepStrictEqual(rows[0], partial[0])
  assert.deepStrictEqual(rows[2], partial[2])
  var r = adjustments(rows)[0]
  assert.strictEqual(r.amount, -20)
  assert.strictEqual(r.type, 'expense')
  assert.strictEqual(r.category, '餐饮')
  assert.strictEqual(r.merchant, '青山电商商家')
  assert.strictEqual(r.originalCategory, '退款')
  assert.strictEqual(r.refundMatched, true)
  ;['id', 'day', 'ym', 'time', 'by', 'byMe', 'ownerKey', 'shareBook', 'shareId',
    'shareSourceId', 'shareVersion', 'source', 'desc', 'extra'].forEach(function (key) {
    assert.deepStrictEqual(r[key], partial[1][key], key)
  })
  assert.ok(r.entryId)
  assert.strictEqual(JSON.stringify(partial), before)
  assert.deepStrictEqual(stats.totals(rows), { expense: 80, income: 50, count: 4, refundAdjustment: 20 })
  assert.deepStrictEqual(stats.totals([r]), { expense: -20, income: 0, count: 1, refundAdjustment: 20 })
})

test('included mode and explicit overrides do not re-project totals', function () {
  prefs.setRefundExcluded(false)
  var included = stats.ledger(partial)
  assert.deepStrictEqual(included[1], partial[1])
  assert.notStrictEqual(included[1], partial[1])
  assert.deepStrictEqual(stats.totals(included), { expense: 100, income: 70, count: 4, refundAdjustment: 0 })
  var excluded = stats.ledger(partial, true)
  assert.strictEqual(stats.totals(excluded).expense, 80)
  prefs.setRefundExcluded(true)
  assert.deepStrictEqual(stats.ledger(partial), excluded)
  assert.deepStrictEqual(stats.ledger(partial, false), included)
  assert.strictEqual(stats.totals(included).income, 70)
  assert.strictEqual(stats.totals(excluded.concat([excluded[1]])).count, 4)
})

var split = remember([
  tx('split-a', '2026-10-01', 'expense', 40, '餐饮', '青山商城'),
  tx('split-b', '2026-10-02', 'expense', 60, '服饰', '青山商家'),
  tx('split-r', '2026-11-06', 'refund', 100, '退款', '青山商城', { byMe: true, by: '本人' })
])

test('one refund splits across categories but keeps one original id and date', function () {
  var rows = stats.ledger(split)
  var refs = adjustments(rows)
  assert.strictEqual(rows.length, 4)
  assert.strictEqual(refs.length, 2)
  assert.notStrictEqual(refs[0].entryId, refs[1].entryId)
  assert.strictEqual(sum(refs, 'amount'), -100)
  assert.deepStrictEqual(refs.map(function (r) { return r.amount }).sort(), [-40, -60])
  refs.forEach(function (r) {
    assert.strictEqual(r.id, 'split-r')
    assert.strictEqual(r.day, '2026-11-06')
    assert.strictEqual(r.time, split[2].time)
    assert.strictEqual(r.by, '本人')
    assert.strictEqual(r.refundMatched, true)
  })
  assert.strictEqual(stats.totals(rows).count, 3)
  assert.strictEqual(stats.totals(refs).count, 1)
  assert.strictEqual(stats.summary(split, '2026-10').expense, 100)
  var s = stats.summary(split, '2026-11')
  assert.strictEqual(s.count, 1)
  assert.strictEqual(named(s.byCat, '餐饮').amount, -40)
  assert.strictEqual(named(s.byCat, '服饰').amount, -60)
  assert.strictEqual(stats.budgetSpent(split, '2026-11').matched, 100)
})

var crossMonth = remember([
  tx('oct-pay', '2026-10-31', 'expense', 80, '餐饮', '青山商家'),
  tx('nov-refund', '2026-11-07', 'refund', 30, '退款', '青山商城'),
  tx('nov-pay', '2026-11-09', 'expense', 10, '交通', '地铁')
])

test('cross-month categories and percentages use refund-date cashflow', function () {
  var oct = stats.summary(crossMonth, '2026-10')
  var nov = stats.summary(crossMonth, '2026-11')
  assert.strictEqual(oct.expense, 80)
  assert.strictEqual(named(oct.byCat, '餐饮').amount, 80)
  assert.strictEqual(nov.expense, -20)
  assert.strictEqual(nov.expenseNet, -20)
  assert.strictEqual(nov.expenseGross, 10)
  assert.strictEqual(nov.refund, 30)
  assert.strictEqual(named(nov.byCat, '餐饮').amount, -30)
  assert.strictEqual(named(nov.byCat, '餐饮').amountText, '-30.00')
  assert.strictEqual(named(nov.byCat, '餐饮').pct, 0)
  assert.strictEqual(named(nov.byCat, '交通').pct, 100)
  assert.strictEqual(stats.compareCats(crossMonth, '2026-12').amountOf('餐饮'), -30)
  assert.strictEqual(stats.compareCats(crossMonth, '2026-12').prevTotal, -20)
  var budget = stats.budgetSpent(crossMonth, '2026-11')
  assert.strictEqual(budget.net, 0)
  assert.strictEqual(budget.matched, 30)
  assert.strictEqual(budget.unmatched, 0)
  assert.strictEqual(budget.byCat['餐饮'], -30)
})

var crossYear = remember([
  tx('dec-pay', '2025-12-31', 'expense', 120, '购物', '旧年商户'),
  tx('jan-refund', '2026-01-02', 'refund', 120, '退款', '旧年商户')
])

test('cross-year refunds never restate earlier yearly spending', function () {
  assert.strictEqual(stats.yearSummary(crossYear, 2025).expense, 120)
  var year = stats.yearSummary(crossYear, '2026')
  assert.strictEqual(year.expense, -120)
  assert.strictEqual(year.expenseText, '-120.00')
  assert.strictEqual(year.expenseNet, -120)
  assert.strictEqual(year.net, 120)
  assert.strictEqual(year.topAll[0].amount, -120)
  assert.strictEqual(year.topAll[0].negative, true)
  assert.strictEqual(year.topAll[0].barPct, 0)
  assert.strictEqual(year.topAll[0].pct, 0)
  var day = stats.calendar(crossYear, '2026-01').days[1]
  assert.strictEqual(day.amount, -120)
  assert.strictEqual(day.amountText, '-120.00')
  assert.strictEqual(day.level, 0)
  assert.strictEqual(stats.budgetSpent(crossYear, '2025-12').net, 120)
  assert.strictEqual(stats.budgetSpent(crossYear, '2026-01').matched, 120)
})

test('precomputed full-ledger projections avoid repeated refund pairing', function () {
  var projected = stats.ledger(crossMonth, true)
  var originalPair = refundpair.pair
  var calls = 0
  refundpair.pair = function (rows) {
    calls++
    return originalPair(rows)
  }
  try {
    assert.strictEqual(stats.summary(crossMonth, '2026-11', projected).expense, -20)
    assert.strictEqual(stats.trend(crossMonth, '2026-11', 2, projected).length, 2)
    assert.strictEqual(stats.calendar(crossMonth, '2026-11', projected).days[6].amount, -30)
    assert.strictEqual(stats.insights(crossMonth, '2026-11', projected).net, -20)
    assert.strictEqual(stats.compareCats(crossMonth, '2026-12', projected).prevTotal, -20)
    assert.strictEqual(stats.topMerchants(crossMonth, '2026-11', 5, projected).length, 2)
    assert.strictEqual(stats.yearSummary(crossMonth, '2026', projected).expense, 60)
    assert.strictEqual(stats.budgetSpent(crossMonth, '2026-11', projected).matched, 30)
    assert.strictEqual(calls, 0)
  } finally {
    refundpair.pair = originalPair
  }
})

var onlyRefund = remember([tx('only-refund', '2026-02-01', 'refund', 40, '原退款类别', '__proto__')])
var overRefund = remember([
  tx('over-pay', '2026-02-01', 'expense', 5, '餐饮', '饭店'),
  tx('over-refund', '2026-02-02', 'refund', 20, '退款', '饭店')
])

test('unmatched and overrefund cashflow stays negative; only budget clamps', function () {
  var row = stats.ledger(onlyRefund)[0]
  assert.strictEqual(row.originalCategory, '原退款类别')
  assert.strictEqual(row.category, '未配对退款')
  assert.strictEqual(row.merchant, '__proto__')
  assert.strictEqual(row.amount, -40)
  assert.strictEqual(row.refundMatched, false)
  assert.strictEqual(stats.ledger(onlyRefund, false)[0].category, '退款')
  assert.strictEqual(stats.summary(onlyRefund, '2026-02').expense, -40)
  assert.strictEqual(stats.insights(onlyRefund, '2026-02').net, -40)
  assert.strictEqual(stats.yearSummary(onlyRefund, '2026').expense, -40)
  var s = stats.summary(overRefund, '2026-02')
  assert.strictEqual(s.expense, -15)
  assert.strictEqual(s.net, 15)
  assert.strictEqual(named(s.byCat, '未配对退款').amount, -20)
  var budget = stats.budgetSpent(overRefund, '2026-02')
  assert.strictEqual(budget.net, 0)
  // refundpair 撤回未全额配完的分摊；统计不另猜商户。
  assert.strictEqual(budget.matched, 0)
  assert.strictEqual(budget.unmatched, 20)
  assert.strictEqual(budget.byCat['餐饮'], 5)
  assert.strictEqual(budget.byCat['未配对退款'], -20)
})

test('the existing 180-day attribution window does not alter cashflow', function () {
  var rows = remember([
    tx('old', '2025-01-01', 'expense', 30, '餐饮', '饭店'),
    tx('late', '2026-02-01', 'refund', 30, '退款', '饭店')
  ])
  assert.strictEqual(stats.ledger(rows)[1].refundMatched, false)
  assert.strictEqual(stats.summary(rows, '2025-01').expense, 30)
  assert.strictEqual(stats.summary(rows, '2026-02').expense, -30)
})

test('refund allocations isolate self, member identity and shared book', function () {
  var rows = remember([
    tx('peer-pay', '2026-03-01', 'expense', 100, '餐饮', '饭店', { byMe: false, by: '同名', ownerKey: 'A', shareBook: 'one' }),
    tx('peer-good', '2026-03-02', 'refund', 20, '退款', '饭店', { byMe: false, by: '改名', ownerKey: 'A', shareBook: 'one' }),
    tx('peer-wrong', '2026-03-03', 'refund', 20, '退款', '饭店', { byMe: false, by: '同名', ownerKey: 'B', shareBook: 'one' }),
    tx('book-wrong', '2026-03-04', 'refund', 20, '退款', '饭店', { byMe: false, by: '同名', ownerKey: 'A', shareBook: 'two' }),
    tx('mine-wrong', '2026-03-05', 'refund', 20, '退款', '饭店', { byMe: true, by: '同名' })
  ])
  var refs = adjustments(stats.ledger(rows))
  assert.deepStrictEqual(refs.map(function (r) { return r.refundMatched }), [true, false, false, false])
  assert.deepStrictEqual(refs.map(function (r) { return r.category }), ['餐饮', '未配对退款', '未配对退款', '未配对退款'])
  refs.forEach(function (r, i) { assert.strictEqual(r.ownerKey, rows[i + 1].ownerKey) })
  assert.strictEqual(stats.budgetSpent(rows, '2026-03').matched, 20)
  assert.strictEqual(stats.budgetSpent(rows, '2026-03').unmatched, 60)
})

test('decimal amounts conserve cents in allocation and every aggregation', function () {
  var rows = remember([
    tx('cent-a', '2026-04-01', 'expense', 0.1, '餐饮', '小店'),
    tx('cent-b', '2026-04-02', 'expense', 0.2, '购物', '小店'),
    tx('cent-r', '2026-04-03', 'refund', 0.1 + 0.2, '退款', '小店'),
    tx('cent-i1', '2026-04-04', 'income', '0.10', '工资', '公司'),
    tx('cent-i2', '2026-04-04', 'income', 0.2, '工资', '公司')
  ])
  var projected = stats.ledger(rows)
  assert.strictEqual(stats.totals(projected).expense, 0)
  assert.strictEqual(stats.totals(projected).income, 0.3)
  assert.strictEqual(stats.totals(projected).refundAdjustment, 0.3)
  assert.strictEqual(stats.summary(rows, '2026-04').expenseGross, 0.3)
  assert.strictEqual(stats.summary(rows, '2026-04').refund, 0.3)
  assert.strictEqual(stats.summary(rows, '2026-04').net, 0.3)
  assert.strictEqual(stats.budgetSpent(rows, '2026-04').matched, 0.3)
  assert.strictEqual(stats.calendar(rows, '2026-04').days[2].amount, -0.3)
  assert.strictEqual(stats.calendar(rows, '2026-04').days[3].income, 0.3)
  assert.strictEqual(stats.ledger(rows, false)[2].amount, 0.3)
  var signed = stats.ledger([tx('signed', '2026-04-01', 'expense', -1.005, '修正', '店')])[0]
  assert.strictEqual(signed.amount, -1.01)
})

test('category, merchant, id and source dictionary keys are prototype-safe', function () {
  var rows = remember([
    tx('constructor', '2026-05-01', 'expense', 10, '__proto__', '__proto__', { source: '__proto__' }),
    tx('toString', '2026-05-02', 'expense', 20, 'constructor', 'constructor'),
    tx('-1', '2026-05-03', 'expense', 30, '-10', '-10'),
    tx('__total', '2026-05-04', 'expense', 40, '__total', '__total'),
    tx('__proto__', '2026-05-05', 'refund', 2, '退款', '__proto__')
  ])
  var s = stats.summary(rows, '2026-05')
  assert.strictEqual(s.count, 5)
  assert.strictEqual(s.expense, 98)
  assert.strictEqual(named(s.byCat, '__proto__').amount, 8)
  assert.strictEqual(named(s.byCat, 'constructor').amount, 20)
  assert.strictEqual(named(s.byCat, '-10').amount, 30)
  s.byCat.forEach(function (c) { assert.strictEqual(typeof c.color, 'string') })
  stats.yearSummary(rows, '2026').topAll.forEach(function (c) { assert.strictEqual(typeof c.icon, 'string') })
  assert.strictEqual(stats.budgetSpent(rows, '2026-05').byCat.__proto__, 8)
  assert.strictEqual(named(stats.topMerchants(rows, '2026-05', 20), '__proto__').amount, 8)
  assert.strictEqual(stats.compareCats(rows, '2026-06').amountOf('__total'), 40)
  assert.strictEqual(stats.compareCats(rows, '2026-06').amountOf('valueOf'), 0)
  assert.strictEqual(stats.audit(rows).bySource.__proto__, 1)
  assert.strictEqual({}.amount, undefined)
})

test('merchant ranking includes negative attributed and unmatched refund rows', function () {
  var rows = remember(crossMonth.concat([tx('merchant-r', '2026-11-10', 'refund', 7, '退款', '完全不同')]))
  var top = stats.topMerchants(rows, '2026-11', 20)
  assert.strictEqual(named(top, '青山商家').amount, -30)
  assert.strictEqual(named(top, '青山商家').amountText, '-30.00')
  assert.strictEqual(named(top, '完全不同').amount, -7)
  assert.strictEqual(sum(top, 'amount'), -27)
  prefs.setRefundExcluded(false)
  assert.deepStrictEqual(stats.topMerchants(rows, '2026-11', 20).map(function (r) { return r.name }), ['地铁'])
})

test('insights split signed amounts by refund weekday and retain largest original payment', function () {
  var rows = remember([
    tx('sat-pay', '2026-11-07', 'expense', 100, '餐饮', '饭店'),
    tx('mon-refund', '2026-11-09', 'refund', 100, '退款', '饭店'),
    tx('sun-unmatched', '2026-11-15', 'refund', 20, '退款', '别的店'),
    tx('mon-pay', '2026-11-16', 'expense', 10, '交通', '地铁')
  ])
  var insight = stats.insights(rows, '2026-11')
  assert.strictEqual(insight.net, -10)
  assert.strictEqual(insight.weekday, -90)
  assert.strictEqual(insight.weekend, 80)
  assert.strictEqual(insight.spentDays, 2)
  assert.strictEqual(insight.count, 2)
  assert.strictEqual(insight.maxTx, rows[0])
  assert.strictEqual(insight.avgDaily, Math.round(-10 / insight.elapsed * 100) / 100)
  prefs.setRefundExcluded(false)
  assert.deepStrictEqual(stats.insights(rows, '2026-11'), insight)
  var empty = stats.insights(onlyRefund, '2026-02')
  assert.strictEqual(empty.maxTx, null)
  assert.strictEqual(empty.spentDays, 0)
})

test('transfers, unclassified count and legacy summary fields are retained', function () {
  var rows = remember([
    tx('uncat-pay', '2026-07-01', 'expense', 12, '未分类', '店铺甲'),
    tx('uncat-refund', '2026-07-02', 'refund', 2, '退款', '店铺甲'),
    tx('invest', '2026-07-03', 'transfer', 0.1, '理财', '银行'),
    tx('loan', '2026-07-03', 'transfer', 0.2, '借还款', '银行'),
    tx('account', '2026-07-03', 'transfer', 0.3, '账户转移', '银行')
  ])
  var s = stats.summary(rows, '2026-07')
  assert.strictEqual(s.uncatCount, 1)
  assert.strictEqual(s.transfer, 0.6)
  assert.strictEqual(s.invest, 0.1)
  assert.strictEqual(s.loan, 0.2)
  assert.strictEqual(s.acct, 0.3)
  assert.strictEqual(s.byTransfer.length, 3)
  assert.strictEqual(s.count, 5)
  assert.strictEqual(s.income, 0)
  assert.strictEqual(s.expense, 10)
  assert.strictEqual(stats.summary(rows.concat([rows[0]]), '2026-07').count, 5)
})

test('uncategorized AI input excludes all read-only peer records', function () {
  var rows = [
    tx('mine-1', '2026-08-01', 'expense', 0.1, '未分类', '__proto__', { desc: '公开描述' }),
    tx('mine-2', '2026-08-02', 'expense', 0.2, '未分类', '__proto__'),
    tx('mine-short', '2026-08-02', 'expense', 1, '未分类', ''),
    tx('peer-1', '2026-08-03', 'expense', 100, '未分类', '__proto__', { byMe: false, desc: 'PRIVATE' }),
    tx('peer-2', '2026-08-03', 'expense', 100, '未分类', 'PRIVATE', { byMe: false, desc: 'PRIVATE' }),
    tx('peer-short', '2026-08-03', 'expense', 100, '未分类', '', { byMe: false })
  ]
  var groups = stats.uncatGroups(rows)
  assert.strictEqual(groups.total, 1)
  assert.strictEqual(groups.noMerchant, 1)
  assert.strictEqual(groups.items[0].count, 2)
  assert.strictEqual(groups.items[0].amountText, '0.30')
  assert.strictEqual(groups.items[0].d, '公开描述')
  assert.strictEqual(JSON.stringify(groups).indexOf('PRIVATE'), -1)
})

test('audit duplicate identity includes owner and book rather than nickname', function () {
  function peer(id, owner, book, by) {
    return tx(id, '2026-08-01', 'expense', 20, '餐饮', '饭店', {
      byMe: false, ownerKey: owner, shareBook: book, by: by, source: '__proto__'
    })
  }
  var rows = [
    peer('b-a', 'A', 'one', '同名'), peer('h-a', 'A', 'one', '改名'),
    peer('b-b', 'B', 'one', '同名'), peer('b-c', 'A', 'two', '同名'),
    peer('legacy-a', '', 'one', '同名'), peer('legacy-b', '', 'one', '同名'),
    peer('A', '', 'one', '同名'),
    tx('mine', '2026-08-01', 'expense', 20, '餐饮', '饭店', { by: '同名' })
  ]
  var audit = stats.audit(rows)
  assert.strictEqual(audit.dupGroups, 1)
  assert.strictEqual(audit.dupExtra, 1)
  assert.strictEqual(audit.list[0].count, 2)
  assert.strictEqual(audit.bySource.__proto__, 7)
})

test('empty and zero-amount data keep stable API fields and unique counts', function () {
  assert.deepStrictEqual(stats.ledger([]), [])
  assert.deepStrictEqual(stats.totals([]), { expense: 0, income: 0, count: 0, refundAdjustment: 0 })
  assert.strictEqual(stats.summary([], '2026-01').expense, 0)
  assert.strictEqual(stats.yearSummary([], '2026').count, 0)
  assert.strictEqual(stats.calendar([], '2026-02').days.length, 28)
  var zeros = remember([tx('zero', '2026-01-01', 'refund', 0, '退款', '店')])
  assert.strictEqual(stats.ledger(zeros).length, 1)
  assert.strictEqual(stats.summary(zeros, '2026-01').count, 1)
  assert.strictEqual(stats.calendar(zeros, '2026-01').days[0].amountText, '0.00')
})

function checkModes(rows) {
  var years = Object.create(null)
  rows.forEach(function (t) { years[t.ym.slice(0, 4)] = true })
  var before = JSON.stringify(rows)
  var modes = [true, false].map(function (exclude) {
    prefs.setRefundExcluded(exclude)
    var projected = stats.ledger(rows)
    rows.forEach(function (raw) {
      var derived = projected.filter(function (r) { return r.id === raw.id })
      var expected = (cents(raw.amount) / 100 * (exclude && raw.type === 'refund' ? -1 : 1)) || 0
      assert.strictEqual(sum(derived, 'amount'), expected, 'cent conservation ' + raw.id)
    })
    var result = Object.create(null)
    Object.keys(years).forEach(function (year) {
      var months = []
      var yearly = stats.yearSummary(rows, year)
      for (var month = 1; month <= 12; month++) {
        var ym = year + '-' + (month < 10 ? '0' : '') + month
        var s = stats.summary(rows, ym)
        var cal = stats.calendar(rows, ym)
        var totals = stats.totals(projected.filter(function (t) { return t.ym === ym }))
        assert.strictEqual(s.expense, totals.expense, ym + ' projected expense')
        assert.strictEqual(s.incomeTotal, totals.income, ym + ' projected income')
        assert.strictEqual(s.count, totals.count, ym + ' unique count')
        assert.strictEqual(sum(cal.days, 'amount'), s.expense, ym + ' daily/monthly expense')
        assert.strictEqual(sum(cal.days, 'income'), s.incomeTotal, ym + ' daily/monthly income')
        assert.strictEqual(sum(s.byCat, 'amount'), s.expense, ym + ' category expense')
        assert.strictEqual(sum(s.byIncome, 'amount'), s.incomeTotal, ym + ' category income')
        assert.strictEqual(s.expenseNet, (cents(s.expenseGross) - cents(s.refund)) / 100)
        var insight = stats.insights(rows, ym)
        assert.strictEqual(insight.net, s.expenseNet, ym + ' net insights')
        assert.strictEqual((cents(insight.weekday) + cents(insight.weekend)) / 100, insight.net)
        var budget = stats.budgetSpent(rows, ym)
        assert.strictEqual(budget.net, Math.max(s.expenseNet, 0), ym + ' budget consumed')
        assert.strictEqual((cents(budget.matched) + cents(budget.unmatched)) / 100, s.refund)
        var catSum = Object.keys(budget.byCat).reduce(function (n, k) { return n + cents(budget.byCat[k]) }, 0)
        assert.strictEqual(catSum / 100, s.expenseNet, ym + ' signed budget categories')
        result[ym] = { net: s.net, days: cal.days.map(function (d) { return cents(d.income) - cents(d.amount) }) }
        months.push(s)
      }
      assert.strictEqual(sum(months, 'expense'), yearly.expense, year + ' monthly/yearly expense')
      assert.strictEqual(sum(months, 'incomeTotal'), yearly.incomeTotal, year + ' monthly/yearly income')
      assert.strictEqual(sum(months, 'net'), yearly.net, year + ' monthly/yearly net')
      assert.strictEqual(sum(yearly.topAll, 'amount'), yearly.expense, year + ' expense ranking')
      assert.strictEqual(sum(yearly.topAllIn, 'amount'), yearly.incomeTotal, year + ' income ranking')
      assert.strictEqual(sum(stats.trend(rows, year + '-12', 12), 'net'), yearly.net, year + ' trend')
      result[year] = yearly.net
    })
    return result
  })
  assert.deepStrictEqual(modes[0], modes[1], 'daily/monthly/yearly net must be identical under toggle')
  assert.strictEqual(JSON.stringify(rows), before, 'statistics must not mutate raw input')
}

test('split refunds do not inflate same-category or merchant counts', function () {
  var rows = remember([
    tx('same-cat-a', '2026-11-01', 'expense', 60, '餐饮', '餐厅'),
    tx('same-cat-b', '2026-11-02', 'expense', 40, '餐饮', '餐厅'),
    tx('same-cat-r', '2026-11-03', 'refund', 100, '退款', '餐厅')
  ])
  assert.strictEqual(stats.ledger(rows).filter(function (t) { return t.refundAdjustment }).length, 2)
  assert.strictEqual(stats.summary(rows, '2026-11').byCat[0].count, 3)
  assert.strictEqual(stats.topMerchants(rows, '2026-11')[0].count, 3)
  assert.strictEqual(stats.yearSummary(rows, '2026').topAll[0].count, 3)
})

test('signed formatter retains rounding and never renders negative zero', function () {
  var format = require('../utils/format')
  assert.strictEqual(format.signedMoney(-1234.5), '-1,234.50')
  assert.strictEqual(format.signedMoney(-0.004), '0.00')
  assert.strictEqual(format.signedMoney(-1.005), '-1.01')
  assert.strictEqual(format.money(-1234.5), '1,234.50')
})

test('all fixtures reconcile across modes for every day, month and year', function () {
  fixtures.forEach(checkModes)
})

console.log('Passed ' + pass + ', failed ' + fails.length)
if (fails.length) process.exit(1)
