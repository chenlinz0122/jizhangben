// node tools/test-health.js
var assert = require('assert')
var path = require('path')
var health = require('../utils/health')

var pass = 0
var fails = []
function test(name, fn) {
  try { fn(); pass++; console.log('PASS ' + name) } catch (err) {
    fails.push(name)
    console.error('FAIL ' + name + '\n' + err.stack)
  }
}

var NOW = new Date(2026, 10, 24, 12, 0, 0).getTime()
function tx(id, day, amount, extra) {
  var time = new Date(day + 'T12:00:00').getTime()
  var row = {
    id: id, day: day, ym: day.slice(0, 7), time: time,
    type: 'expense', amount: amount, category: '餐饮', merchant: '测试商户'
  }
  Object.keys(extra || {}).forEach(function (key) { row[key] = extra[key] })
  return row
}
function issuesOf(scan, type) {
  return scan.issues.filter(function (entry) { return entry.type === type })
}
function peer(id, owner, book, extra) {
  return tx(id, '2026-11-20', 25, Object.assign({
    byMe: false, by: '成员', ownerKey: owner, shareBook: book
  }, extra || {}))
}

test('duplicates keep every record and use stable keys independent of input order', function () {
  var a = tx('a', '2026-11-20', 25, { ownerKey: 'A', shareBook: 'B', source: 'bill' })
  var b = tx('b', '2026-11-20', 25, { ownerKey: 'A', shareBook: 'B', source: 'shot', category: '购物' })
  var c = tx('c', '2026-11-20', 25, { ownerKey: 'A', shareBook: 'B', source: 'manual', note: '第三笔也保留' })
  var first = health.scan([a, b, c], NOW)
  var second = health.scan([c, b, a], NOW)
  var dup = issuesOf(first, 'duplicate')
  assert.strictEqual(dup.length, 1)
  assert.deepStrictEqual(dup[0].txIds, ['a', 'b', 'c'])
  assert.deepStrictEqual(dup[0].records, [a, b, c])
  assert.strictEqual(dup[0].key, issuesOf(second, 'duplicate')[0].key)
  assert.deepStrictEqual(first.issues.map(function (x) { return x.key }), second.issues.map(function (x) { return x.key }))
  assert.strictEqual(health.summarize(first).affectedTxCount, 3)
})

test('duplicate identity includes owner, book, day, amount, merchant and type', function () {
  var rows = [
    peer('a1', 'A', 'one'), peer('a2', 'A', 'one'),
    peer('b1', 'B', 'one'), peer('book2', 'A', 'two'),
    tx('mine', '2026-11-20', 25),
    peer('day', 'C', 'one', { day: '2026-11-21', ym: '2026-11' }),
    peer('amount', 'D', 'one', { amount: 26 }),
    peer('merchant', 'E', 'one', { merchant: '另一商户' }),
    peer('type', 'F', 'one', { type: 'income', category: '工资' })
  ]
  rows[5].time = new Date('2026-11-21T12:00:00').getTime()
  var dup = issuesOf(health.scan(rows, NOW), 'duplicate')
  assert.strictEqual(dup.length, 1)
  assert.deepStrictEqual(dup[0].txIds, ['a1', 'a2'])
})

test('legacy member rows without owner identity never merge with each other or self', function () {
  var rows = [
    peer('legacy-a', '', 'one'), peer('legacy-b', '', 'one'),
    tx('mine', '2026-11-20', 25)
  ]
  assert.strictEqual(issuesOf(health.scan(rows, NOW), 'duplicate').length, 0)
})

test('future dates compare against local today and do not flag today', function () {
  var scan = health.scan([
    tx('today', '2026-11-24', 10),
    tx('tomorrow', '2026-11-25', 10),
    tx('old', '2026-11-23', 10)
  ], '2026-11-24T12:00:00')
  var future = issuesOf(scan, 'future')
  assert.strictEqual(future.length, 1)
  assert.deepStrictEqual(future[0].txIds, ['tomorrow'])
  assert.strictEqual(future[0].severity, 'medium')
})

test('zero, negative and invalid amounts are high severity issues', function () {
  var scan = health.scan([
    tx('zero', '2026-11-20', 0),
    tx('negative', '2026-11-20', -12.5),
    tx('invalid', '2026-11-20', 'not-a-number')
  ], NOW)
  var amount = issuesOf(scan, 'amount')
  assert.strictEqual(amount.length, 3)
  assert.deepStrictEqual(amount.map(function (x) { return x.title }).sort(), ['金额无效', '负金额', '零金额'].sort())
  assert.ok(amount.every(function (x) { return x.severity === 'high' }))
})

test('missing merchant and uncategorized records are detected after trimming', function () {
  var scan = health.scan([
    tx('no-merchant', '2026-11-20', 10, { merchant: '   ' }),
    tx('uncat', '2026-11-20', 10, { category: '未分类' }),
    tx('blank-cat', '2026-11-20', 10, { category: '  ' })
  ], NOW)
  assert.deepStrictEqual(issuesOf(scan, 'missingMerchant').map(function (x) { return x.txIds[0] }), ['no-merchant'])
  assert.strictEqual(issuesOf(scan, 'uncategorized').length, 2)
})

test('low-confidence OCR records remain visible in data health with reasons', function () {
  var scan = health.scan([
    tx('ocr-low', '2026-11-20', 10, { confidence: 'low', reviewReasons: ['未识别到商户', '详情页缺少交易单号'] }),
    tx('ocr-high', '2026-11-20', 10, { confidence: 'high', reviewReasons: [] })
  ], NOW)
  var issues = issuesOf(scan, 'ocrReview')
  assert.strictEqual(issues.length, 1)
  assert.deepStrictEqual(issues[0].txIds, ['ocr-low'])
  assert.ok(issues[0].description.includes('未识别到商户') && issues[0].description.includes('详情页缺少交易单号'))
})

test('large amount defaults to inclusive 10000 and supports configuration', function () {
  var rows = [
    tx('below', '2026-11-20', 9999.99),
    tx('equal', '2026-11-20', 10000),
    tx('above', '2026-11-20', 12000)
  ]
  var scan = health.scan(rows, NOW)
  assert.strictEqual(scan.largeAmount, 10000)
  assert.deepStrictEqual(issuesOf(scan, 'large').map(function (x) { return x.txIds[0] }), ['above', 'equal'])
  assert.strictEqual(health.scan(rows, NOW, { largeAmount: 12000 }).largeAmount, 12000)
  assert.strictEqual(issuesOf(health.scan(rows, NOW, { largeAmount: 12000 }), 'large').length, 1)
  assert.strictEqual(health.scan(rows, { now: NOW, largeAmount: 5000 }).largeAmount, 5000)
  assert.strictEqual(health.scan(rows, NOW, { largeAmount: -1 }).largeAmount, 10000)
})

test('every issue has stable key, type, severity, ids, title, description and suggestion', function () {
  var scan = health.scan([tx('all', '2026-11-25', 10000, { merchant: '', category: '未分类' })], NOW)
  assert.strictEqual(scan.issues.length, 4)
  var keys = Object.create(null)
  scan.issues.forEach(function (entry) {
    assert.ok(entry.key && keys[entry.key] !== true)
    keys[entry.key] = true
    assert.ok(entry.type && entry.severity && entry.title && entry.description && entry.suggestion)
    assert.deepStrictEqual(entry.txIds, ['all'])
    assert.strictEqual(entry.records.length, 1)
  })
})

test('empty data and summarize are stable, grouped and do not mutate scan', function () {
  var empty = health.scan([], NOW)
  var summary = health.summarize(empty)
  assert.deepStrictEqual(empty, { total: 0, largeAmount: 10000, today: '2026-11-24', issues: [] })
  assert.strictEqual(summary.total, 0)
  assert.strictEqual(summary.issueCount, 0)
  assert.strictEqual(summary.affectedTxCount, 0)
  assert.strictEqual(summary.healthy, true)
  assert.deepStrictEqual(summary.groups, [])
  assert.strictEqual(summary.types.length, 7)
  assert.strictEqual(health.scan(null, NOW).total, 0)

  var scan = health.scan([tx('a', '2026-11-20', 25), tx('b', '2026-11-20', 25)], NOW)
  var before = JSON.stringify(scan)
  Object.freeze(scan.issues)
  var result = health.summarize(scan)
  assert.strictEqual(JSON.stringify(scan), before)
  assert.strictEqual(result.byType.duplicate, 1)
  assert.strictEqual(result.txCountByType.duplicate, 2)
  assert.strictEqual(result.groups[0].type, 'duplicate')
  assert.strictEqual(result.groups[0].issues.length, 1)
})

/* 页面控制器集成：真实 store.remove，验证逐笔删除、成员权限和跳流水筛选。 */
var storage = {}
var modals = []
var toasts = []
var nav = []
var app = { globalData: {} }
function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)) }
global.wx = {
  getStorageSync: function (key) { return key in storage ? clone(storage[key]) : '' },
  setStorageSync: function (key, value) { storage[key] = clone(value) },
  removeStorageSync: function (key) { delete storage[key] },
  getAppBaseInfo: function () { return { theme: 'light' } },
  onThemeChange: function () {},
  offThemeChange: function () {},
  setNavigationBarTitle: function () {},
  setTabBarStyle: function () {},
  showToast: function (options) { toasts.push(options) },
  showModal: function (options) { modals.push(options) },
  switchTab: function (options) { nav.push(options.url) },
  navigateBack: function () {}
}
global.getApp = function () { return app }
var pageConfig = null
global.Page = function (config) { pageConfig = config }
var store = require('../utils/store')
var pagePath = path.resolve(__dirname, '../pages/health/health.js')
require(pagePath)
var page = Object.assign({}, pageConfig)
page.data = clone(pageConfig.data)
page.setData = function (patch, cb) {
  var self = this
  Object.keys(patch).forEach(function (key) {
    var parts = key.split('.')
    var target = self.data
    while (parts.length > 1) target = target[parts.shift()]
    target[parts[0]] = patch[key]
  })
  if (cb) cb()
}
function seed(rows) {
  storage.txs_v1 = clone(rows)
  storage.shared_book_v1 = {
    bookId: 'one', name: '测试账本', nickname: '我', joinedAt: NOW,
    members: 2, memberList: [{ nickname: '我', isMe: true }, { nickname: '小李', isMe: false }]
  }
  storage.prefs_v1 = { viewScope: 'both' }
  store.reload()
  app.globalData = {}
  page.setData({ scope: 'both', activeType: 'all', largeAmount: 10000 })
  page.refresh()
}
function allIssues() {
  var out = []
  page.data.groups.forEach(function (group) {
    out = out.concat(group.issues)
  })
  return out
}
function event(id, key) {
  return { currentTarget: { dataset: { id: id, key: key || '' } } }
}

test('health page groups issues and marks peer duplicate rows read-only', function () {
  seed([
    tx('mine-a', '2026-11-20', 25), tx('mine-b', '2026-11-20', 25),
    peer('peer-a', 'P', 'one', { by: '小李' }), peer('peer-b', 'P', 'one', { by: '小李' }),
    tx('uncat', '2026-11-21', 33, { category: '未分类' })
  ])
  page.onLoad()
  page.onShow()
  assert.strictEqual(page.data.summary.total, 5)
  assert.strictEqual(page.data.summary.issueCount, 3)
  assert.strictEqual(page.data.types.length, 7)
  var duplicates = allIssues().filter(function (entry) { return entry.type === 'duplicate' })
  assert.strictEqual(duplicates.length, 2)
  var peerIssue = duplicates.filter(function (entry) { return entry.items[0].id === 'peer-a' })[0]
  assert.ok(peerIssue.items.every(function (row) { return row.canEdit === false && row.byLabel === '小李' }))
})

test('dangerous deletion requires confirmation, rejects peers and removes only one own row', function () {
  seed([
    tx('mine-a', '2026-11-20', 25), tx('mine-b', '2026-11-20', 25),
    peer('peer-a', 'P', 'one'), peer('peer-b', 'P', 'one')
  ])
  var originalRemove = store.remove
  var removed = []
  store.remove = function (id) { removed.push(id); return originalRemove(id) }
  try {
    modals = []
    page.requestDelete(event('peer-a'))
    assert.strictEqual(modals.length, 0)
    assert.deepStrictEqual(removed, [])

    page.requestDelete(event('mine-a'))
    assert.strictEqual(modals.length, 1)
    assert.strictEqual(modals[0].confirmText, '确认删除')
    assert.strictEqual(modals[0].confirmColor, '#d9433f')
    assert.ok(modals[0].content.indexOf('不会批量删除') >= 0)
    modals[0].success({ confirm: false })
    assert.deepStrictEqual(removed, [])

    modals[0].success({ confirm: true })
    assert.deepStrictEqual(removed, ['mine-a'])
    assert.deepStrictEqual(storage.txs_v1.map(function (row) { return row.id }).sort(), ['mine-b', 'peer-a', 'peer-b'])
    assert.strictEqual(allIssues().filter(function (entry) { return entry.type === 'duplicate' }).length, 1)
  } finally {
    store.remove = originalRemove
  }
})

test('detail and uncategorized navigation write complete list filters', function () {
  seed([tx('mine-a', '2026-11-20', 25), tx('mine-b', '2026-11-20', 25),
    tx('uncat', '2026-11-21', 33, { category: '未分类' })])
  nav = []
  var duplicate = allIssues().filter(function (entry) { return entry.type === 'duplicate' })[0]
  page.goTx(event('mine-a', duplicate.key))
  assert.strictEqual(nav[nav.length - 1], '/pages/list/list')
  assert.strictEqual(app.globalData.openTxId, 'mine-a')
  assert.strictEqual(app.globalData.filterYm, '2026-11')
  assert.strictEqual(app.globalData.filterDay, '2026-11-20')
  assert.strictEqual(app.globalData.backTab, '/pages/health/health')

  page.goUncat()
  assert.strictEqual(app.globalData.filterUncat, true)
  assert.strictEqual(app.globalData.filterCat, '')
  assert.strictEqual(app.globalData.filterKind, '')
  assert.strictEqual(app.globalData.filterDay, '')
  assert.strictEqual(app.globalData.openTxId, '')
})

test('scope filtering, type filtering and explicit empty/healthy states work', function () {
  seed([tx('mine-a', '2026-11-20', 25), tx('mine-b', '2026-11-20', 25), peer('peer-a', 'P', 'one')])
  page.setScope({ currentTarget: { dataset: { scope: 'mine' } } })
  assert.strictEqual(page.data.summary.total, 2)
  assert.ok(!JSON.stringify(page.data.groups).includes('peer-a'))
  page.setScope({ currentTarget: { dataset: { scope: 'both' } } })
  assert.strictEqual(page.data.summary.total, 3)

  page.filterType({ currentTarget: { dataset: { type: 'large' } } })
  assert.strictEqual(page.data.groups.length, 0)
  page.filterType({ currentTarget: { dataset: { type: 'all' } } })
  assert.ok(page.data.groups.length > 0)

  seed([])
  assert.strictEqual(page.data.hasTx, false)
  assert.strictEqual(page.data.summary.total, 0)
  seed([tx('ok', '2026-11-20', 10)])
  assert.strictEqual(page.data.hasTx, true)
  assert.strictEqual(page.data.summary.healthy, true)
  assert.strictEqual(page.data.summary.issueCount, 0)
})

console.log('Passed ' + pass + ', failed ' + fails.length)
if (fails.length) process.exit(1)
