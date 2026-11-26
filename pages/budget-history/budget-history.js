var budgetHistory = require('../../utils/budget-history')
var store = require('../../utils/store')
var format = require('../../utils/format')
var theme = require('../../utils/theme')
var darkmode = require('../../utils/darkmode')

function money(value, signed) {
  var n = Number(value)
  if (!isFinite(n)) n = 0
  return (signed && n < 0 ? '-' : '') + '¥' + format.money(Math.abs(n))
}

function diffClass(value) {
  return value > 0 ? 'up' : value < 0 ? 'down' : 'same'
}

function timeText(value) {
  if (!value) return '时间未记录'
  var d = new Date(value)
  if (isNaN(d.getTime())) return '时间未记录'
  function pad(n) { return n < 10 ? '0' + n : '' + n }
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

function copyText(item, comparison) {
  var lines = [
    '历史预算存档 · ' + format.monthLabel(item.ym),
    '保存时间：' + timeText(item.updatedAt),
    '历史总预算：' + money(item.budget)
  ]
  var cats = Object.keys(item.catBudgets)
  lines.push('历史分类预算：' + (cats.length ? cats.map(function (name) {
    return name + ' ' + money(item.catBudgets[name])
  }).join('，') : '无'))
  if (comparison) {
    lines.push('当前总预算：' + money(comparison.currentBudget))
    lines.push('总预算差异（当前 − 历史）：' + money(comparison.budgetDiff, true))
    lines.push('分类预算差异（当前 − 历史）：')
    if (!comparison.categories.length) lines.push('无')
    comparison.categories.forEach(function (row) {
      lines.push('- ' + row.category + '：历史 ' + money(row.budget) + '，当前 ' +
        money(row.currentBudget) + '，差异 ' + money(row.diff, true))
    })
  }
  return lines.join('\n')
}

function viewRow(item, currentBudget, currentCats) {
  var comparison = null
  var error = ''
  try {
    comparison = budgetHistory.diff(item.ym, currentBudget, currentCats)
    if (!comparison) error = '当前预算数据无效，暂时无法计算差异'
  } catch (e) { error = '当前预算数据无效，暂时无法计算差异' }
  var cats = Object.keys(item.catBudgets).map(function (name) {
    return { category: name, amountText: money(item.catBudgets[name]) }
  })
  var categoryDiffs = comparison ? comparison.categories.map(function (row) {
    return Object.assign({}, row, {
      budgetText: money(row.budget),
      currentBudgetText: money(row.currentBudget),
      diffText: money(row.diff, true),
      diffClass: diffClass(row.diff)
    })
  }) : []
  return {
    ym: item.ym,
    monthText: format.monthLabel(item.ym),
    updatedAtText: timeText(item.updatedAt),
    budgetText: money(item.budget),
    categories: cats,
    hasCategories: cats.length > 0,
    currentBudgetText: money(currentBudget),
    budgetDiffText: comparison ? money(comparison.budgetDiff, true) : '--',
    budgetDiffClass: comparison ? diffClass(comparison.budgetDiff) : 'same',
    categoryDiffs: categoryDiffs,
    hasCategoryDiffs: categoryDiffs.length > 0,
    diffError: error,
    copyText: copyText(item, comparison)
  }
}

Page({
  data: {
    themeKey: 'green',
    dark: false,
    currentMonth: '',
    currentBudgetText: '¥0.00',
    currentCategoryCount: 0,
    saving: false,
    items: [],
    hasHistory: false,
    error: ''
  },

  onLoad: function () {
    var self = this
    this._unloaded = false
    if (wx.setNavigationBarTitle) wx.setNavigationBarTitle({ title: '历史预算存档' })
    this._unwatchDark = darkmode.watch(function (dark) {
      if (!self._unloaded) self.setData({ dark: dark })
    })
  },

  onShow: function () {
    var currentTheme = theme.get()
    this.setData({
      themeKey: currentTheme.key,
      dark: darkmode.isDark(),
      currentMonth: format.ymOf(Date.now())
    })
    theme.syncTabBar()
    this.refresh()
  },

  onUnload: function () {
    this._unloaded = true
    if (this._unwatchDark) this._unwatchDark()
  },

  toast: function (title) {
    if (wx.showToast) wx.showToast({ title: title, icon: 'none' })
  },

  refresh: function () {
    var currentBudget = store.budget()
    var currentCats = store.catBudgets() || {}
    var items = budgetHistory.list(budgetHistory.MAX_MONTHS).map(function (item) {
      return viewRow(item, currentBudget, currentCats)
    })
    var error = items.length && items[0].diffError ? items[0].diffError : ''
    this.setData({
      items: items,
      hasHistory: items.length > 0,
      currentBudgetText: money(currentBudget),
      currentCategoryCount: Object.keys(currentCats).length,
      error: error
    })
  },

  saveCurrent: function () {
    if (this.data.saving) return
    this.setData({ saving: true })
    var ym = format.ymOf(Date.now())
    var saved = budgetHistory.record(ym, store.budget(), store.catBudgets(), Date.now())
    this.setData({ saving: false })
    if (!saved) return this.toast('存档失败：请检查预算数据或本机空间')
    this.refresh()
    this.toast('已存档 ' + ym + ' 预算')
  },

  copyHistory: function (e) {
    var ym = e && e.currentTarget && e.currentTarget.dataset.ym
    var item = this.data.items.filter(function (row) { return row.ym === ym })[0]
    if (!item || !item.copyText) return this.toast('暂无可复制的历史预算')
    wx.setClipboardData({
      data: item.copyText,
      success: function () { wx.showToast({ title: '历史预算已复制', icon: 'none' }) },
      fail: function () { wx.showToast({ title: '复制失败，请重试', icon: 'none' }) }
    })
  }
})
