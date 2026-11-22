// pages/share/share —— 共同账本：邀请好友，两个人记同一本账
var shared = require('../../utils/shared')
var darkmode = require('../../utils/darkmode')

function pad2(n) { return (n < 10 ? '0' : '') + n }

function timeText(ms) {
  var t = Number(ms) || 0
  if (!t) return '还没同步过'
  var d = new Date(t)
  return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

Page({
  data: {
    joined: false,
    name: '',
    code: '',
    codeText: '',
    members: 0,
    memberLimit: 3,
    isOwner: false,
    lastSyncText: '还没同步过',
    nameInput: '',
    codeInput: '',
    busy: false,
    msg: '',
    dark: false
  },

  onLoad: function (opts) {
    var self = this
    this.setData({ dark: darkmode.isDark() })
    darkmode.watch(function (d) { self.setData({ dark: d }) })

    /* 分享链接带 code：填进输入框，让用户确认一下再加入（不偷偷加入） */
    var q = opts && (opts.code || opts.share)
    if (q) this.setData({ codeInput: String(q).toUpperCase() })
    this.load()
  },

  onShow: function () {
    if (this.data.joined) this.load()
  },

  onName: function (e) { this.setData({ nameInput: e.detail.value, msg: '' }) },
  onCode: function (e) {
    var v = String(e.detail.value || '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 6)
    this.setData({ codeInput: v, msg: '' })
  },

  load: function () {
    var self = this
    var b = shared.current()
    if (!b) { this.setData({ joined: false }); return }
    shared.info(function (res) {
      if (!res || !res.ok) { self.setData({ joined: false }); return }
      if (!res.joined) { self.setData({ joined: false }); return }
      self.apply(res)
    })
  },

  apply: function (res) {
    var code = String(res.code || '')
    this.setData({
      joined: true,
      name: res.name || '共同账本',
      code: code,
      codeText: code ? code.slice(0, 3) + ' ' + code.slice(3) : '',
      members: res.members || 1,
      memberLimit: res.memberLimit || 3,
      isOwner: !!res.owner
    })
    var b = shared.current()
    this.setData({ lastSyncText: timeText(b && b.lastSync) })
  },

  createBook: function () {
    var self = this
    if (this.data.busy) return
    this.setData({ busy: true, msg: '' })
    shared.createBook(this.data.nameInput, function (res) {
      if (res && res.ok) {
        self.setData({ busy: false, joined: true })
        self.apply({ name: res.name, code: res.code, members: 1, memberLimit: 3, owner: true })
        wx.showToast({ title: '账本建好了', icon: 'success' })
        return
      }
      self.setData({ busy: false, msg: (res && res.msg) || '建账本失败，稍后再试' })
    })
  },

  joinBook: function () {
    var self = this
    if (this.data.busy) return
    if (this.data.codeInput.length !== 6) {
      this.setData({ msg: '邀请码是 6 位，问 TA 再要一次' })
      return
    }
    this.setData({ busy: true, msg: '' })
    shared.joinBook(this.data.codeInput, function (res) {
      if (res && res.ok) {
        self.setData({ busy: false, joined: true, codeInput: '' })
        shared.clearPendingShare()
        self.apply({ name: res.name, code: res.code, members: res.members || 2, memberLimit: 3 })
        wx.showToast({ title: '已加入共同账本', icon: 'success' })
        return
      }
      self.setData({ busy: false, msg: (res && res.msg) || '加入失败，稍后再试' })
    })
  },

  copyCode: function () {
    var code = this.data.code
    if (!code) return
    wx.setClipboardData({
      data: code,
      success: function () { wx.showToast({ title: '邀请码已复制', icon: 'none' }) }
    })
  },

  doSync: function () {
    var self = this
    if (this.data.busy) return
    this.setData({ busy: true, msg: '' })
    shared.sync(function (res) {
      self.setData({ busy: false })
      var b = shared.current()
      self.setData({ lastSyncText: timeText(b && b.lastSync) })
      if (res && res.ok) {
        var n = res.added || 0
        wx.showToast({
          title: n > 0 ? ('同步完成，新增 ' + n + ' 条') : '同步完成，没有新记录',
          icon: 'none',
          duration: 1600
        })
        if (res.members) self.setData({ members: res.members })
        return
      }
      self.setData({ msg: (res && res.msg) || '同步失败，检查网络后再试' })
    })
  },

  quit: function () {
    var self = this
    var owner = this.data.isOwner
    wx.showModal({
      title: owner ? '解散共同账本？' : '退出共同账本？',
      content: owner
        ? '你是账本创建人，退出会把整本拆掉：对方也会被移出，云端的共享记录会被清空（你本地账目不受影响）。'
        : '退出后你就看不到对方新记的账了，本地已有的记录会保留。',
      confirmText: owner ? '解散' : '退出',
      confirmColor: '#d0563f',
      success: function (r) {
        if (!r.confirm) return
        shared.leave(function (res) {
          if (res && res.ok) {
            self.setData({ joined: false, name: '', code: '', codeText: '', members: 0 })
            wx.showToast({ title: owner ? '已解散' : '已退出', icon: 'none' })
            return
          }
          self.setData({ msg: (res && res.msg) || '操作失败，稍后再试' })
        })
      }
    })
  },

  onShareAppMessage: function () {
    var code = this.data.code
    return {
      title: '加进我的共同账本，咱俩记同一本账',
      path: '/pages/share/share?code=' + code
    }
  },

  onShareTimeline: function () {
    return { title: '一起记账：加进我的共同账本', query: 'code=' + this.data.code }
  }
})
