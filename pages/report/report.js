var format = require('../../utils/format')
var store = require('../../utils/store')
var stats = require('../../utils/stats')
var category = require('../../utils/category')
var vip = require('../../utils/vip')
var prefs = require('../../utils/prefs')
var darkmode = require('../../utils/darkmode')
var shared = require('../../utils/shared')
var dataTools = require('../../utils/data-tools')

function cents(amount) {
  var n = Number(amount) || 0
  return ((n < 0 ? -1 : 1) * Math.round(Math.abs(n) * 100 + 1e-8)) || 0
}

/* 折叠正支出时，退款抵减项仍单列。 */
function previewCats(list, limit) {
  return list.filter(function (c, i) { return i < limit || c.negative })
}

function topBy(txs, ym, kind, n) {
  var rows = stats.ledger(txs, prefs.refundExcluded())
  var map = Object.create(null)
  for (var i = 0; i < rows.length; i++) {
    var t = rows[i]
    if (t.ym !== ym) continue
    var hit = kind === 'income'
      ? (t.type === 'income' || t.type === 'refund')
      : (t.type === 'expense')
    if (!hit) continue
    var key = String(t.merchant || '未知').trim() || '未知'
    if (!map[key]) map[key] = { name: key, cents: 0, count: 0, cat: '', ids: Object.create(null) }
    var row = map[key]
    row.cents += cents(t.amount)
    var id = String(t.originalId || t.id || ('row' + i))
    if (!row.ids[id]) { row.ids[id] = true; row.count++ }
    row.cat = t.category
  }
  var list = Object.keys(map).map(function (k) { return map[k] })
  list.sort(function (a, b) { return b.cents - a.cents })
  return list.slice(0, n || 6).map(function (row) {
    return {
      name: row.name, amount: row.cents / 100, count: row.count, cat: row.cat,
      amountText: format.signedMoney(row.cents / 100), negative: row.cents < 0,
      icon: String(row.cat || '账').slice(0, 1)
    }
  })
}

var theme = require('../../utils/theme')

Page({
  data: {
    themeKey: 'green',
    ym: '',
    monthText: '',
    canNext: false,
    maxYm: '',
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
    backTab: '',
    backLabel: '',
    dColW: 0,
    dInW: 0,
    months: [],
    scrollToId: '',

    rankBoards: [],
    rankAny: false,

    year: null,
    yearCatsOpen: false,
    yearTab: 'expense',

    cells: [],
    selDayText: '',
    uncatCount: 0,

    /* 会员锁：报表页整体是会员功能，未开通只显示一张锁屏卡 */
    locked: false,

    /* 免费版：这些卡片以灰化占位出现，比直接不渲染更让人知道锁了什么 */
    teasers: [
      { name: '每日支出趋势', hint: '会员可见 · 点这里开通', bars: ['70%', '45%', '88%', '60%', '76%'] },
      { name: '近 6 个月对比', hint: '会员可见 · 点这里开通', bars: ['52%', '68%', '40%', '82%', '58%', '74%'] },
      { name: '商户排行', hint: '会员可见 · 点这里开通', bars: ['90%', '66%', '48%'] },
      { name: '年度汇总', hint: '会员可见 · 点这里开通', bars: ['84%', '60%', '70%', '46%'] }
    ],

    /* 系统深色模式：环形图要把中心文字画成浅色，否则深色底上看不清 */
    dark: false,

    /* 共同账本视角：mine 只看自己 / both 看双方 / peer 只看对方 */
    sharedOn: false,
    sharedMembers: 0,
    scope: 'both',

    /* 环图画布：先不建，等首屏数字渲染完再建，否则渲染层开局就卡住 */
    hidePie: true
  },

  onLoad: function () {
    var self = this
    this.setData({ ym: format.ymOf(Date.now()), dark: darkmode.isDark() })
    this._unwatchDark = darkmode.watch(function (dark) {
      self.setData({ dark: dark }, function () { if (self._visible) { theme.syncTabBar(); self.refresh() } })
    })
  },

  onShow: function () {
    this._visible = true
    this.setData({ themeKey: theme.get().key, dark: darkmode.isDark() })
    theme.syncTabBar()
    var app = getApp()
    if (/^\d{4}-(0[1-9]|1[0-2])$/.test(app.globalData.reportYm || '') && app.globalData.reportYm <= format.ymOf(Date.now())) {
      this.setData({ ym: app.globalData.reportYm })
    }
    app.globalData.reportYm = ''
    var section = app.globalData.reportSection
    app.globalData.reportSection = ''
    /* 只有点名「由本页显示返回」的标记才在这儿消费；
     * 「回流水页」的标记留给流水页自己读，否则报表顺手把它吃掉，流水页就没有返回按钮了。 */
    if (app.globalData.backFor === '/pages/report/report') {
      this.setData({ backTab: app.globalData.backTab, backLabel: app.globalData.backLabel || '返回' })
      app.globalData.backFor = ''
      app.globalData.backTab = ''
      app.globalData.backLabel = ''
    } else {
      this.setData({ backTab: '', backLabel: '' })
    }
    /* 共同账本：视角跟着本机偏好走，流水页里切换过这里也要跟上 */
    var book = shared.current()
    var on = shared.isJoined()
    this.setData({
      sharedOn: on,
      sharedMembers: (book && book.members) || 0,
      scope: on ? prefs.viewScope() : 'both'
    })
    this.syncVip()
    if (section === 'tools' || section === 'budget') {
      if (section === 'budget' && !vip.isVip()) { vip.guard('月度预算'); return }
      this.setData({ tab: 'expense' }, function () {
        if (wx.pageScrollTo) wx.pageScrollTo({ selector: section === 'tools' ? '#data-tools' : '#budget-card', duration: 250 })
      })
    }
  },

  onHide: function () { this._visible = false },

  onUnload: function () {
    if (this._unwatchDark) this._unwatchDark()
  },

  /* 报表统一取数：加入了共同账本时按「只看自己 / 看双方 / 只看对方」过滤，
     没加入就照旧全量。所有统计、构成、导出都走这里，避免各页口径打架。 */
  scopeTxs: function () {
    return shared.viewRows(store.all(), prefs.viewScope())
  },

  /* 切换视角：写进本机偏好，流水页和首页一起变 */
  setScope: function (e) {
    var k = e.currentTarget.dataset.k
    var v = (k === 'mine' || k === 'peer') ? k : 'both'
    prefs.setViewScope(v)
    if (v === this.data.scope) return
    var self = this
    this.setData({ scope: v }, function () { self.refresh() })
  },

  /* 报表的免费部分：本月数字卡 + 支出构成 + 数据工具；其余区块都是会员功能，
   * 所以数据照算（免费也要出数字和构成），只是 wxml 里把后面的卡片不渲染 */
  syncVip: function () {
    var self = this
    var locked = !vip.isVip()
    this.setData({ locked: locked })
    this.refresh()
    if (this._vipChecked) return
    this._vipChecked = true
    vip.refresh(function () {
      var stillLocked = !vip.isVip()
      if (stillLocked === locked) return   /* 状态没变，不重复计算 */
      self.setData({ locked: stillLocked })
      if (!stillLocked) self.refresh()
    })
  },

  goVip: function () {
    wx.navigateTo({ url: '/pages/vip/vip' })
  },

  /* 页面内返回（报表 ← 总览 是 switchTab，原生没有返回箭头） */
  goBack: function () {
    var target = this.data.backTab
    this.setData({ backTab: '', backLabel: '' })
    if (target) wx.switchTab({ url: target })
  },

  refresh: function () {
    var self = this
    var ym = this.data.ym
    var kind = this.data.tab
    var txs = this.scopeTxs()
    var s = stats.summary(txs, ym)
    var bs = stats.budgetSpent(txs, ym)
    var ins = stats.insights(txs, ym)
    var cmp = stats.compareCats(txs, ym)
    var cal = stats.calendar(txs, ym)
    var ys = stats.yearSummary(txs, ym.split('-')[0])
    var uncatCount = 0
    var grossCats = Object.create(null)
    var maxPayment = null
    for (var ui = 0; ui < txs.length; ui++) {
      var raw = txs[ui]
      if (raw.byMe !== false && raw.type === 'expense' && raw.category === '未分类') uncatCount++
      if (raw.ym !== ym || raw.type !== 'expense') continue
      var name = raw.category || '未分类'
      grossCats[name] = (grossCats[name] || 0) + cents(raw.amount)
      if (cents(raw.amount) > 0 && (!maxPayment || cents(raw.amount) > cents(maxPayment.amount))) maxPayment = raw
    }
    /* 年度分类：支出 / 入账两个榜，默认只露前 3 类，展开看全年全部类目 */
    if (ys) {
      var yIncome = this.data.yearTab === 'income'
      var yAll = ((yIncome ? ys.topAllIn : ys.topAll) || []).filter(function (c) { return c.amount !== 0 })
      var yOpen = this.data.yearCatsOpen
      var yPreview = previewCats(yAll, 3)
      ys.topTotal = yAll.length
      ys.topMore = yAll.length > yPreview.length
      ys.top = yOpen ? yAll : yPreview
      ys.moreLabel = yOpen ? '收起' : '展开全部 ' + yAll.length + ' 类'
      ys.topLabel = yIncome ? '入账分类排行' : (s.refundOut ? '净支出分类排行' : '支出分类排行')
    }

    /* 支出分类带环比 + 分类预算 */
    var cb = store.catBudgets()
    var expCats = s.byCat.map(function (c) {
      var prev = cmp.amountOf(c.name)
      var change = cents(c.amount) - cents(prev)
      var deltaText = ''
      var deltaDir = change > 0 ? 'up' : (change < 0 ? 'down' : '')
      var d = prev !== 0 ? Math.round((change / Math.abs(cents(prev))) * 100) : 0
      if (change === 0) {
        deltaText = '持平'
      } else if (prev <= 0 || c.amount < 0 || Math.abs(d) > 999) {
        /* 上个月这类没有消费就别写「上月 ¥0.00」，那是一条噪音；
           也别染成红色的「涨了」，新出现的分类不是坏消息 */
        if (prev > 0) {
          deltaText = '上月 ¥' + format.signedMoney(prev)
        } else {
          deltaText = '本月新增'
          deltaDir = ''
        }
      } else {
        deltaText = (d > 0 ? '+' : '') + d + '%'
      }
      var bud = cb[c.name] || 0
      var signedNet = bs.byCat[c.name] || 0
      var netAmt = Math.max(signedNet, 0)
      var backAmt = Math.max((grossCats[c.name] || 0) - cents(signedNet), 0) / 100
      return {
        _amt: c.amount, negative: c.amount < 0,
        name: c.name, amountText: c.amountText, pct: c.pct, count: c.count,
        color: c.color, icon: String(c.name || '账').slice(0, 1), tint: category.tintOf(c.name), deltaText: deltaText, deltaDir: deltaDir,
        budget: bud,
        budgetText: bud > 0 ? format.money(bud) : '',
        budgetSpentText: format.money(netAmt),
        budgetRefundText: backAmt > 0 ? format.money(backAmt) : '',
        budgetPct: bud > 0 ? Math.min(100, Math.round((netAmt / bud) * 100)) : 0,
        budgetOver: bud > 0 && netAmt > bud
      }
    }).filter(function (c) { return c._amt !== 0 })

    var incCats = s.byIncome.map(function (c) {
      return {
        _amt: c.amount, negative: c.amount < 0,
        name: c.name, amountText: c.amountText, pct: c.pct, count: c.count,
        color: c.color, icon: String(c.name || '账').slice(0, 1), tint: category.tintOf(c.name), deltaText: '', deltaDir: ''
      }
    })

    /* 当前 tab 的分类，默认 5 条 */
    var full = kind === 'income' ? incCats : expCats
    this._cats = full
    var preview = previewCats(full, 5)
    /* 每日对比 */
    var daily = this.buildDaily(txs, ym, kind)
    /* 缩放档位换算成柱子宽度：44 / 62 rpx 之外一律铺满整行 */
    var zoom = this.data.dayZoom || 1
    var dColW = zoom === 1 ? 0 : (zoom === 2 ? 44 : 62)
    var dInW = dColW ? dColW * daily.list.length : 0

    /* 近 6 个月对比 */
    var tr6 = stats.trend(txs, ym, 6)
    var max6 = 0
    for (var i = 0; i < tr6.length; i++) {
      var v = kind === 'income' ? tr6[i].income : tr6[i].expense
      max6 = Math.max(max6, Math.abs(v))
    }
    var months = tr6.map(function (x) {
      var v2 = kind === 'income' ? x.income : x.expense
      var h = max6 > 0 ? Math.round((Math.abs(v2) / max6) * 100) : 0
      if (v2 !== 0 && h < 4) h = 4
      return {
        ym: x.ym,
        label: x.label,
        text: format.signedMoney(v2),
        h: h,
        active: x.ym === ym,
        negative: v2 < 0,
        zero: v2 === 0
      }
    })
    var activeIdx = 0
    months.forEach(function (x, i) { if (x.active) activeIdx = i })

    /* 预算消耗最低为零，报表净支出保留负数。 */
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
        var spentN = Math.max(bs.byCat[n] || 0, 0)
        return {
          name: n,
          icon: String(n).slice(0, 1),
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

    /* 商户排行：支出榜和入账榜都给出来，当前页签对应的那个排前面 */
    var topExp = topBy(txs, ym, 'expense', 6)
    var topInc = topBy(txs, ym, 'income', 6)
    var rankBoards = [
      { key: 'exp', title: s.refundOut ? '净支出排行' : '支出排行', sub: s.refundOut ? '含当月退款抵减 · 按净额排序' : '本月花得最多的商户', inc: false, list: topExp },
      { key: 'inc', title: '入账排行', sub: '本月进账最多的商户', inc: true, list: topInc }
    ]
    if (kind === 'income') rankBoards = [rankBoards[1], rankBoards[0]]

    /* 首屏只提交看得见的部分：日历格、年度汇总、排行、月度图这些一起塞过来，
       渲染层要十几秒才画完，用户看到的就是「报表很卡、打不开」 */
    this.setData({
      monthText: format.monthLabel(ym),
      maxYm: curYm,
      canNext: ym < curYm,
      isCurMonth: isCur,
      hasData: s.count > 0,
      s: {
        expenseText: format.signedMoney(s.expense),
        incomeText: format.money(s.incomeTotal),
        netText: format.money(Math.abs(s.net)),
        netSign: s.net < 0 ? '-' : '',
        count: s.count,
        refundText: format.money(s.refund),
        refundOut: !!s.refundOut,
        transferText: format.money(s.transfer),
        investText: format.money(s.invest),
        loanText: format.money(s.loan),
        acctText: format.money(s.acct)
      },

      avgDailyText: format.signedMoney(ins.avgDaily),
      maxMerchant: maxPayment ? maxPayment.merchant : '',
      maxAmountText: maxPayment ? format.money(maxPayment.amount) : '0.00',
      weekdayText: format.signedMoney(ins.weekday),
      weekendText: format.signedMoney(ins.weekend),
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
      cats: this.data.catsOpen ? full : preview,
      catsHasMore: full.length > preview.length,
      catsTotal: full.length,
      uncatCount: uncatCount,

      daily: daily,
      dayZoom: zoom,
      dColW: dColW,
      dInW: dInW,
      months: months,
      chartW: months.length * 164,
      scrollToId: 'm' + activeIdx,
      rankBoards: rankBoards,
      rankAny: topExp.length > 0 || topInc.length > 0,
      catBudgetList: catBudgetList,
      cells: cal.cells.map(function (c, idx) {
        return Object.assign({}, c, {
          k: c.blank ? 'b' + idx : 'd' + c.d,
          negative: !c.blank && c.amount < 0
        })
      }),
      selDayText: ''
    }, function () {
      var cid = kind === 'income' ? 'piein' : 'pie'
      var opt = {
        text: '¥' + (kind === 'income' ? self.data.s.incomeText : self.data.s.expenseText),
        label: kind === 'income' ? '本月入账' : (s.refundOut ? '本月净支出' : '本月支出')
      }
      /* 先把首屏文字渲染完，再建画布：canvas 从「不渲染」到「渲染」这一步在真机上最贵，
         放在后面，页面就不会一打开先白等十几秒 */
      self.setData({ hidePie: false }, function () {
        self.drawPie(cid, self._cats, opt)
      })

      /* 年度汇总是最重的一块（全年每类每月），单独补一刀，别和首屏挤在一起 */
      self.setData({ year: ys })
    })  },

  /* 每日与月汇总共用现金流日期口径。 */
  buildDaily: function (txs, ym, kind) {
    var cal = stats.calendar(txs, ym)
    var m = parseInt(ym.split('-')[1], 10)
    var dim = cal.days.length
    var raw = cal.days.map(function (c) { return kind === 'income' ? c.income : c.amount })
    var max = 0
    var maxIdx = -1
    for (var k = 0; k < raw.length; k++) {
      if (Math.abs(raw[k]) > max) { max = Math.abs(raw[k]); maxIdx = k }
    }

    var list = raw.map(function (v, idx) {
      var h = max > 0 ? Math.round((Math.abs(v) / max) * 100) : 0
      if (v !== 0 && h < 5) h = 5
      var day = cal.days[idx].d
      var ax = ''
      if (day === 1 || day % 5 === 0 || day === dim) ax = m + '.' + day
      return {
        d: day, amount: v, amountText: format.signedMoney(v), h: h,
        negative: v < 0, zero: v === 0, isMax: idx === maxIdx && max > 0, ax: ax
      }
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
      tipText: max > 0 ? (m + '月' + cal.days[maxIdx].d + '日 · ' + (kind === 'income' ? '共入账' : (prefs.refundExcluded() ? '净支出' : '共支出')) + ' ¥' + format.signedMoney(raw[maxIdx])) : '',
      tipLeft: left,
      maxText: format.signedMoney(max > 0 ? raw[maxIdx] : 0),
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
      var w = res[0].width
      var h = res[0].height

      var win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      var dpr = win.pixelRatio || 2

      /* 尺寸没变就别重设宽高：每次设 width 都会重建整块绘制缓冲，真机上这一下最贵 */
      var cw = Math.round(w * dpr)
      if (canvas.width !== cw) {
        canvas.width = w * dpr
        canvas.height = h * dpr
      }
      var ctx = canvas.getContext('2d')
      /* 真机 canvas 2d 支持 setTransform；测试用的假 ctx 只有 scale，兜一下 */
      if (ctx.setTransform) ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      else ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, w, h)

      var cx = w / 2
      var cy = h / 2
      var rOuter = Math.min(w, h) / 2 - 2
      var rInner = rOuter * 0.62

      var total = 0
      for (var i = 0; i < cats.length; i++) {
        if (cats[i]._amt > 0) total += cents(cats[i]._amt)
      }
      if (total === 0) {
        ctx.beginPath()
        ctx.arc(cx, cy, (rOuter + rInner) / 2, 0, Math.PI * 2)
        ctx.lineWidth = rOuter - rInner
        ctx.strokeStyle = self.data.dark ? '#343d46' : '#e6eaed'
        ctx.stroke()
      }

      var start = -Math.PI / 2
      for (var j = 0; j < cats.length; j++) {
        if (cats[j]._amt <= 0 || total === 0) continue
        var sweep = (cents(cats[j]._amt) / total) * Math.PI * 2
        if (sweep <= 0) continue
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
      ctx.strokeStyle = (self.data && self.data.dark) ? '#1b2026' : '#ffffff'
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
        ctx.fillStyle = (self.data && self.data.dark) ? '#f2f4f6' : '#2b3136'
        ctx.fillText(numText, cx, cy - w * 0.038)
      }
      if (labText) {
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillStyle = (self.data && self.data.dark) ? '#9aa4ad' : '#9aa0a6'
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

  pickMonth: function (e) {
    var self = this
    var ym = String(e.detail.value || '')
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym) || ym > format.ymOf(Date.now())) return
    this.setData({ ym: ym }, function () { self.refresh() })
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
    app.globalData.backFor = '/pages/list/list'
    app.globalData.backTab = '/pages/report/report'
    app.globalData.backLabel = '报表'
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
    app.globalData.filterUncat = false
    app.globalData.backFor = '/pages/list/list'
    app.globalData.backTab = '/pages/report/report'
    app.globalData.backLabel = '报表'
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
    app.globalData.backFor = '/pages/list/list'
    app.globalData.backTab = '/pages/report/report'
    app.globalData.backLabel = '报表'
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
    app.globalData.filterUncat = false
    app.globalData.backFor = '/pages/list/list'
    app.globalData.backTab = '/pages/report/report'
    app.globalData.backLabel = '报表'
    wx.switchTab({ url: '/pages/list/list' })
  },

  /* 退款怎么算：点顶部那行「退款 ¥x 已抵消 · 点这里改」直接切 */
  toggleRefund: function () {
    var next = prefs.setRefundExcluded(!prefs.refundExcluded())
    this.refresh()
    wx.showToast({ title: next ? '退款已抵消，支出同步减少' : '退款已计入入账', icon: 'none' })
  },

  setBudget: function () {
    var self = this
    if (!vip.guard('月度预算')) return
    var cur = this.data.budget
    wx.showModal({
      title: cur > 0 ? '改月度预算' : '设月度预算',
      editable: true,
      placeholderText: cur > 0 ? '当前 ¥' + format.money(cur) + '，填 0 取消' : '比如 3000，填 0 不设',
      success: function (res) {
        if (!res.confirm) return
        var v = Number(String(res.content || '').replace(/[^\d.]/g, ''))
        var saved = store.setBudget(v)
        if (saved === null) return
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
        if (store.setCatBudget(name, v) === null) return
        self.refresh()
        wx.showToast({ title: v > 0 ? '预算已设' : '已取消预算', icon: 'none' })
      }
    })
  },

  exportCsv: function () {
    var ym = this.data.ym
    var txs = this.scopeTxs()
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

  /* 与「我的」共用免费数据工具，跨页面也只允许一个操作。 */
  backup: function () {
    var self = this
    return dataTools.backup(function () { self.refresh() })
  },

  restore: function () {
    var self = this
    return dataTools.restore(function () { self.refresh() })
  },

  /* AI 补分类：只处理词库没命中的「未分类」，按商户去重后一批批问
   * 结果先弹出来给用户确认，确认了才写库；写过的商户沉淀成规则，下次导入直接命中，不再调 AI */
  aiFill: function () {
    var self = this
    if (!vip.guard('AI 补分类')) return
    if (!wx.cloud) {
      wx.showToast({ title: '当前基础库不支持云开发', icon: 'none' })
      return
    }

    var txs = this.scopeTxs().filter(function (t) { return t.byMe !== false })
    var g = stats.uncatGroups(txs, 60)
    if (!g.items.length) {
      var why = g.noMerchant > 0
        ? '未分类的 ' + g.noMerchant + ' 笔都没有商户名，AI 也没法按商户归类，只能手动改'
        : '未分类的都已经处理过了'
      wx.showModal({ title: '没有能补的', content: why, showCancel: false })
      return
    }

    var payload = g.items.map(function (it) {
      return { i: it.i, m: it.m, d: it.d, t: 'expense' }
    })
    /* 类目清单直接把「未分类」递给模型，它就会照着答「未分类」，等于白问，先剔掉 */
    function pick(list) {
      return list.filter(function (c) { return c && c !== '未分类' })
    }

    wx.showLoading({ title: 'AI 分类中…', mask: true })
    wx.cloud.callFunction({
      name: 'aiCat',
      data: {
        items: payload,
        cats: { expense: pick(category.CATS.expense), income: pick(category.CATS.income) }
      },
      success: function (res) {
        wx.hideLoading()
        var r = res && res.result
        if (!r || !r.ok) {
          wx.showModal({
            title: 'AI 这次没出来',
            content: ((r && r.error) || '调用失败') + '\n\n不影响记账，过会儿再点一次就行；急的话去「流水」页手动改分类。',
            showCancel: false
          })
          return
        }
        self.showAiPreview(g, r)
      },
      fail: function (e) {
        wx.hideLoading()
        var msg = String((e && e.errMsg) || '调用失败')
        if (/FUNCTION_NOT_FOUND|function not found|-501000|-404/i.test(msg)) {
          msg = '云函数 aiCat 还没部署：在微信开发者工具里右键 cloudfunctions/aiCat，选「上传并部署：云端安装依赖」'
        }
        wx.showModal({ title: '调用云函数失败', content: msg, showCancel: false })
      }
    })
  },

  /* 把 AI 的结论摊开给用户看，确认后才落库 */
  showAiPreview: function (g, r) {
    var self = this
    var byI = {}
    g.items.forEach(function (it) { byI[it.i] = it })

    var list = []
    var map = {}
    /* 客户端再校验一次：云函数被判错/被改过都可能返回不存在的类目，
     * 写进库会让报表类目合计和支出总额对不上。只认支出清单里真实存在的名字 */
    var allow = category.CATS.expense.filter(function (c) { return c && c !== '未分类' })
    r.results.forEach(function (x) {
      var it = byI[x.i]
      if (!it) return
      if (allow.indexOf(String(x.c || '').trim()) < 0) return
      list.push(it)
      map[it.key] = x.c
      it.cat = x.c
    })
    if (!list.length) {
      wx.showToast({ title: 'AI 没给出可用分类', icon: 'none' })
      return
    }

    var lines = []
    var show = Math.min(list.length, 8)
    for (var i = 0; i < show; i++) {
      lines.push(list[i].m + ' → ' + list[i].cat + (list[i].count > 1 ? '（' + list[i].count + ' 笔）' : ''))
    }
    if (list.length > show) lines.push('…还有 ' + (list.length - show) + ' 个商户')

    var note = []
    if (g.overflow) note.push('另有 ' + (g.total - g.items.length) + ' 个商户这次没轮到，可以再点一次')
    if (r.dropped) note.push(r.dropped + ' 个模型没判出来，会继续留作未分类')

    wx.showModal({
      title: '确认写入 ' + list.length + ' 个商户？',
      content: lines.join('\n') + (note.length ? '\n\n' + note.join('；') : ''),
      confirmText: '写入',
      success: function (res) {
        if (!res.confirm) return
        var out = store.applyCategories(map)
        self.refresh()
        if (!out || out.saved !== true || out.partial) {
          wx.showModal({
            title: '分类保存失败',
            content: out && out.partial
              ? '分类或规则可能已有部分写入且回滚未完成。请先核对实际账本、导出备份，再决定是否重试。'
              : '本次分类和规则未保存，可以重试，或先导出备份。',
            showCancel: false
          })
          return
        }
        wx.showModal({
          title: '补了 ' + out.changed + ' 笔',
          content: '同时沉淀了 ' + out.learned + ' 条商户规则，以后这同一批商户导入时会自动分好类，不用再调 AI。\n判错的去「流水」页点那笔改一下，手改会覆盖这里的结论。',
          showCancel: false
        })
      }
    })
  },

  clearAll: function () {
    var n = store.all().length
    wx.showModal({
      title: '清空所有数据？',
      content: '本机 ' + n + ' 笔流水、分类规则和预算会清空，不能恢复。你自己已共享的记录会在下次同步时从云端删除；其他成员的记录只清除本机副本，不删除对方云端记录，本机清除标记保留期间不会重新拉回。无法远程擦除成员已保存的本机副本。建议先在「数据工具」导出备份；只删某个月的本人流水，请去「流水 → 管理」。',
      confirmText: '清空',
      confirmColor: '#d9433f',
      success: function (res) {
        if (!res.confirm) return
        if (store.clearAll() === false) return
        wx.showToast({ title: '已清空', icon: 'none' })
        var pages = getCurrentPages()
        var cur = pages[pages.length - 1]
        if (cur && cur.refresh) cur.refresh()
      }
    })
  }
})
