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

module.exports = {
  KEY: KEY,
  refundExcluded: refundExcluded,
  setRefundExcluded: setRefundExcluded
}
