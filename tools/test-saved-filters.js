const assert = require('assert')
const filter = require('../utils/list-filter')
const saved = require('../utils/saved-filters')
const disk = {}
global.wx = {
  getStorageSync: (key) => key in disk ? disk[key] : '',
  setStorageSync: (key, value) => { disk[key] = value }
}
let passed = 0
function check(value, message) { assert.ok(value, message); passed++ }
const base = { id: '1', day: '2026-11-20', amount: 35.5, category: '餐饮', type: 'expense', accountId: 'wechat' }
check(filter.matches(base, {}), '空筛选放行')
check(filter.matches(base, { minAmount: '35.50', maxAmount: 36, cats: ['餐饮'], accountId: 'wechat', dateFrom: '2026-11-01', dateTo: '2026-11-30' }), '组合筛选命中')
check(!filter.matches(base, { minAmount: 36 }), '金额下限排除')
check(!filter.matches(base, { maxAmount: 35 }), '金额上限排除')
check(!filter.matches(base, { cats: ['交通'] }), '多分类筛选排除')
check(!filter.matches(base, { accountId: '__none__' }), '未指定账户筛选排除已归属记录')
check(filter.matches(Object.assign({}, base, { accountId: '' }), { accountId: '__none__' }), '未指定账户筛选命中空账户')
check(!filter.matches(base, { dateFrom: '2026-11-21' }), '开始日期排除')
check(!filter.matches(base, { dateTo: '2026-11-19' }), '结束日期排除')
check(!filter.matches(Object.assign({}, base, { type: 'transfer' }), { excludeTransfer: true }), '排除转账生效')
check(filter.matches(Object.assign({}, base, { type: 'transfer', fromAccountId: 'bank', toAccountId: 'wechat' }), { accountId: 'bank' }), '转账可按转出账户筛选')
check(filter.hasAdvanced({ cats: ['餐饮'] }) && !filter.hasAdvanced({ minAmount: '' }), '高级筛选状态判断正确')
check(filter.normalize({ minAmount: 'bad' }).minAmount === null, '非法金额被忽略')
check(filter.labels({ minAmount: 10, maxAmount: 100, cats: ['餐饮', '交通'] }).length === 2, '筛选摘要生成')
const first = saved.save('大额餐饮', { minAmount: 100, cats: ['餐饮'] })
check(first && saved.list()[0].name === '大额餐饮', '保存筛选视图')
const second = saved.save('本月交通', { cats: ['交通'] })
check(saved.list().length === 2, '筛选视图按时间倒序')
check(saved.remove(first.id) && saved.list().length === 1 && saved.list()[0].id === second.id, '删除筛选视图')
check(saved.save('', {}) === null, '拒绝空名称')
console.log('通过 ' + passed + ' 项，失败 0 项')
