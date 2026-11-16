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
  if ((m = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/))) {
    var mm = parseInt(m[1], 10)
    var dd = parseInt(m[2], 10)
    /* 账单基本是过去的：解析出的月份比现在大半年，就认为落在去年 */
    var yy = (mm - now.m >= 6) ? now.y - 1 : now.y
    return makeDate(yy, mm, dd)
  }
  if ((m = text.match(/(\d{1,2})-(\d{1,2})(?![\d-])/))) {
    var m2 = parseInt(m[1], 10)
    var d2 = parseInt(m[2], 10)
    var y2 = (m2 - now.m >= 6) ? now.y - 1 : now.y
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
    var yy = (mm - now.m >= 6) ? now.y - 1 : now.y
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

/* 取这张卡片的整段文字（金额行 + 后面最多两行小字），用来找分类词/日期/时间 */
function blockText(rows, i) {
  var parts = [rows[i].text]
  for (var k = i + 1; k < rows.length && k <= i + 2; k++) {
    if (rowHasAmount(rows[k])) break
    parts.push(rows[k].text)
  }
  return parts.join(' ')
}

function parseItems(items, userRules, opts) {
  var now = new Date()
  var nowInfo = { y: now.getFullYear(), m: now.getMonth() + 1, ts: now.getTime() }
  var rows = groupRows(items)
  if (!rows.length) {
    return { items: [], skipped: 0, source: '', error: '没识别到文字，换一张更清楚的截图' }
  }

  /* 来源：整张图里出现过平台名就认它 */
  var allText = rows.map(function (r) { return r.text }).join(' ')
  var source = '截图'
  if (allText.indexOf('支付宝') >= 0 || allText.indexOf('余额宝') >= 0) source = '支付宝'
  if (allText.indexOf('微信') >= 0 || allText.indexOf('零钱') >= 0) source = '微信'

  var ctxDate = null
  var out = []
  var skipped = 0
  var seen = {}

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i]
    var cells = row.cells
    var text = row.text

    /* 顶部汇总行（微信是「支出 ¥1369.74　收入 ¥1184.92」，支付宝是两格并排） */
    if (/支出/.test(text) && /收入/.test(text)) {
      skipped++
      continue
    }

    /* 金额格 */
    var amtCell = null
    var amtIdx = -1
    var inlineMerchant = ''
    for (var c = 0; c < cells.length; c++) {
      var amt = parseAmountCell(cells[c].text)
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
    if (!markRefund && /退款|退货/.test(block)) {
      type = 'refund'
    } else if (/转入|转出|转给|提现|还款|赎回|申购|基金|理财通|零钱通/.test(block)) {
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

    var cls = category.classify(merchant, text, platformCat, userRules)

    var idBase = format.dayOf(ts) + '|' + amtCell.value + '|' + merchant + '|' + source
    var idKey = hash(idBase)
    seen[idKey] = (seen[idKey] || 0) + 1
    var id = 'h' + idKey + (seen[idKey] > 1 ? '#' + seen[idKey] : '')

    out.push({
      id: id,
      time: ts,
      day: format.dayOf(ts),
      ym: format.ymOf(ts),
      amount: amtCell.value,
      type: type,
      merchant: merchant,
      desc: '',
      category: type === 'refund'
        ? '退款'
        : (type === 'transfer' ? category.transferCat(merchant, '') : cls.cat),
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
      error: '这张图里没找到带金额的账单行，确认截的是账单列表页（不是详情页）'
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
  groupRows: groupRows,
  parseAmountCell: parseAmountCell,
  fromBill: fromBill
}
