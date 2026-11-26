// node tools/test-budget-templates.js
var assert = require('assert')
var fs = require('fs')
var path = require('path')
var storage = Object.create(null)
var failKeys = Object.create(null)
var clipboard = ''
var modalOptions = null
var modalReply = null
var toastCalls = 0

global.wx = {
  getStorageSync: function (key) { return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : '' },
  setStorageSync: function (key, value) {
    if (failKeys[key]) throw new Error('injected storage failure: ' + key)
    storage[key] = value
  },
  removeStorageSync: function (key) { delete storage[key] },
  showToast: function () { toastCalls++ },
  showModal: function (options) {
    modalOptions = options
    if (modalReply !== null && options.success) options.success(modalReply)
  },
  getClipboardData: function (options) { options.success({ data: clipboard }) },
  setClipboardData: function (options) { clipboard = options.data; if (options.success) options.success() },
  navigateTo: function (options) { wx.lastNavigation = options.url },
  switchTab: function (options) { wx.lastTab = options.url },
  getAppBaseInfo: function () { return { theme: 'light' } },
  onThemeChange: function () {},
  offThemeChange: function () {}
}

global.getApp = function () { return { globalData: {} } }
var templates = require('../utils/budget-templates')
var store = require('../utils/store')
var originalSetCatBudget = store.setCatBudget
var vip = require('../utils/vip')
var format = require('../utils/format')
var pass = 0
var failed = 0

function reset() {
  Object.keys(storage).forEach(function (key) { delete storage[key] })
  Object.keys(failKeys).forEach(function (key) { delete failKeys[key] })
  clipboard = ''
  modalOptions = null
  modalReply = null
  toastCalls = 0
  delete wx.lastNavigation
  delete wx.lastTab
  store.reload()
  store.setCatBudget = originalSetCatBudget
  wx.setStorageSync(vip.KEY, { expireAt: Date.now() + 86400000 })
}

function test(name, fn) {
  reset()
  try {
    fn()
    pass++
    console.log('PASS ' + name)
  } catch (e) {
    failed++
    console.error('FAIL ' + name + '\n' + e.stack)
  }
}

function template(patch) {
  return Object.assign({
    id: 'mine-1', name: '我的预算', monthlyBudget: 3000,
    categoryBudgets: { '餐饮': 1200, '交通': 300 }, builtin: false, createdAt: 100
  }, patch || {})
}

test('builtin templates contain required examples and are editable copies', function () {
  assert.strictEqual(templates.KEY, 'budget_templates_v1')
  var items = templates.list()
  assert.deepStrictEqual(items.map(function (item) { return item.name }), ['基础生活', '50/30/20 简化版', '旅行月'])
  assert.ok(items.every(function (item) { return item.builtin === true && item.monthlyBudget > 0 }))
  assert.strictEqual(storage[templates.KEY], undefined)
  items[0].name = 'changed'
  items[0].categoryBudgets['餐饮'] = 1
  assert.strictEqual(templates.get('builtin-basic-life').name, '基础生活')
  assert.notStrictEqual(templates.get('builtin-basic-life').categoryBudgets['餐饮'], 1)
  var copy = Object.assign({}, items[0], { id: 'copy-basic', builtin: false })
  var saved = templates.save(copy)
  assert.strictEqual(saved.builtin, false)
  assert.strictEqual(templates.save(items[0]), null)
  assert.strictEqual(templates.get('builtin-basic-life').name, '基础生活')
})

test('CRUD saves only custom templates and preserves createdAt on update', function () {
  var created = templates.save(template())
  assert.ok(created)
  assert.deepStrictEqual(storage[templates.KEY], [created])
  assert.strictEqual(templates.get(created.id).name, '我的预算')
  var updated = templates.save(template({ name: '调整后', monthlyBudget: '3200.126', categoryBudgets: { '餐饮': '1100.005', '旅行': 0 } }))
  assert.strictEqual(updated.monthlyBudget, 3200.13)
  assert.deepStrictEqual(updated.categoryBudgets, { '餐饮': 1100.01, '旅行': 0 })
  assert.strictEqual(updated.createdAt, 100)
  assert.strictEqual(templates.list().length, 4)
  assert.strictEqual(templates.remove(created.id), true)
  assert.strictEqual(templates.get(created.id), null)
  assert.strictEqual(templates.remove(created.id), false)
  assert.strictEqual(templates.remove('builtin-basic-life'), false)
})

test('validation rejects negative, malformed, non-category, long-name and invalid-id data', function () {
  ;[null, [], 'bad', template({ name: '' }), template({ name: 'x'.repeat(41) }),
    template({ id: 'bad/id' }), template({ id: '' }), template({ id: 123 }), template({ monthlyBudget: -1 }),
    template({ monthlyBudget: '' }), template({ monthlyBudget: '1e3' }), template({ monthlyBudget: Infinity }),
    template({ monthlyBudget: templates.AMOUNT_MAX + 0.001 }), template({ categoryBudgets: [] }),
    template({ categoryBudgets: { '不存在的分类': 10 } }), template({ categoryBudgets: { '餐饮': -0.01 } }),
    template({ categoryBudgets: { '餐饮': 'abc' } }), template({ categoryBudgets: { '餐饮': true } }),
    template({ builtin: 'yes' })].forEach(function (raw) {
    assert.strictEqual(templates.save(raw), null)
  })
  assert.deepStrictEqual(templates.list().map(function (item) { return item.id }), [
    'builtin-basic-life', 'builtin-50-30-20', 'builtin-travel-month'
  ])
  var auto = templates.save({ name: '自动编号', monthlyBudget: 0, categoryBudgets: {} })
  assert.ok(/^bt-/.test(auto.id))
  assert.strictEqual(auto.monthlyBudget, 0)
})

test('storage isolates malformed rows and duplicate ids', function () {
  storage[templates.KEY] = { bad: true }
  assert.strictEqual(templates.list().length, 3)
  storage[templates.KEY] = [template(), template({ name: '重复' }), template({ id: 'good' }), null,
    template({ id: 'bad/id' }), Object.assign({}, templates.get('builtin-basic-life'), { name: '伪造内置' }),
    Object.assign({}, templates.get('builtin-basic-life'), { builtin: false, name: '占用内置 ID' })]
  var custom = templates.list().filter(function (item) { return !item.builtin })
  assert.deepStrictEqual(custom.map(function (item) { return item.id }), ['mine-1', 'good'])
})

test('duplicate creates a custom copy for builtin and custom sources', function () {
  var copied = templates.duplicate('builtin-travel-month', { now: 123 })
  assert.ok(copied)
  assert.strictEqual(copied.builtin, false)
  assert.strictEqual(copied.name, '旅行月 副本')
  assert.strictEqual(copied.createdAt, 123)
  assert.notStrictEqual(copied.id, 'builtin-travel-month')
  var second = templates.duplicate(copied.id)
  assert.ok(second)
  assert.strictEqual(second.name, '旅行月 副本 副本')
  var longSource = templates.save(template({ id: 'long-source', name: 'x'.repeat(40) }))
  var longCopy = templates.duplicate(longSource.id)
  assert.strictEqual(longCopy.name.length, 40)
  assert.ok(/ 副本$/.test(longCopy.name))
  assert.strictEqual(templates.duplicate('missing'), null)
})

test('preview computes allocation, remaining, income rate and never writes budgets', function () {
  store.setBudget(99)
  store.setCatBudget('娱乐', 88)
  var beforeBudget = store.budget()
  var beforeCats = store.catBudgets()
  var result = templates.preview(template(), '6000')
  assert.strictEqual(result.allocated, 1500)
  assert.strictEqual(result.remaining, 1500)
  assert.strictEqual(result.budgetRate, 50)
  assert.strictEqual(result.rows[0].percent, 40)
  assert.strictEqual(result.incomeText, '¥6,000.00')
  assert.strictEqual(templates.preview(template(), '').budgetRate, null)
  assert.strictEqual(templates.preview(template({ categoryBudgets: { '餐饮': 4000 } })).overAllocated, true)
  assert.strictEqual(templates.preview(template(), -1), null)
  assert.strictEqual(templates.preview(null, ''), null)
  assert.strictEqual(store.budget(), beforeBudget)
  assert.deepStrictEqual(store.catBudgets(), beforeCats)
})

test('export/import round-trip merges and skips invalid or builtin rows', function () {
  templates.save(template())
  var backup = JSON.parse(JSON.stringify(templates.exportData()))
  assert.strictEqual(backup.kind, 'budget_templates')
  assert.strictEqual(backup.key, templates.KEY)
  assert.strictEqual(backup.version, 1)
  assert.strictEqual(backup.items.length, 1)
  templates.remove('mine-1')
  assert.notStrictEqual(templates.planImport, templates.importData)
  var plan = templates.planImport(backup)
  assert.strictEqual(plan.added, 1)
  assert.strictEqual(templates.get('mine-1'), null, '合并计划不能提前写盘')
  assert.strictEqual(plan.changes[0].key, templates.KEY)
  wx.setStorageSync(plan.changes[0].key, plan.changes[0].value)
  assert.deepStrictEqual(templates.get('mine-1'), template())
  var duplicate = templates.importData(backup)
  assert.strictEqual(duplicate.updated, 1)
  assert.strictEqual(duplicate.skipped, 0)
  var mixed = templates.importData({ kind: 'budget_templates', version: 1, items: [
    template({ id: 'other' }), template({ id: 'other' }), template({ id: 'bad/id' }),
    Object.assign({}, templates.get('builtin-basic-life'), { monthlyBudget: 1 })
  ] })
  assert.strictEqual(mixed.added, 1)
  assert.strictEqual(mixed.skipped, 3)
  assert.strictEqual(templates.get('mine-1').name, '我的预算')
  assert.throws(function () { templates.importData({ kind: 'budget_templates', version: 2, items: [] }) }, /格式不对/)
  assert.throws(function () { templates.importData('bad') }, /格式不对/)
  failKeys[templates.KEY] = true
  assert.strictEqual(templates.save(template({ id: 'no-space' })), null)
  backup.items[0].name = '需要写入的新模板'
  assert.strictEqual(templates.importData(backup).saved, false)
})

var pageDefinition
global.Page = function (definition) { pageDefinition = definition }
require('../pages/budget-templates/budget-templates.js')

function pageInstance() {
  var page = Object.assign({}, pageDefinition, { data: JSON.parse(JSON.stringify(pageDefinition.data)) })
  page.setData = function (patch, callback) {
    Object.assign(this.data, patch)
    if (callback) callback()
  }
  return page
}

function readyPage() {
  var page = pageInstance()
  page.onLoad()
  page.onShow()
  page.openDraft()
  return page
}

function input(page, handler, value, dataset) {
  page[handler]({ currentTarget: { dataset: dataset || {} }, detail: { value: value } })
}

test('page selects templates and previews edited values without touching store', function () {
  var page = pageInstance()
  page.onLoad()
  page.onShow()
  assert.strictEqual(page.data.builtinTemplates.length, 3)
  assert.strictEqual(page.data.preview.name, '基础生活')
  assert.strictEqual(page.data.draftName, '基础生活（我的）')
  page.selectTemplate({ currentTarget: { dataset: { id: 'builtin-travel-month' } } })
  assert.strictEqual(page.data.preview.name, '旅行月')
  assert.strictEqual(page.data.draftName, '旅行月（我的）')
  page.openDraft()
  input(page, 'onBudgetInput', '9000')
  input(page, 'onCategoryAmount', '6000', { index: page.data.categories.indexOf('旅行') })
  assert.strictEqual(page.data.draftBudget, '9000')
  assert.strictEqual(page.data.draftRows[page.data.categories.indexOf('旅行')].amount, '6000')
  input(page, 'onIncomeInput', '12000')
  assert.strictEqual(page.data.preview.budgetRate, Math.round(8000 / 12000 * 1000) / 10)
  assert.strictEqual(store.budget(), 0)
  assert.deepStrictEqual(store.catBudgets(), {})
  page.onUnload()
})

test('page saves, edits and deletes custom templates', function () {
  var page = readyPage()
  input(page, 'onNameInput', '页面模板')
  input(page, 'onBudgetInput', '2600')
  input(page, 'onCategoryAmount', '1000', { index: page.data.categories.indexOf('餐饮') })
  page.saveCustom()
  var saved = templates.list().filter(function (item) { return item.name === '页面模板' })[0]
  assert.ok(saved)
  assert.strictEqual(saved.monthlyBudget, 2600)
  page.editTemplate({ currentTarget: { dataset: { id: saved.id } } })
  input(page, 'onBudgetInput', '2700')
  page.saveCustom()
  assert.strictEqual(templates.get(saved.id).monthlyBudget, 2700)
  page.removeTemplate({ currentTarget: { dataset: { id: saved.id } } })
  assert.ok(modalOptions && /删除/.test(modalOptions.content))
  assert.strictEqual(store.budget(), 0)
  page.onUnload()
})

test('page rejects invalid draft values before saving', function () {
  var page = readyPage()
  input(page, 'onNameInput', '')
  page.saveCustom()
  assert.strictEqual(templates.list().length, 3)
  input(page, 'onNameInput', '无效金额')
  input(page, 'onBudgetInput', '-1')
  page.saveCustom()
  assert.strictEqual(templates.list().length, 3)
  page.onUnload()
})

test('page apply requires member and second confirmation, then replaces both budgets', function () {
  var page = readyPage()
  store.setBudget(123)
  store.setCatBudget('娱乐', 77)
  store.setCatBudget('购物', 66)
  wx.setStorageSync(vip.KEY, { expireAt: 0 })
  page.applyTemplate()
  assert.strictEqual(store.budget(), 123)
  assert.ok(modalOptions && /会员功能/.test(modalOptions.title))
  assert.strictEqual(modalOptions.confirmText, '去开通')
  assert.strictEqual(modalOptions.success({ confirm: true }), undefined)
  assert.strictEqual(wx.lastNavigation, '/pages/vip/vip')

  wx.setStorageSync(vip.KEY, { expireAt: Date.now() + 86400000 })
  page.applyTemplate()
  assert.ok(/覆盖当前月预算与现有分类预算/.test(modalOptions.content))
  assert.ok(/未列出的分类预算将被清除/.test(modalOptions.content))
  assert.strictEqual(store.budget(), 123)
  assert.strictEqual(store.catBudgets()['娱乐'], 77)
  var selected = templates.get(page.data.selectedId)
  page._confirmApply = modalOptions.success
  page._confirmApply({ confirm: true })
  assert.strictEqual(store.budget(), selected.monthlyBudget)
  assert.deepStrictEqual(Object.assign({}, store.catBudgets()), selected.categoryBudgets)
  assert.strictEqual(store.catBudgets()['娱乐'], undefined)
  assert.strictEqual(page.data.applying, false)
  page.onUnload()
})

test('page apply rolls back atomically when a budget key write fails', function () {
  var page = readyPage()
  store.setBudget(321)
  store.setCatBudget('娱乐', 45)
  store.setCatBudget('购物', 67)
  var oldCats = Object.assign({}, store.catBudgets())
  var selected = templates.get(page.data.selectedId)
  failKeys.budget_v1 = true
  page.applyTemplate()
  modalOptions.success({ confirm: true })
  assert.strictEqual(store.budget(), 321)
  assert.deepStrictEqual(Object.assign({}, store.catBudgets()), oldCats)
  assert.strictEqual(page.data.applying, false)
  assert.notDeepStrictEqual(Object.assign({}, store.catBudgets()), selected.categoryBudgets)
  page.onUnload()
})

test('canceling page apply leaves month and category budgets unchanged', function () {
  var page = readyPage()
  store.setBudget(456)
  store.setCatBudget('娱乐', 78)
  var beforeCats = store.catBudgets()
  page.applyTemplate()
  assert.ok(modalOptions)
  modalOptions.success({ confirm: false })
  assert.strictEqual(store.budget(), 456)
  assert.deepStrictEqual(store.catBudgets(), beforeCats)
  assert.strictEqual(page.data.applying, false)
  assert.strictEqual(wx.lastTab, undefined)
  page.onUnload()
})

test('page backup copies JSON and merge restores templates', function () {
  var page = readyPage()
  page.exportTemplates()
  assert.strictEqual(JSON.parse(clipboard).kind, 'budget_templates')
  input(page, 'onNameInput', '备份模板')
  page.saveCustom()
  var id = page.data.selectedId
  var saved = templates.get(id)
  assert.ok(saved && saved.name === '备份模板')
  page.exportTemplates()
  templates.remove(id)
  page.mergeBackup()
  assert.ok(modalOptions && /相同 ID/.test(modalOptions.content))
  modalOptions.success({ confirm: true })
  assert.ok(templates.get(id))
  page.onUnload()
})

test('theme watcher unregisters and report navigation uses budget section', function () {
  var page = pageInstance()
  page.onLoad()
  assert.strictEqual(typeof page._stopThemeWatch, 'function')
  page.goReport()
  assert.strictEqual(wx.lastTab, '/pages/report/report')
  var app = { globalData: {} }
  global.getApp = function () { return app }
  page.goReport()
  assert.strictEqual(app.globalData.reportSection, 'budget')
  assert.strictEqual(app.globalData.reportYm, format.ymOf(Date.now()))
  delete global.getApp
  page.onUnload()
})

test('WXML bindings exist, overwrite notice and dark/safe-area styles are present', function () {
  var root = path.resolve(__dirname, '..')
  var wxml = fs.readFileSync(path.join(root, 'pages/budget-templates/budget-templates.wxml'), 'utf8')
  var wxss = fs.readFileSync(path.join(root, 'pages/budget-templates/budget-templates.wxss'), 'utf8')
  var bindings = wxml.match(/(?:bind|catch)[:\-]?(?:tap|change|input)="([^"]+)"/g) || []
  bindings.forEach(function (binding) {
    var name = binding.match(/"([^"]+)"/)[1]
    assert.strictEqual(typeof pageDefinition[name], 'function', 'missing handler ' + name)
  })
  assert.ok(wxml.includes('theme-{{themeKey}}'))
  assert.ok(wxml.includes("{{dark ? 'dark' : ''}}"))
  assert.ok(wxml.includes('覆盖当前月预算与现有分类预算'))
  assert.ok(wxml.includes('内置金额仅为示例'))
  assert.ok(wxml.includes('/pages/budget-templates/budget-templates'))
  assert.ok(wxml.includes('bindtap="openDraft"'))
  assert.ok(!wxml.includes('sheet-mask'))
  assert.ok(wxss.includes('env(safe-area-inset-bottom)'))
  assert.ok(wxss.includes('.dark'))
  assert.ok(wxss.includes('var(--brand'))
})

console.log('\n' + pass + ' passed, ' + failed + ' failed')
if (failed) process.exitCode = 1
