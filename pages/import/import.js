var darkmode = require('../../utils/darkmode')
var parser = require('../../utils/parser')
var parsesms = require('../../utils/parsesms')
var store = require('../../utils/store')
var format = require('../../utils/format')
var ocrbill = require('../../utils/ocrbill')
var vip = require('../../utils/vip')

var DEMO = [
  '交易时间\t交易分类\t交易对方\t商品说明\t收/支\t金额\t收/付款方式\t交易状态\t交易订单号\t商家订单号\t备注',
  '2026-11-01 12:31:20\t餐饮美食\t美团外卖\t午餐\t支出\t28.50\t余额宝\t交易成功\t20261101001\t\t',
  '2026-11-02 08:12:05\t交通出行\t滴滴出行\t快车\t支出\t16.80\t花呗\t交易成功\t20261102002\t\t',
  '2026-11-03 19:45:33\t日用百货\t盒马鲜生\t生鲜蔬菜\t支出\t63.20\t余额宝\t交易成功\t20261103003\t\t',
  '2026-11-05 21:10:12\t休闲娱乐\t猫眼电影\t电影票\t支出\t45.00\t花呗\t交易成功\t20261105004\t\t',
  '2026-11-07 10:02:44\t通讯网络\t中国移动\t话费充值\t支出\t100.00\t余额宝\t交易成功\t20261107005\t\t',
  '2026-11-09 14:20:18\t医疗健康\t杭州口腔医院\t补牙\t支出\t380.00\t银行卡\t交易成功\t20261109006\t\t',
  '2026-11-10 09:00:00\t其他\t某某公司\t10月工资\t收入\t4500.00\t银行卡\t交易成功\t20261110007\t\t',
  '2026-11-12 15:33:07\t\t不知名小店\t现金消费\t支出\t12.00\t现金\t交易成功\t20261112008\t\t'
].join('\n')

var theme = require('../../utils/theme')

Page({
  onShow: function () {
    this.setData({ themeKey: theme.get().key, dark: darkmode.isDark() })
  },
  data: {
    dark: false,
    themeKey: 'green',
    text: '',
    preview: null,
    result: null,
    parsing: false,
    billBusy: false,
    billStep: ''
  },

  onUnload: function () {
    this._unloaded = true
    this._taskToken = (this._taskToken || 0) + 1
    ;(this._retryTimers || []).forEach(function (id) { clearTimeout(id) })
    this._retryTimers = []
  },

  beginTask: function () {
    this._taskToken = (this._taskToken || 0) + 1
    return this._taskToken
  },

  taskActive: function (token) {
    return !this._unloaded && token === this._taskToken
  },

  onInput: function (e) {
    this.setData({ text: e.detail.value, preview: null, result: null })
    this._items = null
  },

  fillDemo: function () {
    this.setData({ text: DEMO, preview: null, result: null })
    this._items = null
    wx.showToast({ title: '已填入示例，点解析试试', icon: 'none' })
  },

  /* ---------- 账单文件导入：微信 .xlsx / 支付宝 .csv ---------- */

  chooseBillFile: function () {
    var self = this
    if (this.data.billBusy) return
    if (!vip.guard('账单导入')) return
    if (!wx.chooseMessageFile) {
      wx.showToast({ title: '这个版本不支持选文件，请用截图识别', icon: 'none' })
      return
    }

    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['xlsx', 'csv', 'txt'],
      success: function (res) {
        if (self._unloaded) return
        var f = (res.tempFiles || [])[0]
        if (!f) return
        var token = self.beginTask()
        self.setData({ preview: null, result: null, billBusy: true, billStep: '正在上传…' })
        self.uploadAndParse(f.path, f.name, token)
      },
      fail: function (err) {
        if (self._unloaded) return
        var msg = String((err && err.errMsg) || '')
        if (!/cancel/i.test(msg)) wx.showToast({ title: '没选到文件', icon: 'none' })
      }
    })
  },

  uploadAndParse: function (filePath, fileName, token) {
    var self = this
    var task = token === undefined ? this.beginTask() : token
    if (!this.taskActive(task)) return
    var cloudPath = 'bills/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) +
      (/\.(xlsx|csv|txt)$/i.test(fileName || '') ? fileName.match(/\.(xlsx|csv|txt)$/i)[0] : '.csv')

    this.uploadWithRetry(filePath, cloudPath, function (err, up) {
      if (!self.taskActive(task)) {
        if (up) self.cleanupFile(up.fileID)
        return
      }
      if (err) {
        var msg = String((err && err.errMsg) || '')
        if (/ECONNRESET|reset|network|timeout/i.test(msg)) {
          msg = '网络被中断，已重试 3 次。可试试换网络、关掉代理/VPN；文件大的话先在电脑上按月份拆开'
        }
        self.setData({ billBusy: false, billStep: '' })
        wx.showModal({ title: '上传失败', content: msg, showCancel: false })
        return
      }

      self.setData({ billStep: '正在解析账单…' })
      wx.cloud.callFunction({
        name: 'parseBill',
        data: { fileID: up.fileID, name: fileName || '' },
        success: function (r) {
          self.cleanupFile(up.fileID)
          if (!self.taskActive(task)) return
          var res = (r && r.result) || {}
          if (!res.ok) {
            self.setData({ billBusy: false, billStep: '' })
            wx.showModal({
              title: '解析失败',
              content: res.error || '这个文件没读懂，确认是原始导出的账单文件（不要自己另存）',
              showCancel: false
            })
            return
          }
          self.showBillPreview(res)
        },
        fail: function (err2) {
          self.cleanupFile(up.fileID)
          if (!self.taskActive(task)) return
          var m2 = String((err2 && err2.errMsg) || '')
          if (/function not found|FunctionName/i.test(m2)) {
            m2 = '云函数 parseBill 还没部署：在开发者工具里右键 cloudfunctions/parseBill → 上传并部署'
          }
          self.setData({ billBusy: false, billStep: '' })
          wx.showModal({ title: '解析失败', content: m2, showCancel: false })
        }
      })
    })
  },

  uploadWithRetry: function (filePath, cloudPath, done, token) {
    var self = this
    var task = token === undefined ? this.beginTask() : token
    var tries = 0
    var MAX = 3
    this._retryTimers = this._retryTimers || []

    function later(fn) {
      var id = setTimeout(function () {
        var i = self._retryTimers.indexOf(id)
        if (i >= 0) self._retryTimers.splice(i, 1)
        fn()
      }, 800)
      self._retryTimers.push(id)
    }

    function attempt() {
      if (!self.taskActive(task)) return
      tries++
      wx.cloud.uploadFile({
        cloudPath: cloudPath,
        filePath: filePath,
        success: function (up) { done(null, up) },
        fail: function (err) {
          if (!self.taskActive(task)) { done(err); return }
          var msg = String((err && err.errMsg) || '')
          if (/ECONNRESET|reset|timeout|network|socket/i.test(msg) && tries < MAX) {
            self.setData({ billStep: '上传中断，重试中（' + tries + '/' + (MAX - 1) + '）…' })
            later(attempt)
            return
          }
          done(err)
        }
      })
    }
    attempt()
  },

  cleanupFile: function (fileID) {
    if (!fileID || !wx.cloud) return
    try { wx.cloud.deleteFile({ fileList: [fileID] }) } catch (e) {}
  },

  showBillPreview: function (res) {
    var r = ocrbill.fromBill(res.items || [], store.rules())
    if (!r.items.length) {
      this.setData({ billBusy: false, billStep: '' })
      wx.showModal({ title: '没读到流水', content: '这个文件里没有可用的交易记录', showCancel: false })
      return
    }

    /* 0 元行不进账，其余交给 store 算「新增 / 合并 / 重复」 */
    var skipZero = 0
    var keep = []
    for (var j = 0; j < r.items.length; j++) {
      if (!(r.items[j].amount > 0)) { skipZero++; continue }
      keep.push(r.items[j])
    }

    var plan = store.previewAdd(keep)
    this._items = keep

    var sample = keep.slice(0, 6).map(function (t) {
      return {
        merchant: t.merchant,
        amountText: format.money(t.amount),
        category: t.category,
        timeText: format.shortTime(t.time),
        type: t.type
      }
    })

    this.setData({
      billBusy: false,
      billStep: '',
      preview: {
        add: plan.added,
        merged: plan.merged,
        dup: plan.dup,
        skipped: (res.skipped || 0) + skipZero,
        source: res.source || r.source,
        sample: sample,
        kind: 'bill'
      }
    })
  },

  /* ---------- 剪贴板 / 选 CSV / 手动粘贴 ---------- */

  chooseFile: function () {
    var self = this
    var token = this.beginTask()
    if (!wx.chooseMessageFile) {
      wx.showToast({ title: '这个版本不支持选文件，请用粘贴', icon: 'none' })
      return
    }
    try {
      wx.chooseMessageFile({
        count: 1,
        type: 'file',
        extension: ['csv', 'txt'],
        success: function (res) {
          if (!self.taskActive(token)) return
          var f = res.tempFiles[0]
          if (!f) return
          wx.getFileSystemManager().readFile({
            filePath: f.path,
            encoding: 'utf-8',
            success: function (r) {
              if (!self.taskActive(token)) return
              self.setData({ text: r.data, preview: null, result: null })
              self._items = null
              wx.showToast({ title: '读到了，点解析', icon: 'none' })
            },
            fail: function () {
              if (!self.taskActive(token)) return
              wx.showToast({ title: '读不了这个文件，改用「账单文件导入」', icon: 'none' })
            }
          })
        },
        fail: function () {
          wx.showToast({ title: '没选文件，可以改用粘贴', icon: 'none' })
        }
      })
    } catch (err) {
      wx.showToast({ title: '当前系统不支持选文件，请用粘贴', icon: 'none' })
    }
  },

  /* 剪贴板里可能是账单表格，也可能是几条银行短信：先看像不像短信，认不出再走表格 */
  smartParse: function (text) {
    var rules = store.rules()
    if (parsesms.looksLikeSms(text)) {
      var sms = parsesms.parse(text, rules)
      if (sms.items && sms.items.length) return sms
      var tbl = parser.parse(text, rules)
      if (tbl.items && tbl.items.length) return tbl
      /* 两边都没东西：如果是短信，就报短信那句更好懂的错 */
      return (sms && sms.error) ? sms : tbl
    }
    return parser.parse(text, rules)
  },

  /* 解析给定文本并出预览，供「一键导入」和「手动解析」复用 */
  parseText: function (text) {
    if (!text || text.replace(/\s/g, '').length < 20) {
      wx.showToast({ title: '内容太短了', icon: 'none' })
      return
    }
    this.setData({ parsing: true })

    var r = this.smartParse(text)
    if (r.error) {
      this.setData({ parsing: false })
      wx.showToast({ title: r.error, icon: 'none' })
      return
    }

    var plan = store.previewAdd(r.items)

    var sample = r.items.slice(0, 5).map(function (t) {
      return {
        merchant: t.merchant,
        amountText: format.money(t.amount),
        category: t.category,
        timeText: format.shortTime(t.time),
        type: t.type
      }
    })

    this._items = r.items

    this.setData({
      parsing: false,
      preview: {
        add: plan.added,
        merged: plan.merged,
        dup: plan.dup,
        skipped: r.skipped,
        source: r.source || '未识别',
        sample: sample,
        kind: 'text'
      }
    })
  },

  doParse: function () {
    this.parseText(this.data.text)
  },

  /* 一键导入：先读剪贴板，自动识别并解析；读不到或识别不出再走备选入口 */
  oneTapImport: function () {
    var self = this
    var token = this.beginTask()
    if (!wx.getClipboardData) {
      this.fallbackSheet()
      return
    }
    wx.getClipboardData({
      success: function (res) {
        if (!self.taskActive(token)) return
        var text = String((res && res.data) || '').trim()
        if (text.replace(/\s/g, '').length < 20) {
          wx.showToast({ title: '剪贴板里还没有账单内容', icon: 'none' })
          self.fallbackSheet()
          return
        }
        self.setData({ text: text, preview: null, result: null })
        self.parseText(text)
      },
      fail: function (err) {
        if (!self.taskActive(token)) return
        var msg = String((err && err.errMsg) || '')
        if (/privacy|112|104|auth|scope/i.test(msg)) {
          wx.showModal({
            title: '需要先同意剪贴板权限',
            content: '请在弹出的隐私授权里点同意；若没弹窗，可在小程序右上角「···」→ 设置里打开剪贴板权限后再试',
            showCancel: false
          })
          return
        }
        self.fallbackSheet()
      }
    })
  },

  /* 剪贴板走不通时的备选：选文件 / 手动粘贴 */
  fallbackSheet: function () {
    var self = this
    wx.showActionSheet({
      itemList: ['选择账单文件（xlsx/csv）', '手动粘贴账单'],
      success: function (res) {
        if (self._unloaded) return
        if (res.tapIndex === 0) {
          self.chooseBillFile()
        } else {
          wx.showToast({ title: '在下方输入框粘贴账单', icon: 'none' })
        }
      }
    })
  },

  doImport: function () {
    var items = this._items
    if (!items || !items.length) {
      wx.showToast({ title: '还没有解析结果', icon: 'none' })
      return
    }
    var res = store.addMany(items)
    if (!res || res.saved !== true || res.partial) {
      this.setData({ result: null })
      wx.showModal({
        title: '没能保存',
        content: res && res.partial
          ? '本次未能完整保存，可能已有部分写入且回滚未完成。原文和预览已保留，请先核对实际账本、导出备份，再决定是否重试。'
          : '本次未保存，原文和预览已保留。可以重试，或先去「报表 → 数据工具」导出备份。',
        showCancel: false
      })
      return
    }
    var learned = store.learnFromItems(items)
    this._items = null
    this.setData({
      text: '',
      preview: null,
      result: { added: res.added, dup: res.dup, merged: res.merged || 0 }
    })
    if (learned === false) {
      wx.showModal({
        title: '流水已保存',
        content: '本次流水已保存，但分类规则未保存，不影响本次导入结果，无需重新导入。稍后可在流水页修改分类来学习规则。',
        showCancel: false
      })
    }
  },

  goList: function () {
    wx.switchTab({ url: '/pages/list/list' })
  },

  goShot: function () {
    wx.navigateTo({ url: '/pages/shot/shot' })
  }
})
