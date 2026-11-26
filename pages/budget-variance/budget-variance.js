var budgetVariance = require('../../utils/budget-variance')
var store = require('../../utils/store')
var stats = require('../../utils/stats')
var shared = require('../../utils/shared')
var prefs = require('../../utils/prefs')
var category = require('../../utils/category')
var format = require('../../utils/format')
var theme = require('../../utils/theme')
var darkmode = require('../../utils/darkmode')

var PAGE_PATH = '/pages/budget-variance/budget-variance'

function validYm(value) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ''))
}

function moneyText(value, signed) {
  var n = Number(value)
  if (!isFinite(n)) return '¥0.00'
  return (signed && n < 0 ? '-' : '') + '¥' + format.money(Math.abs(n))
}

function rateText(value) {
  if (value === null || value === undefined || !isFinite(value)) return '--'
  if (value >= 10000) return '>=10000%'
  return value.toFixed(1) + '%'
}

function scopeLabel(book, scope) {
  if (!book) return '本机全部流水'
  var view = prefs.viewScopeLabel(scope)
  var name = String(book.name || '共同账本').replace(/[\r\n]+/g, ' ').slice(0, 30)
  return '共同账本「' + name + '」· ' + view + (book.members > 1 ? '（' + book.members + ' 人）' : '')
}

Page({
  data: {
    themeKey: 'green',
    dark: false,
    ym: '',
    monthText: '',
    maxYm: '',
    canNext: false,
    loading: true,
    error: '',
    backTab: '',
    backLabel: '',
    sharedOn: false,
    sharedMembers: 0,
    scope: 'both',
    scopeText: '本机全部流水',
    hasData: false,
    hasCategories: false,
    hasBudget: false,
    totalBudget: 0,
    totalBudgetText: '0.00',
    actualNetSpend: 0,
    actualNetSpendText: '0.00',
    actualNetSpendMoneyText: '¥0.00',
    netNegative: false,
    grossSpentText: '0.00',
    refundReceivedText: '0.00',
    remaining: null,
    remainingText: '--',
    remainingMoneyText: '--',
    remainingLabel: '不可计算',
    overspend: null,
    overspendText: '--',
    usageRate: null,
    usageRateText: '--',
    barPct: 0,
    overallStatus: budgetVariance.STATUS.NO_BUDGET,
    overallLabel: '未设总预算',
    statusClass: 'none',
    summaryNote: '本月支出 − 本月到账退款',
    categories: [],
    suggestions: [],
    reportText: '',
    trendMonths: [],
    trendText: '',
    trendBudgetNote: '仅已保存的当前月预算参与比较，历史月份不补算'
  },

  onLoad: function () {
    var self = this
    var current = format.ymOf(Date.now())
    this.setData({ ym: current, maxYm: current, dark: darkmode.isDark() })
    if (wx.setNavigationBarTitle) wx.setNavigationBarTitle({ title: '预算执行偏差分析' })
    this._unwatchDark = darkmode.watch(function (dark) {
      if (self._unloaded) return
      self.setData({ dark: dark })
      if (self._visible) {
        theme.syncTabBar()
        self.refresh()
      }
    })
  },

  onShow: function () {
    this._visible = true
    var app = getApp()
    var backTab = ''
    var backLabel = ''
    if (app.globalData.backFor === PAGE_PATH) {
      backTab = app.globalData.backTab || ''
      backLabel = app.globalData.backLabel || '返回'
    }
    app.globalData.backFor = ''
    app.globalData.backTab = ''
    app.globalData.backLabel = ''
    var book = shared.current()
    var joined = shared.isJoined()
    this.setData({
      themeKey: theme.get().key,
      dark: darkmode.isDark(),
      sharedOn: joined,
      sharedMembers: joined && book ? (book.members || 0) : 0,
      scope: joined ? prefs.viewScope() : 'both',
      backTab: backTab,
      backLabel: backLabel,
      maxYm: format.ymOf(Date.now())
    })
    if (!validYm(this.data.ym)) this.setData({ ym: format.ymOf(Date.now()) })
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

  scopeTxs: function () {
    return shared.viewRows(store.all(), prefs.viewScope())
  },

  setScope: function (e) {
    if (!this.data.sharedOn) return
    var value = e && e.currentTarget && e.currentTarget.dataset.k
    if (value !== 'mine' && value !== 'both' && value !== 'peer') return
    prefs.setViewScope(value)
    var self = this
    this.setData({ scope: value }, function () { self.refresh() })
  },

  refresh: function () {
    var self = this
    this.setData({ loading: true, error: '' })
    try {
      var ym = this.data.ym
      var scope = this.data.scope
      var book = this.data.sharedOn ? shared.current() : null
      var txs = this.scopeTxs()
      var projected = stats.ledger(txs, true)
      var result = budgetVariance.calculate(txs, ym, store.budget(), store.catBudgets(), {
        projected: projected,
        scopeLabel: scopeLabel(book, scope)
      })
      /*  store 只保存一个当前额度，没有历史预算快照；趋势不得把它复制到旧月份。 */
      var currentYm = format.ymOf(Date.now())
      var currentBudget = store.budget()
      var budgetByMonth = Object.create(null)
      if (currentBudget > 0) budgetByMonth[currentYm] = currentBudget
      var trend = budgetVariance.calculateTrend(txs, ym, 6, budgetByMonth, store.catBudgets(), {
        projected: projected,
        scopeLabel: scopeLabel(book, scope)
      })
      var trendMonths = trend.months.map(function (row) {
        var rowClass = row.status
        if (rowClass === budgetVariance.STATUS.OVER) rowClass = 'over'
        else if (rowClass === budgetVariance.STATUS.NEAR) rowClass = 'near'
        else if (rowClass === budgetVariance.STATUS.HEALTHY) rowClass = 'healthy'
        else rowClass = 'none'
        return Object.assign({}, row, {
          statusClass: rowClass,
          monthShort: row.ym.slice(5).replace('-', '/'),
          budgetMoneyText: row.hasBudget ? moneyText(row.budget) : '未设置',
          spentMoneyText: moneyText(row.actualNetSpend, true),
          varianceMoneyText: row.hasBudget ? moneyText(row.variance, true) : '--',
          usageRateText: rateText(row.usageRate),
          negative: row.actualNetSpend < 0,
          active: row.ym === ym
        })
      })
      var statusClass = result.overallStatus
      if (statusClass === budgetVariance.STATUS.OVER) statusClass = 'over'
      else if (statusClass === budgetVariance.STATUS.NEAR) statusClass = 'near'
      else if (statusClass === budgetVariance.STATUS.HEALTHY) statusClass = 'healthy'
      else statusClass = 'none'
      var categories = result.categories.map(function (row) {
        var rowClass = row.status
        if (rowClass === budgetVariance.STATUS.OVER) rowClass = 'over'
        else if (rowClass === budgetVariance.STATUS.NEAR) rowClass = 'near'
        else if (rowClass === budgetVariance.STATUS.HEALTHY) rowClass = 'healthy'
        else rowClass = 'none'
        return Object.assign({}, row, {
          icon: category.iconOf(row.category),
          tint: category.tintOf(row.category),
          color: category.colorOf(row.category),
          statusClass: rowClass,
          statusText: row.status === budgetVariance.STATUS.OVER ? '超支'
            : row.status === budgetVariance.STATUS.NEAR ? '接近预算'
              : row.status === budgetVariance.STATUS.HEALTHY ? '健康' : '未设预算',
          budgetText: row.hasBudget ? format.money(row.budget) : '未设',
          spentMoneyText: moneyText(row.spent, true),
          varianceMoneyText: row.hasBudget ? moneyText(row.variance, true) : '--',
          variancePctText: row.variancePct === null ? '--' : row.variancePct.toFixed(1) + '%',
          usageRateText: rateText(row.usageRate),
          negative: row.spent < 0
        })
      })
      var remainingLabel = !result.hasBudget ? '不可计算'
        : result.overspend > 0 ? '超支' : '剩余'
      var summaryNote = result.netNegative
        ? '退款大于支出，净支出保留负数；使用率按 0% 展示'
        : result.refundReceived > 0
          ? '本月退款 ' + moneyText(result.refundReceived) + ' 已按到账月抵减'
          : '本月支出 − 本月到账退款；收入与转账不计'
      self._result = result
      self.setData({
        loading: false,
        error: '',
        monthText: format.monthLabel(ym),
        canNext: ym < format.ymOf(Date.now()),
        scopeText: scopeLabel(book, scope),
        hasData: result.hasData,
        hasCategories: categories.length > 0,
        hasBudget: result.hasBudget,
        totalBudget: result.totalBudget,
        totalBudgetText: result.hasBudget ? format.money(result.totalBudget) : '未设置',
        actualNetSpend: result.actualNetSpend,
        actualNetSpendText: format.signedMoney(result.actualNetSpend),
        actualNetSpendMoneyText: moneyText(result.actualNetSpend, true),
        netNegative: result.netNegative,
        grossSpentText: format.money(result.grossSpent),
        refundReceivedText: format.money(result.refundReceived),
        remaining: result.remaining,
        remainingText: result.remaining === null ? '--' : format.money(Math.abs(result.remaining)),
        remainingMoneyText: result.remaining === null ? '--' : moneyText(Math.abs(result.remaining)),
        remainingLabel: remainingLabel,
        overspend: result.overspend,
        overspendText: result.overspend === null ? '--' : format.money(result.overspend),
        usageRate: result.usageRate,
        usageRateText: rateText(result.usageRate),
        barPct: result.barPct,
        overallStatus: result.overallStatus,
        overallLabel: result.overallLabel,
        statusClass: statusClass,
        summaryNote: summaryNote,
        categories: categories,
        suggestions: result.suggestions,
        reportText: result.reportText,
        trendMonths: trendMonths,
        trendText: trend.reportText,
        trendBudgetNote: !currentBudget
          ? '当前月未设置预算；区间内月份均标记为未设置'
          : trend.budgetedMonthCount
            ? '仅当前月有已保存预算；历史月份未设置，不补算'
            : '所选区间不含当前月；历史月份未设置，不补算'
      })
    } catch (err) {
      self.setData({ loading: false, error: '分析生成失败，请检查本机数据后重试。' })
    }
  },

  prevMonth: function () {
    if (this.data.ym <= '1970-01') return
    var self = this
    this.setData({ ym: format.shiftMonth(this.data.ym, -1) }, function () { self.refresh() })
  },

  nextMonth: function () {
    if (!this.data.canNext) return
    var self = this
    this.setData({ ym: format.shiftMonth(this.data.ym, 1) }, function () { self.refresh() })
  },

  pickMonth: function (e) {
    var ym = String(e && e.detail && e.detail.value || '')
    if (!validYm(ym) || ym < '1970-01' || ym > format.ymOf(Date.now())) return
    if (ym === this.data.ym) return
    var self = this
    this.setData({ ym: ym }, function () { self.refresh() })
  },

  currentMonth: function () {
    var ym = format.ymOf(Date.now())
    if (ym === this.data.ym) return
    var self = this
    this.setData({ ym: ym }, function () { self.refresh() })
  },

  copyReport: function () {
    if (!this.data.reportText) {
      wx.showToast({ title: '暂无可复制的报告', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: this.data.reportText,
      success: function () { wx.showToast({ title: '报告已复制', icon: 'none' }) },
      fail: function () { wx.showToast({ title: '复制失败，请重试', icon: 'none' }) }
    })
  },

  copyTrend: function () {
    if (!this.data.trendText) {
      wx.showToast({ title: '暂无可复制的趋势', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: this.data.trendText,
      success: function () { wx.showToast({ title: '趋势已复制', icon: 'none' }) },
      fail: function () { wx.showToast({ title: '复制失败，请重试', icon: 'none' }) }
    })
  },

  goBudgetSettings: function () {
    var app = getApp()
    app.globalData.reportYm = this.data.ym
    app.globalData.reportSection = 'budget'
    wx.switchTab({ url: '/pages/report/report' })
  },

  goBack: function () {
    if (this.data.backTab) {
      wx.switchTab({ url: this.data.backTab })
      return
    }
    wx.navigateBack({ fail: function () { wx.switchTab({ url: '/pages/report/report' }) } })
  }
})
