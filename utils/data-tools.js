/* 本机数据工具：免费、全量导出；恢复只交给 store 合并，不清空原账本。 */
var format = require('./format')
var KEY = 'backup_generated_v1'
var working = false
var listeners = []

function busy() { return working }

/* Tab 可以在文件读写时切换，让入口的禁用态随同一个锁更新。 */
function watch(listener) {
  listeners.push(listener)
  return function () {
    var i = listeners.indexOf(listener)
    if (i >= 0) listeners.splice(i, 1)
  }
}

function notify() {
  listeners.slice().forEach(function (listener) {
    /* 页面已经销毁等展示异常不能让文件操作的锁卡住。 */
    try { listener(working) } catch (e) {}
  })
}

function lastGenerated() {
  try {
    var n = Number(wx.getStorageSync(KEY))
    return isFinite(n) && n > 0 ? n : 0
  } catch (e) { return 0 }
}

function toast(title) { wx.showToast({ title: title, icon: 'none' }) }

function begin(onDone) {
  if (working) {
    toast('数据工具正在处理，请稍候')
    return null
  }
  working = true
  notify()
  var ended = false
  return function (result) {
    if (ended) return
    ended = true
    working = false
    notify()
    if (typeof onDone === 'function') onDone(result)
  }
}

function cancelled(err) {
  return /cancel/i.test(String((err && err.errMsg) || ''))
}

function backup(onDone) {
  var done = begin(onDone)
  if (!done) return false
  var failed = function () {
    done({ ok: false })
    toast('生成备份失败，请检查本机空间后重试')
  }
  try {
    var data = require('./store').exportAll()
    var fs = wx.getFileSystemManager()
    var now = Date.now()
    var path = wx.env.USER_DATA_PATH + '/book_backup_' + format.dayOf(now) + '_' + now + '.json'
    fs.writeFile({
      filePath: path,
      data: JSON.stringify(data),
      encoding: 'utf8',
      success: function () {
        /* 只表示文件写成，不代表已转存到小程序之外。 */
        var generated = Date.now()
        try { wx.setStorageSync(KEY, generated) } catch (e) {}
        var settled = false
        var generatedTip = function (prefix) {
          if (settled) return
          settled = true
          done({ ok: true, generated: true, path: path })
          wx.showModal({
            title: '备份文件已生成',
            content: prefix + '请将 JSON 文件另存到小程序之外，并确认可以找到。仅在本机生成不代表已安全备份；清理小程序数据可能丢失文件。\n本机路径：' + path,
            showCancel: false
          })
        }
        if (typeof wx.shareFileMessage === 'function') {
          try {
            wx.shareFileMessage({
              filePath: path,
              success: function () { generatedTip('已完成文件分享操作。') },
              fail: function (err) {
                generatedTip(cancelled(err) ? '已取消分享，文件仍只在本机。' : '文件分享未完成。')
              }
            })
          } catch (e) { generatedTip('当前无法分享文件，请更新微信后重新生成并转存。') }
        } else {
          /* openDocument 不支持 JSON，不用它冒充文件导出。 */
          generatedTip('当前微信不支持文件分享，请更新微信后重新生成并转存。')
        }
      },
      fail: failed
    })
  } catch (e) { failed() }
  return true
}

function restore(onDone) {
  var done = begin(onDone)
  if (!done) return false
  var fail = function (title) {
    done({ ok: false })
    toast(title)
  }
  var restoreFailed = function (out, err) {
    done({ ok: false, partial: !!(out && out.partial) })
    wx.showModal({
      title: '恢复失败',
      content: out && out.partial
        ? '本次恢复可能已有部分写入且回滚未完成。请先核对实际账本、导出当前数据备份，再决定是否重试；原备份文件未修改。'
        : (err ? (/格式不对/.test(String(err.message || ''))
          ? '备份文件格式不对，请选择有效的账本 JSON 备份。'
          : '恢复时发生异常，请先核对实际账本并导出当前数据，再决定是否重试。')
          : '本次恢复未保存，原备份文件未修改。可以重试，或先导出当前数据备份。'),
      showCancel: false
    })
  }
  try {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['json'],
      success: function (res) {
        var f = res && res.tempFiles && res.tempFiles[0]
        if (!f || !f.path) { fail('没有选到备份文件'); return }
        try {
          wx.getFileSystemManager().readFile({
            filePath: f.path,
            encoding: 'utf8',
            success: function (r) {
              var payload
              try { payload = JSON.parse(r.data) } catch (e) {
                fail('文件不是有效备份')
                return
              }
              var n = payload && Array.isArray(payload.txs) ? payload.txs.length : 0
              if (!n) { fail('备份里没有流水'); return }
              try {
                wx.showModal({
                  title: '恢复备份？',
                  content: '备份里有 ' + n + ' 笔流水；将按现有规则合并，已存在的会自动跳过，不清空原账本。备份中的预算和分类规则也会恢复，请先生成当前账本备份。',
                  confirmText: '恢复',
                  success: function (m) {
                    if (!m.confirm) { done({ ok: false, cancelled: true }); return }
                    var out
                    try { out = require('./store').importAll(payload) } catch (err) {
                      restoreFailed(null, err)
                      return
                    }
                    if (!out || out.saved !== true || out.partial) {
                      restoreFailed(out)
                      return
                    }
                    done({ ok: true, result: out })
                    wx.showModal({
                      title: '恢复完成',
                      content: '新增 ' + out.added + ' 笔，重复跳过 ' + out.dup + ' 笔，合并 ' + out.merged + ' 笔' +
                        (out.skipped ? '，无效数据跳过 ' + out.skipped + ' 笔' : '') +
                        '；库里共 ' + out.total + ' 笔。',
                      showCancel: false
                    })
                  },
                  fail: function () { fail('未能打开恢复确认，请重试') }
                })
              } catch (e) { fail('未能打开恢复确认，请重试') }
            },
            fail: function () { fail('读不到这个文件') }
          })
        } catch (e) { fail('读不到这个文件') }
      },
      fail: function (err) {
        if (cancelled(err)) done({ ok: false, cancelled: true })
        else fail('未能选择文件，请重试')
      }
    })
  } catch (e) { fail('当前无法选择备份文件，请更新微信后重试') }
  return true
}

module.exports = {
  backup: backup,
  restore: restore,
  busy: busy,
  watch: watch,
  lastGenerated: lastGenerated
}
