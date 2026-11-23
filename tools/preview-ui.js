/* Local browser adaptation, NOT a WeChat emulator. Trusted repo source only; no native/cloud services. */
'use strict'
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), http = require('node:http')
const ROOT = path.resolve(__dirname, '..'), UTILS = path.join(ROOT, 'utils')
const PAGES = ['home', 'index', 'list', 'report'], SCENARIOS = ['empty', 'default', 'joined', 'vip']
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const copy = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v))
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const decode = v => String(v).replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (m, k) => k[0] === '#' ? String.fromCodePoint(parseInt(k.slice(k[1] === 'x' ? 2 : 1), k[1] === 'x' ? 16 : 10)) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[k])
const pageFile = (p, ext) => path.join(ROOT, 'pages', p, p + '.' + ext)
function read(file) { const real = fs.realpathSync(file); if (!real.startsWith(ROOT + path.sep)) throw Error('Source outside repository'); return fs.readFileSync(real, 'utf8') }
function json(file) { return JSON.parse(read(file)) }
function patch(data, values) {
  for (const [key, value] of Object.entries(values)) {
    const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.'); if (parts.some(p => ['__proto__', 'constructor', 'prototype'].includes(p))) throw Error('Unsafe data path')
    let target = data; parts.slice(0, -1).forEach((p, i) => { target = target[p] ||= /^\d+$/.test(parts[i + 1]) ? [] : {} }); target[parts.at(-1)] = value
  }
}
function fixture(scenario) {
  const now = new Date(); now.setFullYear(2026)
  const pad = n => String(n).padStart(2, '0'), day = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const rows = [['午后食堂', '餐饮', 38, 'expense'], ['城市地铁', '交通', 6, 'expense'], ['周末书店', '购物', 126, 'expense'], ['生活超市', '购物', 89.5, 'expense'], ['街角小铺', '未分类', 28, 'expense'], ['示例工作室', '工资', 8500, 'income'], ['上月食堂', '餐饮', 56, 'expense'], ['上月影院', '娱乐', 68, 'expense'], ['周末书店', '退款', 26, 'refund']].map((r, i) => {
    const d = new Date(2026, now.getMonth() - (i === 6 || i === 7 ? 1 : 0), i === 8 ? now.getDate() : Math.max(1, now.getDate() - i - 1), 12, i)
    const peer = scenario === 'joined' && [1, 3, 7].includes(i)
    return { id: 'sample-' + i, merchant: r[0], category: r[1], amount: r[2], type: r[3], time: +d, day: day(d), ym: day(d).slice(0, 7), source: '示例数据', desc: i === 2 ? '阅读与日常' : '', note: '', byMe: !peer, by: peer ? '小林' : '', ownerKey: peer ? 'sample-peer' : '', shareBook: peer ? 'sample-book' : '' }
  }).sort((a, b) => b.time - a.time)
  const storage = { txs_v1: scenario === 'empty' ? [] : rows, account_skip_v1: +now, account_v1: scenario === 'empty' ? {} : { nick: '小满', avatar: '', at: +now }, vip_member_v1: { expireAt: scenario === 'vip' ? +new Date(2027, 11, 31) : 0, checkedAt: +now, openid: 'sample-only' }, budget_v1: scenario === 'empty' ? 0 : 3000, budcats_v1: {} }
  if (scenario === 'joined') storage.shared_book_v1 = { bookId: 'sample-book', name: '我们的日常', code: 'SAMPLE', nickname: '小满', members: 2, role: 'owner', joinedAt: +now - 86400000, shareSince: 0, lastSync: +now, memberList: [{ nickname: '小满', isMe: true, role: 'owner' }, { nickname: '小林', isMe: false }] }
  return { storage, now: +now }
}
function native(s) {
  const noop = () => {}, complete = o => { if (o && o.success) o.success({}) }
  const nav = o => { s.navigation = o.url; s.message = '预览跳转（未打开原生页面）：' + o.url; complete(o) }
  const tab = o => { const p = PAGES.find(p => o.url === `/pages/${p}/${p}`); if (p) s.nextPage = p; else nav(o) }
  const blocked = o => { s.message = '浏览器预览未访问真实文件或设备'; if (o && o.fail) o.fail({ errMsg: 'preview: native operation disabled' }) }
  const win = () => ({ theme: s.dark ? 'dark' : 'light', windowWidth: 390, windowHeight: 844, pixelRatio: 1, safeArea: { top: 0, bottom: 844 } })
  return {
    getStorageSync: k => copy(s.storage[k] ?? ''), setStorageSync: (k, v) => { s.storage[k] = copy(v) }, removeStorageSync: k => { delete s.storage[k] }, clearStorageSync: () => { s.storage = Object.create(null) },
    getWindowInfo: win, getSystemInfoSync: win, onThemeChange: noop, offThemeChange: noop, nextTick: fn => fn(),
    setNavigationBarTitle: o => { s.title = o.title }, setNavigationBarColor: noop, setTabBarStyle: o => { s.tabStyle = o }, setTabBarItem: o => { (s.tabItems ||= {})[o.index] = o }, pageScrollTo: o => { s.scrollTo = o.selector }, getAppBaseInfo: win,
    showToast: o => { s.message = o.title }, hideToast: noop, showLoading: o => { s.message = o.title }, hideLoading: noop,
    showModal: o => { s.dialog = { kind: 'modal', id: ++s.dialogId, page: s.active, options: o } }, showActionSheet: o => { s.dialog = { kind: 'sheet', id: ++s.dialogId, page: s.active, options: o } },
    navigateTo: nav, redirectTo: nav, navigateBack: () => { s.message = '预览没有原生页面栈' }, switchTab: tab, reLaunch: tab,
    setClipboardData: o => { s.clipboard = o.data; s.message = '仅存入预览内存，未写入真实剪贴板'; complete(o) },
    env: { USER_DATA_PATH: 'preview-memory' }, getFileSystemManager: () => ({ writeFile: blocked, readFile: blocked, saveFile: blocked }), chooseMessageFile: blocked, openDocument: blocked, shareFileMessage: blocked,
    createSelectorQuery: () => { const q = { select: () => q, selectAll: () => q, in: () => q, fields: () => q, boundingClientRect: () => q, exec: fn => fn && fn([]) }; return q },
    cloud: { callFunction: o => {
      let result = { ok: false, code: 'PREVIEW_OFFLINE', msg: '示例预览未执行云操作' }
      if (o.name === 'vip' && o.data.action === 'status') result = { ok: true, ...copy(s.storage.vip_member_v1) }
      if (o.name === 'book' && o.data.action === 'my') result = { ok: true, joined: !!s.storage.shared_book_v1, ...copy(s.storage.shared_book_v1) }
      if (o.success) o.success({ result }); return Promise.resolve({ result })
    } }
  }
}
function runtime(s) {
  // Reload utilities after source edits, keeping only this scenario's in-memory data.
  const revision = fs.readdirSync(UTILS).filter(n => n.endsWith('.js')).map(n => { const st = fs.statSync(path.join(UTILS, n)); return n + ':' + st.mtimeMs + ':' + st.size }).join('|')
  if (s.context && s.revision === revision) return
  s.revision = revision; s.pages = {}; s.modules = {}; s.dialog = null; s.timers = []; s.actionTimers = false
  class PreviewDate extends Date { constructor(...a) { super(...(a.length ? a : [s.now])) } static now() { return s.now } }
  s.context = vm.createContext({ Date: PreviewDate, wx: native(s), Page: p => { s.definition = p }, getApp: () => s.app, getCurrentPages: () => [s.pages[s.active]?.page].filter(Boolean), console: { log() {}, warn() {}, error() {} },
    // Lifecycle timers are no-ops. Only short action debounces run, synchronously and with a strict budget.
    setTimeout: (fn, delay) => { const id = ++s.timerId; if (s.actionTimers && delay <= 300 && s.timers.length < 16) s.timers.push({ id, fn }); return id }, clearTimeout: id => { s.timers = s.timers.filter(t => t.id !== id) }, setInterval: () => 0, clearInterval() {} }, { codeGeneration: { strings: false, wasm: false } })
}
function load(s, file, isPage = false) {
  const source = read(file), module = { exports: {} }
  if (!isPage && s.modules[file]) return s.modules[file].exports
  if (!isPage) s.modules[file] = module
  const localRequire = name => {
    if (!/^\.{1,2}\//.test(name)) throw Error('Only relative utils imports are allowed')
    const resolved = path.resolve(path.dirname(file), name.endsWith('.js') ? name : name + '.js')
    if (!resolved.startsWith(UTILS + path.sep) || !fs.realpathSync(resolved).startsWith(UTILS + path.sep) || path.extname(resolved) !== '.js') throw Error('Import outside utils denied')
    return load(s, resolved)
  }
  s.context.__module = module; s.context.__require = localRequire
  new vm.Script('(function(require,module,exports){\n' + source + '\n})(__require,__module,__module.exports)', { filename: file }).runInContext(s.context, { timeout: 1500 })
  return module.exports
}
function activate(s, name, show) {
  runtime(s); const source = read(pageFile(name, 'js')); let entry = s.pages[name]
  if (s.active !== name) { s.pages[s.active]?.page.onHide?.(); s.title = ''; s.dialog = null }
  s.active = name
  if (!entry || entry.source !== source) {
    entry?.page.onUnload?.(); s.dialog = null; load(s, pageFile(name, 'js'), true)
    const page = s.definition; page.data = copy(page.data || {}); page.setData = (v, cb) => { patch(page.data, v); if (cb) cb.call(page) }
    entry = s.pages[name] = { page, source }; page.onLoad?.({}); show = true
  }
  if (show) entry.page.onShow?.()
  return entry.page
}
// Quote-aware tokens: a '>' or '<' in a quoted attribute/expression is never a tag boundary.
function parse(wxml) {
  const root = { children: [] }, stack = [root]
  const tokens = wxml.match(/<!--[\s\S]*?-->|{{[\s\S]*?}}|<\/?[\w:-]+\b(?:[^>"']|"[^"]*"|'[^']*')*>|[^<{]+|[<{]/g) || []
  for (const token of tokens) {
    if (token.startsWith('<!--')) continue
    if (token.startsWith('</')) { if (stack.length === 1) throw Error('Unexpected WXML close'); const n = stack.pop(); if (token.slice(2).trim().replace(/>$/, '') !== n.tag) throw Error('Mismatched WXML tag'); continue }
    if (!/^<[\w]/.test(token)) { stack.at(-1).children.push({ text: token }); continue }
    const tag = token.match(/^<([\w:-]+)/)[1], attrs = Object.create(null)
    const rest = token.slice(tag.length + 1).replace(/\/?\s*>$/, '')
    for (const m of rest.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g)) attrs[m[1]] = decode(m[2] ?? m[3] ?? m[4] ?? '')
    const node = { tag, attrs, children: [] }; stack.at(-1).children.push(node); if (!/\/\s*>$/.test(token)) stack.push(node)
  }
  if (stack.length !== 1) throw Error('Unclosed WXML tag')
  return root.children
}
function expression(s, expr, scope) {
  s.context.__scope = scope
  try { return new vm.Script('(function(){with(__scope){return (' + expr + ')}})()').runInContext(s.context, { timeout: 100 }) } catch (e) { if (e.name === 'TypeError' || e.name === 'ReferenceError') return undefined; throw e }
}
function value(s, text, scope) {
  const exact = text.match(/^{{([\s\S]*?)}}$/); if (exact && !exact[1].includes('}}')) return expression(s, exact[1], scope)
  return text.replace(/{{([\s\S]*?)}}/g, (_, expr) => String(expression(s, expr, scope) ?? ''))
}
function css(text, dark) {
  return text.replace(/(-?\d*\.?\d+)rpx\b/g, (_, n) => `calc(${n} * 100vw / 750)`).replace(/@media\s*\(prefers-color-scheme:\s*(dark|light)\)/g, (_, mode) => '@media ' + ((mode === 'dark') === dark ? 'all' : 'not all')).replace(/(^|[{}])([^{}]+)(?=\{)/g, (_, lead, selector) => lead + selector.replace(/(^|[\s>+~,])(page|view|text|image|scroll-view|picker)(?=[\s.#[:>+~,]|$)/g, (_, prefix, tag) => prefix + ({ page: 'body', view: 'div', text: 'span', image: 'img', 'scroll-view': 'div', picker: 'label' })[tag]))
}
function handlers(nodes, found = new Set()) { for (const n of nodes) { for (const [k, v] of Object.entries(n.attrs || {})) if (/^(bind|catch):?(tap|longpress|change|input|confirm|error)$/.test(k) && /^[A-Za-z_$][\w$]*$/.test(v)) found.add(v); handlers(n.children || [], found) } return found }
function render(s, nodes, scope) {
  let chain = false, matched = false
  return nodes.map(n => {
    if (own(n, 'text')) return esc(value(s, decode(n.text), scope))
    const a = n.attrs
    if (own(a, 'wx:for')) {
      chain = false; matched = false
      const list = value(s, a['wx:for'], scope) || [], attrs = { ...a }; delete attrs['wx:for']
      return Object.entries(list).map(([i, item]) => render(s, [{ ...n, attrs }], { ...scope, [a['wx:for-item'] || 'item']: item, [a['wx:for-index'] || 'index']: Array.isArray(list) ? Number(i) : i })).join('')
    }
    if (own(a, 'wx:if')) { chain = true; matched = !!value(s, a['wx:if'], scope); if (!matched) return '' }
    else if (own(a, 'wx:elif') || own(a, 'wx:else')) { if (!chain || matched) return ''; matched = own(a, 'wx:else') || !!value(s, a['wx:elif'], scope); if (!matched) return '' }
    else { chain = false; matched = false }
    const child = render(s, n.children, scope); if (n.tag === 'block') return child
    const tag = ({ view: 'div', text: 'span', image: 'img', 'scroll-view': 'div', picker: 'label', canvas: 'div', button: 'button', input: 'input', textarea: 'textarea', switch: 'input' })[n.tag]
    if (!tag) throw Error('Unsupported WXML element: ' + n.tag)
    const attrs = [], dataset = {}; let change = ''
    for (const [k, raw] of Object.entries(a)) {
      const v = value(s, raw, scope), bind = k.match(/^(bind|catch):?(tap|longpress|change|input|confirm|error)$/)
      if (bind) { const event = bind[2] === 'tap' ? 'event' : bind[2]; attrs.push(`data-${event}="${esc(v)}"`); if (bind[1] === 'catch') attrs.push(`data-catch-${event}="1"`); if (event === 'change') change = v; continue }
      if (k.startsWith('data-')) { dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v; attrs.push(`${k}="${esc(typeof v === 'object' ? JSON.stringify(v) : v)}"`); continue }
      if (['hidden', 'disabled', 'checked'].includes(k)) { if (raw === '' || (v && v !== 'false')) attrs.push(k); continue }
      if (['class', 'id', 'style', 'placeholder', 'value', 'maxlength', 'aria-label', 'aria-hidden', 'role'].includes(k)) attrs.push(`${k}="${esc(k === 'style' ? css(String(v ?? ''), s.dark) : v)}"`)
      if (k === 'src' && /^\/?assets\/tabbar\/[\w-]+\.png$/.test(v)) attrs.push(`src="/${esc(String(v).replace(/^\//, ''))}"`)
      if (k === 'scroll-x' || k === 'scroll-y') attrs.push(`data-${k}="1"`)
    }
    attrs.push(`data-wx-dataset="${esc(JSON.stringify(dataset))}"`)
    let inside = child
    if (n.tag === 'switch') attrs.push('type="checkbox" role="switch" data-native-switch="1"', `style="--switch-color:${esc(value(s, a.color || '#17806b', scope))}"`)
    if (n.tag === 'picker') { if (a.mode !== 'date') throw Error('Only date/month pickers are supported'); attrs.push('data-picker="1"'); inside += `<input aria-label="选择月份" type="${a.fields === 'month' ? 'month' : 'date'}" value="${esc(value(s, a.value || '', scope))}" max="${esc(value(s, a.end || '', scope))}" data-change="${esc(change)}" data-wx-dataset="${esc(JSON.stringify(dataset))}">` }
    if (n.tag === 'canvas') { attrs.push('data-preview-canvas="1"'); inside = '原生 Canvas 未模拟' }
    return `<${tag} ${attrs.join(' ')}>${['input', 'img'].includes(tag) ? '' : inside + `</${tag}>`}`
  }).join('')
}
const SHELL_CSS = `html,body{margin:0;width:100%;min-height:100%;}body{padding-bottom:64px}*{box-sizing:border-box}button,input,textarea{font:inherit}button{cursor:pointer;text-align:center;padding:0 14px;line-height:2.55;border:1px solid #ddd;border-radius:5px;background:#f8f8f8}input{min-width:0;border:0;background:transparent;color:inherit}img{object-fit:cover}[data-native-switch]{appearance:none;position:relative;width:44px;height:25px;border-radius:20px;background:#c8cbd0;cursor:pointer;flex:none}[data-native-switch]::after{content:'';position:absolute;left:2px;top:2px;width:21px;height:21px;background:#fff;border-radius:50%;box-shadow:0 1px 3px #0003}[data-native-switch]:checked{background:var(--switch-color)}[data-native-switch]:checked::after{left:21px}span{white-space:pre-wrap}[hidden]{display:none!important}[data-event]{cursor:pointer}[data-scroll-x]{overflow-x:auto}[data-scroll-y]{overflow-y:auto}[data-picker]{position:relative;display:block}[data-picker]>input{position:absolute;inset:0;opacity:0;width:100%;height:100%;cursor:pointer}[data-preview-canvas]{display:flex;align-items:center;justify-content:center;border:1px dashed #9aa4ad;color:#88939d;font-size:11px}.pu-banner{padding:5px 10px;font:10px/1.6 sans-serif;background:#e8eef0;color:#465660}.pu-banner a{color:inherit;margin-right:9px}.pu-title{height:44px;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:600}.pu-tabs{position:fixed;bottom:0;inset-inline:0;height:60px;display:flex;border-top:1px solid #ddd;z-index:1000;background:#fff}.pu-tabs a{flex:1;text-align:center;text-decoration:none;padding:8px 0 5px;font-size:10px;display:flex;gap:4px;align-items:center;flex-direction:column}.pu-tabs img{width:24px;height:24px}.pu-status{position:fixed;z-index:2001;bottom:68px;left:12px;right:12px;background:#263b42;color:#fff;border-radius:9px;padding:12px;font-size:12px;cursor:pointer}.pu-overlay{position:fixed;inset:0;z-index:2002;background:#0007;display:grid;place-items:center;padding:24px}.pu-dialog{background:#fff;color:#222;border-radius:14px;padding:22px;width:100%;max-width:360px;font-size:14px;white-space:pre-wrap}.pu-dialog input{border:1px solid #aaa;padding:10px;width:100%;margin:12px 0}.pu-dialog button{margin:8px 5px 0 0;font-size:14px}`
function dialog(s) {
  const d = s.dialog; if (!d) return ''; const o = d.options
  const button = (text, detail) => `<button data-resolve="${esc(JSON.stringify({ id: d.id, ...detail }))}">${esc(text)}</button>`
  return `<div class="pu-overlay"><section class="pu-dialog" role="dialog" aria-modal="true"><strong>${esc(o.title || '请选择')}</strong><p>${esc(o.content || '')}</p>${o.editable ? `<input id="pu-modal-input" placeholder="${esc(o.placeholderText || '')}" value="${esc(o.content || '')}">` : ''}${d.kind === 'sheet' ? o.itemList.map((t, i) => button(t, { tapIndex: i })).join('') + button('取消', { cancel: true }) : (o.showCancel === false ? '' : button(o.cancelText || '取消', { confirm: false })) + button(o.confirmText || '确定', { confirm: true })}</section></div>`
}
function documentHtml(s) {
  const p = s.active, config = json(path.join(ROOT, 'app.json')), pageConfig = json(pageFile(p, 'json')), nodes = parse(read(pageFile(p, 'wxml')))
  const route = (page, scenario = s.scenario, dark = s.dark) => `/?page=${page}&scenario=${scenario}&dark=${dark ? 1 : 0}`
  const tabs = config.tabBar || {}, tabStyle = { ...tabs, ...s.tabStyle }, title = s.title || pageConfig.navigationBarTitleText || config.window.navigationBarTitleText
  const bar = (tabs.list || []).map((raw, i) => { const t = { ...raw, ...s.tabItems?.[i] }; const name = t.pagePath.split('/')[1]; if (!PAGES.includes(name)) return ''; const icon = name === p ? t.selectedIconPath || t.iconPath : t.iconPath; return `<a href="${esc(route(name))}" style="color:${esc(name === p ? tabStyle.selectedColor : tabStyle.color)}" ${name === p ? 'aria-current="page"' : ''}>${/^assets\/tabbar\/[\w-]+\.png$/.test(icon) ? `<img alt="" src="/${esc(icon)}">` : ''}<span>${esc(t.text)}</span></a>` }).join('')
  const controls = SCENARIOS.map(k => `<a href="${esc(route(p, k))}">${k === s.scenario ? '[' + k + ']' : k}</a>`).join('') + `<a href="${esc(route(p, s.scenario, !s.dark))}">${s.dark ? '浅色' : '深色'}</a>`
  const styles = css(read(path.join(ROOT, 'app.wxss')) + '\n' + read(pageFile(p, 'wxss')), s.dark)
  return `<!doctype html><html lang="zh-CN" style="color-scheme:${s.dark ? 'dark' : 'light'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · 示例预览</title><style>${SHELL_CSS}\n${styles.replace(/<\/style/gi, '<\\/style')}</style></head><body data-page="${p}" data-scenario="${s.scenario}" data-dark="${s.dark ? 1 : 0}"><div class="pu-banner" title="原生 Canvas、文件、云端、剪贴板未模拟；计时器受限。修改仅保留在预览内存。">浏览器适配预览 · 示例数据 · 非微信模拟器<br>${controls}</div><header class="pu-title">${esc(title)}</header><main id="preview-root">${render(s, nodes, s.pages[p].page.data)}</main><nav class="pu-tabs" style="background:${esc(tabStyle.backgroundColor || '#fff')}">${bar}</nav>${s.message ? `<div class="pu-status" role="status" data-dismiss="1">${esc(s.message)}</div>` : ''}${dialog(s)}<script src="/preview-client.js"></script></body></html>`
}
const CLIENT = `(() => {
let queue = Promise.resolve();
function action(method, dataset, detail) {
 const body = document.body, payload = {page:body.dataset.page,scenario:body.dataset.scenario,dark:body.dataset.dark,method,dataset,detail};
 queue = queue.then(async () => {
  const focus=document.activeElement, focusKey=focus?.dataset.input, start=focus?.selectionStart, end=focus?.selectionEnd;
  const response=await fetch('/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}), result=await response.json();
  if(!response.ok) throw Error(result.error);
  const doc=new DOMParser().parseFromString(result.html,'text/html'); document.head.replaceWith(doc.head); document.body.replaceWith(doc.body); document.documentElement.style.colorScheme=doc.documentElement.style.colorScheme;
  history.replaceState(null,'','/?page='+result.activePage+'&scenario='+payload.scenario+'&dark='+payload.dark);
  if(result.activePage!==payload.page) scrollTo(0,0);
  if(focusKey) {const input=[...document.querySelectorAll('[data-input]')].find(e=>e.dataset.input===focusKey);if(input){input.focus();try{input.setSelectionRange(start,end)}catch{}}}
 }).catch(error=>{let el=document.querySelector('.pu-status');if(!el){el=document.createElement('div');el.className='pu-status';document.body.append(el)}el.textContent='预览错误：'+error.message});
}
document.addEventListener('click',e=>{
 const resolved=e.target.closest('[data-resolve]');if(resolved){action('$resolve',{}, {...JSON.parse(resolved.dataset.resolve),content:document.querySelector('#pu-modal-input')?.value||''});return}
 const dismiss=e.target.closest('[data-dismiss]');if(dismiss){dismiss.remove();return}
 const calls=[];for(let el=e.target;el&&el!==document.body;el=el.parentElement){if(el.disabled)return;if(el.dataset.event){calls.push({method:el.dataset.event,dataset:JSON.parse(el.dataset.wxDataset||'{}')});if(el.dataset.catchEvent)break}}
 if(calls.length){e.preventDefault();action(calls[0].method,calls[0].dataset,{previewBubble:calls.slice(1)})}
});
for(const type of ['input','change','contextmenu','keydown'])document.addEventListener(type,e=>{
 const key=type==='contextmenu'?'longpress':type==='keydown'?'confirm':type;if(type==='keydown'&&e.key!=='Enter')return;
 const el=e.target.closest('[data-'+key+']');if(!el||el.disabled)return;if(type==='contextmenu')e.preventDefault();
 action(el.dataset[key],JSON.parse(el.dataset.wxDataset||'{}'),{value:el.type==='checkbox'?el.checked:el.value});
});
})();`
function resolveDialog(s, detail) {
  const d = s.dialog; if (!d || d.id !== detail.id || d.page !== s.active) throw Error('No matching pending dialog')
  if (d.kind === 'sheet' && !detail.cancel && (!Number.isInteger(detail.tapIndex) || !d.options.itemList[detail.tapIndex])) throw Error('Invalid action-sheet option')
  s.dialog = null
  if (d.kind === 'sheet' && detail.cancel) d.options.fail?.({ errMsg: 'showActionSheet:fail cancel' })
  else d.options.success?.(d.kind === 'sheet' ? { tapIndex: detail.tapIndex } : { confirm: detail.confirm === true, cancel: detail.confirm !== true, content: String(detail.content || '').slice(0, 10000) })
}
function dispatch(s, body) {
  const page = activate(s, body.page, false), allowed = handlers(parse(read(pageFile(body.page, 'wxml'))))
  const invoke = (method, dataset, detail) => { if (!allowed.has(method) || !own(page, method) || typeof page[method] !== 'function') throw Error('Handler not bound in page WXML'); const target = { dataset: dataset || {} }; page[method]({ currentTarget: target, target, detail: detail || {} }) }
  s.message = ''; s.navigation = ''; s.actionTimers = true
  try {
    if (body.method === '$resolve') resolveDialog(s, body.detail || {})
    else { invoke(body.method, body.dataset, body.detail); for (const call of (body.detail?.previewBubble || []).slice(0, 8)) invoke(call.method, call.dataset, {}) }
    for (let i = 0; s.timers.length && i < 16; i++) s.timers.shift().fn()
  } finally { s.actionTimers = false; s.timers = [] }
  if (s.nextPage) { const p = s.nextPage; s.nextPage = ''; activate(s, p, true) }
}
function createServer() {
  const states = new Map()
  return http.createServer(async (req, res) => {
    const send = (status, type, data) => { res.writeHead(status, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" }); res.end(data) }
    try {
      const host = `127.0.0.1:${req.socket.localPort}`
      if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== 'http://' + host) || req.headers['sec-fetch-site'] === 'cross-site') return send(403, 'application/json', '{"error":"Local same-origin requests only"}')
      const url = new URL(req.url, 'http://' + host)
      if (req.method === 'GET' && url.pathname === '/preview-client.js') return send(200, 'text/javascript', CLIENT)
      if (req.method === 'GET' && /^\/assets\/tabbar\/[\w-]+\.png$/.test(url.pathname)) { const file = path.join(ROOT, url.pathname.slice(1)); if (!fs.existsSync(file)) return send(404, 'text/plain', 'Icon not created yet'); const real = fs.realpathSync(file); if (!real.startsWith(path.join(ROOT, 'assets', 'tabbar') + path.sep)) return send(403, 'text/plain', 'Asset denied'); res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); return res.end(fs.readFileSync(real)) }
      let input = Object.fromEntries(url.searchParams)
      if (req.method === 'POST' && url.pathname === '/action') { if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(415, 'application/json', '{"error":"JSON required"}'); const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 32768) throw Error('Action too large'); chunks.push(chunk) } input = JSON.parse(Buffer.concat(chunks).toString('utf8'), (k, v) => { if (['__proto__', 'constructor', 'prototype'].includes(k)) throw Error('Unsafe key'); return v }) }
      else if (req.method !== 'GET' || url.pathname !== '/') return send(404, 'application/json', '{"error":"Not found"}')
      const page = input.page || 'home', scenario = input.scenario || 'default', dark = String(input.dark || '') === '1'
      if (!PAGES.includes(page) || !SCENARIOS.includes(scenario)) throw Error('Unknown page or scenario')
      const key = scenario + ':' + dark
      if (!states.has(key)) states.set(key, { ...fixture(scenario), scenario, dark, app: { globalData: {} }, pages: {}, dialogId: 0, timerId: 0 })
      const s = states.get(key)
      if (req.method === 'POST') dispatch(s, { ...input, page }); else activate(s, page, true)
      const html = documentHtml(s)
      send(200, req.method === 'POST' ? 'application/json' : 'text/html', req.method === 'POST' ? JSON.stringify({ ok: true, activePage: s.active, message: s.message || '', navigation: s.navigation || '', html }) : html)
    } catch (error) { send(400, 'application/json', JSON.stringify({ error: error.message })) }
  })
}
if (require.main === module) { const port = Number(process.env.PORT || 8765); if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid PORT'); createServer().listen(port, '127.0.0.1', () => console.log(`Browser adaptation (not WeChat): http://127.0.0.1:${port}/?page=home&scenario=default`)) }
module.exports = { createServer, parse, render, runtime, fixture, patch, css, handlers }
