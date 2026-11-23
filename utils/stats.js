var format = require('./format')
var category = require('./category')
var prefs = require('./prefs')
var refundpair = require('./refundpair')

function emptyMap() {
  return Object.create(null)
}

function cents(value) {
  var n = Number(value) || 0
  if (!isFinite(n)) return 0
  return ((n < 0 ? -1 : 1) * Math.round(Math.abs(n) * 100 + 1e-8)) || 0
}

function clone(t) {
  var row = {}
  Object.keys(t).forEach(function (key) { row[key] = t[key] })
  return row
}

/* 配对只借用付款的分类和商户，退款始终记在退款发生日。 */
function ledger(txs, exclude) {
  if (exclude === undefined) exclude = prefs.refundExcluded()
  var raw = txs.map(function (t) {
    var row = clone(t)
    row.amount = cents(t.amount) / 100
    return row
  })
  if (!exclude) {
    raw.forEach(function (t) {
      if (t.type === 'refund') {
        if (t.category && t.category !== '退款') t.originalCategory = t.category
        t.category = '退款'
      }
    })
    return raw
  }

  var byRefund = emptyMap()
  refundpair.pair(raw).pairs.forEach(function (p) {
    var key = String(p.refund.id)
    if (!byRefund[key]) byRefund[key] = []
    byRefund[key].push(p)
  })

  var rows = []
  raw.forEach(function (t, index) {
    if (t.type !== 'refund') { rows.push(t); return }
    var remain = cents(t.amount)
    var allocations = byRefund[String(t.id)] || []
    var part = 0
    function adjustment(amount, expense) {
      var row = clone(t)
      row.type = 'expense'
      row.amount = (-amount / 100) || 0
      row.originalCategory = t.originalCategory || t.category || '退款'
      row.originalMerchant = t.merchant || ''
      row.category = expense ? (expense.category || '未分类') : '未配对退款'
      if (expense) row.merchant = expense.merchant
      row.refundAdjustment = true
      row.refundMatched = !!expense
      row.entryId = 'refund:' + JSON.stringify([t.id, index, part++])
      rows.push(row)
    }
    allocations.forEach(function (p) {
      if (p.refund !== t) return
      var amount = Math.min(remain, cents(p.amount))
      if (amount <= 0) return
      adjustment(amount, p.expense)
      remain -= amount
    })
    if (remain !== 0 || part === 0) adjustment(remain, null)
  })
  return rows
}

/* 输入必须已经投影；拆分退款按原始 id 只计一笔。 */
function totals(rows) {
  var expense = 0
  var income = 0
  var refundAdjustment = 0
  var ids = emptyMap()
  rows.forEach(function (t) {
    ids[String(t.id)] = true
    var amount = cents(t.amount)
    if (t.type === 'expense') expense += amount
    else if (t.type === 'income' || t.type === 'refund') income += amount
    if (t.refundAdjustment) refundAdjustment += Math.abs(amount)
  })
  return {
    expense: expense / 100,
    income: income / 100,
    count: Object.keys(ids).length,
    refundAdjustment: refundAdjustment / 100
  }
}

function bump(map, name, amount, id) {
  if (!map[name]) map[name] = { name: name, amount: 0, count: 0, ids: emptyMap() }
  map[name].amount = (cents(map[name].amount) + cents(amount)) / 100
  var key = String(id)
  if (!map[name].ids[key]) { map[name].ids[key] = true; map[name].count++ }
}

function toList(map) {
  var list = Object.keys(map).map(function (k) { return { name: map[k].name, amount: map[k].amount, count: map[k].count } })
  list.sort(function (a, b) { return b.amount - a.amount })
  var positive = list.reduce(function (sum, c) { return sum + Math.max(cents(c.amount), 0) }, 0)
  list.forEach(function (c) {
    c.pct = c.amount > 0 && positive > 0 ? Math.round(cents(c.amount) / positive * 1000) / 10 : 0
    c.amountText = format.signedMoney(c.amount)
    var color = category.colorOf(c.name)
    c.color = typeof color === 'string' ? color : category.colorOf('未分类')
  })
  return list
}

function aggregate(raw, rows) {
  var total = totals(rows)
  var income = 0
  var expense = 0
  var refund = 0
  var transfer = 0
  var uncatCount = 0
  var expMap = emptyMap()
  var incMap = emptyMap()
  var trMap = emptyMap()
  raw.forEach(function (t) {
    if (t.type === 'expense') {
      expense += cents(t.amount)
      if (t.category === '未分类') uncatCount++
    } else if (t.type === 'refund') refund += cents(t.amount)
    else if (t.type === 'income') income += cents(t.amount)
  })
  rows.forEach(function (t) {
    if (t.type === 'expense') bump(expMap, t.category || '未分类', t.amount, t.id)
    else if (t.type === 'income' || t.type === 'refund') bump(incMap, t.category || '未分类', t.amount, t.id)
    else {
      transfer += cents(t.amount)
      bump(trMap, t.category || '转账', t.amount, t.id)
    }
  })

  var trList = toList(trMap)
  var invest = 0
  var loan = 0
  var acct = 0
  trList.forEach(function (t) {
    if (t.name === '理财') invest += cents(t.amount)
    else if (t.name === '借还款') loan += cents(t.amount)
    else acct += cents(t.amount)
  })
  return {
    count: total.count,
    income: income / 100,
    incomeTotal: total.income,
    expenseGross: expense / 100,
    refund: refund / 100,
    expense: total.expense,
    expenseNet: (expense - refund) / 100,
    transfer: transfer / 100,
    invest: invest / 100,
    loan: loan / 100,
    acct: acct / 100,
    net: (cents(total.income) - cents(total.expense)) / 100,
    byCat: toList(expMap),
    byIncome: toList(incMap),
    byTransfer: trList,
    uncatCount: uncatCount
  }
}

function summary(txs, ym) {
  var outRefund = prefs.refundExcluded()
  function inMonth(t) { return t.ym === ym }
  var out = aggregate(txs.filter(inMonth), ledger(txs, outRefund).filter(inMonth))
  out.ym = ym
  out.refundOut = outRefund
  return out
}

/* 近 n 个月趋势（含当前月）。 */
function trend(txs, ym, n) {
  var out = []
  var rows = ledger(txs)
  for (var i = n - 1; i >= 0; i--) {
    var m = format.shiftMonth(ym, -i)
    var s = totals(rows.filter(function (t) { return t.ym === m }))
    out.push({
      ym: m,
      label: m.split('-')[1] + '月',
      income: s.income,
      expense: s.expense,
      net: (cents(s.income) - cents(s.expense)) / 100
    })
  }
  return out
}

function daysInMonth(ym) {
  var p = ym.split('-')
  return new Date(parseInt(p[0], 10), parseInt(p[1], 10), 0).getDate()
}

/* 金额保留负数，热力只画正支出。 */
function calendar(txs, ym) {
  var p = ym.split('-')
  var y = parseInt(p[0], 10)
  var m = parseInt(p[1], 10)
  var days = daysInMonth(ym)
  var firstWeekday = new Date(y, m - 1, 1).getDay()
  var arr = []
  for (var d = 1; d <= days; d++) arr.push({ d: d, amount: 0, income: 0, level: 0 })

  ledger(txs).forEach(function (t) {
    if (t.ym !== ym) return
    var dd = parseInt(String(t.day).split('-')[2], 10)
    var cell = arr[dd - 1]
    if (!cell) return
    if (t.type === 'expense') cell.amount += cents(t.amount)
    else if (t.type === 'income' || t.type === 'refund') cell.income += cents(t.amount)
  })

  var max = 0
  arr.forEach(function (cell) {
    cell.amount /= 100
    cell.income /= 100
    if (cell.amount > max) max = cell.amount
  })
  arr.forEach(function (cell) {
    if (cell.amount > 0) cell.level = Math.min(4, Math.max(1, Math.ceil(cell.amount / max * 4)))
    cell.amountText = format.signedMoney(cell.amount)
    cell.incomeText = format.signedMoney(cell.income)
  })

  var lead = []
  for (var b = 0; b < firstWeekday; b++) lead.push({ blank: true })
  return { cells: lead.concat(arr), days: arr, firstWeekday: firstWeekday, max: max, dim: days }
}

/* 净支出按现金流日期；最大一笔和消费天数仍看原始付款。 */
function insights(txs, ym) {
  var nowYm = format.ymOf(Date.now())
  var elapsed = ym === nowYm ? new Date().getDate() : daysInMonth(ym)
  var rows = ledger(txs, true).filter(function (t) { return t.ym === ym })
  var net = totals(rows).expense
  var maxTx = null
  var weekday = 0
  var weekend = 0
  var daySet = emptyMap()
  var paymentIds = emptyMap()

  rows.forEach(function (t) {
    if (t.type !== 'expense') return
    var wd = new Date(t.day ? t.day + 'T12:00:00' : t.time).getDay()
    if (wd === 0 || wd === 6) weekend += cents(t.amount)
    else weekday += cents(t.amount)
  })
  txs.forEach(function (t) {
    if (t.ym !== ym || t.type !== 'expense') return
    paymentIds[String(t.id)] = true
    if (cents(t.amount) <= 0) return
    daySet[t.day] = true
    if (!maxTx || cents(t.amount) > cents(maxTx.amount)) maxTx = t
  })

  return {
    net: net,
    avgDaily: elapsed > 0 ? cents(net / elapsed) / 100 : 0,
    elapsed: elapsed,
    maxTx: maxTx,
    weekday: weekday / 100,
    weekend: weekend / 100,
    spentDays: Object.keys(daySet).length,
    count: Object.keys(paymentIds).length
  }
}

function compareCats(txs, ym) {
  var prev = summary(txs, format.shiftMonth(ym, -1))
  var map = emptyMap()
  prev.byCat.forEach(function (c) { map[c.name] = c.amount })
  return {
    prevTotal: prev.expense,
    amountOf: function (name) { return map[name] || 0 }
  }
}

function topMerchants(txs, ym, n) {
  var map = emptyMap()
  ledger(txs).forEach(function (t) {
    if (t.ym !== ym || t.type !== 'expense') return
    bump(map, String(t.merchant || '未知').trim(), t.amount, t.id)
  })
  var list = Object.keys(map).map(function (k) { return { name: map[k].name, amount: map[k].amount, count: map[k].count } })
  list.sort(function (a, b) { return b.amount - a.amount })
  var top = list.slice(0, n || 5)
  top.forEach(function (t) { t.amountText = format.signedMoney(t.amount) })
  return top
}

/* 判重只用于提示；无法识别归属的旧成员记录不互相判重。 */
function audit(txs) {
  var out = {
    total: txs.length,
    bySource: emptyMap(),
    byIdKind: { bill: 0, shot: 0 },
    dupGroups: 0,
    dupExtra: 0,
    trimZero: 0,
    list: []
  }

  var groups = emptyMap()
  for (var i = 0; i < txs.length; i++) {
    var t = txs[i]
    var src = t.source || '未知'
    out.bySource[src] = (out.bySource[src] || 0) + 1
    if (String(t.id || '').charAt(0) === 'b') out.byIdKind.bill++
    else out.byIdKind.shot++
    if (!(t.amount > 0)) out.trimZero++

    var owner = t.ownerKey ? ['owner', t.ownerKey] : ['self']
    if (!t.ownerKey && t.byMe === false) owner = ['legacy', t.shareId || t.id || i]
    var k = JSON.stringify([t.byMe === false, owner, t.shareBook || '', t.day,
      cents(t.amount), t.merchant || '', t.type || ''])
    if (!groups[k]) groups[k] = []
    groups[k].push(t)
  }

  Object.keys(groups).forEach(function (key) {
    var g = groups[key]
    if (g.length < 2) return
    out.dupGroups++
    out.dupExtra += g.length - 1
    if (out.list.length < 5) {
      var sources = []
      g.forEach(function (t) {
        var v = (t.source || '?') + '(' + String(t.id || '').charAt(0) + ')'
        if (sources.indexOf(v) < 0) sources.push(v)
      })
      out.list.push({
        merchant: g[0].merchant,
        day: g[0].day,
        count: g.length,
        amountText: format.signedMoney(g[0].amount),
        sources: sources.join(' ')
      })
    }
  })
  return out
}

function rankList(list) {
  return list.map(function (c) {
    var bar = Math.max(Math.round(c.pct), 0)
    if (bar > 0 && bar < 4) bar = 4
    var icon = category.iconOf(c.name)
    return {
      name: c.name,
      amount: c.amount,
      amountText: c.amountText,
      icon: typeof icon === 'string' ? icon : category.iconOf('其他支出'),
      color: c.color,
      count: c.count,
      pct: c.pct,
      barPct: bar,
      negative: c.amount < 0
    }
  })
}

function yearSummary(txs, year) {
  var outRefund = prefs.refundExcluded()
  function inYear(t) { return String(t.ym || '').split('-')[0] === String(year) }
  var s = aggregate(txs.filter(inYear), ledger(txs, outRefund).filter(inYear))
  var topAll = rankList(s.byCat)
  return {
    year: year,
    count: s.count,
    expense: s.expense,
    expenseGross: s.expenseGross,
    expenseNet: s.expenseNet,
    income: s.income,
    refund: s.refund,
    incomeTotal: s.incomeTotal,
    net: s.net,
    expenseText: format.signedMoney(s.expense),
    incomeText: format.signedMoney(s.incomeTotal),
    netText: format.money(Math.abs(s.net)),
    netSign: s.net < 0 ? '-' : '',
    top: topAll.slice(0, 3),
    topAll: topAll,
    topAllIn: rankList(s.byIncome),
    refundOut: outRefund
  }
}

/* 仅预算消耗总额夹到零，分类净额保留负数。 */
function budgetSpent(txs, ym) {
  var expense = 0
  var refund = 0
  var matched = 0
  var byCat = emptyMap()
  txs.forEach(function (t) {
    if (t.ym !== ym) return
    if (t.type === 'expense') expense += cents(t.amount)
    else if (t.type === 'refund') refund += cents(t.amount)
  })
  ledger(txs, true).forEach(function (t) {
    if (t.ym !== ym || t.type !== 'expense') return
    var cat = t.category || '未分类'
    byCat[cat] = (byCat[cat] || 0) + cents(t.amount)
    if (t.refundAdjustment && t.refundMatched) matched -= cents(t.amount)
  })
  Object.keys(byCat).forEach(function (cat) { byCat[cat] /= 100 })
  return {
    expense: expense / 100,
    refund: refund / 100,
    net: Math.max(expense - refund, 0) / 100,
    matched: matched / 100,
    unmatched: (refund - matched) / 100,
    byCat: byCat
  }
}

/* AI 只处理本人可编辑的未分类付款。 */
function uncatGroups(txs, limit) {
  var cap = limit || 60
  var map = emptyMap()
  var noMerchant = 0
  for (var i = 0; i < txs.length; i++) {
    var t = txs[i]
    if (t.byMe === false || t.type !== 'expense' || t.category !== '未分类') continue
    var key = String(t.merchant || '').trim()
    if (key.length < 2) { noMerchant++; continue }
    if (!map[key]) map[key] = { key: key, count: 0, amount: 0, desc: '' }
    map[key].count++
    map[key].amount += cents(t.amount)
    if (!map[key].desc && t.desc) map[key].desc = String(t.desc).slice(0, 24)
  }

  var keys = Object.keys(map).sort(function (a, b) { return map[b].count - map[a].count })
  var picked = keys.slice(0, cap)
  return {
    items: picked.map(function (k, idx) {
      return {
        i: idx + 1,
        m: map[k].key,
        d: map[k].desc,
        key: map[k].key,
        count: map[k].count,
        amountText: format.signedMoney(map[k].amount / 100)
      }
    }),
    total: keys.length,
    overflow: keys.length > picked.length,
    noMerchant: noMerchant
  }
}

module.exports = {
  ledger: ledger,
  totals: totals,
  summary: summary,
  trend: trend,
  calendar: calendar,
  insights: insights,
  compareCats: compareCats,
  topMerchants: topMerchants,
  yearSummary: yearSummary,
  budgetSpent: budgetSpent,
  uncatGroups: uncatGroups,
  audit: audit
}
