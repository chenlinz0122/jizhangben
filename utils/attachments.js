/* 流水票据：元数据存 tx_attachments_v1，图片只存 USER_DATA_PATH/receipts/。
 * 所有写操作都先校验临时文件；复制失败或元数据写入失败会清理本次复制的图片。
 * planImport 与账本其他功能保持一致：只生成合并计划，不写存储、不复制图片。
 */
var KEY = 'tx_attachments_v1'
var _idCounter = 0

function own(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

function object(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function put(obj, key, value) {
  Object.defineProperty(obj, key, { value: value, enumerable: true, writable: true, configurable: true })
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/')
}

function pathKey(value) {
  var p = normalizePath(value)
  return /^[A-Za-z]:\//.test(p) ? p.toLowerCase() : p
}

function validId(value) {
  return typeof value === 'string' && !!value.trim() && value.length <= 200
}

function requireTxId(txId) {
  if (!validId(txId)) throw new Error('流水 ID 不能为空')
  return txId
}

function receiptsDir() {
  var root = normalizePath(wx.env && wx.env.USER_DATA_PATH).replace(/\/+$/, '')
  if (!root) throw new Error('无法获取本地图片目录')
  return root + '/receipts'
}

function managedPath(path) {
  var p = normalizePath(path)
  var dir = receiptsDir()
  var prefix = dir + '/'
  var same = pathKey(p).indexOf(pathKey(prefix)) === 0
  if (!same) return false
  var rest = p.slice(prefix.length)
  return !!rest && rest.split('/').indexOf('..') < 0
}

function fileInfo(path, onlyManaged) {
  if (onlyManaged && !managedPath(path)) return null
  try {
    var fs = wx.getFileSystemManager()
    var stat = fs.statSync(normalizePath(path))
    if (!stat) return null
    if (typeof stat.isFile === 'function') return stat.isFile() ? stat : null
    if (stat.isFile === false || stat.isDirectory === true) return null
    return stat
  } catch (e) {
    return null
  }
}

function baseName(path) {
  var parts = normalizePath(path).split('/')
  return parts[parts.length - 1] || ''
}

function cleanName(value, path) {
  var name = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!name) name = baseName(path)
  return (name || '票据图片').slice(0, 120)
}

function normalizeMetadata(raw) {
  if (!object(raw) || !validId(raw.id) || typeof raw.path !== 'string') return null
  var addedAt = raw.addedAt
  if (typeof addedAt !== 'number' || !isFinite(addedAt) || addedAt < 0) return null
  var item = {
    id: raw.id.trim(),
    path: normalizePath(raw.path),
    name: cleanName(raw.name, raw.path),
    addedAt: addedAt
  }
  if (raw.missing === true) item.missing = true
  var sizeFields = ['compressedAt', 'compressedFromBytes', 'bytes']
  sizeFields.forEach(function (key) {
    if (typeof raw[key] === 'number' && isFinite(raw[key]) && raw[key] >= 0) item[key] = raw[key]
  })
  return item
}

function readAll() {
  var raw
  try { raw = wx.getStorageSync(KEY) } catch (e) { throw new Error('票据数据读取失败') }
  if (!object(raw)) return {}
  var out = {}
  Object.keys(raw).forEach(function (txId) {
    if (!validId(txId) || !Array.isArray(raw[txId])) return
    var seen = Object.create(null)
    var rows = []
    raw[txId].forEach(function (value) {
      var item = normalizeMetadata(value)
      if (!item || seen[item.id]) return
      seen[item.id] = true
      rows.push(item)
    })
    if (rows.length) put(out, txId, rows)
  })
  return out
}

function writeAll(data) {
  try { wx.setStorageSync(KEY, clone(data)) } catch (e) {
    throw new Error('票据数据保存失败，请检查存储空间')
  }
}

function validateItem(item) {
  var next = clone(item)
  if (!managedPath(next.path) || !fileInfo(next.path, true)) next.missing = true
  else delete next.missing
  return next
}

function validateMap(data) {
  var out = {}
  Object.keys(data).forEach(function (txId) {
    var rows = data[txId].map(validateItem)
    if (rows.length) put(out, txId, rows)
  })
  return out
}

function list(txId) {
  if (!validId(txId)) return []
  var data = readAll()
  var rows = own(data, txId) ? data[txId] : []
  var checked = rows.map(validateItem)
  if (JSON.stringify(rows) !== JSON.stringify(checked)) {
    if (checked.length) put(data, txId, checked)
    else delete data[txId]
    writeAll(data)
  }
  return clone(checked)
}

function ensureDir() {
  var fs = wx.getFileSystemManager()
  var dir = receiptsDir()
  try { fs.mkdirSync({ dirPath: dir, recursive: true }); return } catch (e) {}
  try { fs.mkdirSync(dir, true); return } catch (e) {}
  try {
    var stat = fs.statSync(dir)
    if (stat && (typeof stat.isDirectory !== 'function' || stat.isDirectory())) return
  } catch (error) {}
  throw new Error('无法创建本地票据目录')
}

function copyFile(src, dest) {
  var fs = wx.getFileSystemManager()
  try { fs.copyFileSync({ srcPath: src, destPath: dest }); return } catch (e) {}
  try { fs.copyFileSync(src, dest); return } catch (error) {
    throw new Error('图片复制失败，请检查本机存储空间')
  }
}

function unlinkFile(path) {
  if (!managedPath(path) || !fileInfo(path, true)) return false
  var fs = wx.getFileSystemManager()
  try { fs.unlinkSync(normalizePath(path)); return true } catch (e) {}
  try { fs.unlinkSync({ filePath: normalizePath(path) }); return true } catch (error) {
    throw new Error('图片文件删除失败，请重试')
  }
}

function bytesOf(data) {
  if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) return new Uint8Array(data)
  if (data && data.buffer && typeof data.byteOffset === 'number') {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  if (typeof data === 'string') {
    var out = new Uint8Array(data.length)
    for (var s = 0; s < data.length; s++) out[s] = data.charCodeAt(s) & 255
    return out
  }
  return new Uint8Array(data || [])
}

/* 用内容指纹去重，不往规定存储结构里塞 hash 字段。 */
function signature(path) {
  var stat = fileInfo(path, false)
  if (!stat) return ''
  try {
    var bytes = bytesOf(wx.getFileSystemManager().readFileSync(normalizePath(path)))
    var h1 = 2166136261
    var h2 = 2246822519
    for (var i = 0; i < bytes.length; i++) {
      h1 = Math.imul(h1 ^ bytes[i], 16777619)
      h2 = Math.imul(h2 ^ bytes[i], 3266489917)
    }
    return bytes.length + ':' + (h1 >>> 0).toString(16) + ':' + (h2 >>> 0).toString(16)
  } catch (e) {
    return ''
  }
}

function extension(name, path) {
  var source = String(name || '') + ' ' + baseName(path)
  var match = source.toLowerCase().match(/\.([a-z0-9]{2,5})(?:\s|$)/)
  var ext = match ? match[1] : 'jpg'
  return ['jpg', 'jpeg', 'png', 'webp', 'heic', 'gif', 'bmp'].indexOf(ext) >= 0 ? ext : 'jpg'
}

function idInUse(data, id) {
  var ids = Object.keys(data)
  for (var i = 0; i < ids.length; i++) {
    if ((data[ids[i]] || []).some(function (item) { return item.id === id })) return true
  }
  return false
}

function newId(data) {
  var id
  do {
    _idCounter++
    id = 'att_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8) + '_' + _idCounter.toString(36)
  } while (idInUse(data, id))
  return id
}

function normalizeSource(raw) {
  var path = typeof raw === 'string' ? raw : raw && raw.path
  if (typeof path !== 'string' || !path) return null
  return { path: normalizePath(path), name: cleanName(raw && raw.name, path) }
}

function attach(txId, tempFiles) {
  requireTxId(txId)
  if (!Array.isArray(tempFiles)) tempFiles = typeof tempFiles === 'string' ? [tempFiles] : []
  if (!tempFiles.length) return { added: 0, duplicate: 0, skipped: 0, items: list(txId) }

  var data = readAll()
  var current = clone(own(data, txId) ? data[txId] : [])
  var known = Object.create(null)
  current.forEach(function (item) {
    if (item.missing) return
    var sig = signature(item.path)
    if (sig) known[sig] = true
  })
  var sources = Object.create(null)
  var created = []
  var added = []
  var duplicate = 0
  var skipped = 0
  var dirReady = false
  var now = Date.now()

  try {
    tempFiles.forEach(function (raw) {
      var source = normalizeSource(raw)
      if (!source) { skipped++; return }
      var sourceKey = pathKey(source.path)
      if (sources[sourceKey]) { duplicate++; return }
      sources[sourceKey] = true
      if (!fileInfo(source.path, false)) { skipped++; return }
      var sig = signature(source.path)
      if (sig && known[sig]) { duplicate++; return }
      if (!dirReady) { ensureDir(); dirReady = true }
      var id = newId(data)
      var dest = receiptsDir() + '/' + id + '.' + extension(source.name, source.path)
      created.push(dest)
      copyFile(source.path, dest)
      var item = { id: id, path: dest, name: source.name, addedAt: now }
      current.push(item)
      added.push(item)
      put(data, txId, current)
      if (sig) known[sig] = true
    })
    if (!added.length && !duplicate && skipped) throw new Error('没有可添加的图片，请重新选择')
    if (added.length) writeAll(data)
    return { added: added.length, duplicate: duplicate, skipped: skipped, items: clone(current) }
  } catch (e) {
    created.forEach(function (path) { try { unlinkFile(path) } catch (error) {} })
    throw e
  }
}

function pathInUse(data, path, exceptTx, exceptId) {
  var target = pathKey(path)
  var ids = Object.keys(data)
  for (var i = 0; i < ids.length; i++) {
    var txId = ids[i]
    var rows = own(data, txId) ? data[txId] : []
    for (var j = 0; j < rows.length; j++) {
      if (txId === exceptTx && rows[j].id === exceptId) continue
      if (pathKey(rows[j].path) === target) return true
    }
  }
  return false
}

function remove(txId, attachmentId) {
  requireTxId(txId)
  if (!validId(attachmentId)) return { removed: false, fileRemoved: false }
  var data = readAll()
  var rows = own(data, txId) ? data[txId] : []
  var index = -1
  for (var i = 0; i < rows.length; i++) if (rows[i].id === attachmentId) { index = i; break }
  if (index < 0) return { removed: false, fileRemoved: false }

  var item = rows[index]
  var next = clone(data)
  next[txId] = rows.filter(function (row) { return row.id !== attachmentId })
  if (!next[txId].length) delete next[txId]
  writeAll(next)
  var fileRemoved = false
  try {
    if (!pathInUse(next, item.path)) fileRemoved = unlinkFile(item.path)
  } catch (e) {
    try { writeAll(data) } catch (rollback) {}
    throw e
  }
  return { removed: true, fileRemoved: fileRemoved }
}

function removeTx(txId) {
  requireTxId(txId)
  var data = readAll()
  var rows = own(data, txId) ? data[txId] : []
  if (!rows.length) return { removed: 0, filesRemoved: 0 }
  var paths = Object.create(null)
  rows.forEach(function (item) { paths[pathKey(item.path)] = item.path })
  var next = clone(data)
  delete next[txId]
  writeAll(next)
  var filesRemoved = 0
  var failed = 0
  Object.keys(paths).forEach(function (key) {
    if (pathInUse(next, paths[key])) return
    try { if (unlinkFile(paths[key])) filesRemoved++ } catch (e) { failed++ }
  })
  if (failed) throw new Error('票据关联已清理，但有 ' + failed + ' 个图片文件删除失败')
  return { removed: rows.length, filesRemoved: filesRemoved }
}

function exportData() {
  return validateMap(readAll())
}

function apiError(message, code, extra) {
  var error = new Error(message)
  error.code = code
  if (extra) Object.keys(extra).forEach(function (key) { error[key] = extra[key] })
  return error
}

/* 同时兼容回调式与 Promise 式小程序 API。 */
function callWx(name, args) {
  return new Promise(function (resolve, reject) {
    if (typeof wx[name] !== 'function') {
      reject(apiError('当前环境不支持' + (name === 'compressImage' ? '图片压缩' : '保存到相册'), 'API_UNAVAILABLE'))
      return
    }
    var settled = false
    function done(callback, value) {
      if (settled) return
      settled = true
      callback(value)
    }
    try {
      var result = wx[name](Object.assign({}, args, {
        success: function (res) { done(resolve, res || {}) },
        fail: function (err) { done(reject, err || new Error('操作失败')) }
      }))
      if (result && typeof result.then === 'function') result.then(function (res) { done(resolve, res || {}) }, function (err) { done(reject, err) })
    } catch (e) { done(reject, e) }
  })
}

function selectedRows(data, txId, attachmentIds) {
  var rows = own(data, txId) ? data[txId] : []
  if (attachmentIds === undefined) return rows.slice()
  if (!Array.isArray(attachmentIds)) attachmentIds = [attachmentIds]
  var ids = Object.create(null)
  attachmentIds.forEach(function (id) { if (validId(id)) ids[id] = true })
  return rows.filter(function (item) { return ids[item.id] })
}

function progress(options, completed, total, item) {
  if (!options || typeof options.onProgress !== 'function') return
  try { options.onProgress({ completed: completed, total: total, itemId: item && item.id }) } catch (e) {}
}

function failure(item, error, defaultCode) {
  var code = error && error.code || defaultCode || 'OPERATION_FAILED'
  var message = error && error.errMsg || error && error.message || '操作失败，请重试'
  var out = { id: item.id, name: item.name, code: code, message: String(message) }
  if (error && error.needsSettings) out.needsSettings = true
  return out
}

function resultItems(data, txId) {
  return clone(own(data, txId) ? data[txId] : [])
}

function uniqueCompressedPath(item) {
  var dir = receiptsDir()
  var stamp = Date.now().toString(36)
  var safeId = String(item.id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'attachment'
  var base = dir + '/' + safeId + '.compressed.' + stamp
  var target = base + '.jpg'
  var index = 1
  while (fileInfo(target, false)) target = base + '-' + (index++) + '.jpg'
  return target
}

function compressedName(item) {
  var stem = baseName(item.path).replace(/\.[^.]+$/, '') || '票据'
  return cleanName(stem + '-压缩.jpg', item.path)
}

/* 每张独立提交元数据；写入失败只删除新副本，原图与旧引用保持不变。 */
function compress(txId, attachmentIds, options) {
  requireTxId(txId)
  var data = readAll()
  var rows = selectedRows(data, txId, attachmentIds)
  var result = { compressed: 0, failed: 0, skipped: 0, savedBytes: 0, degraded: false, errors: [], items: resultItems(data, txId) }
  if (!rows.length) return Promise.resolve(result)
  if (typeof wx.compressImage !== 'function') {
    result.degraded = true
    rows.forEach(function (item) {
      if (item.missing || !managedPath(item.path) || !fileInfo(item.path, true)) result.skipped++
      else {
        result.failed++
        result.errors.push(failure(item, apiError('当前环境不支持图片压缩，已保留原图', 'API_UNAVAILABLE'), 'API_UNAVAILABLE'))
      }
    })
    return Promise.resolve(result)
  }

  var chain = Promise.resolve()
  rows.forEach(function (item) {
    chain = chain.then(function () {
      var dest = ''
      var created = false
      var committed = false
      return Promise.resolve().then(function () {
        var before = fileInfo(item.path, true)
        if (!before) { result.skipped++; return false }
        ensureDir()
        dest = uniqueCompressedPath(item)
        return callWx('compressImage', { srcPath: item.path, quality: 65 }).then(function (res) {
          var tempPath = res && res.tempFilePath
          if (!tempPath || !fileInfo(tempPath, false)) throw apiError('压缩结果不可用，已保留原图', 'COMPRESS_FAILED')
          created = true
          copyFile(normalizePath(tempPath), dest)
          var after = fileInfo(dest, true)
          if (!after) throw apiError('压缩图片保存失败，已保留原图', 'COMPRESS_FAILED')
          var next = clone(data)
          var current = own(next, txId) ? next[txId] : []
          var index = -1
          for (var i = 0; i < current.length; i++) if (current[i].id === item.id) { index = i; break }
          if (index < 0) throw apiError('票据记录已变化，已保留原图', 'METADATA_CHANGED')
          var oldBytes = typeof before.size === 'number' && isFinite(before.size) ? before.size : 0
          var newBytes = typeof after.size === 'number' && isFinite(after.size) ? after.size : 0
          current[index] = Object.assign({}, current[index], {
            path: dest,
            name: compressedName(item),
            compressedAt: Date.now(),
            compressedFromBytes: oldBytes,
            bytes: newBytes
          })
          delete current[index].missing
          put(next, txId, current)
          writeAll(next)
          data = next
          committed = true
          result.compressed++
          result.savedBytes += Math.max(0, oldBytes - newBytes)
          if (!pathInUse(data, item.path)) {
            try { unlinkFile(item.path) } catch (error) {}
          }
        }).catch(function (error) {
          result.failed++
          result.errors.push(failure(item, error, 'COMPRESS_FAILED'))
        }).then(function () {
          if (created && !committed) {
            try { unlinkFile(dest) } catch (error) {}
          }
        })
      }).catch(function (error) {
        result.failed++
        result.errors.push(failure(item, error, 'COMPRESS_FAILED'))
      })
    }).then(function () {
      progress(options, result.compressed + result.failed + result.skipped, rows.length, item)
    })
  })
  return chain.then(function () {
    result.items = resultItems(data, txId)
    return result
  })
}

function needsAlbumPermission(error) {
  var message = String(error && (error.errMsg || error.message) || '')
  return /auth|permission|deny|拒绝|权限|授权/i.test(message)
}

function saveToAlbum(item) {
  return callWx('saveImageToPhotosAlbum', { filePath: item.path }).catch(function (error) {
    if (!needsAlbumPermission(error)) throw error
    if (typeof wx.authorize !== 'function') throw apiError('需要相册权限，请前往系统设置开启', 'PERMISSION_DENIED', { needsSettings: true })
    return callWx('authorize', { scope: 'writePhotosAlbum' }).then(function () {
      return callWx('saveImageToPhotosAlbum', { filePath: item.path })
    }, function (authError) {
      if (needsAlbumPermission(authError)) throw apiError('相册权限被拒绝，请前往系统设置开启', 'PERMISSION_DENIED', { needsSettings: true })
      throw authError
    })
  })
}

/* 逐张保存，不生成 ZIP；权限被拒后剩余图片明确标记为跳过。 */
function exportToAlbum(txId, attachmentIds, options) {
  requireTxId(txId)
  var data = readAll()
  var rows = selectedRows(data, txId, attachmentIds)
  var result = { saved: 0, failed: 0, skipped: 0, needsSettings: false, errors: [] }
  if (!rows.length) return Promise.resolve(result)
  if (typeof wx.saveImageToPhotosAlbum !== 'function') {
    result.degraded = true
    rows.forEach(function (item) {
      if (item.missing || !managedPath(item.path) || !fileInfo(item.path, true)) result.skipped++
      else {
        result.failed++
        result.errors.push(failure(item, apiError('当前环境不支持保存到相册', 'API_UNAVAILABLE'), 'API_UNAVAILABLE'))
      }
    })
    return Promise.resolve(result)
  }

  var permissionDenied = false
  var chain = Promise.resolve()
  rows.forEach(function (item) {
    chain = chain.then(function () {
      if (permissionDenied) { result.skipped++; return }
      if (item.missing || !managedPath(item.path) || !fileInfo(item.path, true)) { result.skipped++; return }
      return saveToAlbum(item).then(function () {
        result.saved++
      }, function (error) {
        result.failed++
        if (error.needsSettings) { result.needsSettings = true; permissionDenied = true }
        result.errors.push(failure(item, error, 'EXPORT_FAILED'))
      })
    }).then(function () {
      progress(options, result.saved + result.failed + result.skipped, rows.length, item)
    })
  })
  return chain.then(function () { return result })
}

function parsePayload(payload) {
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload) } catch (e) { throw new Error('票据备份格式不对') }
  }
  if (payload === undefined) return {}
  if (!object(payload)) throw new Error('票据备份格式不对')
  if (own(payload, 'attachments') && object(payload.attachments)) {
    if (payload.version !== undefined && payload.version !== 1) throw new Error('票据备份版本不支持')
    payload = payload.attachments
  }
  return payload
}

/* 同 txId 下按附件 id 合并，备份优先；所有路径重新验真，坏路径只标记 missing。
 * 这里只调用 stat/read，不调用 mkdir/copy/unlink/setStorage。 */
function planImport(payload) {
  var incoming = parsePayload(payload)
  var current = readAll()
  var checkedCurrent = validateMap(current)
  var merged = clone(checkedCurrent)
  var added = 0
  var updated = 0
  var unchanged = 0
  var skipped = 0

  Object.keys(incoming).forEach(function (txId) {
    if (!validId(txId) || !Array.isArray(incoming[txId])) throw new Error('票据备份格式不对')
    var seen = Object.create(null)
    incoming[txId].forEach(function (raw) {
      var item = normalizeMetadata(raw)
      if (!item || seen[item.id]) { skipped++; return }
      seen[item.id] = true
      item = validateItem(item)
      var rows = own(merged, txId) ? merged[txId] : []
      var index = -1
      for (var i = 0; i < rows.length; i++) if (rows[i].id === item.id) { index = i; break }
      if (index < 0) { rows.push(item); added++ }
      else if (JSON.stringify(rows[index]) !== JSON.stringify(item)) { rows[index] = item; updated++ }
      else unchanged++
      if (rows.length) put(merged, txId, rows)
    })
  })

  var missing = 0
  var total = 0
  Object.keys(merged).forEach(function (txId) {
    merged[txId].forEach(function (item) { total++; if (item.missing) missing++ })
  })
  var changes = JSON.stringify(current) === JSON.stringify(merged)
    ? [] : [{ key: KEY, value: clone(merged) }]
  return {
    ok: true,
    value: merged,
    changes: changes,
    added: added,
    updated: updated,
    unchanged: unchanged,
    skipped: skipped,
    missing: missing,
    total: total
  }
}

module.exports = {
  KEY: KEY,
  list: list,
  attach: attach,
  remove: remove,
  removeTx: removeTx,
  exportData: exportData,
  compress: compress,
  exportToAlbum: exportToAlbum,
  planImport: planImport
}
