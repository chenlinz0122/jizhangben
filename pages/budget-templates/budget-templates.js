var darkmode = require('../../utils/darkmode')
var theme = require('../../utils/theme')
var format = require('../../utils/format')
var budgetTemplates = require('../../utils/budget-templates')
var store = require('../../utils/store')
var vip = require('../../utils/vip')

function row(item, selected) {
  return Object.assign({}, item, {
    selected: selected,
    budgetText: '¥' + format.money(item.monthlyBudget),
    categoryText: Object.keys(item.categoryBudgets).map(function (name) {
      return name + ' ¥' + format.money(item.categoryBudgets[name])
    }).join(' · '),
    typeText: item.builtin ? '内置示例' : '我的模板'
  })
}

function formRows(item, names) {
  var source = item ? item.categoryBudgets : {}
  return names.map(function (name) {
    return { category: name, amount: hasOwn(source, name) ? String(source[name]) : '' }
  })
}

function text(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max || 40)
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key)
}

Page({
  data: {
    dark: false,
    themeKey: 'green',
    themeColor: '#17806b',
    builtinTemplates: [],
    customTemplates: [],
    categories: [],
    selectedId: '',
    editingId: '',
    savingCustom: false,
    draftName: '',
    draftBudget: '',
    draftRows: [],
    incomeInput: '',
    preview: null,
    applying: false,
    currentBudget: 0,
    currentCategoryCount: 0
  },

  onLoad: function () {
    var self = this
    this._unloaded = false
    this._stopThemeWatch = darkmode.watch(function (dark) {
      if (!self._unloaded) self.setData({ dark: dark })
    })
    this.setData({ categories: budgetTemplates.CATEGORIES.slice() })
  },

  onShow: function () {
    var currentTheme = theme.get()
    this.setData({ themeKey: currentTheme.key, themeColor: currentTheme.color, dark: darkmode.isDark() })
    this.refresh()
  },

  onUnload: function () {
    this._unloaded = true
    if (this._stopThemeWatch) this._stopThemeWatch()
  },

  noop: function () {},

  toast: function (title) {
    if (wx.showToast) wx.showToast({ title: title, icon: 'none' })
  },

  refresh: function () {
    var selectedId = this.data.selectedId
    var items = budgetTemplates.list()
    if (!items.some(function (item) { return item.id === selectedId })) selectedId = items[0].id
    var source = budgetTemplates.get(selectedId)
    var self = this
    this.setData({
      selectedId: selectedId,
      builtinTemplates: items.filter(function (item) { return item.builtin }).map(function (item) {
        return row(item, item.id === selectedId)
      }),
      customTemplates: items.filter(function (item) { return !item.builtin }).map(function (item) {
        return row(item, item.id === selectedId)
      }),
      currentBudget: store.budget(),
      currentCategoryCount: Object.keys(store.catBudgets() || {}).length
    }, function () {
      self.updatePreview(source, self.data.incomeInput)
      if (!self.data.editingId && !self.data.draftRows.length) self.openDraft()
    })
  },

  updatePreview: function (source, incomeValue) {
    if (!source) {
      this.setData({ preview: null })
      return
    }
    var income = String(incomeValue === undefined ? this.data.incomeInput : incomeValue).trim()
    var result
    try { result = budgetTemplates.preview(source, income) } catch (e) { result = null }
    this.setData({ preview: result })
  },

  selected: function () {
    return budgetTemplates.get(this.data.selectedId)
  },

  selectTemplate: function (e) {
    var source = budgetTemplates.get(e.currentTarget.dataset.id)
    if (!source) return
    this.setData({ selectedId: source.id, editingId: '' })
    this.refresh()
    this.openDraft()
  },

  onIncomeInput: function (e) {
    var value = e.detail.value
    this.setData({ incomeInput: value })
    this.updatePreview(this.selected(), value)
  },

  openDraft: function () {
    var source = this.selected()
    if (!source) return
    var rows = budgetTemplates.CATEGORIES.map(function (name) {
      return {
        category: name,
        amount: hasOwn(source.categoryBudgets, name) ? String(source.categoryBudgets[name]) : ''
      }
    })
    this.setData({
      editingId: '',
      savingCustom: false,
      draftName: source.builtin ? text(source.name, budgetTemplates.NAME_MAX - 4) + '（我的）' : source.name,
      draftBudget: String(source.monthlyBudget),
      draftRows: rows
    })
  },

  closeDraft: function () {
    if (this.data.savingCustom) return
    this.setData({ editingId: '' })
    this.openDraft()
  },

  editTemplate: function (e) {
    var source = budgetTemplates.get(e.currentTarget.dataset.id)
    if (!source || source.builtin) return
    this.setData({ selectedId: source.id })
    this.refresh()
    this.setData({
      editingId: source.id,
      savingCustom: false,
      draftName: source.name,
      draftBudget: String(source.monthlyBudget),
      draftRows: formRows(source, budgetTemplates.CATEGORIES)
    })
  },

  onNameInput: function (e) {
    this.setData({ draftName: e.detail.value })
  },

  onBudgetInput: function (e) {
    this.setData({ draftBudget: e.detail.value })
  },

  onCategoryAmount: function (e) {
    var index = Number(e.currentTarget.dataset.index)
    if (isNaN(index) || !this.data.draftRows[index]) return
    var rows = this.data.draftRows.slice()
    rows[index] = Object.assign({}, rows[index], { amount: e.detail.value })
    this.setData({ draftRows: rows })
  },

  collectDraft: function () {
    var categoryBudgets = {}
    this.data.draftRows.forEach(function (item) {
      if (String(item.amount || '').trim() !== '') categoryBudgets[item.category] = item.amount
    })
    return {
      id: this.data.editingId || undefined,
      name: text(this.data.draftName, budgetTemplates.NAME_MAX),
      monthlyBudget: String(this.data.draftBudget || '').trim(),
      categoryBudgets: categoryBudgets,
      builtin: false,
      createdAt: this.data.editingId && budgetTemplates.get(this.data.editingId) ?
        budgetTemplates.get(this.data.editingId).createdAt : Date.now()
    }
  },

  saveCustom: function () {
    if (this.data.savingCustom) return
    var editing = this.data.editingId
    if (editing && !budgetTemplates.get(editing)) return this.toast('模板已不存在，请重新载入')
    this.setData({ savingCustom: true })
    var saved = budgetTemplates.save(this.collectDraft())
    this.setData({ savingCustom: false })
    if (!saved) {
      this.toast('保存失败：请检查名称、金额和分类')
      return
    }
    this.setData({ selectedId: saved.id, editingId: '' })
    this.refresh()
    this.openDraft()
    this.toast(editing ? '模板已更新' : '已保存为我的模板')
  },

  duplicateTemplate: function (e) {
    var source = budgetTemplates.get(e.currentTarget.dataset.id)
    if (!source) return
    var copied = budgetTemplates.duplicate(source.id)
    if (!copied) return this.toast('复制失败，请检查本机空间')
    this.setData({ selectedId: copied.id })
    this.refresh()
    this.openDraft()
    this.toast('已复制为我的模板')
  },

  removeTemplate: function (e) {
    var self = this
    var id = e.currentTarget.dataset.id
    var source = budgetTemplates.get(id)
    if (!source || source.builtin) return
    wx.showModal({
      title: '删除我的模板？',
      content: '将删除“' + source.name + '”，不会影响已经应用到账本的预算。',
      confirmText: '删除',
      confirmColor: '#d9433f',
      success: function (res) {
        if (!res.confirm) return
        if (!budgetTemplates.remove(id)) return self.toast('删除失败')
        if (self.data.selectedId === id) self.setData({ selectedId: '' })
        self.refresh()
        self.toast('模板已删除')
      }
    })
  },

  exportTemplates: function () {
    var self = this
    var data = JSON.stringify(budgetTemplates.exportData())
    wx.setClipboardData({
      data: data,
      success: function () {
        wx.showModal({
          title: '备份已复制',
          content: '模板 JSON 已复制到剪贴板，仅包含自定义模板。可粘贴保存，之后使用“合并备份”恢复。',
          showCancel: false
        })
      },
      fail: function () { self.toast('复制失败，请重试') }
    })
  },

  mergeBackup: function () {
    var self = this
    wx.showModal({
      title: '合并模板备份？',
      content: '将读取剪贴板中的预算模板 JSON 并合并。相同 ID 会被备份内容更新，其他现有模板保留。',
      confirmText: '合并',
      success: function (res) {
        if (!res.confirm) return
        wx.getClipboardData({
          success: function (result) {
            var text = String((result && result.data) || '').trim()
            if (!text) return self.toast('剪贴板为空，请先复制模板备份')
            var merged
            try {
              merged = budgetTemplates.importData(JSON.parse(text))
            } catch (e) {
              return self.toast(e.message || '备份格式不对')
            }
            if (!merged.saved) return self.toast('合并失败，请检查本机空间')
            self.refresh()
            wx.showModal({
              title: '模板已合并',
              content: '新增 ' + merged.added + ' 个，更新 ' + merged.updated + ' 个，跳过 ' + merged.skipped + ' 条无效或重复数据。',
              showCancel: false
            })
          },
          fail: function () { self.toast('读取剪贴板失败') }
        })
      }
    })
  },

  goReport: function () {
    var app = getApp()
    if (app && app.globalData) {
      app.globalData.reportYm = format.ymOf(Date.now())
      app.globalData.reportSection = 'budget'
    }
    wx.switchTab({ url: '/pages/report/report' })
  },

  applyTemplate: function () {
    if (this.data.applying) return
    var source = this.selected()
    if (!source) return this.toast('请先选择模板')
    var checked = budgetTemplates.normalize(source)
    var preview = budgetTemplates.preview(checked, '')
    if (!checked || !preview) return this.toast('模板数据无效，请重新编辑')
    var self = this
    var month = format.ymOf(Date.now())
    /* 与报表页共用会员守卫；未开通时不会继续确认或写入预算。 */
    if (!vip.guard('月度预算')) return
    this.setData({ applying: true })
    wx.showModal({
      title: '确认覆盖本月预算？',
      content: '将把“' + source.name + '”应用到 ' + month + '：\n月预算设为 ¥' + format.money(checked.monthlyBudget) +
        '，并替换全部 ' + Object.keys(checked.categoryBudgets).length + ' 个分类预算。\n这会覆盖当前月预算与现有分类预算，模板中未列出的分类预算将被清除。此操作不可撤销。',
      confirmText: '确认覆盖',
      confirmColor: this.data.themeColor,
      success: function (res) {
        if (!res.confirm) return self.setData({ applying: false })
        var result = store.applyBudgetTemplate(checked.monthlyBudget, checked.categoryBudgets)
        self.setData({ applying: false })
        if (!result || !result.saved) {
          return self.toast('应用失败，当前预算未改变')
        }
        self.refresh()
        wx.showModal({
          title: '预算已应用',
          content: month + ' 的月预算和分类预算已按模板更新。可前往报表查看。',
          confirmText: '查看报表',
          cancelText: '留在此页',
          success: function (next) { if (next.confirm) self.goReport() }
        })
      },
      fail: function () { self.setData({ applying: false }) }
    })
  }
})
