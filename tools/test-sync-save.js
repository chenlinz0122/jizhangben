const assert = require('assert')
const path = require('path')
const copy = (v) => v === undefined ? undefined : JSON.parse(JSON.stringify(v))
const tx = (id, day = '2026-11-22') => ({
  id, day, ym: day.slice(0, 7), time: new Date(day + 'T12:00:00+08:00').getTime(),
  type: 'expense', amount: 25, merchant: '离线-' + id, category: '餐饮'
})
const remote = (id, extra = {}) => Object.assign(tx(id), {
  sharedId: 'peer-' + id, ownerKey: 'peer-key', version: 1, isMe: false, byName: '成员'
}, extra)
let passed = 0
function check(condition, message) { assert.ok(condition, message); passed++ }
function setup(options = {}) {
  const disk = {
    txs_v1: copy(options.local || []),
    shared_book_v1: { bookId: 'test-book', name: '离线账本', lastSync: 123, members: 2, joinedAt: Date.now(), shareSince: 0 }
  }
  if (options.scope !== undefined) disk.shared_book_v1.shareSince = options.scope
  const rows = copy(options.remote || [])
  const calls = []
  const faults = new Set(options.failKeys || [])
  let env
  global.wx = {
    getStorageSync: (key) => {
      if (faults.has('read:' + key)) throw new Error('offline read failure')
      return key in disk ? copy(disk[key]) : ''
    },
    setStorageSync: (key, value) => {
      if (faults.has(key)) throw new Error('offline write failure')
      disk[key] = copy(value)
    },
    removeStorageSync: (key) => { if (faults.has(key)) throw new Error('offline remove failure'); delete disk[key] },
    showToast() {},
    cloud: { callFunction(request) {
      calls.push(copy(request.data))
      setTimeout(() => {
        const data = request.data
        let result
        if (data.action === 'pull') {
          const start = Number(data.cursor || 0)
          const page = rows.slice(start, start + 100)
          result = { ok: true, protocol: 2, members: 2, memberList: [], txs: page,
            hasMore: start + 100 < rows.length, cursor: String(start + 100).padStart(6, '0') }
          if (options.pull) result = options.pull(data, result)
        } else if (data.action === 'push') {
          const acks = []
          for (const t of data.txs) {
            let old = rows.find((r) => r.isMe && r.id === t.id)
            if (!old) { old = { id: t.id, version: 0 }; rows.push(old) }
            Object.assign(old, copy(t), { deleted: !!t.deleted, version: old.version + 1, sharedId: 'me-' + t.id, ownerKey: 'me-key', isMe: true, byName: '我' })
            acks.push({ id: old.id, version: old.version, sharedId: old.sharedId, deleted: !!old.deleted })
          }
          result = { ok: true, protocol: 2, pushed: data.txs.length, acks }
          if (options.afterPush) options.afterPush(env, data)
          if (options.push) result = options.push(data, result)
        } else if (data.action === 'my') {
          result = { ok: true, protocol: 2, joined: true, bookId: 'test-book', members: 2, memberList: [], role: 'owner' }
        } else throw new Error('Unexpected cloud action')
        request.success({ result: copy(result) })
      }, 0)
    } }
  }
  const storePath = path.resolve(__dirname, '../utils/store.js')
  const sharedPath = path.resolve(__dirname, '../utils/shared.js')
  delete require.cache[storePath]
  delete require.cache[sharedPath]
  const store = require(storePath)
  const shared = require(sharedPath)
  env = { disk, calls, faults, store, shared, rows, sync: () => new Promise((resolve) => shared.sync(resolve)) }
  return env
}

;(async () => {
  let env = setup({ scope: null, local: [tx('old', '2020-01-02')] })
  let result = await env.sync()
  check(result.code === 'SCOPE_REQUIRED' && env.calls.length === 0, '未确认共享范围绝不上传')
  check(env.shared.setShareScope('recent'), '明确选择近期范围可保存')
  result = await env.sync()
  check(result.ok && !env.calls.some((c) => c.action === 'push'), '近期范围不上传历史账目')
  check(env.shared.setShareScope('all'), '明确允许全部历史')
  result = await env.sync()
  check(result.ok && result.pushed === 1, '全部范围上传自己的历史记录')
  const pushCount = env.calls.filter((c) => c.action === 'push').length
  result = await env.sync()
  check(result.ok && env.calls.filter((c) => c.action === 'push').length === pushCount, '已确认记录不重复上传')

  const foreign = Object.assign(tx('foreign'), {
    amount: 72, nativeAmount: 10, currency: 'USD', rateToCny: 7.2,
    accountId: 'local-only-account', toCurrency: 'EUR', toNativeAmount: 9, toRateToCny: 8
  })
  env = setup({ local: [foreign] })
  result = await env.sync()
  check(result.ok && result.pushed === 1, '外币流水可正常同步')
  const sent = env.calls.find((c) => c.action === 'push').txs[0]
  check(sent.nativeAmount === 10 && sent.currency === 'USD' && sent.rateToCny === 7.2 &&
    sent.toNativeAmount === 9 && sent.toCurrency === 'EUR' && sent.toRateToCny === 8,
  '上传保留原币金额、币种与汇率快照')
  check(sent.accountId === undefined, '本机账户 ID 不随共同账本上传')

  env = setup({ remote: [remote('foreign-remote', {
    amount: 72, nativeAmount: 10, currency: 'USD', rateToCny: 7.2
  })] })
  result = await env.sync()
  check(result.ok && result.added === 1, '外币云端流水可正常拉取')
  const pulled = env.store.all()[0]
  check(pulled.nativeAmount === 10 && pulled.currency === 'USD' && pulled.rateToCny === 7.2,
    '拉取保留原币金额、币种与汇率快照')

  env = setup({ local: [tx('local', '2020-01-02')], remote: [remote('new')], failKeys: ['txs_v1'] })
  result = await env.sync()
  check(!result.ok && env.store.all().length === 1, '落库失败不假成功且缓存不污染')
  check(env.disk.shared_book_v1.lastSync === 123, '落库失败不推进同步时间')
  check(!env.calls.some((c) => c.action === 'push'), '拉取落库失败不继续上传')
  env.faults.clear()
  result = await env.sync()
  check(result.ok && result.added === 1 && env.store.all().length === 2, '解除存储故障重试完整成功')
  check(env.store.all().some((t) => t.id === 'local'), '多年旧账不丢')
  check(env.store.all().some((t) => t.byMe === false && t.shareId === 'peer-new'), '他人记录保存稳定身份')

  for (const key of ['shared_sync_v2', 'shared_book_v1']) {
    env = setup({ remote: [remote('new')], failKeys: [key] })
    result = await env.sync()
    check(!result.ok && env.disk.shared_book_v1.lastSync === 123, key + ' 写失败不能报成功')
    check(env.store.all().length === 1, key + ' 写失败不丢已保存的流水')
    env.faults.clear()
    result = await env.sync()
    check(result.ok && env.store.all().length === 1, key + ' 重试不重复')
    check(env.calls.every((c) => c.action !== 'push'), '重试不把他人的流水当作自己上传')
  }

  env = setup({ local: [tx('a'), tx('b')], push: () => ({ ok: true, protocol: 2, pushed: 1, acks: [] }) })
  result = await env.sync()
  check(!result.ok && result.code === 'PARTIAL_PUSH', '部分确认不能报完整成功')
  check(Object.keys(env.disk.shared_sync_v2['test-book'].own).length === 0, '部分确认不标记全部已上传')
  check(env.disk.txs_v1.length === 2 && env.disk.shared_book_v1.lastSync === 123, '部分上传保留本机记录和旧同步时间')

  env = setup({ local: [tx('a')], push: () => ({ ok: false, code: 'SERVER_ERROR', msg: '离线上传失败' }) })
  result = await env.sync()
  check(!result.ok && result.msg === '离线上传失败', '云端上传失败原样报告')
  check(env.disk.shared_book_v1.lastSync === 123, '上传失败不推进时间')

  env = setup({ remote: [remote('new')], pull: () => ({ ok: true, txs: [] }) })
  result = await env.sync()
  check(result.code === 'UPGRADE_REQUIRED' && !env.disk.shared_sync_v2, '旧云函数不会冒充新协议成功')
  env = setup({ pull: () => ({ ok: true, protocol: 2, txs: [], hasMore: true, cursor: '' }) })
  result = await env.sync()
  check(!result.ok && env.calls.length === 1, '分页游标不前进即停止，不死循环')
  env = setup({ remote: [remote('bad', { amount: -1 })] })
  result = await env.sync()
  check(!result.ok && env.store.all().length === 0, '无效云端金额不污染本机')

  env = setup({ remote: Array.from({ length: 721 }, (_, i) => remote('r' + i)) })
  result = await env.sync()
  check(result.ok && result.added === 721 && env.store.all().length === 721, '超过600条全部分页拉取')
  check(env.calls.filter((c) => c.action === 'pull').length === 8, '拉取按游标获取所有页面')
  env = setup({ remote: Array.from({ length: 110 }, (_, i) => remote('r' + i)), pull: (data, r) => data.cursor ? { ok: false, msg: '分页中断' } : r })
  result = await env.sync()
  check(!result.ok && env.store.all().length === 0 && env.disk.shared_book_v1.lastSync === 123, '后续页失败不提交残缺快照')

  env = setup({ local: Array.from({ length: 4101 }, (_, i) => tx('l' + i)) })
  result = await env.sync()
  check(result.ok && result.pushed === 4101 && env.calls.filter((c) => c.action === 'push').length === 206, '超过4000条的本人记录全部上传')
  result = await env.sync()
  check(result.ok && result.pushed === 0 && Object.keys(env.disk.shared_sync_v2['test-book'].own).length === 4101, '同步状态不再截断到4000条造成反复上传')
  env = setup({ local: [tx('same')], remote: [remote('same'), remote('same', { sharedId: 'other-owner-same', ownerKey: 'other-key' })] })
  result = await env.sync()
  check(result.ok && env.store.all().length === 3, '同ID同昵称的不同成员记录各自保留')
  check(env.store.all().filter((t) => t.byMe === false).length === 2, '归属由稳定身份决定，不猜昵称')
  const peer = env.store.all().find((t) => t.byMe === false)
  check(env.store.update(peer.id, { amount: 1 }) === null && !env.store.remove(peer.id), '他人记录不能修改或全局删除')

  env = setup({ local: [tx('own')] })
  result = await env.sync()
  check(result.ok && env.store.update('own', { note: '修改后的备注' }), '本人可修改')
  result = await env.sync()
  check(result.ok && result.pushed === 1 && env.rows.find((r) => r.id === 'own').note === '修改后的备注', '已上传记录修改后继续同步')
  check(env.store.remove('own'), '本人记录删除成功')
  result = await env.sync()
  check(result.ok && result.pushed === 1 && env.rows.find((r) => r.id === 'own').deleted, '删除作为墓碑通知云端')
  result = await env.sync()
  check(result.ok && env.store.all().length === 0 && result.pushed === 0, '删除重试不复活不重复上传')
  check(env.store.addMany([tx('own')]).saved && !env.store.gone().own, '主动重新导入会撤销本机删除标记')
  result = await env.sync()
  check(result.ok && result.pushed === 1, '主动恢复后重新同步')

  env = setup({ local: [tx('own')], remote: [remote('peer')] })
  await env.sync()
  check(env.store.clearAll(), '清空本机数据成功')
  result = await env.sync()
  check(result.ok && env.store.all().length === 0, '清空后同步不把删掉的数据拉回')
  check(env.rows.find((r) => r.isMe).deleted && !env.rows.find((r) => !r.isMe).deleted, '清空只传播本人删除，不能删除他人云端数据')

  let editedDuringPush = false
  env = setup({ local: [tx('own')], afterPush: (current) => {
    if (!editedDuringPush) { editedDuringPush = true; current.store.update('own', { note: '上传期间修改' }) }
  } })
  result = await env.sync()
  check(result.ok && env.store.all()[0].note === '上传期间修改', '上传确认不覆盖期间新增的修改')
  result = await env.sync()
  check(result.ok && result.pushed === 1 && env.rows[0].note === '上传期间修改', '下一次同步补传上传期间修改')

  env = setup({ local: [tx('private')], pull: (data, result) => {
    env.disk.shared_book_v1.joinedAt++
    env.disk.shared_book_v1.shareSince = null
    return result
  } })
  result = await env.sync()
  check(result.code === 'BOOK_CHANGED' && env.calls.every((c) => c.action !== 'push'), '同步期间成员代际或共享授权变化必须停止上传')

  env = setup({ remote: [remote('new')] })
  const both = await Promise.all([env.sync(), env.sync()])
  check(both.every((r) => r.ok) && env.calls.length === 1, '重复点击合并为一次同步并通知全部回调')
  env = setup({ failKeys: ['read:shared_sync_v2'] })
  result = await env.sync()
  check(!result.ok && !env.shared.busy(), '读取同步状态失败可见且释放同步锁')
  env = setup({ pull: () => ({ ok: false, code: 'NOT_MEMBER', msg: '已退出' }) })
  result = await env.sync()
  check(!result.ok && !env.shared.isJoined(), '云端确认不再是成员后移除过期账本缓存')
  env = setup()
  delete env.disk.shared_book_v1
  result = await new Promise((resolve) => env.shared.info(resolve))
  check(result.ok && env.shared.current().owner && env.shared.current().shareSince === null, '无本机缓存可恢复云端身份，但不会偷偷授权上传')

  console.log('通过 ' + passed + ' 项，失败 0 项')
})().catch((error) => { console.error(error); process.exitCode = 1 })
