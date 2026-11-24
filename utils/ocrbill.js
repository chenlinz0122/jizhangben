/* 账单截图 OCR 结果 → 流水
 * 输入：微信 OCR 返回的文字块 [{text,left,top,height}]
 * 输出：与 utils/parser.js 一致的结构，方便共用 store / stats
 *
 * 做法：先把文字块按纵向位置聚成「行」，每行里挑出金额那一格，
 * 剩下的文字当商户名。日期靠行内文字（今天/11月14日）或上面最近一个日期头。
 */
var category = require('./category')
var format = require('./format')

function num(v) {
  var n = Number(v)
  return isNaN(n) ? 0 : n
}

function hash(s) {
  var h = 5381
  for (var i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  }
  return h.toString(36)
}

/* 账单只写「X月X日」没有年份时推断年份。账单记录的都是过去发生的交易：拿「月/日」
 * 跟今天比，比今天晚就落回去年。只比月份会在同月内判错——11 月 16 日看到「11 月 20 日」
 * 会算成今年，生成一条未来日期的流水。 */
function inferYear(month, day, now) {
  var nowDay = now.d || new Date(now.ts).getDate()
  var md = month * 100 + (day || 1)
  var nowMd = now.m * 100 + nowDay
  return md > nowMd ? now.y - 1 : now.y
}

/* OCR 回来的文本可能带 HTML 实体（支付宝账单页中间的「·」就是 &middot;） */
function decodeEntities(s) {
  return String(s || '')
    .replace(/&middot;/gi, '·')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 10)) })
}

/* 清掉 OCR 噪声：行首多出来的括号/竖线、行尾省略号，顺带统一全角符号 */
function cleanText(s) {
  var t = decodeEntities(s).replace(/\s+/g, ' ').trim()
  t = t.replace(/：/g, ':').replace(/，/g, ',').replace(/．/g, '.')
  t = t.replace(/^[}\]|>'"]+/, '').trim()
  t = t.replace(/^[·•]\s*/, '')
  t = t.replace(/[.。…·]+$/, '').trim()
  return t
}

/* 账单卡片里那行小字其实是平台给好的分类：日用百货 / 投资理财 / 交通出行… */
function findPlatformCat(text) {
  var keys = Object.keys(category.PLATFORM_MAP)
  var best = ''
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i]
    if (k === '其他') continue
    if (text.indexOf(k) >= 0 && k.length > best.length) best = k
  }
  return best
}

/* 银行 App 的标识，用来把截图的来源认出来（储蓄卡/信用卡/尾号是辅助判断） */
var BANK_NAME_RE = /招商银行|工商银行|建设银行|农业银行|中国银行|交通银行|邮储银行|邮政储蓄|浦发银行|中信银行|兴业银行|民生银行|光大银行|平安银行|华夏银行|广发银行|宁波银行|杭州银行|北京银行|上海银行|江苏银行|农村商业银行|农商行|信用卡中心/

/* ---------- 1. 聚成行 ---------- */
function groupRows(items) {
  var list = []
  for (var i = 0; i < items.length; i++) {
    var it = items[i] || {}
    var text = cleanText(it.text)
    if (!text) continue
    list.push({
      text: text,
      left: num(it.left),
      top: num(it.top),
      h: num(it.height) || 20
    })
  }
  if (!list.length) return []

  var hasPos = false
  for (var k = 0; k < list.length; k++) {
    if (list[k].top > 0 || list[k].left > 0) { hasPos = true; break }
  }
  /* 没有坐标就退化成「一行一条」 */
  if (!hasPos) {
    return list.map(function (x) {
      return {
        baseTop: 0,
        h: 20,
        text: x.text,
        cells: [{ text: x.text, left: 0, top: 0 }]
      }
    })
  }

  list.sort(function (a, b) {
    return a.top - b.top || a.left - b.left
  })

  var rows = []
  for (var j = 0; j < list.length; j++) {
    var cur = list[j]
    var last = rows[rows.length - 1]
    if (last && Math.abs(cur.top - last.baseTop) <= Math.max(10, Math.min(cur.h, last.h) * 0.65)) {
      last.cells.push(cur)
      last.h = Math.min(last.h, cur.h)
    } else {
      rows.push({ baseTop: cur.top, h: cur.h, cells: [cur] })
    }
  }
  for (var r = 0; r < rows.length; r++) {
    rows[r].cells.sort(function (a, b) { return a.left - b.left })
    rows[r].text = rows[r].cells.map(function (c) { return c.text }).join(' ')
  }
  return rows
}

/* ---------- 2. 金额 ---------- */
/* 账单金额一定带两位小数，或者带 ¥ / 正负号。裸整数不当金额，避免把年份当钱。 */
function parseAmountCell(t) {
  var s = String(t || '').replace(/\s/g, '')
  if (!s) return null
  s = s.replace(/[¥￥]/g, '').replace(/元$/, '')
  /* OCR 会把减号认成各种样子：真减号 −(U+2212)、破折号 — –、全角 － */
  s = s.replace(/[−–—－]/g, '-').replace(/＋/g, '+')
  var sign = ''
  if (s.charAt(0) === '+' || s.charAt(0) === '-') {
    sign = s.charAt(0)
    s = s.slice(1)
  }
  var looksMoney = /^[+-]?(\d{1,3}(,\d{3})*|\d+)(\.\d{1,2})?$/.test(s) &&
    (s.indexOf('.') >= 0 || /[¥￥]/.test(t) || sign !== '')
  if (!looksMoney) return null
  var v = parseFloat(s.replace(/,/g, ''))
  if (isNaN(v) || v <= 0) return null
  return { value: Math.round(v * 100) / 100, sign: sign }
}

/* ---------- 3. 日期 ---------- */
function pad(n) { return n < 10 ? '0' + n : '' + n }

function makeDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  var dt = new Date(y, m - 1, d)
  return { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() }
}

function dateInText(text, now) {
  var m
  if ((m = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/))) {
    return makeDate(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10))
  }
  /* 详情页的时间带完整年份：2026-11-16 23:00:50 */
  if ((m = text.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*(?:日|号)?/))) {
    return makeDate(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10))
  }
  if ((m = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/))) {
    var mm = parseInt(m[1], 10)
    var dd = parseInt(m[2], 10)
    var yy = inferYear(mm, dd, now)
    return makeDate(yy, mm, dd)
  }
  if ((m = text.match(/(\d{1,2})-(\d{1,2})(?![\d-])/))) {
    var m2 = parseInt(m[1], 10)
    var d2 = parseInt(m[2], 10)
    var y2 = inferYear(m2, d2, now)
    return makeDate(y2, m2, d2)
  }
  if ((m = text.match(/(今天|昨天|前天)/))) {
    var off = m[1] === '今天' ? 0 : (m[1] === '昨天' ? 1 : 2)
    var d = new Date(now.ts)
    d.setDate(d.getDate() - off)
    return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() }
  }
  return null
}

function monthHeader(text, now) {
  var m
  if ((m = text.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月(?![日号])/))) {
    return { y: parseInt(m[1], 10), m: parseInt(m[2], 10) }
  }
  if ((m = text.match(/^(\d{1,2})\s*月(?![日号])/))) {
    var mm = parseInt(m[1], 10)
    var yy = inferYear(mm, 1, now)
    return { y: yy, m: mm }
  }
  return null
}

function timeInText(text) {
  /* OCR 经常把冒号认成全角「：」 */
  var m = text.match(/(\d{1,2})\s*[:：]\s*(\d{2})/)
  if (!m) return null
  var h = parseInt(m[1], 10)
  var mi = parseInt(m[2], 10)
  if (h > 23 || mi > 59) return null
  return { h: h, mi: mi }
}

/* 只有日期/时间、没有实质文字的格子（如「今天 12:31」「11月13日 10:02」） */
function isDateTimeCell(ct) {
  var s = String(ct || '')
    .replace(/今天|昨天|前天|星期[一二三四五六日天]/g, ' ')
    .replace(/(\d{4})\s*年/g, ' ')
    .replace(/\d{1,2}\s*月/g, ' ')
    .replace(/\d{1,2}\s*日/g, ' ')
    .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, ' ')
    .replace(/[年月日\s·:：]/g, '')
  return s.length === 0
}

/* ---------- 4. 整行文字里直接抠（没有坐标时的兜底） ---------- */
function parseInline(text) {
  var re = /[¥￥]?\s*([+-])?\s*(\d{1,3}(?:,\d{3})*|\d+)\.(\d{1,2})(?:\s*元)?/g
  var m
  var hit = null
  while ((m = re.exec(text))) {
    var v = parseFloat((m[2] + '.' + m[3]).replace(/,/g, ''))
    if (!isNaN(v) && v > 0) hit = { value: Math.round(v * 100) / 100, sign: m[1] || '' }
  }
  if (!hit) return null

  var rest = text.replace(re, ' ')
  rest = rest.replace(/今天|昨天|前天/g, ' ')
  rest = rest.replace(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g, ' ')
  rest = rest.replace(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/g, ' ')
  rest = rest.replace(/\d{1,2}:\d{2}(?::\d{2})?/g, ' ')
  rest = rest.replace(/支出|收入|退款|交易成功|交易关闭/g, ' ')
  var merchant = rest.replace(/\s+/g, ' ').trim()
  return { value: hit.value, sign: hit.sign, merchant: merchant || '截图识别' }
}

/* ---------- 4.6 单笔详情页（微信支付凭证 / 支付宝账单详情） ---------- */
/* 详情页版面跟列表页完全不同：商户名在金额的上方、金额是整页最大的那行字、
 * 时间带完整年份、还带交易单号。单独走一条解析，好处很实在：
 *   1) 日期带年份，不用再推「今年还是去年」；
 *   2) 有交易单号就能像账单文件一样精确判重——同一天同额同商户的两笔不会被吞，
 *      同一张截图重复导入也不会翻倍。 */
var DETAIL_MARKS = [
  '交易单号', '商户单号', '订单号', '收款方全称', '支付时间', '交易时间',
  '付款方式', '支付方式', '当前状态', '收单机构', '商品说明', '账单分类',
  '计入收支', '账单详情'
]

function detailScore(allText) {
  var n = 0
  for (var i = 0; i < DETAIL_MARKS.length; i++) {
    if (allText.indexOf(DETAIL_MARKS[i]) >= 0) n++
  }
  return n
}

/* 金额：整页字号最大的那个短格子（详情页的大字金额比正文明显大一号） */
function pickBigAmount(rows) {
  var best = null
  for (var i = 0; i < rows.length; i++) {
    var cells = rows[i].cells
    for (var c = 0; c < cells.length; c++) {
      var cell = cells[c]
      if (String(cell.text || '').replace(/\s/g, '').length > 14) continue
      var amt = parseAmountCell(cell.text)
      if (!amt) continue
      var h = cell.h || 20
      if (!best || h > best.h + 1) best = { value: amt.value, sign: amt.sign, h: h, row: i }
    }
  }
  return best
}

function parseDetail(rows, nowInfo, userRules, allText, source) {
  var best = pickBigAmount(rows)
  if (!best) {
    return { items: [], skipped: 0, source: source, error: '详情页里没找到金额，换张清楚点的截图' }
  }

  /* 时间：第一处带完整日期的行（详情页一定有「支付时间 2026-11-16 23:00:50」） */
  var dRow = null
  var tRow = null
  for (var r = 0; r < rows.length; r++) {
    var d = dateInText(rows[r].text, nowInfo)
    if (!d) continue
    dRow = d
    tRow = timeInText(rows[r].text) || timeInText(rows[r + 1] ? rows[r + 1].text : '')
    break
  }
  var base = dRow ? new Date(dRow.y, dRow.m - 1, dRow.d) : new Date(nowInfo.ts)
  if (tRow) base.setHours(tRow.h, tRow.mi, 0, 0)
  var ts = base.getTime()

  /* 商户：金额行上方那一行（跳过状态/日期/页面标题） */
  var merchant = ''
  for (var up = best.row - 1; up >= 0 && up >= best.row - 4; up--) {
    var t2 = rows[up].text
    if (!t2 || t2.length < 2 || t2.length > 24) continue
    if (dateInText(t2, nowInfo)) continue
    if (/支付成功|交易成功|已收钱|收款成功|已退款|退款成功|交易关闭|已关闭|当前状态|账单详情|全部账单|账单服务|订单详情/.test(t2)) continue
    merchant = t2
    break
  }
  if (!merchant) {
    /* 兜底：支付宝详情页的「收款方全称」 */
    for (var r2 = 0; r2 < rows.length; r2++) {
      var mt = rows[r2].text.match(/(?:收款方全称|商户名称|收款方|对方)\s*(.*)/)
      if (!mt) continue
      var v = String(mt[1] || '').trim()
      if (!v && rows[r2 + 1]) v = String(rows[r2 + 1].text || '').trim()
      if (v) { merchant = v.slice(0, 24); break }
    }
  }
  if (!merchant) merchant = '截图识别'

  /* 商品说明 → 备注（支付宝详情页有，微信那边一般没有） */
  var desc = ''
  for (var d3 = 0; d3 < rows.length; d3++) {
    var dm = rows[d3].text.match(/商品说明\s*(.*)/)
    if (!dm) continue
    desc = String(dm[1] || '').trim()
    if (!desc && rows[d3 + 1]) desc = String(rows[d3 + 1].text || '').trim()
    break
  }

  /* 状态 → 方向。详情页整页只讲这一笔，所以整页文字都能当上下文 */
  var state = ''
  for (var s = 0; s < rows.length; s++) {
    var mm = rows[s].text.match(/(支付成功|交易成功|已收钱|收款成功|已全额退款|已退款|退款成功|交易关闭|已关闭|等待付款|已失效)/)
    if (mm) { state = mm[1]; break }
  }

  var type = 'expense'
  if (/退款|已退/.test(state)) {
    type = 'refund'
  } else if (/已收钱|收款成功/.test(state)) {
    type = 'income'
  } else if (/关闭|失效/.test(state)) {
    return { items: [], skipped: 1, source: source, error: '这一笔是「' + state + '」，没有成交，就不记账了' }
  } else if (/转入|转出|转账给|提现|还款|赎回|申购|零钱充值|充值到零钱|网银充值|银行卡充值|来自银行卡|来自储蓄卡/.test(merchant + ' ' + desc + ' ' + state)) {
    /* 注意：不能拿「零钱通/余额宝」当转账依据——那只是付款方式，
     * 「支付方式 零钱通」是拿零钱通付款，属于正常支出。
     * 也只看商户/说明/状态这三处，不喂整页文字（页面上的「收单机构」等字样会把分类带偏） */
    type = 'transfer'
  } else if (best.sign === '+') {
    type = 'income'
  } else if (best.sign === '-') {
    type = 'expense'
  } else {
    type = (source === '支付宝') ? 'income' : 'expense'
  }

  /* 交易单号：OCR 常把长单号折成两行，这里去掉空白再抠，能拼回去 */
  var sn = ''
  var packed = allText.replace(/\s/g, '')
  var sm = packed.match(/交易单号[:：]?(\d{10,})/) ||
    packed.match(/商户单号[:：]?(\d{10,})/) ||
    packed.match(/订单号[:：]?(\d{10,})/)
  if (sm) sn = sm[1]

  var platformCat = findPlatformCat(allText)
  /* 只把商户/说明/状态喂给分类器：整页文字里有「收单机构 财付通」「支付方式 零钱通」
   * 这类字样，会命中转账类关键词把一笔正常支出带偏 */
  var clsText = (desc + ' ' + state).trim()
  var cls = category.classify(merchant, clsText, platformCat, userRules, type)

  /* 有单号就用单号当身份（前缀 b，跟账单文件一致），没有才退回日期+金额+商户 */
  var id = sn
    ? 'b' + hash('sn|' + source + '|' + sn)
    : 'h' + hash(format.dayOf(ts) + '|' + best.value + '|' + merchant + '|' + source)

  var cat = type === 'refund'
    ? '退款'
    : (type === 'transfer' ? category.transferCat(merchant, clsText) : cls.cat)

  return {
    items: [compact({
      id: id,
      time: ts,
      day: format.dayOf(ts),
      ym: format.ymOf(ts),
      amount: best.value,
      type: type,
      merchant: merchant,
      desc: desc.slice(0, 24),
      category: cat,
      account: '',
      status: state,
      source: source,
      byPlatform: cls.by,
      note: ''
    })],
    skipped: 0,
    source: source,
    error: ''
  }
}

/* 取某一行里最像商户名的那个格子（去掉金额格、时间格、纯数字） */
function merchantCellOf(row) {
  var best = ''
  var cells = (row && row.cells) || []
  for (var i = 0; i < cells.length; i++) {
    var ct = String(cells[i].text || '').trim()
    if (!ct) continue
    if (parseAmountCell(ct)) continue
    if (/^[¥￥+\-]?\s*(\d{1,3}(,\d{3})*|\d+)(\.\d{1,2})?\s*元?$/.test(ct)) continue
    if (isDateTimeCell(ct)) continue
    if (ct.length > best.length) best = ct
  }
  return best.replace(/^[·•]\s*/, '').trim()
}

/* ---------- 5. 主流程 ---------- */
/* 账单卡片布局：商户+金额同一行，下面跟「分类」「时间」两行小字。
 * 判断某行是不是金额行 */
function rowHasAmount(row) {
  if (!row || !row.cells) return false
  for (var i = 0; i < row.cells.length; i++) {
    if (parseAmountCell(row.cells[i].text)) return true
  }
  return false
}

/* 只有「余额 + 数字」那一行：银行 App 在每笔下面就摆余额，
 * 它既不是流水，也不该把卡片的分类/时间信息截断 */
function isBalanceRow(row) {
  if (!row || !row.text) return false
  if (!/余额/.test(row.text)) return false
  var rest = String(row.text)
    .replace(/余额|可用余额|账户余额|当前余额/g, '')
    .replace(/[¥￥+\-\s]/g, '')
    .replace(/[\d,.]+/g, '')
  return rest.length <= 2
}

/* 取这张卡片的整段文字（金额行 + 后面最多两行小字），用来找分类词/日期/时间 */
function blockText(rows, i) {
  var parts = [rows[i].text]
  for (var k = i + 1; k < rows.length && k <= i + 2; k++) {
    /* 余额行只是展示，不算卡片内容的结尾，但也不塞进 block（里面有数字会干扰） */
    if (isBalanceRow(rows[k])) continue
    if (rowHasAmount(rows[k])) break
    parts.push(rows[k].text)
  }
  return parts.join(' ')
}

function parseItems(items, userRules, opts) {
  var now = new Date()
  var nowInfo = { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate(), ts: now.getTime() }
  var rows = groupRows(items)
  if (!rows.length) {
    return { items: [], skipped: 0, source: '', error: '没识别到文字，换一张更清楚的截图' }
  }

  /* 来源：整张图里出现过平台名就认它。
     银行 App 界面没有统一标志，靠银行名 / 卡类型 / 尾号认。 */
  var allText = rows.map(function (r) { return r.text }).join(' ')
  var source = '截图'
  if (allText.indexOf('支付宝') >= 0 || allText.indexOf('余额宝') >= 0) source = '支付宝'
  else if (allText.indexOf('微信') >= 0 || allText.indexOf('零钱') >= 0) source = '微信'
  else if (BANK_NAME_RE.test(allText) || /储蓄卡|借记卡|信用卡|尾号\s*\d{4}/.test(allText)) source = '银行卡'

  /* 单笔详情页（微信支付凭证 / 支付宝账单详情）：版面跟列表页完全不同，走另一条解析。
   * 只在认出 2 个以上详情页标志词时才切过去，避免把列表页误判成详情页 */
  if (detailScore(allText) >= 2) {
    return parseDetail(rows, nowInfo, userRules, allText, source)
  }

  var ctxDate = null
  var out = []
  var skipped = 0
  var seen = {}

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i]
    var cells = row.cells
    var text = row.text

    /* 银行 App 每笔下面的「余额 xxx」行不是流水，直接略过 */
    if (source === '银行卡' && isBalanceRow(row)) { skipped++; continue }

    /* 顶部汇总行（微信是「支出 ¥1369.74　收入 ¥1184.92」，支付宝是两格并排） */
    if (/支出/.test(text) && /收入/.test(text)) {
      skipped++
      continue
    }

    /* 金额格。银行 App 的卡片里「余额 1,234.56」和交易金额并排显示，
       余额不是这一笔的钱，那一格和它后面的数字都要跳过 */
    var amtCell = null
    var amtIdx = -1
    var inlineMerchant = ''
    var balIdx = -1
    for (var bc = 0; bc < cells.length; bc++) {
      if (/余额/.test(String(cells[bc].text || ''))) { balIdx = bc; break }
    }
    for (var c = 0; c < cells.length; c++) {
      var ct0 = String(cells[c].text || '')
      if (source === '银行卡') {
        if (/余额|可用余额|账户余额/.test(ct0)) continue
        if (balIdx >= 0 && c > balIdx) continue
      }
      var amt = parseAmountCell(ct0)
      if (amt) { amtCell = amt; amtIdx = c; break }
    }

    /* 只有一整块文字、又拆不出格子 → 直接从整行抠 */
    if (!amtCell && cells.length === 1) {
      var inl = parseInline(text)
      if (inl) {
        amtCell = { value: inl.value, sign: inl.sign }
        inlineMerchant = inl.merchant
      }
    }

    if (!amtCell) {
      /* 没有金额 → 可能是日期头/月份头/界面文字 */
      var d0 = dateInText(text, nowInfo)
      if (d0) ctxDate = d0
      var mh = monthHeader(text, nowInfo)
      if (mh) {
        ctxDate = ctxDate && ctxDate.m === mh.m ? ctxDate : { y: mh.y, m: mh.m, d: 1 }
      }
      skipped++
      continue
    }

    /* 商户：去掉金额格和纯时间格后最长的那个 */
    /* 这张卡片的整体文字：分类词、日期、时间都在本行或下面两行小字里 */
    var block = (cells.length === 1) ? text : blockText(rows, i)
    var platformCat = findPlatformCat(block)
    var merchant = inlineMerchant
    if (!merchant) {
      for (var c2 = 0; c2 < cells.length; c2++) {
        if (c2 === amtIdx) continue
        var ct = String(cells[c2].text || '').trim()
        if (!ct) continue
        if (/^[¥￥+\-]?\s*(\d{1,3}(,\d{3})*|\d+)(\.\d{1,2})?\s*元?$/.test(ct)) continue
        if (isDateTimeCell(ct)) continue
        if (ct.length > merchant.length) merchant = ct
      }
      merchant = merchant.replace(/^[·•]\s*/, '').trim()
    }
    /* 金额和商户被 OCR 认成了两行（金额那行只剩数字）：往上找一行把商户名捞回来 */
    if (!merchant && cells.length === 1) {
      for (var up = i - 1; up >= 0 && up >= i - 2; up--) {
        if (rowHasAmount(rows[up])) continue
        var pm = merchantCellOf(rows[up])
        if (pm) { merchant = pm; break }
      }
    }
    if (!merchant) merchant = '截图识别'

    /* 顶部汇总区/界面文字：没有商户名却带着「支出 180.07」「本月已省」这类字样 */
    if (merchant === '截图识别' && /支出|收入|已省|收支分析|复盘|筛选|搜索|订单/.test(text)) {
      skipped++
      continue
    }

    /* 汇总行 / 界面文案不是流水，直接跳过 */
    if (/^(本月|上月|本年|去年|总计|合计|共计|总支出|总收入|收入合计|支出合计|支出|收入|已省|本月已省|全部|更多)$/.test(merchant)) {
      skipped++
      continue
    }
    if (/(本月支出|本月收入|上月支出|上月收入|收支统计|笔交易)/.test(text) && merchant.length <= 6) {
      skipped++
      continue
    }

    /* 日期：卡片内优先，其次沿用上一次的日期头 */
    var dRow = dateInText(block, nowInfo)
    var tRow = timeInText(block)

    /* 兜底：时间行有时被 OCR 挤到卡片下面几行（长商户名/图标占位），往下再看 4 行 */
    if (!tRow) {
      for (var f = i + 1; f <= i + 4 && f < rows.length; f++) {
        if (rowHasAmount(rows[f])) break
        var ft = rows[f].text
        if (!/\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}\s*[:：]\s*\d{2}/.test(ft)) continue
        if (!dRow) {
          var fD = dateInText(ft, nowInfo)
          if (fD) dRow = fD
        }
        var fT = timeInText(ft)
        if (fT) { tRow = fT; break }
      }
    }

    if (dRow) ctxDate = dRow
    var useDate = dRow || ctxDate
    var baseDate = useDate
      ? new Date(useDate.y, useDate.m - 1, useDate.d)
      : new Date(nowInfo.ts)
    var ts = baseDate.getTime()
    if (tRow) {
      baseDate.setHours(tRow.h, tRow.mi, 0, 0)
      ts = baseDate.getTime()
    }

    /* 收支类型
     * 支付宝：支出带负号，收入/退款/理财进出是正数不带号
     * 微信：支出带负号，收入带正号，转账类可能不带号
     * 退款、理财进出、转给他人都不算日常收支，单列出来 */
    var type = 'expense'
    var markRefund = /已全额退款|已退款|退款成功|已退/.test(block)
    if (!markRefund && /退款|退货|冲正/.test(block)) {
      type = 'refund'
    } else if (source === '银行卡') {
      /* 银行 App 的用词跟微信/支付宝不一样：
         还款、取现、理财申购赎回是自己账户之间搬；消费/支付/转出/转给是花出去了；
         入账/转入/工资/结息才是进账。没写方向的银行流水绝大多数是支出。 */
      if (/信用卡还款|还款成功|自动还款|还信用卡|还款|取现|取款|ATM|理财|基金|申购|赎回|转存|定活互转/.test(block)) {
        type = 'transfer'
      } else if (/消费|支付|扣款|扣费|支出|转出|转给|付款|缴费|缴款/.test(block)) {
        type = 'expense'
      } else if (/入账|转入|存入|汇入|工资|代发|利息|结息|分红|收到|到账/.test(block)) {
        type = 'income'
      } else if (amtCell.sign === '+') {
        type = 'income'
      } else {
        type = 'expense'
      }
    } else if (/转入|转出|转给|提现|还款|赎回|申购|基金|理财通|零钱通|收益发放|收益入账|理财收益|余额宝收益|零钱充值|充值到零钱|网银充值|银行卡充值|来自银行卡|来自储蓄卡/.test(block)) {
      type = 'transfer'
    } else if (/收益|利息|红包|收款|入账|来自/.test(block)) {
      type = 'income'
    } else if (amtCell.sign === '+') {
      type = 'income'
    } else if (amtCell.sign === '-') {
      type = 'expense'
    } else if (/收入/.test(text)) {
      type = 'income'
    } else if (/支出/.test(text)) {
      type = 'expense'
    } else {
      /* 没符号：支付宝的支出一定带负号，所以正数视为收入；其他来源保守按支出 */
      type = (source === '支付宝') ? 'income' : 'expense'
    }

    var cls = category.classify(merchant, text, platformCat, userRules, type)

    var idBase = format.dayOf(ts) + '|' + amtCell.value + '|' + merchant + '|' + source
    var idKey = hash(idBase)
    seen[idKey] = (seen[idKey] || 0) + 1
    var id = 'h' + idKey + (seen[idKey] > 1 ? '#' + seen[idKey] : '')

    /* 收益发放 / 理财收益：支付宝把「余额宝-收益发放」的商户写成基金公司名（汇添富富通A），
     * transferCat 靠商户名认不出「理财」，这里直接钉死，避免落到「账户转移」 */
    var isInvestYield = /收益发放|收益入账|理财收益|余额宝收益/.test(block)
    var cat = type === 'refund'
      ? '退款'
      : (isInvestYield ? '理财' : (type === 'transfer' ? category.transferCat(merchant, '') : cls.cat))

    out.push({
      id: id,
      time: ts,
      day: format.dayOf(ts),
      ym: format.ymOf(ts),
      amount: amtCell.value,
      type: type,
      merchant: merchant,
      desc: '',
      category: cat,
      account: '',
      status: '',
      source: source,
      byPlatform: cls.by,
      note: ''
    })
  }

  if (!out.length) {
    return {
      items: [],
      skipped: skipped,
      source: source,
      error: '这张图里没找到带金额的账单行，确认截的是账单列表页，或者某一笔的详情页'
    }
  }

  return { items: out, skipped: skipped, source: source, error: '' }
}

/* 账单文件（微信 xlsx / 支付宝 csv）解析出来的条目 → 流水对象
 * id 规则和截图识别一致（日期+金额+商户），所以两条路导入的数据能互相去重 */
function fromBill(items, userRules) {
  var seen = {}
  var out = []

  for (var i = 0; i < items.length; i++) {
    var it = items[i]
    if (!it || !it.t || !isFinite(it.a)) continue
    /* 0 元是支付宝「订单关闭 / 已取消」这类，记进去只会污染统计 */
    if (!(Math.round(Math.abs(Number(it.a)) * 100) > 0)) continue

    var merchant = cleanText(it.m || '') || '账单导入'
    var desc = cleanText(it.d || '')
    var type = it.ty || 'expense'
    /* 原始交易类型也进分类文本：微信「转账」这类只有对方姓名，不给类型就落进未分类 */
    var cls = category.classify(merchant, (desc + ' ' + (it.raw || '')).trim(), it.pc || '', userRules, type)

    /* 支出单不能落在收入类目里：像「投诉不退款永久封号」这种说明会让关键词命中「退款」 */
    var cat = cls.cat
    if (type === 'expense' && category.CATS.income.indexOf(cat) >= 0 && cat !== category.UNCAT) {
      cat = '其他支出'
    }

    /* 资金搬移的子类由解析层给出（理财 / 借还款 / 账户转移），没给就按名字猜 */
    var moveKind = it.mk || category.transferCat(merchant, desc)

    var amt = Math.round(Number(it.a) * 100) / 100
    var sn = String(it.sn || '').trim()

    /* 有交易单号就用单号当身份（同一份账单重导、跨月导出重叠部分都不会重复记）
     * 截图没有单号，只好退回「日期+金额+商户+来源」 */
    var idKey
    if (sn) {
      idKey = hash('sn|' + (it.s || '') + '|' + sn)
    } else {
      idKey = hash(format.dayOf(it.t) + '|' + amt + '|' + merchant + '|' + (it.s || ''))
      seen[idKey] = (seen[idKey] || 0) + 1
    }
    var id = (sn ? 'b' : 'h') + idKey + (seen[idKey] > 1 ? '#' + seen[idKey] : '')

    out.push(compact({
      id: id,
      time: it.t,
      day: format.dayOf(it.t),
      ym: format.ymOf(it.t),
      amount: amt,
      type: type,
      merchant: merchant,
      desc: desc.slice(0, 24),
      category: type === 'refund'
        ? '退款'
        : (type === 'transfer' ? moveKind : cat),
      source: it.s || '账单文件',
      byPlatform: cls.by
    }))
  }

  return {
    items: out,
    source: out.length ? out[0].source : '',
    skipped: items.length - out.length
  }
}

/* 一条流水要占本地存储，空字段不写，能省下两三成体积 */
function compact(o) {
  var keys = Object.keys(o)
  for (var i = 0; i < keys.length; i++) {
    var v = o[keys[i]]
    if (v === '' || v === undefined || v === null) delete o[keys[i]]
  }
  return o
}

module.exports = {
  parseItems: parseItems,
  parseDetail: parseDetail,
  groupRows: groupRows,
  parseAmountCell: parseAmountCell,
  fromBill: fromBill
}
