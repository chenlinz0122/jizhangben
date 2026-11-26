/* 分类明细：某一年的某个分类，全部明细按月分段，从上到下从新到旧
 * 入口：报表页「年度汇总」里点分类。查账单时最常问的是「这一类今年都花在哪了」，
 * 所以按月切段 + 每段带小计，比丢进流水页混在别的分类里看要直接。
 * kind = expense（支出）/ income（入账，含退款）。 */
var darkmode = require('../../utils/darkmode')
var format = require('../../utils/format')
var store = require('../../utils/store')
var shared = require('../../utils/shared')
var prefs = require('../../utils/prefs')
var stats = require('../../utils/stats')

var WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

var theme = require('../../utils/theme')

Page({
  data: {
    dark: false,
    themeKey: 'green',
    cat: '',
    year: '',
    kind: 'expense',
    totalText: '0.00',
    count: 0,
    monthCount: 0,
    avgText: '0.00',
    maxText: '0.00',
    maxMerchant: '',
    months: [],
    sheetVisible: false,
    sheet: null
  },

  onLoad: function (options) {
    var y = String((options && options.year) || '').slice(0, 4)
    if (!/^\d{4}$/.test(y)) y = format.ymOf(Date.now()).slice(0, 4)
    var c = (options && options.cat) || ''
    try {
      c = decodeURIComponent(c)
    } catch (e) {
      /* 参数没编码就原样用 */
    }
    var kind = options && options.kind === 'income' ? 'income' : 'expense'
    this.setData({ year: y, cat: c, kind: kind })
    wx.setNavigationBarTitle({ title: c ? c + ' · ' + y : '分类明细' })
  },

  /* 页面内返回：原生导航栏本来就有箭头，但换手机/深色模式偶尔不好找，
   * 所以自己再给一个；万一没有上一页（比如从分享卡片直接打开），回报表页。 */
  goBack: function () {
    var pages = getCurrentPages()
    if (pages && pages.length > 1) {
      wx.navigateBack()
    } else {
      wx.switchTab({ url: '/pages/report/report' })
    }
  },

  /* 放在 onShow 里建：从这一页出去改了流水再回来，数字要是新的 */
  onShow: function () {
    this.setData({ themeKey: theme.get().key, dark: darkmode.isDark() })
    if (this.data.cat) this.build()
  },

  /* 点一笔 → 看这一笔的完整信息（这一页只读，改/删还是回流水页做） */
  openDetail: function (e) {
    var id = e.currentTarget.dataset.id
    if (!id) return
    var txs = shared.viewRows(store.all(), prefs.viewScope())
    var tx = null
    for (var i = 0; i < txs.length; i++) {
      if (txs[i].id === id) { tx = txs[i]; break }
    }
    if (!tx) return
    var d = new Date(tx.time)
    var income = tx.type === 'income' || tx.type === 'refund'
    this.setData({
      sheetVisible: true,
      sheet: {
        merchant: tx.merchant || '（没有商户名）',
        amountText: format.money(tx.amount),
        sign: income ? '+' : '-',
        inc: income,
        typeText: tx.type === 'expense' ? '支出' : (tx.type === 'income' ? '收入' : (tx.type === 'refund' ? '退款' : '不计收支')),
        dateText: tx.day.slice(0, 4) + ' 年 ' + parseInt(tx.day.slice(5, 7), 10) + ' 月 ' +
          parseInt(tx.day.slice(8), 10) + ' 日 ' + WEEK[d.getDay()],
        timeText: format.pad(d.getHours()) + ':' + format.pad(d.getMinutes()),
        category: tx.category,
        sourceText: tx.source || '—',
        desc: String(tx.desc || tx.note || '').trim()
      }
    })
  },

  closeDetail: function () {
    this.setData({ sheetVisible: false, sheet: null })
  },

  noop: function () {},

  build: function () {
    var year = this.data.year
    var cat = this.data.cat
    var income = this.data.kind === 'income'
    var txs = stats.ledger(shared.viewRows(store.all(), prefs.viewScope()))
    var list = txs.filter(function (t) {
      return (income ? (t.type === 'income' || t.type === 'refund') : t.type === 'expense') &&
        t.category === cat && String(t.ym || '').slice(0, 4) === year
    }).sort(function (a, b) { return b.time - a.time })
    var total = stats.totals(list)
    var amount = income ? total.income : total.expense
    var maxTx = null
    var map = Object.create(null)

    for (var j = 0; j < list.length; j++) {
      var x = list[j]
      var ym = x.ym
      if (!x.refundAdjustment && (!maxTx || x.amount > maxTx.amount)) maxTx = x
      if (!map[ym]) map[ym] = { rows: [], items: [], adjustments: Object.create(null) }
      var g = map[ym]
      g.rows.push(x)
      if (x.refundAdjustment) {
        g.adjustments[x.day] = (g.adjustments[x.day] || 0) + Math.round(-x.amount * 100)
        continue
      }
      var d = new Date(x.time)
      g.items.push({
        id: x.id,
        merchant: x.merchant || '（没有商户名）',
        desc: String(x.desc || x.note || '').trim(),
        dayText: parseInt(x.day.slice(8), 10) + ' 日',
        weekText: WEEK[d.getDay()],
        timeText: format.pad(d.getHours()) + ':' + format.pad(d.getMinutes()),
        amountText: format.money(x.amount),
        sign: income ? '+' : '-'
      })
    }
    var months = Object.keys(map).sort().reverse().map(function (ym) {
      var g = map[ym]
      var sum = stats.totals(g.rows)
      return {
        ym: ym, label: parseInt(ym.slice(5, 7), 10) + ' 月',
        totalText: format.signedMoney(income ? sum.income : sum.expense), count: sum.count,
        adjustments: Object.keys(g.adjustments).sort().reverse().map(function (day) {
          return { day: day, text: format.money(g.adjustments[day] / 100) }
        }),
        items: g.items
      }
    })
    this.setData({
      refundOut: prefs.refundExcluded(),
      totalText: format.signedMoney(amount), count: total.count,
      monthCount: months.length,
      avgText: months.length ? format.signedMoney(amount / months.length) : '0.00',
      maxText: maxTx ? format.money(maxTx.amount) : '0.00',
      maxMerchant: maxTx ? (maxTx.merchant || '') : '', months: months
    })
  }
})
