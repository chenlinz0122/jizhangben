/* 新功能数据随账本备份一起导出/恢复；只生成变更计划，真正写入由 store.saveChanges 统一执行。 */
var accounts = require('./accounts')
var exchangeRates = require('./exchange-rates')
var rateAlerts = require('./rate-alerts')
var annualShare = require('./annual-share')
var accountMap = require('./account-map')
var attachments = require('./attachments')
var recurring = require('./recurring')
var budgetTemplates = require('./budget-templates')
var budgetHistory = require('./budget-history')
var savedFilters = require('./saved-filters')
var settlementState = require('./settlement-state')
var category = require('./category')

var KEYS = {
  accounts: 'accounts_v1',
  exchangeRates: 'exchange_rates_v1',
  rateAlerts: 'rate_alerts_v1',
  annualSharePreferences: 'annual_share_prefs_v1',
  accountMappings: 'account_mappings_v1',
  attachments: 'tx_attachments_v1',
  recurring: 'recurring_v1',
  budgetTemplates: 'budget_templates_v1',
  budgetHistory: 'budget_history_v1',
  savedFilters: 'saved_filters_v1',
  disabledRules: 'disabled_rules_v1',
  settlement: 'settlement_v1'
}

function read(key) {
  return wx.getStorageSync(key)
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + '格式不对')
  return value
}

function same(a, b) { return JSON.stringify(a) === JSON.stringify(b) }

function exportAll() {
  var list = accounts.list()
  if (accounts.error()) throw new Error(accounts.error())
  var disabled = read(KEYS.disabledRules)
  return {
    accounts: list,
    exchangeRates: exchangeRates.exportData(),
    rateAlerts: rateAlerts.exportData(),
    annualSharePreferences: annualShare.loadPreferences(wx),
    accountMappings: accountMap.exportData(),
    attachments: attachments.exportData(),
    recurring: recurring.list(),
    budgetTemplates: budgetTemplates.exportData(),
    budgetHistory: budgetHistory.exportData(),
    savedFilters: savedFilters.list(),
    disabledRules: !disabled || typeof disabled !== 'object' || Array.isArray(disabled) ? {} : disabled,
    settlement: settlementState.exportData()
  }
}

function mergeById(current, incoming, normalize, label) {
  var map = Object.create(null)
  var order = []
  current.forEach(function (item) { map[item.id] = item; order.push(item.id) })
  incoming.forEach(function (raw) {
    var item = normalize(raw)
    if (!item || !item.id) throw new Error(label + '备份格式不对')
    if (!map[item.id]) order.push(item.id)
    map[item.id] = item
  })
  return order.map(function (id) { return map[id] })
}

function planImport(features) {
  if (features === undefined) return { changes: [], disabled: Object.create(null) }
  object(features, '功能备份')
  var changes = []
  var plannedAccounts = null
  function push(key, value) {
    if (!same(read(key), value)) changes.push({ key: key, value: value })
  }

  if (features.accounts !== undefined) {
    if (!Array.isArray(features.accounts)) throw new Error('账户备份格式不对')
    var currentAccounts = accounts.list()
    if (accounts.error()) throw new Error(accounts.error())
    var cleanAccounts = features.accounts.map(function (raw) {
      var normalized = accounts.normalizeAccount(raw, null, true)
      if (!normalized.account) throw new Error('账户备份格式不对：' + normalized.error)
      return normalized.account
    })
    plannedAccounts = mergeById(currentAccounts, cleanAccounts, function (item) { return item }, '账户')
    push(KEYS.accounts, plannedAccounts)
  }

  if (features.exchangeRates !== undefined) {
    var ratePlan = exchangeRates.planImport(features.exchangeRates, { accounts: plannedAccounts || accounts.list() })
    if (!ratePlan.ok) throw new Error('汇率历史备份格式不对')
    push(KEYS.exchangeRates, ratePlan.value)
  }

  if (features.rateAlerts !== undefined) {
    var alertPlan = rateAlerts.planImport(features.rateAlerts, { accounts: plannedAccounts || accounts.list() })
    if (!alertPlan.ok) throw new Error('汇率提醒备份格式不对')
    push(KEYS.rateAlerts, alertPlan.value)
  }

  if (features.annualSharePreferences !== undefined) {
    var sharePrefs = annualShare.loadPreferences({
      getStorageSync: function () { return features.annualSharePreferences }
    })
    push(KEYS.annualSharePreferences, sharePrefs)
  }

  if (features.accountMappings !== undefined) {
    var mappingPlan = accountMap.planImport(features.accountMappings, { accounts: plannedAccounts || accounts.list() })
    if (!mappingPlan.ok) throw new Error('支付映射备份格式不对')
    push(KEYS.accountMappings, mappingPlan.value)
  }

  if (features.attachments !== undefined) {
    var attachmentPlan = attachments.planImport(features.attachments)
    if (!attachmentPlan.ok) throw new Error('票据备份格式不对：' + (attachmentPlan.error || '未知错误'))
    attachmentPlan.changes.forEach(function (change) { changes.push(change) })
  }

  if (features.recurring !== undefined) {
    if (!Array.isArray(features.recurring)) throw new Error('周期账单备份格式不对')
    var cleanRecurring = features.recurring.map(function (raw) {
      var item = recurring.normalize(raw)
      if (!item) throw new Error('周期账单备份格式不对')
      return item
    })
    push(KEYS.recurring, mergeById(recurring.list(), cleanRecurring, function (item) { return item }, '周期账单'))
  }

  if (features.budgetTemplates !== undefined) {
    var templatePlan = budgetTemplates.planImport(features.budgetTemplates)
    if (!templatePlan.ok) throw new Error('预算模板备份格式不对')
    push(KEYS.budgetTemplates, templatePlan.value)
  }

  if (features.budgetHistory !== undefined) {
    var historyPlan = budgetHistory.planImport(features.budgetHistory)
    if (!historyPlan.ok) throw new Error('预算历史备份格式不对')
    push(KEYS.budgetHistory, historyPlan.value)
  }

  if (features.savedFilters !== undefined) {
    if (!Array.isArray(features.savedFilters) || features.savedFilters.length > 30) throw new Error('筛选视图备份格式不对')
    var currentViews = savedFilters.list()
    var cleanViews = features.savedFilters.map(function (raw) {
      if (!raw || typeof raw.id !== 'string' || !raw.id || typeof raw.name !== 'string' || !raw.name.trim() ||
          !raw.filters || typeof raw.filters !== 'object' || Array.isArray(raw.filters)) {
        throw new Error('筛选视图备份格式不对')
      }
      return { id: raw.id, name: raw.name.trim().slice(0, 20), filters: raw.filters, createdAt: Number(raw.createdAt) || Date.now() }
    })
    push(KEYS.savedFilters, mergeById(currentViews, cleanViews, function (item) { return item }, '筛选视图'))
  }

  var disabled = Object.create(null)
  if (features.disabledRules !== undefined) {
    var incomingDisabled = object(features.disabledRules, '停用规则备份')
    var validCats = []
    ;['expense', 'income', 'transfer'].forEach(function (type) {
      category.CATS[type].forEach(function (name) { if (validCats.indexOf(name) < 0) validCats.push(name) })
    })
    var currentDisabled = read(KEYS.disabledRules)
    if (currentDisabled && typeof currentDisabled === 'object' && !Array.isArray(currentDisabled)) {
      Object.keys(currentDisabled).forEach(function (key) { disabled[key] = currentDisabled[key] })
    }
    Object.keys(incomingDisabled).forEach(function (key) {
      if (!key || typeof incomingDisabled[key] !== 'string' || validCats.indexOf(incomingDisabled[key]) < 0) {
        throw new Error('停用规则备份格式不对')
      }
      disabled[key] = incomingDisabled[key]
    })
    push(KEYS.disabledRules, Object.keys(disabled).length ? disabled : null)
  }

  if (features.settlement !== undefined) {
    var settlementPlan = settlementState.planImport(features.settlement)
    if (!settlementPlan.ok) throw new Error('结算状态备份格式不对：' + (settlementPlan.error || '未知错误'))
    push(KEYS.settlement, settlementPlan.value)
  }

  return { changes: changes, disabled: disabled }
}

module.exports = { KEYS: KEYS, exportAll: exportAll, planImport: planImport }
