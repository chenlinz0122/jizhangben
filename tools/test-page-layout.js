const assert = require('assert')
const fs = require('fs')
const path = require('path')
const root = path.resolve(__dirname, '..')
const disk = {}
const calls = { nav: [], tabs: [], styles: [], icons: [], scrolls: [], modals: [] }
let dark = false
let watcher
const app = { globalData: {} }
const clone = (v) => JSON.parse(JSON.stringify(v))
global.wx = {
  getStorageSync: (k) => k in disk ? clone(disk[k]) : '',
  setStorageSync: (k, v) => { disk[k] = clone(v) },
  removeStorageSync: (k) => { delete disk[k] },
  getAppBaseInfo: () => ({ theme: dark ? 'dark' : 'light' }),
  getWindowInfo: () => ({ windowWidth: 375 }),
  onThemeChange: (fn) => { watcher = fn }, offThemeChange: (fn) => { if (watcher === fn) watcher = null },
  navigateTo: (o) => calls.nav.push(o.url), switchTab: (o) => calls.tabs.push(o.url),
  setTabBarStyle: (o) => calls.styles.push(o), setTabBarItem: (o) => calls.icons.push(o),
  pageScrollTo: (o) => calls.scrolls.push(o), showToast() {},
  showModal: (o) => calls.modals.push(o)
}
global.getApp = () => app
const format = require('../utils/format')
const store = require('../utils/store')
const theme = require('../utils/theme')
const darkmode = require('../utils/darkmode')
const vip = require('../utils/vip')
let paid = false
vip.isVip = () => paid
vip.refresh = (cb) => { if (cb) cb() }
vip.guard = (name) => { if (!paid) calls.nav.push('/pages/vip/vip'); return paid }
const now = format.ymOf(Date.now())
const previous = format.shiftMonth(now, -1)
function tx(id, month, amount) {
  const [y, m] = month.split('-').map(Number)
  const time = new Date(y, m - 1, 1, 12).getTime()
  return { id, time, day: format.dayOf(time), ym: month, type: 'expense', amount, category: '餐饮', merchant: '测试饭店' }
}
disk.txs_v1 = [tx('now', now, 120), tx('previous', previous, 60)]
disk.budget_v1 = 100
function page(name) {
  let p
  global.Page = (v) => { p = v }
  require(path.join(root, 'pages', name, name + '.js'))
  p = Object.assign({}, p, { data: clone(p.data) })
  p.setData = function (patch, cb) { Object.assign(this.data, patch); if (cb) cb() }
  if (name === 'report') { p.drawPie = () => {} }
  return p
}
let passed = 0
function check(value, name) { assert.ok(value, name); passed++ }
const config = JSON.parse(fs.readFileSync(path.join(root, 'app.json')))
check(config.tabBar.list.map((t) => t.text).join(',') === '首页,流水,报表,我的', '四个Tab职责和顺序正确')
check(config.tabBar.list[3].pagePath === 'pages/index/index', '原总览复用为我的，无重复入口')
for (const pagePath of ['pages/accounts/accounts', 'pages/recurring/recurring', 'pages/rules/rules', 'pages/health/health', 'pages/settlement/settlement', 'pages/attachments/attachments', 'pages/insights/insights', 'pages/annual/annual', 'pages/budget-templates/budget-templates', 'pages/budget-variance/budget-variance', 'pages/budget-history/budget-history', 'pages/rate-alerts/rate-alerts']) {
  check(config.pages.includes(pagePath), pagePath + ' 已注册到小程序')
  check(fs.existsSync(path.join(root, pagePath + '.js')) && fs.existsSync(path.join(root, pagePath + '.wxml')) && fs.existsSync(path.join(root, pagePath + '.wxss')), pagePath + ' 三个页面文件齐全')
}
const mineWxml = fs.readFileSync(path.join(root, 'pages/index/index.wxml'), 'utf8')
const mineSource = fs.readFileSync(path.join(root, 'pages/index/index.js'), 'utf8')
check(['accounts', 'recurring', 'rules', 'health', 'settlement', 'insights', 'annual', 'budget-templates', 'budget-variance', 'budget-history', 'rate-alerts'].every((name) => mineWxml.includes('/pages/' + name + '/' + name) || mineSource.includes('/pages/' + name + '/' + name)), '我的页提供新功能入口')
const homeWxml = fs.readFileSync(path.join(root, 'pages/home/home.wxml'), 'utf8')
check(['accounts', 'recurring', 'rules', 'health'].every((name) => homeWxml.includes('/pages/' + name + '/' + name)), '首页提供常用新功能入口')
check(homeWxml.includes('账户净资产') && homeWxml.includes('netWorthText'), '首页展示账户净资产摘要')
check(homeWxml.includes('/pages/insights/insights') && homeWxml.includes('reminderCount'), '首页提供健康报告与周期提醒入口')
check(homeWxml.includes('/pages/annual/annual'), '首页提供年度财务报告入口')
const listWxml = fs.readFileSync(path.join(root, 'pages/list/list.wxml'), 'utf8')
check(listWxml.includes('bindtap="openAttachments"') && listWxml.includes('attachmentCount'), '流水详情提供票据管理入口')
const reportWxml = fs.readFileSync(path.join(root, 'pages/report/report.wxml'), 'utf8')
check(reportWxml.includes('bindtap="goAnnual"') && reportWxml.includes('bindtap="goBudgetTemplates"'), '报表提供年度报告与预算模板入口')
check(reportWxml.includes('bindtap="goBudgetVariance"'), '报表提供预算偏差分析入口')
check(reportWxml.includes('bindtap="goBudgetHistory"'), '报表提供历史预算存档入口')
const appTheme = JSON.parse(fs.readFileSync(path.join(root, config.themeLocation)))
check(config.darkmode && appTheme.dark.navText === 'white', '原生导航声明深色主题')
for (const item of config.tabBar.list) {
  for (const asset of [item.iconPath, item.selectedIconPath]) {
    const png = fs.readFileSync(path.join(root, asset))
    check(png.readUInt32BE(16) === 72 && png.readUInt32BE(20) === 72 && png.length < 40000, '本地Tab图标尺寸与体积合规')
  }
}
const home = page('home')
home.onLoad(); home.syncData()
check(home.data.s.expenseText === '120.00' && home.data.ym === now, '首页汇总当月')
check(calls.nav.length === 0, '未登录不再强制弹登录阻碍记账')
check(home.data.budget === 0, '免费用户不泄露会员预算进度')
home.goBudget(); check(calls.nav.pop() === '/pages/vip/vip', '免费预算入口保留会员门槛')
paid = true; home.syncData()
check(home.data.budgetPct === 100 && home.data.budgetOver && home.data.budgetLeftText === '20.00', '会员超预算进度有上限并显示超出金额')
home.pickMonth({ detail: { value: previous } })
check(home.data.s.expenseText === '60.00' && !home.data.isCurrent && home.data.budgetSpentText === '60.00', '历史月收支与预算一致')
home.pickMonth({ detail: { value: '9999-13' } }); check(home.data.ym === previous, '非法月份不能写入页面状态')
home.nextMonth(); check(home.data.ym === now, '下月返回当前月')
home.nextMonth(); check(home.data.ym === now, '禁止越过当前月份')
home.prevMonth(); home.goUncat()
check(app.globalData.filterYm === previous && app.globalData.filterUncat, '待分类入口保留所选月份')
home.goCategory({ currentTarget: { dataset: { name: '餐饮' } } })
check(app.globalData.filterCat === '餐饮' && app.globalData.filterKind === 'expense' && !app.globalData.filterUncat, '分类跳转清除旧条件')
home.goReport()
check(app.globalData.reportYm === previous && calls.tabs.at(-1) === '/pages/report/report', '报告入口携带选择月份')
home.goMine(); check(calls.tabs.at(-1) === '/pages/index/index', '个人头像进入我的Tab')
const list = page('list'); list.onLoad()
home.openRecent({ currentTarget: { dataset: { id: 'previous' } } })
list.onShow()
check(list.data.sheetVisible && list.data.sheetItem.id === 'previous' && !app.globalData.openTxId, '首页最近流水直接打开对应详情')
check(list.data.ym === previous, '详情跳转继续保留月份')
list.pickMonth({ detail: { value: now } }); check(list.data.ym === now, '流水页支持直接选月')
const report = page('report'); report.onLoad()
app.globalData = { reportYm: previous, reportSection: 'tools', backFor: '/pages/report/report', backTab: '/pages/index/index', backLabel: '我的' }
report.onShow()
check(report.data.ym === previous && report.data.backLabel === '我的' && calls.scrolls.at(-1).selector === '#data-tools', '我的数据工具能直达报告工具区')
check(!app.globalData.reportYm && !app.globalData.reportSection, '跨页指令消费后清除')
app.globalData.reportSection = 'budget'; report.onShow()
check(calls.scrolls.at(-1).selector === '#budget-card', '预算入口直达会员预算区')
dark = true
check(darkmode.isDark(), '深色读取getAppBaseInfo而非不含theme的getWindowInfo')
theme.set('ink')
check(calls.styles.at(-1).backgroundColor === '#1b2421' && calls.styles.at(-1).borderStyle === 'black', '原生Tab底色与深色同步')
check(calls.icons.slice(-4).every((v) => v.selectedIconPath.endsWith('-dark.png')), '深色使用高对比导航图标')
dark = false; theme.set('amber')
check(calls.icons.slice(-4).every((v) => v.selectedIconPath.endsWith('-amber.png')), '换色时导航图标同步')
check(calls.styles.at(-1).selectedColor === '#b96a2b', '换色时导航文字同步')
const wxml = fs.readFileSync(path.join(root, 'pages/list/list.wxml'), 'utf8')
check(wxml.lastIndexOf('</view>') > wxml.indexOf('class="sheet '), '详情弹层仍在主题根下')
check(!fs.readFileSync(path.join(root, 'pages/home/home.wxml'), 'utf8').includes('开通会员'), '首页不再重复展示会员推广')
const addWxml = fs.readFileSync(path.join(root, 'pages/add/add.wxml'), 'utf8')
check(addWxml.includes("saveState === 'saving'") && addWxml.includes("saveState === 'saved'"), '手记保存按钮有处理中和已保存状态')
const catWxml = fs.readFileSync(path.join(root, 'pages/cat/cat.wxml'), 'utf8')
check(catWxml.includes('catchmovement="noop"'), '分类详情遮罩阻止触摸事件穿透')
const catWxss = fs.readFileSync(path.join(root, 'pages/cat/cat.wxss'), 'utf8')
check(/\.sheet\.up\s*\{[^}]*max-height:\s*88vh[^}]*overflow-y:\s*auto/.test(catWxss), '分类详情长内容可限制高度并滚动')
check(catWxss.includes('.dark .mlabel, .dark .im, .dark .shm, .dark .shv'), '分类详情深色正文有高对比颜色')
const reportWxss = fs.readFileSync(path.join(root, 'pages/report/report.wxss'), 'utf8')
check(reportWxss.includes('.dark .iv, .dark .yn'), '报表洞察与年度金额深色可读')
const shotWxml = fs.readFileSync(path.join(root, 'pages/shot/shot.wxml'), 'utf8')
check(shotWxml.includes('wx:for="{{preview.fails}}"') && !shotWxml.includes('preview.fails[0]'), '多图识别展示全部失败图片而不只展示第一张')
const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8')
check(gitignore.includes('cloudfunctions/*/secret.js'), '所有云函数本地密钥文件均被 Git 忽略')
const projectConfig = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'))
const packIgnore = projectConfig.packOptions.ignore.map((item) => item.value)
check(packIgnore.includes('cloudfunctions/book/node_modules') && packIgnore.includes('本地密钥.txt') && packIgnore.includes('cloudfunctions/aiCat/secret.js'), '小程序打包排除依赖和本地密钥')
const aiCatSource = fs.readFileSync(path.join(root, 'cloudfunctions/aiCat/index.js'), 'utf8')
check(!aiCatSource.includes("require('./secret')") && aiCatSource.includes('process.env.ZHIPU_API_KEY'), 'AI 密钥只从环境变量读取')
for (const name of ['share', 'promo']) {
  const source = fs.readFileSync(path.join(root, 'pages', name, name + '.js'), 'utf8')
  check(source.includes('this._unwatchDark = darkmode.watch') && /onUnload:\s*function\s*\(\)\s*\{[\s\S]*?this\._unwatchDark\(\)/.test(source), name + '页面卸载时取消主题监听')
}
const loginSource = fs.readFileSync(path.join(root, 'pages/login/login.js'), 'utf8')
check(loginSource.includes('this._unloaded = true') && loginSource.includes('clearTimeout(this._loginTimer)'), '登录页卸载清理任务并阻止过期跳转')
console.log('通过 ' + passed + ' 项，失败 0 项')
