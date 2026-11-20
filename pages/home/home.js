// pages/home/home - 首页
//
// 定位：打开小程序第一眼看到的东西——打招呼、这个月花了多少、四个常用入口、最近几笔。
// 详细流水去「流水」页，图表分析去「报表」页，这里只做「一眼看清 + 最快记一笔」。

var format = require('../../utils/format')
var store = require('../../utils/store')
var stats = require('../../utils/stats')
var category = require('../../utils/category')
var vip = require('../../utils/vip')
var account = require('../../utils/account')
var theme = require('../../utils/theme')
var darkmode = require('../../utils/darkmode')

function greetText() {
  var h = new Date().getHours()
  if (h < 6) return '还没睡？'
  if (h < 11) return '早上好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

Page({
  data: {
    nick: '',
    avatar: '',
    isLogin: false,
    greeting: '',

    isVip: false,
    vipText: '',

    monthText: '',
    s: { expenseText: '0.00', incomeText: '0.00', netText: '0.00', netSign: '', count: 0 },
    recent: [],
    hasData: false,
    uncatCount: 0,

    themeKey: 'green',
    themes: [],
    dark: false
  },

  onLoad: function () {
    var self = this
    this.setData({
      greeting: greetText(),
      themeKey: theme.get().key,
      themes: theme.list(),
      dark: darkmode.isDark()
    })
    /* 系统切换深浅色时跟着变，不用重启小程序 */
    darkmode.watch(function (dark) { self.setData({ dark: dark }) })
    /* 第一次进来、没登录、也还没点过「先逛逛」→ 引导一次登录。
       延迟 300ms，别在首屏渲染时把页面盖住。 */
    if (!account.isLogin() && !account.skipped()) {
      setTimeout(function () {
        wx.navigateTo({ url: '/pages/login/login' })
      }, 300)
    }
  },

  onShow: function () {
    this.syncProfile()
    this.syncData()
    this.syncVip()
    this.syncTheme()
    this.syncDark()

    /* 分享进来（?invite=）时，这里兜一次：核销成功会 +7 天，再刷一次状态 */
    var self = this
    vip.autoAcceptInvite(function (res) {
      if (res && res.ok) self.syncVip()
    })
  },

  syncTheme: function () {
    var t = theme.get()
    this.setData({ themeKey: t.key, themes: theme.list() })
    theme.syncTabBar()
  },

  syncDark: function () {
    this.setData({ dark: darkmode.isDark() })
  },

  /* 换配色：只动主色和首页头部；tabBar 选中色只能在运行时改，顺手一起改 */
  pickTheme: function (e) {
    var key = e.currentTarget.dataset.key
    var t = theme.set(key)
    this.setData({ themeKey: t.key })
  },

  syncProfile: function () {
    var a = account.get()
    this.setData({
      nick: a.nick,
      avatar: a.avatar,
      isLogin: account.isLogin()
    })
  },

  syncData: function () {
    var ym = format.ymOf(Date.now())
    var txs = store.all()
    var s = stats.summary(txs, ym)

    var recent = []
    for (var i = 0; i < txs.length && recent.length < 5; i++) {
      var t = txs[i]
      if (t.ym !== ym) continue
      recent.push({
        id: t.id,
        merchant: t.merchant || '未填写商户',
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
      monthText: format.monthLabel(ym),
      s: {
        expenseText: format.money(s.expense),
        incomeText: format.money(s.incomeTotal),
        netText: format.money(Math.abs(s.net)),
        netSign: s.net < 0 ? '-' : '',
        count: s.count
      },
      recent: recent,
      hasData: s.count > 0,
      uncatCount: s.uncatCount || 0
    })
  },

  syncVip: function () {
    var self = this
    this.setData({
      isVip: vip.isVip(),
      vipText: vip.isVip() ? vip.statusText() : '未开通会员 · 点右上角'
    })
    if (this._vipChecked) return
    this._vipChecked = true
    vip.refresh(function () {
      self.setData({
        isVip: vip.isVip(),
        vipText: vip.isVip() ? vip.statusText() : '未开通会员 · 点右上角'
      })
    })
  },

  /* ---------- 头像 ---------- */
  tapAvatar: function () {
    if (!this.data.isLogin) {
      wx.navigateTo({ url: '/pages/login/login' })
      return
    }
    wx.showActionSheet({
      itemList: ['换个昵称头像', '退出登录'],
      success: function (res) {
        if (res.tapIndex === 0) {
          wx.navigateTo({ url: '/pages/login/login' })
        } else if (res.tapIndex === 1) {
          wx.showModal({
            title: '退出登录',
            content: '只清昵称和头像，账本数据一条都不动。',
            confirmText: '退出',
            success: function (r) {
              if (!r.confirm) return
              account.logout()
              account.markSkip()
              wx.reLaunch({ url: '/pages/home/home' })
            }
          })
        }
      }
    })
  },

  /* ---------- 入口 ---------- */
  goAdd: function () {
    wx.navigateTo({ url: '/pages/add/add' })
  },

  goShot: function () {
    wx.navigateTo({ url: '/pages/shot/shot' })
  },

  goImport: function () {
    wx.navigateTo({ url: '/pages/import/import' })
  },

  goVip: function () {
    wx.navigateTo({ url: '/pages/vip/vip' })
  },

  openFeedback: function () {
    wx.navigateTo({ url: '/pages/feedback/feedback' })
  },

  goList: function () {
    var app = getApp()
    app.globalData.backFor = '/pages/list/list'
    app.globalData.backTab = '/pages/home/home'
    app.globalData.backLabel = '首页'
    wx.switchTab({ url: '/pages/list/list' })
  },

  goReport: function () {
    var app = getApp()
    app.globalData.backFor = '/pages/report/report'
    app.globalData.backTab = '/pages/home/home'
    app.globalData.backLabel = '首页'
    wx.switchTab({ url: '/pages/report/report' })
  },

  goUncat: function () {
    var app = getApp()
    app.globalData.filterUncat = true
    app.globalData.filterCat = ''
    app.globalData.filterKind = ''
    app.globalData.filterYm = ''
    app.globalData.filterDay = ''
    app.globalData.backFor = '/pages/list/list'
    app.globalData.backTab = '/pages/home/home'
    app.globalData.backLabel = '首页'
    wx.switchTab({ url: '/pages/list/list' })
  }
})
