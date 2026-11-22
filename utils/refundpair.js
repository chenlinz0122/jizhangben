/* 退款配对：把「退款」和它对应的那笔「付款」认成一对
 *
 * 为什么要单独抽出来：支付和退款在账单里经常不是同一个名字
 * （付款写「抖音电商商家」，退款写「抖音商城」），金额也可能是部分退款。
 * 只按「同商户 + 同金额」硬配，就会漏掉一些，出现「退款删了、付款还在」的半截状态。
 *
 * 这里的匹配是打分的：
 *   1. 商户名规范化后相同（去掉「有限公司 / 商城 / 商家 / 旗舰店」这类噪声）→ 最高分
 *   2. 商户名有共同的词（如「抖音」）→ 次高分
 *   3. 金额正好等于这笔支出剩余未退的部分 → 加分（全额退款的典型特征）
 *   4. 退款时间在付款之后的 180 天内，越近分越高；早于付款的直接不匹配
 * 退款金额比单笔支出大时，会依次摊到多笔支出上（比如一次退了合并支付的两单）。
 */

var NOISE = [
  '有限责任公司', '有限公司', '股份公司', '分公司', '公司',
  '旗舰店', '专营店', '专卖店', '官方', '商城', '商家', '店铺', '网店',
  '电子商务', '电商', '科技', '网络', '信息技术', '信息服务', '服务',
  '平台', '集团', '控股', '商贸', '贸易'
]

var WINDOW_DAYS = 180

function round2(n) {
  return Math.round((n || 0) * 100) / 100
}

/* 商户名规范化：去括号内容、去分隔符、去行业噪声词，保留字号（抖音 / 美团 / 淘宝…） */
function normMerchant(name) {
  var s = String(name || '').toLowerCase()
  if (!s) return ''
  s = s.replace(/[（(【\[].*?[)）】\]]/g, '')
  s = s.replace(/[\s\-—_·.,，、/\\|:：;；"'“”]/g, '')
  for (var i = 0; i < NOISE.length; i++) {
    s = s.split(NOISE[i]).join('')
  }
  return s
}

/* 两个规范化名字有没有 2 个字以上的公共片段（用来认「抖音电商商家」和「抖音商城」） */
function shareToken(a, b) {
  if (!a || !b) return false
  for (var len = Math.min(a.length, b.length); len >= 2; len--) {
    for (var i = 0; i + len <= a.length; i++) {
      if (b.indexOf(a.substr(i, len)) >= 0) return true
    }
  }
  return false
}

/* 给「支出 e」和「退款 r」打分；返回 -1 表示这对不允许匹配 */
function scoreOf(e, r) {
  var days = (r.time - e.time) / 86400000
  if (days < -1 || days > WINDOW_DAYS) return -1

  var en = normMerchant(e.tx.merchant)
  var rn = normMerchant(r.merchant)
  var same = !!(en && rn && (en === rn || en.indexOf(rn) >= 0 || rn.indexOf(en) >= 0))
  var alike = !same && shareToken(en, rn)
  var exact = Math.abs(e.left - r.amount) <= 0.01
  var canPay = e.left >= r.amount - 0.01

  /* 名字没关系、金额又不一样的，一律不许配：
     不然「闲鱼退 12.5」会被硬塞给「海底捞 320」，把好账算坏 */
  if (!same && !alike && !exact) return -1

  var s = 0
  if (same) s += 100
  else if (alike) s += 58
  if (exact) s += 72
  if (canPay) s += 14
  s -= Math.min(Math.abs(days), WINDOW_DAYS) * 0.35
  return s
}

/**
 * 把退款和支出配对
 * @param {Array} txs 已经按页面筛选条件收好的交易数组（同一个月 / 同一个搜索条件）
 * @returns {{
 *   leftOf: Object,         // 支出 id -> 扣完已退金额后剩下的净额
 *   refundedOf: Object,     // 支出 id -> 被退掉的总金额
 *   hideId: Object,         // 应该整行隐藏的 id（退款本身 + 被退干净的支出）
 *   pairs: Array,           // [{ refund, expense, amount }]
 *   unmatched: Array,       // 找不到任何支出可冲的退款
 *   unmatchedAmount: Number // 上面那些退款的钱加起来
 * }}
 */
function pair(txs) {
  var exp = []
  var ref = []
  for (var i = 0; i < txs.length; i++) {
    var t = txs[i]
    if (!t) continue
    if (t.type === 'expense') exp.push({ tx: t, left: round2(t.amount), time: t.time })
    else if (t.type === 'refund') ref.push(t)
  }
  /* 退款按时间从早到晚处理，先发生的先配，减少「配错到后面那笔」的概率 */
  ref.sort(function (a, b) { return a.time - b.time })

  var leftOf = {}
  var refundedOf = {}
  var hideId = {}
  var pairs = []
  var unmatched = []
  var unmatchedAmount = 0

  for (var j = 0; j < ref.length; j++) {
    var r = ref[j]
    /* 退款本身永远不单独显示：要么和付款成对消失，要么把付款冲成净额 */
    hideId[r.id] = true

    var remain = round2(r.amount)
    var guard = 0
    while (remain > 0.005 && guard < 20) {
      guard++
      var best = null
      var bestScore = -1
      for (var k = 0; k < exp.length; k++) {
        var e = exp[k]
        if (e.left <= 0.005) continue
        var sc = scoreOf(e, r)
        if (sc > bestScore) { bestScore = sc; best = e }
      }
      if (!best || bestScore < 0) break

      var use = Math.min(remain, best.left)
      best.left = round2(best.left - use)
      leftOf[best.tx.id] = best.left
      refundedOf[best.tx.id] = round2((refundedOf[best.tx.id] || 0) + use)
      if (best.left <= 0.005) hideId[best.tx.id] = true
      pairs.push({ refund: r, expense: best.tx, amount: round2(use), guessed: bestScore < 30 })
      remain = round2(remain - use)
    }

    /* 兜底：名字和金额都对不上（账单里商户名被平台改写过）时，
       钱还是得有个落脚的地方——摊到「时间最近、还有余额」的那笔支出上，
       宁可归类粗一点，也不留一条孤零零的退款。优先同月，没有再放宽到 180 天内。
       这里不强制退款晚于付款：有的账单退款日期会被平台写成比付款还早。 */
    if (remain > 0.005) {
      var fallback = null
      var bestGap = Infinity
      for (var f = 0; f < exp.length; f++) {
        var fe = exp[f]
        if (fe.left <= 0.005) continue
        var gap = Math.abs(r.time - fe.time) / 86400000
        if (gap > WINDOW_DAYS) continue
        /* 同月优先：跨月的时间差再小也往后排 */
        var weight = (fe.tx.ym === r.ym) ? gap : gap + 200
        if (weight < bestGap) { bestGap = weight; fallback = fe }
      }
      if (fallback) {
        var use2 = Math.min(remain, fallback.left)
        fallback.left = round2(fallback.left - use2)
        leftOf[fallback.tx.id] = fallback.left
        refundedOf[fallback.tx.id] = round2((refundedOf[fallback.tx.id] || 0) + use2)
        if (fallback.left <= 0.005) hideId[fallback.tx.id] = true
        pairs.push({ refund: r, expense: fallback.tx, amount: round2(use2), guessed: true })
        remain = round2(remain - use2)
      }
    }

    if (remain > 0.005) {
      unmatched.push(r)
      unmatchedAmount = round2(unmatchedAmount + remain)
    }
  }

  /* 没被退过的支出，净额就是原价 */
  for (var m = 0; m < exp.length; m++) {
    var ex = exp[m]
    if (leftOf[ex.tx.id] === undefined) leftOf[ex.tx.id] = ex.left
  }

  return {
    leftOf: leftOf,
    refundedOf: refundedOf,
    hideId: hideId,
    pairs: pairs,
    unmatched: unmatched,
    unmatchedAmount: unmatchedAmount
  }
}

module.exports = {
  normMerchant: normMerchant,
  pair: pair
}
