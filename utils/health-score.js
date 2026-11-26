/* 月度财务健康评分：纯函数，所有金额先在内部换算为整数分。
 * calculate(txs, options)
 *   options.ym：YYYY-MM；不传则统计传入的全部流水。
 *   options.budget：月度预算，单位为元（与 store.budget() 一致）。
 *   options.healthScan：可复用 health.scan() 的结果；传入后不会重复扫描。
 *   options.accountNetWorthCents：当前账户净资产快照，单位为分；不参与评分。
 *   options.now：体检参考时间；不传时使用确定性的月末/最后流水日期。
 *   options.scopeText：报告中的账本范围说明。
 * 返回 score、breakdown、metrics、suggestions，并附带 ym、level、reportText。
 */
var health = require('./health')
var format = require('./format')

var MAX_CENTS = 9007199254740991
var WEIGHTS = { savings: 24, budget: 20, concentration: 20, categorization: 16, health: 20 }

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function validYm(value) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ''))
}

function monthOf(tx) {
  var ym = String(tx && tx.ym || '')
  if (validYm(ym)) return ym
  var day = String(tx && tx.day || '')
  if (validYm(day.slice(0, 7))) return day.slice(0, 7)
  if (tx && tx.time !== undefined && tx.time !== null && tx.time !== '') {
    var time = new Date(tx.time).getTime()
    if (isFinite(time)) return format.ymOf(time)
  }
  return ''
}

function toCents(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return 0
  var number = Number(value)
  if (!isFinite(number)) return 0
  var rounded = Math.round(Math.abs(number) * 100 + 1e-8)
  if (!isFinite(rounded)) return number < 0 ? -MAX_CENTS : MAX_CENTS
  rounded = Math.min(MAX_CENTS, rounded)
  return (number < 0 ? -rounded : rounded) || 0
}

function addCents(total, value) {
  var next = total + value
  if (!isFinite(next)) return value < 0 ? -MAX_CENTS : MAX_CENTS
  return clamp(next, -MAX_CENTS, MAX_CENTS)
}

function integerCents(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null
  var number = Number(value)
  if (!isFinite(number)) return null
  return clamp(Math.round(number), -MAX_CENTS, MAX_CENTS) || 0
}

function ratioOf(numerator, denominator) {
  if (!(denominator > 0) || !isFinite(numerator) || !isFinite(denominator)) return null
  var ratio = numerator / denominator
  return isFinite(ratio) ? ratio : null
}

function percentText(ratio) {
  if (ratio === null || !isFinite(ratio)) return '--'
  if (Math.abs(ratio) >= 10000) return (ratio < 0 ? '-' : '') + '>=10000%'
  return (Math.round(ratio * 1000) / 10).toFixed(1) + '%'
}

function moneyText(cents) {
  return '¥' + format.signedMoney((cents || 0) / 100)
}

function categoryOf(tx) {
  var name = String(tx && tx.category || '').trim()
  return !name || name === '未分类' ? '未分类' : name
}

function isUncategorized(tx) {
  return categoryOf(tx) === '未分类'
}

function timestampOf(value) {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim()) return new Date(value).getTime()
  return NaN
}

/* 默认参考日期不读取系统时钟，保证同一输入得到同一结果。 */
function deterministicNow(rows, ym, requested) {
  var supplied = timestampOf(requested)
  if (isFinite(supplied)) return supplied
  if (validYm(ym)) {
    var parts = ym.split('-')
    return new Date(Number(parts[0]), Number(parts[1]), 0, 12, 0, 0).getTime()
  }
  var latest = new Date(1970, 0, 1, 12, 0, 0).getTime()
  rows.forEach(function (row) {
    var day = String(row.tx.day || '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return
    var time = new Date(day + 'T12:00:00').getTime()
    if (isFinite(time) && time > latest) latest = time
  })
  return latest
}

function idsOf(issue) {
  var ids = []
  if (issue && Array.isArray(issue.txIds)) {
    issue.txIds.forEach(function (id) { if (id !== null && id !== undefined && id !== '') ids.push(String(id)) })
  }
  return ids
}

/* 传入全量体检结果时，只保留本月问题；页面传入本月结果时原样复用。 */
function scopedIssues(scan, rows, ym) {
  var issues = scan && Array.isArray(scan.issues) ? scan.issues.filter(function (entry) {
    return entry && typeof entry === 'object' && !Array.isArray(entry)
  }) : []
  if (!validYm(ym)) return issues.slice()
  var ids = Object.create(null)
  rows.forEach(function (row) { if (row.id) ids[row.id] = true })
  return issues.filter(function (issue) {
    if (Array.isArray(issue.records) && issue.records.length) {
      var matched = issue.records.some(function (record) {
        var recordYm = monthOf(record)
        return !recordYm || recordYm === ym
      })
      if (matched) return true
    }
    var issueIds = idsOf(issue)
    if (issueIds.length) return issueIds.some(function (id) { return ids[id] === true })
    return !!scan && scan.total === rows.length
  })
}

function item(key, label, max, score, valueText, hint) {
  return {
    key: key,
    label: label,
    score: clamp(Math.round(score), 0, max),
    max: max,
    valueText: valueText,
    hint: hint
  }
}

function healthStats(issues) {
  var counts = { high: 0, medium: 0, low: 0 }
  var affected = Object.create(null)
  issues.forEach(function (issue) {
    var severity = issue.severity
    if (counts[severity] !== undefined) counts[severity]++
    idsOf(issue).forEach(function (id) { affected[id] = true })
  })
  return {
    issueCount: issues.length,
    affectedTxCount: Object.keys(affected).length,
    highCount: counts.high,
    mediumCount: counts.medium,
    lowCount: counts.low
  }
}

function suggestionsFor(stats) {
  if (!stats.txCount) return ['本月暂无流水，请先记一笔或导入账单。']
  var out = []
  if (stats.healthHighCount) out.push('优先核对体检高风险问题，确认重复、金额和日期后再继续分析。')
  if (stats.budgetCents > 0 && stats.budgetUsage !== null && stats.budgetUsage > 1) {
    out.push('本月净支出已超当前预算，建议检查大额支出并调整下月预算。')
  }
  if (stats.incomeCents === 0 && stats.expenseCents > 0) {
    out.push('本月未记录收入，储蓄率按中性分处理；如确有收入请补记。')
  } else if (stats.savingsRate !== null && stats.savingsRate < 0.2) {
    out.push('储蓄率低于 20% 目标，建议先留出固定储蓄，再安排弹性消费。')
  }
  if (stats.budgetCents <= 0) out.push('设置月度预算后，可更直观地看到支出进度和超支风险。')
  if (stats.uncategorizedCount) out.push('有 ' + stats.uncategorizedCount + ' 笔非转账流水待分类，补齐后分类集中度会更准确。')
  if (stats.topCategoryShare !== null && stats.topCategoryShare > 0.6) {
    out.push('最大已分类支出「' + stats.topCategory + '」占比偏高，可回顾是否有可压缩空间。')
  }
  if (!out.length && stats.healthIssueCount) out.push('体检发现需核对的问题，建议逐项确认；提示不代表记录一定错误。')
  if (!out.length) out.push('本月主要指标表现稳定，建议保持记账习惯并定期回看。')
  return out.slice(0, 5)
}

function buildReportText(result) {
  var m = result.metrics
  var lines = [
    '月度财务健康报告',
    '月份：' + (result.ym || '未指定月份'),
    '范围：' + (result.scopeText || '全部传入流水'),
    '综合评分：' + result.score + '/100（' + result.level + '）',
    '',
    '关键指标',
    '收入：' + moneyText(m.incomeCents),
    '净支出（退款抵减后）：' + moneyText(m.netExpenseCents),
    '收支结余：' + moneyText(m.balanceCents),
    '储蓄率：' + (m.savingsRate === null ? '无收入，未评定' : percentText(m.savingsRate)),
    '预算使用（当前设置）：' + (m.budgetUsage === null ? '未设置' : percentText(m.budgetUsage)),
    '最大已分类支出：' + (m.topCategory ? m.topCategory + '（' + percentText(m.topCategoryShare) + '）' : '暂无'),
    '待分类：' + m.uncategorizedCount + '/' + m.categorizationTxCount + ' 笔',
    '数据体检：' + m.healthIssueCount + ' 项问题，涉及 ' + m.healthAffectedTxCount + ' 笔',
    '当前净资产快照：' + (m.netWorthCents === null ? '暂无账户数据' : moneyText(m.netWorthCents)),
    '',
    '分项评分'
  ]
  result.breakdown.forEach(function (entry) {
    lines.push(entry.label + '：' + entry.score + '/' + entry.max + '，' + entry.valueText)
  })
  lines.push('', '建议')
  result.suggestions.forEach(function (text, index) { lines.push((index + 1) + '. ' + text) })
  lines.push('', '说明：金额按分计算后展示；净资产为当前快照，单月无法得出趋势。评分仅反映已记录数据，不构成投资或借贷建议。')
  return lines.join('\n')
}

function calculate(txs, options) {
  options = options && typeof options === 'object' ? options : {}
  var ym = validYm(options.ym) ? String(options.ym) : ''
  var source = Array.isArray(txs) ? txs : []
  var rows = source.filter(function (tx) {
    return tx && typeof tx === 'object' && !Array.isArray(tx)
  }).map(function (tx) {
    return { tx: tx, id: String(tx.id || ''), ym: monthOf(tx), amountCents: toCents(tx.amount) }
  }).filter(function (row) {
    return !ym || row.ym === ym
  })

  var incomeCents = 0
  var expenseCents = 0
  var refundCents = 0
  var uncategorizedCount = 0
  var categorizationTxCount = 0
  var categories = Object.create(null)
  rows.forEach(function (row) {
    var amount = row.amountCents
    if (row.tx.type !== 'transfer') {
      categorizationTxCount++
      if (isUncategorized(row.tx)) uncategorizedCount++
    }
    if (amount <= 0) return
    if (row.tx.type === 'income') incomeCents = addCents(incomeCents, amount)
    else if (row.tx.type === 'expense') expenseCents = addCents(expenseCents, amount)
    else if (row.tx.type === 'refund') refundCents = addCents(refundCents, amount)
    if (row.tx.type === 'expense' && !isUncategorized(row.tx)) {
      var name = categoryOf(row.tx)
      categories[name] = addCents(categories[name] || 0, amount)
    }
  })

  var netExpenseCents = Math.max(0, expenseCents - refundCents)
  var balanceCents = addCents(incomeCents, -netExpenseCents)
  var savingsRate = ratioOf(balanceCents, incomeCents)
  var budgetCents = Math.max(0, toCents(options.budget))
  var budgetUsage = ratioOf(netExpenseCents, budgetCents)
  var uncategorizedRatio = ratioOf(uncategorizedCount, categorizationTxCount)
  var categoryNames = Object.keys(categories).sort(function (a, b) { return a < b ? -1 : (a > b ? 1 : 0) })
  var categorizedExpenseCents = categoryNames.reduce(function (sum, name) { return addCents(sum, categories[name]) }, 0)
  var topCategory = ''
  var topCategoryCents = 0
  categoryNames.forEach(function (name) {
    if (categories[name] > topCategoryCents) {
      topCategory = name
      topCategoryCents = categories[name]
    }
  })
  var topCategoryShare = ratioOf(topCategoryCents, categorizedExpenseCents)

  var scan = options.healthScan
  var healthScanReused = !!scan && typeof scan === 'object'
  if (!healthScanReused) {
    scan = health.scan(rows.map(function (row) { return row.tx }), deterministicNow(rows, ym, options.now), {
      largeAmount: options.largeAmount
    })
  }
  var issues = scopedIssues(scan, rows, ym)
  var hs = healthStats(issues)
  var affectedRatio = ratioOf(hs.affectedTxCount, rows.length)

  var breakdown = []
  var savingsScore = 0
  var budgetScore = 0
  var concentrationScore = 0
  var categorizationScore = 0
  var healthScore = 0
  if (rows.length) {
    savingsScore = savingsRate === null ? WEIGHTS.savings / 2 : WEIGHTS.savings * clamp(savingsRate / 0.2, 0, 1)
    budgetScore = budgetCents <= 0 ? WEIGHTS.budget / 2 : WEIGHTS.budget * clamp((1.5 - (budgetUsage || 0)) / 0.7, 0, 1)
    concentrationScore = topCategoryShare === null ? WEIGHTS.concentration / 2 : WEIGHTS.concentration * clamp((0.8 - topCategoryShare) / 0.45, 0, 1)
    categorizationScore = categorizationTxCount === 0 ? WEIGHTS.categorization / 2 : WEIGHTS.categorization * (1 - (uncategorizedRatio || 0))
    var healthPenalty = hs.highCount * 6 + hs.mediumCount * 4 + hs.lowCount * 2 + Math.round((affectedRatio || 0) * 8)
    healthScore = WEIGHTS.health - healthPenalty

    breakdown.push(item('savingsRate', '储蓄率', WEIGHTS.savings, savingsScore,
      incomeCents ? percentText(savingsRate) + '（结余 ' + moneyText(balanceCents) + '）' : '无收入（中性分）',
      incomeCents ? '以 20% 储蓄率为满分目标；退款抵减本月支出。' : '本月无收入，按中性分处理，不虚构储蓄率。'))
    breakdown.push(item('budgetControl', '预算控制', WEIGHTS.budget, budgetScore,
      budgetCents ? percentText(budgetUsage) + '（' + moneyText(netExpenseCents) + ' / ' + moneyText(budgetCents) + '）' : '未设置（中性分）',
      budgetCents ? '预算使用 80% 以内满分，150% 及以上零分。' : '未设置月度预算，按中性分处理。'))
    breakdown.push(item('categoryConcentration', '分类集中度', WEIGHTS.concentration, concentrationScore,
      topCategory ? topCategory + ' ' + percentText(topCategoryShare) : '暂无已分类支出（中性分）',
      topCategory ? '最大已分类支出占比 35% 以内满分，80% 及以上零分。' : '没有可参与评分的已分类支出，按中性分处理。'))
    breakdown.push(item('uncategorizedRatio', '待分类比例', WEIGHTS.categorization, categorizationScore,
      uncategorizedCount + '/' + categorizationTxCount + ' 笔 · ' + percentText(uncategorizedRatio),
      categorizationTxCount ? '按非转账流水计算，待分类比例越低得分越高。' : '本月仅转账或没有可分类流水，按中性分处理。'))
    breakdown.push(item('dataHealth', '数据体检', WEIGHTS.health, healthScore,
      hs.issueCount + ' 项问题 · 涉及 ' + hs.affectedTxCount + ' 笔',
      hs.issueCount ? '按问题严重程度与涉及流水比例扣分，请优先核对高风险项。' : '未发现重复、日期、金额、商户、分类或 OCR 问题。'))
  } else {
    breakdown.push(item('savingsRate', '储蓄率', WEIGHTS.savings, 0, '暂无流水', '本月无流水，暂不评分。'))
    breakdown.push(item('budgetControl', '预算控制', WEIGHTS.budget, 0, '暂无流水', '本月无流水，暂不评分。'))
    breakdown.push(item('categoryConcentration', '分类集中度', WEIGHTS.concentration, 0, '暂无流水', '本月无流水，暂不评分。'))
    breakdown.push(item('uncategorizedRatio', '待分类比例', WEIGHTS.categorization, 0, '暂无流水', '本月无流水，暂不评分。'))
    breakdown.push(item('dataHealth', '数据体检', WEIGHTS.health, 0, '暂无流水', '本月无流水，暂不评分。'))
  }

  var netWorthCents = integerCents(options.accountNetWorthCents)
  var metrics = {
    ym: ym,
    txCount: rows.length,
    incomeCents: incomeCents,
    expenseCents: expenseCents,
    refundCents: refundCents,
    netExpenseCents: netExpenseCents,
    balanceCents: balanceCents,
    savingsRate: savingsRate,
    budgetCents: budgetCents,
    budgetRemainingCents: budgetCents ? addCents(budgetCents, -netExpenseCents) : null,
    budgetUsage: budgetUsage,
    categorizedExpenseCents: categorizedExpenseCents,
    categoryCount: categoryNames.length,
    topCategory: topCategory,
    topCategoryCents: topCategoryCents,
    topCategoryShare: topCategoryShare,
    categorizationTxCount: categorizationTxCount,
    uncategorizedCount: uncategorizedCount,
    uncategorizedRatio: uncategorizedRatio,
    healthIssueCount: hs.issueCount,
    healthAffectedTxCount: hs.affectedTxCount,
    healthHighCount: hs.highCount,
    healthMediumCount: hs.mediumCount,
    healthLowCount: hs.lowCount,
    healthScanReused: healthScanReused,
    netWorthCents: netWorthCents,
    netWorthTrendAvailable: false
  }
  var score = breakdown.reduce(function (sum, entry) { return sum + entry.score }, 0)
  var level = !rows.length ? '暂无数据' : (score >= 85 ? '优秀' : (score >= 70 ? '良好' : (score >= 55 ? '一般' : '需改善')))
  var result = {
    score: clamp(Math.round(score), 0, 100),
    level: level,
    ym: ym,
    hasData: rows.length > 0,
    scopeText: String(options.scopeText || ''),
    breakdown: breakdown,
    metrics: metrics,
    suggestions: suggestionsFor(metrics)
  }
  result.reportText = buildReportText(result)
  return result
}

module.exports = {
  calculate: calculate,
  buildReportText: buildReportText
}
