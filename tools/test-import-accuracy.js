const assert = require('assert')
const zlib = require('zlib')
const bill = require('../cloudfunctions/parseBill/bill')
const xlsx = require('../cloudfunctions/parseBill/xlsx')
const parser = require('../utils/parser')
const ocrbill = require('../utils/ocrbill')
const billId = require('../utils/bill-id')
const refundpair = require('../utils/refundpair')

const disk = Object.create(null)
global.wx = {
  getStorageSync: (key) => key in disk ? disk[key] : '',
  setStorageSync: (key, value) => { disk[key] = value },
  removeStorageSync: (key) => { delete disk[key] },
  showToast() {}
}
const store = require('../utils/store')
let passed = 0
function check(value, message) { assert.ok(value, message); passed++ }

function makeZip(xml, options) {
  const opts = options || {}
  const name = Buffer.from('xl/worksheets/sheet1.xml')
  const raw = Buffer.from(xml)
  const method = opts.stored ? 0 : 8
  const compressed = opts.stored ? raw : zlib.deflateRawSync(raw)
  const declared = opts.declared === undefined ? raw.length : opts.declared
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(method, 8)
  local.writeUInt32LE(compressed.length, 18)
  local.writeUInt32LE(declared, 22)
  local.writeUInt16LE(name.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(method, 10)
  central.writeUInt32LE(compressed.length, 20)
  central.writeUInt32LE(declared, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt32LE(0, 42)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(central.length + name.length, 12)
  eocd.writeUInt32LE(local.length + name.length + compressed.length, 16)
  return Buffer.concat([local, name, compressed, central, name, eocd])
}

const alipayHeader = '交易时间,交易分类,交易对方,商品说明,收/支,金额,支付方式,交易状态,交易订单号,商家订单号,交易单号,备注'
const alipayRow = '2026-11-01 12:00:00,餐饮,星巴克,咖啡,支出,35.00,余额宝,交易成功,ORDER001,MERCHANT001,SN001,早餐'
let parsed = bill.parseAlipay(alipayHeader + '\n' + alipayRow)
check(parsed.items.length === 1 && parsed.items[0].a === 35, '支付宝标准表头从金额列读取，不把支付方式当金额')
check(parsed.items[0].m === '星巴克' && parsed.items[0].d === '咖啡' && parsed.items[0].sn === 'ORDER001', '支付宝商户、商品和交易订单号按表头定位')

const reordered = bill.parseAlipay([
  '备注,金额,交易时间,收/支,交易对方,商品说明,交易分类,支付方式,交易状态,交易订单号,商家订单号,交易单号',
  '重排,35.00,2026-11-01 12:00:00,支出,星巴克,咖啡,餐饮,余额宝 1234.56,交易成功,ORDER001,MERCHANT001,SN001'
].join('\n'))
check(reordered.items[0].a === 35 && reordered.items[0].sn === 'ORDER001', '支付宝重排表头仍读取正确金额与订单号')

const ocr = ocrbill.parseItems([{ text: '招商银行 星巴克消费35.00元，余额1234.56元' }], {})
check(ocr.items.length === 1 && ocr.items[0].amount === 35, '无坐标 OCR 单行文本剔除余额，不把余额当交易额')

const sn = '2026110100000000000000000001'
const text = parser.parse([
  '交易时间\t交易分类\t交易对方\t商品说明\t收/支\t金额\t支付方式\t交易状态\t交易订单号\t备注',
  ['2026-11-01 12:00:00', '餐饮', '星巴克', '咖啡', '支出', '35.00', '余额宝', '交易成功', sn, ''].join('\t')
].join('\n'), {})
check(text.items.length === 1, '文本账单解析成功')
const fromBill = ocrbill.fromBill([{
  t: new Date(2026, 10, 1, 12).getTime(), a: 35, ty: 'expense', m: '星巴克', d: '咖啡',
  raw: '餐饮', pc: '餐饮', sn, s: '支付宝'
}], {})
const detailRows = [
  { text: '星巴克', left: 0, top: 0, height: 20 },
  { text: '¥35.00', left: 0, top: 30, height: 44 },
  { text: '支付时间 2026-11-01 12:00:00', left: 0, top: 80, height: 20 },
  { text: '交易单号 ' + sn, left: 0, top: 105, height: 20 }
]
const detail = ocrbill.parseDetail(ocrbill.groupRows(detailRows), { y: 2026, m: 11, d: 24, ts: Date.now() }, {}, detailRows.map((r) => r.text).join(' '), '支付宝')
check(text.items[0].id === fromBill.items[0].id && text.items[0].id === detail.items[0].id, '文本、文件与详情截图三条导入路径生成同一交易 ID')

const legacyId = billId.legacyTradeNoId('支付宝', sn)
const oldRecord = Object.assign({}, text.items[0], { id: legacyId })
delete oldRecord.legacyId
disk.txs_v1 = [oldRecord]
disk.gone_v1 = {}
store.reload()
const dedupe = store.previewAdd([fromBill.items[0]])
check(dedupe.added === 0 && dedupe.dup === 1, '统一 ID 后仍能识别升级前文本解析器入库的老记录')

check(store.remove(oldRecord.id), '删除带单号流水成功')
const backup = store.exportAll()
check(backup.gone && backup.gone[oldRecord.id] > 0, '全量备份携带删除墓碑')
disk.txs_v1 = []
disk.gone_v1 = {}
store.reload()
const restored = store.importAll({ version: 1, txs: [], gone: backup.gone })
check(restored.saved === true && store.gone()[oldRecord.id] > 0, '空流水备份可恢复删除墓碑')
const conflict = store.importAll({ version: 1, txs: [oldRecord], gone: backup.gone })
check(conflict.added === 0 && conflict.skipped === 1 && store.all().length === 0, '恢复时墓碑优先，同名流水不会复活')
assert.throws(() => store.importAll({ version: 1, txs: [], gone: { bad: 'yesterday' } }), /格式不对/)
passed++

const wrongPair = refundpair.pair([
  { id: 'sinopec', type: 'expense', merchant: '中国石化', amount: 100, time: new Date(2026, 10, 1).getTime() },
  { id: 'mobile', type: 'refund', merchant: '中国移动', amount: 100, time: new Date(2026, 10, 2).getTime() }
])
check(wrongPair.pairs.length === 0 && wrongPair.unmatched.length === 1, '退款配对不再因通用两字词中国而错配')

const normalXlsx = makeZip('<worksheet><row><c r="A1"><v>ok</v></c></row></worksheet>')
check(xlsx.readSheet(normalXlsx)[0][0] === 'ok', '正常 xlsx 仍可解析')
assert.throws(() => xlsx.readSheet(makeZip('<worksheet/>', { declared: 33 * 1024 * 1024 })), /体积过大/)
passed++
const tooManyEntries = makeZip('<worksheet/>')
tooManyEntries.writeUInt16LE(513, tooManyEntries.length - 12)
assert.throws(() => xlsx.readSheet(tooManyEntries), /条目过多/)
passed++
assert.throws(() => xlsx.readSheet(makeZip('<worksheet><row><c r="IW1"><v>x</v></c></row></worksheet>')), /列数超过限制/)
passed++
assert.throws(() => xlsx.readSheet(makeZip('<worksheet>' + '<row></row>'.repeat(50001) + '</worksheet>')), /行数超过限制/)
passed++
assert.throws(() => xlsx.readSheet(makeZip('<worksheet><row><c r="A1"><v>x</v></c></row></worksheet>', { declared: 1 })), /大小校验失败/)
passed++

console.log('通过 ' + passed + ' 项，失败 0 项')
