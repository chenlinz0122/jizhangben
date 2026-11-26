var darkmode = require('../../utils/darkmode')
var format = require('../../utils/format')
var store = require('../../utils/store')
var category = require('../../utils/category')
var accounts = require('../../utils/accounts')
var currency = require('../../utils/currency')

var CURRENCY_OPTIONS = currency.CODES.map(function (code) {
  return { code: code, name: currency.CURRENCIES[code].name, label: code + ' · ' + currency.CURRENCIES[code].name }
})

function amountCents(text) {
  var value = String(text || '').trim()
  if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(value)) return null
  var cents = Math.round(Number(value) * 100)
  return isFinite(cents) && cents > 0 && cents <= 9007199254740991 ? cents : null
}

function accountById(list, id) {
  return list.filter(function (item) { return item.id === id })[0] || null
}

function withIcons(names) {
  return names.map(function (n) { return { name: n, icon: category.iconOf(n) } })
}

/* 历史商户 + 规则里记过的商户，按出现次数排，供输入时补全 */
function knownMerchants() {
  var map = {}
  store.all().forEach(function (t) {
    var m = String(t.merchant || '').trim()
    if (m && m.length >= 2) map[m] = (map[m] || 0) + 1
  })
  Object.keys(store.rules()).forEach(function (k) {
    if (!map[k]) map[k] = 0
  })
  return Object.keys(map).sort(function (a, b) { return map[b] - map[a] })
}

var theme = require('../../utils/theme')

Page({
  onShow: function () {
    this.setData({ themeKey: theme.get().key, dark: darkmode.isDark() })
    this.loadAccounts()
  },
  data: {
    dark: false,
    themeKey: 'green',
    type: 'expense',
    cats: withIcons(category.catsOf('expense')),
    cat: '餐饮',
    amount: '',
    merchant: '',
    note: '',
    date: '',
    today: '',
    suggestions: [],
    accounts: [],
    currencyOptions: CURRENCY_OPTIONS,
    manualCurrency: 'CNY',
    manualCurrencyIndex: 0,
    manualRate: '1',
    selectedCurrency: 'CNY',
    selectedSymbol: '¥',
    selectedRate: 1,
    selectedRateText: '人民币固定汇率 1',
    selectedForeign: false,
    amountPreview: '',
    toManualCurrency: 'CNY',
    toManualCurrencyIndex: 0,
    toManualRate: '1',
    toCurrency: 'CNY',
    toSymbol: '¥',
    toRate: 1,
    toRateText: '人民币固定汇率 1',
    toForeign: false,
    transferPreview: '',
    accountNames: [{ id: '', name: '未指定账户' }],
    accountId: '',
    accountIndex: 0,
    fromAccountId: '',
    fromAccountIndex: 0,
    toAccountId: '',
    toAccountIndex: 0,
    saveState: ''
  },

  onLoad: function () {
    var today = format.dayOf(Date.now())
    this.setData({ date: today, today: today })
    this._merchants = knownMerchants()
    this.loadAccounts()
  },

  loadAccounts: function () {
    var list = accounts.list()
    var names = [{ id: '', name: '未指定账户' }].concat(list.map(function (item) {
      return { id: item.id, name: item.name }
    }))
    function indexOf(id) {
      for (var i = 0; i < names.length; i++) if (names[i].id === id) return i
      return 0
    }
    this.setData({
      accounts: list,
      accountNames: names,
      accountIndex: indexOf(this.data.accountId),
      fromAccountIndex: indexOf(this.data.fromAccountId),
      toAccountIndex: indexOf(this.data.toAccountId)
    })
    this.syncCurrency()
  },

  currencyState: function (account, manualCode, manualRate) {
    var code = account ? account.currency : currency.normalizeCode(manualCode)
    var rate = account ? account.rateToCny : currency.normalizeRate(manualRate, code)
    return {
      code: code,
      symbol: currency.CURRENCIES[code].symbol,
      rate: rate === null ? null : rate,
      rateText: currency.formatRate(rate, code),
      foreign: code !== 'CNY'
    }
  },

  syncCurrency: function () {
    var transfer = this.data.type === 'transfer'
    var sourceId = transfer ? this.data.fromAccountId : this.data.accountId
    var source = this.currencyState(
      accountById(this.data.accounts, sourceId), this.data.manualCurrency, this.data.manualRate
    )
    var target = this.currencyState(
      accountById(this.data.accounts, this.data.toAccountId), this.data.toManualCurrency, this.data.toManualRate
    )
    this.setData({
      selectedCurrency: source.code,
      selectedSymbol: source.symbol,
      selectedRate: source.rate,
      selectedRateText: source.rateText,
      selectedForeign: source.foreign,
      toCurrency: target.code,
      toSymbol: target.symbol,
      toRate: target.rate,
      toRateText: target.rateText,
      toForeign: target.foreign
    })
    this.updateAmountPreviews()
  },

  updateAmountPreviews: function () {
    var native = amountCents(this.data.amount)
    var cny = native === null || this.data.selectedRate === null ? null : currency.convert(native, this.data.selectedRate, 1)
    var preview = cny === null ? '' : (cny > 0 && this.data.selectedForeign ? '约合 ' + currency.formatNative(cny, 'CNY') : '')
    var transferPreview = ''
    if (this.data.type === 'transfer' && native !== null && this.data.selectedRate && this.data.toRate) {
      var target = currency.convert(native, this.data.selectedRate, this.data.toRate)
      if (target !== null && target > 0 && (this.data.toCurrency !== this.data.selectedCurrency || this.data.toRate !== this.data.selectedRate)) {
        transferPreview = '转入约 ' + currency.formatNative(target, this.data.toCurrency)
      }
    }
    this.setData({ amountPreview: preview, transferPreview: transferPreview })
  },

  onAccount: function (e) {
    var idx = Number(e.detail.value) || 0
    this.setData({ accountIndex: idx, accountId: this.data.accountNames[idx].id })
    this.syncCurrency()
  },

  onFromAccount: function (e) {
    var idx = Number(e.detail.value) || 0
    this.setData({ fromAccountIndex: idx, fromAccountId: this.data.accountNames[idx].id })
    this.syncCurrency()
  },

  onToAccount: function (e) {
    var idx = Number(e.detail.value) || 0
    this.setData({ toAccountIndex: idx, toAccountId: this.data.accountNames[idx].id })
    this.syncCurrency()
  },

  onManualCurrency: function (e) {
    var index = Number(e.detail.value) || 0
    var code = CURRENCY_OPTIONS[index].code
    var rate = code === 'CNY' ? '1' : (this.data.manualCurrency === code ? this.data.manualRate : '')
    this.setData({ manualCurrencyIndex: index, manualCurrency: code, manualRate: rate })
    this.syncCurrency()
  },

  onManualRate: function (e) {
    this.setData({ manualRate: e.detail.value })
    this.syncCurrency()
  },

  onToManualCurrency: function (e) {
    var index = Number(e.detail.value) || 0
    var code = CURRENCY_OPTIONS[index].code
    var rate = code === 'CNY' ? '1' : (this.data.toManualCurrency === code ? this.data.toManualRate : '')
    this.setData({ toManualCurrencyIndex: index, toManualCurrency: code, toManualRate: rate })
    this.syncCurrency()
  },

  onToManualRate: function (e) {
    this.setData({ toManualRate: e.detail.value })
    this.syncCurrency()
  },

  onUnload: function () {
    if (this._backTimer) clearTimeout(this._backTimer)
  },

  switchType: function (e) {
    var t = e.currentTarget.dataset.t
    var cats = withIcons(category.catsOf(t))
    this.setData({ type: t, cats: cats, cat: cats[0].name })
    this.syncCurrency()
  },

  onAmount: function (e) {
    this.setData({ amount: e.detail.value })
    this.updateAmountPreviews()
  },

  onMerchant: function (e) {
    var kw = e.detail.value.trim()
    var sugs = []
    if (kw && this._merchants) {
      var low = kw.toLowerCase()
      sugs = this._merchants.filter(function (m) {
        return m.toLowerCase().indexOf(low) >= 0
      }).slice(0, 6)
    }
    this.setData({ merchant: e.detail.value, suggestions: sugs })
  },

  pickSuggestion: function (e) {
    var m = e.currentTarget.dataset.m
    this.setData({ merchant: m, suggestions: [] })
  },

  onNote: function (e) {
    this.setData({ note: e.detail.value })
  },

  onDate: function (e) {
    this.setData({ date: e.detail.value })
  },

  pickCat: function (e) {
    this.setData({ cat: e.currentTarget.dataset.cat })
  },

  save: function () {
    if (this._saving) return
    var nativeCents = amountCents(this.data.amount)
    if (nativeCents === null) {
      wx.showToast({ title: '请填有效正金额，最多两位小数且不能为 0', icon: 'none' })
      return
    }
    var isTransfer = this.data.type === 'transfer'
    var sourceAccount = accountById(this.data.accounts, isTransfer ? this.data.fromAccountId : this.data.accountId)
    var targetAccount = isTransfer ? accountById(this.data.accounts, this.data.toAccountId) : null
    var source = this.currencyState(sourceAccount, this.data.manualCurrency, this.data.manualRate)
    if (source.rate === null) {
      wx.showToast({ title: '请填写大于 0 的有效汇率', icon: 'none' })
      return
    }
    var cnyCents = currency.convert(nativeCents, source.rate, 1)
    if (cnyCents === null || cnyCents <= 0) {
      wx.showToast({ title: '换算后人民币金额不足 0.01 元', icon: 'none' })
      return
    }
    var target = null
    var targetCents = null
    if (isTransfer) {
      target = this.currencyState(targetAccount, this.data.toManualCurrency, this.data.toManualRate)
      if (target.rate === null) {
        wx.showToast({ title: '请填写转入币种的有效汇率', icon: 'none' })
        return
      }
      targetCents = currency.convert(nativeCents, source.rate, target.rate)
      if (targetCents === null || targetCents <= 0) {
        wx.showToast({ title: '换算后转入金额不足 0.01', icon: 'none' })
        return
      }
    }
    var amount = cnyCents / 100

    var date = String(this.data.date || '')
    var parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
    var d = new Date(0)
    if (parts) {
      d.setFullYear(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
      d.setHours(12, 0, 0, 0)
    }
    if (!parts || Number(parts[1]) < 1 ||
        d.getFullYear() !== Number(parts[1]) || d.getMonth() + 1 !== Number(parts[2]) ||
        d.getDate() !== Number(parts[3]) || date > format.dayOf(Date.now())) {
      wx.showToast({ title: '请选择有效日期，不能晚于今天', icon: 'none' })
      return
    }
    var ts = d.getTime()
    var type = this.data.type
    var cat = this.data.cat
    var merchant = this.data.merchant || this.data.note || '(手记)'
    if (type === 'transfer' && this.data.fromAccountId && this.data.fromAccountId === this.data.toAccountId) {
      wx.showToast({ title: '转出和转入账户不能相同', icon: 'none' })
      return
    }

    var rnd = String(Math.floor(Math.random() * 1000000))
    while (rnd.length < 6) rnd = '0' + rnd
    var tx = {
      /* 手记 id：毫秒时间戳 + 6 位随机，避免同一秒连记两笔时 4 位随机碰撞 */
      id: 'm' + Date.now() + rnd,
      time: ts,
      day: format.dayOf(ts),
      ym: format.ymOf(ts),
      amount: amount,
      nativeAmount: nativeCents / 100,
      currency: source.code,
      rateToCny: source.rate,
      type: type,
      merchant: merchant,
      desc: this.data.note,
      category: cat,
      accountId: type === 'transfer' ? '' : this.data.accountId,
      fromAccountId: type === 'transfer' ? this.data.fromAccountId : '',
      toAccountId: type === 'transfer' ? this.data.toAccountId : '',
      toNativeAmount: isTransfer ? targetCents / 100 : undefined,
      toCurrency: isTransfer ? target.code : undefined,
      toRateToCny: isTransfer ? target.rate : undefined,
      account: '手记',
      status: '手动',
      source: '手记',
      byPlatform: 'manual',
      note: this.data.note
    }

    this._saving = true
    this.setData({ saveState: 'saving' })
    var res
    try {
      res = store.addOne(tx)
    } catch (e) {
      res = null
    }
    if (!res || res.saved !== true || res.partial) {
      this._saving = false
      this.setData({ saveState: '' })
      wx.showModal({
        title: '没能保存',
        content: res && res.partial
          ? '本次未能完整保存，可能已有部分写入且回滚未完成。输入已保留，请先核对实际账本、导出备份，再决定是否重试。'
          : '本次未保存，输入已保留。可以重试，或先去「报表 → 数据工具」导出备份。',
        showCancel: false
      })
      return
    }
    this.setData({ saveState: 'saved' })
    if (type !== 'transfer' && this.data.merchant && store.learn(this.data.merchant, cat) === false) {
      wx.showModal({
        title: '流水已保存',
        content: '这笔流水已保存，但分类规则未保存，无需再记一次。稍后可在流水页修改分类来学习规则。',
        showCancel: false,
        success: function () { wx.navigateBack() }
      })
      return
    }

    wx.showToast({ title: '已记上', icon: 'success' })
    var self = this
    this._backTimer = setTimeout(function () {
      self._backTimer = null
      wx.navigateBack()
    }, 500)
  }
})
