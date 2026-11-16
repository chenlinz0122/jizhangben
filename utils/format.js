function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

function dayOf(ts) {
  var d = new Date(ts)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

function ymOf(ts) {
  var d = new Date(ts)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1)
}

function money(n) {
  var v = Math.round(Math.abs(Number(n) || 0) * 100) / 100
  var s = v.toFixed(2)
  var p = s.split('.')
  p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return p.join('.')
}

function shortTime(ts) {
  var d = new Date(ts)
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

function monthLabel(ym) {
  var p = ym.split('-')
  return p[0] + '年' + parseInt(p[1], 10) + '月'
}

function shiftMonth(ym, delta) {
  var p = ym.split('-')
  var y = parseInt(p[0], 10)
  var m = parseInt(p[1], 10) + delta
  while (m < 1) {
    m += 12
    y -= 1
  }
  while (m > 12) {
    m -= 12
    y += 1
  }
  return y + '-' + pad(m)
}

module.exports = {
  pad: pad,
  dayOf: dayOf,
  ymOf: ymOf,
  money: money,
  shortTime: shortTime,
  monthLabel: monthLabel,
  shiftMonth: shiftMonth
}
