// 云函数 book 的离线自测：内存假库跑「建账本 → 邀请 → 推送 → 拉取 → 解散」全流程
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

  const c1 = await call('A', { action: 'create', name: '我们的家' })
  check('建账本成功', c1.ok === true && c1.name === '我们的家', c1)
  check('邀请码 6 位', /^[234-9A-Z]{6}$/.test(c1.code), { code: c1.code })
  check('账本号 8 位', /^[234-9A-Z]{8}$/.test(c1.bookId), { id: c1.bookId })
  const c2 = await call('A', { action: 'create', name: '第二本' })
  check('同一个人不会建出第二本', c2.ok === true && c2.bookId === c1.bookId, c2)

  const my = await call('A', { action: 'my' })
  check('A 的账本概况', my.ok && my.joined && my.role === 'owner' && my.members === 1, my)

  const j1 = await call('B', { action: 'join', code: c1.code })
  check('B 用邀请码加入', j1.ok === true && j1.members === 2, j1)
  const j2 = await call('B', { action: 'join', code: c1.code })
  check('B 重复加入不报错', j2.ok === true && j2.already === true, j2)
  const j3 = await call('C', { action: 'join', code: c1.code })
  check('第 3 个人还能加', j3.ok === true && j3.members === 3, j3)
  const j4 = await call('D', { action: 'join', code: c1.code })
  check('满 3 人后第 4 个被拒', j4.ok === false && j4.code === 'FULL', j4)
  const j5 = await call('B', { action: 'join', code: 'ZZZZZZ' })
  check('错邀请码 → BAD_CODE', j5.ok === false && j5.code === 'BAD_CODE', j5)
  const j6 = await call('B', { action: 'join', code: 'abc' })
  check('邀请码格式不对 → BAD_FORMAT', j6.ok === false && j6.code === 'BAD_FORMAT', j6)

  const txs = [
    { id: 'h1001', time: 1, day: '2026-11-22', ym: '2026-11', type: 'expense', amount: 12.5, category: '餐饮', desc: '午饭' },
    { id: 'h1002', time: 2, day: '2026-11-22', ym: '2026-11', type: 'expense', amount: 30, category: '交通', desc: '打车' },
    { id: 'h1003', time: 3, day: '2026-11-21', ym: '2026-11', type: 'income', amount: 100, category: '工资', desc: '补贴' }
  ]
  const p1 = await call('A', { action: 'push', bookId: c1.bookId, txs })
  check('A 推 3 条', p1.ok === true && p1.pushed === 3, p1)
  const p2 = await call('A', { action: 'push', bookId: c1.bookId, txs })
  check('重复推同 3 条不会多出文档', (p2.ok === true) && db.store.book_txs.length === 3, { n: db.store.book_txs.length })
  const p3 = await call('E', { action: 'push', bookId: c1.bookId, txs })
  check('非成员推不进去', p3.ok === false && p3.code === 'NOT_MEMBER', p3)

  const pl = await call('B', { action: 'pull', bookId: c1.bookId })
  check('B 拉到 3 条', pl.ok === true && pl.txs.length === 3, { n: pl.txs.length })
  check('拉回来的带 bookId 和分类', pl.txs.every((t) => t.bookId === c1.bookId && t.category), pl.txs[0])
  check('按下单时间倒序（最新在前）', pl.txs[0].id === 'h1003', { first: pl.txs[0].id })
  check('成员数一起回', pl.members === 3, { members: pl.members })
  const pl2 = await call('E', { action: 'pull', bookId: c1.bookId })
  check('非成员拉不到', pl2.ok === false && pl2.code === 'NOT_MEMBER', pl2)

  /* 普通成员退出：账本和记录都还在 */
  const lv1 = await call('C', { action: 'leave' })
  check('C 退出成功', lv1.ok === true && lv1.dissolved !== true, lv1)
  check('C 退出后账本还在', db.store.books.length === 1 && db.store.book_txs.length === 3, { books: db.store.books.length })

  /* 房主退出：整本拆掉 */
  const lv2 = await call('A', { action: 'leave' })
  check('房主退出 = 解散', lv2.ok === true && lv2.dissolved === true, lv2)
  check('账本清空', db.store.books.length === 0, { books: db.store.books.length })
  check('成员清空', db.store.book_members.length === 0, { m: db.store.book_members.length })
  check('云端流水清空', db.store.book_txs.length === 0, { txs: db.store.book_txs.length })
  const my2 = await call('B', { action: 'my' })
  check('B 视角已无账本', my2.ok === true && my2.joined === false, my2)

  console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项')
  if (fails.length) {
    fails.forEach((f) => console.log('  ✗ ' + f))
    process.exit(1)
  }
})()
