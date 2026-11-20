// 云函数 vip 的离线自测：用内存假库替换 wx-server-sdk，把邀请 / 兑码全流程跑一遍
// 跑法：node tools/test-vip-mock.js
const Module = require('module')
const path = require('path')

/* ---------------- 内存版云数据库 ---------------- */
function makeDB() {
  const store = {}
  let seq = 0
  const coll = (name) => {
    if (!store[name]) store[name] = []
    return store[name]
  }
  const match = (doc, q) => Object.keys(q).every((k) => doc[k] === q[k])
  const api = {
    createCollection(name) {
      if (store[name]) {
        const e = new Error('collection already exists')
        e.errMsg = 'collection already exists'
        return Promise.reject(e)
      }
      store[name] = []
      return Promise.resolve({})
    },
    collection(name) {
      const rows = coll(name)
      const ctx = { q: null, lim: 0 }
      const q = {
        where(cond) { ctx.q = cond; return q },
        limit(n) { ctx.lim = n; return q },
        get() {
          let list = ctx.q ? rows.filter((d) => match(d, ctx.q)) : rows.slice()
          if (ctx.lim) list = list.slice(0, ctx.lim)
          return Promise.resolve({ data: list.map((d) => Object.assign({}, d)) })
        },
        count() {
          const list = ctx.q ? rows.filter((d) => match(d, ctx.q)) : rows
          return Promise.resolve({ total: list.length })
        },
        add(opts) {
          const doc = Object.assign({ _id: 'id' + ++seq }, opts.data)
          rows.push(doc)
          return Promise.resolve({ _id: doc._id })
        },
        update(opts) {
          const list = ctx.q ? rows.filter((d) => match(d, ctx.q)) : rows
          list.forEach((d) => Object.assign(d, opts.data))
          return Promise.resolve({ stats: { updated: list.length } })
        },
        doc(id) {
          return {
            update(opts) {
              const d = rows.find((x) => x._id === id)
              if (!d) return Promise.resolve({ stats: { updated: 0 } })
              Object.assign(d, opts.data)
              return Promise.resolve({ stats: { updated: 1 } })
            },
            get() {
              return Promise.resolve({ data: rows.find((x) => x._id === id) || null })
            }
          }
        }
      }
      return q
    }
  }
  return { api, store }
}

const fake = {
  DYNAMIC_CURRENT_ENV: 'mock-env',
  init() {},
  database() {
    return db.api
  },
  getWXContext() {
    return { OPENID: fake.currentOpenid }
  }
}
const db = makeDB()

/* ---------------- 拦 require('wx-server-sdk') ---------------- */
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') return fake
  return origLoad.apply(this, arguments)
}

const fn = require(path.join(__dirname, '..', 'cloudfunctions', 'vip', 'index.js'))

/* ---------------- 断言小工具 ---------------- */
let pass = 0
const fails = []
function check(name, cond, extra) {
  if (cond) { pass++ } else { fails.push(name + (extra ? ' → ' + JSON.stringify(extra) : '')) }
}
async function call(openid, event) {
  fake.currentOpenid = openid
  return await fn.main(Object.assign({ action: 'status' }, event || {}))
}
const DAY = 86400000
const near = (ts, days) => Math.abs(ts - (Date.now() + days * DAY)) < 60000

;(async () => {
  /* 1. 首跑自建：建集合 + 灌 70 张码 */
  const init = await call('A', { action: 'initdb' })
  check('initdb ok', init && init.ok === true, init)
  check('codes 灌了 70 张', (db.store.codes || []).length === 70, { n: (db.store.codes || []).length })
  check('invites/invite_logs 已建', Array.isArray(db.store.invites) && Array.isArray(db.store.invite_logs))

  /* 2. 老功能没被改坏：兑一张真码 */
  const r1 = await call('X', { action: 'redeem', code: 'ZBH8-5BKZ-DECS-474V' })
  check('兑码成功', r1 && r1.ok === true && r1.isVip === true, r1)
  check('365 天到期日正确', near(r1.expireAt, 365), { expireAt: r1.expireAt })
  const r2 = await call('X', { action: 'redeem', code: 'ZBH8-5BKZ-DECS-474V' })
  check('同码二次兑 = 不重复加天', r2 && r2.already === true && r2.daysLeft === 365, r2)
  const r3 = await call('Y', { action: 'redeem', code: 'ZBH8-5BKZ-DECS-474V' })
  check('别人再用这张码 → USED', r3 && r3.code === 'USED', r3)
  const r4 = await call('X', { action: 'redeem', code: '1234' })
  check('格式不对 → BAD_FORMAT', r4 && r4.code === 'BAD_FORMAT', r4)

  /* 3. 邀请码：取两次是一样的 */
  const i1 = await call('A', { action: 'invite' })
  check('拿到邀请码', i1 && i1.ok === true && /^[2-9A-Z]{16}$/.test(i1.code), i1)
  check('拆成四段展示', i1.codeText === i1.code.replace(/(.{4})(?=.)/g, '$1-'), { t: i1.codeText })
  const i2 = await call('A', { action: 'invite' })
  check('同一个人的邀请码固定', i2.code === i1.code, { a: i1.code, b: i2.code })
  check('邀请初始计数为 0', i2.invited === 0 && i2.rewarded === 0 && i2.maxReward === 5, i2)

  /* 4. 被邀请：双方各 +7 天 */
  const a1 = await call('B', { action: 'accept', code: i1.codeText })
  check('被邀请人 +7 天', a1 && a1.ok === true && a1.days === 7 && near(a1.expireAt, 7), a1)
  check('邀请人本次也 +7', a1.inviterRewarded === true, a1)
  const memberA = (db.store.members || []).find((m) => m.openid === 'A')
  check('邀请人 A 现在也是会员', memberA && memberA.expireAt > Date.now(), memberA)
  const stB = await call('B', { action: 'status' })
  check('B 的会员状态生效', stB.isVip === true && stB.daysLeft === 7, stB)

  /* 5. 各种拒绝分支 */
  const a2 = await call('B', { action: 'accept', code: i1.code })
  check('同一人被邀两次 → ALREADY_INVITED', a2 && a2.code === 'ALREADY_INVITED', a2)
  const a3 = await call('A', { action: 'accept', code: i1.code })
  check('邀请自己 → SELF_INVITE', a3 && a3.code === 'SELF_INVITE', a3)
  const a4 = await call('C', { action: 'accept', code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ' })
  check('不存在的邀请码 → BAD_CODE', a4 && a4.code === 'BAD_CODE', a4)
  const a5 = await call('C', { action: 'accept', code: 'abc' })
  check('邀请码格式不对 → BAD_FORMAT', a5 && a5.code === 'BAD_FORMAT', a5)

  /* 6. 邀请人上限 5 次：第 6 个人进来只给被邀请人，不再给 A */
  for (let i = 0; i < 5; i++) {
    await call('F' + i, { action: 'accept', code: i1.code })
  }
  const i3 = await call('A', { action: 'invite' })
  check('A 已邀 6 人', i3.invited === 6, i3)
  check('A 只拿到 5 次奖励', i3.rewarded === 5, i3)
  const lastLog = (db.store.invite_logs || []).slice(-1)[0]
  check('第 6 次的日志 rewarded=false', lastLog && lastLog.rewarded === false, lastLog)
  const memberA2 = (db.store.members || []).find((m) => m.openid === 'A')
  check('A 的天数 = 5×7 = 35（不含其它来源）', near(memberA2.expireAt, 35), { expireAt: memberA2.expireAt })

  /* 结果 */
  console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项')
  if (fails.length) {
    fails.forEach((f) => console.log('  ✗ ' + f))
    process.exit(1)
  }
})()
