/* 意见反馈：不依赖登录态，云函数用 openid 认人（用于限频和回复） */

var theme = require('../../utils/theme')

Page({
  onShow: function () {
    this.setData({ themeKey: theme.get().key })
  },
  data: {
    themeKey: 'green',
    types: [
      { key: 'bug', name: '算错了 / 有 bug' },
      { key: 'idea', name: '功能建议' },
      { key: 'other', name: '其他' }
    ],
    type: 'idea',
    content: '',
    len: 0,
    contact: '',
    imagePath: '',
    busy: false,
    msg: ''
  },

  pickType: function (e) {
    this.setData({ type: e.currentTarget.dataset.key })
  },

  onContent: function (e) {
    var v = String(e.detail.value || '')
    this.setData({ content: v, len: v.length, msg: '' })
  },

  onContact: function (e) {
    this.setData({ contact: e.detail.value })
  },

  pickShot: function () {
    var self = this
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: function (res) {
        var f = res.tempFiles && res.tempFiles[0]
        if (f && f.tempFilePath) self.setData({ imagePath: f.tempFilePath })
      }
    })
  },

  previewShot: function () {
    if (!this.data.imagePath) return
    wx.previewImage({ urls: [this.data.imagePath] })
  },

  removeShot: function () {
    this.setData({ imagePath: '' })
  },

  submit: function () {
    var self = this
    if (this.data.busy) return
    var content = String(this.data.content || '').trim()
    if (content.length < 5) {
      this.setData({ msg: '多写两句吧，至少 5 个字' })
      return
    }
    this.setData({ busy: true, msg: '' })

    var finish = function (fileID, uploadNote) {
      wx.cloud.callFunction({
        name: 'feedback',
        data: {
          action: 'submit',
          type: self.data.type,
          content: content,
          contact: String(self.data.contact || '').trim(),
          fileID: fileID || '',
          page: self.route || ''
        },
        success: function (res) {
          var r = (res && res.result) || {}
          if (r.ok) {
            self.setData({ busy: false })
            wx.showToast({ title: '收到，谢谢', icon: 'success' })
            setTimeout(function () {
              wx.navigateBack({ delta: 1, fail: function () {} })
            }, 900)
            return
          }
          self.setData({ busy: false, msg: codeText(r.code, r.msg) })
        },
        fail: function () {
          self.setData({ busy: false, msg: '提交失败，可能是网络或云开发不可用，稍后再试' })
        }
      })
      if (uploadNote) wx.showToast({ title: uploadNote, icon: 'none' })
    }

    if (!this.data.imagePath) {
      finish('', '')
      return
    }

    /* 图片先落云存储；上传失败就退回「只提交文字」，别把整条反馈卡死 */
    var ext = (this.data.imagePath.match(/\.[a-z0-9]+$/i) || ['.jpg'])[0]
    var cloudPath = 'feedback/' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + ext
    wx.cloud.uploadFile({
      cloudPath: cloudPath,
      filePath: this.data.imagePath,
      success: function (up) { finish((up && up.fileID) || '', '') },
      fail: function () { finish('', '图片没传上去，先发文字') }
    })
  }
})

/* 云函数错误码 → 人话 */
function codeText(code, msg) {
  var map = {
    RATE_LIMIT: '今天提交得有点多，明天再来？',
    TOO_SHORT: '内容太短了，多说两句',
    BAD_TYPE: '类型不对，刷新一下再提交',
    NO_COLLECTION: '后台还没建 feedbacks 集合，先私信我',
    BAD_ACTION: '版本不一致，重开小程序再试'
  }
  return map[code] || msg || '提交失败，稍后再试'
}
