// 只验证同步写入失败的补偿回滚，不模拟进程中断。
const path = require('path')
const { isDeepStrictEqual } = require('util')

const STORE_PATH = path.join(__dirname, '..', 'utils', 'store.js')
const TX = 'txs_v1'
const RULE = 'rules_v1'
const BUDGET = 'budget_v1'
const CAT = 'budcats_v1'
const DATA_KEYS = [TX, RULE, BUDGET, CAT, 'gone_v1']
const NativeDate = Date
const originalWx = global.wx
const NOW = new NativeDate(2026, 10, 22, 12, 30, 0).getTime()

class FixedDate extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [NOW])) }
  static now() { return NOW }
}

function copy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}
function tx(id, day, extra) {
  const p = day.split('-').map(Number)
  return Object.assign({
    id, day, ym: day.slice(0, 7),
    time: new NativeDate(p[0], p[1] - 1, p[2], 12, 30).getTime(),
    type: 'expense', category: '餐饮', amount: 25,
    merchant: '测试商户-' + id, desc: ''
  }, extra)
}
function seed() {
  return {
    [TX]: [
      tx('b-current', '2026-11-22', { merchant: '待分类书店', category: '未分类' }),
      tx('b-classified', '2026-11-20', { merchant: '待分类书店', amount: 30 }),
      tx('b-leap', '2024-02-29'),
      tx('b-old', '2021-05-10'),
      tx('b-oldest', '2019-01-05')
    ],
    [RULE]: { '旧茶铺': '餐饮' },
    [BUDGET]: 1200,
    [CAT]: { '餐饮': 300, '交通': 100 },
    // 全是假数据，不读取真实会员、邀请码或共同账本信息。
    vip_member_v1: { isVip: true, permanent: true, expireAt: 0 },
    pending_invite_v1: 'offline-invite',
    theme_v1: 'dark',
    shared_book_v1: { bookId: 'offline-book', role: 'owner' },
    shared_pushed_v1: ['b-old'],
    pending_share_v1: 'offline-share',
    shared_remarks_v1: { peer: '离线成员' },
    unrelated_test_marker: { keep: ['unchanged'] }
  }
}

let pass = 0
let scenarios = 0
let scope = ''
const fails = []
const forbiddenCalls = []
function check(name, condition, extra) {
  if (condition) pass++
  else fails.push(scope + ' / ' + name + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra)))
}
function same(name, actual, expected) {
  // 对象按 Storage 序列化语义比较，保留顶层失败返回值的区别。
  const plain = (v) => v !== null && typeof v === 'object' ? copy(v) : v
  check(name, isDeepStrictEqual(plain(actual), plain(expected)), { actual, expected })
}
function scenario(name, fn) {
  scenarios++
  scope = name
  try { fn() } catch (err) {
    check('出现未预期异常', false, err.stack || String(err))
  }
}
function invoke(fn) {
  try { return fn() } catch (err) {
    check('保存失败应返回失败值，不能抛出未处理异常', false, err.stack || String(err))
    return undefined
  }
}
function offlineOnly(name) {
  return function () {
    forbiddenCalls.push(name)
    throw new Error('离线测试禁止调用 ' + name)
  }
}

function fresh(patch, absent) {
  const disk = copy(Object.assign(seed(), patch || {}))
  ;(absent || []).forEach((key) => { delete disk[key] })
  const events = []
  const faults = []
  function write(op, key, value) {
    const event = { op, key, ok: false }
    events.push(event)
    for (const fault of faults) {
      if (fault.key !== key || fault.left === 0) continue
      if (fault.skip > 0) { fault.skip--; continue }
      fault.left--
      throw new Error('MOCK_STORAGE_WRITE_FAILED: ' + key + ' (' + op + ')')
    }
    if (op === 'set') disk[key] = copy(value)
    else delete disk[key]
    event.ok = true
  }
  global.wx = {
    getStorageSync(key) {
      events.push({ op: 'get', key })
      return Object.prototype.hasOwnProperty.call(disk, key) ? copy(disk[key]) : ''
    },
    setStorageSync(key, value) { write('set', key, value) },
    removeStorageSync(key) { write('remove', key) },
    clearStorageSync() { Object.keys(disk).forEach((key) => write('remove', key)) },
    getStorageInfoSync() { return { keys: Object.keys(disk), currentSize: 0, limitSize: 10240 } },
    showToast() {},
    request: offlineOnly('wx.request'),
    uploadFile: offlineOnly('wx.uploadFile'),
    downloadFile: offlineOnly('wx.downloadFile'),
    connectSocket: offlineOnly('wx.connectSocket'),
    getFileSystemManager: offlineOnly('wx.getFileSystemManager'),
    cloud: { callFunction: offlineOnly('wx.cloud.callFunction'), database: offlineOnly('wx.cloud.database') }
  }
  delete require.cache[require.resolve(STORE_PATH)]
  const store = require(STORE_PATH)
  return {
    store, disk, events,
    fail(key, options) {
      const opts = options || {}
      faults.push({ key, skip: opts.skip || 0, left: opts.forever ? Infinity : 1 })
    },
    writes() { return events.filter((e) => e.op !== 'get') },
    resetEvents() { events.length = 0 }
  }
}
function view(store) {
  return copy({ txs: store.all(), rules: store.rules(), budget: store.budget(), catBudgets: store.catBudgets() })
}
function snapshot(env) {
  const heldTx = env.store.all()
  const heldRules = env.store.rules()
  const before = { disk: copy(env.disk), view: view(env.store), heldTx, heldRules }
  env.resetEvents()
  return before
}
function heldUnchanged(before) {
  same('旧流水引用未被原地修改', before.heldTx, before.view.txs)
  same('旧规则引用未被原地修改', before.heldRules, before.view.rules)
}
function unchanged(env, before) {
  same('磁盘完整保留（含 key 是否存在）', env.disk, before.disk)
  same('当前缓存和预算仍是旧值', view(env.store), before.view)
  heldUnchanged(before)
  env.store.reload()
  same('reload 后仍是旧值', view(env.store), before.view)
}
function persisted(env) {
  same('流水缓存与磁盘一致', env.store.all(), env.disk[TX] || [])
  same('规则缓存与磁盘一致', env.store.rules(), env.disk[RULE] || {})
  const current = view(env.store)
  env.store.reload()
  same('reload 后与成功返回前一致', view(env.store), current)
}
function noTrim(result) {
  check('结果不再携带 trimmed', !!result && !Object.prototype.hasOwnProperty.call(result, 'trimmed'), result)
}
function failedAt(env, key) {
  check('确实触发指定 key 的一次故障', env.writes().filter((e) => e.key === key && !e.ok).length === 1, env.writes())
}
function snapshotsBeforeWrite(env, keys) {
  const firstWrite = env.events.findIndex((e) => e.op !== 'get')
  const readKeys = env.events.slice(0, firstWrite).map((e) => e.key)
  check('首个写入前已读取所有待写 key 的快照', firstWrite >= 0 && keys.every((key) => readKeys.includes(key)), readKeys)
}
function reverseRollback(env) {
  const writes = env.writes()
  const firstFailure = writes.findIndex((e) => !e.ok)
  check('操作进入写失败分支', firstFailure >= 0, writes)
  if (firstFailure < 0) return
  const expected = writes.slice(0, firstFailure).filter((e) => e.ok).map((e) => e.key).reverse()
  same('仅对已写成功的 key 按相反顺序回滚', writes.slice(firstFailure + 1).map((e) => e.key), expected)
}
function backup(extra) {
  return Object.assign({
    version: 1,
    txs: [tx('b-backup-old', '2017-03-08'), tx('b-backup-new', '2026-11-23')],
    rules: { '旧茶铺': '购物', '新书店': '教育' },
    budget: 2400,
    catBudgets: { '餐饮': 450, '教育': 200 }
  }, extra || {})
}
function sorted(list) { return copy(list).sort((a, b) => b.time - a.time) }
function mergeFixture() {
  const h = tx('h-merge', '2022-06-12', { merchant: '合并茶铺', amount: 16 })
  h.time = new NativeDate(2022, 5, 12, 0, 0).getTime()
  const b = tx('b-merge', '2022-06-12', { merchant: '合并茶铺', amount: 16, desc: '补充订单', note: '测试备注' })
  return { env: fresh({ [TX]: sorted(seed()[TX].concat(h)) }), incoming: b }
}

try {
  global.Date = FixedDate

  scenario('Storage mock 双向 JSON 深拷贝', () => {
    const env = fresh()
    const input = { nested: { amount: 1 }, list: [1] }
    wx.setStorageSync('mock-probe', input)
    input.nested.amount = 2
    input.list.push(2)
    same('set 不保留调用者引用', env.disk['mock-probe'], { nested: { amount: 1 }, list: [1] })
    const read = wx.getStorageSync('mock-probe')
    read.nested.amount = 3
    read.list.push(3)
    same('get 不泄露磁盘引用', wx.getStorageSync('mock-probe'), { nested: { amount: 1 }, list: [1] })
    same('Date.now 固定', Date.now(), NOW)
    same('无参 new Date 固定', new Date().getTime(), NOW)
  })

  scenario('移除自动裁剪接口', () => {
    const env = fresh()
    check('不再导出 trimYear', !Object.prototype.hasOwnProperty.call(env.store, 'trimYear'))
    check('不再导出 trimExisting', !Object.prototype.hasOwnProperty.call(env.store, 'trimExisting'))
  })

  for (const day of ['2026-11-23', '2016-02-28', '2099-12-31']) {
    scenario('addOne 保留多年历史：' + day, () => {
      const env = fresh()
      const before = snapshot(env)
      const item = tx('b-added-one', day)
      const result = invoke(() => env.store.addOne(item))
      check('saved=true', !!result && result.saved === true, result)
      same('返回新增 tx', result && result.tx, item)
      check('不再携带 kept', !!result && !Object.prototype.hasOwnProperty.call(result, 'kept'), result)
      noTrim(result)
      same('新旧流水全部在缓存', env.store.all(), sorted(before.view.txs.concat(item)))
      same('新旧流水全部在磁盘', env.disk[TX], sorted(before.disk[TX].concat(item)))
      heldUnchanged(before)
      persisted(env)
    })
  }

  scenario('addMany 同时导入旧账、新账、异常未来账', () => {
    const env = fresh()
    const before = snapshot(env)
    const items = [tx('b-batch-old', '2015-05-01'), tx('b-batch-new', '2026-11-23'), tx('b-batch-future', '2099-12-31')]
    const inputBefore = copy(items)
    const result = invoke(() => env.store.addMany(items))
    same('导入计数正确', result && [result.added, result.dup, result.merged, result.saved], [3, 0, 0, true])
    noTrim(result)
    same('没有历史被裁剪', env.disk[TX], sorted(before.disk[TX].concat(items)))
    same('调用者输入未被改变', items, inputBefore)
    heldUnchanged(before)
    persisted(env)
  })

  scenario('preview 不写盘、不改原流水、不裁剪历史', () => {
    const { env, incoming } = mergeFixture()
    const before = snapshot(env)
    const items = [incoming, copy(before.view.txs[0]), tx('b-preview-old', '2014-01-01'), tx('b-preview-future', '2099-12-31')]
    const inputBefore = copy(items)
    const result = env.store.previewAdd(items)
    same('仅返回 added/dup/merged', result, { added: 2, dup: 1, merged: 1 })
    same('重复预览结果稳定', env.store.previewAdd(items), result)
    same('预览零写入（含 remove）', env.writes(), [])
    same('预览不改调用者输入', items, inputBefore)
    unchanged(env, before)
    const added = invoke(() => env.store.addMany(items))
    same('真实导入与预览计数一致', added && [added.added, added.dup, added.merged, added.saved], [2, 1, 1, true])
    same('合并与新增后仍保留全部历史', env.store.all().length, before.view.txs.length + 2)
    check('弱合并升级 id 并补充信息', env.store.all().some((t) => t.id === incoming.id && t.desc === incoming.desc && t.note === incoming.note))
    persisted(env)
  })

  scenario('preview 弱匹配但无信息变化应计 dup', () => {
    const existing = tx('b-no-change', '2022-08-01', { merchant: '无变化茶铺' })
    const incoming = Object.assign({}, existing, { id: 'h-no-change' })
    const env = fresh({ [TX]: sorted(seed()[TX].concat(existing)) })
    const before = snapshot(env)
    same('无变化不虚报 merged', env.store.previewAdd([incoming]), { added: 0, dup: 1, merged: 0 })
    same('没有写盘', env.writes(), [])
    unchanged(env, before)
    const result = invoke(() => env.store.addMany([incoming]))
    same('正式导入也只是重复', result && [result.added, result.dup, result.merged, result.saved], [0, 1, 0, true])
    unchanged(env, before)
  })

  for (const legacy of [false, true]) {
    scenario('restore 保留多年历史与未来账：' + (legacy ? '缺省旧版本' : 'version 1'), () => {
      const env = fresh()
      const before = snapshot(env)
      const payload = backup()
      payload.txs.push(tx('b-backup-future', '2099-12-31'), copy(before.view.txs[0]))
      if (legacy) delete payload.version
      const inputBefore = copy(payload)
      const result = invoke(() => env.store.importAll(payload))
      same('恢复完整返回契约', result && [result.added, result.dup, result.merged, result.skipped, result.rules, result.total, result.saved], [3, 1, 0, 0, 1, before.view.txs.length + 3, true])
      noTrim(result)
      snapshotsBeforeWrite(env, DATA_KEYS)
      same('旧账与恢复账均保存', env.disk[TX], sorted(before.disk[TX].concat(payload.txs.slice(0, 3))))
      same('规则只补缺，不覆盖原规则', env.store.rules(), { '旧茶铺': '餐饮', '新书店': '教育' })
      same('恢复总预算', env.store.budget(), 2400)
      same('恢复分类预算，保留未覆盖分类', env.store.catBudgets(), { '餐饮': 450, '交通': 100, '教育': 200 })
      same('不修改备份入参', payload, inputBefore)
      heldUnchanged(before)
      persisted(env)
    })
  }

  scenario('restore 跳过无效流水并补齐有效流水日期', () => {
    const env = fresh()
    const valid = tx('b-date-less', '2013-04-05')
    delete valid.day
    delete valid.ym
    const invalid = [null, 42, 'bad', [], {}, { id: 'bad-time', time: 'bad', amount: 1 }, { id: 'bad-amount', time: NOW, amount: 'bad' }, { time: NOW, amount: 1 }]
    const payload = { version: 1, txs: invalid.concat(valid) }
    const inputBefore = copy(payload)
    const result = invoke(() => env.store.importAll(payload))
    same('无效行逐条跳过，其余照常保存', result && [result.added, result.skipped, result.total, result.saved], [1, invalid.length, seed()[TX].length + 1, true])
    same('有效旧账正确补齐 day/ym', env.store.all().find((t) => t.id === valid.id), Object.assign({}, valid, { day: '2013-04-05', ym: '2013-04' }))
    same('补日期不会污染输入', payload, inputBefore)
    same('缺省元数据不清空原规则预算', [env.store.rules(), env.store.budget(), env.store.catBudgets()], [seed()[RULE], seed()[BUDGET], seed()[CAT]])
    persisted(env)
  })

  const singleFailures = [
    ['单笔保存', TX, (s) => s.addOne(tx('b-fail-one', '2026-11-23')), (r) => !!r && r.saved === false, (r) => !!r && r.saved === true],
    ['批量导入', TX, (s) => s.addMany([tx('b-fail-batch', '2026-11-23')]), (r) => !!r && r.saved === false, (r) => !!r && r.saved === true],
    ['修改流水', TX, (s) => s.update('b-current', { category: '教育', desc: '修改后', amount: 99 }), (r) => r === null, (r) => !!r && r.id === 'b-current' && r.amount === 99 && r.category === '教育'],
    ['批量分类', TX, (s) => s.relabel(['b-current', 'b-old'], '教育'), (r) => r === null, (r) => r === 2],
    ['删除单笔', TX, (s) => s.remove('b-old'), (r) => r === false, (r) => r === true],
    ['删除整月', TX, (s) => s.removeMonth('2026-11'), (r) => r === null, (r) => r === 2],
    ['学习规则', RULE, (s) => s.learn('新学书店', '教育'), (r) => r === false, (r) => r === true],
    ['批量学习规则', RULE, (s) => s.learnFromItems([tx('b-learn', '2026-11-22', { merchant: '新学书店', category: '教育', byPlatform: 'platform' })]), (r) => r === false, (r) => r === true]
  ]
  for (const [name, key, action, failed, succeeded] of singleFailures) {
    scenario(name + '失败 copy-on-write，重试成功', () => {
      const env = fresh()
      const before = snapshot(env)
      env.fail(key)
      const result = invoke(() => action(env.store))
      check('返回失败而不是假成功', failed(result), result)
      failedAt(env, key)
      unchanged(env, before)
      const retryBefore = snapshot(env)
      const retry = invoke(() => action(env.store))
      check('一次性故障后可成功重试', succeeded(retry), retry)
      check('重试确实写入目标 key', env.writes().some((e) => e.key === key && e.ok), env.writes())
      heldUnchanged(retryBefore)
      persisted(env)
    })
  }

  scenario('弱合并写失败不能污染旧流水对象', () => {
    const { env, incoming } = mergeFixture()
    const before = snapshot(env)
    env.fail(TX)
    const result = invoke(() => env.store.addMany([incoming]))
    check('合并失败 saved=false', !!result && result.saved === false, result)
    failedAt(env, TX)
    unchanged(env, before)
  })

  const budgetCases = [
    ['设置总预算', BUDGET, (s) => s.setBudget(2300.126), 2300.13, (s) => s.budget()],
    ['取消总预算', BUDGET, (s) => s.setBudget(0), 0, (s) => s.budget()],
    ['设置分类预算', CAT, (s) => s.setCatBudget('餐饮', 500.126), { '餐饮': 500.13, '交通': 100 }, (s) => s.catBudgets()],
    ['取消分类预算', CAT, (s) => s.setCatBudget('餐饮', 0), { '交通': 100 }, (s) => s.catBudgets()]
  ]
  for (const [name, key, action, expected, read] of budgetCases) {
    scenario(name + '失败无假成功', () => {
      const env = fresh()
      const before = snapshot(env)
      env.fail(key)
      same('失败返回 null', invoke(() => action(env.store)), null)
      failedAt(env, key)
      unchanged(env, before)
      same('重试返回已保存值', invoke(() => action(env.store)), expected)
      same('读到的预算与成功返回值一致', read(env.store), expected)
      persisted(env)
    })
  }

  scenario('预算模板整体覆盖并校验分类', () => {
    const env = fresh()
    same('非法分类拒绝写入', invoke(() => env.store.applyBudgetTemplate(3000, { 不存在: 100 })), null)
    const result = invoke(() => env.store.applyBudgetTemplate(3000.126, { 餐饮: 1200.126, 交通: 300, 购物: 0 }))
    check('模板保存成功', !!result && result.saved === true, result)
    same('月预算按分保存', env.store.budget(), 3000.13)
    same('分类预算整体替换', env.store.catBudgets(), { 餐饮: 1200.13, 交通: 300 })
    persisted(env)
  })

  for (const key of [BUDGET, CAT]) {
    scenario('预算模板在 ' + key + ' 失败时两个 key 一起回滚', () => {
      const env = fresh()
      const before = snapshot(env)
      env.fail(key)
      const result = invoke(() => env.store.applyBudgetTemplate(2600, { 餐饮: 1000, 交通: 200 }))
      check('失败不报成功', !!result && result.saved === false, result)
      unchanged(env, before)
      const retry = invoke(() => env.store.applyBudgetTemplate(2600, { 餐饮: 1000, 交通: 200 }))
      check('重试成功', !!retry && retry.saved === true, retry)
      same('重试后月预算正确', env.store.budget(), 2600)
      same('重试后分类预算正确', env.store.catBudgets(), { 餐饮: 1000, 交通: 200 })
    })
  }

  scenario('成功 clearAll 不触碰会员、主题、shared 标记', () => {
    const env = fresh()
    const before = snapshot(env)
    same('返回 true', invoke(() => env.store.clearAll()), true)
    snapshotsBeforeWrite(env, DATA_KEYS)
    same('账目、规则、预算清空', view(env.store), { txs: [], rules: {}, budget: 0, catBudgets: {} })
    const protectedKeys = Object.keys(before.disk).filter((key) => !DATA_KEYS.includes(key))
    for (const key of protectedKeys) same('保留 ' + key, env.disk[key], before.disk[key])
    check('只写账本数据与删除日志', env.writes().every((e) => DATA_KEYS.includes(e.key) || e.key === 'disabled_rules_v1'), env.writes())
    heldUnchanged(before)
    persisted(env)
  })

  for (const key of DATA_KEYS) {
    scenario('clearAll 在 ' + key + ' 失败后回滚', () => {
      const env = fresh()
      const before = snapshot(env)
      env.fail(key)
      same('返回 false', invoke(() => env.store.clearAll()), false)
      failedAt(env, key)
      snapshotsBeforeWrite(env, DATA_KEYS)
      reverseRollback(env)
      unchanged(env, before)
    })
  }

  const malformed = [
    ['null payload', null], ['数组 payload', []], ['字符串 payload', 'bad'], ['数字 payload', 7],
    ['缺 txs', {}], ['txs 非数组', { version: 1, txs: {} }],
    ...[0, 2, '1', null].map((v) => ['不支持 version=' + JSON.stringify(v), backup({ version: v })]),
    ...[null, [], 'bad', 7, true].map((v) => ['非法 rules=' + JSON.stringify(v), backup({ rules: v })]),
    ...[-1, 'bad', {}, [], null, Infinity, NaN].map((v, i) => ['非法 budget #' + i, backup({ budget: v })]),
    ...[null, [], 'bad', 7].map((v) => ['非法 catBudgets=' + JSON.stringify(v), backup({ catBudgets: v })]),
    ...[-1, 'bad', {}, null, Infinity].map((v, i) => ['非法分类预算值 #' + i, backup({ catBudgets: { '餐饮': v } })])
  ]
  for (const [name, payload] of malformed) {
    scenario('restore 校验先于任何写入：' + name, () => {
      const env = fresh()
      const before = snapshot(env)
      let result
      let thrown = false
      try { result = env.store.importAll(payload) } catch (err) { thrown = true }
      check('抛出校验错误或返回 saved=false', thrown || (!!result && result.saved === false), result)
      same('校验失败零写入（不能先写再回滚）', env.writes(), [])
      unchanged(env, before)
    })
  }

  scenario('restore 的合法零预算用于取消旧预算', () => {
    const env = fresh()
    const result = invoke(() => env.store.importAll({ version: 1, txs: [], budget: 0 }))
    check('saved=true', !!result && result.saved === true, result)
    same('总预算归零', env.store.budget(), 0)
    same('旧流水不受影响', env.store.all(), seed()[TX])
    persisted(env)
  })

  for (const key of DATA_KEYS) {
    scenario('restore 在 ' + key + ' 写失败时恢复原数据', () => {
      const env = fresh({ gone_v1: { 'b-backup-new': NOW } })
      const before = snapshot(env)
      env.fail(key)
      const result = invoke(() => env.store.importAll(backup()))
      check('saved=false', !!result && result.saved === false, result)
      check('完整回滚不报 partial=true', !!result && !result.partial, result)
      failedAt(env, key)
      snapshotsBeforeWrite(env, DATA_KEYS)
      reverseRollback(env)
      unchanged(env, before)
    })
  }

  scenario('restore 回滚也保留原本不存在的 key', () => {
    const env = fresh(null, [RULE, BUDGET, CAT])
    const before = snapshot(env)
    env.fail(CAT)
    const result = invoke(() => env.store.importAll(backup()))
    check('saved=false', !!result && result.saved === false, result)
    failedAt(env, CAT)
    reverseRollback(env)
    unchanged(env, before)
    check('新写入的规则和预算已删除，而非留下空值占位', !Object.prototype.hasOwnProperty.call(env.disk, RULE) && !Object.prototype.hasOwnProperty.call(env.disk, BUDGET))
  })

  scenario('AI 分类成功只改变未分类支出', () => {
    const income = tx('b-income', '2023-01-01', { type: 'income', category: '未分类', merchant: '待分类书店' })
    const env = fresh({ [TX]: sorted(seed()[TX].concat(income)) })
    const before = snapshot(env)
    const result = invoke(() => env.store.applyCategories({ '待分类书店': '教育' }))
    same('AI 返回 changed/learned/saved', result && [result.changed, result.learned, result.saved], [1, 1, true])
    snapshotsBeforeWrite(env, [TX, RULE])
    const expected = copy(before.view.txs)
    expected.find((t) => t.id === 'b-current').category = '教育'
    expected.find((t) => t.id === 'b-current').edited = NOW
    same('已分类行、收入和历史都不动', env.store.all(), expected)
    same('AI 规则落盘', env.disk[RULE], { '旧茶铺': '餐饮', '待分类书店': '教育' })
    heldUnchanged(before)
    persisted(env)
  })

  for (const key of [TX, RULE]) {
    scenario('AI 在 ' + key + ' 保存失败后回滚分类和规则', () => {
      const env = fresh()
      const before = snapshot(env)
      env.fail(key)
      const result = invoke(() => env.store.applyCategories({ '待分类书店': '教育' }))
      check('saved=false', !!result && result.saved === false, result)
      check('完整回滚不报 partial=true', !!result && !result.partial, result)
      failedAt(env, key)
      snapshotsBeforeWrite(env, [TX, RULE])
      reverseRollback(env)
      unchanged(env, before)
    })
  }

  // 先探测实际写序，再注入正向写入和补偿回滚的双重故障。
  const partialCases = [
    ['restore', (s) => s.importAll(backup()), true],
    ['AI', (s) => s.applyCategories({ '待分类书店': '教育' }), true],
    ['clearAll', (s) => s.clearAll(), false]
  ]
  for (const [name, action, hasPartial] of partialCases) {
    scenario(name + ' 回滚也失败时缓存重读实际磁盘', () => {
      const probe = fresh()
      const probeResult = invoke(() => action(probe.store))
      const keys = probe.writes().filter((e) => e.ok).map((e) => e.key)
      check('成功试跑确实包含多个不同 key', keys.length >= 2 && new Set(keys).size === keys.length && (hasPartial ? probeResult && probeResult.saved === true : probeResult === true), keys)
      if (keys.length < 2) return
      const rollbackKey = keys[0]
      const failedKey = keys[keys.length - 1]
      const committed = keys.slice(0, -1)
      const env = fresh()
      const before = snapshot(env)
      env.fail(rollbackKey, { skip: 1, forever: true })
      env.fail(failedKey)
      const result = invoke(() => action(env.store))
      if (hasPartial) {
        check('saved=false 且 partial=true', !!result && result.saved === false && result.partial === true, result)
      } else {
        same('clearAll 返回 false', result, false)
      }
      const expectedTrace = committed.map((key) => [key, true])
        .concat([[failedKey, false]], committed.slice().reverse().map((key) => [key, key !== rollbackKey]))
      same('故障轨迹确实覆盖正向保存及逆序失败回滚', env.writes().map((e) => [e.key, e.ok]), expectedTrace)
      check('磁盘确有部分变更，未把失败回滚伪装为成功', !isDeepStrictEqual(env.disk, before.disk))
      heldUnchanged(before)
      persisted(env)
      for (const key of DATA_KEYS.filter((key) => key !== rollbackKey)) {
        same('未写入或成功回滚的 key 保留原值：' + key, env.disk[key], before.disk[key])
      }
    })
  }

  scenario('无变更操作也返回新契约', () => {
    const env = fresh()
    const before = snapshot(env)
    same('找不到的 update 返回 null', env.store.update('missing', { amount: 2 }), null)
    same('找不到的 remove 返回 false', env.store.remove('missing'), false)
    same('无匹配 relabel 返回 0', env.store.relabel(['missing'], '教育'), 0)
    same('无匹配月份返回 0', env.store.removeMonth('2000-01'), 0)
    same('重复学习规则返回 true', env.store.learn('旧茶铺', '餐饮'), true)
    same('空批量学习返回 true', env.store.learnFromItems([]), true)
    const added = env.store.addMany([])
    same('空导入返回成功零计数', added && [added.added, added.dup, added.merged, added.saved], [0, 0, 0, true])
    const ai = env.store.applyCategories({})
    same('空 AI 返回成功零计数', ai && [ai.changed, ai.learned, ai.saved], [0, 0, true])
    unchanged(env, before)
  })

  scenario('删除日志与流水一起提交', () => {
    const env = fresh()
    const before = snapshot(env)
    env.fail('gone_v1')
    same('日志保存失败时删除返回 false', env.store.remove('b-current'), false)
    unchanged(env, before)
    same('重试删除成功', env.store.remove('b-current'), true)
    same('删除时间持久化', env.store.gone()['b-current'], NOW)
    env.fail(TX)
    same('加回失败不能丢掉删除日志', env.store.addOne(tx('b-current', '2026-11-22')).saved, false)
    same('回滚恢复日志', env.store.gone()['b-current'], NOW)
    same('主动加回成功', env.store.addOne(tx('b-current', '2026-11-22')).saved, true)
    check('主动加回清除日志', !env.store.gone()['b-current'])
  })

  scenario('他人记录只读，批处理也不能越权', () => {
    const peer = tx('shared:book:peer', '2026-11-22', { byMe: false, by: '', category: '未分类', merchant: '待分类书店' })
    const env = fresh({ [TX]: [peer] })
    same('无昵称也不能改他人记录', env.store.update(peer.id, { amount: 1 }), null)
    same('不能删除他人记录', env.store.remove(peer.id), false)
    same('整月删除跳过他人', env.store.removeMonth('2026-11'), 0)
    same('批量分类跳过他人', env.store.relabel([peer.id], '教育'), 0)
    same('AI 分类跳过他人', env.store.applyCategories({ '待分类书店': '教育' }).changed, 0)
    same('他人账目完整保留', env.store.all(), [peer])
  })

  scenario('大量删除不截断未同步标记', () => {
    const rows = Array.from({ length: 4101 }, (_, i) => tx('bulk-' + i, '2026-11-22'))
    const env = fresh({ [TX]: rows })
    same('整月删除全部4101条', env.store.removeMonth('2026-11'), 4101)
    same('所有删除标记保留供同步', Object.keys(env.store.gone()).length, 4101)
  })

  scenario('云端更新只写一次且不产生本机删除日志', () => {
    const env = fresh()
    const update = Object.assign({}, env.store.all()[0], { note: '云端新备注' })
    const result = env.store.applyRemote([update, tx('remote-new', '2020-01-01')], ['b-old'])
    same('新增更新删除计数', [result.saved, result.added, result.updated, result.removed], [true, 1, 1, 1])
    same('不把云端删除重复推回', Object.keys(env.store.gone()), [])
    same('本机流水写入一次', env.writes().filter((e) => e.key === TX).length, 1)
    persisted(env)
  })

  scope = '离线边界'
  same('没有线上或真实文件存储调用', forbiddenCalls, [])
} finally {
  global.Date = NativeDate
  if (originalWx === undefined) delete global.wx
  else global.wx = originalWx
  delete require.cache[require.resolve(STORE_PATH)]
}

console.log('场景 ' + scenarios + ' 个，断言 ' + (pass + fails.length) + ' 项：通过 ' + pass + ' 项，失败 ' + fails.length + ' 项')
if (fails.length) {
  fails.forEach((failure) => console.error('  FAIL ' + failure))
  process.exitCode = 1
}
