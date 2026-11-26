/* 共同账本结算：输入金额为元，输出金额一律为分。
 * paid = 本人正支出 - 本人正退款；share = 按权重（默认平均）分摊的净支出；
 * balance = paid - share，负数表示应付、正数表示应收。
 * 权重只认 ownerKey；缺失、无效或未知成员按 0 处理，全为 0 时回退平均分摊。
 * options.categoryWeights 为“分类 -> 成员权重”映射；覆盖分类各自结算净支出，
 * 其余分类合并后按 options.weights 结算，全部分摊均以整数分相加。
 */
var MAX_CENTS = Number.MAX_SAFE_INTEGER
var MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

function map() { return Object.create(null) }

function ownerKeyOf(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

/* 超过安全整数范围的金额不参与结算，避免浮点精度破坏“按分”和转账守恒。 */
function cents(value) {
  var n = Number(value)
  if (!isFinite(n) || n <= 0) return 0
  var scaled = n * 100
  if (!isFinite(scaled) || scaled > MAX_CENTS) return 0
  return Math.min(MAX_CENTS, Math.max(0, Math.round(scaled + 1e-8)))
}

function safeAdd(a, b) {
  var sum = a + b
  return Number.isSafeInteger(sum) ? sum : null
}

function monthOf(tx) {
  if (MONTH_RE.test(String(tx.ym || ''))) return tx.ym
  if (MONTH_RE.test(String(tx.day || '').slice(0, 7))) return String(tx.day).slice(0, 7)
  var time = Number(tx.time)
  if (isFinite(time) && !isNaN(new Date(time).getTime())) {
    var d = new Date(time)
    return d.getFullYear() + '-' + (d.getMonth() < 9 ? '0' : '') + (d.getMonth() + 1)
  }
  return ''
}

function normalizeMembers(list) {
  var members = []
  var byOwner = map()
  var me = null
  var i
  for (i = 0; i < (Array.isArray(list) ? list.length : 0); i++) {
    var raw = list[i]
    if (!raw || typeof raw !== 'object') continue
    var key = ownerKeyOf(raw.ownerKey)
    if (!key && raw.isMe) key = '__me__'
    /* __me__ 只允许作为本机成员的稳定身份或本机流水别名。 */
    if (!key || (key === '__me__' && !raw.isMe) || byOwner[key]) continue
    var member = {
      ownerKey: key,
      name: String(raw.name || raw.nickname || '成员'),
      nickname: String(raw.nickname || raw.name || '成员'),
      isMe: !!raw.isMe,
      paid: 0,
      expense: 0,
      refund: 0,
      share: 0,
      balance: 0,
      index: members.length
    }
    members.push(member)
    byOwner[key] = member
    if (member.isMe && !me) me = member
  }
  return { members: members, byOwner: byOwner, me: me }
}

function resolveOwner(tx, normalized) {
  var key = ownerKeyOf(tx.ownerKey)
  if (key) {
    if (key === '__me__') return normalized.me
    return normalized.byOwner[key] || null
  }
  /* 只有明确是他人的流水不能借用本机别名；旧本机流水没有 ownerKey。 */
  return tx.byMe === false ? null : normalized.me
}

/* 把十进制权重转成精确整数，避免 0.1 + 0.2 之类的浮点误差影响分余数。 */
function decimalWeight(value) {
  var text = typeof value === 'number' ? String(value) : (typeof value === 'string' ? value.trim() : '')
  if (!/^\+?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text) || !isFinite(Number(text)) || Number(text) <= 0) return null
  var parts = text.toLowerCase().split('e')
  var mantissa = parts[0].replace(/^\+/, '')
  var exponent = parts.length > 1 ? Number(parts[1]) : 0
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 1000 || typeof BigInt !== 'function') return null
  var bits = mantissa.split('.')
  var fraction = bits[1] || ''
  var digits = (bits[0] + fraction).replace(/^0+/, '') || '0'
  var scale = fraction.length - exponent
  /* 限制异常输入规模；普通数值和页面输入的精度远低于此限制。 */
  if (digits.length > 100 || Math.abs(scale) > 1000) return null
  var coefficient = BigInt(digits)
  if (coefficient <= BigInt(0)) return null
  return { coefficient: coefficient, scale: scale, weight: Number(text) }
}

function normalizeWeights(list, options) {
  var out = { mode: 'equal', weights: map(), warnings: [], fallback: false }
  var supplied = options && options.weights
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) {
    if (supplied !== undefined && supplied !== null) out.warnings.push('权重格式无效，已回退为平均分摊')
    out.fallback = out.warnings.length > 0
    return out
  }
  var keys = Object.keys(supplied)
  if (!keys.length) return out

  var values = []
  var commonScale = 0
  var positive = 0
  list.forEach(function (member) {
    var raw
    try { raw = Object.prototype.hasOwnProperty.call(supplied, member.ownerKey) ? supplied[member.ownerKey] : undefined } catch (e) { raw = undefined }
    if (raw === undefined || raw === null || raw === '') {
      values.push({ weight: 0 })
      return
    }
    /* 0 是有效的“不参与”，其余非正数、非有限值和无法解析的文本均忽略。 */
    if (raw === 0 || raw === '0' || raw === '0.0') {
      values.push({ weight: 0 })
      return
    }
    var parsed = decimalWeight(raw)
    if (!parsed) {
      values.push({ weight: 0 })
      out.warnings.push('成员 ' + member.name + '（' + member.ownerKey + '）的权重无效，已按 0 处理')
      return
    }
    commonScale = Math.max(commonScale, parsed.scale)
    positive++
    out.weights[member.ownerKey] = parsed.weight
    values.push(parsed)
  })
  keys.forEach(function (key) {
    var known = false
    for (var i = 0; i < list.length; i++) if (list[i].ownerKey === key) { known = true; break }
    if (!known) out.warnings.push('权重 ' + key + ' 没有对应成员，已忽略')
  })
  if (!positive) {
    out.mode = 'equal'
    out.weights = map()
    out.fallback = true
    out.warnings.push('所有权重均无效或为 0，已回退为平均分摊')
    return out
  }
  out.mode = 'weighted'
  out.values = values
  out.total = values.reduce(function (sum, item) {
    if (!item.coefficient) return sum
    var unit = item.coefficient
    var power = commonScale - item.scale
    for (var i = 0; i < power; i++) unit *= BigInt(10)
    return sum + unit
  }, BigInt(0))
  return out
}

/* 最大余数法：先取整数分，再把余分给小数余量最大者；同量按成员顺序。 */
function weightedShares(total, weightState) {
  var absolute = total < 0 ? -total : total
  var amount = BigInt(absolute)
  var shares = []
  var remainders = []
  var assigned = 0
  weightState.values.forEach(function (item, index) {
    if (!item.coefficient) { shares.push(0); remainders.push(BigInt(0)); return }
    var unit = item.coefficient
    var power = weightState.commonScale - item.scale
    for (var i = 0; i < power; i++) unit *= BigInt(10)
    var product = amount * unit
    var base = product / weightState.total
    remainders.push(product % weightState.total)
    shares.push(Number(base))
    assigned += Number(base)
  })
  var order = remainders.map(function (value, index) { return { index: index, value: value } })
  order.sort(function (a, b) {
    if (a.value > b.value) return -1
    if (a.value < b.value) return 1
    return a.index - b.index
  })
  var left = absolute - assigned
  for (var i = 0; i < left; i++) shares[order[i].index]++
  return shares.map(function (share) { return share === 0 ? 0 : (total < 0 ? -share : share) })
}

function greedyTransfers(members) {
  var debtors = members.filter(function (m) { return m.balance < 0 }).map(function (m) {
    return { member: m, left: -m.balance, index: m.index }
  })
  var creditors = members.filter(function (m) { return m.balance > 0 }).map(function (m) {
    return { member: m, left: m.balance, index: m.index }
  })
  debtors.sort(function (a, b) { return b.left - a.left || a.index - b.index })
  creditors.sort(function (a, b) { return b.left - a.left || a.index - b.index })
  var transfers = []
  var i = 0
  var j = 0
  while (i < debtors.length && j < creditors.length) {
    var from = debtors[i]
    var to = creditors[j]
    var amount = Math.min(from.left, to.left)
    if (amount > 0) transfers.push({ from: from.member.ownerKey, to: to.member.ownerKey, amount: amount })
    from.left -= amount
    to.left -= amount
    if (from.left === 0) i++
    if (to.left === 0) j++
  }
  return transfers
}

function categoryNameOf(tx) {
  var name = typeof tx.category === 'string' ? tx.category.trim() : ''
  return name || '未分类'
}

/* 覆盖值必须是“分类 -> 成员权重映射”。格式无效或回退平均的覆盖整条忽略，
   该分类仍走本月默认权重；个别无效成员权重沿用默认权重的“按 0 处理”规则。 */
function normalizeCategoryWeights(list, supplied) {
  var out = { states: map(), weights: map(), warnings: [], fallback: [] }
  if (supplied === undefined || supplied === null) return out
  if (!objectLike(supplied)) {
    out.warnings.push('分类权重格式无效，已忽略全部分类覆盖')
    return out
  }
  Object.keys(supplied).forEach(function (rawName) {
    var name = rawName.trim()
    if (!name) { out.warnings.push('分类名称为空，已忽略该覆盖'); return }
    if (!Object.keys(supplied[rawName] || {}).length) {
      out.warnings.push('分类「' + name + '」的权重为空，已改用本月默认权重')
      out.fallback.push(name)
      return
    }
    var state = normalizeWeights(list, { weights: supplied[rawName] })
    /* 全零/全无效覆盖若回退平均，会改变默认权重口径，因此整条忽略。 */
    if (state.fallback) {
      out.warnings.push('分类「' + name + '」的权重无效或均为 0，已改用本月默认权重')
      out.fallback.push(name)
      return
    }
    out.states[name] = state
    out.weights[name] = JSON.parse(JSON.stringify(state.weights))
    state.warnings.forEach(function (warning) { out.warnings.push('分类「' + name + '」：' + warning) })
  })
  return out
}

function objectLike(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function sharesFor(total, weightState, memberCount) {
  if (weightState.mode === 'weighted') return weightedShares(total, weightState)
  var base = Math.floor(total / memberCount)
  var remainder = total - base * memberCount
  var shares = []
  for (var i = 0; i < memberCount; i++) shares.push(base + (i < remainder ? 1 : 0))
  return shares
}

function calculate(txs, members, options) {
  var normalized = normalizeMembers(members)
  var list = normalized.members
  var weightState = normalizeWeights(list, options)
  var categoryState = normalizeCategoryWeights(list, options && options.categoryWeights)
  var result = {
    members: list,
    transfers: [],
    total: 0,
    expense: 0,
    refund: 0,
    ym: options && MONTH_RE.test(String(options.ym || '')) ? String(options.ym) : '',
    ignored: 0,
    splitMode: weightState.mode,
    weights: JSON.parse(JSON.stringify(weightState.weights)),
    weightWarnings: weightState.warnings,
    weightFallback: weightState.fallback,
    categoryWeights: JSON.parse(JSON.stringify(categoryState.weights)),
    categoryWarnings: categoryState.warnings,
    categoryFallback: categoryState.fallback,
    categories: []
  }
  if (!list.length) return result

  var gross = 0
  var refunds = 0
  var categoryTotals = map()
  function categoryRow(name) {
    if (!categoryTotals[name]) categoryTotals[name] = { name: name, expense: 0, refund: 0, net: 0 }
    return categoryTotals[name]
  }
  var rows = Array.isArray(txs) ? txs : []
  for (var i = 0; i < rows.length; i++) {
    var tx = rows[i]
    if (!tx || typeof tx !== 'object') { result.ignored++; continue }
    if (tx.type !== 'expense' && tx.type !== 'refund') continue
    var amount = cents(tx.amount)
    if (!amount) continue
    if (result.ym && monthOf(tx) !== result.ym) continue
    var owner = resolveOwner(tx, normalized)
    if (!owner) { result.ignored++; continue }
    var expense = owner.expense
    var refund = owner.refund
    var paid = owner.paid
    var nextGross = gross
    var nextRefunds = refunds
    if (tx.type === 'expense') {
      expense = safeAdd(expense, amount)
      paid = safeAdd(paid, amount)
      nextGross = safeAdd(gross, amount)
    } else {
      refund = safeAdd(refund, amount)
      paid = safeAdd(paid, -amount)
      nextRefunds = safeAdd(refunds, amount)
    }
    /* 累计金额超出安全整数时跳过该笔，保持各余额与转账建议守恒。 */
    if (expense === null || refund === null || paid === null || nextGross === null || nextRefunds === null) {
      result.ignored++
      continue
    }
    owner.expense = expense
    owner.refund = refund
    owner.paid = paid
    gross = nextGross
    refunds = nextRefunds
    var name = categoryNameOf(tx)
    var category = categoryRow(name)
    var signed = tx.type === 'expense' ? amount : -amount
    category.net = safeAdd(category.net, signed)
    if (tx.type === 'expense') category.expense = safeAdd(category.expense, amount)
    else category.refund = safeAdd(category.refund, amount)
  }

  var total = gross - refunds
  var coveredTotal = BigInt(0)
  Object.keys(categoryState.states).forEach(function (name) {
    coveredTotal += BigInt(categoryRow(name).net)
  })
  /* 覆盖分类先从总额扣除，其余分类统一按默认权重分摊，避免逐笔取整。 */
  var restTotal = Number(BigInt(total) - coveredTotal)
  var shareTotals = sharesFor(restTotal, weightState, list.length)
    .map(function (share) { return BigInt(share) })
  Object.keys(categoryState.states).forEach(function (name) {
    var part = sharesFor(categoryRow(name).net, categoryState.states[name], list.length)
    for (var i = 0; i < list.length; i++) shareTotals[i] += BigInt(part[i])
  })
  /* 分类间先按 BigInt 累加，避免正负分类交替时出现中间安全整数溢出。 */
  var shares = shareTotals.map(function (share) { return Number(share) })
  result.categories = Object.keys(categoryTotals).map(function (name) {
    var category = categoryTotals[name]
    return {
      name: name,
      expense: category.expense,
      refund: category.refund,
      net: category.net,
      covered: Object.prototype.hasOwnProperty.call(categoryState.states, name)
    }
  }).sort(function (a, b) { return Math.abs(b.net) - Math.abs(a.net) || a.name.localeCompare(b.name) })
  for (var m = 0; m < list.length; m++) {
    list[m].share = shares[m]
    list[m].balance = list[m].paid - shares[m]
  }
  result.total = total
  result.expense = gross
  result.refund = refunds
  result.transfers = greedyTransfers(list)
  list.forEach(function (member) { delete member.index })
  return result
}

module.exports = { calculate: calculate }
