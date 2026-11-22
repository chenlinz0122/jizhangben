/* 卡密纯逻辑层：不依赖云开发 SDK，node 里可直接 require 来测
 *
 * 码型：4 组 × 4 位，共 16 位，字符集去掉容易看错的 0 / 1 / I / O
 *   ABCD-EFGH-JKLM-NPQR
 *
 * 只负责「格式化 / 校验 / 算到期日 / 批量造码」，读写数据库全在 index.js。
 */

var ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
var GROUP = 4
var GROUPS = 4
var LEN = GROUP * GROUPS
var DAY = 24 * 60 * 60 * 1000

/* 永久卡：days 传 -1（或 0）就按「永久」算，到期日钉在 2200-01-01，
   这样数据库里仍然是可比的数字，页面用 isPermanent() 判断显示「永久」 */
var PERMANENT_AT = Date.UTC(2200, 0, 1)
var PERMANENT_DAYS = -1

/* 用户手输可能有空格、小写、全角横线 → 先归一化再校验 */
function normalize(raw) {
  return String(raw == null ? '' : raw).toUpperCase().replace(/[^0-9A-Z]/g, '')
}

function isRightShape(norm) {
  if (norm.length !== LEN) return false
  for (var i = 0; i < norm.length; i++) {
    if (ALPHABET.indexOf(norm.charAt(i)) < 0) return false
  }
  return true
}

function format(norm) {
  var parts = []
  for (var i = 0; i < norm.length; i += GROUP) parts.push(norm.slice(i, i + GROUP))
  return parts.join('-')
}

/* 随机源优先 crypto，没有就退回 Math.random（只在离线造码时用） */
function randomCode() {
  var bytes = null
  try {
    var crypto = require('crypto')
    bytes = crypto.randomBytes(LEN)
  } catch (e) {
    bytes = null
  }
  var out = ''
  for (var i = 0; i < LEN; i++) {
    var r = bytes ? bytes[i] % ALPHABET.length : Math.floor(Math.random() * ALPHABET.length)
    out += ALPHABET.charAt(r)
  }
  return out
}

/* 到期日：还没过期就在原到期日上续，已过期则从今天重新算
 * 这样「提前续费」不会把剩余天数吞掉
 * days = -1 表示永久卡，直接给到 PERMANENT_AT；已是永久的再兑普通卡不变 */
function calcExpire(nowMs, currentExpire, days) {
  var now = Number(nowMs) || Date.now()
  var cur = Number(currentExpire) || 0
  if (cur >= PERMANENT_AT) return PERMANENT_AT
  var n = Number(days)
  if (!n || n < 0) return PERMANENT_AT
  var base = cur > now ? cur : now
  return base + n * DAY
}

/* 是否算永久会员 */
function isPermanent(expireAt) {
  return (Number(expireAt) || 0) >= PERMANENT_AT
}

/* 批量造码 → 直接就是能导入云数据库的文档结构
 * usedBy 必须是空字符串（不是缺字段），云函数靠它做「条件更新」防重复兑换 */
function makeCodes(count, days, batch, nowMs) {
  var n = Math.max(1, Math.min(5000, Number(count) || 1))
  var raw = Number(days)
  var d = (!raw || raw < 0) ? -1 : Math.min(5000, raw)
  var out = []
  var seen = {}
  while (out.length < n) {
    var code = randomCode()
    if (seen[code]) continue
    seen[code] = 1
    out.push({
      code: code,
      codeText: format(code),
      days: d,
      usedBy: '',
      usedAt: 0,
      batch: String(batch || ''),
      createdAt: Number(nowMs) || Date.now()
    })
  }
  return out
}

function daysLeft(nowMs, expireAt) {
  var left = (Number(expireAt) || 0) - (Number(nowMs) || Date.now())
  return left > 0 ? Math.ceil(left / DAY) : 0
}

module.exports = {
  ALPHABET: ALPHABET,
  LEN: LEN,
  DAY: DAY,
  normalize: normalize,
  isRightShape: isRightShape,
  format: format,
  randomCode: randomCode,
  calcExpire: calcExpire,
  makeCodes: makeCodes,
  daysLeft: daysLeft,
  PERMANENT_AT: PERMANENT_AT,
  PERMANENT_DAYS: PERMANENT_DAYS,
  isPermanent: isPermanent
}


