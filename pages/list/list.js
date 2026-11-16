var format = require('../../utils/format')
var store = require('../../utils/store')
var stats = require('../../utils/stats')
var category = require('../../utils/category')

Page({
  data: {
    ym: '',
    monthText: '',
    canNext: false,
    onlyUncat: false,
    filterCat: '',
    filterKind: '',
    filterDay: '',
    kw: '',
    searching: false,
    groups: [],
    s: { expenseText: '0.00', incomeText: '0.00', count: 0 },
    sheetVisible: false,
    sheetItem: null,
    sheetCats: []
  },

  onLoad: function () {
    this.setData({ ym: format.ymOf(Date.now()) })
  },

  onShow: function () {
    var app = getApp()
    if (app.globalData.filterUncat) {
      app.globalData.filterUncat = false
      /* 从总览跳进「未分类」时，把月份重置到当前月，否则会沿用上次停留的旧月份，
       * 非搜索状态下刷新会按旧月份过滤，可能显示 0 笔。 */
      this.setData({ onlyUncat: true, ym: format.ymOf(Date.now()), kw: '', filterDay: '' })
    }
    /* 四个筛选条件各自独立读取，不能用 filterCat 当总开关——日历跳当天时 filterCat 是空串 */
    var jumped = !!(app.globalData.filterCat || app.globalData.filterKind ||
      app.globalData.filterYm || app.globalData.filterDay)
    if (app.globalData.filterCat) this.setData({ filterCat: app.globalData.filterCat })
    if (app.globalData.filterKind) this.setData({ filterKind: app.globalData.filterKind })
    if (app.globalData.filterYm) this.setData({ ym: app.globalData.filterYm })
    if (app.globalData.filterDay) this.setData({ filterDay: app.globalData.filterDay })
    /* 从报表跳过来时清掉搜索词，否则跨月搜索会把月份筛选顶掉 */
    if (jumped) this.setData({ kw: '' })
    app.globalData.filterCat = ''
    app.globalData.filterKind = ''
    app.globalData.filterYm = ''
    app.globalData.filterDay = ''
    this.refresh()
  },

  refresh: function () {
    var ym = this.data.ym
    var kw = (this.data.kw || '').trim().toLowerCase()
    var searching = !!kw
    var txs = store.all()

    var groups = []
    var cur = null
    var tExp = 0
    var tInc = 0
    var tCount = 0

    for (var i = 0; i < txs.length; i++) {
      var t = txs[i]
      if (!searching && t.ym !== ym) continue
      if (searching) {
        var hay = [t.merchant, t.desc, t.note, t.category].join(' ').toLowerCase()
        if (hay.indexOf(kw) < 0) continue
      }
      if (this.data.filterDay && t.day !== this.data.filterDay) continue
      if (this.data.onlyUncat && !(t.type === 'expense' && t.category === '未分类')) continue
      if (this.data.filterCat && t.category !== this.data.filterCat) continue
      if (this.data.filterKind === 'expense' && t.type !== 'expense') continue
      if (this.data.filterKind === 'income' && !(t.type === 'income' || t.type === 'refund')) continue

      tCount++
      if (t.type === 'expense') tExp += t.amount
      if (t.type === 'income' || t.type === 'refund') tInc += t.amount

      if (!cur || cur.day !== t.day) {
        var parts = t.day.split('-')
        cur = {
          day: t.day,
          label: parseInt(parts[1], 10) + '月' + parseInt(parts[2], 10) + '日',
          items: [],
          spend: 0
        }
        groups.push(cur)
      }

      var row = {
        id: t.id,
        merchant: t.merchant,
        category: t.category,
        amountText: format.money(t.amount),
        timeText: format.pad(new Date(t.time).getHours()) + ':' + format.pad(new Date(t.time).getMinutes()),
        type: t.type,
        sign: (t.type === 'income' || t.type === 'refund') ? '+' : (t.type === 'transfer' ? '' : '-'),
        color: category.colorOf(t.category),
        icon: category.iconOf(t.category),
        tint: category.tintOf(t.category),
        isUncat: t.category === '未分类'
      }
      cur.items.push(row)
      if (t.type === 'expense') cur.spend += t.amount
      if (t.type === 'refund') cur.spend -= t.amount
    }

    groups.forEach(function (g) {
      g.spendText = format.money(Math.max(g.spend, 0))
    })

    this.setData({
      monthText: searching ? '全部流水' : format.monthLabel(ym),
      canNext: ym < format.ymOf(Date.now()),
      searching: searching,
      groups: groups,
      s: {
        expenseText: format.money(tExp),
        incomeText: format.money(tInc),
        count: tCount
      }
    })
  },

  onSearch: function (e) {
    var self = this
    this.setData({ kw: e.detail.value }, function () { self.refresh() })
  },

  clearKw: function () {
    var self = this
    this.setData({ kw: '' }, function () { self.refresh() })
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

  toggleUncat: function () {
    var self = this
    this.setData({ onlyUncat: !this.data.onlyUncat }, function () { self.refresh() })
  },

  clearFilter: function () {
    var self = this
    this.setData({ filterCat: '', filterKind: '', filterDay: '' }, function () { self.refresh() })
  },

  openSheet: function (e) {
    var id = e.currentTarget.dataset.id
    var txs = store.all()
    var tx = null
    for (var i = 0; i < txs.length; i++) {
      if (txs[i].id === id) { tx = txs[i]; break }
    }
    if (!tx) return
    var cats = category.catsOf(tx.type).slice(0)
    if (tx.type !== 'transfer' && cats.indexOf('未分类') < 0) cats.push('未分类')
    this.setData({
      sheetVisible: true,
      sheetItem: {
        id: tx.id,
        merchant: tx.merchant,
        amountText: format.money(tx.amount),
        category: tx.category,
        source: tx.source
      },
      sheetCats: cats
    })
  },

  closeSheet: function () {
    this.setData({ sheetVisible: false, sheetItem: null })
  },

  pickCat: function (e) {
    var cat = e.currentTarget.dataset.cat
    var item = this.data.sheetItem
    if (!item) return
    var txs = store.all()
    var tx = null
    for (var i = 0; i < txs.length; i++) {
      if (txs[i].id === item.id) { tx = txs[i]; break }
    }
    if (!tx) return
    store.update(item.id, { category: cat })
    store.learn(tx.merchant, cat)
    this.setData({ sheetVisible: false, sheetItem: null })
    this.refresh()
    wx.showToast({ title: '已改成「' + cat + '」', icon: 'none' })
  },

  onLongPress: function (e) {
    var id = e.currentTarget.dataset.id
    var self = this
    wx.showModal({
      title: '删除这笔？',
      content: '删了就找不回来了',
      confirmText: '删除',
      confirmColor: '#d9433f',
      success: function (res) {
        if (!res.confirm) return
        store.remove(id)
        self.refresh()
      }
    })
  },

  /* 弹窗里直接删这笔（不靠长按，长按很多人不知道） */
  deleteSheetItem: function () {
    var item = this.data.sheetItem
    if (!item) return
    var self = this
    wx.showModal({
      title: '删除这笔？',
      content: item.merchant + ' ¥' + item.amountText + '\n删了就找不回来了',
      confirmText: '删除',
      confirmColor: '#d9433f',
      success: function (res) {
        if (!res.confirm) return
        store.remove(item.id)
        self.setData({ sheetVisible: false, sheetItem: null })
        self.refresh()
        wx.showToast({ title: '已删除', icon: 'none' })
      }
    })
  },

  /* 工具栏「⋯」：删本月 / 清空全部 */
  moreActions: function () {
    var self = this
    var ym = this.data.ym
    wx.showActionSheet({
      itemList: ['删除 ' + format.monthLabel(ym) + ' 的全部流水', '清空全部数据（含分类规则）'],
      success: function (res) {
        if (res.tapIndex === 0) self.clearMonth()
        else if (res.tapIndex === 1) self.clearEverything()
      }
    })
  },

  clearMonth: function () {
    var self = this
    var ym = this.data.ym
    var n = 0
    store.all().forEach(function (t) { if (t.ym === ym) n++ })
    if (!n) { wx.showToast({ title: '这个月本来就没数据', icon: 'none' }); return }
    wx.showModal({
      title: '删除 ' + format.monthLabel(ym) + ' 的流水？',
      content: '这个月共 ' + n + ' 笔，删了找不回来；其他月份不受影响。',
      confirmText: '删除',
      confirmColor: '#d9433f',
      success: function (res) {
        if (!res.confirm) return
        var removed = store.removeMonth(ym)
        self.refresh()
        wx.showToast({ title: '已删除 ' + removed + ' 笔', icon: 'none' })
      }
    })
  },

  clearEverything: function () {
    var self = this
    var n = store.all().length
    wx.showModal({
      title: '清空全部数据？',
      content: '库里 ' + n + ' 笔流水、学到的分类规则、月度预算会一起清零，找不回来。建议先去「导入」页把两份账单原件重新导一遍，再回来清。',
      confirmText: '全部清空',
      confirmColor: '#d9433f',
      success: function (res) {
        if (!res.confirm) return
        store.clearAll()
        self.setData({ onlyUncat: false, filterCat: '', filterKind: '', filterDay: '', kw: '' })
        self.refresh()
        wx.showToast({ title: '已清空', icon: 'none' })
      }
    })
  },

  noop: function () {},

  goImport: function () {
    wx.navigateTo({ url: '/pages/import/import' })
  }
})
