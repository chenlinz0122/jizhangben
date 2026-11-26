const assert = require('assert')
const path = require('path')
const clone = (v) => v === undefined ? undefined : JSON.parse(JSON.stringify(v))
const disk = { txs_v1: [], prefs_v1: { refundOut: true } }
const app = { globalData: {} }
const nav = []
global.wx = {
  getStorageSync: (key) => key in disk ? clone(disk[key]) : '',
  setStorageSync: (key, value) => { disk[key] = clone(value) },
  removeStorageSync: (key) => { delete disk[key] },
  setNavigationBarTitle() {}, setTabBarStyle() {}, onThemeChange() {}, showToast() {},
  switchTab: (options) => nav.push(options.url), navigateTo: (options) => nav.push(options.url)
}
global.getApp = () => app
const format = require('../utils/format')
const store = require('../utils/store')
const stats = require('../utils/stats')
const prefs = require('../utils/prefs')
const refundpair = require('../utils/refundpair')
const ym = format.ymOf(Date.now())
const prior = format.shiftMonth(ym, -1)
function tx(id, type, amount, month, day, cat, merchant) {
  const p = month.split('-').map(Number)
  const time = new Date(p[0], p[1] - 1, day, 12).getTime()
  return { id, type, amount, time, day: format.dayOf(time), ym: month, category: cat, merchant: merchant || '饭店' }
}
function page(name) {
  let config
  global.Page = (value) => { config = value }
  const filename = path.resolve(__dirname, '../pages/' + name + '/' + name + '.js')
  delete require.cache[filename]
  require(filename)
  const out = Object.assign({}, config, { data: clone(config.data) })
  out.setData = function (values, cb) {
    for (const key of Object.keys(values)) {
      const parts = key.split('.')
      let target = this.data
      while (parts.length > 1) target = target[parts.shift()]
      target[parts[0]] = values[key]
    }
    if (cb && name !== 'report') cb()
  }
  out.data.ym = ym
  out.data.year = ym.slice(0, 4)
  return out
}
const list = page('list')
const home = page('home')
const report = page('report')
const cat = page('cat')
let pass = 0
const check = (value, message) => { assert.ok(value, message); pass++ }
function seed(rows) {
  disk.txs_v1 = clone(rows).sort((a, b) => b.time - a.time)
  store.reload()
  list.setData({ ym, kw: '', filterCat: '', filterKind: '', filterDay: '', onlyUncat: false, sharedOn: false })
  report.data.ym = ym
  home.data.ym = ym
  app.globalData = {}
}
function refreshAll() {
  list.refresh(); home.syncData(); report.refresh()
}
function visible() { return list.data.groups.flatMap((g) => g.items) }
const expense = tx('expense', 'expense', 100, ym, 3, '餐饮')
const refund = tx('refund', 'refund', 20, ym, 5, '退款')
const income = tx('income', 'income', 50, ym, 10, '工资', '公司')
const unmatched = tx('unmatched', 'refund', 30, ym, 6, '退款', '完全无关的退款方')

seed([expense, refund, income, unmatched])
const before = clone(disk.txs_v1)
refreshAll()
for (const [name, p] of [['流水', list], ['首页', home], ['报表', report]]) {
  check(p.data.s.expenseText === '50.00', name + '净支出100-20-30=50')
  check(p.data.s.incomeText === '50.00', name + '退款不伪装成收入')
  check(p.data.s.count === 4, name + '计数包括隐藏退款且不重计')
}
check(visible().find((t) => t.id === 'expense').amountText === '100.00', '保留原付款金额，不回改历史日')
check(!visible().some((t) => t.type === 'refund'), '抵减口径仍不展示退款明细行')
check(list.data.refundNote.includes('50.00') && list.data.refundNote.includes('到账日'), '隐藏退款有明确总计核对说明')
check(list.data.groups.reduce((sum, g) => sum + Math.round(Number(g.spendText) * 100), 0) === 5000, '每日净支出可相加得到月合计')
check(list.data.groups.some((g) => g.refundText === '20.00' && g.spendText === '-20.00'), '只有退款的日期保留负净支出汇总')
check(home.data.recent.some((t) => t.id === 'expense' && t.amountText === '100.00'), '首页最近流水保留原付款')
check(report.data.cats.find((c) => c.name === '餐饮').amountText === '80.00', '报表分类已经净额，不能再次扣款')
check(report.data.cats.find((c) => c.name === '未配对退款').amountText === '-30.00', '未匹配退款单列，不能冲掉无关分类')
assert.deepStrictEqual(disk.txs_v1, before); pass++

list.setData({ filterCat: '餐饮', filterKind: 'expense' }); list.refresh()
check(list.data.s.expenseText === '80.00', '筛选分类只抵减该分类20，不扣其他退款30')
check(list.data.s.count === 2, '分类计数含对应的付款和退款')
cat.setData({ cat: '餐饮', kind: 'expense', year: ym.slice(0, 4) }); cat.build()
check(cat.data.totalText === '80.00' && cat.data.months[0].totalText === '80.00', '年度分类详情与报表一致')
check(cat.data.months[0].items[0].amountText === '100.00' && cat.data.months[0].adjustments[0].text === '20.00', '分类详情保留付款，另外说明退款抵减')
list.setData({ filterCat: '未配对退款' }); list.refresh()
check(list.data.s.expenseText === '-30.00' && visible().length === 0 && list.data.groups.length === 1, '退款分类无可见交易行仍展示汇总，不是假空数据')
list.setData({ filterCat: '', filterKind: 'expense', filterDay: refund.day }); list.refresh()
check(list.data.s.expenseText === '-20.00', '从日历进入退款当天金额不被夹到零')
check(report.buildDaily(store.all(), ym, 'expense').list.some((d) => d.d === 5 && d.negative && d.h > 0), '负值日柱不会被当零抹掉')

const previousPayment = tx('previous', 'expense', 100, prior, 20, '餐饮')
const laterRefund = tx('later', 'refund', 100, ym, 2, '退款')
const currentPayment = tx('current', 'expense', 50, ym, 3, '购物', '百货店')
seed([previousPayment, laterRefund, currentPayment]); refreshAll()
check(list.data.s.expenseText === '-50.00' && home.data.s.netText === '50.00', '跨月退款按到账月增加结余')
list.setData({ ym: prior }); list.refresh()
check(list.data.s.expenseText === '100.00' && visible()[0].amountText === '100.00', '后一个月的退款不能让原付款月消失')
check(stats.summary(store.all(), prior).expense === 100, '上月汇总与上月明细一致')
list.setData({ ym, kw: '饭店', filterDay: '', filterCat: '', filterKind: '' }); list.refresh()
check(list.data.searching && list.data.s.expenseText === '0.00' && list.data.s.count === 2, '全局关键词搜索按全部命中的收付日期汇总')
check(visible().some((t) => t.id === 'previous'), '搜索保留上月原付款并单列本月抵减')

prefs.setRefundExcluded(false); refreshAll()
check(home.data.s.expenseText === '50.00' && home.data.s.incomeText === '100.00' && home.data.s.netText === '50.00', '切换展示方式不改变跨月结余')
list.setData({ kw: '', ym }); list.refresh()
check(visible().some((t) => t.type === 'refund'), '计入入账模式退款可查看和编辑')
check(report.data.s.netText === home.data.s.netText, '报表与首页结余一致')
prefs.setRefundExcluded(true)

seed([laterRefund]); refreshAll()
check(home.data.hasData && home.data.recent.length === 0 && home.data.s.expenseText === '-100.00', '只有退款不是空账本，净支出保留负数')
check(report.data.cats.length === 1 && report.data.cats[0].pct === 0, '只有退款的分类不生成负扇形占比')

seed([expense, refund])
list.setData({ filterCat: '购物', filterKind: 'income', filterDay: '2000-01-01', kw: '旧关键词', onlyUncat: true })
app.globalData = { filterYm: ym, filterCat: '餐饮', filterKind: 'expense', filterUncat: false, backFor: '/pages/list/list', backTab: '/pages/report/report' }
list.onShow()
check(!list.data.onlyUncat && list.data.kw === '' && list.data.filterDay === '' && list.data.s.expenseText === '80.00', '报表跳转完整替换旧筛选，不逐个留下旧条件')
list.setData({ filterDay: refund.day }); list.prevMonth()
check(list.data.filterDay === '', '换月份解除旧日期限制')
app.globalData = { filterCat: '旧分类', filterKind: 'income', filterDay: '旧日期' }
home.goList(); list.onShow()
check(list.data.filterCat === '' && list.data.filterKind === '' && list.data.filterDay === '' && list.data.backTab === '/pages/home/home', '首页全部流水入口清掉所有旧筛选')
list.goBack()
check(nav[nav.length - 1] === '/pages/home/home', '返回首页使用正确Tab')
home.pickMonth({ detail: { value: prior } })
home.goList(); list.onShow()
check(list.data.ym === prior, '合并后的首页查看全部保留所选月份')

const nativeSet = global.setTimeout
const nativeClear = global.clearTimeout
const timers = new Map()
let nextTimer = 0
try {
  global.setTimeout = (fn) => { timers.set(++nextTimer, fn); return nextTimer }
  global.clearTimeout = (id) => timers.delete(id)
  let refreshes = 0
  const originalRefresh = list.refresh
  list.refresh = () => { refreshes++ }
  list.onSearch({ detail: { value: '饭' } }); list.onSearch({ detail: { value: '饭店' } })
  check(timers.size === 1 && refreshes === 0, '连续输入只保留最后一次搜索任务')
  const callback = Array.from(timers.values())[0]; timers.clear(); callback()
  check(refreshes === 1 && list.data.kw === '饭店', '防抖后按最新关键词刷新一次')
  list.onSearch({ detail: { value: '离开' } }); list.onUnload()
  check(timers.size === 0, '页面卸载清理搜索任务')
  list.refresh = originalRefresh
} finally {
  global.setTimeout = nativeSet
  global.clearTimeout = nativeClear
}
const calls = []
const ctx = {
  scale() {}, clearRect() {}, beginPath() {}, closePath() {},
  arc: (x, y, radius, start, end) => { assert.ok(Number.isFinite(radius) && radius > 0 && Number.isFinite(start) && Number.isFinite(end)); calls.push(['arc', start, end]) },
  fill: () => calls.push(['fill']), stroke: () => calls.push(['stroke']),
  measureText: (text) => ({ width: text.length * 7 }),
  fillText: (text) => calls.push(['text', text])
}
global.wx.getWindowInfo = () => ({ pixelRatio: 1 })
global.wx.createSelectorQuery = () => ({ select: () => ({ fields: () => ({
  exec: (callback) => callback([{ node: { getContext: () => ctx }, width: 200, height: 200 }])
}) }) })
report.drawPie('pie', [{ _amt: -30, pct: 0 }], { text: '¥-30.00', label: '净支出' })
check(!calls.some((c) => c[0] === 'fill') && calls.some((c) => c[0] === 'stroke'), '只有退款时画中性圆环，不生成虚假正支出扇形')
check(calls.some((c) => c[0] === 'text' && c[1] === '¥-30.00'), '画布中心保留负净支出文本')
calls.length = 0
report.drawPie('pie', [{ _amt: 100, pct: 100, color: '#123456' }, { _amt: -20, pct: 0 }, { _amt: 0, pct: 0 }], { text: '¥80.00', label: '净支出' })
check(calls.filter((c) => c[0] === 'fill').length === 1, '非正分类不被强行画成最小扇形')
seed([laterRefund]); report.refresh()
check(report.data.cells.some((c) => c.d === 2 && c.negative), '日历明确标记净退款日期')
check(report.data.months.some((m) => m.ym === ym && m.negative && m.h > 0), '月度负值有可见柱而非被截断')
store.setBudget(100); report.refresh()
check(report.data.s.expenseText === '-100.00' && report.data.budgetSpentText === '0.00' && report.data.budgetLeftText === '100.00', '只在预算消耗处夹到零，不能抹掉实际净退款')

seed([
  tx('filter-a', 'expense', 100, ym, 3, '餐饮', '餐厅'),
  tx('filter-b', 'expense', 20, ym, 4, '交通', '地铁'),
  tx('filter-c', 'income', 50, ym, 5, '工资', '公司'),
  tx('filter-d', 'transfer', 200, ym, 6, '账户转移', '银行')
])
list.setData({
  kw: '', filterDay: '', filterCat: '', filterKind: '', onlyUncat: false,
  advanced: { minAmount: '50', maxAmount: '150', cats: ['餐饮'], accountId: '__none__', dateFrom: '', dateTo: '', excludeTransfer: true }
})
list.refresh()
check(visible().length === 1 && visible()[0].id === 'filter-a' && list.data.s.count === 1, '流水页组合高级筛选正确')
list.setData({ 'advanced.dateFrom': ym + '-04', 'advanced.dateTo': ym + '-30' })
list.refresh()
check(list.data.allDates && list.data.monthText === '自定义日期' && visible().length === 0, '自定义日期区间跨月筛选并显示正确标题')
list.clearFilter()
check(visible().length === 4 && !list.data.allDates, '清除全部筛选恢复默认流水')

const originalPair = refundpair.pair
let pairCalls = 0
refundpair.pair = function (rows) { pairCalls++; return originalPair(rows) }
try {
  seed([expense, refund])
  prefs.setRefundExcluded(true)
  report.refresh()
  check(pairCalls === 1, '报表抵减模式一次刷新只配对退款一次')
  pairCalls = 0
  prefs.setRefundExcluded(false)
  report.refresh()
  check(pairCalls === 1, '报表入账模式只为预算/洞察计算一次抵减投影')
  pairCalls = 0
  prefs.setRefundExcluded(true)
  home.syncData()
  check(pairCalls === 1, '首页汇总只配对退款一次')
} finally {
  refundpair.pair = originalPair
  prefs.setRefundExcluded(true)
}
const vip = require('../utils/vip')
report.goAnnual()
check(nav[nav.length - 1] === '/pages/annual/annual?year=' + ym.slice(0, 4), '报表可进入对应年度报告')
const originalGuard = vip.guard
vip.guard = () => true
try {
  report.goBudgetTemplates()
  check(nav[nav.length - 1] === '/pages/budget-templates/budget-templates', '会员可进入预算模板')
  report.goBudgetVariance()
  check(nav[nav.length - 1] === '/pages/budget-variance/budget-variance', '会员可进入预算偏差分析')
  report.goBudgetHistory()
  check(nav[nav.length - 1] === '/pages/budget-history/budget-history', '报表可进入历史预算存档')
} finally {
  vip.guard = originalGuard
}
console.log('通过 ' + pass + ' 项，失败 0 项')
