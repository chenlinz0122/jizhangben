var format = require('../../utils/format')
var store = require('../../utils/store')
var stats = require('../../utils/stats')
var category = require('../../utils/category')

/* 按类型排个名：支出看花得最多，入账看进得最多 */
function topBy(txs, ym, kind, n) {
  var map = {}
  for (var i = 0; i < txs.length; i++) {
    var t = txs[i]
    if (t.ym !== ym) continue
    var hit = kind === 'income'
      ? (t.type === 'income' || t.type === 'refund')
      : (t.type === 'expense')
    if (!hit) continue
    var key = String(t.merchant || '未知').trim()
    if (!map[key]) map[key] = { name: key, amount: 0, count: 0, cat: '' }
    map[key].amount += t.amount
    map[key].count++
    map[key].cat = t.category
  }
  var list = Object.keys(map).map(function (k) { return map[k] })
  list.sort(function (a, b) { return b.amount - a.amount })
  var top = list.slice(0, n || 6)
  for (var j = 0; j < top.length; j++) {
    top[j].amountText = format.money(top[j].amount)
    top[j].icon = category.iconOf(top[j].cat)
  }
  return top
}

Page({
  data: {
    ym: '',
    monthText: '',
    canNext: false,
    hasData: false,
    isCurMonth: true,
    tab: 'expense',

    s: {
      expenseText: '0.00',
      incomeText: '0.00',
      netText: '0.00',
      netSign: '',
      count: 0,
      refundText: '0.00',
      transferText: '0.00',
      investText: '0.00',
      loanText: '0.00',
      acctText: '0.00'
    },

    /* 洞察 */
    avgDailyText: '0.00',
    maxMerchant: '',
    maxAmountText: '0.00',
    weekdayText: '0.00',
    weekendText: '0.00',
    spentDays: 0,

    /* 预算 */
    budget: 0,
    budgetText: '0.00',
    budgetSpentText: '0.00',
    budgetRefundText: '0.00',
    budgetLeftText: '0.00',
    budgetPct: 0,
    budgetOver: false,
    budgetPerDayText: '0.00',
    budgetRestDays: 0,
    catBudgetOpen: false,
    catBudgetList: [],

    /* 构成 */
    cats: [],
    catsOpen: false,
    catsHasMore: false,
    catsTotal: 0,

    /* 每日 / 月度 */
    daily: { list: [], tipText: '', tipLeft: 50, show: false, x1: '', x2: '', x3: '', x4: '' },
    /* 每日柱的缩放档位：1× 整月铺满，2×/3× 柱子加宽 + 左右滑动 */
    dayZoom: 1,
    dColW: 0,
    dInW: 0,
    months: [],
    scrollToId: '',

    topList: [],

    year: null,
    yearCatsOpen: false,
    yearTab: 'expense',

    cells: [],
    selDayText: ''
  },

  onLoad: function () {
    this.setData({ ym: format.ymOf(Date.now()) })
  },

  onShow: function () {
    this.refresh()
  },

  refresh: function () {
    var self = this
    var ym = this.data.ym
    var kind = this.data.tab
    var txs = store.all()
    var s = stats.summary(txs, ym)
    var bs = stats.budgetSpent(txs, ym)
    var ins = stats.insights(txs, ym)
    var cmp = stats.compareCats(txs, ym)
    var cal = stats.calendar(txs, ym)
    var ys = stats.yearSummary(txs, ym.split('-')[0])
    /* 年度分类：支出 / 入账两个榜，默认只露前 3 类，展开看全年全部类目 */
    if (ys) {
      var yIncome = this.data.yearTab === 'income'
      var yAll = (yIncome ? ys.topAllIn : ys.topAll) || []
      var yOpen = this.data.yearCatsOpen
      ys.topTotal = yAll.length
      ys.topMore = yAll.length > 3
      ys.top = yOpen ? yAll : yAll.slice(0, 3)
      ys.moreLabel = yOpen ? '收起' : '展开全部 ' + yAll.length + ' 类'
      ys.topLabel = yIncome ? '入账最多的分类' : '支出最多的分类'
    }

    /* 支出分类带环比 + 分类预算 */
    var cb = store.catBudgets()
    var expCats = s.byCat.map(function (c) {
      var prev = cmp.amountOf(c.name)
      var deltaText = ''
      var deltaDir = ''
      if (prev <= 0) {
        deltaText = '新增'
      } else {
        var d = Math.round(((c.amount - prev) / prev) * 100)
        if (d === 0) { deltaText = '持平' } else {
          deltaText = (d > 0 ? '+' : '') + d + '%'
          deltaDir = d > 0 ? 'up' : 'down'
        }
      }
      var bud = cb[c.name] || 0
      /* 分类预算的「已花」要扣掉这个类目的退款，不能拿原价去比额度 */
      var netAmt = Math.max(Math.round((bs.byCat[c.name] || 0) * 100) / 100, 0)
      var backAmt = Math.max(Math.round((c.amount - netAmt) * 100) / 100, 0)
      return {
        name: c.name, amountText: c.amountText, pct: c.pct, count: c.count,
        color: c.color, icon: category.iconOf(c.name), tint: category.tintOf(c.name), deltaText: deltaText, deltaDir: deltaDir,
        budget: bud,
        budgetText: bud > 0 ? format.money(bud) : '',
        budgetSpentText: format.money(netAmt),
        budgetRefundText: backAmt > 0 ? format.money(backAmt) : '',
        budgetPct: bud > 0 ? Math.min(100, Math.round((netAmt / bud) * 100)) : 0,
        budgetOver: bud > 0 && netAmt > bud
      }
    })

    var incCats = s.byIncome.map(function (c) {
      return {
        name: c.name, amountText: c.amountText, pct: c.pct, count: c.count,
        color: c.color, icon: category.iconOf(c.name), tint: category.tintOf(c.name), deltaText: '', deltaDir: ''
      }
    })

    /* 当前 tab 的分类，默认 5 条 */
    var full = kind === 'income' ? incCats : expCats
    this._cats = full
    var n = this.data.catsOpen ? full.length : Math.min(full.length, 5)
    /* 每日对比 */
    var daily = this.buildDaily(txs, ym, kind)
    /* 缩放档位换算成柱子宽度：44 / 62 rpx 之外一律铺满整行 */
    var zoom = this.data.dayZoom || 1
    var dColW = zoom === 1 ? 0 : (zoom === 2 ? 44 : 62)
    var dInW = dColW ? dColW * daily.list.length : 0

    /* 近 6 个月对比 */
    var tr6 = stats.trend(txs, ym, 6)
    var max6 = 1
    for (var i = 0; i < tr6.length; i++) {
      var v = kind === 'income' ? tr6[i].income : tr6[i].expense
      if (v > max6) max6 = v
    }
    var months = tr6.map(function (x) {
      var v2 = kind === 'income' ? x.income : x.expense
      var h = Math.round((v2 / max6) * 100)
      if (v2 > 0 && h < 4) h = 4
      return {
        ym: x.ym,
        label: x.label,
        text: format.money(v2),
        h: h,
        active: x.ym === ym,
        zero: v2 <= 0
      }
    })
    var activeIdx = 0
    months.forEach(function (x, i) { if (x.active) activeIdx = i })

    /* 预算：口径是「退款也算没花」，已花 = 支出 - 退款 */
    var b = store.budget()
    var curYm = format.ymOf(Date.now())
    var isCur = ym === curYm
    var restDays = 0
    if (isCur) {
      var dim = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate()
      restDays = dim - new Date().getDate() + 1
    }
    var spent = bs.net
    var over = b > 0 && spent > b
    var left = b > 0 ? Math.max(b - spent, 0) : 0
    var pct = b > 0 ? Math.min(100, Math.round((spent / b) * 100)) : 0

    /* 分类预算设置清单：支出类目一次列全（类目有 21 个，
       wx.showActionSheet 最多只能放 6 项，所以不能拿它做选择器） */
    var catBudgetList = category.CATS.expense
      .filter(function (n) { return n !== '未分类' })
      .map(function (n) {
        var budN = cb[n] || 0
        var spentN = Math.max(Math.round((bs.byCat[n] || 0) * 100) / 100, 0)
        return {
          name: n,
          icon: category.iconOf(n),
          tint: category.tintOf(n),
          spentText: format.money(spentN),
          has: budN > 0,
          budgetLabel: budN > 0 ? '¥' + format.money(budN) : '未设',
          budClass: budN > 0 ? (spentN > budN ? 'over' : 'on') : 'off',
          over: budN > 0 && spentN > budN,
          _spent: spentN
        }
      })
    catBudgetList.sort(function (p, q) {
      if (p.has !== q.has) return p.has ? -1 : 1
      return q._spent - p._spent
    })

    this.setData({
      monthText: format.monthLabel(ym),
      canNext: ym < curYm,
      isCurMonth: isCur,
      hasData: s.count > 0,
      s: {
        expenseText: format.money(s.expense),
        incomeText: format.money(s.incomeTotal),
        netText: format.money(Math.abs(s.net)),
        netSign: s.net < 0 ? '-' : '',
        count: s.count,
        refundText: format.money(s.refund),
        transferText: format.money(s.transfer),
        investText: format.money(s.invest),
        loanText: format.money(s.loan),
        acctText: format.money(s.acct)
      },

      avgDailyText: format.money(ins.avgDaily),
      maxMerchant: ins.maxTx ? ins.maxTx.merchant : '',
      maxAmountText: ins.maxTx ? format.money(ins.maxTx.amount) : '0.00',
      weekdayText: format.money(ins.weekday),
      weekendText: format.money(ins.weekend),
      spentDays: ins.spentDays,

      budget: b,
      budgetText: format.money(b),
      budgetSpentText: format.money(spent),
      budgetRefundText: format.money(bs.refund),
      budgetLeftText: format.money(left),
      budgetOverText: format.money(Math.max(spent - b, 0)),
      budgetPct: pct,
      budgetOver: over,
      budgetRestDays: restDays,
      budgetPerDayText: restDays > 0 ? format.money(left / restDays) : '0.00',

      catBudgetOpen: this.data.catBudgetOpen,
      catBudgetList: catBudgetList,

      cats: full.slice(0, n),
      /* 按钮跟「展开状态」无关：只要类目超过 5 个就一直在，
         否则展开到全部条数后 catsHasMore 变 false，按钮消失就收不回去了 */
      catsHasMore: full.length > 5,
      catsTotal: full.length,

      daily: daily,
      dayZoom: zoom,
      dColW: dColW,
      dInW: dInW,
      months: months,
      chartW: months.length * 164,
      scrollToId: 'm' + activeIdx,
      topList: topBy(txs, ym, kind, 6),

      year: ys,

      cells: cal.cells.map(function (c, idx) {
        c.k = c.blank ? 'b' + idx : 'd' + c.d
        return c
      }),
      selDayText: ''
    }, function () {
      self.drawPie(kind === 'income' ? 'piein' : 'pie', self._cats, {
        text: '¥' + (kind === 'income' ? self.data.s.incomeText : self.data.s.expenseText),
        label: kind === 'income' ? '本月入账' : '本月支出'
      })
    })
  },

  /* 本月每天的量：支出算原价支出，入账算收入 + 退款 */
  buildDaily: function (txs, ym, kind) {
    var p = ym.split('-')
    var y = parseInt(p[0], 10)
    var m = parseInt(p[1], 10)
    var dim = new Date(y, m, 0).getDate()

    var raw = []
    for (var d = 1; d <= dim; d++) raw.push(0)

    for (var i = 0; i < txs.length; i++) {
      var t = txs[i]
      if (t.ym !== ym) continue
      var dd = parseInt(String(t.day).split('-')[2], 10)
      if (dd < 1 || dd > dim) continue
      if (kind === 'income') {
        if (t.type === 'income' || t.type === 'refund') raw[dd - 1] += t.amount
      } else if (t.type === 'expense') {
        raw[dd - 1] += t.amount
      }
    }

    var max = 0
    var maxIdx = -1
    for (var k = 0; k < raw.length; k++) {
      if (raw[k] > max) { max = raw[k]; maxIdx = k }
    }

    var list = raw.map(function (v, idx) {
      var use = v > 0 ? v : 0
      var h = max > 0 ? Math.round((use / max) * 100) : 0
      if (use > 0 && h < 5) h = 5
      var day = idx + 1
      /* 放大后每一列下面要有个日期，不然滑着就不知道看的是哪天 */
      var ax = ''
      if (day === 1 || day % 5 === 0 || day === dim) ax = m + '.' + day
      return { d: day, h: h, isMax: idx === maxIdx && max > 0, ax: ax }
    })

    var left = dim > 1 ? ((maxIdx + 0.5) / dim) * 100 : 50
    if (left < 22) left = 22
    if (left > 78) left = 78

    var mid1 = Math.max(2, Math.round(dim / 3))
    var mid2 = Math.max(mid1 + 1, Math.round((dim * 2) / 3))

    return {
      list: list,
      dim: dim,
      show: max > 0,
      tipText: max > 0 ? (m + '月' + (maxIdx + 1) + '日 · ' + (kind === 'income' ? '共入账' : '共支出') + ' ¥' + format.money(max)) : '',
      tipLeft: left,
      maxText: format.money(max),
      x1: m + '.' + 1,
      x2: m + '.' + mid1,
      x3: m + '.' + mid2,
      x4: m + '.' + dim
    }
  },

  /* 环形图：只画环 + 中心数字都画在画布上
   * 中心文字必须画进 canvas，不能用 view 盖上去——canvas 是原生组件，
   * 普通 view 在真机上会被它挡住（以前中心是空白的，就是这个原因）。 */
  drawPie: function (id, cats, info, attempt) {
    var self = this
    if (!cats || !cats.length) return
    var n = attempt || 0

    var query = wx.createSelectorQuery()
    query.select('#' + id).fields({ node: true, size: true }).exec(function (res) {
      if (!res || !res[0] || !res[0].node) {
        /* canvas 在 wx:if 里，刚切换页签时可能还没渲染出来，最多再等 3 次 */
        if (n >= 3) return
        setTimeout(function () { self.drawPie(id, cats, info, n + 1) }, 150)
        return
      }
      var canvas = res[0].node
      var ctx = canvas.getContext('2d')
      var w = res[0].width
      var h = res[0].height

      var win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      var dpr = win.pixelRatio || 2

      canvas.width = w * dpr
      canvas.height = h * dpr
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, w, h)

      var cx = w / 2
      var cy = h / 2
      var rOuter = Math.min(w, h) / 2 - 2
      var rInner = rOuter * 0.62

      var total = 0
      for (var i = 0; i < cats.length; i++) total += cats[i].pct
      if (total <= 0) total = 100

      var start = -Math.PI / 2
      for (var j = 0; j < cats.length; j++) {
        var sweep = (cats[j].pct / total) * Math.PI * 2
        if (sweep < 0.015) sweep = 0.015
        ctx.beginPath()
        ctx.arc(cx, cy, rOuter, start, start + sweep)
        ctx.arc(cx, cy, rInner, start + sweep, start, true)
        ctx.closePath()
        ctx.fillStyle = cats[j].color
        ctx.fill()
        start += sweep
      }

      ctx.beginPath()
      ctx.arc(cx, cy, rInner, 0, Math.PI * 2)
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1
      ctx.stroke()

      /* 中心数字 + 标签，直接画在画布上 */
      var numText = String((info && info.text) || '')
      var labText = String((info && info.label) || '')
      if (numText) {
        var fs = Math.round(w * 0.095)
        ctx.font = 'bold ' + fs + 'px sans-serif'
        /* 金额太长（六位数以上）就把字号往下缩，别顶到环上 */
        while (fs > 8 && ctx.measureText(numText).width > rInner * 1.86) {
          fs -= 1
          ctx.font = 'bold ' + fs + 'px sans-serif'
        }
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillStyle = '#2b3136'
        ctx.fillText(numText, cx, cy - w * 0.038)
      }
      if (labText) {
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillStyle = '#9aa0a6'
        ctx.font = Math.round(w * 0.055) + 'px sans-serif'
        ctx.fillText(labText, cx, cy + w * 0.07)
      }
    })
  },

  switchTab: function (e) {
    var self = this
    var tab = e.currentTarget.dataset.tab
    if (!tab || tab === this.data.tab) return
    this.setData({ tab: tab, catsOpen: false }, function () { self.refresh() })
  },

  toggleCats: function () {
    var self = this
    this.setData({ catsOpen: !this.data.catsOpen }, function () {
      self.refresh()
    })
  },

  prevMonth: function () {
    var self = this
    this.setData({ ym: format.shiftMonth(this.data.ym, -1) }, function () { self.refresh() })
  },

  nextMonth: function () {
    if (!this.data.canNext) return
    var self = this
    this.setData({ ym: format.shiftMonth(this.data.ym, 1) }, function () { self.refresh() })
  },

  /* 点月度柱子 → 跳到流水页，看那个月的明细 */
  tapBar: function (e) {
    var ym = e.currentTarget.dataset.ym
    if (!ym) return
    var app = getApp()
    app.globalData.filterYm = ym
    app.globalData.filterCat = ''
    app.globalData.filterDay = ''
    app.globalData.filterKind = ''
    app.globalData.filterUncat = false
    wx.switchTab({ url: '/pages/list/list' })
  },

  /* 年度分类：展开 / 收起全部类目 */
  toggleYearCats: function () {
    var self = this
    this.setData({ yearCatsOpen: !this.data.yearCatsOpen }, function () {
      self.refresh()
    })
  },

  /* 年度分类：支出 / 入账 切换（跟页面顶部那个页签是两回事，互不影响） */
  switchYearTab: function (e) {
    var tab = e.currentTarget.dataset.tab
    if (!tab || tab === this.data.yearTab) return
    var self = this
    this.setData({ yearTab: tab, yearCatsOpen: false }, function () {
      self.refresh()
    })
  },

  /* 点年度里的某个分类 → 打开分类明细页，按月列出这一年这一类花的钱 */
  tapYearCat: function (e) {
    var name = e.currentTarget.dataset.name
    if (!name) return
    var year = this.data.year ? String(this.data.year.year) : format.ymOf(Date.now()).slice(0, 4)
    wx.navigateTo({
      url: '/pages/cat/cat?year=' + year + '&kind=' + this.data.yearTab +
        '&cat=' + encodeURIComponent(name)
    })
  },

  /* 点构成里的某个分类 → 跳到流水页看这个分类的明细 */
  tapCat: function (e) {
    var name = e.currentTarget.dataset.name
    if (!name) return
    var app = getApp()
    app.globalData.filterCat = name
    app.globalData.filterKind = this.data.tab
    app.globalData.filterYm = this.data.ym
    app.globalData.filterDay = ''
    wx.switchTab({ url: '/pages/list/list' })
  },

  /* 每日柱放大 / 缩小：1× 整月一屏，2×/3× 柱子加宽到需要左右滑 */
  zoomDay: function (e) {
    var self = this
    var d = Number(e.currentTarget.dataset.d) || 0
    var z = (this.data.dayZoom || 1) + d
    if (z < 1) z = 1
    if (z > 3) z = 3
    if (z === this.data.dayZoom) return
    this.setData({ dayZoom: z }, function () {
      self.refresh()
    })
  },

  /* 点每日柱子 → 跳到流水页看那一天的明细 */
  tapDaily: function (e) {
    var d = e.currentTarget.dataset.d
    if (!d) return
    var day = this.data.ym + '-' + format.pad(d)
    var app = getApp()
    app.globalData.filterYm = this.data.ym
    app.globalData.filterDay = day
    app.globalData.filterCat = ''
    app.globalData.filterKind = this.data.tab === 'income' ? 'income' : 'expense'
    app.globalData.filterUncat = false
    wx.switchTab({ url: '/pages/list/list' })
  },

  tapDay: function (e) {
    var item = e.currentTarget.dataset.item
    if (!item || item.blank) return
    var day = this.data.ym + '-' + format.pad(item.d)
    var app = getApp()
    app.globalData.filterDay = day
    app.globalData.filterCat = ''
    app.globalData.filterKind = 'expense'
    app.globalData.filterYm = this.data.ym
    wx.switchTab({ url: '/pages/list/list' })
  },

  setBudget: function () {
    var self = this
    var cur = this.data.budget
    wx.showModal({
      title: cur > 0 ? '改月度预算' : '设月度预算',
      editable: true,
      placeholderText: cur > 0 ? '当前 ¥' + format.money(cur) + '，填 0 取消' : '比如 3000，填 0 不设',
      success: function (res) {
        if (!res.confirm) return
        var v = Number(String(res.content || '').replace(/[^\d.]/g, ''))
        store.setBudget(v)
        self.refresh()
        wx.showToast({ title: v > 0 ? '预算已设' : '已取消预算', icon: 'none' })
      }
    })
  },

  /* 分类预算：直接展开成一张可点的清单（类目太多，actionSheet 塞不下） */
  toggleCatBudget: function () {
    this.setData({ catBudgetOpen: !this.data.catBudgetOpen })
  },

  pickCatBudget: function (e) {
    var self = this
    var name = e.currentTarget.dataset.name
    if (!name) return
    var cur = store.catBudgets()[name] || 0
    wx.showModal({
      title: (cur > 0 ? '改「' : '设「') + name + '」预算',
      editable: true,
      placeholderText: cur > 0 ? '当前 ¥' + format.money(cur) + '，填 0 取消' : '比如 500，填 0 不设',
      success: function (m) {
        if (!m.confirm) return
        var v = Number(String(m.content || '').replace(/[^\d.]/g, ''))
        store.setCatBudget(name, v)
        self.refresh()
        wx.showToast({ title: v > 0 ? '预算已设' : '已取消预算', icon: 'none' })
      }
    })
  },

  exportCsv: function () {
    var ym = this.data.ym
    var txs = store.all()
    var lines = ['日期,时间,收/支,金额,分类,交易对方,说明,来源']
    for (var i = 0; i < txs.length; i++) {
      var t = txs[i]
      if (t.ym !== ym) continue
      var d = new Date(t.time)
      lines.push([
        t.day,
        format.pad(d.getHours()) + ':' + format.pad(d.getMinutes()),
        t.type === 'expense' ? '支出' : (t.type === 'income' ? '收入' : (t.type === 'refund' ? '退款' : '不计收支')),
        t.amount.toFixed(2),
        t.category,
        '"' + String(t.merchant).replace(/"/g, '""') + '"',
        '"' + String(t.desc || '').replace(/"/g, '""') + '"',
        t.source || ''
      ].join(','))
    }

    wx.setClipboardData({
      data: lines.join('\n'),
      success: function () {
        wx.showModal({
          title: '已复制到剪贴板',
          content: '去微信里发给「文件传输助手」，在电脑上另存为 .csv 文件，双击就能用 Excel 打开',
          showCancel: false
        })
      }
    })
  },

  /* 备份：全量 JSON 转发到聊天 / 存到本地 */
  backup: function () {
    var self = this
    var data = store.exportAll()
    var fs = wx.getFileSystemManager()
    var path = wx.env.USER_DATA_PATH + '/book_backup_' + format.dayOf(Date.now()) + '.json'
    fs.writeFile({
      filePath: path,
      data: JSON.stringify(data),
      encoding: 'utf8',
      success: function () {
        var openDoc = function () {
          wx.openDocument({
            filePath: path,
            fileType: 'json',
            showMenu: true,
            fail: function () {
              wx.showModal({ title: '备份文件已生成', content: '路径：' + path, showCancel: false })
            }
          })
        }
        if (wx.shareFileMessage) {
          wx.shareFileMessage({ filePath: path, fail: openDoc })
        } else {
          openDoc()
        }
      },
      fail: function () { wx.showToast({ title: '生成备份失败', icon: 'none' }) }
    })
  },

  /* 恢复：从聊天里选备份 JSON，流水按现有判重规则合并 */
  restore: function () {
    var self = this
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['json'],
      success: function (res) {
        var f = res.tempFiles[0]
        if (!f) return
        var fs = wx.getFileSystemManager()
        fs.readFile({
          filePath: f.path,
          encoding: 'utf8',
          success: function (r) {
            var payload = null
            try { payload = JSON.parse(r.data) } catch (e) {
              wx.showToast({ title: '文件不是有效备份', icon: 'none' })
              return
            }
            var n = Array.isArray(payload.txs) ? payload.txs.length : 0
            if (!n) { wx.showToast({ title: '备份里没有流水', icon: 'none' }); return }
            wx.showModal({
              title: '恢复备份？',
              content: '备份里有 ' + n + ' 笔流水；已存在的会自动跳过，不会重复记。',
              confirmText: '恢复',
              success: function (m) {
                if (!m.confirm) return
                try {
                  var out = store.importAll(payload)
                  self.refresh()
                  wx.showModal({
                    title: '恢复完成',
                    content: '新增 ' + out.added + ' 笔，重复跳过 ' + out.dup + ' 笔，合并 ' + out.merged + ' 笔' +
                      (out.trimmed ? '，超出一年清掉 ' + out.trimmed + ' 笔' : '') +
                      '；库里共 ' + out.total + ' 笔。',
                    showCancel: false
                  })
                } catch (err) {
                  wx.showToast({ title: err.message || '恢复失败', icon: 'none' })
                }
              }
            })
          },
          fail: function () { wx.showToast({ title: '读不到这个文件', icon: 'none' }) }
        })
      }
    })
  },

  clearAll: function () {
    var n = store.all().length
    wx.showModal({
      title: '清空所有数据？',
      content: '库里 ' + n + ' 笔流水、学到的分类规则、月度预算会一起清零，不能恢复。只想删某个月的，去「流水」页点右上「⋯ 管理」。',
      confirmText: '清空',
      confirmColor: '#d9433f',
      success: function (res) {
        if (!res.confirm) return
        store.clearAll()
        wx.showToast({ title: '已清空', icon: 'none' })
        var pages = getCurrentPages()
        var cur = pages[pages.length - 1]
        if (cur && cur.refresh) cur.refresh()
      }
    })
  }
})
