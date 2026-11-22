// 「共同账本里对方记的账被并进我这条」的回归测试
// 跑法：node tools/test-sync-loose.js
//
// 背景：store.addMany 有一条「弱合并」规则：同类型 + 同一天 + 同金额 + 商户相似 +
//  id 前缀不同 + 时间差 2 分钟内 → 当成同一笔并进已有那条。
//  在共同账本里这条会吃数据：两个人在同一分钟各记一笔同商户同金额（一起点外卖、
//  一人一杯奶茶），对方那条会被并进你的记录里，于是「同步成功了但流水里看不到对方的」。
//  现在按「谁记的」先隔离：归属不同（一个有 by 一个没有，或名字不同）一律不合并。
const path = require('path')

const storage = {}
const now = new Date(2026, 10, 22, 12, 30, 0).getTime()

function tx(o) { return Object.assign({ type: 'expense', category: '餐饮', ym: '2026-11', day: '2026-11-22' }, o) }

storage.txs_v1 = [
  tx({ id: 'bill1', time: now, amount: 20, merchant: '楼下便利店', desc: '我记的' })
]

const noop = () => {}
global.wx = {
  getStorageSync: (k) => (k in storage ? storage[k] : ''),
  setStorageSync: (k, v) => { storage[k] = v },
  removeStorageSync: (k) => { delete storage[k] },
  showToast: noop, showModal: noop, showActionSheet: noop,
  navigateTo: noop, switchTab: noop,
  cloud: { callFunction: noop }
}

const store = require(path.join(__dirname, '..', 'utils', 'store.js'))
let pass = 0
const fails = []
function check(name, cond, extra) {
  if (cond) pass++
  else fails.push(name + (extra ? ' → ' + JSON.stringify(extra) : ''))
}

/* 1) 对方记的同日同额同商户（id 前缀不同、时间差 1 分钟）：必须保留成独立一条 */
const peer = tx({ id: 'tx9', time: now + 60000, amount: 20, merchant: '楼下便利店', by: '小李', byMe: false })
const r1 = store.addMany([peer])
const all1 = store.all()
check('对方那条没有被并进我的记录', r1.added === 1, r1)
check('两条都在本地', all1.length === 2, all1.map((t) => t.id))
check('对方那条还挂着名字', all1.some((t) => t.id === 'tx9' && t.by === '小李' && t.byMe === false), all1.map((t) => t.by))

/* 2) 同一个人的同一笔（都没有 by）：弱合并照旧生效，不能因为这次改动去重失效 */
const mineAgain = tx({ id: 'h77', time: now + 60000, amount: 20, merchant: '楼下便利店', desc: '同一个人的同一笔' })
const r2 = store.addMany([mineAgain])
const all2 = store.all()
check('同一个人的同额记录仍然弱合并', r2.added === 0 && (r2.merged + r2.dup) === 1, r2)
check('合并后还是 2 条，没有多出来', all2.length === 2, all2.map((t) => t.id))

/* 3) 两个不同成员各记一笔同额：也不能互相合并 */
const peerA = tx({ id: 'a11', time: now + 120000, amount: 8.5, merchant: '奶茶店', by: '老王', byMe: false })
const peerB = tx({ id: 'b22', time: now + 180000, amount: 8.5, merchant: '奶茶店', by: '小李', byMe: false })
const r3 = store.addMany([peerA, peerB])
const all3 = store.all()
check('两个成员的同额记录各自保留', r3.added === 2, r3)
check('本地共 4 条', all3.length === 4, all3.map((t) => t.id))

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项')
if (fails.length) {
  fails.forEach((f) => console.log('  ✗ ' + f))
  process.exit(1)
}
