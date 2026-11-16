/* 极简 xlsx 读取器：只用 node 内置 zlib，不装任何依赖
 * 微信账单导出的 xlsx 就 sharedStrings + 一张 sheet，够用 */
var zlib = require('zlib')

function readZip(buf) {
  var eocd = -1
  for (var i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx 文件')

  var count = buf.readUInt16LE(eocd + 10)
  var cdOff = buf.readUInt32LE(eocd + 16)
  var entries = {}
  var p = cdOff

  for (var k = 0; k < count; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break
    var method = buf.readUInt16LE(p + 10)
    var compSize = buf.readUInt32LE(p + 20)
    var nameLen = buf.readUInt16LE(p + 28)
    var extraLen = buf.readUInt16LE(p + 30)
    var commentLen = buf.readUInt16LE(p + 32)
    var lho = buf.readUInt32LE(p + 42)
    var name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8')
    entries[name] = { method: method, compSize: compSize, lho: lho }
    p += 46 + nameLen + extraLen + commentLen
  }

  return {
    names: Object.keys(entries),
    has: function (name) { return !!entries[name] },
    read: function (name) {
      var e = entries[name]
      if (!e) return null
      var q = e.lho
      if (buf.readUInt32LE(q) !== 0x04034b50) throw new Error('ZIP 局部头损坏')
      var nl = buf.readUInt16LE(q + 26)
      var el = buf.readUInt16LE(q + 28)
      var start = q + 30 + nl + el
      var data = buf.slice(start, start + e.compSize)
      if (e.method === 0) return data
      return zlib.inflateRawSync(data)
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

  var rows = []
  for (var r = 0; r < rowXmls.length; r++) {
    var cellsXml = rowXmls[r].match(/<c[\s>][\s\S]*?<\/c>/g) || []
    var row = []
    for (var c2 = 0; c2 < cellsXml.length; c2++) {
      var cell = cellsXml[c2]
      var refM = cell.match(/r="([A-Za-z]+)\d*"/)
      var idx = refM ? colIndex(refM[1]) : row.length
      var tM = cell.match(/t="([^"]+)"/)
      var type = tM ? tM[1] : ''
      var val = ''

      if (type === 's') {
        var vM = cell.match(/<v>([\s\S]*?)<\/v>/)
        val = vM ? (shared[parseInt(vM[1], 10)] || '') : ''
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
