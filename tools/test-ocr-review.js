const assert = require('assert')
const fs = require('fs')
const path = require('path')
const ocrbill = require('../utils/ocrbill')

let passed = 0
function check(value, message) {
  assert.ok(value, message)
  passed++
}
function equal(actual, expected, message) {
  assert.deepStrictEqual(actual, expected, message)
  passed++
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.keys(value).forEach((key) => freeze(value[key]))
    Object.freeze(value)
  }
  return value
}
function meta(item, confidence, reasons) {
  check(['high', 'medium', 'low'].indexOf(item.confidence) >= 0, 'confidence 只能是 high/medium/low')
  check(Array.isArray(item.reviewReasons) && item.reviewReasons.every((reason) => typeof reason === 'string'), 'reviewReasons 始终是字符串数组')
  equal(item.confidence, confidence, '置信度符合规则')
  equal(item.reviewReasons, reasons, '疑点完整且顺序稳定')
  check(new Set(item.reviewReasons).size === item.reviewReasons.length, '疑点不重复')
}
function T(text, left, top, height) {
  return { text, left, top, height: height || 18 }
}
function listRows(merchant, amount, date) {
  const rows = [T('微信支付', 10, 0), T(merchant, 10, 80), T(amount, 200, 80)]
  if (date) rows.push(T(date, 10, 104))
  return rows
}

console.log('[1] 列表截图置信度')

const highInput = freeze(listRows('星巴克', '-35.00', '2026-11-01 12:30'))
const highBefore = JSON.stringify(highInput)
const high = ocrbill.parseItems(highInput, {})
equal(high.items.length, 1, '高置信度记录保留')
meta(high.items[0], 'high', [])
equal(high.items[0].amount, 35, '高置信度金额不变')
equal(JSON.stringify(highInput), highBefore, 'parseItems 不修改原始文字块')

const medium = ocrbill.parseItems(freeze(listRows('星巴克', '-35.00', '11月1日 12:30')), {})
meta(medium.items[0], 'medium', ['交易日期缺少年份，已按历史交易推断'])

const inlineInput = freeze([{ text: '2026年11月1日 星巴克消费35.00元' }])
const inlineBefore = JSON.stringify(inlineInput)
const inline = ocrbill.parseItems(inlineInput, {})
equal(inline.items.length, 1, '低置信度记录不因复核被丢弃')
equal(inline.items[0].amount, 35, '低置信度金额仍保留')
meta(inline.items[0], 'low', ['金额来自非独立金额格', '收支方向不明确，暂按支出处理'])
const inlineAgain = ocrbill.parseItems(inlineInput, {})
equal(inlineAgain.items[0].reviewReasons, inline.items[0].reviewReasons, '重复解析疑点稳定')
equal(JSON.stringify(inlineInput), inlineBefore, '单块文本解析不修改输入')

const noDate = ocrbill.parseItems(freeze(listRows('星巴克', '-35.00')), {})
meta(noDate.items[0], 'low', ['未识别到交易日期，暂用今天'])

const longMerchant = '这是一段明显过长的商户名称可能把页面说明和交易对方混在一起'
const long = ocrbill.parseItems(freeze(listRows(longMerchant, '-35.00', '2026-11-01 12:30')), {})
meta(long.items[0], 'low', ['商户名称过长，可能混入界面文案'])

const uiText = ocrbill.parseItems(freeze(listRows('账单详情 点击查看', '-35.00', '2026-11-01 12:30')), {})
meta(uiText.items[0], 'low', ['商户内容疑似界面文案'])

const transfer = ocrbill.parseItems(freeze(listRows('零钱通', '35.00', '2026-11-01 12:30')), {})
equal(transfer.items[0].type, 'transfer', '原有转账分类行为不变')
meta(transfer.items[0], 'low', ['转账方向不明确'])

const monthOnly = ocrbill.parseItems(freeze([
  T('2026年11月', 10, 0),
  T('星巴克', 10, 60),
  T('-35.00', 200, 60)
]), {})
meta(monthOnly.items[0], 'low', ['交易日期仅精确到月份，暂按月初处理'])

console.log('[2] 详情截图置信度')
const nowInfo = { y: 2026, m: 11, d: 24, ts: new Date(2026, 10, 24).getTime() }
const sn = '2026110100000000000000000001'
function parseDetail(rows, source) {
  const before = JSON.stringify(rows)
  const result = ocrbill.parseDetail(
    ocrbill.groupRows(rows), nowInfo, {}, rows.map((row) => row.text).join(' '), source || '微信'
  )
  equal(JSON.stringify(rows), before, 'parseDetail 不修改原始文字块')
  return result
}
const detailHigh = parseDetail(freeze([
  T('星巴克', 0, 0),
  T('-¥35.00', 0, 30, 44),
  T('支付时间 2026-11-01 12:30', 0, 80),
  T('交易单号 ' + sn, 0, 105)
]))
meta(detailHigh.items[0], 'high', [])

const detailNoSn = parseDetail(freeze([
  T('星巴克', 0, 0),
  T('-¥35.00', 0, 30, 44),
  T('支付时间 2026-11-01 12:30', 0, 80)
]))
meta(detailNoSn.items[0], 'low', ['详情页缺少交易单号'])
check(detailNoSn.items.length === 1, '详情页缺单号仍保留记录')

const detailPartialDate = parseDetail(freeze([
  T('星巴克', 0, 0),
  T('-¥35.00', 0, 30, 44),
  T('支付时间 11月1日 12:30', 0, 80),
  T('交易单号 ' + sn, 0, 105)
]))
meta(detailPartialDate.items[0], 'medium', ['交易日期缺少年份，已按历史交易推断'])

const detailMissing = parseDetail(freeze([
  T('-¥35.00', 0, 0, 44),
  T('支付方式 零钱', 0, 60)
]))
meta(detailMissing.items[0], 'low', [
  '未识别到交易日期，暂用今天',
  '未识别到商户',
  '详情页缺少交易单号'
])

console.log('[3] 原图坐标与图片序号')
const positionedInput = freeze(listRows('星巴克', '-35.00', '2026-11-01 12:30'))
const positioned = ocrbill.parseItems(positionedInput, {}, { imageIndex: 0 })
equal(positioned.items[0].imageIndex, 0, 'parseItems 保留调用方提供的图片序号')
equal(positioned.items[0].ocrBox, { left: 200, top: 80, width: 64.8, height: 18 }, '金额格保留 left/top/height 并估算宽度')
const explicitWidth = ocrbill.parseItems(freeze([
  T('星巴克', 10, 80), Object.assign(T('-35.00', 200, 80), { width: 77 }), T('2026-11-01 12:30', 10, 104)
]), {}, { imageIndex: 1 })
equal(explicitWidth.items[0].ocrBox.width, 77, 'OCR 自带宽度时优先保留')
const multiCoordinates = ocrbill.parseItems(freeze([
  Object.assign(T('甲商户', 10, 80), { imageIndex: 0 }), Object.assign(T('-1.00', 40, 80), { imageIndex: 0 }),
  Object.assign(T('2026-11-01 10:00', 10, 104), { imageIndex: 0 }),
  Object.assign(T('乙商户', 10, 180), { imageIndex: 1 }), Object.assign(T('-2.00', 40, 180), { imageIndex: 1 }),
  Object.assign(T('2026-11-02 11:00', 10, 204), { imageIndex: 1 })
]), {}, { imageIndex: 9 })
equal(multiCoordinates.items.map((item) => item.imageIndex), [0, 1], '不同图片的文字块不会串图，条目序号优先取自身')
equal(multiCoordinates.items.map((item) => item.ocrBox.left), [40, 40], '多图各自保留原图坐标')
const noCoordinates = ocrbill.parseItems(freeze([{ text: '星巴克 -35.00 2026-11-01 12:30' }]), {}, { imageIndex: 0 })
check(!Object.prototype.hasOwnProperty.call(noCoordinates.items[0], 'ocrBox'), '无坐标旧数据不伪造识别框')
equal(noCoordinates.items[0].imageIndex, 0, '无坐标时仍保留已知图片序号')
const missingHeight = ocrbill.parseItems(freeze([
  { text: '星巴克', left: 10, top: 80 }, { text: '-35.00', left: 200, top: 80 }, { text: '2026-11-01 12:30', left: 10, top: 104 }
]), {})
check(!Object.prototype.hasOwnProperty.call(missingHeight.items[0], 'ocrBox'), '缺少高度时识别框留空')
check(!Object.prototype.hasOwnProperty.call(missingHeight.items[0], 'imageIndex'), '图片序号未知时留空')
const detailPositioned = ocrbill.parseDetail(
  ocrbill.groupRows(freeze([
    Object.assign(T('星巴克', 0, 0), { imageIndex: 2 }),
    Object.assign(T('-¥35.00', 12, 30, 44), { imageIndex: 2 }),
    Object.assign(T('支付时间 2026-11-01 12:30', 0, 80), { imageIndex: 2 }),
    Object.assign(T('交易单号 ' + sn, 0, 105), { imageIndex: 2 })
  ])), nowInfo, {}, '星巴克 -¥35.00 支付时间 2026-11-01 12:30 交易单号 ' + sn, '微信', { imageIndex: 4 }
)
equal(detailPositioned.items[0].imageIndex, 2, 'parseDetail 保留金额格自身图片序号')
equal(detailPositioned.items[0].ocrBox.left, 12, 'parseDetail 保留原图左坐标')
equal(detailPositioned.items[0].ocrBox.top, 30, 'parseDetail 保留原图上坐标')
equal(detailPositioned.items[0].ocrBox.height, 44, 'parseDetail 保留原图高度')
check(detailPositioned.items[0].ocrBox.width > 0, 'parseDetail 给出可用框宽度')

console.log('[4] 人工修正与疑点重算')
const correctionBase = Object.assign({}, noDate.items[0], {
  time: new Date(2026, 10, 1, 12, 34).getTime(),
  day: '2026-11-01', ym: '2026-11', ocrBox: { left: 20, top: 30, width: 60, height: 18 }, imageIndex: 0
})
const correctionBefore = JSON.stringify(correctionBase)
const corrected = ocrbill.correctItem(correctionBase, {
  merchant: '修正商户', amount: '36.50', date: '2026-11-02', type: 'income', category: '工资'
}, {})
check(corrected && corrected.amount === 36.5 && corrected.merchant === '修正商户', '修正写入商户与金额')
equal(corrected.day, '2026-11-02', '修正日期同步 day')
equal(corrected.ym, '2026-11', '修正日期同步 ym')
equal(new Date(corrected.time).getHours(), 12, '修正日期保留原时分')
equal(new Date(corrected.time).getMinutes(), 34, '修正日期保留原分钟')
equal(corrected.type, 'income', '修正写入收支类型')
equal(corrected.category, '工资', '修正写入分类')
meta(corrected, 'high', [])
equal(corrected.ocrBox, correctionBase.ocrBox, '修正不丢失原图坐标')
equal(corrected.imageIndex, 0, '修正不丢失图片序号')
equal(JSON.stringify(correctionBase), correctionBefore, '修正函数不修改原条目')
const fixedMerchant = ocrbill.correctItem(long.items[0], { merchant: '正常商户' }, {})
meta(fixedMerchant, 'high', [])
const fixedAmount = ocrbill.correctItem(inline.items[0], { amount: '40.00' }, {})
check(fixedAmount.reviewReasons.indexOf('金额来自非独立金额格') < 0, '修正金额消除金额来源疑点')
check(fixedAmount.reviewReasons.indexOf('收支方向不明确，暂按支出处理') >= 0, '未修正字段的疑点继续保留')
const fixedType = ocrbill.correctItem(transfer.items[0], { type: 'income', category: '其他收入' }, {})
meta(fixedType, 'high', [])
equal(ocrbill.correctItem(correctionBase, { amount: '0' }, {}), null, '拒绝零金额修正')
equal(ocrbill.correctItem(correctionBase, { date: '2026-02-30' }, {}), null, '拒绝无效日期修正')
equal(ocrbill.correctItem(correctionBase, { type: 'income', category: '餐饮' }, {}), null, '拒绝收支方向不匹配的分类')

console.log('[5] 账单文件置信度')
const billBase = {
  t: new Date(2026, 10, 1, 12).getTime(), a: 35, ty: 'expense', m: '星巴克', sn: 'SN001', s: '微信'
}
const billInput = freeze([billBase])
const billBefore = JSON.stringify(billInput)
const billHigh = ocrbill.fromBill(billInput, {})
meta(billHigh.items[0], 'high', [])
equal(JSON.stringify(billInput), billBefore, 'fromBill 不修改原始账单条目')

const billMediumInput = freeze([Object.assign({}, billBase, { sn: '' })])
const billMedium = ocrbill.fromBill(billMediumInput, {})
meta(billMedium.items[0], 'medium', ['账单条目缺少交易单号，按日期金额商户判重'])

const billLowInput = freeze([{ t: billBase.t, a: 35 }])
const billLowBefore = JSON.stringify(billLowInput)
const billLow = ocrbill.fromBill(billLowInput, {})
equal(billLow.items.length, 1, '账单低置信度记录不丢弃')
meta(billLow.items[0], 'low', [
  '未识别到商户',
  '收支方向不明确，暂按支出处理',
  '账单条目缺少交易单号，按日期金额商户判重',
  '账单来源不明确'
])
equal(JSON.stringify(billLowInput), billLowBefore, '低置信度账单转换不修改输入')

console.log('[6] 页面复核清单与确认门禁')
const disk = {}
const modals = []
const batches = []
global.wx = {
  getStorageSync: (key) => key in disk ? disk[key] : '',
  setStorageSync: (key, value) => { disk[key] = value },
  removeStorageSync: (key) => { delete disk[key] },
  showModal: (options) => modals.push(options),
  showToast: () => {}
}
global.getApp = () => ({ globalData: {} })
const store = require('../utils/store')
store.previewAdd = (items) => ({ added: items.length, merged: 0, dup: 0 })
store.addMany = (items) => {
  batches.push(items)
  return { saved: true, added: items.length, merged: 0, dup: 0 }
}
store.learnFromItems = () => true
let definition
global.Page = (value) => { definition = value }
const shotPath = path.resolve(__dirname, '../pages/shot/shot.js')
delete require.cache[shotPath]
require(shotPath)
const page = Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)) })
page.setData = function (patch) {
  Object.keys(patch).forEach((key) => { this.data[key] = patch[key] })
}
function tx(id, confidence, reasons) {
  return Object.assign({
    id, time: new Date(2026, 10, 1, 12).getTime(), amount: 35, type: 'expense',
    merchant: id === 'low' ? '待核对商户' : '正常商户', category: '餐饮', confidence, reviewReasons: reasons
  })
}
const lowTx = tx('low', 'low', inline.items[0].reviewReasons)
const highTx = tx('high', 'high', [])
page.finishBatch([lowTx, highTx], [{ no: 3, why: '网络失败' }, { no: 1, why: '文字不清' }], 1, '微信', 3)
equal(page.data.preview.lowCount, 1, '预览统计低置信度数量')
equal(page.data.preview.lowItems.length, 1, '低置信度逐条进入预览')
equal(page.data.preview.lowItems[0].merchant, lowTx.merchant, '复核清单展示商户')
equal(page.data.preview.lowItems[0].amountText, '35.00', '复核清单展示金额')
equal(page.data.preview.lowItems[0].reviewReasons, lowTx.reviewReasons, '复核清单展示疑点')
equal(page.data.preview.fails.map((fail) => fail.no), [1, 3], '保留多图失败提示及图序')

page.requestImport()
equal(batches.length, 0, '低置信度确认前不调用导入')
equal(modals.length, 1, '低置信度确认前弹出二次确认')
check(modals[0].content.indexOf('逐条核对') >= 0 && modals[0].content.indexOf('不会被自动丢弃') >= 0, '弹窗明确要求核对且不丢弃记录')
check(modals[0].confirmText.indexOf('已核对') >= 0, '确认按钮强调已经核对')
page.doImport()
equal(modals.length, 1, '弹窗打开期间重复点击不重复弹窗')
equal(batches.length, 0, '弹窗打开期间仍不能导入')
modals[0].success({ confirm: false })
equal(batches.length, 0, '取消核对不导入并保留预览')

page.requestImport()
modals[1].success({ confirm: true })
equal(batches.length, 1, '用户明确确认后才调用现有导入')
equal(batches[0].length, 2, '确认后高低置信度记录都导入')
check(page.data.result.added === 2 && page.data.preview === null, '确认后沿用原有导入完成流程')

page.finishBatch([tx('medium', 'medium', medium.items[0].reviewReasons)], [], 0, '微信', 1)
const modalCount = modals.length
page.requestImport()
equal(modals.length, modalCount, '中置信度不触发低置信度门禁')
equal(batches.length, 2, '中置信度沿用直接确认导入')

page.finishBatch([lowTx], [], 0, '微信', 1)
page.requestImport()
const staleModal = modals[modals.length - 1]
page.finishBatch([Object.assign({}, lowTx, { id: 'new-low' })], [], 0, '微信', 1)
staleModal.success({ confirm: true })
equal(batches.length, 2, '新一批预览不能复用旧确认')
page.requestImport()
modals[modals.length - 1].success({ confirm: true })
equal(batches.length, 3, '新一批预览需独立确认')

page.redraw()
page.doImport()
equal(batches.length, 3, '重选图片清空预览后不能导入')

console.log('[7] 页面多图框选、缺失坐标与修正')
const originalFiles = [
  { tempFilePath: 'shot-a.jpg', width: 400, height: 800 },
  { tempFilePath: 'shot-b.jpg', width: 500, height: 1000 }
]
page.ocrOne = function (src, no, total, cb) {
  const top = no === 1 ? 80 : 160
  const result = ocrbill.parseItems([T('商户' + no, 10, top), T('-' + no + '.00', no === 1 ? 40 : 80, top)], {}, { imageIndex: no - 1 })
  cb(null, result)
}
page.runBatch(originalFiles, page.beginTask())
equal(page._shotImages.map((image) => image.path), ['shot-a.jpg', 'shot-b.jpg'], '页面保存本轮原图路径')
equal(page._shotImages.map((image) => [image.width, image.height]), [[400, 800], [500, 1000]], '页面保存本轮原图尺寸')
equal(page._parsed.map((item) => item.imageIndex), [0, 1], '逐图解析写入图片序号')
equal(page.data.preview.images.length, 2, '预览保留多张原图')
equal(page.data.preview.images[0].boxes[0].leftPct, '10.0000', '第一图框按原图宽度换算百分比')
equal(page.data.preview.images[0].boxes[0].topPct, '10.0000', '第一图框按原图高度换算百分比')
equal(page.data.preview.images[1].boxes[0].leftPct, '16.0000', '第二图使用自身尺寸换算')
equal(page.data.preview.images[1].boxes[0].topPct, '16.0000', '第二图框映射到自身原图')
page.focusReviewItem({ currentTarget: { dataset: { index: 1 } } })
equal(page.data.reviewImageIndex, 1, '点击低置信度条目切换到对应图片')
equal(page.data.highlightKey, 'parsed-1', '点击条目设置对应高亮框')
page.selectOriginalImage({ currentTarget: { dataset: { index: 0 } } })
equal(page.data.reviewImageIndex, 0, '可手动切换多张原图')
const imageInfoRequests = []
wx.getImageInfo = (options) => {
  imageInfoRequests.push(options.src)
  options.success({ width: 640, height: 960 })
}
page.runBatch([{ tempFilePath: 'no-size.jpg' }], page.beginTask())
equal(imageInfoRequests, ['no-size.jpg'], '选图结果缺尺寸时读取原图信息')
equal([page._shotImages[0].width, page._shotImages[0].height], [640, 960], '读取成功后保存原图尺寸')
wx.getImageInfo = (options) => options.fail({})
page.runBatch([{ tempFilePath: 'unknown-size.jpg' }], page.beginTask())
equal([page._shotImages[0].width, page._shotImages[0].height], [0, 0], '尺寸读取失败时保留空值而不伪造')
equal(page.data.preview.images[0].boxes.length, 0, '尺寸缺失时不画错误位置的框')
equal(page.data.preview.images[0].unmappedCount, 1, '尺寸缺失时提示该项无法标框')
delete wx.getImageInfo
page._shotImages = originalFiles.map((file) => ({ path: file.tempFilePath, width: file.width, height: file.height }))
page.finishBatch([Object.assign({}, lowTx, { imageIndex: undefined, ocrBox: undefined })], [], 0, '截图', 2)
equal(page.data.preview.lowItems[0].imageIndex, -1, '多图缺少图片序号时不错误映射')
equal(page.data.preview.lowItems[0].hasBox, false, '缺少坐标的条目不伪造框')
page._shotImages = [{ path: 'shot-a.jpg', width: 400, height: 800 }]
page.finishBatch([Object.assign({}, lowTx, { imageIndex: undefined, ocrBox: undefined })], [], 0, '截图', 1)
equal(page.data.preview.images[0].unmappedCount, 1, '单图缺少坐标时显示未标框数量')
page.finishBatch([Object.assign({}, lowTx, {
  imageIndex: 0, ocrBox: { left: 40, top: 80, width: 64.8, height: 18 },
  reviewReasons: ['未识别到商户', '未识别到交易日期，暂用今天', '收支方向不明确，暂按支出处理']
})], [], 0, '截图', 1)
page.requestImport()
const staleReview = modals[modals.length - 1]
const tokenBeforeEdit = page._reviewToken
page._confirmedReviewToken = tokenBeforeEdit
page.editReviewItem({ currentTarget: { dataset: { index: 0 } } })
equal(page.data.editForm.amount, '35.00', '编辑表单带入原金额')
equal(page.data.editForm.date, '2026-11-01', '编辑表单带入原日期')
page.onReviewField({ currentTarget: { dataset: { field: 'merchant' } }, detail: { value: '修正商户' } })
page.onReviewField({ currentTarget: { dataset: { field: 'amount' } }, detail: { value: '36.50' } })
page.onReviewDate({ detail: { value: '2026-11-02' } })
page.onReviewType({ detail: { value: '1' } })
page.onReviewCategory({ detail: { value: page.data.editCategories.indexOf('工资') } })
page.saveReviewEdit()
equal(page._parsed[0].merchant, '修正商户', '页面修正保存回 _parsed')
equal(page._parsed[0].amount, 36.5, '页面修正保存金额')
equal(page._parsed[0].day, '2026-11-02', '页面修正同步日期')
equal(page._parsed[0].type, 'income', '页面修正同步类型')
equal(page._parsed[0].category, '工资', '页面修正同步分类')
meta(page._parsed[0], 'high', [])
equal(page.data.preview.lowCount, 0, '修正后待核对数量即时刷新')
equal(page.data.preview.sample[0].merchant, '修正商户', '修正后预览即时刷新')
equal(page._confirmedReviewToken, 0, '修正后旧确认令牌失效')
check(page._reviewToken > tokenBeforeEdit, '修正生成新的确认令牌版本')
equal(batches.length, 3, '修正弹窗未确认前不导入')
staleReview.success({ confirm: true })
equal(batches.length, 3, '修正前的旧弹窗不能确认新内容')
page.requestImport()
equal(modals[modals.length - 1].title, '修正后请重新确认', '低置信度消除后仍要求重新确认')
equal(batches.length, 3, '重新确认前仍不导入')
modals[modals.length - 1].success({ confirm: true })
equal(batches.length, 4, '重新确认后导入修正记录')
equal(batches[3][0].merchant, '修正商户', '导入使用修正后的条目')
equal(batches[3][0].ocrBox, { left: 40, top: 80, width: 64.8, height: 18 }, '导入记录保留原图坐标')

const wxml = fs.readFileSync(path.resolve(__dirname, '../pages/shot/shot.wxml'), 'utf8')
check(wxml.indexOf('preview.lowCount') >= 0 && wxml.indexOf('preview.lowItems') >= 0, '页面模板展示低置信度数量与逐条清单')
check(wxml.indexOf('item.reviewReasons') >= 0, '页面模板展示每条疑点')
check(wxml.indexOf('bindtap="requestImport"') >= 0, '导入按钮经过确认门禁')
check(wxml.indexOf('原图核对') >= 0 && wxml.indexOf('preview.images[reviewImageIndex].path') >= 0, '模板展示本轮原图')
check(wxml.indexOf('class="ocrbox') >= 0 && wxml.indexOf('left:{{item.leftPct}}%') >= 0 && wxml.indexOf('top:{{item.topPct}}%') >= 0, '识别框使用绝对定位百分比样式')
check(wxml.indexOf('width:{{item.widthPct}}%') >= 0 && wxml.indexOf('height:{{item.heightPct}}%') >= 0, '识别框宽高按百分比缩放')
check(wxml.indexOf('bindtap="focusReviewItem"') >= 0 && wxml.indexOf("catchtap=\"editReviewItem\"") >= 0, '低置信度条目支持定位与修正')
check(wxml.indexOf('bindinput="onReviewField"') >= 0 && wxml.indexOf('bindchange="onReviewDate"') >= 0, '编辑表单支持商户金额与日期')
check(wxml.indexOf('bindchange="onReviewType"') >= 0 && wxml.indexOf('bindchange="onReviewCategory"') >= 0, '编辑表单支持类型与分类')
check(wxml.indexOf('bindtap="saveReviewEdit"') >= 0, '保存修正绑定页面处理方法')
const wxss = fs.readFileSync(path.resolve(__dirname, '../pages/shot/shot.wxss'), 'utf8')
check(/\.ocrbox\s*\{[^}]*position:\s*absolute/.test(wxss), '识别框 CSS 为绝对定位')
check(wxss.indexOf('safe-area-inset-bottom') >= 0, '页面保留底部安全区')
check(wxss.indexOf('.dark .original-review') >= 0 && wxss.indexOf('.dark .editbox') >= 0, '原图核对与编辑表单支持深色')

console.log('通过 ' + passed + ' 项，失败 0 项')
