/* 多账户与余额视图：node tools/test-accounts.js */
var assert = require('node:assert/strict')
var fs = require('node:fs')
var path = require('node:path')
var test = require('node:test')

var root = path.resolve(__dirname, '..')
var disk = {}
var modals = []
var toasts = []
var tabStyles = []
var navTitles = []
var storageFailure = false
var failedKey = ''
var systemDark = true
var themeListener = null

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

global.wx = {
  getStorageSync: function (key) { return key in disk ? clone(disk[key]) : '' },
  setStorageSync: function (key, value) {
    if (storageFailure || key === failedKey) throw new Error('storage full')
    disk[key] = clone(value)
  },
  removeStorageSync: function (key) { delete disk[key] },
  getAppBaseInfo: function () { return { theme: systemDark ? 'dark' : 'light' } },
  getSystemInfoSync: function () { return { theme: systemDark ? 'dark' : 'light' } },
  onThemeChange: function (listener) { themeListener = listener },
  offThemeChange: function (listener) { if (themeListener === listener) themeListener = null },
  setTabBarStyle: function (options) { tabStyles.push(options) },
  setTabBarItem: function () {},
  setNavigationBarTitle: function (options) { navTitles.push(options.title) },
  showModal: function (options) { modals.push(options) },
  showToast: function (options) { toasts.push(options) }
}

var accounts = require('../utils/accounts')
var exchangeRates = require('../utils/exchange-rates')
var store = require('../utils/store')

function reset() {
  disk = {}
  modals = []
  toasts = []
  tabStyles = []
  navTitles = []
  storageFailure = false
  failedKey = ''
  systemDark = true
  themeListener = null
  disk.theme_v1 = 'ink'
  accounts.reload()
  store.reload()
}

function account(name, type, opening, include, id) {
  return accounts.save({
    id: id,
    name: name,
    type: type,
    openingBalance: opening,
    includeInNetWorth: include,
    createdAt: 1700000000000
  })
}

function last(list) { return list[list.length - 1] }

function loadPage() {
  var definition
  global.Page = function (options) { definition = options }
  var file = path.join(root, 'pages/accounts/accounts.js')
  delete require.cache[file]
  require(file)
  var page = Object.assign({}, definition, { data: clone(definition.data) })
  page.setData = function (patch, callback) {
    Object.assign(this.data, patch)
    if (callback) callback()
  }
  return page
}

test('账户模型按 accounts_v1 存储，金额按分规范化', function () {
  reset()
  assert.deepEqual(accounts.list(), [])
  var cash = account('  现金  ', 'cash', '1000.10', false)
  assert.ok(cash.id)
  assert.equal(cash.name, '现金')
  assert.equal(cash.openingBalance, 1000.1)
  assert.equal(cash.includeInNetWorth, false)
  assert.equal(cash.createdAt, 1700000000000)
  assert.deepEqual(disk.accounts_v1, [cash])
  assert.deepEqual(accounts.get(cash.id), cash)

  var updated = accounts.save({ id: cash.id, name: '现金', type: 'cash', openingBalance: '1000.20', includeInNetWorth: true })
  assert.equal(updated.openingBalance, 1000.2)
  assert.equal(updated.createdAt, cash.createdAt)
  assert.equal(accounts.list().length, 1)

  assert.equal(account('银行卡', 'bank', -1, true), null)
  assert.match(accounts.error(), /只有信用卡/)
  var credit = account('信用卡', 'credit', -1200.25, true)
  assert.equal(credit.openingBalance, -1200.25)
  assert.equal(account('', 'cash', 0, true), null)
  assert.match(accounts.error(), /账户名称/)
  assert.equal(account('钱包', 'wallet', '1.234', true), null)
  assert.match(accounts.error(), /两位小数/)
})

test('单账户收支、退款和旧 account 字段的余额计算正确', function () {
  reset()
  var cash = account('现金', 'cash', 100.10, true, 'cash')
  var bank = account('银行卡', 'bank', 1000, true, 'bank')
  var wallet = account('微信', 'wallet', 50, true, 'wallet')
  var credit = account('信用卡', 'credit', 0, true, 'credit')
  var excluded = account('不计入账户', 'bank', 999, false, 'excluded')
  var txs = [
    { id: 't1', type: 'expense', amount: 0.20, accountId: 'cash', account: '微信' },
    { id: 't2', type: 'income', amount: 10.01, accountId: 'cash' },
    { id: 't3', type: 'refund', amount: 0.09, accountId: 'cash' },
    { id: 't4', type: 'expense', amount: 100.50, accountId: 'bank' },
    { id: 't5', type: 'income', amount: 88, account: '微信' },
    { id: 't6', type: 'expense', amount: 123.45, accountId: 'credit' },
    { id: 't7', type: 'expense', amount: 100, accountId: 'excluded' },
    { id: 't8', type: 'expense', amount: 5, accountId: 'missing' }
  ]
  var values = accounts.balances(txs)
  assert.equal(values[cash.id], 11000)
  assert.equal(values[bank.id], 89950)
  assert.equal(values[wallet.id], 5000)
  assert.equal(values[credit.id], -12345)
  assert.equal(values[excluded.id], 89900)
  assert.equal(values.missing, undefined)
  assert.equal(accounts.netWorth(txs), 93605)
  assert.equal(txs[0].account, '微信')
})

test('转账等额扣减转入，不改变净资产，自转与不完整转账不重复计算', function () {
  reset()
  account('现金', 'cash', 100, true, 'cash')
  account('银行卡', 'bank', 200, true, 'bank')
  var txs = [
    { id: 'move', type: 'transfer', amount: 30.01, fromAccountId: 'cash', toAccountId: 'bank', accountId: 'cash' },
    { id: 'self', type: 'transfer', amount: 10, fromAccountId: 'cash', toAccountId: 'cash' },
    { id: 'legacy', type: 'transfer', amount: 20, accountId: 'cash' }
  ]
  var values = accounts.balances(txs)
  assert.equal(values.cash, 6999)
  assert.equal(values.bank, 23001)
  assert.equal(accounts.netWorth(txs), 30000)
})

test('信用卡负余额合法并真实参与净资产', function () {
  reset()
  account('信用卡', 'credit', -500, true, 'credit')
  account('储蓄卡', 'bank', 1000, true, 'bank')
  assert.equal(accounts.netWorth([{ type: 'expense', amount: 125.55, accountId: 'credit' }]), 37445)
  accounts.save({ id: 'credit', name: '信用卡', type: 'credit', openingBalance: -500, includeInNetWorth: false })
  assert.equal(accounts.netWorth([]), 100000)
})

test('删除保护覆盖 accountId 与转账两端，且不修改关联流水', function () {
  reset()
  account('现金', 'cash', 100, true, 'cash')
  account('银行卡', 'bank', 200, true, 'bank')
  var txs = [
    { id: 'expense', type: 'expense', amount: 10, accountId: 'cash' },
    { id: 'move', type: 'transfer', amount: 20, fromAccountId: 'bank', toAccountId: 'cash' }
  ]
  disk.txs_v1 = clone(txs)
  assert.equal(accounts.relatedCount('cash', txs), 2)
  assert.equal(accounts.remove('cash', txs), false)
  assert.match(accounts.error(), /2 笔流水/)
  assert.ok(accounts.get('cash'))
  assert.deepEqual(disk.txs_v1, txs)

  assert.equal(accounts.remove('cash'), false)
  assert.match(accounts.error(), /2 笔流水/)
  disk.txs_v1 = []
  assert.equal(accounts.remove('cash'), true)
  assert.equal(accounts.get('cash'), null)
  assert.equal(accounts.list().length, 1)
})

test('导出可独立修改，导入完整往返且拒绝坏数据', function () {
  reset()
  var cash = account('现金', 'cash', 10.01, true, 'cash')
  var credit = account('信用卡', 'credit', -20.02, false, 'credit')
  var payload = accounts.exportData()
  assert.equal(payload.storageKey, 'accounts_v1')
  assert.equal(payload.version, 1)
  assert.deepEqual(payload.accounts, [cash, credit])
  var roundtrip = accounts.exportData()
  payload.accounts[0].name = '仅修改导出对象'
  assert.equal(accounts.get('cash').name, '现金')

  delete disk.accounts_v1
  assert.deepEqual(accounts.importData(roundtrip), [cash, credit])
  assert.throws(function () {
    accounts.importData({ version: 1, accounts: [cash, cash] })
  }, /重复 ID/)
  assert.throws(function () {
    accounts.importData({ version: 1, accounts: [Object.assign({}, cash, { type: 'other' })] })
  }, /格式不对/)
  assert.throws(function () { accounts.importData('{broken') }, /JSON/)
  assert.deepEqual(accounts.list(), [cash, credit])
  assert.deepEqual(accounts.importData(JSON.stringify({ version: 1, accounts: [] })), [])
})

test('空账户一键建立四个示例，重复调用不覆盖已有账户', function () {
  reset()
  var created = accounts.seedDefaults()
  assert.deepEqual(created.map(function (item) { return item.name }), ['现金', '微信', '支付宝', '银行卡'])
  assert.deepEqual(created.map(function (item) { return item.type }), ['cash', 'wallet', 'wallet', 'bank'])
  assert.ok(created.every(function (item) {
    return item.openingBalance === 0 && item.includeInNetWorth === true && item.createdAt > 0
  }))
  assert.equal(new Set(created.map(function (item) { return item.id })).size, 4)
  assert.deepEqual(accounts.seedDefaults(), created)
  var custom = account('自定义', 'cash', 5, true)
  assert.equal(accounts.list().length, 5)
  assert.ok(accounts.get(custom.id))
})

test('账户页支持空态示例、增删改、净资产、删除保护和深浅主题', function () {
  reset()
  var page = loadPage()
  page.onLoad()
  page.onShow()
  assert.equal(navTitles[0], '多账户与余额')
  assert.equal(page.data.dark, true)
  assert.equal(page.data.themeKey, 'ink')
  assert.equal(page.data.accountCount, 0)
  assert.equal(page.data.netWorthText, '¥0.00')

  page.seedExamples()
  assert.equal(page.data.accountCount, 4)
  assert.equal(page.data.includedCount, 4)
  assert.equal(page.data.error, '')

  page.openCreate()
  page.inputName({ detail: { value: '活期钱包' } })
  page.pickType({ currentTarget: { dataset: { type: 'wallet' } } })
  page.inputOpening({ detail: { value: '100.10' } })
  page.toggleInclude({ detail: { value: false } })
  page.saveForm()
  assert.equal(page.data.accountCount, 5)
  assert.equal(page.data.netWorthText, '¥0.00')
  assert.equal(page.data.accounts[4].balanceText, '¥100.10')
  assert.equal(page.data.formVisible, false)

  var id = page.data.accounts[4].id
  page.openEdit({ currentTarget: { dataset: { id: id } } })
  page.inputOpening({ detail: { value: '200.20' } })
  page.toggleInclude({ detail: { value: true } })
  page.saveForm()
  assert.equal(page.data.netWorthText, '¥200.20')
  assert.equal(accounts.get(id).createdAt, accounts.list()[4].createdAt)

  disk.txs_v1 = [{ id: 'expense', type: 'expense', amount: 1, accountId: id }]
  store.reload()
  page.refresh()
  assert.equal(page.data.accounts[4].balanceText, '¥199.20')
  assert.equal(page.data.netWorthText, '¥199.20')

  page.deleteAccount({ currentTarget: { dataset: { id: id } } })
  assert.match(last(modals).content, /1 笔流水/)
  assert.equal(typeof last(modals).success, 'undefined')
  assert.ok(accounts.get(id))
  assert.equal(disk.txs_v1.length, 1)

  var wechat = accounts.list().filter(function (item) { return item.name === '微信' })[0]
  page.deleteAccount({ currentTarget: { dataset: { id: wechat.id } } })
  assert.equal(last(modals).title, '删除账户？')
  last(modals).success({ confirm: true })
  assert.equal(accounts.get(wechat.id), null)
  assert.equal(page.data.accountCount, 4)

  systemDark = false
  themeListener({ theme: 'light' })
  assert.equal(page.data.dark, false)
  assert.equal(last(tabStyles).selectedColor, '#2f5d8a')
  page.onUnload()
  assert.equal(themeListener, null)
})

test('页面可录入信用卡负数期初余额并显示负净资产', function () {
  reset()
  var page = loadPage()
  page.onShow()
  page.openCreate()
  page.inputName({ detail: { value: '信用卡' } })
  page.pickType({ currentTarget: { dataset: { type: 'credit' } } })
  page.inputOpening({ detail: { value: '-300.25' } })
  page.saveForm()
  assert.equal(page.data.accountCount, 1)
  assert.equal(page.data.accounts[0].balanceText, '-¥300.25')
  assert.equal(page.data.accounts[0].negative, true)
  assert.equal(page.data.netWorthText, '-¥300.25')
  assert.equal(page.data.netWorthNegative, true)
})

test('页面在账户损坏和存储失败时保留输入并给出错误反馈', function () {
  reset()
  disk.accounts_v1 = { broken: true }
  var page = loadPage()
  page.onShow()
  assert.equal(page.data.accountCount, 0)
  assert.match(page.data.error, /格式损坏/)

  reset()
  page = loadPage()
  page.onShow()
  page.openCreate()
  page.inputName({ detail: { value: '保存失败账户' } })
  storageFailure = true
  page.saveForm()
  assert.equal(page.data.busy, false)
  assert.equal(page.data.formVisible, true)
  assert.equal(page.data.form.name, '保存失败账户')
  assert.match(page.data.formError, /保存失败/)
  assert.equal(accounts.list().length, 0)
})

test('外币余额使用原币分，净资产按账户汇率折算，历史快照不随汇率改写', function () {
  reset()
  var usd = accounts.save({ name: '美元账户', type: 'bank', openingBalance: 100, currency: 'USD', rateToCny: 7.2, includeInNetWorth: true })
  var eur = accounts.save({ name: '欧元账户', type: 'bank', openingBalance: 100, currency: 'EUR', rateToCny: 8, includeInNetWorth: true })
  var txs = [
    { id: 'usd-expense', type: 'expense', amount: 72, nativeAmount: 10, currency: 'USD', rateToCny: 7.2, accountId: usd.id },
    { id: 'legacy-expense', type: 'expense', amount: 7.2, accountId: usd.id },
    { id: 'cross', type: 'transfer', amount: 72, nativeAmount: 10, currency: 'USD', rateToCny: 7.2,
      toNativeAmount: 9, toCurrency: 'EUR', toRateToCny: 8, fromAccountId: usd.id, toAccountId: eur.id }
  ]
  var values = accounts.balances(txs)
  assert.equal(values[usd.id], 7900)
  assert.equal(values[eur.id], 10900)
  assert.equal(accounts.netWorth(txs), 144080)
  accounts.save({ id: usd.id, name: usd.name, type: usd.type, openingBalance: 100, currency: 'USD', rateToCny: 8, includeInNetWorth: true })
  assert.equal(accounts.balances(txs)[usd.id], 7910)
  assert.equal(accounts.netWorth(txs), 150480)
  assert.equal(txs[0].rateToCny, 7.2)
})

test('账户新增与修改外币币种、汇率自动记录，CNY 和重复保存不记录', function () {
  reset()
  var usd = accounts.save({ name: '美元', type: 'bank', openingBalance: 10, currency: 'USD', rateToCny: 7.2, includeInNetWorth: true })
  var first = exchangeRates.list(usd.id)[0]
  assert.equal(first.currency, 'USD')
  assert.equal(first.rate, 7.2)
  assert.equal(first.previousRate, null)

  accounts.save({ id: usd.id, name: '美元账户', type: 'bank', openingBalance: 10, currency: 'USD', rateToCny: 7.2, includeInNetWorth: true })
  assert.equal(exchangeRates.list(usd.id).length, 1)
  accounts.save({ id: usd.id, name: '美元账户', type: 'bank', openingBalance: 10, currency: 'USD', rateToCny: 8, includeInNetWorth: true })
  var rows = exchangeRates.list(usd.id)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].previousRate, 7.2)
  assert.equal(rows[0].rate, 8)

  accounts.save({ id: usd.id, name: '欧元账户', type: 'bank', openingBalance: 10, currency: 'EUR', rateToCny: 8, includeInNetWorth: true })
  rows = exchangeRates.list(usd.id)
  assert.equal(rows.length, 3)
  assert.equal(rows[0].currency, 'EUR')
  assert.equal(rows[0].rate, 8)
  accounts.save({ id: usd.id, name: '人民币账户', type: 'bank', openingBalance: 10, currency: 'CNY', rateToCny: 1, includeInNetWorth: true })
  assert.equal(exchangeRates.list(usd.id).length, 3)

  var cny = account('现金', 'cash', 1, true)
  assert.deepEqual(exchangeRates.list(cny.id), [])
})

test('汇率历史失败时回滚账户保存，删除失败保留账户和历史', function () {
  reset()
  var usd = accounts.save({ name: '美元', type: 'bank', openingBalance: 10, currency: 'USD', rateToCny: 7.2, includeInNetWorth: true })
  var beforeAccounts = clone(disk.accounts_v1)
  var beforeRates = clone(disk.exchange_rates_v1)
  failedKey = exchangeRates.KEY
  assert.equal(accounts.save({ id: usd.id, name: '美元', type: 'bank', openingBalance: 10, currency: 'USD', rateToCny: 8, includeInNetWorth: true }), null)
  assert.match(accounts.error(), /账户未保存/)
  assert.deepEqual(disk.accounts_v1, beforeAccounts)
  assert.deepEqual(disk.exchange_rates_v1, beforeRates)

  assert.equal(accounts.save({ name: '新增美元', type: 'bank', openingBalance: 1, currency: 'USD', rateToCny: 9, includeInNetWorth: true }), null)
  assert.deepEqual(disk.accounts_v1, beforeAccounts)
  assert.deepEqual(disk.exchange_rates_v1, beforeRates)
  assert.equal(accounts.remove(usd.id, []), false)
  assert.match(accounts.error(), /账户未删除/)
  assert.deepEqual(disk.accounts_v1, beforeAccounts)
  assert.deepEqual(disk.exchange_rates_v1, beforeRates)

  failedKey = ''
  assert.equal(accounts.remove(usd.id, []), true)
  assert.deepEqual(exchangeRates.list(usd.id), [])
})

test('删除账户时映射清理失败会同时恢复汇率历史', function () {
  reset()
  var usd = accounts.save({ name: '美元', type: 'bank', openingBalance: 10, currency: 'USD', rateToCny: 7.2, includeInNetWorth: true })
  disk.account_mappings_v1 = [{ id: 'r1', keyword: '美元', accountId: usd.id, enabled: true, createdAt: 1 }]
  var beforeAccounts = clone(disk.accounts_v1)
  var beforeRates = clone(disk.exchange_rates_v1)
  failedKey = 'account_mappings_v1'
  assert.equal(accounts.remove(usd.id, []), false)
  assert.match(accounts.error(), /账户及汇率历史已恢复/)
  assert.deepEqual(disk.accounts_v1, beforeAccounts)
  assert.deepEqual(disk.exchange_rates_v1, beforeRates)
  assert.equal(disk.account_mappings_v1.length, 1)
})

test('账户导入移除账户时清理汇率历史，清理失败回滚账户和历史', function () {
  reset()
  var usd = accounts.save({ name: '美元', type: 'bank', openingBalance: 10, currency: 'USD', rateToCny: 7.2, includeInNetWorth: true })
  var cash = account('现金', 'cash', 1, true)
  var payload = accounts.exportData()
  payload.accounts = payload.accounts.filter(function (item) { return item.id === cash.id })
  var beforeAccounts = clone(disk.accounts_v1)
  var beforeRates = clone(disk.exchange_rates_v1)
  failedKey = exchangeRates.KEY
  assert.throws(function () { accounts.importData(payload) }, /账户未导入/)
  assert.deepEqual(disk.accounts_v1, beforeAccounts)
  assert.deepEqual(disk.exchange_rates_v1, beforeRates)
  failedKey = ''
  accounts.importData(payload)
  assert.equal(accounts.get(usd.id), null)
  assert.deepEqual(exchangeRates.list(usd.id), [])
})

test('跨币种转账按目标原币入账，旧转账与不完整账户保持兼容', function () {
  reset()
  account('美元', 'bank', 10, true, 'usd')
  account('日元', 'wallet', 1000, true, 'jpy')
  var savedUsd = accounts.save({ id: 'usd', name: '美元', type: 'bank', openingBalance: 10, currency: 'USD', rateToCny: 7.2, includeInNetWorth: true })
  var savedJpy = accounts.save({ id: 'jpy', name: '日元', type: 'wallet', openingBalance: 1000, currency: 'JPY', rateToCny: 0.05, includeInNetWorth: true })
  var cross = { id: 'cross', type: 'transfer', amount: 3.6, nativeAmount: 0.5, currency: 'USD', rateToCny: 7.2,
    toNativeAmount: 72, toCurrency: 'JPY', toRateToCny: 0.05, fromAccountId: 'usd', toAccountId: 'jpy' }
  var values = accounts.balances([cross])
  assert.equal(values.usd, 950)
  assert.equal(values.jpy, 107200)
  assert.equal(accounts.netWorth([cross]), 12200)
  assert.ok(savedUsd && savedJpy)

  var legacy = [{ id: 'old', type: 'transfer', amount: 1, fromAccountId: 'usd', toAccountId: 'jpy' }]
  values = accounts.balances(legacy)
  assert.equal(values.usd, 986)
  assert.equal(values.jpy, 102000)
  assert.equal(accounts.netWorth(legacy), 12199)
})

test('账户页可设置币种和汇率，人民币固定且列表显示原币余额', function () {
  reset()
  var page = loadPage()
  page.onShow()
  page.openCreate()
  page.inputName({ detail: { value: '美元钱包' } })
  page.pickCurrency({ detail: { value: 1 } })
  page.inputRate({ detail: { value: '7.20' } })
  page.inputOpening({ detail: { value: '100.10' } })
  page.saveForm()
  var row = page.data.accounts[0]
  assert.equal(row.currency, 'USD')
  assert.equal(row.balanceText, '$100.10 USD')
  assert.match(row.rateText, /1 USD = 7.2 CNY/)
  assert.equal(row.rateHistory.length, 1)
  assert.equal(row.rateHistory[0].changeText, '首次 → 7.2')
  assert.match(row.rateHistory[0].timeText, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  assert.equal(page.data.netWorthText, '¥720.72')

  page.openEdit({ currentTarget: { dataset: { id: row.id } } })
  page.inputRate({ detail: { value: '8' } })
  page.saveForm()
  assert.equal(page.data.netWorthText, '¥800.80')
  assert.equal(page.data.accounts[0].rateHistory.length, 2)
  assert.equal(page.data.accounts[0].rateHistory[0].changeText, '7.2 → 8')
  page.openEdit({ currentTarget: { dataset: { id: row.id } } })
  page.pickCurrency({ detail: { value: 0 } })
  assert.equal(page.data.form.rateToCny, '1')
  page.inputRate({ detail: { value: '99' } })
  assert.equal(page.data.form.rateToCny, '99')
  page.saveForm()
  assert.equal(accounts.get(row.id).rateToCny, 1)
  assert.equal(page.data.accounts[0].balanceText, '¥100.10')
})

test('删除、导入和旧账户读取兼容币种字段', function () {
  reset()
  var old = { id: 'old', name: '旧现金', type: 'cash', openingBalance: 1.25, includeInNetWorth: true, createdAt: 1700000000000 }
  disk.accounts_v1 = [old]
  var normalized = accounts.list()[0]
  assert.equal(normalized.currency, 'CNY')
  assert.equal(normalized.rateToCny, 1)
  assert.equal(accounts.netWorth([]), 125)
  assert.deepEqual(accounts.importData({ version: 1, accounts: [old] })[0], normalized)
  assert.equal(accounts.remove('old', []), true)

  var foreign = accounts.save({ name: '港币', type: 'wallet', openingBalance: 10, currency: 'HKD', rateToCny: 0.92, includeInNetWorth: true })
  assert.deepEqual(accounts.importData(accounts.exportData()), [foreign])
  assert.throws(function () {
    accounts.importData({ version: 1, accounts: [Object.assign({}, foreign, { currency: 'XXX' })] })
  }, /币种不支持/)
  assert.throws(function () {
    accounts.importData({ version: 1, accounts: [Object.assign({}, foreign, { rateToCny: -1 })] })
  }, /汇率/)
})

test('页面模板包含完整账户操作，不依赖应用配置写入', function () {
  var wxml = fs.readFileSync(path.join(root, 'pages/accounts/accounts.wxml'), 'utf8')
  assert.ok(wxml.includes('一键建立现金 / 微信 / 支付宝 / 银行卡示例'))
  assert.ok(wxml.includes('bindtap="saveForm"') && wxml.includes('bindtap="deleteAccount"'))
  assert.ok(wxml.includes('汇率记录') && wxml.includes('item.changeText') && wxml.includes('item.timeText'))
  assert.ok(wxml.includes('仅审计展示，不改写流水快照'))
  var source = fs.readFileSync(path.join(root, 'pages/accounts/accounts.js'), 'utf8')
  assert.ok(!source.includes('app.json'))
})
