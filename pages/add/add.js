var darkmode = require('../../utils/darkmode')
var format = require('../../utils/format')
var store = require('../../utils/store')
var category = require('../../utils/category')

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
    suggestions: []
  },

  onLoad: function () {
    var today = format.dayOf(Date.now())
    this.setData({ date: today, today: today })
    this._merchants = knownMerchants()
  },

  switchType: function (e) {
    var t = e.currentTarget.dataset.t
    var cats = withIcons(category.catsOf(t))
    this.setData({ type: t, cats: cats, cat: cats[0].name })
  },

  onAmount: function (e) {
    this.setData({ amount: e.detail.value })
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
    var amountText = String(this.data.amount || '').trim()
    var amount = Math.round(Number(amountText) * 100) / 100
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(amountText) || !isFinite(amount) || amount <= 0) {
      wx.showToast({ title: '请填有效正金额，按分取整后不能为 0', icon: 'none' })
      return
    }

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

    var rnd = String(Math.floor(Math.random() * 1000000))
    while (rnd.length < 6) rnd = '0' + rnd
    var tx = {
      /* 手记 id：毫秒时间戳 + 6 位随机，避免同一秒连记两笔时 4 位随机碰撞 */
      id: 'm' + Date.now() + rnd,
      time: ts,
      day: format.dayOf(ts),
      ym: format.ymOf(ts),
      amount: amount,
      type: type,
      merchant: merchant,
      desc: this.data.note,
      category: cat,
      account: '手记',
      status: '手动',
      source: '手记',
      byPlatform: 'manual',
      note: this.data.note
    }

    var res = store.addOne(tx)
    if (!res || res.saved !== true || res.partial) {
      wx.showModal({
        title: '没能保存',
        content: res && res.partial
          ? '本次未能完整保存，可能已有部分写入且回滚未完成。输入已保留，请先核对实际账本、导出备份，再决定是否重试。'
          : '本次未保存，输入已保留。可以重试，或先去「报表 → 数据工具」导出备份。',
        showCancel: false
      })
      return
    }
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
    setTimeout(function () {
      wx.navigateBack()
    }, 500)
  }
})
