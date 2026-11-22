/* 退款配对自测：node tools/test-refund-pair.js
 * 只测 utils/refundpair.js 的纯逻辑，不依赖小程序环境。 */

var rp = require('../utils/refundpair')

var pass = 0
var fail = 0

function ok(cond, msg) {
  if (cond) { pass++ } else { fail++; console.log('  ✗ ' + msg) }
}

function tx(id, type, merchant, amount, day) {
  var t = new Date(day + 'T10:00:00+08:00').getTime()
  return { id: id, type: type, merchant: merchant, amount: amount, time: t, day: day, ym: day.slice(0, 7) }
}

/* 1. 同商户同金额：两条都消失 */
;(function () {
  var list = [
    tx('e1', 'expense', '抖音电商商家', 44.24, '2026-11-10'),
    tx('r1', 'refund', '抖音电商商家', 44.24, '2026-11-12')
  ]
  var r = rp.pair(list)
  ok(r.hideId.e1 === true, '同商户同金额：付款应隐藏')
  ok(r.hideId.r1 === true, '同商户同金额：退款应隐藏')
  ok(r.leftOf.e1 === 0, '同商户同金额：净额应为 0')
  ok(r.refundedOf.e1 === 44.24, '同商户同金额：记录已退 44.24')
  ok(r.pairs.length === 1, '同商户同金额：应产生 1 组配对')
  ok(r.unmatched.length === 0, '同商户同金额：不应有未配对退款')
})()

/* 2. 商户名不同但同字号（抖音电商商家 vs 抖音商城）+ 同金额 */
;(function () {
  var list = [
    tx('e2', 'expense', '抖音电商商家', 44.24, '2026-11-10'),
    tx('r2', 'refund', '抖音商城', 44.24, '2026-11-14')
  ]
  var r = rp.pair(list)
  ok(r.hideId.e2 === true, '模糊商户同金额：付款应隐藏')
  ok(r.hideId.r2 === true, '模糊商户同金额：退款应隐藏')
  ok(r.unmatched.length === 0, '模糊商户同金额：不应残留未配对')
})()

/* 3. 部分退款：退款行消失，付款行变净额 */
;(function () {
  var list = [
    tx('e3', 'expense', '天猫超市', 400, '2026-11-03'),
    tx('r3', 'refund', '天猫超市', 150, '2026-11-05')
  ]
  var r = rp.pair(list)
  ok(r.hideId.e3 === undefined, '部分退款：付款行要保留')
  ok(r.hideId.r3 === true, '部分退款：退款行隐藏')
  ok(r.leftOf.e3 === 250, '部分退款：付款净额应为 250')
  ok(r.refundedOf.e3 === 150, '部分退款：记录已退 150')
  ok(r.pairs.length === 1, '部分退款：应产生 1 组配对')
})()

/* 4. 退款日期比付款早：不硬配，两条都留着让人自己看 */
;(function () {
  var list = [
    tx('e4', 'expense', '星巴克', 30, '2026-11-20'),
    tx('r4', 'refund', '星巴克', 30, '2026-11-01')
  ]
  var r = rp.pair(list)
  ok(r.hideId.e4 === undefined, '退款早于付款：付款不动')
  ok(r.hideId.r4 === undefined, '退款早于付款：退款留着')
  ok(r.unmatchedAmount === 30, '退款早于付款：记为未配对 30')
})()

/* 5. 同商户两笔同额支出 + 一笔退款：只吃掉其中一笔 */
;(function () {
  var list = [
    tx('e5a', 'expense', '美团', 25, '2026-11-02'),
    tx('e5b', 'expense', '美团', 25, '2026-11-18'),
    tx('r5', 'refund', '美团', 25, '2026-11-19')
  ]
  var r = rp.pair(list)
  var hidden = 0
  if (r.hideId.e5a) hidden++
  if (r.hideId.e5b) hidden++
  ok(hidden === 1, '两笔同额支出只应隐藏一笔（实际 ' + hidden + '）')
  ok(r.hideId.r5 === true, '对应的退款应隐藏')
  ok((r.leftOf.e5a === 0) !== (r.leftOf.e5b === 0), '剩余那笔净额应为原价 25')
})()

/* 6. 一次退款摊到两笔支出（合并支付后退其中一部分） */
;(function () {
  var list = [
    tx('e6a', 'expense', '京东', 100, '2026-11-08'),
    tx('e6b', 'expense', '京东', 100, '2026-11-09'),
    tx('r6', 'refund', '京东', 150, '2026-11-15')
  ]
  var r = rp.pair(list)
  ok(r.hideId.r6 === true, '大额退款：退款行隐藏')
  var leftA = r.leftOf.e6a
  var leftB = r.leftOf.e6b
  ok((leftA === 0 && leftB === 50) || (leftA === 50 && leftB === 0), '大额退款：两笔支出合计剩 50（实际 ' + leftA + '/' + leftB + '）')
  ok(r.unmatchedAmount === 0, '大额退款：不应残留未配对金额')
})()

/* 7. 名字和金额都对不上：坚决不配，宁可留着，也不许把闲鱼退的钱塞给海底捞 */
;(function () {
  var list = [
    tx('e7', 'expense', '海底捞', 320, '2026-11-06'),
    tx('r7', 'refund', '闲鱼', 12.5, '2026-11-07')
  ]
  var r = rp.pair(list)
  ok(r.hideId.e7 === undefined, '名字金额都不同：付款不动')
  ok(r.leftOf.e7 === 320, '名字金额都不同：付款保持原价 320')
  ok(r.refundedOf.e7 === undefined, '名字金额都不同：付款不应被记已退')
  ok(r.hideId.r7 === undefined, '名字金额都不同：退款留着自己显示')
  ok(r.unmatchedAmount === 12.5, '名字金额都不同：记为未配对 12.5')
  ok(r.pairs.length === 0, '名字金额都不同：不应产生任何配对')
})()

/* 7b. 跨月：10 月花的钱、11 月才退，名字看着不同但金额刚好对得上 → 正常配上 */
;(function () {
  var list = [
    tx('e7b', 'expense', '某服装店', 199, '2026-10-20'),
    tx('r7b', 'refund', '支付宝退款', 199, '2026-11-02')
  ]
  var r = rp.pair(list)
  ok(r.hideId.e7b === true, '跨月同金额：付款应被退干净并隐藏')
  ok(r.unmatched.length === 0, '跨月同金额：不应残留')
})()

/* 8. 超过 180 天的退款不参与配对 */
;(function () {
  var list = [
    tx('e8', 'expense', '山姆', 500, '2026-01-10'),
    tx('r8', 'refund', '山姆', 500, '2026-11-10')
  ]
  var r = rp.pair(list)
  ok(r.hideId.e8 === undefined, '超过 180 天：付款不应被隐藏')
  ok(r.unmatched.length === 1, '超过 180 天：应记为未配对')
})()

/* 9. 商户名规范化 */
;(function () {
  ok(rp.normMerchant('抖音电商商家') === '抖音', '规范化：抖音电商商家 → 抖音')
  ok(rp.normMerchant('抖音商城（官方）') === '抖音', '规范化：去括号 + 商城 → 抖音')
  ok(rp.normMerchant('') === '', '规范化：空名 → 空')
  ok(rp.normMerchant('星巴克(上海)有限公司') === '星巴克', '规范化：去有限公司 → 星巴克')
})()

/* 10. 只有退款没有支出：整笔记为未配对，退款留在列表里，不崩 */
;(function () {
  var list = [tx('r10', 'refund', '某商家', 88, '2026-11-11')]
  var r = rp.pair(list)
  ok(r.hideId.r10 === undefined, '孤立退款：留在列表里')
  ok(r.unmatchedAmount === 88, '孤立退款：未配对金额 88')
})()

/* 11. 只配上一半（退款 100，只找到 60 的付款）：整笔撤回，不留半截 */
;(function () {
  var list = [
    tx('e11', 'expense', '饿了么', 60, '2026-11-09'),
    tx('r11', 'refund', '饿了么', 100, '2026-11-12')
  ]
  var r = rp.pair(list)
  ok(r.leftOf.e11 === 60, '只配一半：付款恢复原价 60')
  ok(r.refundedOf.e11 === undefined, '只配一半：付款不应被记已退')
  ok(r.hideId.e11 === undefined, '只配一半：付款不隐藏')
  ok(r.hideId.r11 === undefined, '只配一半：退款留在列表里')
  ok(r.pairs.length === 0, '只配一半：不应留下半截配对')
  ok(r.unmatchedAmount === 100, '只配一半：整笔记未配对 100')
})()

console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exit(fail ? 1 : 0)
