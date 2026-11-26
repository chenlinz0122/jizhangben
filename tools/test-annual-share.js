// node tools/test-annual-share.js
var assert = require('assert')
var fs = require('fs')
var path = require('path')
var annualShare = require('../utils/annual-share')
var annualReport = require('../utils/annual-report')

var passed = 0
function check(value, message) { assert.ok(value, message); passed++ }
function clone(value) { return JSON.parse(JSON.stringify(value)) }
function last(list) { return list[list.length - 1] }

function FakeContext() {
  this.size = 22
  this.align = 'left'
  this.texts = []
  this.rects = []
}
FakeContext.prototype.setFontSize = function (size) { this.size = Number(size) || 22 }
FakeContext.prototype.setFont = function (font) {
  var match = /(\d+(?:\.\d+)?)px/.exec(String(font))
  if (match) this.size = Number(match[1])
}
FakeContext.prototype.setTextAlign = function (align) { this.align = align || 'left' }
FakeContext.prototype.setTextBaseline = function () {}
FakeContext.prototype.setFillStyle = function (color) { this.fillStyle = color }
FakeContext.prototype.setStrokeStyle = function (color) { this.strokeStyle = color }
FakeContext.prototype.setLineWidth = function (width) { this.lineWidth = width }
function fakeWidth(value, size) {
  var units = 0
  Array.from(String(value)).forEach(function (char) { units += char.charCodeAt(0) > 255 ? 1 : (/\s/.test(char) ? 0.35 : 0.62) })
  return units * size
}
FakeContext.prototype.measureText = function (value) {
  return { width: fakeWidth(value, this.size) }
}
FakeContext.prototype.fillText = function (value, x, y) {
  this.texts.push({ text: String(value), x: x, y: y, width: fakeWidth(value, this.size), size: this.size, align: this.align, color: this.fillStyle })
}
FakeContext.prototype.fillRect = function (x, y, width, height) { this.rects.push({ x: x, y: y, width: width, height: height, color: this.fillStyle }) }
FakeContext.prototype.beginPath = function () {}
FakeContext.prototype.moveTo = function () {}
FakeContext.prototype.lineTo = function () {}
FakeContext.prototype.arc = function () {}
FakeContext.prototype.closePath = function () {}
FakeContext.prototype.fill = function () {}
FakeContext.prototype.stroke = function () {}

function tx(id, ym, amount, extra) {
  var row = { id: id, ym: ym, day: ym + '-15', time: new Date(ym + '-15T12:00:00').getTime(), type: 'expense', amount: amount, category: '餐饮', merchant: '测试商户' }
  Object.keys(extra || {}).forEach(function (key) { row[key] = extra[key] })
  return row
}

function renderFixture(result, options) {
  var ctx = new FakeContext()
  var layout = annualShare.render(ctx, result, options)
  return { ctx: ctx, layout: layout }
}

try {
  var result = annualReport.calculate([
    tx('income', '2026-01', 10000, { type: 'income', category: '工资' }),
    tx('food', '2026-02', 1000, { category: '餐饮' }),
    tx('refund', '2026-02', 200, { type: 'refund', category: '退款' }),
    tx('transport', '2026-03', 400, { category: '交通' }),
    tx('education', '2026-04', 200, { category: '教育' }),
    tx('long-category', '2026-05', 500, { category: '超长分类名称超长分类名称超长分类名称超长分类名称超长分类名称超长分类名称' })
  ], { year: 2026, now: new Date(2026, 10, 24, 12), scopeText: '本机全部流水' })
  var snapshot = JSON.stringify(result)
  var fixture = renderFixture(result, { generatedAt: new Date(2026, 10, 24, 12) })
  check(fixture.layout.width === 750 && fixture.layout.height === 1000, '分享卡固定为 750x1000')
  check(fixture.ctx.rects[0].color === '#f3f0e8', '分享卡使用固定高对比浅色风格')
  ;['2026 年度财务报告', '本机全部流水', '全年收支结余', '¥8,100.00', '收入', '¥10,000.00', '净支出', '¥1,900.00', '退款', '¥200.00', '年度储蓄率', '81.0%', 'TOP 3 支出分类', '年度健康概览', '生成于 2026.11.24'].forEach(function (part) {
    check(fixture.layout.texts.indexOf(part) >= 0, '绘制必需内容 ' + part)
  })
  check(fixture.layout.texts.some(function (value) { return value.indexOf('…') >= 0 && value.indexOf('超长分类') >= 0 }), '超长分类名安全截断')
  check(fixture.layout.texts.indexOf('教育') === -1, 'TOP 最多三名且不绘制第四名')
  check(fixture.layout.texts.filter(function (value) { return /^[123]$/.test(value) }).length === 3, '只绘制 TOP3 排名')
  check(JSON.stringify(result) === snapshot, '绘制不修改 annualReport 结果')
  check(fixture.ctx.texts.every(function (item) {
    var left = item.align === 'right' ? item.x - item.width : (item.align === 'center' ? item.x - item.width / 2 : item.x)
    return left >= -0.01 && left + item.width <= 750.01 && item.y >= 0 && item.y <= 1000
  }), '全部文字位于画布内')
  check(fixture.ctx.texts.every(function (item) { return !/[\r\n\t]/.test(item.text) }), '绘制文本不含换行和控制符')
  check(fixture.ctx.texts.every(function (item, index) {
    return fixture.ctx.texts.slice(index + 1).every(function (other) {
      var verticalOverlap = item.y - item.size * 0.8 < other.y + other.size * 0.2 && other.y - other.size * 0.8 < item.y + other.size * 0.2
      var left = item.align === 'right' ? item.x - item.width : (item.align === 'center' ? item.x - item.width / 2 : item.x)
      var otherLeft = other.align === 'right' ? other.x - other.width : (other.align === 'center' ? other.x - other.width / 2 : other.x)
      var horizontalOverlap = left < otherLeft + other.width && otherLeft < left + item.width
      return !(verticalOverlap && horizontalOverlap)
    })
  }), '同排文字不会互相重叠')

  var themePalettes = {}
  ;['paper', 'forest', 'night'].forEach(function (theme) {
    var themed = renderFixture(result, { theme: theme, generatedAt: 'invalid' })
    themePalettes[theme] = themed.ctx
    check(themed.ctx.rects[0].color === annualShare.THEMES[theme].background, theme + ' 主题背景生效')
    check(themed.ctx.texts.some(function (item) { return item.color === annualShare.THEMES[theme].ink }), theme + ' 主题文字色生效')
    check(themed.ctx.texts.some(function (item) { return item.color === annualShare.THEMES[theme].brand }), theme + ' 主题强调色生效')
    check(themed.layout.texts.indexOf('生成于 ' + annualShare.formatDate('invalid')) >= 0, theme + ' 主题非法日期安全回退')
  })
  check(themePalettes.paper.rects[0].color !== themePalettes.forest.rects[0].color && themePalettes.forest.rects[0].color !== themePalettes.night.rects[0].color, '三套主题背景互不相同')
  check(themePalettes.paper.texts[1].color !== themePalettes.night.texts[1].color, '深色主题使用不同文字颜色')

  var custom = renderFixture(result, {
    theme: 'night', title: '我的 2026 账本', subtitle: '只给家人看', accentColor: '#FF6600',
    showTopCategories: false, showHealth: false, showGeneratedAt: false,
    generatedAt: new Date(2026, 10, 24)
  })
  check(custom.layout.texts.indexOf('我的 2026 账本') >= 0 && custom.layout.texts.indexOf('只给家人看') >= 0, '自定义标题与副标题生效')
  check(custom.layout.texts.indexOf('TOP 3 支出分类') === -1 && custom.layout.texts.indexOf('餐饮') === -1, '关闭支出分类后不绘制分类模块')
  check(custom.layout.texts.indexOf('年度健康概览') === -1 && custom.layout.texts.indexOf('有收入月均储蓄率') === -1, '关闭健康模块后不绘制健康内容')
  check(!custom.layout.texts.some(function (value) { return /^生成于 /.test(value) }), '关闭生成日期后不绘制日期')
  check(custom.ctx.texts.some(function (item) { return item.color === '#ff6600' }), '合法十六进制自定义强调色生效')
  check(custom.layout.texts.indexOf('全年收支结余') >= 0 && custom.layout.texts.indexOf('¥8,100.00') >= 0, '隐藏可选模块仍保留收支核心数据')

  ;['red', '#12', '#1234', '#12345678', '#gggggg', 123456, {}, null].forEach(function (color) {
    var invalid = renderFixture(result, { theme: 'forest', accentColor: color })
    check(invalid.ctx.texts.some(function (item) { return item.color === annualShare.THEMES.forest.brand }), '非法强调色回退主题色 ' + String(color))
  })
  check(renderFixture(result, { theme: 'unknown', accentColor: '#0f0' }).ctx.rects[0].color === annualShare.THEMES.paper.background, '非法主题回退 paper')
  check(renderFixture(result, { accentColor: '#AbC' }).ctx.texts.some(function (item) { return item.color === '#abc' }), '合法三位十六进制颜色归一化')
  check(renderFixture(null, { title: '空账本', showTopCategories: false, showHealth: false, showGeneratedAt: false }).layout.texts.indexOf('空账本') >= 0, '缺失数据与自定义模板组合仍安全')

  var defaults = annualShare.defaultOptions()
  check(defaults.theme === 'paper' && defaults.title === new Date().getFullYear() + ' 年度财务报告' && defaults.showTopCategories && defaults.showHealth && defaults.showGeneratedAt, '默认模板兼容旧版')
  check(annualShare.normalizeOptions({ showTopCategories: 'false', showHealth: 0, showGeneratedAt: null }).showTopCategories === false && annualShare.normalizeOptions({ showHealth: 0 }).showHealth === false, '非布尔开关安全按 false 处理')

  var empty = annualReport.calculate([], { year: 2026 })
  var emptyFixture = renderFixture(empty, { generatedAt: new Date(2026, 10, 24) })
  check(annualShare.isEmpty(empty) && annualShare.isEmpty(null), '空报告可被页面识别')
  check(emptyFixture.layout.texts.indexOf('全年收支结余 · 暂无流水') >= 0 && emptyFixture.layout.texts.indexOf('暂无支出分类') >= 0, '空数据绘制明确占位而不崩溃')
  check(emptyFixture.layout.texts.indexOf('--') >= 0, '空数据储蓄率显示 --')
  var missingFixture = renderFixture(null)
  check(missingFixture.layout.texts.indexOf('¥0.00') >= 0, '缺失 result 也安全降级')

  var moneyCases = [[0, '¥0.00'], [1, '¥0.01'], [-1, '¥-0.01'], [123456789, '¥1,234,567.89'], [9007199254740991, '¥90,071,992,547,409.91'], [-9007199254740991, '¥-90,071,992,547,409.91'], [1e30, '¥90,071,992,547,409.91'], [Infinity, '¥0.00'], [NaN, '¥0.00'], [true, '¥0.00']]
  moneyCases.forEach(function (item) { check(annualShare.formatMoney(item[0]) === item[1], '整数分格式化 ' + item[0]) })
  check(annualShare.formatRate(null) === '--' && annualShare.formatRate(0) === '0.0%' && annualShare.formatRate(10000) === '>=10000%' && annualShare.formatRate(-10000) === '->=10000%', '储蓄率边界安全')
  var extreme = renderFixture({ hasData: true, year: 2026, totals: { balanceCents: -9007199254740991, incomeCents: 9007199254740991, netExpenseCents: -9007199254740991, refundCents: 1e30, savingsRate: -1e30 }, health: {}, topCategories: [] })
  check(extreme.layout.texts.indexOf('¥-90,071,992,547,409.91') >= 0 && extreme.layout.texts.indexOf('->=10000%') >= 0, '极端金额和储蓄率完整安全绘制')
  check(extreme.ctx.texts.every(function (item) { return !/Infinity|NaN/.test(item.text) }), '非法数值不会进入画布')
  check(extreme.ctx.texts.every(function (item) {
    var left = item.align === 'right' ? item.x - item.width : item.x
    return left >= -0.01 && left + item.width <= 750.01
  }), '极端金额自动缩放且不溢出')
  var fallbackCtx = new FakeContext()
  fallbackCtx.measureText = undefined
  annualShare.render(fallbackCtx, { hasData: true, year: 2026, scopeText: 'x'.repeat(200), totals: {}, health: {}, topCategories: [{ name: 'y'.repeat(200), expenseCents: 1 }] })
  check(fallbackCtx.texts.some(function (item) { return /…$/.test(item.text) }), '旧画布缺少 measureText 时仍可估算并截断')

  var wrapCtx = new FakeContext()
  wrapCtx.setFontSize(20)
  var wrapped = annualShare.wrapText(wrapCtx, '一二三四五六七八九十一二三四五六七八九十', 42, 2)
  check(wrapped.length === 2 && wrapped.every(function (lineValue) { return wrapCtx.measureText(lineValue).width <= 42 }), '换行不超过限定宽度和行数')
  check(/…$/.test(annualShare.truncateText(wrapCtx, 'abcdefghijklmnopqrstuvwxyz', 70)), '截断带省略号')
  check(annualShare.formatDate(new Date(2026, 0, 2)) === '2026.01.02', '生成日期补零')

  var prefDisk = {}
  var prefStorage = {
    getStorageSync: function (key) { return key === annualShare.PREFS_STORAGE_KEY ? prefDisk[key] : '' },
    setStorageSync: function (key, value) { prefDisk[key] = clone(value) }
  }
  check(annualShare.PREFS_STORAGE_KEY === 'annual_share_prefs_v1', '使用约定的偏好存储键')
  check(annualShare.loadPreferences(prefStorage).theme === 'paper', '无旧偏好时回退默认')
  var savedPrefs = annualShare.savePreferences({ theme: 'forest', title: '家庭年报', subtitle: '本机账本', showTopCategories: false, showHealth: true, showGeneratedAt: false, accentColor: '#123ABC' }, prefStorage)
  check(savedPrefs.saved && prefDisk.annual_share_prefs_v1.theme === 'forest', '模板偏好写入本机存储')
  var loadedPrefs = annualShare.loadPreferences(prefStorage)
  check(loadedPrefs.theme === 'forest' && loadedPrefs.title === '家庭年报' && loadedPrefs.subtitle === '本机账本' && loadedPrefs.showTopCategories === false && loadedPrefs.showHealth === true && loadedPrefs.showGeneratedAt === false && loadedPrefs.accentColor === '#123abc', '重新加载还原主题、文本、开关与颜色')
  prefDisk.annual_share_prefs_v1 = '{broken json'
  check(annualShare.loadPreferences(prefStorage).theme === 'paper' && annualShare.loadPreferences(prefStorage).showHealth, '损坏偏好回退默认')
  prefDisk.annual_share_prefs_v1 = { theme: 'night', title: 42, subtitle: null, showHealth: 'false', accentColor: 'javascript:bad' }
  var repairedPrefs = annualShare.loadPreferences(prefStorage)
  check(repairedPrefs.theme === 'night' && repairedPrefs.title === '' && repairedPrefs.subtitle === '' && repairedPrefs.showHealth === false && repairedPrefs.accentColor === '', '旧偏好字段非法时逐项安全降级')
  check(annualShare.loadPreferences({ getStorageSync: function () { throw new Error('storage failure') } }).theme === 'paper', '读取存储异常回退默认')
  check(!annualShare.savePreferences(defaultSharePrefsForTest(), { setStorageSync: function () { throw new Error('storage failure') } }).saved, '写入存储异常不抛出')
  function defaultSharePrefsForTest() { return { theme: 'paper', title: '', subtitle: '', showTopCategories: true, showHealth: true, showGeneratedAt: true, accentColor: '' } }

  var disk = {}
  var contexts = []
  var draws = []
  var exports = []
  var saves = []
  var shares = []
  var previews = []
  var toasts = []
  var modals = []
  var settings = []
  var pageFile = path.resolve(__dirname, '../pages/annual/annual.js')
  function setup(rows, prefs) {
    disk = { txs_v1: rows === undefined ? [
      tx('income', '2026-01', 10000, { type: 'income', category: '工资' }),
      tx('food', '2026-02', 1234, { category: '餐饮' }),
      tx('refund', '2026-02', 200, { type: 'refund', category: '退款' }),
      tx('old', '2025-12', 999, { category: '交通' })
    ] : rows }
    if (prefs !== undefined) disk.annual_share_prefs_v1 = prefs
    contexts = []; draws = []; exports = []; saves = []; shares = []; previews = []; toasts = []; modals = []; settings = []
    global.getApp = function () { return { globalData: {} } }
    global.wx = {
      getStorageSync: function (key) { return key in disk ? clone(disk[key]) : '' },
      setStorageSync: function (key, value) { disk[key] = clone(value) },
      removeStorageSync: function (key) { delete disk[key] },
      getAppBaseInfo: function () { return { theme: 'light', windowWidth: 375 } },
      setNavigationBarTitle: function () {},
      setTabBarStyle: function () {},
      setTabBarItem: function () {},
      showToast: function (options) { toasts.push(options) },
      showModal: function (options) { modals.push(options) },
      previewImage: function (options) { previews.push(options) },
      openSetting: function (options) { settings.push(options) },
      createCanvasContext: function (id) {
        var ctx = new FakeContext()
        ctx.draw = function (reserve, callback) { draws.push({ ctx: ctx, reserve: reserve }); if (callback) callback() }
        contexts.push({ id: id, ctx: ctx })
        return ctx
      },
      canvasToTempFilePath: function (options, owner) { exports.push({ options: options, owner: owner }) },
      saveImageToPhotosAlbum: function (options) { saves.push(options) },
      shareImageMessage: function (options) { shares.push(options) }
    }
    var definition
    global.Page = function (options) { definition = options }
    delete require.cache[require.resolve('../utils/store')]
    delete require.cache[pageFile]
    require(pageFile)
    var instance = Object.assign({}, definition, { data: clone(definition.data) })
    instance.setData = function (patch, callback) {
      instance.stateWrites++
      Object.assign(this.data, patch)
      if (callback) callback()
    }
    instance.stateWrites = 0
    instance.onLoad({ year: '2026' })
    instance.refresh()
    return instance
  }
  function generate(env, filePath) {
    env.generateShare()
    check(exports.length > 0 && env.data.shareBusy, '生成期间 busy 并等待临时文件')
    last(exports).options.success({ tempFilePath: filePath || 'wxfile://usr/annual-2026.png' })
    check(env.data.shareImage === (filePath || 'wxfile://usr/annual-2026.png') && !env.data.shareBusy, '临时文件成功后才显示预览')
  }

  var env = setup()
  check(env.data.hasData && env.data.incomeText === '¥10,000.00' && env.data.netExpenseText === '¥1,034.00', '页面继续使用 annualReport 的真实结果')
  check(env.data.shareBusy === false && env.data.shareImage === '', '页面分享初始状态安全')
  env.generateShare()
  check(env.data.shareBusy && env.data.shareAction === 'generate' && contexts.length === 1 && draws.length === 1, '生成调用旧版 CanvasContext 并绘制')
  var request = last(exports)
  check(request.options.canvasId === 'annual-share-canvas' && request.options.destWidth === 750 && request.options.destHeight === 1000 && request.owner === env, '临时文件参数与页面实例正确')
  request.options.success({ tempFilePath: 'wxfile://usr/annual.png' })
  check(env.data.shareImage === 'wxfile://usr/annual.png' && /^\d{4}\.\d{2}\.\d{2}$/.test(env.data.shareGeneratedAt), '生成成功保存预览和日期')
  env.previewShareImage()
  check(previews[0].current === 'wxfile://usr/annual.png' && previews[0].urls.length === 1, '预览使用已生成的临时文件')
  env.saveShareImage()
  check(env.data.shareBusy && env.data.shareAction === 'save' && saves[0].filePath === 'wxfile://usr/annual.png', '保存使用当前临时文件并进入 busy')
  var callsBefore = saves.length
  env.saveShareImage(); env.generateShare()
  check(saves.length === callsBefore && contexts.length === 1, 'busy 时禁止重复生成和保存')
  last(saves).success()
  check(!env.data.shareBusy && env.data.shareStatus === '已保存到相册。' && last(toasts).title === '已保存到相册', '仅保存成功回调后提示成功')

  env = setup(undefined, { theme: 'forest', title: '家庭年报', subtitle: '自定义副标题', showTopCategories: false, showHealth: false, showGeneratedAt: false, accentColor: '#AABBCC' })
  check(env.data.sharePrefs.theme === 'forest' && env.data.sharePrefs.title === '家庭年报' && env.data.sharePrefs.accentColor === '#aabbcc', '页面加载本机模板偏好')
  generate(env)
  var customPageTexts = contexts[0].ctx.texts.map(function (item) { return item.text })
  check(customPageTexts.indexOf('家庭年报') >= 0 && customPageTexts.indexOf('自定义副标题') >= 0, '页面生成分享图应用标题与副标题')
  check(customPageTexts.indexOf('TOP 3 支出分类') === -1 && customPageTexts.indexOf('年度健康概览') === -1 && !customPageTexts.some(function (value) { return /^生成于 /.test(value) }), '页面生成分享图应用模块开关')
  check(contexts[0].ctx.texts.some(function (item) { return item.color === '#aabbcc' }), '页面生成分享图应用自定义颜色')
  env.selectShareTheme({ currentTarget: { dataset: { theme: 'night' } } })
  check(env.data.sharePrefs.theme === 'night' && disk.annual_share_prefs_v1.theme === 'night' && !env.data.shareImage, '切换主题持久化并使旧图失效')
  env.inputShareTitle({ detail: { value: '新标题' } })
  env.inputShareSubtitle({ detail: { value: '新副标题' } })
  env.toggleShareModule({ currentTarget: { dataset: { field: 'showTopCategories' } }, detail: { value: true } })
  env.toggleShareModule({ currentTarget: { dataset: { field: 'showHealth' } }, detail: { value: true } })
  env.toggleShareModule({ currentTarget: { dataset: { field: 'showGeneratedAt' } }, detail: { value: true } })
  env.inputShareAccent({ detail: { value: '#12zzzz' } })
  check(env.data.sharePrefs.title === '新标题' && env.data.sharePrefs.subtitle === '新副标题' && env.data.sharePrefs.showTopCategories && env.data.sharePrefs.showHealth && env.data.sharePrefs.showGeneratedAt && env.data.sharePrefs.accentColor === '', '页面输入与开关更新偏好，非法颜色回退')
  env.resetShareAccent()
  check(env.data.sharePrefs.accentColor === '' && disk.annual_share_prefs_v1.accentColor === '', '强调色可恢复跟随主题')
  var persistedPrefs = clone(disk.annual_share_prefs_v1)
  env = setup(undefined, persistedPrefs)
  check(env.data.sharePrefs.theme === 'night' && env.data.sharePrefs.title === '新标题' && env.data.sharePrefs.showHealth, '重新进入页面恢复已保存偏好')
  env.resetSharePrefs()
  check(env.data.sharePrefs.theme === 'paper' && env.data.sharePrefs.title === '' && env.data.sharePrefs.showTopCategories && env.data.sharePrefs.showHealth && env.data.sharePrefs.showGeneratedAt, '恢复默认重置全部模板选项')
  check(disk.annual_share_prefs_v1.theme === 'paper', '恢复默认同样保存到本机')

  env = setup(undefined, '{damaged')
  check(env.data.sharePrefs.theme === 'paper' && env.data.sharePrefs.title === '' && env.data.sharePrefs.showHealth, '页面遇到损坏旧偏好安全回退')
  env = setup(undefined, { theme: 'forest' })
  check(env.data.sharePrefs.theme === 'forest' && env.data.sharePrefs.showTopCategories && env.data.sharePrefs.showHealth && env.data.sharePrefs.showGeneratedAt, '旧版不完整偏好保留主题并补齐默认字段')

  env = setup()
  env.generateShare()
  var prefsAtBusy = clone(env.data.sharePrefs)
  env.selectShareTheme({ currentTarget: { dataset: { theme: 'night' } } })
  check(JSON.stringify(env.data.sharePrefs) === JSON.stringify(prefsAtBusy) && contexts.length === 1, '生成 busy 期间禁止修改模板和重复绘制')
  last(exports).options.success({ tempFilePath: 'wxfile://usr/busy.png' })

  env = setup()
  env._report = { hasData: true, year: 2026, scopeText: '旧版口径', totals: { balanceCents: 100, incomeCents: 200, netExpenseCents: 50, refundCents: 50, savingsRate: 0.5 }, health: {}, topCategories: [] }
  env.generateShare()
  check(exports.length === 1 && contexts[0].ctx.texts.some(function (item) { return item.text === '旧版口径' || item.text === '本机全部流水' }), '旧版年度结果缺省字段仍可生成分享图')
  last(exports).options.success({ tempFilePath: 'wxfile://usr/legacy.png' })

  env = setup()
  generate(env)
  check(shares.length === 0, '生成分享图不会后台自动分享')
  env.shareToFriends()
  check(env.data.shareBusy && env.data.shareAction === 'share' && shares.length === 1, '用户点击后才调用好友分享 API 并进入 busy')
  check(shares[0].imageUrl === 'wxfile://usr/annual-2026.png', '好友分享使用已生成的图片地址')
  var shareCallsBefore = shares.length
  env.shareToFriends(); env.saveShareImage(); env.generateShare()
  check(shares.length === shareCallsBefore && saves.length === 0 && contexts.length === 1, '分享 busy 时禁止重复分享、保存和生成')
  last(shares).success()
  check(!env.data.shareBusy && env.data.shareStatus === '已分享给好友。' && last(toasts).title === '已分享给好友', '仅在分享成功回调后提示成功')
  check(env.data.shareImage === 'wxfile://usr/annual-2026.png', '分享成功后仍保留图片')

  env = setup()
  generate(env)
  env.shareToFriends()
  last(shares).fail({ errMsg: 'shareImageMessage:fail cancel' })
  check(!env.data.shareBusy && env.data.shareImage && env.data.shareStatus.indexOf('已取消') >= 0 && !env.data.shareError, '取消分享解除 busy、保留图片且不显示失败')
  check(last(toasts).title === '已取消分享', '取消分享有明确反馈')
  env.shareToFriends(); last(shares).success()
  check(env.data.shareStatus === '已分享给好友。', '取消后可重新分享')

  env = setup()
  generate(env)
  env.shareToFriends()
  last(shares).fail({ errMsg: 'shareImageMessage:fail write' })
  check(!env.data.shareBusy && env.data.shareImage && env.data.shareError.indexOf('分享给好友失败') >= 0, '分享失败解除 busy、保留图片并如实反馈')
  check(env.data.shareRetryAction === 'share', '分享失败后提供重试分享入口')
  env.shareToFriends(); last(shares).success()
  check(env.data.shareStatus === '已分享给好友。', '分享失败后可重试')

  env = setup()
  generate(env)
  delete wx.shareImageMessage
  var unsupportedError = null
  var shareInvoked = annualShare.shareToFriends('wxfile://usr/annual-2026.png', { fail: function (err) { unsupportedError = err } })
  check(shareInvoked === false && unsupportedError && unsupportedError.code === 'UNSUPPORTED' && unsupportedError.message.indexOf('保存到相册') >= 0, '好友分享 API 不可用时返回明确保存相册兜底')
  env.shareToFriends()
  check(!env.data.shareBusy && env.data.shareImage && env.data.shareError.indexOf('不支持直接分享') >= 0 && env.data.shareError.indexOf('保存到相册') >= 0, '页面在 API 不可用时提示改用保存相册且不伪造成功')
  check(env.data.shareRetryAction === 'save' && last(toasts).title.indexOf('保存相册') >= 0, 'API 不可用时保留图片并引导保存相册')
  env.saveShareImage(); last(saves).success()
  check(env.data.shareStatus === '已保存到相册。', 'API 不可用时保存相册兜底仍可用')

  env = setup()
  generate(env)
  env.shareToFriends()
  env.onUnload()
  writesAtUnload = env.stateWrites
  var toastsAtUnload = toasts.length
  last(shares).success()
  check(env.stateWrites === writesAtUnload && toasts.length === toastsAtUnload, '卸载后分享成功回调不 setData 或弹成功提示')

  env = setup()
  generate(env)
  env.shareToFriends()
  env.onUnload()
  writesAtUnload = env.stateWrites
  toastsAtUnload = toasts.length
  last(shares).fail({ errMsg: 'shareImageMessage:fail cancel' })
  check(env.stateWrites === writesAtUnload && toasts.length === toastsAtUnload, '卸载后分享失败回调不 setData 或弹提示')

  env = setup()
  generate(env)
  env.generateShare()
  last(exports).options.fail({ errMsg: 'canvasToTempFilePath:fail' })
  check(!env.data.shareBusy && env.data.shareImage === '' && env.data.shareError === '生成失败，请重试。', '生成失败解除 busy 并如实反馈')
  generate(env, 'wxfile://usr/retry.png')
  check(env.data.shareImage === 'wxfile://usr/retry.png', '生成失败后可重试')

  env = setup()
  generate(env)
  env.saveShareImage()
  last(saves).fail({ errMsg: 'saveImageToPhotosAlbum:fail auth deny' })
  check(!env.data.shareBusy && env.data.shareImage && env.data.shareError.indexOf('相册权限') >= 0, '权限拒绝保留图片并显示真实原因')
  check(last(modals).title === '未获得相册权限' && last(modals).content.indexOf('不会自动保存') >= 0, '权限弹窗不谎称已保存或自动分享')
  last(modals).success({ confirm: true })
  check(settings.length === 1, '拒绝后提供前往设置入口')
  settings[0].success()
  env.refresh()
  check(env.data.shareImage && !env.data.loading, '从设置返回后同一年报告保留图片供重试')
  env.saveShareImage(); last(saves).success()
  check(last(toasts).title === '已保存到相册', '权限处理后允许手动重试保存')

  env = setup()
  generate(env)
  env.saveShareImage(); last(saves).fail({ errMsg: 'saveImageToPhotosAlbum:fail write' })
  check(!env.data.shareBusy && env.data.shareError === '保存到相册失败，请重试。' && env.data.shareImage, '普通保存失败不丢图且可重试')
  env.saveShareImage(); last(saves).success()
  check(env.data.shareStatus === '已保存到相册。', '普通保存失败后可重试')

  env = setup()
  generate(env)
  env.generateShare()
  env.prevYear()
  check(env.data.year === 2025 && !env.data.shareBusy && env.data.shareImage === '', '切换年份使旧图和旧任务失效')
  var writesAtUnload = env.stateWrites
  last(exports).options.success({ tempFilePath: 'wxfile://usr/stale.png' })
  check(env.stateWrites === writesAtUnload && !env.data.shareImage, '旧年份异步回调被忽略')

  env = setup()
  generate(env)
  env.saveShareImage()
  env.onUnload()
  writesAtUnload = env.stateWrites
  last(saves).success()
  check(env.stateWrites === writesAtUnload && toasts.length === 0, '卸载后保存回调不 setData 或弹成功提示')

  env = setup()
  env.generateShare()
  env.onUnload()
  writesAtUnload = env.stateWrites
  last(exports).options.success({ tempFilePath: 'wxfile://usr/late.png' })
  check(env.stateWrites === writesAtUnload && toasts.length === 0, '卸载后生成回调不 setData 或弹提示')

  env = setup([])
  check(!env.data.hasData && env.data.txCount === 0, '无流水年份禁用分享数据')
  env.generateShare()
  check(contexts.length === 0 && last(toasts).title.indexOf('还没有流水') >= 0 && !env.data.shareBusy, '无数据不创建画布并给出提示')

  env = setup()
  generate(env)
  delete wx.saveImageToPhotosAlbum
  env.saveShareImage()
  check(!env.data.shareBusy && env.data.shareError.indexOf('不支持') >= 0, '旧微信缺少保存 API 时如实降级')

  env = setup()
  delete wx.canvasToTempFilePath
  env.generateShare()
  check(!env.data.shareBusy && env.data.shareError.indexOf('不支持') >= 0 && contexts.length === 0, '缺少导出 API 时不进入忙碌')

  env = setup()
  wx.canvasToTempFilePath = function () { throw new Error('export failure') }
  env.generateShare()
  check(!env.data.shareBusy && env.data.shareError === '生成失败，请重试。', '导出同步异常也解除忙碌')

  env = setup()
  generate(env)
  wx.saveImageToPhotosAlbum = function () { throw new Error('save failure') }
  env.saveShareImage()
  check(!env.data.shareBusy && env.data.shareError === '保存到相册失败，请重试。' && env.data.shareImage, '保存同步异常不丢图且可重试')

  var wxml = fs.readFileSync(path.resolve(__dirname, '../pages/annual/annual.wxml'), 'utf8')
  check(wxml.indexOf('生成分享图') >= 0 && wxml.indexOf('分享给好友') >= 0 && wxml.indexOf('保存到相册') >= 0 && wxml.indexOf('canvas-id="annual-share-canvas"') >= 0, '页面提供画布、生成、好友分享和保存入口')
  check(wxml.indexOf('disabled="{{!hasData || loading || shareBusy}}"') >= 0 && wxml.indexOf('disabled="{{!shareImage || shareBusy}}" bindtap="shareToFriends"') >= 0 && wxml.indexOf('disabled="{{!shareImage || shareBusy}}" bindtap="saveShareImage"') >= 0, '无图和忙碌时好友分享及保存按钮禁用')
  check(wxml.indexOf('重试分享') >= 0 && wxml.indexOf('不会在后台自动分享') >= 0, '页面支持重试分享并明确不后台自动分享')
  ;['分享模板', 'selectShareTheme', 'inputShareTitle', 'inputShareSubtitle', 'toggleShareModule', 'resetSharePrefs', 'showTopCategories', 'showHealth', 'showGeneratedAt', '恢复默认'].forEach(function (part) {
    check(wxml.indexOf(part) >= 0, '页面模板设置区包含 ' + part)
  })
  check(wxml.indexOf('type="color"') >= 0 && wxml.indexOf('inputShareAccent') >= 0, '页面提供合法强调色输入')

  console.log('通过 ' + passed + ' 项，失败 0 项')
} catch (err) {
  console.error('失败 ' + passed + ' 项后：' + err.stack)
  process.exitCode = 1
}
