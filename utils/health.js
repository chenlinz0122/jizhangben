/* 流水查重与数据体检：只读扫描，不修改传入的流水。
 * scan(txs, now, options)：now 可为时间戳 / Date / 日期字符串；
 * options.largeAmount 为大额线，默认 10000。也支持 scan(txs, { now, largeAmount })。
 * summarize(scan)：返回总数、问题数、受影响笔数、各类型计数和按类型分组的问题。
 */
var format = require('./format')

var DEFAULT_LARGE_AMOUNT = 10000
var TYPE_DEFS = [
  { key: 'duplicate', label: '疑似重复', severity: 'high', hint: '同成员、同账本、同日期、同金额、同商户、同类型' },
  { key: 'future', label: '未来日期', severity: 'medium', hint: '记账日期晚于今天' },
  { key: 'amount', label: '零或负金额', severity: 'high', hint: '金额不是有限正数' },
  { key: 'missingMerchant', label: '缺少商户', severity: 'medium', hint: '商户名为空或只有空白' },
  { key: 'uncategorized', label: '未分类', severity: 'low', hint: '分类为空或仍为“未分类”' },
  { key: 'ocrReview', label: 'OCR 待核对', severity: 'medium', hint: '截图识别置信度低，建议对照原图复核' },
  { key: 'large', label: '异常大额', severity: 'medium', hint: '金额绝对值达到当前大额线' }
]
var TYPE_ORDER = Object.create(null)
var TYPE_MAP = Object.create(null)
var SEVERITY_RANK = { low: 1, medium: 2, high: 3 }
TYPE_DEFS.forEach(function (def, index) {
  TYPE_ORDER[def.key] = index
  TYPE_MAP[def.key] = def
})

function emptyMap() { return Object.create(null) }

function clone(tx) { return Object.assign({}, tx) }

function cents(value) {
  var n = Number(value)
  if (!isFinite(n)) return 0
  return ((n < 0 ? -1 : 1) * Math.round(Math.abs(n) * 100 + 1e-8)) || 0
}

function validDay(value) {
  var day = String(value || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false
  var p = day.split('-')
  var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]))
  return d.getFullYear() === Number(p[0]) && d.getMonth() === Number(p[1]) - 1 && d.getDate() === Number(p[2])
}

function dayOf(tx) {
  if (validDay(tx.day)) return String(tx.day)
  var time = new Date(tx.time).getTime()
  return isFinite(time) ? format.dayOf(time) : ''
}

function nowTimestamp(now) {
  if (now instanceof Date) return now.getTime()
  if (typeof now === 'number') return now
  if (typeof now === 'string' && now.trim()) return new Date(now).getTime()
  return NaN
}

function ownerOf(tx, fallbackId) {
  if (tx.ownerKey) return ['owner', String(tx.ownerKey)]
  if (tx.byMe === false) return ['legacy', String(tx.shareId || tx.id || fallbackId)]
  return ['self']
}

function signatureOf(row) {
  return JSON.stringify([
    row.tx.byMe === false, ownerOf(row.tx, row.id), row.tx.shareBook || '',
    row.day, row.amountCents, String(row.tx.merchant || '').trim(), row.tx.type || ''
  ])
}

function prepare(txs) {
  var fallbackCounts = emptyMap()
  return txs.filter(function (tx) {
    return tx && typeof tx === 'object' && !Array.isArray(tx)
  }).map(function (tx) {
    var day = dayOf(tx)
    var rawAmount = tx.amount
    var amount = Number(rawAmount)
    var amountValid = rawAmount !== '' && rawAmount !== null && rawAmount !== undefined && isFinite(amount)
    var fallback = JSON.stringify([day, amountValid ? cents(amount) : 'invalid',
      String(tx.merchant || '').trim(), tx.type || '', tx.byMe === false,
      tx.ownerKey || '', tx.shareBook || '', tx.shareId || ''])
    fallbackCounts[fallback] = (fallbackCounts[fallback] || 0) + 1
    var id = String(tx.id || '')
    if (!id) id = 'row:' + fallback + ':' + fallbackCounts[fallback]
    var row = {
      tx: tx,
      id: id,
      day: day,
      amount: amount,
      amountValid: amountValid,
      amountCents: amountValid ? cents(amount) : 0
    }
    row.signature = signatureOf(row)
    return row
  })
}

function issue(key, type, severity, rows, title, description, suggestion) {
  var records = rows.slice().sort(function (a, b) {
    return a.id === b.id ? (a.signature < b.signature ? -1 : 1) : (a.id < b.id ? -1 : 1)
  }).map(function (row) { return clone(row.tx) })
  return {
    key: key,
    type: type,
    severity: severity,
    txIds: records.map(function (tx) { return String(tx.id || '') }).filter(Boolean),
    title: title,
    description: description,
    suggestion: suggestion,
    records: records
  }
}

function addSingle(issues, type, row, title, description, suggestion) {
  issues.push(issue(type + ':' + row.id, type, TYPE_MAP[type].severity, [row], title, description, suggestion))
}

function scan(txs, now, options) {
  /* 允许把配置放在第二个参数里，页面传入时间戳时仍使用第三个参数。 */
  if (now && typeof now === 'object' && !(now instanceof Date) &&
      (now.now !== undefined || now.largeAmount !== undefined || now.largeAmountThreshold !== undefined)) {
    options = now
    now = now.now
  }
  options = options || {}
  var requestedLimit = options.largeAmount !== undefined ? options.largeAmount : options.largeAmountThreshold
  var parsedLimit = Number(requestedLimit)
  var roundedLimit = Math.round(parsedLimit * 100) / 100
  var largeAmount = requestedLimit !== undefined && isFinite(parsedLimit) && parsedLimit > 0 && roundedLimit > 0
    ? roundedLimit : DEFAULT_LARGE_AMOUNT
  var timestamp = nowTimestamp(now)
  if (!isFinite(timestamp)) timestamp = Date.now()
  var today = format.dayOf(timestamp)
  var rows = prepare(Array.isArray(txs) ? txs : [])
  var issues = []

  rows.forEach(function (row) {
    var tx = row.tx
    var dayText = row.day || '日期未知'
    var merchant = String(tx.merchant || '').trim() || '未知商户'
    var typeText = tx.type === 'expense' ? '支出' : (tx.type === 'income' ? '收入' :
      (tx.type === 'refund' ? '退款' : (tx.type === 'transfer' ? '不计收支' : '未知类型')))

    if (row.day && row.day > today) {
      addSingle(issues, 'future', row, '未来日期',
        dayText + ' 的' + typeText + '晚于今天（' + today + '）。',
        '请核对记账日期；若是计划账，可保留，若是已发生交易请改成实际日期。')
    }

    if (!row.amountValid) {
      addSingle(issues, 'amount', row, '金额无效',
        merchant + '的金额为空或不是有效数字，' + dayText + '。',
        '请在流水明细中核对并补成有限正数。')
    } else if (row.amount === 0) {
      addSingle(issues, 'amount', row, '零金额',
        merchant + '在 ' + dayText + ' 的金额为 0.00。',
        '请核对是否漏填金额；无实际资金变动的记录建议删除。')
    } else if (row.amount < 0) {
      addSingle(issues, 'amount', row, '负金额',
        merchant + '在 ' + dayText + ' 的金额为 ¥' + format.signedMoney(row.amount) + '。',
        '常规支出和收入通常不填负数；请核对方向，退款请使用退款类型。')
    }

    if (!String(tx.merchant || '').trim()) {
      addSingle(issues, 'missingMerchant', row, '缺少商户',
        dayText + ' 的' + typeText + '（¥' + format.signedMoney(row.amount) + '）没有商户名。',
        '请在流水明细中补充商户，便于查重、搜索和自动分类。')
    }

    if (!String(tx.category || '').trim() || String(tx.category).trim() === '未分类') {
      addSingle(issues, 'uncategorized', row, '未分类',
        merchant + '在 ' + dayText + ' 的这笔' + typeText + '尚未分类。',
        '可在流水中筛选“未分类”，逐笔核对后选择正确分类。')
    }

    if (tx.confidence === 'low') {
      var reasons = Array.isArray(tx.reviewReasons) ? tx.reviewReasons.filter(function (reason) {
        return typeof reason === 'string' && reason.trim()
      }).map(function (reason) { return reason.trim() }) : []
      addSingle(issues, 'ocrReview', row, 'OCR 待核对',
        merchant + '在 ' + dayText + ' 的识别结果置信度较低' + (reasons.length ? '：' + reasons.join('；') : '。'),
        '请对照原始截图核对日期、金额、商户和收支方向；确认后再保留或修改。')
    }

    if (row.amountValid && Math.abs(row.amount) >= largeAmount) {
      addSingle(issues, 'large', row, '异常大额',
        merchant + '在 ' + dayText + ' 的金额为 ¥' + format.signedMoney(row.amount) +
        '，绝对值已达到大额线 ¥' + format.money(largeAmount) + '。',
        '大额不一定是错误，请核对金额、币种和交易方向后再决定是否修改。')
    }
  })

  /* 判重身份不含昵称和分类；缺少 ownerKey 的旧成员记录各自隔离，避免误删。 */
  var groups = emptyMap()
  rows.forEach(function (row) {
    if (!groups[row.signature]) groups[row.signature] = []
    groups[row.signature].push(row)
  })
  Object.keys(groups).forEach(function (signature) {
    var group = groups[signature]
    if (group.length < 2) return
    var first = group[0]
    var count = group.length
    issues.push(issue('duplicate:' + signature, 'duplicate', 'high', group, '疑似重复',
      first.day + ' 的' + (String(first.tx.merchant || '').trim() || '无商户') +
      '有 ' + count + ' 笔同成员、同账本、同金额、同类型的流水。',
      '请逐笔核对来源和时间后再删除；系统不会自动删除重复组中的任何记录。'))
  })

  issues.sort(function (a, b) {
    var order = TYPE_ORDER[a.type] - TYPE_ORDER[b.type]
    if (order) return order
    return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0)
  })

  return {
    total: rows.length,
    largeAmount: largeAmount,
    today: today,
    issues: issues
  }
}

function idsOf(entry) {
  var ids = []
  if (Array.isArray(entry.txIds)) ids = entry.txIds.map(function (id) { return String(id) })
  if (!ids.length && Array.isArray(entry.records)) {
    entry.records.forEach(function (tx) { if (tx && tx.id) ids.push(String(tx.id)) })
  }
  return ids
}

function summarize(scan) {
  var source = scan && Array.isArray(scan.issues) ? scan.issues : []
  var byType = {}
  var txCountByType = {}
  var bySeverity = { high: 0, medium: 0, low: 0 }
  var affected = emptyMap()
  TYPE_DEFS.forEach(function (def) {
    byType[def.key] = 0
    txCountByType[def.key] = 0
  })

  source.forEach(function (entry) {
    if (!entry || !TYPE_MAP[entry.type]) return
    byType[entry.type]++
    if (bySeverity[entry.severity]) bySeverity[entry.severity]++
    var unique = emptyMap()
    idsOf(entry).forEach(function (id) {
      unique[id] = true
      affected[id] = true
    })
    txCountByType[entry.type] += Object.keys(unique).length
  })

  var types = TYPE_DEFS.map(function (def) {
    return {
      type: def.key,
      label: def.label,
      title: def.label,
      hint: def.hint,
      severity: def.severity,
      count: byType[def.key],
      txCount: txCountByType[def.key]
    }
  })
  var groups = types.filter(function (type) { return type.count > 0 }).map(function (type) {
    var entries = source.filter(function (entry) { return entry && entry.type === type.type })
    var severity = 'low'
    entries.forEach(function (entry) {
      if (SEVERITY_RANK[entry.severity] > SEVERITY_RANK[severity]) severity = entry.severity
    })
    return {
      key: type.type,
      type: type.type,
      label: type.label,
      title: type.title,
      hint: type.hint,
      severity: severity,
      count: entries.length,
      txCount: type.txCount,
      issues: entries
    }
  })
  var issueCount = source.filter(function (entry) { return entry && TYPE_MAP[entry.type] }).length
  return {
    total: scan && typeof scan.total === 'number' ? scan.total : 0,
    issueCount: issueCount,
    affectedTxCount: Object.keys(affected).length,
    healthy: issueCount === 0,
    largeAmount: scan && scan.largeAmount !== undefined ? scan.largeAmount : DEFAULT_LARGE_AMOUNT,
    byType: byType,
    txCountByType: txCountByType,
    bySeverity: bySeverity,
    highCount: bySeverity.high,
    mediumCount: bySeverity.medium,
    lowCount: bySeverity.low,
    types: types,
    groups: groups,
    issues: source.slice()
  }
}

module.exports = {
  scan: scan,
  summarize: summarize,
  TYPE_DEFS: TYPE_DEFS,
  DEFAULT_LARGE_AMOUNT: DEFAULT_LARGE_AMOUNT
}
