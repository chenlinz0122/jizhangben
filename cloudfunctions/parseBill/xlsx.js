/* 极简 xlsx 读取器：只用 node 内置 zlib，不装任何依赖
 * 微信账单导出的 xlsx 就 sharedStrings + 一张 sheet，够用 */
var zlib = require('zlib')

var MAX_ENTRIES = 512
var MAX_ENTRY_BYTES = 32 * 1024 * 1024
var MAX_TOTAL_BYTES = 64 * 1024 * 1024
var MAX_ROWS = 50000
var MAX_COLS = 256
var MAX_CELLS = 2000000
var MAX_SHARED = 100000

function readZip(buf) {
  var eocd = -1
  for (var i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx 文件')

  var count = buf.readUInt16LE(eocd + 10)
  var cdOff = buf.readUInt32LE(eocd + 16)
  if (count > MAX_ENTRIES) throw new Error('xlsx 条目过多，已停止解析')
  if (cdOff > buf.length || cdOff + count * 46 > buf.length) throw new Error('ZIP 中央目录损坏')
  var entries = {}
  var totalBytes = 0
  var p = cdOff

  for (var k = 0; k < count; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP 中央目录损坏')
    var method = buf.readUInt16LE(p + 10)
    var uncompSize = buf.readUInt32LE(p + 24)
    var compSize = buf.readUInt32LE(p + 20)
    var nameLen = buf.readUInt16LE(p + 28)
    var extraLen = buf.readUInt16LE(p + 30)
    var commentLen = buf.readUInt16LE(p + 32)
    var lho = buf.readUInt32LE(p + 42)
    if (p + 46 + nameLen + extraLen + commentLen > buf.length) throw new Error('ZIP 条目信息损坏')
    if (method !== 0 && method !== 8) throw new Error('xlsx 包含不支持的压缩方式')
    if (uncompSize > MAX_ENTRY_BYTES || totalBytes + uncompSize > MAX_TOTAL_BYTES) {
      throw new Error('xlsx 解压后体积过大，已停止解析')
    }
    totalBytes += uncompSize
    var name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8')
    if (!name || entries[name]) throw new Error('ZIP 条目名为空或重复')
    entries[name] = { method: method, compSize: compSize, uncompSize: uncompSize, lho: lho }
    p += 46 + nameLen + extraLen + commentLen
  }

  return {
    names: Object.keys(entries),
    has: function (name) { return !!entries[name] },
    read: function (name) {
      var e = entries[name]
      if (!e) return null
      var q = e.lho
      if (q + 30 > buf.length || buf.readUInt32LE(q) !== 0x04034b50) throw new Error('ZIP 局部头损坏')
      var nl = buf.readUInt16LE(q + 26)
      var el = buf.readUInt16LE(q + 28)
      var start = q + 30 + nl + el
      if (start > buf.length || e.compSize > buf.length - start) throw new Error('ZIP 条目数据损坏')
      var data = buf.slice(start, start + e.compSize)
      var out = data
      if (e.method === 8) {
        try {
          out = zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES })
        } catch (err) {
          throw new Error('xlsx 解压失败或展开体积超过限制')
        }
      }
      if (out.length !== e.uncompSize) throw new Error('ZIP 条目大小校验失败')
      return out
    }
  }
}

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function pickText(xml) {
  /* 去掉拼音注音块，再把所有 <t> 拼起来 */
  var noPh = xml.replace(/<rPh[^>]*>[\s\S]*?<\/rPh>/g, '')
  var parts = noPh.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []
  var out = ''
  for (var i = 0; i < parts.length; i++) {
    out += decodeXml(parts[i].replace(/<[^>]+>/g, ''))
  }
  return out
}

function colIndex(ref) {
  var letters = String(ref).replace(/[0-9]/g, '').toUpperCase()
  var n = 0
  for (var i = 0; i < letters.length; i++) {
    n = n * 26 + (letters.charCodeAt(i) - 64)
  }
  return n - 1
}

/* 返回二维数组（行优先，缺的格子为 undefined） */
function readSheet(buf) {
  var zip = readZip(buf)

  var shared = []
  var ssName = 'xl/sharedStrings.xml'
  if (zip.has(ssName)) {
    var ss = zip.read(ssName).toString('utf8')
    var sis = ss.match(/<si>[\s\S]*?<\/si>/g) || []
    if (sis.length > MAX_SHARED) throw new Error('xlsx 共享字符串过多，已停止解析')
    for (var i = 0; i < sis.length; i++) shared.push(pickText(sis[i]))
  }

  /* 找第一个 sheet */
  var sheetName = 'xl/worksheets/sheet1.xml'
  if (!zip.has(sheetName) && zip.has('xl/workbook.xml')) {
    var names = zip.names.filter(function (n) { return /^xl\/worksheets\/sheet\d+\.xml$/.test(n) })
    if (names.length) sheetName = names[0]
  }
  if (!zip.has(sheetName)) throw new Error('xlsx 里没找到工作表')

  var sheet = zip.read(sheetName).toString('utf8')
  var rowXmls = sheet.match(/<row[^>]*>[\s\S]*?<\/row>/g) || []
  if (rowXmls.length > MAX_ROWS) throw new Error('xlsx 行数超过限制，请按月份拆分')

  var rows = []
  var totalCells = 0
  for (var r = 0; r < rowXmls.length; r++) {
    var cellsXml = rowXmls[r].match(/<c[\s>][\s\S]*?<\/c>/g) || []
    totalCells += cellsXml.length
    if (totalCells > MAX_CELLS) throw new Error('xlsx 单元格过多，请按月份拆分')
    var row = []
    for (var c2 = 0; c2 < cellsXml.length; c2++) {
      var cell = cellsXml[c2]
      var refM = cell.match(/r="([A-Za-z]+)\d*"/)
      var idx = refM ? colIndex(refM[1]) : row.length
      if (idx < 0 || idx >= MAX_COLS) throw new Error('xlsx 列数超过限制')
      var tM = cell.match(/t="([^"]+)"/)
      var type = tM ? tM[1] : ''
      var val = ''

      if (type === 's') {
        var vM = cell.match(/<v>([\s\S]*?)<\/v>/)
        var sharedIdx = vM ? parseInt(vM[1], 10) : -1
        val = sharedIdx >= 0 && sharedIdx < shared.length ? shared[sharedIdx] : ''
      } else if (type === 'inlineStr') {
        val = pickText(cell)
      } else if (type === 'str') {
        var vm2 = cell.match(/<v>([\s\S]*?)<\/v>/)
        val = vm2 ? decodeXml(vm2[1]) : ''
      } else if (type === 'b') {
        val = ''
      } else {
        var vm3 = cell.match(/<v>([\s\S]*?)<\/v>/)
        val = vm3 ? decodeXml(vm3[1]) : ''
      }
      row[idx] = String(val).trim()
    }
    rows.push(row)
  }
  return rows
}

module.exports = { readSheet: readSheet }
