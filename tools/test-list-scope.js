// 流水页「全部 / 只看我」的离线自测
// 跑法：node tools/test-list-scope.js
// 做法：用一个极简 wx mock 把 pages/list/list.js 的 refresh() 真跑起来，
//      检查「别人记的账挂名字」「只看我把它过滤掉」这两件事。
const path = require('path')

const storage = {}
const now = Date.now()

storage.txs_v1 = [
  { id: 'mine1', time: now, day: '2026-11-22', ym: '2026-11', type: 'expense', amount: 25, category: '交通', merchant: '打车', desc: '我自己记的' },
  { id: 'mine2', time: now - 1000, day: '2026-11-22', ym: '2026-11', type: 'expense', amount: 12, category: '餐饮', merchant: '食堂', desc: '我也记的' },
  { id: 'other1', time: now - 2000, day: '2026-11-22', ym: '2026-11', type: 'expense', amount: 8.8, category: '餐饮', merchant: '奶茶店', desc: '别人记的', by: '小李', byMe: false }
]
storage.shared_book_v1 = {
  bookId: 'TESTBOOK', name: '我们的家', code: 'AB12CD', nickname: '我',
  members: 3, memberLimit: 10,
  memberList: [
    { nickname: '老王', role: 'owner', isMe: false },
    { nickname: '我', role: 'member', isMe: true },
    { nickname: '小李', role: 'member', isMe: false }
  ],
  joinedAt: now, lastSync: 0
}

const noop = () => {}
global.wx = {
  getStorageSync: (k) => (k in storage ? storage[k] : ''),
  setStorageSync: (k, v) => { storage[k] = v },
  removeStorageSync: (k) => { delete storage[k] },
  showToast: noop, showModal: noop, showActionSheet: noop,
  navigateTo: noop, switchTab: noop,
  cloud: { callFunction: noop }
}

let captured = null
global.Page = (opts) => { captured = opts }
global.getApp = () => ({ globalData: {} })

require(path.join(__dirname, '..', 'pages', 'list', 'list.js'))
if (!captured) { console.log('没抓到 Page 配置'); process.exit(1) }

/* 造一个能用的页面实例：data + setData */
const page = Object.assign({}, captured)
page.data = JSON.parse(JSON.stringify(captured.data || {}))
page.setData = function (patch, cb) {
  for (const k in patch) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) this.data[k] = patch[k]
  }
  if (typeof cb === 'function') cb()
}
page.onLoad()
page.onShow()

let pass = 0
const fails = []
function check(name, cond, extra) {
  if (cond) pass++
  else fails.push(name + (extra ? ' → ' + JSON.stringify(extra) : ''))
}
function total() {
  let n = 0
  page.data.groups.forEach((g) => { n += g.items.length })
  return n
}
function byItems() {
  const out = []
  page.data.groups.forEach((g) => g.items.forEach((it) => { if (it.by) out.push(it) }))
  return out
}

check('进了共同账本，data.sharedOn 是 true', page.data.sharedOn === true, page.data.sharedOn)
check('成员数读到 3', page.data.sharedMembers === 3, page.data.sharedMembers)
check('默认「全部」视角', page.data.scope === 'all', page.data.scope)
check('全部视角下 3 条都在', total() === 3, total())
check('只有别人记的那条挂了名字', byItems().length === 1 && byItems()[0].merchant === '奶茶店', byItems().map((x) => x.merchant))
check('自己记的不挂名字', byItems().every((x) => x.by === '小李'), byItems())
check('别人的标签写的是「小李」', byItems()[0] && byItems()[0].by === '小李', byItems()[0])

page.setData({ scope: 'mine' })
page.refresh()
check('切到「只看我」后只剩自己 2 条', total() === 2, total())
check('「只看我」里没有任何别人记录', byItems().length === 0, byItems())
check('自己两条都在', page.data.groups[0] && page.data.groups[0].items.some((x) => x.id === 'mine1'), page.data.groups[0] && page.data.groups[0].items.map((x) => x.id))

/* 没加入账本时不该受 scope 影响：模拟未加入 */
delete storage.shared_book_v1
page.setData({ sharedOn: false, scope: 'mine' })
page.refresh()
check('没加入时 scope 不生效，3 条照常显示', total() === 3, total())
check('没加入时也不显示别人的名字标签', byItems().length === 0, byItems().length)

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项')
if (fails.length) {
  fails.forEach((f) => console.log('  ✗ ' + f))
  process.exit(1)
}
