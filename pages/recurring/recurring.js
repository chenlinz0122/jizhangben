var darkmode = require('../../utils/darkmode')
var theme = require('../../utils/theme')
var format = require('../../utils/format')
var category = require('../../utils/category')
var recurring = require('../../utils/recurring')
var accounts = require('../../utils/accounts')

var TYPE_NAMES = { expense: '支出', income: '收入', transfer: '转账' }
var INTERVAL_NAMES = { month: '每月', week: '每周', year: '每年' }
var WEEK_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
var LEAD_DAY_OPTIONS = ['当天（提前 0 天）', '提前 1 天', '提前 2 天', '提前 3 天', '提前 4 天', '提前 5 天', '提前 6 天', '提前 7 天']

function categoryNames(type) {
  return category.catsOf(type).map(function (name) { return String(name) })
}

function reminderRows(items) {
  return items.map(function (item) {
    var sign = item.type === 'expense' ? '-' : (item.type === 'income' ? '+' : '')
    var whenText = item.daysLeft < 0 ? '已逾期 ' + (-item.daysLeft) + ' 天' :
      (item.daysLeft === 0 ? '今天到期' : item.daysLeft + ' 天后')
    return Object.assign({}, item, {
      typeName: TYPE_NAMES[item.type],
      intervalName: INTERVAL_NAMES[item.interval],
      amountText: sign + '¥' + format.money(item.amount),
      whenText: whenText,
      overdue: item.daysLeft < 0
    })
  })
}

function showReminderModal(title, content) {
  if (wx.showModal) {
    wx.showModal({ title: title, content: content, showCancel: false })
  } else if (wx.showToast) {
    wx.showToast({ title: title, icon: 'none' })
  }
}

Page({
  data: {
    dark: false,
    themeKey: 'green',
    themeColor: '#17806b',
    today: '',
    items: [],
    overdue: [],
    dueToday: [],
    dueSoon: [],
    dueCount: 0,
    activeCount: 0,
    reminderPrefs: { enabled: false, leadDays: 3, subscribedAt: 0, templateId: '' },
    reminderItems: [],
    leadDayOptions: LEAD_DAY_OPTIONS,
    reminderAuthorizing: false,
    showForm: false,
    editingId: '',
    formTitle: '',
    typeNames: TYPE_NAMES,
    intervalNames: INTERVAL_NAMES,
    weekNames: WEEK_NAMES,
    monthDays: Array.from({ length: 31 }, function (_, i) { return i + 1 }),
    form: null,
    cats: [],
    accountOptions: [{ id: '', name: '未指定账户' }],
    accountIndex: 0,
    fromAccountIndex: 0,
    toAccountIndex: 0,
    generating: false
  },

  onLoad: function () {
    this._stopThemeWatch = darkmode.watch(function (dark) { this.setData({ dark: dark }) }.bind(this))
    var today = format.dayOf(Date.now())
    var cats = categoryNames('expense')
    var reminderPrefs = recurring.getReminderPrefs()
    this.setData({
      today: today,
      cats: cats,
      reminderPrefs: reminderPrefs,
      form: this.blankForm(today, 'expense', cats[0])
    })
    this.loadAccountOptions()
  },

  onShow: function () {
    var currentTheme = theme.get()
    this.setData({ themeKey: currentTheme.key, themeColor: currentTheme.color, dark: darkmode.isDark() })
    this.refresh()
    this.loadAccountOptions(this.data.form)
  },

  noop: function () {},

  onUnload: function () {
    this._unloaded = true
    if (this._stopThemeWatch) this._stopThemeWatch()
  },

  loadAccountOptions: function (form) {
    var options = [{ id: '', name: '未指定账户' }]
    accounts.list().forEach(function (item) { options.push({ id: item.id, name: item.name }) })
    ;['accountId', 'fromAccountId', 'toAccountId'].forEach(function (key) {
      var id = form && form[key]
      if (id && !options.some(function (item) { return item.id === id })) options.push({ id: id, name: id + '（旧）' })
    })
    function indexOf(id) {
      for (var i = 0; i < options.length; i++) if (options[i].id === id) return i
      return 0
    }
    this.setData({
      accountOptions: options,
      accountIndex: indexOf(form && form.accountId),
      fromAccountIndex: indexOf(form && form.fromAccountId),
      toAccountIndex: indexOf(form && form.toAccountId)
    })
  },

  onAccount: function (e) {
    var idx = Number(e.detail.value) || 0
    var item = this.data.accountOptions[idx]
    this.setData({ accountIndex: idx, form: Object.assign({}, this.data.form, { accountId: item.id }) })
  },

  onFromAccount: function (e) {
    var idx = Number(e.detail.value) || 0
    var item = this.data.accountOptions[idx]
    this.setData({ fromAccountIndex: idx, form: Object.assign({}, this.data.form, { fromAccountId: item.id }) })
  },

  onToAccount: function (e) {
    var idx = Number(e.detail.value) || 0
    var item = this.data.accountOptions[idx]
    this.setData({ toAccountIndex: idx, form: Object.assign({}, this.data.form, { toAccountId: item.id }) })
  },

  blankForm: function (today, type, cat) {
    var parts = today.split('-')
    var weekday = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])).getDay()
    return {
      name: '', type: type, amount: '', category: cat, merchant: '', note: '',
      accountId: '', fromAccountId: '', toAccountId: '',
      interval: 'month', dayOfMonth: Number(parts[2]), dayOfWeek: weekday, startDate: today
    }
  },

  refresh: function () {
    var today = this.data.today || format.dayOf(Date.now())
    var upcoming = recurring.due(today, 7)
    var byId = {}
    upcoming.forEach(function (item) { byId[item.id] = item })
    var overdue = upcoming.filter(function (item) { return item.daysLeft < 0 })
    var dueToday = upcoming.filter(function (item) { return item.daysLeft === 0 })
    var dueSoon = upcoming.filter(function (item) { return item.daysLeft > 0 })
    var accountLabels = Object.create(null)
    accounts.list().forEach(function (item) { accountLabels[item.id] = item.name })
    var reminderPrefs = recurring.getReminderPrefs()
    var reminders = reminderRows(recurring.reminderItems(today))
    var items = recurring.list().map(function (item) {
      var dueInfo = byId[item.id]
      var dateLabel
      if (!item.enabled) dateLabel = '已停用'
      else if (dueInfo && dueInfo.daysLeft < 0) dateLabel = '已逾期 ' + (-dueInfo.daysLeft) + ' 天'
      else if (dueInfo && dueInfo.daysLeft === 0) dateLabel = '今天到期'
      else if (dueInfo) dateLabel = dueInfo.daysLeft + ' 天后到期'
      else dateLabel = item.nextDate + ' 下一期'
      var sign = item.type === 'expense' ? '-' : (item.type === 'income' ? '+' : '')
      return Object.assign({}, item, {
        typeName: TYPE_NAMES[item.type],
        intervalName: INTERVAL_NAMES[item.interval],
        amountText: sign + '¥' + format.money(item.amount),
        amountClass: item.type === 'expense' ? 'exp' : (item.type === 'income' ? 'inc' : 'transfer'),
        scheduleText: item.interval === 'week' ? '每' + WEEK_NAMES[item.dayOfWeek] :
          (item.interval === 'year' ? '每年 ' + item.startDate.slice(5) : '每月 ' + item.dayOfMonth + ' 日'),
        dateLabel: dateLabel,
        canSkip: !!(dueInfo && item.enabled),
        accountName: accountLabels[item.accountId] || item.accountId || '未指定账户',
        fromAccountName: accountLabels[item.fromAccountId] || item.fromAccountId || '未指定账户',
        toAccountName: accountLabels[item.toAccountId] || item.toAccountId || '未指定账户'
      })
    })
    this.setData({
      today: today,
      items: items,
      overdue: overdue,
      dueToday: dueToday,
      dueSoon: dueSoon,
      dueCount: upcoming.length,
      activeCount: items.filter(function (item) { return item.enabled }).length,
      reminderPrefs: reminderPrefs,
      reminderItems: reminders
    })
  },

  toggleReminder: function (e) {
    var enabled = !!e.detail.value
    var saved = recurring.saveReminderPrefs({ enabled: enabled })
    this.refresh()
    if (!saved) return wx.showToast({ title: '提醒设置保存失败', icon: 'none' })
    wx.showToast({ title: enabled ? '已开启应用内提醒' : '已关闭应用内提醒', icon: 'none' })
  },

  onReminderLeadDays: function (e) {
    var leadDays = Number(e.detail.value)
    var saved = recurring.saveReminderPrefs({ leadDays: leadDays })
    this.refresh()
    if (!saved) return wx.showToast({ title: '提醒设置保存失败', icon: 'none' })
    wx.showToast({ title: leadDays ? '已设置提前 ' + leadDays + ' 天' : '已设置为到期当天提醒', icon: 'none' })
  },

  authorizeReminder: function () {
    if (this.data.reminderAuthorizing) return
    var self = this
    var templateId = recurring.getReminderPrefs().templateId
    function feedback(title, content) {
      self.setData({ reminderAuthorizing: false })
      self.refresh()
      showReminderModal(title, content)
    }
    if (!templateId) {
      feedback('仅应用内提醒', '未配置微信订阅消息模板，无法调用微信授权；近期账单只在本页显示（需开启应用内提醒）。')
      return
    }
    if (typeof wx.requestSubscribeMessage !== 'function') {
      feedback('仅应用内提醒', '当前微信环境不支持订阅消息授权，近期账单只在本页显示（需开启应用内提醒）。')
      return
    }
    this.setData({ reminderAuthorizing: true })
    try {
      wx.requestSubscribeMessage({
        tmplIds: [templateId],
        success: function (res) {
          if (!res || (res.errMsg && res.errMsg !== 'requestSubscribeMessage:ok')) {
            feedback('微信提醒授权失败', '微信未完成本次授权，上方应用内提醒开关不受影响。')
            return
          }
          var result = res[templateId]
          if (result === 'accept') {
            var saved = recurring.saveReminderPrefs({ subscribedAt: Date.now() })
            if (saved) {
              feedback('微信提醒已授权', '微信已同意本次订阅。是否发送消息由微信平台规则决定；本应用没有后台定时推送。')
            } else {
              feedback('授权成功，设置保存失败', '微信已同意本次订阅，但本机设置保存失败；上方应用内提醒开关不受影响。')
            }
            return
          }
          if (result === 'reject') {
            feedback('未获得微信提醒授权', '本次订阅已被拒绝，上方应用内提醒开关不受影响。')
          } else if (result === 'ban') {
            feedback('未获得微信提醒授权', '当前微信账号暂不支持订阅，上方应用内提醒开关不受影响。')
          } else {
            feedback('授权结果不明确', '微信未返回明确的订阅结果，上方应用内提醒开关不受影响。')
          }
        },
        fail: function (res) {
          var detail = res && res.errMsg ? '：' + res.errMsg : ''
          feedback('微信提醒授权失败', '微信未完成本次授权' + detail + '，上方应用内提醒开关不受影响。')
        }
      })
    } catch (e) {
      feedback('微信提醒授权失败', '当前环境无法完成订阅授权，上方应用内提醒开关不受影响。')
    }
  },

  openForm: function (e) {
    var id = e.currentTarget.dataset.id || ''
    var source = null
    if (id) source = recurring.list().filter(function (item) { return item.id === id })[0]
    if (id && !source) {
      wx.showToast({ title: '这条周期账单已不存在', icon: 'none' })
      return
    }
    var cats = categoryNames(source ? source.type : 'expense')
    var form = source ? Object.assign({}, source) : this.blankForm(this.data.today, 'expense', cats[0])
    if (cats.indexOf(form.category) < 0) form.category = cats[0] || '未分类'
    this.setData({
      showForm: true,
      editingId: id,
      formTitle: id ? '编辑周期账单' : '新增周期账单',
      form: form,
      cats: cats
    })
    this.loadAccountOptions(form)
  },

  closeForm: function () {
    if (this.data.generating) return
    this.setData({ showForm: false, editingId: '' })
  },

  onFormInput: function (e) {
    var field = e.currentTarget.dataset.field
    var patch = {}
    patch[field] = e.detail.value
    this.setData({ form: Object.assign({}, this.data.form, patch) })
  },

  switchType: function (e) {
    var type = e.currentTarget.dataset.type
    var cats = categoryNames(type)
    this.setData({
      form: Object.assign({}, this.data.form, { type: type, category: cats[0] || '未分类' }),
      cats: cats
    })
  },

  switchInterval: function (e) {
    this.setData({ form: Object.assign({}, this.data.form, { interval: e.currentTarget.dataset.interval }) })
  },

  pickCategory: function (e) {
    this.setData({ form: Object.assign({}, this.data.form, { category: e.currentTarget.dataset.category }) })
  },

  onStartDate: function (e) {
    var date = e.detail.value
    var parts = date.split('-')
    var weekday = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])).getDay()
    this.setData({
      form: Object.assign({}, this.data.form, {
        startDate: date,
        dayOfMonth: Number(parts[2]),
        dayOfWeek: weekday
      })
    })
  },

  onMonthDay: function (e) {
    this.setData({ form: Object.assign({}, this.data.form, { dayOfMonth: Number(e.detail.value) }) })
  },

  onWeekDay: function (e) {
    this.setData({ form: Object.assign({}, this.data.form, { dayOfWeek: Number(e.detail.value) }) })
  },

  submitForm: function () {
    var form = this.data.form || {}
    var name = String(form.name || '').trim()
    var amountText = String(form.amount || '').trim()
    var amount = Math.round(Number(amountText) * 100) / 100
    if (!name) return wx.showToast({ title: '请填写周期账单名称', icon: 'none' })
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(amountText) || !isFinite(amount) || amount <= 0) {
      return wx.showToast({ title: '请填写有效正金额', icon: 'none' })
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.startDate || '')) {
      return wx.showToast({ title: '请选择开始日期', icon: 'none' })
    }
    if (form.type === 'transfer' && form.fromAccountId && form.fromAccountId === form.toAccountId) {
      return wx.showToast({ title: '转出和转入账户不能相同', icon: 'none' })
    }
    var old = this.data.editingId ? recurring.list().filter(function (row) {
      return row.id === this.data.editingId
    }.bind(this))[0] : null
    var item = Object.assign({}, old || {}, form, {
      id: this.data.editingId || undefined,
      name: name,
      amount: amount,
      dayOfMonth: Number(form.dayOfMonth),
      dayOfWeek: Number(form.dayOfWeek)
    })
    var saved = recurring.save(item)
    if (!saved) return wx.showToast({ title: '保存失败，请检查输入或本机空间', icon: 'none' })
    this.setData({ showForm: false, editingId: '' })
    this.refresh()
    wx.showToast({ title: '已保存', icon: 'success' })
  },

  toggleItem: function (e) {
    var id = e.currentTarget.dataset.id
    var item = recurring.toggle(id, e.detail.value)
    if (!item) return wx.showToast({ title: '状态保存失败', icon: 'none' })
    this.refresh()
    wx.showToast({ title: item.enabled ? '已启用' : '已停用', icon: 'none' })
  },

  deleteItem: function (e) {
    var self = this
    var id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删除周期账单？',
      content: '只删除这条规则，已经生成的流水不会删除。',
      confirmText: '删除',
      confirmColor: '#d9433f',
      success: function (res) {
        if (!res.confirm) return
        if (!recurring.remove(id)) return wx.showToast({ title: '删除失败', icon: 'none' })
        self.refresh()
        wx.showToast({ title: '已删除', icon: 'none' })
      }
    })
  },

  skipItem: function (e) {
    var self = this
    var item = recurring.list().filter(function (row) { return row.id === e.currentTarget.dataset.id })[0]
    if (!item) return
    var period = item.interval === 'month' ? '本月这一期' : '本期'
    wx.showModal({
      title: '跳过' + period + '？',
      content: '将跳过 ' + item.nextDate + '，直接推进到下一周期，不会生成流水。',
      confirmText: '跳过',
      success: function (res) {
        if (!res.confirm) return
        if (!recurring.skipNext(item.id)) return wx.showToast({ title: '跳过失败', icon: 'none' })
        self.refresh()
        wx.showToast({ title: '已跳过并推进', icon: 'none' })
      }
    })
  },

  generateDue: function () {
    if (this.data.generating) return
    if (!this.data.dueCount) return wx.showToast({ title: '今天没有到期账单', icon: 'none' })
    var self = this
    wx.showModal({
      title: '生成到期账单？',
      content: '将为每个到期项生成当前一期流水；不追补更早的历史周期。重复点击不会重复入账。',
      confirmText: '生成',
      success: function (res) {
        if (!res.confirm || self.data.generating) return
        self.setData({ generating: true })
        var result
        try { result = recurring.generateDue(self.data.today) } catch (e) { result = null }
        self.setData({ generating: false })
        self.refresh()
        if (!result || result.failed || !result.saved) {
          wx.showModal({
            title: '部分生成未完成',
            content: (result ? '已生成 ' + result.generated + ' 笔，识别到已有 ' + result.duplicate + ' 笔。' : '') +
              '请核对流水和下一期日期后再试；稳定 ID 可避免重复入账。',
            showCancel: false
          })
          return
        }
        var message = '已生成 ' + result.generated + ' 笔'
        if (result.duplicate) message += '，已有 ' + result.duplicate + ' 笔未重复生成'
        if (result.skipped) message += '，跳过 ' + result.skipped + ' 期'
        wx.showToast({ title: message, icon: 'none' })
      }
    })
  }
})
