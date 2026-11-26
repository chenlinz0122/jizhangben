/* 支付方式文本 -> 账户。原始 account 字段只用于匹配，关联结果写入 accountId。
 * account_mappings_v1: [{ id, keyword, accountId, enabled, createdAt }]
 * 同长度关键词命中不同账户时不猜测，交由用户逐笔选择。
 */
var KEY = 'account_mappings_v1'
var MAX_KEYWORD = 80
var _lastError = ''
var _idCounter = 0

function MappingError(code, message, partial) {
  this.name = 'MappingError'
  this.code = code
  this.message = message
  this.partial = !!partial
}
MappingError.prototype = Object.create(Error.prototype)
MappingError.prototype.constructor = MappingError

function absent(value) {
  return value === '' || value === undefined || value === null
}

function normalizeKeyword(value) {
  return String(value == null ? '' : value).trim().toLowerCase().replace(/\s+/g, '')
}

function readRaw() {
  try {
    return wx.getStorageSync(KEY)
  } catch (e) {
    throw new MappingError('STORAGE_READ_FAILED', '支付方式映射读取失败，请重试')
  }
}

function normalizeRule(raw, base, strict) {
  raw = raw || {}
  base = base || {}
  var id = raw.id === undefined ? base.id : raw.id
  if (id === undefined || id === null) id = ''
  if (typeof id !== 'string' && typeof id !== 'number') return { error: '映射规则 ID 无效' }
  id = String(id).trim()
  if (id.length > 100 || (strict && !id)) return { error: '映射规则 ID 无效' }

  var keyword = raw.keyword === undefined ? base.keyword : raw.keyword
  if (typeof keyword !== 'string') return { error: '支付方式关键词必须是文本' }
  keyword = keyword.trim()
  if (!keyword) return { error: '请填写支付方式关键词' }
  if (/[\u0000-\u001f\u007f]/.test(keyword)) return { error: '关键词不能包含控制字符' }
  keyword = normalizeKeyword(keyword)
  if (keyword.length > MAX_KEYWORD) return { error: '关键词不能超过 ' + MAX_KEYWORD + ' 个字符' }

  var accountId = raw.accountId === undefined ? base.accountId : raw.accountId
  if (typeof accountId !== 'string' && typeof accountId !== 'number') return { error: '请选择关联账户' }
  accountId = String(accountId).trim()
  if (!accountId || accountId.length > 100) return { error: '请选择关联账户' }

  var enabled = raw.enabled === undefined ? (base.enabled === undefined ? true : base.enabled) : raw.enabled
  if (typeof enabled !== 'boolean') return { error: '规则启用状态无效' }
  var createdAt = raw.createdAt === undefined ? (base.createdAt === undefined ? Date.now() : base.createdAt) : raw.createdAt
  createdAt = Number(createdAt)
  if (!isFinite(createdAt) || createdAt <= 0) return { error: '规则创建时间无效' }

  return { rule: { id: id, keyword: keyword, accountId: accountId, enabled: enabled, createdAt: createdAt } }
}

function newId(items) {
  var seen = Object.create(null)
  items.forEach(function (item) { seen[item.id] = true })
  var id
  do {
    _idCounter++
    id = 'amap_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8) + '_' + _idCounter.toString(36)
  } while (seen[id])
  return id
}

function list() {
  _lastError = ''
  var raw = readRaw()
  if (absent(raw)) return []
  if (!Array.isArray(raw)) throw new MappingError('BAD_STORAGE', '支付方式映射应为规则数组')
  var seen = Object.create(null)
  var out = []
  for (var i = 0; i < raw.length; i++) {
    var normalized = normalizeRule(raw[i], null, true)
    if (!normalized.rule) throw new MappingError('BAD_STORAGE', '映射规则格式不对：' + normalized.error)
    if (seen[normalized.rule.id]) throw new MappingError('BAD_STORAGE', '映射规则包含重复 ID')
    seen[normalized.rule.id] = true
    out.push(normalized.rule)
  }
  return out
}

/* 单 key 写入后回读校验；失败时恢复原值，绝不把静默失败当成成功。 */
function writeAll(items) {
  var before = readRaw()
  var serialized = JSON.stringify(items)
  if (!absent(before) && JSON.stringify(before) === serialized) return true
  try {
    wx.setStorageSync(KEY, items)
    if (JSON.stringify(readRaw()) !== serialized) throw new Error('storage verification failed')
    _lastError = ''
    return true
  } catch (e) {
    var restored = false
    try {
      if (absent(before)) wx.removeStorageSync(KEY)
      else wx.setStorageSync(KEY, before)
      var after = readRaw()
      restored = absent(before) ? absent(after) : JSON.stringify(after) === JSON.stringify(before)
    } catch (rollbackError) {}
    var error = new MappingError('STORAGE_WRITE_FAILED', restored ? '映射保存失败，本次修改已撤销' : '映射保存中断且回滚失败，请立即核对本地数据', !restored)
    _lastError = error.message
    throw error
  }
}

function accountIds(accounts) {
  if (!Array.isArray(accounts)) throw new MappingError('BAD_ACCOUNTS', '账户列表格式不正确')
  var seen = Object.create(null)
  accounts.forEach(function (item) {
    if (item && item.id !== undefined && item.id !== null) seen[String(item.id)] = true
  })
  return seen
}

function ensureAccount(accountId, accounts) {
  if (accounts === undefined) return
  var seen = accountIds(accounts)
  if (!seen[accountId]) throw new MappingError('ACCOUNT_NOT_FOUND', '关联账户不存在，请重新选择')
}

function find(items, id) {
  id = String(id == null ? '' : id).trim()
  for (var i = 0; i < items.length; i++) if (items[i].id === id) return i
  return -1
}

function save(input, accounts) {
  _lastError = ''
  try {
    var items = list()
    var suppliedId = input && input.id !== undefined && input.id !== null ? String(input.id).trim() : ''
    var at = find(items, suppliedId)
    var normalized = normalizeRule(input || {}, at >= 0 ? items[at] : null, false)
    if (!normalized.rule) throw new MappingError('BAD_RULE', normalized.error)
    if (!normalized.rule.id) normalized.rule.id = newId(items)
    if (at < 0 && find(items, normalized.rule.id) >= 0) throw new MappingError('BAD_RULE', '映射规则 ID 已存在')
    ensureAccount(normalized.rule.accountId, accounts)
    if (at >= 0) items[at] = normalized.rule
    else items.push(normalized.rule)
    writeAll(items)
    return normalized.rule
  } catch (e) {
    _lastError = e.message || '映射规则保存失败'
    return null
  }
}

function remove(id) {
  _lastError = ''
  try {
    var items = list()
    var at = find(items, id)
    if (at < 0) return false
    items.splice(at, 1)
    writeAll(items)
    return true
  } catch (e) {
    _lastError = e.message || '映射规则删除失败'
    return false
  }
}

function toggle(id, enabled) {
  _lastError = ''
  try {
    var items = list()
    var at = find(items, id)
    if (at < 0) throw new MappingError('RULE_NOT_FOUND', '没有找到这条映射规则')
    if (enabled !== undefined && typeof enabled !== 'boolean') throw new MappingError('BAD_ENABLED', '启用状态无效')
    var next = enabled === undefined ? !items[at].enabled : enabled
    if (items[at].enabled === next) return items[at]
    items[at].enabled = next
    writeAll(items)
    return items[at]
  } catch (e) {
    _lastError = e.message || '规则状态切换失败'
    return null
  }
}

/* 删除账户后同步清理规则。返回 true 表示没有悬空规则（包括无需清理）。 */
function prune(accounts) {
  var seen = accountIds(accounts)
  var items = list()
  var next = items.filter(function (item) { return seen[item.accountId] })
  if (next.length !== items.length) writeAll(next)
  return true
}

function removeByAccountId(accountId) {
  accountId = String(accountId == null ? '' : accountId).trim()
  var items = list()
  var next = items.filter(function (item) { return item.accountId !== accountId })
  if (next.length !== items.length) writeAll(next)
  return true
}

function match(paymentName, accounts) {
  var keyword = normalizeKeyword(paymentName)
  var ids = accountIds(accounts)
  var rules = list()
  var longest = 0
  var hits = []
  rules.forEach(function (rule) {
    if (!rule.enabled || !ids[rule.accountId] || !keyword || keyword.indexOf(rule.keyword) < 0) return
    if (rule.keyword.length > longest) {
      longest = rule.keyword.length
      hits = [rule]
    } else if (rule.keyword.length === longest) {
      hits.push(rule)
    }
  })
  var unique = Object.create(null)
  var candidates = []
  hits.forEach(function (rule) {
    if (unique[rule.accountId]) return
    unique[rule.accountId] = true
    var account = accounts.filter(function (item) { return String(item.id) === rule.accountId })[0]
    candidates.push({ accountId: rule.accountId, accountName: account && account.name ? account.name : rule.accountId })
  })
  var ambiguous = candidates.length > 1
  return {
    matched: candidates.length === 1,
    ambiguous: ambiguous,
    status: candidates.length === 1 ? 'matched' : (ambiguous ? 'ambiguous' : 'unmatched'),
    keyword: hits.length ? hits[0].keyword : '',
    ruleIds: hits.map(function (rule) { return rule.id }),
    accountId: candidates.length === 1 ? candidates[0].accountId : '',
    accountName: candidates.length === 1 ? candidates[0].accountName : '',
    candidates: candidates
  }
}

function hasAccountId(tx) {
  return !!tx && tx.accountId !== undefined && tx.accountId !== null && String(tx.accountId).trim() !== ''
}

function assign(tx, accounts) {
  if (!tx || typeof tx !== 'object' || Array.isArray(tx)) return null
  var next = Object.assign({}, tx)
  if (hasAccountId(tx)) return next
  var result = match(tx.account, accounts)
  if (result.matched) next.accountId = result.accountId
  return next
}

function parsePayload(payload) {
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload) } catch (e) { throw new MappingError('BAD_PAYLOAD', '映射备份不是有效 JSON') }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.rules)) {
    throw new MappingError('BAD_PAYLOAD', '映射备份格式不对')
  }
  if (payload.version !== undefined && payload.version !== 1) throw new MappingError('BAD_PAYLOAD', '映射备份版本不支持')
  return payload
}

/* 合并计划不写存储；同一 ID 以导入规则为准，缺失账户的规则自动停用。 */
function planImport(payload, options) {
  payload = parsePayload(payload)
  options = options || {}
  var mode = options.mode === undefined ? 'merge' : options.mode
  if (mode !== 'merge' && mode !== 'replace') throw new MappingError('BAD_PAYLOAD', '映射导入模式无效')
  var seen = Object.create(null)
  var clean = payload.rules.map(function (raw) {
    var normalized = normalizeRule(raw, null, true)
    if (!normalized.rule) throw new MappingError('BAD_PAYLOAD', '映射备份格式不对：' + normalized.error)
    if (seen[normalized.rule.id]) throw new MappingError('BAD_PAYLOAD', '映射备份包含重复 ID')
    seen[normalized.rule.id] = true
    return normalized.rule
  })
  var current = mode === 'merge' ? list() : []
  var map = Object.create(null)
  var order = []
  current.forEach(function (item) { map[item.id] = item; order.push(item.id) })
  var added = 0
  var updated = 0
  var unchanged = 0
  clean.forEach(function (item) {
    if (!map[item.id]) { order.push(item.id); added++ }
    else if (JSON.stringify(map[item.id]) !== JSON.stringify(item)) updated++
    else unchanged++
    map[item.id] = item
  })
  var value = order.map(function (id) { return map[id] })
  var disabled = 0
  if (options.accounts !== undefined) {
    var ids = accountIds(options.accounts)
    value.forEach(function (item) {
      if (!ids[item.accountId] && item.enabled) { item.enabled = false; disabled++ }
    })
  }
  var raw = readRaw()
  var changes = (!absent(raw) && JSON.stringify(raw) === JSON.stringify(value)) || (absent(raw) && !value.length)
    ? [] : [{ key: KEY, value: value }]
  return {
    ok: true,
    mode: mode,
    value: value,
    changes: changes,
    added: added,
    updated: updated,
    disabled: disabled,
    unchanged: unchanged,
    total: value.length
  }
}

function importData(payload, options) {
  _lastError = ''
  try {
    var plan = planImport(payload, options)
    if (plan.changes.length) writeAll(plan.value)
    return plan.value
  } catch (e) {
    _lastError = e.message || '映射导入失败'
    throw e
  }
}

function exportData() {
  return {
    app: '通用记账Book',
    version: 1,
    storageKey: KEY,
    exportedAt: Date.now(),
    rules: list()
  }
}

module.exports = {
  KEY: KEY,
  STORAGE_KEY: KEY,
  MappingError: MappingError,
  normalizeKeyword: normalizeKeyword,
  normalize: normalizeKeyword,
  normalizeRule: normalizeRule,
  list: list,
  save: save,
  remove: remove,
  toggle: toggle,
  match: match,
  assign: assign,
  exportData: exportData,
  importData: importData,
  planImport: planImport,
  prune: prune,
  removeByAccountId: removeByAccountId,
  hasAccountId: hasAccountId,
  error: function () { return _lastError }
}
