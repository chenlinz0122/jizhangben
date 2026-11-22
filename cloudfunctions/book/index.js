// 云函数：共同账本（多人记同一本账）
//
// 集合：
//   books         { bookId, name, owner, code, createdAt, memberLimit }
//   book_members  { bookId, openid, nickname, role:'owner'|'member', joinedAt }
//   book_txs      { _id: bookId + '_' + txId, bookId, ...一条流水, openid, byName, updatedAt }
//
// 设计取舍：
//   1. 账目仍然以本地 Storage 为主，云端只是「中转站」：谁记账谁推，别人拉下来合并，
//      本地按 id 去重，所以断网也能照常记；
//   2. book_txs 用「bookId_txId」做文档 _id，天然幂等：同一条推两次不会多出一条；
//   3. 一个账本最多 10 人（一家人 / 室友 / 小团队够用），不做实时同步，切页/下拉时拉一次；
//   4. 每条流水带「记的人」：push 时把成员昵称写进 byName，pull 时回给客户端 byName + isMe，
//      客户端合并后本地也能显示「这笔是谁记的」；
//   5. openid 不返回给客户端，只在云端用来判断成员身份和「是不是我记的」。
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const BOOKS = 'books'
const BOOK_MEMBERS = 'book_members'
const BOOK_TXS = 'book_txs'

const MEMBER_LIMIT = 10
const PUSH_MAX = 300
const PULL_PAGE = 100
const PULL_PAGES = 6
const NICK_MAX = 10

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

/* 昵称：去掉首尾空白和控制字符，最多 10 个字；没填就给个默认 */
function pickNick(raw, fallback) {
  const v = String(raw || '').replace(/[\s\r\n\t]/g, '').slice(0, NICK_MAX)
  return v || fallback || '成员'
}

/* 老账本的 memberLimit 是 3，不能因为它写死了就把老账本卡在 3 人：取「最大值」 */
function limitOf(book) {
  const n = Number((book && book.memberLimit) || 0)
  return Math.max(n || 0, MEMBER_LIMIT)
}

function memberOf(openid, bookId) {
  return db.collection(BOOK_MEMBERS).where({ bookId: bookId, openid: openid }).limit(1).get()
}

/* 成员清单里只回「名字 + 角色 + 是不是我」，不回 openid */
async function memberList(bookId, meOpenid) {
  const snap = await db.collection(BOOK_MEMBERS).where({ bookId: bookId }).limit(50).get()
  const rows = (snap && snap.data) || []
  const list = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (!r) continue
    list.push({
      nickname: r.nickname || (r.role === 'owner' ? '账主' : '成员'),
      role: r.role === 'owner' ? 'owner' : 'member',
      isMe: r.openid === meOpenid,
      joinedAt: r.joinedAt || 0
    })
  }
  list.sort(function (a, b) {
    if (a.role !== b.role) return a.role === 'owner' ? -1 : 1
    return (a.joinedAt || 0) - (b.joinedAt || 0)
  })
  return list
}

async function create(openid, name, nick) {
  const bookName = String(name || '').trim().slice(0, 20) || '我们的账本'
  const mine = await db.collection(BOOKS).where({ owner: openid }).limit(1).get()
  if (mine.data && mine.data.length) {
    const b = mine.data[0]
    /* 已经建过：顺手把昵称补上，方便老账本升级后显示名字 */
    if (nick) await db.collection(BOOK_MEMBERS).where({ bookId: b.bookId, openid: openid })
      .update({ data: { nickname: pickNick(nick, '账主') } }).catch(function () {})
    const list = await memberList(b.bookId, openid)
    return ok({
      bookId: b.bookId, name: b.name, code: b.code, created: false,
      members: list.length, memberLimit: limitOf(b), memberList: list
    })
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
    data: { bookId: bookId, openid: openid, nickname: pickNick(nick, '账主'), role: 'owner', joinedAt: Date.now() }
  })
  const list = await memberList(bookId, openid)
  return ok({
    bookId: bookId, name: bookName, code: code, created: true,
    members: list.length, memberLimit: MEMBER_LIMIT, memberList: list
  })
}

async function myBook(openid) {
  const m = await db.collection(BOOK_MEMBERS).where({ openid: openid }).limit(1).get()
  const row = m.data && m.data[0]
  if (!row) return ok({ joined: false })
  const b = await db.collection(BOOKS).where({ bookId: row.bookId }).limit(1).get()
  const book = b.data && b.data[0]
  if (!book) return ok({ joined: false })
  const list = await memberList(book.bookId, openid)
  return ok({
    joined: true,
    bookId: book.bookId,
    name: book.name,
    code: book.code,
    role: row.role,
    nickname: row.nickname || '',
    members: list.length,
    memberList: list,
    memberLimit: limitOf(book),
    owner: book.owner === openid
  })
}

async function join(openid, rawCode, nick) {
  const code = String(rawCode || '').trim().toUpperCase().replace(/[^0-9A-Z]/g, '')
  if (code.length !== 6) return bad('BAD_FORMAT', '邀请码是 6 位，检查一下')

  const b = await db.collection(BOOKS).where({ code: code }).limit(1).get()
  const book = b.data && b.data[0]
  if (!book) return bad('BAD_CODE', '没找到这个账本，让 TA 重新发一次')

  const already = await memberOf(openid, book.bookId)
  if (already.data && already.data.length) {
    if (nick) {
      await db.collection(BOOK_MEMBERS).where({ bookId: book.bookId, openid: openid })
        .update({ data: { nickname: pickNick(nick, '成员') } }).catch(function () {})
    }
    const list = await memberList(book.bookId, openid)
    return ok({
      bookId: book.bookId, name: book.name, code: book.code, already: true,
      members: list.length, memberLimit: limitOf(book), memberList: list
    })
  }

  /* 自己已经有账本就别加了：一个人只带一本共同账本，避免账目串在一起 */
  const mine = await db.collection(BOOK_MEMBERS).where({ openid: openid }).limit(1).get()
  if (mine.data && mine.data.length) {
    return bad('ALREADY_JOINED', '你已经在一个共同账本里了，先退出再加入')
  }

  const cnt = await db.collection(BOOK_MEMBERS).where({ bookId: book.bookId }).count()
  const n = (cnt && cnt.total) || 0
  const cap = limitOf(book)
  if (n >= cap) return bad('FULL', '这个账本已经 ' + cap + ' 个人了，满了')

  await db.collection(BOOK_MEMBERS).add({
    data: { bookId: book.bookId, openid: openid, nickname: pickNick(nick, '成员'), role: 'member', joinedAt: Date.now() }
  })
  const list = await memberList(book.bookId, openid)
  return ok({
    bookId: book.bookId, name: book.name, code: book.code,
    members: list.length, memberLimit: cap, memberList: list
  })
}

/* 改自己的昵称：只影响以后推上去的记录，已经推过的历史记录保留当时的名字 */
async function setNick(openid, rawNick) {
  const nick = pickNick(rawNick, '')
  if (!nick) return bad('BAD_FORMAT', '名字不能为空')
  const m = await db.collection(BOOK_MEMBERS).where({ openid: openid }).limit(1).get()
  const row = m.data && m.data[0]
  if (!row) return bad('NOT_MEMBER', '你还没加入共同账本')
  await db.collection(BOOK_MEMBERS).where({ bookId: row.bookId, openid: openid })
    .update({ data: { nickname: nick } })
  const list = await memberList(row.bookId, openid)
  return ok({ nickname: nick, memberList: list })
}

async function leave(openid) {
  const m = await db.collection(BOOK_MEMBERS).where({ openid: openid }).limit(1).get()
  const row = m.data && m.data[0]
  if (!row) return ok({ joined: false })
  await db.collection(BOOK_MEMBERS).where({ openid: openid }).remove()
  /* 账主退出就把整本拆了：否则别人会留在一个人人都不在的账本里 */
  if (row.role === 'owner') {
    await db.collection(BOOK_MEMBERS).where({ bookId: row.bookId }).remove()
    await db.collection(BOOK_TXS).where({ bookId: row.bookId }).remove()
    await db.collection(BOOKS).where({ bookId: row.bookId }).remove()
    return ok({ joined: false, dissolved: true })
  }
  /* 普通成员退出：只把自己挪出去，账本和别人记的都留着 */
  await db.collection(BOOK_TXS).where({ bookId: row.bookId, openid: openid }).remove().catch(function () {})
  return ok({ joined: false })
}

async function push(openid, bookId, txs) {
  const m = await memberOf(openid, bookId)
  if (!m.data || !m.data.length) return bad('NOT_MEMBER', '你不在这个账本里')
  const byName = pickNick(m.data[0].nickname, m.data[0].role === 'owner' ? '账主' : '成员')

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
      doc.byName = byName
      doc.updatedAt = Number(t.updatedAt) || Date.now()
      const id = String(bookId + '_' + t.id).replace(/[^\w\-]/g, '_').slice(0, 120)
      return db.collection(BOOK_TXS).doc(id).set({ data: doc }).then(function () { pushed++ })
        .catch(function () {})
    }))
  }
  return ok({ pushed: pushed, byName: byName })
}

async function pull(openid, bookId) {
  const m = await memberOf(openid, bookId)
  if (!m.data || !m.data.length) return bad('NOT_MEMBER', '你不在这个账本里')

  const rows = []
  for (let p = 0; p < PULL_PAGES; p++) {
    const snap = await db.collection(BOOK_TXS).where({ bookId: bookId })
      .orderBy('time', 'desc').skip(p * PULL_PAGE).limit(PULL_PAGE).get()
    const list = (snap && snap.data) || []
    for (let i = 0; i < list.length; i++) rows.push(list[i])
    if (list.length < PULL_PAGE) break
  }

  /* 白名单回传：openid 一律不出云端，只给「谁记的」和「是不是我」 */
  const out = []
  for (let i = 0; i < rows.length; i++) {
    const d = rows[i]
    const one = {}
    TX_FIELDS.forEach(function (k) { if (d[k] !== undefined && d[k] !== null) one[k] = d[k] })
    one.byName = d.byName || ''
    one.isMe = d.openid ? (d.openid === openid) : true
    out.push(one)
  }

  const list = await memberList(bookId, openid)
  return ok({ txs: out, members: list.length, memberList: list })
}

const run = async function (action, openid, event) {
  if (action === 'create') return await create(openid, event && event.name, event && event.nickname)
  if (action === 'my') return await myBook(openid)
  if (action === 'join') return await join(openid, event && event.code, event && event.nickname)
  if (action === 'leave') return await leave(openid)
  if (action === 'setNick') return await setNick(openid, event && event.nickname)
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
