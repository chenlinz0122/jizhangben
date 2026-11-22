/* 本地偏好开关（只存自己手机，跟账号、账本都没关系）
 *
 * 目前只有一个：退款怎么算
 *   refundOut = true （默认）退款抵消：既不进收入，也从支出里扣掉 —— 等于这笔钱没花也没赚
 *   refundOut = false        退款算进账、支出按原价（结余数字跟「抵消」一样，只是展示位置不同）
 *
 * 预算不受这个开关影响：预算本来就看「实际花了多少」，退款回来了就该少算（见 stats.budgetSpent）。
 */
var KEY = 'prefs_v1'

function read() {
  try {
    var v = wx.getStorageSync(KEY)
    return v && typeof v === 'object' ? v : {}
  } catch (e) {
    return {}
  }
}

function save(o) {
  try { wx.setStorageSync(KEY, o) } catch (e) {}
}

function refundExcluded() {
  var o = read()
  /* 没设过就是「不计入」，这是用户要的默认口径 */
  return o.refundOut === undefined ? true : !!o.refundOut
}

function setRefundExcluded(v) {
  var o = read()
  o.refundOut = !!v
  save(o)
  return o.refundOut
}

/* 共同账本里看哪部分账：'mine' 只看自己 / 'both' 看双方（默认） / 'peer' 只看对方
 * 只对自己手机生效；没加入账本时这个设置不起作用（一律当全部）。 */
function viewScope() {
  var v = read().viewScope
  if (v === 'mine' || v === 'peer') return v
  /* 老版本存的是 'all' 或干脆没存，一律当「看双方」 */
  return 'both'
}

function setViewScope(v) {
  var o = read()
  o.viewScope = (v === 'mine' || v === 'peer') ? v : 'both'
  save(o)
  return o.viewScope
}

/* 给界面用的一行小字：只看自己 / 看双方 / 只看对方 */
function viewScopeLabel(v) {
  var s = v || viewScope()
  if (s === 'mine') return '只看自己'
  if (s === 'peer') return '只看对方'
  return '看双方'
}

module.exports = {
  KEY: KEY,
  refundExcluded: refundExcluded,
  setRefundExcluded: setRefundExcluded,
  viewScope: viewScope,
  setViewScope: setViewScope,
  viewScopeLabel: viewScopeLabel
}
