const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const out = path.resolve(__dirname, '../assets/tabbar')
const size = 72
const icons = {
  home: [[[4, 11], [12, 4], [20, 11]], [[6, 10], [6, 20], [10, 20], [10, 14], [14, 14], [14, 20], [18, 20], [18, 10]]],
  list: [[[6, 4], [18, 4], [18, 20], [6, 20], [6, 4]], [[9, 8], [15, 8]], [[9, 12], [15, 12]], [[9, 16], [13, 16]]],
  report: [[[4, 4], [4, 20], [21, 20]], [[8, 16], [8, 12]], [[13, 16], [13, 8]], [[18, 16], [18, 4]]],
  mine: [Array.from({ length: 41 }, (_, i) => [12 + 3.7 * Math.cos(i * Math.PI / 20), 7.5 + 3.7 * Math.sin(i * Math.PI / 20)]), [[5, 21], [5, 19], [6, 16], [9, 14], [15, 14], [18, 16], [19, 19], [19, 21], [5, 21]]]
}
const colors = { '': '#7a8882', '-active': '#17806b', '-ink': '#2f5d8a', '-amber': '#b96a2b', '-dark': '#93cdb8' }
function crc(buffer) {
  let c = 0xffffffff
  for (const b of buffer) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0) }
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const tag = Buffer.from(type)
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc(Buffer.concat([tag, data])))
  return Buffer.concat([length, tag, data, checksum])
}
function render(lines, hex) {
  const rgba = [1, 3, 5].map((n) => parseInt(hex.slice(n, n + 2), 16))
  const pixels = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let covered = 0
    for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
      const px = (x + (sx + 0.5) / 3) / 3
      const py = (y + (sy + 0.5) / 3) / 3
      const hit = lines.some((points) => points.slice(1).some((b, i) => {
        const a = points[i], dx = b[0] - a[0], dy = b[1] - a[1]
        const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy || 1)))
        return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy) < 0.85
      }))
      if (hit) covered++
    }
    const offset = y * (size * 4 + 1) + 1 + x * 4
    rgba.forEach((value, i) => { pixels[offset + i] = value })
    pixels[offset + 3] = Math.round(covered / 9 * 255)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}
for (const [name, lines] of Object.entries(icons)) {
  for (const [suffix, color] of Object.entries(colors)) fs.writeFileSync(path.join(out, name + suffix + '.png'), render(lines, color))
}
console.log('Generated 20 local navigation icons')
