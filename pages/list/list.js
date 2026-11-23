var format = require('../../utils/format')
var store = require('../../utils/store')
var stats = require('../../utils/stats')
var category = require('../../utils/category')
var vip = require('../../utils/vip')
var shared = require('../../utils/shared')
var prefs = require('../../utils/prefs')

var theme = require('../../utils/theme')
var darkmode = require('../../utils/darkmode')

Page({
  data: {
    themeKey: 'green',
    dark: false,
    maxYm: '',
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
    /* 共同账本：只有加入了才显示「谁记的」和视角切换 */
    sharedOn: false,
    sharedMembers: 0,
    /* 视角：mine 只看自己 / both 看双方 / peer 只看对方，默认看双方 */
    scope: 'both'
  },

  onLoad: function () {
    var self = this
    this.setData({ ym: format.ymOf(Date.now()), maxYm: format.ymOf(Date.now()), dark: darkmode.isDark() })
    this._unwatchDark = darkmode.watch(function (dark) {
      self.setData({ dark: dark })
      if (self._visible) theme.syncTabBar()
    })
  },

  onShow: function () {
    this._visible = true
    this.setData({ themeKey: theme.get().key, dark: darkmode.isDark(), maxYm: format.ymOf(Date.now()) })
    theme.syncTabBar()
    var app = getApp()
    var g = app.globalData
    var jumped = !!(g.filterUncat || g.filterCat || g.filterKind || g.filterYm || g.filterDay ||
      (g.backFor === '/pages/list/list' && g.backTab))
    if (jumped) this.setData({
      onlyUncat: !!g.filterUncat, filterCat: g.filterCat || '', filterKind: g.filterKind || '',
      filterDay: g.filterDay || '', ym: g.filterYm || format.ymOf(Date.now()), kw: ''
    })
    app.globalData.filterUncat = false
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
    var sharedOn = shared.isJoined()
    this.setData({
      sharedOn: sharedOn,
      sharedMembers: (book && book.members) || 0,
      /* 视角是跟着手机走的偏好，别的页面切换过这里也要跟上 */
      scope: sharedOn ? prefs.viewScope() : 'both'
    })
    this.refresh()
    if (g.openTxId) {
      var id = g.openTxId
      g.openTxId = ''
      this.openSheet({ currentTarget: { dataset: { id: id } } })
    }
  },

  pickMonth: function (e) {
    var ym = String(e.detail.value || '')
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym) || ym > format.ymOf(Date.now())) return
    this.setData({ ym: ym, filterDay: '', kw: '' })
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
    var tabs = ['/pages/home/home', '/pages/index/index', '/pages/list/list', '/pages/report/report']
    if (tabs.indexOf(target) >= 0) {
      wx.switchTab({ url: target })
    } else {
      wx.navigateTo({ url: target, fail: function () { wx.switchTab({ url: '/pages/home/home' }) } })
    }
  },

  refresh: function () {
    var ym = this.data.ym
    var kw = (this.data.kw || '').trim().toLowerCase()
    var searching = !!kw
    clearTimeout(this._searchTimer)
    var refundOut = prefs.refundExcluded()
    var scope = this.data.sharedOn ? this.data.scope : 'both'
    var raw = shared.viewRows(store.all(), scope)
    var txs = stats.ledger(raw, refundOut)

    /* 第一遍：把当前筛选条件下的记录先收成一个数组 */
    var filtered = []
    for (var i = 0; i < txs.length; i++) {
      var t = txs[i]
      if (!searching && t.ym !== ym) continue
      if (searching) {
        var hay = [t.merchant, t.originalMerchant, t.desc, t.note, t.category, t.originalCategory].join(' ').toLowerCase()
        if (hay.indexOf(kw) < 0) continue
      }
      if (this.data.filterDay && t.day !== this.data.filterDay) continue
      if (this.data.onlyUncat && !(t.type === 'expense' && !t.refundAdjustment && t.category === '未分类')) continue
      if (this.data.filterCat && t.category !== this.data.filterCat) continue
      if (this.data.filterKind === 'expense' && t.type !== 'expense') continue
      if (this.data.filterKind === 'income' && !(t.type === 'income' || t.type === 'refund')) continue
      filtered.push(t)
    }

    filtered.sort(function (a, b) { return b.time - a.time })
    var total = stats.totals(filtered)
    var groups = []
    var dayMap = Object.create(null)

    for (var m = 0; m < filtered.length; m++) {
      var tx = filtered[m]
      var cur = dayMap[tx.day]
      if (!cur) {
        var parts = tx.day.split('-')
        cur = {
          day: tx.day,
          label: parseInt(parts[1], 10) + '月' + parseInt(parts[2], 10) + '日',
          items: [],
          spend: 0,
          refund: 0
        }
        groups.push(cur)
        dayMap[tx.day] = cur
      }
      if (tx.type === 'expense') cur.spend += Math.round(tx.amount * 100)
      if (tx.refundAdjustment) { cur.refund += Math.round(-tx.amount * 100); continue }

      /* 谁记的：别人的记录带名字（有备注就显示备注）；自己的不挂，进账本页之前一律不挂 */
      var byNick = (this.data.sharedOn && tx.by && tx.byMe === false) ? String(tx.by) : ''
      var sign = '+'
      if (tx.type === 'transfer') sign = ''
      else if (tx.type === 'expense') sign = '-'
      var row = {
        id: tx.id,
        merchant: tx.merchant || '（没有商户名）',
        category: tx.category,
        amountText: format.money(tx.amount),
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
        byLabel: byNick ? shared.labelOf(byNick, tx.ownerKey) : ''
      }
      cur.items.push(row)
    }

    var note = total.refundAdjustment > 0
      ? '付款 ¥' + format.money(total.expense + total.refundAdjustment) +
        ' − 退款 ¥' + format.money(total.refundAdjustment) + ' = 净支出 ¥' + format.signedMoney(total.expense) +
        ' · 退款按到账日计，笔数含退款'
      : ''
    var plainView = !searching && !this.data.filterCat && !this.data.filterDay &&
      !this.data.filterKind && !this.data.onlyUncat

    /* 看双方时最常见的困惑：「同步成功了、账本里也有，可这个月流水里一条对方的都没有」。
       对方的账多半记在别的月份（流水默认只看本月），这里直接说清楚，别让人以为是同步丢了。 */
    if (plainView && this.data.sharedOn && scope !== 'mine') {
      var peerAll = 0
      var peerThisMonth = 0
      for (var pa = 0; pa < raw.length; pa++) {
        if (shared.isMine(raw[pa])) continue
        peerAll++
        if (raw[pa].ym === ym) peerThisMonth++
      }
      if (peerAll > 0 && peerThisMonth === 0) {
        note += (note ? '；' : '') + '对方记的 ' + peerAll + ' 笔都在别的月份，用上面的 ‹ › 翻一下就能看到'
      }
    }

    groups.sort(function (a, b) { return a.day < b.day ? 1 : (a.day > b.day ? -1 : 0) })
    groups.forEach(function (g) {
      g.spendText = format.signedMoney(g.spend / 100)
      g.refundText = g.refund ? format.money(g.refund / 100) : ''
    })

    this.setData({
      monthText: searching ? '全部流水' : format.monthLabel(ym),
      canNext: ym < format.ymOf(Date.now()),
      searching: searching,
      groups: groups,
      refundNote: note,
      s: {
        expenseText: format.signedMoney(total.expense),
        incomeText: format.money(total.income),
        count: total.count,
        refundOut: refundOut
      }
    })
  },

  onSearch: function (e) {
    var self = this
    clearTimeout(this._searchTimer)
    this.setData({ kw: e.detail.value })
    this._searchTimer = setTimeout(function () { self.refresh() }, 180)
  },

  onHide: function () {
    this._visible = false
    clearTimeout(this._searchTimer)
  },

  onUnload: function () {
    clearTimeout(this._searchTimer)
    if (this._unwatchDark) this._unwatchDark()
  },

  clearKw: function () {
    var self = this
    this.setData({ kw: '' }, function () { self.refresh() })
  },

  prevMonth: function () {
    var self = this
    this.setData({ ym: format.shiftMonth(this.data.ym, -1), filterDay: '' }, function () { self.refresh() })
  },

  nextMonth: function () {
    if (!this.data.canNext) return
    var self = this
    this.setData({ ym: format.shiftMonth(this.data.ym, 1), filterDay: '' }, function () { self.refresh() })
  },

  toggleUncat: function () {
    var self = this
    this.setData({ onlyUncat: !this.data.onlyUncat }, function () { self.refresh() })
  },

  /* 共同账本：只看自己 / 看双方 / 只看对方 —— 切换后记进本机偏好，报表和首页跟着一起变 */
  setScope: function (e) {
    var k = e.currentTarget.dataset.k
    var v = (k === 'mine' || k === 'peer') ? k : 'both'
    prefs.setViewScope(v)
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
        canEdit: store.canEdit(tx),
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
        byLabel: (tx.by && tx.byMe === false) ? shared.labelOf(tx.by, tx.ownerKey) : '',
        ownerKey: tx.ownerKey || '',
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

  editableTx: function (id) {
    var all = store.all()
    for (var i = 0; i < all.length; i++) {
      if (all[i].id !== id) continue
      if (store.canEdit(all[i])) return all[i]
      wx.showToast({ title: '只能修改或删除自己记的账', icon: 'none' })
      return null
    }
    return null
  },

  /* 默认先看明细，点「改分类」才展开类目清单，别一上来甩 21 个选项 */
  toggleCatMode: function () {
    var item = this.data.sheetItem
    if (!item || !this.editableTx(item.id)) return
    this.setData({ catMode: !this.data.catMode })
  },

  editNote: function () {
    var item = this.data.sheetItem
    if (!item || !this.editableTx(item.id)) return
    var self = this
    wx.showModal({
      title: '这笔的备注',
      editable: true,
      placeholderText: '比如「和室友 AA」「报销用」',
      content: item.note || '',
      success: function (res) {
        if (!res.confirm || !self.editableTx(item.id)) return
        var v = String(res.content || '').trim()
        if (store.update(item.id, { note: v }) === null) return
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
    var cur = shared.remarkOf(nick, item.ownerKey)
    wx.showModal({
      title: '他叫什么（你自己看的名字）',
      editable: true,
      placeholderText: '比如「妹妹」「室友老张」，留空恢复原名',
      content: cur,
      success: function (res) {
        if (!res.confirm) return
        var v = shared.setRemark(nick, res.content, item.ownerKey)
        if (v === null) { wx.showToast({ title: '个人备注未保存，请重试', icon: 'none' }); return }
        self.setData({
          'sheetItem.byLabel': shared.labelOf(nick, item.ownerKey)
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
    var tx = this.editableTx(item.id)
    if (!tx) return
    if (store.update(item.id, { category: cat }) === null) return
    var learned = store.learn(tx.merchant, cat)
    this.setData({ sheetVisible: false, sheetItem: null, catMode: false })
    this.refresh()
    if (learned === false) {
      wx.showModal({
        title: '本笔分类已保存',
        content: '这笔已改成「' + cat + '」，但分类规则未保存，后续导入不会应用这次规则。可稍后再修改分类来学习规则。',
        showCancel: false
      })
      return
    }
    wx.showToast({ title: '已改成「' + cat + '」', icon: 'none' })
    this.offerBatch(tx, cat)
  },

  /* 改完一笔，顺手问一句：这个商户之前的账要不要一起改？
   * 不然同一个商户错 20 笔，就得点 20 次。 */
  offerBatch: function (tx, cat) {
    if (!tx || !store.canEdit(tx)) return
    var name = String(tx.merchant || '').trim()
    if (!name || name.length < 2) return
    var income = tx.type === 'income' || tx.type === 'refund'
    var ids = []
    var all = store.all()
    for (var i = 0; i < all.length; i++) {
      var t = all[i]
      if (t.id === tx.id || !store.canEdit(t)) continue
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
        content: '你自己记的这个商户还有 ' + ids.length + ' 笔不是「' + cat + '」，要一起改成「' + cat + '」吗？不会修改其他成员的记录。',
        confirmText: '一起改',
        success: function (res) {
          if (!res.confirm) return
          var n = store.relabel(ids, cat)
          if (n === null) return
          self.refresh()
          wx.showToast({ title: '又改了 ' + n + ' 笔', icon: 'none' })
        }
      })
    }, 260)
  },

  onLongPress: function (e) {
    var id = e.currentTarget.dataset.id
    if (!this.editableTx(id)) return
    var self = this
    wx.showModal({
      title: '删除这笔？',
      content: '删了就找不回来了；本人已共享记录的云端删除将在下次同步时提交。',
      confirmText: '删除',
      confirmColor: '#d9433f',
      success: function (res) {
        if (!res.confirm || !self.editableTx(id)) return
        if (store.remove(id) === false) return
        self.refresh()
      }
    })
  },

  /* 弹窗里直接删这笔（不靠长按，长按很多人不知道） */
  deleteSheetItem: function () {
    var item = this.data.sheetItem
    if (!item || !this.editableTx(item.id)) return
    var self = this
    wx.showModal({
      title: '删除这笔？',
      content: item.merchant + ' ¥' + item.amountText + '\n删了就找不回来了；本人已共享记录的云端删除将在下次同步时提交。',
      confirmText: '删除',
      confirmColor: '#d9433f',
      success: function (res) {
        if (!res.confirm || !self.editableTx(item.id)) return
        if (store.remove(item.id) === false) return
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
      itemList: [vipItem, refundItem, '删除 ' + format.monthLabel(ym) + ' 的本人流水', '清空全部数据（含分类规则）'],
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

  goShare: function () {
    wx.navigateTo({ url: '/pages/share/share' })
  },

  goVip: function () {
    wx.navigateTo({ url: '/pages/vip/vip' })
  },

  clearMonth: function () {
    var self = this
    var ym = this.data.ym
    var n = 0
    store.all().forEach(function (t) { if (t.ym === ym && store.canEdit(t)) n++ })
    if (!n) { wx.showToast({ title: '这个月没有本人可删除的流水', icon: 'none' }); return }
    wx.showModal({
      title: '删除 ' + format.monthLabel(ym) + ' 的本人流水？',
      content: '这个月你自己记的共 ' + n + ' 笔，删了找不回来；其他成员和其他月份的记录不受影响。本人已共享记录的云端删除将在下次同步时提交。建议先导出备份。',
      confirmText: '删除',
      confirmColor: '#d9433f',
      success: function (res) {
        if (!res.confirm) return
        var removed = store.removeMonth(ym)
        if (removed === null) return
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
      content: '本机 ' + n + ' 笔流水、分类规则和预算会清空，不能恢复。你自己已共享的记录会在下次同步时从云端删除；其他成员的记录只清除本机副本，不删除对方云端记录，本机清除标记保留期间不会重新拉回。无法远程擦除成员已保存的本机副本。建议先去「报表 → 数据工具」导出备份。',
      confirmText: '全部清空',
      confirmColor: '#d9433f',
      success: function (res) {
        if (!res.confirm) return
        if (store.clearAll() === false) return
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
