/* 本地存储：流水 / 规则 / 设置 */
var category = require('./category')
var format = require('./format')

var KEY_TX = 'txs_v1'
var KEY_RULE = 'rules_v1'
var KEY_BUDGET = 'budget_v1'
var KEY_CATBUD = 'budcats_v1'
/* 删除日志 { id: 删除时间 }：共同账本同步时据此通知云端，重新加回来的会自动划掉 */
var KEY_GONE = 'gone_v1'

var _cache = null
var _rules = null

/* 老账本里被当成收入的理财收益：只在「收益发放 / 理财收益 / 余额宝收益」这类
 * 明确字眼上动手，申购/赎回/转入/转出仍按原来的资金搬移处理 */
function isOldYield(t) {
  if (!t || t.type === 'transfer') return false
  var text = String(t.merchant || '') + '|' + String(t.desc || '') + '|' + String(t.category || '')
  if (!/收益发放|收益入账|理财收益|余额宝收益/.test(text)) return false
  return !/申购|赎回|转入|转出/.test(text)
}

function all() {
  if (_cache) return _cache
  var v = wx.getStorageSync(KEY_TX)
  _cache = Array.isArray(v) ? v : []
  /* 口径升级：旧分类名在读出时统一映射成官方分类；不动本地原始数据，随时可退 */
  for (var i = 0; i < _cache.length; i++) {
    var t = _cache[i]
    var c = category.migrate(t)
    if (c !== t.category) t.category = c
    /* 类目落在「不计收支」那几类时，类型也跟着纠正：
     * 老账本把银行卡进出记成了收入/支出，只改类目不改类型的话还会被算进收支 */
    if (category.isMoveCat(t.category)) t.type = 'transfer'
    /* 老口径遗留：理财收益（余额宝-收益发放）曾被记成一笔「其他收入」，
     * 现在统一认成「不计收支 / 理财」——收益只是账户自己涨了，不算进账 */
    if (isOldYield(t)) {
      t.type = 'transfer'
      t.category = '理财'
    }
    /* 共同账本拉下来的记录：老版本推上去的可能没带 day / ym（云端只存推上来的字段），
     * 读出来就按时间补齐。不补的话流水页按月过滤会把它们整条挡掉，
     * 表现就是「同步成功了、账本里也有这笔，但流水里怎么都看不见」。 */
    if (!t.time && t.day) {
      var dp = String(t.day).split('-')
      var ts = new Date(Number(dp[0]), Number(dp[1]) - 1, Number(dp[2])).getTime()
      if (ts) t.time = ts
    }
    if (!t.day && t.time) t.day = format.dayOf(t.time)
    if (!t.ym) t.ym = t.day ? String(t.day).slice(0, 7) : (t.time ? format.ymOf(t.time) : '')
  }
  return _cache
}

function saveChanges(changes) {
  var before = []
  var written = 0
  try {
    for (var i = 0; i < changes.length; i++) before.push(wx.getStorageSync(changes[i].key))
    for (var j = 0; j < changes.length; j++) {
      var change = changes[j]
      if (change.value === null) wx.removeStorageSync(change.key)
      else wx.setStorageSync(change.key, change.value)
      written++
    }
  } catch (e) {
    var partial = false
    for (var k = written - 1; k >= 0; k--) {
      try {
        if (before[k] === '' || before[k] === undefined) wx.removeStorageSync(changes[k].key)
        else wx.setStorageSync(changes[k].key, before[k])
      } catch (rollbackError) {
        partial = true
      }
    }
    if (partial) { _cache = null; _rules = null }
    wx.showToast({ title: partial ? '保存中断，请核对账本后重试' : '存储失败，本次修改未保存', icon: 'none' })
    return { saved: false, partial: partial }
  }
  for (var n = 0; n < changes.length; n++) {
    if (changes[n].key === KEY_TX) _cache = changes[n].value
    if (changes[n].key === KEY_RULE) _rules = changes[n].value
  }
  return { saved: true }
}

function copyTxs() {
  return all().map(function (t) { return Object.assign({}, t) })
}

function gone() {
  var v = wx.getStorageSync(KEY_GONE)
  return Object.assign(Object.create(null), v && typeof v === 'object' && !Array.isArray(v) ? v : {})
}

/* 删除日志的下一版：add 记进去，drop 划掉；没变化返回 null */
function goneChange(add, drop) {
  var cur = gone()
  var next = Object.assign(Object.create(null), cur)
  var changed = false
  var now = Date.now()
  for (var i = 0; i < (add || []).length; i++) {
    if (add[i] && !next[add[i]]) { next[add[i]] = now; changed = true }
  }
  for (var j = 0; j < (drop || []).length; j++) {
    if (next[drop[j]]) { delete next[drop[j]]; changed = true }
  }
  if (!changed) return null
  return { key: KEY_GONE, value: Object.keys(next).length ? next : null }
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
  if (!canEdit(a) || !canEdit(b)) return false
  if (a.type !== b.type) return false
  if (a.day !== b.day) return false
  if (round2(a.amount) !== round2(b.amount)) return false
  if (!merchantLike(a.merchant, b.merchant)) return false
  /* 不同人记的账绝不合并：共同账本里两个人可能同一分钟各记一笔同商户同金额
     （一起点外卖、各买一杯奶茶），那是两笔真实支出，合并掉就等于把对方那条吃了 */
  if (!!a.by !== !!b.by) return false
  if (a.by && b.by && a.by !== b.by) return false

  var pa = String(a.id || '').charAt(0)
  var pb = String(b.id || '').charAt(0)
  if (!((pa === 'b' && pb === 'h') || (pa === 'h' && pb === 'b'))) return false

  if (zeroClock(a.time) || zeroClock(b.time)) return true
  return Math.abs(a.time - b.time) <= 2 * 60 * 1000
}

/* 把新记录的信息补进已有那条，返回是否有改动 */
function mergeInto(target, src, renamed) {
  var changed = false

  /* 单号型是更权威的那份，升级 id，以后再导就自动判重复 */
  if (String(src.id || '').charAt(0) === 'b' && String(target.id || '').charAt(0) === 'h') {
    if (renamed) renamed.push(target.id)
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
  /* 共同账本：自己这条被别人的记录「并」上了，也把「谁记的」带过来，
   * 否则合并完就成了无名记录，看着像自己记的 */
  if (!target.by && src.by) {
    target.by = src.by
    if (src.byMe === false) target.byMe = false
    changed = true
  }
  if (changed) target.edited = Date.now()
  return changed
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
  var merged = mergeItems(list)
  var result = { added: merged.added, dup: merged.dup, merged: merged.merged }
  if (!dry) {
    var saved = merged.dirty ? saveChanges(merged.changes) : { saved: true }
    Object.assign(result, saved)
  }
  return result
}

function mergeItems(list) {
  var base = copyTxs()
  var idx = indexByDay(base)
  var ids = Object.create(null)
  for (var i = 0; i < base.length; i++) ids[base[i].id] = true

  var added = 0
  var dup = 0
  var merged = 0
  var dirty = false
  var renamed = []
  var fresh = []
  var deleted = gone()

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
      var changed = mergeInto(hit, t, renamed)
      ids[t.id] = true
      if (changed) { merged++; dirty = true } else { dup++ }
      continue
    }

    ids[t.id] = true
    fresh.push(t.id)
    var next = Object.assign({}, t)
    if (canEdit(t) && deleted[t.id]) next.edited = Math.max(Date.now(), Number(t.edited || 0) + 1, deleted[t.id] + 1)
    base.push(next)
    var ik = next.day + '|' + round2(next.amount)
    if (!idx[ik]) idx[ik] = []
    idx[ik].push(next)
    added++
    dirty = true
  }

  sortDesc(base)
  /* 截图型 id 升级成单号型 = 旧 id 没了；删过又加回来的 = 不算删 */
  var changes = []
  var goneNext = goneChange(renamed, fresh)
  if (goneNext) changes.push(goneNext)
  changes.push({ key: KEY_TX, value: base })
  return { items: base, added: added, dup: dup, merged: merged, dirty: dirty, changes: changes }
}

function addOne(t) {
  var cur = copyTxs()
  var next = Object.assign({}, t)
  var deleted = gone()[t.id]
  if (canEdit(t) && deleted) next.edited = Math.max(Date.now(), Number(t.edited || 0) + 1, deleted + 1)
  cur.push(next)
  sortDesc(cur)
  var changes = []
  var restored = goneChange(null, [t.id])
  if (restored) changes.push(restored)
  changes.push({ key: KEY_TX, value: cur })
  return Object.assign({ tx: t }, saveChanges(changes))
}

function canEdit(t) {
  return !!t && t.byMe !== false
}

function update(id, patch) {
  var cur = copyTxs()
  for (var i = 0; i < cur.length; i++) {
    if (cur[i].id === id) {
      if (!canEdit(cur[i])) return null
      for (var k in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) cur[i][k] = patch[k]
      }
      cur[i].edited = Date.now()
      var updated = cur[i]
      sortDesc(cur)
      return saveChanges([{ key: KEY_TX, value: cur }]).saved ? updated : null
    }
  }
  return null
}

/* 批量改分类：同一个商户的历史记录一起改，只写一次存储。
 * 一共 3000 笔的时候逐笔 update() 会写 3000 次，卡死。 */
function relabel(ids, cat) {
  var cur = copyTxs()
  var mark = Object.create(null)
  for (var i = 0; i < ids.length; i++) mark[ids[i]] = true
  var n = 0
  for (var j = 0; j < cur.length; j++) {
    if (canEdit(cur[j]) && mark[cur[j].id] && cur[j].category !== cat) {
      cur[j].category = cat
      cur[j].edited = Date.now()
      n++
    }
  }
  if (n && !saveChanges([{ key: KEY_TX, value: cur }]).saved) return null
  return n
}

function remove(id) {
  return removeMany([id]) === 1
}

/* 一次删多笔，返回删掉的笔数；保存失败返回 null */
function removeMany(ids) {
  var mark = Object.create(null)
  for (var i = 0; i < ids.length; i++) mark[ids[i]] = true
  var cur = all()
  var next = []
  var hit = []
  for (var j = 0; j < cur.length; j++) {
    if (mark[cur[j].id] && canEdit(cur[j])) hit.push(cur[j].id)
    else next.push(cur[j])
  }
  if (!hit.length) return 0
  var changes = []
  var goneNext = goneChange(hit, null)
  if (goneNext) changes.push(goneNext)
  changes.push({ key: KEY_TX, value: next })
  return saveChanges(changes).saved ? hit.length : null
}

/* 删除一整个月的流水，返回删掉的笔数 */
function removeMonth(ym) {
  var ids = []
  var cur = all()
  for (var i = 0; i < cur.length; i++) {
    if (cur[i].ym === ym) ids.push(cur[i].id)
  }
  return removeMany(ids)
}

/* 共同账本同步落库：按 id 整条替换或新增，再删掉云端已删除的。
 * 不做弱合并（别人的账不能并进我的），也不记删除日志（这些删除本来就来自云端）。 */
function applyRemote(puts, removeIds) {
  var drop = Object.create(null)
  for (var i = 0; i < (removeIds || []).length; i++) drop[removeIds[i]] = true
  var put = Object.create(null)
  for (var j = 0; j < (puts || []).length; j++) put[puts[j].id] = puts[j]
  var cur = all()
  var next = []
  var out = { added: 0, updated: 0, removed: 0 }
  for (var k = 0; k < cur.length; k++) {
    var t = cur[k]
    if (drop[t.id]) { out.removed++; continue }
    if (put[t.id]) {
      next.push(Object.assign({}, put[t.id]))
      put[t.id] = null
      out.updated++
      continue
    }
    next.push(t)
  }
  for (var m = 0; m < (puts || []).length; m++) {
    if (!put[puts[m].id]) continue
    next.push(Object.assign({}, puts[m]))
    put[puts[m].id] = null
    out.added++
  }
  if (!out.added && !out.updated && !out.removed) return Object.assign(out, { saved: true })
  sortDesc(next)
  var changes = []
  var restored = goneChange(null, (puts || []).filter(canEdit).map(function (t) { return t.id }))
  if (restored) changes.push(restored)
  changes.push({ key: KEY_TX, value: next })
  return Object.assign(out, saveChanges(changes))
}

function clearAll() {
  var changes = [
    { key: KEY_RULE, value: {} },
    { key: KEY_BUDGET, value: null },
    { key: KEY_CATBUD, value: null }
  ]
  var deleted = goneChange(all().map(function (t) { return t.id }), null)
  if (deleted) changes.push(deleted)
  changes.push({ key: KEY_TX, value: [] })
  return saveChanges(changes).saved
}

function rules() {
  if (_rules) return _rules
  var v = wx.getStorageSync(KEY_RULE)
  _rules = (v && typeof v === 'object') ? v : {}
  return _rules
}

/* 用户手动改了某笔的分类 → 记住这个商户名，下次自动命中 */
function learn(merchant, cat) {
  var key = String(merchant || '').trim()
  if (!key || key.length < 2 || cat === '未分类') return true
  var r = Object.assign(Object.create(null), rules())
  if (r[key] === cat) return true
  r[key] = cat
  return saveChanges([{ key: KEY_RULE, value: r }]).saved
}

/* 导入时用平台给的分类训练规则（平台分类更权威） */
function learnFromItems(items) {
  var r = Object.assign(Object.create(null), rules())
  var changed = false
  for (var i = 0; i < items.length; i++) {
    var it = items[i]
    if (it.byPlatform !== 'platform') continue
    var key = String(it.merchant || '').trim()
    if (!key || key.length < 2) continue
    if (it.category === '未分类') continue
    /* 淘宝/京东/抖音这类「什么都能买」的平台名不学：一旦学成购物，
     * 下次在上面买课、买药也永远是购物。它们交给平台分类每次重新判定。 */
    if (category.isLooseMerchant(key)) continue
    if (r[key]) continue
    r[key] = it.category
    changed = true
  }
  return !changed || saveChanges([{ key: KEY_RULE, value: r }]).saved
}

/* 月度预算（只存一个数，不按月分；想看历史月份的预算再说） */
function budget() {
  var v = wx.getStorageSync(KEY_BUDGET)
  var n = Number(v)
  return isNaN(n) || n <= 0 ? 0 : Math.round(n * 100) / 100
}

function setBudget(v) {
  var n = Number(v)
  n = isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0
  return saveChanges([{ key: KEY_BUDGET, value: n > 0 ? n : null }]).saved ? n : null
}

/* 分类预算：{ 类目名: 额度 }，只对支出有意义 */
function catBudgets() {
  var v = wx.getStorageSync(KEY_CATBUD)
  return (v && typeof v === 'object') ? v : {}
}

function setCatBudget(name, v) {
  var m = Object.assign(Object.create(null), catBudgets())
  var n = Number(v)
  if (!isFinite(n) || n <= 0) { delete m[name] } else { m[name] = Math.round(n * 100) / 100 }
  return saveChanges([{ key: KEY_CATBUD, value: m }]).saved ? m : null
}

/* AI 补分类：按「商户名」把这批未分类的支出改掉，并把结果沉淀成规则
 * 只动「未分类」的行，已经分好类的一律不碰——AI 判错了也只是浪费一次，不会污染旧数据 */
function applyCategories(map) {
  var cur = copyTxs()
  var r = Object.assign(Object.create(null), rules())
  var keys = Object.keys(map || {})
  var changed = 0
  var learned = 0

  for (var i = 0; i < keys.length; i++) {
    var key = String(keys[i] || '').trim()
    var cat = map[keys[i]]
    if (key.length < 2 || !cat || cat === '未分类') continue
    for (var j = 0; j < cur.length; j++) {
      var t = cur[j]
      if (!canEdit(t) || t.type !== 'expense' || t.category !== '未分类') continue
      if (String(t.merchant || '').trim() !== key) continue
      t.category = cat
      t.edited = Date.now()
      changed++
    }
    if (!r[key]) { r[key] = cat; learned++ }
  }

  var changes = []
  if (learned) changes.push({ key: KEY_RULE, value: r })
  if (changed) changes.push({ key: KEY_TX, value: cur })
  var result = saveChanges(changes)
  return Object.assign({ changed: result.saved ? changed : 0, learned: result.saved ? learned : 0 }, result)
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

function importAll(payload) {
  if (!payload || !Array.isArray(payload.txs) ||
      (payload.version !== undefined && payload.version !== 1)) throw new Error('备份文件格式不对')
  var maps = ['rules', 'catBudgets']
  for (var m = 0; m < maps.length; m++) {
    var name = maps[m]
    var value = payload[name]
    if (value === undefined) continue
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('备份文件格式不对')
    var keys = Object.keys(value)
    for (var k = 0; k < keys.length; k++) {
      var entry = value[keys[k]]
      if (name === 'rules' ? typeof entry !== 'string' :
          (typeof entry !== 'number' || !isFinite(entry) || entry < 0)) throw new Error('备份文件格式不对')
    }
  }
  if (payload.budget !== undefined &&
      (typeof payload.budget !== 'number' || !isFinite(payload.budget) || payload.budget < 0)) {
    throw new Error('备份文件格式不对')
  }

  var clean = []
  var skipped = 0
  var kinds = ['expense', 'income', 'refund', 'transfer']
  var textFields = ['merchant', 'desc', 'note', 'category', 'account', 'status', 'source', 'src', 'byPlatform', 'by']
  for (var i = 0; i < payload.txs.length; i++) {
    var t = payload.txs[i]
    var valid = t && typeof t === 'object' && !Array.isArray(t) &&
      typeof t.id === 'string' && t.id.trim() &&
      typeof t.time === 'number' && isFinite(new Date(t.time).getTime()) &&
      typeof t.amount === 'number' && isFinite(t.amount) && t.amount > 0 && kinds.indexOf(t.type) >= 0
    if (valid) {
      for (var f = 0; f < textFields.length; f++) {
        var field = t[textFields[f]]
        if (field !== undefined && typeof field !== 'string') { valid = false; break }
      }
    }
    if (!valid) { skipped++; continue }
    var next = Object.assign({}, t)
    next.day = format.dayOf(next.time)
    next.ym = next.day.slice(0, 7)
    clean.push(next)
  }

  var res = mergeItems(clean)
  var changes = []
  var ruleAdded = 0
  if (payload.rules !== undefined) {
    var r = Object.assign(Object.create(null), rules())
    Object.keys(payload.rules).forEach(function (key) {
      if (!r[key]) { r[key] = payload.rules[key]; ruleAdded++ }
    })
    if (ruleAdded) changes.push({ key: KEY_RULE, value: r })
  }
  if (payload.budget !== undefined) {
    changes.push({ key: KEY_BUDGET, value: payload.budget > 0 ? Math.round(payload.budget * 100) / 100 : null })
  }
  if (payload.catBudgets !== undefined) {
    var cm = Object.assign(Object.create(null), catBudgets(), payload.catBudgets)
    changes.push({ key: KEY_CATBUD, value: cm })
  }
  if (res.dirty) changes = changes.concat(res.changes)
  var result = saveChanges(changes)
  return Object.assign({
    added: result.saved ? res.added : 0,
    dup: res.dup,
    merged: result.saved ? res.merged : 0,
    skipped: skipped,
    rules: result.saved ? ruleAdded : 0,
    total: all().length
  }, result)
}

module.exports = {
  all: all,
  addMany: addMany,
  previewAdd: previewAdd,
  addOne: addOne,
  update: update,
  canEdit: canEdit,
  relabel: relabel,
  applyCategories: applyCategories,
  remove: remove,
  removeMany: removeMany,
  removeMonth: removeMonth,
  applyRemote: applyRemote,
  gone: gone,
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
  reload: function () { _cache = null; _rules = null }
}
