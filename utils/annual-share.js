/* 年度分享卡：旧版 CanvasContext 兼容。金额始终按整数分格式化。
 * render(ctx, result, options) 只入队绘制，不调用 ctx.draw()。
 * options.generatedAt 可为 Date、时间戳或日期字符串；options.scopeText 可覆盖口径。
 * options.theme/title/subtitle/showTopCategories/showHealth/showGeneratedAt/accentColor 可自定义模板。
 * 返回 { width, height, texts }，texts 是实际绘制的文字，便于离线校验。
 */
var WIDTH = 750
var HEIGHT = 1000
var MAX_CENTS = 9007199254740991
var PREFS_STORAGE_KEY = 'annual_share_prefs_v1'
var THEMES = {
  paper: {
    background: '#f3f0e8', ink: '#173b32', muted: '#6e7f77', line: '#d9dfd8',
    card: '#fffdf8', brand: '#16705c', soft: '#e4efe8', positive: '#15704f',
    negative: '#b64a3e', bar: '#dce7e0', decorative: '#16705c'
  },
  forest: {
    background: '#102d26', ink: '#f1f5e9', muted: '#aec2b6', line: '#365449',
    card: '#1b4035', brand: '#8ed5ae', soft: '#294c3e', positive: '#a9e5bd',
    negative: '#ffb0a2', bar: '#2a4c3f', decorative: '#8ed5ae'
  },
  night: {
    background: '#151c2d', ink: '#eef2ff', muted: '#aab5cc', line: '#39445e',
    card: '#222c43', brand: '#a9c4ff', soft: '#2c3955', positive: '#a9e1be',
    negative: '#ffb0ad', bar: '#35415e', decorative: '#a9c4ff'
  }
}
var DEFAULT_OPTIONS = {
  theme: 'paper',
  title: '',
  subtitle: '',
  showTopCategories: true,
  showHealth: true,
  showGeneratedAt: true,
  accentColor: ''
}

function pad(value) {
  return value < 10 ? '0' + value : String(value)
}

function cleanText(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function centsOf(value) {
  var number = Number(value)
  if (!isFinite(number) || typeof value === 'boolean') return 0
  return Math.min(MAX_CENTS, Math.max(-MAX_CENTS, Math.round(number))) || 0
}

function formatMoney(value) {
  var cents = centsOf(value)
  var digits = String(Math.abs(cents))
  var fraction = digits.length < 2 ? '0' + digits : digits.slice(-2)
  var integer = (digits.length > 2 ? digits.slice(0, -2) : '0')
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return '¥' + (cents < 0 ? '-' : '') + integer + '.' + fraction
}

function ratioOf(value) {
  var number = Number(value)
  return value === null || value === undefined || value === '' || !isFinite(number) ? null : number
}

function formatRate(value) {
  var ratio = ratioOf(value)
  if (ratio === null) return '--'
  if (Math.abs(ratio) >= 10000) return (ratio < 0 ? '-' : '') + '>=10000%'
  return (Math.round(ratio * 1000) / 10).toFixed(1) + '%'
}

function formatDate(value) {
  var date = value instanceof Date ? value : new Date(value === undefined || value === null || value === '' ? Date.now() : value)
  if (!isFinite(date.getTime())) date = new Date()
  return date.getFullYear() + '.' + pad(date.getMonth() + 1) + '.' + pad(date.getDate())
}

function isEmpty(result) {
  return !result || result.hasData === false || !(result.totals && typeof result.totals === 'object')
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function fontSizeOf(ctx) {
  var match = /(\d+(?:\.\d+)?)px/.exec(String(ctx._shareFontSize || 22))
  return match ? Number(match[1]) : 22
}

function setFont(ctx, size, weight) {
  ctx._shareFontSize = size
  if (typeof ctx.setFontSize === 'function') ctx.setFontSize(size)
  if (typeof ctx.setFont === 'function') ctx.setFont((weight || '') + ' ' + size + 'px sans-serif')
}

function codePoints(text) {
  var out = []
  var index = 0
  while (index < text.length) {
    var code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      var next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        out.push(text.slice(index, index + 2))
        index += 2
        continue
      }
    }
    out.push(text.charAt(index))
    index++
  }
  return out
}

function widthOf(ctx, text) {
  if (typeof ctx.measureText === 'function') {
    var measured = Number(ctx.measureText(String(text)).width)
    if (isFinite(measured) && measured >= 0) return measured
  }
  var size = fontSizeOf(ctx)
  var units = 0
  codePoints(String(text)).forEach(function (char) {
    var code = char.charCodeAt(0)
    units += code > 255 ? 1 : (/\s/.test(char) ? 0.35 : 0.62)
  })
  return units * size
}

function ellipsis() {
  return '…'
}

function truncateText(ctx, text, maxWidth) {
  var source = cleanText(text) || '--'
  if (widthOf(ctx, source) <= maxWidth) return source
  var chars = codePoints(source)
  if (!chars.length || maxWidth <= widthOf(ctx, ellipsis())) return ''
  var low = 0
  var high = chars.length
  while (low < high) {
    var middle = Math.ceil((low + high) / 2)
    if (widthOf(ctx, chars.slice(0, middle).join('') + ellipsis()) <= maxWidth) low = middle
    else high = middle - 1
  }
  return chars.slice(0, low).join('') + ellipsis()
}

function wrapText(ctx, text, maxWidth, maxLines) {
  var source = cleanText(text)
  if (!source) return []
  var paragraphs = ['']
  codePoints(source).forEach(function (char) {
    var index = paragraphs.length - 1
    if (paragraphs[index] && widthOf(ctx, paragraphs[index] + char) > maxWidth) paragraphs.push(char)
    else paragraphs[index] += char
  })
  var limit = Math.max(1, Math.floor(maxLines || 1))
  if (paragraphs.length > limit) {
    paragraphs = paragraphs.slice(0, limit)
    paragraphs[limit - 1] = truncateText(ctx, paragraphs[limit - 1], maxWidth)
  }
  return paragraphs
}

function text(ctx, value, x, y, size, color, options) {
  options = options || {}
  setFont(ctx, size, options.weight || '')
  if (typeof ctx.setTextAlign === 'function') ctx.setTextAlign(options.align || 'left')
  if (typeof ctx.setTextBaseline === 'function') ctx.setTextBaseline('alphabetic')
  if (typeof ctx.setFillStyle === 'function') ctx.setFillStyle(color)
  var output = truncateText(ctx, value, options.maxWidth === undefined ? WIDTH - x - 24 : options.maxWidth)
  if (typeof ctx.fillText === 'function') ctx.fillText(output, x, y)
  return output
}

function fittedText(ctx, value, x, y, maxWidth, size, color, options) {
  options = options || {}
  var minSize = options.minSize || 18
  var current = size
  setFont(ctx, current, options.weight || '')
  while (current > minSize && widthOf(ctx, cleanText(value)) > maxWidth) {
    current = Math.max(minSize, current - 1)
    setFont(ctx, current, options.weight || '')
  }
  return text(ctx, value, x, y, current, color, Object.assign({}, options, { maxWidth: maxWidth }))
}

function fillRect(ctx, x, y, width, height, color, radius) {
  if (typeof ctx.setFillStyle === 'function') ctx.setFillStyle(color)
  if (!radius || typeof ctx.beginPath !== 'function' || typeof ctx.arc !== 'function') {
    if (typeof ctx.fillRect === 'function') ctx.fillRect(x, y, width, height)
    return
  }
  var r = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + width - r, y)
  ctx.arc(x + width - r, y + r, r, -Math.PI / 2, 0)
  ctx.lineTo(x + width, y + height - r)
  ctx.arc(x + width - r, y + height - r, r, 0, Math.PI / 2)
  ctx.lineTo(x + r, y + height)
  ctx.arc(x + r, y + height - r, r, Math.PI / 2, Math.PI)
  ctx.lineTo(x, y + r)
  ctx.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5)
  ctx.closePath()
  if (typeof ctx.fill === 'function') ctx.fill()
}

function line(ctx, x1, y1, x2, y2, color, width) {
  if (typeof ctx.setStrokeStyle === 'function') ctx.setStrokeStyle(color)
  if (typeof ctx.setLineWidth === 'function') ctx.setLineWidth(width || 1)
  if (typeof ctx.beginPath !== 'function') return
  ctx.beginPath()
  if (typeof ctx.moveTo === 'function') ctx.moveTo(x1, y1)
  if (typeof ctx.lineTo === 'function') ctx.lineTo(x2, y2)
  if (typeof ctx.stroke === 'function') ctx.stroke()
}

function circle(ctx, x, y, radius, color) {
  fillRect(ctx, x - radius, y - radius, radius * 2, radius * 2, color, radius)
}

function isValidHex(value) {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(value || ''))
}

function safeColor(value, fallback) {
  return isValidHex(value) ? String(value).toLowerCase() : fallback
}

function preference(input) {
  return input && typeof input === 'object' && !Array.isArray(input) ? input : {}
}

function booleanOption(input, key, fallback) {
  return input[key] === undefined ? fallback : input[key] === true
}

// 模板与本地偏好共用：非法主题、颜色、类型都逐项回退，不拒绝整份旧数据。
function normalizeOptions(input) {
  var source = preference(input)
  var themeKey = Object.prototype.hasOwnProperty.call(THEMES, source.theme) ? source.theme : DEFAULT_OPTIONS.theme
  var palette = Object.assign({}, THEMES[themeKey])
  var accentColor = safeColor(source.accentColor, '')
  if (accentColor) {
    palette.brand = accentColor
    palette.decorative = accentColor
  }
  return {
    theme: themeKey,
    palette: palette,
    title: cleanText(source.title) || (cleanText(source.year) ? cleanText(source.year) + ' 年度财务报告' : new Date().getFullYear() + ' 年度财务报告'),
    subtitle: cleanText(source.subtitle) || source.scopeText || '已记录流水',
    showTopCategories: booleanOption(source, 'showTopCategories', DEFAULT_OPTIONS.showTopCategories),
    showHealth: booleanOption(source, 'showHealth', DEFAULT_OPTIONS.showHealth),
    showGeneratedAt: booleanOption(source, 'showGeneratedAt', DEFAULT_OPTIONS.showGeneratedAt),
    accentColor: accentColor
  }
}

function defaultOptions() {
  return normalizeOptions(DEFAULT_OPTIONS)
}

function loadPreferences(storage) {
  var saved = {}
  try {
    if (storage && typeof storage.getStorageSync === 'function') {
      saved = preference(storage.getStorageSync(PREFS_STORAGE_KEY))
    }
  } catch (err) { saved = {} }
  var options = normalizeOptions(saved)
  return {
    theme: options.theme,
    title: typeof saved.title === 'string' ? cleanText(saved.title) : '',
    subtitle: typeof saved.subtitle === 'string' ? cleanText(saved.subtitle) : '',
    showTopCategories: saved.showTopCategories === undefined ? DEFAULT_OPTIONS.showTopCategories : saved.showTopCategories === true,
    showHealth: saved.showHealth === undefined ? DEFAULT_OPTIONS.showHealth : saved.showHealth === true,
    showGeneratedAt: saved.showGeneratedAt === undefined ? DEFAULT_OPTIONS.showGeneratedAt : saved.showGeneratedAt === true,
    accentColor: options.accentColor
  }
}

function savePreferences(input, storage) {
  var source = preference(input)
  var options = normalizeOptions(source)
  var value = {
    theme: options.theme,
    title: typeof source.title === 'string' ? cleanText(source.title) : '',
    subtitle: typeof source.subtitle === 'string' ? cleanText(source.subtitle) : '',
    showTopCategories: booleanOption(source, 'showTopCategories', DEFAULT_OPTIONS.showTopCategories),
    showHealth: booleanOption(source, 'showHealth', DEFAULT_OPTIONS.showHealth),
    showGeneratedAt: booleanOption(source, 'showGeneratedAt', DEFAULT_OPTIONS.showGeneratedAt),
    accentColor: options.accentColor
  }
  var saved = false
  try {
    if (!storage || typeof storage.setStorageSync !== 'function') throw new Error('Storage unavailable')
    storage.setStorageSync(PREFS_STORAGE_KEY, clone(value))
    saved = true
  } catch (err) { saved = false }
  return { value: value, saved: saved }
}

function numberOrZero(value) {
  var number = Number(value)
  return isFinite(number) ? number : 0
}

function render(ctx, result, options) {
  if (!ctx || typeof ctx.fillText !== 'function') throw new Error('Canvas context unavailable')
  result = result && typeof result === 'object' ? result : {}
  options = options && typeof options === 'object' ? options : {}
  var config = normalizeOptions(Object.assign({}, options, {
    year: result.year,
    scopeText: options.scopeText || result.scopeText
  }))
  var palette = config.palette
  var totals = result.totals && typeof result.totals === 'object' ? result.totals : {}
  var health = result.health && typeof result.health === 'object' ? result.health : {}
  var categories = Array.isArray(result.topCategories) ? result.topCategories : []
  var drawn = []
  function write(value, x, y, size, color, settings) {
    var output = text(ctx, value, x, y, size, color, settings)
    drawn.push(output)
    return output
  }
  function fit(value, x, y, width, size, color, settings) {
    var output = fittedText(ctx, value, x, y, width, size, color, settings)
    drawn.push(output)
    return output
  }

  fillRect(ctx, 0, 0, WIDTH, HEIGHT, palette.background)
  circle(ctx, 70, 68, 14, palette.decorative)
  fillRect(ctx, 65, 63, 4, 10, palette.background)
  fillRect(ctx, 71, 63, 4, 10, palette.background)
  write('ANNUAL REVIEW', 98, 76, 20, palette.brand, { weight: 'bold', maxWidth: 300 })
  fit(config.title, 56, 151, 638, 53, palette.ink, { weight: 'bold', minSize: 28 })
  write(config.subtitle, 56, 194, 22, palette.muted, { maxWidth: 638 })
  line(ctx, 56, 222, 694, 222, palette.line, 1)

  write(isEmpty(result) ? '全年收支结余 · 暂无流水' : '全年收支结余', 56, 266, 24, palette.muted, { maxWidth: 638 })
  fit(formatMoney(totals.balanceCents), 56, 326, 638, 60, centsOf(totals.balanceCents) < 0 ? palette.negative : palette.ink, { weight: 'bold', minSize: 24 })

  var stats = [
    { label: '收入', value: formatMoney(totals.incomeCents) },
    { label: '净支出', value: formatMoney(totals.netExpenseCents) },
    { label: '退款', value: formatMoney(totals.refundCents) },
    { label: '年度储蓄率', value: formatRate(totals.savingsRate) }
  ]
  stats.forEach(function (item, index) {
    var x = 56 + (index % 2) * 325
    var y = 348 + Math.floor(index / 2) * 106
    fillRect(ctx, x, y, 313, 94, palette.card, 18)
    write(item.label, x + 20, y + 30, 21, palette.muted, { maxWidth: 273 })
    fit(item.value, x + 20, y + 70, 273, 30, item.label === '年度储蓄率' ? palette.brand : palette.ink, { weight: 'bold', minSize: 15 })
  })

  if (config.showTopCategories) {
    write('TOP 3 支出分类', 56, 604, 27, palette.ink, { weight: 'bold', maxWidth: 320 })
    write('按支出发生额', 694, 604, 19, palette.muted, { align: 'right', maxWidth: 220 })
    if (!categories.length) {
      write('暂无支出分类', 100, 657, 24, palette.muted, { maxWidth: 594 })
    } else {
      categories.slice(0, 3).forEach(function (item, index) {
        var y = 638 + index * 59
        circle(ctx, 72, y - 8, 16, index === 0 ? palette.brand : palette.soft)
        write(String(index + 1), 72, y, 20, index === 0 ? palette.background : palette.brand, { align: 'center', weight: 'bold', maxWidth: 26 })
        write(item && item.name, 100, y, 24, palette.ink, { weight: 'bold', maxWidth: 350 })
        fit(formatMoney(item && item.expenseCents), 694, y, 240, 24, palette.ink, { align: 'right', minSize: 15 })
        fillRect(ctx, 100, y + 16, 430, 7, palette.bar, 4)
        var pct = ratioOf(item && item.pct)
        if (pct === null && numberOrZero(totals.expenseCents) > 0) pct = centsOf(item && item.expenseCents) / totals.expenseCents * 100
        var width = Math.min(430, Math.max(0, numberOrZero(pct) / 100 * 430))
        if (width > 0) fillRect(ctx, 100, y + 16, width, 7, safeColor(item && item.color, palette.brand), 4)
        write(formatRate(pct === null ? null : pct / 100), 694, y + 25, 18, palette.muted, { align: 'right', maxWidth: 160 })
      })
    }
  }

  if (config.showHealth) {
    fillRect(ctx, 56, 810, 638, 128, palette.soft, 20)
    write('年度健康概览', 80, 846, 25, palette.ink, { weight: 'bold', maxWidth: 300 })
    write('有收入月均储蓄率', 80, 877, 18, palette.muted, { maxWidth: 230 })
    fit(formatRate(health.averageSavingsRate), 80, 915, 220, 34, palette.brand, { weight: 'bold', minSize: 18 })
    write('有收入 ' + numberOrZero(health.incomeMonths) + '/12 月 · 预算覆盖 ' + numberOrZero(health.budgetMonths) + '/12 月', 330, 877, 19, palette.ink, { maxWidth: 340 })
    var issue = cleanText(health.issueSummaryText || '0 项问题 · 涉及 0 笔')
    setFont(ctx, 18, '')
    var issueLines = wrapText(ctx, '数据体检 ' + issue + ' · 覆盖 ' + numberOrZero(health.scanMonths) + '/12 月', 340, 2)
    issueLines.forEach(function (value, index) {
      var output = text(ctx, value, 330, 906 + index * 23, 18, palette.muted, { maxWidth: 340 })
      drawn.push(output)
    })
  }

  write('仅反映已记录数据；金额按分计算，退款按发生月抵减。', 56, 965, 18, palette.muted, { maxWidth: 638 })
  if (config.showGeneratedAt) write('生成于 ' + formatDate(options.generatedAt), 56, 994, 18, palette.muted, { maxWidth: 638 })
  return { width: WIDTH, height: HEIGHT, texts: drawn }
}

function shareToFriends(imageUrl, callbacks) {
  callbacks = callbacks || {}
  function failed(error) {
    if (typeof callbacks.fail === 'function') callbacks.fail(error)
    return false
  }
  if (!imageUrl || typeof imageUrl !== 'string') {
    return failed({
      code: 'INVALID_IMAGE_URL',
      errMsg: 'shareImageMessage:fail invalid imageUrl',
      message: '分享图片不存在，请先生成分享图。'
    })
  }
  if (typeof wx === 'undefined' || typeof wx.shareImageMessage !== 'function') {
    return failed({
      code: 'UNSUPPORTED',
      errMsg: 'shareImageMessage:fail unsupported',
      message: '当前微信版本不支持直接分享图片，请改用保存到相册。'
    })
  }
  try {
    var request = { imageUrl: imageUrl }
    if (typeof callbacks.success === 'function') request.success = callbacks.success
    if (typeof callbacks.fail === 'function') request.fail = callbacks.fail
    if (typeof callbacks.complete === 'function') request.complete = callbacks.complete
    wx.shareImageMessage(request)
    return true
  } catch (err) {
    return failed(err || { errMsg: 'shareImageMessage:fail' })
  }
}

module.exports = {
  WIDTH: WIDTH,
  HEIGHT: HEIGHT,
  PREFS_STORAGE_KEY: PREFS_STORAGE_KEY,
  THEMES: THEMES,
  DEFAULT_OPTIONS: DEFAULT_OPTIONS,
  normalizeOptions: normalizeOptions,
  defaultOptions: defaultOptions,
  loadPreferences: loadPreferences,
  savePreferences: savePreferences,
  render: render,
  isEmpty: isEmpty,
  formatMoney: formatMoney,
  formatRate: formatRate,
  formatDate: formatDate,
  truncateText: truncateText,
  wrapText: wrapText,
  shareToFriends: shareToFriends
}
