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

/* 公司法定全称去掉这些壳，剩下的才是「字号」。
 * 「上海格物致品网络科技有限公司」→「上海格物致品网络科技」，
 * 这样关键词能命中「网络科技」这类业务词，也不会被「有限公司」这几个字干扰。 */
function stripCo(s) {
  return String(s || '')
    .replace(/有限责任公司|股份有限公司|有限公司|分公司|公司|集团|控股|实业|门店|旗舰店|专营店|专卖店|官方|自营|商城|小程序/g, '')
}

function indexOfRules(list) {
  /* 关键词也要归一化：商户名 normalize 之后空格、括号都没了
   * （「Apple Store」→「applestore」），关键词不去空格就永远命中不了 */
  return list.map(function (it) { return { kw: normalize(it[0]), cat: it[1] } })
}

var _expIndex = null
var _incIndex = null
var _coIndex = null
function expIndex() { return _expIndex || (_expIndex = indexOfRules(R.EXP)) }
function incIndex() { return _incIndex || (_incIndex = indexOfRules(R.INC)) }
function coIndex() { return _coIndex || (_coIndex = indexOfRules(R.COMPANY_KW || [])) }

/* 是不是「什么都能买」的大平台商户（淘宝/京东/抖音……）：
 * 这类名字不能用来学本地规则，否则一次平台分类就把整个平台锁死。 */
function isLooseMerchant(s) {
  var n = normalize(s)
  if (!n) return false
  var list = R.LOOSE_MERCHANTS || []
  for (var i = 0; i < list.length; i++) {
    if (n.indexOf(normalize(list[i])) >= 0) return true
  }
  return false
}

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
  var m = normalize(merchant)
  var d = normalize(desc)
  var dir = (kind === 'income' || kind === 'refund') ? 'income' : 'expense'
  var pool = CATS[dir]

  /* 退款自己就是一个类目，不再往下猜 */
  if (kind === 'refund') return { cat: '退款', by: 'kind' }

  if (dir === 'expense') {
    /* 这两类抢在平台分类之前：学费在支付宝被记成「公共服务」（映射下来是生活缴费），
     * 税费/社保被记成「充值缴费」。抢在映射前面才不会被带偏。 */
    var eduPay = /学费|学杂费|教育收费|缴款单号|执收单位/.test(m + '|' + d) ||
      (/财政厅|财政局|非税/.test(m + '|' + d) && /大学|学院|学校|教育|中学|小学|幼儿园|职业/.test(m + '|' + d))
    if (eduPay) return { cat: '教育', by: 'builtin' }
    if (/税务局|税务|社保费|公积金|罚款/.test(m + '|' + d)) return { cat: '其他支出', by: 'builtin' }
  }

  /* 1) 用户手动改过的「同一个商户」：精确同名优先，平台分类也别盖它。
   *    这是「我改过一次，下次又错了」的主要来源——以前平台分类排在用户规则前面。 */
  if (userRules) {
    var ukws0 = Object.keys(userRules)
    for (var e = 0; e < ukws0.length; e++) {
      if (normalize(ukws0[e]) === m) {
        var exactCat = userRules[ukws0[e]]
        if (has(pool, exactCat)) return { cat: exactCat, by: 'user' }
      }
    }
  }

  /* 2) 平台给的分类（支付宝「交易分类」、微信账单的分类列）。
   *    但「文化休闲 / 商业服务 / 其他 / 信用借还」这几个是支付宝倒垃圾的桶：
   *    在抖音商城买东西被记成「文化休闲」（映射过来是娱乐），企业服务被记成「商业服务」。
   *    这几个桶不采信，先让关键词判，关键词也没有再拿它兜底。 */
  var weakPlatform = isWeakPlatform(platformCat)
  if (platformCat && !weakPlatform && R.PLATFORM_MAP[platformCat] && has(pool, R.PLATFORM_MAP[platformCat])) {
    return { cat: R.PLATFORM_MAP[platformCat], by: 'platform' }
  }

  /* 3) 用户规则里的其他写法（商户名略有差异时靠子串命中） */
  if (userRules) {
    var ukws = Object.keys(userRules)
    /* 规则 key 由 learn() 原样存进来（可能带空格/括号/大写），而 text 是 normalize 过的，
     * 匹配前必须同样归一化，否则「Apple Store」这类商户名永远命中不了自己。 */
    var ulist = ukws.map(function (k) { return { kw: normalize(k), cat: userRules[k] } })
    var uhit = pickLongest(m + '|' + d, ulist)
    if (uhit && has(pool, uhit.cat)) return { cat: uhit.cat, by: 'user' }
  }

  /* 4) 商户名命中内置词库。商户名优先于商品说明：
   *    「淘宝」下单、说明里写着「美团外卖优惠券」，按商户算才对。 */
  var mText = m + '|' + stripCo(m)
  var hitM = pickLongest(mText, dir === 'income' ? incIndex() : expIndex())
  if (hitM) return { cat: hitM.cat, by: 'builtin' }

  /* 5) 商户名认不出来再看商品说明 / 备注 */
  var hitD = pickLongest(d, dir === 'income' ? incIndex() : expIndex())
  if (hitD) return { cat: hitD.cat, by: 'builtin' }

  /* 6) 上面都没认出来，才用那个不靠谱的平台分类兜底 */
  if (weakPlatform && R.PLATFORM_MAP[platformCat] && has(pool, R.PLATFORM_MAP[platformCat])) {
    return { cat: R.PLATFORM_MAP[platformCat], by: 'platform' }
  }

  /* 7) 只给了公司法定全称时（支付宝详情页的「收款方全称」），按里面的业务词猜 */
  if (dir === 'expense') {
    var coHit = pickLongest(mText, coIndex())
    if (coHit && has(pool, coHit.cat)) return { cat: coHit.cat, by: 'biz' }
  }

  return { cat: UNCAT, by: 'none' }
}

/* 支付宝这几个分类是「倒垃圾的桶」，见 classify 里的说明 */
var WEAK_PLATFORM = ['文化休闲', '商业服务', '其他', '信用借还']
function isWeakPlatform(cat) {
  if (!cat) return false
  for (var i = 0; i < WEAK_PLATFORM.length; i++) {
    if (String(cat).indexOf(WEAK_PLATFORM[i]) >= 0) return true
  }
  return false
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
  isLooseMerchant: isLooseMerchant,
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
