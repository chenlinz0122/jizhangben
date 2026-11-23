// pages/login/login - 登录 / 完善资料
//
// 参考常青藤测评的登录页结构（头像 chooseAvatar + 昵称 nickname 输入 + 隐私协议勾选 + 一键登录 + 暂不登录），
// 但记账Book不需要手机号：个人主体小程序拿不到 getPhoneNumber，而且记账根本用不上手机号。
// 所以「登录」= 在本机记一个昵称头像 + 向云函数要一次 openid（会员核销认这个 openid）。

var darkmode = require('../../utils/darkmode')
var account = require('../../utils/account')
var vip = require('../../utils/vip')

var theme = require('../../utils/theme')

Page({
  onShow: function () {
    this.setData({ themeKey: theme.get().key, dark: darkmode.isDark() })
  },
  data: {
    dark: false,
    themeKey: 'green',
    avatar: '',
    nick: '',
    agreed: false,
    showPrivacy: false,
    agreedError: false,
    busy: false,
    errMsg: '',
    from: ''
  },

  onLoad: function (opts) {
    var a = account.get()
    this.setData({
      avatar: a.avatar,
      nick: a.nick,
      from: (opts && opts.from) || '',
      showPrivacy: !!(opts && opts.privacy === '1')
    })

    /* 从分享链接进来：先把邀请码存住，再核销（双方各 +7 天） */
    if (opts && opts.invite) vip.setPendingInvite(opts.invite)

    /* 顺手向云函数要一次 openid / 会员状态：
       首次在崭新环境里跑时，服务端会自己把集合建好、把卡密灌进去，这里正好当探针 */
    try {
      vip.autoAcceptInvite(function () { vip.refresh() })
      vip.refresh()
    } catch (e) {}
  },

  onUnload: function () {
    if (this._errTimer) clearTimeout(this._errTimer)
    /* 从返回键走掉也算「先逛逛」，不然下次冷启动又弹一次 */
    if (!account.isLogin()) account.markSkip()
  },

  /* ---------- 头像：官方 chooseAvatar，选完立刻落盘 ---------- */
  onChooseAvatar: function (e) {
    var self = this
    var p = (e && e.detail && e.detail.avatarUrl) || ''
    if (!p) return
    account.persistAvatar(p, function (saved) {
      self.setData({ avatar: saved || p })
    })
  },

  /* ---------- 昵称：官方 nickname 输入框（可直接选微信昵称） ---------- */
  onNickInput: function (e) {
    this.setData({ nick: (e.detail.value || ''), errMsg: '' })
  },

  onNickBlur: function (e) {
    this.setData({ nick: (e.detail.value || '').trim() })
  },

  /* ---------- 协议 ---------- */
  toggleAgree: function () {
    if (!this.data.agreed) {
      this.setData({ showPrivacy: true })
    } else {
      this.setData({ agreed: false })
    }
  },

  openPrivacy: function () {
    this.setData({ showPrivacy: true, agreedError: false })
  },

  closePrivacy: function () {
    this.setData({ showPrivacy: false })
  },

  stopProp: function () {},

  agreePrivacy: function () {
    this.setData({ showPrivacy: false, agreed: true, agreedError: false })
  },

  disagreePrivacy: function () {
    this.setData({ showPrivacy: false })
    this.tip('要同意这份说明才能登录，不同意也可以先逛逛')
  },

  /* 未勾协议时把提示顶在按钮上面，别再弹一次弹窗 */
  checkAgreed: function () {
    if (this.data.agreed) return true
    var self = this
    this.setData({ agreedError: true })
    if (this._errTimer) clearTimeout(this._errTimer)
    this._errTimer = setTimeout(function () { self.setData({ agreedError: false }) }, 3000)
    return false
  },

  tip: function (msg) {
    this.setData({ errMsg: msg })
  },

  /* ---------- 登录 ---------- */
  doLogin: function () {
    var self = this
    if (this.data.busy) return

    var nick = String(this.data.nick || '').trim()
    if (!nick) {
      this.tip('先填个昵称，可以直接用微信昵称')
      return
    }
    if (!this.checkAgreed()) {
      this.tip('请先勾选同意这份说明')
      return
    }

    this.setData({ busy: true, errMsg: '' })

    /* 顺手向云函数要一次 openid：会员核销只认它，拿不到也不挡登录（账本仍可用） */
    vip.refresh(function () {
      account.login({
        nick: nick,
        avatar: self.data.avatar,
        openid: vip.openid()
      })
      account.clearSkip()
      self.setData({ busy: false })
      wx.showToast({ title: '登录成功', icon: 'success', duration: 1200 })
      setTimeout(function () { self.goAfterLogin() }, 700)
    })
  },

  goAfterLogin: function () {
    if (this.data.from === 'mine') {
      wx.switchTab({ url: '/pages/index/index' })
      return
    }
    if (this.data.from === 'vip') {
      wx.navigateBack({
        delta: 1,
        fail: function () { wx.switchTab({ url: '/pages/home/home' }) }
      })
      return
    }
    wx.switchTab({ url: '/pages/home/home' })
  },

  /* 先逛逛：只记一次，避免每次打开都弹登录 */
  skipLogin: function () {
    account.markSkip()
    wx.switchTab({ url: this.data.from === 'mine' ? '/pages/index/index' : '/pages/home/home' })
  }
})
