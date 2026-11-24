/* 账单文件 → 标准流水（纯函数，方便自测）
 * 支持：
 *   微信支付账单 .xlsx（个人对账导出的那版）
 *   支付宝交易明细 .csv（GBK 或 UTF-8 都行，调用方先解码）
 */

function pad(n) { return n < 10 ? '0' + n : String(n) }

/* Excel 日期序列号 → 毫秒（序列号是「墙上时间」，要按本地时间还原） */
function serialToMs(n) {
  var ms = (Number(n) - 25569) * 86400000
  if (!isFinite(ms)) return null
  var d = new Date(ms)
  return new Date(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()
  ).getTime()
}

/* 'YYYY-MM-DD HH:mm:ss' / 'YYYY/MM/DD HH:mm' → 毫秒 */
function textToMs(s) {
  var m = String(s).match(/(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})(?:[ T日]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/)
  if (!m) return null
  return new Date(
    parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10),
    parseInt(m[4] || '0', 10), parseInt(m[5] || '0', 10), parseInt(m[6] || '0', 10)
  ).getTime()
}

function num(s) {
  var n = Number(String(s).replace(/[^\d.-]/g, ''))
  return isFinite(n) ? n : 0
}

function trim(s) {
  return String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim()
}

/* ---------- 统一的类型判定（微信 / 支付宝共用一张表） ----------
 * 输出 kind：
 *   expense  真实花销（支出）
 *   income   真实进账（工资、别人还钱、理财收益、信用卡转进…）
 *   refund   退款到账（同样算进账，但单独标出来）
 *   move     资金在自己账户之间搬（不计收支）：moveKind = 理财 / 信用卡 / 转账
 * 判定顺序固定，任何平台差异只体现在「进 words 的原始字段」上，不再各写一套。
 */

function moveKindOf(words) {
  if (/零钱通|理财通|余额宝|基金|活期|定期|国债|黄金|赎回|申购|理财|收益再投/.test(words)) return '理财'
  if (/借出|借入|借款|收回借款/.test(words)) return '借还款'
  if (/信用卡|花呗|借呗|白条|还款|提现|零钱充值|充值到零钱|小荷包/.test(words)) return '账户转移'
  return ''
}

/* 真正的「自己账户之间搬钱」：只认理财申购赎回、还信用卡、零钱提现/充值 */
var MOVE_OUT = /零钱通|理财通|余额宝|基金|活期|定期|国债|黄金|申购|赎回|理财|信用卡还款|花呗还款|借呗还款|白条还款|零钱提现|提现到银行卡|提现到微信零钱|提现到支付宝|充值到零钱|零钱充值|小荷包/

/* io：原始「收/支」列；typ：交易类型/交易分类；其余是商户、商品、备注 */
function classifyRow(io, typ, merchant, product, remark) {
  var words = [typ, merchant, product, remark].join('|')
  var ioText = String(io || '')
  var neutral = !ioText || ioText === '/' || /不计收支/.test(ioText)
  var isIn = /收入/.test(ioText)
  var isOut = /支出/.test(ioText)

  /* 1. 理财收益：口径是「理财账户自己涨了」，不是外部进账 → 不计收支 / 理财。
   *    「收益发放 / 收益入账」这类字眼一律走理财；「分红 / 利息」仍按真实进账算收入。 */
  if (/收益发放|收益入账|理财收益|余额宝收益/.test(words) && !/申购|赎回|转入|转出/.test(words)) {
    return { kind: 'move', moveKind: '理财' }
  }
  if (/分红|利息/.test(words) && !/申购|赎回|转入|转出/.test(words)) {
    return { kind: 'income', moveKind: '' }
  }

  /* 2. 信用卡转进（溢缴款转回、转进零钱）——本质还是自己账户之间搬钱，不计收支；
   *    还款是另一条路（MOVE_OUT），也别在这里抢掉 */
  if (/信用卡|花呗|白条/.test(words) && /转进|转入|退回|溢缴|转回/.test(words) && !/还款/.test(words)) {
    return { kind: 'move', moveKind: '账户转移' }
  }

  /* 2.5 银行卡转进微信/支付宝（账单里叫「零钱充值」「网银充值」「转入零钱通-来自XX银行」）
   *     银行卡流水本身不进账本，这笔只是「钱从卡搬到钱包」，两边都是用户自己的账户
   *     → 不计收支 / 账户转移；反方向的「提现到银行卡」同理 */
  if ((/零钱充值|充值到零钱|网银充值|银行卡转入|来自银行卡|来自储蓄卡/.test(words) ||
       /转入.{0,12}来自.{0,12}(银行|储蓄卡)/.test(words)) && !/提现|转出到银行卡/.test(words)) {
    return { kind: 'move', moveKind: '账户转移' }
  }

  /* 2.6 反方向：微信/支付宝 → 银行卡（零钱提现、零钱通转出到银行、余额宝转出到银行卡）
   *     钱提回自己卡里，没有离开用户 → 同样不计收支 */
  if (!/信用卡|花呗|白条|还款/.test(words) &&
      /零钱提现|提现到银行卡|转出到银行卡|转出.{0,10}到.{0,12}(银行|储蓄卡)/.test(words)) {
    return { kind: 'move', moveKind: '账户转移' }
  }

  var mk = moveKindOf(words)

  /* 3. 「/」= 原文自己说这笔不计收支。但要先挑出两类特殊的：
   *    基金「买入退款」是申购失败退回，属理财搬钱，不能当收入（否则凭空多一笔入账）
   *    其余「退款 / 退货」虽然原文标不计收支，钱是真的回到口袋 → 算退款入账 */
  if (neutral) {
    if (/买入退款|申购退款|认购退款/.test(words)) return { kind: 'move', moveKind: '理财' }
    if (/退款|退货/.test(words)) return { kind: 'refund', moveKind: '' }
    return { kind: 'move', moveKind: mk || '账户转移' }
  }

  /* 4. 进账方向：退款单独标，其余都是收入（信用卡转进、别人还钱都在这里）
   *    例外：提现到自己的另一个钱包，是账户间搬钱，不是收入 */
  if (isIn) {
    if (/提现到微信零钱|提现到支付宝/.test(words)) {
      return { kind: 'move', moveKind: '账户转移' }
    }
    if (/退款|退货/.test(words)) return { kind: 'refund', moveKind: '' }
    return { kind: 'income', moveKind: '' }
  }

  /* 5. 出账方向：只有真正在自己账户间搬钱的不叫花销。
   *    转给爸妈朋友、发红包、话费充值、公交卡充值、缴社保 —— 钱出去了就是支出 */
  if (isOut) {
    if (MOVE_OUT.test(words)) return { kind: 'move', moveKind: mk || '账户转移' }
    return { kind: 'expense', moveKind: '' }
  }

  /* 6. 方向不明（个别老格式）→ 保守当资金搬移 */
  return { kind: 'move', moveKind: mk || '账户转移' }
}

function parseWechat(rows) {
  var head = -1
  for (var i = 0; i < rows.length; i++) {
    var t = (rows[i] || []).join('')
    if (/交易时间/.test(t) && /金额/.test(t)) { head = i; break }
  }
  if (head < 0) throw new Error('不是微信支付账单：找不到「交易时间 / 金额」表头')

  var items = []
  var skipped = 0
  for (var r = head + 1; r < rows.length; r++) {
    var row = rows[r] || []
    var timeCell = trim(row[0])
    var amount = num(row[5])
    if (!timeCell || !amount) { skipped++; continue }
    if (/[合计总计]/.test(trim(row[0]) + trim(row[1]))) { skipped++; continue }

    var ts = /^\d+(\.\d+)?$/.test(timeCell) ? serialToMs(timeCell) : textToMs(timeCell)
    if (!ts) { skipped++; continue }

    var typ = trim(row[1])
    var merchant = trim(row[2])
    var product = trim(row[3])
    var inout = trim(row[4])
    var status = trim(row[7])
    var remark = trim(row[10])

    if (product === '/') product = ''
    if (merchant === '/' || merchant === '.' || merchant === '..' || !merchant) {
      /* 微信把「对方昵称」隐藏成 "."，真名藏在这条转账备注里 */
      merchant = product.replace(/^转账备注[:：]/, '') || typ || '微信支付'
    }

    var cls = classifyRow(inout, typ, merchant, product, remark)

    items.push({
      t: ts,
      a: Math.abs(amount),
      k: cls.kind,
      mk: cls.moveKind,
      ty: cls.kind === 'move' ? 'transfer' : cls.kind,
      io: inout,
      raw: typ,
      m: merchant.slice(0, 40),
      d: product.slice(0, 40),
      pc: '',
      sn: trim(row[8]).slice(0, 64),
      s: '微信'
    })
  }
  return { source: '微信', items: items, skipped: skipped }
}

/* ---------- 支付宝 ---------- */

function splitCsvLine(line) {
  var out = []
  var cur = ''
  var inQ = false
  for (var i = 0; i < line.length; i++) {
    var ch = line.charAt(i)
    if (ch === '"') {
      if (inQ && line.charAt(i + 1) === '"') { cur += '"'; i++ }
      else inQ = !inQ
    } else if (ch === ',' && !inQ) {
      out.push(cur); cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out
}

function alipayType() { /* 已并入 classifyRow，保留空壳避免旧引用报错 */ }

function parseAlipay(text) {
  var lines = String(text).split(/\r?\n/)
  var head = -1
  for (var i = 0; i < lines.length; i++) {
    var cells = splitCsvLine(lines[i])
    if (/交易时间/.test(cells[0] || '') && /金额/.test(lines[i])) { head = i; break }
  }
  if (head < 0) throw new Error('不是支付宝交易明细：找不到「交易时间 / 金额」表头')

  var items = []
  var skipped = 0
  for (var r = head + 1; r < lines.length; r++) {
    var line = lines[r]
    if (!trim(line)) { skipped++; continue }
    var c = splitCsvLine(line)
    if (c.length < 8) { skipped++; continue }

    var ts = textToMs(trim(c[0]))
    var amount = num(c[6])
    /* 金额为 0 的记录也保留（支付宝里有「订单关闭」这类 0 元行），交给前端决定怎么处理 */
    if (!ts) { skipped++; continue }

    var cat = trim(c[1])
    var merchant = trim(c[2])
    var product = trim(c[4])
    var inout = trim(c[5])
    var remark = trim(c[11])
    if (product === '/') product = ''
    if (!merchant || merchant === '/' || merchant === '.') {
      merchant = product.replace(/^转账备注[:：]/, '') || cat || '支付宝'
    }

    var cls = classifyRow(inout, cat, merchant, product, remark)

    items.push({
      t: ts,
      a: Math.abs(amount),
      k: cls.kind,
      mk: cls.moveKind,
      ty: cls.kind === 'move' ? 'transfer' : cls.kind,
      io: inout,
      raw: cat,
      m: merchant.slice(0, 40),
      d: product.slice(0, 40),
      pc: cat === '其他' ? '' : cat,
      sn: trim(c[9]).slice(0, 64),
      s: '支付宝'
    })
  }
  return { source: '支付宝', items: items, skipped: skipped }
}

/* ---------- 银行卡流水 ----------
 * 银行 App / 网银导出的 Excel、CSV 各行列名都不一样，所以按列名定位，不写死列序。
 * 只负责「读成一条条流水」，方向判到 expense/income/refund/move，分类交给小程序端。
 */
function normKey(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/[\s"'*]/g, '')
    .replace(/[（）]/g, function (m) { return m === '（' ? '(' : ')' })
}

var BANK_COL = {
  time: ['交易时间', '交易日期', '记账日期', '记账日', '交易日', '入账日期', '发生日期', '时间', '日期'],
  clock: ['交易时间', '交易时刻', '时间', '入账时间'],
  io: ['收/支', '收支', '借/贷', '借贷标志', '借贷', '收支标志', '收付标志', '交易方向', '方向'],
  amount: ['金额', '金额(元)', '交易金额', '交易金额(元)', '发生金额', '发生额', '人民币金额', '收支金额', '交易额'],
  inAmount: ['收入金额', '收入', '贷方金额', '贷方发生额', '贷方', '存入金额', '收款金额', '转入金额'],
  outAmount: ['支出金额', '支出', '借方金额', '借方发生额', '借方', '支取金额', '付款金额', '转出金额'],
  merchant: ['交易对方', '对方户名', '对方名称', '对方账户名称', '商户名称', '商户', '收款方', '付款人', '收款人', '交易对手', '对方'],
  desc: ['摘要', '交易摘要', '用途', '附言', '备注', '交易备注', '交易说明', '商品说明', '交易描述'],
  tradeNo: ['交易流水号', '流水号', '交易号', '账务流水号', '凭证号', '参考号', '订单号'],
  status: ['交易状态', '状态', '交易结果', '处理状态'],
  pay: ['卡号', '账号', '交易卡号', '本方账号', '账户'],
  balance: ['余额', '账户余额', '交易后余额', '可用余额', '本次余额'],
  wtype: ['交易类型', '业务类型', '交易种类', '业务种类']
}

function findBankCol(headerCells, aliases) {
  var keys = headerCells.map(normKey)
  for (var i = 0; i < keys.length; i++) {
    for (var j = 0; j < aliases.length; j++) {
      if (keys[i] === normKey(aliases[j])) return i
    }
  }
  for (var a = 0; a < aliases.length; a++) {
    var ak = normKey(aliases[a])
    if (!ak) continue
    for (var b = 0; b < keys.length; b++) {
      if (keys[b].indexOf(ak) >= 0) return b
    }
  }
  return -1
}

/* 自己账户之间搬钱（不算花销，也不算进账）：还信用卡、理财申购赎回、ATM 取现回自己手上 */
var BANK_MOVE = /信用卡还款|还信用卡|自动还款|还款成功|理财|基金|申购|赎回|定期|活期|通知存款|国债|保证金|取现|取款|ATM|零钱通|余额宝|提现/

/* 方向判定：先看列（借贷/收支/双金额），再看摘要用词，最后才看正负号 */
function bankKind(io, wtype, merchant, desc, rawAmount) {
  var ioText = String(io || '').replace(/\s/g, '')
  var words = [wtype, merchant, desc].join('|')

  if (/借/.test(ioText) && !/贷/.test(ioText)) return { kind: 'expense', moveKind: '' }
  if (/贷/.test(ioText) && !/借/.test(ioText)) return { kind: 'income', moveKind: '' }
  if (/支出|付方/.test(ioText)) return { kind: 'expense', moveKind: '' }
  if (/收入|收方/.test(ioText)) return { kind: 'income', moveKind: '' }

  if (/退款|退货|冲正/.test(words)) return { kind: 'refund', moveKind: '' }
  if (BANK_MOVE.test(words)) return { kind: 'move', moveKind: '账户转移' }
  if (/工资|代发|薪金|薪水|劳务费|报销|利息|结息|分红|入账|转入|存入|汇入|收到/.test(words)) {
    return { kind: 'income', moveKind: '' }
  }
  if (/^-/.test(String(rawAmount || '').replace(/\s/g, ''))) return { kind: 'expense', moveKind: '' }
  return { kind: 'expense', moveKind: '' }
}

/**
 * 银行流水二维表（xlsx 行或 csv 拆出来的行）→ 标准条目
 */
function parseBank(rows) {
  var head = -1
  var limit = Math.min(rows.length, 40)
  for (var i = 0; i < limit; i++) {
    var keys = (rows[i] || []).map(normKey)
    var hasTime = false
    var hasAmt = false
    for (var k = 0; k < keys.length; k++) {
      if (/交易时间|交易日期|记账日|交易日|日期|时间/.test(keys[k])) hasTime = true
      if (/金额|支出|收入|借方|贷方|发生额/.test(keys[k])) hasAmt = true
    }
    if (hasTime && hasAmt) { head = i; break }
  }
  if (head < 0) throw new Error('不是银行流水：找不到含「交易日期 / 金额」的表头')

  var headerCells = rows[head] || []
  var col = {
    time: findBankCol(headerCells, BANK_COL.time),
    clock: findBankCol(headerCells, BANK_COL.clock),
    io: findBankCol(headerCells, BANK_COL.io),
    amount: findBankCol(headerCells, BANK_COL.amount),
    inAmount: findBankCol(headerCells, BANK_COL.inAmount),
    outAmount: findBankCol(headerCells, BANK_COL.outAmount),
    merchant: findBankCol(headerCells, BANK_COL.merchant),
    desc: findBankCol(headerCells, BANK_COL.desc),
    tradeNo: findBankCol(headerCells, BANK_COL.tradeNo),
    status: findBankCol(headerCells, BANK_COL.status),
    pay: findBankCol(headerCells, BANK_COL.pay),
    balance: findBankCol(headerCells, BANK_COL.balance),
    wtype: findBankCol(headerCells, BANK_COL.wtype)
  }

  /* 余额列绝不能当交易金额 */
  if (col.balance >= 0 && col.amount === col.balance) col.amount = -1
  /* 借贷/收支双列优先于通用金额列 */
  if (col.inAmount >= 0 && col.outAmount >= 0) col.amount = -1

  if (col.time < 0) throw new Error('银行流水里没找到日期列')
  if (col.amount < 0 && col.inAmount < 0 && col.outAmount < 0) throw new Error('银行流水里没找到金额列')

  var items = []
  var skipped = 0

  function cell(cells, idx) {
    if (idx < 0 || idx >= cells.length) return ''
    return trim(cells[idx])
  }

  for (var r = head + 1; r < rows.length; r++) {
    var cells = rows[r] || []
    if (cells.length < 2) { skipped++; continue }

    var timeText = cell(cells, col.time)
    if (col.clock >= 0 && col.clock !== col.time) {
      var clockText = cell(cells, col.clock)
      if (/[0-9]{1,2}:[0-9]{2}/.test(clockText) && !/[0-9]{1,2}:[0-9]{2}/.test(timeText)) {
        timeText = (timeText + ' ' + clockText).trim()
      }
    }
    if (!timeText) { skipped++; continue }

    var ts = /^\d+(\.\d+)?$/.test(timeText) ? serialToMs(timeText) : textToMs(timeText)
    if (!ts) { skipped++; continue }

    var io = cell(cells, col.io)
    var wtype = cell(cells, col.wtype)
    var merchant = cell(cells, col.merchant)
    var desc = cell(cells, col.desc)
    if (desc === '/') desc = ''
    if (merchant === '/' || merchant === '.' || !merchant) merchant = desc || wtype || '银行流水'

    var amount = 0
    var kind = ''
    var moveKind = ''
    var rawAmount = ''

    if (col.amount >= 0) {
      rawAmount = cell(cells, col.amount)
      amount = Math.abs(num(rawAmount))
      var cls1 = bankKind(io, wtype, merchant, desc, rawAmount)
      kind = cls1.kind
      moveKind = cls1.moveKind
    } else {
      var inAmt = Math.abs(num(cell(cells, col.inAmount)))
      var outAmt = Math.abs(num(cell(cells, col.outAmount)))
      rawAmount = outAmt > 0 ? String(cell(cells, col.outAmount)) : String(cell(cells, col.inAmount))
      var cls2 = bankKind(io, wtype, merchant, desc, rawAmount)
      kind = cls2.kind
      moveKind = cls2.moveKind
      if (kind === 'refund' || kind === 'move') {
        amount = inAmt > 0 ? inAmt : outAmt
      } else if (inAmt > 0) {
        amount = inAmt
        kind = 'income'
      } else if (outAmt > 0) {
        amount = outAmt
        kind = 'expense'
      }
    }

    /* 状态列说失败的整行不要 */
    var status = cell(cells, col.status)
    if (/失败|关闭|撤销|取消|已退回/.test(status) && !/已退款/.test(status)) { skipped++; continue }

    if (!amount) { skipped++; continue }

    var ty = kind === 'move' ? 'transfer' : kind

    items.push({
      t: ts,
      a: Math.round(amount * 100) / 100,
      k: kind,
      mk: kind === 'move' ? (moveKind || '账户转移') : '',
      ty: ty,
      io: io,
      raw: (wtype || desc).slice(0, 40),
      m: merchant.slice(0, 40),
      d: desc.slice(0, 40),
      pc: '',
      sn: cell(cells, col.tradeNo).slice(0, 64),
      s: '银行卡'
    })
  }

  return { source: '银行卡', items: items, skipped: skipped }
}

/* csv 文本 → 二维表（支付宝那份解析器已经在用，银行 csv 也借它） */
function csvToRows(text) {
  var lines = String(text || '').split(/\r?\n/)
  var rows = []
  for (var i = 0; i < lines.length; i++) {
    if (!trim(lines[i])) continue
    rows.push(splitCsvLine(lines[i]))
  }
  return rows
}

module.exports = {
  serialToMs: serialToMs,
  textToMs: textToMs,
  classifyRow: classifyRow,
  parseWechat: parseWechat,
  parseAlipay: parseAlipay,
  parseBank: parseBank,
  csvToRows: csvToRows,
  splitCsvLine: splitCsvLine
}
