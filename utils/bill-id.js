/* 账单型流水统一身份：文本导入、文件导入和详情截图必须生成同一个 id。 */
function hash(s) {
  var h = 5381
  for (var i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  }
  return h.toString(36)
}

function tradeNoId(source, tradeNo) {
  var sn = String(tradeNo || '').trim()
  if (!sn) return ''
  return 'b' + hash('sn|' + String(source || '') + '|' + sn)
}

/* 旧版文本解析器使用 source + tradeNo。保留这个别名用于识别升级前已入库的流水，
   避免统一 id 后老记录再次导入时被当成另一笔。 */
function legacyTradeNoId(source, tradeNo) {
  var sn = String(tradeNo || '').trim()
  if (!sn) return ''
  return 'b' + hash(String(source || '') + sn)
}

module.exports = {
  hash: hash,
  tradeNoId: tradeNoId,
  legacyTradeNoId: legacyTradeNoId
}
