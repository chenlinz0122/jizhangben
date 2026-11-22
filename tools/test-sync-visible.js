// 「同步成功但流水里看不见对方记录」的回归测试
// 跑法：node tools/test-sync-visible.js
//
// 背景：云端早期推上去的记录可能没带 day / ym。store.all() 和 pullAndMerge 现在会按时间补齐，
//      否则流水页按月过滤（t.ym !== ym）会把整条挡掉：账本里有、报表某些区块算得到、
//      流水列表却一条都没有。
const path = require('path')

const storage = {}
const now = Date.now()

/* 1) 已经是本地存量：别人记的、缺 ym/day —— 模拟升级前就拉下来落库的那条 */
storage.txs_v1 = [
  { id: 'otherNoYmd', time: now, type: 'expense', amount: 9.9, category: '餐饮', merchant: '老王的面', desc: '别人记的，缺 ym/day', by: '老王', byMe: false }
]

storage.shared_book_v1 = {
  bookId: 'TESTBOOK', name: '我们的家', code: 'AB12CD', nickname: '我',
  members: 2, memberLimit: 10,
  memberList: [
    { nickname: '我', role: 'member', isMe: true },
    { nickname: '老王', role: 'owner', isMe: false }
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
  cloud: {
    callFunction: (opt) => {
      const data = (opt && opt.data) || {}
      let result = { ok: true }
      if (data.action === 'push') {
        result = { ok: true, pushed: 0 }
      } else if (data.action === 'pull') {
        /* 2) 云端那条也没带 ym/day —— 模拟对方旧版本推上去的 */
        result = {
          ok: true,
          txs: [
            { id: 'fromCloud', time: now - 60000, type: 'expense', amount: 5.5, category: '餐饮', merchant: '云朵咖啡', byName: '小李', isMe: false }
          ],
          members: 2,
          memberList: storage.shared_book_v1.memberList
        }
      } else {
        result = { ok: false, code: 'BAD_ACTION' }
      }
      if (opt && opt.success) setTimeout(() => opt.success({ result }), 0)
      else if (opt && opt.fail) setTimeout(() => opt.fail({ errMsg: 'mock' }), 0)
    }
  }
}

let captured = null
global.Page = (opts) => { captured = opts }
global.getApp = () => ({ globalData: {} })

require(path.join(__dirname, '..', 'pages', 'list', 'list.js'))
if (!captured) { console.log('没抓到 Page 配置'); process.exit(1) }

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
page.refresh()

let pass = 0
const fails = []
function check(name, cond, extra) {
  if (cond) pass++
  else fails.push(name + (extra ? ' → ' + JSON.stringify(extra) : ''))
}
function rows() {
  const out = []
  page.data.groups.forEach((g) => g.items.forEach((it) => out.push(it)))
  return out
}

/* 存量记录：读出来就该补齐 ym/day，并且出现在本月流水里 */
check('存量那条缺 ym 也能进流水', rows().some((r) => r.id === 'otherNoYmd'), rows().map((r) => r.id))
check('这条挂了别人的名字标签', rows().some((r) => r.id === 'otherNoYmd' && r.by === '老王'), rows().map((r) => r.by))

/* 同步：拉下来的云端记录要补齐 ym/day 再落库 */
const sharedMod = require(path.join(__dirname, '..', 'utils', 'shared.js'))
const storeMod = require(path.join(__dirname, '..', 'utils', 'store.js'))

;(async function () {
  await new Promise((res) => sharedMod.sync(() => res()))

  const all = storeMod.all()
  const cloud = all.filter((t) => t.id === 'fromCloud')[0]
  check('云端记录落库了', !!cloud, all.map((t) => t.id))
  check('云端记录补上了 ym', !!cloud && cloud.ym === String(cloud.day || '').slice(0, 7), cloud && cloud.ym)
  check('云端记录补上了 day', !!cloud && /^\d{4}-\d{2}-\d{2}$/.test(String(cloud.day || '')), cloud && cloud.day)
  check('云端记录标成别人的', !!cloud && cloud.by === '小李' && cloud.byMe === false, cloud && cloud.by)

  page.refresh()
  const list = rows().map((r) => r.id)
  check('看双方时能看见云端那条', list.indexOf('fromCloud') >= 0, list)
  check('看双方时两条都在', list.length === 2, list)

  /* 只看对方 / 只看自己 也要跟着对上 */
  page.setData({ scope: 'peer' })
  page.refresh()
  const peerIds = rows().map((r) => r.id).sort()
  check('只看对方时只剩两条别人的记录', peerIds.join(',') === 'fromCloud,otherNoYmd', peerIds)

  page.setData({ scope: 'mine' })
  page.refresh()
  check('只看自己时一条都没有', rows().length === 0, rows().map((r) => r.id))

  console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项')
  if (fails.length) {
    fails.forEach((f) => console.log('  ✗ ' + f))
    process.exit(1)
  }
})()
