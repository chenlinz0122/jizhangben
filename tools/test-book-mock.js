// node tools/test-book-mock.js — 完全离线，不调用云端。
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { makeBookMock } = require('./book-mock-db')

let passed = 0
const failures = []
async function test(name, callback) {
  try {
    await callback()
    passed++
  } catch (error) {
    failures.push(name + ': ' + error.stack)
  }
}
function good(result) { assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.protocol, 2); return result }
function bad(result, code) { assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(result.code, code); assert.equal(result.protocol, 2); return result }
function live(id, extra) { return Object.assign({ id, time: 1795305600000, amount: 12.5, type: 'expense', baseVersion: 0 }, extra) }
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex') }
function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
function push(mock, owner, bookId, txs) { return mock.call(owner, { action: 'push', protocol: 2, bookId, txs }) }
function pull(mock, owner, bookId, cursor = '') { return mock.call(owner, { action: 'pull', protocol: 2, bookId, cursor }) }
async function allRows(mock, owner, bookId) {
  const rows = []
  let cursor = ''
  let pages = 0
  while (true) {
    const result = good(await pull(mock, owner, bookId, cursor))
    pages++
    assert.ok(result.txs.length <= 100)
    assert.equal(typeof result.hasMore, 'boolean')
    assert.equal(typeof result.cursor, 'string')
    result.txs.forEach((row) => { assert.ok(row.sharedId > cursor); cursor = row.sharedId })
    rows.push(...result.txs)
    assert.equal(result.cursor, cursor)
    if (!result.hasMore) return { rows, pages }
    assert.equal(result.txs.length, 100)
    assert.ok(result.cursor)
    assert.ok(pages < 50, 'cursor must make progress')
  }
}

async function main() {
  const mock = makeBookMock({ throwOnMissing: true })
  good(await mock.call('A', { action: 'initdb' }))
  const book = good(await mock.call('A', { action: 'create', name: '家', nickname: '同名' }))
  const id = book.bookId
  good(await mock.call('B', { action: 'join', code: book.code, nickname: '同名' }))
  const other = good(await mock.call('Z', { action: 'create', nickname: '其他账本' }))

  await test('create/my/join advertise protocol and preserve actual membership', async () => {
    assert.equal(book.created, true)
    assert.equal(book.memberLimit, 10)
    assert.equal(good(await mock.call('A', { action: 'create' })).created, false)
    const mine = good(await mock.call('B', { action: 'my' }))
    const member = mock.store.book_members.find((row) => row.openid === 'B')
    assert.equal(mine.role, member.role)
    assert.equal(mine.joinedAt, member.joinedAt)
    assert.equal(mine.owner, false)
    assert.equal(mine.members, 2)
    assert.equal(good(await mock.call('B', { action: 'join', code: book.code })).already, true)
    assert.equal(good(await mock.call('stranger', { action: 'my' })).joined, false)
    bad(await mock.call('', { action: 'my' }), 'NO_OPENID')
  })
  await test('create while joined is rejected without creating a book', async () => {
    const before = mock.store.books.length
    bad(await mock.call('B', { action: 'create', name: '不能创建' }), 'ALREADY_JOINED')
    assert.equal(mock.store.books.length, before)
    bad(await mock.call('A', { action: 'join', code: other.code }), 'ALREADY_JOINED')
  })
  await test('both push and pull reject missing, old and string protocol', async () => {
    for (const protocol of [undefined, 1, '2', null]) {
      for (const action of ['push', 'pull']) {
        const result = bad(await mock.call('A', { action, protocol, bookId: id, txs: [live('old')] }), 'UPGRADE_REQUIRED')
        assert.equal(result.txs, undefined)
        if (action === 'push') { assert.equal(result.pushed, 0); assert.deepEqual(result.acks, []) }
      }
    }
    assert.equal((mock.store.book_txs || []).length, 0)
  })
  await test('non-members and malformed access cannot read or write', async () => {
    bad(await push(mock, 'stranger', id, [live('x')]), 'NOT_MEMBER')
    bad(await pull(mock, 'stranger', id), 'NOT_MEMBER')
    for (const invalid of ['', null, {}, 8]) bad(await push(mock, 'A', invalid, []), 'BAD_FORMAT')
    for (const cursor of [null, 5, {}, 'x'.repeat(201)]) bad(await pull(mock, 'A', id, cursor), 'BAD_CURSOR')
    const empty = good(await pull(mock, 'Z', other.bookId))
    assert.deepEqual(empty.txs, [])
    assert.equal(empty.hasMore, false)
    assert.equal(empty.cursor, '')
  })
  await test('same local id is isolated by owner; source and whitelist round trip', async () => {
    const row = live('same/id', { src: 'manual', source: '微信', category: '餐饮', edited: 1795305600001,
      privateSecret: 'not allowed', openid: 'B', sharedId: 'forged', ownerKey: 'forged', version: 300, byName: 'forged' })
    const a = good(await push(mock, 'A', id, [row])).acks[0]
    const b = good(await push(mock, 'B', id, [live('same/id', { amount: 8 })])).acks[0]
    assert.equal(a.sharedId, digest(JSON.stringify([id, 'A', row.id])))
    assert.equal(b.sharedId, digest(JSON.stringify([id, 'B', row.id])))
    assert.notEqual(a.sharedId, b.sharedId)
    assert.deepEqual(a, { id: row.id, sharedId: a.sharedId, version: 1, deleted: false })
    const rows = good(await pull(mock, 'A', id)).txs
    assert.equal(rows.length, 2)
    const mine = rows.find((item) => item.isMe)
    assert.equal(mine.source, '微信')
    assert.equal(mine.src, 'manual')
    assert.equal(mine.edited, row.edited)
    assert.equal(mine.byName, '同名')
    assert.equal(mine.ownerKey, digest(id + 'A'))
    assert.notEqual(mine.ownerKey, rows.find((item) => !item.isMe).ownerKey)
    rows.forEach((item) => ['openid', 'bookId', '_id', 'privateSecret', 'baseVersion', 'updatedAt'].forEach((key) => assert.equal(key in item, false)))
    assert.equal(mock.store.book_txs.find((item) => item._id === a.sharedId).openid, 'A')
    const members = good(await pull(mock, 'B', id)).memberList
    assert.equal(new Set(members.map((member) => member.ownerKey)).size, 2)
    assert.ok(members.every((member) => !('openid' in member)))
  })
  await test('retry acknowledgements do not bump version or updatedAt', async () => {
    const row = live('retry', { source: '导入', desc: null, note: undefined })
    const first = good(await push(mock, 'A', id, [row]))
    const stored = structuredClone(mock.store.book_txs.find((item) => item.id === 'retry'))
    good(await mock.call('A', { action: 'setNick', nickname: '新名字' }))
    const retry = good(await push(mock, 'A', id, [Object.assign({}, row, { desc: '', note: '', unknown: 'ignored' })]))
    assert.deepEqual(retry.acks, first.acks)
    assert.deepEqual(mock.store.book_txs.find((item) => item.id === 'retry'), stored)
    assert.equal(retry.pushed, 1)
  })
  await test('edits increment versions; stale edits conflict with successful prefix preserved', async () => {
    const updated = good(await push(mock, 'A', id, [live('retry', { source: '导入', amount: 20, baseVersion: 1 })]))
    assert.equal(updated.acks[0].version, 2)
    const result = bad(await push(mock, 'A', id, [live('prefix'), live('retry', { amount: 99, baseVersion: 1 }), live('never-attempted')]), 'VERSION_CONFLICT')
    assert.equal(result.pushed, 1)
    assert.equal(result.acks[0].id, 'prefix')
    assert.equal(result.failedIndex, 1)
    assert.equal(result.conflict.version, 2)
    assert.equal(result.conflict.id, 'retry')
    assert.ok(!mock.store.book_txs.some((row) => row.id === 'never-attempted'))
    assert.equal(mock.store.book_txs.find((row) => row.id === 'retry').amount, 20)
    const retry = good(await push(mock, 'A', id, [live('retry', { source: '导入', amount: 20, baseVersion: 0 })]))
    assert.equal(retry.acks[0].version, 2)
  })
  await test('concurrent conflicting edits have exactly one winner', async () => {
    good(await push(mock, 'A', id, [live('race')]))
    const results = await Promise.all([push(mock, 'A', id, [live('race', { amount: 2, baseVersion: 1 })]),
      push(mock, 'A', id, [live('race', { amount: 3, baseVersion: 1 })])])
    assert.equal(results.filter((row) => row.ok).length, 1)
    bad(results.find((row) => !row.ok), 'VERSION_CONFLICT')
    assert.equal(mock.store.book_txs.find((row) => row.id === 'race').version, 2)
  })
  await test('minimal tombstones, retries and stale resurrection protection', async () => {
    const deleted = good(await push(mock, 'A', id, [{ id: 'race', deleted: true, baseVersion: 2 }]))
    assert.equal(deleted.acks[0].version, 3)
    assert.equal(deleted.acks[0].deleted, true)
    assert.deepEqual(good(await push(mock, 'A', id, [{ id: 'race', deleted: true, baseVersion: 2 }])).acks, deleted.acks)
    bad(await push(mock, 'A', id, [live('race', { amount: 3, baseVersion: 2 })]), 'VERSION_CONFLICT')
    const tombstone = good(await pull(mock, 'B', id)).txs.find((row) => row.id === 'race')
    assert.equal(tombstone.deleted, true)
    assert.equal(tombstone.version, 3)
    assert.equal(tombstone.time, undefined)
    const absent = good(await push(mock, 'B', id, [{ id: 'never-uploaded', deleted: true }]))
    assert.equal(absent.acks[0].version, 1)
    assert.deepEqual(good(await push(mock, 'B', id, [{ id: 'never-uploaded', deleted: true }])).acks, absent.acks)
  })
  await test('legacy own id is reused and peers cannot overwrite legacy docs', async () => {
    const legacy = { _id: id + '_legacy', bookId: id, openid: 'A', id: 'legacy', time: 1, amount: 3, type: 'expense', desc: null }
    mock.store.book_txs.push(legacy)
    const peer = good(await push(mock, 'B', id, [live('legacy')])).acks[0]
    assert.notEqual(peer.sharedId, legacy._id)
    assert.deepEqual(mock.store.book_txs.find((row) => row._id === legacy._id), legacy)
    const pulled = good(await pull(mock, 'B', id)).txs.find((row) => row.sharedId === legacy._id)
    assert.equal(pulled.version, 0)
    assert.equal(pulled.byName, '新名字')
    const retry = good(await push(mock, 'A', id, [live('legacy', { time: 1, amount: 3 })])).acks[0]
    assert.equal(retry.sharedId, legacy._id)
    assert.equal(retry.version, 0)
    const edit = good(await push(mock, 'A', id, [live('legacy', { amount: 7 })])).acks[0]
    assert.equal(edit.sharedId, legacy._id)
    assert.equal(edit.version, 1)
    assert.equal(mock.store.book_txs.filter((row) => row.id === 'legacy').length, 2)
  })
  await test('foreign ownership at resolved doc id is rejected transactionally', async () => {
    const forged = digest(JSON.stringify([id, 'A', 'foreign']))
    mock.store.book_txs.push({ _id: forged, bookId: id, openid: 'B', id: 'foreign', amount: 4, time: 1 })
    const before = structuredClone(mock.store.book_txs.find((row) => row._id === forged))
    bad(await push(mock, 'A', id, [live('foreign')]), 'OWNER_MISMATCH')
    assert.deepEqual(mock.store.book_txs.find((row) => row._id === forged), before)
    const peerDoc = mock.store.book_txs.find((row) => row.id === 'same/id' && row.openid === 'A')
    const saved = structuredClone(peerDoc)
    good(await push(mock, 'B', id, [live('same/id', { amount: 9, baseVersion: 1, openid: 'A', sharedId: peerDoc._id })]))
    assert.deepEqual(mock.store.book_txs.find((row) => row._id === peerDoc._id), saved)
  })
  await test('malformed rows reject the entire batch before any write', async () => {
    const invalids = [null, [], 'row', {}, live(''), live('   '), live(4), live('x'.repeat(201)),
      live('bad', { amount: 0 }), live('bad', { amount: -1 }), live('bad', { amount: Infinity }), live('bad', { amount: NaN }),
      live('bad', { type: 'unsupported' }), live('bad', { type: '' }),
      live('bad', { amount: '3' }), live('bad', { time: 0 }), live('bad', { time: Infinity }), live('bad', { time: 8640000000000001 }),
      live('bad', { time: 'today' }), live('bad', { deleted: 'true' }), live('bad', { deleted: null }),
      live('bad', { baseVersion: -1 }), live('bad', { baseVersion: 1.2 }), live('bad', { baseVersion: '0' }), live('bad', { baseVersion: null }),
      live('bad', { baseVersion: Number.MAX_SAFE_INTEGER + 1 }), live('bad', { source: {} }), live('bad', { desc: 'x'.repeat(1001) }),
      live('bad', { edited: 'yes' }), live('bad', { note: 1 })]
    for (const row of invalids) {
      const before = structuredClone(mock.store.book_txs)
      const result = bad(await push(mock, 'A', id, [live('not-written'), row]), 'BAD_TX')
      assert.equal(result.pushed, 0)
      assert.deepEqual(result.acks, [])
      assert.equal(result.failedIndex, 1)
      assert.deepEqual(mock.store.book_txs, before)
    }
    for (const txs of [null, undefined, {}, 'rows']) bad(await push(mock, 'A', id, txs), 'BAD_TXS')
  })
  await test('unsafe-looking ids remain distinct strings without map-key collisions', async () => {
    const ids = ['__proto__', 'constructor', 'toString', 'a/b', 'a_b', 'a b', '长'.repeat(200)]
    const result = good(await push(mock, 'A', id, ids.map((key) => live(key))))
    assert.equal(result.pushed, ids.length)
    assert.equal(new Set(result.acks.map((row) => row.sharedId)).size, ids.length)
    assert.deepEqual(result.acks.map((row) => row.id), ids)
  })
  await test('oversize batch rejected, 300 accepted, empty batch acknowledged', async () => {
    const rows = Array.from({ length: 301 }, (_, i) => live('bulk-' + i))
    const before = mock.store.book_txs.length
    const result = bad(await push(mock, 'A', id, rows), 'TOO_MANY_TXS')
    assert.equal(result.pushed, 0)
    assert.deepEqual(result.acks, [])
    assert.equal(mock.store.book_txs.length, before)
    assert.equal(good(await push(mock, 'A', id, rows.slice(0, 300))).pushed, 300)
    assert.deepEqual(good(await push(mock, 'A', id, [])).acks, [])
  })
  await test('database failures return successful acks only and retries stay idempotent', async () => {
    mock.failNext('set', 'book_txs', (event) => event.data.id === 'fail-2')
    const rows = [live('fail-1'), live('fail-2'), live('fail-3')]
    const result = bad(await push(mock, 'A', id, rows), 'MOCK_DB_ERROR')
    assert.equal(result.pushed, 1)
    assert.equal(result.failedIndex, 1)
    assert.equal(result.acks[0].id, 'fail-1')
    assert.match(result.msg, /injected/)
    assert.ok(!mock.store.book_txs.some((row) => row.id === 'fail-2' || row.id === 'fail-3'))
    const retry = good(await push(mock, 'A', id, rows))
    assert.equal(retry.pushed, 3)
    assert.deepEqual(retry.acks[0], result.acks[0])
    assert.ok(retry.acks.every((row) => row.version === 1))
  })
  await test('read and commit failures are not mistaken for absent docs or success', async () => {
    mock.failNext('get', 'book_txs')
    bad(await push(mock, 'A', id, [live('get-fail')]), 'MOCK_DB_ERROR')
    const before = structuredClone(mock.store.books)
    mock.failNext('commit', '')
    const result = bad(await push(mock, 'A', id, [live('commit-fail')]), 'MOCK_DB_ERROR')
    assert.deepEqual(result.acks, [])
    assert.equal(result.pushed, 0)
    assert.deepEqual(mock.store.books, before)
    assert.ok(!mock.store.book_txs.some((row) => row.id === 'commit-fail' || row.id === 'get-fail'))
  })
  await test('more than 600 rows paginate without truncation, duplicates or owner leaks', async () => {
    for (let offset = 300; offset < 707; offset += 300) {
      good(await push(mock, 'A', id, Array.from({ length: Math.min(300, 707 - offset) }, (_, i) => live('bulk-' + (offset + i)))))
    }
    good(await push(mock, 'Z', other.bookId, [live('private-other-book')]))
    const { rows, pages } = await allRows(mock, 'B', id)
    assert.ok(pages >= 8)
    const expected = mock.store.book_txs.filter((row) => row.bookId === id).map((row) => row._id).sort()
    assert.deepEqual(rows.map((row) => row.sharedId), expected)
    assert.equal(new Set(rows.map((row) => row.sharedId)).size, rows.length)
    assert.ok(rows.some((row) => row.deleted))
    assert.ok(!rows.some((row) => row.id === 'private-other-book'))
    assert.equal(good(await pull(mock, 'B', id, expected[expected.length - 1])).hasMore, false)
    console.log('pagination: ' + rows.length + ' rows / ' + pages + ' pages')
  })
  await test('exact full last page reports hasMore false under 100-row query cap', async () => {
    const exact = makeBookMock()
    const b = good(await exact.call('O', { action: 'create' }))
    good(await push(exact, 'O', b.bookId, Array.from({ length: 200 }, (_, i) => live('exact-' + i))))
    const first = good(await pull(exact, 'O', b.bookId))
    assert.equal(first.txs.length, 100)
    assert.equal(first.hasMore, true)
    const last = good(await pull(exact, 'O', b.bookId, first.cursor))
    assert.equal(last.txs.length, 100)
    assert.equal(last.hasMore, false)
  })
  await test('membership limit and malformed invite behavior retained', async () => {
    for (let i = 0; i < 8; i++) good(await mock.call('member-' + i, { action: 'join', code: book.code }))
    bad(await mock.call('overflow', { action: 'join', code: book.code }), 'FULL')
    bad(await mock.call('overflow', { action: 'join', code: 'abc' }), 'BAD_FORMAT')
    bad(await mock.call('overflow', { action: 'join', code: 'ZZZZZZ' }), 'BAD_CODE')
    bad(await mock.call('stranger', { action: 'setNick' }), 'NOT_MEMBER')
  })
  await test('simultaneous create and join cannot claim two memberships', async () => {
    const results = await Promise.all([mock.call('new-user', { action: 'create' }), mock.call('new-user', { action: 'join', code: other.code })])
    assert.equal(results.filter((row) => row.ok).length, 1)
    bad(results.find((row) => !row.ok), 'ALREADY_JOINED')
    assert.equal(mock.store.book_members.filter((row) => row.openid === 'new-user').length, 1)
  })

  await test('ordinary leave tombstones all pages before membership removal; errors are retryable', async () => {
    const m = makeBookMock()
    const b = good(await m.call('owner', { action: 'create' }))
    good(await m.call('member', { action: 'join', code: b.code, nickname: '退出的人' }))
    good(await push(m, 'owner', b.bookId, [live('keep')]))
    good(await push(m, 'member', b.bookId, Array.from({ length: 205 }, (_, i) => live('own-' + i))))
    good(await push(m, 'member', b.bookId, [{ id: 'already-deleted', deleted: true }]))
    m.store.book_txs.push({ _id: 'legacy-leave', bookId: b.bookId, openid: 'member', id: 'legacy-leave', amount: 4, time: 1 })
    let tombstones = 0
    m.failNext('set', 'book_txs', (event) => event.data.deleted && ++tombstones === 111)
    bad(await m.call('member', { action: 'leave' }), 'MOCK_DB_ERROR')
    const membership = m.store.book_members.find((row) => row.openid === 'member')
    assert.equal(membership.leaving, true)
    assert.equal(m.store.book_txs.filter((row) => row.openid === 'member' && row.deleted).length, 111)
    bad(await push(m, 'member', b.bookId, [live('blocked')]), 'MEMBER_LEAVING')
    bad(await m.call('member', { action: 'join', code: b.code }), 'MEMBER_LEAVING')
    assert.equal(good(await m.call('member', { action: 'my' })).leaving, true)
    m.failNext('remove', 'book_members', (event) => event.id === membership._id)
    bad(await m.call('member', { action: 'leave' }), 'MOCK_DB_ERROR')
    assert.ok(m.store.book_members.some((row) => row.openid === 'member'))
    assert.ok(m.store.book_txs.filter((row) => row.openid === 'member').every((row) => row.deleted))
    const completed = structuredClone(m.store.book_txs)
    good(await m.call('member', { action: 'leave' }))
    assert.deepEqual(m.store.book_txs, completed)
    assert.equal(m.store.book_txs.length, 208)
    const deleted = (await allRows(m, 'owner', b.bookId)).rows.filter((row) => !row.isMe)
    assert.equal(deleted.length, 207)
    assert.ok(deleted.every((row) => row.deleted && row.byName === '退出的人'))
    assert.ok(deleted.every((row) => row.version === (row.id === 'already-deleted' || row.id === 'legacy-leave' ? 1 : 2)))
    assert.equal(good(await m.call('member', { action: 'my' })).joined, false)
    good(await m.call('member', { action: 'leave' }))
    bad(await pull(m, 'member', b.bookId), 'NOT_MEMBER')
    assert.equal(m.store.book_txs.find((row) => row.id === 'keep').deleted, false)
  })
  await test('owner leave closes first, retries every failure stage and preserves other books', async () => {
    const m = makeBookMock()
    const b = good(await m.call('owner', { action: 'create' }))
    good(await m.call('member', { action: 'join', code: b.code }))
    const keep = good(await m.call('other', { action: 'create' }))
    good(await push(m, 'other', keep.bookId, [live('other-data')]))
    good(await push(m, 'owner', b.bookId, Array.from({ length: 237 }, (_, i) => live('cleanup-' + i))))
    for (let i = 0; i < 135; i++) m.store.book_members.push({ _id: 'legacy-member-' + i, bookId: b.bookId, openid: 'legacy-' + i, role: 'member' })
    let removed = 0
    m.failNext('remove', 'book_txs', () => ++removed === 121)
    bad(await m.call('owner', { action: 'leave' }), 'MOCK_DB_ERROR')
    assert.equal(m.store.books.find((row) => row.bookId === b.bookId).closing, true)
    assert.equal(m.store.book_txs.filter((row) => row.bookId === b.bookId).length, 117)
    assert.ok(m.store.book_members.some((row) => row.openid === 'owner'))
    bad(await m.call('new', { action: 'join', code: b.code }), 'BOOK_CLOSING')
    bad(await push(m, 'member', b.bookId, [live('blocked')]), 'BOOK_CLOSING')
    bad(await pull(m, 'member', b.bookId), 'BOOK_CLOSING')
    bad(await m.call('owner', { action: 'create' }), 'BOOK_CLOSING')
    assert.equal(good(await m.call('owner', { action: 'my' })).closing, true)
    let membershipsRemoved = 0
    m.failNext('remove', 'book_members', () => ++membershipsRemoved === 111)
    bad(await m.call('owner', { action: 'leave' }), 'MOCK_DB_ERROR')
    assert.equal(m.store.book_txs.filter((row) => row.bookId === b.bookId).length, 0)
    assert.ok(m.store.book_members.some((row) => row.openid === 'owner'))
    m.failNext('remove', 'books')
    bad(await m.call('owner', { action: 'leave' }), 'MOCK_DB_ERROR')
    assert.equal(m.store.book_members.filter((row) => row.bookId === b.bookId).length, 1)
    const owner = m.store.book_members.find((row) => row.openid === 'owner')
    m.failNext('remove', 'book_members', (event) => event.id === owner._id)
    bad(await m.call('owner', { action: 'leave' }), 'MOCK_DB_ERROR')
    assert.ok(m.store.books.some((row) => row.bookId === b.bookId), 'final transaction must roll back book removal')
    assert.ok(m.store.book_members.some((row) => row.openid === 'owner'))
    assert.equal(good(await m.call('owner', { action: 'leave' })).dissolved, true)
    assert.equal(m.store.book_members.filter((row) => row.bookId === b.bookId).length, 0)
    assert.equal(m.store.books.filter((row) => row.bookId === b.bookId).length, 0)
    good(await m.call('owner', { action: 'leave' }))
    assert.equal(good(await m.call('other', { action: 'my' })).joined, true)
    assert.equal(good(await pull(m, 'other', keep.bookId)).txs[0].id, 'other-data')
  })
  await test('push preflight cannot write after ordinary member leave starts', async () => {
    const entered = deferred()
    const release = deferred()
    let pause = false
    const m = makeBookMock({ onOperation: async (event) => {
      if (pause && event.op === 'query' && event.collection === 'book_txs' && event.data.id === 'late') {
        pause = false
        entered.resolve()
        await release.promise
      }
    } })
    const b = good(await m.call('owner', { action: 'create' }))
    good(await m.call('member', { action: 'join', code: b.code }))
    good(await push(m, 'member', b.bookId, [live('existing')]))
    pause = true
    const pending = push(m, 'member', b.bookId, [live('late')])
    await entered.promise
    m.failNext('set', 'book_txs', (event) => event.data.deleted)
    const leaving = await m.call('member', { action: 'leave' })
    release.resolve()
    const result = await pending
    bad(leaving, 'MOCK_DB_ERROR')
    bad(result, 'MEMBER_LEAVING')
    assert.ok(!m.store.book_txs.some((row) => row.id === 'late'))
    good(await m.call('member', { action: 'leave' }))
  })
  await test('join preflight cannot admit a member after owner closes the book', async () => {
    const entered = deferred()
    const release = deferred()
    let pause = false
    const m = makeBookMock({ onOperation: async (event) => {
      if (pause && event.op === 'query' && event.collection === 'book_members' && event.data.openid === 'new') {
        pause = false
        entered.resolve()
        await release.promise
      }
    } })
    const b = good(await m.call('owner', { action: 'create' }))
    good(await push(m, 'owner', b.bookId, [live('existing')]))
    pause = true
    const pending = m.call('new', { action: 'join', code: b.code })
    await entered.promise
    m.failNext('remove', 'book_txs')
    const leaving = await m.call('owner', { action: 'leave' })
    release.resolve()
    const result = await pending
    bad(leaving, 'MOCK_DB_ERROR')
    bad(result, 'BOOK_CLOSING')
    assert.ok(!m.store.book_members.some((row) => row.openid === 'new'))
    good(await m.call('owner', { action: 'leave' }))
  })
  await test('stale concurrent leave cannot delete a rejoined membership or new records', async () => {
    const entered = deferred()
    const release = deferred()
    let pause = false
    const m = makeBookMock({ onOperation: async (event) => {
      if (pause && event.op === 'query' && event.collection === 'book_txs' && event.data.openid === 'member') {
        pause = false
        entered.resolve()
        await release.promise
      }
    } })
    const b = good(await m.call('owner', { action: 'create' }))
    good(await m.call('member', { action: 'join', code: b.code }))
    good(await push(m, 'member', b.bookId, [live('old')]))
    pause = true
    const pending = m.call('member', { action: 'leave' })
    await entered.promise
    const completed = await m.call('member', { action: 'leave' })
    const rejoined = await m.call('member', { action: 'join', code: b.code })
    const saved = await push(m, 'member', b.bookId, [live('new')])
    release.resolve()
    const result = await pending
    good(completed)
    good(rejoined)
    good(saved)
    bad(result, 'MEMBER_CHANGED')
    assert.equal(good(await m.call('member', { action: 'my' })).joined, true)
    assert.equal(m.store.book_txs.find((row) => row.id === 'new').deleted, false)
  })
  await test('every tx write is transactional and no unscoped bulk deletion is used', async () => {
    assert.ok(mock.history.filter((event) => event.op === 'set' && event.collection === 'book_txs').every((event) => event.transaction))
    assert.ok(!mock.history.some((event) => event.op === 'queryRemove'))
  })
  console.log('book protocol 2: ' + passed + ' passed, ' + failures.length + ' failed')
  failures.forEach((error) => console.error(error))
  if (failures.length) process.exitCode = 1
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
