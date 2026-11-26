/* 年度财务报告：纯函数。金额一律按整数分累计，不修改流水或 options。
 * calculate(txs, options)
 *   year：默认当前年；budgetByMonth / healthScanByMonth：YYYY-MM 键的对象或 12 项数组。
 *   accountNetWorthCents：当前净资产快照（分），不参与收支，也不生成历史趋势。
 * 退款按退款发生月抵减净支出；分类 TOP 按支出发生额，不猜测跨月退款归属。
 */
var format = require('./format')
var category = require('./category')
var health = require('./health')

var MAX_CENTS = 9007199254740991

function validYm(value) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ''))
}

function monthOf(tx) {
  if (validYm(tx && tx.ym)) return String(tx.ym)
  if (validYm(String(tx && tx.day || '').slice(0, 7))) return String(tx.day).slice(0, 7)
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

function snapshotCents(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null
  var number = Number(value)
  if (!isFinite(number)) return null
  return Math.min(MAX_CENTS, Math.max(-MAX_CENTS, Math.round(number))) || 0
}

function addCents(total, value) {
  return Math.min(MAX_CENTS, Math.max(-MAX_CENTS, total + value))
}

function subtractCents(left, right) {
  return addCents(left, -right)
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
  return name || '未分类'
}

function emptyMonth(year, index) {
  var ym = year + '-' + format.pad(index + 1)
  return {
    ym: ym,
    month: index + 1,
    label: (index + 1) + '月',
    hasData: false,
    txCount: 0,
    incomeCents: 0,
    expenseCents: 0,
    refundCents: 0,
    netExpenseCents: 0,
    balanceCents: 0,
    savingsRate: null,
    budgetProvided: false,
    budgetCents: null,
    budgetUsage: null,
    budgetRemainingCents: null,
    budgetExceeded: false,
    expenseText: '¥0.00',
    incomeText: '¥0.00',
    refundText: '¥0.00',
    netExpenseText: '¥0.00',
    balanceText: '¥0.00',
    savingsRateText: '--',
    budgetText: '未设置',
    trendText: '无记录',
    trendHeight: 0
  }
}

function monthEntry(source, ym) {
  if (!source || typeof source !== 'object') return undefined
  if (Array.isArray(source)) return source[Number(ym.slice(5, 7)) - 1]
  if (Object.prototype.hasOwnProperty.call(source, ym)) return source[ym]
  if (Object.prototype.hasOwnProperty.call(source, ym.slice(5))) return source[ym.slice(5)]
  return undefined
}

function budgetCentsOf(value) {
  if (value && typeof value === 'object') value = value.budget !== undefined ? value.budget : value.cents
  var cents = toCents(value)
  return cents > 0 ? cents : null
}

function idOf(tx, index) {
  return tx && tx.id !== undefined && tx.id !== null && tx.id !== '' ? String(tx.id) : ''
}

function idsOf(issue) {
  var out = []
  var list = issue && Array.isArray(issue.txIds) ? issue.txIds : []
  list.forEach(function (id) {
    if (id !== undefined && id !== null && id !== '') out.push(String(id))
  })
  return out
}

/* 传入的既可能是本月体检，也可能是全年体检；只保留能定位到本月的记录。 */
function scopedIssues(scan, monthRows) {
  if (!scan || typeof scan !== 'object' || !Array.isArray(scan.issues)) return []
  var ids = Object.create(null)
  monthRows.forEach(function (row) { if (row.id) ids[row.id] = true })
  var count = monthRows.length
  return scan.issues.filter(function (issue) {
    if (!issue || typeof issue !== 'object' || Array.isArray(issue)) return false
    if (Array.isArray(issue.records) && issue.records.length) {
      return issue.records.some(function (record) {
        if (!record || typeof record !== 'object') return false
        var id = idOf(record)
        if (id && ids[id]) return true
        return !id && monthOf(record) === (count ? monthRows[0].ym : '')
      })
    }
    var issueIds = idsOf(issue)
    if (issueIds.length) return issueIds.some(function (id) { return ids[id] === true })
    return count > 0 && scan.total === count
  })
}

function healthOverview(yearRows, months, scans, now) {
  var supplied = !!scans && typeof scans === 'object'
  var scanMonths = 0
  var issues = []
  var issueKeys = Object.create(null)
  var total = 0
  months.forEach(function (month) {
    var rows = yearRows.filter(function (row) { return row.ym === month.ym })
    total += rows.length
    var scan = monthEntry(scans, month.ym)
    if (!scan || typeof scan !== 'object') return
    scanMonths++
    scopedIssues(scan, rows).forEach(function (issue) {
      var key = issue.key || JSON.stringify([issue.type, idsOf(issue).sort(), issue.title || ''])
      if (issueKeys[key]) return
      issueKeys[key] = true
      issues.push(issue)
    })
  })
  if (!supplied) {
    var scan = health.scan(yearRows.map(function (row) { return row.tx }), now)
    issues = scan.issues
    scanMonths = 12
  }
  var summary = health.summarize({ total: total, issues: issues })
  /* 体检汇总的 severity 计数从零开始时也要计入，这里按去重后的问题重新统计。 */
  var severity = { high: 0, medium: 0, low: 0 }
  issues.forEach(function (issue) {
    if (severity[issue.severity] !== undefined) severity[issue.severity]++
  })
  var byType = {}
  Object.keys(summary.byType).forEach(function (key) { byType[key] = summary.byType[key] })
  var txCountByType = {}
  Object.keys(summary.txCountByType).forEach(function (key) { txCountByType[key] = summary.txCountByType[key] })
  return {
    txCount: total,
    scanMonths: scanMonths,
    scanComplete: scanMonths === 12,
    scanReused: supplied,
    issueCount: summary.issueCount,
    affectedTxCount: summary.affectedTxCount,
    healthy: summary.healthy,
    highCount: severity.high,
    mediumCount: severity.medium,
    lowCount: severity.low,
    byType: byType,
    txCountByType: txCountByType,
    types: summary.types.filter(function (item) { return item.count > 0 }),
    issueSummaryText: summary.issueCount + ' 项问题 · 涉及 ' + summary.affectedTxCount + ' 笔'
  }
}

function categoryList(categoryMap, refunds, totalExpense) {
  var names = Object.keys(categoryMap)
  names.forEach(function (name) { if (!refunds[name]) refunds[name] = 0 })
  return names.map(function (name) {
    var amount = categoryMap[name] || 0
    var refund = refunds[name] || 0
    return {
      name: name,
      expenseCents: amount,
      refundCents: refund,
      netExpenseCents: subtractCents(amount, refund),
      pct: ratioOf(amount, totalExpense) === null ? 0 : Math.round(amount / totalExpense * 1000) / 10,
      amount: amount / 100,
      amountText: moneyText(amount),
      netExpenseText: moneyText(subtractCents(amount, refund)),
      color: category.colorOf(name)
    }
  }).sort(function (a, b) {
    if (b.expenseCents !== a.expenseCents) return b.expenseCents - a.expenseCents
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)
  })
}

function extremeMonth(months, highest) {
  var picked = null
  months.forEach(function (month) {
    if (!month.hasData) return
    if (!picked || (highest ? month.netExpenseCents > picked.netExpenseCents : month.netExpenseCents < picked.netExpenseCents)) {
      picked = month
    }
  })
  return picked
}

function buildReportText(result) {
  var totals = result.totals
  var health = result.health
  var lines = [
    result.year + ' 年度财务报告',
    '范围：' + (result.scopeText || '全部传入流水'),
    '',
    '年度总览',
    '收入：' + moneyText(totals.incomeCents),
    '支出：' + moneyText(totals.expenseCents),
    '退款：' + moneyText(totals.refundCents),
    '净支出：' + moneyText(totals.netExpenseCents),
    '收支结余：' + moneyText(totals.balanceCents),
    '年度储蓄率：' + percentText(totals.savingsRate),
    '有记录月份：' + totals.recordedMonths + '/12',
    '平均月支出：' + moneyText(totals.averageMonthlyExpenseCents) + '（仅有记录月份）',
    '最高支出月：' + (totals.highestExpenseMonth ? totals.highestExpenseMonth.label + ' ' + moneyText(totals.highestExpenseMonth.netExpenseCents) : '暂无'),
    '最低支出月：' + (totals.lowestExpenseMonth ? totals.lowestExpenseMonth.label + ' ' + moneyText(totals.lowestExpenseMonth.netExpenseCents) : '暂无'),
    '',
    '年度健康概览',
    '有收入月份平均储蓄率：' + percentText(health.averageSavingsRate) + '（' + health.incomeMonths + ' 个有收入月）',
    '预算覆盖：' + health.budgetMonths + '/12 月',
    '预算内净支出：' + moneyText(health.budgetNetExpenseCents),
    '预算合计：' + (health.budgetCents === null ? '未设置' : moneyText(health.budgetCents)),
    '预算使用：' + percentText(health.budgetUsage),
    '超支月份：' + health.overBudgetMonths,
    '数据体检：' + health.issueSummaryText + '（覆盖 ' + health.scanMonths + '/12 月）',
    '当前净资产快照：' + (result.netWorthCents === null ? '暂无账户数据' : moneyText(result.netWorthCents)),
    '',
    '支出分类 TOP（按支出发生额，退款另计）'
  ]
  result.topCategories.slice(0, 5).forEach(function (item, index) {
    lines.push((index + 1) + '. ' + item.name + '：' + item.amountText + '（' + percentText(item.pct / 100) + '）')
  })
  if (!result.topCategories.length) lines.push('暂无支出分类')
  lines.push('', '月份明细（无记录月份不参与趋势判断）')
  result.months.forEach(function (month) {
    lines.push(month.label + '：' + (month.hasData
      ? '收入 ' + month.incomeText + '，支出 ' + month.expenseText + '，退款 ' + month.refundText + '，净支出 ' + moneyText(month.netExpenseCents) + '，结余 ' + month.balanceText
      : '无记录'))
  })
  lines.push('', '说明：金额按分计算；退款按发生月抵减；未设置预算的月份不计入预算统计。净资产是当前快照，不能据此推断历史月份趋势。')
  return lines.join('\n')
}

function calculate(txs, options) {
  options = options && typeof options === 'object' ? options : {}
  var currentYear = new Date().getFullYear()
  var parsedYear = Number(options.year === undefined ? currentYear : options.year)
  var year = String(isFinite(parsedYear) && parsedYear >= 1970 && parsedYear <= 9999 ? Math.floor(parsedYear) : currentYear)
  var months = []
  var monthMaps = []
  var categoryMap = Object.create(null)
  var refundMap = Object.create(null)
  var yearRows = []
  var seenIds = Object.create(null)
  var txCount = 0
  var incomeCents = 0
  var expenseCents = 0
  var refundCents = 0
  var i
  for (i = 0; i < 12; i++) {
    months.push(emptyMonth(year, i))
    monthMaps.push({ rows: [], categoryMap: Object.create(null), refundMap: Object.create(null) })
  }
  var source = Array.isArray(txs) ? txs : []
  source.forEach(function (tx, index) {
    if (!tx || typeof tx !== 'object' || Array.isArray(tx)) return
    var ym = monthOf(tx)
    if (ym.slice(0, 4) !== year) return
    var monthIndex = Number(ym.slice(5, 7)) - 1
    if (monthIndex < 0 || monthIndex > 11) return
    var month = months[monthIndex]
    var map = monthMaps[monthIndex]
    var id = idOf(tx, index)
    var amount = toCents(tx.amount)
    month.hasData = true
    month.txCount++
    map.rows.push({ tx: tx, ym: ym, id: id })
    yearRows.push({ tx: tx, ym: ym, id: id })
    if (!id || !seenIds[id]) txCount++
    if (id) seenIds[id] = true
    if (amount <= 0) return
    if (tx.type === 'income') {
      month.incomeCents = addCents(month.incomeCents, amount)
      incomeCents = addCents(incomeCents, amount)
    } else if (tx.type === 'expense') {
      var name = categoryOf(tx)
      month.expenseCents = addCents(month.expenseCents, amount)
      expenseCents = addCents(expenseCents, amount)
      categoryMap[name] = addCents(categoryMap[name] || 0, amount)
      map.categoryMap[name] = addCents(map.categoryMap[name] || 0, amount)
    } else if (tx.type === 'refund') {
      var refundName = categoryOf(tx)
      month.refundCents = addCents(month.refundCents, amount)
      refundCents = addCents(refundCents, amount)
      refundMap[refundName] = addCents(refundMap[refundName] || 0, amount)
      map.refundMap[refundName] = addCents(map.refundMap[refundName] || 0, amount)
    }
  })

  var recordedMonths = 0
  var incomeMonths = 0
  var savingsRateSum = 0
  var budgetMonths = 0
  var missingBudgetMonths = 0
  var budgetCents = 0
  var budgetNetExpenseCents = 0
  var overBudgetMonths = 0
  months.forEach(function (month, index) {
    month.netExpenseCents = subtractCents(month.expenseCents, month.refundCents)
    month.balanceCents = subtractCents(month.incomeCents, month.netExpenseCents)
    month.savingsRate = ratioOf(month.balanceCents, month.incomeCents)
    month.expenseText = moneyText(month.expenseCents)
    month.incomeText = moneyText(month.incomeCents)
    month.refundText = moneyText(month.refundCents)
    month.netExpenseText = moneyText(month.netExpenseCents)
    month.balanceText = moneyText(month.balanceCents)
    month.savingsRateText = month.savingsRate === null ? '--' : percentText(month.savingsRate)
    if (month.hasData) {
      recordedMonths++
      if (month.incomeCents > 0) {
        incomeMonths++
        savingsRateSum += month.savingsRate
      }
    }
    var budget = budgetCentsOf(monthEntry(options.budgetByMonth, month.ym))
    if (budget === null) {
      missingBudgetMonths++
      month.budgetText = '未设置'
    } else {
      month.budgetProvided = true
      month.budgetCents = budget
      month.budgetUsage = ratioOf(Math.max(month.netExpenseCents, 0), budget)
      month.budgetRemainingCents = subtractCents(budget, Math.max(month.netExpenseCents, 0))
      month.budgetExceeded = month.netExpenseCents > budget
      month.budgetText = percentText(month.budgetUsage) + ' · ' + moneyText(Math.max(month.netExpenseCents, 0)) + ' / ' + moneyText(budget)
      budgetMonths++
      budgetCents = addCents(budgetCents, budget)
      budgetNetExpenseCents = addCents(budgetNetExpenseCents, Math.max(month.netExpenseCents, 0))
      if (month.budgetExceeded) overBudgetMonths++
    }
    month.topCategories = categoryList(monthMaps[index].categoryMap, monthMaps[index].refundMap, month.expenseCents).slice(0, 3)
  })

  var netExpenseCents = subtractCents(expenseCents, refundCents)
  var balanceCents = subtractCents(incomeCents, netExpenseCents)
  var maxExpense = 0
  months.forEach(function (month) { maxExpense = Math.max(maxExpense, Math.abs(month.netExpenseCents)) })
  months.forEach(function (month) {
    month.trendText = month.hasData ? moneyText(month.netExpenseCents) : '无记录'
    month.trendHeight = month.hasData && maxExpense > 0 ? Math.max(4, Math.round(Math.abs(month.netExpenseCents) / maxExpense * 100)) : 0
    month.trendStyle = 'height: ' + month.trendHeight + '%'
    month.trendNegative = month.netExpenseCents < 0
  })
  var topCategories = categoryList(categoryMap, refundMap, expenseCents)
  var highest = extremeMonth(months, true)
  var lowest = extremeMonth(months, false)
  var now = options.now
  if (!(now instanceof Date) && typeof now !== 'number' && typeof now !== 'string') {
    now = new Date(Number(year), 11, 31, 12, 0, 0).getTime()
  }
  var result = {
    year: year,
    scopeText: String(options.scopeText || ''),
    hasData: recordedMonths > 0,
    txCount: txCount,
    totals: {
      txCount: txCount,
      incomeCents: incomeCents,
      expenseCents: expenseCents,
      refundCents: refundCents,
      netExpenseCents: netExpenseCents,
      balanceCents: balanceCents,
      savingsRate: ratioOf(balanceCents, incomeCents),
      recordedMonths: recordedMonths,
      averageMonthlyExpenseCents: recordedMonths ? Math.round(netExpenseCents / recordedMonths) : 0,
      highestExpenseMonth: highest,
      lowestExpenseMonth: lowest
    },
    months: months,
    topCategories: topCategories,
    health: {
      incomeMonths: incomeMonths,
      averageSavingsRate: incomeMonths ? savingsRateSum / incomeMonths : null,
      budgetMonths: budgetMonths,
      missingBudgetMonths: missingBudgetMonths,
      budgetCents: budgetMonths ? budgetCents : null,
      budgetNetExpenseCents: budgetMonths ? budgetNetExpenseCents : null,
      budgetUsage: ratioOf(budgetNetExpenseCents, budgetCents),
      overBudgetMonths: overBudgetMonths
    },
    netWorthCents: snapshotCents(options.accountNetWorthCents),
    netWorthTrendAvailable: false
  }
  result.health = Object.assign(result.health, healthOverview(yearRows, months, options.healthScanByMonth, now))
  result.reportText = buildReportText(result)
  return result
}

module.exports = {
  calculate: calculate,
  buildReportText: buildReportText
}
