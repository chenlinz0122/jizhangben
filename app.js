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
      /* 共同账本邀请：落在别的页面时，首页会弹一句「要不要加入」；
         直接落在共同账本页就不用再存（那页自己填邀请码） */
      if (q.code) {
        var path = String((options && options.path) || '')
        if (path.indexOf('pages/share/share') < 0) {
          require('./utils/shared').setPendingShare(q.code)
        }
      }
    } catch (e) {}

    /* 本地记账不依赖云环境，共同账本会同步流水。 */
    if (wx.cloud) {
      /* 云开发环境要写死：不写 env 时用「账号下的默认环境」，
         一个账号建过好几个环境（或换了环境）就会指到空的那一个，
         表现就是云函数明明部署了却一直报找不到。 */
      try {
        wx.cloud.init({ env: 'cloud1-d1gspor0c4bf8ef20', traceUser: true })
        this.globalData.cloudReady = true
      } catch (e) {
        this.globalData.cloudReady = false
      }

      /* 第一次装到新环境时，让云端把 codes / members / feedbacks / invites 建好并灌入卡密。
         本地打一个记号，之后不再重复调用（服务端自己也是幂等的）。
         v1 → v2：永久卡那批码是后来加的，换一次记号让老用户也补灌一遍（逐条查重，不会重复） */
      try {
        if (!wx.getStorageSync('cloud_inited_v2')) {
          wx.cloud.callFunction({ name: 'vip', data: { action: 'initdb' } })
            .then(function (res) {
              if (res && res.result && res.result.ok) wx.setStorageSync('cloud_inited_v2', 1)
            })
            .catch(function () {})
        }
      } catch (e) {}
    }
  }
})
