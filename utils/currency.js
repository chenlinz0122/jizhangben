/* 多币种工具：所有换算和展示的金额参数均为整数「分」。
 * rateToCny 表示 1 外币 = 多少人民币；流水保存换算时的快照。
 */
var MAX_CENTS = 9007199254740991
var CURRENCIES = {
  CNY: { code: 'CNY', symbol: '¥', name: '人民币' },
  USD: { code: 'USD', symbol: '$', name: '美元' },
  EUR: { code: 'EUR', symbol: '€', name: '欧元' },
  GBP: { code: 'GBP', symbol: '£', name: '英镑' },
  JPY: { code: 'JPY', symbol: '¥', name: '日元' },
  HKD: { code: 'HKD', symbol: 'HK$', name: '港币' }
}
var CODES = ['CNY', 'USD', 'EUR', 'GBP', 'JPY', 'HKD']

function normalizeStrictCode(value) {
  var code = String(value === undefined || value === null ? '' : value).trim().toUpperCase()
  return Object.prototype.hasOwnProperty.call(CURRENCIES, code) ? code : ''
}

function normalizeCode(value) {
  return normalizeStrictCode(value) || 'CNY'
}

function normalizeRate(value, code) {
  code = code === undefined ? '' : normalizeCode(value && value.code ? value.code : code)
  if (code === 'CNY') return 1
  if (typeof value === 'string') {
    value = value.trim()
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return null
  }
  if (typeof value !== 'string' && typeof value !== 'number') return null
  if (value === '' || value === undefined || value === null) return null
  var rate = Number(value)
  if (!isFinite(rate) || rate <= 0 || rate > 100000000) return null
  return rate
}

function cents(value) {
  var n = Number(value)
  if (!isFinite(n)) return null
  var rounded = Math.round(n + (n < 0 ? -1e-9 : 1e-9))
  return Math.abs(rounded) <= MAX_CENTS ? rounded : null
}

/* 输入输出均为分；按四舍五入保留最小货币单位。 */
function convert(amount, fromRate, toRate) {
  if (!Number.isInteger(Number(amount))) return null
  var value = cents(amount)
  var from = normalizeRate(fromRate)
  var to = normalizeRate(toRate)
  if (value === null || from === null || to === null) return null
  var result = Math.round(value * from / to)
  return isFinite(result) && Math.abs(result) <= MAX_CENTS ? result : null
}

function accountRate(account) {
  return normalizeRate(account && account.rateToCny, account && account.currency)
}

/* 返回流水的原币分；旧流水没有原币字段时，amount 仍解释为人民币分。 */
function txNative(tx, account) {
  if (!tx) return 0
  var hasNative = tx.nativeAmount !== undefined && tx.nativeAmount !== null && tx.nativeAmount !== ''
  var code = hasNative ? normalizeCode(tx.currency) : 'CNY'
  var rate = hasNative ? normalizeRate(tx.rateToCny, code) : 1
  if (rate === null) rate = accountRate(account) || 1
  var value
  if (hasNative) {
    var text = String(tx.nativeAmount).trim()
    var match = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(text)
    value = match
      ? Number(match[1] + match[2]) * 100 + (match[3] ? Number(match[3]) / Math.pow(10, match[3].length) * 100 * (match[1] === '-' ? -1 : 1) : 0)
      : cents(Number(tx.nativeAmount) * 100)
    value = cents(value)
  } else {
    value = cents(Number(tx.amount) * 100)
  }
  return value === null ? 0 : value
}

function formatNative(value, code) {
  if (value === null || value === undefined || value === '') return '--'
  var amount = cents(value)
  if (amount === null) return '--'
  code = normalizeCode(code)
  var meta = CURRENCIES[code]
  var sign = amount < 0 ? '-' : ''
  var text = (Math.abs(amount) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return sign + meta.symbol + text + (code === 'CNY' ? '' : ' ' + code)
}

function formatRate(rate, code) {
  code = normalizeCode(code)
  return code === 'CNY' ? '1（人民币固定）' : '1 ' + code + ' = ' + (normalizeRate(rate, code) || '--') + ' CNY'
}

module.exports = {
  CURRENCIES: CURRENCIES,
  CODES: CODES,
  normalizeStrictCode: normalizeStrictCode,
  normalizeCode: normalizeCode,
  normalizeRate: normalizeRate,
  convert: convert,
  txNative: txNative,
  formatNative: formatNative,
  formatRate: formatRate
}
