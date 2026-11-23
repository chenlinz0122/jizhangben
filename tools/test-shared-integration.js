const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { makeBookMock } = require('./book-mock-db')
const root = path.resolve(__dirname, '..')
const clone = (v) => v === undefined ? undefined : JSON.parse(JSON.stringify(v))
const server = makeBookMock({ throwOnMissing: true })
const now = Date.now()
const tx = (id, amount = 25, time = now) => ({ id, amount, time, type: 'expense', merchant: '测试店铺', category: '餐饮', source: '手记' })
let passed = 0
const check = (value, message) => { assert.ok(value, message); passed++ }

function device(openid, disk = {}) {
  const faults = new Set()
  const requests = []
  const modules = new Map()
  const dev = { disk, faults, requests, afterCall: null }
  const wx = {
    getStorageSync: (key) => key in disk ? clone(disk[key]) : '',
    setStorageSync: (key, value) => {
      if (faults.has(key)) throw new Error('injected local storage failure')
      disk[key] = clone(value)
    },
    removeStorageSync: (key) => { if (faults.has(key)) throw new Error('injected remove failure'); delete disk[key] },
    showToast() {},
    cloud: { callFunction(options) {
      requests.push(clone(options.data))
      setTimeout(async () => {
        try {
          const result = await server.call(openid, clone(options.data))
          if (dev.afterCall) dev.afterCall(options.data, result)
          options.success({ result: clone(result) })
        } catch (error) { options.fail({ errMsg: error.message }) }
      }, 0)
    } }
  }
  const context = vm.createContext({ wx, console, setTimeout, clearTimeout })
  function load(filename) {
    if (!filename.endsWith('.js')) filename += '.js'
    if (modules.has(filename)) return modules.get(filename).exports
    const module = { exports: {} }
    modules.set(filename, module)
    const run = vm.runInContext('(function(require,module,exports){' + fs.readFileSync(filename, 'utf8') + '\n})', context, { filename })
    run((name) => load(path.resolve(path.dirname(filename), name)), module, module.exports)
    return module.exports
  }
  dev.store = load(path.join(root, 'utils/store.js'))
  dev.shared = load(path.join(root, 'utils/shared.js'))
  dev.call = (method, ...args) => new Promise((resolve) => dev.shared[method](...args, resolve))
  dev.sync = (resolution) => new Promise((resolve) => dev.shared.sync(resolve, resolution))
  return dev
}

;(async () => {
  const a = device('member-A', { txs_v1: [tx('same-id'), tx('old-a', 10, new Date(2020, 0, 2).getTime())] })
  const b = device('member-B', { txs_v1: [tx('same-id', 50)] })
  let r = await a.call('createBook', '双人离线账本', '同昵称')
  check(r.ok && a.shared.current().owner, '创建后本机正确识别账主')
  const bookId = r.bookId
  const code = r.code
  r = await b.call('joinBook', code, '同昵称')
  check(r.ok && !b.shared.current().owner, '同昵称成员不会变成账主')
  check((await a.sync()).code === 'SCOPE_REQUIRED', '建账本不是授权上传全部历史')
  check(a.shared.setShareScope('recent') && b.shared.setShareScope('recent'), '双方明确确认近期范围')
  r = await a.sync()
  check(r.ok && r.pushed === 1, '仅上传范围内本人的流水')
  r = await b.sync()
  check(r.ok && r.added === 1 && r.pushed === 1, 'B能拉到A的记录并上传自己的同号记录')
  r = await a.sync()
  check(r.ok && r.added === 1 && a.store.all().length === 3, 'A收到B同号记录且旧账完整保留')
  check(server.store.book_txs.length === 2, '同号记录在云端也是两条，不相互覆盖')
  const aPeer = a.store.all().find((t) => !a.shared.isMine(t))
  check(aPeer.amount === 50 && aPeer.source === '手记', '跨端来源与金额完整')
  check(aPeer.ownerKey && aPeer.shareBook === bookId, '跨端记录有稳定归属和账本边界')
  check(a.store.update(aPeer.id, { amount: 1 }) === null && !a.store.remove(aPeer.id), '不能替他人改账或删账')

  a.store.update('same-id', { amount: 38, note: 'A修改' })
  check((await a.sync()).ok, '本人修改上云成功')
  r = await b.sync()
  check(r.ok && r.updated === 1 && b.store.all().some((t) => t.byMe === false && t.amount === 38 && t.note === 'A修改'), '对方已有流水被更新，不按id忽略修改')
  check(a.store.remove('same-id'), '本人删除成功')
  check((await a.sync()).ok, '本人删除上云')
  r = await b.sync()
  check(r.ok && r.removed === 1 && b.store.all().length === 1, '对方收到删除，不动自己的同号流水')
  check((await a.sync()).ok && !a.store.all().some((t) => t.id === 'same-id'), '再次同步不会复活本人已删流水')

  a.store.addOne(tx('retry-row'))
  a.afterCall = (data, result) => {
    if (data.action === 'push' && result.ok) a.faults.add('shared_sync_v2')
  }
  r = await a.sync()
  check(!r.ok && server.store.book_txs.some((t) => t.id === 'retry-row'), '云端成功但本机确认失败必须报失败')
  a.afterCall = null
  a.faults.clear()
  const revision = server.store.book_txs.find((t) => t.id === 'retry-row').version
  r = await a.sync()
  check(r.ok && r.pushed === 0 && server.store.book_txs.find((t) => t.id === 'retry-row').version === revision, '确认失败重试幂等，不重复上传或新增版本')

  a.store.addOne(tx('partial-one'))
  a.store.addOne(tx('partial-two'))
  server.failNext('set', 'book_txs', (event) => event.data.id === 'partial-two')
  r = await a.sync()
  check(!r.ok, '云端批次中途失败向客户端报告失败')
  r = await a.sync()
  check(r.ok && server.store.book_txs.filter((t) => /^partial-/.test(t.id)).length === 2, '云端部分写入后重试补齐，不丢不重')

  const a2 = device('member-A')
  r = await a2.call('info')
  check(r.ok && r.joined && a2.shared.current().owner, '同微信新设备能恢复账本与账主身份')
  check(a2.shared.setShareScope('recent'), '新设备也必须确认范围')
  r = await a2.sync()
  check(r.ok && a2.store.all().some((t) => t.id === 'retry-row'), '同账号另一设备恢复本人共享流水')
  a.store.update('retry-row', { note: '第一台修改' })
  a2.store.update('retry-row', { note: '第二台修改' })
  check((await a.sync()).ok, '第一台先同步修改')
  r = await a2.sync()
  check(!r.ok && r.code === 'CONFLICT', '两个设备同时改同一笔不会静默覆盖')
  check(a2.store.all().find((t) => t.id === 'retry-row').note === '第二台修改', '冲突保留本机修改')
  r = await a2.sync('cloud')
  check(r.ok && a2.store.all().find((t) => t.id === 'retry-row').note === '第一台修改', '明确选择云端后可解决冲突')
  a.store.update('retry-row', { note: '第一台再次修改' })
  a2.store.update('retry-row', { note: '明确保留第二台' })
  await a.sync()
  check((await a2.sync()).code === 'CONFLICT', '再次双端修改仍检测冲突')
  r = await a2.sync('local')
  check(r.ok && server.store.book_txs.find((t) => t.id === 'retry-row').note === '明确保留第二台', '明确选择本机后以新版本上传')

  a.shared.setShareScope('all')
  r = await a.sync()
  check(r.ok && server.store.book_txs.some((t) => t.id === 'old-a'), '确认历史共享后才上传旧账')
  a.shared.setShareScope('recent')
  a.store.update('old-a', { note: '缩小范围后的私人备注' })
  r = await a.sync()
  check(r.ok && server.store.book_txs.find((t) => t.id === 'old-a').note !== '缩小范围后的私人备注', '缩小共享范围后旧账新修改不再上传')
  a.shared.setShareScope('all')

  const stale = device('member-A', { txs_v1: [tx('retry-row')] })
  await stale.call('info'); stale.shared.setShareScope('all')
  r = await stale.sync()
  check(r.code === 'CONFLICT' && server.store.book_txs.find((t) => t.id === 'retry-row').note === '明确保留第二台', '没有基线的旧副本不能覆盖较新的云端内容')

  a.store.addOne(tx('delete-conflict'))
  await a.sync(); await a2.sync()
  a.store.remove('delete-conflict')
  a2.store.update('delete-conflict', { note: '删除同时另一台修改' })
  await a2.sync()
  r = await a.sync()
  check(r.code === 'CONFLICT' && !server.store.book_txs.find((t) => t.id === 'delete-conflict').deleted, '删除与另一端修改也必须冲突确认')
  r = await a.sync('cloud')
  check(r.ok && a.store.all().some((t) => t.id === 'delete-conflict' && t.note === '删除同时另一台修改') && !a.store.gone()['delete-conflict'], '选择云端撤销待删除标记并恢复记录')

  a.store.addOne(tx('restore-after-loss'))
  await a.sync()
  a.store.remove('restore-after-loss')
  a.afterCall = (data) => { if (data.action === 'push') throw new Error('模拟删除响应丢失') }
  check(!(await a.sync()).ok, '删除确认丢失不会假成功')
  a.afterCall = null
  a.store.addMany([tx('restore-after-loss')])
  r = await a.sync()
  check(r.ok && a.store.all().some((t) => t.id === 'restore-after-loss') && !server.store.book_txs.find((t) => t.id === 'restore-after-loss').deleted, '确认丢失后主动恢复不会被旧墓碑再次删除')
  a.store.update('restore-after-loss', { note: '丢失确认的第一次修改' })
  a.afterCall = (data) => { if (data.action === 'push') throw new Error('模拟修改响应丢失') }
  await a.sync(); a.afterCall = null
  a.store.update('restore-after-loss', { note: '确认丢失后再次修改' })
  r = await a.sync()
  check(r.ok && server.store.book_txs.find((t) => t.id === 'restore-after-loss').note === '确认丢失后再次修改', '待确认操作可识别为本人上传，不误报双端冲突')

  await server.call('member-A', { action: 'push', protocol: 2, bookId, txs: [tx('legacy-collision')] })
  await server.call('member-B', { action: 'push', protocol: 2, bookId, txs: [tx('legacy-collision', 60)] })
  const legacy = device('member-A', { txs_v1: [Object.assign(tx('legacy-collision', 60), { byMe: false, by: '同昵称' })] })
  await legacy.call('info'); legacy.shared.setShareScope('all')
  r = await legacy.sync()
  check(r.ok && legacy.store.all().filter((t) => t.id === 'legacy-collision' || t.shareSourceId === 'legacy-collision' || /^legacy:/.test(t.id)).length === 2, '本人同号加旧版他人记录只留下两条，不生成第三份遗留副本')

  for (let i = 0; i < 625; i++) a.store.addOne(tx('page-' + i, 1))
  r = await a.sync()
  check(r.ok && r.pushed === 625, '多批次上传625条成功')
  const beforePull = b.requests.length
  r = await b.sync()
  check(r.ok && b.store.all().filter((t) => /^page-/.test(t.shareSourceId || '')).length === 625, '另一端拉取超过600条没有丢尾页')
  check(b.requests.slice(beforePull).filter((t) => t.action === 'pull').length >= 7, '分页真正经过多次云函数调用')

  const beforeLeave = b.store.all().length
  r = await b.call('leave')
  check(r.ok && !b.shared.isJoined() && b.store.all().length === beforeLeave, '普通成员退出不删除本机副本')
  r = await a.sync()
  check(r.ok && !a.store.all().some((t) => t.byMe === false), '成员退出的墓碑会移除其他端共享副本')
  r = await b.call('joinBook', code, '重新加入')
  check(r.ok && b.shared.current().shareSince === null, '重新加入同一本账要重新确认共享范围')
  b.shared.setShareScope('all')
  r = await b.sync()
  check(r.code === 'CONFLICT' && b.store.all().some((t) => t.id === 'same-id' && t.amount === 50), '重新加入遇到旧墓碑先确认，不能静默删除本机记录')
  check((await b.sync('local')).ok, '重新加入可明确选择重新共享本机记录')
  await b.call('leave')
  r = await b.call('createBook', '第二本', '新名字')
  check(r.ok && b.shared.current().lastSync === 0 && b.shared.current().shareSince === null, '换账本不继承旧同步时间和授权')
  b.shared.setShareScope('all')
  r = await b.sync()
  check(r.ok && server.store.book_txs.filter((t) => t.bookId === b.shared.current().bookId).length === 2, '换账本绝不上传上一本其他成员的账目')
  r = await a.call('leave')
  check(r.ok && r.dissolved && server.store.book_txs.every((t) => t.bookId !== bookId), '账主解散清理全部页且不误伤另一本')
  r = await a2.call('info')
  check(r.ok && !r.joined && !a2.shared.isJoined(), '解散后其他设备正确清除过期成员状态')
  console.log('通过 ' + passed + ' 项，失败 0 项')
})().catch((error) => { console.error(error); process.exitCode = 1 })
