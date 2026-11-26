var accounts = require('../../utils/accounts')
var currency = require('../../utils/currency')
var rateAlerts = require('../../utils/rate-alerts')
var theme = require('../../utils/theme')
var darkmode = require('../../utils/darkmode')

function timeText(value) {
  if (!value) return '--'
  var date = new Date(value)
  function pad(number) { return number < 10 ? '0' + number : '' + number }
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

Page({
  data: {
    themeKey: 'green',
    dark: false,
    accountId: '',
    accountOptions: [],
    accountIndex: 0,
    accountName: '',
    currency: '',
    currencyName: '',
    currentRate: null,
    currentRateText: '--',
    supported: false,
    targetRate: '',
    direction: 'above',
    enabled: false,
    pending: false,
    triggerCount: 0,
    lastTriggeredText: '--',
    statusText: '未设置提醒',
    statusClass: 'idle',
    error: ''
  },

  onLoad: function (options) {
    this.setData({ accountId: String(options && options.accountId || '').trim() })
    if (wx.setNavigationBarTitle) wx.setNavigationBarTitle({ title: '汇率变更提醒' })
    var self = this
    this._unwatchDark = darkmode.watch(function (dark) {
      if (self._unloaded) return
      self.setData({ dark: dark })
    })
  },

  onShow: function () {
    this.setData({ themeKey: theme.get().key, dark: darkmode.isDark() })
    theme.syncTabBar()
    this.refresh()
  },

  onHide: function () {
    this._visible = false
  },

  onUnload: function () {
    this._visible = false
    this._unloaded = true
    if (this._unwatchDark) this._unwatchDark()
  },

  refresh: function () {
    var id = this.data.accountId
    var options = accounts.list().filter(function (item) { return item.currency !== 'CNY' }).map(function (item) {
      return { id: item.id, name: item.name + ' · ' + item.currency }
    })
    if (!options.length) {
      this.setData({ accountOptions: [], supported: false, error: '暂无外币账户，请先在账户页新增外币账户。' })
      return
    }
    var index = 0
    options.forEach(function (item, i) { if (item.id === id) index = i })
    if (!id) id = options[index].id
    this.setData({ accountOptions: options, accountIndex: index, accountId: id })
    try {
      var account = accounts.get(id)
      if (!account) {
        this.setData({ supported: false, error: '账户不存在或已删除。' })
        return
      }
      var code = account.currency
      var supported = code !== 'CNY'
      var patch = {
        accountName: account.name,
        currency: code,
        currencyName: currency.CURRENCIES[code].name,
        currentRate: supported ? account.rateToCny : 1,
        currentRateText: supported ? String(account.rateToCny) : '1（人民币固定）',
        supported: supported,
        error: supported ? '' : 'CNY 是人民币固定汇率，不支持汇率变更提醒。'
      }
      if (supported) {
        var config = rateAlerts.get(id)
        if (config && config.currency === code) {
          patch.targetRate = String(config.targetRate)
          patch.direction = config.direction
          patch.enabled = config.enabled
          patch.pending = config.pending
          patch.triggerCount = config.triggerCount
          patch.lastTriggeredText = timeText(config.lastTriggeredAt)
          patch.statusText = config.pending ? '待提醒：汇率已跨越目标' : config.enabled ? '监控中' : '已关闭'
          patch.statusClass = config.pending ? 'pending' : config.enabled ? 'active' : 'idle'
        } else {
          patch.targetRate = ''
          patch.direction = 'above'
          patch.enabled = false
          patch.pending = false
          patch.triggerCount = 0
          patch.lastTriggeredText = '--'
          patch.statusText = '未设置提醒'
          patch.statusClass = 'idle'
        }
      }
      this.setData(patch)
    } catch (err) {
      this.setData({ supported: false, error: '汇率提醒读取失败，请稍后重试。' })
    }
  },

  pickAccount: function (event) {
    var index = Number(event.detail.value) || 0
    var item = this.data.accountOptions[index]
    if (!item) return
    this.setData({ accountId: item.id, accountIndex: index, error: '' })
    this.refresh()
  },

  inputTarget: function (event) {
    this.setData({ targetRate: String(event.detail.value || ''), error: '' })
  },

  selectDirection: function (event) {
    var direction = event.currentTarget.dataset.direction
    if (direction !== 'above' && direction !== 'below') return
    this.setData({ direction: direction, error: '' })
  },

  report: function (message) {
    this.setData({ error: message })
    if (wx.showToast) wx.showToast({ title: message, icon: 'none' })
  },

  saveConfig: function (enabled, successText) {
    if (!this.data.supported || !this.data.accountId) return false
    var targetRate = currency.normalizeRate(this.data.targetRate, this.data.currency)
    if (targetRate === null) {
      this.report('目标汇率必须是大于 0 的有效数字')
      return false
    }
    var self = this
    var config = {
      targetRate: targetRate,
      direction: this.data.direction,
      enabled: enabled
    }
    var saved = rateAlerts.save(this.data.accountId, {
      id: this.data.accountId,
      currency: this.data.currency,
      rateToCny: this.data.currentRate
    }, config)
    if (!saved) {
      this.report(rateAlerts.error() || '提醒设置保存失败')
      return false
    }
    this.setData({ error: '' })
    this.refresh()
    if (successText && wx.showToast) wx.showToast({ title: successText, icon: 'none' })
    return true
  },

  saveSettings: function () {
    this.saveConfig(this.data.enabled, '提醒设置已保存')
  },

  toggleEnabled: function (event) {
    var enabled = !!(event.detail && event.detail.value)
    this.saveConfig(enabled, enabled ? '汇率提醒已开启' : '汇率提醒已关闭')
  },

  acknowledge: function () {
    if (!rateAlerts.ack(this.data.accountId)) {
      this.report(rateAlerts.error() || '确认失败，请重试')
      return
    }
    this.setData({ error: '' })
    this.refresh()
    if (wx.showToast) wx.showToast({ title: '已确认提醒', icon: 'none' })
  },

  /* 仅验证并展示应用内测试弹窗，不伪造跨越，也不改变 pending/触发次数。 */
  testAlert: function () {
    if (!this.data.supported || !this.data.accountId) return
    var targetRate = currency.normalizeRate(this.data.targetRate, this.data.currency)
    if (targetRate === null) {
      this.report('请先填写大于 0 的目标汇率')
      return
    }
    var direction = this.data.direction === 'above' ? '上涨到' : '下跌到'
    if (wx.showModal) {
      wx.showModal({
        title: '应用内提醒测试',
        content: '测试：' + this.data.accountName + ' 的 ' + this.data.currency +
          ' 汇率' + direction + ' ' + targetRate + ' CNY 时将在此应用内提醒。此测试不会改变提醒状态。',
        showCancel: false,
        confirmText: '知道了',
        confirmColor: '#17806b'
      })
    } else {
      this.report('当前微信版本无法显示测试弹窗')
    }
  },

  goBack: function () {
    wx.navigateBack({ fail: function () { wx.switchTab({ url: '/pages/home/home' }) } })
  }
})
