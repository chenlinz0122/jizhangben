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
    var remark = shared.remarkOf(nick, m.ownerKey)
    var label = remark || nick
    out.push({
      nickname: nick,
      ownerKey: m.ownerKey || '',
      remark: remark,
      label: label,
      role: m.role === 'owner' ? 'owner' : 'member',
      isMe: !!m.isMe,
      initial: String(label || '成').slice(0, 1)
    })
  }
  return out
}

var theme = require('../../utils/theme')

function errorText(res, fallback) {
  var msg = (res && res.msg) || fallback
  if (res && res.code === 'UPGRADE_REQUIRED') msg += '；请上传并部署新版云函数 book 后重试'
  return msg + (res && res.code ? '（' + res.code + '）' : '')
}

function ownerOf(book) {
  if (typeof book.owner === 'boolean') return book.owner
  if (book.role) return book.role === 'owner'
  var list = book.memberList || []
  for (var i = 0; i < list.length; i++) {
    if (list[i].isMe) return list[i].role === 'owner'
  }
  return false
}

Page({
  data: {
    themeKey: 'green',
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
    loading: false,
    membershipKnown: false,
    hasConflict: false,
    shareScope: '',
    scopeText: '未确认，请选择共享范围',
    msg: '',
    dark: false
  },

  onLoad: function (opts) {
    var self = this
    this.setData({ dark: darkmode.isDark() })
    darkmode.watch(function (d) { self.setData({ dark: d }) })

    /* 分享链接带 code：填进输入框，让用户确认一下再加入（不偷偷加入） */
    var q = (opts && (opts.code || opts.share)) || shared.pendingShare()
    if (q) this.setData({ codeInput: String(q).toUpperCase() })
    /* 上次填过的名字回填一次，省得每次都敲 */
    var saved = ''
    try { saved = String(wx.getStorageSync('share_nick_v1') || '') } catch (e) { saved = '' }
    if (saved) this.setData({ nickInput: saved })
  },

  onShow: function () {
    this.setData({ themeKey: theme.get().key })
    this.load()
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
    if (this.data.loading || this.data.busy) return
    var self = this
    var b = shared.current()
    if (b && b.bookId) this.apply(b)
    if (shared.busy()) {
      this.setData({ msg: '共同账本正在处理其他操作，请稍后重试' })
      return
    }
    this.setData({ loading: true, msg: '' })
    // 没有本机缓存也查询云端；只有明确返回未加入，才显示创建/加入表单。
    shared.info(function (res) {
      self.setData({ loading: false })
      if (!res || !res.ok) {
        var cached = shared.current() || b
        if (cached && cached.bookId) self.apply(cached)
        self.setData({
          membershipKnown: self.data.joined,
          msg: errorText(res, '无法确认账本状态，请检查网络后重试') + (self.data.joined ? '；当前显示本机缓存' : '')
        })
        return
      }
      if (!res.joined) {
        self.resetBook()
        return
      }
      self.apply(res)
    })
  },

  resetBook: function () {
    this.setData({
      joined: false, membershipKnown: true, hasConflict: false, name: '', code: '', codeText: '',
      members: 0, memberList: [], myName: '', isOwner: false,
      shareScope: '', scopeText: '未确认，请选择共享范围', lastSyncText: '还没同步过', msg: ''
    })
  },

  apply: function (res) {
    var b = shared.current() || {}
    var book = Object.assign({}, b, res)
    var code = String(book.code || '')
    this.setData({
      joined: true,
      membershipKnown: true,
      name: book.name || '共同账本',
      code: code,
      codeText: code ? code.slice(0, 3) + ' ' + code.slice(3) : '',
      members: book.members || 1,
      memberLimit: book.memberLimit || 10,
      memberList: withInitial(book.memberList),
      myName: book.nickname || shared.myName() || '',
      isOwner: ownerOf(book),
      lastSyncText: timeText(b.lastSync),
      shareScope: b.shareSince == null ? '' : (b.shareSince === 0 ? 'all' : 'recent'),
      scopeText: shared.scopeText()
    })
  },

  blocked: function () {
    if (!this.data.busy && !this.data.loading && !shared.busy()) return false
    this.setData({ msg: '正在处理共同账本，请稍后再试' })
    return true
  },

  chooseScope: function (e) {
    this.confirmScope(e.currentTarget.dataset.scope, false)
  },

  promptScope: function () {
    if (this.blocked()) return
    var self = this
    this.setData({ busy: true, msg: '请先确认共享范围，再开始同步' })
    wx.showActionSheet({
      itemList: ['加入当天起的本人流水', '全部本人流水（含历史）'],
      success: function (r) {
        self.setData({ busy: false })
        self.confirmScope(r.tapIndex === 0 ? 'recent' : 'all', true)
      },
      fail: function () { self.setData({ busy: false }) }
    })
  },

  confirmScope: function (scope, syncAfter) {
    if (scope !== 'recent' && scope !== 'all') return
    if (this.blocked()) return
    if (!shared.current()) { this.setData({ msg: '请先确认已加入共同账本' }); return }
    var self = this
    this.setData({ busy: true })
    wx.showModal({
      title: scope === 'all' ? '共享全部本人流水？' : '共享加入当天起的流水？',
      content: (scope === 'all'
        ? '将上传你自己的全部流水，包含加入前的历史账目。'
        : '按流水日期筛选：从加入账本当天的本地零点起，共享你自己的流水；之后补录的更早账目不包含。') +
        '\n金额、商户、流水备注等账目内容会上传云端，对账本成员可见。确认后，首页可自动同步。\n「只看自己 / 看双方 / 只看对方」只改变显示，不限制上传。更改范围不会删除已在云端的记录，也不能远程擦除成员已保存的本机副本。',
      confirmText: '同意共享',
      success: function (r) {
        self.setData({ busy: false })
        if (!r.confirm) return
        if (shared.busy()) { self.setData({ msg: '同步正在进行，请结束后重新选择范围' }); return }
        if (!shared.setShareScope(scope)) {
          self.setData({ msg: '共享范围未保存，尚未开始同步，请重试' })
          return
        }
        self.apply(shared.current())
        self.setData({ msg: '共享范围已确认；首页可自动同步。更改范围不会删除已有云端记录。' })
        if (syncAfter) self.doSync()
      },
      fail: function () { self.setData({ busy: false, msg: '未能打开确认窗口，请重新选择共享范围' }) }
    })
  },

  createBook: function () {
    var self = this
    if (this.blocked()) return
    if (!this.data.membershipKnown || this.data.joined) return
    this.setData({ busy: true, msg: '' })
    shared.createBook(this.data.nameInput, this.data.nickInput, function (res) {
      if (res && res.ok) {
        self.setData({ busy: false, joined: true })
        self.apply(res)
        self.setData({ msg: '账本已创建，请先选择并确认共享范围' })
        wx.showToast({ title: '账本建好了', icon: 'success' })
        return
      }
      self.setData({ busy: false, msg: errorText(res, '建账本失败，稍后再试') })
    })
  },

  joinBook: function () {
    var self = this
    if (this.blocked()) return
    if (!this.data.membershipKnown || this.data.joined) return
    if (this.data.codeInput.length !== 6) {
      this.setData({ msg: '邀请码是 6 位，问 TA 再要一次' })
      return
    }
    this.setData({ busy: true, msg: '' })
    shared.joinBook(this.data.codeInput, this.data.nickInput, function (res) {
      if (res && res.ok) {
        self.setData({ busy: false, joined: true, codeInput: '' })
        shared.clearPendingShare()
        self.apply(res)
        self.setData({ msg: '已加入，请先选择并确认共享范围' })
        wx.showToast({ title: '已加入共同账本', icon: 'success' })
        return
      }
      self.setData({ busy: false, msg: errorText(res, '加入失败，稍后再试') })
    })
  },

  /* 账本昵称会共享给成员；个人成员备注才只保存在本机。 */
  editNick: function () {
    if (this.blocked()) return
    var self = this
    this.setData({ busy: true, msg: '' })
    wx.showModal({
      title: '账本昵称（成员可见）',
      editable: true,
      placeholderText: '比如「小王」',
      content: this.data.myName || '',
      success: function (r) {
        var v = String(r.content || '').trim().slice(0, 10)
        if (!r.confirm || !v) { self.setData({ busy: false }); return }
        shared.setNick(v, function (res) {
          self.setData({ busy: false })
          if (res && res.ok) {
            self.apply(Object.assign({}, shared.current(), { nickname: res.nickname || v, memberList: res.memberList || self.data.memberList }))
            wx.showToast({ title: '改好了', icon: 'none' })
            return
          }
          self.setData({ msg: errorText(res, '改名字失败，稍后再试') })
        })
      },
      fail: function () { self.setData({ busy: false, msg: '未能打开昵称编辑，请重试' }) }
    })
  },

  /* 给账本里的人起备注：只在我这台手机上生效，不改他本人填的昵称 */
  editRemark: function (e) {
    if (this.blocked()) return
    var self = this
    var nick = String(e.currentTarget.dataset.nick || '')
    if (!nick) return
    if (e.currentTarget.dataset.me) {
      this.editNick()
      return
    }
    var ownerKey = e.currentTarget.dataset.owner || ''
    var cur = shared.remarkOf(nick, ownerKey)
    wx.showModal({
      title: '「' + nick + '」在你手机上叫什么',
      editable: true,
      placeholderText: '比如「妹妹」「室友老张」，留空恢复原名',
      content: cur,
      success: function (r) {
        if (!r.confirm) return
        var v = shared.setRemark(nick, r.content, ownerKey)
        if (v === null) {
          self.setData({ msg: '个人备注未保存，请稍后重试' })
          return
        }
        var raw = []
        for (var i = 0; i < self.data.memberList.length; i++) {
          var m = self.data.memberList[i]
          raw.push({ nickname: m.nickname, role: m.role, isMe: m.isMe, ownerKey: m.ownerKey })
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

  doSync: function (resolution) {
    if (resolution !== 'local' && resolution !== 'cloud') resolution = ''
    var self = this
    if (this.blocked()) return
    var b = shared.current()
    if (!b) { this.setData({ msg: '请先确认已加入共同账本' }); return }
    if (b.shareSince == null) { this.promptScope(); return }
    this.setData({ busy: true, hasConflict: false, msg: '同步中，请稍候' })
    shared.sync(function (res) {
      self.setData({ busy: false })
      var book = shared.current()
      self.setData({ lastSyncText: timeText(book && book.lastSync) })
      if (res && res.ok) {
        var next = Object.assign({}, book)
        if (res.members != null) next.members = res.members
        if (res.memberList) next.memberList = res.memberList
        self.apply(next)
        self.setData({ msg: shared.syncSummary(res) })
        return
      }
      if (!book) self.resetBook()
      self.setData({ msg: errorText(res, '同步失败，检查网络后再试'),
        hasConflict: !!(res && (res.code === 'CONFLICT' || res.code === 'VERSION_CONFLICT')) })
      if (res && res.code === 'SCOPE_REQUIRED') self.promptScope()
    }, resolution)
  },

  resolveConflict: function () {
    if (this.blocked() || !this.data.hasConflict) return
    var self = this
    this.setData({ busy: true })
    wx.showActionSheet({
      itemList: ['冲突记录保留本机版本', '冲突记录采用云端版本'],
      success: function (r) {
        var local = r.tapIndex === 0
        wx.showModal({
          title: local ? '保留本机修改？' : '采用云端修改？',
          content: '仅处理当前有冲突的记录，包含冲突的删除操作。另一份修改将被替换，建议先在报表页导出备份。',
          confirmText: '确认处理',
          success: function (answer) {
            self.setData({ busy: false })
            if (answer.confirm) self.doSync(local ? 'local' : 'cloud')
          },
          fail: function () { self.setData({ busy: false }) }
        })
      },
      fail: function () { self.setData({ busy: false }) }
    })
  },

  quit: function () {
    if (this.blocked() || !this.data.joined) return
    var self = this
    var owner = this.data.isOwner
    this.setData({ busy: true, msg: '' })
    wx.showModal({
      title: owner ? '解散共同账本？' : '退出共同账本？',
      content: (owner
        ? '你是账主，解散会移出所有成员并清空云端共享记录，本机已有账目保留。'
        : '退出后不再同步，本机已有账目保留。') + '无法远程擦除其他成员已同步到手机上的副本。建议先导出备份。',
      confirmText: owner ? '解散' : '退出',
      confirmColor: '#d0563f',
      success: function (r) {
        if (!r.confirm) { self.setData({ busy: false }); return }
        if (shared.busy()) {
          self.setData({ busy: false, msg: '同步正在进行，请结束后再退出' })
          return
        }
        shared.leave(function (res) {
          self.setData({ busy: false })
          if (res && res.ok) {
            self.resetBook()
            wx.showToast({ title: owner ? '已解散' : '已退出', icon: 'none' })
            return
          }
          self.setData({ msg: errorText(res, '操作失败，稍后再试') })
        })
      },
      fail: function () { self.setData({ busy: false, msg: '未能打开退出确认，请重试' }) }
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
