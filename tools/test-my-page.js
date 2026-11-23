/* 我的页与免费数据工具：node tools/test-my-page.js */
var assert = require('assert')
var path = require('path')
var fs = require('fs')
var passed = 0
function check(value, message) { assert.ok(value, message); passed++ }
function copy(value) { return JSON.parse(JSON.stringify(value)) }
var now = Date.now()
var disk = {
  account_v1: { nick: '小林', avatar: 'wxfile://usr/avatar.png' },
  txs_v1: [
    { id: 'b-mine', time: now, type: 'expense', amount: 12, category: '餐饮', merchant: '早餐店' },
    { id: 'b-peer', time: now - 1000, type: 'expense', amount: 20, category: '购物', merchant: '书店', byMe: false, shareBook: 'book' },
    { id: 'b-archived', time: now - 2000, type: 'income', amount: 30, category: '工资', merchant: '旧账本', byMe: false, shareBook: 'old' }
  ],
  budget_v1: 500,
  budcats_v1: { '餐饮': 200 },
  rules_v1: { '早餐店': '餐饮' },
  prefs_v1: { viewScope: 'mine' },
  shared_book_v1: { bookId: 'book', name: '家里的账本', members: 2, lastSync: now, memberList: [
    { nickname: '小林', ownerKey: 'me', isMe: true }, { nickname: '小周', ownerKey: 'peer' }
  ] }
}
var format = require('../utils/format')
disk.txs_v1.forEach(function (row) {
  row.day = format.dayOf(row.time)
  row.ym = row.day.slice(0, 7)
})
var app = { globalData: {} }
var nav = []
var modals = []
var toasts = []
var tabStyles = []
var systemTheme = 'dark'
var themeListener
var writes = []
var shares = []
var chooses = []
var reads = []
var io = {
  writeFile: function (options) { writes.push(options) },
  readFile: function (options) { reads.push(options) }
}
function shareFile(options) { shares.push(options) }
global.wx = {
  env: { USER_DATA_PATH: 'wxfile://usr' },
  getStorageSync: function (key) { return key in disk ? copy(disk[key]) : '' },
  setStorageSync: function (key, value) { disk[key] = copy(value) },
  removeStorageSync: function (key) { delete disk[key] },
  getFileSystemManager: function () { return io },
  shareFileMessage: shareFile,
  chooseMessageFile: function (options) { chooses.push(options) },
  openDocument: function () { throw new Error('JSON 不应调用 openDocument') },
  navigateTo: function (options) { nav.push(options.url) },
  switchTab: function (options) { nav.push(options.url) },
  navigateBack: function (options) { options.fail() },
  setTabBarStyle: function (options) { tabStyles.push(options) },
  getWindowInfo: function () { return { theme: systemTheme } },
  getAppBaseInfo: function () { return { theme: systemTheme } },
  getSystemInfoSync: function () { return { theme: systemTheme } },
  onThemeChange: function (listener) { themeListener = listener },
  showModal: function (options) { modals.push(options) },
  showToast: function (options) { toasts.push(options) }
}
global.getApp = function () { return app }
function page(name) {
  var definition
  global.Page = function (options) { definition = options }
  var file = path.resolve(__dirname, '../pages/' + name + '/' + name + '.js')
  delete require.cache[file]
  require(file)
  var instance = Object.assign({}, definition, { data: copy(definition.data) })
  instance.setData = function (patch, callback) {
    Object.keys(patch).forEach(function (key) { instance.data[key] = patch[key] })
    if (callback && name !== 'report') callback()
  }
  return instance
}
function last(list) { return list[list.length - 1] }
function choosePayload(payload) {
  last(chooses).success({ tempFiles: [{ path: 'memory.json' }] })
  last(reads).success({ data: JSON.stringify(payload) })
}
function themeEvent(key) { return { currentTarget: { dataset: { key: key } } } }
var store = require('../utils/store')
var tools = require('../utils/data-tools')
var vip = require('../utils/vip')
var shared = require('../utils/shared')
vip.guard = function () { throw new Error('备份恢复不能被会员限制') }
shared.info = shared.sync = function () { throw new Error('我的页不得查询云端或自动同步') }
var mine = page('index')
mine.onLoad()
mine.onShow()
check(mine.data.dark, '首次进入跟随深色系统')
check(tabStyles.length === 1, 'onShow 同步 Tab 主题')
check(mine.data.nick === '小林' && mine.data.initial === '小' && mine.data.loggedIn, '资料来自本机账户')
check(mine.data.avatar === disk.account_v1.avatar, '已选头像可显示')
mine.avatarError()
check(mine.data.avatar === '' && mine.data.initial === '小', '头像失效回退昵称首字')
check(mine.data.recordCount === 3, '记录数包含全部真实本机数据，不被只看自己过滤')
check(mine.data.joined && mine.data.bookName === '家里的账本' && mine.data.membersText === '2 位成员', '展示缓存账本和真实成员数')
check(mine.data.memberNames.indexOf('小周') >= 0 && mine.data.lastSyncText.indexOf(':') >= 0, '成员及同步时间可读')
check(!mine.data.scopeConfirmed && mine.data.shareScopeText === '尚未确认共享范围', '未确认共享范围不冒充已同意')
check(mine.data.viewScopeText === '只看自己', '展示真实查看口径')
check(mine.data.vipText === vip.statusText() && mine.data.vipAction === '开通或兑换', '未开通会员展示真实状态和兑换入口')
check(mine.data.backupText === '尚未生成', '没有备份元数据不伪造备份时间')
disk.shared_book_v1.shareSince = 0
disk.vip_member_v1 = { expireAt: Date.UTC(2201, 0, 1), openid: 'offline-id' }
mine.refresh()
check(mine.data.scopeConfirmed && mine.data.shareScopeText.indexOf('全部历史') >= 0, '明确共享全部历史的缓存才显示确认')
check(mine.data.vipText === '永久会员' && mine.data.vipAction === '查看权益', '永久会员保留真实权益状态')
;['green', 'ink', 'amber'].forEach(function (key) {
  mine.pickTheme(themeEvent(key))
  check(mine.data.themeKey === key && disk.theme_v1 === key, '主题落盘并刷新 ' + key)
})
check(mine.data.themes.length === 3, '仅提供三个真实主题')
themeListener({ theme: 'light' })
check(!mine.data.dark, '系统主题变化立即更新')
systemTheme = 'dark'
mine.onShow()
check(mine.data.dark, '重新显示也校准深色模式')
mine.toggleRefund({ detail: { value: false } })
check(!mine.data.refundOut && disk.prefs_v1.refundOut === false, '退款偏好真实保存')
mine.goProfile(); mine.goVip(); mine.goShare(); mine.goPrivacy(); mine.goFeedback(); mine.goDataTools()
assert.deepStrictEqual(nav, [
  '/pages/login/login?from=mine', '/pages/vip/vip', '/pages/share/share',
  '/pages/login/login?from=mine&privacy=1', '/pages/feedback/feedback', '/pages/report/report'
]); passed++
assert.deepStrictEqual(app.globalData, {
  reportSection: 'tools', backFor: '/pages/report/report', backTab: '/pages/index/index', backLabel: '我的'
}); passed++

var before = store.exportAll()
mine.backup()
check(tools.busy() && mine.data.busy && writes.length === 1, '写文件期间共享锁与我的页禁用态生效')
check(!tools.lastGenerated(), '写入尚未成功时不能登记生成时间')
var exported = JSON.parse(last(writes).data)
assert.deepStrictEqual(exported.txs, before.txs); passed++
assert.deepStrictEqual(exported.rules, before.rules); passed++
assert.deepStrictEqual(exported.catBudgets, before.catBudgets); passed++
check(exported.budget === 500 && exported.version === before.version && exported.app === before.app, '原样全量导出，包含预算且无会员门槛')
var navCount = nav.length
mine.pickTheme(themeEvent('green')); mine.goDataTools(); mine.goProfile(); mine.goVip(); mine.goShare(); mine.goPrivacy(); mine.goFeedback()
mine.toggleRefund({ detail: { value: true } }); mine.logout(); mine.backup(); mine.restore()
check(writes.length === 1 && chooses.length === 0 && nav.length === navCount, '忙碌时所有入口阻止重复操作与跳转')
check(disk.theme_v1 === 'amber' && !disk.prefs_v1.refundOut, '忙碌时不变更偏好')
check(tools.restore() === false, '模块级锁阻止另一页面重入')
last(writes).success()
check(tools.lastGenerated() > 0 && tools.busy(), '只有写成功才记录时间，等待分享时继续加锁')
last(shares).fail({ errMsg: 'shareFileMessage:fail cancel' })
check(!tools.busy() && !mine.data.busy, '取消分享后解除锁')
check(last(modals).title === '备份文件已生成' && last(modals).content.indexOf('已取消分享') >= 0, '取消分享只提示已生成，不谎称已存好')
check(last(modals).content.indexOf('小程序之外') >= 0 && mine.data.backupText !== '尚未生成', '展示真实生成时间并提醒外部保存')
var generated = tools.lastGenerated()
var completed = 0
tools.backup(function () { completed++ })
last(writes).fail()
check(completed === 1 && !tools.busy() && tools.lastGenerated() === generated, '写失败回调且保留原元数据')
check(last(toasts).title.indexOf('生成备份失败') === 0, '写失败有反馈')
delete wx.shareFileMessage
tools.backup(); last(writes).success()
check(!tools.busy() && last(modals).content.indexOf('不支持文件分享') >= 0, '旧微信无 JSON openDocument，生成说明与升级提醒')
wx.shareFileMessage = shareFile
tools.backup(); last(writes).success(); last(shares).success()
check(last(modals).title === '备份文件已生成' && last(modals).content.indexOf('确认可以找到') >= 0, '分享成功也不保证外部文件已安全保存')

mine.restore()
check(mine.data.busy && tools.busy(), '选择恢复文件时加锁')
last(chooses).fail({ errMsg: 'chooseMessageFile:fail cancel' })
check(!tools.busy() && !mine.data.busy, '取消选择释放锁')
tools.restore(); last(chooses).success({ tempFiles: [] })
check(!tools.busy(), '没有返回文件也释放锁')
tools.restore(); last(chooses).fail({ errMsg: 'chooseMessageFile:fail permission denied' })
check(!tools.busy() && last(toasts).title.indexOf('未能选择文件') === 0, '非取消的选文件失败有反馈')
tools.restore(); last(chooses).success({ tempFiles: [{ path: 'bad.json' }] }); last(reads).fail()
check(!tools.busy() && last(toasts).title === '读不到这个文件', '读失败有反馈且解锁')
tools.restore(); last(chooses).success({ tempFiles: [{ path: 'bad.json' }] }); last(reads).success({ data: '{broken' })
check(!tools.busy() && last(toasts).title === '文件不是有效备份', '非法 JSON 不写账本')
tools.restore(); choosePayload(null)
check(!tools.busy() && last(toasts).title === '备份里没有流水', '空负载保留已有反馈')
var payload = { version: 1, txs: [{ id: 'b-restored', time: now - 900000, type: 'expense', amount: 7, category: '餐饮', merchant: '恢复测试' }] }
tools.restore(); choosePayload(payload)
check(tools.busy() && store.all().length === 3 && last(modals).title === '恢复备份？', '恢复必须先确认，不重置旧数据')
last(modals).success({ confirm: false })
check(!tools.busy() && store.all().length === 3, '取消确认不写入')
var report = page('report')
report.data.ym = format.ymOf(now)
;[
  { scope: 'mine', expense: '12.00', count: 1 },
  { scope: 'peer', expense: '20.00', count: 1 },
  { scope: 'both', expense: '32.00', count: 2 }
].forEach(function (item) {
  disk.prefs_v1.viewScope = item.scope
  report.refresh()
  check(report.data.s.expenseText === item.expense && report.data.s.count === item.count, '报表真实统计继续尊重口径 ' + item.scope)
  check(report.scopeTxs().every(function (row) { return row.shareBook !== 'old' }), '报表不会混入旧共同账本 ' + item.scope)
})
mine.refresh()
check(mine.data.recordCount === 3 && mine.data.viewScopeText === '看双方', '我的页显示全量记录数，不冒充范围统计')
disk.prefs_v1.viewScope = 'mine'
var refreshed = 0
report.refresh = function () { refreshed++ }
report.restore(); choosePayload(payload); last(modals).success({ confirm: true })
check(refreshed === 1 && last(modals).title === '恢复完成' && store.all().length === 4, '报表包装器免费恢复，并在成功后刷新')
check(mine.data.recordCount === 4 && !mine.data.busy, '另一 Tab 完成恢复时我的页数据和禁用态也更新')
report.restore(); choosePayload(payload); last(modals).success({ confirm: true })
check(store.all().length === 4 && last(modals).content.indexOf('重复跳过 1 笔') >= 0, '重复恢复不重复记账')
var importAll = store.importAll
;[null, { saved: false }, { saved: true, partial: true }].forEach(function (out) {
  store.importAll = function () { return out }
  var count = refreshed
  report.restore(); choosePayload(payload); last(modals).success({ confirm: true })
  check(refreshed === count + 1 && !tools.busy() && last(modals).title === '恢复失败', '保存失败或部分写入也刷新，并维持恢复失败标题')
  if (out && out.partial) check(last(modals).content.indexOf('回滚未完成') >= 0, '部分写入明确提示核对账本')
})
store.importAll = function () { throw new Error('storage failure') }
var refreshBefore = refreshed
report.restore(); choosePayload(payload); last(modals).success({ confirm: true })
check(refreshed === refreshBefore + 1 && !tools.busy() && last(modals).title === '恢复失败', '导入异常仍刷新并解锁')
store.importAll = importAll
report.restore(); choosePayload({ version: 99, txs: payload.txs }); last(modals).success({ confirm: true })
check(last(modals).title === '恢复失败' && last(modals).content.indexOf('格式不对') >= 0 && store.all().length === 4, '错误版本安全拒绝')
refreshBefore = refreshed
report.backup(); last(writes).fail()
check(refreshed === refreshBefore + 1 && !tools.busy(), '报表备份失败也回调刷新')
var originalFS = wx.getFileSystemManager
wx.getFileSystemManager = function () { throw new Error('unavailable') }
tools.backup()
check(!tools.busy() && last(toasts).title.indexOf('生成备份失败') === 0, '文件系统抛异常解锁并报错')
wx.getFileSystemManager = originalFS
var chooseFile = wx.chooseMessageFile
delete wx.chooseMessageFile
tools.restore()
check(!tools.busy() && last(toasts).title.indexOf('当前无法选择') === 0, '不支持选择文件时不锁死')
wx.chooseMessageFile = chooseFile

var preserved = copy(disk)
mine.logout()
check(last(modals).content.indexOf('不会结束会员权益') >= 0 && last(modals).content.indexOf('不会退出共同账本') >= 0, '退出文案明确不删账不退会员')
last(modals).success({ confirm: false })
check(!!disk.account_v1, '取消退出不改账户')
mine.logout(); last(modals).success({ confirm: true })
check(!disk.account_v1 && !!disk.account_skip_v1 && !mine.data.loggedIn, '退出只清本机资料并记住跳过登录')
;['txs_v1', 'budget_v1', 'budcats_v1', 'rules_v1', 'vip_member_v1', 'shared_book_v1'].forEach(function (key) {
  assert.deepStrictEqual(disk[key], preserved[key]); passed++
})
check(mine.data.initial === '我', '未登录有非表情的文字头像')
var login = page('login')
login.onLoad({ from: 'mine', privacy: '1' })
check(login.data.showPrivacy && login.data.from === 'mine', '隐私路由直接展开说明')
login.goAfterLogin()
check(last(nav) === '/pages/index/index', '从我的登录完成返回我的')
login.skipLogin()
check(last(nav) === '/pages/index/index' && !!disk.account_skip_v1, '从我的跳过也返回我的')
login.onLoad({ from: 'vip' }); login.goAfterLogin()
check(!login.data.showPrivacy && last(nav) === '/pages/home/home', '会员来源原有返回失败回首页逻辑不变')
login.onLoad({}); login.skipLogin()
check(last(nav) === '/pages/home/home', '普通来源跳过仍到首页')
var json = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../pages/index/index.json'), 'utf8'))
check(json.navigationBarTitleText === '我的' && !json.navigationStyle, '我的使用原生导航标题')
var wxml = fs.readFileSync(path.resolve(__dirname, '../pages/index/index.wxml'), 'utf8')
check(wxml.indexOf('最近生成备份') >= 0 && wxml.indexOf("? '已选' : '选择'") >= 0, '备份标签与主题选中状态文案准确')
check(wxml.indexOf('ui-icon icon-book') >= 0 && wxml.indexOf('disabled="{{busy}}"') >= 0, '使用共享图标并原生禁用交互')
mine.onUnload()
console.log('通过 ' + passed + ' 项，失败 0 项')
