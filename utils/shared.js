/* 共同账本（客户端）
 *
 * 口径：
 *   1. 账本仍然以本地 Storage 为准，云端只做「多人之间的中转」；
 *   2. 记账 / 导入照旧写本地，sync() 时把还没推过的记录推上去，再把别人的拉下来合并；
 *   3. 合并走 store.addMany()，按 id 去重，重复推不会翻倍；
 *   4. 谁记的：拉下来的记录带 by（昵称）和 byMe（是不是我记的），本地一起存；
 *      自己记的记录没有 by，一律当成「我」，所以不用给历史数据补字段；
 *   5. 一个人只能在一个共同账本里，退出（账主退出 = 解散）由云端处理。
 */

var store = require('./store')

var BOOK_KEY = 'shared_book_v1'
var PUSHED_KEY = 'shared_pushed_v1'
var PENDING_KEY = 'pending_share_v1'

var TX_FIELDS = ['id', 'time', 'day', 'ym', 'type', 'amount', 'category', 'desc', 'account',
  'byPlatform', 'status', 'merchant', 'note', 'src', 'edited']

function readObj(key) {
  try {
    var v = wx.getStorageSync(key)
    return v && typeof v === 'object' ? v : null
  } catch (e) {
    return null
  }
}

function writeObj(key, v) {
  try { wx.setStorageSync(key, v) } catch (e) {}
}

function current() {
  return readObj(BOOK_KEY)
}

function isJoined() {
  var b = current()
  return !!(b && b.bookId)
}

/* 我的昵称：没设过就报空，页面自己兜底成「我」 */
function myName() {
  var b = current()
  return (b && b.nickname) || ''
}

function save(book) {
  var old = current() || {}
  var next = {
    bookId: book.bookId,
    name: book.name || old.name || '共同账本',
    code: book.code || old.code || '',
    nickname: book.nickname || old.nickname || '',
    members: book.members || old.members || 0,
    memberLimit: book.memberLimit || old.memberLimit || 10,
    memberList: book.memberList || old.memberList || [],
    joinedAt: old.joinedAt || Date.now(),
    lastSync: old.lastSync || 0
  }
  writeObj(BOOK_KEY, next)
  return next
}

function clear() {
  try { wx.removeStorageSync(BOOK_KEY) } catch (e) {}
}

function call(action, data, cb) {
  var done = typeof cb === 'function' ? cb : function () {}
  if (!wx.cloud) {
    done({ ok: false, msg: '当前微信版本用不了云开发' })
    return
  }
  var payload = { action: action }
  for (var k in data) {
    if (Object.prototype.hasOwnProperty.call(data, k)) payload[k] = data[k]
  }
  wx.cloud.callFunction({
    name: 'book',
    data: payload,
    success: function (r) { done((r && r.result) || { ok: false }) },
    fail: function (err) {
      var msg = String((err && err.errMsg) || '')
      if (/function not found|FunctionName/i.test(msg)) {
        msg = '云函数 book 还没部署：右键 cloudfunctions/book → 上传并部署'
      }
      done({ ok: false, msg: msg || '网络出问题了，稍后再试' })
    }
  })
}

/* 建一本（已经当账主就直接返回那一本） */
function createBook(name, nickname, cb) {
  call('create', { name: name, nickname: nickname }, function (res) {
    if (res && res.ok) {
      res.nickname = myNameOfList(res.memberList) || nickname || ''
      save(res)
    }
    cb && cb(res)
  })
}

/* 用 6 位邀请码加入 */
function joinBook(code, nickname, cb) {
  call('join', { code: code, nickname: nickname }, function (res) {
    if (res && res.ok) {
      res.nickname = myNameOfList(res.memberList) || nickname || ''
      save(res)
    }
    cb && cb(res)
  })
}

/* 从成员清单里挑出「我」的名字 */
function myNameOfList(list) {
  if (!list || !list.length) return ''
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].isMe) return list[i].nickname || ''
  }
  return ''
}

/* 改自己的昵称（以后新记的账用新名字，历史记录保留当时的名字） */
function setNick(nickname, cb) {
  call('setNick', { nickname: nickname }, function (res) {
    if (res && res.ok) {
      var b = current()
      if (b) { b.nickname = res.nickname || nickname || ''; writeObj(BOOK_KEY, b) }
    }
    cb && cb(res)
  })
}

/* 账本概况：名称、邀请码、几个人、都是谁 */
function info(cb) {
  var b = current()
  if (!b) { cb && cb({ ok: false, code: 'NO_BOOK' }); return }
  call('my', {}, function (res) {
    if (res && res.ok && res.joined) {
      res.nickname = res.nickname || myNameOfList(res.memberList) || (b && b.nickname) || ''
      save(res)
    } else if (res && res.ok && !res.joined) {
      clear()
    }
    cb && cb(res)
  })
}

/* 退出（账主退出会把整本拆掉，代价值得在页面上说清楚） */
function leave(cb) {
  call('leave', {}, function (res) {
    if (res && res.ok) clear()
    cb && cb(res)
  })
}

function pushedSet() {
  var arr = []
  try { arr = wx.getStorageSync(PUSHED_KEY) || [] } catch (e) { arr = [] }
  if (!Array.isArray(arr)) arr = []
  var set = {}
  for (var i = 0; i < arr.length; i++) set[arr[i]] = 1
  return { list: arr, set: set }
}

function markPushed(ids) {
  if (!ids || !ids.length) return
  var p = pushedSet()
  var list = p.list.concat(ids)
  if (list.length > 4000) list = list.slice(list.length - 4000)
  writeObj(PUSHED_KEY, list)
}

/* 把本地还没推过的记录推上去（最多 300 条一次） */
function pushPending(bookId, cb) {
  var p = pushedSet()
  var all = store.all()
  var todo = []
  for (var i = 0; i < all.length; i++) {
    var t = all[i]
    if (!t || !t.id || p.set[t.id]) continue
    todo.push(t)
  }
  if (!todo.length) { cb && cb({ ok: true, pushed: 0 }); return }
  todo = todo.slice(-300)
  var payload = []
  for (var j = 0; j < todo.length; j++) {
    var raw = todo[j]
    var plain = {}
    for (var k = 0; k < TX_FIELDS.length; k++) {
      var key = TX_FIELDS[k]
      if (raw[key] !== undefined && raw[key] !== null) plain[key] = raw[key]
    }
    plain.updatedAt = Number(raw.edited) || Number(raw.time) || Date.now()
    payload.push(plain)
  }
  call('push', { bookId: bookId, txs: payload }, function (res) {
    if (res && res.ok) {
      var ids = []
      for (var m = 0; m < payload.length; m++) ids.push(payload[m].id)
      markPushed(ids)
    }
    cb && cb(res)
  })
}

/* 拉别人的记录并合并进本地 */
function pullAndMerge(bookId, cb) {
  call('pull', { bookId: bookId }, function (res) {
    if (!res || !res.ok) { cb && cb(res || { ok: false }); return }
    var rows = res.txs || []
    var incoming = []
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i]
      if (!row || !row.id) continue
      var one = {
        id: row.id, time: row.time, day: row.day, ym: row.ym,
        type: row.type, amount: row.amount, category: row.category,
        desc: row.desc, account: row.account, byPlatform: row.byPlatform,
        status: row.status, merchant: row.merchant, note: row.note,
        src: row.src, edited: row.edited
      }
      /* 谁记的：别人的记录带名字，自己的记录不带（本地历史数据也就不用迁移） */
      if (row.byName && !row.isMe) {
        one.by = row.byName
        one.byMe = false
      }
      incoming.push(one)
    }
    var out = { added: 0, merged: 0, members: res.members || 0 }
    if (incoming.length) {
      var r = store.addMany(incoming)
      out.added = (r && r.added) || 0
      out.merged = (r && r.merged) || 0
    }
    /* 拉下来的也算「已知」，以后不必再推回去 */
    var ids = []
    for (var q = 0; q < incoming.length; q++) ids.push(incoming[q].id)
    markPushed(ids)
    var b = current()
    if (b) {
      b.lastSync = Date.now()
      if (res.memberList) b.memberList = res.memberList
      if (res.members) b.members = res.members
      writeObj(BOOK_KEY, b)
    }
    cb && cb(Object.assign({ ok: true }, out))
  })
}

/* 一次完整同步：先推后拉，回调里给「新增几条」 */
function sync(cb) {
  var b = current()
  if (!b || !b.bookId) { cb && cb({ ok: false, msg: '还没加入共同账本' }); return }
  pushPending(b.bookId, function (p) {
    pullAndMerge(b.bookId, function (r) {
      if (!r || !r.ok) { cb && cb(r || { ok: false }); return }
      r.pushed = (p && p.pushed) || 0
      cb && cb(r)
    })
  })
}

/* 本地这条记录是不是我自己记的：没有 by 就是自己 */
function isMine(t) {
  if (!t) return true
  return !(t.by && t.byMe === false)
}

/* 分享链接：/pages/share/share?code=XXXXXX */
function sharePath() {
  var b = current()
  return '/pages/share/share?code=' + ((b && b.code) || '')
}

function setPendingShare(code) {
  var c = String(code || '').trim().toUpperCase().replace(/[^0-9A-Z]/g, '')
  if (!c) return
  writeObj(PENDING_KEY, c)
}

function pendingShare() {
  var c = ''
  try { c = String(wx.getStorageSync(PENDING_KEY) || '') } catch (e) { c = '' }
  return c
}

function clearPendingShare() {
  try { wx.removeStorageSync(PENDING_KEY) } catch (e) {}
}

module.exports = {
  BOOK_KEY: BOOK_KEY,
  PUSHED_KEY: PUSHED_KEY,
  PENDING_KEY: PENDING_KEY,
  current: current,
  isJoined: isJoined,
  myName: myName,
  isMine: isMine,
  createBook: createBook,
  joinBook: joinBook,
  setNick: setNick,
  info: info,
  leave: leave,
  sync: sync,
  sharePath: sharePath,
  setPendingShare: setPendingShare,
  pendingShare: pendingShare,
  clearPendingShare: clearPendingShare
}
