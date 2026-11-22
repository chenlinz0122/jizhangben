// 「退款怎么算」开关的离线自测（默认口径 = 退款抵消：不进收入、也扣支出）
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

/* 1. 默认口径：退款抵消（两边都不算这一笔） */
check('默认就是「抵消」', prefs.refundExcluded() === true, prefs.refundExcluded())
let s = stats.summary(txs, ym)
check('收入合计 = 只有真收入 50（退款不算收入）', s.incomeTotal === 50, s.incomeTotal)
check('支出 = 原价 100 - 退款 20 = 80', s.expense === 80, s.expense)
check('原价单独留着（给分类构成用）', s.expenseGross === 100, s.expenseGross)
check('结余 = 50 - 80 = -30', s.net === -30, s.net)
check('退款金额单独还留着 20', s.refund === 20, s.refund)
check('收入构成里没有「退款」', s.byIncome.every((x) => x.name !== '退款'), s.byIncome.map((x) => x.name))
check('汇总里标了 refundOut', s.refundOut === true, s.refundOut)

/* 2. 日历热力：退款那天从支出里扣回去 */
const cal = stats.calendar(txs, ym)
const day5 = cal.days[4]
check('11-05 那天的入账是 0（退款不算收入）', day5.income === 0, day5.income)
check('11-05 那天的支出被退款扣成 0（当天没别的支出）', day5.amount === 0, day5.amount)

/* 3. 年度汇总同步 */
const ys = stats.yearSummary(txs, '2026')
check('年度入账 = 50', ys.incomeTotal === 50, ys.incomeTotal)
check('年度支出 = 80', ys.expense === 80, ys.expense)
check('年度结余 = -30', ys.net === -30, ys.net)

/* 4. 切到「计入入账」：退款算进账、支出按原价，结余应当一样 */
prefs.setRefundExcluded(false)
check('关掉后 refundExcluded = false', prefs.refundExcluded() === false)
s = stats.summary(txs, ym)
check('计入后入账 = 50 + 20 = 70', s.incomeTotal === 70, s.incomeTotal)
check('计入后支出按原价 = 100', s.expense === 100, s.expense)
check('计入后结余 = 70 - 100 = -30（跟抵消口径一致）', s.net === -30, s.net)
check('计入后收入构成里有「退款」', s.byIncome.some((x) => x.name === '退款'), s.byIncome.map((x) => x.name))
const cal2 = stats.calendar(txs, ym)
check('计入后 11-05 入账恢复 20', cal2.days[4].income === 20, cal2.days[4].income)

/* 5. 预算口径不受开关影响：退款照样抵扣 */
const bs = stats.budgetSpent(txs, ym)
check('预算仍按退款抵扣（100 - 20 = 80）', bs.net === 80, bs.net)
prefs.setRefundExcluded(true)
check('切回抵消后预算还是 80', stats.budgetSpent(txs, ym).net === 80, stats.budgetSpent(txs, ym).net)

/* 6. 只有退款、没有支出的月份：支出别出负数 */
const onlyRefund = [txs[1]]
const sr = stats.summary(onlyRefund, ym)
check('只有退款时入账 0', sr.incomeTotal === 0, sr.incomeTotal)
check('只有退款时支出夹到 0', sr.expense === 0, sr.expense)
check('只有退款时结余 0', sr.net === 0, sr.net)

/* 7. 退款比支出还多的月份：支出不能是负数 */
const over = [
  { id: 'x', ym: ym, day: '2026-11-01', time: Date.now(), type: 'expense', amount: 10, category: '餐饮', merchant: '饭店' },
  { id: 'y', ym: ym, day: '2026-11-02', time: Date.now(), type: 'refund', amount: 30, category: '退款', merchant: '饭店' }
]
const so = stats.summary(over, ym)
check('退款 > 支出时支出夹到 0', so.expense === 0, so.expense)
check('退款 > 支出时结余 = 0 - 0 = 0', so.net === 0, so.net)

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项')
if (fails.length) {
  fails.forEach((f) => console.log('  ✗ ' + f))
  process.exit(1)
}
