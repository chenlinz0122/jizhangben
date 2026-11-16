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

Page({
  data: {
    type: 'expense',
    cats: withIcons(category.catsOf('expense')),
    cat: '餐饮',
    amount: '',
    merchant: '',
    note: '',
    date: '',
    today: '',
    minDate: '',
    suggestions: []
  },

  onLoad: function () {
    var today = format.dayOf(Date.now())
    /* 账本只留最近一年，日期选择器就不让人往前挑超过一年 */
    var d = new Date()
    d.setMonth(d.getMonth() - 12)
    this.setData({ date: today, today: today, minDate: format.dayOf(d.getTime()) })
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
    var amount = parseFloat(this.data.amount)
    if (!amount || amount <= 0) {
      wx.showToast({ title: '先填个金额', icon: 'none' })
      return
    }

    var parts = this.data.date.split('-')
    var ts = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), 12, 0, 0).getTime()
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
      amount: Math.round(amount * 100) / 100,
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
    if (res && res.kept === false) {
      wx.showModal({
        title: '这条没记上',
        content: '账本只保留最近一年，这条的日期超出范围，落库时被清掉了。换个一年内的日期再试。',
        showCancel: false
      })
      return
    }
    if (res && res.saved === false) {
      wx.showModal({
        title: '没能保存',
        content: '本地存储空间已满，这笔没有存进去。建议先导出备份，再清掉一些旧流水后重试。',
        showCancel: false
      })
      return
    }
    if (type !== 'transfer' && this.data.merchant) {
      store.learn(this.data.merchant, cat)
    }

    if (res && res.trimmed) {
      wx.showToast({ title: '已记上，清掉 ' + res.trimmed + ' 笔超一年旧流水', icon: 'none' })
    } else {
      wx.showToast({ title: '已记上', icon: 'success' })
    }
    setTimeout(function () {
      wx.navigateBack()
    }, 500)
  }
})
