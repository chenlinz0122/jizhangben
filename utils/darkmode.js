/* 系统深色模式：只读状态，不提供手动开关（跟随系统最省事）
 *
 * 微信要求：小程序声明 "darkmode": true 且配 theme.json 才会跟随系统。
 * 这里做的是「跟随系统时，别让页面在深色下瞎眼」——主要救首页大数字、环形图中心文字。
 */

function info() {
  try {
    return (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()) || {}
  } catch (e) {
    return {}
  }
}

function isDark() {
  var i = info()
  return String(i.theme || '') === 'dark'
}

/* 系统主题切换时回调（没有这个 API 的旧版本就静默） */
function watch(cb) {
  if (!wx.onThemeChange || typeof cb !== 'function') return
  wx.onThemeChange(function (res) {
    cb(String((res && res.theme) || 'light') === 'dark')
  })
}

module.exports = {
  isDark: isDark,
  watch: watch
}
