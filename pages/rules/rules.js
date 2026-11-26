/* 分类规则管理中心：只管理本地规则，不改动已有流水。 */
var category = require('../../utils/category')
var darkmode = require('../../utils/darkmode')
var ruleManager = require('../../utils/rule-manager')
var store = require('../../utils/store')
var theme = require('../../utils/theme')

var SOURCE_TEXT = {
  user: '命中启用规则',
  builtin: '命中内置分类',
  'platform-sub': '命中平台二级分类',
  platform: '采用平台分类',
  'platform-name': '采用平台默认分类',
  biz: '命中商户关键词',
  kind: '按流水类型判断',
  none: '未命中关键词'
}

function decorateRule(rule) {
  return Object.assign({}, rule, {
    badge: String(rule.category || '?').slice(0, 1),
    color: category.colorOf(rule.category),
    tint: category.tintOf(rule.category),
    impactText: (rule.enabled ? '影响 ' : '启用后影响 ') + rule.affectedCount + ' 笔'
  })
}

Page({
  data: {
    themeKey: 'green',
    themeColor: '#17806b',
    dark: false,
    loading: true,
    actionBusy: false,
    error: '',
    actionError: '',
    rules: [],
    visibleRules: [],
    totalCount: 0,
    enabledCount: 0,
    disabledCount: 0,
    search: '',
    filter: 'all',
    previewMerchant: '',
    previewDesc: '',
    previewType: 'expense',
    previewResult: null,
    previewError: ''
  },

  onLoad: function () {
    var self = this
    this._unloaded = false
    this.setData({ dark: darkmode.isDark() })
    this._stopDarkWatch = darkmode.watch(function (dark) {
      if (!self._unloaded) self.setData({ dark: dark })
    })
  },

  onShow: function () {
    this._visible = true
    var current = theme.get()
    this.setData({ themeKey: current.key, themeColor: current.color, dark: darkmode.isDark() })
    this.loadRules(true)
  },

  onHide: function () { this._visible = false },

  onUnload: function () {
    this._visible = false
    this._unloaded = true
    if (this._stopDarkWatch) this._stopDarkWatch()
  },

  loadRules: function (showLoading) {
    if (this._unloaded) return
    if (showLoading) this.setData({ loading: true, error: '' })
    try {
      /* 规则管理器直接写两个 storage key，先让 store 的缓存与磁盘一致。 */
      store.reload()
      var rules = ruleManager.list().map(decorateRule)
      var enabled = rules.filter(function (rule) { return rule.enabled }).length
      this._allRules = rules
      this.setData({
        loading: false,
        error: '',
        rules: rules,
        totalCount: rules.length,
        enabledCount: enabled,
        disabledCount: rules.length - enabled
      })
      this.renderRules()
      this.updatePreview()
    } catch (error) {
      this._allRules = []
      this.setData({
        loading: false,
        error: '规则数据读取失败：' + (error.message || '请重试'),
        rules: [],
        visibleRules: [],
        totalCount: 0,
        enabledCount: 0,
        disabledCount: 0,
        previewResult: null,
        previewError: '请先修复规则数据，再使用预览'
      })
    }
  },

  renderRules: function () {
    var query = String(this.data.search || '').trim().toLowerCase()
    var filter = this.data.filter
    var visible = (this._allRules || []).filter(function (rule) {
      if (filter === 'enabled' && !rule.enabled) return false
      if (filter === 'disabled' && rule.enabled) return false
      return !query || (rule.merchant + ' ' + rule.category).toLowerCase().indexOf(query) >= 0
    })
    this.setData({ visibleRules: visible })
  },

  onSearch: function (e) {
    this.setData({ search: String(e.detail.value || '') })
    this.renderRules()
  },

  clearSearch: function () {
    this.setData({ search: '' })
    this.renderRules()
  },

  pickFilter: function (e) {
    var filter = e.currentTarget.dataset.filter
    if (['all', 'enabled', 'disabled'].indexOf(filter) < 0) return
    this.setData({ filter: filter })
    this.renderRules()
  },

  showFailure: function (message) {
    this.setData({ actionError: message })
    wx.showToast({ title: message, icon: 'none', duration: 2400 })
  },

  runAction: function (action, successText) {
    if (this._unloaded || this.data.actionBusy || this.data.loading) return
    this.setData({ actionBusy: true, actionError: '' })
    var result
    try {
      result = action()
    } catch (error) {
      result = { ok: false, message: error.message || '操作失败，请重试' }
    }
    if (!result || !result.ok) {
      this.setData({ actionBusy: false })
      this.showFailure((result && result.message) || '操作失败，请重试')
      this.loadRules(false)
      return
    }
    this.setData({ actionBusy: false })
    wx.showToast({ title: successText, icon: 'success' })
    this.loadRules(false)
  },

  toggleRule: function (e) {
    var merchant = e.currentTarget.dataset.merchant
    var enabled = !!e.detail.value
    this.runAction(function () {
      return ruleManager.toggle(merchant, enabled)
    }, enabled ? '规则已启用' : '规则已停用')
  },

  requestRemove: function (e) {
    if (this.data.actionBusy || this.data.loading) return
    var self = this
    var merchant = e.currentTarget.dataset.merchant
    var count = Number(e.currentTarget.dataset.count) || 0
    wx.showModal({
      title: '删除分类规则',
      content: '删除“' + merchant + '”？已有流水不会被修改或删除' +
        (count ? '，目前有 ' + count + ' 笔流水的分类结果会受影响。' : '。'),
      confirmText: '删除',
      confirmColor: '#d9433f',
      success: function (res) {
        if (!res.confirm || self._unloaded) return
        self.runAction(function () { return ruleManager.remove(merchant) }, '规则已删除')
      }
    })
  },

  requestClearDisabled: function () {
    if (this.data.actionBusy || this.data.loading || !this.data.disabledCount) return
    var self = this
    wx.showModal({
      title: '清空停用规则',
      content: '确定清空 ' + this.data.disabledCount + ' 条停用规则吗？清空后无法恢复，但不会删除流水。',
      confirmText: '清空',
      confirmColor: '#d9433f',
      success: function (res) {
        if (!res.confirm || self._unloaded) return
        self.runAction(function () { return ruleManager.clearDisabled() }, '停用规则已清空')
      }
    })
  },

  onPreviewMerchant: function (e) {
    this.setData({ previewMerchant: String(e.detail.value || ''), previewError: '' })
    this.updatePreview()
  },

  onPreviewDesc: function (e) {
    this.setData({ previewDesc: String(e.detail.value || ''), previewError: '' })
    this.updatePreview()
  },

  pickPreviewType: function (e) {
    var type = e.currentTarget.dataset.type
    if (['expense', 'income', 'transfer'].indexOf(type) < 0) return
    this.setData({ previewType: type })
    this.updatePreview()
  },

  updatePreview: function () {
    if (this._unloaded || this.data.loading || this.data.error) return
    var merchant = String(this.data.previewMerchant || '').trim()
    var desc = String(this.data.previewDesc || '').trim()
    if (!merchant && !desc) {
      this.setData({ previewResult: null, previewError: '' })
      return
    }
    try {
      var result = ruleManager.preview(merchant + ' ' + desc, this.data.previewType)
      this.setData({
        previewResult: Object.assign({}, result, {
          badge: String(result.category || '?').slice(0, 1),
          color: category.colorOf(result.category),
          tint: category.tintOf(result.category),
          sourceText: SOURCE_TEXT[result.by] || '自动分类'
        }),
        previewError: ''
      })
    } catch (error) {
      this.setData({ previewResult: null, previewError: error.message || '预览失败，请重试' })
    }
  },

  retry: function () { this.loadRules(true) }
})
