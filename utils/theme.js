/* 配色主题：只改「主色 + 首页头部」，不动正文颜色，避免把对比度改坏
 * 三套：青绿（默认）/ 墨蓝 / 暖橘
 */

var darkmode = require('./darkmode')
var KEY = 'theme_v1'

var THEMES = [
  { key: 'green', name: '青绿', color: '#17806b', grad1: '#e7f5ef', grad2: '#f7fbf9', ink: '#0f5f50' },
  { key: 'ink', name: '墨蓝', color: '#2f5d8a', grad1: '#e8eff7', grad2: '#f8fafc', ink: '#1f4468' },
  { key: 'amber', name: '暖橘', color: '#b96a2b', grad1: '#fbeee2', grad2: '#fdfaf6', ink: '#8f4d18' }
]

function get() {
  var k = ''
  try { k = String(wx.getStorageSync(KEY) || '') } catch (e) {}
  for (var i = 0; i < THEMES.length; i++) {
    if (THEMES[i].key === k) return THEMES[i]
  }
  return THEMES[0]
}

function list() {
  return THEMES
}

/* 切主题：本地记住 + 顺手把 tabBar 选中色改掉（tabBar 只能运行时改） */
function set(key) {
  var t = get()
  for (var i = 0; i < THEMES.length; i++) {
    if (THEMES[i].key === key) t = THEMES[i]
  }
  try { wx.setStorageSync(KEY, t.key) } catch (e) {}
  applyTabBar(t)
  return t
}

function applyTabBar(t) {
  var dark = darkmode.isDark()
  if (wx.setTabBarItem) {
    var suffix = dark ? '-dark' : (t.key === 'green' ? '-active' : '-' + t.key)
    ;['home', 'list', 'report', 'mine'].forEach(function (name, index) {
      wx.setTabBarItem({ index: index, selectedIconPath: 'assets/tabbar/' + name + suffix + '.png', fail: function () {} })
    })
  }
  if (!wx.setTabBarStyle) return
  try {
    wx.setTabBarStyle({
      selectedColor: dark ? '#93cdb8' : t.color,
      color: dark ? '#a0b0a7' : '#7a8882',
      backgroundColor: dark ? '#1b2421' : '#ffffff',
      borderStyle: dark ? 'black' : 'white',
      fail: function () {}
    })
  } catch (e) {}
}

/* 页面 onShow 调用：把 tabBar 拉回当前主题 */
function syncTabBar() {
  applyTabBar(get())
}

module.exports = {
  KEY: KEY,
  list: list,
  get: get,
  set: set,
  syncTabBar: syncTabBar
}
