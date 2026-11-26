var KEY = 'saved_filters_v1'
var MAX = 30

function read() {
  try {
    var v = wx.getStorageSync(KEY)
    return Array.isArray(v) ? v : []
  } catch (e) { return [] }
}

function write(list) {
  try { wx.setStorageSync(KEY, list); return true } catch (e) { return false }
}

function list() {
  return read().slice().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0) })
}

function save(name, filters) {
  var title = String(name || '').trim().slice(0, 20)
  if (!title) return null
  var current = read()
  if (current.length >= MAX) return null
  var item = {
    id: 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    name: title,
    filters: filters || {},
    createdAt: Date.now()
  }
  current.push(item)
  return write(current) ? item : null
}

function remove(id) {
  var current = read()
  var next = current.filter(function (item) { return item.id !== id })
  if (next.length === current.length) return true
  return write(next)
}

module.exports = { KEY: KEY, list: list, save: save, remove: remove }
