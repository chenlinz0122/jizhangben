const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.join(__dirname, '..')
const requested = process.argv.slice(2)
const known = new Set(requested)
const unavailable = requested.filter((name) => !fs.existsSync(path.join(__dirname, name)))
if (unavailable.length) {
  console.error('未知测试脚本：' + unavailable.join(', '))
  process.exit(1)
}
const scripts = fs.readdirSync(__dirname)
  .filter((name) => /^test-.*\.js$/.test(name) && name !== 'test-all.js')
  .filter((name) => !known.size || known.has(name))
  .sort()

let failed = 0
for (const script of scripts) {
  const started = Date.now()
  // 每个脚本独立进程，避免全局 wx、Date 和 require 缓存互相污染。
  const result = spawnSync(process.execPath, [path.join(__dirname, script)], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024
  })
  const elapsed = Date.now() - started
  if (result.status === 0 && !result.error) {
    console.log('PASS ' + script + ' (' + elapsed + 'ms)')
    continue
  }
  failed++
  console.error('FAIL ' + script + ' (' + elapsed + 'ms)')
  if (result.error) console.error(result.error.message)
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
}

console.log('\n' + (scripts.length - failed) + '/' + scripts.length + ' 个测试脚本通过')
if (!scripts.length || failed) process.exitCode = 1
