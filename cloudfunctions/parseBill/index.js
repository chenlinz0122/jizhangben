/* 账单文件解析云函数：把一个账单文件（微信 xlsx / 支付宝 csv）变成标准流水数组
 * 只做「文件 → 结构化数据」，分类留给小程序端（那边才有分类词表和用户规则） */
var cloud = require('wx-server-sdk')
var xlsx = require('./xlsx')
var bill = require('./bill')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

/* 支付宝导出的 csv 是 GBK，先严格试 UTF-8，不行再 GBK */
function decodeText(buf) {
  var s = buf.toString('utf8')
  if (!/\uFFFD/.test(s)) return s
  try {
    var TD = require('util').TextDecoder
    return new TD('gbk').decode(buf)
  } catch (e) {
    return s
  }
}

/* 依次试几种解析，第一个真的出数据的胜出；都失败就把最后一个错误抛出去 */
function tryFirst(list) {
  var lastErr = null
  for (var i = 0; i < list.length; i++) {
    try {
      var r = list[i]()
      if (r && r.items && r.items.length) return r
      lastErr = new Error('这个文件里没读到流水')
    } catch (e) {
      lastErr = e
    }
  }
  throw (lastErr || new Error('解析失败'))
}

exports.main = async function (event) {
  var fileID = event && event.fileID
  var name = String((event && event.name) || '')

  if (!fileID) return { ok: false, error: '没收到文件，重新选一次' }

  try {
    var res = await cloud.downloadFile({ fileID: fileID })
    var buf = res.fileContent
    if (!buf || !buf.length) return { ok: false, error: '文件是空的' }
    if (buf.length > 30 * 1024 * 1024) return { ok: false, error: '文件超过 30MB，先在电脑上按月份拆开' }

    var isZip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50
    var isXlsx = /\.xlsx$/i.test(name) || isZip

    var parsed
    if (isXlsx) {
      var rows = xlsx.readSheet(buf)
      /* 先是微信那一版（表头固定），不对再当银行流水按列名读 */
      parsed = tryFirst([
        function () { return bill.parseWechat(rows) },
        function () { return bill.parseBank(rows) }
      ])
    } else {
      var text = decodeText(buf)
      parsed = tryFirst([
        function () { return bill.parseAlipay(text) },
        function () { return bill.parseBank(bill.csvToRows(text)) }
      ])
    }

    if (!parsed || !parsed.items.length) {
      return { ok: false, error: '这个文件里没读到流水，确认是「微信支付账单」「支付宝交易明细」或者银行 App 导出的流水原件' }
    }

    /* 太老的数据不要，避免一次塞爆本地存储 */
    return {
      ok: true,
      source: parsed.source,
      total: parsed.items.length,
      skipped: parsed.skipped || 0,
      items: parsed.items
    }
  } catch (e) {
    return { ok: false, error: '解析失败：' + (e && e.message ? e.message : String(e)) }
  }
}
