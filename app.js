var store = require('./utils/store')

App({
  globalData: {
    filterUncat: false,
    filterCat: '',
    filterKind: '',
    filterYm: '',
    filterDay: '',
    cloudReady: false,
    /* 跨 tab 跳转没有页面栈，原生返回箭头不会出现，
       所以跳转方把「回哪儿」写在这儿，目标页自己画一个返回按钮。
       backFor = 该由哪个页面显示这个按钮；backTab = 点了退回哪个页面 */
    backFor: '',
    backTab: '',
    backLabel: ''
  },
  onLaunch: function (options) {
    /* 分享进来的邀请码可能落在任意入口页，先存起来，登录页/首页会核销 */
    try {
      var q = (options && options.query) || {}
      if (q.invite) {
        var vipUtil = require('./utils/vip')
        vipUtil.setPendingInvite(q.invite)
      }
    } catch (e) {}

    /* 云开发只用于「截图识别」的 OCR，流水仍然存在手机本地。
       没用云环境也不影响记账，只是截图识别不可用。 */
    if (wx.cloud) {
      try {
        wx.cloud.init({ traceUser: true })
        this.globalData.cloudReady = true
      } catch (e) {
        this.globalData.cloudReady = false
      }

      /* 第一次装到新环境时，让云端把 codes / members / feedbacks 建好并灌入卡密。
         本地打一个记号，之后不再重复调用（服务端自己也是幂等的） */
      try {
        if (!wx.getStorageSync('cloud_inited_v1')) {
          wx.cloud.callFunction({ name: 'vip', data: { action: 'initdb' } })
            .then(function (res) {
              if (res && res.result && res.result.ok) wx.setStorageSync('cloud_inited_v1', 1)
            })
            .catch(function () {})
        }
      } catch (e) {}
    }

    /* 账本只留最近一年：存量数据在这里截一次，以后每次导入/手记也会自动截 */
    try {
      var trimmed = store.trimExisting()
      if (trimmed > 0) {
        setTimeout(function () {
          wx.showToast({
            title: '已清理 ' + trimmed + ' 笔超过一年的旧流水',
            icon: 'none',
            duration: 2500
          })
        }, 800)
      }
    } catch (e) {}
  }
})
