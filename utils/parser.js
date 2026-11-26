/* 支付宝 / 微信 账单文本解析器
 * 输入：CSV / TSV / 从 Excel 直接复制粘贴的制表符文本
 * 输出：结构化流水数组
 */
var category = require('./category')
var format = require('./format')
var billId = require('./bill-id')

var HEAD_ALIAS = {
  /* 银行导出普遍把日期和时间分成两列（交易日期 + 交易时间），所以 time 之外单列一个 clock */
  time: ['交易时间', '交易创建时间', '支付时间', '发生时间', '创建时间', '时间', '日期',
    '交易日期', '记账日期', '记账日', '交易日', '入账日期', '入账日期时间', '发生日期',
    '资金发生日期', '交易发生日期', '交易日时间'],
  clock: ['交易时间', '交易时刻', '时间', '入账时间', '发生时间', '交易时分秒'],
  io: ['收/支', '收支类型', '收/支类型', '收支', '借/贷', '借贷标志', '借贷', '借贷方向',
    '收支标志', '收付标志', '交易方向', '资金方向', '收付类型', '方向'],
  amount: ['金额', '金额(元)', '金额（元）', '交易金额', '发生金额', '交易金额(元)',
    '交易金额（元）', '发生额', '人民币金额', '记账金额', '收支金额', '交易额'],
  inAmount: ['收入金额', '收入金额（+元）', '收入金额(+元)', '收入（元）', '收入',
    '贷方金额', '贷方发生额', '贷方金额（元）', '贷方', '存入金额', '存入额',
    '收款金额', '转入金额', '收入额'],
  outAmount: ['支出金额', '支出金额（-元）', '支出金额(-元)', '支出（元）', '支出',
    '借方金额', '借方发生额', '借方金额（元）', '借方', '支取金额', '支取额',
    '付款金额', '转出金额', '支出额'],
  merchant: ['交易对方', '对方', '商户名称', '商户', '交易对象', '收款方', '对方名称',
    '对方户名', '对方账户名称', '交易对手', '对方姓名', '收款人', '付款人',
    '收/付款户名', '对方账号名称', '商户/网点'],
  desc: ['商品说明', '商品名称', '商品详情', '商品', '交易说明', '摘要', '交易摘要',
    '用途', '交易备注', '附言', '备注', '备注信息', '交易描述', '摘要说明', '业务名称'],
  tradeNo: ['交易订单号', '交易单号', '订单号', '账务流水号', '流水号', '交易号',
    '交易流水号', '凭证号', '参考号'],
  status: ['交易状态', '当前状态', '状态', '交易状态说明', '交易结果', '处理状态', '记账状态'],
  pay: ['收/付款方式', '支付方式', '付款方式', '收付款方式', '支付渠道', '卡号', '账号',
    '交易卡号', '本方账号', '账户', '银行卡号'],
  /* 余额列只用来避开「别把余额当交易额」，不参与记账 */
  balance: ['余额', '账户余额', '交易后余额', '可用余额', '余额(元)', '余额（元）', '本次余额'],
  pcat: ['交易分类'],
  wtype: ['交易类型', '业务类型', '交易种类', '业务种类']
}

function stripBom(t) {
  return String(t || '').replace(/^\uFEFF/, '')
}

function detectSeparator(sample) {
  if (sample.indexOf('\t') >= 0) return '\t'
  if (sample.indexOf(',') >= 0) return ','
  return '\u0001'
}

function splitQuoted(line) {
  var out = []
  var cur = ''
  var inQuote = false
  for (var i = 0; i < line.length; i++) {
    var c = line.charAt(i)
    if (inQuote) {
      if (c === '"') {
        if (line.charAt(i + 1) === '"') {
          cur += '"'
          i++
        } else {
          inQuote = false
        }
      } else {
        cur += c
      }
    } else if (c === '"') {
      inQuote = true
    } else if (c === ',') {
      out.push(cur)
      cur = ''
    } else {
      cur += c
    }
  }
  out.push(cur)
  return out
}

function splitLine(line, sep) {
  if (sep === '\t') return line.split('\t')
  if (sep === ',') return splitQuoted(line)
  return line.trim().split(/\s{2,}/)
}

function cellKey(s) {
  return String(s || '')
    .replace(/[\s"']/g, '')
    .replace(/[（）]/g, function (m) {
      return m === '（' ? '(' : ')'
    })
}

function findCol(headerCells, aliases) {
  var keys = headerCells.map(cellKey)
  for (var i = 0; i < keys.length; i++) {
    for (var j = 0; j < aliases.length; j++) {
      if (keys[i] === cellKey(aliases[j])) return i
    }
  }
  for (var a = 0; a < aliases.length; a++) {
    var ak = cellKey(aliases[a])
    for (var b = 0; b < keys.length; b++) {
      if (keys[b].indexOf(ak) >= 0) return b
    }
  }
  return -1
}

function findHeaderIndex(lines) {
  var limit = Math.min(lines.length, 40)
  for (var i = 0; i < limit; i++) {
    var line = lines[i]
    if (!line) continue
    var cells = line.split('\t').length > 1 ? line.split('\t') : splitLine(line, detectSeparator(line))
    var hasTime = false
    var hasAmt = false
    for (var j = 0; j < cells.length; j++) {
      var k = cellKey(cells[j])
      if (!hasTime && HEAD_ALIAS.time.some(function (a) { return k.indexOf(cellKey(a)) >= 0 })) hasTime = true
      if (!hasAmt && (HEAD_ALIAS.amount.concat(HEAD_ALIAS.outAmount).some(function (a) { return k.indexOf(cellKey(a)) >= 0 }))) hasAmt = true
    }
    if (hasTime && hasAmt) return i
  }
  return -1
}

function toNum(s) {
  if (s === null || s === undefined) return 0
  var t = String(s).replace(/[¥￥,\s]/g, '').replace(/元/g, '')
  t = t.replace(/[^0-9.\-]/g, '')
  var v = parseFloat(t)
  return isNaN(v) ? 0 : v
}

function toTs(s) {
  if (!s) return 0
  var t = String(s).trim().replace(/\//g, '-')
  var m = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/)
  if (m) {
    return new Date(
      parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10),
      parseInt(m[4] || 0, 10), parseInt(m[5] || 0, 10), parseInt(m[6] || 0, 10)
    ).getTime()
  }
  var d = Date.parse(t)
  return isNaN(d) ? 0 : d
}

function detectSource(headerCells) {
  var keys = headerCells.map(cellKey)
  if (keys.indexOf('当前状态') >= 0 || keys.indexOf('交易单号') >= 0) return '微信'
  if (keys.indexOf('交易分类') >= 0 || keys.indexOf('交易订单号') >= 0) return '支付宝'
  /* 银行导出文件：有余额列、借贷双列、对方户名或交易摘要，任一命中就按银行卡流水处理 */
  for (var i = 0; i < keys.length; i++) {
    if (/余额|借方|贷方|对方户名|交易摘要|摘要|交易日期|记账日/.test(keys[i])) return '银行卡'
  }
  return '其他'
}

function resolveType(io, wtype, status, merchant, desc) {
  var sStatus = String(status || '')
  if (/退款/.test(sStatus)) return 'refund'
  if (/关闭|失败|撤销|取消/.test(sStatus) && !/已退款/.test(sStatus)) return null

  var sIO = String(io || '').replace(/\s/g, '')
  var sW = String(wtype || '')
  /* 关键词三处都看：银行搬运的字眼经常不在「收/支」列里，而在交易对方/商品说明里 */
  var sAll = sIO + '|' + String(wtype || '') + '|' + String(merchant || '') + '|' + String(desc || '')
  /* 银行卡和钱包之间搬钱：微信账单里这类经常标成「收入/支出」（零钱充值、提现到银行卡），
   * 但钱没离开用户，一律按不计收支处理 */
  if (/零钱充值|充值到零钱|网银充值|银行卡充值|零钱提现|提现到银行卡|转出到银行卡|来自银行卡|来自储蓄卡|转入.{0,12}(银行|储蓄卡)|转出.{0,12}(银行|储蓄卡)/.test(sAll)) return 'transfer'
  if (/不计/.test(sIO)) return 'transfer'
  /* 银行对账单习惯用「借 / 贷」标志：借方是钱从账上出去，贷方是钱进来。
   * 只在格子本身就是「借」或「贷」时才认，避免把「借/贷」这种表头值误判。 */
  if (sIO === '借' || sIO === '借方' || sIO === 'D' || sIO === '支出方') return 'expense'
  if (sIO === '贷' || sIO === '贷方' || sIO === 'C' || sIO === '收入方') return 'income'
  if (/支出|付方|借方/.test(sIO)) return 'expense'
  if (/收入|收方|贷方/.test(sIO)) return 'income'
  /* 银行流水常没有收支列，方向只写在摘要里（工资代发、结息、退款冲正）。
   * 只在没有方向列时兜底，不影响微信/支付宝原有的「支出/收入」判定。
   * 必须排在下面的「转账」之前：不然后面「转账收入」会被当成资金搬移。 */
  if (!sIO || sIO === '/' || sIO === '-') {
    if (/退款|退货|冲正/.test(sAll)) return 'refund'
    if (/工资|代发|薪金|薪水|劳务费|利息|结息|入账|转入|存入|汇入|收到/.test(sAll)) return 'income'
  }
  if (/转账/.test(sW)) return 'transfer'
  return 'expense'
}

/**
 * 解析文本
 * @returns {{items:Array, skipped:number, source:string, error:string}}
 */
function parse(text, userRules) {
  var raw = stripBom(text)
  var lines = raw.split(/\r\n|\n|\r/).filter(function (l) { return l.trim().length > 0 })
  if (lines.length < 2) {
    return { items: [], skipped: 0, source: '', error: '内容太少，至少要有一行表头加一行流水' }
  }

  var headerIdx = findHeaderIndex(lines)
  if (headerIdx < 0) {
    return { items: [], skipped: 0, source: '', error: '没找到表头：要有一行含「交易时间/交易日期」和「金额」这类列名，微信、支付宝、银行的导出文件都认' }
  }

  var sep = detectSeparator(lines[headerIdx])
  var headerCells = splitLine(lines[headerIdx], sep)
  var source = detectSource(headerCells)

  var col = {
    time: findCol(headerCells, HEAD_ALIAS.time),
    clock: findCol(headerCells, HEAD_ALIAS.clock),
    io: findCol(headerCells, HEAD_ALIAS.io),
    amount: findCol(headerCells, HEAD_ALIAS.amount),
    inAmount: findCol(headerCells, HEAD_ALIAS.inAmount),
    outAmount: findCol(headerCells, HEAD_ALIAS.outAmount),
    merchant: findCol(headerCells, HEAD_ALIAS.merchant),
    desc: findCol(headerCells, HEAD_ALIAS.desc),
    tradeNo: findCol(headerCells, HEAD_ALIAS.tradeNo),
    status: findCol(headerCells, HEAD_ALIAS.status),
    pay: findCol(headerCells, HEAD_ALIAS.pay),
    balance: findCol(headerCells, HEAD_ALIAS.balance),
    pcat: findCol(headerCells, HEAD_ALIAS.pcat),
    wtype: findCol(headerCells, HEAD_ALIAS.wtype)
  }

  /* 余额列不能被当成金额列（银行流水里「余额」一行金额比交易额还显眼）；
   * 只要金额列正好落在余额列上，就按「没找到金额列」处理 */
  if (col.balance >= 0 && col.amount === col.balance) col.amount = -1

  /* 双列金额表头（「收入金额」+「支出金额」）：通用 alias「金额」会在第二轮模糊匹配里
   * 错抢其中一列，于是另一列的行金额读成 0 被整行丢掉。识别出双列就强制走双列分支。 */
  if (col.inAmount >= 0 && col.outAmount >= 0) col.amount = -1

  if (col.time < 0) {
    return { items: [], skipped: 0, source: source, error: '表头里没有时间列，没法按时段统计' }
  }
  if (col.amount < 0 && (col.inAmount < 0 || col.outAmount < 0)) {
    return { items: [], skipped: 0, source: source, error: '表头里没有金额列' }
  }

  var items = []
  var skipped = 0

  function get(cells, idx) {
    if (idx < 0 || idx >= cells.length) return ''
    return String(cells[idx] || '').trim()
  }

  for (var i = headerIdx + 1; i < lines.length; i++) {
    var cells = splitLine(lines[i], sep)
    if (cells.length < 3) { skipped++; continue }

    /* 银行把日期和时间拆成两列：日期列只有 yyyy-mm-dd，时间列只有 hh:mm:ss，
       不拼起来的话所有流水会挤到当天 0 点 */
    var timeText = get(cells, col.time)
    if (col.clock >= 0 && col.clock !== col.time) {
      var clockText = get(cells, col.clock)
      if (/[0-9]{1,2}\s*:[0-9]{2}/.test(clockText) && !/[0-9]{1,2}\s*:[0-9]{2}/.test(timeText)) {
        timeText = (timeText + ' ' + clockText).trim()
      }
    }
    var ts = toTs(timeText)
    if (!ts) { skipped++; continue }

    var amount = 0
    var type = null
    if (col.amount >= 0) {
      var rawAmount = get(cells, col.amount)
      amount = Math.abs(toNum(rawAmount))
      type = resolveType(get(cells, col.io), get(cells, col.wtype), get(cells, col.status), get(cells, col.merchant), get(cells, col.desc))
      /* 金额自己带负号就是「钱出去」：银行流水里 -100.00 明确是支出，
         即便摘要里碰巧有「转入」这类字眼也以符号为准 */
      if (/^-/.test(String(rawAmount).replace(/\s/g, ''))) {
        if (type === 'income') type = 'expense'
        /* 「转账」在银行流水里多数就是转给别人，负号说明钱真的出去了，算支出 */
        else if (type === 'transfer' && source === '银行卡') type = 'expense'
      }
    } else {
      var inAmt = Math.abs(toNum(get(cells, col.inAmount)))
      var outAmt = Math.abs(toNum(get(cells, col.outAmount)))
      /* 双列也不能只按列猜方向：状态里写着「已退款」、收/支写着「不计收支」的，
       * 一律以状态为准，否则退款那行会被当成一笔新收入记进来；
       * 状态是关闭/失败的直接丢掉（st 为 null → amount 留 0 被跳过）。 */
      var st = resolveType(get(cells, col.io), get(cells, col.wtype), get(cells, col.status), get(cells, col.merchant), get(cells, col.desc))
      if (st === null) {
        amount = 0
      } else if (st === 'refund' || st === 'transfer') {
        type = st
        amount = inAmt > 0 ? inAmt : outAmt
      } else if (inAmt > 0) { amount = inAmt; type = 'income' }
      else if (outAmt > 0) { amount = outAmt; type = 'expense' }
    }

    if (amount === 0) { skipped++; continue }
    if (!type) { skipped++; continue }

    var merchant = get(cells, col.merchant)
    var desc = get(cells, col.desc)
    var tradeNo = get(cells, col.tradeNo)
    var statusText = get(cells, col.status)
    var account = get(cells, col.pay)

    /* 平台分类只对支出可信：收入的科目平台给的是「其他」，套上去会变成「其他支出」 */
    var pcat = (type === 'expense') ? get(cells, col.pcat) : ''
    var wt = get(cells, col.wtype)
    var cls = category.classify(merchant, (desc + ' ' + wt).trim(), pcat, userRules, type)
    var cat = cls.cat
    if (type === 'refund') cat = '退款'
    if (type === 'transfer') cat = category.transferCat(merchant, (desc + ' ' + wt).trim())

    /* 有交易单号的就是账单型，统一用 b 前缀（store 的 mergeInto/数据体检都只认 b），
     * 之前用 n 前缀会导致这类记录不计入 bill、也不会触发截图记录 h→b 的升级。 */
    var id = tradeNo ? billId.tradeNoId(source, tradeNo) : 'h' + billId.hash(ts + '|' + amount + '|' + merchant)

    items.push({
      id: id,
      legacyId: tradeNo ? billId.legacyTradeNoId(source, tradeNo) : '',
      time: ts,
      day: format.dayOf(ts),
      ym: format.ymOf(ts),
      amount: Math.round(amount * 100) / 100,
      type: type,
      merchant: merchant || desc || '未知商户',
      desc: desc,
      category: cat,
      account: account,
      status: statusText,
      source: source,
      byPlatform: cls.by,
      note: ''
    })
  }

  return { items: items, skipped: skipped, source: source, error: '' }
}

module.exports = {
  parse: parse,
  toNum: toNum,
  toTs: toTs
}
