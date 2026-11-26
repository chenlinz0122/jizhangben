// pages/promo/promo —— 推广得会员：发帖 / 评论区推荐，按浏览量换会员
var config = require('../../utils/config')
var darkmode = require('../../utils/darkmode')

var theme = require('../../utils/theme')

Page({
  onShow: function () {
    this.setData({ themeKey: theme.get().key })
  },
  data: {
    themeKey: 'green',
    platforms: ['抖音', '小红书', 'B站', '公众号'],
    pIdx: 0,
    views: '',
    link: '',
    imagePath: '',
    contact: '',
    busy: false,
    msg: '',
    tiers: config.PROMO.tiers,
    days: config.PROMO.visitDays || 7,
    note: config.PROMO.note || '',
    dark: false
  },

  onLoad: function () {
    var self = this
    this.setData({ dark: darkmode.isDark() })
    this._unwatchDark = darkmode.watch(function (d) { if (!self._unloaded) self.setData({ dark: d }) })
  },

  onUnload: function () {
    this._unloaded = true
    if (this._unwatchDark) this._unwatchDark()
  },

  pickPlatform: function (e) {
    this.setData({ pIdx: Number(e.currentTarget.dataset.i) || 0 })
  },

  onViews: function (e) {
    var v = String(e.detail.value || '').replace(/[^0-9]/g, '')
    this.setData({ views: v })
  },

  onLink: function (e) {
    this.setData({ link: String(e.detail.value || '').trim() })
  },

  onContact: function (e) {
    this.setData({ contact: String(e.detail.value || '').trim() })
  },

  pickImage: function () {
    var self = this
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: function (res) {
        if (self._unloaded) return
        var f = (res.tempFiles && res.tempFiles[0]) || {}
        if (f.tempFilePath) self.setData({ imagePath: f.tempFilePath })
      }
    })
  },

  clearImage: function () {
    this.setData({ imagePath: '' })
  },

  submit: function () {
    var self = this
    if (this.data.busy) return
    var views = Number(this.data.views) || 0
    if (views < 100) {
      this.setData({ msg: '先把浏览量填上（后台数据里能看到），不到 100 的帖子基本没效果' })
      return
    }
    if (!this.data.link) {
      this.setData({ msg: '帖子链接也发我一下，我好核对浏览量' })
      return
    }
    if (!this.data.contact) {
      this.setData({ msg: '留个联系方式（微信 / 闲鱼号），审核过了才好发兑换码' })
      return
    }
    this.setData({ busy: true, msg: '' })

    var content = '【推广兑换】平台：' + this.data.platforms[this.data.pIdx] +
      '；浏览量：' + views +
      '；链接：' + this.data.link +
      '；联系方式：' + this.data.contact +
      '；申请档位：' + tierOf(views, this.data.tiers)

    var finish = function (fileID) {
      wx.cloud.callFunction({
        name: 'feedback',
        data: {
          action: 'submit',
          type: 'other',
          content: content.slice(0, 500),
          contact: self.data.contact,
          fileID: fileID || '',
          page: self.route || ''
        },
        success: function (res) {
          if (self._unloaded) return
          var r = (res && res.result) || {}
          if (r.ok) {
            self.setData({ busy: false, link: '', views: '', imagePath: '' })
            wx.showModal({
              title: '收到啦',
              content: '我会去核对浏览量和帖子还在不在，通过后 48 小时内把兑换码发到你留的联系方式。',
              showCancel: false,
              confirmText: '好'
            })
            return
          }
          self.setData({ busy: false, msg: codeText(r.code, r.msg) })
        },
        fail: function () {
          if (self._unloaded) return
          self.setData({ busy: false, msg: '提交失败，可能是网络问题，稍后再试' })
        }
      })
    }

    if (!this.data.imagePath) {
      finish('')
      return
    }
    var ext = (this.data.imagePath.match(/\.[a-z0-9]+$/i) || ['.jpg'])[0]
    var cloudPath = 'promo/' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + ext
    wx.cloud.uploadFile({
      cloudPath: cloudPath,
      filePath: this.data.imagePath,
      success: function (up) { finish((up && up.fileID) || '') },
      fail: function () { finish('') }
    })
  }
})

function tierOf(views, tiers) {
  var hit = (tiers || []).slice().sort(function (a, b) { return b.views - a.views })
  for (var i = 0; i < hit.length; i++) {
    if (views >= hit[i].views) return hit[i].name
  }
  return '暂未达标'
}

/* 云函数错误码 → 人话 */
function codeText(code, msg) {
  var map = {
    RATE_LIMIT: '今天提交得有点多，明天再来',
    TOO_SHORT: '内容太短',
    TOO_LONG: '写太长了，浓缩一下',
    BAD_TYPE: '版本不一致，重开小程序再试',
    NO_COLLECTION: '后台还没建 feedbacks 集合',
    BAD_ACTION: '版本不一致，重开小程序再试'
  }
  return map[code] || msg || '提交失败，稍后再试'
}

