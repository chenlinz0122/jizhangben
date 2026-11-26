/* 自定义分类
 *
 * 用户自己起的类目名，只存本地：{ expense: ['咖啡'], income: ['兼职'], transfer: [] }
 * 不参与归类引擎，只决定「记一笔」里多出哪些可选项；
 * 归类引擎那边只要保证 migrate 不会把自定义名字改写成「其他支出」即可。
 */

var KEY = 'my_cats_v1'
var TYPES = ['expense', 'income', 'transfer']
var MAX = 12

function read() {
  if (typeof wx === 'undefined') return {}
  try { return wx.getStorageSync(KEY) || {} } catch (e) { return {} }
}

function write(obj) {
  if (typeof wx === 'undefined') return
  try { wx.setStorageSync(KEY, obj) } catch (e) {}
}

function list(type) {
  var all = read()
  var arr = all[type]
  return Array.isArray(arr) ? arr.filter(function (n) { return !!n }).slice() : []
}

/* 是不是用户自己建的分类（任意方向都算，migrate 用它保住名字） */
function has(name) {
  var n = String(name || '').trim()
  if (!n) return false
  for (var i = 0; i < TYPES.length; i++) {
    if (list(TYPES[i]).indexOf(n) >= 0) return true
  }
  return false
}

function check(type, name, builtin) {
  var n = String(name || '').replace(/\s+/g, '')
  if (!n) return { ok: false, msg: '名字不能为空' }
  if (n.length > 6) return { ok: false, msg: '最多 6 个字' }
  if (/^\d+$/.test(n)) return { ok: false, msg: '不要只填数字' }
  if (n === '未分类') return { ok: false, msg: '「未分类」是保留名' }
  if (builtin && builtin.indexOf(n) >= 0) return { ok: false, msg: '和默认分类重名了' }
  if (list(type).indexOf(n) >= 0) return { ok: false, msg: '已经有这个分类了' }
  return { ok: true, name: n }
}

function add(type, name, builtin) {
  var r = check(type, name, builtin)
  if (!r.ok) return r
  var all = read()
  var arr = Array.isArray(all[type]) ? all[type].slice() : []
  if (arr.length >= MAX) return { ok: false, msg: '自定义分类最多 ' + MAX + ' 个' }
  arr.push(r.name)
  all[type] = arr
  write(all)
  return { ok: true, name: r.name }
}

function remove(type, name) {
  var all = read()
  var arr = Array.isArray(all[type]) ? all[type] : []
  all[type] = arr.filter(function (n) { return n !== name })
  write(all)
}

module.exports = {
  KEY: KEY,
  MAX: MAX,
  list: list,
  has: has,
  add: add,
  remove: remove
}
