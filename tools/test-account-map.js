/* 支付方式自动映射账户：node tools/test-account-map.js */
var assert = require('node:assert/strict')
var fs = require('node:fs')
var path = require('node:path')
var test = require('node:test')

var root = path.resolve(__dirname, '..')
var disk = {}
var modals = []
var toasts = []
var storageFailure = false
var silentFailure = false

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

global.wx = {
  getStorageSync: function (key) { return key in disk ? clone(disk[key]) : '' },
  setStorageSync: function (key, value) {
    if (storageFailure) throw new Error('storage full')
    if (silentFailure && key === 'account_mappings_v1') return
    disk[key] = clone(value)
  },
  removeStorageSync: function (key) { delete disk[key] },
  getAppBaseInfo: function () { return { theme: 'light' } },
  getSystemInfoSync: function () { return { theme: 'light' } },
  onThemeChange: function () {},
  offThemeChange: function () {},
  setTabBarStyle: function () {},
  setTabBarItem: function () {},
  setNavigationBarTitle: function () {},
  showModal: function (options) { modals.push(options) },
  showToast: function (options) { toasts.push(options) }
}

var accountMap = require('../utils/account-map')
var accounts = require('../utils/accounts')
var store = require('../utils/store')

function reset() {
  disk = {}
  modals = []
  toasts = []
  storageFailure = false
  silentFailure = false
  store.reload()
}

function account(id, name) {
  return accounts.save({ id: id, name: name || id, type: 'wallet', openingBalance: 0, includeInNetWorth: true, createdAt: 1700000000000 })
}

function rule(keyword, accountId, enabled, id) {
  return accountMap.save({ id: id, keyword: keyword, accountId: accountId, enabled: enabled, createdAt: 1700000000000 })
}

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

function last(list) { return list[list.length - 1] }

test('关键词规范化与 account_mappings_v1 CRUD', function () {
  reset()
  assert.equal(accountMap.KEY, 'account_mappings_v1')
  assert.equal(accountMap.normalizeKeyword('  Wei   Xin\tPay '), 'weixinpay')
  account('wechat', '微信')
  var saved = rule('  Wei   XIN ', 'wechat')
  assert.ok(saved.id)
  assert.equal(saved.keyword, 'weixin')
  assert.equal(saved.enabled, true)
  assert.equal(saved.createdAt, 1700000000000)
  assert.deepEqual(disk.account_mappings_v1, [saved])
  assert.equal(accountMap.list().length, 1)
  assert.equal(accountMap.toggle(saved.id, false).enabled, false)
  assert.equal(accountMap.toggle(saved.id).enabled, true)
  assert.equal(accountMap.save({ id: saved.id, keyword: '微 信', accountId: 'wechat', enabled: true }).createdAt, saved.createdAt)
  assert.equal(accountMap.remove(saved.id), true)
  assert.deepEqual(accountMap.list(), [])
  assert.equal(accountMap.remove(saved.id), false)
  assert.equal(rule('', 'wechat'), null)
  assert.match(accountMap.error(), /关键词/)
  assert.equal(accountMap.save({ keyword: '微信', accountId: 'missing' }, [{ id: 'wechat', name: '微信' }]), null)
  assert.equal(accountMap.toggle('missing'), null)
})

test('最长匹配优先，停用与悬空账户规则不参与匹配', function () {
  reset()
  account('wechat', '微信')
  account('bank', '银行卡')
  rule('支付', 'bank')
  rule('微信支付', 'wechat')
  rule('微信支付', 'missing', true, 'dangling')
  rule('云闪付', 'bank', false)
  var result = accountMap.match('  微信 支付 ', [
    { id: 'wechat', name: '微信' }, { id: 'bank', name: '银行卡' }
  ])
  assert.equal(result.status, 'matched')
  assert.equal(result.accountId, 'wechat')
  assert.equal(result.keyword, '微信支付')
  assert.equal(result.ruleIds.indexOf('dangling'), -1)
  assert.equal(accountMap.match('云闪付', [{ id: 'bank', name: '银行卡' }]).status, 'unmatched')
  assert.equal(accountMap.match('现金', [{ id: 'bank', name: '银行卡' }]).status, 'unmatched')
})

test('多个不同账户同分视为模糊，同账户重复规则不模糊', function () {
  reset()
  var list = [{ id: 'a', name: '甲账户' }, { id: 'b', name: '乙账户' }]
  rule('支付', 'a', true, 'a1')
  rule('支付', 'b', true, 'b1')
  var ambiguous = accountMap.match('支付宝支付', list)
  assert.equal(ambiguous.status, 'ambiguous')
  assert.equal(ambiguous.matched, false)
  assert.equal(ambiguous.accountId, '')
  assert.deepEqual(ambiguous.candidates.map(function (item) { return item.accountId }), ['a', 'b'])
  rule('支付', 'a', true, 'a2')
  var same = accountMap.match('支付宝支付', [list[0]])
  assert.equal(same.status, 'matched')
  assert.equal(same.accountId, 'a')
  assert.deepEqual(same.ruleIds, ['a1', 'a2'])
})

test('assign 返回副本，模糊不赋值且已有 accountId 不覆盖', function () {
  reset()
  var list = [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }]
  rule('微信', 'a')
  rule('微信支付', 'a')
  rule('支付', 'b')
  var tx = { id: 't1', account: ' 微信 支付 ', amount: 12 }
  var copy = accountMap.assign(tx, list)
  assert.equal(copy.accountId, 'a')
  assert.equal(copy.account, tx.account)
  assert.equal(tx.accountId, undefined)
  assert.notEqual(copy, tx)
  var existing = { id: 't2', account: '微信', accountId: 'b' }
  assert.equal(accountMap.assign(existing, list).accountId, 'b')
  assert.equal(accountMap.assign({ id: 't3', account: '银联' }, list).accountId, undefined)
  assert.equal(accountMap.assign({ id: 't5', account: '支付宝' }, list).accountId, 'b')
  assert.equal(accountMap.assign({ id: 't6', account: '微信支付' }, list).accountId, 'a')
  rule('钱包', 'a')
  rule('钱包', 'b')
  assert.equal(accountMap.assign({ id: 't7', account: '电子钱包付款' }, list).accountId, undefined)
  assert.equal(accountMap.assign({ id: 't4', account: '微信', accountId: '  ' }, list).accountId, 'a')
  assert.equal(accountMap.assign(null, list), null)
})

test('导出独立副本，导入支持合并、替换和缺失账户停用计划', function () {
  reset()
  var list = [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }]
  var first = rule('微信', 'a', true, 'r1')
  var payload = accountMap.exportData()
  assert.equal(payload.storageKey, 'account_mappings_v1')
  assert.equal(payload.version, 1)
  payload.rules[0].keyword = 'changed'
  assert.equal(accountMap.list()[0].keyword, '微信')

  var incoming = {
    version: 1,
    rules: [
      { id: 'r1', keyword: '微 信', accountId: 'b', enabled: false, createdAt: 1700000000001 },
      { id: 'r2', keyword: '支付宝', accountId: 'missing', enabled: true, createdAt: 1700000000002 }
    ]
  }
  var plan = accountMap.planImport(incoming, { accounts: list })
  assert.equal(plan.ok, true)
  assert.equal(plan.added, 1)
  assert.equal(plan.updated, 1)
  assert.equal(plan.disabled, 1)
  assert.equal(plan.total, 2)
  assert.equal(plan.value[0].accountId, 'b')
  assert.equal(plan.value[1].enabled, false)
  assert.equal(accountMap.list()[0].accountId, 'a')
  assert.equal(plan.changes[0].key, 'account_mappings_v1')
  plan.changes.forEach(function (change) { disk[change.key] = clone(change.value) })
  assert.equal(accountMap.list()[0].accountId, 'b')

  var merged = accountMap.importData(JSON.stringify({ version: 1, rules: [first] }), { accounts: list })
  assert.equal(merged.length, 2)
  assert.equal(merged[0].accountId, 'a')
  assert.equal(merged[1].enabled, false)
  var replaced = accountMap.importData({ version: 1, rules: [first] }, { mode: 'replace', accounts: list })
  assert.deepEqual(replaced, [first])
  assert.throws(function () { accountMap.importData({ version: 2, rules: [] }) }, /版本/)
  assert.throws(function () { accountMap.importData({ version: 1, rules: [first, first] }) }, /重复 ID/)
  assert.throws(function () { accountMap.importData('{broken') }, /JSON/)
})

test('映射存储静默失败或损坏时不报成功，保留原规则', function () {
  reset()
  account('a', '甲')
  var saved = rule('微信', 'a')
  silentFailure = true
  assert.equal(accountMap.toggle(saved.id, false), null)
  assert.match(accountMap.error(), /保存失败/)
  assert.equal(accountMap.list()[0].enabled, true)
  silentFailure = false
  disk.account_mappings_v1 = { broken: true }
  assert.throws(function () { accountMap.list() }, /数组/)
  assert.equal(rule('支付宝', 'a'), null)
})

test('删除账户清理映射；清理失败恢复账户并阻止删除', function () {
  reset()
  account('a', '甲')
  account('b', '乙')
  rule('微信', 'a', true, 'ra')
  rule('支付宝', 'b', true, 'rb')
  silentFailure = true
  assert.equal(accounts.remove('a', []), false)
  assert.match(accounts.error(), /账户未删除/)
  assert.ok(accounts.get('a'))
  assert.equal(accountMap.list().length, 2)
  silentFailure = false
  assert.equal(accounts.remove('a', []), true)
  assert.equal(accounts.get('a'), null)
  assert.deepEqual(accountMap.list().map(function (item) { return item.id }), ['rb'])
})

test('账户导入移除账户时清理映射，清理失败回滚账户', function () {
  reset()
  account('a', '甲')
  account('b', '乙')
  rule('微信', 'a', true, 'ra')
  rule('支付宝', 'b', true, 'rb')
  var payload = accounts.exportData()
  payload.accounts = payload.accounts.filter(function (item) { return item.id === 'b' })
  silentFailure = true
  assert.throws(function () { accounts.importData(payload) }, /账户未导入|映射/)
  assert.ok(accounts.get('a'))
  assert.equal(accountMap.list().length, 2)
  silentFailure = false
  accounts.importData(payload)
  assert.equal(accounts.get('a'), null)
  assert.deepEqual(accountMap.list().map(function (item) { return item.id }), ['rb'])
})

test('账户页显示影响笔数、预览并可新增启停删除规则', function () {
  reset()
  account('wechat', '微信')
  account('bank', '银行卡')
  rule('微信', 'wechat')
  rule('微信支付', 'wechat', false)
  disk.txs_v1 = [
    { id: 't1', type: 'expense', amount: 1, time: 1700000000000, day: '2023-11-14', account: '微信' },
    { id: 't2', type: 'expense', amount: 2, time: 1700000000000, day: '2023-11-14', account: '微信', accountId: 'bank' },
    { id: 't3', type: 'expense', amount: 3, time: 1700000000000, day: '2023-11-14', account: '微信支付' }
  ]
  store.reload()
  var page = loadPage()
  page.onShow()
  assert.equal(page.data.mappingAutoCount, 2, JSON.stringify({ error: page.data.mappingError, rules: page.data.mappingRules, accounts: page.data.accounts }))
  assert.equal(page.data.mappingRules[0].assignCount, 2)
  assert.equal(page.data.mappingRules[1].impactText, '已停用')
  page.inputMappingPreview({ detail: { value: '微信支付' } })
  assert.match(page.data.mappingPreviewResult, /wechat|微信/)

  page.inputMappingKeyword({ detail: { value: ' 云 闪付 ' } })
  page.pickMappingAccount({ currentTarget: { dataset: {} }, detail: { value: 1 } })
  page.saveMappingRule()
  assert.equal(page.data.mappingRules.length, 3)
  assert.equal(page.data.mappingRules[2].keyword, '云闪付')
  assert.equal(page.data.mappingRules[2].accountId, 'bank')
  var id = page.data.mappingRules[2].id
  page.toggleMappingRule({ currentTarget: { dataset: { id: id } }, detail: { value: false } })
  assert.equal(accountMap.list().filter(function (item) { return item.id === id })[0].enabled, false)
  page.deleteMappingRule({ currentTarget: { dataset: { id: id } } })
  assert.equal(last(modals).title, '删除映射规则？')
  last(modals).success({ confirm: true })
  assert.equal(accountMap.list().length, 2)
  assert.equal(page.data.mappingKeyword, '')
})

test('批量应用只改未指定流水，模糊规则逐笔确认且可跳过', function () {
  reset()
  account('wechat', '微信')
  account('bank', '银行卡')
  account('alipay', '支付宝')
  rule('微信', 'wechat')
  rule('支付', 'bank')
  rule('支付', 'alipay')
  disk.txs_v1 = [
    { id: 'auto', type: 'expense', amount: 1, time: 1700000000000, day: '2023-11-14', account: '微信' },
    { id: 'existing', type: 'expense', amount: 2, time: 1700000000000, day: '2023-11-14', account: '微信', accountId: 'bank' },
    { id: 'fuzzy1', type: 'expense', amount: 3, time: 1700000000000, day: '2023-11-14', account: '支付宝支付' },
    { id: 'fuzzy2', type: 'expense', amount: 4, time: 1700000000000, day: '2023-11-14', account: '支付' },
    { id: 'none', type: 'expense', amount: 5, time: 1700000000000, day: '2023-11-14', account: '现金' }
  ]
  store.reload()
  var page = loadPage()
  page.onShow()
  assert.equal(page.data.mappingAutoCount, 1, JSON.stringify({ error: page.data.mappingError, rules: page.data.mappingRules, accounts: page.data.accounts }))
  assert.equal(page.data.mappingAmbiguousCount, 2)
  page.applyMappings()
  assert.match(last(modals).content, /自动关联 1 笔/)
  last(modals).success({ confirm: true })
  assert.equal(store.all().filter(function (tx) { return tx.id === 'auto' })[0].accountId, 'wechat')
  assert.equal(store.all().filter(function (tx) { return tx.id === 'existing' })[0].accountId, 'bank')
  assert.equal(store.all().filter(function (tx) { return tx.id === 'fuzzy1' })[0].accountId, undefined)
  assert.match(page.data.mappingConfirmed.txText, /fuzzy1|支付宝支付/)
  assert.equal(page.data.mappingConfirmed.candidates.length, 2)
  page.confirmMappedAccount({ currentTarget: { dataset: { accountId: 'alipay' } } })
  assert.equal(store.all().filter(function (tx) { return tx.id === 'fuzzy1' })[0].accountId, 'alipay')
  assert.match(page.data.mappingConfirmed.txText, /fuzzy2|支付/)
  page.skipMappedTx()
  assert.equal(page.data.mappingApplyBusy, false)
  assert.equal(page.data.mappingConfirmed, null)
  assert.equal(store.all().filter(function (tx) { return tx.id === 'fuzzy2' })[0].accountId, undefined)
  assert.equal(last(modals).title, '关联完成')
  assert.match(last(modals).content, /已关联 2 笔，跳过 1 笔，失败 0 笔/)
  assert.equal(last(toasts).icon, 'success')
})

test('批量应用写入失败不报成功，自动关联整批回滚', function () {
  reset()
  account('wechat', '微信')
  rule('微信', 'wechat')
  disk.txs_v1 = [
    { id: 'failed', type: 'expense', amount: 1, time: 1700000000000, day: '2023-11-14', account: '微信' },
    { id: 'ok', type: 'expense', amount: 2, time: 1700000000000, day: '2023-11-14', account: '微信' }
  ]
  store.reload()
  var page = loadPage()
  page.onShow()
  storageFailure = true
  page.applyMappings()
  last(modals).success({ confirm: true })
  storageFailure = false
  assert.equal(store.all().filter(function (tx) { return tx.id === 'failed' })[0].accountId, undefined)
  assert.equal(store.all().filter(function (tx) { return tx.id === 'ok' })[0].accountId, undefined)
  assert.equal(last(modals).title, '关联未全部完成')
  assert.match(last(modals).content, /已关联 0 笔.*失败 2 笔/)
  assert.equal(toasts.some(function (item) { return item.icon === 'success' }), false)
})

test('新增与批量导入自动映射支付方式，但不覆盖已有账户', function () {
  reset()
  account('wechat', '微信')
  rule('微信', 'wechat')
  var one = { id: 'm-one', type: 'expense', amount: 1, time: 1700000000000, day: '2023-11-14', account: '微信付款' }
  assert.equal(store.addOne(one).saved, true)
  assert.equal(store.all().find(function (tx) { return tx.id === 'm-one' }).accountId, 'wechat')
  var many = [
    { id: 'm-auto', type: 'expense', amount: 2, time: 1700000000000, day: '2023-11-14', account: '微信' },
    { id: 'm-existing', type: 'expense', amount: 3, time: 1700000000000, day: '2023-11-14', account: '微信', accountId: 'other' }
  ]
  assert.equal(store.addMany(many).saved, true)
  assert.equal(store.all().find(function (tx) { return tx.id === 'm-auto' }).accountId, 'wechat')
  assert.equal(store.all().find(function (tx) { return tx.id === 'm-existing' }).accountId, 'other')
})

test('映射页面模板包含管理、预览、批量应用和逐笔确认控件', function () {
  var wxml = fs.readFileSync(path.join(root, 'pages/accounts/accounts.wxml'), 'utf8')
  ;['saveMappingRule', 'toggleMappingRule', 'deleteMappingRule', 'inputMappingPreview', 'applyMappings', 'confirmMappedAccount', 'skipMappedTx'].forEach(function (name) {
    assert.ok(wxml.includes('bindtap="' + name + '"') || wxml.includes('bindinput="' + name + '"') || wxml.includes('bindchange="' + name + '"'), name)
  })
  assert.ok(wxml.includes('应用到未指定流水'))
  assert.ok(wxml.includes('{{item.impactText}}'))
  var source = fs.readFileSync(path.join(root, 'pages/accounts/accounts.js'), 'utf8')
  assert.ok(source.includes("'将关联 ' + assignCount + ' 笔'"))
})
