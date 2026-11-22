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

function greetText() {
  var h = new Date().getHours()
  /* 不带标点：wxml 里统一拼「问候，名字」，带问号会拼成「还没睡？，小满」 */
  if (h < 6) return '夜深了'
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

    ym: '',
    maxYm: '',
    monthText: '',
    isCurrent: true,
    canNext: false,
    cats: [],
    budget: 0,
    budgetPct: 0,
    budgetOver: false,
    scope: 'both',
    s: { expenseText: '0.00', incomeText: '0.00', netText: '0.00', netSign: '', count: 0 },
    recent: [],
    hasData: false,
    uncatCount: 0,

    themeKey: 'green',
    dark: false,

    sharedJoined: false,
    sharedName: '',
    sharedMembers: 0,
    sharedStatus: '',
    sharedSyncing: false,
    sharedScopeRequired: false,
    /* 共同账本视角小标：只看自己 / 看双方 / 只看对方 */
    scopeLabel: ''
  },

  onLoad: function () {
    var self = this
    this.setData({
      greeting: greetText(),
      themeKey: theme.get().key,
      ym: format.ymOf(Date.now()), maxYm: format.ymOf(Date.now()),
      dark: darkmode.isDark()
    })
    this._unwatchDark = darkmode.watch(function (dark) {
      self.setData({ dark: dark })
      if (self._homeVisible) theme.syncTabBar()
    })
  },

  onShow: function () {
    this._homeVisible = true
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

  onHide: function () {
    this._homeVisible = false
  },

  onUnload: function () {
    if (this._unwatchDark) this._unwatchDark()
  },

  applyShared: function () {
    var b = shared.current()
    if (b && b.shareSince != null && this.data.sharedScopeRequired) {
      this.setData({ sharedStatus: '共享范围：' + shared.scopeText() })
    }
    this.setData({
      sharedJoined: !!(b && b.bookId),
      sharedName: (b && b.name) || '共同账本',
      sharedMembers: (b && b.members) || 0,
      sharedScopeRequired: !!(b && b.shareSince == null)
    })
  },

  sharedError: function (res, fallback) {
    var msg = (res && res.msg) || fallback
    if (res && res.code === 'UPGRADE_REQUIRED') msg += '；请上传并部署新版云函数 book 后重试'
    return msg + (res && res.code ? '（' + res.code + '）' : '')
  },

  /* 无本机缓存也尝试恢复成员身份；离线不丢掉已加入的展示。 */
  syncShared: function () {
    this.applyShared()
    if (this._sharedLoading || this._syncing || this._joining || this._invitePrompt) return
    if (shared.busy()) {
      this.setData({ sharedStatus: '共同账本正在处理其他操作，请稍后同步' })
      return
    }
    var self = this
    this._sharedLoading = true
    shared.info(function (res) {
      self._sharedLoading = false
      self.applyShared()
      if (!res || !res.ok) {
        self.setData({ sharedStatus: self.sharedError(res, '暂时无法查询共同账本，请检查网络后重试') })
        return
      }
      self.syncData()
      if (self._homeVisible === false) return
      var b = shared.current()
      if (!res.joined || !b) {
        self.setData({ sharedStatus: '创建或加入后，先确认共享范围再同步' })
        self.acceptPendingShare()
        return
      }
      var pending = shared.pendingShare()
      if (pending && pending === b.code) shared.clearPendingShare()
      if (b.shareSince == null) {
        self.setData({ sharedStatus: '尚未确认共享范围，请点「管理 / 邀请」选择；未确认不会自动同步' })
        return
      }
      if (!self.data.sharedStatus) self.setData({ sharedStatus: '共享范围：' + shared.scopeText() })
      // 自动和手动使用同一把页面锁；失败也限频，避免反复 onShow 重试。
      var lastAttempt = self._autoBookId === b.bookId ? (self._lastSyncAttempt || 0) : 0
      if (Date.now() - Math.max(b.lastSync || 0, lastAttempt) > 5 * 60 * 1000) self.runSharedSync(false)
    })
  },

  acceptPendingShare: function () {
    var pending = shared.pendingShare()
    if (!pending || shared.current() || this._invitePrompt || this._joining || shared.busy()) return
    var self = this
    this._invitePrompt = true
    wx.showModal({
      title: '一起记账？',
      content: '加入后，账本昵称对成员可见。流水要先选择并确认共享范围才会上传；确认后首页可自动同步。',
      confirmText: '加入',
      cancelText: '先不用',
      success: function (r) {
        self._invitePrompt = false
        if (!r.confirm) { shared.clearPendingShare(); return }
        if (shared.busy()) { self.setData({ sharedStatus: '共同账本正在处理其他操作，邀请码已保留，请稍后重试' }); return }
        self._joining = true
        self.setData({ sharedStatus: '正在加入共同账本…' })
        shared.joinBook(pending, '', function (res) {
          self._joining = false
          if (res && res.ok) {
            shared.clearPendingShare()
            self.applyShared()
            self.syncData()
            self.setData({ sharedStatus: '已加入，请先在管理页确认共享范围' })
            self.goShare()
            return
          }
          self.setData({ sharedStatus: self.sharedError(res, '加入失败') + '；邀请码已保留，可进管理页重试' })
        })
      },
      fail: function () {
        self._invitePrompt = false
        self.setData({ sharedStatus: '邀请确认未完成，邀请码已保留，可进管理页重试' })
      }
    })
  },

  /* 管理/邀请始终进入管理页，与明确的同步按钮分开。 */
  goShare: function () {
    wx.navigateTo({ url: '/pages/share/share' })
  },

  doSync: function () {
    this.runSharedSync(true)
  },

  runSharedSync: function (manual) {
    var b = shared.current()
    if (!b || !b.bookId) { if (manual) this.goShare(); return }
    if (b.shareSince == null) {
      this.setData({ sharedStatus: '请先在管理页选择并确认共享范围，尚未开始同步' })
      if (manual) this.goShare()
      return
    }
    if (this._syncing || this._sharedLoading || this._joining || this._invitePrompt || shared.busy()) {
      if (manual) this.setData({ sharedStatus: '共同账本正在处理，请稍后再同步' })
      return
    }
    this._syncing = true
    this._autoBookId = b.bookId
    this._lastSyncAttempt = Date.now()
    this.setData({ sharedSyncing: true, sharedStatus: '同步中，请稍候' })
    var self = this
    shared.sync(function (res) {
      self._syncing = false
      self.setData({ sharedSyncing: false })
      self.applyShared()
      // 更新、删除以及部分成功写入都要重绘，不能只检查 added。
      self.syncData()
      if (res && res.ok) {
        if (res.members != null) self.setData({ sharedMembers: res.members })
        self.setData({ sharedStatus: shared.syncSummary(res) })
        return
      }
      self.setData({ sharedStatus: self.sharedError(res, '同步失败，请检查网络后重试') })
      if (manual && res && res.code === 'SCOPE_REQUIRED') self.goShare()
    })
  },

  syncTheme: function () {
    var t = theme.get()
    this.setData({ themeKey: t.key })
    theme.syncTabBar()
  },

  syncDark: function () {
    this.setData({ dark: darkmode.isDark() })
  },

  syncProfile: function () {
    var a = account.get()
    this.setData({
      nick: a.nick,
      avatar: a.avatar,
      isLogin: account.isLogin(),
      greeting: greetText()
    })
  },

  syncData: function () {
    var currentYm = format.ymOf(Date.now())
    var ym = this.data.ym || currentYm
    if (ym > currentYm) ym = currentYm
    var scope = shared.isJoined() ? prefs.viewScope() : 'both'
    var txs = shared.viewRows(store.all(), scope)
    this.setData({ scope: scope, scopeLabel: shared.isJoined() ? prefs.viewScopeLabel(scope) : '' })
    var s = stats.summary(txs, ym)

    var recent = []
    var refundOut = prefs.refundExcluded()
    for (var i = 0; i < txs.length && recent.length < 5; i++) {
      var t = txs[i]
      if (t.ym !== ym) continue
      if (refundOut && t.type === 'refund') continue
      recent.push({
        id: t.id,
        merchant: t.merchant || '未填写商户',
        category: t.category,
        color: category.colorOf(t.category),
        initial: String(t.category || '账').slice(0, 1),
        byLabel: t.byMe === false ? shared.labelOf(t.by || '成员', t.ownerKey) : '',
        tint: category.tintOf(t.category),
        amountText: format.money(t.amount),
        timeText: format.shortTime(t.time),
        type: t.type,
        sign: (t.type === 'income' || t.type === 'refund') ? '+' : (t.type === 'transfer' ? '' : '-')
      })
    }

    var budget = vip.isVip() ? store.budget() : 0
    var spent = budget > 0 ? stats.budgetSpent(txs, ym).net : 0
    this.setData({
      ym: ym, maxYm: currentYm, canNext: ym < currentYm, isCurrent: ym === currentYm,
      cats: s.byCat.filter(function (c) { return c.amount !== 0 }).slice(0, 3),
      budget: budget, budgetText: format.money(budget), budgetSpentText: format.money(spent),
      budgetLeftText: format.money(Math.abs(budget - spent)), budgetOver: spent > budget,
      budgetPct: budget > 0 ? Math.min(100, Math.round(spent / budget * 100)) : 0,
      monthText: format.monthLabel(ym),
      s: {
        expenseText: format.signedMoney(s.expense),
        incomeText: format.money(s.incomeTotal),
        netText: format.money(Math.abs(s.net)),
        netSign: s.net < 0 ? '-' : '',
        count: s.count,
        refundText: format.money(s.refund),
        refundOut: refundOut
      },
      recent: recent,
      hasData: s.count > 0,
      uncatCount: txs.filter(function (t) { return t.ym === ym && t.type === 'expense' && t.category === '未分类' && store.canEdit(t) }).length
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
    this.setData({ isVip: vip.isVip() })
    if (this._vipChecked) return
    this._vipChecked = true
    vip.refresh(function () {
      self.setData({ isVip: vip.isVip() })
      self.syncData()
    })
  },

  goMine: function () {
    wx.switchTab({ url: '/pages/index/index' })
  },

  pickMonth: function (e) {
    var ym = String(e.detail.value || '')
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym) || ym > format.ymOf(Date.now())) return
    this.setData({ ym: ym })
    this.syncData()
  },

  prevMonth: function () {
    this.setData({ ym: format.shiftMonth(this.data.ym, -1) })
    this.syncData()
  },

  nextMonth: function () {
    if (!this.data.canNext) return
    this.setData({ ym: format.shiftMonth(this.data.ym, 1) })
    this.syncData()
  },

  currentMonth: function () {
    this.setData({ ym: format.ymOf(Date.now()) })
    this.syncData()
  },

  setScope: function (e) {
    prefs.setViewScope(e.currentTarget.dataset.k)
    this.syncData()
  },

  goBudget: function () {
    if (!vip.guard('月度预算')) return
    getApp().globalData.reportSection = 'budget'
    this.goReport()
  },

  openRecent: function (e) {
    getApp().globalData.openTxId = e.currentTarget.dataset.id
    this.goList()
  },

  goCategory: function (e) {
    this.goList({ category: e.currentTarget.dataset.name })
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

  goList: function (options) {
    var app = getApp()
    var cat = options && options.category || ''
    Object.assign(app.globalData, { filterUncat: false, filterCat: cat, filterKind: cat ? 'expense' : '', filterYm: this.data.ym, filterDay: '' })
    app.globalData.backFor = '/pages/list/list'
    app.globalData.backTab = '/pages/home/home'
    app.globalData.backLabel = '首页'
    wx.switchTab({ url: '/pages/list/list' })
  },

  goReport: function () {
    var app = getApp()
    app.globalData.reportYm = this.data.ym
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
    app.globalData.filterYm = this.data.ym
    app.globalData.filterDay = ''
    app.globalData.backFor = '/pages/list/list'
    app.globalData.backTab = '/pages/home/home'
    app.globalData.backLabel = '首页'
    wx.switchTab({ url: '/pages/list/list' })
  }
})
