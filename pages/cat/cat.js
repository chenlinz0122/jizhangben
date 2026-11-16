/* 分类明细：某一年的某个分类，全部明细按月分段，从上到下从新到旧
 * 入口：报表页「年度汇总」里点分类。查账单时最常问的是「这一类今年都花在哪了」，
 * 所以按月切段 + 每段带小计，比丢进流水页混在别的分类里看要直接。
 * kind = expense（支出）/ income（入账，含退款）。 */
var format = require('../../utils/format')
var store = require('../../utils/store')

var WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

Page({
  data: {
    cat: '',
    year: '',
    kind: 'expense',
    totalText: '0.00',
    count: 0,
    monthCount: 0,
    avgText: '0.00',
    maxText: '0.00',
    maxMerchant: '',
    months: []
  },

  onLoad: function (options) {
    var y = String((options && options.year) || '').slice(0, 4)
    if (!/^\d{4}$/.test(y)) y = format.ymOf(Date.now()).slice(0, 4)
    var c = (options && options.cat) || ''
    try {
      c = decodeURIComponent(c)
    } catch (e) {
      /* 参数没编码就原样用 */
    }
    var kind = options && options.kind === 'income' ? 'income' : 'expense'
    this.setData({ year: y, cat: c, kind: kind })
    wx.setNavigationBarTitle({ title: c ? c + ' · ' + y : '分类明细' })
  },

  /* 放在 onShow 里建：从这一页出去改了流水再回来，数字要是新的 */
  onShow: function () {
    if (this.data.cat) this.build()
  },

  build: function () {
    var year = this.data.year
    var cat = this.data.cat
    var income = this.data.kind === 'income'
    var txs = store.all()

    var list = []
    for (var i = 0; i < txs.length; i++) {
      var t = txs[i]
      /* 入账口径 = 收入 + 退款（退款本身就是一个类目） */
      if (income ? !(t.type === 'income' || t.type === 'refund') : t.type !== 'expense') continue
      if (t.category !== cat) continue
      if (String(t.ym || '').indexOf(year) !== 0) continue
      list.push(t)
    }
    /* 从新到旧；按月切段时先出现的自然就是最近的月份 */
    list.sort(function (a, b) { return b.time - a.time })

    var total = 0
    var maxTx = null
    var map = {}
    var order = []

    for (var j = 0; j < list.length; j++) {
      var x = list[j]
      var ym = x.ym
      total += x.amount
      if (!maxTx || x.amount > maxTx.amount) maxTx = x

      var g = map[ym]
      if (!g) {
        g = {
          ym: ym,
          label: parseInt(ym.slice(5, 7), 10) + ' 月',
          total: 0,
          count: 0,
          items: []
        }
        map[ym] = g
        order.push(ym)
      }

      var d = new Date(x.time)
      g.total += x.amount
      g.count++
      g.items.push({
        id: x.id,
        merchant: x.merchant || '（没有商户名）',
        desc: String(x.desc || x.note || '').trim(),
        dayText: parseInt(x.day.slice(8), 10) + ' 日',
        weekText: WEEK[d.getDay()],
        timeText: format.pad(d.getHours()) + ':' + format.pad(d.getMinutes()),
        amountText: format.money(x.amount),
        sign: income ? '+' : '-'
      })
    }

    var months = order.map(function (ym) {
      var g2 = map[ym]
      return {
        ym: ym,
        label: g2.label,
        totalText: format.money(g2.total),
        count: g2.count,
        items: g2.items
      }
    })

    this.setData({
      totalText: format.money(total),
      count: list.length,
      monthCount: months.length,
      avgText: months.length ? format.money(total / months.length) : '0.00',
      maxText: maxTx ? format.money(maxTx.amount) : '0.00',
      maxMerchant: maxTx ? (maxTx.merchant || '') : '',
      months: months
    })
  }
})
