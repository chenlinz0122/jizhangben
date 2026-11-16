var format = require('./format')
var category = require('./category')

function emptyCatMap() {
  return {}
}

function bump(map, name, amount) {
  if (!map[name]) map[name] = { name: name, amount: 0, count: 0 }
  map[name].amount += amount
  map[name].count++
}

function toList(map, total) {
  var list = Object.keys(map).map(function (k) { return map[k] })
  list.sort(function (a, b) { return b.amount - a.amount })
  if (!total) total = list.reduce(function (s, c) { return s + c.amount }, 0) || 1
  list.forEach(function (c) {
    c.pct = Math.round((c.amount / total) * 1000) / 10
    c.amountText = format.money(c.amount)
    c.color = category.colorOf(c.name)
  })
  return list
}

/**
 * 某个月的汇总
 */
function summary(txs, ym) {
  var income = 0
  var expense = 0
  var refund = 0
  var transfer = 0
  var count = 0
  var expMap = emptyCatMap()
  var incMap = emptyCatMap()
  var trMap = emptyCatMap()

  for (var i = 0; i < txs.length; i++) {
    var t = txs[i]
    if (t.ym !== ym) continue
    count++
    if (t.type === 'income') {
      income += t.amount
      bump(incMap, t.category, t.amount)
    } else if (t.type === 'expense') {
      expense += t.amount
      bump(expMap, t.category, t.amount)
    } else if (t.type === 'refund') {
      refund += t.amount
      bump(incMap, '退款', t.amount)
    } else {
      transfer += t.amount
      bump(trMap, t.category || '转账', t.amount)
    }
  }

  /* 口径：退款算进账，支出按原样统计、不再被退款抵扣
   *   进账 = 收入 + 退款   支出 = 花的原价   结余 = 进账 - 支出 */
  var incomeTotal = income + refund
  var netExpense = Math.max(expense - refund, 0)
  var expList = toList(expMap)
  var incList = toList(incMap)
  var trList = toList(trMap)

  /* 不计收支的三类分项（对齐官方：理财 / 借还款 / 账户转移） */
  var invest = 0
  var loan = 0
  var acct = 0
  for (var x = 0; x < trList.length; x++) {
    if (trList[x].name === '理财') invest += trList[x].amount
    else if (trList[x].name === '借还款') loan += trList[x].amount
    else acct += trList[x].amount
  }

  return {
    ym: ym,
    count: count,
    income: income,
    incomeTotal: incomeTotal,
    expenseGross: expense,
    refund: refund,
    expense: expense,
    expenseNet: netExpense,
    transfer: transfer,
    invest: invest,
    loan: loan,
    acct: acct,
    net: incomeTotal - expense,
    byCat: expList,
    byIncome: incList,
    byTransfer: trList,
    uncatCount: (function () {
      var c = 0
      for (var k = 0; k < txs.length; k++) {
        if (txs[k].ym === ym && txs[k].type === 'expense' && txs[k].category === '未分类') c++
      }
      return c
    })()
  }
}

/**
 * 近 n 个月趋势（含当前月）
 */
function trend(txs, ym, n) {
  var out = []
  for (var i = n - 1; i >= 0; i--) {
    var m = format.shiftMonth(ym, -i)
    var s = summary(txs, m)
    out.push({
      ym: m,
      label: m.split('-')[1] + '月',
      income: s.incomeTotal,
      expense: s.expense,
      net: s.net
    })
  }
  return out
}

function daysInMonth(ym) {
  var p = ym.split('-')
  return new Date(parseInt(p[0], 10), parseInt(p[1], 10), 0).getDate()
}

/* 本月每天的支出与入账热力（退款计入入账，不冲减当天支出） */
function calendar(txs, ym) {
  var p = ym.split('-')
  var y = parseInt(p[0], 10)
  var m = parseInt(p[1], 10)
  var days = new Date(y, m, 0).getDate()
  var firstWeekday = new Date(y, m - 1, 1).getDay()

  var arr = []
  for (var d = 1; d <= days; d++) {
    arr.push({ d: d, amount: 0, income: 0, level: 0 })
  }

  for (var i = 0; i < txs.length; i++) {
    var t = txs[i]
    if (t.ym !== ym) continue
    var dd = parseInt(String(t.day).split('-')[2], 10)
    var cell = arr[dd - 1]
    if (!cell) continue
    if (t.type === 'expense') cell.amount += t.amount
    else if (t.type === 'refund') cell.income += t.amount
    else if (t.type === 'income') cell.income += t.amount
  }

  var max = 0
  for (var k = 0; k < arr.length; k++) {
    if (arr[k].amount > 0 && arr[k].amount > max) max = arr[k].amount
  }
  for (var j = 0; j < arr.length; j++) {
    var a = arr[j].amount
    if (a < 0) { arr[j].amount = 0; a = 0 }
    if (a > 0.01) {
      arr[j].level = Math.min(4, Math.max(1, Math.ceil((a / (max || 1)) * 4)))
    }
    arr[j].amountText = format.money(arr[j].amount)
    arr[j].incomeText = format.money(arr[j].income)
  }

  /* 前面补空格子，让 1 号落在正确的星期几 */
  var lead = []
  for (var b = 0; b < firstWeekday; b++) lead.push({ blank: true })
  var cells = lead.concat(arr)

  return { cells: cells, days: arr, firstWeekday: firstWeekday, max: max, dim: days }
}

/* 日均、最大一笔、工作日 vs 周末、有消费的天数 */
function insights(txs, ym) {
  var nowYm = format.ymOf(Date.now())
  var elapsed = ym === nowYm ? new Date().getDate() : daysInMonth(ym)

  var expense = 0
  var refund = 0
  var count = 0
  var maxTx = null
  var weekday = 0
  var weekend = 0
  var daySet = {}

  for (var i = 0; i < txs.length; i++) {
    var t = txs[i]
    if (t.ym !== ym) continue
    if (t.type === 'refund') { refund += t.amount; continue }
    if (t.type !== 'expense') continue

    expense += t.amount
    count++
    daySet[t.day] = true
    var wd = new Date(t.time).getDay()
    if (wd === 0 || wd === 6) weekend += t.amount
    else weekday += t.amount

    if (!maxTx || t.amount > maxTx.amount) maxTx = t
  }

  var net = expense   /* 退款已算进账，这里就是原价支出 */

  return {
    net: net,
    avgDaily: elapsed > 0 ? net / elapsed : 0,
    elapsed: elapsed,
    maxTx: maxTx,
    weekday: weekday,
    weekend: weekend,
    spentDays: Object.keys(daySet).length,
    count: count
  }
}

/* 分类环比：这个类目比上个月多了还是少了 */
function compareCats(txs, ym) {
  var prev = summary(txs, format.shiftMonth(ym, -1))
  var map = {}
  for (var i = 0; i < prev.byCat.length; i++) {
    map[prev.byCat[i].name] = prev.byCat[i].amount
  }
  map.__total = prev.expense

  return {
    prevTotal: prev.expense,
    amountOf: function (name) {
      return map[name] || 0
    }
  }
}

/* 花得最多的商户 */
function topMerchants(txs, ym, n) {
  var map = {}
  for (var i = 0; i < txs.length; i++) {
    var t = txs[i]
    if (t.ym !== ym || t.type !== 'expense') continue
    var key = String(t.merchant || '未知').trim()
    if (!map[key]) map[key] = { name: key, amount: 0, count: 0 }
    map[key].amount += t.amount
    map[key].count++
  }
  var list = Object.keys(map).map(function (k) { return map[k] })
  list.sort(function (a, b) { return b.amount - a.amount })
  var top = list.slice(0, n || 5)
  for (var j = 0; j < top.length; j++) {
    top[j].amountText = format.money(top[j].amount)
  }
  return top
}

/* 数据体检：查本地流水有没有重复、是哪条路进来的
 * 判重口径只用于「提示」，不自动删数据 —— 同日同额同商户也可能是真两笔 */
function audit(txs) {
  var out = {
    total: txs.length,
    bySource: {},
    byIdKind: { bill: 0, shot: 0 },   /* b = 账单文件（有交易单号），h = 截图 */
    dupGroups: 0,
    dupExtra: 0,
    trimZero: 0,
    list: []
  }

  var groups = {}
  for (var i = 0; i < txs.length; i++) {
    var t = txs[i]
    var src = t.source || '未知'
    out.bySource[src] = (out.bySource[src] || 0) + 1
    if (String(t.id || '').charAt(0) === 'b') out.byIdKind.bill++
    else out.byIdKind.shot++
    if (!(t.amount > 0)) out.trimZero++

    var k = t.day + '|' + Math.round(Number(t.amount) * 100) + '|' + (t.merchant || '') + '|' + (t.type || '')
    if (!groups[k]) groups[k] = []
    groups[k].push(t)
  }

  for (var k2 in groups) {
    if (!Object.prototype.hasOwnProperty.call(groups, k2)) continue
    var g = groups[k2]
    if (g.length < 2) continue
    out.dupGroups++
    out.dupExtra += g.length - 1
    if (out.list.length < 5) {
      out.list.push({
        merchant: g[0].merchant,
        day: g[0].day,
        count: g.length,
        amountText: format.money(g[0].amount),
        sources: (function () {
          var s = []
          for (var i = 0; i < g.length; i++) {
            var v = (g[i].source || '?') + '(' + String(g[i].id || '').charAt(0) + ')'
            if (s.indexOf(v) < 0) s.push(v)
          }
          return s.join(' ')
        })()
      })
    }
  }

  return out
}

/* 年度汇总：当前自然年的支出 / 入账 / 结余 + 支出 Top3 分类 */
function yearSummary(txs, year) {
  var expense = 0
  var income = 0
  var refund = 0
  var count = 0
  var expMap = emptyCatMap()

  for (var i = 0; i < txs.length; i++) {
    var t = txs[i]
    if (String(t.ym || '').indexOf(year) !== 0) continue
    count++
    if (t.type === 'expense') {
      expense += t.amount
      bump(expMap, t.category, t.amount)
    } else if (t.type === 'income') {
      income += t.amount
    } else if (t.type === 'refund') {
      refund += t.amount
    }
  }

  var incomeTotal = income + refund
  var net = incomeTotal - expense
  var top = toList(expMap, expense).slice(0, 3).map(function (c) {
    return { name: c.name, amountText: c.amountText, icon: category.iconOf(c.name), color: c.color }
  })

  return {
    year: year,
    count: count,
    expense: expense,
    incomeTotal: incomeTotal,
    net: net,
    expenseText: format.money(expense),
    incomeText: format.money(incomeTotal),
    netText: format.money(Math.abs(net)),
    netSign: net < 0 ? '-' : '',
    top: top
  }
}

module.exports = {
  summary: summary,
  trend: trend,
  calendar: calendar,
  insights: insights,
  compareCats: compareCats,
  topMerchants: topMerchants,
  yearSummary: yearSummary,
  audit: audit
}
