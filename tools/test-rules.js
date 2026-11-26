const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const managerPath = path.join(root, 'utils/rule-manager.js')
const storePath = path.join(root, 'utils/store.js')
const pagePath = path.join(root, 'pages/rules/rules.js')
const clone = (value) => JSON.parse(JSON.stringify(value))
const tx = (id, merchant, desc, type = 'expense') => ({
  id, merchant, desc: desc || '', type, amount: 20, category: '未分类',
  day: '2026-11-20', ym: '2026-11', time: new Date('2026-11-20T12:00:00+08:00').getTime()
})
let passed = 0
function check(value, message) { assert.ok(value, message); passed++ }
function same(actual, expected, message) { assert.deepStrictEqual(actual, expected, message); passed++ }

function seed() {
  return {
    rules_v1: { '离线书店': '购物', '离线书店分店': '购物', '工资卡': '工资' },
    disabled_rules_v1: { '停用测试店': '娱乐' },
    txs_v1: [
      tx('t1', '离线书店', '买书'),
      tx('t2', '离线书店分店', '买书'),
      tx('t3', '别的商户', '离线书店优惠券'),
      tx('t4', '离线书店', '稿费', 'income'),
      tx('t5', '离线书店', '转账', 'transfer'),
      tx('t6', '停用测试店', '消费')
    ]
  }
}

function setup(initial = seed()) {
  const disk = clone(initial)
  const calls = { writes: 0, reads: 0, toasts: [], modals: [] }
  let failKey = ''
  let failAlways = true
  let failedOnce = false
  let throwOnCall = null
  let readFailKey = ''
  let dark = false
  let watcher = null
  global.wx = {
    getStorageSync(key) {
      calls.reads++
      if (key === readFailKey) throw new Error('read blocked')
      return key in disk ? clone(disk[key]) : ''
    },
    setStorageSync(key, value) {
      calls.writes++
      const callNo = calls.writes
      if (key === failKey && (failAlways || !failedOnce)) {
        failedOnce = true
        throw new Error('write blocked')
      }
      if (throwOnCall && throwOnCall[key] && throwOnCall[key].includes(callNo)) {
        throw new Error('call blocked')
      }
      disk[key] = clone(value)
    },
    removeStorageSync(key) { delete disk[key] },
    getAppBaseInfo() { return { theme: dark ? 'dark' : 'light' } },
    getSystemInfoSync() { return { theme: dark ? 'dark' : 'light' } },
    onThemeChange(fn) { watcher = fn },
    offThemeChange(fn) { if (watcher === fn) watcher = null },
    showToast(options) { calls.toasts.push(options) },
    showModal(options) { calls.modals.push(options) }
  }
  global.getApp = () => ({ globalData: {} })
  delete require.cache[managerPath]
  delete require.cache[storePath]
  const manager = require(managerPath)
  const store = require(storePath)
  return {
    disk, calls, manager, store,
    fail(key, always = true) { failKey = key; failAlways = always; failedOnce = false },
    failRead(key) { readFailKey = key },
    failCalls(plan) { throwOnCall = plan },
    setDark(value) { dark = value },
    themeChange(value) { dark = value; if (watcher) watcher({ theme: value }) }
  }
}

try {
  let env = setup({ txs_v1: [] })
  same(env.manager.list(), [], '空存储返回空规则列表')
  same(env.manager.clearDisabled(), { ok: true, changed: false, count: 0 }, '停用规则为空时清空不写盘')
  check(env.calls.writes === 0, '空清空不产生写入')

  env = setup()
  let listed = env.manager.list()
  same(listed.map((r) => r.merchant), ['工资卡', '离线书店', '离线书店分店', '停用测试店'], '列表合并启停规则并按商户排序')
  check(listed.find((r) => r.merchant === '离线书店').affectedCount === 2, '影响笔数只计算分类实际变化')
  check(listed.find((r) => r.merchant === '离线书店分店').affectedCount === 0, '被更具体同分类规则覆盖时计 0')
  check(listed.find((r) => r.merchant === '停用测试店').affectedCount === 1, '停用规则返回启用后的影响笔数')
  check(env.manager.affectedCount('不存在的商户') === 0, '不存在的规则影响笔数为 0')

  env.store.rules()
  let result = env.manager.toggle('离线书店', false)
  check(result.ok && result.changed && !result.enabled, '停用规则返回明确成功')
  check(!('离线书店' in env.disk.rules_v1) && env.disk.disabled_rules_v1['离线书店'] === '购物', '停用规则在两个 key 间迁移')
  check(!('离线书店' in env.store.rules()), '写入后 store.rules 缓存已刷新')
  result = env.manager.toggle('离线书店', true)
  check(result.ok && result.changed && result.enabled, '重新启用规则成功')
  check(env.disk.rules_v1['离线书店'] === '购物' && !('离线书店' in env.disk.disabled_rules_v1), '启用规则移回 rules_v1')
  const beforeNoop = env.calls.writes
  result = env.manager.toggle('离线书店', true)
  check(result.ok && !result.changed && env.calls.writes === beforeNoop, '重复启用不写盘')

  result = env.manager.remove('停用测试店')
  check(result.ok && result.changed && !result.enabled, '删除停用规则成功')
  check(!('停用测试店' in env.disk.disabled_rules_v1), '删除停用规则清理 disabled_rules_v1')
  result = env.manager.remove('工资卡')
  check(result.ok && !('工资卡' in env.disk.rules_v1), '删除启用规则成功')
  result = env.manager.remove('工资卡')
  check(!result.ok && result.code === 'RULE_NOT_FOUND', '删除不存在的规则明确失败')

  env = setup()
  env.manager.toggle('离线书店', false)
  result = env.manager.clearDisabled()
  check(result.ok && result.changed && result.count === 2, '清空停用规则返回数量')
  same(env.disk.disabled_rules_v1, {}, '清空后停用存储为空对象')
  check(env.disk.rules_v1['离线书店分店'] === '购物', '清空停用规则不影响启用规则')

  env = setup()
  let preview = env.manager.preview('离线书店 购买图书', 'expense')
  check(preview.ok && preview.category === '购物' && preview.by === 'user', '预览命中启用用户规则')
  preview = env.manager.preview('停用测试店 消费', 'expense')
  check(preview.category === '未分类', '预览不命中停用规则')
  preview = env.manager.preview('工资卡 发放', 'income')
  check(preview.category === '工资' && preview.by === 'user', '预览支持收入类型')
  preview = env.manager.preview('任意商户 任意说明', 'transfer')
  check(preview.category === '账户转移' && preview.by === 'kind', '预览支持转账类型')
  assert.throws(() => env.manager.preview('文本', 'bad'), (e) => e.code === 'BAD_TYPE'); passed++
  assert.throws(() => env.manager.preview('  ', 'expense'), (e) => e.code === 'BAD_TEXT'); passed++

  for (const [merchant, enabled, code] of [['', true, 'BAD_MERCHANT'], ['不存在', true, 'RULE_NOT_FOUND'], ['离线书店', 'false', 'BAD_ENABLED']]) {
    env = setup()
    result = env.manager.toggle(merchant, enabled)
    check(!result.ok && result.code === code && env.calls.writes === 0, '非法启停输入明确失败且不写盘：' + code)
  }
  env = setup()
  result = env.manager.remove('  ')
  check(!result.ok && result.code === 'BAD_MERCHANT', '删除拒绝空商户')

  const badCases = [
    [{ rules_v1: 'bad', disabled_rules_v1: {}, txs_v1: [] }, 'BAD_STORAGE'],
    [{ rules_v1: {}, disabled_rules_v1: [], txs_v1: [] }, 'BAD_STORAGE'],
    [{ rules_v1: { '坏商户': 3 }, disabled_rules_v1: {}, txs_v1: [] }, 'BAD_STORAGE'],
    [{ rules_v1: { '坏商户': '不存在的分类' }, disabled_rules_v1: {}, txs_v1: [] }, 'BAD_STORAGE'],
    [{ rules_v1: { '': '餐饮' }, disabled_rules_v1: {}, txs_v1: [] }, 'BAD_MERCHANT'],
    [{ rules_v1: { ' 坏商户': '餐饮' }, disabled_rules_v1: {}, txs_v1: [] }, 'BAD_STORAGE'],
    [{ rules_v1: { '冲突商户': '餐饮' }, disabled_rules_v1: { '冲突商户': '娱乐' }, txs_v1: [] }, 'RULE_CONFLICT'],
    [{ rules_v1: { constructor: '餐饮' }, disabled_rules_v1: {}, txs_v1: [] }, 'BAD_MERCHANT']
  ]
  for (const [data, code] of badCases) {
    env = setup(data)
    assert.throws(() => env.manager.list(), (e) => e.code === code); passed++
    result = env.manager.toggle('冲突商户', false)
    check(!result.ok && result.code === code && env.calls.writes === 0, '坏数据写操作明确失败：' + code)
  }

  env = setup()
  env.store.rules()
  env.fail('disabled_rules_v1')
  result = env.manager.toggle('离线书店', false)
  check(!result.ok && result.code === 'STORAGE_WRITE_FAILED' && !result.partial, '第二个 key 写失败返回明确错误')
  check(env.disk.rules_v1['离线书店'] === '购物' && !('离线书店' in env.disk.disabled_rules_v1), '第二个 key 写失败回滚第一个 key')
  same(env.store.rules(), env.disk.rules_v1, '写失败后 store 缓存与回滚后的磁盘一致')

  env = setup()
  env.failCalls({ rules_v1: [3], disabled_rules_v1: [2] })
  result = env.manager.toggle('离线书店', false)
  check(!result.ok && result.code === 'STORAGE_ROLLBACK_FAILED' && result.partial, '回滚失败明确报告 partial')
  check(!('离线书店' in env.disk.rules_v1) && !('离线书店' in env.disk.disabled_rules_v1), '回滚失败测试确实留下规则丢失的部分写入')

  env = setup()
  env.failRead('rules_v1')
  result = env.manager.toggle('离线书店', false)
  check(!result.ok && result.code === 'STORAGE_READ_FAILED', '读取失败不被静默吞掉')

  function setupPage(initial = seed()) {
    const pageEnv = setup(initial)
    let definition
    global.Page = (options) => { definition = options }
    delete require.cache[pagePath]
    require(pagePath)
    const page = Object.assign({}, definition, { data: clone(definition.data) })
    page.setData = function (patch, cb) { Object.assign(this.data, patch); if (cb) cb() }
    pageEnv.page = page
    return pageEnv
  }

  env = setupPage()
  env.page.onLoad()
  env.page.onShow()
  check(!env.page.data.loading && !env.page.data.error && env.page.data.totalCount === 4, '页面加载启用和停用规则')
  check(env.page.data.enabledCount === 3 && env.page.data.disabledCount === 1, '页面汇总启停数量')
  env.page.onSearch({ detail: { value: '离线' } })
  check(env.page.data.visibleRules.length === 2, '页面按商户搜索')
  env.page.pickFilter({ currentTarget: { dataset: { filter: 'disabled' } } })
  check(env.page.data.visibleRules.length === 0, '页面筛选与搜索可组合')
  env.page.clearSearch()
  check(env.page.data.visibleRules.length === 1, '清空搜索后显示停用规则')

  env.page.toggleRule({ currentTarget: { dataset: { merchant: '停用测试店' } }, detail: { value: true } })
  check(env.page.data.enabledCount === 4 && env.page.data.disabledCount === 0, '页面启停后刷新汇总')
  check(env.calls.toasts.at(-1).title === '规则已启用', '页面启停成功反馈')
  env.fail('disabled_rules_v1')
  env.page.toggleRule({ currentTarget: { dataset: { merchant: '离线书店' } }, detail: { value: false } })
  check(env.page.data.actionBusy === false && !!env.page.data.actionError, '页面写入失败解除锁并显示错误')
  check(env.disk.rules_v1['离线书店'] === '购物', '页面失败不改变实际规则')

  env = setupPage()
  env.page.onLoad(); env.page.onShow()
  env.page.onPreviewMerchant({ detail: { value: '离线书店' } })
  env.page.onPreviewDesc({ detail: { value: '购买图书' } })
  check(env.page.data.previewResult.category === '购物', '页面实时预览商户与说明')
  env.page.pickPreviewType({ currentTarget: { dataset: { type: 'income' } } })
  check(env.page.data.previewResult.category !== '购物', '页面切换类型重新预览')

  env = setupPage()
  env.page.onLoad(); env.page.onShow()
  env.page.requestRemove({ currentTarget: { dataset: { merchant: '工资卡', count: 0 } } })
  check(env.calls.modals.at(-1).title === '删除分类规则', '删除前显示确认弹窗')
  env.calls.modals.at(-1).success({ confirm: true })
  check(!('工资卡' in env.disk.rules_v1) && env.page.data.totalCount === 3, '确认后删除规则并刷新页面')

  env = setupPage()
  env.page.onLoad(); env.page.onShow()
  env.page.requestClearDisabled()
  env.calls.modals.at(-1).success({ confirm: true })
  check(env.page.data.disabledCount === 0, '页面确认后清空停用规则')

  env = setupPage({ rules_v1: '坏数据', disabled_rules_v1: {}, txs_v1: [] })
  env.page.onLoad(); env.page.onShow()
  check(!env.page.data.loading && env.page.data.error.includes('规则数据读取失败'), '页面坏数据有明确错误状态')

  env = setupPage()
  env.page.onLoad(); env.page.onShow()
  env.setDark(true); env.themeChange('dark')
  check(env.page.data.dark, '页面跟随系统深色模式')
  env.page.onUnload()
  check(env.page._unloaded && !env.page._visible, '页面卸载清理可见状态')

  const wxml = fs.readFileSync(path.join(root, 'pages/rules/rules.wxml'), 'utf8')
  const wxss = fs.readFileSync(path.join(root, 'pages/rules/rules.wxss'), 'utf8')
  check(wxml.includes('bindchange="toggleRule"') && wxml.includes('bindinput="onSearch"'), '规则页绑定启停与搜索事件')
  check(wxss.includes('env(safe-area-inset-bottom)') && wxss.includes('.rules-page.dark'), '规则页支持安全区和深色模式')

  env = setup()
  env.store.learn('停用测试店', '交通')
  check(env.disk.rules_v1['停用测试店'] === '交通' && !(env.disk.disabled_rules_v1 && env.disk.disabled_rules_v1['停用测试店']), '手动改分类会重新启用停用规则且不产生冲突')

  env = setup()
  env.store.learnFromItems([{ byPlatform: 'platform', merchant: '停用测试店', category: '交通' }])
  check(!env.disk.rules_v1['停用测试店'] && env.disk.disabled_rules_v1['停用测试店'] === '娱乐', '导入自动学习尊重停用规则')

  env = setup()
  const ai = env.store.applyCategories({ '停用测试店': '交通' })
  check(ai.saved && ai.changed === 1 && ai.learned === 0 && !env.disk.rules_v1['停用测试店'], 'AI 可改流水但不擅自重新启用停用规则')

  env = setup()
  env.store.clearAll()
  check(!env.disk.disabled_rules_v1, '清空账本同时清掉停用规则')

  console.log('通过 ' + passed + ' 项，失败 0 项')
} catch (error) {
  console.error('失败：' + error.message)
  console.error(error.stack)
  process.exitCode = 1
}
