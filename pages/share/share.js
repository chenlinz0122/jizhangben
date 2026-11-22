// pages/share/share —— 共同账本：多人记同一本账
var shared = require('../../utils/shared')
var darkmode = require('../../utils/darkmode')

function pad2(n) { return (n < 10 ? '0' : '') + n }

function timeText(ms) {
  var t = Number(ms) || 0
  if (!t) return '还没同步过'
  var d = new Date(t)
  return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

/* 头像位上放名字第一个字，比默认图标好认；显示名优先用「我给他起的备注」 */
function withInitial(list) {
  var out = []
  for (var i = 0; i < (list || []).length; i++) {
    var m = list[i] || {}
    var nick = m.nickname || '成员'
    var remark = shared.remarkOf(nick)
    var label = remark || nick
    out.push({
      nickname: nick,
      remark: remark,
      label: label,
      role: m.role === 'owner' ? 'owner' : 'member',
      isMe: !!m.isMe,
      initial: String(label || '成').slice(0, 1)
    })
  }
  return out
}

Page({
  data: {
    joined: false,
    name: '',
    code: '',
    codeText: '',
    members: 0,
    memberLimit: 10,
    memberList: [],
    myName: '',
    isOwner: false,
    lastSyncText: '还没同步过',
    nameInput: '',
    nickInput: '',
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
    /* 上次填过的名字回填一次，省得每次都敲 */
    var saved = ''
    try { saved = String(wx.getStorageSync('share_nick_v1') || '') } catch (e) { saved = '' }
    if (saved) this.setData({ nickInput: saved })
    this.load()
  },

  onShow: function () {
    if (this.data.joined) this.load()
  },

  onNick: function (e) {
    var v = String(e.detail.value || '').slice(0, 10)
    try { wx.setStorageSync('share_nick_v1', v) } catch (err) {}
    this.setData({ nickInput: v, msg: '' })
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
      if (!res.joined) { this.setData({ joined: false }); return }
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
      memberLimit: res.memberLimit || 10,
      memberList: withInitial(res.memberList),
      myName: res.nickname || shared.myName() || '',
      isOwner: !!res.owner
    })
    var b = shared.current()
    this.setData({ lastSyncText: timeText(b && b.lastSync) })
  },

  createBook: function () {
    var self = this
    if (this.data.busy) return
    this.setData({ busy: true, msg: '' })
    shared.createBook(this.data.nameInput, this.data.nickInput, function (res) {
      if (res && res.ok) {
        self.setData({ busy: false, joined: true })
        self.apply({
          name: res.name, code: res.code, members: res.members || 1,
          memberLimit: res.memberLimit || 10, memberList: res.memberList,
          nickname: res.nickname, owner: true
        })
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
    shared.joinBook(this.data.codeInput, this.data.nickInput, function (res) {
      if (res && res.ok) {
        self.setData({ busy: false, joined: true, codeInput: '' })
        shared.clearPendingShare()
        self.apply({
          name: res.name, code: res.code, members: res.members || 2,
          memberLimit: res.memberLimit || 10, memberList: res.memberList,
          nickname: res.nickname
        })
        wx.showToast({ title: '已加入共同账本', icon: 'success' })
        return
      }
      self.setData({ busy: false, msg: (res && res.msg) || '加入失败，稍后再试' })
    })
  },

  /* 改自己的名字：只影响以后记的账，别人已经同步走的旧记录还是旧名字 */
  editNick: function () {
    var self = this
    wx.showModal({
      title: '我在这个账本里叫什么',
      editable: true,
      placeholderText: '比如「小王」',
      content: this.data.myName || '',
      success: function (r) {
        if (!r.confirm) return
        var v = String(r.content || '').trim().slice(0, 10)
        if (!v) return
        shared.setNick(v, function (res) {
          if (res && res.ok) {
            self.setData({ myName: res.nickname || v, memberList: withInitial(res.memberList) })
            wx.showToast({ title: '改好了', icon: 'none' })
            return
          }
          self.setData({ msg: (res && res.msg) || '改名字失败，稍后再试' })
        })
      }
    })
  },

  /* 给账本里的人起备注：只在我这台手机上生效，不改他本人填的昵称 */
  editRemark: function (e) {
    var self = this
    var nick = String(e.currentTarget.dataset.nick || '')
    if (!nick) return
    if (this.data.myName && nick === this.data.myName) {
      this.editNick()
      return
    }
    var cur = shared.remarkOf(nick)
    wx.showModal({
      title: '「' + nick + '」在你手机上叫什么',
      editable: true,
      placeholderText: '比如「妹妹」「室友老张」，留空恢复原名',
      content: cur,
      success: function (r) {
        if (!r.confirm) return
        var v = shared.setRemark(nick, r.content)
        var raw = []
        for (var i = 0; i < self.data.memberList.length; i++) {
          var m = self.data.memberList[i]
          raw.push({ nickname: m.nickname, role: m.role, isMe: m.isMe })
        }
        self.setData({ memberList: withInitial(raw) })
        wx.showToast({ title: v ? '备注已保存' : '已恢复原名', icon: 'none' })
      }
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
        if (res.memberList) self.setData({ memberList: withInitial(res.memberList) })
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
        ? '你是账主，退出会把整本拆掉：其他人也会被移出，云端的共享记录会被清空（你们本地账目不受影响）。'
        : '退出后你就看不到别人新记的账了，本地已有的记录会保留。',
      confirmText: owner ? '解散' : '退出',
      confirmColor: '#d0563f',
      success: function (r) {
        if (!r.confirm) return
        shared.leave(function (res) {
          if (res && res.ok) {
            self.setData({ joined: false, name: '', code: '', codeText: '', members: 0, memberList: [] })
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
      title: '加进我的共同账本，一起记同一本账',
      path: '/pages/share/share?code=' + code
    }
  },

  onShareTimeline: function () {
    return { title: '一起记账：加进我的共同账本', query: 'code=' + this.data.code }
  }
})
