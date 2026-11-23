const assert = require('assert')
const path = require('path')
const copy = (v) => JSON.parse(JSON.stringify(v))
const now = Date.now()
const format = require('../utils/format')
const ym = format.ymOf(now)
const day = format.dayOf(now)
const tx = (id, amount, extra = {}) => Object.assign({ id, amount, time: now, day, ym, type: 'expense', category: '餐饮', merchant: '测试商户' }, extra)
const disk = {
  txs_v1: [tx('mine', 10), tx('peer', 20, { byMe: false, by: '', shareBook: 'book' }), tx('old-peer', 90, { byMe: false, by: '旧成员', shareBook: 'old-book' })],
  shared_book_v1: { bookId: 'book', shareSince: 0 }, prefs_v1: { viewScope: 'both' }
}
global.wx = {
  getStorageSync: (k) => k in disk ? copy(disk[k]) : '',
  setStorageSync: (k, v) => { disk[k] = copy(v) },
  setNavigationBarTitle() {}, setTabBarStyle() {}, showToast() {}, removeStorageSync: (k) => { delete disk[k] }
}
global.getApp = () => ({ globalData: {} })
const shared = require('../utils/shared')
let captured
const page = (name) => {
  global.Page = (definition) => { captured = definition }
  require(path.join(__dirname, '../pages', name, name + '.js'))
  const instance = Object.assign({}, captured, { data: copy(captured.data) })
  instance.setData = function (patch) { Object.assign(this.data, patch) }
  return instance
}
let pass = 0
const check = (value, message) => { assert.ok(value, message); pass++ }
check(!shared.isMine(disk.txs_v1[1]), '无昵称的成员流水仍归成员，不归自己')
check(shared.viewRows(disk.txs_v1, 'both').length === 2, '当前共同账本不混入旧账本成员数据')
check(shared.viewRows(disk.txs_v1, 'mine')[0].id === 'mine', '只看自己不含成员')
check(shared.viewRows(disk.txs_v1, 'peer')[0].id === 'peer', '只看成员限定当前账本')
const overview = page('home')
overview.onLoad()
overview.syncData()
check(overview.data.s.expenseText === '30.00', '合并后的首页与当前共同账本一致')
disk.prefs_v1.viewScope = 'mine'
overview.syncData()
check(overview.data.s.expenseText === '10.00', '首页尊重只看自己')
const detail = page('cat')
detail.onLoad({ year: ym.slice(0, 4), cat: '餐饮', kind: 'expense' })
detail.build()
check(detail.data.totalText === '10.00', '年度分类明细尊重只看自己')
disk.prefs_v1.viewScope = 'peer'
detail.build()
check(detail.data.totalText === '20.00', '年度分类明细只看当前成员，不混旧账本')
shared.setRemark('同昵称', '室友A', 'key-a')
shared.setRemark('同昵称', '室友B', 'key-b')
check(shared.labelOf('同昵称', 'key-a') === '室友A' && shared.labelOf('同昵称', 'key-b') === '室友B', '相同昵称成员的个人备注按身份隔离')
check(shared.labelOf('改了昵称', 'key-a') === '室友A', '成员改昵称后仍保留个人备注')
delete disk.shared_book_v1
check(shared.viewRows(disk.txs_v1, 'mine').length === 3, '退出后保留本机所有账目供查看')
console.log('通过 ' + pass + ' 项，失败 0 项')
