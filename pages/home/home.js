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
var shared = require('../../utils/shared')
var prefs = require('../../utils/prefs')

/* 退款和付款配对用的键：同商户名 + 同金额（按分比较） */
function refundKey(t) {
  return String(t.merchant || '').trim().toLowerCase() + '|' + Math.round((t.amount || 0) * 100)
}

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
    dark: false,

    sharedJoined: false,
    sharedName: '',
    sharedMembers: 0
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
    this.syncShared()

    /* 分享进来（?invite=）时，这里兜一次：核销成功会 +7 天，再刷一次状态 */
    var self = this
    vip.autoAcceptInvite(function (res) {
      if (res && res.ok) self.syncVip()
    })
  },

  /* 共同账本：显示账本名；打开链接进来且还没加入时问一句要不要加 */
  syncShared: function () {
    var self = this
    var b = shared.current()
    this.setData({
      sharedJoined: !!b,
      sharedName: (b && b.name) || '',
      sharedMembers: (b && b.members) || 0
    })

    var pending = shared.pendingShare()
    if (pending && !b) {
      wx.showModal({
        title: '一起记账？',
        content: '对方邀请你加入共同账本，加入后彼此的记录会同步到对方手机上。',
        confirmText: '加入',
        cancelText: '先不用',
        success: function (r) {
          if (!r.confirm) { shared.clearPendingShare(); return }
          shared.joinBook(pending, '', function (res) {
            shared.clearPendingShare()
            if (res && res.ok) {
              self.setData({
                sharedJoined: true,
                sharedName: res.name || '共同账本',
                sharedMembers: res.members || 1
              })
              wx.showToast({ title: '已加入共同账本', icon: 'none' })
              return
            }
            wx.showToast({ title: (res && res.msg) || '加入失败', icon: 'none' })
          })
        }
      })
      return
    }
    if (pending && b) shared.clearPendingShare()

    /* 已经加入了就顺手静默同步一次，但 5 分钟内不重复跑 */
    if (b && Date.now() - (b.lastSync || 0) > 5 * 60 * 1000) {
      shared.sync(function (res) {
        if (res && res.ok) {
          if (res.members) self.setData({ sharedMembers: res.members })
          if (res.added > 0) {
            self.syncData()
            wx.showToast({ title: '共同账本新增 ' + res.added + ' 条', icon: 'none' })
          }
        }
      })
    }
  },

  goShare: function () {
    wx.navigateTo({ url: '/pages/share/share' })
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
    var refundOut = prefs.refundExcluded()
    /* 抵消口径下，退款和它对应的那笔付款配成对，两条都不进最近流水 */
    var refundPool = {}
    if (refundOut) {
      for (var r = 0; r < txs.length; r++) {
        var rt = txs[r]
        if (rt.ym !== ym || rt.type !== 'refund') continue
        var rk = refundKey(rt)
        refundPool[rk] = (refundPool[rk] || 0) + 1
      }
    }
    for (var i = 0; i < txs.length && recent.length < 5; i++) {
      var t = txs[i]
      if (t.ym !== ym) continue
      if (t.type === 'refund' && refundOut) continue
      if (refundOut && t.type === 'expense') {
        var ek = refundKey(t)
        if (refundPool[ek] > 0) { refundPool[ek]--; continue }
      }
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
        count: s.count,
        refundText: format.money(s.refund),
        refundOut: refundOut
      },
      recent: recent,
      hasData: s.count > 0,
      uncatCount: s.uncatCount || 0
    })
  },

  /* 退款口径：抵消（默认）/ 计入入账。首页、流水页、报表页读的是同一个开关 */
  toggleRefund: function () {
    var next = prefs.setRefundExcluded(!prefs.refundExcluded())
    this.syncData()
    wx.showToast({
      title: next ? '退款已抵消，支出同步减少' : '退款已计入入账',
      icon: 'none'
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
