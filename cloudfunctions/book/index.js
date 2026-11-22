// 云函数：共同账本（两个人记同一本账）
//
// 集合：
//   books         { bookId, name, owner, code, createdAt, memberLimit }
//   book_members  { bookId, openid, role:'owner'|'member', joinedAt }
//   book_txs      { _id: bookId + '_' + txId, bookId, ...一条流水, openid, updatedAt }
//
// 设计取舍：
//   1. 账目仍然以本地 Storage 为主，云端只是「中转站」：谁记账谁推，对方拉下来合并，
//      本地按 id 去重，所以断网也能照常记；
//   2. book_txs 用「bookId_txId」做文档 _id，天然幂等：同一条推两次不会多出一条；
//   3. 一个账本最多 3 人（两个人够用，留一个给家人），不做实时同步，切页/下拉时拉一次。
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const BOOKS = 'books'
const BOOK_MEMBERS = 'book_members'
const BOOK_TXS = 'book_txs'

const MEMBER_LIMIT = 3
const PUSH_MAX = 300
const PULL_PAGE = 100
const PULL_PAGES = 6

/* 允许上云的字段白名单：不把本地私有字段（比如 ai 中间态）带出去 */
const TX_FIELDS = ['id', 'time', 'day', 'ym', 'type', 'amount', 'category', 'desc', 'account',
  'byPlatform', 'status', 'merchant', 'note', 'src', 'edited']

function ok(data) { return Object.assign({ ok: true }, data || {}) }
function bad(code, msg) { return { ok: false, code: code, msg: msg } }

function isNoCollection(msg) {
  return /collection not exists|database collection not exists|-502005/i.test(String(msg || ''))
}

let booted = false
async function ensureCollection(name) {
  try {
    await db.createCollection(name)
    return 'created'
  } catch (e) {
    const msg = String((e && e.errMsg) || (e && e.message) || e || '')
    if (/already exist|-501001|duplicate/i.test(msg)) return 'exists'
    return 'skip'
  }
}
async function bootstrap() {
  if (booted) return { skip: true }
  const a = await ensureCollection(BOOKS)
  const b = await ensureCollection(BOOK_MEMBERS)
  const c = await ensureCollection(BOOK_TXS)
  booted = true
  return { books: a, members: b, txs: c }
}

function randomChars(n) {
  const ALPHA = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
  let out = ''
  for (let i = 0; i < n; i++) out += ALPHA.charAt(Math.floor(Math.random() * ALPHA.length))
  return out
}

function memberOf(openid, bookId) {
  return db.collection(BOOK_MEMBERS).where({ bookId: bookId, openid: openid }).limit(1).get()
}

async function create(openid, name) {
  const bookName = String(name || '').trim().slice(0, 20) || '我们的账本'
  const mine = await db.collection(BOOKS).where({ owner: openid }).limit(1).get()
  if (mine.data && mine.data.length) {
    const b = mine.data[0]
    return ok({ bookId: b.bookId, name: b.name, code: b.code, created: false })
  }

  let bookId = ''
  for (let i = 0; i < 5 && !bookId; i++) {
    const tryId = randomChars(8)
    const dup = await db.collection(BOOKS).where({ bookId: tryId }).limit(1).get()
    if (!dup.data || !dup.data.length) bookId = tryId
  }
  if (!bookId) return bad('SERVER_ERROR', '账本号生成失败，再试一次')

  const code = randomChars(6)
  await db.collection(BOOKS).add({
    data: { bookId: bookId, name: bookName, owner: openid, code: code, createdAt: Date.now(), memberLimit: MEMBER_LIMIT }
  })
  await db.collection(BOOK_MEMBERS).add({
    data: { bookId: bookId, openid: openid, role: 'owner', joinedAt: Date.now() }
  })
  return ok({ bookId: bookId, name: bookName, code: code, created: true })
}

async function myBook(openid) {
  const m = await db.collection(BOOK_MEMBERS).where({ openid: openid }).limit(1).get()
  const row = m.data && m.data[0]
  if (!row) return ok({ joined: false })
  const b = await db.collection(BOOKS).where({ bookId: row.bookId }).limit(1).get()
  const book = b.data && b.data[0]
  if (!book) return ok({ joined: false })
  const cnt = await db.collection(BOOK_MEMBERS).where({ bookId: book.bookId }).count()
  return ok({
    joined: true,
    bookId: book.bookId,
    name: book.name,
    code: book.code,
    role: row.role,
    members: (cnt && cnt.total) || 0,
    memberLimit: book.memberLimit || MEMBER_LIMIT,
    owner: book.owner === openid
  })
}

async function join(openid, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase().replace(/[^0-9A-Z]/g, '')
  if (code.length !== 6) return bad('BAD_FORMAT', '邀请码是 6 位，检查一下')

  const b = await db.collection(BOOKS).where({ code: code }).limit(1).get()
  const book = b.data && b.data[0]
  if (!book) return bad('BAD_CODE', '没找到这个账本，让 TA 重新发一次')

  const already = await memberOf(openid, book.bookId)
  if (already.data && already.data.length) {
    return ok({ bookId: book.bookId, name: book.name, code: book.code, already: true })
  }

  /* 自己已经有账本就别加了：一个人只带一本共同账本，避免账目串在一起 */
  const mine = await db.collection(BOOK_MEMBERS).where({ openid: openid }).limit(1).get()
  if (mine.data && mine.data.length) {
    return bad('ALREADY_JOINED', '你已经在一个共同账本里了，先退出再加入')
  }

  const cnt = await db.collection(BOOK_MEMBERS).where({ bookId: book.bookId }).count()
  const n = (cnt && cnt.total) || 0
  if (n >= (book.memberLimit || MEMBER_LIMIT)) return bad('FULL', '这个账本人数满了')

  await db.collection(BOOK_MEMBERS).add({
    data: { bookId: book.bookId, openid: openid, role: 'member', joinedAt: Date.now() }
  })
  return ok({ bookId: book.bookId, name: book.name, code: book.code, members: n + 1 })
}

async function leave(openid) {
  const m = await db.collection(BOOK_MEMBERS).where({ openid: openid }).limit(1).get()
  const row = m.data && m.data[0]
  if (!row) return ok({ joined: false })
  await db.collection(BOOK_MEMBERS).where({ openid: openid }).remove()
  /* 房主退出就把整本拆了：否则对方会留在一个人人都不在的账本里 */
  if (row.role === 'owner') {
    await db.collection(BOOK_MEMBERS).where({ bookId: row.bookId }).remove()
    await db.collection(BOOK_TXS).where({ bookId: row.bookId }).remove()
    await db.collection(BOOKS).where({ bookId: row.bookId }).remove()
    return ok({ joined: false, dissolved: true })
  }
  return ok({ joined: false })
}

async function push(openid, bookId, txs) {
  const m = await memberOf(openid, bookId)
  if (!m.data || !m.data.length) return bad('NOT_MEMBER', '你不在这个账本里')

  const list = Array.isArray(txs) ? txs.slice(0, PUSH_MAX) : []
  if (!list.length) return ok({ pushed: 0 })

  let pushed = 0
  for (let i = 0; i < list.length; i += 20) {
    const chunk = list.slice(i, i + 20)
    await Promise.all(chunk.map(function (t) {
      if (!t || !t.id) return Promise.resolve()
      const doc = {}
      TX_FIELDS.forEach(function (k) { if (t[k] !== undefined && t[k] !== null) doc[k] = t[k] })
      doc.bookId = bookId
      doc.openid = openid
      doc.updatedAt = Number(t.updatedAt) || Date.now()
      const id = String(bookId + '_' + t.id).replace(/[^\w\-]/g, '_').slice(0, 120)
      return db.collection(BOOK_TXS).doc(id).set({ data: doc }).then(function () { pushed++ })
        .catch(function () {})
    }))
  }
  return ok({ pushed: pushed })
}

async function pull(openid, bookId) {
  const m = await memberOf(openid, bookId)
  if (!m.data || !m.data.length) return bad('NOT_MEMBER', '你不在这个账本里')

  const rows = []
  for (let p = 0; p < PULL_PAGES; p++) {
    const snap = await db.collection(BOOK_TXS).where({ bookId: bookId })
      .orderBy('time', 'desc').skip(p * PULL_PAGE).limit(PULL_PAGE).get()
    const list = (snap && snap.data) || []
    list.forEach(function (d) { rows.push(d) })
    if (list.length < PULL_PAGE) break
  }

  const members = await db.collection(BOOK_MEMBERS).where({ bookId: bookId }).count()
  return ok({ txs: rows, members: (members && members.total) || 0 })
}

const run = async function (action, openid, event) {
  if (action === 'create') return await create(openid, event && event.name)
  if (action === 'my') return await myBook(openid)
  if (action === 'join') return await join(openid, event && event.code)
  if (action === 'leave') return await leave(openid)
  if (action === 'push') return await push(openid, event && event.bookId, event && event.txs)
  if (action === 'pull') return await pull(openid, event && event.bookId)
  if (action === 'initdb') return ok(await bootstrap())
  return bad('BAD_ACTION', '不认识的操作：' + action)
}

exports.main = async function (event) {
  const wxContext = cloud.getWXContext()
  const openid = wxContext && wxContext.OPENID
  if (!openid) return bad('NO_OPENID', '拿不到微信身份，请在小程序里调用')

  const action = String((event && event.action) || 'my')
  try {
    return await run(action, openid, event)
  } catch (e) {
    const msg = String((e && e.errMsg) || (e && e.message) || e || '')
    if (isNoCollection(msg)) {
      try {
        await bootstrap()
        return await run(action, openid, event)
      } catch (e2) {
        const msg2 = String((e2 && e2.errMsg) || (e2 && e2.message) || e2 || '')
        if (isNoCollection(msg2)) return bad('NO_COLLECTION', '云数据库里还没有建 books 集合')
        return bad('SERVER_ERROR', msg2)
      }
    }
    return bad('SERVER_ERROR', msg)
  }
}
