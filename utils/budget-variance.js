/* 预算执行偏差：金额输入/输出均为元，内部全程按分累计。
 * variance = budget - spent：正数表示结余，负数表示超支；未设预算时为 null。
 * usageRate 为百分比数值；净支出 <= 0 时按 0% 展示，避免把退款误报成超支。
 * calculateTrend(txs, endYm, monthCount, monthlyBudgetOrMap, categoryBudgets, options)
 *   返回 { endYm, monthCount, months, reportText }，月份按时间升序且包含结束月。
 *   预算传数值表示区间内各月共用；传 { 'YYYY-MM': budget } 时缺失键表示未设置。
 */
var stats = require('./stats')
var format = require('./format')

var STATUS = {
  OVER: 'over_budget',
  NEAR: 'near_budget',
  HEALTHY: 'healthy',
  UNBUDGETED: 'unbudgeted',
  NO_BUDGET: 'no_budget'
}
var STATUS_TEXT = {
  over_budget: '超支',
  near_budget: '接近预算',
  healthy: '健康',
  unbudgeted: '未设预算',
  no_budget: '未设总预算'
}
var DEFAULT_NEAR_THRESHOLD = 0.8

function validYm(value) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ''))
}

function cents(value) {
  if (value === null || value === undefined || typeof value === 'boolean' || value === '') return 0
  var n = Number(value)
  if (!isFinite(n)) return 0
  var c = Math.round(Math.abs(n) * 100 + 1e-8)
  if (!isFinite(c)) return 0
  return (n < 0 ? -c : c) || 0
}

function budgetCents(value) {
  var c = cents(value)
  return c > 0 ? c : 0
}

function round1(value) {
  return Math.round(value * 10) / 10
}

function usageOf(spent, budget) {
  if (budget <= 0) return null
  return round1((spent <= 0 ? 0 : spent / budget) * 100)
}

function variancePctOf(spent, budget) {
  if (budget <= 0) return null
  return round1(((budget - spent) / budget) * 100)
}

function barPctOf(usage) {
  if (usage === null) return 0
  if (usage >= 10000) return 100
  return Math.max(0, Math.min(100, Math.round(usage)))
}

function rateText(value) {
  if (value === null) return '--'
  if (value >= 10000) return '>=10000%'
  return value.toFixed(1) + '%'
}

function currency(value, signed) {
  var amount = cents(value) / 100
  return (signed && amount < 0 ? '-' : '') + '¥' + format.money(Math.abs(amount))
}

function cleanText(value, fallback) {
  var text = String(value === null || value === undefined ? '' : value)
    .replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return text || fallback || ''
}

function categoryName(value) {
  return cleanText(value, '未分类')
}

function monthOf(tx) {
  if (validYm(tx && tx.ym)) return tx.ym
  if (validYm(String(tx && tx.day || '').slice(0, 7))) return String(tx.day).slice(0, 7)
  if (!tx || tx.time === undefined || tx.time === null || tx.time === '') return ''
  var raw = tx.time
  var time = typeof raw === 'number' ? raw : new Date(raw).getTime()
  return isFinite(time) ? format.ymOf(time) : ''
}

function timestamp(value) {
  if (value === undefined || value === null || value === '') return null
  var time = typeof value === 'number' ? value : new Date(value).getTime()
  return isFinite(time) ? time : null
}

/* 补齐老流水可能缺失的 ym/day/time；不修改调用方对象。 */
function normalizeRows(txs) {
  if (!Array.isArray(txs)) return []
  var out = []
  txs.forEach(function (tx) {
    if (!tx || typeof tx !== 'object' || Array.isArray(tx)) return
    var row = {}
    Object.keys(tx).forEach(function (key) { row[key] = tx[key] })
    row.amount = cents(tx.amount) / 100
    var time = timestamp(tx.time)
    var day = String(tx.day || '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) && time !== null) day = format.dayOf(time)
    row.day = day
    if (time === null && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
      var parts = day.split('-')
      time = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 12).getTime()
    }
    row.time = time === null ? 0 : time
    row.ym = monthOf(row)
    if (row.category) row.category = categoryName(row.category)
    out.push(row)
  })
  return out
}

function statusOf(spent, budget, nearThreshold) {
  if (budget <= 0) return STATUS.UNBUDGETED
  if (spent > budget) return STATUS.OVER
  return usageOf(spent, budget) >= nearThreshold * 100 ? STATUS.NEAR : STATUS.HEALTHY
}

function adviceOf(status, spent, budget, category) {
  var name = category ? '「' + category + '」' : '总预算'
  if (status === STATUS.UNBUDGETED) {
    return spent < 0
      ? name + '退款后为净结余，不构成超支；可设置分类预算以便后续跟踪。'
      : name + '尚未设置额度，建议补充分类预算后再判断执行偏差。'
  }
  if (status === STATUS.OVER) {
    return name + '已超支 ' + currency((spent - budget) / 100) + '，建议核对大额支出并控制后续消费。'
  }
  if (status === STATUS.NEAR) {
    return name + '已使用 ' + rateText(usageOf(spent, budget)) + '，建议留意剩余额度。'
  }
  if (spent < 0) {
    return name + '退款大于支出，净支出为 ' + currency(spent / 100, true) + '；使用率按 0% 展示。'
  }
  if (spent === 0) {
    return name + '本月暂无支出，当前没有执行偏差。'
  }
  return name + '尚有 ' + currency((budget - spent) / 100) + ' 结余，可继续按计划跟踪。'
}

function thresholdOf(options) {
  var value = options && options.nearThreshold !== undefined
    ? Number(options.nearThreshold) : DEFAULT_NEAR_THRESHOLD
  if (!isFinite(value)) return DEFAULT_NEAR_THRESHOLD
  if (value > 1 && value <= 100) value /= 100
  return Math.max(0.01, Math.min(1, value))
}

function compareCats(a, b) {
  var rank = { over_budget: 0, near_budget: 1, unbudgeted: 2, healthy: 3 }
  var byStatus = rank[a.status] - rank[b.status]
  if (byStatus) return byStatus
  if (a.status === STATUS.OVER && b.variance !== a.variance) return a.variance - b.variance
  if (b.usageRate !== a.usageRate) {
    var au = a.usageRate === null ? -1 : a.usageRate
    var bu = b.usageRate === null ? -1 : b.usageRate
    return bu - au
  }
  if (a.category < b.category) return -1
  return a.category > b.category ? 1 : 0
}

function buildReport(ym, scope, result) {
  var title = validYm(ym) ? format.monthLabel(ym) : '未知月份'
  var lines = [
    '预算执行偏差分析 · ' + title,
    '统计范围：' + scope,
    '整体状态：' + STATUS_TEXT[result.overallStatus],
    '口径：本月支出 − 本月到账退款；退款抵减原付款分类，跨月退款按到账月计入。收入与转账不计入支出。',
    '差额 = 预算 − 净支出；正数为结余，负数为超支。净支出为负时使用率按 0% 展示。',
    '',
    '总预算：' + (result.hasBudget ? currency(result.totalBudget) : '未设置'),
    '实际净支出：' + currency(result.actualNetSpend, true),
    result.hasBudget
      ? (result.remaining >= 0 ? '剩余：' : '超支：') + currency(Math.abs(result.remaining))
      : '剩余/超支：无法计算（未设总预算）',
    '使用率：' + rateText(result.usageRate),
    '',
    '分类偏差：'
  ]
  if (!result.categories.length) lines.push('（无分类数据）')
  result.categories.forEach(function (row) {
    var budget = row.hasBudget ? currency(row.budget) : '未设置'
    var variance = row.hasBudget ? currency(row.variance, true) : '--'
    var pct = row.variancePct === null ? '--' : row.variancePct.toFixed(1) + '%'
    lines.push('- ' + row.category + '：预算 ' + budget + '，净支出 ' + currency(row.spent, true) +
      '，差额 ' + variance + '（' + pct + '），' + STATUS_TEXT[row.status] + '。' + row.advice)
  })
  lines.push('', '建议：')
  result.suggestions.forEach(function (item, index) { lines.push((index + 1) + '. ' + item) })
  return lines.join('\n')
}

function calculate(txs, ym, monthlyBudget, categoryBudgets, options) {
  options = options && typeof options === 'object' ? options : {}
  ym = validYm(ym) ? String(ym) : ''
  var rows = normalizeRows(txs)
  var monthRows = validYm(ym) ? rows.filter(function (tx) { return tx.ym === ym }) : []
  /* projected 必须是完整账本的投影，不能先按月截断，否则会改变跨月退款配对。 */
  var projected = Array.isArray(options.projected)
    ? normalizeRows(options.projected) : stats.ledger(rows, true)
  var budgetStats = validYm(ym) ? stats.budgetSpent(rows, ym, projected) : { byCat: Object.create(null) }
  var totalBudgetCents = budgetCents(monthlyBudget)
  var grossCents = 0
  var refundCents = 0
  var grossByCat = Object.create(null)
  monthRows.forEach(function (tx) {
    if (tx.type === 'expense') {
      var amount = cents(tx.amount)
      grossCents += amount
      var name = categoryName(tx.category)
      grossByCat[name] = (grossByCat[name] || 0) + amount
    } else if (tx.type === 'refund') {
      refundCents += cents(tx.amount)
    }
  })
  var netCents = grossCents - refundCents
  var nearThreshold = thresholdOf(options)

  var budgetMap = Object.create(null)
  if (categoryBudgets && typeof categoryBudgets === 'object' && !Array.isArray(categoryBudgets)) {
    Object.keys(categoryBudgets).forEach(function (key) {
      var name = categoryName(key)
      var amount = budgetCents(categoryBudgets[key])
      if (name && amount > 0) budgetMap[name] = amount
    })
  }
  var spentMap = Object.create(null)
  Object.keys(budgetStats.byCat).forEach(function (key) {
    var name = categoryName(key)
    var amount = cents(budgetStats.byCat[key])
    if (amount !== 0) spentMap[name] = amount
  })
  var names = Object.create(null)
  Object.keys(budgetMap).forEach(function (name) { names[name] = true })
  Object.keys(spentMap).forEach(function (name) { names[name] = true })

  var categories = Object.keys(names).map(function (name) {
    var budget = budgetMap[name] || 0
    var spent = spentMap[name] || 0
    var hasBudget = budget > 0
    var status = statusOf(spent, budget, nearThreshold)
    var gross = grossByCat[name] || 0
    var advice = adviceOf(status, spent, budget, name)
    if (hasBudget && spent === 0 && gross > 0) {
      advice = '「' + name + '」本月退款已全额抵减支出，净支出为 ¥0.00，当前没有超支。'
    }
    return {
      category: name,
      budget: budget / 100,
      spent: spent / 100,
      variance: hasBudget ? (budget - spent) / 100 : null,
      variancePct: variancePctOf(spent, budget),
      status: status,
      advice: advice,
      hasBudget: hasBudget,
      usageRate: usageOf(spent, budget),
      barPct: barPctOf(usageOf(spent, budget)),
      grossSpent: gross / 100,
      noSpend: gross === 0 && spent === 0
    }
  }).sort(compareCats)

  var hasBudget = totalBudgetCents > 0
  var overallStatus = !hasBudget ? STATUS.NO_BUDGET
    : statusOf(netCents, totalBudgetCents, nearThreshold)
  var overCategories = categories.filter(function (row) { return row.status === STATUS.OVER })
  var nearCategories = categories.filter(function (row) { return row.status === STATUS.NEAR })
  var unbudgeted = categories.filter(function (row) { return row.status === STATUS.UNBUDGETED && row.spent !== 0 })
  var negativeCategories = categories.filter(function (row) { return row.spent < 0 })
  var suggestions = []

  if (!hasBudget) {
    suggestions.push('尚未设置月度总预算，暂无法判断整体执行偏差；可先在「报表 → 月度预算」设置。')
    if (!monthRows.length) suggestions.push('本月暂无流水，设置预算后即可开始跟踪。')
  } else if (overallStatus === STATUS.OVER) {
    suggestions.push('总预算已超支 ' + currency((netCents - totalBudgetCents) / 100) +
      '（已用 ' + rateText(usageOf(netCents, totalBudgetCents)) + '），建议优先控制超支分类。')
  } else if (overallStatus === STATUS.NEAR) {
    suggestions.push('总预算已使用 ' + rateText(usageOf(netCents, totalBudgetCents)) +
      '，接近上限；剩余 ' + currency((totalBudgetCents - netCents) / 100) + '，建议控制后续支出。')
  } else if (netCents < 0) {
    suggestions.push('本月退款大于支出，净支出为 ' + currency(netCents / 100, true) +
      '；使用率按 0% 展示，不视为超支，退款不追溯改动付款月份。')
  } else if (!grossCents && !refundCents) {
    suggestions.push('本月暂无支出，预算尚未动用。')
  } else {
    suggestions.push('总预算已使用 ' + rateText(usageOf(netCents, totalBudgetCents)) +
      '，剩余 ' + currency((totalBudgetCents - netCents) / 100) + '，当前执行健康。')
  }

  overCategories.slice(0, 2).forEach(function (row) {
    suggestions.push('「' + row.category + '」超支 ' + currency(-row.variance) +
      '，已用 ' + rateText(row.usageRate) + '；建议核对大额支出并调整该类预算。')
  })
  if (overallStatus !== STATUS.OVER) {
    nearCategories.slice(0, 2).forEach(function (row) {
      suggestions.push('「' + row.category + '」已使用 ' + rateText(row.usageRate) +
        '，接近分类预算，建议留意剩余额度。')
    })
  }
  unbudgeted.slice(0, 3).forEach(function (row) {
    suggestions.push('「' + row.category + '」净支出 ' + currency(row.spent, true) +
      ' 但未设分类预算，建议补充额度以便识别偏差。')
  })
  if (netCents >= 0) {
    negativeCategories.slice(0, 1).forEach(function (row) {
      suggestions.push('「' + row.category + '」退款抵减后为净支出 ' + currency(row.spent, true) +
        '，其结余已包含在本月净支出中。')
    })
  }
  if (hasBudget && !categories.length) suggestions.push('暂无分类流水，也没有分类预算；有支出后可进一步分析分类偏差。')
  suggestions = suggestions.slice(0, 7)

  var result = {
    ym: ym,
    totalBudget: totalBudgetCents / 100,
    actualNetSpend: netCents / 100,
    remaining: hasBudget ? (totalBudgetCents - netCents) / 100 : null,
    overspend: hasBudget ? Math.max(netCents - totalBudgetCents, 0) / 100 : null,
    variance: hasBudget ? (totalBudgetCents - netCents) / 100 : null,
    variancePct: variancePctOf(netCents, totalBudgetCents),
    usageRate: usageOf(netCents, totalBudgetCents),
    barPct: barPctOf(usageOf(netCents, totalBudgetCents)),
    hasBudget: hasBudget,
    hasData: monthRows.length > 0,
    netNegative: netCents < 0,
    grossSpent: grossCents / 100,
    refundReceived: refundCents / 100,
    categoryBudgetTotal: Object.keys(budgetMap).reduce(function (sum, name) {
      return sum + budgetMap[name]
    }, 0) / 100,
    categoryCount: categories.length,
    overBudgetCount: overCategories.length,
    unbudgetedCount: unbudgeted.length,
    budgetedWithoutSpendCount: categories.filter(function (row) { return row.hasBudget && row.noSpend }).length,
    overallStatus: overallStatus,
    overallLabel: STATUS_TEXT[overallStatus],
    categories: categories,
    suggestions: suggestions
  }
  var scope = cleanText(options.scopeLabel, '当前账本范围').slice(0, 80)
  result.reportText = buildReport(ym, scope, result)
  return result
}

function trendMonthCount(value) {
  if (value === undefined || value === null || value === '' || typeof value === 'boolean') return 6
  var count = Number(value)
  if (!isFinite(count) || count <= 0) return 6
  return Math.max(1, Math.floor(count))
}

function buildTrendReport(endYm, monthCount, scope, months) {
  var title = validYm(endYm) ? format.monthLabel(endYm) : '未知月份'
  var lines = [
    '预算执行偏差趋势 · 近 ' + monthCount + ' 个月',
    '截止月份：' + title,
    '统计范围：' + scope,
    '口径：本月支出 − 本月到账退款；退款抵减原付款分类，跨月退款按到账月计入。收入与转账不计入支出。',
    '差额 = 预算 − 实际净支出；正数为结余，负数为超支。净支出为负时使用率按 0% 展示。',
    '预算仅按本次传入的数值或月份映射计算；未提供的月份标记为未设置，不补算历史预算。',
    ''
  ]
  if (!months.length) lines.push('（结束月份无效，无法生成趋势）')
  months.forEach(function (row) {
    lines.push('- ' + row.month + '：预算 ' + (row.hasBudget ? currency(row.budget) : '未设置') +
      '，实际净支出 ' + currency(row.actualNetSpend, true) +
      '，差额 ' + (row.hasBudget ? currency(row.variance, true) : '--') +
      '，使用率 ' + rateText(row.usageRate) + '，' + row.statusText + '。')
  })
  return lines.join('\n')
}

/* 趋势只比较总预算与总净支出；分类预算不会反向补出缺失的总预算。 */
function calculateTrend(txs, endYm, monthCount, monthlyBudgetOrMap, categoryBudgets, options) {
  options = options && typeof options === 'object' ? options : {}
  endYm = validYm(endYm) ? String(endYm) : ''
  monthCount = trendMonthCount(monthCount)
  var scope = cleanText(options.scopeLabel, '当前账本范围').slice(0, 80)
  if (!endYm) {
    return {
      endYm: '',
      monthCount: monthCount,
      months: [],
      budgetedMonthCount: 0,
      missingBudgetMonthCount: 0,
      hasData: false,
      reportText: buildTrendReport('', monthCount, scope, [])
    }
  }

  var rows = normalizeRows(txs)
  /* 完整账本只配对一次，再供各月复用，确保跨月退款仍归到到账月。 */
  var projected = Array.isArray(options.projected)
    ? normalizeRows(options.projected) : stats.ledger(rows, true)
  var monthOptions = Object.assign({}, options, { projected: projected })
  var budgetIsMap = monthlyBudgetOrMap && typeof monthlyBudgetOrMap === 'object' && !Array.isArray(monthlyBudgetOrMap)
  var months = []
  for (var offset = monthCount - 1; offset >= 0; offset--) {
    var ym = format.shiftMonth(endYm, -offset)
    var budget = 0
    if (budgetIsMap) {
      if (Object.prototype.hasOwnProperty.call(monthlyBudgetOrMap, ym)) budget = budgetCents(monthlyBudgetOrMap[ym])
    } else {
      budget = budgetCents(monthlyBudgetOrMap)
    }
    var result = calculate(rows, ym, budget / 100, categoryBudgets, monthOptions)
    var status = result.hasBudget ? result.overallStatus : STATUS.UNBUDGETED
    months.push({
      ym: ym,
      month: format.monthLabel(ym),
      label: ym.slice(5) + '月',
      budget: result.totalBudget,
      totalBudget: result.totalBudget,
      actualNetSpend: result.actualNetSpend,
      variance: result.variance,
      variancePct: result.variancePct,
      usageRate: result.usageRate,
      status: status,
      statusText: result.hasBudget ? result.overallLabel : STATUS_TEXT[STATUS.UNBUDGETED],
      hasBudget: result.hasBudget,
      hasData: result.hasData,
      netNegative: result.netNegative,
      grossSpent: result.grossSpent,
      refundReceived: result.refundReceived,
      remaining: result.remaining,
      overspend: result.overspend,
      barPct: result.barPct
    })
  }
  var budgetedMonthCount = months.filter(function (row) { return row.hasBudget }).length
  return {
    endYm: endYm,
    monthCount: monthCount,
    months: months,
    budgetedMonthCount: budgetedMonthCount,
    missingBudgetMonthCount: monthCount - budgetedMonthCount,
    hasData: months.some(function (row) { return row.hasData }),
    reportText: buildTrendReport(endYm, monthCount, scope, months)
  }
}

module.exports = {
  calculate: calculate,
  calculateTrend: calculateTrend,
  STATUS: STATUS,
  DEFAULT_NEAR_THRESHOLD: DEFAULT_NEAR_THRESHOLD
}
