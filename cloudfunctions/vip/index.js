// 云函数：会员卡密（状态查询 + 兑换）
//
// 两个 action：
//   status  → 查当前 openid 的会员到期日
//   redeem  → 核销一张卡密，成功后返回新的到期日
//
// ── 需要先建两个集合（云开发控制台 → 数据库）──
//   codes    卡密台账。权限设「仅管理端可读写」，小程序端不可读写
//            文档结构：{ code, codeText, days, usedBy:'', usedAt:0, batch, createdAt }
//   members  会员台账。同样「仅管理端可读写」
//            文档结构：{ openid, expireAt, code, updatedAt }
//
// ── 防重复兑换 ──
// 用「条件更新」：只有 usedBy 为空的那一次才会成功（updated === 1），
// 并发提交、断网重试都不会把一张码兑两次。
const cloud = require('wx-server-sdk')
const core = require('./core')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const CODES = 'codes'
const MEMBERS = 'members'
const FEEDBACKS = 'feedbacks'
const INVITES = 'invites'
const INVITE_LOGS = 'invite_logs'

/* 邀请口径：双方各 +7 天，邀请人最多领 5 次 */
const INVITE_DAYS = 7
const INVITE_MAX = 5

/* 首跑自建：集合不存在时，第一次调用会自动把 codes / members / feedbacks 建好，
   并把内置的 70 张卡密灌进 codes（已存在同号卡密就跳过，重复跑也不会重复灌） */
const SEED_CODES = require('./codes.json')

function ok(data) {
  return Object.assign({ ok: true }, data || {})
}

function bad(errCode, msg) {
  return { ok: false, code: errCode, msg: msg }
}

async function getMember(openid) {
  const snap = await db.collection(MEMBERS).where({ openid }).limit(1).get()
  return (snap.data && snap.data[0]) || null
}

function statusPayload(member) {
  const now = Date.now()
  const expireAt = (member && member.expireAt) || 0
  const isVip = expireAt > now
  return {
    expireAt: expireAt,
    isVip: isVip,
    daysLeft: core.daysLeft(now, expireAt),
    lastCode: (member && member.code) || ''
  }
}

let booted = false

async function ensureCollection(name) {
  try {
    await db.createCollection(name)
    return 'created'
  } catch (e) {
    const msg = String((e && e.errMsg) || (e && e.message) || e || '')
    if (/already exist|-501001|duplicate/i.test(msg)) return 'exists'
    return 'skip'
  }
}

async function seedCodes() {
  const snap = await db.collection(CODES).count()
  const total = (snap && snap.total) || 0
  if (total > 0) return { seeded: 0, existing: total }

  let seeded = 0
  for (let i = 0; i < SEED_CODES.length; i += 10) {
    const chunk = SEED_CODES.slice(i, i + 10)
    for (const doc of chunk) {
      const dup = await db.collection(CODES).where({ code: doc.code }).limit(1).get()
      if (dup.data && dup.data.length) continue
      await db.collection(CODES).add({
        data: {
          code: doc.code,
          codeText: doc.codeText,
          days: doc.days,
          usedBy: '',
          usedAt: 0,
          batch: doc.batch,
          createdAt: doc.createdAt
        }
      })
      seeded++
    }
  }
  return { seeded: seeded, existing: total }
}

async function bootstrap() {
  if (booted) return { skip: true }
  const r1 = await ensureCollection(CODES)
  const r2 = await ensureCollection(MEMBERS)
  const r3 = await ensureCollection(FEEDBACKS)
  const r5 = await ensureCollection(INVITES)
  const r6 = await ensureCollection(INVITE_LOGS)
  const r4 = await seedCodes()
  booted = true
  return { codes: r1, members: r2, feedbacks: r3, invites: r5, inviteLogs: r6, seed: r4 }
}

function isNoCollection(msg) {
  return /collection not exists|database collection not exists|-502005/i.test(msg)
}

async function status(openid) {
  const member = await getMember(openid)
  /* 顺手把 openid 带回去：小程序端要拿它做「登录身份」，省一个云函数 */
  return ok(Object.assign(statusPayload(member), { openid }))
}

async function redeem(openid, rawCode) {
  const code = core.normalize(rawCode)
  if (!core.isRightShape(code)) {
    return bad('BAD_FORMAT', '卡密格式不对，应该是 XXXX-XXXX-XXXX-XXXX')
  }

  const snap = await db.collection(CODES).where({ code: code }).limit(1).get()
  if (!snap.data || !snap.data.length) {
    return bad('NOT_FOUND', '这张卡密不存在，检查一下有没有输错')
  }
  const doc = snap.data[0]

  /* 已经被别人用掉 */
  if (doc.usedBy && doc.usedBy !== openid) {
    return bad('USED', '这张卡密已经被用过了')
  }

  /* 同一张码再提交一次（网络重试）→ 直接返回现状，不重复加天数 */
  if (doc.usedBy === openid) {
    const member = await getMember(openid)
    return ok(Object.assign(statusPayload(member), { already: true }))
  }

  /* 抢码：只有 usedBy 还是空串的这一次能写进去 */
  const claim = await db.collection(CODES)
    .where({ code: code, usedBy: '' })
    .update({ data: { usedBy: openid, usedAt: Date.now() } })

  if (!claim.stats || claim.stats.updated !== 1) {
    const again = await db.collection(CODES).where({ code: code }).limit(1).get()
    const cur = (again.data && again.data[0]) || {}
    if (cur.usedBy && cur.usedBy !== openid) return bad('USED', '这张卡密已经被用过了')
    /* 抢码失败但码又没被别人占：只可能是导入时漏了 usedBy 字段（缺字段匹配不上条件） */
    if (!cur.usedBy) {
      return bad('CODE_BAD_DATA', '这张卡密数据不完整（缺 usedBy 字段），在数据库里补成空字符串后再兑')
    }
  }

  const days = Number(doc.days) || 365
  const member = await getMember(openid)
  const expireAt = core.calcExpire(Date.now(), member && member.expireAt, days)

  try {
    if (member && member._id) {
      await db.collection(MEMBERS).doc(member._id).update({
        data: { expireAt: expireAt, code: code, updatedAt: Date.now() }
      })
    } else {
      await db.collection(MEMBERS).add({
        data: { openid: openid, expireAt: expireAt, code: code, updatedAt: Date.now() }
      })
    }
  } catch (e) {
    /* 写会员失败就把码退回去，别让用户花钱买一张作废的卡 */
    await db.collection(CODES).where({ code: code, usedBy: openid })
      .update({ data: { usedBy: '', usedAt: 0 } })
    throw e
  }

  return ok({ expireAt: expireAt, isVip: true, daysLeft: core.daysLeft(Date.now(), expireAt), days: days, openid: openid })
}

/* ---------- 邀请好友：双方各 +7 天 ---------- */

/* 给某个 openid 加天数（没开通就直接开），返回新的到期日 */
async function grantDays(openid, days) {
  const member = await getMember(openid)
  const expireAt = core.calcExpire(Date.now(), member && member.expireAt, days)
  if (member && member._id) {
    await db.collection(MEMBERS).doc(member._id).update({
      data: { expireAt: expireAt, updatedAt: Date.now() }
    })
  } else {
    await db.collection(MEMBERS).add({
      data: { openid: openid, expireAt: expireAt, code: 'invite', updatedAt: Date.now() }
    })
  }
  return expireAt
}

/* 取/建自己的邀请码 */
async function invite(openid) {
  const mine = await db.collection(INVITES).where({ openid: openid }).limit(1).get()
  let doc = mine.data && mine.data[0]

  if (!doc) {
    let created = null
    for (let i = 0; i < 5 && !created; i++) {
      const code = core.randomCode()
      const dup = await db.collection(INVITES).where({ code: code }).limit(1).get()
      if (dup.data && dup.data.length) continue
      const add = await db.collection(INVITES).add({
        data: {
          openid: openid,
          code: code,
          codeText: core.format(code),
          createdAt: Date.now()
        }
      })
      created = { _id: add._id, code: code, codeText: core.format(code) }
    }
    if (!created) return bad('SERVER_ERROR', '邀请码生成失败，稍后再试')
    doc = created
  }

  /* 已经邀到几个人：以核销日志为准，别信计数字段（可能是旧数据） */
  const logs = await db.collection(INVITE_LOGS).where({ inviter: openid }).count()
  const rewardedLogs = await db.collection(INVITE_LOGS).where({ inviter: openid, rewarded: true }).count()

  return ok({
    code: doc.code,
    codeText: doc.codeText,
    invited: (logs && logs.total) || 0,
    rewarded: (rewardedLogs && rewardedLogs.total) || 0,
    maxReward: INVITE_MAX,
    days: INVITE_DAYS
  })
}

/* 核销邀请码：被邀请人 +7 天，邀请人再 +7 天（最多 5 次） */
async function accept(openid, rawCode) {
  const code = core.normalize(rawCode)
  if (!core.isRightShape(code)) return bad('BAD_FORMAT', '邀请码格式不对')

  const inviterSnap = await db.collection(INVITES).where({ code: code }).limit(1).get()
  const inviter = inviterSnap.data && inviterSnap.data[0]
  if (!inviter) return bad('BAD_CODE', '这个邀请码不存在，检查有没有输错')

  if (inviter.openid === openid) {
    return bad('SELF_INVITE', '不能邀请自己，发给朋友吧')
  }

  /* 一个人一辈子只算一次被邀请 */
  const dup = await db.collection(INVITE_LOGS).where({ invitee: openid }).limit(1).get()
  if (dup.data && dup.data.length) {
    return bad('ALREADY_INVITED', '你已经用过一次邀请奖励了')
  }

  const expireAt = await grantDays(openid, INVITE_DAYS)

  /* 邀请人的奖励：超过 5 次就不再加天数，但日志照记（方便你看真实拉新数） */
  const used = await db.collection(INVITE_LOGS).where({ inviter: inviter.openid, rewarded: true }).count()
  const rewarded = ((used && used.total) || 0) < INVITE_MAX
  if (rewarded) await grantDays(inviter.openid, INVITE_DAYS)

  await db.collection(INVITE_LOGS).add({
    data: {
      inviter: inviter.openid,
      invitee: openid,
      code: code,
      days: INVITE_DAYS,
      rewarded: rewarded,
      at: Date.now()
    }
  })

  const member = await getMember(openid)
  return ok({
    days: INVITE_DAYS,
    rewarded: rewarded,
    expireAt: expireAt,
    isVip: true,
    daysLeft: core.daysLeft(Date.now(), (member && member.expireAt) || expireAt),
    openid: openid,
    inviterRewarded: rewarded,
    maxReward: INVITE_MAX
  })
}

exports.main = async function (event) {
  const wxContext = cloud.getWXContext()
  const openid = wxContext && wxContext.OPENID
  if (!openid) return bad('NO_OPENID', '拿不到微信身份，请在小程序里调用')

  const action = String((event && event.action) || 'status')

  const run = async function () {
    if (action === 'status') return await status(openid)
    if (action === 'redeem') return await redeem(openid, event && event.code)
    if (action === 'invite') return await invite(openid)
    if (action === 'accept') return await accept(openid, event && event.code)
    if (action === 'initdb') return ok(await bootstrap())
    return bad('BAD_ACTION', '不认识的操作：' + action)
  }

  try {
    return await run()
  } catch (e) {
    const msg = String((e && e.errMsg) || (e && e.message) || e || '')
    /* 集合不存在：自动建库灌码后重试一次，省掉去控制台手工建集合 */
    if (isNoCollection(msg)) {
      try {
        await bootstrap()
        return await run()
      } catch (e2) {
        const msg2 = String((e2 && e2.errMsg) || (e2 && e2.message) || e2 || '')
        if (isNoCollection(msg2)) {
          return bad('NO_COLLECTION', '云数据库里还没有建 codes / members 集合')
        }
        return bad('SERVER_ERROR', msg2 || '服务端出错了')
      }
    }
    return bad('SERVER_ERROR', msg || '服务端出错了')
  }
}
