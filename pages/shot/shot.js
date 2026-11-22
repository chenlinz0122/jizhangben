var store = require('../../utils/store')
var ocrbill = require('../../utils/ocrbill')
var format = require('../../utils/format')
var vip = require('../../utils/vip')

var theme = require('../../utils/theme')

Page({
  onShow: function () {
    this.setData({ themeKey: theme.get().key })
  },
  data: {
    themeKey: 'green',
    busy: false,
    stepText: '',
    photos: 0,
    done: 0,
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
    if (!vip.guard('截图识别')) return
    if (!wx.cloud) {
      this.setData({ error: '当前微信版本用不了云开发，改用「复制粘贴」导入' })
      return
    }
    wx.chooseMedia({
      /* 一次最多 9 张（微信相册多选的硬上限），逐张识别、最后合成一份预览 */
      count: 9,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: function (res) {
        var files = (res.tempFiles || []).filter(function (f) { return f && f.tempFilePath })
        if (!files.length) return
        self.setData({ error: '', preview: null, result: null, photos: files.length, done: 0 })
        self.runBatch(files)
      },
      fail: function () {}
    })
  },

  /* 多张识别：2 条流水线并行跑（一张在识别时另一张已经在传），一张等一张的两倍速度。
     不用 3 条以上：百度免费版 OCR 的 QPS 是 2，第三条就会撞「QPS 超限」，
     反而要重试。单张时退回原来的串行 + 细化文案。 */
  runBatch: function (files) {
    var self = this
    var total = files.length
    var LANES = total > 1 ? 2 : 1
    var out = []          // 按图序存：图 n 的流水放在 out[n - 1]
    var fails = []
    var skipped = 0
    var source = ''
    var started = 0
    var finished = 0
    var inFlight = 0
    this._multi = total > 1

    this.setData({ busy: true, done: 0, stepText: total > 1 ? ('识别中 · 已完成 0/' + total + ' 张') : '' })

    function makeDone(no) {
      return function (err, r) {
        inFlight--
        finished++
        self.setData({ done: finished, stepText: self.stepFor(finished, total) })
        if (err || !r || !r.items || !r.items.length) {
          fails.push({ no: no, why: String(err || '没认出流水') })
        } else {
          out[no - 1] = r.items
          skipped += r.skipped || 0
          if (!source) source = r.source || ''
        }
        if (finished >= total) {
          var acc = []
          for (var i = 0; i < out.length; i++) {
            if (out[i]) acc = acc.concat(out[i])
          }
          self.finishBatch(acc, fails, skipped, source, total)
          return
        }
        launch()
      }
    }

    function launch() {
      while (started < total && inFlight < LANES) {
        var no = started + 1
        var src = files[started].tempFilePath
        started++
        inFlight++
        self.ocrOne(src, no, total, makeDone(no))
      }
    }

    launch()
  },

  stepFor: function (done, total) {
    if (total <= 1) return ''
    return '识别中 · 已完成 ' + done + '/' + total + ' 张'
  },

  /* 单张：压缩 → 上传（带重试）→ 云函数识别 → 解析 */
  ocrOne: function (src, no, total, cb) {
    var self = this
    var single = total <= 1
    function step(t) { if (single) self.setData({ stepText: t }) }

    this.setData({ busy: true })
    step('正在压缩图片…')

    this.compress(src, function (path) {
      step('正在上传…')
      var cloudPath = 'shot/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.jpg'

      self.uploadWithRetry(path, cloudPath, function (err, up) {
        if (err) {
          var msg = String((err && err.errMsg) || '')
          if (/env|environment|invalid/i.test(msg)) {
            msg = '云开发环境没对上，检查开发者工具里是否已开通云开发并选中环境'
          } else if (/ECONNRESET|reset|network|timeout|net::/i.test(msg)) {
            msg = '网络连接被中断（ECONNRESET），已自动重试 3 次仍未成功'
          }
          cb('上传失败：' + msg)
          return
        }

        step('正在识别文字…')
        self.callOcr(up.fileID, function (err2, res) {
          self.cleanup(up.fileID)
          if (err2) {
            var m2 = String((err2 && err2.errMsg) || '')
            if (/function not found|FunctionName/i.test(m2)) {
              m2 = '云函数还没上传，先在开发者工具里右键 cloudfunctions/ocrText → 上传并部署'
            }
            cb('调用云函数失败：' + m2)
            return
          }
          if (!res.ok) {
            cb(res.error || '识别失败')
            return
          }
          var r = ocrbill.parseItems(res.items, store.rules())
          if (r.error) {
            cb(r.error)
            return
          }
          cb(null, r)
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
            if (!self._multi) self.setData({ stepText: '上传中断，重试中（' + tries + '/' + (MAX - 1) + '）…' })
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

  /* 所有图都过完：合成一份预览；多张之间重叠的那几笔交给 store 判重去合并 */
  finishBatch: function (acc, fails, skipped, source, total) {
    var self = this
    this.setData({ busy: false, stepText: '' })

    if (!acc.length) {
      var why = ''
      if (fails.length) {
        /* 按图序排，别让「第 2、1、3」这种乱序出现在提示里 */
        var nos = fails.slice().sort(function (a, b) { return a.no - b.no })
        why = '：第 ' + nos.map(function (f) { return f.no }).join('、') + ' 张没认出来'
        if (/上传失败|ECONNRESET|network|timeout/i.test(nos[0].why)) {
          why += '（网络相关，可试试：① 换个网络 ② 关掉代理/VPN ③ 截短一点再传）'
        } else if (nos[0].why) {
          why += '（' + nos[0].why + '）'
        }
      }
      this.setData({ error: (total > 1 ? '这 ' + total + ' 张都没' : '没') + '识别出流水' + why })
      return
    }

    var plan = store.previewAdd(acc)
    var sample = acc.slice(0, 6).map(function (t) {
      return {
        merchant: t.merchant,
        amountText: format.money(t.amount),
        category: t.category,
        timeText: format.shortTime(t.time),
        type: t.type
      }
    })

    /* 暂存解析结果，确认导入时直接用，避免再解析一遍 */
    this._parsed = acc

    this.setData({
      busy: false,
      stepText: '',
      error: '',
      preview: {
        total: acc.length,
        add: plan.added,
        merged: plan.merged,
        dup: plan.dup,
        skipped: skipped,
        source: source,
        photos: total,
        fails: fails,
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
    this.setData({ preview: null, result: null, error: '', photos: 0, done: 0, stepText: '' })
    this._parsed = null
  },

  goImport: function () {
    wx.redirectTo({ url: '/pages/import/import' })
  },

  goList: function () {
    wx.switchTab({ url: '/pages/list/list' })
  }
})
