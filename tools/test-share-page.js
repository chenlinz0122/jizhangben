// Focused UI contract tests; no cloud calls or native simulator required.
// Run: node tools/test-share-page.js
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.resolve(__dirname, '..')
let passed = 0

function test(name, run) {
  try { run(); passed++; console.log('PASS ' + name) } catch (err) {
    console.error('FAIL ' + name + '\n' + err.stack)
    process.exitCode = 1
  }
}

function fixture(name, book) {
  const h = {
    book: book || null, txs: [], pending: '', globalBusy: false, scopeSaved: true,
    infos: [], syncs: [], joins: [], creates: [], leaves: [], modals: [], actions: [],
    toasts: [], nav: [], tabs: [], writes: [], scopes: [], refreshes: 0, remarks: {}
  }
  h.shared = {
    current: () => h.book,
    isJoined: () => !!h.book,
    myName: () => (h.book || {}).nickname || '',
    busy: () => h.globalBusy,
    isMine: (t) => !t || t.byMe !== false,
    info: (cb) => h.infos.push(cb),
    sync: (cb, resolution) => { h.resolution = resolution; h.syncs.push(cb) },
    createBook: (name, nick, cb) => h.creates.push(cb),
    joinBook: (code, nick, cb) => h.joins.push(cb),
    leave: (cb) => h.leaves.push(cb),
    pendingShare: () => h.pending,
    clearPendingShare: () => { h.pending = '' },
    scopeText: () => h.book && h.book.shareSince != null ? '已选共享范围' : '尚未确认共享范围',
    setShareScope: (scope) => {
      h.scopes.push(scope)
      if (!h.scopeSaved) return false
      h.book.shareSince = scope === 'all' ? 0 : new Date(2026, 10, 23).getTime()
      return true
    },
    syncSummary: (r) => ['pushed', 'added', 'updated', 'removed'].map((k) => k + ':' + (r[k] || 0)).join(' '),
    remarkOf: (nick) => h.remarks[nick] || '',
    labelOf: (nick) => h.remarks[nick] || nick,
    setRemark: (nick, text) => {
      if (h.remarkFails) return null
      h.remarks[nick] = text
      return text
    }
  }
  const store = {
    all: () => h.txs,
    canEdit: (t) => !!t && t.byMe !== false,
    rules: () => ({}),
    update: (id, patch) => { h.writes.push(['update', id, patch]); return {} },
    remove: (id) => { h.writes.push(['remove', id]); return true },
    removeMonth: (ym) => { h.writes.push(['removeMonth', ym]); return 1 },
    clearAll: () => { h.writes.push(['clearAll']); return true },
    learn: () => true,
    relabel: (ids) => { h.writes.push(['relabel', Array.from(ids)]); return ids.length }
  }
  const modules = {
    shared: h.shared, store,
    theme: { get: () => ({ key: 'green' }), list: () => [], syncTabBar() {} },
    darkmode: { isDark: () => false, watch() {} },
    format: { ymOf: () => '2026-11', monthLabel: (ym) => ym, money: (n) => String(n), pad: (n) => String(n) },
    category: { catsOf: () => ['餐饮'], colorOf: () => '', iconOf: () => '', tintOf: () => '', classify: () => ({ cat: '' }) },
    prefs: { refundExcluded: () => false, viewScope: () => 'both' },
    vip: { isVip: () => false, autoAcceptInvite() {} }
  }
  let page
  const filename = path.join(root, 'pages', name, name + '.js')
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page: (p) => { page = p },
    require: (id) => modules[id.split('/').pop()] || {},
    wx: {
      getStorageSync: () => '', setStorageSync() {},
      showModal: (o) => h.modals.push(o),
      showActionSheet: (o) => h.actions.push(o),
      showToast: (o) => h.toasts.push(o),
      navigateTo: (o) => h.nav.push(o.url), switchTab: (o) => h.tabs.push(o.url)
    },
    getApp: () => ({ globalData: {} }),
    setTimeout: (cb) => cb(), console
  }, { filename })
  page.data = JSON.parse(JSON.stringify(page.data))
  page.setData = function (patch, cb) {
    for (const key of Object.keys(patch)) {
      const keys = key.split('.')
      let target = this.data
      while (keys.length > 1) target = target[keys.shift()]
      target[keys[0]] = patch[key]
    }
    if (cb) cb()
  }
  if (name === 'home') {
    for (const method of ['syncProfile', 'syncVip', 'syncTheme', 'syncDark']) page[method] = () => {}
    page.syncData = () => { h.refreshes++ }
  }
  if (name === 'list') page.refresh = () => { h.refreshes++ }
  h.page = page
  h.replyInfo = (res) => {
    if (res.ok) h.book = res.joined ? Object.assign({}, h.book, res) : null
    const cb = h.infos.shift()
    cb(res) // Bare call catches the original this/self callback bug.
  }
  return h
}

function member(extra) {
  return Object.assign({ bookId: 'b1', name: '家', code: 'ABC123', joinedAt: Date.now(), shareSince: null, lastSync: 0 }, extra)
}
function event(data) { return { currentTarget: { dataset: data } } }
function tx(id, extra) {
  return Object.assign({ id, ym: '2026-11', time: Date.now(), type: 'expense', merchant: '咖啡店', category: '未分类', amount: 10 }, extra)
}

test('share lifecycle calls info only onShow and guards reentry', () => {
  const h = fixture('share')
  h.page.onLoad({ code: 'abc123' })
  assert.equal(h.infos.length, 0)
  h.page.onShow(); h.page.onShow()
  assert.equal(h.infos.length, 1)
  h.replyInfo({ ok: true, joined: false })
  assert.equal(h.page.data.joined, false)
  assert.equal(h.page.data.membershipKnown, true)
  assert.equal(h.page.data.loading, false)
})

test('share restores cloud membership with no local cache and infers owner', () => {
  const h = fixture('share')
  h.page.onShow()
  h.replyInfo(Object.assign(member({ memberList: [{ isMe: true, nickname: '我', role: 'owner' }] }), { ok: true, joined: true }))
  assert.equal(h.page.data.joined, true)
  assert.equal(h.page.data.isOwner, true)
  assert.equal(h.page.data.shareScope, '')
})

test('share offline preserves joined cache and owner role', () => {
  const h = fixture('share', member({ role: 'owner' }))
  h.page.onShow()
  h.replyInfo({ ok: false, code: 'OFFLINE', msg: '断网' })
  assert.equal(h.page.data.joined, true)
  assert.equal(h.page.data.isOwner, true)
  assert.match(h.page.data.msg, /OFFLINE.*本机缓存/)
})

test('unknown membership on network failure does not enable unjoined form', () => {
  const h = fixture('share')
  h.page.onShow()
  h.replyInfo({ ok: false, msg: '断网' })
  assert.equal(h.page.data.membershipKnown, false)
  h.page.createBook(); h.page.joinBook()
  assert.equal(h.creates.length + h.joins.length, 0)
})

test('explicitly unjoined callback uses page binding and resets old owner', () => {
  const h = fixture('share', member({ owner: true }))
  h.page.onShow(); h.replyInfo({ ok: true, joined: false })
  assert.equal(h.page.data.joined, false)
  assert.equal(h.page.data.isOwner, false)
})

test('scope consent is required and cancel does not save or sync', () => {
  const h = fixture('share', member())
  h.page.doSync(); h.page.doSync()
  assert.equal(h.actions.length, 1)
  assert.equal(h.syncs.length, 0)
  h.actions[0].success({ tapIndex: 0 })
  const modal = h.modals[0]
  assert.match(modal.content, /本地零点/)
  for (const text of ['金额', '商户', '备注', '自动同步', '只改变显示', '不会删除']) assert.ok(modal.content.includes(text))
  modal.success({ confirm: false })
  assert.equal(h.scopes.length + h.syncs.length, 0)
  assert.equal(h.page.data.busy, false)
})

test('confirmed all range saves then syncs and includes updates/deletes in summary', () => {
  const h = fixture('share', member())
  h.page.doSync(); h.actions[0].success({ tapIndex: 1 })
  h.modals[0].success({ confirm: true })
  assert.deepEqual(h.scopes, ['all'])
  assert.equal(h.page.data.shareScope, 'all')
  assert.equal(h.syncs.length, 1)
  h.syncs[0]({ ok: true, pushed: 1, added: 0, updated: 2, removed: 3, members: 2 })
  assert.match(h.page.data.msg, /updated:2 removed:3/)
  assert.equal(h.page.data.busy, false)
})

test('scope storage failure never starts sync', () => {
  const h = fixture('share', member())
  h.scopeSaved = false
  h.page.confirmScope('recent', true)
  h.modals[0].success({ confirm: true })
  assert.equal(h.syncs.length, 0)
  assert.match(h.page.data.msg, /未保存/)
})

test('server SCOPE_REQUIRED prompts and UPGRADE_REQUIRED explains deployment', () => {
  const h = fixture('share', member({ shareSince: 0 }))
  h.page.doSync(); h.syncs[0]({ ok: false, code: 'SCOPE_REQUIRED' })
  assert.equal(h.actions.length, 1)
  h.actions[0].fail()
  h.page.doSync(); h.syncs[1]({ ok: false, code: 'UPGRADE_REQUIRED', msg: '版本过旧' })
  assert.match(h.page.data.msg, /部署新版云函数 book.*UPGRADE_REQUIRED/)
})

test('conflict choices require confirmation and pass explicit resolution', () => {
  const h = fixture('share', member({ shareSince: 0 }))
  h.page.doSync(); h.syncs[0]({ ok: false, code: 'CONFLICT', msg: '有冲突' })
  assert.equal(h.page.data.hasConflict, true)
  h.page.resolveConflict(); h.actions[0].success({ tapIndex: 1 })
  assert.equal(h.syncs.length, 1)
  h.modals[0].success({ confirm: false })
  assert.equal(h.syncs.length, 1)
  h.page.resolveConflict(); h.actions[1].success({ tapIndex: 0 })
  h.modals[1].success({ confirm: true })
  assert.equal(h.resolution, 'local')
  assert.equal(h.syncs.length, 2)
})

test('quit guards duplicate modal and preserves joined UI on failure', () => {
  const h = fixture('share', member({ owner: true }))
  h.page.apply(h.book)
  h.page.quit(); h.page.quit()
  assert.equal(h.modals.length, 1)
  assert.match(h.modals[0].content, /无法远程擦除/)
  h.modals[0].success({ confirm: true }); h.page.quit()
  assert.equal(h.leaves.length, 1)
  h.leaves[0]({ ok: false, msg: '断网' })
  assert.equal(h.page.data.joined, true)
  assert.equal(h.page.data.busy, false)
  assert.match(h.page.data.msg, /断网/)
  h.page.quit(); h.modals[1].success({ confirm: false })
  assert.equal(h.page.data.busy, false)
})

test('failed share join keeps invite and reports error', () => {
  const h = fixture('share')
  h.pending = 'ABC123'
  h.page.onLoad({}); h.page.setData({ membershipKnown: true })
  h.page.joinBook(); h.joins[0]({ ok: false, msg: '失败' })
  assert.equal(h.pending, 'ABC123')
  assert.equal(h.page.data.codeInput, 'ABC123')
  assert.match(h.page.data.msg, /失败/)
})

test('share personal remark storage error is not reported as success', () => {
  const h = fixture('share', member())
  h.remarkFails = true
  h.page.editRemark(event({ nick: '成员', me: false }))
  h.modals[0].success({ confirm: true, content: '室友' })
  assert.match(h.page.data.msg, /未保存/)
  assert.equal(h.toasts.length, 0)
})

test('home management always navigates even during sync', () => {
  const h = fixture('home', member({ shareSince: 0 }))
  h.page._syncing = true
  h.page.goShare()
  assert.deepEqual(h.nav, ['/pages/share/share'])
  assert.equal(h.syncs.length, 0)
})

test('home restores cache but never auto syncs unconfirmed scope', () => {
  const h = fixture('home')
  h.page.onShow(); h.page.onShow()
  assert.equal(h.infos.length, 1)
  h.replyInfo(Object.assign(member(), { ok: true, joined: true }))
  assert.equal(h.page.data.sharedJoined, true)
  assert.equal(h.syncs.length, 0)
  h.page.doSync()
  assert.equal(h.syncs.length, 0)
  assert.deepEqual(h.nav, ['/pages/share/share'])
})

test('home automatic/manual sync share lock and refresh update/removal-only result', () => {
  const h = fixture('home', member({ shareSince: 0 }))
  h.page.onShow()
  h.replyInfo({ ok: true, joined: true })
  assert.equal(h.syncs.length, 1)
  h.page.doSync(); h.page.onShow()
  assert.equal(h.syncs.length, 1)
  const before = h.refreshes
  h.syncs[0]({ ok: true, added: 0, updated: 2, removed: 1 })
  assert.equal(h.refreshes, before + 1)
  assert.match(h.page.data.sharedStatus, /updated:2 removed:1/)
  h.page.onShow(); h.replyInfo({ ok: true, joined: true })
  assert.equal(h.syncs.length, 1)
})

test('home displays sync failures and throttles repeated auto retries', () => {
  const h = fixture('home', member({ shareSince: 0 }))
  h.page.onShow(); h.replyInfo({ ok: true, joined: true })
  h.syncs[0]({ ok: false, code: 'UPGRADE_REQUIRED', msg: '旧版' })
  assert.match(h.page.data.sharedStatus, /部署新版云函数 book/)
  h.page.onShow(); h.replyInfo({ ok: true, joined: true })
  assert.equal(h.syncs.length, 1)
})

test('home offline cache survives and global busy blocks sync', () => {
  const h = fixture('home', member({ shareSince: 0 }))
  h.page.onShow(); h.replyInfo({ ok: false, msg: '断网' })
  assert.equal(h.page.data.sharedJoined, true)
  assert.match(h.page.data.sharedStatus, /断网/)
  h.globalBusy = true; h.page.doSync()
  assert.equal(h.syncs.length, 0)
})

test('home does not start automatic sync after navigating away', () => {
  const h = fixture('home', member({ shareSince: 0 }))
  h.page.onShow(); h.page.onHide(); h.replyInfo({ ok: true, joined: true })
  assert.equal(h.syncs.length, 0)
})

test('home failed invite join retains pending code and allows retry', () => {
  const h = fixture('home')
  h.pending = 'ABC123'
  h.page.onShow(); h.replyInfo({ ok: true, joined: false })
  h.modals[0].success({ confirm: true })
  h.joins[0]({ ok: false, msg: '断网' })
  assert.equal(h.pending, 'ABC123')
  assert.match(h.page.data.sharedStatus, /邀请码已保留/)
  h.page.onShow(); h.replyInfo({ ok: true, joined: false })
  h.modals[1].success({ confirm: true })
  h.book = member()
  h.joins[1]({ ok: true })
  assert.equal(h.pending, '')
  assert.equal(h.syncs.length, 0)
  assert.deepEqual(h.nav, ['/pages/share/share'])
})

test('peer rows, including nameless peers, block every edit and longpress', () => {
  const h = fixture('list')
  h.txs = [tx('peer', { byMe: false })]
  h.page.openSheet(event({ id: 'peer' }))
  assert.equal(h.page.data.sheetItem.canEdit, false)
  h.page.onLongPress(event({ id: 'peer' }))
  h.page.toggleCatMode(); h.page.editNote(); h.page.pickCat(event({ cat: '餐饮' })); h.page.deleteSheetItem()
  assert.equal(h.modals.length + h.writes.length, 0)
  assert.equal(h.page.data.catMode, false)
})

test('own row is editable and callbacks recheck current ownership', () => {
  const h = fixture('list')
  h.txs = [tx('mine')]
  h.page.openSheet(event({ id: 'mine' }))
  assert.equal(h.page.data.sheetItem.canEdit, true)
  h.page.editNote()
  h.txs[0].byMe = false
  h.modals[0].success({ confirm: true, content: 'changed' })
  assert.equal(h.writes.length, 0)
})

test('peer personal remark remains available with storage failure feedback', () => {
  const h = fixture('list')
  h.txs = [tx('peer', { byMe: false, by: '小李' })]
  h.page.openSheet(event({ id: 'peer' }))
  h.page.editByRemark(); h.modals[0].success({ confirm: true, content: '室友' })
  assert.equal(h.page.data.sheetItem.byLabel, '室友')
  h.remarkFails = true
  h.page.editByRemark(); h.modals[1].success({ confirm: true, content: '新备注' })
  assert.equal(h.page.data.sheetItem.byLabel, '室友')
  assert.match(h.toasts.at(-1).title, /未保存/)
})

test('bulk classification includes only own matching records', () => {
  const h = fixture('list')
  h.txs = [tx('first'), tx('mine'), tx('peer', { byMe: false })]
  h.page.offerBatch(h.txs[0], '餐饮')
  assert.match(h.modals[0].content, /还有 1 笔/)
  h.modals[0].success({ confirm: true })
  assert.deepEqual(h.writes[0], ['relabel', ['mine']])
})

test('month deletion counts only own rows and explains next-sync deletes', () => {
  const h = fixture('list')
  h.page.data.ym = '2026-11'
  h.txs = [tx('mine'), tx('peer', { byMe: false })]
  h.page.clearMonth()
  assert.match(h.modals[0].content, /自己记的共 1 笔/)
  assert.match(h.modals[0].content, /下次同步/)
  h.txs = [tx('peer', { byMe: false })]
  h.page.clearMonth()
  assert.equal(h.modals.length, 1)
})

test('clear-all explains own cloud deletion, local peer copies and backup', () => {
  const h = fixture('list')
  h.page.clearEverything()
  for (const text of ['下次同步', '只清除本机副本', '导出备份']) assert.ok(h.modals[0].content.includes(text))
})

test('list home back target uses switchTab and management navigates', () => {
  const h = fixture('list')
  h.page.data.backTab = '/pages/home/home'
  h.page.goBack(); h.page.goShare()
  assert.deepEqual(h.tabs, ['/pages/home/home'])
  assert.deepEqual(h.nav, ['/pages/share/share'])
})

test('templates separate catchtap sync and hide peer edit actions', () => {
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
  const home = read('pages/home/home.wxml')
  assert.match(home, /class="shared-copy" bindtap="goShare"/)
  assert.match(home, /catchtap="doSync"/)
  const list = read('pages/list/list.wxml')
  assert.match(list, /class="shacts" wx:if="{{sheetItem.canEdit}}"/)
  assert.match(list, /wx:if="{{catMode && sheetItem.canEdit}}"/)
  const share = read('pages/share/share.wxml')
  assert.match(share, /wx:elif="{{membershipKnown && !loading}}"/)
})

console.log('Passed ' + passed + ' focused UI tests' + (process.exitCode ? ' (failures above)' : ''))
