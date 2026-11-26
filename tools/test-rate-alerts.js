/* 汇率提醒核心与页面契约测试：node --test tools/test-rate-alerts.js */
var assert = require('node:assert/strict')
var fs = require('node:fs')
var path = require('node:path')
var root = path.resolve(__dirname, '..')
var storage = {}
var passed = 0
var failed = 0
var writes = 0
var failedKey = ''
var calls
var pageDefinition
var dark = false
var watcher = null

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function reset() {
  Object.keys(storage).forEach(function (key) { delete storage[key] })
  writes = 0
  failedKey = ''
  calls = { toasts: [], modals: [], backs: [], tabs: [], title: '' }
  dark = false
  watcher = null
}

function seedAccount(id, code, rate) {
  storage.accounts_v1 = storage.accounts_v1 || []
  var account = {
    id: id || 'usd-1', name: '美元账户', type: 'bank', openingBalance: 0,
    currency: code || 'USD', rateToCny: rate || 7.2, includeInNetWorth: true, createdAt: 1
  }
  storage.accounts_v1.push(account)
  return account
}

function config(targetRate, direction, enabled) {
  return {
    targetRate: targetRate === undefined ? 7.2 : targetRate,
    direction: direction || 'above',
    enabled: enabled === undefined ? true : enabled
  }
}

global.wx = {
  getStorageSync: function (key) { return key in storage ? clone(storage[key]) : '' },
  setStorageSync: function (key, value) {
    if (key === failedKey) throw new Error('storage full')
    writes++
    storage[key] = clone(value)
  },
  removeStorageSync: function (key) { delete storage[key] },
  getAppBaseInfo: function () { return { theme: dark ? 'dark' : 'light' } },
  onThemeChange: function (fn) { watcher = fn },
  offThemeChange: function (fn) { if (watcher === fn) watcher = null },
  setNavigationBarTitle: function (options) { calls.title = options.title },
  setTabBarStyle: function () {},
  setTabBarItem: function () {},
  showToast: function (options) { calls.toasts.push(options.title) },
  showModal: function (options) { calls.modals.push(options) },
  navigateBack: function (options) { calls.backs.push(options); if (options.fail) options.fail() },
  switchTab: function (options) { calls.tabs.push(options.url) }
}

var alerts = require('../utils/rate-alerts')
var pageFile = path.join(root, 'pages/rate-alerts/rate-alerts.js')

function loadPage() {
  global.Page = function (definition) { pageDefinition = definition }
  delete require.cache[require.resolve(pageFile)]
  require(pageFile)
  var page = Object.assign({}, pageDefinition, { data: clone(pageDefinition.data) })
  page.setData = function (patch, callback) {
    Object.assign(this.data, patch)
    if (callback) callback()
  }
  return page
}

function save(target, direction, enabled, account) {
  account = account || { id: 'usd-1', currency: 'USD', rateToCny: 7.2 }
  return alerts.save(account.id, account, config(target, direction, enabled))
}

function evaluate(rate, previous, account) {
  account = account || { id: 'usd-1', currency: 'USD', rateToCny: rate }
  return alerts.evaluate(account, previous)
}

function test(name, run) {
  reset()
  try {
    run()
    passed++
    console.log('PASS ' + name)
  } catch (err) {
    failed++
    console.error('FAIL ' + name + '\n' + err.stack)
  }
}

test('存储键、按账户保存与返回副本契约完整', function () {
  assert.equal(alerts.KEY, 'rate_alerts_v1')
  assert.equal(alerts.STORAGE_KEY, alerts.KEY)
  var saved = save('7.20')
  assert.deepEqual(saved, {
    accountId: 'usd-1', currency: 'USD', targetRate: 7.2, direction: 'above',
    enabled: true, pending: false, lastTriggeredAt: null, triggerCount: 0,
    updatedAt: saved.updatedAt
  })
  assert.ok(Number.isInteger(saved.updatedAt) && saved.updatedAt > 0)
  assert.deepEqual(Object.keys(storage[alerts.KEY]), ['usd-1'])
  var copy = alerts.get('usd-1')
  copy.targetRate = 999
  assert.equal(alerts.get('usd-1').targetRate, 7.2)
  var exported = alerts.exportData()
  exported.rateAlerts['usd-1'].targetRate = 888
  assert.equal(alerts.get('usd-1').targetRate, 7.2)
})

test('上涨穿越包含达到目标，未穿越与从目标上方继续上涨不触发', function () {
  save(7.2)
  assert.equal(evaluate(7.1, 7.0).pending, false)
  assert.equal(evaluate(7.2, 7.1).pending, true)
  assert.equal(evaluate(7.4, 7.3).pending, true, '确认前保持待提醒')
  alerts.ack('usd-1')
  assert.equal(evaluate(7.0, 7.3).pending, false)
  assert.equal(evaluate(7.3, 7.2).pending, false)
  assert.equal(evaluate(7.4, 7.3).pending, false)
})

test('下跌穿越包含达到目标，未穿越与从目标下方继续下跌不触发', function () {
  save(7.2, 'below')
  assert.equal(evaluate(7.3, 7.4).pending, false)
  var hit = evaluate(7.2, 7.3)
  assert.equal(hit.pending, true)
  assert.equal(hit.direction, 'below')
  assert.equal(hit.triggerCount, 1)
  assert.ok(hit.lastTriggeredAt > 0)
  assert.deepEqual(alerts.listPending().map(function (item) { return item.accountId }), ['usd-1'])
})

test('同一方向重复评估不触发，ack 后重新跨越才再次触发', function () {
  save(7.2)
  var first = evaluate(7.3, 7.1)
  var repeat = evaluate(7.4, 7.3)
  assert.equal(repeat.pending, true)
  assert.equal(repeat.triggerCount, 1)
  assert.equal(repeat.lastTriggeredAt, first.lastTriggeredAt)
  assert.equal(alerts.ack('usd-1'), true)
  assert.equal(alerts.ack('usd-1'), false)
  assert.equal(alerts.get('usd-1').pending, false)
  assert.equal(evaluate(7.4, 7.3).pending, false)
  assert.equal(evaluate(7.1, 7.4).pending, false)
  var second = evaluate(7.2, 7.1)
  assert.equal(second.pending, true)
  assert.equal(second.triggerCount, 2)
  assert.ok(second.lastTriggeredAt >= first.lastTriggeredAt)
})

test('关闭清除待提醒且暂停评估，重新开启仍需新的跨越', function () {
  save(7.2)
  evaluate(7.3, 7.1)
  var closed = save(undefined, undefined, false)
  assert.equal(closed.enabled, false)
  assert.equal(closed.pending, false)
  assert.equal(closed.triggerCount, 1)
  assert.deepEqual(alerts.listPending(), [])
  assert.equal(evaluate(7.1, 6.9).pending, false)
  var opened = save(undefined, undefined, true)
  assert.equal(opened.pending, false)
  assert.equal(opened.triggerCount, 1)
  assert.equal(evaluate(7.3, 7.1).pending, true)
  assert.equal(alerts.get('usd-1').triggerCount, 2)
})

test('无配置、汇率未变和账户币种变化均不会误触发', function () {
  assert.equal(evaluate(7.3, 7.1), null)
  assert.equal(alerts.error(), '')
  save(7.2)
  var before = alerts.get('usd-1')
  assert.deepEqual(evaluate(7.2, 7.2), before)
  assert.equal(alerts.get('usd-1').triggerCount, 0)
  var eur = { id: 'usd-1', currency: 'EUR', rateToCny: 8 }
  assert.equal(alerts.evaluate(eur, 7.9), null)
  var switched = alerts.save('usd-1', eur, { targetRate: 8, direction: 'below' })
  assert.equal(switched.currency, 'EUR')
  assert.equal(switched.pending, false)
  assert.equal(switched.triggerCount, 0)
})

test('拒绝非法目标汇率、账户汇率、方向、开关和账户标识', function () {
  ;[0, -1, '', 'abc', '1e3', Infinity, true, {}, []].forEach(function (value) {
    assert.equal(save(value), null)
    assert.match(alerts.error(), /目标汇率/)
  })
  assert.equal(alerts.save('', { id: '', currency: 'USD', rateToCny: 7 }, config()), null)
  assert.equal(alerts.save('usd-1', { id: 'other', currency: 'USD', rateToCny: 7 }, config()), null)
  assert.equal(alerts.save('usd-1', { id: 'usd-1', currency: 'XXX', rateToCny: 7 }, config()), null)
  assert.equal(alerts.save('usd-1', { id: 'usd-1', currency: 'USD', rateToCny: 0 }, config()), null)
  assert.equal(alerts.save('usd-1', { id: 'usd-1', currency: 'USD', rateToCny: 7 }, config(7, 'sideways')), null)
  assert.equal(alerts.save('usd-1', { id: 'usd-1', currency: 'USD', rateToCny: 7 }, config(7, 'above', 'yes')), null)
  save(7.2)
  var before = JSON.stringify(storage)
  assert.equal(evaluate(7.3, 0), null)
  assert.match(alerts.error(), /汇率必须/)
  assert.equal(alerts.evaluate({ id: 'usd-1', currency: 'USD', rateToCny: -1 }, 7), null)
  assert.equal(JSON.stringify(storage), before)
})

test('CNY 保存和评估均明确拒绝，不生成配置', function () {
  var cny = { id: 'cny-1', currency: 'CNY', rateToCny: 1 }
  assert.equal(alerts.save('cny-1', cny, config()), null)
  assert.match(alerts.error(), /CNY 不支持/)
  assert.equal(alerts.evaluate(cny, 1), null)
  assert.match(alerts.error(), /CNY 不支持/)
  assert.deepEqual(storage, {})
})

test('写入失败自动回滚，删除账户配置不影响其他账户', function () {
  save(7.2)
  alerts.save('eur-1', { id: 'eur-1', currency: 'EUR', rateToCny: 8 }, config(8))
  var before = JSON.stringify(storage)
  failedKey = alerts.KEY
  assert.equal(evaluate(7.3, 7.1), null)
  assert.match(alerts.error(), /撤销|回滚/)
  assert.equal(JSON.stringify(storage), before)
  assert.equal(alerts.ack('usd-1'), false)
  failedKey = ''
  assert.equal(alerts.remove('usd-1'), true)
  assert.equal(alerts.get('usd-1'), null)
  assert.ok(alerts.get('eur-1'))
  assert.equal(alerts.remove('usd-1'), false)
})

test('导出和 planImport 为纯计划，支持合并、替换与无变化导入', function () {
  save(7.2)
  save(8, 'below', true, { id: 'eur-1', currency: 'EUR', rateToCny: 8.1 })
  var exported = alerts.exportData()
  assert.equal(exported.kind, 'rate_alerts')
  assert.equal(exported.version, 1)
  assert.equal(exported.storageKey, 'rate_alerts_v1')
  var before = JSON.stringify(storage)
  var beforeWrites = writes
  var samePlan = alerts.planImport(JSON.stringify(exported))
  assert.equal(samePlan.ok, true)
  assert.equal(samePlan.unchanged, 2)
  assert.deepEqual(samePlan.changes, [])
  assert.equal(JSON.stringify(storage), before)
  assert.equal(writes, beforeWrites)

  var incoming = exported.rateAlerts
  incoming['usd-1'].targetRate = 7.5
  incoming['jpy-1'] = {
    accountId: 'jpy-1', currency: 'JPY', targetRate: 0.05, direction: 'above', enabled: true,
    pending: false, lastTriggeredAt: null, triggerCount: 0, updatedAt: 2
  }
  var plan = alerts.planImport({ version: 1, rateAlerts: incoming })
  assert.equal(plan.added, 1)
  assert.equal(plan.updated, 1)
  assert.equal(plan.unchanged, 1)
  assert.equal(plan.total, 3)
  assert.deepEqual(plan.changes, [{ key: alerts.KEY, value: plan.value }])
  assert.equal(JSON.stringify(storage), before)
  assert.equal(writes, beforeWrites)

  var replace = alerts.planImport({ 'jpy-1': incoming['jpy-1'] }, { mode: 'replace' })
  assert.equal(replace.total, 1)
  assert.throws(function () { alerts.planImport({ version: 2, rateAlerts: {} }) }, /版本/)
  assert.throws(function () { alerts.planImport([]) }, /格式/)
})

test('planImport 校验账户列表并清理孤儿及币种过期配置', function () {
  save(7.2)
  alerts.save('eur-1', { id: 'eur-1', currency: 'EUR', rateToCny: 8 }, config(8))
  alerts.save('orphan', { id: 'orphan', currency: 'JPY', rateToCny: 0.05 }, config(0.05))
  var exported = alerts.exportData()
  var before = JSON.stringify(storage)
  var plan = alerts.planImport(exported, {
    accounts: [{ id: 'usd-1', currency: 'USD' }, { id: 'eur-1', currency: 'USD' }]
  })
  assert.equal(plan.removed, 2)
  assert.equal(plan.skipped, 2)
  assert.deepEqual(Object.keys(plan.value), ['usd-1'])
  assert.equal(JSON.stringify(storage), before)
  assert.throws(function () { alerts.planImport(exported, { accounts: {} }) }, /账户列表/)
  assert.throws(function () { alerts.planImport(exported, { accounts: [{}] }) }, /账户 ID/)
  assert.throws(function () { alerts.planImport(exported, { accounts: [{ id: 'usd-1', currency: 'XXX' }] }) }, /币种/)
})

test('导入拒绝 CNY、非法汇率、坏布尔值、坏次数和孤儿账户字段', function () {
  var base = {
    accountId: 'usd-1', currency: 'USD', targetRate: 7.2, direction: 'above', enabled: true,
    pending: false, lastTriggeredAt: null, triggerCount: 0, updatedAt: 1
  }
  var variants = [
    Object.assign({}, base, { currency: 'CNY', targetRate: 1 }),
    Object.assign({}, base, { targetRate: 0 }),
    Object.assign({}, base, { enabled: 1 }),
    Object.assign({}, base, { triggerCount: -1 }),
    Object.assign({}, base, { pending: true }),
    Object.assign({}, base, { accountId: 'other' })
  ]
  variants.forEach(function (item) {
    assert.throws(function () { alerts.planImport({ 'usd-1': item }) })
  })
  assert.deepEqual(storage, {})
})

test('页面按 accountId 路由展示账户汇率、规则、开关和状态', function () {
  seedAccount()
  var page = loadPage()
  page.onLoad({ accountId: 'usd-1' })
  page.onShow()
  assert.equal(calls.title, '汇率变更提醒')
  assert.equal(page.data.accountId, 'usd-1')
  assert.equal(page.data.accountName, '美元账户')
  assert.equal(page.data.currency, 'USD')
  assert.equal(page.data.currentRate, 7.2)
  assert.equal(page.data.currentRateText, '7.2')
  assert.equal(page.data.supported, true)
  assert.equal(page.data.enabled, false)
  assert.equal(page.data.statusText, '未设置提醒')
  page.inputTarget({ detail: { value: '7.50' } })
  page.selectDirection({ currentTarget: { dataset: { direction: 'below' } } })
  page.saveSettings()
  assert.equal(alerts.get('usd-1').targetRate, 7.5)
  assert.equal(alerts.get('usd-1').direction, 'below')
  assert.equal(alerts.get('usd-1').enabled, false)
  page.toggleEnabled({ detail: { value: true } })
  assert.equal(page.data.enabled, true)
  assert.equal(page.data.statusText, '监控中')
})

test('页面立即测试只显示应用内弹窗，不伪造触发或写入', function () {
  seedAccount()
  save(7.2)
  var page = loadPage()
  page.onLoad({ accountId: 'usd-1' })
  page.onShow()
  var before = JSON.stringify(storage)
  var beforeWrites = writes
  page.testAlert()
  assert.equal(calls.modals.length, 1)
  assert.match(calls.modals[0].title, /应用内提醒测试/)
  assert.match(calls.modals[0].content, /上涨到 7.2 CNY/)
  assert.match(calls.modals[0].content, /不会改变提醒状态/)
  assert.equal(JSON.stringify(storage), before)
  assert.equal(writes, beforeWrites)
  page.inputTarget({ detail: { value: '0' } })
  page.testAlert()
  assert.equal(calls.modals.length, 1)
  assert.match(page.data.error, /大于 0/)
})

test('页面展示待提醒并可确认，关闭后清除待提醒', function () {
  seedAccount()
  save(7.2)
  evaluate(7.3, 7.1)
  var page = loadPage()
  page.onLoad({ accountId: 'usd-1' })
  page.onShow()
  assert.equal(page.data.pending, true)
  assert.equal(page.data.statusClass, 'pending')
  assert.equal(page.data.triggerCount, 1)
  assert.notEqual(page.data.lastTriggeredText, '--')
  page.acknowledge()
  assert.equal(page.data.pending, false)
  assert.equal(page.data.statusText, '监控中')
  evaluate(7.4, 7.1)
  page.refresh()
  assert.equal(page.data.pending, true)
  page.toggleEnabled({ detail: { value: false } })
  assert.equal(page.data.enabled, false)
  assert.equal(page.data.pending, false)
  assert.deepEqual(alerts.listPending(), [])
})

test('CNY 账户不进入提醒选择，缺失账户 ID 时自动选择外币账户', function () {
  seedAccount('cny-1', 'CNY', 1)
  var page = loadPage()
  page.onLoad({ accountId: 'cny-1' })
  page.onShow()
  assert.equal(page.data.supported, false)
  assert.deepEqual(page.data.accountOptions, [])
  assert.match(page.data.error, /暂无外币账户/)
  storage.accounts_v1 = []
  seedAccount('usd-1', 'USD', 7.2)
  var missing = loadPage()
  missing.onLoad({})
  missing.onShow()
  assert.equal(missing.data.accountId, 'usd-1')
  assert.equal(missing.data.accountOptions.length, 1)
  assert.equal(missing.data.error, '')
})

test('页面深色监听、返回和模板处理器、路由契约完整', function () {
  seedAccount()
  var page = loadPage()
  page.onLoad({ accountId: 'usd-1' })
  page.onShow()
  assert.equal(typeof watcher, 'function')
  dark = true
  watcher({ theme: 'dark' })
  assert.equal(page.data.dark, true)
  page.goBack()
  assert.equal(calls.tabs[0], '/pages/home/home')
  page.onUnload()
  assert.equal(watcher, null)

  var wxml = fs.readFileSync(path.join(root, 'pages/rate-alerts/rate-alerts.wxml'), 'utf8')
  var wxss = fs.readFileSync(path.join(root, 'pages/rate-alerts/rate-alerts.wxss'), 'utf8')
  var app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))
  assert.ok(app.pages.includes('pages/rate-alerts/rate-alerts'))
  assert.ok(wxml.includes('bindinput="inputTarget"') && wxml.includes('bindchange="toggleEnabled"'))
  assert.ok(wxml.includes('上涨到提醒') && wxml.includes('下跌到提醒') && wxml.includes('立即测试'))
  assert.ok(wxml.includes('仅应用内提醒') && wxml.includes('不后台推送'))
  assert.ok(wxml.includes('待提醒') && wxml.includes('bindtap="acknowledge"'))
  assert.ok(wxml.includes('theme-{{themeKey}}') && wxml.includes("{{dark ? 'dark' : ''}}"))
  var handlers = Array.from(wxml.matchAll(/bind(?:tap|input|change)="([^"]+)"/g), function (match) { return match[1] })
  handlers.forEach(function (name) { assert.equal(typeof page[name], 'function', '缺少页面处理器 ' + name) })
  assert.ok(wxss.includes('env(safe-area-inset-top)') && wxss.includes('env(safe-area-inset-bottom)'))
  assert.ok(wxss.includes('.rate-page.dark') && wxss.includes('.rate-direction.selected'))
})

console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项')
if (failed) process.exitCode = 1
