// pages/settlement/settlement —— 共同账本结算（只读本机已同步数据）
var settlement = require('../../utils/settlement')
var settlementState = require('../../utils/settlement-state')
var shared = require('../../utils/shared')
var store = require('../../utils/store')
var prefs = require('../../utils/prefs')
var format = require('../../utils/format')
var theme = require('../../utils/theme')
var darkmode = require('../../utils/darkmode')
var category = require('../../utils/category')

var MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

/* 直接按整数分拼金额，避免极端金额经过浮点除法再丢失分。 */
function money(cents, signed) {
  var value = Number(cents) || 0
  var negative = value < 0
  var abs = Math.abs(value)
  var whole = Math.floor(abs / 100)
  var fraction = String(abs % 100)
  if (fraction.length < 2) fraction = '0' + fraction
  var text = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + fraction
  return (negative ? '-' : (signed && value > 0 ? '+' : '')) + text
}

function syncText(time) {
  var ms = Number(time) || 0
  if (!ms) return '还没同步过'
  var d = new Date(ms)
  if (isNaN(d.getTime())) return '还没同步过'
  return format.pad(d.getMonth() + 1) + '-' + format.pad(d.getDate()) + ' ' +
    format.pad(d.getHours()) + ':' + format.pad(d.getMinutes())
}

function historyTime(time) {
  var d = new Date(time)
  if (isNaN(d.getTime())) return ''
  return format.dayOf(time) + ' ' + format.pad(d.getHours()) + ':' + format.pad(d.getMinutes())
}

function toast(title) {
  if (wx.showToast) wx.showToast({ title: title, icon: 'none', duration: 2200 })
}

function emptyLocalState() {
  return {
    weightEditing: false, weights: {}, weightModeText: '平均分摊', weightWarnings: '',
    categoryEditing: false, categoryOptions: [], categoryIndex: 0, categoryName: '',
    categoryInputs: [], categoryWeights: {}, categoryWarnings: '', categories: [],
    templates: [], templateName: '', templateIndex: -1, templateId: '',
    history: [], historyCount: 0, settledCount: 0, pendingCount: 0
  }
}

function weightSummary(weights, members) {
  var parts = []
  members.forEach(function (member) {
    var value = Object.prototype.hasOwnProperty.call(weights, member.ownerKey) ? weights[member.ownerKey] : 1
    parts.push(member.name + ' ' + value)
  })
  return parts.join(' / ')
}

function categoryInputsOf(name, weights, defaultWeights, members) {
  var override = weights[name] || {}
  return members.map(function (member) {
    var value = Object.prototype.hasOwnProperty.call(override, member.ownerKey)
      ? override[member.ownerKey]
      : (Object.prototype.hasOwnProperty.call(defaultWeights, member.ownerKey) ? defaultWeights[member.ownerKey] : 1)
    return { ownerKey: member.ownerKey, name: member.name, weightText: String(value) }
  })
}

Page({
  data: {
    themeKey: 'green',
    dark: false,
    joined: false,
    bookName: '',
    ym: '',
    monthText: '',
    maxYm: '',
    canNext: false,
    memberCount: 0,
    members: [],
    transfers: [],
    hasData: false,
    emptyText: '',
    expenseText: '0.00',
    refundText: '0.00',
    totalText: '0.00',
    myBalanceText: '0.00',
    myBalanceLabel: '已结清',
    myBalanceClass: '',
    preferenceText: '',
    lastSyncText: '还没同步过',
    ignored: 0,
    weightEditing: false,
    weights: {},
    weightModeText: '平均分摊',
    weightWarnings: '',
    categoryEditing: false,
    categoryOptions: [],
    categoryIndex: 0,
    categoryName: '',
    categoryInputs: [],
    categoryWeights: {},
    categoryWarnings: '',
    categories: [],
    templates: [],
    templateName: '',
    templateIndex: -1,
    templateId: '',
    history: [],
    historyCount: 0,
    settledCount: 0,
    pendingCount: 0
  },

  onLoad: function () {
    var self = this
    this._unloaded = false
    this.setData({ ym: format.ymOf(Date.now()), maxYm: format.ymOf(Date.now()), dark: darkmode.isDark() })
    this._unwatchDark = darkmode.watch(function (dark) {
      if (!self._unloaded) self.setData({ dark: dark })
    })
  },

  onShow: function () {
    this._visible = true
    this.setData({ themeKey: theme.get().key, dark: darkmode.isDark() })
    this.refresh()
  },

  onHide: function () { this._visible = false },

  onUnload: function () {
    this._unloaded = true
    this._visible = false
    if (this._unwatchDark) this._unwatchDark()
  },

  refresh: function () {
    if (this._unloaded) return
    var book = shared.current() || {}
    var ym = this.data.ym
    var nowYm = format.ymOf(Date.now())
    var base = {
      joined: !!book.bookId,
      bookName: book.name || '共同账本',
      monthText: MONTH_RE.test(ym) ? format.monthLabel(ym) : '',
      maxYm: nowYm,
      canNext: MONTH_RE.test(ym) && ym < nowYm,
      lastSyncText: syncText(book.lastSync),
      preferenceText: '流水页当前为「' + prefs.viewScopeLabel(prefs.viewScope()) + '」'
    }
    if (!book.bookId) {
      this.setData(Object.assign(base, emptyLocalState(), {
        members: [], transfers: [], memberCount: 0, hasData: false,
        emptyText: '还没有加入共同账本，加入后即可查看成员分摊与结算建议。',
        expenseText: '0.00', refundText: '0.00', totalText: '0.00',
        myBalanceText: '0.00', myBalanceLabel: '未加入', myBalanceClass: '', ignored: 0
      }))
      return
    }

    var rawMembers = Array.isArray(book.memberList) ? book.memberList : []
    if (!rawMembers.length) {
      this.setData(Object.assign(base, emptyLocalState(), {
        members: [], transfers: [], memberCount: 0, hasData: false,
        emptyText: '成员名单尚未同步，请先到共同账本页同步后再查看结算。',
        expenseText: '0.00', refundText: '0.00', totalText: '0.00',
        myBalanceText: '0.00', myBalanceLabel: '待同步', myBalanceClass: '', ignored: 0
      }))
      return
    }

    /* 结算必须覆盖双方已同步流水；流水页的 mine/peer 偏好只影响查看，不改变分摊口径。 */
    var txs = shared.viewRows(store.all(), 'both')
    var localState = settlementState.load(book.bookId, ym)
    var weights = localState.weights || {}
    var categoryWeights = localState.categoryWeights || {}
    var result = settlement.calculate(txs, rawMembers, { ym: ym, weights: weights, categoryWeights: categoryWeights })
    var settledIds = Object.create(null)
    localState.settled.forEach(function (item) {
      settledIds[JSON.stringify([item.from, item.to, item.amount])] = true
    })
    var labels = Object.create(null)
    rawMembers.forEach(function (member) {
      if (!member || !member.ownerKey) return
      var nick = member.nickname || '成员'
      labels[member.ownerKey] = shared.labelOf(nick, member.ownerKey)
    })
    if (result.members.length) {
      var me = result.members.filter(function (member) { return member.isMe })[0]
      if (me) labels[me.ownerKey] += '（我）'
    }

    var members = result.members.map(function (member) {
      var pct = result.expense > 0 ? Math.round(member.expense / result.expense * 1000) / 10 : 0
      var balanceClass = member.balance < 0 ? 'due' : (member.balance > 0 ? 'receive' : '')
      var balanceLabel = member.balance < 0 ? '应付 ' : (member.balance > 0 ? '应收 ' : '已结清')
      return {
        ownerKey: member.ownerKey,
        name: labels[member.ownerKey] || member.name,
        isMe: member.isMe,
        initial: String(labels[member.ownerKey] || member.name || '成').slice(0, 1),
        expenseText: money(member.expense),
        refundText: money(member.refund),
        paidText: money(member.paid, true),
        paidNegative: member.paid < 0,
        shareText: money(member.share),
        balanceText: money(Math.abs(member.balance)),
        balanceLabel: balanceLabel + (member.balance ? '¥' + money(Math.abs(member.balance)) : ''),
        balanceClass: balanceClass,
        pct: pct,
        pctText: pct + '%',
        hasRefund: member.refund > 0,
        weightText: Object.prototype.hasOwnProperty.call(weights, member.ownerKey) ? String(weights[member.ownerKey]) : (result.splitMode === 'weighted' ? '0' : '1')
      }
    })
    var transfers = result.transfers.map(function (item) {
      var settled = !!settledIds[JSON.stringify([item.from, item.to, item.amount])]
      return {
        from: item.from,
        to: item.to,
        fromName: labels[item.from] || '成员',
        toName: labels[item.to] || '成员',
        amount: item.amount,
        amountText: money(item.amount),
        settled: settled,
        statusText: settled ? '已结清' : '待结清',
        actionText: settled ? '取消已结清' : '标记已结清'
      }
    })
    var settledCount = transfers.filter(function (item) { return item.settled }).length
    var historyRows = settlementState.history(book.bookId, 100).map(function (item) {
      return {
        timeText: historyTime(item.time),
        monthText: format.monthLabel(item.ym),
        fromName: item.fromName || labels[item.from] || item.from,
        toName: item.toName || labels[item.to] || item.to,
        amountText: money(item.amount),
        action: item.action,
        actionText: item.action === 'settle' ? '标记已结清' : '取消已结清',
        actionClass: item.action === 'settle' ? 'receive' : 'due'
      }
    })
    var me = result.members.filter(function (member) { return member.isMe })[0]
    var myBalance = me ? me.balance : 0
    var categoryNames = category.catsOf('expense').concat(['退款'])
    result.categories.forEach(function (item) {
      if (categoryNames.indexOf(item.name) < 0) categoryNames.push(item.name)
    })
    Object.keys(categoryWeights).forEach(function (name) {
      if (categoryNames.indexOf(name) < 0) categoryNames.push(name)
    })
    var categoryOptions = categoryNames.map(function (name) { return { name: name } })
    var templates = settlementState.listTemplates(book.bookId).map(function (item) {
      return {
        id: item.id,
        name: item.name,
        createdAtText: historyTime(item.createdAt),
        weightText: Object.keys(item.weights).length ? weightSummary(item.weights, members) : '平均分摊'
      }
    })
    var categoryRows = result.categories.map(function (item) {
      return {
        name: item.name,
        netText: money(item.net),
        covered: item.covered,
        weightText: item.covered ? weightSummary(categoryWeights[item.name], members) : '本月默认权重'
      }
    })
    this.setData(Object.assign(base, {
      members: members,
      transfers: transfers,
      memberCount: members.length,
      hasData: result.total !== 0 || result.expense !== 0 || result.refund !== 0,
      emptyText: members.length ? '这个月没有可结算的支出或退款。' : '暂无可参与结算的成员，请先同步成员名单。',
      expenseText: money(result.expense),
      refundText: money(result.refund),
      totalText: money(result.total),
      myBalanceText: money(Math.abs(myBalance)),
      myBalanceLabel: myBalance < 0 ? '我应付' : (myBalance > 0 ? '我应收' : '我已结清'),
      myBalanceClass: myBalance < 0 ? 'due' : (myBalance > 0 ? 'receive' : ''),
      ignored: result.ignored,
      weights: result.weights,
      weightModeText: result.splitMode === 'weighted' ? '按权重分摊' : '平均分摊',
      weightWarnings: result.weightWarnings.join('；'),
      categoryEditing: false,
      categoryOptions: categoryOptions,
      categoryIndex: 0,
      categoryName: categoryOptions[0].name,
      categoryInputs: categoryInputsOf(categoryOptions[0].name, categoryWeights, result.weights, members),
      categoryWeights: categoryWeights,
      categoryWarnings: result.categoryWarnings.join('；'),
      categories: categoryRows,
      templates: templates,
      templateName: '',
      templateIndex: -1,
      templateId: '',
      history: historyRows,
      historyCount: historyRows.length,
      settledCount: settledCount,
      pendingCount: transfers.length - settledCount
    }))
  },

  toggleWeightEditing: function () {
    if (!this.data.joined || !this.data.memberCount) return
    this.setData({ weightEditing: !this.data.weightEditing })
  },

  onWeightInput: function (e) {
    var key = String(e.currentTarget.dataset.key || '')
    var value = String(e.detail.value == null ? '' : e.detail.value)
    if (!/^\d*\.?\d*$/.test(value)) { toast('权重只能填写 0 或正数'); return }
    var members = this.data.members
    for (var i = 0; i < members.length; i++) {
      if (members[i].ownerKey === key) {
        var next = members.map(function (member, index) {
          return index === i ? Object.assign({}, member, { weightText: value }) : member
        })
        this.setData({ members: next })
        return
      }
    }
  },

  saveMemberWeights: function () {
    var book = shared.current() || {}
    if (!book.bookId) return
    var weights = Object.create(null)
    var positive = false
    for (var i = 0; i < this.data.members.length; i++) {
      var member = this.data.members[i]
      var text = String(member.weightText == null ? '' : member.weightText).trim()
      var value = text === '' ? 0 : Number(text)
      if (!isFinite(value) || value < 0) { toast('权重必须为 0 或正数'); return }
      weights[member.ownerKey] = value
      if (value > 0) positive = true
    }
    if (!positive) { toast('至少一名成员的权重大于 0'); return }
    var saved = settlementState.saveWeights(book.bookId, this.data.ym, weights)
    if (!saved.ok) { toast(saved.error || '权重保存失败'); return }
    this.setData({ weightEditing: false })
    this.refresh()
    toast('权重已保存到本机')
  },

  resetWeights: function () {
    var book = shared.current() || {}
    if (!book.bookId) return
    var saved = settlementState.saveWeights(book.bookId, this.data.ym, {})
    if (!saved.ok) { toast(saved.error || '恢复平均分摊失败'); return }
    this.refresh()
    toast('已恢复平均分摊')
  },

  onTemplateNameInput: function (e) {
    this.setData({ templateName: String(e.detail.value == null ? '' : e.detail.value) })
  },

  saveWeightTemplate: function () {
    var book = shared.current() || {}
    var name = String(this.data.templateName || '').trim()
    if (!book.bookId) return
    if (!name) { toast('请先填写模板名称'); return }
    var saved = settlementState.saveTemplate(book.bookId, name, this.data.weights)
    if (!saved.ok) { toast(saved.error || '模板保存失败'); return }
    this.refresh()
    toast('模板已保存到本机')
  },

  pickTemplate: function (e) {
    var index = Number(e.detail.value)
    var item = this.data.templates[index]
    if (!item) return
    this.setData({ templateIndex: index, templateId: item.id })
  },

  applyWeightTemplate: function () {
    var book = shared.current() || {}
    if (!book.bookId) return
    var saved = settlementState.applyTemplate(book.bookId, this.data.ym, this.data.templateId)
    if (!saved.ok) { toast(saved.error || '模板套用失败'); return }
    this.refresh()
    toast('已套用模板权重')
  },

  deleteWeightTemplate: function (e) {
    var book = shared.current() || {}
    var id = String(e.currentTarget.dataset.id || '')
    if (!book.bookId) return
    var saved = settlementState.deleteTemplate(book.bookId, id)
    if (!saved.ok) { toast(saved.error || '模板删除失败'); return }
    this.refresh()
    toast('模板已删除')
  },

  toggleCategoryEditing: function () {
    if (!this.data.joined || !this.data.memberCount) return
    this.setData({ categoryEditing: !this.data.categoryEditing })
  },

  pickCategory: function (e) {
    var index = Number(e.detail.value)
    var name = this.data.categoryOptions[index] && this.data.categoryOptions[index].name
    if (!name) return
    this.setData({
      categoryIndex: index,
      categoryName: name,
      categoryInputs: categoryInputsOf(name, this.data.categoryWeights, this.data.weights, this.data.members)
    })
  },

  onCategoryWeightInput: function (e) {
    var key = String(e.currentTarget.dataset.key || '')
    var value = String(e.detail.value == null ? '' : e.detail.value)
    if (!/^\d*\.?\d*$/.test(value)) { toast('分类权重只能填写 0 或正数'); return }
    var inputs = this.data.categoryInputs.map(function (item) {
      return item.ownerKey === key ? Object.assign({}, item, { weightText: value }) : item
    })
    this.setData({ categoryInputs: inputs })
  },

  saveCategoryOverride: function () {
    var book = shared.current() || {}
    if (!book.bookId) return
    var weights = Object.create(null)
    var positive = false
    for (var i = 0; i < this.data.categoryInputs.length; i++) {
      var item = this.data.categoryInputs[i]
      var text = String(item.weightText == null ? '' : item.weightText).trim()
      var value = text === '' ? 0 : Number(text)
      if (!isFinite(value) || value < 0) { toast('分类权重必须为 0 或正数'); return }
      weights[item.ownerKey] = value
      if (value > 0) positive = true
    }
    if (!positive) { toast('至少一名成员的分类权重大于 0'); return }
    var saved = settlementState.saveCategoryWeights(book.bookId, this.data.ym, this.data.categoryName, weights)
    if (!saved.ok) { toast(saved.error || '分类覆盖保存失败'); return }
    this.setData({ categoryEditing: false })
    this.refresh()
    toast('分类覆盖已保存')
  },

  removeCategoryOverride: function (e) {
    var book = shared.current() || {}
    var name = String(e.currentTarget.dataset.category || '')
    if (!book.bookId) return
    var saved = settlementState.removeCategoryWeights(book.bookId, this.data.ym, name)
    if (!saved.ok) { toast(saved.error || '分类覆盖删除失败'); return }
    this.refresh()
    toast('已删除分类覆盖')
  },

  toggleTransfer: function (e) {
    var index = Number(e.currentTarget.dataset.index)
    var item = this.data.transfers[index]
    if (!item) return
    var book = shared.current() || {}
    if (!book.bookId) return
    var saved = settlementState.toggleSettled(book.bookId, this.data.ym, item)
    if (!saved.ok) { toast(saved.error || '本机记录保存失败'); return }
    this.refresh()
    toast(saved.action === 'settle' ? '已标记结清' : '已取消结清标记')
  },

  prevMonth: function () {
    if (!MONTH_RE.test(this.data.ym)) return
    var self = this
    this.setData({ ym: format.shiftMonth(this.data.ym, -1) }, function () { self.refresh() })
  },

  nextMonth: function () {
    var next = format.shiftMonth(this.data.ym, 1)
    if (next > format.ymOf(Date.now())) return
    var self = this
    this.setData({ ym: next }, function () { self.refresh() })
  },

  pickMonth: function (e) {
    var value = String(e.detail.value || '')
    if (!MONTH_RE.test(value) || value > format.ymOf(Date.now())) return
    var self = this
    this.setData({ ym: value }, function () { self.refresh() })
  },

  goShare: function () {
    wx.navigateTo({ url: '/pages/share/share' })
  }
})
