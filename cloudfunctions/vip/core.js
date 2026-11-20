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
 * 这样「提前续费」不会把剩余天数吞掉 */
function calcExpire(nowMs, currentExpire, days) {
  var now = Number(nowMs) || Date.now()
  var cur = Number(currentExpire) || 0
  var base = cur > now ? cur : now
  var n = Number(days) || 0
  return base + n * DAY
}

/* 批量造码 → 直接就是能导入云数据库的文档结构
 * usedBy 必须是空字符串（不是缺字段），云函数靠它做「条件更新」防重复兑换 */
function makeCodes(count, days, batch, nowMs) {
  var n = Math.max(1, Math.min(5000, Number(count) || 1))
  var d = Math.max(1, Number(days) || 365)
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
  daysLeft: daysLeft
}
