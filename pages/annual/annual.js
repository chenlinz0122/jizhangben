var annualReport = require('../../utils/annual-report')
var store = require('../../utils/store')
var shared = require('../../utils/shared')
var health = require('../../utils/health')
var accounts = require('../../utils/accounts')
var format = require('../../utils/format')
var theme = require('../../utils/theme')
var darkmode = require('../../utils/darkmode')
var annualShare = require('../../utils/annual-share')

function currentYear() {
  return new Date().getFullYear()
}

function defaultSharePrefs() {
  return {
    theme: 'paper',
    title: '',
    subtitle: '',
    showTopCategories: true,
    showHealth: true,
    showGeneratedAt: true,
    accentColor: ''
  }
}

function money(cents) {
  return '¥' + format.signedMoney((Number(cents) || 0) / 100)
}

function rateText(value) {
  if (value === null || value === undefined || !isFinite(value)) return '--'
  if (Math.abs(value) >= 10000) return (value < 0 ? '-' : '') + '>=10000%'
  return (Math.round(value * 1000) / 10).toFixed(1) + '%'
}

function ymOf(tx) {
  var ym = String(tx && tx.ym || '')
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) return ym
  var day = String(tx && tx.day || '').slice(0, 7)
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(day)) return day
  if (tx && tx.time !== undefined && tx.time !== null && tx.time !== '') {
    var time = new Date(tx.time).getTime()
    if (isFinite(time)) return format.ymOf(time)
  }
  return ''
}

Page({
  data: {
    themeKey: 'green',
    dark: false,
    year: currentYear(),
    yearText: currentYear() + '年',
    maxYear: String(currentYear()),
    canNext: false,
    loading: true,
    error: '',
    sharedOn: false,
    scopeText: '本机全部流水',
    hasData: false,
    txCount: 0,
    incomeText: '¥0.00',
    expenseText: '¥0.00',
    refundText: '¥0.00',
    netExpenseText: '¥0.00',
    balanceText: '¥0.00',
    balanceClass: '',
    savingsRateText: '--',
    recordedMonthsText: '0 / 12',
    averageExpenseText: '¥0.00',
    highestMonthText: '暂无',
    lowestMonthText: '暂无',
    months: [],
    topCategories: [],
    health: {
      averageSavingsRateText: '--',
      incomeMonths: 0,
      budgetMonths: 0,
      budgetText: '未设置',
      budgetUsageText: '--',
      overBudgetMonths: 0,
      issueSummaryText: '0 项问题',
      scanCoverageText: '0 / 12 月',
      types: []
    },
    netWorthText: '暂无账户数据',
    budgetNote: '预算按当前设置评估有记录月份；未设置的月份不计入预算统计。',
    reportText: '',
    shareBusy: false,
    shareAction: '',
    shareImage: '',
    shareGeneratedAt: '',
    shareStatus: '',
    shareError: '',
    shareRetryAction: '',
    sharePrefs: defaultSharePrefs(),
    shareThemes: [
      { key: 'paper', label: '纸感' },
      { key: 'forest', label: '森林' },
      { key: 'night', label: '夜色' }
    ]
  },

  onLoad: function (query) {
    var self = this
    var requested = Number(query && query.year)
    var max = currentYear()
    if (isFinite(requested) && requested >= 1970 && requested <= max) {
      this.setData({ year: Math.floor(requested), yearText: Math.floor(requested) + '年' })
    }
    this.setData({ dark: darkmode.isDark(), sharePrefs: annualShare.loadPreferences(wx) })
    if (wx.setNavigationBarTitle) wx.setNavigationBarTitle({ title: '年度财务报告' })
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
      maxYear: String(currentYear())
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
    this._shareSeq = (this._shareSeq || 0) + 1
    if (this._unwatchDark) this._unwatchDark()
  },

  shareActive: function (seq) {
    return !this._unloaded && this._shareSeq === seq
  },

  clearShare: function () {
    this._shareSeq = (this._shareSeq || 0) + 1
    this._shareYear = null
    this._shareScope = ''
    this._shareTemplateKey = ''
    if (this._unloaded) return
    this.setData({
      shareBusy: false,
      shareAction: '',
      shareImage: '',
      shareGeneratedAt: '',
      shareStatus: '',
      shareError: '',
      shareRetryAction: ''
    })
  },

  refresh: function () {
    var self = this
    this.setData({ loading: true, error: '' })
    try {
      var rows = shared.viewRows(store.all(), 'both')
      var year = this.data.year
      var yearRows = rows.filter(function (tx) { return ymOf(tx).slice(0, 4) === String(year) })
      var budgetByMonth = {}
      var healthScanByMonth = {}
      var budget = store.budget()
      var now = Date.now()
      for (var month = 1; month <= 12; month++) {
        var ym = year + '-' + format.pad(month)
        var monthRows = yearRows.filter(function (tx) { return ymOf(tx) === ym })
        healthScanByMonth[ym] = health.scan(monthRows, now)
        if (budget > 0 && monthRows.length) budgetByMonth[ym] = budget
      }
      var result = annualReport.calculate(rows, {
        year: year,
        budgetByMonth: budgetByMonth,
        healthScanByMonth: healthScanByMonth,
        accountNetWorthCents: accounts.netWorth(rows),
        now: now,
        scopeText: this.data.scopeText
      })
      var totals = result.totals
      var overview = result.health
      var topCategories = result.topCategories.map(function (item, index) {
        return Object.assign({}, item, {
          rank: index + 1,
          percentText: rateText(item.pct / 100),
          barStyle: 'width: ' + item.pct + '%'
        })
      })
      var healthTypes = overview.types.map(function (item) {
        return {
          type: item.type,
          label: item.label,
          countText: item.count + ' 项 · ' + item.txCount + ' 笔'
        }
      })
      this._report = result
      if (!result.hasData || this._shareYear !== year || this._shareScope !== this.data.scopeText) this.clearShare()
      this.setData({
        loading: false,
        error: '',
        yearText: year + '年',
        canNext: year < currentYear(),
        hasData: result.hasData,
        txCount: result.txCount,
        incomeText: money(totals.incomeCents),
        expenseText: money(totals.expenseCents),
        refundText: money(totals.refundCents),
        netExpenseText: money(totals.netExpenseCents),
        balanceText: money(totals.balanceCents),
        balanceClass: totals.balanceCents < 0 ? 'negative' : (totals.balanceCents > 0 ? 'positive' : ''),
        savingsRateText: rateText(totals.savingsRate),
        recordedMonthsText: totals.recordedMonths + ' / 12',
        averageExpenseText: money(totals.averageMonthlyExpenseCents),
        highestMonthText: totals.highestExpenseMonth ? totals.highestExpenseMonth.label + ' · ' + money(totals.highestExpenseMonth.netExpenseCents) : '暂无',
        lowestMonthText: totals.lowestExpenseMonth ? totals.lowestExpenseMonth.label + ' · ' + money(totals.lowestExpenseMonth.netExpenseCents) : '暂无',
        months: result.months,
        topCategories: topCategories,
        health: {
          averageSavingsRateText: rateText(overview.averageSavingsRate),
          incomeMonths: overview.incomeMonths,
          budgetMonths: overview.budgetMonths,
          budgetText: overview.budgetCents === null ? '未设置' : money(overview.budgetCents),
          budgetUsageText: rateText(overview.budgetUsage),
          overBudgetMonths: overview.overBudgetMonths,
          issueSummaryText: overview.issueSummaryText,
          scanCoverageText: overview.scanMonths + ' / 12 月',
          types: healthTypes
        },
        netWorthText: result.netWorthCents === null ? '暂无账户数据' : money(result.netWorthCents),
        reportText: result.reportText
      })
    } catch (err) {
      this._report = null
      this.clearShare()
      if (!this._unloaded) this.setData({ loading: false, error: '报告生成失败，请检查本机数据后重试。' })
    }
  },

  prevYear: function () {
    if (this.data.year <= 1970) return
    this.setData({ year: this.data.year - 1 })
    this.refresh()
  },

  nextYear: function () {
    if (!this.data.canNext) return
    this.setData({ year: this.data.year + 1 })
    this.refresh()
  },

  pickYear: function (e) {
    var year = Number(e && e.detail && e.detail.value)
    if (!isFinite(year) || year < 1970 || year > currentYear() || year === this.data.year) return
    this.setData({ year: Math.floor(year) })
    this.refresh()
  },

  currentYear: function () {
    var year = currentYear()
    if (year === this.data.year) return
    this.setData({ year: year })
    this.refresh()
  },

  updateSharePrefs: function (patch) {
    if (this._unloaded) return
    if (this.data.shareBusy) {
      wx.showToast({ title: '正在处理分享图，请稍候', icon: 'none' })
      return
    }
    var prefs = annualShare.normalizeOptions(Object.assign({}, this.data.sharePrefs, patch))
    var value = {
      theme: prefs.theme,
      title: patch.title === undefined ? this.data.sharePrefs.title : patch.title,
      subtitle: patch.subtitle === undefined ? this.data.sharePrefs.subtitle : patch.subtitle,
      showTopCategories: prefs.showTopCategories,
      showHealth: prefs.showHealth,
      showGeneratedAt: prefs.showGeneratedAt,
      accentColor: prefs.accentColor
    }
    var saved = annualShare.savePreferences(value, wx)
    this.setData({ sharePrefs: saved.value })
    this.clearShare()
    if (!saved.saved) wx.showToast({ title: '偏好暂存于本次页面，本机保存失败', icon: 'none' })
  },

  selectShareTheme: function (e) {
    var theme = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.theme
    if (theme === this.data.sharePrefs.theme) return
    this.updateSharePrefs({ theme: theme })
  },

  inputShareTitle: function (e) {
    this.updateSharePrefs({ title: e && e.detail && e.detail.value || '' })
  },

  inputShareSubtitle: function (e) {
    this.updateSharePrefs({ subtitle: e && e.detail && e.detail.value || '' })
  },

  toggleShareModule: function (e) {
    var detail = e && e.detail
    var field = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.field
    if (['showTopCategories', 'showHealth', 'showGeneratedAt'].indexOf(field) < 0) return
    var patch = {}
    patch[field] = !!(detail && detail.value)
    this.updateSharePrefs(patch)
  },

  inputShareAccent: function (e) {
    this.updateSharePrefs({ accentColor: e && e.detail && e.detail.value || '' })
  },

  resetShareAccent: function () {
    this.updateSharePrefs({ accentColor: '' })
  },

  resetSharePrefs: function () {
    this.updateSharePrefs(defaultSharePrefs())
  },

  shareTemplateKey: function () {
    return JSON.stringify(this.data.sharePrefs)
  },

  generateShare: function () {
    if (this._unloaded) return
    if (this.data.shareBusy) {
      wx.showToast({ title: '正在处理分享图，请稍候', icon: 'none' })
      return
    }
    if (this.data.loading || this.data.error || !this.data.hasData || !this._report || annualShare.isEmpty(this._report)) {
      wx.showToast({ title: '这一年还没有流水，暂不能生成分享图', icon: 'none' })
      return
    }
    if (!wx.createCanvasContext || !wx.canvasToTempFilePath) {
      this.setData({ shareError: '当前微信版本不支持生成分享图，请升级后重试。', shareRetryAction: 'generate' })
      wx.showToast({ title: '当前不支持生成分享图', icon: 'none' })
      return
    }
    var self = this
    var seq = (this._shareSeq || 0) + 1
    var generatedAt = Date.now()
    var settled = false
    this._shareSeq = seq
    this._shareYear = this.data.year
    this._shareScope = this.data.scopeText
    this._shareTemplateKey = this.shareTemplateKey()
    this.setData({
      shareBusy: true,
      shareAction: 'generate',
      shareImage: '',
      shareGeneratedAt: '',
      shareError: '',
      shareStatus: '正在生成分享图…',
      shareRetryAction: ''
    })
    function active() { return self.shareActive(seq) }
    function fail() {
      if (settled) return
      settled = true
      if (!active()) return
      self.setData({
        shareBusy: false,
        shareAction: '',
        shareError: '生成失败，请重试。',
        shareStatus: '分享图未生成，可重新尝试。',
        shareRetryAction: 'generate'
      })
      wx.showToast({ title: '生成分享图失败，请重试', icon: 'none' })
    }
    try {
      var ctx = wx.createCanvasContext('annual-share-canvas', this)
      annualShare.render(ctx, this._report, Object.assign({}, this.data.sharePrefs, {
        generatedAt: generatedAt,
        scopeText: this.data.scopeText
      }))
      ctx.draw(false, function () {
        if (settled || !active()) return
        try {
          wx.canvasToTempFilePath({
            canvasId: 'annual-share-canvas',
            x: 0,
            y: 0,
            width: annualShare.WIDTH,
            height: annualShare.HEIGHT,
            destWidth: annualShare.WIDTH,
            destHeight: annualShare.HEIGHT,
            fileType: 'png',
            quality: 1,
            success: function (res) {
              if (settled || !active()) return
              if (!res || !res.tempFilePath) { fail(); return }
              settled = true
              self.setData({
                shareBusy: false,
                shareAction: '',
                shareImage: res.tempFilePath,
                shareGeneratedAt: annualShare.formatDate(generatedAt),
                shareError: '',
                shareStatus: '分享图已生成，可预览、分享给好友或保存到相册。',
                shareRetryAction: ''
              })
            },
            fail: fail
          }, self)
        } catch (err) { fail() }
      })
    } catch (err) { fail() }
  },

  shareToFriends: function () {
    if (this._unloaded) return
    if (this.data.shareBusy) {
      wx.showToast({ title: '正在处理，请稍候', icon: 'none' })
      return
    }
    var path = this.data.shareImage
    if (!path || !this.data.hasData || this._shareYear !== this.data.year || this._shareScope !== this.data.scopeText || this._shareTemplateKey !== this.shareTemplateKey()) {
      wx.showToast({ title: '请先生成当前年份的分享图', icon: 'none' })
      return
    }
    var self = this
    var seq = (this._shareSeq || 0) + 1
    var settled = false
    this._shareSeq = seq
    this.setData({
      shareBusy: true,
      shareAction: 'share',
      shareError: '',
      shareStatus: '正在打开分享给好友…',
      shareRetryAction: ''
    })
    function active() { return self.shareActive(seq) }
    function failed(err) {
      if (settled) return
      settled = true
      if (!active()) return
      self.setData({ shareBusy: false, shareAction: '' })
      var message = String(err && (err.errMsg || err.message) || '')
      if (/cancel|取消/i.test(message)) {
        self.setData({ shareError: '', shareStatus: '已取消分享，图片仍保留，可重试。', shareRetryAction: '' })
        wx.showToast({ title: '已取消分享', icon: 'none' })
        return
      }
      if ((err && err.code === 'UNSUPPORTED') || /unsupported|not support|不支持/i.test(message)) {
        self.setData({
          shareError: '当前微信版本不支持直接分享图片，请改用保存到相册。',
          shareStatus: '图片已保留，可保存到相册后发送给好友。',
          shareRetryAction: 'save'
        })
        wx.showToast({ title: '当前不支持直接分享，请改用保存相册', icon: 'none' })
        return
      }
      self.setData({
        shareError: '分享给好友失败，请重试或改用保存到相册。',
        shareStatus: '图片已保留，可重试分享或保存到相册。',
        shareRetryAction: 'share'
      })
      wx.showToast({ title: '分享失败，可重试或保存相册', icon: 'none' })
    }
    annualShare.shareToFriends(path, {
      success: function () {
        if (settled || !active()) return
        settled = true
        self.setData({
          shareBusy: false,
          shareAction: '',
          shareError: '',
          shareStatus: '已分享给好友。',
          shareRetryAction: ''
        })
        wx.showToast({ title: '已分享给好友', icon: 'success' })
      },
      fail: failed
    })
  },

  saveShareImage: function () {
    if (this._unloaded) return
    if (this.data.shareBusy) {
      wx.showToast({ title: '正在处理分享图，请稍候', icon: 'none' })
      return
    }
    var path = this.data.shareImage
    if (!path || !this.data.hasData || this._shareYear !== this.data.year || this._shareScope !== this.data.scopeText || this._shareTemplateKey !== this.shareTemplateKey()) {
      wx.showToast({ title: '请先生成当前年份的分享图', icon: 'none' })
      return
    }
    if (!wx.saveImageToPhotosAlbum) {
      this.setData({ shareError: '当前微信版本不支持保存到相册，请升级后重试。', shareRetryAction: 'save' })
      wx.showToast({ title: '当前不支持保存到相册', icon: 'none' })
      return
    }
    var self = this
    var seq = (this._shareSeq || 0) + 1
    var settled = false
    this._shareSeq = seq
    this.setData({ shareBusy: true, shareAction: 'save', shareError: '', shareStatus: '正在保存到相册…', shareRetryAction: '' })
    function active() { return self.shareActive(seq) }
    function failed(err) {
      if (settled) return
      settled = true
      if (!active()) return
      self.setData({ shareBusy: false, shareAction: '' })
      var message = String(err && (err.errMsg || err.message) || '')
      if (/auth|permission|deny|拒绝|权限|授权/i.test(message)) {
        self.setData({
          shareError: '未获得相册权限，请在微信设置中开启后重试。',
          shareStatus: '图片已保留，可预览；开启权限后可重试保存。',
          shareRetryAction: 'save'
        })
        if (wx.showModal) {
          wx.showModal({
            title: '未获得相册权限',
            content: '请在微信设置中允许保存到相册。当前分享图仍可预览，不会自动保存。',
            confirmText: '去设置',
            cancelText: '稍后重试',
            success: function (res) {
              if (!res.confirm || !self.shareActive(seq)) return
              if (!wx.openSetting) {
                wx.showToast({ title: '请在微信设置中开启相册权限', icon: 'none' })
                return
              }
              wx.openSetting({
                success: function () {
                  if (!self.shareActive(seq)) return
                  wx.showToast({ title: '请再次点击保存到相册', icon: 'none' })
                },
                fail: function () {
                  if (!self.shareActive(seq)) return
                  wx.showToast({ title: '无法打开设置，请稍后重试', icon: 'none' })
                }
              })
            }
          })
        } else {
          wx.showToast({ title: '未获得相册权限，请开启后重试', icon: 'none' })
        }
        return
      }
      self.setData({ shareError: '保存到相册失败，请重试。', shareStatus: '分享图仍可预览，尚未保存到相册。', shareRetryAction: 'save' })
      wx.showToast({ title: '保存失败，请重试', icon: 'none' })
    }
    try {
      wx.saveImageToPhotosAlbum({
        filePath: path,
        success: function () {
          if (settled || !active()) return
          settled = true
          self.setData({ shareBusy: false, shareAction: '', shareError: '', shareStatus: '已保存到相册。', shareRetryAction: '' })
          wx.showToast({ title: '已保存到相册', icon: 'success' })
        },
        fail: failed
      })
    } catch (err) { failed(err) }
  },

  previewShareImage: function () {
    var path = this.data.shareImage
    if (!path) {
      wx.showToast({ title: '请先生成分享图', icon: 'none' })
      return
    }
    if (!wx.previewImage) {
      wx.showToast({ title: '当前不支持全图预览', icon: 'none' })
      return
    }
    wx.previewImage({
      current: path,
      urls: [path],
      fail: function () { wx.showToast({ title: '预览失败，请重试', icon: 'none' }) }
    })
  },

  copyReport: function () {
    var text = this.data.reportText
    if (!text) {
      wx.showToast({ title: '暂无可复制的报告', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: text,
      success: function () { wx.showToast({ title: '年报已复制', icon: 'none' }) },
      fail: function () { wx.showToast({ title: '复制失败，请重试', icon: 'none' }) }
    })
  },

  goBack: function () {
    wx.navigateBack({ fail: function () { wx.switchTab({ url: '/pages/report/report' }) } })
  }
})
