/* 多币种核心：node --test tools/test-currency.js */
var assert = require('node:assert/strict')
var test = require('node:test')
var currency = require('../utils/currency')
var disk = {}
var writes = 0
var failedKey = ''

global.wx = {
  getStorageSync: function (key) { return key in disk ? JSON.parse(JSON.stringify(disk[key])) : '' },
  setStorageSync: function (key, value) {
    if (key === failedKey) throw new Error('storage full')
    writes++
    disk[key] = JSON.parse(JSON.stringify(value))
  },
  removeStorageSync: function (key) { delete disk[key] }
}

var rates = require('../utils/exchange-rates')

function resetRates() {
  disk = {}
  writes = 0
  failedKey = ''
  rates.reload && rates.reload()
}

test('支持六种币种，代码规范化且人民币汇率固定为 1', function () {
  assert.deepEqual(currency.CODES, ['CNY', 'USD', 'EUR', 'GBP', 'JPY', 'HKD'])
  assert.equal(currency.normalizeCode(' usd '), 'USD')
  assert.equal(currency.normalizeCode('XXX'), 'CNY')
  assert.equal(currency.normalizeCode(null), 'CNY')
  currency.CODES.forEach(function (code) {
    assert.equal(currency.CURRENCIES[code].code, code)
    assert.ok(currency.CURRENCIES[code].symbol)
    assert.ok(currency.CURRENCIES[code].name)
  })
  assert.equal(currency.normalizeRate('999', 'CNY'), 1)
  assert.equal(currency.normalizeRate('7.20', 'USD'), 7.2)
  assert.equal(currency.normalizeRate('0.05', 'JPY'), 0.05)
  ;[0, -1, '', 'abc', Infinity, '1e3', true, {}, []].forEach(function (rate) {
    assert.equal(currency.normalizeRate(rate, 'USD'), null)
  })
  assert.equal(currency.normalizeStrictCode(' usd '), 'USD')
  assert.equal(currency.normalizeStrictCode('XXX'), '')
})

test('convert 按分换算并四舍五入，保留汇率快照语义', function () {
  assert.equal(currency.convert(1000, 1, 1), 1000)
  assert.equal(currency.convert(1000, 7.2, 1), 7200)
  assert.equal(currency.convert(7200, 1, 7.2), 1000)
  assert.equal(currency.convert(1, 0.05, 1), 0)
  assert.equal(currency.convert(10, 0.05, 1), 1)
  assert.equal(currency.convert(-1000, 7.2, 1), -7200)
  assert.equal(currency.convert(1000, 0, 1), null)
  assert.equal(currency.convert(1000, 7.2, null), null)
  assert.equal(currency.convert(1.2, 1, 1), null)
})

test('txNative 读取原币分并兼容无币种字段的旧人民币流水', function () {
  var account = { currency: 'USD', rateToCny: 99 }
  assert.equal(currency.txNative({ nativeAmount: '12.34', currency: 'USD', rateToCny: 7.2 }, account), 1234)
  assert.equal(currency.txNative({ nativeAmount: '-0.29', currency: 'EUR', rateToCny: 8 }, account), -29)
  assert.equal(currency.txNative({ amount: 12.34 }, account), 1234)
  assert.equal(currency.txNative({ nativeAmount: 'bad', amount: 2 }, account), 0)
  assert.equal(currency.txNative({ nativeAmount: 1.25, currency: 'JPY', rateToCny: 0.05 }, null), 125)
})

test('formatNative 显示符号、币种、千分位和负数，人民币保持原样式', function () {
  assert.equal(currency.formatNative(123456, 'USD'), '$1,234.56 USD')
  assert.equal(currency.formatNative(-29, 'EUR'), '-€0.29 EUR')
  assert.equal(currency.formatNative(100, 'JPY'), '¥1.00 JPY')
  assert.equal(currency.formatNative(100, 'CNY'), '¥1.00')
  assert.equal(currency.formatNative(null, 'USD'), '--')
  assert.equal(currency.formatRate(7.2, 'USD'), '1 USD = 7.2 CNY')
})

test('汇率历史记录首次与修改，按时间倒序且 CNY、重复汇率不记录', function () {
  resetRates()
  assert.equal(rates.KEY, 'exchange_rates_v1')
  assert.deepEqual(rates.list('a'), [])
  var first = rates.record('a', 'USD', '7.20', null, 1700000000000)
  assert.ok(first.id)
  assert.deepEqual(first, { id: first.id, currency: 'USD', rate: 7.2, previousRate: null, createdAt: 1700000000000 })
  var changed = rates.record('a', 'USD', 8, 7.2, 1700000001000)
  assert.equal(changed.previousRate, 7.2)
  assert.deepEqual(rates.list('a').map(function (item) { return item.id }), [changed.id, first.id])
  assert.deepEqual(disk.exchange_rates_v1.a, [changed, first])

  var beforeWrites = writes
  assert.equal(rates.record('a', 'USD', 8, 8, 1700000002000), null)
  assert.equal(rates.record('a', 'USD', 8, undefined, 1700000002000), null)
  assert.equal(rates.record('a', 'CNY', 1, null, 1700000002000), null)
  assert.equal(rates.error(), '')
  assert.equal(writes, beforeWrites)
  assert.equal(rates.list('a').length, 2)

  var usdToEur = rates.record('a', 'EUR', 8, 8, 1700000003000)
  assert.equal(usdToEur.currency, 'EUR')
  assert.equal(rates.list('a').length, 3, '币种变化即使汇率相同也记录')
  var copy = rates.list('a')
  copy[0].rate = 999
  assert.equal(rates.list('a')[0].rate, 8)
})

test('汇率历史拒绝无效账户、币种、汇率和时间，不产生坏数据', function () {
  resetRates()
  ;[
    function () { return rates.record('', 'USD', 7, null, 1) },
    function () { return rates.record('a', 'XXX', 7, null, 1) },
    function () { return rates.record('a', 'USD', 0, null, 1) },
    function () { return rates.record('a', 'USD', -1, null, 1) },
    function () { return rates.record('a', 'USD', 7, 0, 1) },
    function () { return rates.record('a', 'USD', 7, null, 0) }
  ].forEach(function (run) {
    assert.equal(run(), null)
    assert.ok(rates.error())
  })
  assert.deepEqual(disk, {})
})

test('汇率历史每账户最多 100 条，保留最新记录', function () {
  resetRates()
  for (var i = 1; i <= 105; i++) rates.record('a', 'USD', i, i - 1 || null, 1700000000000 + i)
  var rows = rates.list('a')
  assert.equal(rows.length, 100)
  assert.equal(rows[0].rate, 105)
  assert.equal(rows[99].rate, 6)
  assert.equal(disk.exchange_rates_v1.a.length, 100)
})

test('删除账户清理对应汇率历史，不影响其他账户', function () {
  resetRates()
  rates.record('a', 'USD', 7, null, 1)
  rates.record('b', 'EUR', 8, null, 2)
  assert.equal(rates.removeAccount('a'), true)
  assert.deepEqual(rates.list('a'), [])
  assert.equal(rates.list('b').length, 1)
  assert.equal(rates.removeAccount('a'), false)
  assert.equal(rates.error(), '')
})

test('汇率历史兼容旧记录并支持导出、纯合并计划和替换模式', function () {
  resetRates()
  disk.exchange_rates_v1 = {
    a: [{ currency: 'USD', rate: '7.2', time: 1700000000000 }],
    cny: [{ id: 'old-cny', currency: 'CNY', rate: 1, previousRate: null, createdAt: 1700000000000 }]
  }
  var legacy = rates.list('a')[0]
  assert.ok(legacy.id)
  assert.equal(legacy.previousRate, null)
  assert.equal(legacy.createdAt, 1700000000000)
  assert.deepEqual(rates.list('cny'), [])

  var exported = rates.exportData()
  assert.equal(exported.storageKey, 'exchange_rates_v1')
  assert.equal(exported.version, 1)
  exported.exchangeRates.a[0].rate = 99
  assert.equal(rates.list('a')[0].rate, 7.2)

  var incoming = { a: [
    { id: legacy.id, currency: 'USD', rate: 8, previousRate: 7.2, createdAt: 1700000001000 },
    { id: 'new-eur', currency: 'EUR', rate: 9, previousRate: null, createdAt: 1700000002000 }
  ] }
  var before = JSON.stringify(disk)
  var beforeWrites = writes
  var plan = rates.planImport({ version: 1, exchangeRates: incoming })
  assert.equal(plan.ok, true)
  assert.equal(plan.added, 1)
  assert.equal(plan.updated, 1)
  assert.equal(plan.total, 2)
  assert.deepEqual(plan.changes, [{ key: 'exchange_rates_v1', value: plan.value }])
  assert.equal(JSON.stringify(disk), before, 'planImport 不写盘')
  assert.equal(writes, beforeWrites)
  disk[rates.KEY] = JSON.parse(JSON.stringify(plan.value))
  assert.deepEqual(rates.planImport(rates.exportData()).changes, [], '已提交的导出重复导入无变化')

  var replace = rates.planImport({ a: [{ id: 'only', currency: 'JPY', rate: 0.05, previousRate: null, createdAt: 1700000003000 }] }, { mode: 'replace' })
  assert.equal(replace.total, 1)
  assert.equal(replace.value.a[0].currency, 'JPY')
  assert.throws(function () { rates.planImport({ version: 2, exchangeRates: {} }) }, /版本/)
  assert.throws(function () { rates.planImport({ a: [{ id: 'bad', currency: 'USD', rate: 0, previousRate: null, createdAt: 1 }] }) }, /大于 0/)
})

test('汇率历史写入失败自动回滚，删除失败不破坏原数据', function () {
  resetRates()
  rates.record('a', 'USD', 7, null, 1)
  var before = JSON.stringify(disk)
  failedKey = rates.KEY
  assert.equal(rates.record('a', 'USD', 8, 7, 2), null)
  assert.match(rates.error(), /撤销|回滚/)
  assert.equal(JSON.stringify(disk), before)
  assert.equal(rates.removeAccount('a'), false)
  assert.equal(JSON.stringify(disk), before)
})
