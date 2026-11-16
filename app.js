var store = require('./utils/store')

App({
  globalData: {
    filterUncat: false,
    filterCat: '',
    filterKind: '',
    filterYm: '',
    filterDay: '',
    cloudReady: false
  },
  onLaunch: function () {
    /* 云开发只用于「截图识别」的 OCR，流水仍然存在手机本地。
       没用云环境也不影响记账，只是截图识别不可用。 */
    if (wx.cloud) {
      try {
        wx.cloud.init({ traceUser: true })
        this.globalData.cloudReady = true
      } catch (e) {
        this.globalData.cloudReady = false
      }
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
