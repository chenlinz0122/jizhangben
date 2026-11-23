// 共同账本：协议 2，身份隔离、版本检查和可重试清理。
const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const BOOKS = 'books'
const BOOK_MEMBERS = 'book_members'
const BOOK_TXS = 'book_txs'
const MEMBER_LIMIT = 10
const PUSH_MAX = 300
const PULL_PAGE = 100
const NICK_MAX = 10
const STRING_LIMITS = { id: 200, day: 32, ym: 16, type: 32, category: 100, desc: 1000,
  account: 100, byPlatform: 100, status: 100, merchant: 200, note: 2000, src: 100, source: 100 }
const TX_FIELDS = Object.keys(STRING_LIMITS).concat(['time', 'amount', 'edited'])

function ok(data) { return Object.assign({ ok: true, protocol: 2 }, data || {}) }
function bad(code, msg, data) { return Object.assign({ ok: false, protocol: 2, code: code, msg: msg }, data || {}) }
function fail(code, msg, details) { throw Object.assign(new Error(msg), { code: code }, details || {}) }
function message(e) { return String((e && (e.errMsg || e.message)) || e || '') }
function failure(e, data) {
  return bad(String((e && (e.code || e.errCode)) || 'SERVER_ERROR'), message(e),
    Object.assign({}, e && e.conflict ? { conflict: e.conflict } : {}, data))
}
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex') }
function sharedId(bookId, openid, id) { return hash(JSON.stringify([bookId, openid, id])) }
function ownerKey(bookId, openid) { return hash(bookId + (openid || '')) }
function memberId(openid) { return hash(JSON.stringify(['member', openid])) }
function isNoCollection(msg) { return /collection not exists|database collection not exists|-502005/i.test(msg) }

let booted = false
async function ensureCollection(name) {
  try {
    await db.createCollection(name)
    return 'created'
  } catch (e) {
    if (/already exist|-501001|duplicate/i.test(message(e))) return 'exists'
    throw e
  }
}
async function bootstrap() {
  if (booted) return { skip: true }
  const books = await ensureCollection(BOOKS)
  const members = await ensureCollection(BOOK_MEMBERS)
  const txs = await ensureCollection(BOOK_TXS)
  booted = true
  return { books: books, members: members, txs: txs }
}
function randomChars(n) {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
  let out = ''
  for (let i = 0; i < n; i++) out += alphabet.charAt(Math.floor(Math.random() * alphabet.length))
  return out
}
function pickNick(raw, fallback) {
  return String(raw || '').replace(/[\s\x00-\x1f\x7f]/g, '').slice(0, NICK_MAX) || fallback || '成员'
}
function limitOf(book) { return Math.max(Number(book && book.memberLimit) || 0, MEMBER_LIMIT) }
async function first(name, where) {
  const snap = await db.collection(name).where(where).limit(1).get()
  return snap.data && snap.data[0]
}
async function getDoc(source, name, id) {
  try {
    const snap = await source.collection(name).doc(id).get()
    return snap.data || null
  } catch (e) {
    if (/document with _id .* does not exist/i.test(message(e))) return null
    throw e
  }
}
function activeBook(book) {
  if (!book) fail('BOOK_NOT_FOUND', '账本已不存在')
  if (book.closing) fail('BOOK_CLOSING', '账本正在解散，请稍后重试退出')
}
function activeMember(member, openid, bookId) {
  if (!member || member.openid !== openid || member.bookId !== bookId) fail('NOT_MEMBER', '你不在这个账本里')
  if (member.leaving) fail('MEMBER_LEAVING', '正在退出账本，请重试退出以完成清理')
}
async function touchBook(transaction, book) {
  await transaction.collection(BOOKS).doc(book._id).update({ data: { syncRevision: (book.syncRevision || 0) + 1 } })
}
async function memberList(bookId, meOpenid) {
  const snap = await db.collection(BOOK_MEMBERS).where({ bookId: bookId }).limit(100).get()
  return (snap.data || []).map(function (r) {
    return { nickname: r.nickname || (r.role === 'owner' ? '账主' : '成员'),
      role: r.role === 'owner' ? 'owner' : 'member', isMe: r.openid === meOpenid,
      ownerKey: ownerKey(bookId, r.openid), joinedAt: r.joinedAt || 0 }
  }).sort(function (a, b) {
    return a.role !== b.role ? (a.role === 'owner' ? -1 : 1) : a.joinedAt - b.joinedAt
  })
}
async function bookReply(book, openid, extra) {
  const list = await memberList(book.bookId, openid)
  return ok(Object.assign({ bookId: book.bookId, name: book.name, code: book.code,
    members: list.length, memberLimit: limitOf(book), memberList: list }, extra))
}

async function create(openid, name, nick) {
  const member = await first(BOOK_MEMBERS, { openid: openid })
  const mine = await first(BOOKS, { owner: openid })
  if (member && (!mine || member.bookId !== mine.bookId)) return bad('ALREADY_JOINED', '你已经在一个共同账本里了，先退出再创建')
  if (mine) {
    activeBook(mine)
    if (member) activeMember(member, openid, mine.bookId)
    await db.runTransaction(async function (transaction) {
      const book = await getDoc(transaction, BOOKS, mine._id)
      activeBook(book)
      const id = member ? member._id : memberId(openid)
      const current = await getDoc(transaction, BOOK_MEMBERS, id)
      if (current) activeMember(current, openid, mine.bookId)
      if (!current) {
        await transaction.collection(BOOK_MEMBERS).doc(id).set({ data: {
          bookId: mine.bookId, openid: openid, nickname: pickNick(nick, '账主'), role: 'owner', joinedAt: Date.now()
        } })
      } else if (nick) {
        await transaction.collection(BOOK_MEMBERS).doc(id).update({ data: { nickname: pickNick(nick, '账主') } })
      }
      await touchBook(transaction, book)
    })
    return bookReply(mine, openid, { created: false })
  }
  let bookId = ''
  for (let i = 0; i < 5 && !bookId; i++) {
    const candidate = randomChars(8)
    if (!await first(BOOKS, { bookId: candidate })) bookId = candidate
  }
  if (!bookId) return bad('SERVER_ERROR', '账本号生成失败，再试一次')
  const book = { bookId: bookId, name: String(name || '').trim().slice(0, 20) || '我们的账本',
    owner: openid, code: randomChars(6), createdAt: Date.now(), memberLimit: MEMBER_LIMIT, syncRevision: 0 }
  await db.runTransaction(async function (transaction) {
    if (await getDoc(transaction, BOOK_MEMBERS, memberId(openid))) fail('ALREADY_JOINED', '你已经在一个共同账本里了')
    if (await getDoc(transaction, BOOKS, bookId)) fail('SERVER_ERROR', '账本号重复，请重试')
    await transaction.collection(BOOKS).doc(bookId).set({ data: book })
    await transaction.collection(BOOK_MEMBERS).doc(memberId(openid)).set({ data: {
      bookId: bookId, openid: openid, nickname: pickNick(nick, '账主'), role: 'owner', joinedAt: Date.now()
    } })
  })
  return bookReply(book, openid, { created: true })
}
async function myBook(openid) {
  const member = await first(BOOK_MEMBERS, { openid: openid })
  if (!member) return ok({ joined: false })
  const book = await first(BOOKS, { bookId: member.bookId })
  if (!book) return ok({ joined: false })
  return bookReply(book, openid, { joined: true, role: member.role, joinedAt: member.joinedAt || 0,
    nickname: member.nickname || '', owner: book.owner === openid, closing: !!book.closing, leaving: !!member.leaving })
}
async function join(openid, rawCode, nick) {
  const code = String(rawCode || '').trim().toUpperCase().replace(/[^0-9A-Z]/g, '')
  if (code.length !== 6) return bad('BAD_FORMAT', '邀请码是 6 位，检查一下')
  const book = await first(BOOKS, { code: code })
  if (!book) return bad('BAD_CODE', '没找到这个账本，让 TA 重新发一次')
  activeBook(book)
  const mine = await first(BOOK_MEMBERS, { openid: openid })
  if (mine && mine.bookId !== book.bookId) return bad('ALREADY_JOINED', '你已经在一个共同账本里了，先退出再加入')
  const already = await db.runTransaction(async function (transaction) {
    const currentBook = await getDoc(transaction, BOOKS, book._id)
    activeBook(currentBook)
    const id = mine ? mine._id : memberId(openid)
    const current = await getDoc(transaction, BOOK_MEMBERS, id)
    if (current && current.bookId !== book.bookId) fail('ALREADY_JOINED', '你已经在一个共同账本里了')
    if (current) {
      activeMember(current, openid, book.bookId)
      if (nick) await transaction.collection(BOOK_MEMBERS).doc(id).update({ data: { nickname: pickNick(nick, '成员') } })
    } else {
      const count = await db.collection(BOOK_MEMBERS).where({ bookId: book.bookId }).count()
      if (count.total >= limitOf(currentBook)) fail('FULL', '这个账本已经满员了')
      await transaction.collection(BOOK_MEMBERS).doc(id).set({ data: {
        bookId: book.bookId, openid: openid, nickname: pickNick(nick, '成员'), role: 'member', joinedAt: Date.now()
      } })
    }
    await touchBook(transaction, currentBook)
    return !!current
  })
  return bookReply(book, openid, { already: already })
}
async function setNick(openid, rawNick) {
  const member = await first(BOOK_MEMBERS, { openid: openid })
  if (!member) return bad('NOT_MEMBER', '你还没加入共同账本')
  const nick = pickNick(rawNick, '')
  await db.collection(BOOK_MEMBERS).doc(member._id).update({ data: { nickname: nick } })
  return ok({ nickname: nick, memberList: await memberList(member.bookId, openid) })
}

function versionOf(row) {
  const version = row && row.version != null ? row.version : 0
  if (!Number.isSafeInteger(version) || version < 0) fail('BAD_STORED_VERSION', '云端记录版本无效')
  return version
}
function nextVersion(row) {
  const version = versionOf(row)
  if (version === Number.MAX_SAFE_INTEGER) fail('VERSION_OVERFLOW', '记录版本已达上限')
  return version + 1
}
function content(row) {
  if (row.deleted === true) return { id: row.id, deleted: true }
  const out = {}
  TX_FIELDS.forEach(function (key) {
    out[key] = row[key] == null ? (key === 'time' || key === 'amount' || key === 'edited' ? 0 : '') : row[key]
  })
  out.deleted = false
  return out
}
function validateRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) fail('BAD_TX', '流水必须是对象')
  if (typeof row.id !== 'string' || !row.id.trim() || row.id.length > STRING_LIMITS.id) fail('BAD_TX', '流水 id 必须是 1 到 200 字符的非空字符串')
  if (row.deleted !== undefined && typeof row.deleted !== 'boolean') fail('BAD_TX', 'deleted 必须是布尔值')
  if (row.baseVersion !== undefined && (!Number.isSafeInteger(row.baseVersion) || row.baseVersion < 0)) fail('BAD_TX', 'baseVersion 必须是非负整数')
  Object.keys(STRING_LIMITS).forEach(function (key) {
    if (row[key] != null && (typeof row[key] !== 'string' || row[key].length > STRING_LIMITS[key])) fail('BAD_TX', key + ' 类型或长度无效')
  })
  if (row.edited != null && typeof row.edited !== 'boolean' && (!Number.isFinite(row.edited) || row.edited < 0)) fail('BAD_TX', 'edited 必须是非负数或布尔值')
  if (!row.deleted) {
    if (['expense', 'income', 'refund', 'transfer'].indexOf(row.type) < 0) fail('BAD_TX', '流水类型无效')
    if (!Number.isFinite(row.amount) || row.amount <= 0) fail('BAD_TX', '金额必须是有限正数')
    if (!Number.isFinite(row.time) || row.time <= 0 || row.time > 8640000000000000) fail('BAD_TX', '时间必须是有效的正数时间戳')
  }
  return { desired: content(row), baseVersion: row.baseVersion === undefined ? 0 : row.baseVersion }
}
function ack(row, id) { return { id: row.id, sharedId: id, version: versionOf(row), deleted: row.deleted === true } }
async function access(openid, bookId) {
  if (typeof bookId !== 'string' || !bookId.trim() || bookId.length > 200) fail('BAD_FORMAT', 'bookId 无效')
  const member = await first(BOOK_MEMBERS, { bookId: bookId, openid: openid })
  activeMember(member, openid, bookId)
  const book = await first(BOOKS, { bookId: bookId })
  activeBook(book)
  return { member: member, book: book }
}
async function push(openid, bookId, txs) {
  const acks = []
  let index = 0
  try {
    if (!Array.isArray(txs)) fail('BAD_TXS', 'txs 必须是数组')
    if (txs.length > PUSH_MAX) fail('TOO_MANY_TXS', '每次最多推送 ' + PUSH_MAX + ' 条，请分批提交')
    const records = []
    for (index = 0; index < txs.length; index++) records.push(validateRow(txs[index]))
    index = 0
    const context = await access(openid, bookId)
    for (; index < records.length; index++) {
      const record = records[index]
      const desired = record.desired
      const legacy = await first(BOOK_TXS, { bookId: bookId, openid: openid, id: desired.id })
      const id = legacy ? legacy._id : sharedId(bookId, openid, desired.id)
      const result = await db.runTransaction(async function (transaction) {
        const book = await getDoc(transaction, BOOKS, context.book._id)
        activeBook(book)
        const member = await getDoc(transaction, BOOK_MEMBERS, context.member._id)
        activeMember(member, openid, bookId)
        const existing = await getDoc(transaction, BOOK_TXS, id)
        if (existing && (existing.openid !== openid || existing.bookId !== bookId || existing.id !== desired.id)) fail('OWNER_MISMATCH', '不能覆盖其他成员的流水')
        if (existing && JSON.stringify(content(existing)) === JSON.stringify(desired)) return ack(existing, id)
        if (record.baseVersion !== versionOf(existing)) {
          fail('VERSION_CONFLICT', '流水已更新，请先拉取再处理冲突', { conflict: { id: desired.id, sharedId: id,
            version: versionOf(existing), deleted: !!(existing && existing.deleted) } })
        }
        const doc = Object.assign({}, desired, { bookId: bookId, openid: openid,
          byName: pickNick(member.nickname, member.role === 'owner' ? '账主' : '成员'),
          updatedAt: Date.now(), version: nextVersion(existing) })
        await touchBook(transaction, book)
        await transaction.collection(BOOK_TXS).doc(id).set({ data: doc })
        return ack(doc, id)
      })
      acks.push(result)
    }
    return ok({ pushed: acks.length, acks: acks })
  } catch (e) {
    return failure(e, { pushed: acks.length, acks: acks, failedIndex: index })
  }
}
async function pull(openid, bookId, cursor) {
  if (cursor === undefined) cursor = ''
  if (typeof cursor !== 'string' || cursor.length > 200) fail('BAD_CURSOR', 'cursor 必须是文档游标字符串')
  await access(openid, bookId)
  const where = { bookId: bookId }
  if (cursor) where._id = db.command.gt(cursor)
  const snap = await db.collection(BOOK_TXS).where(where).orderBy('_id', 'asc').limit(PULL_PAGE).get()
  const rows = snap.data || []
  const next = rows.length ? rows[rows.length - 1]._id : cursor
  let hasMore = false
  if (rows.length === PULL_PAGE) {
    const extra = await db.collection(BOOK_TXS).where({ bookId: bookId, _id: db.command.gt(next) })
      .orderBy('_id', 'asc').limit(1).get()
    hasMore = !!(extra.data && extra.data.length)
  }
  const list = await memberList(bookId, openid)
  const names = new Map(list.map(function (member) { return [member.ownerKey, member.nickname] }))
  const out = rows.map(function (row) {
    const key = ownerKey(bookId, row.openid)
    return Object.assign(content(row), { sharedId: row._id, ownerKey: key, isMe: row.openid === openid,
      byName: row.byName || names.get(key) || '成员', version: versionOf(row), deleted: row.deleted === true })
  })
  return ok({ txs: out, cursor: next, hasMore: hasMore, members: list.length, memberList: list })
}

async function removeAll(name, where) {
  while (true) {
    const snap = await db.collection(name).where(where).limit(100).get()
    if (!snap.data || !snap.data.length) return
    for (const row of snap.data) await db.collection(name).doc(row._id).remove()
  }
}
function sameMembership(current, original) {
  return current.openid === original.openid && current.bookId === original.bookId &&
    current.role === original.role && current.joinedAt === original.joinedAt
}
function leavingMember(current, original) {
  if (current && (!sameMembership(current, original) || !current.leaving)) fail('MEMBER_CHANGED', '成员身份已改变，请刷新账本状态')
}
async function leave(openid) {
  const member = await first(BOOK_MEMBERS, { openid: openid })
  if (!member) return ok({ joined: false })
  const book = await first(BOOKS, { bookId: member.bookId })
  const owner = member.role === 'owner'
  // 与 push/join 共用账本文档作为写入屏障。
  const marked = await db.runTransaction(async function (transaction) {
    const currentBook = book && await getDoc(transaction, BOOKS, book._id)
    const currentMember = await getDoc(transaction, BOOK_MEMBERS, member._id)
    if (!currentMember) return false
    if (!sameMembership(currentMember, member)) fail('MEMBER_CHANGED', '成员身份已改变，请刷新账本状态')
    if (currentBook) {
      await transaction.collection(BOOKS).doc(currentBook._id).update({ data: {
        syncRevision: (currentBook.syncRevision || 0) + 1,
        closing: owner || !!currentBook.closing
      } })
    }
    await transaction.collection(BOOK_MEMBERS).doc(member._id).update({ data: { leaving: true } })
    return true
  })
  if (!marked) return ok({ joined: false })
  if (owner) {
    await removeAll(BOOK_TXS, { bookId: member.bookId })
    await removeAll(BOOK_MEMBERS, { bookId: member.bookId, openid: db.command.neq(openid) })
  } else {
    let cursor = ''
    while (true) {
      const where = { bookId: member.bookId, openid: openid }
      if (cursor) where._id = db.command.gt(cursor)
      const snap = await db.collection(BOOK_TXS).where(where).orderBy('_id', 'asc').limit(100).get()
      const rows = snap.data || []
      if (!rows.length) break
      for (const row of rows) {
        await db.runTransaction(async function (transaction) {
          const currentBook = book && await getDoc(transaction, BOOKS, book._id)
          const currentMember = await getDoc(transaction, BOOK_MEMBERS, member._id)
          leavingMember(currentMember, member)
          if (!currentMember) return
          const existing = await getDoc(transaction, BOOK_TXS, row._id)
          if (!existing || existing.deleted === true) return
          if (existing.openid !== openid || existing.bookId !== member.bookId) fail('OWNER_MISMATCH', '流水归属已改变')
          if (currentBook) await touchBook(transaction, currentBook)
          await transaction.collection(BOOK_TXS).doc(row._id).set({ data: {
            id: existing.id, deleted: true, bookId: member.bookId, openid: openid,
            byName: existing.byName || pickNick(member.nickname, '成员'), version: nextVersion(existing), updatedAt: Date.now()
          } })
        })
      }
      cursor = rows[rows.length - 1]._id
    }
  }
  // 账主身份保留到最后；最后两次删除在同一事务内提交。
  await db.runTransaction(async function (transaction) {
    const currentBook = book && await getDoc(transaction, BOOKS, book._id)
    const currentMember = await getDoc(transaction, BOOK_MEMBERS, member._id)
    leavingMember(currentMember, member)
    if (currentBook) {
      if (owner) await transaction.collection(BOOKS).doc(book._id).remove()
      else await touchBook(transaction, currentBook)
    }
    if (currentMember) await transaction.collection(BOOK_MEMBERS).doc(member._id).remove()
  })
  return ok(Object.assign({ joined: false }, owner ? { dissolved: true } : {}))
}

async function run(action, openid, event) {
  if ((action === 'push' || action === 'pull') && event.protocol !== 2) {
    return bad('UPGRADE_REQUIRED', '共同账本同步协议已升级，请更新客户端', action === 'push' ? { pushed: 0, acks: [] } : {})
  }
  if (action === 'create') return create(openid, event.name, event.nickname)
  if (action === 'my') return myBook(openid)
  if (action === 'join') return join(openid, event.code, event.nickname)
  if (action === 'leave') return leave(openid)
  if (action === 'setNick') return setNick(openid, event.nickname)
  if (action === 'push') return push(openid, event.bookId, event.txs)
  if (action === 'pull') return pull(openid, event.bookId, event.cursor)
  if (action === 'initdb') return ok(await bootstrap())
  return bad('BAD_ACTION', '不认识的操作：' + action)
}
exports.main = async function (event) {
  event = event || {}
  const openid = (cloud.getWXContext() || {}).OPENID
  const action = String(event.action || 'my')
  const emptyPush = action === 'push' ? { pushed: 0, acks: [] } : {}
  if (!openid) return bad('NO_OPENID', '拿不到微信身份，请在小程序里调用', emptyPush)
  try {
    return await run(action, openid, event)
  } catch (e) {
    if (isNoCollection(message(e))) {
      try {
        await bootstrap()
        return await run(action, openid, event)
      } catch (retryError) {
        return failure(retryError, emptyPush)
      }
    }
    return failure(e, emptyPush)
  }
}
