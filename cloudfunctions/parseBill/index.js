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
      parsed = bill.parseWechat(rows)
    } else {
      parsed = bill.parseAlipay(decodeText(buf))
    }

    if (!parsed.items.length) {
      return { ok: false, error: '这个文件里没读到流水，确认是「微信支付账单」或「支付宝交易明细」的原文件' }
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
