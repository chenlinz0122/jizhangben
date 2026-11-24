/* 银行短信 → 流水
 *
 * 支持一次粘一大段，里面几十条短信也行。认这几种常见写法：
 *   【招商银行】您尾号1234的储蓄卡11月23日12:30在星巴克消费人民币35.00元，余额1234.56元。
 *   【工商银行】您尾号5678的借记卡11月22日09:15工资代发入账人民币8500.00元。
 *   【建设银行】您账户5678于11月21日18:02转出100.00元，收款方张三，余额500.00元。
 *   您尾号1234的信用卡11月20日消费89.00元，商户京东，已退款。
 *
 * 只负责「读成一条条流水」，分类仍然交给 category 那边。
 */
var category = require('./category')
var format = require('./format')

function hash(s) {
  var h = 5381
  for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

function pad(n) { return n < 10 ? '0' + n : String(n) }

/* 短信里常不写年份：比当前月还大得多就往去年算（11 月的短信不会是明年 3 月） */
function inferYear(month, nowY, nowM) {
  return month > nowM + 1 ? nowY - 1 : nowY
}

function makeTs(y, m, d, hh, mm) {
  var dt = new Date(y, m - 1, d, hh || 0, mm || 0, 0, 0)
  if (isNaN(dt.getTime())) return 0
  /* 日期非法（2 月 30 日之类）会被 Date 顺延，这里挡一下 */
  if (dt.getMonth() + 1 !== m) return 0
  return dt.getTime()
}

/* 先把「余额 X 元」整段抠掉：余额比交易金额还显眼，留着就会被当成这一笔的金额 */
var BALANCE_RE = /(?:余额|可用余额|账户余额|当前余额)(?:为|是|剩余)?\s*(?:人民币|RMB|￥|¥)?\s*[\d,]+(?:\.\d{1,2})?\s*元?/g

function parseOne(line, now) {
  var text = String(line || '').replace(/\s+/g, ' ').trim()
  if (!text) return null

  /* 验证码、营销、还款提醒这类不是流水 */
  if (/验证码|校验码|动态码|激活|注册|登录|优惠|活动|理财推荐|额度提升|点击/.test(text) &&
      !/消费|支出|入账|转入|转出|扣款|付款|取现/.test(text)) {
    return null
  }

  var bank = ''
  var m = text.match(/【(.{2,14}?)】/)
  if (m) bank = m[1].replace(/短信|提醒|通知|客服|银行服务/g, '').replace(/^[\s\-]+|[\s\-]+$/g, '')
  if (!bank) {
    m = text.match(/(?:^|[，,。\s])([\u4e00-\u9fa5]{2,10}?(?:银行|信用卡中心|农村商业银行))/)
    if (m) bank = m[1]
  }

  /* 卡尾号：尾号1234 / 卡号后四位1234 / 1234的储蓄卡 / 账户5678 */
  var tail = ''
  m = text.match(/尾号(?:为|是)?\s*(\d{4})/) ||
      text.match(/后四位(?:为|是)?\s*(\d{4})/) ||
      text.match(/(\d{4})\s*的(?:储蓄卡|借记卡|信用卡|账户|卡)/) ||
      text.match(/(?:卡号|账户)(?:尾号|末四位)?(?:为|是|：|:)?\s*(?:\*{2,}|\d{2,})(\d{4})(?!\d)/) ||
      text.match(/(?:卡号|账户|卡)\s*(?:\*{2,}\s*)?(\d{4,})(?!\d)/)
  if (m) tail = String(m[1]).slice(-4)

  var balance = ''
  m = text.match(/(?:余额|可用余额|账户余额|当前余额)(?:为|是|剩余)?\s*(?:人民币|RMB|￥|¥)?\s*([\d,]+(?:\.\d{1,2})?)/)
  if (m) balance = m[1]

  /* 摘掉余额再找金额，避免把余额当交易额 */
  var clean = text.replace(BALANCE_RE, ' ')

  var amount = 0
  m = clean.match(/(?:人民币|RMB|￥|¥)\s*([\d,]+(?:\.\d{1,2})?)/) ||
      clean.match(/([\d,]+\.\d{2})\s*元/) ||
      clean.match(/([\d,]+\.\d{1,2})/)
  if (m) amount = parseFloat(String(m[1]).replace(/,/g, ''))
  if (!(amount > 0)) return null

  var words = clean
  var type = ''
  if (/退款|退货|冲正|已退回/.test(words)) {
    type = 'refund'
  } else if (/信用卡还款|还款成功|自动还款|还信用卡|取现|取款|ATM|转存|零钱通|余额宝|理财赎回|赎回|申购/.test(words)) {
    type = 'transfer'
  } else if (/收入|入账|转入|存入|汇入|工资|代发|薪金|薪水|报销|利息|结息|分红|收到|到账/.test(words)) {
    type = 'income'
  } else if (/支出|消费|支付|扣款|扣费|转出|转给|付款|缴费|取现/.test(words)) {
    type = 'expense'
  } else {
    /* 没有方向词就宁可不记，免得把「余额变动提醒」当成一笔钱 */
    return null
  }

  /* 商户：在XX消费 / 向XX转账 / 收款方XX / 商户XX */
  var merchant = ''
  m = words.match(/在(.{2,26}?)(?:消费|支付|刷卡|扣款|购物|用餐|加油|缴费)/)
  if (m) merchant = m[1]
  if (!merchant) {
    m = words.match(/向(.{2,26}?)(?:转账|付款|支付)/)
    if (m) merchant = m[1]
  }
  if (!merchant) {
    m = words.match(/(?:收款方|付款方|商户|对方)(?:为|是|：|:)?\s*(.{2,26}?)(?:，|,|。|；|;|$|人民币|\d+\.\d{2})/)
    if (m) merchant = m[1]
  }
  if (merchant) merchant = merchant.replace(/[（(].*?[）)]/g, '').replace(/[，,。；;：:]+$/, '').trim()

  /* 时间：完整日期 > 月日 > 只有时分（当天）*/
  var ts = 0
  var nowY = now.getFullYear()
  var nowM = now.getMonth() + 1
  m = words.match(/(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?\s*(?:(\d{1,2}):(\d{2}))?/)
  if (m) {
    ts = makeTs(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10),
      parseInt(m[4] || '0', 10), parseInt(m[5] || '0', 10))
  }
  if (!ts) {
    m = words.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(?:(\d{1,2}):(\d{2}))?/)
    if (m) {
      var mm2 = parseInt(m[1], 10)
      var dd2 = parseInt(m[2], 10)
      ts = makeTs(inferYear(mm2, nowY, nowM), mm2, dd2,
        parseInt(m[3] || '0', 10), parseInt(m[4] || '0', 10))
    }
  }
  if (!ts) {
    m = words.match(/(?:^|\s)(\d{1,2}):(\d{2})(?::\d{2})?/)
    if (m) {
      var today = new Date(now.getTime())
      ts = makeTs(today.getFullYear(), today.getMonth() + 1, today.getDate(),
        parseInt(m[1], 10), parseInt(m[2], 10))
    }
  }
  if (!ts) ts = now.getTime()

  if (!merchant) {
    /* 短信里没有商户名时，用「这笔是什么」当名字，比拿银行名当商户强 */
    if (/信用卡还款|还款成功|自动还款|还信用卡/.test(words)) merchant = '信用卡还款'
    else if (/取现|取款|ATM/.test(words)) merchant = 'ATM取现'
    else if (/工资|代发|薪金|薪水/.test(words)) merchant = '工资代发'
    else if (/利息|结息/.test(words)) merchant = '银行利息'
    else if (type === 'refund') merchant = '退款'
    else if (type === 'transfer') merchant = '账户转移'
    else merchant = bank || '银行短信'
  }

  var source = bank || '银行卡'
  var day = format.dayOf(ts)
  var id = 'h' + hash(day + '|' + Math.round(amount * 100) / 100 + '|' + merchant + '|' + tail)
  var descParts = []
  if (tail) descParts.push('尾号' + tail)
  if (balance) descParts.push('余额' + balance)
  var desc = descParts.join(' · ')
  var cls = category.classify(merchant, desc, '', null, type)

  return {
    id: id,
    time: ts,
    day: day,
    ym: format.ymOf(ts),
    amount: Math.round(amount * 100) / 100,
    type: type,
    merchant: merchant,
    desc: desc,
    category: type === 'refund' ? '退款'
      : (type === 'transfer' ? category.transferCat(merchant, desc) : cls.cat),
    account: tail ? ('尾号' + tail) : '',
    status: '',
    source: source,
    byPlatform: cls.by,
    note: ''
  }
}

/* 一段文字里像不像银行短信：有【XX银行】或者「尾号/账户 + 金额」的组合 */
function looksLikeSms(text) {
  var s = String(text || '')
  if (s.length < 8) return false
  var hasBank = /【.{2,14}?】/.test(s) || /[\u4e00-\u9fa5]{2,10}银行/.test(s)
  var hasCard = /尾号|后四位|储蓄卡|借记卡|信用卡|账户|卡号/.test(s)
  var hasMoney = /(?:人民币|RMB|￥|¥)|[\d,]+\.\d{1,2}\s*元/.test(s)
  var hasWord = /消费|支出|入账|转入|转出|扣款|取款|退款|支付|汇款|代发/.test(s)
  if (hasBank && hasMoney) return true
  if (hasCard && hasMoney && hasWord) return true
  return false
}

/**
 * 解析一大段短信
 * @returns {{items:Array, skipped:number, source:string, error:string}}
 */
function parse(text, userRules, now) {
  var raw = String(text || '')
  var nowDate = now instanceof Date ? now : new Date()
  /* 多行多条；同一行里塞了多条（少见）时再按【拆 */
  var chunks = raw.split(/\r\n|\n|\r/).map(function (l) { return l.trim() }).filter(function (l) { return l.length > 0 })
  if (chunks.length === 1 && (raw.match(/【/g) || []).length > 1) {
    chunks = raw.split(/(?=【)/).map(function (l) { return l.trim() }).filter(function (l) { return l.length > 0 })
  }

  var items = []
  var skipped = 0
  var banks = {}

  for (var i = 0; i < chunks.length; i++) {
    var it = parseOne(chunks[i], nowDate)
    if (!it) { skipped++; continue }
    var cls = category.classify(it.merchant, it.desc, '', userRules, it.type)
    if (it.type === 'expense' || it.type === 'income') it.category = cls.cat
    it.byPlatform = cls.by
    items.push(it)
    if (it.source && it.source !== '银行卡') banks[it.source] = 1
  }

  var sourceNames = Object.keys(banks)
  var source = sourceNames.length === 1 ? sourceNames[0] : (sourceNames.length > 1 ? sourceNames.slice(0, 2).join('/') : '银行卡')

  if (!items.length) {
    return {
      items: [],
      skipped: skipped,
      source: '',
      error: '这段文字里没认出银行流水：要带「尾号/账户」和「消费/入账 + 金额」这类字眼'
    }
  }

  return { items: items, skipped: skipped, source: source, error: '' }
}

module.exports = {
  parse: parse,
  parseOne: parseOne,
  looksLikeSms: looksLikeSms
}
