var format = require('../../utils/format')
var store = require('../../utils/store')
var stats = require('../../utils/stats')
var category = require('../../utils/category')

Page({
  data: {
    ym: '',
    maxYm: '',
    monthText: '',
    canNext: false,
    s: { expenseText: '0.00', incomeText: '0.00', netText: '0.00', netSign: '', count: 0, uncatCount: 0 },
    cats: [],
    recent: [],
    hasData: false
  },

  onLoad: function () {
    this.setData({ ym: format.ymOf(Date.now()), maxYm: format.ymOf(Date.now()) })
  },

  onShow: function () {
    this.refresh()
  },

  refresh: function () {
    var ym = this.data.ym || format.ymOf(Date.now())
    var txs = store.all()
    var s = stats.summary(txs, ym)
    var cats = s.byCat.slice(0, 6)

    var recent = []
    for (var i = 0; i < txs.length && recent.length < 6; i++) {
      var t = txs[i]
      if (t.ym !== ym) continue
      recent.push({
        id: t.id,
        merchant: t.merchant,
        category: t.category,
        color: category.colorOf(t.category),
        icon: category.iconOf(t.category),
        tint: category.tintOf(t.category),
        amountText: format.money(t.amount),
        timeText: format.shortTime(t.time),
        type: t.type,
        sign: (t.type === 'income' || t.type === 'refund') ? '+' : (t.type === 'transfer' ? '' : '-')
      })
    }

    this.setData({
      ym: ym,
      monthText: format.monthLabel(ym),
      canNext: ym < format.ymOf(Date.now()),
      s: {
        expenseText: format.money(s.expense),
        incomeText: format.money(s.incomeTotal),
        netText: format.money(Math.abs(s.net)),
        netSign: s.net < 0 ? '-' : '',
        count: s.count,
        uncatCount: s.uncatCount
      },
      cats: cats,
      recent: recent,
      hasData: s.count > 0
    })
  },

  prevMonth: function () {
    var self = this
    this.setData({ ym: format.shiftMonth(this.data.ym, -1) }, function () { self.refresh() })
  },

  nextMonth: function () {
    if (!this.data.canNext) return
    var self = this
    this.setData({ ym: format.shiftMonth(this.data.ym, 1) }, function () { self.refresh() })
  },

  /* 点中间的月份直接弹选择器，跳任意月份（不用一格一格点箭头） */
  pickMonth: function (e) {
    var now = format.ymOf(Date.now())
    var v = e.detail.value || now
    if (v > now) v = now
    var self = this
    this.setData({ ym: v }, function () { self.refresh() })
  },

  goImport: function () {
    wx.navigateTo({ url: '/pages/import/import' })
  },

  goAdd: function () {
    wx.navigateTo({ url: '/pages/add/add' })
  },

  goList: function () {
    wx.switchTab({ url: '/pages/list/list' })
  },

  goReport: function () {
    wx.switchTab({ url: '/pages/report/report' })
  },

  goUncat: function () {
    var app = getApp()
    /* 清掉上一个月/分类/日期筛选的残留，否则从报表跳进「未分类」时
     * list 页还挂在旧月份上，可能显示 0 笔，看起来像没有未分类数据。 */
    app.globalData.filterUncat = true
    app.globalData.filterCat = ''
    app.globalData.filterKind = ''
    app.globalData.filterYm = ''
    app.globalData.filterDay = ''
    wx.switchTab({ url: '/pages/list/list' })
  }
})
