/* 批量生成卡密（本地跑，不联网、不碰云数据库）
 *
 *   用法：
 *     node tools/gen-codes.js            默认 50 张 / 365 天
 *     node tools/gen-codes.js 100 365    100 张 / 365 天
 *     node tools/gen-codes.js 20 30      20 张 / 30 天（月卡）
 *
 *   产物：tools/out/codes-<批次>.json
 *   一行一个对象，正好是微信云开发控制台「导入」认的格式：
 *   数据库 → codes → 导入 → 选这个文件 → 字段自动对上 → 开始导入
 *
 *   注意：usedBy 必须是空字符串（不是不写），云函数靠它做「条件更新」抢码。
 */

var fs = require('fs')
var path = require('path')
var core = require('../cloudfunctions/vip/core')

var count = Number(process.argv[2]) || 50
var days = Number(process.argv[3]) || 365

var stamp = new Date()
var batch = 'B' + stamp.getFullYear() +
  ('0' + (stamp.getMonth() + 1)).slice(-2) +
  ('0' + stamp.getDate()).slice(-2) +
  ('0' + stamp.getHours()).slice(-2) +
  ('0' + stamp.getMinutes()).slice(-2) +
  ('0' + stamp.getSeconds()).slice(-2) +
  'D' + days

var list = core.makeCodes(count, days, batch)

var outDir = path.join(__dirname, 'out')
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })

var outFile = path.join(outDir, 'codes-' + batch + '.json')
fs.writeFileSync(outFile, list.map(function (d) { return JSON.stringify(d) }).join('\n') + '\n', 'utf8')

console.log('生成 ' + list.length + ' 张，每张 ' + days + ' 天，批次 ' + batch)
console.log('文件：' + outFile)
console.log('前 3 张：')
list.slice(0, 3).forEach(function (d) { console.log('  ' + d.codeText) })
console.log('导入：云开发控制台 → 数据库 → codes → 导入 → 选上面的文件')
