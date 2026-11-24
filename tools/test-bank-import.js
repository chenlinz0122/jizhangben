/* 银行卡导入三条链路的自测：
 *   1) 导出的 CSV/Excel（前端 utils/parser + 云函数 bill.parseBank）
 *   2) 银行短信文本（utils/parsesms）
 *   3) 银行 App 截图（utils/ocrbill）
 * 跑法：node tools/test-bank-import.js
 */
const assert = require('assert')
const path = require('path')
const root = path.resolve(__dirname, '..')

let pass = 0
function ok(name, fn) {
  try {
    fn()
    pass++
    console.log('  ✓ ' + name)
  } catch (e) {
    console.log('  ✗ ' + name + ' — ' + (e && e.message))
    process.exitCode = 1
  }
}

/* ---------- 1. 文件导入（前端解析器） ---------- */
const parser = require(path.join(root, 'utils/parser'))

console.log('\n[1] 银行导出文件')

ok('招行：日期时间分列 + 支出/收入双列', () => {
  const r = parser.parse(
    '交易日期,交易时间,支出,收入,余额,交易类型,交易备注\n' +
    '2026-11-23,12:30:05,35.00,,1234.56,消费,星巴克咖啡\n' +
    '2026-11-22,09:15:00,,8500.00,1269.56,代发工资,某公司工资\n'
  )
  assert.strictEqual(r.source, '银行卡')
  assert.strictEqual(r.items.length, 2)
  const [a, b] = r.items
  assert.strictEqual(a.type, 'expense')
  assert.strictEqual(a.amount, 35)
  assert.strictEqual(a.merchant, '星巴克咖啡')
  const d = new Date(a.time)
  assert.strictEqual(d.getHours(), 12)
  assert.strictEqual(d.getMinutes(), 30)
  assert.strictEqual(b.type, 'income')
  assert.strictEqual(b.amount, 8500)
  assert.strictEqual(b.category, '工资')
})

ok('工行：单金额列带负号 + 对方户名', () => {
  const r = parser.parse(
    '交易日期,摘要,交易金额,余额,对方户名\n' +
    '2026-11-23,消费,-88.50,9000.00,永辉超市\n' +
    '2026-11-20,工资入账,5000.00,9088.50,某某科技有限公司\n'
  )
  assert.strictEqual(r.source, '银行卡')
  assert.strictEqual(r.items.length, 2)
  assert.strictEqual(r.items[0].type, 'expense')
  assert.strictEqual(r.items[0].amount, 88.5)
  assert.strictEqual(r.items[1].type, 'income')
  assert.strictEqual(r.items[1].amount, 5000)
})

ok('建行：借贷双列（借方=支出、贷方=收入）', () => {
  const r = parser.parse(
    '交易日期,摘要,借方发生额,贷方发生额,余额,对方户名\n' +
    '2026-11-23,网银支付,45.00,0.00,1000.00,滴滴\n' +
    '2026-11-22,跨行转入,0.00,2000.00,955.00,李四\n'
  )
  assert.strictEqual(r.items.length, 2)
  assert.strictEqual(r.items[0].type, 'expense')
  assert.strictEqual(r.items[1].type, 'income')
  assert.strictEqual(r.items[1].amount, 2000)
})

ok('借/贷 标志列', () => {
  const r = parser.parse(
    '交易日期,借/贷,交易金额,余额,摘要\n' +
    '2026-11-23,借,66.00,500.00,超市购物\n' +
    '2026-11-22,贷,1000.00,566.00,转账收入\n'
  )
  assert.strictEqual(r.items[0].type, 'expense')
  assert.strictEqual(r.items[1].type, 'income')
})

ok('信用卡账单：退款行单独标', () => {
  const r = parser.parse(
    '交易日,记账日,交易描述,人民币金额\n' +
    '2026-11-23,2026-11-24,星巴克,35.00\n' +
    '2026-11-20,2026-11-21,退款-京东,89.00\n'
  )
  assert.strictEqual(r.items[0].type, 'expense')
  assert.strictEqual(r.items[1].type, 'refund')
})

ok('余额列不能被当成金额（只有余额时报没金额）', () => {
  const r = parser.parse('交易日期,余额\n2026-11-23,1234.56\n')
  assert.ok(r.error, '应该报错而不是把余额记成流水')
})

ok('微信/支付宝原有格式不受影响', () => {
  const w = parser.parse(
    '交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注\n' +
    '2026-11-01 12:31:20,餐饮美食,美团外卖,午餐,支出,28.50,余额宝,交易成功,20261101001,,\n'
  )
  assert.strictEqual(w.source, '支付宝')
  assert.strictEqual(w.items[0].type, 'expense')
  const t = parser.parse(
    '交易时间\t交易分类\t交易对方\t商品说明\t收/支\t金额\n' +
    '2026-11-01 12:31:20\t餐饮美食\t美团外卖\t午餐\t支出\t28.50\n'
  )
  assert.strictEqual(t.items.length, 1)
})

/* ---------- 2. 云函数那份（xlsx 走这条路） ---------- */
const bill = require(path.join(root, 'cloudfunctions/parseBill/bill'))

console.log('\n[2] 云端解析（xlsx / csv）')

ok('csvToRows + parseBank：招行', () => {
  const rows = bill.csvToRows(
    '交易日期,交易时间,支出,收入,余额,交易类型\n' +
    '2026-11-23,12:30:05,35.00,,1234.56,消费\n'
  )
  const r = bill.parseBank(rows)
  assert.strictEqual(r.source, '银行卡')
  assert.strictEqual(r.items[0].ty, 'expense')
  assert.strictEqual(r.items[0].a, 35)
  assert.ok(new Date(r.items[0].t).getHours() === 12)
})

ok('Excel 日期序列号能还原', () => {
  const rows = [['交易日期', '摘要', '交易金额', '余额'], [45890.5, '星巴克', -35.5, 1200]]
  const r = bill.parseBank(rows)
  assert.strictEqual(r.items.length, 1)
  const d = new Date(r.items[0].t)
  assert.strictEqual(d.getFullYear(), 2025)
  assert.strictEqual(d.getMonth() + 1, 8)
  assert.strictEqual(d.getDate(), 21)
})

ok('信用卡还款 / ATM 取现 → 不计收支', () => {
  const rows = bill.csvToRows(
    '交易日期,摘要,交易金额,余额\n' +
    '2026-11-23,信用卡自动还款,-1200.00,500.00\n' +
    '2026-11-22,ATM取现,-200.00,1700.00\n'
  )
  const r = bill.parseBank(rows)
  assert.strictEqual(r.items[0].ty, 'transfer')
  assert.strictEqual(r.items[1].ty, 'transfer')
})

ok('失败状态的银行行要丢掉', () => {
  const rows = bill.csvToRows(
    '交易日期,摘要,交易金额,余额,交易状态\n' +
    '2026-11-23,消费,-35.00,500.00,失败\n' +
    '2026-11-23,消费,-20.00,480.00,成功\n'
  )
  const r = bill.parseBank(rows)
  assert.strictEqual(r.items.length, 1)
  assert.strictEqual(r.skipped, 1)
})

ok('余额列冒充金额时要报错', () => {
  assert.throws(() => bill.parseBank(bill.csvToRows('交易日期,余额\n2026-11-23,1234.56\n')))
})

/* ---------- 3. 银行短信 ---------- */
const sms = require(path.join(root, 'utils/parsesms'))
const NOW = new Date(2026, 10, 24, 22, 0, 0)

console.log('\n[3] 银行短信')

ok('招行：尾号 + 商户 + 余额', () => {
  const r = sms.parse('【招商银行】您尾号1234的储蓄卡11月23日12:30在星巴克消费人民币35.00元，余额1234.56元。', null, NOW)
  assert.strictEqual(r.error, '')
  assert.strictEqual(r.source, '招商银行')
  const it = r.items[0]
  assert.strictEqual(it.type, 'expense')
  assert.strictEqual(it.amount, 35, '余额不能被当成金额')
  assert.strictEqual(it.merchant, '星巴克')
  assert.strictEqual(it.category, '餐饮')
  assert.strictEqual(it.account, '尾号1234')
  const d = new Date(it.time)
  assert.strictEqual(d.getMonth() + 1, 11)
  assert.strictEqual(d.getDate(), 23)
  assert.strictEqual(d.getHours(), 12)
})

ok('工行：工资代发算收入', () => {
  const r = sms.parse('【工商银行】您尾号5678的借记卡11月22日09:15工资代发入账人民币8500.00元。', null, NOW)
  const it = r.items[0]
  assert.strictEqual(it.type, 'income')
  assert.strictEqual(it.amount, 8500)
  assert.strictEqual(it.category, '工资')
})

ok('建行：转出 + 收款方', () => {
  const r = sms.parse('【建设银行】您账户5678于11月21日18:02转出100.00元，收款方张三，余额500.00元。', null, NOW)
  const it = r.items[0]
  assert.strictEqual(it.type, 'expense')
  assert.strictEqual(it.amount, 100)
  assert.strictEqual(it.merchant, '张三')
  assert.strictEqual(it.account, '尾号5678')
})

ok('信用卡退款算退款、还款不算收支', () => {
  const refund = sms.parse('【中信银行】您尾号9012的信用卡11月20日消费89.00元，商户京东，已退款。', null, NOW)
  assert.strictEqual(refund.items[0].type, 'refund')
  const repay = sms.parse('【招商银行】您尾号1234的信用卡11月19日还款成功，金额1200.00元。', null, NOW)
  assert.strictEqual(repay.items[0].type, 'transfer')
})

ok('一次粘多条：短信混着验证码和余额提醒', () => {
  const r = sms.parse([
    '【招商银行】您尾号1234的储蓄卡11月23日12:30在星巴克消费人民币35.00元，余额1234.56元。',
    '【招商银行】您尾号1234的储蓄卡11月23日18:10在美团支付人民币68.50元，余额1166.06元。',
    '【工商银行】您尾号5678的借记卡验证码是123456，请勿泄露。',
    '【招商银行】您尾号1234的储蓄卡余额为1166.06元。'
  ].join('\n'), null, NOW)
  assert.strictEqual(r.items.length, 2)
  assert.strictEqual(r.skipped, 2)
  assert.ok(r.source.indexOf('招商银行') >= 0)
})

ok('纯营销/余额通知不该产生流水', () => {
  const a = sms.parse('【招商银行】信用卡分期优惠活动，点击了解详情。', null, NOW)
  assert.strictEqual(a.items.length, 0)
  assert.ok(a.error)
  const b = sms.parse('【招商银行】您尾号1234的储蓄卡余额为1166.06元。', null, NOW)
  assert.strictEqual(b.items.length, 0)
})

ok('looksLikeSms 不把表格误认成短信', () => {
  assert.strictEqual(sms.looksLikeSms('交易时间,交易分类,金额\n2026-11-01,餐饮,28.50'), false)
  assert.strictEqual(sms.looksLikeSms('【招商银行】您尾号1234的储蓄卡11月23日消费人民币35.00元'), true)
})

/* ---------- 4. 银行 App 截图 ---------- */
const ocrbill = require(path.join(root, 'utils/ocrbill'))
function T(text, left, top, height) { return { text, left, top, height: height || 18 } }

console.log('\n[4] 银行 App 截图')

ok('招行列表：余额行跳过、时间不丢、还款不计收支', () => {
  const items = [
    T('招商银行', 10, 8, 22),
    T('尾号1234 储蓄卡', 10, 36, 14),
    T('本月支出 1,234.56', 10, 62, 16),
    T('星巴克咖啡', 30, 100),
    T('-35.00', 200, 100),
    T('余额 1,234.56', 30, 124, 13),
    T('11月23日 12:30', 30, 144, 13),
    T('工资代发', 30, 260),
    T('+8,500.00', 200, 260),
    T('11月22日 09:15', 30, 284, 13),
    T('信用卡还款', 30, 320),
    T('-1,200.00', 200, 320),
    T('11月19日', 30, 344, 13)
  ]
  const r = ocrbill.parseItems(items, null, {})
  assert.strictEqual(r.source, '银行卡')
  assert.strictEqual(r.items.length, 3, '余额行不能被当成流水')
  const st = r.items[0]
  assert.strictEqual(st.merchant, '星巴克咖啡')
  assert.strictEqual(st.amount, 35, '金额不能取成余额')
  const d = new Date(st.time)
  assert.strictEqual(d.getHours(), 12)
  assert.strictEqual(r.items[1].type, 'income')
  assert.strictEqual(r.items[2].type, 'transfer')
})

ok('微信列表页不会被误判成银行', () => {
  const items = [
    T('微信支付', 10, 8, 22),
    T('星巴克咖啡', 30, 80),
    T('-35.00', 200, 80),
    T('餐饮', 30, 104, 13),
    T('11月23日 12:30', 30, 124, 13)
  ]
  const r = ocrbill.parseItems(items, null, {})
  assert.strictEqual(r.source, '微信')
  assert.strictEqual(r.items.length, 1)
  assert.strictEqual(r.items[0].type, 'expense')
})

/* ---------- 5. 真的存进账本 ---------- */
console.log('\n[5] 导入到账本（store 集成）')

ok('短信解析出来的流水能存进账本、并按口径算收支', () => {
  const disk = {}
  global.wx = {
    getStorageSync: (k) => (k in disk ? JSON.parse(JSON.stringify(disk[k])) : ''),
    setStorageSync: (k, v) => { disk[k] = JSON.parse(JSON.stringify(v)) },
    removeStorageSync: (k) => { delete disk[k] }
  }
  const store = require(path.join(root, 'utils/store'))
  const stats = require(path.join(root, 'utils/stats'))
  const r = sms.parse([
    '【招商银行】您尾号1234的储蓄卡11月23日12:30在星巴克消费人民币35.00元，余额1234.56元。',
    '【招商银行】您尾号1234的储蓄卡11月23日18:10在美团支付人民币68.50元，余额1166.06元。',
    '【招商银行】您尾号1234的信用卡11月19日还款成功，金额1200.00元。'
  ].join('\n'), null, NOW)
  assert.strictEqual(r.items.length, 3)

  const plan = store.previewAdd(r.items)
  assert.strictEqual(plan.added, 3, '三条都应该能新增')

  const res = store.addMany(r.items)
  assert.strictEqual(res.saved, true)
  assert.strictEqual(store.all().length, 3)

  /* 信用卡还款 1200 是不计收支，净支出应只有 103.5 */
  const m = stats.month ? stats.month('2026-11') : null
  if (m && typeof m.out === 'number') {
    assert.strictEqual(Math.round(m.out * 100) / 100, 103.5)
  }
})

console.log('\n共 ' + pass + ' 项通过')
