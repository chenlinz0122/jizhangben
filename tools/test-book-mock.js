// 云函数 book 的离线自测：内存假库跑「建账本 → 多人加入 → 推送 → 拉取 → 退群 / 解散」全流程
// 跑法：node tools/test-book-mock.js
const Module = require('module')
const path = require('path')

function makeDB() {
  const store = {}
  let seq = 0
  const NEQ = '$neq'
  const rowsOf = (name) => {
    if (!store[name]) store[name] = []
    return store[name]
  }
  const match = (doc, q) => Object.keys(q || {}).every((k) => {
    const want = q[k]
    if (want && typeof want === 'object' && NEQ in want) return doc[k] !== want[NEQ]
    return doc[k] === want
  })
  const api = {
    createCollection(name) {
      if (store[name]) {
        const e = new Error('collection already exists')
        e.errMsg = 'collection already exists'
        return Promise.reject(e)
      }
      store[name] = []
      return Promise.resolve({})
    },
    collection(name) {
      const rows = rowsOf(name)
      const ctx = { q: null, lim: 0, skip: 0, order: null }
      const q = {
        where(cond) { ctx.q = cond; return q },
        limit(n) { ctx.lim = n; return q },
        skip(n) { ctx.skip = n; return q },
        orderBy(field, dir) { ctx.order = { field, dir }; return q },
        get() {
          let list = ctx.q ? rows.filter((d) => match(d, ctx.q)) : rows.slice()
          if (ctx.order) {
            const { field, dir } = ctx.order
            list = list.slice().sort((a, b) => (dir === 'desc' ? (b[field] || 0) - (a[field] || 0) : (a[field] || 0) - (b[field] || 0)))
          }
          if (ctx.skip) list = list.slice(ctx.skip)
          if (ctx.lim) list = list.slice(0, ctx.lim)
          return Promise.resolve({ data: list.map((d) => Object.assign({}, d)) })
        },
        count() {
          const list = ctx.q ? rows.filter((d) => match(d, ctx.q)) : rows
          return Promise.resolve({ total: list.length })
        },
        add(opts) {
          const doc = Object.assign({ _id: 'id' + ++seq }, opts.data)
          rows.push(doc)
          return Promise.resolve({ _id: doc._id })
        },
        update(opts) {
          const list = ctx.q ? rows.filter((d) => match(d, ctx.q)) : rows
          list.forEach((d) => Object.assign(d, opts.data))
          return Promise.resolve({ stats: { updated: list.length } })
        },
        remove() {
          const keep = ctx.q ? rows.filter((d) => !match(d, ctx.q)) : []
          const removed = rows.length - keep.length
          store[name] = keep
          return Promise.resolve({ stats: { removed } })
        },
        doc(id) {
          return {
            set(opts) {
              const idx = rows.findIndex((x) => x._id === id)
              const doc = Object.assign({ _id: id }, opts.data)
              if (idx >= 0) rows[idx] = doc
              else rows.push(doc)
              return Promise.resolve({ stats: { created: idx < 0 ? 1 : 0, updated: idx >= 0 ? 1 : 0 } })
            },
            update(opts) {
              const d = rows.find((x) => x._id === id)
              if (!d) return Promise.resolve({ stats: { updated: 0 } })
              Object.assign(d, opts.data)
              return Promise.resolve({ stats: { updated: 1 } })
            }
          }
        }
      }
      return q
    },
    command: { neq: (v) => ({ [NEQ]: v }) }
  }
  return { api, store }
}

const db = makeDB()
const fake = {
  DYNAMIC_CURRENT_ENV: 'mock-env',
  init() {},
  database() { return db.api },
  getWXContext() { return { OPENID: fake.openid } }
}
const origLoad = Module._load
Module._load = function (request) {
  if (request === 'wx-server-sdk') return fake
  return origLoad.apply(this, arguments)
}

const fn = require(path.join(__dirname, '..', 'cloudfunctions', 'book', 'index.js'))

let pass = 0
const fails = []
function check(name, cond, extra) {
  if (cond) pass++
  else fails.push(name + (extra ? ' → ' + JSON.stringify(extra) : ''))
}
async function call(openid, event) {
  fake.openid = openid
  return await fn.main(event)
}

;(async () => {
  const init = await call('A', { action: 'initdb' })
  check('initdb 建好三张表', init.ok === true, init)
  check('books / book_members / book_txs 都在', ['books', 'book_members', 'book_txs'].every((k) => Array.isArray(db.store[k])), Object.keys(db.store))

  const c1 = await call('A', { action: 'create', name: '我们的家', nickname: '老王' })
  check('建账本成功（带昵称）', c1.ok === true && c1.name === '我们的家', c1)
  check('邀请码 6 位', /^[234-9A-Z]{6}$/.test(c1.code), { code: c1.code })
  check('账本号 8 位', /^[234-9A-Z]{8}$/.test(c1.bookId), { id: c1.bookId })
  check('建完就有 1 个成员且是我', c1.members === 1 && c1.memberList[0].isMe === true, c1.memberList)
  check('账主昵称记下来了', c1.memberList[0].nickname === '老王', c1.memberList[0])
  check('默认上限 10 人', c1.memberLimit === 10, { limit: c1.memberLimit })

  const c2 = await call('A', { action: 'create', name: '第二本' })
  check('同一个人不会建出第二本', c2.ok === true && c2.bookId === c1.bookId, c2)

  const my = await call('A', { action: 'my' })
  check('A 的账本概况', my.ok && my.joined && my.role === 'owner' && my.members === 1, my)
  check('my 里带上我的昵称', my.nickname === '老王', { nick: my.nickname })

  const j1 = await call('B', { action: 'join', code: c1.code, nickname: '小李' })
  check('B 用邀请码加入', j1.ok === true && j1.members === 2, j1)
  check('B 加入后成员清单有两个人', j1.memberList.length === 2, j1.memberList)
  check('B 在清单里标成「我」', j1.memberList.filter((m) => m.isMe).length === 1 && j1.memberList.some((m) => m.nickname === '小李' && m.isMe), j1.memberList)
  check('成员清单不暴露 openid', j1.memberList.every((m) => !('openid' in m)), j1.memberList[0])

  const j2 = await call('B', { action: 'join', code: c1.code })
  check('B 重复加入不报错', j2.ok === true && j2.already === true, j2)

  /* 一直加到 10 个人（A + B + C..J），第 11 个该被拒 */
  const names = ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']
  for (let i = 0; i < names.length; i++) {
    const r = await call(names[i], { action: 'join', code: c1.code, nickname: '成员' + names[i] })
    if (i === names.length - 1) check('第 10 个人还能加', r.ok === true && r.members === 10, r)
  }
  const j11 = await call('K', { action: 'join', code: c1.code })
  check('满 10 人后第 11 个被拒', j11.ok === false && j11.code === 'FULL', j11)

  const j5 = await call('L', { action: 'join', code: 'ZZZZZZ' })
  check('错邀请码 → BAD_CODE', j5.ok === false && j5.code === 'BAD_CODE', j5)
  const j6 = await call('M', { action: 'join', code: 'abc' })
  check('邀请码格式不对 → BAD_FORMAT', j6.ok === false && j6.code === 'BAD_FORMAT', j6)

  /* 已经在别的账本里，再去加第二本 → ALREADY_JOINED */
  const z = await call('Z', { action: 'create', name: '另一个家', nickname: '小Z' })
  const j7 = await call('A', { action: 'join', code: z.code })
  check('已在账本里的人不能再加别的账本', j7.ok === false && j7.code === 'ALREADY_JOINED', j7)

  const txs = [
    { id: 'h1001', time: 1, day: '2026-11-22', ym: '2026-11', type: 'expense', amount: 12.5, category: '餐饮', desc: '午饭' },
    { id: 'h1002', time: 2, day: '2026-11-22', ym: '2026-11', type: 'expense', amount: 30, category: '交通', desc: '打车' },
    { id: 'h1003', time: 3, day: '2026-11-21', ym: '2026-11', type: 'income', amount: 100, category: '工资', desc: '补贴' }
  ]
  const p1 = await call('A', { action: 'push', bookId: c1.bookId, txs })
  check('A 推 3 条', p1.ok === true && p1.pushed === 3, p1)
  check('推送时把「谁记的」写进云端', db.store.book_txs.every((d) => d.byName === '老王'), db.store.book_txs.map((d) => d.byName))
  const p2 = await call('A', { action: 'push', bookId: c1.bookId, txs })
  check('重复推同 3 条不会多出文档', (p2.ok === true) && db.store.book_txs.length === 3, { n: db.store.book_txs.length })
  const p3 = await call('N', { action: 'push', bookId: c1.bookId, txs })
  check('非成员推不进去', p3.ok === false && p3.code === 'NOT_MEMBER', p3)

  const pl = await call('B', { action: 'pull', bookId: c1.bookId })
  check('B 拉到 3 条', pl.ok === true && pl.txs.length === 3, { n: pl.txs.length })
  check('拉回来的带分类', pl.txs.every((t) => t.category), pl.txs[0])
  check('按下单时间倒序（最新在前）', pl.txs[0].id === 'h1003', { first: pl.txs[0].id })
  check('成员数一起回', pl.members === 10, { members: pl.members })
  check('拉回来的带「谁记的」', pl.txs.every((t) => t.byName === '老王'), pl.txs.map((t) => t.byName))
  check('别人的记录 isMe=false', pl.txs.every((t) => t.isMe === false), pl.txs.map((t) => t.isMe))
  check('pull 不暴露 openid', pl.txs.every((t) => !('openid' in t)), Object.keys(pl.txs[0]))
  const pl2 = await call('N', { action: 'pull', bookId: c1.bookId })
  check('非成员拉不到', pl2.ok === false && pl2.code === 'NOT_MEMBER', pl2)

  /* B 也推一条：A 拉下来应该看到「小李」记的，自己那 3 条 isMe=true */
  const btx = [{ id: 'b2001', time: 4, day: '2026-11-22', ym: '2026-11', type: 'expense', amount: 8, category: '餐饮', desc: '奶茶' }]
  const pb = await call('B', { action: 'push', bookId: c1.bookId, txs: btx })
  check('B 推 1 条', pb.ok === true && pb.pushed === 1, pb)
  const pla = await call('A', { action: 'pull', bookId: c1.bookId })
  const mine = pla.txs.filter((t) => t.isMe)
  const others = pla.txs.filter((t) => !t.isMe)
  check('A 拉到 4 条', pla.txs.length === 4, { n: pla.txs.length })
  check('A 自己记的 3 条 isMe=true', mine.length === 3, { n: mine.length })
  check('B 记的那条名字是「小李」', others.length === 1 && others[0].byName === '小李', others[0])

  /* 改昵称：以后推的记录用新名字 */
  const nick = await call('A', { action: 'setNick', nickname: '王大爷' })
  check('改昵称成功', nick.ok === true && nick.nickname === '王大爷', nick)
  check('改完清单里立刻是新名字', nick.memberList.some((m) => m.isMe && m.nickname === '王大爷'), nick.memberList)
  const p4 = await call('A', { action: 'push', bookId: c1.bookId, txs: [{ id: 'h1004', time: 5, day: '2026-11-22', ym: '2026-11', type: 'expense', amount: 5, category: '餐饮', desc: '早饭' }] })
  check('改完名再推 1 条', p4.ok === true && p4.pushed === 1, p4)
  check('新记录用新名字', db.store.book_txs.filter((d) => d.id === 'h1004')[0].byName === '王大爷', db.store.book_txs.map((d) => d.id + ':' + d.byName))

  const nick2 = await call('N', { action: 'setNick', nickname: '路人' })
  check('没加入的人改不了昵称', nick2.ok === false && nick2.code === 'NOT_MEMBER', nick2)

  /* 普通成员退出：只删自己推的记录，账本和别人的都留着 */
  const cPush = await call('C', { action: 'push', bookId: c1.bookId, txs: [{ id: 'c3001', time: 6, day: '2026-11-22', ym: '2026-11', type: 'expense', amount: 3, category: '餐饮', desc: 'C 的' }] })
  check('C 推 1 条', cPush.ok === true, cPush)
  const before = db.store.book_txs.length
  const lv1 = await call('C', { action: 'leave' })
  check('C 退出成功', lv1.ok === true && lv1.dissolved !== true, lv1)
  check('C 退出后账本还在', db.store.books.length === 2, { books: db.store.books.length })
  check('C 退出只删掉自己那条', db.store.book_txs.length === before - 1, { before, after: db.store.book_txs.length })
  check('C 退出的记录不再出现在账本里', db.store.book_txs.every((d) => d.openid !== 'C'), db.store.book_txs.map((d) => d.openid))
  const cMy = await call('C', { action: 'my' })
  check('C 视角已退出', cMy.ok === true && cMy.joined === false, cMy)
  const cPull = await call('C', { action: 'pull', bookId: c1.bookId })
  check('C 退出后拉不到', cPull.ok === false && cPull.code === 'NOT_MEMBER', cPull)

  /* 账主退出：整本拆掉，但不会误伤另一个账本 */
  const lv2 = await call('A', { action: 'leave' })
  check('账主退出 = 解散', lv2.ok === true && lv2.dissolved === true, lv2)
  check('这本的成员清空（另一个账本的人还在）', db.store.book_members.filter((m) => m.bookId === c1.bookId).length === 0, db.store.book_members)
  check('这本的云端流水清空', db.store.book_txs.filter((d) => d.bookId === c1.bookId).length === 0, db.store.book_txs.length)
  check('另一个账本没事', db.store.books.filter((b) => b.bookId === z.bookId).length === 1, db.store.books.map((b) => b.bookId))
  const my2 = await call('B', { action: 'my' })
  check('B 视角已无账本', my2.ok === true && my2.joined === false, my2)
  const zMy = await call('Z', { action: 'my' })
  check('Z 的账本还在', zMy.ok === true && zMy.joined === true && zMy.members === 1, zMy)

  console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项')
  if (fails.length) {
    fails.forEach((f) => console.log('  ✗ ' + f))
    process.exit(1)
  }
})()
