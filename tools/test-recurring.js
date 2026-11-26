// node tools/test-recurring.js
var assert = require('assert')
var storage = Object.create(null)
var failKeys = Object.create(null)

global.wx = {
  getStorageSync: function (key) { return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : '' },
  setStorageSync: function (key, value) {
    if (failKeys[key]) throw new Error('injected storage failure: ' + key)
    storage[key] = value
  },
  removeStorageSync: function (key) { delete storage[key] },
  showToast: function () {},
  getAppBaseInfo: function () { return { theme: 'light' } },
  onThemeChange: function () {},
  offThemeChange: function () {},
  showModal: function () {}
}

var store = require('../utils/store')
var recurring = require('../utils/recurring')
var config = require('../utils/config')
var pass = 0
var failed = 0

function reset() {
  Object.keys(storage).forEach(function (key) { delete storage[key] })
  Object.keys(failKeys).forEach(function (key) { delete failKeys[key] })
  config.REMINDER.recurringTemplateId = ''
  delete wx.requestSubscribeMessage
  wx.showToast = function () {}
  wx.showModal = function () {}
  store.reload()
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

function item(patch) {
  return Object.assign({
    id: 'rent', name: '房租', type: 'expense', category: '居住', amount: 2000,
    merchant: '房东', note: '每月房租', accountId: '银行卡', fromAccountId: '', toAccountId: '',
    interval: 'month', dayOfMonth: 31, dayOfWeek: 1, startDate: '2024-01-31',
    nextDate: '2024-01-31', enabled: true, lastGenerated: '', skipped: {}
  }, patch || {})
}

function ledgerIds() { return store.all().map(function (tx) { return tx.id }) }

test('month-end clamping: Jan 31 -> Feb 29 -> Mar 31 -> Apr 30', function () {
  recurring.save(item())
  assert.strictEqual(recurring.generateOne('rent').date, '2024-01-31')
  assert.strictEqual(recurring.list()[0].nextDate, '2024-02-29')
  assert.strictEqual(recurring.generateOne('rent').date, '2024-02-29')
  assert.strictEqual(recurring.list()[0].nextDate, '2024-03-31')
  assert.strictEqual(recurring.generateOne('rent').date, '2024-03-31')
  assert.strictEqual(recurring.list()[0].nextDate, '2024-04-30')
  assert.deepStrictEqual(ledgerIds(), ['r:rent:2024-03-31', 'r:rent:2024-02-29', 'r:rent:2024-01-31'])
})

test('weekly schedule uses weekday and advances seven days', function () {
  recurring.save(item({ id: 'weekly', interval: 'week', dayOfWeek: 1, startDate: '2024-01-03', nextDate: '2024-01-08' }))
  recurring.generateOne('weekly')
  assert.strictEqual(recurring.list()[0].nextDate, '2024-01-15')
  recurring.generateOne('weekly')
  assert.strictEqual(recurring.list()[0].nextDate, '2024-01-22')
  assert.strictEqual(store.all()[0].day, '2024-01-15')
})

test('first weekly occurrence is on/after start date', function () {
  var row = recurring.save(item({ id: 'weekly', interval: 'week', dayOfWeek: 1, startDate: '2024-01-03', nextDate: '' }))
  assert.strictEqual(row.nextDate, '2024-01-08')
})

test('annual Feb 29 clamps in common years and restores leap day', function () {
  recurring.save(item({ id: 'annual', interval: 'year', startDate: '2024-02-29', nextDate: '2024-02-29' }))
  var expected = ['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']
  expected.forEach(function (date, index) {
    assert.strictEqual(recurring.generateOne('annual').date, date)
    if (index < expected.length - 1) assert.strictEqual(recurring.list()[0].nextDate, expected[index + 1])
  })
})

test('first monthly occurrence respects day and start date', function () {
  var row = recurring.save(item({ id: 'rent', startDate: '2024-01-15', nextDate: '' }))
  assert.strictEqual(row.nextDate, '2024-01-31')
})

test('stable transaction id and duplicate generation never double-book', function () {
  recurring.save(item())
  var first = recurring.generateOne('rent', '2024-01-31')
  assert.strictEqual(first.txId, 'r:rent:2024-01-31')
  var second = recurring.generateOne('rent', '2024-01-31')
  assert.strictEqual(second.duplicate, true)
  assert.strictEqual(second.generated, false)
  assert.strictEqual(store.all().length, 1)
  assert.strictEqual(recurring.generateDue('2024-01-31').generated, 0)
  assert.strictEqual(store.all().length, 1)
})

test('existing stable id is adopted and recurring schedule advances', function () {
  recurring.save(item())
  store.addOne({ id: 'r:rent:2024-01-31', day: '2024-01-31', amount: 2000, type: 'expense', time: 1 })
  var result = recurring.generateOne('rent')
  assert.strictEqual(result.duplicate, true)
  assert.strictEqual(recurring.list()[0].nextDate, '2024-02-29')
  assert.strictEqual(store.all().length, 1)
})

test('disabled and off-current periods are not generated', function () {
  recurring.save(item({ enabled: false }))
  assert.strictEqual(recurring.generateOne('rent').status, 'disabled')
  recurring.toggle('rent', true)
  assert.strictEqual(recurring.generateOne('rent', '2023-12-31').status, 'invalid-date')
  assert.strictEqual(recurring.generateOne('rent', '2024-02-29').status, 'not-current')
  assert.strictEqual(store.all().length, 0)
})

test('skip marks the period and advances without generating a transaction', function () {
  recurring.save(item())
  var skipped = recurring.skipNext('rent')
  assert.strictEqual(skipped.skipped['2024-01-31'], true)
  assert.strictEqual(skipped.nextDate, '2024-02-29')
  assert.strictEqual(recurring.generateOne('rent', '2024-01-31').status, 'skipped')
  assert.strictEqual(store.all().length, 0)
  assert.strictEqual(recurring.list()[0].nextDate, '2024-02-29')
})

test('due includes overdue/today/upcoming but excludes disabled items', function () {
  recurring.save(item({ id: 'old', startDate: '2023-01-01', nextDate: '2024-01-01', dayOfMonth: 1 }))
  recurring.save(item({ id: 'today', startDate: '2023-01-01', nextDate: '2024-01-10', dayOfMonth: 10 }))
  recurring.save(item({ id: 'soon', startDate: '2023-01-01', nextDate: '2024-01-15', dayOfMonth: 15 }))
  recurring.save(item({ id: 'later', startDate: '2023-01-01', nextDate: '2024-01-20', dayOfMonth: 20 }))
  recurring.save(item({ id: 'off', startDate: '2023-01-01', nextDate: '2024-01-10', enabled: false }))
  var rows = recurring.due('2024-01-10', 7)
  assert.deepStrictEqual(rows.map(function (row) { return row.id }), ['old', 'today', 'soon'])
  assert.deepStrictEqual(rows.map(function (row) { return row.daysLeft }), [-9, 0, 5])
})

test('reminder preferences use independent validated storage and configured template', function () {
  assert.strictEqual(recurring.REMINDER_KEY, 'recurring_reminder_v1')
  assert.deepStrictEqual(recurring.getReminderPrefs(), {
    enabled: false, leadDays: 3, subscribedAt: 0, templateId: ''
  })
  assert.strictEqual(storage.recurring_v1, undefined)
  config.REMINDER.recurringTemplateId = 'tpl_recurring'
  storage.recurring_reminder_v1 = { enabled: 'true', leadDays: 99, subscribedAt: -1, templateId: 'stale' }
  assert.deepStrictEqual(recurring.getReminderPrefs(), {
    enabled: false, leadDays: 3, subscribedAt: 0, templateId: 'tpl_recurring'
  })
  var saved = recurring.saveReminderPrefs({ enabled: true, leadDays: 0, subscribedAt: 123, templateId: 'forged' })
  assert.deepStrictEqual(saved, { enabled: true, leadDays: 0, subscribedAt: 123, templateId: 'tpl_recurring' })
  assert.deepStrictEqual(storage.recurring_reminder_v1, saved)
  assert.strictEqual(recurring.saveReminderPrefs({ leadDays: 7 }).leadDays, 7)
  ;[null, [], { enabled: 'yes' }, { leadDays: null }, { leadDays: '' }, { leadDays: -1 },
    { leadDays: 8 }, { leadDays: 1.5 }, { leadDays: NaN }, { subscribedAt: -1 },
    { subscribedAt: 1.5 }, { subscribedAt: null }].forEach(function (patch) {
    assert.strictEqual(recurring.saveReminderPrefs(patch), null)
  })
  assert.strictEqual(recurring.getReminderPrefs().leadDays, 7)
  failKeys.recurring_reminder_v1 = true
  assert.strictEqual(recurring.saveReminderPrefs({ leadDays: 1 }), null)
  assert.strictEqual(recurring.getReminderPrefs().leadDays, 7)
  config.REMINDER.recurringTemplateId = ''
  assert.strictEqual(recurring.getReminderPrefs().templateId, '')
})

test('reminderItems honors the lead-day window and excludes skipped or disabled bills', function () {
  recurring.saveReminderPrefs({ enabled: true, leadDays: 2 })
  recurring.save(item({ id: 'old', startDate: '2023-01-01', nextDate: '2024-01-05' }))
  recurring.save(item({ id: 'today', startDate: '2023-01-01', nextDate: '2024-01-10' }))
  recurring.save(item({ id: 'edge', startDate: '2023-01-01', nextDate: '2024-01-12' }))
  recurring.save(item({ id: 'later', startDate: '2023-01-01', nextDate: '2024-01-13' }))
  recurring.save(item({ id: 'off', startDate: '2023-01-01', nextDate: '2024-01-10', enabled: false }))
  recurring.save(item({ id: 'skip', startDate: '2023-01-01', nextDate: '2024-01-11', skipped: { '2024-01-11': true } }))
  var rows = recurring.reminderItems('2024-01-10')
  assert.deepStrictEqual(rows.map(function (row) { return row.id }), ['old', 'today', 'edge'])
  assert.deepStrictEqual(rows.map(function (row) { return row.daysLeft }), [-5, 0, 2])
  recurring.saveReminderPrefs({ leadDays: 0 })
  assert.deepStrictEqual(recurring.reminderItems('2024-01-10').map(function (row) { return row.id }), ['old', 'today'])
  recurring.saveReminderPrefs({ enabled: false })
  assert.deepStrictEqual(recurring.reminderItems('2024-01-10'), [])
})

test('generateDue handles each due item once and does not backfill history', function () {
  recurring.save(item({ id: 'old', startDate: '2023-01-31', nextDate: '2023-12-31' }))
  recurring.save(item({ id: 'today', nextDate: '2024-01-31' }))
  recurring.save(item({ id: 'later', nextDate: '2024-02-29' }))
  var result = recurring.generateDue('2024-01-31')
  assert.strictEqual(result.generated, 2)
  assert.strictEqual(store.all().length, 2)
  assert.ok(!ledgerIds().includes('r:old:2023-11-30'))
  /* 上期逾期补到 12/31 后，下一期 1/31 是另一个周期；再点会生成这一期，而不是重复 12/31。 */
  var again = recurring.generateDue('2024-01-31')
  assert.strictEqual(again.generated, 1)
  assert.strictEqual(store.all().filter(function (tx) { return tx.id === 'r:old:2023-12-31' }).length, 1)
  assert.strictEqual(store.all().filter(function (tx) { return tx.id === 'r:old:2024-01-31' }).length, 1)
  assert.strictEqual(store.all().length, 3)
})

test('transaction maps income, expense, transfer and recurring metadata', function () {
  recurring.save(item({ id: 'salary', type: 'income', category: '工资', accountId: '银行卡', amount: 5000 }))
  recurring.save(item({ id: 'move', type: 'transfer', fromAccountId: 'A', toAccountId: 'B', amount: 100, nextDate: '2024-01-31' }))
  recurring.generateOne('salary')
  recurring.generateOne('move')
  var income = store.all().filter(function (tx) { return tx.recurringId === 'salary' })[0]
  var transfer = store.all().filter(function (tx) { return tx.recurringId === 'move' })[0]
  assert.strictEqual(income.account, '银行卡')
  assert.strictEqual(income.source, '周期账单')
  assert.strictEqual(transfer.fromAccount, 'A')
  assert.strictEqual(transfer.toAccount, 'B')
})

test('save, toggle and remove update recurring_v1', function () {
  assert.strictEqual(recurring.KEY, 'recurring_v1')
  var row = recurring.save(item())
  assert.strictEqual(row.amount, 2000)
  assert.strictEqual(recurring.toggle('rent', false).enabled, false)
  assert.strictEqual(recurring.toggle('rent').enabled, true)
  assert.strictEqual(recurring.remove('rent'), true)
  assert.deepStrictEqual(recurring.list(), [])
  assert.strictEqual(recurring.remove('missing'), false)
})

test('editing schedule recalculates from today instead of backfilling', function () {
  recurring.save(item())
  var row = recurring.save(item({ dayOfMonth: 15, nextDate: '2024-01-31' }), { today: '2024-03-20' })
  assert.strictEqual(row.nextDate, '2024-04-15')
})

test('bad storage and malformed rows are ignored or safely repaired', function () {
  storage.recurring_v1 = { nope: true }
  assert.deepStrictEqual(recurring.list(), [])
  storage.recurring_v1 = [null, 'bad', item({ id: '' }), item({ amount: -1 }), item({ interval: 'daily' }),
    item({ id: 'good', nextDate: '2024-02-30', skipped: { '2024-01-31': true, bad: true, '2024-02-29': false } })]
  var rows = recurring.list()
  assert.strictEqual(rows.length, 1)
  assert.strictEqual(rows[0].nextDate, '2024-01-31')
  assert.deepStrictEqual(rows[0].skipped, { '2024-01-31': true })
  assert.strictEqual(recurring.save(item({ amount: NaN })), null)
  assert.strictEqual(recurring.list().length, 1)
})

test('export/import round-trip, merge ids, and skip malformed backup rows', function () {
  recurring.save(item())
  var backup = JSON.parse(JSON.stringify(recurring.exportData()))
  recurring.remove('rent')
  var result = recurring.importData(backup)
  assert.strictEqual(result.added, 1)
  assert.deepStrictEqual(recurring.list()[0], item())
  var duplicate = recurring.importData(backup)
  assert.strictEqual(duplicate.updated, 1)
  assert.strictEqual(recurring.list().length, 1)
  var mixed = recurring.importData({ kind: 'recurring', version: 1, items: [item({ id: 'other' }), null, item({ amount: 0 })] })
  assert.strictEqual(mixed.added, 1)
  assert.strictEqual(mixed.skipped, 2)
  assert.throws(function () { recurring.importData({ kind: 'recurring', version: 2, items: [] }) }, /格式不对/)
  assert.throws(function () { recurring.importData('bad') }, /格式不对/)
})

test('ledger storage failure does not advance the period', function () {
  recurring.save(item())
  failKeys.txs_v1 = true
  var result = recurring.generateOne('rent')
  assert.strictEqual(result.status, 'store-failed')
  assert.strictEqual(recurring.list()[0].nextDate, '2024-01-31')
  delete failKeys.txs_v1
  recurring.generateOne('rent')
  assert.strictEqual(store.all().length, 1)
})

test('recurring storage failure after ledger write is recoverable without duplicate', function () {
  recurring.save(item())
  failKeys.recurring_v1 = true
  var first = recurring.generateOne('rent')
  assert.strictEqual(first.generated, true)
  assert.strictEqual(first.saved, false)
  assert.strictEqual(store.all().length, 1)
  delete failKeys.recurring_v1
  var retry = recurring.generateOne('rent')
  assert.strictEqual(retry.duplicate, true)
  assert.strictEqual(retry.saved, true)
  assert.strictEqual(store.all().length, 1)
  assert.strictEqual(recurring.list()[0].nextDate, '2024-02-29')
})

var pageDefinition
global.Page = function (definition) { pageDefinition = definition }
require('../pages/recurring/recurring.js')

function pageInstance() {
  var page = Object.assign({}, pageDefinition, { data: JSON.parse(JSON.stringify(pageDefinition.data)) })
  page.setData = function (patch) { Object.assign(this.data, patch) }
  return page
}

function confirmModals() {
  wx.showModal = function (options) { if (options.success) options.success({ confirm: true }) }
}

test('page adds, edits, toggles and deletes an item', function () {
  confirmModals()
  var page = pageInstance()
  page.onLoad()
  page.onShow()
  page.openForm({ currentTarget: { dataset: {} } })
  page.onFormInput({ currentTarget: { dataset: { field: 'name' } }, detail: { value: '手机套餐' } })
  page.onFormInput({ currentTarget: { dataset: { field: 'amount' } }, detail: { value: '39.00' } })
  page.submitForm()
  assert.strictEqual(page.data.items.length, 1)
  var id = page.data.items[0].id
  page.openForm({ currentTarget: { dataset: { id: id } } })
  page.onFormInput({ currentTarget: { dataset: { field: 'amount' } }, detail: { value: '49.00' } })
  page.submitForm()
  assert.strictEqual(recurring.list()[0].amount, 49)
  page.toggleItem({ currentTarget: { dataset: { id: id } }, detail: { value: false } })
  assert.strictEqual(page.data.items[0].enabled, false)
  page.deleteItem({ currentTarget: { dataset: { id: id } } })
  assert.strictEqual(page.data.items.length, 0)
  page.onUnload()
})

test('page displays due items and generates only after confirmation', function () {
  confirmModals()
  var page = pageInstance()
  page.onLoad()
  var today = page.data.today
  recurring.save(item({ id: 'page-due', startDate: today, nextDate: today, dayOfMonth: Number(today.slice(-2)) }))
  page.onShow()
  assert.strictEqual(page.data.dueToday.length, 1)
  assert.strictEqual(page.data.dueCount, 1)
  page.generateDue()
  assert.strictEqual(store.all().length, 1)
  assert.strictEqual(page.data.dueCount, 0)
  assert.ok(page.data.items[0].lastGenerated)
  page.onUnload()
})

test('page selects configured accounts for recurring transactions', function () {
  var accounts = require('../utils/accounts')
  var cash = accounts.save({ name: '现金', type: 'cash', openingBalance: 0, includeInNetWorth: true })
  var page = pageInstance()
  page.onLoad()
  page.openForm({ currentTarget: { dataset: {} } })
  assert.strictEqual(page.data.accountOptions.length, 2)
  page.onAccount({ detail: { value: 1 } })
  page.onFormInput({ currentTarget: { dataset: { field: 'name' } }, detail: { value: '现金房租' } })
  page.onFormInput({ currentTarget: { dataset: { field: 'amount' } }, detail: { value: '100' } })
  page.submitForm()
  assert.strictEqual(recurring.list()[0].accountId, cash.id)
  page.onUnload()
})

test('page reminder switch and lead days refresh the in-app list', function () {
  recurring.saveReminderPrefs({ enabled: true, leadDays: 0 })
  var page = pageInstance()
  page.onLoad()
  page.onShow()
  var today = page.data.today
  recurring.save(item({ id: 'page-reminder', startDate: today, nextDate: today, dayOfMonth: Number(today.slice(-2)) }))
  page.refresh()
  assert.strictEqual(page.data.reminderItems.length, 1)
  assert.strictEqual(page.data.reminderItems[0].whenText, '今天到期')
  page.onReminderLeadDays({ detail: { value: 7 } })
  assert.strictEqual(page.data.reminderPrefs.leadDays, 7)
  page.toggleReminder({ detail: { value: false } })
  assert.strictEqual(page.data.reminderItems.length, 0)
  assert.strictEqual(recurring.getReminderPrefs().enabled, false)
  page.toggleReminder({ detail: { value: true } })
  assert.strictEqual(page.data.reminderItems.length, 1)
  page.onUnload()
})

test('missing reminder template degrades without calling WeChat authorization', function () {
  var calls = 0
  var modal
  wx.requestSubscribeMessage = function () { calls++ }
  wx.showModal = function (options) { modal = options }
  var page = pageInstance()
  page.onLoad()
  page.onShow()
  page.authorizeReminder()
  assert.strictEqual(calls, 0)
  assert.ok(/仅应用内提醒/.test(modal.title))
  assert.ok(/未配置/.test(modal.content))
  assert.strictEqual(recurring.getReminderPrefs().subscribedAt, 0)
  assert.strictEqual(page.data.reminderAuthorizing, false)
  page.onUnload()
})

test('unavailable subscribe API degrades to in-app reminders', function () {
  config.REMINDER.recurringTemplateId = 'tpl_recurring'
  delete wx.requestSubscribeMessage
  var modal
  wx.showModal = function (options) { modal = options }
  var page = pageInstance()
  page.onLoad()
  page.onShow()
  page.authorizeReminder()
  assert.ok(/仅应用内提醒/.test(modal.title))
  assert.ok(/不支持/.test(modal.content))
  assert.strictEqual(recurring.getReminderPrefs().subscribedAt, 0)
  assert.strictEqual(page.data.reminderAuthorizing, false)
  page.onUnload()
})

test('accepted WeChat subscription records authorization and reports platform limits', function () {
  config.REMINDER.recurringTemplateId = 'tpl_recurring'
  var requested
  var modal
  wx.requestSubscribeMessage = function (options) {
    requested = options.tmplIds
    options.success({ errMsg: 'requestSubscribeMessage:ok', tpl_recurring: 'accept' })
  }
  wx.showModal = function (options) { modal = options }
  var page = pageInstance()
  page.onLoad()
  page.onShow()
  page.authorizeReminder()
  assert.deepStrictEqual(requested, ['tpl_recurring'])
  assert.ok(recurring.getReminderPrefs().subscribedAt > 0)
  assert.strictEqual(page.data.reminderPrefs.templateId, 'tpl_recurring')
  assert.strictEqual(modal.title, '微信提醒已授权')
  assert.ok(/没有后台定时推送/.test(modal.content))
  assert.strictEqual(page.data.reminderAuthorizing, false)
  page.onUnload()
})

test('rejected WeChat subscription is reported and not recorded as authorization', function () {
  config.REMINDER.recurringTemplateId = 'tpl_recurring'
  var modal
  wx.requestSubscribeMessage = function (options) {
    options.success({ errMsg: 'requestSubscribeMessage:ok', tpl_recurring: 'reject' })
  }
  wx.showModal = function (options) { modal = options }
  var page = pageInstance()
  page.onLoad()
  page.onShow()
  page.authorizeReminder()
  assert.strictEqual(modal.title, '未获得微信提醒授权')
  assert.ok(/拒绝/.test(modal.content))
  assert.strictEqual(recurring.getReminderPrefs().subscribedAt, 0)
  assert.strictEqual(page.data.reminderAuthorizing, false)
  page.onUnload()
})

test('failed WeChat subscription is reported without changing authorization state', function () {
  config.REMINDER.recurringTemplateId = 'tpl_recurring'
  var modal
  wx.requestSubscribeMessage = function (options) {
    options.fail({ errMsg: 'requestSubscribeMessage:fail' })
  }
  wx.showModal = function (options) { modal = options }
  var page = pageInstance()
  page.onLoad()
  page.onShow()
  page.authorizeReminder()
  assert.strictEqual(modal.title, '微信提醒授权失败')
  assert.ok(/requestSubscribeMessage:fail/.test(modal.content))
  assert.strictEqual(recurring.getReminderPrefs().subscribedAt, 0)
  assert.strictEqual(page.data.reminderAuthorizing, false)
  page.onUnload()
})

test('WXML handlers exist and manual-generation notice is explicit', function () {
  var fs = require('fs')
  var path = require('path')
  var root = path.resolve(__dirname, '..')
  var wxml = fs.readFileSync(path.join(root, 'pages/recurring/recurring.wxml'), 'utf8')
  var handlers = wxml.match(/(?:bind|catch)[:\-]?(?:tap|change|input)="([^"]+)"/g) || []
  handlers.forEach(function (binding) {
    var name = binding.match(/"([^"]+)"/)[1]
    assert.strictEqual(typeof pageDefinition[name], 'function', 'missing handler ' + name)
  })
  assert.ok(wxml.includes('不会在后台自动运行') && wxml.includes('不会发送推送'))
  assert.ok(wxml.includes('授权微信提醒') && wxml.includes('仅应用内提醒'))
  assert.ok(wxml.includes('不创建后台定时任务'))
})

console.log('\n' + pass + ' passed, ' + failed + ' failed')
if (failed) process.exitCode = 1
