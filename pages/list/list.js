var format = require('../../utils/format')
var store = require('../../utils/store')
var stats = require('../../utils/stats')
var category = require('../../utils/category')
var vip = require('../../utils/vip')
var shared = require('../../utils/shared')
var prefs = require('../../utils/prefs')
var refundpair = require('../../utils/refundpair')

var theme = require('../../utils/theme')

/* '2026-11' → '2026-10'，'2026-01' → '2025-12' */
function monthBefore(ym) {
  var y = parseInt(ym.slice(0, 4), 10)
  var m = parseInt(ym.slice(5, 7), 10)
  if (m === 1) { y -= 1; m = 12 } else { m -= 1 }
  return y + '-' + (m < 10 ? '0' + m : '' + m)
}

/* '2026-11' → '2026-12'，'2026-12' → '2027-01' */
function monthAfter(ym) {
  var y = parseInt(ym.slice(0, 4), 10)
  var m = parseInt(ym.slice(5, 7), 10)
  if (m === 12) { y += 1; m = 1 } else { m += 1 }
  return y + '-' + (m < 10 ? '0' + m : '' + m)
}

Page({
  data: {
    themeKey: 'green',
    ym: '',
    monthText: '',
    canNext: false,
    onlyUncat: false,
    filterCat: '',
    filterKind: '',
    filterDay: '',
    kw: '',
    searching: false,
    groups: [],
    s: { expenseText: '0.00', incomeText: '0.00', count: 0 },
    sheetVisible: false,
    sheetItem: null,
    sheetCats: [],
    catMode: false,
    backTab: '',
    backLabel: '',
    /* 共同账本：只有加入了才显示「谁记的」和「全部 / 只看我」 */
    sharedOn: false,
    sharedMembers: 0,
    scope: 'all'
  },

  onLoad: function () {
    this.setData({ ym: format.ymOf(Date.now()) })
  },

  onShow: function () {
    this.setData({ themeKey: theme.get().key })
    var app = getApp()
    if (app.globalData.filterUncat) {
      app.globalData.filterUncat = false
      /* 从总览跳进「未分类」时，把月份重置到当前月，否则会沿用上次停留的旧月份，
       * 非搜索状态下刷新会按旧月份过滤，可能显示 0 笔。 */
      this.setData({ onlyUncat: true, ym: format.ymOf(Date.now()), kw: '', filterDay: '' })
    }
    /* 四个筛选条件各自独立读取，不能用 filterCat 当总开关——日历跳当天时 filterCat 是空串 */
    var jumped = !!(app.globalData.filterCat || app.globalData.filterKind ||
      app.globalData.filterYm || app.globalData.filterDay)
    if (app.globalData.filterCat) this.setData({ filterCat: app.globalData.filterCat })
    if (app.globalData.filterKind) this.setData({ filterKind: app.globalData.filterKind })
    if (app.globalData.filterYm) this.setData({ ym: app.globalData.filterYm })
    if (app.globalData.filterDay) this.setData({ filterDay: app.globalData.filterDay })
    /* 从报表跳过来时清掉搜索词，否则跨月搜索会把月份筛选顶掉 */
    if (jumped) this.setData({ kw: '' })
    app.globalData.filterCat = ''
    app.globalData.filterKind = ''
    app.globalData.filterYm = ''
    app.globalData.filterDay = ''
    /* 从报表/总览点柱子、点分类跳过来时，记下「回哪儿」。
     * switchTab 没有页面栈，不这样记一笔，用户就被困在流水页、只能自己摸索回 tab。 */
    if (app.globalData.backFor === '/pages/list/list' && app.globalData.backTab) {
      this.setData({
        backTab: app.globalData.backTab,
        backLabel: app.globalData.backLabel || '返回'
      })
      app.globalData.backFor = ''
      app.globalData.backTab = ''
      app.globalData.backLabel = ''
    } else {
      this.setData({ backTab: '', backLabel: '' })
    }
    var book = shared.current()
    this.setData({
      sharedOn: shared.isJoined(),
      sharedMembers: (book && book.members) || 0
    })
    this.refresh()
  },

  /* 页面内的返回按钮：清掉跳转带过来的筛选，再回到来源页 */
  goBack: function () {
    var target = this.data.backTab
    var self = this
    this.setData({
      backTab: '', backLabel: '',
      kw: '', filterCat: '', filterDay: '', filterKind: '',
      onlyUncat: false,
      ym: format.ymOf(Date.now())
    }, function () { self.refresh() })
    if (!target) return
    var tabs = ['/pages/index/index', '/pages/list/list', '/pages/report/report']
    if (tabs.indexOf(target) >= 0) {
      wx.switchTab({ url: target })
    } else {
      wx.navigateTo({ url: target, fail: function () { wx.switchTab({ url: '/pages/index/index' }) } })
    }
  },

  refresh: function () {
    var ym = this.data.ym
    var kw = (this.data.kw || '').trim().toLowerCase()
    var searching = !!kw
    var txs = store.all()
    var refundOut = prefs.refundExcluded()

    /* 第一遍：把当前筛选条件下的记录先收成一个数组 */
    var filtered = []
    for (var i = 0; i < txs.length; i++) {
      var t = txs[i]
      /* 共同账本：切「只看我」时，别人记的直接跳过（自己记的记录没有 by 字段） */
      if (this.data.sharedOn && this.data.scope === 'mine' && !shared.isMine(t)) continue
      if (!searching && t.ym !== ym) continue
      if (searching) {
        var hay = [t.merchant, t.desc, t.note, t.category].join(' ').toLowerCase()
        if (hay.indexOf(kw) < 0) continue
      }
      if (this.data.filterDay && t.day !== this.data.filterDay) continue
      if (this.data.onlyUncat && !(t.type === 'expense' && t.category === '未分类')) continue
      if (this.data.filterCat && t.category !== this.data.filterCat) continue
      if (this.data.filterKind === 'expense' && t.type !== 'expense') continue
      if (this.data.filterKind === 'income' && !(t.type === 'income' || t.type === 'refund')) continue
      filtered.push(t)
    }

    /* 第二遍：抵消口径下把退款和它对应的那笔付款配对（规则见 utils/refundpair.js）
       —— 全额退款：退款行 + 付款行一起从列表里消失；
          部分退款：退款行消失，付款行金额改成扣完退款后的净额，并标一句「已退 ¥x」。
       退款行在任何视图下都不显示（从报表点进来、按分类筛选也一样）。

       配对的取材不看当前这屏的筛选：一律用「这个月的全部流水 + 上个月支出 + 下个月退款」。
       否则从报表点某个分类进来时，退款对应的付款被筛选挡掉，配对失败就会漏出退款行。 */
    var prevYm = monthBefore(ym)
    var nextYm = monthAfter(ym)
    var pairInput = []
    for (var ps = 0; ps < txs.length; ps++) {
      var pt = txs[ps]
      var inMonth = (pt.ym === ym)
      var borrowExp = (pt.ym === prevYm && pt.type === 'expense')
      var borrowRef = (pt.ym === nextYm && pt.type === 'refund')
      if (!inMonth && !borrowExp && !borrowRef) continue
      if (this.data.sharedOn && this.data.scope === 'mine' && !shared.isMine(pt)) continue
      pairInput.push(pt)
    }
    var pr = refundOut
      ? refundpair.pair(pairInput)
      : { hideId: {}, leftOf: {}, refundedOf: {}, pairs: [], unmatchedAmount: 0 }
    var skipId = pr.hideId

    /* 配上的付款如果不在这一屏（跨月、被分类筛选挡掉），这屏看不到那笔付款，
       金额只能从本屏支出合计里扣。只算「退款本身在这屏里」的那些配对：
       从报表点某个分类进来时，本屏一条退款都没有，就不该跟着扣别屏的钱。 */
    var inView = {}
    for (var iv = 0; iv < filtered.length; iv++) inView[filtered[iv].id] = true
    var crossAmount = 0
    for (var cq = 0; cq < pr.pairs.length; cq++) {
      var cpr = pr.pairs[cq]
      if (inView[cpr.refund.id] && !inView[cpr.expense.id]) {
        crossAmount = Math.round((crossAmount + cpr.amount) * 100) / 100
      }
    }

    var groups = []
    var cur = null
    var tExp = 0
    var tInc = 0
    var tCount = 0

    for (var m = 0; m < filtered.length; m++) {
      var tx = filtered[m]
      if (skipId[tx.id]) continue

      tCount++
      var netAmt = tx.amount
      if (tx.type === 'expense') {
        netAmt = (pr.leftOf[tx.id] === undefined) ? tx.amount : pr.leftOf[tx.id]
        tExp += netAmt
      }
      if (tx.type === 'income' || (tx.type === 'refund' && !refundOut)) tInc += tx.amount

      if (!cur || cur.day !== tx.day) {
        var parts = tx.day.split('-')
        cur = {
          day: tx.day,
          label: parseInt(parts[1], 10) + '月' + parseInt(parts[2], 10) + '日',
          items: [],
          spend: 0
        }
        groups.push(cur)
      }

      /* 谁记的：别人的记录带名字（有备注就显示备注）；自己的不挂，进账本页之前一律不挂 */
      var byNick = (this.data.sharedOn && tx.by && tx.byMe === false) ? String(tx.by) : ''
      var sign = '+'
      if (tx.type === 'transfer') sign = ''
      else if (tx.type === 'expense') sign = '-'
      var row = {
        id: tx.id,
        merchant: tx.merchant || '（没有商户名）',
        category: tx.category,
        amountText: format.money(netAmt),
        refundedText: pr.refundedOf[tx.id] ? format.money(pr.refundedOf[tx.id]) : '',
        timeText: format.pad(new Date(tx.time).getHours()) + ':' + format.pad(new Date(tx.time).getMinutes()),
        type: tx.type,
        sign: sign,
        color: category.colorOf(tx.category),
        icon: category.iconOf(tx.category),
        tint: category.tintOf(tx.category),
        isUncat: tx.category === '未分类',
        /* 行内也把说明带出来：账单里的「美团-机票」这种关键信息，藏在详情里等于没有 */
        desc: tx.desc || '',
        note: tx.note || '',
        /* 别人记的账挂个名字标签，显示成「小李 标记的」；自己记的不挂 */
        by: byNick,
        byLabel: byNick ? shared.labelOf(byNick) : ''
      }
      cur.items.push(row)
      if (tx.type === 'expense') cur.spend += netAmt
    }

    /* 合并后合计仍要准确：付款不在这屏的退款，以及极端情况下整本账都找不到支出的退款，
       都从本屏支出里扣掉 */
    tExp -= (crossAmount + pr.unmatchedAmount)

    var note = ''
    /* 只有「整月视图」才给这句配对汇总；从报表点分类/搜关键词进来时，配对整个月发生，
       写在筛选结果上面会让人以为被筛掉的也在这一屏 */
    var plainView = !searching && !this.data.filterCat && !this.data.filterDay &&
      !this.data.filterKind && !this.data.onlyUncat
    if (plainView && refundOut) {
      var fullCnt = 0
      var partCnt = 0
      for (var q = 0; q < filtered.length; q++) {
        var et = filtered[q]
        if (et.type !== 'expense' || !pr.refundedOf[et.id]) continue
        if (pr.refundedOf[et.id] >= et.amount - 0.01) fullCnt++
        else partCnt++
      }
      if (fullCnt > 0 && partCnt > 0) {
        note = '退款已配对：' + fullCnt + ' 组全额退款连付款一起剔除，' + partCnt + ' 笔部分退款并进付款按净额显示'
      } else if (fullCnt > 0) {
        note = fullCnt + ' 组全额退款已连对应的付款一起剔除'
      } else if (partCnt > 0) {
        note = partCnt + ' 笔退款已并进对应的付款，按净额显示'
      }
      if (pr.unmatchedAmount > 0.005) {
        note += (note ? '；' : '') + '另有 ¥' + format.money(pr.unmatchedAmount) + ' 退款没配上付款，留在列表里、已从支出里扣'
      }
    }

    groups.forEach(function (g) {
      g.spendText = format.money(Math.max(g.spend, 0))
    })

    this.setData({
      monthText: searching ? '全部流水' : format.monthLabel(ym),
      canNext: ym < format.ymOf(Date.now()),
      searching: searching,
      groups: groups,
      refundNote: note,
      s: {
        expenseText: format.money(Math.max(tExp, 0)),
        incomeText: format.money(tInc),
        count: tCount
      }
    })
  },

  onSearch: function (e) {
    var self = this
    this.setData({ kw: e.detail.value }, function () { self.refresh() })
  },

  clearKw: function () {
    var self = this
    this.setData({ kw: '' }, function () { self.refresh() })
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

  toggleUncat: function () {
    var self = this
    this.setData({ onlyUncat: !this.data.onlyUncat }, function () { self.refresh() })
  },

  /* 共同账本：全部 / 只看我 */
  setScope: function (e) {
    var v = e.currentTarget.dataset.k === 'mine' ? 'mine' : 'all'
    if (v === this.data.scope) return
    var self = this
    this.setData({ scope: v }, function () { self.refresh() })
  },

  clearFilter: function () {
    var self = this
    this.setData({ filterCat: '', filterKind: '', filterDay: '' }, function () { self.refresh() })
  },

  openSheet: function (e) {
    var id = e.currentTarget.dataset.id
    var txs = store.all()
    var tx = null
    for (var i = 0; i < txs.length; i++) {
      if (txs[i].id === id) { tx = txs[i]; break }
    }
    if (!tx) return
    var cats = category.catsOf(tx.type).slice(0)
    if (tx.type !== 'transfer' && cats.indexOf('未分类') < 0) cats.push('未分类')

    var d = new Date(tx.time)
    var wk = '日一二三四五六'.charAt(d.getDay())
    var dirMap = {
      expense: { t: '支出', cls: 'exp' },
      income: { t: '收入', cls: 'inc' },
      refund: { t: '退款', cls: 'inc' },
      transfer: { t: '不计收支', cls: 'muted' }
    }
    var dir = dirMap[tx.type] || dirMap.expense

    /* 分类依据：重跑一遍规则，顺手把命中的词也拿回来。
     * 只有重算结果和库里存的类目一致时才敢展示——否则说明当初是别的来源（比如平台分类、AI）定的。 */
    var why = ''
    if (tx.category === '未分类') {
      why = '规则和词库都没认出来'
    } else {
      var calc = category.classify(tx.merchant || '', tx.desc || '', '', store.rules(), tx.type)
      if (calc.cat === tx.category) {
        if (calc.by === 'platform-sub') why = '平台细分：说明里「' + calc.kw + '」→ ' + calc.cat
        else if (calc.by === 'platform-name') why = calc.plat + ' 默认类目（说明里没线索）'
        else if (calc.by === 'builtin') why = calc.kw ? '词库命中「' + calc.kw + '」' : '硬规则（学费 / 税费）'
        else if (calc.by === 'user') why = '你改过这个商户 / 之前学过「' + (calc.kw || tx.merchant || '这个商户') + '」'
        else if (calc.by === 'kind') why = tx.type === 'transfer'
          ? '钱在自己账户之间搬，不计收支（' + calc.cat + '）'
          : '退款固定归「退款」'
        else if (calc.by === 'biz') why = '公司名里有「' + calc.kw + '」'
      } else if (tx.byPlatform === 'platform') {
        why = '导入时按平台的分类定的（' + (tx.source || '平台') + '自己标的）'
      }
    }

    this.setData({
      sheetVisible: true,
      catMode: false,
      sheetItem: {
        id: tx.id,
        merchant: tx.merchant || '（没有商户名）',
        amountText: format.money(tx.amount),
        sign: (tx.type === 'income' || tx.type === 'refund') ? '+' : (tx.type === 'transfer' ? '' : '-'),
        dirText: dir.t,
        dirClass: dir.cls,
        category: tx.category,
        icon: category.iconOf(tx.category),
        color: category.colorOf(tx.category),
        dateText: d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 周' + wk,
        timeText: format.pad(d.getHours()) + ':' + format.pad(d.getMinutes()),
        desc: tx.desc || '',
        note: tx.note || '',
        /* 这笔谁记的：带原始昵称（改备注用）和显示名 */
        byNick: (tx.by && tx.byMe === false) ? String(tx.by) : '',
        byLabel: (tx.by && tx.byMe === false) ? shared.labelOf(tx.by) : '',
        status: tx.status || '',
        account: tx.account || '',
        source: tx.source || '',
        why: why
      },
      sheetCats: cats
    })
  },

  closeSheet: function () {
    this.setData({ sheetVisible: false, sheetItem: null, catMode: false })
  },

  /* 默认先看明细，点「改分类」才展开类目清单，别一上来甩 21 个选项 */
  toggleCatMode: function () {
    this.setData({ catMode: !this.data.catMode })
  },

  editNote: function () {
    var item = this.data.sheetItem
    if (!item) return
    var self = this
    wx.showModal({
      title: '这笔的备注',
      editable: true,
      placeholderText: '比如「和室友 AA」「报销用」',
      content: item.note || '',
      success: function (res) {
        if (!res.confirm) return
        var v = String(res.content || '').trim()
        store.update(item.id, { note: v })
        self.setData({ 'sheetItem.note': v })
        self.refresh()
        wx.showToast({ title: v ? '备注已保存' : '备注已清空', icon: 'none' })
      }
    })
  },

  /* 给记这笔的人起备注：改完这一本账里他记的都会一起改成新名字 */
  editByRemark: function () {
    var item = this.data.sheetItem
    if (!item || !item.byNick) return
    var self = this
    var nick = item.byNick
    var cur = shared.remarkOf(nick)
    wx.showModal({
      title: '他叫什么（你自己看的名字）',
      editable: true,
      placeholderText: '比如「妹妹」「室友老张」，留空恢复原名',
      content: cur,
      success: function (res) {
        if (!res.confirm) return
        var v = shared.setRemark(nick, res.content)
        self.setData({
          'sheetItem.byLabel': shared.labelOf(nick)
        })
        self.refresh()
        wx.showToast({ title: v ? '备注已保存' : '已恢复原名', icon: 'none' })
      }
    })
  },

  pickCat: function (e) {
    var cat = e.currentTarget.dataset.cat
    var item = this.data.sheetItem
    if (!item) return
    var txs = store.all()
    var tx = null
    for (var i = 0; i < txs.length; i++) {
      if (txs[i].id === item.id) { tx = txs[i]; break }
    }
    if (!tx) return
    store.update(item.id, { category: cat })
    store.learn(tx.merchant, cat)
    this.setData({ sheetVisible: false, sheetItem: null, catMode: false })
    this.refresh()
    wx.showToast({ title: '已改成「' + cat + '」', icon: 'none' })
    this.offerBatch(tx, cat)
  },

  /* 改完一笔，顺手问一句：这个商户之前的账要不要一起改？
   * 不然同一个商户错 20 笔，就得点 20 次。 */
  offerBatch: function (tx, cat) {
    var name = String(tx.merchant || '').trim()
    if (!name || name.length < 2) return
    var income = tx.type === 'income' || tx.type === 'refund'
    var ids = []
    var all = store.all()
    for (var i = 0; i < all.length; i++) {
      var t = all[i]
      if (t.id === tx.id) continue
      if (String(t.merchant || '').trim() !== name) continue
      if ((t.type === 'income' || t.type === 'refund') !== income) continue
      if (t.category === cat) continue
      ids.push(t.id)
    }
    if (!ids.length) return
    var self = this
    /* toast 先让一眼看完再弹窗，两个一起出来会互相盖住 */
    setTimeout(function () {
      wx.showModal({
        title: '一起改「' + name + '」？',
        content: '这个商户还有 ' + ids.length + ' 笔不是「' + cat + '」，要一起改成「' + cat + '」吗',
        confirmText: '一起改',
        success: function (res) {
          if (!res.confirm) return
          var n = store.relabel(ids, cat)
          self.refresh()
          wx.showToast({ title: '又改了 ' + n + ' 笔', icon: 'none' })
        }
      })
    }, 260)
  },

  onLongPress: function (e) {
    var id = e.currentTarget.dataset.id
    var self = this
    wx.showModal({
      title: '删除这笔？',
      content: '删了就找不回来了',
      confirmText: '删除',
      confirmColor: '#d9433f',
      success: function (res) {
        if (!res.confirm) return
        store.remove(id)
        self.refresh()
      }
    })
  },

  /* 弹窗里直接删这笔（不靠长按，长按很多人不知道） */
  deleteSheetItem: function () {
    var item = this.data.sheetItem
    if (!item) return
    var self = this
    wx.showModal({
      title: '删除这笔？',
      content: item.merchant + ' ¥' + item.amountText + '\n删了就找不回来了',
      confirmText: '删除',
      confirmColor: '#d9433f',
      success: function (res) {
        if (!res.confirm) return
        store.remove(item.id)
        self.setData({ sheetVisible: false, sheetItem: null, catMode: false })
        self.refresh()
        wx.showToast({ title: '已删除', icon: 'none' })
      }
    })
  },

  /* 工具栏「⋯」：会员 / 退款口径 / 删本月 / 清空全部 */
  moreActions: function () {
    var self = this
    var ym = this.data.ym
    var vipItem = vip.isVip()
      ? '会员（已开通 · 至 ' + vip.dateText(vip.expireAt()) + '）'
      : '会员 · 输入卡密开通'
    var refundItem = prefs.refundExcluded()
      ? '退款：抵消支出（点一下改成计入）'
      : '退款：计入入账（点一下改成抵消）'
    wx.showActionSheet({
      itemList: [vipItem, refundItem, '删除 ' + format.monthLabel(ym) + ' 的全部流水', '清空全部数据（含分类规则）'],
      success: function (res) {
        if (res.tapIndex === 0) self.goVip()
        else if (res.tapIndex === 1) self.toggleRefund()
        else if (res.tapIndex === 2) self.clearMonth()
        else if (res.tapIndex === 3) self.clearEverything()
      }
    })
  },

  /* 退款怎么算：一键切，切完本页立刻按新口径重算；
   * 首页、总览、报表读同一个开关，切回去看也是新数字。
   * 默认「抵消」：退款不进收入、同时把支出扣回去；另一种是退款算入账、支出按原价。 */
  toggleRefund: function () {
    var next = prefs.setRefundExcluded(!prefs.refundExcluded())
    this.refresh()
    wx.showToast({
      title: next ? '退款已抵消，支出同步减少' : '退款已计入入账',
      icon: 'none'
    })
  },

  goVip: function () {
    wx.navigateTo({ url: '/pages/vip/vip' })
  },

  clearMonth: function () {
    var self = this
    var ym = this.data.ym
    var n = 0
    store.all().forEach(function (t) { if (t.ym === ym) n++ })
    if (!n) { wx.showToast({ title: '这个月本来就没数据', icon: 'none' }); return }
    wx.showModal({
      title: '删除 ' + format.monthLabel(ym) + ' 的流水？',
      content: '这个月共 ' + n + ' 笔，删了找不回来；其他月份不受影响。',
      confirmText: '删除',
      confirmColor: '#d9433f',
      success: function (res) {
        if (!res.confirm) return
        var removed = store.removeMonth(ym)
        self.refresh()
        wx.showToast({ title: '已删除 ' + removed + ' 笔', icon: 'none' })
      }
    })
  },

  clearEverything: function () {
    var self = this
    var n = store.all().length
    wx.showModal({
      title: '清空全部数据？',
      content: '库里 ' + n + ' 笔流水、学到的分类规则、月度预算会一起清零，找不回来。建议先去「导入」页把两份账单原件重新导一遍，再回来清。',
      confirmText: '全部清空',
      confirmColor: '#d9433f',
      success: function (res) {
        if (!res.confirm) return
        store.clearAll()
        self.setData({ onlyUncat: false, filterCat: '', filterKind: '', filterDay: '', kw: '' })
        self.refresh()
        wx.showToast({ title: '已清空', icon: 'none' })
      }
    })
  },

  noop: function () {},

  goImport: function () {
    wx.navigateTo({ url: '/pages/import/import' })
  }
})
