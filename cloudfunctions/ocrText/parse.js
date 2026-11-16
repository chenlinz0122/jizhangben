/* 云函数内部用的纯函数：把两种 OCR 的返回统一成 [{text,left,top,height}]
 * 单独拆文件是为了能在本地 node 里直接测，不用连云环境。 */

function num(v) {
  var n = Number(v)
  return isNaN(n) ? 0 : n
}

/* 微信通用印刷体：{ items: [{ text, pos: { left, top, height } }] } */
function mapWx(res) {
  var raw = (res && (res.items || res.item_list)) || []
  var out = []
  for (var i = 0; i < raw.length; i++) {
    var it = raw[i] || {}
    var p = it.pos || {}
    var text = String(it.text || '')
    if (!text) continue
    out.push({ text: text, left: num(p.left), top: num(p.top), height: num(p.height) })
  }
  return out
}

/* 百度通用文字识别（含位置）：{ words_result: [{ words, location: { left, top, width, height } }] } */
function mapBaidu(res) {
  var raw = (res && res.words_result) || []
  var out = []
  for (var i = 0; i < raw.length; i++) {
    var it = raw[i] || {}
    var loc = it.location || {}
    var text = String(it.words || '')
    if (!text) continue
    out.push({ text: text, left: num(loc.left), top: num(loc.top), height: num(loc.height) })
  }
  return out
}

/* 百度要求 base64 后不超过 4M。base64 膨胀 4/3，所以原始字节上限 = 4M × 3/4 ≈ 3M 字节；
 * 3MiB（3.15M 字节）base64 后约 4.19M，按字节算仍然超 4M，会被拒。留足余量取 2.8MiB。 */
function tooBig(bytes) {
  return num(bytes) > 2.8 * 1024 * 1024
}

/* 长图越窄越高，识别越容易糊；给个提醒阈值 */
function isVeryLong(width, height) {
  if (!width || !height) return false
  return height / width > 6
}

module.exports = {
  mapWx: mapWx,
  mapBaidu: mapBaidu,
  tooBig: tooBig,
  isVeryLong: isVeryLong,
  num: num
}
