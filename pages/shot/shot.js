var darkmode = require('../../utils/darkmode')
var store = require('../../utils/store')
var ocrbill = require('../../utils/ocrbill')
var format = require('../../utils/format')
var category = require('../../utils/category')
var vip = require('../../utils/vip')

var theme = require('../../utils/theme')

Page({
  onShow: function () {
    this.setData({ themeKey: theme.get().key, dark: darkmode.isDark() })
  },
  data: {
    dark: false,
    themeKey: 'green',
    busy: false,
    stepText: '',
    photos: 0,
    done: 0,
    preview: null,
    result: null,
    error: '',
    cloudReady: false,
    reviewImageIndex: 0,
    highlightKey: '',
    editForm: null,
    editTypeOptions: [
      { value: 'expense', label: '支出' },
      { value: 'income', label: '收入' },
      { value: 'refund', label: '退款' },
      { value: 'transfer', label: '转账' }
    ],
    editTypeIndex: 0,
    editCategories: [],
    editCategoryIndex: 0
  },

  onUnload: function () {
    this._unloaded = true
    this._taskToken = (this._taskToken || 0) + 1
    ;(this._retryTimers || []).forEach(function (id) { clearTimeout(id) })
    this._retryTimers = []
  },

  beginTask: function () {
    this._taskToken = (this._taskToken || 0) + 1
    return this._taskToken
  },

  taskActive: function (token) {
    return !this._unloaded && token === this._taskToken
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
        if (self._unloaded) return
        var files = (res.tempFiles || []).filter(function (f) { return f && f.tempFilePath })
        if (!files.length) return
        var token = self.beginTask()
        self._parsed = null
        self._confirmedReviewToken = 0
        self._reviewModalOpen = false
        self._forceReviewConfirm = false
        self._shotImages = null
        self._previewMeta = null
        self.setData({
          error: '', preview: null, result: null, photos: files.length, done: 0,
          reviewImageIndex: 0, highlightKey: '', editForm: null
        })
        self.runBatch(files, token)
      },
      fail: function () {}
    })
  },

  /* 多张识别：2 条流水线并行跑（一张在识别时另一张已经在传），一张等一张的两倍速度。
     不用 3 条以上：百度免费版 OCR 的 QPS 是 2，第三条就会撞「QPS 超限」，
     反而要重试。单张时退回原来的串行 + 细化文案。 */
  runBatch: function (files, token) {
    var self = this
    var task = token === undefined ? this.beginTask() : token
    if (!this.taskActive(task)) return
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
    /* 原图只留在本轮预览，不参与上传；尺寸缺失时再读取一次。 */
    this._shotImages = files.map(function (file) {
      return {
        path: file.tempFilePath,
        width: Number(file.width) > 0 ? Number(file.width) : 0,
        height: Number(file.height) > 0 ? Number(file.height) : 0
      }
    })
    this.loadOriginalSizes(this._shotImages, task)

    this.setData({ busy: true, done: 0, stepText: total > 1 ? ('识别中 · 已完成 0/' + total + ' 张') : '' })

    function makeDone(no) {
      return function (err, r) {
        if (!self.taskActive(task)) return
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
        self.ocrOne(src, no, total, makeDone(no), task)
      }
    }

    launch()
  },

  loadOriginalSizes: function (images, token) {
    var self = this
    if (!wx.getImageInfo) return
    images.forEach(function (image) {
      if (image.width > 0 && image.height > 0) return
      wx.getImageInfo({
        src: image.path,
        success: function (res) {
          if (!self.taskActive(token) || self._shotImages !== images || !res) return
          if (Number(res.width) > 0) image.width = Number(res.width)
          if (Number(res.height) > 0) image.height = Number(res.height)
          if (self._parsed) self.refreshPreview()
        },
        fail: function () {}
      })
    })
  },

  stepFor: function (done, total) {
    if (total <= 1) return ''
    return '识别中 · 已完成 ' + done + '/' + total + ' 张'
  },

  /* 单张：压缩 → 上传（带重试）→ 云函数识别 → 解析 */
  ocrOne: function (src, no, total, cb, token) {
    var self = this
    var task = token === undefined ? this.beginTask() : token
    if (!this.taskActive(task)) return
    var single = total <= 1
    function step(t) { if (single && self.taskActive(task)) self.setData({ stepText: t }) }

    this.setData({ busy: true })
    step('正在压缩图片…')

    this.compress(src, function (path) {
      if (!self.taskActive(task)) return
      step('正在上传…')
      var cloudPath = 'shot/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.jpg'

      self.uploadWithRetry(path, cloudPath, function (err, up) {
        if (!self.taskActive(task)) {
          if (up) self.cleanup(up.fileID)
          return
        }
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
          if (!self.taskActive(task)) return
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
          var r = ocrbill.parseItems(res.items, store.rules(), { imageIndex: no - 1 })
          if (r.error) {
            cb(r.error)
            return
          }
          cb(null, r)
        }, task)
      })
    })
  },

  /* 上传重试：ECONNRESET 这类网络抖动，隔一下再传基本就过了 */
  uploadWithRetry: function (filePath, cloudPath, done, token) {
    var self = this
    var task = token === undefined ? this.beginTask() : token
    var tries = 0
    var MAX = 3
    this._retryTimers = this._retryTimers || []

    function later(fn) {
      var id = setTimeout(function () {
        var i = self._retryTimers.indexOf(id)
        if (i >= 0) self._retryTimers.splice(i, 1)
        fn()
      }, 800)
      self._retryTimers.push(id)
    }

    function attempt() {
      if (!self.taskActive(task)) return
      tries++
      wx.cloud.uploadFile({
        cloudPath: cloudPath,
        filePath: filePath,
        success: function (up) { done(null, up) },
        fail: function (err) {
          if (!self.taskActive(task)) { done(err); return }
          var msg = String((err && err.errMsg) || '')
          var retryable = /ECONNRESET|reset|timeout|network|net::|socket/i.test(msg)
          if (retryable && tries < MAX) {
            if (!self._multi) self.setData({ stepText: '上传中断，重试中（' + tries + '/' + (MAX - 1) + '）…' })
            later(attempt)
            return
          }
          done(err)
        }
      })
    }
    attempt()
  },

  /* 云函数调用也重试一次，网络抖动很常见 */
  callOcr: function (fileID, done, token) {
    var self = this
    var task = token === undefined ? this.beginTask() : token
    var tries = 0
    self._retryTimers = self._retryTimers || []

    function later(fn) {
      var id = setTimeout(function () {
        var i = self._retryTimers.indexOf(id)
        if (i >= 0) self._retryTimers.splice(i, 1)
        fn()
      }, 800)
      self._retryTimers.push(id)
    }

    function attempt() {
      if (!self.taskActive(task)) return
      tries++
      wx.cloud.callFunction({
        name: 'ocrText',
        data: { fileID: fileID },
        success: function (r) { done(null, (r && r.result) || {}) },
        fail: function (err) {
          if (!self.taskActive(task)) { done(err); return }
          var msg = String((err && err.errMsg) || '')
          if (tries < 2 && /ECONNRESET|reset|timeout|network|net::|socket/i.test(msg)) {
            later(attempt)
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
  finishBatch: function (acc, fails, skipped, source, total, images) {
    fails = fails.slice().sort(function (a, b) { return a.no - b.no })
    if (images) this._shotImages = images
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
      this._parsed = null
      this._shotImages = null
      this._previewMeta = null
      this._confirmedReviewToken = 0
      this._forceReviewConfirm = false
      this.setData({
        error: (total > 1 ? '这 ' + total + ' 张都没' : '没') + '识别出流水' + why,
        preview: null, editForm: null, highlightKey: ''
      })
      return
    }

    this._previewMeta = { fails: fails, skipped: skipped, source: source, photos: total }
    /* 暂存解析结果，确认导入时直接用，避免再解析一遍。
       每批预览都有独立确认凭证，重选图片后旧的确认不能放行新记录。 */
    this._parsed = acc
    this._reviewToken = (this._reviewToken || 0) + 1
    this._confirmedReviewToken = 0
    this._forceReviewConfirm = false
    this.setData({
      busy: false,
      stepText: '',
      error: '',
      reviewImageIndex: 0,
      highlightKey: '',
      editForm: null
    })
    this.refreshPreview()
  },

  previewLine: function (t) {
    return {
      merchant: t.merchant,
      amountText: format.money(t.amount),
      category: t.category,
      timeText: format.shortTime(t.time),
      type: t.type
    }
  },

  /* OCR 坐标是像素，展示统一换成百分比；压缩上传只改变分辨率，不改变相对位置。
     越界坐标裁到图片内，缺尺寸/缺坐标的条目只保留文字，不伪造框。 */
  buildOriginalImages: function (acc) {
    var images = (this._shotImages || []).map(function (image, index) {
      return {
        path: image.path,
        width: image.width || 0,
        height: image.height || 0,
        imageIndex: index,
        label: '第 ' + (index + 1) + ' 张',
        boxes: [],
        unmappedCount: 0
      }
    })
    images.forEach(function (image, index) {
      acc.forEach(function (t, itemIndex) {
        var mappedIndex = Number(t.imageIndex)
        if (t.imageIndex === null || t.imageIndex === undefined || !isFinite(mappedIndex) || Math.floor(mappedIndex) !== mappedIndex || mappedIndex < 0) {
          mappedIndex = images.length === 1 ? 0 : null
        }
        if (mappedIndex !== index) return
        var box = t.ocrBox
        if (!box || !(image.width > 0) || !(image.height > 0)) { image.unmappedCount++; return }
        var values = [box.left, box.top, box.width, box.height].map(Number)
        if (values.some(function (v) { return !isFinite(v) }) || values[2] <= 0 || values[3] <= 0) {
          image.unmappedCount++; return
        }
        var left = Math.max(0, Math.min(image.width, values[0]))
        var top = Math.max(0, Math.min(image.height, values[1]))
        var right = Math.max(left, Math.min(image.width, values[0] + values[2]))
        var bottom = Math.max(top, Math.min(image.height, values[1] + values[3]))
        if (right <= left || bottom <= top) { image.unmappedCount++; return }
        function pct(value, total) { return (value * 100 / total).toFixed(4) }
        image.boxes.push({
          boxKey: 'box-' + itemIndex,
          reviewKey: 'parsed-' + itemIndex,
          leftPct: pct(left, image.width),
          topPct: pct(top, image.height),
          widthPct: pct(right - left, image.width),
          heightPct: pct(bottom - top, image.height),
          low: t.confidence === 'low'
        })
      })
    })
    return images
  },

  makePreview: function (acc, meta) {
    var plan = store.previewAdd(acc)
    var sample = acc.slice(0, 6).map(function (t, index) {
      var line = this.previewLine(t)
      line.sampleKey = 'sample-' + index
      return line
    }, this)
    var images = this.buildOriginalImages(acc)
    var lowItems = []
    acc.forEach(function (t, index) {
      if (t.confidence !== 'low') return
      var line = this.previewLine(t)
      line.parsedIndex = index
      line.reviewKey = 'parsed-' + index
      line.reviewReasons = (t.reviewReasons || []).slice()
      var mappedIndex = Number(t.imageIndex)
      var hasImageIndex = t.imageIndex !== null && t.imageIndex !== undefined && isFinite(mappedIndex) && Math.floor(mappedIndex) === mappedIndex && mappedIndex >= 0
      line.imageIndex = hasImageIndex ? (images[mappedIndex] ? mappedIndex : -1) : (images.length === 1 ? 0 : -1)
      line.hasBox = !!(images[line.imageIndex] && images[line.imageIndex].boxes.some(function (box) {
        return box.reviewKey === line.reviewKey
      }))
      lowItems.push(line)
    }, this)
    return {
      total: acc.length,
      add: plan.added,
      merged: plan.merged,
      dup: plan.dup,
      skipped: meta.skipped,
      source: meta.source,
      photos: meta.photos,
      fails: meta.fails,
      sample: sample,
      lowCount: lowItems.length,
      lowItems: lowItems,
      images: images
    }
  },

  refreshPreview: function () {
    if (!this._parsed || !this._previewMeta) return
    this.setData({ preview: this.makePreview(this._parsed, this._previewMeta) })
  },

  selectOriginalImage: function (e) {
    var index = Number(e.currentTarget.dataset.index)
    var images = this.data.preview && this.data.preview.images
    if (!images || !images[index]) return
    this.setData({ reviewImageIndex: index })
  },

  focusReviewItem: function (e) {
    var index = Number(e.currentTarget.dataset.index)
    var item = (this.data.preview && this.data.preview.lowItems || []).filter(function (line) {
      return line.parsedIndex === index
    })[0]
    if (!item) return
    var patch = { highlightKey: item.reviewKey }
    if (item.imageIndex >= 0) patch.reviewImageIndex = item.imageIndex
    this.setData(patch)
    if (!item.hasBox && wx.showToast) wx.showToast({ title: '该条缺少可用的原图坐标', icon: 'none' })
  },

  editReviewItem: function (e) {
    var index = Number(e.currentTarget.dataset.index)
    var item = this._parsed && this._parsed[index]
    if (!item) return
    var categories = category.catsOf(item.type)
    this.setData({
      highlightKey: 'parsed-' + index,
      editForm: {
        parsedIndex: index,
        merchant: item.merchant,
        amount: Number(item.amount).toFixed(2),
        date: format.dayOf(item.time),
        type: item.type,
        category: item.category
      },
      editCategories: categories,
      editTypeIndex: Math.max(0, this.data.editTypeOptions.map(function (option) { return option.value }).indexOf(item.type)),
      editCategoryIndex: Math.max(0, categories.indexOf(item.category))
    })
    if (item.imageIndex !== null && item.imageIndex !== undefined && this.data.preview.images[item.imageIndex]) {
      this.setData({ reviewImageIndex: item.imageIndex })
    }
  },

  cancelReviewEdit: function () {
    this.setData({ editForm: null })
  },

  onReviewField: function (e) {
    var form = Object.assign({}, this.data.editForm)
    form[e.currentTarget.dataset.field] = e.detail.value
    this.setData({ editForm: form })
  },

  onReviewDate: function (e) {
    var form = Object.assign({}, this.data.editForm)
    form.date = e.detail.value
    this.setData({ editForm: form })
  },

  onReviewType: function (e) {
    var option = this.data.editTypeOptions[Number(e.detail.value)]
    if (!option) return
    var form = Object.assign({}, this.data.editForm)
    form.type = option.value
    var categories = category.catsOf(option.value)
    form.category = categories.indexOf(form.category) >= 0 ? form.category : categories[0]
    this.setData({
      editForm: form,
      editCategories: categories,
      editTypeIndex: Number(e.detail.value),
      editCategoryIndex: Math.max(0, categories.indexOf(form.category))
    })
  },

  onReviewCategory: function (e) {
    var categories = this.data.editCategories
    if (!categories[Number(e.detail.value)]) return
    var form = Object.assign({}, this.data.editForm)
    form.category = categories[Number(e.detail.value)]
    this.setData({ editForm: form, editCategoryIndex: Number(e.detail.value) })
  },

  saveReviewEdit: function () {
    var form = this.data.editForm
    var index = Number(form && form.parsedIndex)
    var item = this._parsed && this._parsed[index]
    if (!item) return
    var corrected = ocrbill.correctItem(item, {
      merchant: form.merchant,
      amount: form.amount,
      date: form.date,
      type: form.type,
      category: form.category
    }, store.rules())
    if (!corrected) {
      if (wx.showToast) wx.showToast({ title: '请填写有效的修正内容', icon: 'none' })
      return
    }
    this._parsed[index] = corrected
    /* 修正也是新的预览版本：旧确认（包括仍打开的弹窗）立即失效。 */
    this._reviewToken = (this._reviewToken || 0) + 1
    this._confirmedReviewToken = 0
    this._forceReviewConfirm = true
    this.setData({ editForm: null })
    this.refreshPreview()
    if (wx.showToast) wx.showToast({ title: '已修正，请重新确认', icon: 'none' })
  },

  requestImport: function () {
    this.doImport()
  },

  /* 低置信度记录仍参与导入，但必须由用户看完逐条疑点后再次确认；人工修正后
     即使疑点清零，也必须重新确认。doImport 自身也有这道门禁，避免其他调用绕过。 */
  doImport: function () {
    if (!this._parsed) return
    var self = this
    var lowCount = this._parsed.filter(function (t) { return t.confidence === 'low' }).length
    if ((lowCount || this._forceReviewConfirm) && this._confirmedReviewToken !== this._reviewToken) {
      if (this._reviewModalOpen || this._unloaded) return
      var token = this._reviewToken
      this._reviewModalOpen = true
      wx.showModal({
        title: lowCount ? '有 ' + lowCount + ' 笔待核对' : '修正后请重新确认',
        content: lowCount
          ? '有 ' + lowCount + ' 笔低置信度记录，日期、金额、商户或收支方向可能认错。请先逐条核对预览中的金额、商户和疑点，确认无误后再导入。这些记录不会被自动丢弃。'
          : '识别内容已经修正。请重新核对原图和预览后再导入；这些记录不会被自动丢弃。',
        confirmText: '已核对，继续导入',
        cancelText: '返回核对',
        success: function (res) {
          self._reviewModalOpen = false
          if (!res.confirm || self._unloaded || self._reviewToken !== token || !self._parsed) return
          self._confirmedReviewToken = token
          self._forceReviewConfirm = false
          self.doImport()
        },
        fail: function () { self._reviewModalOpen = false }
      })
      return
    }
    var res = store.addMany(this._parsed)
    if (!res || res.saved !== true || res.partial) {
      this.setData({ result: null })
      wx.showModal({
        title: '没能保存',
        content: res && res.partial
          ? '本次未能完整保存，可能已有部分写入且回滚未完成。识别结果和预览已保留，请先核对实际账本、导出备份，再决定是否重试。'
          : '本次未保存，识别结果和预览已保留。可以重试，或先去「报表 → 数据工具」导出备份。',
        showCancel: false
      })
      return
    }
    var learned = store.learnFromItems(this._parsed)
    this._parsed = null
    this._shotImages = null
    this._previewMeta = null
    this._confirmedReviewToken = 0
    this._forceReviewConfirm = false
    this._reviewModalOpen = false
    this.setData({
      preview: null,
      reviewImageIndex: 0,
      highlightKey: '',
      editForm: null,
      result: { added: res.added, dup: res.dup, merged: res.merged || 0 }
    })
    if (learned === false) {
      wx.showModal({
        title: '流水已保存',
        content: '本次流水已保存，但分类规则未保存，不影响本次导入结果，无需重新导入。稍后可在流水页修改分类来学习规则。',
        showCancel: false
      })
    }
  },

  redraw: function () {
    this.setData({
      preview: null, result: null, error: '', photos: 0, done: 0, stepText: '',
      reviewImageIndex: 0, highlightKey: '', editForm: null
    })
    this._parsed = null
    this._shotImages = null
    this._previewMeta = null
    this._confirmedReviewToken = 0
    this._forceReviewConfirm = false
    this._reviewModalOpen = false
  },

  goImport: function () {
    wx.redirectTo({ url: '/pages/import/import' })
  },

  goList: function () {
    wx.switchTab({ url: '/pages/list/list' })
  }
})
