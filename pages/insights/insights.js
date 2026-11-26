var healthScore = require('../../utils/health-score')
var store = require('../../utils/store')
var shared = require('../../utils/shared')
var health = require('../../utils/health')
var accounts = require('../../utils/accounts')
var format = require('../../utils/format')
var theme = require('../../utils/theme')
var darkmode = require('../../utils/darkmode')

function validYm(value) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ''))
}

function monthOf(tx) {
  if (validYm(tx && tx.ym)) return tx.ym
  if (validYm(String(tx && tx.day || '').slice(0, 7))) return String(tx.day).slice(0, 7)
  if (tx && tx.time !== undefined && tx.time !== null && tx.time !== '') {
    var time = new Date(tx.time).getTime()
    if (isFinite(time)) return format.ymOf(time)
  }
  return ''
}

function rateText(value) {
  if (value === null || value === undefined || !isFinite(value)) return '--'
  if (Math.abs(value) >= 10000) return (value < 0 ? '-' : '') + '>=10000%'
  return (Math.round(value * 1000) / 10).toFixed(1) + '%'
}

function money(cents) {
  return '¥' + format.signedMoney((Number(cents) || 0) / 100)
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
    sharedOn: false,
    scopeText: '本机全部流水',
    hasData: false,
    score: 0,
    level: '暂无数据',
    ringStyle: 'background: conic-gradient(var(--brand) 0%, var(--ring-track) 0deg)',
    breakdown: [],
    suggestions: [],
    txCount: 0,
    incomeText: '¥0.00',
    netExpenseText: '¥0.00',
    balanceText: '¥0.00',
    balanceClass: '',
    savingsRateText: '--',
    budgetText: '未设置',
    topCategoryText: '暂无已分类支出',
    uncategorizedText: '0 / 0 笔',
    healthText: '0 项问题',
    healthClass: '',
    netWorthText: '¥0.00',
    reportText: ''
  },

  onLoad: function () {
    var self = this
    this.setData({ ym: format.ymOf(Date.now()), maxYm: format.ymOf(Date.now()), dark: darkmode.isDark() })
    if (wx.setNavigationBarTitle) wx.setNavigationBarTitle({ title: '月度财务健康报告' })
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
      scopeText: joined ? '共同账本全部可见成员' : '本机全部流水',
      maxYm: format.ymOf(Date.now())
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

  refresh: function () {
    var self = this
    this.setData({ loading: true, error: '' })
    try {
      var ym = this.data.ym
      var rows = shared.viewRows(store.all(), 'both')
      var monthRows = rows.filter(function (tx) { return monthOf(tx) === ym })
      var now = Date.now()
      var scan = health.scan(monthRows, now)
      var result = healthScore.calculate(rows, {
        ym: ym,
        budget: store.budget(),
        healthScan: scan,
        accountNetWorthCents: accounts.netWorth(rows),
        now: now,
        scopeText: this.data.scopeText
      })
      var metrics = result.metrics
      var breakdown = result.breakdown.map(function (entry) {
        return Object.assign({}, entry, {
          percent: Math.round(entry.score / entry.max * 1000) / 10,
          barStyle: 'width: ' + (Math.round(entry.score / entry.max * 1000) / 10) + '%'
        })
      })
      self._result = result
      self.setData({
        loading: false,
        error: '',
        monthText: format.monthLabel(ym),
        canNext: ym < format.ymOf(Date.now()),
        hasData: result.hasData,
        score: result.score,
        level: result.level,
        ringStyle: 'background: conic-gradient(var(--brand) ' + result.score + '%, var(--ring-track) 0deg)',
        breakdown: breakdown,
        suggestions: result.suggestions,
        txCount: metrics.txCount,
        incomeText: money(metrics.incomeCents),
        netExpenseText: money(metrics.netExpenseCents),
        balanceText: money(metrics.balanceCents),
        balanceClass: metrics.balanceCents < 0 ? 'negative' : (metrics.balanceCents > 0 ? 'positive' : ''),
        savingsRateText: metrics.savingsRate === null ? '无收入' : rateText(metrics.savingsRate),
        budgetText: metrics.budgetCents > 0
          ? rateText(metrics.budgetUsage) + ' · ' + money(metrics.netExpenseCents) + ' / ' + money(metrics.budgetCents)
          : '未设置（中性分）',
        topCategoryText: metrics.topCategory
          ? metrics.topCategory + ' · ' + rateText(metrics.topCategoryShare)
          : '暂无已分类支出',
        uncategorizedText: metrics.uncategorizedCount + ' / ' + metrics.categorizationTxCount + ' 笔',
        healthText: metrics.healthIssueCount + ' 项问题 · 涉及 ' + metrics.healthAffectedTxCount + ' 笔',
        healthClass: metrics.healthIssueCount ? 'warning' : 'good',
        netWorthText: money(metrics.netWorthCents),
        reportText: result.reportText
      })
    } catch (err) {
      self.setData({ loading: false, error: '报告生成失败，请检查本机数据后重试。' })
    }
  },

  prevMonth: function () {
    if (this.data.ym <= '1970-01') return
    this.setData({ ym: format.shiftMonth(this.data.ym, -1) })
    this.refresh()
  },

  nextMonth: function () {
    if (!this.data.canNext) return
    this.setData({ ym: format.shiftMonth(this.data.ym, 1) })
    this.refresh()
  },

  pickMonth: function (e) {
    var ym = String(e && e.detail && e.detail.value || '')
    if (!validYm(ym) || ym > format.ymOf(Date.now()) || ym < '1970-01') return
    if (ym === this.data.ym) return
    this.setData({ ym: ym })
    this.refresh()
  },

  currentMonth: function () {
    var ym = format.ymOf(Date.now())
    if (ym === this.data.ym) return
    this.setData({ ym: ym })
    this.refresh()
  },

  copyReport: function () {
    var text = this.data.reportText
    if (!text) {
      wx.showToast({ title: '暂无可复制的报告', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: text,
      success: function () { wx.showToast({ title: '报告已复制', icon: 'none' }) },
      fail: function () { wx.showToast({ title: '复制失败，请重试', icon: 'none' }) }
    })
  },

  goBack: function () {
    wx.navigateBack({
      fail: function () { wx.switchTab({ url: '/pages/report/report' }) }
    })
  },

  goList: function () {
    wx.switchTab({ url: '/pages/list/list' })
  }
})
