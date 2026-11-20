// 云函数：意见反馈
//
//   submit → 写一条 feedbacks 文档，返回 ok
//
// ── 需要先建集合（云开发控制台 → 数据库）──
//   feedbacks  权限「仅管理端可读写」
//   文档结构：{ openid, type, content, contact, fileID, page, createdAt, status:'new', version }
//
// ── 防刷 ──
// 同一 openid 每天最多 3 条，超了直接拒绝；不做验证码，避免把真实用户挡在门外。
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const FEEDBACKS = 'feedbacks'
const DAY = 24 * 60 * 60 * 1000
const MAX_PER_DAY = 3
const TYPES = ['bug', 'idea', 'other']

function ok(data) {
  return Object.assign({ ok: true }, data || {})
}

function bad(code, msg) {
  return { ok: false, code: code, msg: msg }
}

/* 当天 0 点（北京时间）的时间戳，用来算「今天发了几条」 */
function todayStart() {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  const d = now.getUTCDate()
  return Date.UTC(y, m, d) - 8 * 60 * 60 * 1000
}

async function submit(openid, event) {
  const type = String((event && event.type) || 'idea')
  if (TYPES.indexOf(type) < 0) return bad('BAD_TYPE', '反馈类型不对')

  const content = String((event && event.content) || '').trim()
  if (content.length < 5) return bad('TOO_SHORT', '内容太短了')
  if (content.length > 500) return bad('TOO_LONG', '内容最多 500 字')

  const contact = String((event && event.contact) || '').trim().slice(0, 50)
  const fileID = String((event && event.fileID) || '').trim().slice(0, 200)
  const page = String((event && event.page) || '').trim().slice(0, 60)

  const recent = await db.collection(FEEDBACKS)
    .where({ openid: openid, createdAt: db.command.gte(todayStart()) })
    .count()
  if (recent && recent.total >= MAX_PER_DAY) {
    return bad('RATE_LIMIT', '今天已经提交 ' + recent.total + ' 条了，明天再来')
  }

  const doc = {
    openid: openid,
    type: type,
    content: content,
    contact: contact,
    fileID: fileID,
    page: page,
    createdAt: Date.now(),
    status: 'new',
    version: 1
  }
  const res = await db.collection(FEEDBACKS).add({ data: doc })
  return ok({ id: (res && res._id) || '' })
}

exports.main = async function (event) {
  const wxContext = cloud.getWXContext()
  const openid = wxContext && wxContext.OPENID
  if (!openid) return bad('NO_OPENID', '拿不到微信身份，请在小程序里调用')

  const action = String((event && event.action) || 'submit')
  try {
    if (action === 'submit') return await submit(openid, event)
    return bad('BAD_ACTION', '不认识的操作：' + action)
  } catch (e) {
    const msg = String((e && e.errMsg) || (e && e.message) || e || '')
    if (/collection not exists|database collection not exists|-502005/i.test(msg)) {
      return bad('NO_COLLECTION', '云数据库里还没有建 feedbacks 集合')
    }
    return bad('SERVER_ERROR', msg || '服务端出错了')
  }
}
