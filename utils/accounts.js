/* 多账户与余额视图
 *
 * 账户写入 accounts_v1，汇率审计独立写入 exchange_rates_v1，不改动现有流水。流水关联口径：
 *   - 单账户收支：accountId
 *   - 账户间转账：fromAccountId / toAccountId（不改变净资产）
 *   - 原 account 字段仍是支付方式，不参与账户余额
 * 所有余额运算均使用整数「分」，只有存入账户和展示时才换算成元。
 */
var KEY = 'accounts_v1'
var KEY_TX = 'txs_v1'
var currency = require('./currency')
var exchangeRates = require('./exchange-rates')
var rateAlerts = require('./rate-alerts')
var TYPE_LABELS = { cash: '现金', bank: '银行卡', wallet: '电子钱包', credit: '信用卡' }
var _lastError = ''
var _idCounter = 0
var MAX_CENTS = 9007199254740991

function hasStorage() {
  return typeof wx !== 'undefined' && wx && typeof wx.getStorageSync === 'function'
}

function fail(message) {
  _lastError = message || '账户操作失败'
  return null
}

function toCents(value) {
  if (typeof value === 'string') {
    var text = value.trim()
    var m = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(text)
    if (!m) return null
    var sign = m[1] === '-' ? -1 : 1
    var fraction = m[3] || ''
    if (fraction.length === 1) fraction += '0'
    var cents = sign * (Number(m[2]) * 100 + Number(fraction || 0))
    return isFinite(cents) && Math.abs(cents) <= MAX_CENTS ? cents : null
  }
  var n = Number(value)
  if (!isFinite(n)) return null
  /* 抵消 1.005 * 100 这类二进制浮点误差；余额本身始终是整数分。 */
  var rounded = Math.round((n + (n < 0 ? -1e-9 : 1e-9)) * 100)
  return isFinite(rounded) && Math.abs(rounded) <= MAX_CENTS ? rounded : null
}

function normalizeAccount(input, base, strict) {
  input = input || {}
  base = base || {}
  var id = input.id === undefined ? base.id : input.id
  if (id !== undefined && id !== null) {
    if (typeof id !== 'string' && typeof id !== 'number') return { error: '账户 ID 无效' }
    id = String(id).trim()
    if (!id || id.length > 100) return { error: '账户 ID 无效' }
  } else {
    id = ''
  }

  var rawName = input.name === undefined ? base.name : input.name
  if (typeof rawName !== 'string') return { error: '请填写账户名称' }
  var name = rawName.trim()
  if (!name) return { error: '请填写账户名称' }
  if (name.length > 30) return { error: '账户名称不能超过 30 个字' }

  var type = input.type === undefined ? (base.type || 'cash') : input.type
  if (!Object.prototype.hasOwnProperty.call(TYPE_LABELS, type)) return { error: '账户类型无效' }

  var rawOpening = input.openingBalance === undefined
    ? (base.openingBalance === undefined ? 0 : base.openingBalance)
    : input.openingBalance
  var openingCents = toCents(rawOpening)
  if (openingCents === null) return { error: '期初余额格式不正确，最多保留两位小数' }
  if (openingCents === 0) openingCents = 0
  if (type !== 'credit' && openingCents < 0) return { error: '只有信用卡允许负数期初余额' }

  var code = currency.normalizeCode(input.currency === undefined ? base.currency : input.currency)
  if (input.currency !== undefined && code !== String(input.currency).trim().toUpperCase()) {
    return { error: '账户币种不支持，请选择 CNY、USD、EUR、GBP、JPY 或 HKD' }
  }
  var rawRate = input.rateToCny === undefined ? (base.rateToCny === undefined ? 1 : base.rateToCny) : input.rateToCny
  var rate = currency.normalizeRate(rawRate, code)
  if (rate === null) return { error: '汇率必须是大于 0 的有效数字' }

  var include = input.includeInNetWorth === undefined
    ? (base.includeInNetWorth === undefined ? true : base.includeInNetWorth)
    : input.includeInNetWorth
  if (typeof include !== 'boolean') return { error: '净资产口径设置无效' }

  var createdAt = input.createdAt === undefined ? base.createdAt : input.createdAt
  if (createdAt === undefined) createdAt = Date.now()
  createdAt = Number(createdAt)
  if (!isFinite(createdAt) || createdAt <= 0) return { error: '账户创建时间无效' }
  if (strict && (input.openingBalance === undefined || input.includeInNetWorth === undefined)) {
    return { error: '账户备份缺少期初余额或净资产设置' }
  }

  return {
    account: {
      id: id,
      name: name,
      type: type,
      openingBalance: openingCents / 100,
      currency: code,
      rateToCny: rate,
      includeInNetWorth: include,
      createdAt: createdAt
    }
  }
}

function newId(existing) {
  var id
  do {
    _idCounter++
    id = 'acc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8) + '_' + _idCounter.toString(36)
  } while (existing[id])
  return id
}

function writeAll(items) {
  var before
  var beforePresent = false
  try {
    if (!hasStorage()) throw new Error('storage unavailable')
    before = wx.getStorageSync(KEY)
    beforePresent = before !== '' && before !== undefined && before !== null
  } catch (e) {
    _lastError = '账户保存失败，请检查本机存储后重试'
    return false
  }
  try {
    wx.setStorageSync(KEY, items)
    var saved = wx.getStorageSync(KEY)
    if (JSON.stringify(saved) !== JSON.stringify(items)) throw new Error('storage verification failed')
    _lastError = ''
    return true
  } catch (e) {
    var restored = false
    try {
      if (beforePresent) wx.setStorageSync(KEY, before)
      else wx.removeStorageSync(KEY)
      var after = wx.getStorageSync(KEY)
      restored = beforePresent
        ? JSON.stringify(after) === JSON.stringify(before)
        : (after === '' || after === undefined || after === null)
    } catch (rollbackError) {}
    _lastError = restored
      ? '账户保存失败，本次修改已撤销'
      : '账户保存中断且回滚失败，请立即核对本地数据'
    return false
  }
}

function restoreRawAccount(raw, present) {
  try {
    if (present) wx.setStorageSync(KEY, raw)
    else wx.removeStorageSync(KEY)
    var after = wx.getStorageSync(KEY)
    var ok = present
      ? JSON.stringify(after) === JSON.stringify(raw)
      : (after === '' || after === undefined || after === null)
    if (!ok) throw new Error('rollback verification failed')
    return true
  } catch (e) {
    return false
  }
}

function list() {
  _lastError = ''
  if (!hasStorage()) {
    _lastError = '当前环境无法读取本机账户'
    return []
  }
  var raw
  try {
    raw = wx.getStorageSync(KEY)
  } catch (e) {
    _lastError = '账户读取失败，请稍后重试'
    return []
  }
  if (raw === '' || raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    _lastError = '账户数据格式损坏，请先备份核对后再处理'
    return []
  }
  var out = []
  var seen = Object.create(null)
  var invalid = false
  for (var i = 0; i < raw.length; i++) {
    var normalized = normalizeAccount(raw[i], null, false)
    if (!normalized.account || !normalized.account.id || seen[normalized.account.id]) {
      invalid = true
      continue
    }
    seen[normalized.account.id] = true
    out.push(normalized.account)
  }
  if (invalid) _lastError = '部分账户数据无效，已跳过；请核对后再保存或导入'
  return out
}

function get(id) {
  var target = String(id || '').trim()
  if (!target) return null
  var items = list()
  for (var i = 0; i < items.length; i++) {
    if (items[i].id === target) return items[i]
  }
  return null
}

function save(input) {
  input = input || {}
  var items = list()
  if (_lastError) return null
  var id = input.id === undefined || input.id === null ? '' : String(input.id).trim()
  var base = null
  for (var i = 0; i < items.length; i++) {
    if (items[i].id === id) { base = items[i]; break }
  }
  var normalized = normalizeAccount(input, base, false)
  if (!normalized.account) return fail(normalized.error)
  if (!normalized.account.id) normalized.account.id = newId(seenMap(items))

  /* 新增外币、或修改外币币种/汇率时留下审计记录；CNY 与无变化保存不记录。 */
  var shouldRecordRate = normalized.account.currency !== 'CNY' &&
    (!base || base.currency !== normalized.account.currency || base.rateToCny !== normalized.account.rateToCny)
  var previousRaw = ''
  var previousPresent = false
  if (shouldRecordRate) {
    try {
      previousRaw = wx.getStorageSync(KEY)
      previousPresent = previousRaw !== '' && previousRaw !== undefined && previousRaw !== null
    } catch (e) {
      return fail('账户保存失败，请检查本机存储后重试')
    }
  }

  var found = false
  for (var j = 0; j < items.length; j++) {
    if (items[j].id === normalized.account.id) {
      items[j] = normalized.account
      found = true
      break
    }
  }
  if (!found) items.push(normalized.account)
  if (!writeAll(items)) return null
  if (shouldRecordRate) {
    var recorded = null
    try {
      recorded = exchangeRates.record(
        normalized.account.id,
        normalized.account.currency,
        normalized.account.rateToCny,
        base && base.currency !== 'CNY' ? base.rateToCny : null
      )
    } catch (e) {}
    if (!recorded && exchangeRates.error()) {
      var restored = restoreRawAccount(previousRaw, previousPresent)
      return fail(restored
        ? '账户未保存：' + exchangeRates.error() + '，账户已恢复'
        : '账户与汇率历史保存中断且账户回滚失败，请立即核对本地数据')
    }
  }
  if (base && base.currency === normalized.account.currency && base.currency !== 'CNY' &&
      base.rateToCny !== normalized.account.rateToCny) {
    try { rateAlerts.evaluate(normalized.account, base.rateToCny) } catch (e) {}
  }
  return normalized.account
}

function seenMap(items) {
  var map = Object.create(null)
  for (var i = 0; i < items.length; i++) map[items[i].id] = true
  return map
}

function loadTxs() {
  if (!hasStorage()) throw new Error('当前环境无法读取流水')
  var raw = wx.getStorageSync(KEY_TX)
  if (raw === '' || raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error('流水数据格式损坏，暂时无法计算余额')
  return raw
}

function references(tx, id) {
  return !!tx && (tx.accountId === id || tx.fromAccountId === id || tx.toAccountId === id)
}

function relatedCount(id, txs) {
  var rows = txs === undefined ? loadTxs() : txs
  if (!Array.isArray(rows)) throw new Error('流水数据格式不正确')
  var count = 0
  for (var i = 0; i < rows.length; i++) {
    if (references(rows[i], id)) count++
  }
  return count
}

function remove(id, txs) {
  var target = String(id || '').trim()
  if (!target) return false
  var items = list()
  if (_lastError) return false
  var exists = false
  for (var i = 0; i < items.length; i++) {
    if (items[i].id === target) { exists = true; break }
  }
  if (!exists) return false
  var count
  try {
    count = relatedCount(target, txs)
  } catch (e) {
    _lastError = e.message || '流水读取失败，未删除账户'
    return false
  }
  /* 关联流水不删除、不改写：必须先由用户处理流水，避免产生孤立账目。 */
  if (count > 0) {
    _lastError = '该账户关联 ' + count + ' 笔流水，请先处理关联流水后再删除'
    return false
  }
  var rateSnapshots = []
  try {
    rateSnapshots = [{ id: target, snapshot: exchangeRates.capture(target) }]
  } catch (e) {
    _lastError = '汇率历史读取失败，未删除账户：' + e.message
    return false
  }
  var next = items.filter(function (item) { return item.id !== target })
  var previousRaw = ''
  var previousPresent = false
  try {
    previousRaw = wx.getStorageSync(KEY)
    previousPresent = previousRaw !== '' && previousRaw !== undefined && previousRaw !== null
  } catch (e) {
    _lastError = '账户保存失败，请检查本机存储后重试'
    return false
  }
  if (!writeAll(next)) return false
  if (!removeRateHistory(rateSnapshots)) {
    var historyError = _lastError
    var rateRestored = restoreRateHistory(rateSnapshots)
    var accountRestored = restoreRawAccount(previousRaw, previousPresent)
    _lastError = rateRestored && accountRestored
      ? '账户未删除：' + historyError + '，账户及汇率历史已恢复'
      : '账户删除与汇率历史清理中断且回滚失败，请立即核对本地数据'
    return false
  }
  return reconcileMappings(next, function () { return writeAll(items) }, rateSnapshots)
}

function captureRateSnapshots(ids) {
  return ids.map(function (id) {
    return { id: id, snapshot: exchangeRates.capture(id) }
  })
}

function removeRateHistory(snapshots) {
  for (var i = 0; i < snapshots.length; i++) {
    var entry = snapshots[i]
    if (!exchangeRates.removeAccount(entry.id) && exchangeRates.error()) {
      _lastError = exchangeRates.error()
      return false
    }
  }
  return true
}

function restoreRateHistory(snapshots) {
  var restored = true
  for (var i = 0; i < snapshots.length; i++) {
    var entry = snapshots[i]
    if (!exchangeRates.restore(entry.id, entry.snapshot)) restored = false
  }
  return restored
}

/* 账户、映射和汇率历史分属三个 key：任一清理失败都恢复已修改的数据。
 * 不使用 require 顶层依赖，避免账户模块与映射模块形成循环。 */
function reconcileMappings(nextAccounts, restoreAccounts, rateSnapshots) {
  try {
    require('./account-map').prune(nextAccounts)
    return true
  } catch (e) {
    var mappingError = e.message || '映射规则清理失败'
    var ratesRestored = !rateSnapshots || !rateSnapshots.length || restoreRateHistory(rateSnapshots)
    var restored = false
    try { restored = restoreAccounts() } catch (rollbackError) {}
    _lastError = restored && ratesRestored
      ? '账户未删除：' + mappingError + '，账户及汇率历史已恢复'
      : '账户、映射与汇率历史清理中断且回滚失败，请立即核对本地数据'
    return false
  }
}

function seedDefaults() {
  var items = list()
  if (_lastError) return null
  if (items.length) return items
  var now = Date.now()
  var defaults = [
    { name: '现金', type: 'cash' },
    { name: '微信', type: 'wallet' },
    { name: '支付宝', type: 'wallet' },
    { name: '银行卡', type: 'bank' }
  ]
  var seen = Object.create(null)
  var created = defaults.map(function (item) {
    var id = newId(seen)
    seen[id] = true
    return {
      id: id,
      name: item.name,
      type: item.type,
      openingBalance: 0,
      currency: 'CNY',
      rateToCny: 1,
      includeInNetWorth: true,
      createdAt: now
    }
  })
  return writeAll(created) ? created : null
}

function txRate(tx, account) {
  var code = currency.normalizeCode(tx && tx.currency)
  return currency.normalizeRate(tx && tx.rateToCny, code) || currency.normalizeRate(account && account.rateToCny, account && account.currency) || 1
}

function accountMap(items) {
  var map = Object.create(null)
  items.forEach(function (item) { map[item.id] = item })
  return map
}

function toAccountNative(tx, account) {
  var rate = currency.normalizeRate(tx && tx.rateToCny, tx && tx.currency) || 1
  var targetRate = currency.normalizeRate(tx && tx.toRateToCny, tx && tx.toCurrency) || rate
  var target = currency.normalizeRate(account && account.rateToCny, account && account.currency) || 1
  var hasTarget = tx && tx.toNativeAmount !== undefined && tx.toNativeAmount !== null && tx.toNativeAmount !== ''
  if (hasTarget) {
    var native = currency.txNative({
      nativeAmount: tx.toNativeAmount,
      currency: tx.toCurrency,
      rateToCny: tx.toRateToCny
    }, account)
    if (currency.normalizeCode(tx.toCurrency) === account.currency) return native
    return currency.convert(native, targetRate, target) || 0
  }
  var source = currency.txNative(tx, null)
  return currency.convert(source, rate, target) || 0
}

/* 返回值是各账户的「原币分」，不以账户当前汇率改写历史流水快照。 */
function balances(txs) {
  var items = list()
  var rows = txs === undefined ? loadTxs() : txs
  if (!Array.isArray(rows)) throw new Error('流水数据格式不正确')
  var byId = accountMap(items)
  var result = Object.create(null)
  for (var i = 0; i < items.length; i++) result[items[i].id] = toCents(items[i].openingBalance) || 0

  for (var j = 0; j < rows.length; j++) {
    var tx = rows[j] || {}
    var cny = toCents(tx.amount)
    if (cny === null || cny <= 0) continue
    if (tx.type === 'transfer') {
      var from = String(tx.fromAccountId || '')
      var to = String(tx.toAccountId || '')
      if (!from || !to || from === to) continue
      var fromAccount = byId[from]
      var toAccount = byId[to]
      if (fromAccount) {
        var native = currency.txNative(tx, fromAccount)
        var rate = txRate(tx, fromAccount)
        var accountRate = currency.normalizeRate(fromAccount.rateToCny, fromAccount.currency) || 1
        var hasNative = tx.nativeAmount !== undefined && tx.nativeAmount !== null && tx.nativeAmount !== ''
        var debit = hasNative && currency.normalizeCode(tx.currency) === fromAccount.currency
          ? native
          : (currency.convert(native, rate, accountRate) || 0)
        result[from] -= debit
      }
      if (toAccount) result[to] += toAccountNative(tx, toAccount)
      continue
    }
    var id = String(tx.accountId || '')
    var account = byId[id]
    if (!account) continue
    var nativeAmount = currency.txNative(tx, account)
    var nativeRate = txRate(tx, account)
    var targetRate = currency.normalizeRate(account.rateToCny, account.currency) || 1
    var hasNative = tx.nativeAmount !== undefined && tx.nativeAmount !== null && tx.nativeAmount !== ''
    var delta = hasNative && currency.normalizeCode(tx.currency) === account.currency
      ? nativeAmount
      : (currency.convert(nativeAmount, nativeRate, targetRate) || 0)
    if (tx.type === 'income' || tx.type === 'refund') result[id] += delta
    else if (tx.type === 'expense') result[id] -= delta
  }
  return result
}

function netWorth(txs) {
  var items = list()
  var values = balances(txs)
  var cnyCents = 0
  for (var i = 0; i < items.length; i++) {
    if (!items[i].includeInNetWorth) continue
    var rate = currency.normalizeRate(items[i].rateToCny, items[i].currency) || 1
    cnyCents += currency.convert(values[items[i].id] || 0, rate, 1) || 0
  }
  return cnyCents
}

function exportData() {
  var items = list()
  if (_lastError) throw new Error(_lastError)
  return {
    app: '通用记账Book',
    version: 1,
    storageKey: KEY,
    exportedAt: Date.now(),
    accounts: items
  }
}

function importData(payload) {
  _lastError = ''
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload) } catch (e) { throw new Error('账户备份不是有效 JSON') }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.accounts)) {
    throw new Error('账户备份格式不对')
  }
  if (payload.version !== undefined && payload.version !== 1) throw new Error('账户备份版本不支持')
  var currentItems = list()
  if (_lastError) throw new Error(_lastError)
  var seen = Object.create(null)
  var clean = []
  for (var i = 0; i < payload.accounts.length; i++) {
    var normalized = normalizeAccount(payload.accounts[i], null, true)
    if (!normalized.account) throw new Error('账户备份格式不对：' + normalized.error)
    if (seen[normalized.account.id]) throw new Error('账户备份包含重复 ID')
    seen[normalized.account.id] = true
    clean.push(normalized.account)
  }
  var previous = ''
  var previousPresent = false
  try {
    previous = wx.getStorageSync(KEY)
    previousPresent = previous !== '' && previous !== undefined && previous !== null
  } catch (e) {}
  var removedIds = currentItems.filter(function (item) { return !seenClean(clean, item.id) }).map(function (item) { return item.id })
  var rateSnapshots = []
  try { rateSnapshots = captureRateSnapshots(removedIds) } catch (e) { throw new Error(e.message) }
  if (!writeAll(clean)) throw new Error(_lastError || '账户导入失败')
  if (!removeRateHistory(rateSnapshots)) {
    var historyError = _lastError
    var ratesRestored = restoreRateHistory(rateSnapshots)
    var accountsRestored = restoreRawAccount(previous, previousPresent)
    throw new Error(ratesRestored && accountsRestored
      ? '账户未导入：' + historyError + '，账户及汇率历史已恢复'
      : '账户导入与汇率历史清理中断且回滚失败，请立即核对本地数据')
  }
  var restored = reconcileMappings(clean, function () {
    if (previousPresent) return writeAll(JSON.parse(JSON.stringify(previous)))
    wx.removeStorageSync(KEY)
    _lastError = ''
    return true
  }, rateSnapshots)
  if (!restored) throw new Error(_lastError || '账户导入失败')
  return clean
}

function seenClean(items, id) {
  for (var i = 0; i < items.length; i++) if (items[i].id === id) return true
  return false
}

module.exports = {
  KEY: KEY,
  STORAGE_KEY: KEY,
  TYPE_LABELS: TYPE_LABELS,
  normalizeAccount: normalizeAccount,
  list: list,
  get: get,
  save: save,
  remove: remove,
  seedDefaults: seedDefaults,
  balances: balances,
  netWorth: netWorth,
  relatedCount: relatedCount,
  exportData: exportData,
  importData: importData,
  error: function () { return _lastError },
  reload: function () { _lastError = '' }
}
