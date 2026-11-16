/* 本地存储：流水 / 规则 / 设置 */
var category = require('./category')
var format = require('./format')

var KEY_TX = 'txs_v1'
var KEY_RULE = 'rules_v1'
var KEY_BUDGET = 'budget_v1'
var KEY_CATBUD = 'budcats_v1'

var _cache = null
var _rules = null

function all() {
  if (_cache) return _cache
  var v = wx.getStorageSync(KEY_TX)
  _cache = Array.isArray(v) ? v : []
  /* 口径升级：旧分类名在读出时统一映射成官方分类；不动本地原始数据，随时可退 */
  for (var i = 0; i < _cache.length; i++) {
    var t = _cache[i]
    var c = category.migrate(t)
    if (c !== t.category) t.category = c
  }
  return _cache
}

function persist() {
  try {
    wx.setStorageSync(KEY_TX, _cache || [])
    return true
  } catch (e) {
    /* 写失败（多半是超过单 key 1MB）时，内存里已经是最新的 _cache，磁盘却还是旧的。
     * 不回滚的话界面显示新数据、用户以为存上了，重启就丢。这里立刻从磁盘读回真实值覆盖内存，
     * 保证「看到的 = 存下的」，让调用方能据返回值提示用户本次没保存成功。 */
    try {
      var disk = wx.getStorageSync(KEY_TX)
      _cache = Array.isArray(disk) ? disk : []
    } catch (e2) {
      _cache = []
    }
    wx.showToast({ title: '存储失败，本次修改未保存', icon: 'none' })
    return false
  }
}

function sortDesc(list) {
  list.sort(function (a, b) { return b.time - a.time })
  return list
}

function round2(n) {
  var v = Math.round(Number(n || 0) * 100) / 100
  return v
}

/* 整点零分 = 只知道日期、不知道几点（截图识别兜底出来的时间） */
function zeroClock(ts) {
  var d = new Date(ts)
  return d.getHours() === 0 && d.getMinutes() === 0
}

/* 商户相似：完全一样，或一个是另一个的一部分（至少 2 个字）
 * 截图会把「美团外卖」认成「美团」这种，得容错；「抖音电商商家」和「抖音生活服务商家」不算相似 */
function merchantLike(a, b) {
  a = String(a || '')
  b = String(b || '')
  if (!a || !b) return false
  if (a === b) return true
  var short = a.length <= b.length ? a : b
  var long = a.length <= b.length ? b : a
  return short.length >= 2 && long.indexOf(short) >= 0
}

/* 弱合并：只在「单号型(b)」和「截图型(h)」之间猜同一笔
 * 同类型之间一律交给 id 判重——同一份账单里同日同额同商户大多是两笔真交易，
 * 靠时间+金额+商户去合并会吃掉真实流水 */
function sameLoose(a, b) {
  if (!a || !b) return false
  if (a.type !== b.type) return false
  if (a.day !== b.day) return false
  if (round2(a.amount) !== round2(b.amount)) return false
  if (!merchantLike(a.merchant, b.merchant)) return false

  var pa = String(a.id || '').charAt(0)
  var pb = String(b.id || '').charAt(0)
  if (pa === pb) return false

  if (zeroClock(a.time) || zeroClock(b.time)) return true
  return Math.abs(a.time - b.time) <= 2 * 60 * 1000
}

/* 把新记录的信息补进已有那条，返回是否有改动 */
function mergeInto(target, src) {
  var changed = false

  /* 单号型是更权威的那份，升级 id，以后再导就自动判重复 */
  if (String(src.id || '').charAt(0) === 'b' && String(target.id || '').charAt(0) === 'h') {
    target.id = src.id
    changed = true
  }

  if (zeroClock(target.time) && !zeroClock(src.time)) {
    target.time = src.time
    target.day = src.day
    target.ym = src.ym
    changed = true
  }

  var fields = ['desc', 'byPlatform', 'status', 'account', 'note']
  for (var i = 0; i < fields.length; i++) {
    var k = fields[i]
    if (!target[k] && src[k]) {
      target[k] = src[k]
      changed = true
    }
  }
  return changed
}

/* 账本只保留最近一年：时间跨度超过 12 个月，就从最老的那头删起，直到刚好一年。
 * 基准取「库里最新一条的时间」而不是「今天」——这样导进来的老账单不会一落地就被清空。
 * 不依赖入参的顺序，就地删（会改动传进来的数组）。返回被删掉的笔数。 */
function trimYear(list) {
  if (!list || list.length < 2) return 0
  var newest = 0
  for (var i = 0; i < list.length; i++) {
    if (list[i].time > newest) newest = list[i].time
  }
  if (!newest) return 0
  var d = new Date(newest)
  /* 直接 new Date(y, m-12, d) 在目标月天数不足时会溢出：2024-02-29 会变成 2023-03-01，
   * 临界日被多删。先把日期设到 1 号再退 12 个月，最后夹到该月最后一天。 */
  var cutoffDate = new Date(d.getFullYear(), d.getMonth(), 1)
  cutoffDate.setFullYear(cutoffDate.getFullYear() - 1)
  var lastDay = new Date(cutoffDate.getFullYear(), cutoffDate.getMonth() + 1, 0).getDate()
  cutoffDate.setDate(Math.min(d.getDate(), lastDay))
  var cutoff = cutoffDate.getTime()
  /* 从末尾（最老的）往前删，直到剩下的跨度不超过一年。逐条判断而不提前 break，
   * 这样即使传进来的不是严格倒序（比如恢复备份）也不会漏删中间那条 */
  var n = 0
  for (var j = list.length - 1; j >= 0; j--) {
    if (list[j].time >= cutoff) continue
    list.splice(j, 1)
    n++
  }
  return n
}

/* 启动时清一次存量数据：读出来 → 截到一年 → 有变化才写盘，返回删掉的笔数 */
function trimExisting() {
  var list = all()
  sortDesc(list)
  var n = trimYear(list)
  if (n) persist()
  return n
}

/* 按「日期+金额」建索引，避免每条都去扫全表 */
function indexByDay(list) {
  var idx = {}
  for (var i = 0; i < list.length; i++) {
    var t = list[i]
    var k = t.day + '|' + round2(t.amount)
    if (!idx[k]) idx[k] = []
    idx[k].push(t)
  }
  return idx
}

/* 只算不写：给导入页做预览 */
function previewAdd(list) {
  return runAdd(list, true)
}

function addMany(list) {
  return runAdd(list, false)
}

function runAdd(list, dry) {
  var cur = all()
  var base = dry ? cur.slice() : cur
  var idx = indexByDay(base)
  var ids = {}
  for (var i = 0; i < base.length; i++) ids[base[i].id] = true

  var added = 0
  var dup = 0
  var merged = 0
  var dirty = false

  for (var j = 0; j < list.length; j++) {
    var t = list[j]
    if (ids[t.id]) { dup++; continue }

    var cands = idx[t.day + '|' + round2(t.amount)] || []
    var hit = null
    for (var k = 0; k < cands.length; k++) {
      if (sameLoose(cands[k], t)) { hit = cands[k]; break }
    }

    if (hit) {
      /* 合并后其实什么都没变 → 说明这条早就存过了，算重复而不是合并 */
      var changed = dry ? true : mergeInto(hit, t)
      ids[t.id] = true
      if (changed) { merged++; dirty = true } else { dup++ }
      continue
    }

    ids[t.id] = true
    base.push(t)
    var ik = t.day + '|' + round2(t.amount)
    if (!idx[ik]) idx[ik] = []
    idx[ik].push(t)
    added++
    dirty = true
  }

  if (!dry) {
    sortDesc(cur)
    var trimmed = trimYear(cur)
    if (trimmed) dirty = true
    var saved = true
    if (dirty) saved = persist()
    return { added: added, dup: dup, merged: merged, trimmed: trimmed, saved: saved }
  }

  /* 预览：在副本上算「真导进来会清掉几条」，不改动真实数据 */
  sortDesc(base)
  var wouldTrim = trimYear(base)
  return { added: added, dup: dup, merged: merged, trimmed: wouldTrim }
}

function addOne(t) {
  var cur = all()
  cur.push(t)
  sortDesc(cur)
  var trimmed = trimYear(cur)
  var saved = persist()
  /* 新记的这条自己就在一年之外、被清掉了：告诉调用方一声，别让它以为记上了 */
  return { tx: t, trimmed: trimmed, kept: cur.indexOf(t) >= 0, saved: saved }
}

function update(id, patch) {
  var cur = all()
  for (var i = 0; i < cur.length; i++) {
    if (cur[i].id === id) {
      for (var k in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) cur[i][k] = patch[k]
      }
      persist()
      return cur[i]
    }
  }
  return null
}

function remove(id) {
  var cur = all()
  for (var i = 0; i < cur.length; i++) {
    if (cur[i].id === id) {
      cur.splice(i, 1)
      persist()
      return true
    }
  }
  return false
}

/* 删除一整个月的流水，返回删掉的笔数 */
function removeMonth(ym) {
  var cur = all()
  var n = 0
  for (var i = cur.length - 1; i >= 0; i--) {
    if (cur[i].ym === ym) { cur.splice(i, 1); n++ }
  }
  if (n) persist()
  return n
}

/* 清空所有数据：流水 + 学到的分类规则 + 预算，一次性清干净 */
function clearAll() {
  _cache = []
  _rules = {}
  persist()
  saveRules()
  try { wx.removeStorageSync(KEY_BUDGET) } catch (e) {}
  try { wx.removeStorageSync(KEY_CATBUD) } catch (e) {}
}

function rules() {
  if (_rules) return _rules
  var v = wx.getStorageSync(KEY_RULE)
  _rules = (v && typeof v === 'object') ? v : {}
  return _rules
}

function saveRules() {
  try {
    wx.setStorageSync(KEY_RULE, _rules || {})
  } catch (e) {}
}

/* 用户手动改了某笔的分类 → 记住这个商户名，下次自动命中 */
function learn(merchant, cat) {
  var key = String(merchant || '').trim()
  if (!key || key.length < 2) return
  if (cat === '未分类') return
  var r = rules()
  if (r[key] && r[key] === cat) return
  r[key] = cat
  saveRules()
}

/* 导入时用平台给的分类训练规则（平台分类更权威） */
function learnFromItems(items) {
  var r = rules()
  var changed = false
  for (var i = 0; i < items.length; i++) {
    var it = items[i]
    if (it.byPlatform !== 'platform') continue
    var key = String(it.merchant || '').trim()
    if (!key || key.length < 2) continue
    if (it.category === '未分类') continue
    if (r[key]) continue
    r[key] = it.category
    changed = true
  }
  if (changed) saveRules()
}

/* 月度预算（只存一个数，不按月分；想看历史月份的预算再说） */
function budget() {
  var v = wx.getStorageSync(KEY_BUDGET)
  var n = Number(v)
  return isNaN(n) || n <= 0 ? 0 : Math.round(n * 100) / 100
}

function setBudget(v) {
  var n = Number(v)
  if (isNaN(n) || n <= 0) {
    try { wx.removeStorageSync(KEY_BUDGET) } catch (e) {}
    return 0
  }
  n = Math.round(n * 100) / 100
  try {
    wx.setStorageSync(KEY_BUDGET, n)
  } catch (e) {
    wx.showToast({ title: '存储失败，预算未保存', icon: 'none' })
  }
  return n
}

/* 分类预算：{ 类目名: 额度 }，只对支出有意义 */
function catBudgets() {
  var v = wx.getStorageSync(KEY_CATBUD)
  return (v && typeof v === 'object') ? v : {}
}

function setCatBudget(name, v) {
  var m = catBudgets()
  var n = Number(v)
  if (isNaN(n) || n <= 0) { delete m[name] } else { m[name] = Math.round(n * 100) / 100 }
  try {
    wx.setStorageSync(KEY_CATBUD, m)
  } catch (e) {
    wx.showToast({ title: '存储失败，预算未保存', icon: 'none' })
  }
  return m
}

/* 全量备份：流水 + 规则 + 预算，打成一个 JSON */
function exportAll() {
  return {
    app: '通用记账Book',
    version: 1,
    exportedAt: Date.now(),
    txs: all(),
    rules: rules(),
    budget: budget(),
    catBudgets: catBudgets()
  }
}

/* 从备份恢复：流水走现有判重合并，规则只补缺，预算以备份为准 */
function importAll(payload) {
  if (!payload || !Array.isArray(payload.txs)) throw new Error('备份文件格式不对')
  /* 外部 JSON 不可信：先把畸形元素挑出去，否则 addMany 里读 t.id/t.day 会整包抛异常，
   * 导致一条坏数据让整份备份都恢复不了。 */
  var clean = []
  var skipped = 0
  for (var i = 0; i < payload.txs.length; i++) {
    var t = payload.txs[i]
    if (t && typeof t === 'object' && t.id && isFinite(t.time) && isFinite(t.amount)) {
      t.day = t.day || format.dayOf(t.time)
      t.ym = t.ym || t.day.slice(0, 7)
      clean.push(t)
    } else {
      skipped++
    }
  }
  var res = addMany(clean)
  res.skipped = skipped
  var r = rules()
  var ruleAdded = 0
  if (payload.rules && typeof payload.rules === 'object') {
    Object.keys(payload.rules).forEach(function (k) {
      if (!r[k]) { r[k] = payload.rules[k]; ruleAdded++ }
    })
    saveRules()
  }
  if (Number(payload.budget) > 0) setBudget(payload.budget)
  if (payload.catBudgets && typeof payload.catBudgets === 'object') {
    var cm = catBudgets()
    Object.keys(payload.catBudgets).forEach(function (k) { cm[k] = payload.catBudgets[k] })
    wx.setStorageSync(KEY_CATBUD, cm)
  }
  return {
    added: res.added,
    dup: res.dup,
    merged: res.merged,
    trimmed: res.trimmed,
    skipped: skipped,
    rules: ruleAdded,
    total: all().length
  }
}

module.exports = {
  all: all,
  addMany: addMany,
  previewAdd: previewAdd,
  addOne: addOne,
  update: update,
  remove: remove,
  removeMonth: removeMonth,
  clearAll: clearAll,
  rules: rules,
  learn: learn,
  learnFromItems: learnFromItems,
  budget: budget,
  setBudget: setBudget,
  catBudgets: catBudgets,
  setCatBudget: setCatBudget,
  exportAll: exportAll,
  importAll: importAll,
  trimYear: trimYear,
  trimExisting: trimExisting,
  reload: function () { _cache = null; _rules = null }
}
