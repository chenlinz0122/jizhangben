// 「退款怎么算」开关的离线自测：退款记在退款发生日。
// 跑法：node tools/test-refund-pref.js
var storage = {}
global.wx = {
  getStorageSync: function (k) { return k in storage ? storage[k] : '' },
  setStorageSync: function (k, v) { storage[k] = v },
  removeStorageSync: function (k) { delete storage[k] }
}

var path = require('path')
var prefs = require(path.join(__dirname, '..', 'utils', 'prefs.js'))
var stats = require(path.join(__dirname, '..', 'utils', 'stats.js'))

var pass = 0
var fails = []
function check(name, cond, extra) {
  if (cond) pass++
  else fails.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''))
}

var ym = '2026-11'
var txs = [
  { id: 'a', ym: ym, day: '2026-11-03', time: new Date('2026-11-03T12:00:00').getTime(), type: 'expense', amount: 100, category: '餐饮', merchant: '饭店' },
  { id: 'b', ym: ym, day: '2026-11-05', time: new Date('2026-11-05T12:00:00').getTime(), type: 'refund', amount: 20, category: '退款', merchant: '饭店' },
  { id: 'c', ym: ym, day: '2026-11-10', time: new Date('2026-11-10T12:00:00').getTime(), type: 'income', amount: 50, category: '工资', merchant: '公司' }
]

/* 1. 默认口径：退款是负支出。 */
check('默认就是「抵消」', prefs.refundExcluded() === true, prefs.refundExcluded())
var s = stats.summary(txs, ym)
check('收入合计 = 只有真收入 50（退款不算收入）', s.incomeTotal === 50, s.incomeTotal)
check('支出 = 原价 100 - 退款 20 = 80', s.expense === 80, s.expense)
check('原价单独留着', s.expenseGross === 100, s.expenseGross)
check('分类构成也按净额 80', s.byCat[0].amount === 80, s.byCat)
check('结余 = 50 - 80 = -30', s.net === -30, s.net)
check('退款金额单独还留着 20', s.refund === 20, s.refund)
check('收入构成里没有「退款」', s.byIncome.every(function (x) { return x.name !== '退款' }), s.byIncome)
check('汇总里标了 refundOut', s.refundOut === true, s.refundOut)

/* 2. 日历退款日保留负支出。 */
var cal = stats.calendar(txs, ym)
var day5 = cal.days[4]
check('11-05 那天的入账是 0（退款不算收入）', day5.income === 0, day5.income)
check('11-05 那天的支出是 -20', day5.amount === -20, day5.amount)
check('负支出显示负号但不画热力', day5.amountText === '-20.00' && day5.level === 0, day5)

/* 3. 年度汇总同步。 */
var ys = stats.yearSummary(txs, '2026')
check('年度入账 = 50', ys.incomeTotal === 50, ys.incomeTotal)
check('年度支出 = 80', ys.expense === 80, ys.expense)
check('年度结余 = -30', ys.net === -30, ys.net)

/* 4. 计入入账只改变展示位置，日/月/年结余不变。 */
prefs.setRefundExcluded(false)
check('关掉后 refundExcluded = false', prefs.refundExcluded() === false)
s = stats.summary(txs, ym)
check('计入后入账 = 50 + 20 = 70', s.incomeTotal === 70, s.incomeTotal)
check('计入后支出按原价 = 100', s.expense === 100, s.expense)
check('计入后结余 = 70 - 100 = -30（跟抵消口径一致）', s.net === -30, s.net)
check('计入后收入构成里有「退款」', s.byIncome.some(function (x) { return x.name === '退款' }), s.byIncome)
var cal2 = stats.calendar(txs, ym)
check('计入后 11-05 入账恢复 20', cal2.days[4].income === 20, cal2.days[4].income)
check('退款日结余在开关前后一致', day5.income - day5.amount === cal2.days[4].income - cal2.days[4].amount)
check('年度结余在开关前后一致', stats.yearSummary(txs, '2026').net === ys.net)

/* 5. 预算口径不受开关影响。 */
var bs = stats.budgetSpent(txs, ym)
check('预算仍按退款抵扣（100 - 20 = 80）', bs.net === 80, bs.net)
prefs.setRefundExcluded(true)
check('切回抵消后预算还是 80', stats.budgetSpent(txs, ym).net === 80, stats.budgetSpent(txs, ym).net)

/* 6. 只有退款也必须保留现金流入。 */
var onlyRefund = [txs[1]]
var sr = stats.summary(onlyRefund, ym)
check('只有退款时入账 0', sr.incomeTotal === 0, sr.incomeTotal)
check('只有退款时支出 -20', sr.expense === -20, sr.expense)
check('只有退款时结余 +20', sr.net === 20, sr.net)
check('只有预算消耗夹到 0', stats.budgetSpent(onlyRefund, ym).net === 0)

/* 7. 超额退款不截断负支出。 */
var over = [
  { id: 'x', ym: ym, day: '2026-11-01', time: new Date('2026-11-01T12:00:00').getTime(), type: 'expense', amount: 10, category: '餐饮', merchant: '饭店' },
  { id: 'y', ym: ym, day: '2026-11-02', time: new Date('2026-11-02T12:00:00').getTime(), type: 'refund', amount: 30, category: '退款', merchant: '饭店' }
]
var so = stats.summary(over, ym)
check('退款 > 支出时支出 -20', so.expense === -20, so.expense)
check('退款 > 支出时结余 +20', so.net === 20, so.net)
prefs.setRefundExcluded(false)
check('只有退款的结余切换后不变', stats.summary(onlyRefund, ym).net === sr.net)
check('超额退款的结余切换后不变', stats.summary(over, ym).net === so.net)

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项')
if (fails.length) {
  fails.forEach(function (f) { console.log('  FAIL ' + f) })
  process.exit(1)
}
