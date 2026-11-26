var store = require('./store')
var format = require('./format')

var BOOK_KEY = 'shared_book_v1'
var STATE_KEY = 'shared_sync_v2'
var PENDING_KEY = 'pending_share_v1'
var REMARK_KEY = 'shared_remarks_v1'
var PUSH_BATCH = 20
var TEXT_FIELDS = ['category', 'desc', 'account', 'byPlatform', 'status', 'merchant', 'note', 'src', 'source']
var waiting = null
var changing = false

function readObj(key) {
  var v = wx.getStorageSync(key)
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null
}

function writeObj(key, v) {
  try { wx.setStorageSync(key, v); return true } catch (e) { return false }
}

function current() {
  try { return readObj(BOOK_KEY) } catch (e) { return null }
}

function isJoined() {
  var b = current()
  return !!(b && b.bookId)
}

function isMine(t) { return !t || t.byMe !== false }
function myName() { return (current() || {}).nickname || '' }
function busy() { return !!waiting || changing }
function failure(msg, code) { return { ok: false, code: code || 'LOCAL_SAVE_FAILED', msg: msg } }
function storageError() { return failure('本机保存失败，原有流水保留，请检查存储空间后重试') }
function upgradeError() { return failure('共同账本云函数版本过旧，请在微信开发者工具上传并部署 cloudfunctions/book，并让成员更新小程序', 'UPGRADE_REQUIRED') }

function myMember(list) {
  for (var i = 0; i < (list || []).length; i++) if (list[i] && list[i].isMe) return list[i]
  return {}
}

function save(book) {
  var old = current() || {}
  if (old.bookId !== book.bookId) old = {}
  var me = myMember(book.memberList || old.memberList)
  var role = book.role || me.role || old.role || 'member'
  var joinedAt = book.joinedAt || me.joinedAt || old.joinedAt || Date.now()
  var sameMembership = !old.joinedAt || old.joinedAt === joinedAt
  return writeObj(BOOK_KEY, {
    bookId: book.bookId,
    name: book.name || old.name || '共同账本',
    code: book.code || old.code || '',
    nickname: book.nickname || me.nickname || old.nickname || '',
    members: book.members === undefined ? (old.members || 0) : book.members,
    memberLimit: book.memberLimit || old.memberLimit || 10,
    memberList: book.memberList || old.memberList || [],
    owner: role === 'owner', role: role, joinedAt: joinedAt,
    lastSync: sameMembership ? (old.lastSync || 0) : 0,
    shareSince: sameMembership && typeof old.shareSince === 'number' ? old.shareSince : null
  })
}

function clear() {
  try { wx.removeStorageSync(BOOK_KEY); return true } catch (e) { return false }
}

function call(action, data, cb) {
  if (!wx.cloud || typeof wx.cloud.callFunction !== 'function') {
    cb(failure('当前微信版本用不了云开发', 'CLOUD_UNAVAILABLE'))
    return
  }
  var settled = false
  function done(res) {
    if (settled) return
    settled = true
    cb(res)
  }
  function fail(err) {
    var msg = String((err && (err.errMsg || err.message)) || '')
    var code = String((err && err.errCode) || '')
    if (/function not found|FunctionName/i.test(msg)) msg = '云函数 book 还没部署，请在微信开发者工具右键 cloudfunctions/book → 上传并部署'
    else if (code === '-501000' || /env.*not.*exist|invalid env/i.test(msg)) msg = '云开发环境不匹配（code -501000），请核对 app.js 中的环境和云函数部署环境'
    else msg = '调用云函数失败' + (code ? '（code ' + code + '）' : '') + (msg ? '：' + msg : '')
    done(failure(msg, code || 'NETWORK_ERROR'))
  }
  try {
    wx.cloud.callFunction({
      name: 'book', data: Object.assign({ action: action, protocol: 2 }, data),
      success: function (r) { done((r && r.result) || failure('云函数未返回结果', 'BAD_RESPONSE')) },
      fail: fail
    })
  } catch (e) { if (settled) throw e; fail(e) }
}

function changeMembership(action, data, cb) {
  if (busy()) { cb && cb(failure('正在同步或处理账本，请稍后再试', 'BUSY')); return }
  changing = true
  call(action, data, function (res) {
    changing = false
    if (res && res.ok) {
      if (action === 'leave') {
        if (!clear()) res = storageError()
      } else if (!save(res)) res = failure('云端操作已完成，但本机未能保存账本状态，请重新进入共同账本恢复')
    }
    cb && cb(res)
  })
}

function createBook(name, nickname, cb) { changeMembership('create', { name: name, nickname: nickname }, cb) }
function joinBook(code, nickname, cb) { changeMembership('join', { code: code, nickname: nickname }, cb) }
function leave(cb) { changeMembership('leave', {}, cb) }

function info(cb) {
  if (busy()) { cb && cb(failure('正在处理账本，请稍后再试', 'BUSY')); return }
  var before = (current() || {}).bookId
  call('my', {}, function (res) {
    if (busy() || before !== (current() || {}).bookId) { cb && cb(failure('账本已变化，请重新加载', 'BOOK_CHANGED')); return }
    if (res && res.ok) {
      if (res.joined ? !save(res) : !clear()) res = storageError()
    }
    cb && cb(res)
  })
}

function setNick(nickname, cb) {
  if (busy()) { cb && cb(failure('正在同步，请稍后改名', 'BUSY')); return }
  call('setNick', { nickname: nickname }, function (res) {
    if (res && res.ok) {
      var b = current()
      if (b && !save(Object.assign({}, b, res))) res = storageError()
    }
    cb && cb(res)
  })
}

function setShareScope(mode) {
  var b = current()
  if (!b || busy() || (mode !== 'all' && mode !== 'recent')) return false
  var day = new Date(b.joinedAt)
  day.setHours(0, 0, 0, 0)
  return writeObj(BOOK_KEY, Object.assign({}, b, { shareSince: mode === 'all' ? 0 : day.getTime() }))
}

function scopeText() {
  var b = current()
  if (!b || typeof b.shareSince !== 'number') return '尚未确认共享范围'
  return b.shareSince === 0 ? '本人的全部历史流水' : format.dayOf(b.shareSince) + '（含）以后的本人流水'
}

function plain(t) {
  var time = Number(t.time)
  if (!time && t.day) {
    var dp = String(t.day).split('-')
    time = new Date(Number(dp[0]), Number(dp[1]) - 1, Number(dp[2])).getTime()
  }
  var out = { id: t.id, time: time, day: format.dayOf(time), ym: format.ymOf(time), type: t.type, amount: Number(t.amount) }
  for (var i = 0; i < TEXT_FIELDS.length; i++) out[TEXT_FIELDS[i]] = t[TEXT_FIELDS[i]] || ''
  /* 原币信息属于账目内容，需要随共同账本同步；账户 ID 仍是本机私有信息。 */
  if (t.currency) out.currency = String(t.currency)
  if (t.toCurrency) out.toCurrency = String(t.toCurrency)
  ;['nativeAmount', 'rateToCny', 'toNativeAmount', 'toRateToCny'].forEach(function (key) {
    if (t[key] !== undefined && t[key] !== null && t[key] !== '') out[key] = Number(t[key])
  })
  out.edited = Number(t.edited) || 0
  return out
}

function fingerprint(t) { return JSON.stringify(plain(t)) }
function stateFor(bookId) {
  var books = readObj(STATE_KEY) || {}
  var s = books[bookId]
  var joinedAt = (current() || {}).joinedAt || 0
  if (!s || s.joinedAt !== joinedAt) s = {}
  return { bookId: bookId, joinedAt: joinedAt,
    own: Object.assign(Object.create(null), s.own), pending: Object.assign(Object.create(null), s.pending) }
}
function saveState(state) {
  try {
    var books = Object.assign(Object.create(null), readObj(STATE_KEY) || {})
    books[state.bookId] = state
    return writeObj(STATE_KEY, books)
  } catch (e) { return false }
}
function entry(row, fp) { return { version: row.version, sharedId: row.sharedId, fingerprint: fp } }
function sameBook(book) {
  var b = current() || {}
  return b.bookId === book.bookId && b.joinedAt === book.joinedAt && b.shareSince === book.shareSince
}
function remoteId(bookId, row) { return 'shared:' + bookId + ':' + row.sharedId }

function validRow(row) {
  if (!row || typeof row.id !== 'string' || !row.id || typeof row.sharedId !== 'string' || !row.sharedId ||
      typeof row.ownerKey !== 'string' || !row.ownerKey || typeof row.isMe !== 'boolean' ||
      !Number.isInteger(row.version) || row.version < 0) return false
  if (row.deleted === true) return true
  var t = plain(row)
  return isFinite(t.time) && isFinite(new Date(t.time).getTime()) && isFinite(t.amount) && t.amount > 0 &&
    ['expense', 'income', 'refund', 'transfer'].indexOf(t.type) >= 0 &&
    (!t.currency || /^[A-Z]{3}$/.test(t.currency)) && (!t.toCurrency || /^[A-Z]{3}$/.test(t.toCurrency)) &&
    ['nativeAmount', 'rateToCny', 'toNativeAmount', 'toRateToCny'].every(function (key) {
      return t[key] === undefined || (isFinite(t[key]) && t[key] > 0)
    })
}

function pullPages(bookId, cb) {
  var rows = []
  var seen = Object.create(null)
  function page(cursor) {
    call('pull', { bookId: bookId, cursor: cursor }, function (res) {
      if (!res || !res.ok) { cb(res || failure('拉取失败')); return }
      if (res.protocol !== 2) { cb(upgradeError()); return }
      if (!Array.isArray(res.txs) || typeof res.hasMore !== 'boolean') { cb(failure('云端分页结果不完整，未确认同步', 'BAD_RESPONSE')); return }
      for (var i = 0; i < res.txs.length; i++) {
        var row = res.txs[i]
        if (!validRow(row)) { cb(failure('云端存在无效流水，请核对云端数据后重试；本机记录未覆盖', 'BAD_RESPONSE')); return }
        if (!seen[row.sharedId]) { rows.push(row); seen[row.sharedId] = true }
      }
      if (!res.hasMore) { cb(Object.assign({}, res, { txs: rows })); return }
      if (!res.cursor || typeof res.cursor !== 'string' || res.cursor <= cursor) {
        cb(failure('云端分页游标未前进，未确认同步', 'BAD_RESPONSE')); return
      }
      setTimeout(function () { page(res.cursor) }, 0)
    })
  }
  page('')
}

function mergeRemote(bookId, rows, state, resolution) {
  var local = Object.create(null)
  store.all().forEach(function (t) { local[t.id] = t })
  var gone = store.gone()
  var puts = []
  var removes = []
  var conflicts = 0
  var legacyMatches = Object.create(null)
  rows.forEach(function (row) {
    var t = local[row.id]
    if (!row.isMe && t && !isMine(t) && !t.shareId && t.by === row.byName) legacyMatches[t.id] = true
  })
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i]
    if (!row.isMe) {
      var id = remoteId(bookId, row)
      var legacy = local[row.id]
      if (legacy && !isMine(legacy) && !legacy.shareId && legacy.by === row.byName) removes.push(legacy.id)
      if (row.deleted) { if (local[id]) removes.push(id); continue }
      if (gone[id] || (legacy && gone[legacy.id])) continue
      var other = Object.assign(plain(row), {
        id: id, by: row.byName || '成员', byMe: false,
        shareId: row.sharedId, shareBook: bookId, shareSourceId: row.id,
        shareVersion: row.version, ownerKey: row.ownerKey
      })
      if (!local[id] || JSON.stringify(local[id]) !== JSON.stringify(other)) puts.push(other)
      continue
    }
    var t = local[row.id]
    if (t && !isMine(t)) {
      // 旧版本的他人流水可能占用了自己的原始编号，保留到独立命名空间。
      if (!legacyMatches[t.id]) puts.push(Object.assign({}, t, { id: 'legacy:' + bookId + ':' + row.id }))
      removes.push(t.id)
      t = null
    }
    var prior = state.own[row.id]
    var remoteFp = row.deleted ? 'deleted' : fingerprint(row)
    var pending = state.pending[row.id]
    if (pending && pending.fingerprint === remoteFp) {
      prior = entry(row, remoteFp)
      state.own[row.id] = prior
      delete state.pending[row.id]
    }
    if (gone[row.id] && !t) {
      var deletionConflict = !row.deleted && (!prior || (row.version !== prior.version && remoteFp !== prior.fingerprint))
      if (deletionConflict && resolution !== 'local' && resolution !== 'cloud') { conflicts++; continue }
      if (!deletionConflict || resolution !== 'cloud') { state.own[row.id] = entry(row, remoteFp); continue }
    }
    var dirty = t && (!prior || fingerprint(t) !== prior.fingerprint)
    var conflict = dirty && (!prior || row.version !== prior.version) && remoteFp !== fingerprint(t)
    if (conflict) {
      if (resolution === 'cloud') dirty = false
      else if (resolution !== 'local') { conflicts++; continue }
    }
    if (t && dirty) {
      state.own[row.id] = entry(row, remoteFp)
      continue
    }
    if (row.deleted) {
      if (t) removes.push(t.id)
    } else {
      var mine = plain(row)
      if (!t || fingerprint(t) !== remoteFp) puts.push(mine)
    }
    state.own[row.id] = entry(row, remoteFp)
  }
  if (conflicts) return failure(conflicts + ' 笔流水在两台设备上都被修改，本机与云端内容均已保留。请在共同账本页面选择保留哪一份；建议先导出备份', 'CONFLICT')
  var saved = store.applyRemote(puts, removes)
  if (!saved.saved) return storageError()
  if (!saveState(state)) return storageError()
  return Object.assign({ ok: true }, saved)
}

function pushChanges(book, state, cb) {
  var todo = []
  var live = Object.create(null)
  store.all().forEach(function (t) {
    if (!isMine(t)) return
    live[t.id] = t
    var known = state.own[t.id]
    if (Number(t.time) < book.shareSince) return
    var fp = fingerprint(t)
    if (known && known.fingerprint === fp) return
    todo.push({ payload: Object.assign(plain(t), { baseVersion: known ? known.version : 0 }), fingerprint: fp })
  })
  var gone = store.gone()
  Object.keys(state.own).forEach(function (id) {
    if (live[id] || !gone[id] || state.own[id].fingerprint === 'deleted') return
    todo.push({ payload: { id: id, deleted: true, baseVersion: state.own[id].version }, fingerprint: 'deleted' })
  })
  var pushed = 0
  function batch(offset) {
    if (!sameBook(book)) { cb(failure('账本已变化，请重新同步', 'BOOK_CHANGED')); return }
    if (offset >= todo.length) { cb({ ok: true, pushed: pushed }); return }
    var chunk = todo.slice(offset, offset + PUSH_BATCH)
    chunk.forEach(function (item) {
      state.pending[item.payload.id] = { fingerprint: item.fingerprint, baseVersion: item.payload.baseVersion }
    })
    if (!saveState(state)) { cb(storageError()); return }
    call('push', { bookId: book.bookId, txs: chunk.map(function (v) { return v.payload }) }, function (res) {
      if (!res || !res.ok) { cb(res || failure('上传失败，请重试')); return }
      if (res.protocol !== 2) { cb(upgradeError()); return }
      if (res.pushed !== chunk.length || !Array.isArray(res.acks) || res.acks.length !== chunk.length) {
        cb(failure('部分流水未确认上传成功，本机记录仍保留，请重试同步', 'PARTIAL_PUSH')); return
      }
      var acks = Object.create(null)
      res.acks.forEach(function (ack) { if (ack && ack.id) acks[ack.id] = ack })
      for (var i = 0; i < chunk.length; i++) {
        var item = chunk[i]
        var ack = acks[item.payload.id]
        if (!ack || !ack.sharedId || !Number.isInteger(ack.version) || ack.version < 1 || !!ack.deleted !== !!item.payload.deleted) {
          cb(failure('云端上传确认不完整，请重试', 'BAD_RESPONSE')); return
        }
        state.own[item.payload.id] = entry(ack, item.fingerprint)
        delete state.pending[item.payload.id]
      }
      if (!sameBook(book) || !saveState(state)) { cb(storageError()); return }
      pushed += chunk.length
      setTimeout(function () { batch(offset + chunk.length) }, 0)
    })
  }
  batch(0)
}

function sync(cb, resolution) {
  var done = typeof cb === 'function' ? cb : function () {}
  if (waiting) { waiting.push(done); return }
  if (changing) { done(failure('正在处理账本，请稍后同步', 'BUSY')); return }
  var b = current()
  if (!b || !b.bookId) { done(failure('还没加入共同账本，请先创建或输入邀请码加入', 'NO_BOOK')); return }
  if (typeof b.shareSince !== 'number') { done(failure('请先在共同账本页面确认共享范围，再开始同步', 'SCOPE_REQUIRED')); return }
  waiting = [done]
  function finish(res) {
    var callbacks = waiting
    waiting = null
    if (res && res.code === 'NOT_MEMBER' && sameBook(b) && !clear()) res = storageError()
    callbacks.forEach(function (fn) { fn(res) })
  }
  pullPages(b.bookId, function (remote) {
    if (!remote || !remote.ok) { finish(remote); return }
    if (!sameBook(b)) { finish(failure('账本已变化，请重新同步', 'BOOK_CHANGED')); return }
    var state
    var merged
    try {
      state = stateFor(b.bookId)
      merged = mergeRemote(b.bookId, remote.txs, state, resolution)
    } catch (e) { finish(storageError()); return }
    if (!merged.ok) { finish(merged); return }
    try {
      pushChanges(b, state, function (uploaded) {
        if (!uploaded || !uploaded.ok) { finish(uploaded); return }
        var book = current()
        if (!book || !sameBook(b)) { finish(failure('账本已变化，请重新同步', 'BOOK_CHANGED')); return }
        book = Object.assign({}, book, { lastSync: Date.now(), members: remote.members, memberList: remote.memberList })
        if (!writeObj(BOOK_KEY, book)) { finish(storageError()); return }
        finish({ ok: true, pushed: uploaded.pushed, added: merged.added, updated: merged.updated, removed: merged.removed,
          members: remote.members, memberList: remote.memberList })
      })
    } catch (e) { if (waiting) finish(storageError()); else throw e }
  })
}

function viewRows(rows, scope) {
  var b = current()
  if (!b || !b.bookId) return rows
  return rows.filter(function (t) {
    if (!isMine(t) && t.shareBook && t.shareBook !== b.bookId) return false
    return scope === 'mine' ? isMine(t) : (scope === 'peer' ? !isMine(t) : true)
  })
}

function syncSummary(res) {
  return '同步完成：上传 ' + (res.pushed || 0) + '，新增 ' + (res.added || 0) + '，更新 ' + (res.updated || 0) + '，移除 ' + (res.removed || 0) + ' 笔'
}

function remarksAll() {
  try { return readObj(REMARK_KEY) || {} } catch (e) { return {} }
}

function remarkOf(nick, ownerKey) {
  var n = String(nick || '')
  var bid = (current() || {}).bookId || '_'
  var m = remarksAll()[bid] || {}
  var key = ownerKey ? 'member:' + ownerKey : n
  if (Object.prototype.hasOwnProperty.call(m, key)) return String(m[key] || '')
  return Object.prototype.hasOwnProperty.call(m, n) ? String(m[n] || '') : ''
}

function labelOf(nick, ownerKey) { return remarkOf(nick, ownerKey) || String(nick || '') }

function setRemark(nick, remark, ownerKey) {
  var n = String(nick || '').trim()
  if (!n) return ''
  var v = String(remark || '').trim().slice(0, 10)
  var bid = (current() || {}).bookId || '_'
  var all = Object.assign(Object.create(null), remarksAll())
  var m = Object.assign(Object.create(null), all[bid] || {})
  var key = ownerKey ? 'member:' + ownerKey : n
  if (v || ownerKey) m[key] = v
  else delete m[key]
  all[bid] = m
  return writeObj(REMARK_KEY, all) ? v : null
}

function sharePath() { return '/pages/share/share?code=' + ((current() || {}).code || '') }
function setPendingShare(code) {
  var c = String(code || '').trim().toUpperCase().replace(/[^0-9A-Z]/g, '')
  if (c) writeObj(PENDING_KEY, c)
}
function pendingShare() {
  try { return String(wx.getStorageSync(PENDING_KEY) || '') } catch (e) { return '' }
}
function clearPendingShare() { try { wx.removeStorageSync(PENDING_KEY) } catch (e) {} }

module.exports = {
  BOOK_KEY: BOOK_KEY, STATE_KEY: STATE_KEY, PENDING_KEY: PENDING_KEY, REMARK_KEY: REMARK_KEY,
  current: current, isJoined: isJoined, isMine: isMine, myName: myName, busy: busy, viewRows: viewRows,
  createBook: createBook, joinBook: joinBook, info: info, leave: leave, setNick: setNick,
  setShareScope: setShareScope, scopeText: scopeText, sync: sync, syncSummary: syncSummary,
  remarkOf: remarkOf, labelOf: labelOf, setRemark: setRemark, sharePath: sharePath,
  setPendingShare: setPendingShare, pendingShare: pendingShare, clearPendingShare: clearPendingShare
}
