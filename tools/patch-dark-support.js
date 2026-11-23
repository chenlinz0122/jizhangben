/* 给「没接深色」的页面补上深色支持（幂等，可重复跑）：
   1) js 里加 darkmode 依赖、data 里加 dark 默认值、onShow 里刷新 dark
   2) wxml 根节点加 {{dark ? 'dark' : ''}}
   3) wxss 末尾追加一组深色覆盖
   用法：node tools/patch-dark-support.js */
var fs = require('fs')
var path = require('path')

var root = path.join(__dirname, '..')
var TARGETS = ['add', 'cat', 'feedback', 'import', 'login', 'shot', 'vip']

var DARK_CSS = `

/* ---------- 系统深色 ---------- */
.dark { background: #111916; color: #e5eee9; }
.dark .card { background: #1b2421; border-color: #2c3831; }
.dark .hint, .dark .muted, .dark .tip, .dark .li, .dark .foot, .dark .note, .dark .h2 { color: #9fb0a8; }
.dark .title, .dark .ct, .dark .h1 { color: #e5eee9; }
.dark .ipt, .dark .ta { background: #141b18; border-color: #2c3831; color: #e5eee9; }
.dark .btn.plain { background: #1b2421; border-color: #2c3831; color: #e5eee9; }
.dark .divider { background: #2c3831; }
`

var changed = []

TARGETS.forEach(function (name) {
  var base = path.join(root, 'pages', name, name)

  /* --- js --- */
  var jsFile = base + '.js'
  var js = fs.readFileSync(jsFile, 'utf8')
  var jsDirty = false

  if (js.indexOf('utils/darkmode') < 0) {
    var firstRequire = js.search(/var [A-Za-z_$][\w$]* = require\('\.\.\/\.\.\/utils\//)
    var inject = "var darkmode = require('../../utils/darkmode')\n"
    if (firstRequire >= 0) {
      js = js.slice(0, firstRequire) + inject + js.slice(firstRequire)
    } else {
      js = inject + js
    }
    jsDirty = true
  }

  if (!/\bdark:\s*(false|true)\b/.test(js.split('onLoad')[0])) {
    var dataAt = js.search(/data:\s*\{/)
    if (dataAt >= 0) {
      var braceAt = js.indexOf('{', dataAt)
      js = js.slice(0, braceAt + 1) + '\n    dark: false,' + js.slice(braceAt + 1)
      jsDirty = true
    }
  }

  var onShowAt = js.indexOf('onShow: function')
  if (onShowAt >= 0) {
    var themeLine = "this.setData({ themeKey: theme.get().key })"
    var themeIdx = js.indexOf(themeLine, onShowAt)
    if (themeIdx >= 0 && js.indexOf('darkmode.isDark()', onShowAt) < 0) {
      js = js.slice(0, themeIdx) +
        "this.setData({ themeKey: theme.get().key, dark: darkmode.isDark() })" +
        js.slice(themeIdx + themeLine.length)
      jsDirty = true
    }
  }
  if (jsDirty) { fs.writeFileSync(jsFile, js, 'utf8'); changed.push(name + '.js') }

  /* --- wxml --- */
  var wxmlFile = base + '.wxml'
  var wxml = fs.readFileSync(wxmlFile, 'utf8')
  if (!/dark \? 'dark'/.test(wxml)) {
    var m = wxml.match(/class="(theme-\{\{themeKey\}\} [a-z-]+)"/)
    if (m) {
      wxml = wxml.replace(m[0], 'class="' + m[1] + " {{dark ? 'dark' : ''}}\"")
      fs.writeFileSync(wxmlFile, wxml, 'utf8')
      changed.push(name + '.wxml')
    } else {
      console.log('  ! ' + name + '.wxml 找不到根节点 class，跳过')
    }
  }

  /* --- wxss --- */
  var wxssFile = base + '.wxss'
  var wxss = fs.readFileSync(wxssFile, 'utf8')
  if (!/\.dark\b/.test(wxss)) {
    fs.writeFileSync(wxssFile, wxss.replace(/\s*$/, '') + DARK_CSS, 'utf8')
    changed.push(name + '.wxss')
  }
})

console.log('已改动 ' + changed.length + ' 个文件：' + changed.join('、'))
