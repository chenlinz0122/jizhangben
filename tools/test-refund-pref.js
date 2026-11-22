// 「退款不计入收支」开关的离线自测
// 跑法：node tools/test-refund-pref.js
const storage = {}
global.wx = {
  getStorageSync: (k) => (k in storage ? storage[k] : ''),
  setStorageSync: (k, v) => { storage[k] = v },
  removeStorageSync: (k) => { delete storage[k] }
}

const path = require('path')
const prefs = require(path.join(__dirname, '..', 'utils', 'prefs.js'))
const stats = require(path.join(__dirname, '..', 'utils', 'stats.js'))

let pass = 0
const fails = []
function check(name, cond, extra) {
  if (cond) pass++
  else fails.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''))
}

const ym = '2026-11'
const txs = [
  { id: 'a', ym: ym, day: '2026-11-03', time: Date.now(), type: 'expense', amount: 100, category: '餐饮', merchant: '饭店' },
  { id: 'b', ym: ym, day: '2026-11-05', time: Date.now(), type: 'refund', amount: 20, category: '退款', merchant: '饭店' },
  { id: 'c', ym: ym, day: '2026-11-10', time: Date.now(), type: 'income', amount: 50, category: '工资', merchant: '公司' }
]

/* 1. 默认口径：退款不计入 */
check('默认就是「不计入」', prefs.refundExcluded() === true, prefs.refundExcluded())
let s = stats.summary(txs, ym)
check('收入合计 = 只有真收入 50', s.incomeTotal === 50, s.incomeTotal)
check('支出按原价 100，不被退款抵扣', s.expenseNet === 100, s.expenseNet)
check('结余 = 50 - 100 = -50', s.net === -50, s.net)
check('退款金额单独还留着 20', s.refund === 20, s.refund)
check('收入构成里没有「退款」', s.byIncome.every((x) => x.name !== '退款'), s.byIncome.map((x) => x.name))
check('汇总里标了 refundOut', s.refundOut === true, s.refundOut)

/* 2. 日历热力：退款不计入当天入账 */
const cal = stats.calendar(txs, ym)
const day5 = cal.days[4]
check('11-05 那天的入账是 0（退款不算）', day5.income === 0, day5.income)

/* 3. 年度汇总同步 */
const ys = stats.yearSummary(txs, '2026')
check('年度入账 = 50', ys.incomeTotal === 50, ys.incomeTotal)
check('年度结余 = -50', ys.net === -50, ys.net)

/* 4. 关掉开关 → 回到老口径 */
prefs.setRefundExcluded(false)
check('关掉后 refundExcluded = false', prefs.refundExcluded() === false)
s = stats.summary(txs, ym)
check('关掉后入账 = 50 + 20 = 70', s.incomeTotal === 70, s.incomeTotal)
check('关掉后支出被退款冲减 = 80', s.expenseNet === 80, s.expenseNet)
check('关掉后结余 = 70 - 100 = -30', s.net === -30, s.net)
check('关掉后收入构成里有「退款」', s.byIncome.some((x) => x.name === '退款'), s.byIncome.map((x) => x.name))
const cal2 = stats.calendar(txs, ym)
check('关掉后 11-05 入账恢复 20', cal2.days[4].income === 20, cal2.days[4].income)

/* 5. 预算口径不受开关影响：退款照样抵扣 */
const bs = stats.budgetSpent(txs, ym)
check('预算仍按退款抵扣（100 - 20 = 80）', bs.net === 80, bs.net)
prefs.setRefundExcluded(true)
check('切回不计入后预算还是 80', stats.budgetSpent(txs, ym).net === 80, stats.budgetSpent(txs, ym).net)

/* 6. 只有退款没有收入的月份，别出现 NaN */
const onlyRefund = [txs[1]]
const sr = stats.summary(onlyRefund, ym)
check('只有退款时入账 0', sr.incomeTotal === 0, sr.incomeTotal)
check('只有退款时结余是 0 - 0 = 0', sr.net === 0, sr.net)

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项')
if (fails.length) {
  fails.forEach((f) => console.log('  ✗ ' + f))
  process.exit(1)
}
