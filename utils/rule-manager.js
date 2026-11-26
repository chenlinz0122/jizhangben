/* 分类规则管理：rules_v1 为启用规则，disabled_rules_v1 为停用规则。
 * 读接口遇到坏数据会抛出带 code 的 RuleError；写接口统一返回
 * { ok, changed, code?, message? }，绝不把校验或存储失败当成成功。
 */
var category = require('./category')
var store = require('./store')

var KEY_ENABLED = 'rules_v1'
var KEY_DISABLED = 'disabled_rules_v1'
var KEY_TX = 'txs_v1'
var MAX_MERCHANT = 80
var VALID_TYPES = ['expense', 'income', 'refund', 'transfer']
var VALID_CATS = []
;['expense', 'income', 'transfer'].forEach(function (type) {
  category.CATS[type].forEach(function (name) {
    if (VALID_CATS.indexOf(name) < 0) VALID_CATS.push(name)
  })
})

function RuleError(code, message, details) {
  this.name = 'RuleError'
  this.code = code
  this.message = message
  if (details) this.details = details
}
RuleError.prototype = Object.create(Error.prototype)
RuleError.prototype.constructor = RuleError

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

function absent(value) {
  return value === '' || value === undefined || value === null
}

function validateMerchant(value) {
  if (typeof value !== 'string') throw new RuleError('BAD_MERCHANT', '商户名必须是文本')
  var merchant = value.trim()
  if (!merchant) throw new RuleError('BAD_MERCHANT', '商户名不能为空')
  if (merchant.length > MAX_MERCHANT) throw new RuleError('BAD_MERCHANT', '商户名不能超过 ' + MAX_MERCHANT + ' 个字符')
  if (/[\u0000-\u001f\u007f]/.test(merchant)) throw new RuleError('BAD_MERCHANT', '商户名不能包含控制字符')
  if (['__proto__', 'prototype', 'constructor'].indexOf(merchant) >= 0) {
    throw new RuleError('BAD_MERCHANT', '商户名含有不安全的关键字')
  }
  return merchant
}

function validateType(type) {
  if (VALID_TYPES.indexOf(type) < 0) throw new RuleError('BAD_TYPE', '流水类型必须是 expense、income、refund 或 transfer')
  return type
}

function readSnapshot(key) {
  var raw
  try {
    raw = wx.getStorageSync(key)
  } catch (e) {
    throw new RuleError('STORAGE_READ_FAILED', '读取 ' + key + ' 失败，请重试')
  }
  return { key: key, present: !absent(raw), value: absent(raw) ? {} : raw }
}

function parseMap(snapshot) {
  var raw = snapshot.value
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RuleError('BAD_STORAGE', snapshot.key + ' 应是“商户名:分类名”对象')
  }
  var map = Object.create(null)
  Object.keys(raw).forEach(function (key) {
    var merchant = validateMerchant(key)
    if (key !== merchant) throw new RuleError('BAD_STORAGE', snapshot.key + ' 的商户名不能包含首尾空格')
    var name = raw[key]
    if (typeof name !== 'string' || !name.trim() || name !== name.trim() || VALID_CATS.indexOf(name) < 0) {
      throw new RuleError('BAD_STORAGE', snapshot.key + ' 中“' + key + '”的分类无效', { key: key })
    }
    map[merchant] = name
  })
  return map
}

function loadState() {
  var enabledSnapshot = readSnapshot(KEY_ENABLED)
  var disabledSnapshot = readSnapshot(KEY_DISABLED)
  var enabled = parseMap(enabledSnapshot)
  var disabled = parseMap(disabledSnapshot)
  Object.keys(enabled).forEach(function (merchant) {
    if (hasOwn(disabled, merchant)) {
      throw new RuleError('RULE_CONFLICT', '“' + merchant + '”同时存在于启用和停用规则中，请先核对数据')
    }
  })
  return {
    enabled: Object.assign(Object.create(null), enabled),
    disabled: Object.assign(Object.create(null), disabled),
    originalEnabled: enabled,
    originalDisabled: disabled,
    enabledSnapshot: enabledSnapshot,
    disabledSnapshot: disabledSnapshot
  }
}

function sameMap(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function restore(snapshot) {
  if (snapshot.present) wx.setStorageSync(snapshot.key, snapshot.value)
  else wx.removeStorageSync(snapshot.key)
}

function storageFailure(code, message, partial, key) {
  store.reload()
  var result = { ok: false, changed: false, code: code, message: message, partial: !!partial }
  if (key) result.key = key
  return result
}

/* 两个 key 一起提交，任一写入或回读失败都回滚，避免启用/停用各剩一半。 */
function commit(state, enabled, disabled) {
  var changes = []
  if (!sameMap(state.originalEnabled, enabled)) changes.push({ key: KEY_ENABLED, value: enabled, before: state.enabledSnapshot })
  if (!sameMap(state.originalDisabled, disabled)) changes.push({ key: KEY_DISABLED, value: disabled, before: state.disabledSnapshot })
  if (!changes.length) return { ok: true, changed: false }

  var serialized = []
  try {
    changes.forEach(function (change) { serialized.push(JSON.stringify(change.value)) })
  } catch (e) {
    return storageFailure('STORAGE_WRITE_FAILED', '规则序列化失败，本次修改未保存', false)
  }

  var written = 0
  var failedKey = ''
  try {
    for (var i = 0; i < changes.length; i++) {
      failedKey = changes[i].key
      wx.setStorageSync(changes[i].key, changes[i].value)
      written++
    }
    /* 某些真机/模拟器可能只返回错误而不抛错，回读一次，不静默报成功。 */
    for (var j = 0; j < changes.length; j++) {
      if (JSON.stringify(wx.getStorageSync(changes[j].key)) !== serialized[j]) {
        failedKey = changes[j].key
        throw new Error('storage verification failed')
      }
    }
  } catch (e) {
    var rollbackFailed = false
    for (var k = written - 1; k >= 0; k--) {
      try { restore(changes[k].before) } catch (rollbackError) { rollbackFailed = true }
    }
    if (rollbackFailed) {
      return storageFailure('STORAGE_ROLLBACK_FAILED', '保存中断且回滚失败，请立即核对本地规则数据', true, failedKey)
    }
    return storageFailure('STORAGE_WRITE_FAILED', '保存到 ' + failedKey + ' 失败，本次修改已撤销', false, failedKey)
  }
  store.reload()
  return { ok: true, changed: true }
}

function asFailure(error, fallbackCode) {
  if (error && error.code) {
    return { ok: false, changed: false, code: error.code, message: error.message || '规则操作失败', partial: !!error.partial }
  }
  return { ok: false, changed: false, code: fallbackCode || 'RULE_OPERATION_FAILED', message: '规则操作失败，请重试' }
}

function mutate(action) {
  try {
    var state = loadState()
    var outcome = action(state) || {}
    var metadata = Object.assign({}, outcome)
    delete metadata.nextEnabled
    delete metadata.nextDisabled
    if (!outcome.changed) return Object.assign({ ok: true, changed: false }, metadata)
    var saved = commit(state, outcome.nextEnabled, outcome.nextDisabled)
    return Object.assign(saved, metadata, { changed: saved.ok })
  } catch (error) {
    store.reload()
    return asFailure(error)
  }
}

function readTransactions() {
  var raw
  try {
    raw = wx.getStorageSync(KEY_TX)
  } catch (e) {
    throw new RuleError('STORAGE_READ_FAILED', '读取流水失败，无法计算影响笔数')
  }
  if (absent(raw)) return []
  if (!Array.isArray(raw)) throw new RuleError('BAD_STORAGE', KEY_TX + ' 应是流水数组')
  return raw
}

function findRule(state, merchant) {
  if (hasOwn(state.enabled, merchant)) return { merchant: merchant, category: state.enabled[merchant], enabled: true }
  if (hasOwn(state.disabled, merchant)) return { merchant: merchant, category: state.disabled[merchant], enabled: false }
  return null
}

/* 影响笔数按“分类结果实际变化”计算，而不是简单数同名商户。
 * 停用规则显示“启用后”的影响；已被其他规则覆盖为同一分类时计 0。
 */
function affectedCountIn(state, transactions, merchant) {
  var rule = findRule(state, merchant)
  if (!rule) return 0
  var before = Object.assign(Object.create(null), state.enabled)
  var after = Object.assign(Object.create(null), state.enabled)
  after[merchant] = rule.category
  if (rule.enabled) delete before[merchant]

  var keyword = category.normalize(merchant)
  var count = 0
  transactions.forEach(function (tx) {
    if (!tx || typeof tx !== 'object') return
    /* 用户规则只会在商户/说明包含关键词时命中，先过滤避免反复扫描完整词库。 */
    var text = category.normalize(tx.merchant) + '|' + category.normalize(tx.desc)
    if (!keyword || text.indexOf(keyword) < 0) return
    var oldCat = category.classify(tx.merchant, tx.desc, '', before, tx.type).cat
    var newCat = category.classify(tx.merchant, tx.desc, '', after, tx.type).cat
    if (oldCat !== newCat) count++
  })
  return count
}

function list() {
  var state = loadState()
  var transactions = readTransactions()
  var merchants = Object.keys(state.enabled).concat(Object.keys(state.disabled))
  merchants.sort(function (a, b) { return a.localeCompare(b, 'zh-CN') })
  return merchants.map(function (merchant) {
    var rule = findRule(state, merchant)
    return {
      merchant: merchant,
      category: rule.category,
      enabled: rule.enabled,
      affectedCount: affectedCountIn(state, transactions, merchant)
    }
  })
}

function toggle(merchant, enabled) {
  return mutate(function (state) {
    merchant = validateMerchant(merchant)
    if (typeof enabled !== 'boolean') throw new RuleError('BAD_ENABLED', '启用状态必须是 true 或 false')
    var rule = findRule(state, merchant)
    if (!rule) throw new RuleError('RULE_NOT_FOUND', '没有找到“' + merchant + '”这条规则')
    if (rule.enabled === enabled) return { changed: false, merchant: merchant, enabled: enabled, category: rule.category }
    if (enabled) {
      state.enabled[merchant] = state.disabled[merchant]
      delete state.disabled[merchant]
    } else {
      state.disabled[merchant] = state.enabled[merchant]
      delete state.enabled[merchant]
    }
    return { changed: true, merchant: merchant, enabled: enabled, category: rule.category, nextEnabled: state.enabled, nextDisabled: state.disabled }
  })
}

function remove(merchant) {
  return mutate(function (state) {
    merchant = validateMerchant(merchant)
    var rule = findRule(state, merchant)
    if (!rule) throw new RuleError('RULE_NOT_FOUND', '没有找到“' + merchant + '”这条规则')
    if (rule.enabled) delete state.enabled[merchant]
    else delete state.disabled[merchant]
    return { changed: true, merchant: merchant, enabled: rule.enabled, category: rule.category, nextEnabled: state.enabled, nextDisabled: state.disabled }
  })
}

function clearDisabled() {
  return mutate(function (state) {
    var count = Object.keys(state.disabled).length
    if (!count) return { changed: false, count: count }
    state.disabled = Object.create(null)
    return { changed: true, count: count, nextEnabled: state.enabled, nextDisabled: state.disabled }
  })
}

function preview(text, type) {
  type = validateType(type)
  if (typeof text !== 'string' || !text.trim()) throw new RuleError('BAD_TEXT', '请输入商户名或商品说明')
  if (text.length > 500) throw new RuleError('BAD_TEXT', '预览文本不能超过 500 个字符')
  var state = loadState()
  var result = category.classify('', text, '', state.enabled, type)
  return {
    ok: true,
    category: result.cat,
    cat: result.cat,
    by: result.by,
    keyword: result.kw || ''
  }
}

function affectedCount(merchant) {
  merchant = validateMerchant(merchant)
  var state = loadState()
  return affectedCountIn(state, readTransactions(), merchant)
}

module.exports = {
  KEY_ENABLED: KEY_ENABLED,
  KEY_DISABLED: KEY_DISABLED,
  RuleError: RuleError,
  list: list,
  toggle: toggle,
  remove: remove,
  clearDisabled: clearDisabled,
  preview: preview,
  affectedCount: affectedCount
}
