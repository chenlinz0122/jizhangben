// 云函数：账单截图 OCR
// 只做一件事 —— 把图片变成带坐标的文字块，流水数据不经过这里。
//
// 两条通道：
//   1) 微信通用印刷体（云调用，免费 100 次/天，但需要小程序已认证）
//   2) 百度通用文字识别（含位置版，需要自己在百度智能云申请 Key，个人账号有免费额度）
// 微信那条如果报「not enough market quota」，会自动落到百度那条。
//
// ── 要用百度通道，就把 Key 配成云函数的环境变量（推荐），或直接粘到下面 ──
// 申请地址：https://console.bce.baidu.com/ai/#/ai/ocr/overview/index
// 创建应用后拿到 API Key 和 Secret Key
// 这两个值不要提交进仓库（本地值存在项目根目录的「本地密钥.txt」，已 gitignore）
const BAIDU_API_KEY = process.env.BAIDU_API_KEY || ''
const BAIDU_SECRET_KEY = process.env.BAIDU_SECRET_KEY || ''

/* 百度接口按顺序试：带坐标的优先，没权限就退到无坐标的那条 */
const BAIDU_OCR_PATHS = [
  '/rest/2.0/ocr/v1/general',       // 通用文字识别（标准含位置版）—— 有坐标，解析最准
  '/rest/2.0/ocr/v1/general_basic'  // 通用文字识别（标准版）—— 没坐标，按行兜底
]

const cloud = require('wx-server-sdk')
const https = require('https')
const querystring = require('querystring')
const parse = require('./parse')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

/* 百度 access_token 缓存（有效期 30 天，这里留点余量） */
let tokenCache = { value: '', expireAt: 0 }

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch (e) {
          reject(new Error('返回的不是 JSON：' + data.slice(0, 120)))
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(20000, () => {
      req.destroy(new Error('请求超时'))
    })
    if (body) req.write(body)
    req.end()
  })
}

async function getBaiduToken() {
  const now = Date.now()
  if (tokenCache.value && now < tokenCache.expireAt) return tokenCache.value

  const qs = querystring.stringify({
    grant_type: 'client_credentials',
    client_id: BAIDU_API_KEY,
    client_secret: BAIDU_SECRET_KEY
  })

  const res = await httpsRequest({
    hostname: 'aip.baidubce.com',
    path: '/oauth/2.0/token?' + qs,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  })

  if (!res || !res.access_token) {
    const why = (res && (res.error_description || res.error)) || '没拿到 access_token'
    throw new Error('百度鉴权失败：' + why)
  }

  tokenCache = {
    value: res.access_token,
    expireAt: now + Math.max((res.expires_in || 2592000) - 3600, 60) * 1000
  }
  return tokenCache.value
}

/* 通道 2：百度。先把云存储的图下载下来，再 base64 传过去。
 * 两条接口依次试：含位置版失败（比如应用只授权了标准版，报 error_code 6）就退到标准版。 */
async function ocrByBaidu(fileID) {
  const dl = await cloud.downloadFile({ fileID })
  const buf = dl.fileContent
  if (!buf || !buf.length) throw new Error('下载图片失败')
  if (parse.tooBig(buf.length)) {
    throw new Error('图片太大（超过约 3M），截短一点再试')
  }

  const token = await getBaiduToken()
  const body = querystring.stringify({
    image: buf.toString('base64'),
    language_type: 'CHN_ENG',
    detect_direction: 'true'
  })

  const errors = []
  for (let i = 0; i < BAIDU_OCR_PATHS.length; i++) {
    const path = BAIDU_OCR_PATHS[i]
    const res = await httpsRequest({
      hostname: 'aip.baidubce.com',
      path: path + '?access_token=' + encodeURIComponent(token),
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    }, body)

    if (res && res.error_code) {
      errors.push(path + ' → ' + res.error_code + ' ' + (res.error_msg || ''))
      continue
    }
    const items = parse.mapBaidu(res)
    if (items.length) return { items: items, path: path }
    errors.push(path + ' → 没识别出文字')
  }

  throw new Error('百度的两条接口都没成功：' + errors.join(' | '))
}

/* 通道 1：微信云调用 */
async function ocrByWx(fileID) {
  const res = await cloud.openapi.ocr.printedText({
    type: 'photo',
    imgUrl: fileID
  })
  return parse.mapWx(res)
}

function amIWechatQuotaError(msg) {
  return /101002|not enough market quota|quota/i.test(String(msg || ''))
}

exports.main = async (event) => {
  const fileID = event && event.fileID
  if (!fileID) return { ok: false, error: '缺少图片 fileID' }

  let wxError = ''
  try {
    const items = await ocrByWx(fileID)
    if (items.length) {
      return { ok: true, via: 'wechat', items: items, count: items.length }
    }
    wxError = '微信 OCR 没识别出文字'
  } catch (e) {
    wxError = (e && (e.errMsg || e.message)) || String(e)
  }

  /* 微信那条不通（配额、权限、识别不出），看百度有没有配 */
  const hasBaidu = !!(BAIDU_API_KEY && BAIDU_SECRET_KEY)
  if (!hasBaidu) {
    let hint
    if (amIWechatQuotaError(wxError)) {
      hint = '微信 OCR 的配额没开通（个人主体小程序通常拿不到那 100 次/天的免费额度）。' +
             '要么去 mp 后台「服务市场」开通，要么在这个云函数里填上百度 OCR 的 Key 走备用通道。'
    } else if (/size|too large|exceed/i.test(wxError)) {
      hint = '图片太大了，截短一点或压缩后再传'
    } else if (/permission|48001|unauthorized/i.test(wxError)) {
      hint = 'OCR 接口没权限，检查云函数 config.json 里的 openapi 声明后重新上传'
    } else {
      hint = '微信 OCR 没成功：' + wxError
    }
    return { ok: false, error: hint, raw: wxError, needBaiduKey: true }
  }

  try {
    const r = await ocrByBaidu(fileID)
    const items = r.items
    if (!items.length) {
      return { ok: false, error: '两条通道都没识别出文字，换张清楚点的截图', raw: wxError }
    }
    return {
      ok: true,
      via: 'baidu',
      endpoint: r.path,
      hasCoord: r.path.indexOf('basic') < 0,
      items: items,
      count: items.length,
      wxNote: wxError
    }
  } catch (e) {
    const msg = (e && e.message) || String(e)
    return { ok: false, error: '微信那条不通（' + wxError + '），百度那条也失败：' + msg, raw: msg }
  }
}
