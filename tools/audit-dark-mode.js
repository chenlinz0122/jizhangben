/* 暗色模式体检：哪些页面在系统切到深色时还是白底白字。
   规则来源：wxml 根节点带 {{dark ? 'dark' : ''}} 的页面，必须有对应的 .dark 覆盖；
   wxss 里直接写死的浅色底（#fff / #ffffff / #f4f6f5 之类）在暗色下会刺眼。
   用法：node tools/audit-dark-mode.js */
var fs = require('fs')
var path = require('path')

var root = path.join(__dirname, '..')
var pagesDir = path.join(root, 'pages')
var problems = []

function read(p) { try { return fs.readFileSync(p, 'utf8') } catch (e) { return '' } }

var LIGHT_BG = /background(?:-color)?\s*:\s*(#fff(?:fff)?|#f[0-9a-f]{2,5}|rgba?\(\s*2[0-9]{2)/gi

var dirs = fs.readdirSync(pagesDir)
var report = []
for (var d = 0; d < dirs.length; d++) {
  var name = dirs[d]
  var base = path.join(pagesDir, name, name)
  var wxml = read(base + '.wxml'), wxss = read(base + '.wxss')
  if (!wxml && !wxss) continue

  var hasDarkClass = /class=("|\')[^"']*dark/.test(wxml) || /dark\s*['"]/.test(wxml)
  var darkRules = (wxss.match(/\.dark/g) || []).length
  var lightCount = (wxss.match(LIGHT_BG) || []).length

  report.push({ name: name, darkClass: hasDarkClass, darkRules: darkRules, lightBg: lightCount })

  if (hasDarkClass && darkRules === 0) {
    problems.push(name + '：wxml 里切换了 dark，但 wxss 没有任何 .dark 覆盖 → 深色系统下整页仍是浅色')
  }
  if (hasDarkClass && darkRules > 0 && lightCount > darkRules * 4) {
    problems.push(name + '：写死的浅色底 ' + lightCount + ' 处，只有 ' + darkRules + ' 条 .dark 覆盖，深色下大概率有白块')
  }
  if (!hasDarkClass && lightCount > 0) {
    problems.push(name + '：不支持深色（wxml 没带 dark），但有 ' + lightCount + ' 处写死浅色底，系统深色时是浅色页')
  }
}

console.log('页面暗色支持情况：')
report.forEach(function (r) {
  console.log('  ' + r.name.padEnd(10) + ' dark类:' + (r.darkClass ? '有' : '无') +
    '  .dark规则:' + r.darkRules + '  写死浅色底:' + r.lightBg)
})
console.log('')
if (!problems.length) {
  console.log('暗色体检通过，0 处问题')
  process.exit(0)
}
console.log('发现 ' + problems.length + ' 处问题：')
problems.forEach(function (p, i) { console.log((i + 1) + '. ' + p) })
process.exit(1)
