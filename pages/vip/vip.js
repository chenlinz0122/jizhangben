var vip = require('../../utils/vip')

Page({
  data: {
    code: '',
    busy: false,
    isVip: false,
    statusText: '',
    expireText: '',
    daysLeft: 0,
    lastCode: '',
    msg: '',
    contact: vip.CONTACT,

    /* 档位只用于说明和「拿码时说要哪档」，页面里不放任何支付 */
    tierIdx: 2,
    tiers: [
      { name: '月卡', days: 30, price: '9.9', tag: '', note: '先试一个月，每天约 0.33 元。' },
      { name: '季卡', days: 90, price: '25.9', tag: '省 ¥3.8', note: '按月卡算要 29.7，季卡省 3.8。' },
      { name: '年卡', days: 365, price: '68', tag: '最划算', note: '每天约 0.19 元，一年一次不用惦记。' }
    ],

    /* 对比表：左边功能，右边两列。— 表示这版没有 */
    compare: [
      { name: '手动记账 / 改分类', vip: '不限', free: '不限' },
      { name: '流水 · 总览 · 搜索', vip: '全部', free: '全部' },
      { name: '报表：本月总额 + 支出构成', vip: '✓', free: '✓' },
      { name: '报表：每日趋势 · 6 个月对比', vip: '✓', free: '—' },
      { name: '报表：年度汇总 · 商户排行 · 洞察', vip: '✓', free: '—' },
      { name: '每日花销日历', vip: '✓', free: '—' },
      { name: '截图识别（一次最多 9 张）', vip: '✓', free: '—' },
      { name: '账单导入（微信 xlsx / 支付宝 csv）', vip: '✓', free: '—' },
      { name: 'AI 补分类', vip: '✓', free: '—' },
      { name: '月度预算 + 分类预算', vip: '✓', free: '—' },
      { name: '配色主题', vip: '✓', free: '✓' }
    ],

    benefits: [
      { name: '截图识别', desc: '一次最多 9 张，自动认商户、金额和收支方向' },
      { name: '账单导入', desc: '微信 .xlsx / 支付宝 .csv 整月导入，自动去重' },
      { name: 'AI 补分类', desc: '词库认不出的按商户批量补，补完沉淀成你自己的规则' },
      { name: '报表进阶', desc: '本月总额和支出构成免费；每日趋势、6 个月对比、年度汇总、商户排行、日均洞察要会员' },
      { name: '预算', desc: '月度预算 + 分类预算，超支会变红提醒' }
    ]
  },

  onLoad: function () {
    this.syncLocal()
    this.refresh()
  },

  onShow: function () {
    this.syncLocal()
  },

  syncLocal: function () {
    this.setData({
      isVip: vip.isVip(),
      statusText: vip.statusText(),
      expireText: vip.expireAt() ? vip.dateText(vip.expireAt()) : '',
      daysLeft: vip.daysLeft()
    })
  },

  refresh: function () {
    var self = this
    vip.refresh(function () {
      self.syncLocal()
    })
  },

  onInput: function (e) {
    this.setData({ code: e.detail.value, msg: '' })
  },

  pickTier: function (e) {
    this.setData({ tierIdx: Number(e.currentTarget.dataset.idx) || 0 })
  },

  submit: function () {
    var self = this
    if (this.data.busy) return
    var code = String(this.data.code || '').trim()
    if (!code) {
      this.setData({ msg: '先把卡密填进来' })
      return
    }
    this.setData({ busy: true, msg: '' })
    vip.redeem(code, function (res) {
      if (res && res.ok) {
        self.setData({ busy: false, code: '', msg: '' })
        self.syncLocal()
        wx.showToast({ title: res.already ? '这张已经兑过了' : '已开通', icon: 'success' })
        return
      }
      self.setData({ busy: false, msg: (res && res.msg) || '兑换失败，稍后再试' })
    })
  },

  copyContact: function () {
    wx.setClipboardData({
      data: this.data.contact,
      success: function () {
        wx.showToast({ title: '联系方式已复制', icon: 'none' })
      }
    })
  },

  openFeedback: function () {
    wx.navigateTo({ url: '/pages/feedback/feedback' })
  },

  /* 给「去开通」之外的地方复用：从别的页面跳过来时带返回 */
  goBack: function () {
    wx.navigateBack({ delta: 1, fail: function () { wx.switchTab({ url: '/pages/index/index' }) } })
  }
})
