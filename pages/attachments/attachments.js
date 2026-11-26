var store = require('../../utils/store')
var format = require('../../utils/format')
var attachments = require('../../utils/attachments')
var theme = require('../../utils/theme')
var darkmode = require('../../utils/darkmode')

function txSummary(tx) {
  var d = new Date(tx.time)
  var dir = {
    expense: { text: '支出', sign: '-' },
    income: { text: '收入', sign: '+' },
    refund: { text: '退款', sign: '+' },
    transfer: { text: '不计收支', sign: '' }
  }[tx.type] || { text: '流水', sign: '-' }
  var date = tx.day || (isFinite(d.getTime()) ? format.dayOf(tx.time) : '日期未知')
  return {
    merchant: tx.merchant || '未填写商户',
    amountText: format.money(tx.amount),
    sign: dir.sign,
    typeText: dir.text,
    category: tx.category || '未分类',
    dateText: date,
    timeText: isFinite(d.getTime()) ? format.pad(d.getHours()) + ':' + format.pad(d.getMinutes()) : '',
    desc: tx.desc || '',
    note: tx.note || '',
    account: tx.account || '未填写支付方式'
  }
}

function formatBytes(value) {
  var size = Number(value)
  if (!isFinite(size) || size <= 0) return '0 B'
  if (size < 1024) return size + ' B'
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB'
  return (size / (1024 * 1024)).toFixed(1) + ' MB'
}

function rowsOf(items) {
  return items.map(function (item) {
    var row = Object.assign({}, item, {
      addedText: item.addedAt ? format.shortTime(item.addedAt) : '',
      missingText: item.missing ? '文件不存在，需重新添加' : '',
      sizeText: formatBytes(item.bytes),
      compressedText: item.compressedAt ? '已压缩 · ' + formatBytes(item.bytes) : formatBytes(item.bytes)
    })
    return row
  })
}

Page({
  data: {
    themeKey: 'green',
    themeColor: '#17806b',
    dark: false,
    txId: '',
    tx: null,
    rows: [],
    missingCount: 0,
    loading: true,
    adding: false,
    action: '',
    actionLabel: '',
    progressDone: 0,
    progressTotal: 0,
    feedback: null,
    error: '',
    previewVisible: false,
    previewIndex: 0,
    previewRows: []
  },

  onLoad: function (options) {
    this._unloaded = false
    this._visible = false
    this.setData({ txId: String((options && options.txId) || '') })
    try { wx.setNavigationBarTitle({ title: '流水票据' }) } catch (e) {}
    var self = this
    this._unwatchDark = darkmode.watch(function (dark) {
      if (self._unloaded) return
      self.setData({ dark: dark })
    })
  },

  onShow: function () {
    this._visible = true
    var palette = theme.get()
    this.setData({ themeKey: palette.key, themeColor: palette.color, dark: darkmode.isDark() })
    this.refresh()
  },

  onHide: function () { this._visible = false },

  onUnload: function () {
    this._unloaded = true
    this._visible = false
    if (this._unwatchDark) this._unwatchDark()
  },

  refresh: function () {
    if (this._unloaded) return
    var txId = this.data.txId
    if (!txId) {
      this.setData({ loading: false, tx: null, rows: [], missingCount: 0, error: '缺少流水 ID，无法关联票据' })
      return
    }
    var tx = null
    try {
      var all = store.all()
      for (var i = 0; i < all.length; i++) if (all[i].id === txId) { tx = all[i]; break }
      if (!tx) {
        this.setData({ loading: false, tx: null, rows: [], missingCount: 0, error: '没有找到这笔流水，可能已被删除' })
        return
      }
      var items = attachments.list(txId)
      this.setData({
        loading: false,
        tx: txSummary(tx),
        rows: rowsOf(items),
        missingCount: items.filter(function (item) { return item.missing }).length,
        error: ''
      })
    } catch (e) {
      this.setData({ loading: false, error: e.message || '票据读取失败，请重试' })
    }
  },

  chooseImages: function () {
    if (this.data.adding || this.data.action || !this.data.txId || !this.data.tx) return
    var self = this
    this.setData({ adding: true, error: '' })
    wx.chooseImage({
      count: 9,
      sizeType: ['compressed', 'original'],
      sourceType: ['album', 'camera'],
      success: function (res) {
        var files = res.tempFiles && res.tempFiles.length ? res.tempFiles : (res.tempFilePaths || [])
        try {
          var result = attachments.attach(self.data.txId, files)
          self.setData({ adding: false })
          self.refresh()
          var bits = []
          if (result.added) bits.push('已添加 ' + result.added + ' 张')
          if (result.duplicate) bits.push('跳过重复 ' + result.duplicate + ' 张')
          if (result.skipped) bits.push('忽略无效 ' + result.skipped + ' 张')
          wx.showToast({ title: bits.join('，') || '没有新增图片', icon: 'none' })
        } catch (e) {
          self.setData({ adding: false, error: e.message || '图片添加失败，请重试' })
          wx.showToast({ title: e.message || '图片添加失败', icon: 'none' })
        }
      },
      fail: function (e) {
        self.setData({ adding: false })
        if (e && /cancel/i.test(e.errMsg || '')) return
        var message = '无法选择图片，请检查相册权限'
        self.setData({ error: message })
        wx.showToast({ title: message, icon: 'none' })
      }
    })
  },

  runAttachmentAction: function (action, attachmentIds) {
    if (this._unloaded || this.data.adding || this.data.action || !this.data.txId || !this.data.tx) return
    var self = this
    var isCompress = action === 'compress'
    var label = isCompress ? '压缩全部' : '导出到相册'
    var candidates = attachmentIds
      ? this.data.rows.filter(function (row) { return row.id === attachmentIds && !row.missing })
      : this.data.rows.filter(function (row) { return !row.missing })
    this.setData({
      action: action,
      actionLabel: attachmentIds ? '压缩这张' : label,
      progressDone: 0,
      progressTotal: candidates.length,
      feedback: null,
      error: ''
    })
    return Promise.resolve(attachments[action](this.data.txId, attachmentIds, {
      onProgress: function (state) {
        if (self._unloaded) return
        self.setData({ progressDone: state.completed, progressTotal: state.total })
      }
    })).then(function (result) {
      if (self._unloaded) return
      self.refresh()
      self.setData({ action: '', actionLabel: '', feedback: self.actionFeedback(action, result) })
      wx.showToast({ title: self.feedbackTitle(action, result), icon: result.failed || result.skipped ? 'none' : 'success' })
      if (result.needsSettings) self.guideAlbumPermission(attachmentIds)
    }, function (error) {
      if (self._unloaded) return
      self.refresh()
      var message = error && error.message || '操作失败，请重试'
      self.setData({ action: '', actionLabel: '', feedback: { tone: 'error', title: isCompress ? '压缩未完成' : '导出未完成', detail: message } })
      wx.showToast({ title: message, icon: 'none' })
    })
  },

  actionFeedback: function (action, result) {
    var errors = result.errors || []
    var detail = errors.length ? errors.map(function (error) { return error.name + '：' + error.message }).join('；') : ''
    if (action === 'compress') {
      var title = result.failed || result.skipped ? '压缩完成，部分失败' : '已压缩 ' + result.compressed + ' 张'
      if (!result.failed && !result.skipped && result.savedBytes > 0) title += '，节省 ' + formatBytes(result.savedBytes)
      if (!result.compressed && !result.failed) title = '没有可压缩的图片'
      return { tone: result.failed ? 'warning' : 'success', title: title, detail: detail || '压缩质量约为 65，失败时保留原图。' }
    }
    var exportTitle = result.saved ? '已导出 ' + result.saved + ' 张到相册' : '未能导出到相册'
    if (result.failed || result.skipped) exportTitle += '，部分失败（' + (result.failed + result.skipped) + ' 张）'
    return {
      tone: result.failed || result.skipped ? 'warning' : 'success',
      title: exportTitle,
      detail: detail || '已逐张保存到系统相册，不生成 ZIP 压缩包。'
    }
  },

  feedbackTitle: function (action, result) {
    if (action === 'compress') return result.failed || result.skipped ? '压缩完成，部分失败' : '已压缩 ' + result.compressed + ' 张'
    return result.failed || result.skipped ? '已导出 ' + result.saved + ' 张，部分失败' : '已导出 ' + result.saved + ' 张'
  },

  guideAlbumPermission: function (attachmentIds) {
    var self = this
    wx.showModal({
      title: '需要相册权限',
      content: '导出时相册权限被拒绝，请前往系统设置开启后重试。',
      confirmText: '去设置',
      success: function (res) {
        if (!res.confirm || self._unloaded) return
        if (typeof wx.openSetting !== 'function') {
          wx.showToast({ title: '请手动开启相册权限', icon: 'none' })
          return
        }
        wx.openSetting({
          success: function (setting) {
            if (self._unloaded) return
            if (setting.authSetting && setting.authSetting['writePhotosAlbum']) self.runAttachmentAction('exportToAlbum', attachmentIds)
            else wx.showToast({ title: '尚未开启相册权限', icon: 'none' })
          },
          fail: function () { wx.showToast({ title: '无法打开设置，请手动开启相册权限', icon: 'none' }) }
        })
      }
    })
  },

  compressAll: function () { return this.runAttachmentAction('compress') },

  exportAll: function () { return this.runAttachmentAction('exportToAlbum') },

  compressOne: function (e) {
    var id = e.currentTarget.dataset.id
    if (id) return this.runAttachmentAction('compress', id)
  },

  preview: function (e) {
    var id = e.currentTarget.dataset.id
    var rows = this.data.rows
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].id !== id) continue
      if (rows[i].missing) {
        wx.showToast({ title: '文件不存在，请重新添加', icon: 'none' })
        return
      }
      var visible = rows.filter(function (row) { return !row.missing })
      var index = visible.indexOf(rows[i])
      this.setData({ previewVisible: true, previewIndex: index < 0 ? 0 : index, previewRows: visible })
      return
    }
  },

  closePreview: function () {
    this.setData({ previewVisible: false, previewIndex: 0, previewRows: [] })
  },

  changePreview: function (e) {
    this.setData({ previewIndex: Number(e.detail.current) || 0 })
  },

  previewError: function () {
    var row = this.data.previewRows[this.data.previewIndex]
    var message = row ? '「' + row.name + '」文件不存在或无法读取，请重新添加' : '图片无法读取，请重新添加'
    this.setData({ previewVisible: false })
    this.refresh()
    this.setData({ error: message })
  },

  imageError: function (e) {
    var id = e.currentTarget.dataset.id
    var rows = this.data.rows.map(function (row) {
      return row.id === id ? Object.assign({}, row, { missing: true, missingText: '文件不存在，需重新添加' }) : row
    })
    var count = rows.filter(function (row) { return row.missing }).length
    this.setData({ rows: rows, missingCount: count })
  },

  askRemove: function (e) {
    var id = e.currentTarget.dataset.id
    var self = this
    var row = null
    for (var i = 0; i < this.data.rows.length; i++) if (this.data.rows[i].id === id) { row = this.data.rows[i]; break }
    if (!row) return
    wx.showModal({
      title: '删除票据？',
      content: '将删除「' + row.name + '」及其本机图片，删除后无法恢复。',
      confirmText: '删除',
      confirmColor: '#d9433f',
      success: function (res) { if (res.confirm) self.removeImage(id) }
    })
  },

  removeImage: function (id) {
    if (!this.data.txId || this.data.action || this.data.adding) return
    try {
      var result = attachments.remove(this.data.txId, id)
      if (!result.removed) { wx.showToast({ title: '票据不存在或已删除', icon: 'none' }); return }
      this.setData({ previewVisible: false, previewIndex: 0, previewRows: [] })
      this.refresh()
      wx.showToast({ title: '已删除', icon: 'none' })
    } catch (e) {
      this.setData({ error: e.message || '删除失败，请重试' })
      wx.showToast({ title: e.message || '删除失败', icon: 'none' })
    }
  },

  clearTx: function () {
    if (!this.data.txId || !this.data.rows.length || this.data.action || this.data.adding) return
    var self = this
    wx.showModal({
      title: '清空这笔流水的票据？',
      content: '将删除全部 ' + this.data.rows.length + ' 张票据和本机图片，无法恢复。',
      confirmText: '全部删除',
      confirmColor: '#d9433f',
      success: function (res) {
        if (!res.confirm) return
        try {
          attachments.removeTx(self.data.txId)
          self.refresh()
          wx.showToast({ title: '已清空票据', icon: 'none' })
        } catch (e) {
          self.refresh()
          self.setData({ error: e.message || '清空失败，请重试' })
          wx.showToast({ title: e.message || '清空失败', icon: 'none' })
        }
      }
    })
  },

  goBack: function () {
    wx.navigateBack({ fail: function () { wx.switchTab({ url: '/pages/list/list' }) } })
  }
})
