const assert = require('assert')
const disk = {}
global.wx = {
  getStorageSync: (key) => key in disk ? disk[key] : '',
  setStorageSync: (key, value) => { disk[key] = value },
  removeStorageSync: (key) => { delete disk[key] },
  showToast() {}
}
const accounts = require('../utils/accounts')
const exchangeRates = require('../utils/exchange-rates')
const rateAlerts = require('../utils/rate-alerts')
const annualShare = require('../utils/annual-share')
const budgetHistory = require('../utils/budget-history')
const accountMap = require('../utils/account-map')
const recurring = require('../utils/recurring')
const budgetTemplates = require('../utils/budget-templates')
const saved = require('../utils/saved-filters')
const settlementState = require('../utils/settlement-state')
const store = require('../utils/store')
let passed = 0
function check(value, message) { assert.ok(value, message); passed++ }

const account = accounts.save({ name: '微信', type: 'wallet', openingBalance: 100, includeInNetWorth: true, currency: 'USD', rateToCny: 7.2 })
accountMap.save({ keyword: '微信', accountId: account.id, enabled: true })
rateAlerts.save(account.id, account, { targetRate: 8, direction: 'above', enabled: true })
budgetHistory.record('2026-11', 3000, { '餐饮': 1200 }, 1)
annualShare.savePreferences({ theme: 'forest', title: '我的年报', showHealth: false }, wx)
const item = recurring.save({ name: '房租', type: 'expense', category: '生活缴费', amount: 1200, merchant: '房东', interval: 'month', dayOfMonth: 1, startDate: '2026-01-01' })
const budgetTemplate = budgetTemplates.save({ id: 'bt-test', name: '测试预算', monthlyBudget: 3000, categoryBudgets: { '餐饮': 1200, '交通': 300 }, builtin: false, createdAt: 1 })
const view = saved.save('大额餐饮', { minAmount: 100, cats: ['餐饮'] })
disk.disabled_rules_v1 = { '停用店': '娱乐' }
disk.rules_v1 = { '停用店': '购物' }
settlementState.saveWeights('book-1', '2026-11', { me: 2, peer: 1 })
settlementState.toggleSettled('book-1', '2026-11', { from: 'peer', to: 'me', amount: 500 })
store.reload()
const backup = store.exportAll()
check(backup.features.accounts.length === 1 && backup.features.accounts[0].id === account.id, '账本备份包含账户')
check(backup.features.exchangeRates.exchangeRates[account.id].length === 1, '账本备份包含汇率历史')
check(backup.features.rateAlerts.rateAlerts[account.id].targetRate === 8, '账本备份包含汇率提醒')
check(backup.features.annualSharePreferences.theme === 'forest', '账本备份包含年报分享模板')
check(backup.features.budgetHistory.items['2026-11'].budget === 3000, '账本备份包含历史预算')
check(backup.features.accountMappings.rules.length === 1 && backup.features.accountMappings.rules[0].accountId === account.id, '账本备份包含支付方式映射')
check(backup.features.attachments && typeof backup.features.attachments === 'object', '账本备份包含票据元数据')
check(backup.features.recurring.length === 1 && backup.features.recurring[0].id === item.id, '账本备份包含周期账单')
check(backup.features.budgetTemplates.items.length === 1 && backup.features.budgetTemplates.items[0].id === budgetTemplate.id, '账本备份包含预算模板')
check(backup.features.savedFilters.length === 1 && backup.features.savedFilters[0].id === view.id, '账本备份包含筛选视图')
check(backup.features.disabledRules['停用店'] === '娱乐', '账本备份包含停用规则')
check(backup.features.settlement.books['book-1'].months['2026-11'].weights.me === 2, '账本备份包含结算权重')

for (const key of ['accounts_v1', 'exchange_rates_v1', 'rate_alerts_v1', 'annual_share_prefs_v1', 'account_mappings_v1', 'tx_attachments_v1', 'recurring_v1', 'budget_templates_v1', 'budget_history_v1', 'saved_filters_v1', 'disabled_rules_v1', 'rules_v1', 'settlement_v1']) delete disk[key]
store.reload()
const restored = store.importAll(backup)
check(restored.saved === true, '含新功能的备份可恢复')
check(accounts.list().length === 1 && recurring.list().length === 1 && saved.list().length === 1, '恢复账户、周期账单和筛选视图')
check(exchangeRates.list(account.id).length === 1 && exchangeRates.list(account.id)[0].rate === 7.2, '恢复汇率历史')
check(rateAlerts.get(account.id).targetRate === 8, '恢复汇率提醒')
check(annualShare.loadPreferences(wx).theme === 'forest', '恢复年报分享模板')
check(budgetHistory.get('2026-11').budget === 3000, '恢复历史预算')
check(budgetTemplates.get('bt-test').monthlyBudget === 3000, '恢复预算模板')
check(accountMap.list().length === 1 && accountMap.list()[0].accountId === account.id, '恢复支付方式映射')
check(settlementState.load('book-1', '2026-11').weights.me === 2 && settlementState.load('book-1', '2026-11').settled.length === 1, '恢复结算权重与已结清记录')
check(disk.disabled_rules_v1['停用店'] === '娱乐' && !(disk.rules_v1 && disk.rules_v1['停用店']), '停用规则优先，恢复后不与启用规则冲突')
assert.throws(() => store.importAll({ version: 1, txs: [], features: { accounts: [{ id: 'bad' }] } }), /账户备份格式不对/)
passed++
console.log('通过 ' + passed + ' 项，失败 0 项')
