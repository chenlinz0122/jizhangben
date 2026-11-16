/* 分类体系 + 归类引擎
 *
 * 口径只有一套，对齐「微信记账本」官方分类（支出 19 / 入账 9 / 不计收支 3）：
 *   支出：餐饮 交通 服饰 购物 服务 教育 娱乐 运动 生活缴费 旅行 宠物 医疗
 *         保险 公益 发红包 转账 亲属卡 其他人情 其他支出 退还
 *   入账：生意 工资 奖金 其他人情 收红包 收转账 商家转账 退款 其他收入
 *   不计收支：理财 / 借还款 / 账户转移
 *
 * 结构上保证方向不会串：支出只从支出表里出，入账只从入账表里出，
 * 所以不需要「事后把落错方向的类目改回来」这种补丁。
 * 关键词数据在 category-rules.js，加词只改那边。
 */

var R = require('./category-rules')

var UNCAT = '未分类'

var CATS = {
  expense: [
    '餐饮', '交通', '服饰', '购物', '服务', '教育', '娱乐', '运动', '生活缴费',
    '旅行', '宠物', '医疗', '保险', '公益', '发红包', '转账', '亲属卡',
    '其他人情', '其他支出', '退还', '转入银行卡', UNCAT
  ],
  income: [
    '生意', '工资', '奖金', '其他人情', '收红包', '收转账', '商家转账',
    '退款', '其他收入', '银行卡转出', UNCAT
  ],
  transfer: ['理财', '借还款', '账户转移']
}

var COLOR = {
  /* 支出 · 柔和但有色彩 */
  '餐饮': '#d88a66',
  '交通': '#6f93b5',
  '服饰': '#ce8aa6',
  '购物': '#98a56e',
  '服务': '#b87f79',
  '教育': '#9388c0',
  '娱乐': '#c2829c',
  '运动': '#6fae87',
  '生活缴费': '#7487ad',
  '旅行': '#66a8a6',
  '宠物': '#b88d67',
  '医疗': '#5f9c85',
  '保险': '#7f99a1',
  '公益': '#9aa976',
  '发红包': '#cf9f5f',
  '转账': '#7f949c',
  '亲属卡': '#c08aa0',
  '其他人情': '#c9a467',
  '其他支出': '#8f979c',
  '退还': '#82a393',
  '转入银行卡': '#7693a3',
  /* 入账 */
  '生意': '#5f9e7e',
  '工资': '#559674',
  '奖金': '#7ba86a',
  '收红包': '#a2ab6e',
  '收转账': '#55a28c',
  '商家转账': '#53a4a6',
  '退款': '#63a695',
  '其他收入': '#869696',
  '银行卡转出': '#56969c',
  /* 不计收支 */
  '理财': '#56939a',
  '借还款': '#8679ad',
  '账户转移': '#9286ad',
  UNCAT: '#b6bcc2'
}

/* 分类图标：只做展示，归类逻辑不依赖它 */
var ICON = {
  '餐饮': '🍜', '交通': '🚇', '服饰': '👕', '购物': '🛍️', '服务': '💇',
  '教育': '📚', '娱乐': '🎮', '运动': '🏃', '生活缴费': '💡', '旅行': '✈️',
  '宠物': '🐾', '医疗': '💊', '保险': '🛡️', '公益': '🤝', '发红包': '🧧',
  '转账': '💸', '亲属卡': '💳', '其他人情': '🎁', '其他支出': '🧾', '退还': '🔙',
  '转入银行卡': '🏦',
  '生意': '🧺', '工资': '💰', '奖金': '🏆', '收红包': '🧧', '收转账': '💸',
  '商家转账': '🏪', '退款': '↩️', '其他收入': '💰', '银行卡转出': '🏧',
  '理财': '📈', '借还款': '🤝', '账户转移': '🔄',
  UNCAT: '❓'
}

function normalize(s) {
  if (!s) return ''
  return String(s)
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase()
}

function indexOfRules(list) {
  return list.map(function (it) { return { kw: it[0], cat: it[1] } })
}

var _expIndex = null
var _incIndex = null
function expIndex() { return _expIndex || (_expIndex = indexOfRules(R.EXP)) }
function incIndex() { return _incIndex || (_incIndex = indexOfRules(R.INC)) }

/* 取最长命中：关键词越长越具体，「中国电信」不能输给「电信」 */
function pickLongest(text, list) {
  var best = null
  for (var i = 0; i < list.length; i++) {
    var kw = list[i].kw
    if (!kw) continue
    if (text.indexOf(String(kw).toLowerCase()) >= 0) {
      if (!best || kw.length > best.kw.length) best = list[i]
    }
  }
  return best
}

function has(list, cat) {
  return !!cat && list.indexOf(cat) >= 0
}

/**
 * 归类
 * @param {string} merchant 交易对方
 * @param {string} desc 商品说明
 * @param {string} platformCat 平台给的分类（支付宝有）
 * @param {object} userRules { 关键词: 分类 }
 * @param {string} kind expense / income / refund / transfer
 */
function classify(merchant, desc, platformCat, userRules, kind) {
  var text = normalize(merchant) + '|' + normalize(desc)
  var dir = (kind === 'income' || kind === 'refund') ? 'income' : 'expense'
  var pool = CATS[dir]

  /* 退款自己就是一个类目，不再往下猜 */
  if (kind === 'refund') return { cat: '退款', by: 'kind' }

  if (dir === 'expense') {
    /* 这两类抢在平台分类之前：学费在支付宝被记成「公共服务」（映射下来是生活缴费），
     * 税费/社保被记成「充值缴费」。抢在映射前面才不会被带偏。 */
    var eduPay = /学费|学杂费|教育收费|缴款单号|执收单位/.test(text) ||
      (/财政厅|财政局|非税/.test(text) && /大学|学院|学校|教育|中学|小学|幼儿园|职业/.test(text))
    if (eduPay) return { cat: '教育', by: 'builtin' }
    if (/税务局|税务|社保费|公积金|罚款/.test(text)) return { cat: '其他支出', by: 'builtin' }
  }

  if (platformCat && R.PLATFORM_MAP[platformCat] && has(pool, R.PLATFORM_MAP[platformCat])) {
    return { cat: R.PLATFORM_MAP[platformCat], by: 'platform' }
  }

  if (userRules) {
    var ukws = Object.keys(userRules)
    /* 规则 key 由 learn() 原样存进来（可能带空格/括号/大写），而 text 是 normalize 过的，
     * 匹配前必须同样归一化，否则「Apple Store」这类商户名永远命中不了自己。 */
    var ulist = ukws.map(function (k) { return { kw: normalize(k), cat: userRules[k] } })
    var uhit = pickLongest(text, ulist)
    if (uhit && has(pool, uhit.cat)) return { cat: uhit.cat, by: 'user' }
  }

  var hit = pickLongest(text, dir === 'income' ? incIndex() : expIndex())
  if (hit) return { cat: hit.cat, by: 'builtin' }

  return { cat: UNCAT, by: 'none' }
}

function catsOf(type) {
  return CATS[type] || CATS.expense
}

/**
 * 不计收支的资金流水再分三类（对齐官方：理财 / 借还款 / 账户转移）
 */
function transferCat(merchant, desc) {
  var t = normalize(merchant) + '|' + normalize(desc)
  if (/零钱通|理财通|余额宝|基金|活期|定期|国债|黄金|赎回|申购|理财/.test(t)) return '理财'
  if (/借出|借入|借款|还款给|收回借款/.test(t)) return '借还款'
  return '账户转移'
}

/**
 * 老数据迁移：把旧类目一次性映射成官方类目。
 * 只在读出来的时候算，不改本地库里的原始数据，随时可以退回。
 */
function migrate(t) {
  var cat = String(t.category || '')
  if (t.type === 'transfer' || t.ty === 'transfer') {
    if (cat === '理财') return '理财'
    if (cat === '借还款') return '借还款'
    return '账户转移'          /* 旧的「转账」「信用卡」都属账户间转移 */
  }
  if (t.type === 'income' || t.type === 'refund') {
    if (has(CATS.income, cat)) return cat
    return R.LEGACY_INCOME[cat] || '其他收入'
  }
  if (has(CATS.expense, cat)) return cat
  return R.LEGACY_EXPENSE[cat] || '其他支出'
}

module.exports = {
  CATS: CATS,
  UNCAT: UNCAT,
  COLOR: COLOR,
  ICON: ICON,
  PLATFORM_MAP: R.PLATFORM_MAP,
  classify: classify,
  catsOf: catsOf,
  transferCat: transferCat,
  migrate: migrate,
  normalize: normalize,
  colorOf: function (name) {
    return COLOR[name] || '#9aa0a6'
  },
  iconOf: function (name) {
    return ICON[name] || ICON[UNCAT]
  },
  tintOf: function (name) {
    var hex = COLOR[name] || '#9aa0a6'
    var r = parseInt(hex.slice(1, 3), 16)
    var g = parseInt(hex.slice(3, 5), 16)
    var b = parseInt(hex.slice(5, 7), 16)
    return 'rgba(' + r + ',' + g + ',' + b + ',0.14)'
  }
}
