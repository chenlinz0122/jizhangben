/* 本地账户：昵称 / 头像 / 登录时间
 *
 * 口径：
 *   1. 这不是鉴权，只是「这台手机上有没有人登录过」的展示态；
 *      账本数据仍然只在本机 Storage，登录与否都不影响记账；
 *   2. openid 不在这里存，统一放 utils/vip.js 的缓存（云函数 status 会带回来），
 *      会员核销只认 openid，换手机也不会丢会员；
 *   3. 头像用 chooseAvatar 拿的是临时路径，必须在登录时落盘，否则重启就白框。
 */

var KEY = 'account_v1'
var SKIP_KEY = 'account_skip_v1'

function read() {
  try {
    var v = wx.getStorageSync(KEY)
    return v && typeof v === 'object' ? v : {}
  } catch (e) {
    return {}
  }
}

/* 昵称是登录的唯一硬条件：有昵称就算登录过 */
function get() {
  var a = read()
  return {
    nick: String(a.nick || ''),
    avatar: String(a.avatar || ''),
    openid: String(a.openid || ''),
    at: Number(a.at) || 0
  }
}

function isLogin() {
  return !!get().nick
}

function save(patch) {
  var cur = read()
  var next = {}
  for (var k in cur) {
    if (Object.prototype.hasOwnProperty.call(cur, k)) next[k] = cur[k]
  }
  for (var j in patch) {
    if (Object.prototype.hasOwnProperty.call(patch, j)) next[j] = patch[j]
  }
  try {
    wx.setStorageSync(KEY, next)
  } catch (e) {}
  return next
}

function login(profile) {
  profile = profile || {}
  return save({
    nick: String(profile.nick || '').trim(),
    avatar: String(profile.avatar || ''),
    openid: String(profile.openid || ''),
    at: Date.now()
  })
}

function logout() {
  try {
    wx.removeStorageSync(KEY)
  } catch (e) {}
}

/* 头像落盘：临时路径重启就失效，复制到 USER_DATA_PATH 才能长期显示 */
function persistAvatar(tempPath, cb) {
  var done = typeof cb === 'function' ? cb : function () {}
  var p = String(tempPath || '')
  if (!p) {
    done('')
    return
  }
  /* 只在「确实已经在本地持久目录」时才跳过复制。
     别用 indexOf 里随便匹配 '/tmp' —— 临时路径本身常带 tmp，会把该复制的当成已落盘。 */
  var root = String((wx.env && wx.env.USER_DATA_PATH) || '')
  var already = p.indexOf('wxfile://usr/') === 0 || (!!root && p.indexOf(root) === 0)
  if (already) {
    done(p)
    return
  }
  try {
    wx.getFileSystemManager().saveFile({
      tempFilePath: p,
      success: function (res) {
        done(res && res.savedFilePath ? res.savedFilePath : p)
      },
      fail: function () {
        done(p)   /* 存不下就先用临时路径，本次会话内至少能显示 */
      }
    })
  } catch (e) {
    done(p)
  }
}

/* 「先逛逛」只记一次，别每次进来都弹登录 */
function markSkip() {
  try {
    wx.setStorageSync(SKIP_KEY, Date.now())
  } catch (e) {}
}

function skipped() {
  try {
    return !!wx.getStorageSync(SKIP_KEY)
  } catch (e) {
    return false
  }
}

function clearSkip() {
  try {
    wx.removeStorageSync(SKIP_KEY)
  } catch (e) {}
}

module.exports = {
  KEY: KEY,
  get: get,
  isLogin: isLogin,
  save: save,
  login: login,
  logout: logout,
  persistAvatar: persistAvatar,
  markSkip: markSkip,
  skipped: skipped,
  clearSkip: clearSkip
}
