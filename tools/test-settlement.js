const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { calculate } = require('../utils/settlement')
const settlementState = require('../utils/settlement-state')
const featureBackup = require('../utils/feature-backup')
const format = require('../utils/format')

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log('PASS ' + name)
  } catch (error) {
    console.error('FAIL ' + name)
    throw error
  }
}
const members = [
  { ownerKey: 'me', nickname: '小林', isMe: true },
  { ownerKey: 'peer', nickname: '小周' }
]
const ym = '2026-11'
function tx(id, type, amount, ownerKey, month = ym, extra = {}) {
  const [year, mon] = month.split('-').map(Number)
  const time = new Date(year, mon - 1, 2, 12).getTime()
  return Object.assign({ id, type, amount, ownerKey, time, ym: month }, extra)
}
function byKey(result, key) { return result.members.find((item) => item.ownerKey === key) }
function sumBalances(result) { return result.members.reduce((sum, item) => sum + item.balance, 0) }
function verifyConservation(result) {
  assert.strictEqual(sumBalances(result), 0, '结余总和必须为 0')
  assert.strictEqual(result.members.reduce((sum, item) => sum + item.share, 0), result.total, '分摊总和必须等于净支出')
  assert.strictEqual(result.categories.reduce((sum, item) => sum + item.net, 0), result.total, '分类净支出总和必须等于本月净支出')
  assert.ok(result.categories.every((item) => Number.isSafeInteger(item.net)), '分类净支出必须为安全整数分')
  const deltas = Object.create(null)
  result.members.forEach((item) => { deltas[item.ownerKey] = item.balance })
  result.transfers.forEach((item) => {
    assert.ok(item.amount > 0 && Number.isSafeInteger(item.amount), '转账必须为正整数分')
    assert.notStrictEqual(item.from, item.to, '不能自己转给自己')
    deltas[item.from] += item.amount
    deltas[item.to] -= item.amount
  })
  result.members.forEach((item) => assert.strictEqual(deltas[item.ownerKey], 0, '执行转账建议后应全部结清'))
}

test('两人：A 垫付 100 元，B 应付 50 元', () => {
  const result = calculate([tx('a', 'expense', 100, 'me')], members)
  assert.strictEqual(byKey(result, 'me').paid, 10000)
  assert.strictEqual(byKey(result, 'me').share, 5000)
  assert.strictEqual(byKey(result, 'me').balance, 5000)
  assert.strictEqual(byKey(result, 'peer').balance, -5000)
  assert.deepStrictEqual(result.transfers, [{ from: 'peer', to: 'me', amount: 5000 }])
  verifyConservation(result)
})

test('多人：三人分摊与贪心转账建议', () => {
  const list = members.concat([{ ownerKey: 'third', nickname: '小陈' }])
  const result = calculate([
    tx('a', 'expense', 90, 'me'), tx('b', 'expense', 60, 'peer'), tx('c', 'expense', 30, 'third')
  ], list)
  assert.deepStrictEqual(result.members.map((item) => item.paid), [9000, 6000, 3000])
  assert.deepStrictEqual(result.members.map((item) => item.share), [6000, 6000, 6000])
  assert.deepStrictEqual(result.transfers, [{ from: 'third', to: 'me', amount: 3000 }])
  verifyConservation(result)
})

test('退款抵减付款人，收入与负额不参与', () => {
  const result = calculate([
    tx('a', 'expense', 100, 'me'), tx('r', 'refund', 30, 'me'),
    tx('income', 'income', 999, 'peer'), tx('negative', 'expense', -20, 'peer'),
    tx('negative-refund', 'refund', -5, 'peer')
  ], members)
  assert.strictEqual(result.total, 7000)
  assert.strictEqual(byKey(result, 'me').paid, 7000)
  assert.strictEqual(byKey(result, 'me').refund, 3000)
  assert.strictEqual(byKey(result, 'peer').paid, 0)
  verifyConservation(result)
})

test('transfer 转账与未知成员流水忽略', () => {
  const result = calculate([
    tx('a', 'expense', 20, 'me'), tx('transfer', 'transfer', 9999, 'peer'),
    tx('unknown', 'expense', 50, ' outsider ')
  ], members)
  assert.strictEqual(result.total, 2000)
  assert.strictEqual(result.ignored, 1)
  verifyConservation(result)
})

test('options.ym 跨月过滤并兼容 time/day 推导', () => {
  const result = calculate([
    tx('nov', 'expense', 60, 'me', '2026-11'),
    tx('oct', 'expense', 40, 'peer', '2026-10'),
    tx('time-only', 'expense', 20, 'me', '2026-11', { ym: '' }),
    tx('day-only', 'expense', 10, 'peer', '2026-11', { ym: '', time: 0, day: '2026-11-03' })
  ], members, { ym })
  assert.strictEqual(result.total, 9000)
  assert.strictEqual(result.ym, ym)
  verifyConservation(result)
})

test('本机别名 __me__ 与 ownerKey 优先，不按昵称猜身份', () => {
  const list = [{ ownerKey: 'me-key', nickname: '同名', isMe: true }, { ownerKey: 'other-key', nickname: '同名' }]
  const result = calculate([
    tx('self-alias', 'expense', 30, '__me__'),
    tx('self-key', 'expense', 20, 'me-key'),
    tx('legacy-self', 'expense', 10, ''),
    tx('peer', 'expense', 40, 'other-key'),
    tx('legacy-peer', 'expense', 99, '', ym, { byMe: false })
  ], list)
  assert.strictEqual(byKey(result, 'me-key').paid, 6000)
  assert.strictEqual(byKey(result, 'other-key').paid, 4000)
  assert.strictEqual(result.ignored, 1)
  verifyConservation(result)
  const aliasMember = calculate([tx('x', 'expense', 10, '__me__')], [{ ownerKey: '__me__', isMe: true }])
  assert.strictEqual(aliasMember.members[0].paid, 1000)
})

test('无成员、空流水与无效参数安全返回', () => {
  assert.deepStrictEqual(calculate([tx('x', 'expense', 10, 'me')], []), {
    members: [], transfers: [], total: 0, expense: 0, refund: 0, ym: '', ignored: 0,
    splitMode: 'equal', weights: {}, weightWarnings: [], weightFallback: false,
    categoryWeights: {}, categoryWarnings: [], categoryFallback: [], categories: []
  })
  const result = calculate([], members, { ym: 'bad' })
  assert.strictEqual(result.total, 0)
  assert.deepStrictEqual(result.transfers, [])
  assert.strictEqual(calculate(null, null).members.length, 0)
  verifyConservation(result)
})

test('极端金额：一分钱分摊、安全大额与非有限值', () => {
  const penny = calculate([tx('penny', 'expense', 0.01, 'peer')], members)
  assert.deepStrictEqual(penny.members.map((item) => item.share), [1, 0])
  assert.deepStrictEqual(penny.transfers, [{ from: 'me', to: 'peer', amount: 1 }])
  verifyConservation(penny)

  const huge = Number.MAX_SAFE_INTEGER / 100
  const large = calculate([tx('large', 'expense', huge, 'me')], members)
  assert.strictEqual(large.total, Number.MAX_SAFE_INTEGER)
  assert.ok(large.members.every((item) => Number.isSafeInteger(item.paid) && Number.isSafeInteger(item.share) && Number.isSafeInteger(item.balance)))
  verifyConservation(large)

  const invalid = calculate([
    tx('nan', 'expense', NaN, 'me'), tx('infinity', 'expense', Infinity, 'me'),
    tx('overflow', 'expense', Number.MAX_VALUE, 'me'), tx('zero', 'expense', 0, 'me')
  ], members)
  assert.strictEqual(invalid.total, 0)
  assert.strictEqual(invalid.ignored, 0)
})

test('累加溢出时跳过，不破坏按分守恒', () => {
  const huge = Number.MAX_SAFE_INTEGER / 100
  const result = calculate([tx('one', 'expense', huge, 'me'), tx('two', 'expense', huge, 'me')], members)
  assert.strictEqual(result.total, Number.MAX_SAFE_INTEGER)
  assert.strictEqual(result.ignored, 1)
  verifyConservation(result)
})

test('纯函数不修改输入且转账后保留原始 balance', () => {
  const rows = [tx('a', 'expense', 11.11, 'me')]
  const list = members.map((item) => Object.assign({}, item))
  const before = JSON.stringify({ rows, list })
  const result = calculate(rows, list)
  assert.strictEqual(JSON.stringify({ rows, list }), before)
  assert.strictEqual(byKey(result, 'peer').balance, -555)
  verifyConservation(result)
})

test('权重按比例分摊，0 成员不参与', () => {
  const list = members.concat([{ ownerKey: 'third', nickname: '小陈' }])
  const result = calculate([tx('a', 'expense', 100, 'me')], list, {
    weights: { me: 0, peer: 2, third: 1 }
  })
  assert.strictEqual(result.splitMode, 'weighted')
  assert.deepStrictEqual(result.members.map((item) => item.share), [0, 6667, 3333])
  assert.strictEqual(result.weightFallback, false)
  assert.deepStrictEqual(result.weightWarnings, [])
  verifyConservation(result)
})

test('权重余数守恒且同余量按成员顺序确定性分配', () => {
  const list = members.concat([{ ownerKey: 'third', nickname: '小陈' }])
  const rows = [tx('a', 'expense', 0.01, 'me')]
  const options = { weights: { me: 1, peer: 1, third: 1 } }
  const first = calculate(rows, list, options)
  const second = calculate(rows, list.slice().reverse(), { weights: options.weights })
  assert.deepStrictEqual(first.members.map((item) => item.share), [1, 0, 0])
  assert.deepStrictEqual(second.members.map((item) => item.share), [1, 0, 0])
  assert.strictEqual(second.members[0].ownerKey, 'third')
  verifyConservation(first)
  verifyConservation(second)

  const hundred = calculate([tx('a', 'expense', 100, 'me')], list, options)
  assert.deepStrictEqual(hundred.members.map((item) => item.share), [3334, 3333, 3333])
  verifyConservation(hundred)
})

test('十进制权重精确分摊，不依赖浮点总和', () => {
  const list = members.concat([{ ownerKey: 'third', nickname: '小陈' }])
  const result = calculate([tx('a', 'expense', 0.1, 'me')], list, {
    weights: { me: 0.1, peer: 0.2, third: 0.3 }
  })
  assert.deepStrictEqual(result.members.map((item) => item.share), [2, 3, 5])
  verifyConservation(result)

  const huge = calculate([tx('a', 'expense', 0.01, 'me')], list, {
    weights: { me: Number.MAX_VALUE, peer: 1, third: 2 }
  })
  assert.deepStrictEqual(huge.members.map((item) => item.share), [1, 0, 0])
  verifyConservation(huge)
})

test('权重支持负数净支出并保持转账守恒', () => {
  const result = calculate([tx('r', 'refund', 0.01, 'me')], members, { weights: { me: 1, peer: 1 } })
  assert.deepStrictEqual(result.members.map((item) => item.share), [-1, 0])
  assert.strictEqual(result.total, -1)
  verifyConservation(result)
})

test('无效权重忽略并给出解释，全零或全无效回退平均', () => {
  const mixed = calculate([tx('a', 'expense', 100, 'me')], members, {
    weights: { me: 2, peer: 'bad', outsider: 9 }
  })
  assert.strictEqual(mixed.splitMode, 'weighted')
  assert.deepStrictEqual(mixed.members.map((item) => item.share), [10000, 0])
  assert.ok(mixed.weightWarnings.some((text) => text.includes('peer') && text.includes('按 0')))
  assert.ok(mixed.weightWarnings.some((text) => text.includes('outsider') && text.includes('忽略')))
  verifyConservation(mixed)

  ;[{ me: 0, peer: 0 }, { me: -1, peer: NaN }, { me: Infinity }, []].forEach((weights) => {
    const result = calculate([tx('a', 'expense', 100, 'me')], members, { weights })
    assert.strictEqual(result.splitMode, 'equal')
    assert.strictEqual(result.weightFallback, true)
    assert.deepStrictEqual(result.members.map((item) => item.share), [5000, 5000])
    assert.ok(result.weightWarnings.length > 0)
    verifyConservation(result)
  })
})

test('权重计算不修改成员、流水或权重输入', () => {
  const rows = [tx('a', 'expense', 11.11, 'me')]
  const list = members.map((item) => Object.assign({}, item))
  const weights = { me: 2, peer: 1 }
  const before = JSON.stringify({ rows, list, weights })
  const result = calculate(rows, list, { weights })
  assert.strictEqual(JSON.stringify({ rows, list, weights }), before)
  assert.deepStrictEqual(result.weights, weights)
  verifyConservation(result)
})

test('分类覆盖：分类净支出单独分摊，其余按默认权重后相加', () => {
  const list = members.concat([{ ownerKey: 'third', nickname: '小陈' }])
  const rows = [
    tx('food', 'expense', 100.01, 'me', ym, { category: '餐饮' }),
    tx('food-refund', 'refund', 10.01, 'me', ym, { category: '餐饮' }),
    tx('travel', 'expense', 50.02, 'peer', ym, { category: '旅行' })
  ]
  const options = {
    weights: { me: 1, peer: 2, third: 1 },
    categoryWeights: { 餐饮: { me: 0, peer: 1, third: 1 } }
  }
  const before = JSON.stringify({ rows, list, options })
  const result = calculate(rows, list, options)
  assert.strictEqual(JSON.stringify({ rows, list, options }), before)
  assert.strictEqual(result.total, 14002)
  assert.deepStrictEqual(result.members.map((item) => item.share), [1251, 7001, 5750])
  assert.deepStrictEqual(result.categoryWeights, { 餐饮: { peer: 1, third: 1 } })
  assert.deepStrictEqual(result.categories.map((item) => [item.name, item.net, item.covered]), [
    ['餐饮', 9000, true], ['旅行', 5002, false]
  ])
  assert.deepStrictEqual(result.categoryWarnings, [])
  verifyConservation(result)
})

test('分类覆盖：多分类分别处理余数，0 权重成员不参与', () => {
  const list = members.concat([{ ownerKey: 'third', nickname: '小陈' }])
  const rows = ['餐饮', '旅行', '购物'].map((name, index) => tx(name, 'expense', 0.01, 'me', ym, { category: name }))
  const categoryWeights = { 餐饮: { me: 0, peer: 2, third: 1 }, 旅行: { me: 0, peer: 2, third: 1 }, 购物: { me: 0, peer: 2, third: 1 } }
  const result = calculate(rows, list, { categoryWeights })
  assert.deepStrictEqual(result.members.map((item) => item.share), [0, 3, 0])
  assert.strictEqual(result.total, 3)
  verifyConservation(result)

  const equal = calculate(rows, list, { categoryWeights: { 餐饮: { me: 1, peer: 1, third: 1 }, 旅行: { me: 1, peer: 1, third: 1 }, 购物: { me: 1, peer: 1, third: 1 } } })
  assert.deepStrictEqual(equal.members.map((item) => item.share), [3, 0, 0], '每个分类的一分钱都按成员顺序分配')
  verifyConservation(equal)
})

test('分类覆盖：退款形成负净支出、缺失分类归未分类且保持守恒', () => {
  const result = calculate([
    tx('food', 'expense', 20, 'me', ym, { category: '餐饮' }),
    tx('food-refund', 'refund', 30, 'peer', ym, { category: '餐饮' }),
    tx('uncat', 'expense', 10, 'third')
  ], members.concat([{ ownerKey: 'third', nickname: '小陈' }]), {
    weights: { me: 1, peer: 1, third: 1 },
    categoryWeights: { 餐饮: { me: 1, peer: 0, third: 0 } }
  })
  assert.strictEqual(result.total, 0)
  assert.deepStrictEqual(result.members.map((item) => item.share), [-666, 333, 333])
  assert.ok(result.categories.some((item) => item.name === '未分类' && item.net === 1000 && !item.covered))
  verifyConservation(result)
})

test('分类覆盖：无效格式、空映射和全零忽略并回退默认权重', () => {
  const rows = [tx('food', 'expense', 100, 'me', ym, { category: '餐饮' })]
  const options = { weights: { me: 2, peer: 1 } }
  const malformed = calculate(rows, members, Object.assign({}, options, { categoryWeights: [] }))
  assert.deepStrictEqual(malformed.members.map((item) => item.share), [6667, 3333])
  assert.ok(malformed.categoryWarnings.length)
  verifyConservation(malformed)

  ;[{}, { me: 0, peer: 0 }, { me: -1, peer: 'bad' }].forEach((weights) => {
    const result = calculate(rows, members, Object.assign({}, options, { categoryWeights: { 餐饮: weights } }))
    assert.deepStrictEqual(result.members.map((item) => item.share), [6667, 3333])
    assert.deepStrictEqual(result.categoryFallback, ['餐饮'])
    assert.strictEqual(result.categories[0].covered, false)
    assert.ok(result.categoryWarnings.length)
    verifyConservation(result)
  })
})

test('状态：分类覆盖按账本和月份隔离，可保存、删除和拒绝无效值', () => {
  const disk = {}
  global.wx = {
    getStorageSync: (key) => key in disk ? JSON.parse(JSON.stringify(disk[key])) : '',
    setStorageSync: (key, value) => { disk[key] = JSON.parse(JSON.stringify(value)) },
    showToast: () => {}
  }
  assert.deepStrictEqual(settlementState.load('book-a', ym).categoryWeights, {})
  assert.strictEqual(settlementState.saveCategoryWeights('book-a', ym, '餐饮', { me: 0, peer: 2 }).ok, true)
  assert.deepStrictEqual(settlementState.load('book-a', ym).categoryWeights, { 餐饮: { me: 0, peer: 2 } })
  assert.deepStrictEqual(settlementState.load('book-a', '2026-10').categoryWeights, {})
  assert.deepStrictEqual(settlementState.load('book-b', ym).categoryWeights, {})
  const before = JSON.stringify(disk.settlement_v1)
  ;[{}, { me: 0, peer: 0 }, { me: -1 }, null].forEach((weights) => {
    assert.strictEqual(settlementState.saveCategoryWeights('book-a', ym, '餐饮', weights).ok, false)
  })
  assert.strictEqual(settlementState.saveCategoryWeights('book-a', ym, '', { me: 1 }).ok, false)
  assert.strictEqual(JSON.stringify(disk.settlement_v1), before)
  assert.strictEqual(settlementState.removeCategoryWeights('book-a', ym, '餐饮').ok, true)
  assert.deepStrictEqual(settlementState.load('book-a', ym).categoryWeights, {})
})

test('状态：命名模板 CRUD、账本隔离、套用与平均分摊模板', () => {
  const disk = {}
  global.wx = {
    getStorageSync: (key) => key in disk ? JSON.parse(JSON.stringify(disk[key])) : '',
    setStorageSync: (key, value) => { disk[key] = JSON.parse(JSON.stringify(value)) },
    showToast: () => {}
  }
  assert.deepStrictEqual(settlementState.listTemplates('book-a'), [])
  const saved = settlementState.saveTemplate('book-a', '旅行比例', { me: 2, peer: 1 })
  assert.strictEqual(saved.ok, true)
  assert.ok(saved.template.id && saved.template.name === '旅行比例' && saved.template.createdAt > 0)
  assert.deepStrictEqual(saved.template.weights, { me: 2, peer: 1 })
  assert.deepStrictEqual(settlementState.listTemplates('book-b'), [])
  settlementState.saveCategoryWeights('book-a', ym, '餐饮', { me: 1, peer: 3 })
  const applied = settlementState.applyTemplate('book-a', ym, saved.template.id)
  assert.strictEqual(applied.ok, true)
  assert.deepStrictEqual(settlementState.load('book-a', ym).weights, { me: 2, peer: 1 })
  assert.deepStrictEqual(settlementState.load('book-a', ym).categoryWeights, { 餐饮: { me: 1, peer: 3 } }, '套用模板不能清除分类覆盖')
  assert.deepStrictEqual(settlementState.load('book-a', '2026-10').weights, {})
  const average = settlementState.saveTemplate('book-a', '平均', {})
  assert.strictEqual(settlementState.applyTemplate('book-a', ym, average.template.id).ok, true)
  assert.deepStrictEqual(settlementState.load('book-a', ym).weights, {})
  assert.strictEqual(settlementState.listTemplates('book-a').length, 2)
  const before = JSON.stringify(disk.settlement_v1)
  assert.strictEqual(settlementState.saveTemplate('book-a', '', { me: 1 }).ok, false)
  assert.strictEqual(settlementState.saveTemplate('book-a', '无效', { me: 0, peer: 0 }).ok, false)
  assert.strictEqual(settlementState.applyTemplate('book-a', ym, 'missing').ok, false)
  assert.strictEqual(settlementState.deleteTemplate('book-a', 'missing').ok, false)
  assert.strictEqual(JSON.stringify(disk.settlement_v1), before)
  assert.strictEqual(settlementState.deleteTemplate('book-a', saved.template.id).ok, true)
  assert.deepStrictEqual(settlementState.listTemplates('book-a').map((item) => item.id), [average.template.id])
})

test('状态：权重按账本和月份隔离并持久化', () => {
  const disk = {}
  global.wx = {
    getStorageSync: (key) => key in disk ? JSON.parse(JSON.stringify(disk[key])) : '',
    setStorageSync: (key, value) => { disk[key] = JSON.parse(JSON.stringify(value)) },
    showToast: () => {}
  }
  assert.strictEqual(settlementState.KEY, 'settlement_v1')
  assert.deepStrictEqual(settlementState.load('book-a', ym), { weights: {}, categoryWeights: {}, settled: [] })
  const saved = settlementState.saveWeights('book-a', ym, { me: 2, peer: 0 })
  assert.strictEqual(saved.ok, true)
  assert.deepStrictEqual(settlementState.load('book-a', ym).weights, { me: 2, peer: 0 })
  assert.deepStrictEqual(settlementState.load('book-a', '2026-10').weights, {})
  assert.deepStrictEqual(settlementState.load('book-b', ym).weights, {})
  assert.ok(disk.settlement_v1)
  assert.strictEqual(settlementState.saveWeights('book-a', ym, { me: 0, peer: 0 }).ok, false)
  assert.strictEqual(settlementState.saveWeights('book-a', ym, { me: -1 }).ok, false)
  assert.deepStrictEqual(settlementState.load('book-a', ym).weights, { me: 2, peer: 0 }, '失败写入不能覆盖原状态')
  settlementState.saveWeights('book-a', ym, {})
  assert.deepStrictEqual(settlementState.load('book-a', ym).weights, {})
})

test('状态：转账按 from/to/amount 标识，可标记和取消', () => {
  const disk = {}
  global.wx = {
    getStorageSync: (key) => key in disk ? disk[key] : '',
    setStorageSync: (key, value) => { disk[key] = JSON.parse(JSON.stringify(value)) },
    showToast: () => {}
  }
  const transfer = { from: 'peer', to: 'me', amount: 2000, fromName: '小周', toName: '小林（我）' }
  assert.strictEqual(settlementState.toggleSettled('book-a', ym, transfer).action, 'settle')
  assert.strictEqual(settlementState.load('book-a', ym).settled.length, 1)
  assert.strictEqual(settlementState.load('book-a', ym).settled[0].amount, 2000)
  assert.ok(settlementState.load('book-a', ym).settled[0].settledAt > 0)
  assert.strictEqual(settlementState.toggleSettled('book-a', ym, transfer).action, 'unsettle')
  assert.strictEqual(settlementState.load('book-a', ym).settled.length, 0)
  assert.strictEqual(settlementState.toggleSettled('book-a', ym, Object.assign({}, transfer, { amount: 2001 })).ok, true)
  assert.strictEqual(settlementState.load('book-a', ym).settled.length, 1, '金额变化应视为另一笔转账')
  assert.strictEqual(settlementState.toggleSettled('book-a', ym, { from: 'me', to: 'peer', amount: 2001 }).ok, true)
  assert.strictEqual(settlementState.load('book-a', ym).settled.length, 2, '转账方向不同应分别记录')
  const before = JSON.stringify(disk.settlement_v1)
  assert.strictEqual(settlementState.toggleSettled('book-a', ym, { from: 'me', to: 'me', amount: 1 }).ok, false)
  assert.strictEqual(JSON.stringify(disk.settlement_v1), before)
})

test('状态：历史包含时间、月份、双方、金额和操作类型，支持限量倒序', () => {
  const disk = {}
  global.wx = {
    getStorageSync: (key) => key in disk ? disk[key] : '',
    setStorageSync: (key, value) => { disk[key] = JSON.parse(JSON.stringify(value)) },
    showToast: () => {}
  }
  const transfer = { from: 'peer', to: 'me', amount: 2000 }
  settlementState.toggleSettled('book-a', ym, transfer)
  settlementState.toggleSettled('book-a', ym, transfer)
  settlementState.toggleSettled('book-a', '2026-10', transfer)
  const rows = settlementState.history('book-a', 2)
  assert.strictEqual(rows.length, 2)
  assert.deepStrictEqual(rows.map((item) => item.action), ['settle', 'unsettle'])
  assert.strictEqual(rows[0].ym, '2026-10')
  ;['time', 'ym', 'from', 'to', 'amount', 'action'].forEach((key) => assert.ok(key in rows[0]))
  assert.deepStrictEqual(settlementState.history('book-b', 10), [])
})

test('状态：导入导出可往返，导入为替换且失败不写入', () => {
  const disk = {}
  global.wx = {
    getStorageSync: (key) => key in disk ? JSON.parse(JSON.stringify(disk[key])) : '',
    setStorageSync: (key, value) => { disk[key] = JSON.parse(JSON.stringify(value)) },
    showToast: () => {}
  }
  settlementState.saveWeights('book-a', ym, { me: 3, peer: 1 })
  settlementState.saveCategoryWeights('book-a', ym, '餐饮', { me: 1, peer: 0 })
  settlementState.saveTemplate('book-a', '常用', { me: 2, peer: 1 })
  settlementState.toggleSettled('book-a', ym, { from: 'peer', to: 'me', amount: 1234 })
  settlementState.toggleSettled('book-a', ym, { from: 'peer', to: 'me', amount: 1234 })
  const payload = settlementState.exportData()
  assert.strictEqual(payload.version, 1)
  delete disk.settlement_v1
  const restored = settlementState.importData(payload)
  assert.strictEqual(restored.ok, true)
  assert.deepStrictEqual(settlementState.exportData(), payload)
  assert.deepStrictEqual(settlementState.load('book-a', ym).categoryWeights, { 餐饮: { me: 1, peer: 0 } })
  assert.strictEqual(settlementState.listTemplates('book-a')[0].name, '常用')
  payload.books['book-a'].months[ym].weights.me = 99
  assert.strictEqual(settlementState.load('book-a', ym).weights.me, 3, '导入后修改载荷不能影响存储')

  const before = JSON.stringify(disk.settlement_v1)
  const invalid = settlementState.exportData()
  invalid.books['book-a'].months[ym].weights.me = -1
  assert.strictEqual(settlementState.importData(invalid).ok, false)
  assert.strictEqual(settlementState.importData({ version: 99, books: {} }).ok, false)
  assert.strictEqual(JSON.stringify(disk.settlement_v1), before, '校验失败不能部分写入')
  assert.strictEqual(settlementState.importData({ version: 1, books: {} }).ok, true)
  assert.deepStrictEqual(settlementState.load('book-a', ym), { weights: {}, categoryWeights: {}, settled: [] })
  assert.deepStrictEqual(settlementState.history('book-a'), [])
})

test('状态：备份合并计划不写盘，权重以备份为准且结清记录取并集', () => {
  const disk = {}
  global.wx = {
    getStorageSync: (key) => key in disk ? JSON.parse(JSON.stringify(disk[key])) : '',
    setStorageSync: (key, value) => { disk[key] = JSON.parse(JSON.stringify(value)) },
    showToast: () => {}
  }
  settlementState.saveWeights('book-a', ym, { me: 3, peer: 1 })
  settlementState.saveCategoryWeights('book-a', ym, '餐饮', { me: 1, peer: 0 })
  const localTemplate = settlementState.saveTemplate('book-a', '本机', { me: 1, peer: 1 }).template
  settlementState.toggleSettled('book-a', ym, { from: 'peer', to: 'me', amount: 1234 })
  const payload = settlementState.exportData()
  payload.books['book-a'].months[ym].weights.me = 9
  payload.books['book-a'].months[ym].categoryWeights['餐饮'] = { me: 4, peer: 1 }
  payload.books['book-a'].months[ym].categoryWeights['旅行'] = { me: 0, peer: 2 }
  payload.books['book-a'].templates.push({ id: 'incoming', name: '备份', weights: { me: 5, peer: 1 }, createdAt: 1 })
  payload.books['book-a'].months[ym].settled.push({ from: 'me', to: 'peer', amount: 500, settledAt: 1 })
  const before = JSON.stringify(disk.settlement_v1)
  const plan = settlementState.planImport(payload)
  assert.strictEqual(plan.ok, true)
  assert.strictEqual(JSON.stringify(disk.settlement_v1), before, '合并计划不能提前写盘')
  assert.strictEqual(plan.value.books['book-a'].months[ym].weights.me, 9)
  assert.deepStrictEqual(plan.value.books['book-a'].months[ym].categoryWeights, {
    餐饮: { me: 4, peer: 1 }, 旅行: { me: 0, peer: 2 }
  })
  assert.deepStrictEqual(plan.value.books['book-a'].templates.map((item) => item.id).sort(), [localTemplate.id, 'incoming'].sort())
  assert.strictEqual(plan.value.books['book-a'].months[ym].settled.length, 2)
  const invalid = settlementState.exportData()
  invalid.books['book-a'].months[ym].weights.me = -1
  assert.strictEqual(settlementState.planImport(invalid).ok, false)
  const invalidCategory = settlementState.exportData()
  invalidCategory.books['book-a'].months[ym].categoryWeights['餐饮'] = { me: 0, peer: 0 }
  assert.strictEqual(settlementState.planImport(invalidCategory).ok, false)
  const invalidTemplate = settlementState.exportData()
  invalidTemplate.books['book-a'].templates[0].weights.me = -1
  assert.strictEqual(settlementState.planImport(invalidTemplate).ok, false)
})

test('状态：旧版结算备份缺少新字段时 planImport 保持兼容', () => {
  const disk = {}
  global.wx = {
    getStorageSync: (key) => key in disk ? JSON.parse(JSON.stringify(disk[key])) : '',
    setStorageSync: (key, value) => { disk[key] = JSON.parse(JSON.stringify(value)) },
    showToast: () => {}
  }
  settlementState.saveWeights('book-a', ym, { me: 1, peer: 1 })
  settlementState.saveCategoryWeights('book-a', ym, '餐饮', { me: 2, peer: 1 })
  settlementState.saveTemplate('book-a', '保留', { me: 3, peer: 1 })
  const legacy = {
    version: 1,
    books: { 'book-a': { months: { [ym]: { weights: { me: 4, peer: 1 }, settled: [] } }, history: [] } }
  }
  const before = JSON.stringify(disk.settlement_v1)
  const plan = settlementState.planImport(legacy)
  assert.strictEqual(plan.ok, true)
  assert.strictEqual(JSON.stringify(disk.settlement_v1), before)
  assert.deepStrictEqual(plan.value.books['book-a'].months[ym].weights, { me: 4, peer: 1 })
  assert.deepStrictEqual(plan.value.books['book-a'].months[ym].categoryWeights, { 餐饮: { me: 2, peer: 1 } })
  assert.strictEqual(plan.value.books['book-a'].templates[0].name, '保留')
  assert.strictEqual(settlementState.importData(legacy).ok, true)
  assert.deepStrictEqual(settlementState.load('book-a', ym), { weights: { me: 4, peer: 1 }, categoryWeights: {}, settled: [] })
  assert.deepStrictEqual(settlementState.listTemplates('book-a'), [])
})

test('状态：功能备份 planImport 保留分类覆盖与命名模板', () => {
  const disk = {}
  global.wx = {
    getStorageSync: (key) => key in disk ? JSON.parse(JSON.stringify(disk[key])) : '',
    setStorageSync: (key, value) => { disk[key] = JSON.parse(JSON.stringify(value)) },
    showToast: () => {}
  }
  settlementState.saveCategoryWeights('book-a', ym, '餐饮', { me: 2, peer: 1 })
  settlementState.saveTemplate('book-a', '功能备份', { me: 3, peer: 1 })
  const payload = settlementState.exportData()
  payload.books['book-a'].months[ym].categoryWeights['餐饮'] = { me: 4, peer: 1 }
  payload.books['book-a'].templates[0].name = '恢复模板'
  const before = JSON.stringify(disk.settlement_v1)
  const plan = featureBackup.planImport({ settlement: payload })
  const change = plan.changes.find((item) => item.key === settlementState.KEY)
  assert.ok(change)
  assert.deepStrictEqual(change.value.books['book-a'].months[ym].categoryWeights, { 餐饮: { me: 4, peer: 1 } })
  assert.strictEqual(change.value.books['book-a'].templates[0].name, '恢复模板')
  assert.strictEqual(JSON.stringify(disk.settlement_v1), before, '功能备份计划不能提前写盘')
})

test('状态：本机写入失败返回可解释错误', () => {
  global.wx = {
    getStorageSync: () => '',
    setStorageSync: () => { throw new Error('quota') },
    showToast: () => {}
  }
  const result = settlementState.saveWeights('book-a', ym, { me: 1 })
  assert.strictEqual(result.ok, false)
  assert.ok(result.error.includes('本机保存失败'))
})

test('页面：默认本月、切月、未加入空态与双方结算口径', () => {
  const root = path.resolve(__dirname, '..')
  const disk = {
    txs_v1: [tx('now', 'expense', 80, 'me', ym, { category: '餐饮' }), tx('peer', 'expense', 40, 'peer', ym, { category: '旅行' })],
    shared_book_v1: { bookId: 'book', name: '测试账本', memberList: members, lastSync: 0 },
    prefs_v1: { viewScope: 'mine' }
  }
  let dark = false
  let unwatch = null
  let definition
  const calls = { nav: [], styles: [], toasts: [] }
  global.wx = {
    getStorageSync: (key) => key in disk ? JSON.parse(JSON.stringify(disk[key])) : '',
    setStorageSync: (key, value) => { disk[key] = JSON.parse(JSON.stringify(value)) },
    getAppBaseInfo: () => ({ theme: dark ? 'dark' : 'light' }),
    onThemeChange: (fn) => { unwatch = fn; return () => { unwatch = null } },
    offThemeChange: () => { unwatch = null },
    setTabBarStyle: (value) => calls.styles.push(value),
    navigateTo: (value) => calls.nav.push(value.url),
    showToast: (value) => { calls.toasts.push(value.title) }
  }
  global.Page = (value) => { definition = value }
  require(path.join(root, 'pages/settlement/settlement.js'))
  const page = Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)) })
  page.setData = function (patch, cb) { Object.assign(this.data, patch); if (cb) cb.call(this) }
  page.onLoad()
  const currentYm = format.ymOf(Date.now())
  assert.strictEqual(page.data.ym, currentYm)
  disk.txs_v1[0].ym = currentYm
  disk.txs_v1[1].ym = currentYm
  page.onShow()
  assert.strictEqual(page.data.totalText, '120.00', 'mine 偏好不能漏算对方支出')
  assert.strictEqual(page.data.members.length, 2)
  assert.strictEqual(page.data.transfers.length, 1, '80 元与 40 元垫付应产生一笔 20 元转账')
  assert.strictEqual(page.data.transfers[0].amountText, '20.00')
  assert.ok(page.data.preferenceText.includes('只看自己'))

  page.toggleWeightEditing()
  assert.strictEqual(page.data.weightEditing, true)
  page.onWeightInput({ currentTarget: { dataset: { key: 'me' } }, detail: { value: '1' } })
  page.onWeightInput({ currentTarget: { dataset: { key: 'peer' } }, detail: { value: '3' } })
  page.saveMemberWeights()
  assert.strictEqual(page.data.weightEditing, false)
  assert.strictEqual(page.data.weightModeText, '按权重分摊')
  assert.deepStrictEqual(page.data.weights, { me: 1, peer: 3 })
  assert.strictEqual(page.data.members[0].shareText, '30.00')
  assert.strictEqual(page.data.members[1].shareText, '90.00')
  assert.strictEqual(page.data.transfers.length, 1)
  assert.strictEqual(page.data.transfers[0].from, 'peer')
  assert.strictEqual(page.data.transfers[0].amountText, '50.00')
  assert.ok(disk.settlement_v1)

  page.toggleWeightEditing()
  page.onWeightInput({ currentTarget: { dataset: { key: 'me' } }, detail: { value: '0' } })
  page.onWeightInput({ currentTarget: { dataset: { key: 'peer' } }, detail: { value: '0' } })
  page.saveMemberWeights()
  assert.ok(calls.toasts.includes('至少一名成员的权重大于 0'))
  assert.deepStrictEqual(page.data.weights, { me: 1, peer: 3 }, '全零不能覆盖已有权重')
  page.onWeightInput({ currentTarget: { dataset: { key: 'peer' } }, detail: { value: '-2' } })
  assert.strictEqual(page.data.members[1].weightText, '0', '非法输入不进入编辑值')
  page.resetWeights()
  assert.strictEqual(page.data.weightModeText, '平均分摊')
  assert.deepStrictEqual(page.data.weights, {})
  assert.strictEqual(page.data.transfers[0].amountText, '20.00')

  page.toggleWeightEditing()
  page.onWeightInput({ currentTarget: { dataset: { key: 'me' } }, detail: { value: '1' } })
  page.onWeightInput({ currentTarget: { dataset: { key: 'peer' } }, detail: { value: '3' } })
  page.saveMemberWeights()
  page.onTemplateNameInput({ detail: { value: '常用模板' } })
  page.saveWeightTemplate()
  assert.strictEqual(page.data.templates.length, 1)
  assert.strictEqual(page.data.templates[0].name, '常用模板')
  const templateId = page.data.templates[0].id
  page.resetWeights()
  page.pickTemplate({ detail: { value: 0 } })
  page.applyWeightTemplate()
  assert.deepStrictEqual(page.data.weights, { me: 1, peer: 3 })
  page.deleteWeightTemplate({ currentTarget: { dataset: { id: templateId } } })
  assert.strictEqual(page.data.templates.length, 0)

  page.toggleCategoryEditing()
  const foodIndex = page.data.categoryOptions.findIndex((item) => item.name === '餐饮')
  page.pickCategory({ detail: { value: foodIndex } })
  page.onCategoryWeightInput({ currentTarget: { dataset: { key: 'me' } }, detail: { value: '0' } })
  page.onCategoryWeightInput({ currentTarget: { dataset: { key: 'peer' } }, detail: { value: '2' } })
  page.saveCategoryOverride()
  assert.deepStrictEqual(page.data.categoryWeights, { 餐饮: { me: 0, peer: 2 } })
  assert.strictEqual(page.data.categoryEditing, false)
  assert.ok(page.data.categories.some((item) => item.name === '餐饮' && item.covered))
  assert.strictEqual(page.data.members[0].shareText, '10.00', '餐饮 80 元由 peer 承担，旅行 40 元按 1:3 分摊')
  assert.strictEqual(page.data.members[1].shareText, '110.00')
  page.removeCategoryOverride({ currentTarget: { dataset: { category: '餐饮' } } })
  assert.deepStrictEqual(page.data.categoryWeights, {})
  assert.strictEqual(page.data.members[0].shareText, '30.00')

  page.toggleTransfer({ currentTarget: { dataset: { index: 0 } } })
  assert.strictEqual(page.data.transfers[0].settled, true)
  assert.strictEqual(page.data.transfers[0].actionText, '取消已结清')
  assert.strictEqual(page.data.settledCount, 1)
  assert.strictEqual(page.data.pendingCount, 0)
  assert.strictEqual(page.data.history[0].action, 'settle')
  page.toggleTransfer({ currentTarget: { dataset: { index: 0 } } })
  assert.strictEqual(page.data.transfers[0].settled, false)
  assert.strictEqual(page.data.history[0].action, 'unsettle')
  page.toggleTransfer({ currentTarget: { dataset: { index: 0 } } })
  assert.strictEqual(page.data.historyCount, 3)

  const previous = format.shiftMonth(currentYm, -1)
  page.prevMonth()
  assert.strictEqual(page.data.ym, previous)
  assert.strictEqual(page.data.hasData, false)
  assert.strictEqual(page.data.transfers.length, 0)
  assert.strictEqual(page.data.historyCount, 3, '历史按账本跨月保留')
  page.pickMonth({ detail: { value: currentYm } })
  assert.strictEqual(page.data.transfers[0].settled, true, '重新进入月份仍保留结清状态')
  page.nextMonth()
  assert.strictEqual(page.data.ym, currentYm, '不能切到未来月份')
  page.pickMonth({ detail: { value: 'bad' } })
  assert.strictEqual(page.data.ym, currentYm)

  dark = true
  unwatch({ theme: 'dark' })
  assert.strictEqual(page.data.dark, true)
  delete disk.shared_book_v1
  page.refresh()
  assert.strictEqual(page.data.joined, false)
  assert.strictEqual(page.data.historyCount, 0, '离开账本时清空页面历史')
  assert.ok(page.data.emptyText.includes('还没有加入'))
  page.goShare()
  assert.deepStrictEqual(calls.nav, ['/pages/share/share'])
  page.onUnload()
  assert.strictEqual(unwatch, null)

  const wxml = fs.readFileSync(path.join(root, 'pages/settlement/settlement.wxml'), 'utf8')
  const wxss = fs.readFileSync(path.join(root, 'pages/settlement/settlement.wxss'), 'utf8')
  assert.ok(wxml.includes('theme-{{themeKey}}') && wxml.includes("dark ? 'dark' : ''"))
  assert.ok(wxml.includes('bindinput="onWeightInput"') && wxml.includes('bindtap="saveMemberWeights"'))
  assert.ok(wxml.includes('bindtap="resetWeights"') && wxml.includes('bindtap="toggleTransfer"'))
  assert.ok(wxml.includes('saveWeightTemplate') && wxml.includes('applyWeightTemplate') && wxml.includes('deleteWeightTemplate'))
  assert.ok(wxml.includes('saveCategoryOverride') && wxml.includes('removeCategoryOverride') && wxml.includes('已覆盖'))
  assert.ok(wxml.includes('结算历史') && wxml.includes('仅保存在本机，不改变云端流水'))
  assert.ok(wxml.includes('safe-bottom') && wxss.includes('env(safe-area-inset-bottom)'))
  assert.ok(wxss.includes('.dark .card') && wxss.includes('.dark .weight-input-wrap'))
})

console.log('\n通过 ' + passed + ' 项，失败 0 项')
