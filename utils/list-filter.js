function amount(value) {
  if (value === '' || value === null || value === undefined) return null
  var n = Number(value)
  return isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null
}

function date(value) {
  var s = String(value || '')
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''
}

function normalize(input) {
  var f = input || {}
  return {
    minAmount: amount(f.minAmount),
    maxAmount: amount(f.maxAmount),
    cats: Array.isArray(f.cats) ? f.cats.filter(function (c) { return typeof c === 'string' && c }).slice(0, 50) : [],
    accountId: String(f.accountId || ''),
    dateFrom: date(f.dateFrom),
    dateTo: date(f.dateTo),
    excludeTransfer: !!f.excludeTransfer
  }
}

function hasAdvanced(filter) {
  var f = normalize(filter)
  return f.minAmount !== null || f.maxAmount !== null || f.cats.length > 0 || !!f.accountId ||
    !!f.dateFrom || !!f.dateTo || f.excludeTransfer
}

function matches(tx, input) {
  var f = normalize(input)
  if (f.minAmount !== null && Math.abs(Number(tx.amount) || 0) < f.minAmount) return false
  if (f.maxAmount !== null && Math.abs(Number(tx.amount) || 0) > f.maxAmount) return false
  if (f.cats.length && f.cats.indexOf(tx.category) < 0) return false
  if (f.accountId) {
    if (f.accountId === '__none__') {
      if (tx.accountId || tx.fromAccountId || tx.toAccountId) return false
    } else if (tx.accountId !== f.accountId && tx.fromAccountId !== f.accountId && tx.toAccountId !== f.accountId) return false
  }
  if (f.dateFrom && String(tx.day || '') < f.dateFrom) return false
  if (f.dateTo && String(tx.day || '') > f.dateTo) return false
  if (f.excludeTransfer && tx.type === 'transfer') return false
  return true
}

function labels(input) {
  var f = normalize(input)
  var out = []
  if (f.minAmount !== null || f.maxAmount !== null) {
    out.push('金额 ' + (f.minAmount === null ? '0' : f.minAmount) + '–' + (f.maxAmount === null ? '∞' : f.maxAmount))
  }
  if (f.cats.length) out.push(f.cats.length > 2 ? f.cats.length + ' 个分类' : f.cats.join('、'))
  if (f.accountId) out.push(f.accountId === '__none__' ? '未指定账户' : '指定账户')
  if (f.dateFrom || f.dateTo) out.push((f.dateFrom || '最早') + ' 至 ' + (f.dateTo || '今天'))
  if (f.excludeTransfer) out.push('排除转账')
  return out
}

module.exports = { normalize: normalize, hasAdvanced: hasAdvanced, matches: matches, labels: labels }
