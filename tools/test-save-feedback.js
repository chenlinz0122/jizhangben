const assert = require('assert')
const path = require('path')
const copy = (value) => JSON.parse(JSON.stringify(value))
const nativeTimeout = global.setTimeout
const tx = (id, day, extra) => Object.assign({
  id, day, ym: day.slice(0, 7), time: new Date(day + 'T12:00:00+08:00').getTime(),
  type: 'expense', amount: 20, merchant: '离线书店', category: '餐饮', note: '原备注'
}, extra)
let passed = 0
function check(value, message) { assert.ok(value, message); passed++ }
function setup(pageName, failKey) {
  const disk = {
    txs_v1: [tx('b-old', '2020-01-01'), tx('b-current', '2026-11-22')],
    rules_v1: {}, budget_v1: 1000, budcats_v1: { '餐饮': 100 },
    member_v1: { offline: '保留会员测试标记' }
  }
  const modals = []
  const toasts = []
  const timers = []
  let writes = 0
  let backs = 0
  let definition
  let failedKey = failKey
  global.setTimeout = (fn) => { timers.push(fn); return timers.length }
  global.wx = {
    getStorageSync: (key) => key in disk ? copy(disk[key]) : '',
    setStorageSync: (key, value) => { if (key === failedKey) throw new Error('offline failure'); disk[key] = copy(value); writes++ },
    removeStorageSync: (key) => { if (key === failedKey) throw new Error('offline failure'); delete disk[key]; writes++ },
    showToast: (options) => toasts.push(options),
    showModal: (options) => modals.push(options),
    navigateBack: () => { backs++ }
  }
  global.Page = (options) => { definition = options }
  global.getApp = () => ({ globalData: {} })
  const storePath = path.resolve(__dirname, '../utils/store.js')
  delete require.cache[storePath]
  const store = require(storePath)
  const vip = require('../utils/vip')
  let allowed = true
  vip.guard = () => allowed
  const filename = path.resolve(__dirname, '../pages/' + pageName + '/' + pageName + '.js')
  delete require.cache[filename]
  require(filename)
  const page = Object.assign({}, definition, { data: copy(definition.data) })
  page.setData = function (patch, cb) {
    for (const key of Object.keys(patch)) {
      const parts = key.split('.')
      let target = this.data
      while (parts.length > 1) { const p = parts.shift(); target = target[p] || (target[p] = {}) }
      target[parts[0]] = patch[key]
    }
    if (cb) cb()
  }
  page.refresh = () => {}
  page.offerBatch = () => {}
  return {
    page, store, disk, modals, toasts, timers,
    confirm(content) { const modal = modals[modals.length - 1]; assert.ok(modal && modal.success); modal.success({ confirm: true, content }) },
    retry() { failedKey = undefined },
    denyVip() { allowed = false },
    writes: () => writes, backs: () => backs
  }
}

try {
  for (const name of ['import', 'shot']) {
    let env = setup(name, 'txs_v1')
    const items = [tx('b-import', '2018-02-03', { byPlatform: 'platform', category: '教育' })]
    env.page.data.preview = { add: 1, sample: ['离线预览'] }
    env.page.data.text = '原始账单文本'
    const key = name === 'import' ? '_items' : '_parsed'
    env.page[key] = items
    env.page.doImport()
    check(env.page[key] === items, name + '保存失败保留解析数据')
    check(env.page.data.preview.add === 1, name + '保存失败保留预览')
    check(env.page.data.result === null, name + '失败不显示导入完成')
    check(env.disk.txs_v1.length === 2, name + '失败保留旧流水')
    check(Object.keys(env.disk.rules_v1).length === 0, name + '失败不学习规则')
    check(env.modals.at(-1).title === '没能保存', name + '给出明确失败反馈')
    env.retry()
    env.page.doImport()
    check(env.page.data.result.added === 1, name + '重试后展示真正新增笔数')
    check(env.page.data.preview === null && env.page[key] === null, name + '仅成功后清理预览')
    check(env.disk.txs_v1.some((t) => t.id === 'b-import'), name + '多年旧账导入成功')

    env = setup(name, 'rules_v1')
    env.page[key] = items
    env.page.data.preview = { add: 1 }
    env.page.doImport()
    check(env.page.data.result.added === 1, name + '规则失败不否认流水已保存')
    check(env.modals.at(-1).title === '流水已保存', name + '区分规则保存失败')
    check(env.disk.txs_v1.length === 3, name + '规则失败保留已保存的流水')
  }

  let env = setup('add', 'txs_v1')
  env.page.onLoad()
  Object.assign(env.page.data, { date: '2018-02-03', amount: '12.50', merchant: '离线测试店', note: '输入保留' })
  env.page.save()
  check(env.page.data.amount === '12.50' && env.page.data.note === '输入保留', '手记失败保留金额备注')
  check(env.backs() === 0 && env.timers.length === 0, '手记失败不返回上一页')
  check(env.modals.at(-1).title === '没能保存', '手记失败反馈')
  env.retry()
  env.page.save()
  check(env.disk.txs_v1.some((t) => t.day === '2018-02-03'), '手记支持超过一年的历史日期')
  check(env.disk.txs_v1.some((t) => t.id === 'b-old'), '手记历史流水不删已有旧账')
  check(env.toasts.at(-1).title === '已记上', '手记成功反馈')
  for (const amount of ['Infinity', 'NaN', '0', '-2', '0.001', '12abc']) {
    env = setup('add')
    Object.assign(env.page.data, { amount, date: '2020-01-01' })
    env.page.save()
    check(env.writes() === 0, '拒绝无效金额 ' + amount)
  }
  for (const date of ['2025-02-29', '2026-13-01', '2099-01-01', 'bad']) {
    env = setup('add')
    Object.assign(env.page.data, { amount: '2', date })
    env.page.save()
    check(env.writes() === 0, '拒绝无效或未来日期 ' + date)
  }

  env = setup('list', 'txs_v1')
  env.page.data.sheetVisible = true
  env.page.data.sheetItem = { id: 'b-current', merchant: '离线书店', amountText: '20.00', note: '原备注' }
  env.page.editNote()
  env.confirm('新备注')
  check(env.page.data.sheetItem.note === '原备注', '备注失败不更新详情显示')
  check(!env.toasts.some((t) => t.title === '备注已保存'), '备注失败不覆盖成功提示')
  env.page.pickCat({ currentTarget: { dataset: { cat: '教育' } } })
  check(env.page.data.sheetVisible, '分类失败详情保持打开')
  check(env.store.all().find((t) => t.id === 'b-current').category === '餐饮', '分类失败保持旧值')
  env.page.deleteSheetItem()
  env.confirm()
  check(env.page.data.sheetVisible && env.disk.txs_v1.length === 2, '删除失败保持详情与旧账')
  check(!env.toasts.some((t) => t.title === '已删除'), '删除失败不提示已删除')
  env.page.data.ym = '2026-11'
  env.page.clearMonth()
  env.confirm()
  check(!env.toasts.some((t) => /^已删除/.test(t.title)), '删月失败不报成功')
  env.page.data.filterCat = '餐饮'
  env.page.clearEverything()
  env.confirm()
  check(env.page.data.filterCat === '餐饮', '清空失败不重置筛选')
  check(!env.toasts.some((t) => t.title === '已清空'), '清空失败不报成功')
  check(env.disk.member_v1.offline === '保留会员测试标记', '清空尝试不触碰会员数据')

  env = setup('report', 'budget_v1')
  env.page.setBudget()
  env.confirm('2000')
  check(env.disk.budget_v1 === 1000, '预算失败保留旧预算')
  check(!env.toasts.some((t) => t.title === '预算已设'), '预算失败不报成功')
  env = setup('report', 'budcats_v1')
  env.page.pickCatBudget({ currentTarget: { dataset: { name: '餐饮' } } })
  env.confirm('500')
  check(env.disk.budcats_v1['餐饮'] === 100, '分类预算失败保留旧值')
  check(!env.toasts.some((t) => t.title === '预算已设'), '分类预算失败不报成功')
  env = setup('report')
  env.denyVip()
  env.page.setBudget()
  env.page.aiFill()
  check(env.modals.length === 0 && env.writes() === 0, '预算和AI会员限制仍生效')

  for (const failing of [true, false]) {
    env = setup('report', failing ? 'txs_v1' : undefined)
    const payload = { version: 1, txs: [tx('b-restored', '2016-02-03')], budget: 2000, rules: { '离线书店': '教育' } }
    wx.chooseMessageFile = (options) => options.success({ tempFiles: [{ path: 'memory.json' }] })
    wx.getFileSystemManager = () => ({ readFile(options) { options.success({ data: JSON.stringify(payload) }) } })
    env.page.restore()
    env.confirm()
    check(env.modals.at(-1).title === (failing ? '恢复失败' : '恢复完成'), '恢复反馈对应实际持久化结果')
    check(env.disk.txs_v1.length === (failing ? 2 : 3), '恢复实际流水笔数正确')
    check(env.disk.budget_v1 === (failing ? 1000 : 2000), '恢复失败回滚预算，成功更新预算')
  }
  env = setup('report')
  wx.chooseMessageFile = (options) => options.success({ tempFiles: [{ path: 'memory.json' }] })
  wx.getFileSystemManager = () => ({ readFile(options) { options.success({ data: 'null' }) } })
  env.page.restore()
  check(env.writes() === 0 && env.toasts.at(-1).title === '备份里没有流水', '空备份不崩溃、不改账本')

  env = setup('add')
  let app
  global.App = (definition) => { app = definition }
  delete require.cache[require.resolve('../app')]
  require('../app')
  app.onLaunch({})
  check(env.writes() === 0 && env.disk.txs_v1.length === 2, '启动不再清理多年旧账')

  console.log('通过 ' + passed + ' 项，失败 0 项')
} finally {
  global.setTimeout = nativeTimeout
}
