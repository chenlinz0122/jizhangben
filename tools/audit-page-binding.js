/* 页面完整性自检：
   1) wxml 里绑定的事件方法，js 里是否真的存在（不存在 → 点了没反应）
   2) wxml 里用到的 {{变量}}，js 里是否在 data 初始值或 setData 里出现（不存在 → 显示空白/undefined）
   3) wxml 里用到的 class，wxss 里是否定义（不存在 → 没样式）
   4) 页面四件套文件是否齐（js/json/wxml/wxss）
   用法：node tools/audit-page-binding.js */
var fs = require('fs')
var path = require('path')

var root = path.join(__dirname, '..')
var pagesDir = path.join(root, 'pages')
var problems = []
var checked = 0

function read(p) {
  try { return fs.readFileSync(p, 'utf8') } catch (e) { return null }
}

/* wxml 里的事件绑定：bindtap / bind:tap / catchtap / catch:tap / bindchange ... */
var BIND_RE = /(?:bind|catch|capture-bind|capture-catch)[:\-]?(tap|longtap|longpress|change|input|confirm|blur|focus|submit|reset|load|error|scroll|scrolltolower|scrolltoupper|touchstart|touchmove|touchend|touchcancel|getphonenumber|getuserinfo|opensetting|contact|chooseavatar|play|ended|timeupdate|waiting|progress|loadstart|loadedmetadata)\s*=\s*"([^"]+)"/g

function collectEventHandlers(wxml) {
  var out = {}
  var m
  BIND_RE.lastIndex = 0
  while ((m = BIND_RE.exec(wxml))) {
    var fn = String(m[2] || '').trim()
    if (fn && fn.indexOf('{{') < 0) out[fn] = m[1]
  }
  return out
}

/* {{ }} 里的顶层标识符：a.b.c 只取 a，避免把成员名当变量 */
function collectExpressions(wxml) {
  var out = {}
  var m
  var re = /\{\{([^}]*)\}\}/g
  while ((m = re.exec(wxml))) {
    var expr = m[1]
    /* 去掉字符串字面量，避免把文字里的词当变量 */
    expr = expr.replace(/'[^']*'/g, ' ').replace(/"[^"]*"/g, ' ')
    var idRe = /[A-Za-z_$][A-Za-z0-9_$]*(?:\s*\.\s*[A-Za-z_$][A-Za-z0-9_$]*)*/g
    var im
    while ((im = idRe.exec(expr))) {
      var name = im[0].split('.')[0].trim()
      /* 关键字与局部别名跳过 */
      if (/^(true|false|null|undefined|NaN|typeof|in|item|index)$/.test(name)) continue
      out[name] = 1
    }
  }
  return Object.keys(out)
}

/* wx:for 声明的局部别名（item / index / 自定义） */
function collectLoopAliases(wxml) {
  var alias = { item: 1, index: 1 }
  var m
  var re = /wx:for-(item|index)\s*=\s*"([^"]+)"/g
  while ((m = re.exec(wxml))) alias[String(m[2]).trim()] = 1
  return alias
}

function collectSetDataKeys(js) {
  var keys = {}
  var m
  var re = /setData\s*\(\s*\{([\s\S]{0,4000}?)\}\s*[\),]/g
  while ((m = re.exec(js))) {
    var body = m[1]
    var kRe = /(?:^|[,\{\s])([A-Za-z_$][\w$]*)\s*:/g
    var km
    while ((km = kRe.exec(body))) keys[km[1]] = 1
  }
  return keys
}

function collectDataKeys(js) {
  /* data: { ... } 里的顶层键：按两空格缩进判断 */
  var keys = {}
  var idx = js.indexOf('data:')
  if (idx < 0) return keys
  var seg = js.slice(idx, idx + 5000)
  var m = seg.match(/\n\s*([A-Za-z_$][\w$]*)\s*:/g) || []
  for (var i = 0; i < m.length; i++) {
    var k = m[i].replace(/[\n\s:]/g, '')
    keys[k] = 1
  }
  return keys
}

function collectMethods(js) {
  var out = {}
  var re = /(?:^|\n)\s*([A-Za-z_$][\w$]*)\s*[:=]\s*function\s*\(/g
  var m
  while ((m = re.exec(js))) out[m[1]] = 1
  /* 箭头/简写形式：foo(e) { */
  var re2 = /(?:^|\n)\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g
  while ((m = re2.exec(js))) out[m[1]] = 1
  return out
}

function collectClasses(wxss) {
  var out = {}
  var re = /\.([A-Za-z0-9_-]+)/g
  var m
  while ((m = re.exec(wxss || ''))) out[m[1]] = 1
  return out
}

function collectUsedClasses(wxml) {
  var out = {}
  /* 前面必须是标签/属性分隔符，避免把 hover-class="none" 这类也当成 class 扫进来 */
  var re = /(?:^|[\s"'\/>])class\s*=\s*"([^"]*)"/g
  var m
  while ((m = re.exec(wxml))) {
    var raw = m[1].replace(/\{\{[\s\S]*?\}\}/g, ' ')
    var parts = raw.split(/\s+/)
    for (var i = 0; i < parts.length; i++) {
      var c = parts[i]
      if (!c || c.indexOf('theme-') === 0) continue
      if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(c)) out[c] = 1
    }
  }
  return out
}

var dirs = fs.readdirSync(pagesDir)
/* 全局样式也算定义：app.wxss 里的 .card / .ui-icon 之类各页共用 */
var globalCss = collectClasses(read(path.join(root, 'app.wxss')) || '')
for (var d = 0; d < dirs.length; d++) {
  var name = dirs[d]
  var base = path.join(pagesDir, name, name)
  if (!fs.existsSync(path.join(pagesDir, name, name + '.wxml')) &&
      !fs.existsSync(path.join(pagesDir, name, name + '.js'))) continue
  checked++
  ['js', 'json', 'wxml', 'wxss'].forEach(function (ext) {
    if (!fs.existsSync(base + '.' + ext)) problems.push(name + '：缺 ' + name + '.' + ext)
  })
  var wxml = read(base + '.wxml')
  var js = read(base + '.js')
  var wxss = read(base + '.wxss')
  if (!wxml || !js) continue

  var methods = collectMethods(js)
  var handlers = collectEventHandlers(wxml)
  Object.keys(handlers).forEach(function (fn) {
    if (!methods[fn] && js.indexOf(fn + ':') < 0) {
      problems.push(name + '：wxml 绑定 ' + fn + '（' + handlers[fn] + '）但 js 里没有这个方法')
    }
  })

  var dataKeys = collectDataKeys(js)
  var setKeys = collectSetDataKeys(js)
  var alias = collectLoopAliases(wxml)
  var exprs = collectExpressions(wxml)
  var miss = []
  exprs.forEach(function (k) {
    if (alias[k] || dataKeys[k] || setKeys[k]) return
    if (methods[k]) return
    if (k === 'wx' || k === 'e' || k === 'self') return
    /* js 全文里出现过这个名字（可能是整对象 setData、计算属性、局部变量）就放过 */
    if (new RegExp('\\b' + k + '\\b').test(js)) return
    miss.push(k)
  })
  if (miss.length) problems.push(name + '：wxml 用到但 js 没定义的变量 → ' + miss.join(', '))

  var cssClasses = collectClasses(wxss)
  var used = collectUsedClasses(wxml)
  var noStyle = []
  Object.keys(used).forEach(function (c) {
    if (cssClasses[c] || globalCss[c]) return
    /* 动态拼接的类名前缀（class="dot-{{x}}"）不在这里判定 */
    if (/-$/.test(c)) return
    noStyle.push(c)
  })
  if (noStyle.length) problems.push(name + '：wxml 用到但 wxss 没定义的 class → ' + noStyle.join(', '))
}

if (!problems.length) {
  console.log('页面完整性自检通过：' + checked + ' 个页面，0 处问题')
  process.exit(0)
}
console.log('检查 ' + checked + ' 个页面，发现 ' + problems.length + ' 处问题：')
problems.forEach(function (p, i) { console.log((i + 1) + '. ' + p) })
process.exit(1)
