/* 会员状态（卡密模式）
 *
 * 设计口径：
 *   1. 小程序里不做任何支付，只做「输入卡密 → 核销」，支付发生在小程序外；
 *   2. 会员状态以云函数 vip 为准，本地只做缓存，断网时按缓存宽限（记账工具的盗版成本很低，
 *      不值得为它上强校验，别把正常用户挡在门外）；
 *   3. 判断只认 openid，用户在云函数侧归属，换手机不丢。
 */

var KEY = 'vip_member_v1'

/* 购买渠道文案：只写联系方式，别写支付方式，也别放二维码/收款码 —— 那是违规的 */
var CONTACT = '购买卡密：微信 / 闲鱼搜「记账Book」，联系作者拿码'

function nowMs() {
  return Date.now()
}

function readCache() {
  try {
    var v = wx.getStorageSync(KEY)
    return v && typeof v === 'object' ? v : {}
  } catch (e) {
    return {}
  }
}

function writeCache(patch) {
  var cur = readCache()
  var next = {}
  for (var k in cur) {
    if (Object.prototype.hasOwnProperty.call(cur, k)) next[k] = cur[k]
  }
  for (var j in patch) {
    if (Object.prototype.hasOwnProperty.call(patch, j)) next[j] = patch[j]
  }
  try {
    wx.setStorageSync(KEY, next)
  } catch (e) {}
  return next
}

function expireAt() {
  var c = readCache()
  return Number(c.expireAt) || 0
}

function isVip() {
  return expireAt() > nowMs()
}

function daysLeft() {
  var left = expireAt() - nowMs()
  return left > 0 ? Math.ceil(left / (24 * 60 * 60 * 1000)) : 0
}

function pad2(n) {
  return (n < 10 ? '0' : '') + n
}

function dateText(ms) {
  var t = Number(ms) || 0
  if (!t) return ''
  var d = new Date(t)
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

/* 给页面直接用的一句话状态 */
function statusText() {
  if (!isVip()) return '未开通会员'
  var left = daysLeft()
  return '会员有效至 ' + dateText(expireAt()) + '（还剩 ' + left + ' 天）'
}

/* 把云端返回写进缓存（顺带存 openid，登录页靠它拿身份） */
function apply(result) {
  if (!result || !result.ok) return readCache()
  var patch = {
    expireAt: Number(result.expireAt) || 0,
    checkedAt: nowMs()
  }
  if (result.openid) patch.openid = String(result.openid)
  return writeCache(patch)
}

function openid() {
  return String(readCache().openid || '')
}

/* 云端校准一次。失败就沿用缓存，不打扰用户 */
function refresh(cb) {
  var done = typeof cb === 'function' ? cb : function () {}
  if (!wx.cloud) {
    done(null)
    return
  }
  wx.cloud.callFunction({
    name: 'vip',
    data: { action: 'status' },
    success: function (r) {
      var res = (r && r.result) || {}
      if (res.ok) apply(res)
      done(res)
    },
    fail: function () {
      done(null)
    }
  })
}

/* 兑换卡密：成功回写缓存，callback(err, result) */
function redeem(code, cb) {
  var done = typeof cb === 'function' ? cb : function () {}
  var c = String(code || '').trim()
  if (!c) {
    done({ ok: false, msg: '先把卡密填进来' })
    return
  }
  if (!wx.cloud) {
    done({ ok: false, msg: '当前微信版本用不了云开发，兑换需要联网' })
    return
  }
  wx.cloud.callFunction({
    name: 'vip',
    data: { action: 'redeem', code: c },
    success: function (r) {
      var res = (r && r.result) || {}
      if (res.ok) apply(res)
      done(res)
    },
    fail: function (err) {
      var msg = String((err && err.errMsg) || '')
      if (/function not found|FunctionName/i.test(msg)) {
        msg = '云函数 vip 还没部署：在开发者工具里右键 cloudfunctions/vip → 上传并部署'
      }
      done({ ok: false, msg: msg || '网络出问题了，稍后再试' })
    }
  })
}

/* 功能拦截：未开通就弹窗引导到会员页，返回 true 表示放行 */
function guard(feature) {
  if (isVip()) return true
  var name = feature || '这个功能'
  wx.showModal({
    title: name + '是会员功能',
    content: '免费版可以用首页、手动记账、流水、总览，报表能看本月总额和支出构成。' + name + '需要会员卡密开通。',
    confirmText: '去开通',
    cancelText: '先不用',
    success: function (res) {
      if (res.confirm) wx.navigateTo({ url: '/pages/vip/vip' })
    }
  })
  return false
}

module.exports = {
  CONTACT: CONTACT,
  KEY: KEY,
  isVip: isVip,
  expireAt: expireAt,
  daysLeft: daysLeft,
  statusText: statusText,
  dateText: dateText,
  openid: openid,
  refresh: refresh,
  redeem: redeem,
  apply: apply,
  guard: guard
}
