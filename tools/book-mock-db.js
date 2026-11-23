// 离线假库：限制查询批量、事务回滚、故障注入；不加载真实 SDK。
const Module = require('module')
const path = require('path')

function makeDB(options) {
  options = options || {}
  const store = Object.create(null)
  const history = []
  const faults = []
  const clone = (value) => structuredClone(value)
  let sequence = 0
  let transactionId = 0
  let queue = Promise.resolve()
  const matches = (row, where) => Object.keys(where || {}).every((key) => {
    const value = where[key]
    if (value && typeof value === 'object') {
      if ('$gt' in value) return row[key] > value.$gt
      if ('$neq' in value) return row[key] !== value.$neq
    }
    return row[key] === value
  })
  async function operation(op, collection, id, data, transaction) {
    const event = { op, collection, id, data: clone(data), transaction }
    history.push(event)
    const index = faults.findIndex((fault) => fault.op === op && fault.collection === collection && (!fault.predicate || fault.predicate(event)))
    if (index >= 0) throw faults.splice(index, 1)[0].error
    if (options.onOperation) await options.onOperation(event)
  }
  function collection(name, source, transaction) {
    const rows = () => {
      if (!source[name]) source[name] = []
      return source[name]
    }
    function query(where, limit, order, skip) {
      function selected() {
        let result = rows().filter((row) => matches(row, where))
        if (order) result.sort((a, b) => {
          const value = a[order.field] === b[order.field] ? 0 : a[order.field] < b[order.field] ? -1 : 1
          return order.direction === 'desc' ? -value : value
        })
        return result.slice(skip || 0, (skip || 0) + Math.min(limit == null ? 100 : limit, 100))
      }
      return {
        where(value) { return query(value, limit, order, skip) },
        limit(value) { return query(where, value, order, skip) },
        skip(value) { return query(where, limit, order, value) },
        orderBy(field, direction) { return query(where, limit, { field, direction }, skip) },
        async get() {
          await operation('query', name, null, where, transaction)
          return { data: clone(selected()) }
        },
        async count() {
          await operation('count', name, null, where, transaction)
          return { total: rows().filter((row) => matches(row, where)).length }
        },
        async add({ data }) {
          const id = data._id || 'mock-' + String(++sequence).padStart(8, '0')
          await operation('add', name, id, data, transaction)
          if (rows().some((row) => row._id === id)) throw new Error('duplicate document')
          rows().push(Object.assign({}, clone(data), { _id: id }))
          return { _id: id }
        },
        async update({ data }) {
          await operation('queryUpdate', name, null, data, transaction)
          const result = selected()
          result.forEach((row) => Object.assign(row, clone(data)))
          return { stats: { updated: result.length } }
        },
        async remove() {
          await operation('queryRemove', name, null, where, transaction)
          const ids = new Set(selected().map((row) => row._id))
          source[name] = rows().filter((row) => !ids.has(row._id))
          return { stats: { removed: ids.size } }
        },
        doc(id) {
          return {
            async get() {
              await operation('get', name, id, undefined, transaction)
              const row = rows().find((item) => item._id === id)
              if (!row && options.throwOnMissing) throw new Error('document with _id ' + id + ' does not exist')
              return { data: row ? clone(row) : null }
            },
            async set({ data }) {
              await operation('set', name, id, data, transaction)
              const index = rows().findIndex((row) => row._id === id)
              const doc = Object.assign({}, clone(data), { _id: id })
              if (index < 0) rows().push(doc)
              else rows()[index] = doc
              return { stats: { created: index < 0 ? 1 : 0, updated: index < 0 ? 0 : 1 } }
            },
            async update({ data }) {
              await operation('update', name, id, data, transaction)
              const row = rows().find((item) => item._id === id)
              if (row) Object.assign(row, clone(data))
              return { stats: { updated: row ? 1 : 0 } }
            },
            async remove() {
              await operation('remove', name, id, undefined, transaction)
              const before = rows().length
              source[name] = rows().filter((row) => row._id !== id)
              return { stats: { removed: before - source[name].length } }
            }
          }
        }
      }
    }
    return query()
  }
  const api = {
    command: { gt: (value) => ({ $gt: value }), neq: (value) => ({ $neq: value }) },
    async createCollection(name) {
      await operation('createCollection', name)
      if (store[name]) throw new Error('collection already exists')
      store[name] = []
      return {}
    },
    collection(name) { return collection(name, store, null) },
    runTransaction(callback) {
      const result = queue.then(async () => {
        const id = ++transactionId
        const snapshot = clone(store)
        const transaction = { collection: (name) => collection(name, snapshot, id) }
        try {
          const value = await callback(transaction)
          await operation('commit', '', null, undefined, id)
          Object.keys(store).forEach((key) => { delete store[key] })
          Object.assign(store, snapshot)
          return value
        } catch (error) {
          history.push({ op: 'rollback', transaction: id })
          throw error
        }
      })
      queue = result.catch(() => {})
      return result
    }
  }
  return {
    api, store, history,
    failNext(op, name, predicate, error) {
      faults.push({ op, collection: name, predicate, error: error || Object.assign(new Error('injected database failure'), { code: 'MOCK_DB_ERROR' }) })
    }
  }
}

function makeBookMock(options) {
  const db = makeDB(options)
  const fake = { DYNAMIC_CURRENT_ENV: 'mock-env', init() {}, database() { return db.api },
    getWXContext() { return { OPENID: fake.openid } } }
  const filename = path.resolve(__dirname, '../cloudfunctions/book/index.js')
  const originalLoad = Module._load
  const cached = require.cache[filename]
  let fn
  try {
    delete require.cache[filename]
    Module._load = function (request) {
      return request === 'wx-server-sdk' ? fake : originalLoad.apply(this, arguments)
    }
    fn = require(filename)
  } finally {
    Module._load = originalLoad
    delete require.cache[filename]
    if (cached) require.cache[filename] = cached
  }
  return Object.assign(db, {
    call(openid, event) {
      fake.openid = openid
      return fn.main(event)
    }
  })
}

module.exports = { makeDB, makeBookMock }
