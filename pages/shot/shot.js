var store = require('../../utils/store')
var ocrbill = require('../../utils/ocrbill')
var format = require('../../utils/format')

Page({
  data: {
    busy: false,
    stepText: '',
    preview: null,
    result: null,
    error: '',
    cloudReady: false
  },

  onLoad: function () {
    var app = getApp()
    var ready = !!(app && app.globalData && app.globalData.cloudReady) && !!wx.cloud
    this.setData({ cloudReady: ready })
  },

  chooseShot: function () {
    var self = this
    if (this.data.busy) return
    if (!wx.cloud) {
      this.setData({ error: '当前微信版本用不了云开发，改用「复制粘贴」导入' })
      return
    }
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: function (res) {
        var f = res.tempFiles && res.tempFiles[0]
        if (!f) return
        self.setData({ error: '', preview: null, result: null })
        self.runOcr(f.tempFilePath)
      },
      fail: function () {}
    })
  },

  /* 压缩 → 上传（带重试）→ 云函数识别 → 解析 */
  runOcr: function (src) {
    var self = this
    this.setData({ busy: true, stepText: '正在压缩图片…' })

    this.compress(src, function (path) {
      self.setData({ stepText: '正在上传…' })
      var cloudPath = 'shot/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.jpg'

      self.uploadWithRetry(path, cloudPath, function (err, up) {
        if (err) {
          var msg = String((err && err.errMsg) || '')
          if (/env|environment|invalid/i.test(msg)) {
            msg = '云开发环境没对上，检查开发者工具里是否已开通云开发并选中环境'
          } else if (/ECONNRESET|reset|network|timeout|net::/i.test(msg)) {
            msg = '网络连接被中断（ECONNRESET），已自动重试 3 次仍未成功。可试试：① 换个网络（Wi-Fi 与流量互换）② 关掉代理/VPN ③ 截短一点再传'
          }
          self.setData({ busy: false, stepText: '', error: '上传失败：' + msg })
          return
        }

        self.setData({ stepText: '正在识别文字…' })
        self.callOcr(up.fileID, function (err2, res) {
          self.cleanup(up.fileID)
          if (err2) {
            var m2 = String((err2 && err2.errMsg) || '')
            if (/function not found|FunctionName/i.test(m2)) {
              m2 = '云函数还没上传，先在开发者工具里右键 cloudfunctions/ocrText → 上传并部署'
            }
            self.setData({ busy: false, stepText: '', error: '调用云函数失败：' + m2 })
            return
          }
          if (!res.ok) {
            self.setData({ busy: false, stepText: '', error: res.error || '识别失败' })
            return
          }
          self.buildPreview(res.items)
        })
      })
    })
  },

  /* 上传重试：ECONNRESET 这类网络抖动，隔一下再传基本就过了 */
  uploadWithRetry: function (filePath, cloudPath, done) {
    var self = this
    var tries = 0
    var MAX = 3

    function attempt() {
      tries++
      wx.cloud.uploadFile({
        cloudPath: cloudPath,
        filePath: filePath,
        success: function (up) { done(null, up) },
        fail: function (err) {
          var msg = String((err && err.errMsg) || '')
          var retryable = /ECONNRESET|reset|timeout|network|net::|socket/i.test(msg)
          if (retryable && tries < MAX) {
            self.setData({ stepText: '上传中断，重试中（' + tries + '/' + (MAX - 1) + '）…' })
            setTimeout(attempt, 800)
            return
          }
          done(err)
        }
      })
    }
    attempt()
  },

  /* 云函数调用也重试一次，网络抖动很常见 */
  callOcr: function (fileID, done) {
    var tries = 0

    function attempt() {
      tries++
      wx.cloud.callFunction({
        name: 'ocrText',
        data: { fileID: fileID },
        success: function (r) { done(null, (r && r.result) || {}) },
        fail: function (err) {
          var msg = String((err && err.errMsg) || '')
          if (tries < 2 && /ECONNRESET|reset|timeout|network|net::|socket/i.test(msg)) {
            setTimeout(attempt, 800)
            return
          }
          done(err)
        }
      })
    }
    attempt()
  },

  compress: function (src, cb) {
    if (!wx.compressImage) {
      cb(src)
      return
    }
    wx.compressImage({
      src: src,
      quality: 65,
      success: function (r) { cb(r.tempFilePath || src) },
      fail: function () { cb(src) }
    })
  },

  /* 识别完就把云存储里的图删掉，省容量 */
  cleanup: function (fileID) {
    if (!fileID || !wx.cloud) return
    try {
      wx.cloud.deleteFile({ fileList: [fileID] })
    } catch (e) {}
  },

  buildPreview: function (items) {
    var r = ocrbill.parseItems(items, store.rules())
    if (r.error) {
      this.setData({ busy: false, stepText: '', error: r.error })
      return
    }

    /* 用 store 的预览算「新增 / 合并 / 重复」：截图没有单号，和账单文件里同一笔要能合并 */
    var plan = store.previewAdd(r.items)

    var sample = r.items.slice(0, 6).map(function (t) {
      return {
        merchant: t.merchant,
        amountText: format.money(t.amount),
        category: t.category,
        timeText: format.shortTime(t.time),
        type: t.type
      }
    })

    /* 暂存解析结果，确认导入时直接用，避免再解析一遍 */
    this._parsed = r.items

    this.setData({
      busy: false,
      stepText: '',
      error: '',
      preview: {
        total: r.items.length,
        add: plan.added,
        merged: plan.merged,
        dup: plan.dup,
        skipped: r.skipped,
        source: r.source,
        sample: sample,
        trim: plan.trimmed || 0
      }
    })
  },

  doImport: function () {
    if (!this._parsed) return
    var res = store.addMany(this._parsed)
    store.learnFromItems(this._parsed)
    this._parsed = null
    this.setData({
      preview: null,
      result: { added: res.added, dup: res.dup, merged: res.merged || 0, trim: res.trimmed || 0 }
    })
    if (res.saved === false) {
      wx.showModal({
        title: '没能保存',
        content: '本地存储空间已满，这次识别的流水没有存进去。建议先导出备份，再清掉一些旧流水后重试。',
        showCancel: false
      })
    }
  },

  redraw: function () {
    this.setData({ preview: null, result: null, error: '' })
    this._parsed = null
  },

  goImport: function () {
    wx.redirectTo({ url: '/pages/import/import' })
  },

  goList: function () {
    wx.switchTab({ url: '/pages/list/list' })
  }
})
