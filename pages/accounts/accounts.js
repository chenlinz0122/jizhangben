var accounts = require('../../utils/accounts')
var currency = require('../../utils/currency')
var exchangeRates = require('../../utils/exchange-rates')
var accountMap = require('../../utils/account-map')
var store = require('../../utils/store')
var format = require('../../utils/format')
var theme = require('../../utils/theme')
var darkmode = require('../../utils/darkmode')

var CURRENCY_OPTIONS = currency.CODES.map(function (code) {
  var item = currency.CURRENCIES[code]
  return { code: code, name: item.name, label: code + ' · ' + item.name }
})

var ACCOUNT_TYPES = [
  { value: 'cash', label: '现金', note: '随身现金' },
  { value: 'bank', label: '银行卡', note: '储蓄卡或银行账户' },
  { value: 'wallet', label: '电子钱包', note: '微信、支付宝等' },
  { value: 'credit', label: '信用卡', note: '允许负数余额' }
]

function centsOf(value) {
  var n = Number(value) || 0
  return Math.round((n + (n < 0 ? -1e-9 : 1e-9)) * 100)
}

function moneyText(cents) {
  var value = Number(cents) || 0
  if (value === 0) value = 0
  return (value < 0 ? '-¥' : '¥') + format.money(Math.abs(value) / 100)
}

function inputText(value) {
  return (Number(value) || 0).toFixed(2)
}

function rateInput(value, code) {
  return code === 'CNY' ? '1' : String(value === undefined || value === null ? '' : value)
}

function txText(tx) {
  var day = tx.day || (tx.time ? format.dayOf(tx.time) : '未知日期')
  return day + ' · ' + String(tx.account || '未填写支付方式') + ' · ' + format.money(Number(tx.amount) || 0)
}

function rateHistoryText(item) {
  var records = exchangeRates.list(item.id).map(function (entry) {
    var previous = entry.previousRate === null ? '首次' : String(entry.previousRate)
    return {
      id: entry.id,
      timeText: format.dayOf(entry.createdAt) + ' ' + format.shortTime(entry.createdAt).split(' ')[1],
      changeText: previous + ' → ' + entry.rate,
      rateText: '1 ' + entry.currency + ' = ' + entry.rate + ' CNY'
    }
  })
  return records
}

function previewText(result) {
  if (!result || !result.keyword) return '未命中启用规则'
  if (result.ambiguous) return '命中“' + result.keyword + '”，需选择：' + result.candidates.map(function (item) { return item.accountName }).join(' / ')
  return '命中“' + result.keyword + '” → ' + result.accountName
}

Page({
  data: {
    themeKey: 'green',
    themeColor: '#17806b',
    dark: false,
    accountTypes: ACCOUNT_TYPES,
    currencyOptions: CURRENCY_OPTIONS,
    accounts: [],
    accountCount: 0,
    includedCount: 0,
    netWorthText: '¥0.00',
    netWorthReady: false,
    netWorthNegative: false,
    error: '',
    busy: false,
    formVisible: false,
    editingId: '',
    formTitle: '新增账户',
    formError: '',
    form: {
      name: '',
      type: 'cash',
      openingBalance: '0.00',
      currency: 'CNY',
      rateToCny: '1',
      includeInNetWorth: true
    },
    formCurrencyIndex: 0,
    formCurrencySymbol: '¥',
    formCurrencyName: '人民币',
    formRateHint: currency.formatRate(1, 'CNY'),
    mappingRules: [],
    mappingError: '',
    mappingFormError: '',
    mappingKeyword: '',
    mappingAccountIndex: 0,
    mappingAccountId: '',
    mappingPreviewText: '',
    mappingPreviewResult: '',
    mappingPreviewError: '',
    mappingBusy: false,
    mappingApplyBusy: false,
    mappingAutoCount: 0,
    mappingAmbiguousCount: 0,
    mappingProgress: ''
  },

  onLoad: function () {
    var self = this
    this._unloaded = false
    this._visible = false
    try { wx.setNavigationBarTitle({ title: '多账户与余额' }) } catch (e) {}
    var palette = theme.get()
    this.setData({ dark: darkmode.isDark(), themeKey: palette.key, themeColor: palette.color })
    this._stopDarkWatch = darkmode.watch(function (dark) {
      if (self._unloaded) return
      self.setData({ dark: dark })
      if (self._visible) theme.syncTabBar()
    })
  },

  onShow: function () {
    this._visible = true
    theme.syncTabBar()
    var palette = theme.get()
    this.setData({ dark: darkmode.isDark(), themeKey: palette.key, themeColor: palette.color })
    this.refresh()
  },

  onHide: function () { this._visible = false },

  onUnload: function () {
    this._visible = false
    this._unloaded = true
    this._mappingBatch = null
    if (this._stopDarkWatch) this._stopDarkWatch()
  },

  notifyError: function (message) {
    this.setData({ error: message })
    wx.showToast({ title: message, icon: 'none' })
  },

  noop: function () {},

  readTxs: function () {
    try {
      return store.all()
    } catch (e) {
      this.notifyError('流水读取失败，余额暂不可计算')
      return null
    }
  },

  updateMappingView: function (items, txs) {
    var rules = []
    var autoCount = 0
    var ambiguousCount = 0
    try {
      rules = accountMap.list()
      var counts = Object.create(null)
      rules.forEach(function (rule) { counts[rule.id] = { assignCount: 0, ambiguousCount: 0 } })
      if (Array.isArray(txs)) {
        txs.forEach(function (tx) {
          if (!tx || !store.canEdit(tx) || accountMap.hasAccountId(tx)) return
          var result = accountMap.match(tx.account, items)
          if (result.matched) autoCount++
          else if (result.ambiguous) ambiguousCount++
          result.ruleIds.forEach(function (id) {
            if (!counts[id]) return
            if (result.matched) counts[id].assignCount++
            else if (result.ambiguous) counts[id].ambiguousCount++
          })
        })
      }
      rules = rules.map(function (rule) {
        var account = items.filter(function (item) { return item.id === rule.accountId })[0]
        var assignCount = counts[rule.id].assignCount
        var ambiguousCount = counts[rule.id].ambiguousCount
        return Object.assign({}, rule, {
          accountName: account ? account.name : '账户已删除',
          accountMissing: !account,
          assignCount: assignCount,
          ambiguousCount: ambiguousCount,
          impactText: !account ? '请删除或重新配置' : (rule.enabled ? '将关联 ' + assignCount + ' 笔' : '已停用'),
          ambiguityText: ambiguousCount ? '，待确认 ' + ambiguousCount + ' 笔' : ''
        })
      })
      this.setData({
        mappingRules: rules,
        mappingError: '',
        mappingAutoCount: autoCount,
        mappingAmbiguousCount: ambiguousCount
      })
      this.updateMappingPreview(items)
    } catch (e) {
      this.setData({
        mappingRules: [],
        mappingError: e.message || '映射规则读取失败，请重试',
        mappingAutoCount: 0,
        mappingAmbiguousCount: 0
      })
    }
  },

  refresh: function () {
    if (this._unloaded) return
    var items
    try {
      items = accounts.list()
    } catch (e) {
      this.setData({ accounts: [], accountCount: 0, includedCount: 0, netWorthReady: false, netWorthText: '--', error: '账户读取失败，请重试' })
      this.updateMappingView([], [])
      return
    }
    var txs = this.readTxs()
    this.updateMappingView(items, txs || [])
    var historyError = ''
    var rows = items.map(function (item) {
      var history = []
      try { history = rateHistoryText(item) } catch (e) { historyError = '汇率记录读取失败，请重试' }
      return {
        id: item.id,
        name: item.name,
        initial: String(item.name).slice(0, 1),
        type: item.type,
        typeLabel: accounts.TYPE_LABELS[item.type] || '账户',
        currency: item.currency,
        currencyName: currency.CURRENCIES[item.currency].name,
        rateText: currency.formatRate(item.rateToCny, item.currency),
        rateHistory: history,
        openingBalanceText: currency.formatNative(centsOf(item.openingBalance), item.currency),
        includeInNetWorth: item.includeInNetWorth,
        balanceText: '--',
        negative: false
      }
    })
    var included = items.filter(function (item) { return item.includeInNetWorth }).length
    var base = {
      accounts: rows,
      accountCount: items.length,
      includedCount: included,
      netWorthReady: false,
      netWorthNegative: false,
      netWorthText: '--',
      error: historyError || accounts.error() || ''
    }
    if (txs === null) {
      this.setData(base)
      return
    }
    try {
      var values = accounts.balances(txs)
      var worth = accounts.netWorth(txs)
      rows.forEach(function (row) {
        var value = values[row.id] || 0
        var account = items.filter(function (item) { return item.id === row.id })[0]
        row.balanceText = currency.formatNative(value, account.currency)
        row.negative = value < 0
      })
      base.netWorthReady = true
      base.netWorthText = moneyText(worth)
      base.netWorthNegative = worth < 0
      base.error = accounts.error() || base.error
      this.setData(base)
    } catch (e) {
      base.error = '余额计算失败，请核对账户和流水数据'
      this.setData(base)
    }
  },

  openCreate: function () {
    if (this.data.busy) return
    this.setData({
      formVisible: true,
      editingId: '',
      formTitle: '新增账户',
      formError: '',
      form: { name: '', type: 'cash', openingBalance: '0.00', currency: 'CNY', rateToCny: '1', includeInNetWorth: true },
      formCurrencyIndex: 0,
      formCurrencySymbol: '¥',
      formCurrencyName: '人民币',
      formRateHint: currency.formatRate(1, 'CNY')
    })
  },

  openEdit: function (e) {
    if (this.data.busy) return
    var id = e.currentTarget.dataset.id
    var item = accounts.get(id)
    if (!item) {
      this.notifyError(accounts.error() || '找不到这个账户，请刷新后重试')
      return
    }
    this.setData({
      formVisible: true,
      editingId: item.id,
      formTitle: '编辑账户',
      formError: '',
      form: {
        name: item.name,
        type: item.type,
        openingBalance: inputText(item.openingBalance),
        currency: item.currency,
        rateToCny: rateInput(item.rateToCny, item.currency),
        includeInNetWorth: item.includeInNetWorth
      },
      formCurrencyIndex: currency.CODES.indexOf(item.currency),
      formCurrencySymbol: currency.CURRENCIES[item.currency].symbol,
      formCurrencyName: currency.CURRENCIES[item.currency].name,
      formRateHint: currency.formatRate(item.rateToCny, item.currency)
    })
  },

  openRateAlerts: function (e) {
    var id = e.currentTarget.dataset.id
    if (id) wx.navigateTo({ url: '/pages/rate-alerts/rate-alerts?accountId=' + encodeURIComponent(id) })
  },

  closeForm: function () {
    if (this.data.busy) return
    this.setData({ formVisible: false, formError: '' })
  },

  inputName: function (e) {
    this.setData({ formError: '', form: Object.assign({}, this.data.form, { name: e.detail.value }) })
  },

  inputOpening: function (e) {
    this.setData({ formError: '', form: Object.assign({}, this.data.form, { openingBalance: e.detail.value }) })
  },

  inputRate: function (e) {
    var value = e.detail.value
    this.setData({
      formError: '',
      form: Object.assign({}, this.data.form, { rateToCny: value }),
      formRateHint: currency.formatRate(value, this.data.form.currency)
    })
  },

  pickCurrency: function (e) {
    var index = Number(e.detail.value) || 0
    var item = CURRENCY_OPTIONS[index]
    if (!item) return
    var rate = item.code === 'CNY' ? '1' : this.data.form.rateToCny
    if (item.code !== 'CNY' && currency.normalizeRate(rate, item.code) === null) rate = ''
    this.setData({
      formError: '',
      formCurrencyIndex: index,
      formCurrencySymbol: currency.CURRENCIES[item.code].symbol,
      formCurrencyName: item.name,
      formRateHint: currency.formatRate(rate, item.code),
      form: Object.assign({}, this.data.form, { currency: item.code, rateToCny: rate })
    })
  },

  pickType: function (e) {
    var type = e.currentTarget.dataset.type
    if (!accounts.TYPE_LABELS[type]) return
    this.setData({ formError: '', form: Object.assign({}, this.data.form, { type: type }) })
  },

  toggleInclude: function (e) {
    this.setData({ formError: '', form: Object.assign({}, this.data.form, { includeInNetWorth: !!e.detail.value }) })
  },

  saveForm: function () {
    if (this.data.busy) return
    var form = this.data.form
    var payload = {
      name: form.name,
      type: form.type,
      openingBalance: form.openingBalance,
      currency: form.currency,
      rateToCny: form.rateToCny,
      includeInNetWorth: !!form.includeInNetWorth
    }
    if (this.data.editingId) payload.id = this.data.editingId
    this.setData({ busy: true, formError: '' })
    var saved = null
    try { saved = accounts.save(payload) } catch (e) {}
    if (!saved) {
      var message = accounts.error() || '账户保存失败，请重试'
      this.setData({ busy: false, formError: message })
      wx.showToast({ title: message, icon: 'none' })
      return
    }
    this.setData({ busy: false, formVisible: false, formError: '' })
    this.refresh()
    wx.showToast({ title: this.data.editingId ? '账户已更新' : '账户已新增', icon: 'success' })
  },

  deleteAccount: function (e) {
    if (this.data.busy) return
    var self = this
    var id = e.currentTarget.dataset.id
    var item = accounts.get(id)
    if (!item) {
      this.notifyError(accounts.error() || '找不到这个账户，请刷新后重试')
      return
    }
    var txs = this.readTxs()
    if (txs === null) return
    var count
    try { count = accounts.relatedCount(id, txs) } catch (e) {
      this.notifyError('无法核对关联流水，未删除账户')
      return
    }
    if (count > 0) {
      wx.showModal({
        title: '账户有关联流水',
        content: '「' + item.name + '」关联 ' + count + ' 笔流水。为保护账目，请先处理这些流水，再删除账户。',
        showCancel: false,
        confirmText: '知道了',
        fail: function () { self.notifyError('无法显示删除提示，未删除账户') }
      })
      return
    }
    var ruleCount = 0
    try { ruleCount = accountMap.list().filter(function (rule) { return rule.accountId === id }).length } catch (e) {}
    wx.showModal({
      title: '删除账户？',
      content: '将删除「' + item.name + '」' + (ruleCount ? '，并清理 ' + ruleCount + ' 条映射规则' : '') + '及其汇率历史。此操作不会删除任何流水。',
      confirmText: '删除',
      confirmColor: '#c44b4b',
      success: function (res) {
        if (res.confirm) self.confirmDelete(id, txs)
      },
      fail: function () { self.notifyError('删除未确认，账户仍保留') }
    })
  },

  confirmDelete: function (id, txs) {
    if (this.data.busy) return
    this.setData({ busy: true })
    var removed = false
    try { removed = accounts.remove(id, txs) } catch (e) {}
    if (!removed) {
      this.setData({ busy: false })
      this.notifyError(accounts.error() || '账户删除失败，请重试')
      return
    }
    this.setData({ busy: false })
    this.refresh()
    wx.showToast({ title: '账户已删除', icon: 'success' })
  },

  inputMappingKeyword: function (e) {
    if (this.data.mappingBusy || this.data.mappingApplyBusy) return
    this.setData({ mappingKeyword: String(e.detail.value || ''), mappingFormError: '' })
    this.updateMappingPreview()
  },

  pickMappingAccount: function (e) {
    if (this.data.mappingBusy || this.data.mappingApplyBusy) return
    var index = Number(e.detail.value)
    var item = this.data.accounts[index]
    if (!item) return
    this.setData({ mappingAccountIndex: index, mappingAccountId: item.id, mappingFormError: '' })
  },

  updateMappingPreview: function (items) {
    if (this._unloaded || this.data.mappingError) return
    var text = String(this.data.mappingPreviewText || '')
    if (!text.trim()) {
      this.setData({ mappingPreviewResult: '', mappingPreviewError: '' })
      return
    }
    try {
      var result = accountMap.match(text, items || this.data.accounts)
      this.setData({ mappingPreviewResult: previewText(result), mappingPreviewError: '' })
    } catch (e) {
      this.setData({ mappingPreviewResult: '', mappingPreviewError: e.message || '预览失败，请重试' })
    }
  },

  inputMappingPreview: function (e) {
    if (this.data.mappingApplyBusy) return
    this.setData({ mappingPreviewText: String(e.detail.value || '') })
    this.updateMappingPreview()
  },

  saveMappingRule: function () {
    if (this.data.busy || this.data.mappingBusy || this.data.mappingApplyBusy) return
    var accountId = this.data.mappingAccountId
    if (!accountId || !this.data.accounts.some(function (item) { return item.id === accountId })) {
      this.setData({ mappingAccountId: '', mappingFormError: '请选择关联账户' })
      return
    }
    this.setData({ mappingBusy: true, mappingFormError: '' })
    var saved = null
    try { saved = accountMap.save({ keyword: this.data.mappingKeyword, accountId: accountId }, this.data.accounts) } catch (e) {}
    if (!saved) {
      var message = accountMap.error() || '映射规则保存失败，请重试'
      this.setData({ mappingBusy: false, mappingFormError: message })
      wx.showToast({ title: message, icon: 'none' })
      return
    }
    this.setData({ mappingBusy: false, mappingKeyword: '', mappingFormError: '' })
    this.refresh()
    wx.showToast({ title: '映射规则已新增', icon: 'success' })
  },

  toggleMappingRule: function (e) {
    if (this.data.busy || this.data.mappingBusy || this.data.mappingApplyBusy) return
    var id = e.currentTarget.dataset.id
    var enabled = !!e.detail.value
    var rule
    try { rule = accountMap.list().filter(function (item) { return item.id === id })[0] } catch (err) {
      this.notifyError(err.message || '映射规则读取失败，请重试')
      return
    }
    if (!rule) { this.notifyError('找不到这条映射规则，请刷新后重试'); return }
    if (enabled && !this.data.accounts.some(function (item) { return item.id === rule.accountId })) {
      this.notifyError('关联账户已不存在，请删除这条规则')
      return
    }
    this.setData({ mappingBusy: true })
    var saved = null
    try { saved = accountMap.toggle(id, enabled) } catch (e) {}
    if (!saved) {
      this.setData({ mappingBusy: false })
      this.notifyError(accountMap.error() || '规则状态切换失败，请重试')
      return
    }
    this.setData({ mappingBusy: false })
    this.refresh()
    wx.showToast({ title: enabled ? '规则已启用' : '规则已停用', icon: 'success' })
  },

  deleteMappingRule: function (e) {
    if (this.data.busy || this.data.mappingBusy || this.data.mappingApplyBusy) return
    var self = this
    var id = e.currentTarget.dataset.id
    var rule
    try { rule = accountMap.list().filter(function (item) { return item.id === id })[0] } catch (err) {
      self.notifyError(err.message || '映射规则读取失败，请重试')
      return
    }
    if (!rule) { this.notifyError('找不到这条映射规则，请刷新后重试'); return }
    wx.showModal({
      title: '删除映射规则？',
      content: '删除“' + rule.keyword + '”？已有流水的 accountId 不会被修改或删除。',
      confirmText: '删除',
      confirmColor: '#c44b4b',
      success: function (res) {
        if (!res.confirm || self._unloaded) return
        self.setData({ mappingBusy: true })
        var removed = false
        try { removed = accountMap.remove(id) } catch (err) {}
        if (!removed) {
          self.setData({ mappingBusy: false })
          self.notifyError(accountMap.error() || '规则删除失败，请重试')
          return
        }
        self.setData({ mappingBusy: false })
        self.refresh()
        wx.showToast({ title: '映射规则已删除', icon: 'success' })
      },
      fail: function () { self.notifyError('删除未确认，规则仍保留') }
    })
  },

  applyMappings: function () {
    if (this.data.busy || this.data.mappingBusy || this.data.mappingApplyBusy || this.data.mappingError) return
    var self = this
    var txs = this.readTxs()
    if (txs === null) return
    var items = accounts.list()
    if (accounts.error()) { this.notifyError(accounts.error()); return }
    var automatic = []
    var ambiguous = []
    try {
      txs.forEach(function (tx) {
        if (!tx || !store.canEdit(tx) || accountMap.hasAccountId(tx)) return
        var result = accountMap.match(tx.account, items)
        if (result.matched) automatic.push({ tx: tx, accountId: result.accountId })
        else if (result.ambiguous) ambiguous.push({ tx: tx, candidates: result.candidates })
      })
    } catch (e) {
      this.notifyError(e.message || '映射规则读取失败，流水未修改')
      return
    }
    if (!automatic.length && !ambiguous.length) {
      wx.showToast({ title: '没有可关联的未指定流水', icon: 'none' })
      return
    }
    wx.showModal({
      title: '应用到未指定流水',
      content: '将自动关联 ' + automatic.length + ' 笔；另有 ' + ambiguous.length + ' 笔命中多个账户，需逐笔确认。已有 accountId 的流水不会覆盖。',
      confirmText: '开始应用',
      success: function (res) {
        if (!res.confirm || self._unloaded) return
        self.startMappingBatch({ automatic: automatic, ambiguous: ambiguous, index: 0, applied: 0, failed: 0, skipped: 0, errors: [] })
      },
      fail: function () { self.notifyError('应用未确认，流水未修改') }
    })
  },

  startMappingBatch: function (batch) {
    this._mappingBatch = batch
    this.setData({ mappingApplyBusy: true, mappingConfirmed: null, mappingProgress: '正在关联…' })
    this.processMappingBatch()
  },

  processMappingBatch: function () {
    var batch = this._mappingBatch
    if (!batch || this._unloaded) return
    if (batch.index < batch.automatic.length) {
      var result = null
      try {
        result = store.assignAccounts(batch.automatic.map(function (entry) {
          return { id: entry.tx.id, accountId: entry.accountId }
        }))
      } catch (e) {}
      if (!result || !result.saved) {
        batch.failed += batch.automatic.length
        batch.errors.push('自动关联批量保存失败，流水未修改')
      } else {
        batch.applied += result.updated
        batch.skipped += result.skipped
      }
      batch.index = batch.automatic.length
    }
    if (batch.ambiguous.length) {
      var pending = batch.ambiguous.shift()
      batch.pending = pending
      this.setData({
        mappingConfirmed: {
          txText: txText(pending.tx),
          candidates: pending.candidates
        },
        mappingProgress: '待逐笔确认 ' + (batch.ambiguous.length + 1) + ' 笔'
      })
      return
    }
    this.finishMappingBatch()
  },

  commitMappedTx: function (tx, accountId) {
    var batch = this._mappingBatch
    var current = store.all().filter(function (item) { return item.id === tx.id })[0]
    if (!current || accountMap.hasAccountId(current)) { batch.skipped++; return false }
    if (!this.data.accounts.some(function (item) { return item.id === accountId })) {
      batch.failed++
      batch.errors.push(txText(tx) + '：账户已不存在')
      return false
    }
    var updated = null
    try { updated = store.update(tx.id, { accountId: accountId }) } catch (e) {}
    var verified = store.all().filter(function (item) { return item.id === tx.id })[0]
    if (!updated || !verified || verified.accountId !== accountId) {
      batch.failed++
      batch.errors.push(txText(tx) + '：保存失败')
      return false
    }
    batch.applied++
    return true
  },

  confirmMappedAccount: function (e) {
    if (!this.data.mappingApplyBusy || !this.data.mappingConfirmed) return
    var batch = this._mappingBatch
    var accountId = String(e.currentTarget.dataset.accountId || '')
    var pending = batch.pending
    var allowed = pending && pending.candidates.some(function (item) { return item.accountId === accountId })
    if (!allowed) return
    this.commitMappedTx(pending.tx, accountId)
    batch.pending = null
    this.setData({ mappingConfirmed: null })
    this.processMappingBatch()
  },

  skipMappedTx: function () {
    if (!this.data.mappingApplyBusy || !this.data.mappingConfirmed) return
    var batch = this._mappingBatch
    batch.skipped++
    batch.pending = null
    this.setData({ mappingConfirmed: null })
    this.processMappingBatch()
  },

  finishMappingBatch: function () {
    var batch = this._mappingBatch
    this._mappingBatch = null
    this.setData({ mappingApplyBusy: false, mappingConfirmed: null, mappingProgress: '' })
    this.refresh()
    var title = batch.failed ? '关联未全部完成' : '关联完成'
    var content = '已关联 ' + batch.applied + ' 笔，跳过 ' + batch.skipped + ' 笔，失败 ' + batch.failed + ' 笔。'
    if (batch.errors.length) content += '\n' + batch.errors.slice(0, 3).join('\n')
    wx.showModal({ title: title, content: content, showCancel: false })
    if (!batch.failed) wx.showToast({ title: '已关联 ' + batch.applied + ' 笔', icon: 'success' })
  },

  seedExamples: function () {
    if (this.data.busy || this.data.mappingBusy || this.data.mappingApplyBusy || this.data.accountCount || this.data.error) return
    this.setData({ busy: true })
    var created = null
    try { created = accounts.seedDefaults() } catch (e) {}
    if (!created) {
      this.setData({ busy: false })
      this.notifyError(accounts.error() || '示例账户建立失败，请重试')
      return
    }
    this.setData({ busy: false })
    this.refresh()
    wx.showToast({ title: '已建立 4 个示例账户', icon: 'success' })
  }
})
