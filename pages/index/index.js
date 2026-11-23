var account = require('../../utils/account')
var store = require('../../utils/store')
var vip = require('../../utils/vip')
var shared = require('../../utils/shared')
var prefs = require('../../utils/prefs')
var theme = require('../../utils/theme')
var darkmode = require('../../utils/darkmode')
var dataTools = require('../../utils/data-tools')
var format = require('../../utils/format')

function timeText(ms, empty) {
  var n = Number(ms)
  if (!n || !isFinite(new Date(n).getTime())) return empty
  var d = new Date(n)
  return format.dayOf(n) + ' ' + format.pad(d.getHours()) + ':' + format.pad(d.getMinutes())
}

Page({
  data: {
    themeKey: 'green',
    themeColor: '#17806b',
    themes: [],
    dark: false,
    busy: false,
    loggedIn: false,
    nick: '给自己起个昵称',
    avatar: '',
    initial: '我',
    vipText: '',
    vipAction: '开通或兑换',
    recordCount: 0,
    backupText: '尚未生成',
    joined: false,
    bookName: '',
    membersText: '',
    memberNames: '',
    lastSyncText: '还没同步过',
    shareScopeText: '',
    scopeConfirmed: false,
    viewScopeText: '',
    refundOut: true
  },

  onLoad: function () {
    var self = this
    this._unloaded = false
    this.setData({ dark: darkmode.isDark() })
    this._stopDarkWatch = darkmode.watch(function (dark) {
      if (!self._unloaded) self.setData({ dark: dark })
      if (self._visible) theme.syncTabBar()
    })
    this._stopToolsWatch = dataTools.watch(function (busy) {
      if (self._unloaded) return
      if (busy) self.setData({ busy: true })
      else self.refresh()
    })
  },

  onShow: function () {
    this._visible = true
    theme.syncTabBar()
    this.setData({ dark: darkmode.isDark() })
    this.refresh()
  },

  onHide: function () { this._visible = false },

  onUnload: function () {
    this._visible = false
    this._unloaded = true
    if (this._stopDarkWatch) this._stopDarkWatch()
    if (this._stopToolsWatch) this._stopToolsWatch()
  },

  /* 只展示本机状态，不在「我的」请求共同账本信息或触发上传。 */
  refresh: function () {
    if (this._unloaded) return
    var a = account.get()
    var t = theme.get()
    var b = shared.current() || {}
    var joined = !!b.bookId
    var members = b.memberList || []
    var names = members.slice(0, 3).map(function (m) {
      var name = m.nickname || '成员'
      return shared.labelOf(name, m.ownerKey) + (m.isMe ? '（我）' : '')
    }).join('、')
    if (members.length > 3) names += '等'
    var count = Number(b.members) || members.length
    this.setData({
      themeKey: t.key,
      themeColor: t.color,
      themes: theme.list(),
      busy: dataTools.busy(),
      loggedIn: !!a.nick,
      nick: a.nick || '给自己起个昵称',
      avatar: a.avatar || '',
      initial: String(a.nick || '我').slice(0, 1),
      vipText: vip.statusText(),
      vipAction: vip.isVip() ? '查看权益' : '开通或兑换',
      recordCount: store.all().length,
      backupText: timeText(dataTools.lastGenerated(), '尚未生成'),
      joined: joined,
      bookName: joined ? (b.name || '共同账本') : '和重要的人，一起记账',
      membersText: count > 0 ? count + ' 位成员' : '成员数待确认',
      memberNames: names,
      lastSyncText: timeText(b.lastSync, '还没同步过'),
      shareScopeText: joined ? shared.scopeText() : '',
      scopeConfirmed: joined && typeof b.shareSince === 'number' && isFinite(b.shareSince) && b.shareSince >= 0,
      viewScopeText: prefs.viewScopeLabel(),
      refundOut: prefs.refundExcluded()
    })
  },

  blocked: function () {
    if (!dataTools.busy()) return false
    this.setData({ busy: true })
    wx.showToast({ title: '数据工具正在处理，请稍候', icon: 'none' })
    return true
  },

  avatarError: function () { this.setData({ avatar: '' }) },

  goProfile: function () {
    if (!this.blocked()) wx.navigateTo({ url: '/pages/login/login?from=mine' })
  },

  goVip: function () {
    if (!this.blocked()) wx.navigateTo({ url: '/pages/vip/vip' })
  },

  goShare: function () {
    if (!this.blocked()) wx.navigateTo({ url: '/pages/share/share' })
  },

  goDataTools: function () {
    if (this.blocked()) return
    var g = getApp().globalData
    g.reportSection = 'tools'
    g.backFor = '/pages/report/report'
    g.backTab = '/pages/index/index'
    g.backLabel = '我的'
    wx.switchTab({ url: '/pages/report/report' })
  },

  backup: function () {
    if (this.blocked()) return
    var self = this
    this.setData({ busy: true })
    dataTools.backup(function () { self.refresh() })
    this.setData({ busy: dataTools.busy() })
  },

  restore: function () {
    if (this.blocked()) return
    var self = this
    this.setData({ busy: true })
    dataTools.restore(function () { self.refresh() })
    this.setData({ busy: dataTools.busy() })
  },

  pickTheme: function (e) {
    if (this.blocked()) return
    var key = e.currentTarget.dataset.key
    if (key !== 'green' && key !== 'ink' && key !== 'amber') return
    theme.set(key)
    this.refresh()
  },

  toggleRefund: function (e) {
    if (this.blocked()) return
    prefs.setRefundExcluded(!!e.detail.value)
    this.refresh()
  },

  goPrivacy: function () {
    if (!this.blocked()) wx.navigateTo({ url: '/pages/login/login?from=mine&privacy=1' })
  },

  goFeedback: function () {
    if (!this.blocked()) wx.navigateTo({ url: '/pages/feedback/feedback' })
  },

  logout: function () {
    if (this.blocked()) return
    var self = this
    wx.showModal({
      title: '退出本机资料？',
      content: '仅清除本机昵称和头像，不会删除流水、预算或分类规则，不会退出共同账本，也不会结束会员权益。仍可继续记账。',
      confirmText: '退出资料',
      success: function (res) {
        if (!res.confirm || self.blocked()) return
        account.logout()
        account.markSkip()
        self.refresh()
      }
    })
  }
})
