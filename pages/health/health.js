var health = require('../../utils/health')
var store = require('../../utils/store')
var shared = require('../../utils/shared')
var prefs = require('../../utils/prefs')
var format = require('../../utils/format')
var theme = require('../../utils/theme')
var darkmode = require('../../utils/darkmode')

var SEVERITY_TEXT = { high: '需优先核对', medium: '建议核对', low: '可完善' }
var TYPE_TEXT = {
  duplicate: '疑似重复', future: '未来日期', amount: '零或负金额',
  missingMerchant: '缺少商户', uncategorized: '未分类', ocrReview: 'OCR 待核对', large: '异常大额'
}

function emptySummary() {
  return {
    total: 0, issueCount: 0, affectedTxCount: 0, healthy: true,
    highCount: 0, mediumCount: 0, lowCount: 0,
    byType: {}, txCountByType: {}, bySeverity: { high: 0, medium: 0, low: 0 },
    types: [], groups: [], issues: []
  }
}

function rowView(tx, sharedOn) {
  var byLabel = sharedOn && tx.byMe === false && tx.by ? shared.labelOf(tx.by, tx.ownerKey) : ''
  return {
    id: String(tx.id || ''),
    merchant: String(tx.merchant || '').trim() || '（没有商户名）',
    day: tx.day || '',
    ym: tx.ym || String(tx.day || '').slice(0, 7),
    amountText: format.signedMoney(tx.amount),
    category: tx.category || '未分类',
    type: tx.type || '',
    typeText: tx.type === 'expense' ? '支出' : (tx.type === 'income' ? '收入' :
      (tx.type === 'refund' ? '退款' : (tx.type === 'transfer' ? '不计收支' : '未知类型'))),
    source: tx.source || '',
    desc: tx.desc || '',
    byLabel: byLabel,
    canEdit: store.canEdit(tx)
  }
}

function issueView(issue, sharedOn) {
  return {
    key: issue.key,
    type: issue.type,
    typeLabel: TYPE_TEXT[issue.type] || issue.type,
    severity: issue.severity,
    severityText: SEVERITY_TEXT[issue.severity] || '建议核对',
    txIds: issue.txIds || [],
    title: issue.title,
    description: issue.description,
    suggestion: issue.suggestion,
    items: (issue.records || []).map(function (tx) { return rowView(tx, sharedOn) })
  }
}

Page({
  data: {
    themeKey: 'green',
    dark: false,
    sharedOn: false,
    scope: 'both',
    scopeText: '当前账本可见成员',
    largeAmount: health.DEFAULT_LARGE_AMOUNT,
    largeAmountText: format.money(health.DEFAULT_LARGE_AMOUNT),
    loading: true,
    error: '',
    hasTx: false,
    refreshedAt: '',
    activeType: 'all',
    summary: emptySummary(),
    types: [],
    groups: []
  },

  onLoad: function () {
    var self = this
    this.setData({ dark: darkmode.isDark() })
    if (wx.setNavigationBarTitle) wx.setNavigationBarTitle({ title: '流水查重与数据体检' })
    this._unwatchDark = darkmode.watch(function (dark) {
      if (self._unloaded) return
      self.setData({ dark: dark })
      if (self._visible) theme.syncTabBar()
    })
  },

  onShow: function () {
    this._visible = true
    var joined = shared.isJoined()
    this.setData({
      themeKey: theme.get().key,
      dark: darkmode.isDark(),
      sharedOn: joined,
      scope: joined ? prefs.viewScope() : 'both'
    })
    theme.syncTabBar()
    this.refresh()
  },

  onHide: function () {
    this._visible = false
  },

  onUnload: function () {
    this._visible = false
    this._unloaded = true
    if (this._unwatchDark) this._unwatchDark()
  },

  visibleRows: function () {
    var rows = store.all()
    return shared.isJoined() ? shared.viewRows(rows, this.data.scope) : rows
  },

  refresh: function () {
    this.runScan(false)
  },

  runScan: function (showFeedback) {
    var self = this
    this.setData({ loading: true, error: '' })
    try {
      var joined = shared.isJoined()
      var rows = this.visibleRows()
      var scan = health.scan(rows, Date.now(), { largeAmount: this.data.largeAmount })
      var summary = health.summarize(scan)
      var groups = summary.groups.map(function (group) {
        return {
          key: group.key,
          type: group.type,
          label: group.label,
          hint: group.hint,
          count: group.count,
          txCount: group.txCount,
          issues: group.issues.map(function (entry) { return issueView(entry, joined) })
        }
      })
      this._scan = scan
      this._groups = groups
      this._txViews = Object.create(null)
      groups.forEach(function (group) {
        group.issues.forEach(function (entry) {
          entry.items.forEach(function (tx) { self._txViews[tx.id] = tx })
        })
      })
      var now = new Date()
      this.setData({
        loading: false,
        hasTx: scan.total > 0,
        sharedOn: joined,
        scopeText: !joined ? '本机全部流水' : (self.data.scope === 'mine' ? '仅看自己' : '当前账本可见成员'),
        largeAmountText: format.money(scan.largeAmount),
        refreshedAt: format.pad(now.getHours()) + ':' + format.pad(now.getMinutes()),
        summary: {
          total: summary.total,
          issueCount: summary.issueCount,
          affectedTxCount: summary.affectedTxCount,
          healthy: summary.healthy,
          highCount: summary.highCount,
          mediumCount: summary.mediumCount,
          lowCount: summary.lowCount
        },
        types: summary.types,
        groups: self.filteredGroups()
      })
      if (showFeedback) wx.showToast({ title: '体检已刷新', icon: 'none' })
    } catch (err) {
      this.setData({ loading: false, error: '体检未能完成，请刷新重试。' })
      if (showFeedback) wx.showToast({ title: '刷新失败，请重试', icon: 'none' })
    }
  },

  filteredGroups: function () {
    var groups = this._groups || []
    return this.data.activeType === 'all' ? groups : groups.filter(function (group) {
      return group.type === this.data.activeType
    }, this)
  },

  filterType: function (e) {
    var type = e.currentTarget.dataset.type || 'all'
    var groups = this._groups || []
    this.setData({
      activeType: type,
      groups: type === 'all' ? groups : groups.filter(function (group) { return group.type === type })
    })
  },

  setScope: function (e) {
    if (!shared.isJoined()) return
    var scope = e.currentTarget.dataset.scope === 'mine' ? 'mine' : 'both'
    prefs.setViewScope(scope)
    this.setData({ scope: scope, activeType: 'all' })
    this.runScan(false)
  },

  adjustLargeAmount: function () {
    var self = this
    wx.showModal({
      title: '调整大额体检线',
      editable: true,
      content: String(this.data.largeAmount),
      placeholderText: '默认 10000',
      success: function (res) {
        if (!res.confirm) return
        var value = Number(res.content)
        if (!isFinite(value) || value < 0.01) {
          wx.showToast({ title: '请输入大于 0 的金额', icon: 'none' })
          return
        }
        self.setData({ largeAmount: Math.round(value * 100) / 100 })
        self.runScan(false)
        wx.showToast({ title: '大额线已更新', icon: 'none' })
      }
    })
  },

  goBack: function () {
    wx.navigateBack({
      fail: function () { wx.switchTab({ url: '/pages/home/home' }) }
    })
  },

  goList: function () {
    wx.switchTab({ url: '/pages/list/list' })
  },

  findIssue: function (key, id) {
    var groups = this._groups || []
    for (var i = 0; i < groups.length; i++) {
      var issues = groups[i].issues || []
      for (var j = 0; j < issues.length; j++) {
        if (key && issues[j].key === key) return issues[j]
        if (!key && id && issues[j].items.some(function (tx) { return tx.id === id })) return issues[j]
      }
    }
    return null
  },

  jumpToTx: function (tx, issue, openDetail) {
    if (!tx || !tx.id) return
    var uncat = !!issue && issue.type === 'uncategorized'
    var app = getApp()
    Object.assign(app.globalData, {
      filterUncat: uncat,
      filterCat: '',
      filterKind: '',
      filterYm: tx.ym || String(tx.day || '').slice(0, 7),
      filterDay: uncat ? '' : (tx.day || ''),
      openTxId: openDetail ? tx.id : '',
      backFor: '/pages/list/list',
      backTab: '/pages/health/health',
      backLabel: '返回体检'
    })
    wx.switchTab({ url: '/pages/list/list' })
  },

  goTx: function (e) {
    var id = e.currentTarget.dataset.id
    var issue = this.findIssue(e.currentTarget.dataset.key, id)
    this.jumpToTx(this._txViews && this._txViews[id], issue, true)
  },

  goIssue: function (e) {
    var issue = this.findIssue(e.currentTarget.dataset.key)
    if (!issue) return
    if (issue.type === 'uncategorized') { this.goUncat(); return }
    this.jumpToTx(issue.items[0], issue, false)
  },

  goUncat: function () {
    var app = getApp()
    Object.assign(app.globalData, {
      filterUncat: true,
      filterCat: '',
      filterKind: '',
      filterYm: '',
      filterDay: '',
      openTxId: '',
      backFor: '/pages/list/list',
      backTab: '/pages/health/health',
      backLabel: '返回体检'
    })
    wx.switchTab({ url: '/pages/list/list' })
  },

  editableDuplicate: function (id) {
    var current = null
    store.all().forEach(function (tx) { if (tx.id === id) current = tx })
    if (!current) { wx.showToast({ title: '这笔流水已不存在，请刷新', icon: 'none' }); return null }
    if (!store.canEdit(current)) { wx.showToast({ title: '只能删除自己记的流水', icon: 'none' }); return null }
    var scan = health.scan(this.visibleRows(), Date.now(), { largeAmount: this.data.largeAmount })
    var duplicate = null
    scan.issues.forEach(function (entry) {
      if (entry.type === 'duplicate' && entry.txIds.indexOf(id) >= 0) duplicate = entry
    })
    if (!duplicate) { wx.showToast({ title: '重复状态已变化，请刷新核对', icon: 'none' }); return null }
    return { tx: current, issue: duplicate }
  },

  requestDelete: function (e) {
    var self = this
    var id = e.currentTarget.dataset.id
    var target = this.editableDuplicate(id)
    if (!target) return
    var tx = target.tx
    wx.showModal({
      title: '确认删除这笔流水？',
      content: (String(tx.merchant || '').trim() || '无商户') + ' · ' + (tx.day || '日期未知') +
        ' · ¥' + format.signedMoney(tx.amount) +
        '\n仅删除这一笔，不会批量删除重复组。删除后无法恢复；已共享记录会在下次同步时提交删除。',
      confirmText: '确认删除',
      confirmColor: '#d9433f',
      success: function (res) {
        if (!res.confirm) return
        /* 弹窗停留期间账本可能变化，确认前再次校验成员身份和重复状态。 */
        if (!self.editableDuplicate(id)) return
        if (store.remove(id) === false) {
          wx.showToast({ title: '删除未完成，请刷新后重试', icon: 'none' })
          return
        }
        self.runScan(false)
        wx.showToast({ title: '已删除这一笔', icon: 'none' })
      }
    })
  }
})
