/* 流水票据 Node 自检：node tools/test-attachments.js */
var assert = require('node:assert/strict')
var fs = require('node:fs')
var os = require('node:os')
var path = require('node:path')

var root = fs.mkdtempSync(path.join(os.tmpdir(), 'jizhangben-attachments-'))
var userDir = path.join(root, 'user')
var tempDir = path.join(root, 'temp')
var disk = {}
var storageWrites = 0
var fsWrites = { mkdir: 0, copy: 0, unlink: 0 }
var storageFailure = false
var systemDark = false
var themeListener = null
var chosenPaths = []
var toasts = []
var modals = []
var navTitles = []
var compressCalls = []
var albumCalls = []
var authorizeCalls = []
var settingCalls = []
var compressHandler = null
var albumHandler = null
var authorizeHandler = null
var settingHandler = null

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function reset() {
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(userDir, { recursive: true })
  fs.mkdirSync(tempDir, { recursive: true })
  disk = {}
  storageWrites = 0
  fsWrites = { mkdir: 0, copy: 0, unlink: 0 }
  storageFailure = false
  systemDark = false
  themeListener = null
  chosenPaths = []
  toasts = []
  modals = []
  navTitles = []
  compressCalls = []
  albumCalls = []
  authorizeCalls = []
  settingCalls = []
  compressHandler = function (options) {
    var file = path.join(tempDir, 'compressed-' + compressCalls.length + '.jpg')
    fs.writeFileSync(file, Buffer.from('small'))
    options.success({ tempFilePath: file })
  }
  albumHandler = function (options) { options.success({}) }
  authorizeHandler = function (options) { options.success({}) }
  settingHandler = function (options) { options.success({ authSetting: { writePhotosAlbum: true } }) }
  wx.compressImage = function (options) {
    compressCalls.push(options)
    compressHandler(options)
  }
  wx.saveImageToPhotosAlbum = function (options) {
    albumCalls.push(options)
    albumHandler(options)
  }
}

function manager() {
  return {
    mkdirSync: function (arg, recursive) {
      fsWrites.mkdir++
      var dir = arg && typeof arg === 'object' ? arg.dirPath : arg
      var rec = arg && typeof arg === 'object' ? arg.recursive : recursive
      fs.mkdirSync(dir, { recursive: rec !== false })
    },
    copyFileSync: function (arg, dest) {
      fsWrites.copy++
      var src = arg && typeof arg === 'object' ? arg.srcPath : arg
      var target = arg && typeof arg === 'object' ? arg.destPath : dest
      fs.copyFileSync(src, target)
    },
    unlinkSync: function (arg) {
      fsWrites.unlink++
      fs.unlinkSync(arg && typeof arg === 'object' ? arg.filePath : arg)
    },
    statSync: function (file) { return fs.statSync(file) },
    readFileSync: function (file) { return fs.readFileSync(file) }
  }
}

global.wx = {
  env: { USER_DATA_PATH: userDir },
  getStorageSync: function (key) { return key in disk ? clone(disk[key]) : '' },
  setStorageSync: function (key, value) {
    if (storageFailure) throw new Error('storage full')
    storageWrites++
    disk[key] = clone(value)
  },
  removeStorageSync: function (key) { delete disk[key] },
  getFileSystemManager: manager,
  getAppBaseInfo: function () { return { theme: systemDark ? 'dark' : 'light' } },
  getSystemInfoSync: function () { return { theme: systemDark ? 'dark' : 'light' } },
  onThemeChange: function (listener) { themeListener = listener },
  offThemeChange: function (listener) { if (themeListener === listener) themeListener = null },
  setTabBarStyle: function () {},
  setTabBarItem: function () {},
  setNavigationBarTitle: function (options) { navTitles.push(options.title) },
  showToast: function (options) { toasts.push(options) },
  showModal: function (options) { modals.push(options) },
  compressImage: function (options) {
    compressCalls.push(options)
    compressHandler(options)
  },
  saveImageToPhotosAlbum: function (options) {
    albumCalls.push(options)
    albumHandler(options)
  },
  authorize: function (options) {
    authorizeCalls.push(options)
    authorizeHandler(options)
  },
  openSetting: function (options) {
    settingCalls.push(options)
    settingHandler(options)
  },
  chooseImage: function (options) {
    options.success({
      tempFilePaths: chosenPaths.slice(),
      tempFiles: chosenPaths.map(function (file) { return { path: file, size: fs.statSync(file).size } })
    })
  },
  navigateBack: function () {},
  switchTab: function () {}
}

var attachments = require('../utils/attachments')
var store = require('../utils/store')
var passed = 0

function check(value, message) {
  assert.ok(value, message)
  passed++
}

function equal(actual, expected, message) {
  assert.deepEqual(actual, expected, message)
  passed++
}

function source(name, content) {
  var file = path.join(tempDir, name)
  fs.writeFileSync(file, content || Buffer.from('receipt-' + name))
  return file
}

function receipt(name, content) {
  var file = path.join(userDir, 'receipts', name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content || Buffer.from('receipt-' + name))
  return file.replace(/\\/g, '/')
}

function tx(id) {
  return {
    id: id,
    time: new Date(2026, 10, 24, 12, 30).getTime(),
    day: '2026-11-24',
    ym: '2026-11',
    amount: 36.5,
    type: 'expense',
    merchant: '测试商户',
    category: '餐饮',
    desc: '工作餐',
    note: '留票',
    account: '微信'
  }
}

function loadPage() {
  var definition
  global.Page = function (options) { definition = options }
  var file = path.resolve(__dirname, '../pages/attachments/attachments.js')
  delete require.cache[file]
  require(file)
  var page = Object.assign({}, definition, { data: clone(definition.data) })
  page.setData = function (patch, callback) {
    Object.assign(this.data, patch)
    if (callback) callback()
  }
  return page
}

async function main() {
try {
  reset()
  var first = source('first.jpg', Buffer.from([0, 1, 2, 3, 255]))
  var added = attachments.attach('tx-1', [{ path: first, name: ' 发票.jpg ' }])
  equal({ added: added.added, duplicate: added.duplicate, skipped: added.skipped }, { added: 1, duplicate: 0, skipped: 0 }, '添加一张图片')
  var item = added.items[0]
  check(item.path.indexOf(userDir.replace(/\\/g, '/') + '/receipts/') === 0, '图片复制到 USER_DATA_PATH/receipts')
  check(item.path !== first.replace(/\\/g, '/'), '不保存临时路径')
  check(fs.existsSync(item.path), '持久图片已落盘')
  equal(fs.readFileSync(item.path), Buffer.from([0, 1, 2, 3, 255]), '复制内容一致')
  equal(Object.keys(item).sort(), ['addedAt', 'id', 'name', 'path'], '存储元数据字段符合约定')
  equal(disk[attachments.KEY]['tx-1'][0].name, '发票.jpg', '文件名已清理')
  fs.unlinkSync(first)
  equal(attachments.list('tx-1')[0].missing, undefined, '删除临时文件后仍能读取持久图片')

  reset()
  var dupSource = source('dup.jpg', Buffer.from('same-image'))
  var sameBatch = attachments.attach('tx-dup', [dupSource, dupSource])
  equal({ added: sameBatch.added, duplicate: sameBatch.duplicate }, { added: 1, duplicate: 1 }, '同批重复路径只添加一次')
  var again = attachments.attach('tx-dup', [dupSource])
  equal({ added: again.added, duplicate: again.duplicate }, { added: 0, duplicate: 1 }, '重复添加同一内容会跳过')
  var sameContent = source('another-name.jpg', Buffer.from('same-image'))
  var byContent = attachments.attach('tx-dup', [sameContent])
  equal({ added: byContent.added, duplicate: byContent.duplicate }, { added: 0, duplicate: 1 }, '内容相同但文件名不同也会判重')
  var other = source('another-name.jpg', Buffer.from('different-image'))
  equal(attachments.attach('tx-dup', [other]).added, 1, '同名但内容不同不会误判')
  equal(attachments.list('tx-dup').length, 2, '判重后保留两条不同票据')

  reset()
  var one = attachments.attach('tx-del', [source('one.jpg')]).items[0]
  var two = attachments.attach('tx-del', [source('two.jpg')]).items[1]
  var removed = attachments.remove('tx-del', one.id)
  check(removed.removed && removed.fileRemoved, '删除附件同时删除图片')
  check(!fs.existsSync(one.path) && fs.existsSync(two.path), '只删除目标图片')
  equal(attachments.list('tx-del').length, 1, '删除后元数据同步减少')
  equal(attachments.remove('tx-del', one.id), { removed: false, fileRemoved: false }, '重复删除返回未删除')
  fs.unlinkSync(two.path)
  var missing = attachments.list('tx-del')[0]
  equal(missing.missing, true, '文件不存在时标记 missing')
  equal(disk[attachments.KEY]['tx-del'][0].missing, true, 'missing 标记持久化')
  equal(attachments.remove('tx-del', two.id), { removed: true, fileRemoved: false }, '缺失图片仍可删除元数据')
  equal(attachments.list('tx-del'), [], '最后一张删除后流水无附件')

  reset()
  var tx1a = attachments.attach('tx-a', [source('a1.jpg')]).items[0]
  var tx1b = attachments.attach('tx-a', [source('a2.jpg')]).items[1]
  var tx2 = attachments.attach('tx-b', [source('b1.jpg')]).items[0]
  var cleaned = attachments.removeTx('tx-a')
  equal(cleaned, { removed: 2, filesRemoved: 2 }, '按流水清理附件和文件')
  check(!fs.existsSync(tx1a.path) && !fs.existsSync(tx1b.path), '目标流水图片已清理')
  check(fs.existsSync(tx2.path), '其他流水图片不受影响')
  check(!Object.prototype.hasOwnProperty.call(disk[attachments.KEY], 'tx-a'), '存储中移除目标 txId')
  equal(attachments.list('tx-b').length, 1, '其他流水元数据保留')
  equal(attachments.removeTx('tx-a'), { removed: 0, filesRemoved: 0 }, '重复清理幂等')

  reset()
  disk.txs_v1 = [tx('tx-clean')]
  store.reload()
  var cleanItem = attachments.attach('tx-clean', [source('clean.jpg')]).items[0]
  check(store.remove('tx-clean'), '流水删除成功')
  check(!fs.existsSync(cleanItem.path), '删除流水后同步清理本地票据图片')
  equal(attachments.list('tx-clean'), [], '删除流水后同步清理票据元数据')

  reset()
  var current = attachments.attach('tx-merge', [source('current.jpg')]).items[0]
  var imported = receipt('imported.png', Buffer.from('imported'))
  var badPath = (userDir.replace(/\\/g, '/') + '/receipts/gone.jpg')
  var payload = {
    'tx-merge': [
      { id: current.id, path: current.path, name: '备份新名字.jpg', addedAt: current.addedAt },
      { id: 'imported-1', path: imported, name: '导入票据.png', addedAt: 2 }
    ],
    'tx-missing': [{ id: 'missing-1', path: badPath, name: '丢失.jpg', addedAt: 3 }]
  }
  var beforeDisk = clone(disk)
  var beforeFsWrites = clone(fsWrites)
  var beforeStorageWrites = storageWrites
  var plan = attachments.planImport(payload)
  check(plan.ok, '备份合并计划有效')
  equal(disk, beforeDisk, 'planImport 不写存储')
  equal(storageWrites, beforeStorageWrites, 'planImport 不触发存储写入')
  equal(fsWrites, beforeFsWrites, 'planImport 不创建目录、复制或删除图片')
  equal(plan.value['tx-merge'].length, 2, '备份合并且保留本机现有附件')
  equal(plan.value['tx-merge'][0].name, '备份新名字.jpg', '同 id 附件以备份为准')
  equal(plan.value['tx-merge'][1].missing, undefined, '存在的有效路径不标记缺失')
  equal(plan.value['tx-missing'][0].missing, true, '备份坏路径标记 missing')
  equal({ added: plan.added, updated: plan.updated, missing: plan.missing }, { added: 2, updated: 1, missing: 1 }, '合并计数正确')
  equal(plan.changes[0].key, attachments.KEY, '合并计划使用指定存储键')
  wx.setStorageSync(plan.changes[0].key, plan.changes[0].value)
  var exported = attachments.exportData()
  equal(exported['tx-missing'][0].missing, true, '导出保留缺失标记')
  var repeat = attachments.planImport(exported)
  equal(repeat.changes, [], '再次导入相同备份无变更')

  reset()
  var outside = source('outside.jpg', Buffer.from('outside'))
  var tempExisting = source('temp-existing.jpg', Buffer.from('temp'))
  var valid = receipt('valid.jpg')
  var badPayload = {
    'tx-bad': [
      { id: 'outside', path: outside, name: '目录外.jpg', addedAt: 1 },
      { id: 'temp', path: tempExisting, name: '临时路径.jpg', addedAt: 2 },
      { id: 'remote', path: 'https://example.com/receipt.jpg', name: '网络地址.jpg', addedAt: 3 },
      { id: 'gone', path: userDir.replace(/\\/g, '/') + '/receipts/not-there.jpg', name: '不存在.jpg', addedAt: 4 },
      { id: 'directory', path: userDir.replace(/\\/g, '/') + '/receipts', name: '目录.jpg', addedAt: 5 },
      { id: 'valid', path: valid, name: '有效.jpg', addedAt: 6 },
      { id: 'broken', path: 123, name: '坏行.jpg', addedAt: 7 }
    ]
  }
  var badPlan = attachments.planImport(badPayload)
  equal(badPlan.value['tx-bad'].filter(function (row) { return row.missing }).length, 5, '目录外、临时、网络、缺失和目录路径均标记 missing')
  equal(badPlan.value['tx-bad'].filter(function (row) { return row.id === 'valid' })[0].missing, undefined, '坏路径不影响有效路径')
  equal(badPlan.skipped, 1, '坏元数据行跳过')
  wx.setStorageSync(attachments.KEY, badPlan.value)
  attachments.remove('tx-bad', 'outside')
  check(fs.existsSync(outside), '删除坏路径附件不会删除目录外文件')
  assert.throws(function () { attachments.planImport([]) }, /票据备份格式不对/)
  passed++
  assert.throws(function () { attachments.planImport({ 'tx-x': {} }) }, /票据备份格式不对/)
  passed++

  reset()
  var shared = receipt('shared.jpg')
  disk[attachments.KEY] = {
    'tx-share-a': [{ id: 'a', path: shared, name: '共享.jpg', addedAt: 1 }],
    'tx-share-b': [{ id: 'b', path: shared, name: '共享.jpg', addedAt: 2 }]
  }
  attachments.remove('tx-share-a', 'a')
  check(fs.existsSync(shared), '共享路径仍被其他流水引用时不删除文件')
  attachments.removeTx('tx-share-b')
  check(!fs.existsSync(shared), '最后一个引用删除后清理文件')

  reset()
  var rollbackSource = source('rollback.jpg')
  storageFailure = true
  assert.throws(function () { attachments.attach('tx-rollback', [rollbackSource]) }, /保存失败/)
  passed++
  storageFailure = false
  equal(disk[attachments.KEY], undefined, '元数据写入失败不留下半成品')
  var receiptFiles = fs.existsSync(path.join(userDir, 'receipts')) ? fs.readdirSync(path.join(userDir, 'receipts')) : []
  equal(receiptFiles, [], '元数据写入失败回滚已复制图片')
  assert.throws(function () { attachments.attach('tx-invalid', [path.join(tempDir, 'missing.jpg')]) }, /没有可添加/)
  passed++
  equal(attachments.list('tx-invalid'), [], '无效临时文件不写元数据')

  reset()
  disk.theme_v1 = 'ink'
  disk.txs_v1 = [tx('tx-page')]
  store.reload()
  systemDark = true
  var page = loadPage()
  page.onLoad({ txId: 'tx-page' })
  page.onShow()
  equal(navTitles[navTitles.length - 1], '流水票据', '页面设置标题')
  equal({ theme: page.data.themeKey, dark: page.data.dark }, { theme: 'ink', dark: true }, '页面跟随主题和深色模式')
  equal(page.data.tx.merchant, '测试商户', '页面显示流水摘要')
  equal(page.data.rows, [], '页面初始为空态')
  chosenPaths = [source('page.jpg')]
  page.chooseImages()
  equal(page.data.rows.length, 1, '页面添加后刷新图片网格')
  check(toasts.some(function (toast) { return /已添加 1 张/.test(toast.title) }), '添加成功有反馈')
  var pageId = page.data.rows[0].id
  page.preview({ currentTarget: { dataset: { id: pageId } } })
  check(page.data.previewVisible && page.data.previewRows.length === 1, '页面可预览图片')
  page.closePreview()
  page.askRemove({ currentTarget: { dataset: { id: pageId } } })
  equal(modals[modals.length - 1].title, '删除票据？', '删除前确认')
  modals[modals.length - 1].success({ confirm: true })
  equal(page.data.rows.length, 0, '页面删除后刷新空态')

  var pageMissing = attachments.attach('tx-page', [source('missing-page.jpg')]).items[0]
  fs.unlinkSync(pageMissing.path)
  page.refresh()
  equal(page.data.missingCount, 1, '页面统计缺失文件')
  equal(page.data.rows[0].missingText, '文件不存在，需重新添加', '页面明确提示重新添加')
  page.preview({ currentTarget: { dataset: { id: pageMissing.id } } })
  check(toasts.some(function (toast) { return toast.title === '文件不存在，请重新添加' }), '缺失图片点击后再次提示')
  check(!page.data.previewVisible, '缺失图片不进入预览')
  page.clearTx()
  modals[modals.length - 1].success({ confirm: true })
  equal(page.data.rows.length, 0, '页面支持清空流水票据')

  var noId = loadPage()
  noId.onLoad({})
  noId.onShow()
  check(/缺少流水 ID/.test(noId.data.error), '缺少 txId 时有错误反馈')
  noId.onUnload()
  page.onUnload()
  check(themeListener === null, '页面卸载取消深色监听')

  var wxml = fs.readFileSync(path.resolve(__dirname, '../pages/attachments/attachments.wxml'), 'utf8')
  var wxss = fs.readFileSync(path.resolve(__dirname, '../pages/attachments/attachments.wxss'), 'utf8')
  check(wxml.indexOf('文件不存在') >= 0 && wxml.indexOf('需重新添加') >= 0, 'WXML 包含缺失文件提示')
  check(wxss.indexOf('env(safe-area-inset-bottom)') >= 0 && wxss.indexOf('.attachments-page.dark') >= 0, 'WXSS 包含安全区和深色样式')

  reset()
  var largeA = source('compress-a.jpg', Buffer.alloc(4096, 7))
  var largeB = source('compress-b.jpg', Buffer.alloc(8192, 8))
  var largeC = source('compress-c.jpg', Buffer.alloc(2048, 9))
  var compressItems = attachments.attach('tx-compress', [largeA, largeB, largeC]).items
  var progress = []
  var compressed = await attachments.compress('tx-compress', [compressItems[0].id], {
    onProgress: function (state) { progress.push(state) }
  })
  equal({ compressed: compressed.compressed, failed: compressed.failed, skipped: compressed.skipped }, { compressed: 1, failed: 0, skipped: 0 }, '只压缩选中的一张图片')
  equal(compressCalls.length, 1, '单张压缩只调用一次 API')
  equal(compressCalls[0].quality, 65, '压缩质量约为 65')
  equal(compressCalls[0].srcPath, compressItems[0].path, '压缩使用受管原图路径')
  var compressedItem = compressed.items[0]
  check(compressedItem.path.indexOf(userDir.replace(/\\/g, '/') + '/receipts/') === 0, '压缩结果仍位于受管目录')
  check(compressedItem.path !== compressItems[0].path, '压缩结果使用新路径')
  check(!fs.existsSync(compressItems[0].path), '压缩提交后清理旧副本')
  equal(fs.readFileSync(compressedItem.path), Buffer.from('small'), '压缩图片已复制到受管目录')
  equal({ bytes: compressedItem.bytes, compressedFromBytes: compressedItem.compressedFromBytes }, { bytes: 5, compressedFromBytes: 4096 }, '记录压缩前后字节数')
  equal(compressed.savedBytes, 4091, '统计节省空间')
  check(typeof compressedItem.compressedAt === 'number', '记录压缩时间')
  check(/压缩\.jpg$/.test(compressedItem.name), '压缩后更新文件名')
  equal(compressed.items[1].compressedAt, undefined, '未选中的图片元数据不变')
  equal(progress, [{ completed: 1, total: 1, itemId: compressItems[0].id }], '单张压缩进度完整')
  equal(attachments.list('tx-compress')[0], compressedItem, '列表读取保持压缩元数据稳定')
  var stablePlan = attachments.planImport(attachments.exportData())
  equal(stablePlan.value['tx-compress'][0], compressedItem, '备份导入保持压缩元数据稳定')
  equal(stablePlan.changes, [], '相同压缩元数据重复导入无变化')

  reset()
  var mixed = attachments.attach('tx-mixed', [source('mixed-a.jpg', Buffer.alloc(1000)), source('mixed-b.jpg', Buffer.alloc(2000))]).items
  compressHandler = function (options) {
    if (options.srcPath === mixed[0].path) options.fail({ errMsg: 'compressImage:fail decode' })
    else options.success({ tempFilePath: source('mixed-result.jpg', Buffer.from('ok')) })
  }
  var mixedResult = await attachments.compress('tx-mixed')
  equal({ compressed: mixedResult.compressed, failed: mixedResult.failed, skipped: mixedResult.skipped }, { compressed: 1, failed: 1, skipped: 0 }, '单张压缩失败不阻断其他图片')
  equal(mixedResult.errors.length, 1, '压缩失败返回错误列表')
  equal(mixedResult.errors[0].id, mixed[0].id, '压缩错误对应失败附件')
  check(fs.existsSync(mixed[0].path), '压缩失败保留原图')
  equal(attachments.list('tx-mixed')[0], mixed[0], '压缩失败不改写原引用')
  check(fs.existsSync(mixedResult.items[1].path), '其他图片压缩成功')

  reset()
  var unavailableItems = attachments.attach('tx-no-api', [source('no-api-a.jpg'), source('no-api-b.jpg')]).items
  var unavailableBefore = clone(disk[attachments.KEY])
  delete wx.compressImage
  var unavailable = await attachments.compress('tx-no-api')
  equal({ compressed: unavailable.compressed, failed: unavailable.failed, degraded: unavailable.degraded }, { compressed: 0, failed: 2, degraded: true }, '压缩 API 缺失时明确降级')
  equal(unavailable.errors[0].code, 'API_UNAVAILABLE', 'API 缺失错误码明确')
  equal(disk[attachments.KEY], unavailableBefore, 'API 缺失不修改元数据')
  check(fs.existsSync(unavailableItems[0].path) && fs.existsSync(unavailableItems[1].path), 'API 缺失保留全部原图')
  equal(await attachments.compress('tx-no-api', []), { compressed: 0, failed: 0, skipped: 0, savedBytes: 0, degraded: false, errors: [], items: unavailable.items }, '空选择不执行压缩')

  reset()
  var metadataItem = attachments.attach('tx-write-fail', [source('write-fail.jpg', Buffer.alloc(3000))]).items[0]
  var metadataBefore = clone(disk[attachments.KEY])
  storageFailure = true
  var metadataFailure = await attachments.compress('tx-write-fail')
  storageFailure = false
  equal(metadataFailure.failed, 1, '元数据写入失败报告压缩失败')
  equal(disk[attachments.KEY], metadataBefore, '元数据写入失败不破坏旧引用')
  check(fs.existsSync(metadataItem.path), '元数据写入失败保留原图文件')
  equal(fs.readdirSync(path.join(userDir, 'receipts')), [path.basename(metadataItem.path)], '元数据写入失败清理新副本')

  reset()
  var oldPath = receipt('legacy.jpg', Buffer.alloc(1500))
  disk[attachments.KEY] = { 'tx-legacy': [{ id: 'legacy', path: oldPath, name: '旧票据.jpg', addedAt: 1, bytes: 'bad', unknown: true }] }
  equal(attachments.list('tx-legacy')[0].bytes, undefined, '旧附件与非法扩展字段兼容')
  var legacyResult = await attachments.compress('tx-legacy')
  equal(legacyResult.compressed, 1, '旧附件可压缩')
  equal(legacyResult.items[0].compressedFromBytes, 1500, '旧附件从文件补充原始字节数')
  equal(legacyResult.items[0].unknown, undefined, '压缩不保留未知元数据')

  reset()
  var unsafePath = receipt('safe-id.jpg', Buffer.alloc(1000))
  disk[attachments.KEY] = { 'tx-safe-id': [{ id: '../../escape', path: unsafePath, name: '特殊 ID.jpg', addedAt: 1 }] }
  var safeIdResult = await attachments.compress('tx-safe-id')
  equal(safeIdResult.compressed, 1, '含路径符号的旧附件 ID 仍可压缩')
  check(safeIdResult.items[0].path.indexOf(userDir.replace(/\\/g, '/') + '/receipts/') === 0, '附件 ID 不会造成压缩路径逃逸')
  check(safeIdResult.items[0].path.split('/').indexOf('..') < 0, '压缩路径不含父目录片段')

  reset()
  var outsideManaged = source('outside-managed.jpg', Buffer.from('keep'))
  disk[attachments.KEY] = { 'tx-outside': [{ id: 'outside', path: outsideManaged.replace(/\\/g, '/'), name: '目录外.jpg', addedAt: 1 }] }
  var outsideCompressed = await attachments.compress('tx-outside')
  var outsideExported = await attachments.exportToAlbum('tx-outside')
  equal({ compressed: outsideCompressed.compressed, skipped: outsideCompressed.skipped }, { compressed: 0, skipped: 1 }, '压缩跳过不受管路径')
  equal({ saved: outsideExported.saved, skipped: outsideExported.skipped }, { saved: 0, skipped: 1 }, '导出跳过不受管路径')
  equal(compressCalls.length + albumCalls.length, 0, '不受管图片不会传给压缩或相册 API')
  check(fs.existsSync(outsideManaged), '不受管图片不会被修改或删除')

  reset()
  var exportItems = attachments.attach('tx-export', [source('export-a.jpg'), source('export-b.jpg'), source('export-c.jpg')]).items
  albumHandler = function (options) {
    if (options.filePath === exportItems[1].path) options.fail({ errMsg: 'saveImageToPhotosAlbum:fail write' })
    else options.success({})
  }
  var exportProgress = []
  var partial = await attachments.exportToAlbum('tx-export', undefined, { onProgress: function (state) { exportProgress.push(state.completed) } })
  equal({ saved: partial.saved, failed: partial.failed, skipped: partial.skipped }, { saved: 2, failed: 1, skipped: 0 }, '相册导出支持部分成功')
  equal(partial.errors.length, 1, '相册导出返回错误列表')
  equal(albumCalls.length, 3, '相册逐张保存全部图片')
  equal(exportProgress, [1, 2, 3], '相册导出进度逐张更新')
  var oneExport = await attachments.exportToAlbum('tx-export', exportItems[0].id)
  equal({ saved: oneExport.saved, failed: oneExport.failed }, { saved: 1, failed: 0 }, '相册导出支持选择附件')
  equal(albumCalls[3].filePath, exportItems[0].path, '只保存选中的受管图片')

  reset()
  var permissionItems = attachments.attach('tx-permission', [source('permission-a.jpg'), source('permission-b.jpg')]).items
  albumHandler = function (options) { options.fail({ errMsg: 'saveImageToPhotosAlbum:fail auth deny' }) }
  authorizeHandler = function (options) { options.success({}) }
  var authorized = await attachments.exportToAlbum('tx-permission', permissionItems[0].id)
  equal({ saved: authorized.saved, failed: authorized.failed }, { saved: 0, failed: 1 }, '授权后保存仍失败时报告失败')
  equal(authorizeCalls[0].scope, 'writePhotosAlbum', '需要权限时调用 authorize')
  equal(albumCalls.length, 2, '授权成功后重试保存')
  authorizeCalls = []
  albumCalls = []
  albumHandler = function (options) {
    if (albumCalls.length === 1) options.fail({ errMsg: 'saveImageToPhotosAlbum:fail need auth' })
    else options.success({})
  }
  var retried = await attachments.exportToAlbum('tx-permission', permissionItems[0].id)
  equal(retried.saved, 1, '授权成功后重试可以导出')

  reset()
  var deniedItems = attachments.attach('tx-denied', [source('denied-a.jpg'), source('denied-b.jpg')]).items
  albumHandler = function (options) { options.fail({ errMsg: 'saveImageToPhotosAlbum:fail auth deny' }) }
  authorizeHandler = function (options) { options.fail({ errMsg: 'authorize:fail auth deny' }) }
  var denied = await attachments.exportToAlbum('tx-denied')
  equal({ saved: denied.saved, failed: denied.failed, skipped: denied.skipped, needsSettings: denied.needsSettings }, { saved: 0, failed: 1, skipped: 1, needsSettings: true }, '权限拒绝返回失败、跳过与设置引导标记')
  equal(denied.errors[0].code, 'PERMISSION_DENIED', '权限拒绝错误码明确')
  equal(albumCalls.length, 1, '权限拒绝后不重复请求其余图片')
  check(denied.errors[0].needsSettings, '错误列表提示前往设置')

  reset()
  var noAlbumItems = attachments.attach('tx-no-album', [source('no-album.jpg')]).items
  delete wx.saveImageToPhotosAlbum
  var noAlbum = await attachments.exportToAlbum('tx-no-album')
  equal({ saved: noAlbum.saved, failed: noAlbum.failed, degraded: noAlbum.degraded }, { saved: 0, failed: 1, degraded: true }, '相册 API 缺失时明确降级')
  equal(noAlbum.errors[0].code, 'API_UNAVAILABLE', '相册 API 缺失错误码明确')
  check(fs.existsSync(noAlbumItems[0].path), '相册 API 缺失不影响本地图片')

  reset()
  var pageBatchItems = attachments.attach('tx-page', [source('batch-a.jpg', Buffer.alloc(2000)), source('batch-b.jpg', Buffer.alloc(3000))]).items
  store.reload()
  disk.txs_v1 = [tx('tx-page')]
  store.reload()
  var batchPage = loadPage()
  batchPage.onLoad({ txId: 'tx-page' })
  batchPage.onShow()
  compressHandler = function (options) {
    if (options.srcPath === pageBatchItems[0].path) options.fail({ errMsg: 'compressImage:fail' })
    else options.success({ tempFilePath: source('batch-result.jpg', Buffer.from('tiny')) })
  }
  await batchPage.compressAll()
  equal({ action: batchPage.data.action, done: batchPage.data.progressDone, total: batchPage.data.progressTotal }, { action: '', done: 2, total: 2 }, '页面批量压缩展示完整进度并解除忙碌')
  check(/部分失败/.test(batchPage.data.feedback.title), '页面反馈批量压缩部分失败')
  check(batchPage.data.rows[0].compressedText && batchPage.data.rows[1].compressedText.indexOf('已压缩') === 0, '页面展示单张与批量压缩结果')
  compressHandler = function (options) { options.success({ tempFilePath: source('single-result.jpg', Buffer.from('one')) }) }
  await batchPage.compressOne({ currentTarget: { dataset: { id: pageBatchItems[0].id } } })
  equal(batchPage.data.rows[0].compressedText.indexOf('已压缩'), 0, '页面支持单张压缩')
  await batchPage.exportAll()
  check(/已导出 2 张/.test(batchPage.data.feedback.title), '页面反馈相册导出成功')
  check(/不生成 ZIP/.test(batchPage.data.feedback.detail), '页面明确不承诺 ZIP')

  albumHandler = function (options) { options.fail({ errMsg: 'saveImageToPhotosAlbum:fail auth deny' }) }
  authorizeHandler = function (options) { options.fail({ errMsg: 'authorize:fail auth deny' }) }
  await batchPage.exportAll()
  equal(modals[modals.length - 1].title, '需要相册权限', '页面权限拒绝时引导设置')
  check(/部分失败/.test(batchPage.data.feedback.title), '页面反馈导出部分失败')
  albumHandler = function (options) { options.success({}) }
  modals[modals.length - 1].success({ confirm: true })
  equal(settingCalls.length, 1, '用户确认后打开系统设置')
  await new Promise(function (resolve) { setImmediate(resolve) })
  equal(batchPage.data.action, '', '设置成功后自动重试并结束忙碌')
  check(/已导出 2 张/.test(batchPage.data.feedback.title), '开启权限并重试后反馈成功')
  batchPage.onUnload()

  check(wxml.indexOf('压缩全部') >= 0 && wxml.indexOf('导出到相册') >= 0 && wxml.indexOf('压缩这张') >= 0, 'WXML 包含批量与单张压缩、相册导出操作')
  check(wxml.indexOf('progressDone') >= 0 && wxml.indexOf('feedback') >= 0, 'WXML 包含进度与结果反馈')
  check(wxss.indexOf('.operation-panel') >= 0 && wxss.indexOf('.tile-compress') >= 0, 'WXSS 包含批量操作与单张压缩样式')

  console.log('通过 ' + passed + ' 项，失败 0 项')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
}

main().catch(function (error) {
  console.error(error)
  process.exitCode = 1
})
