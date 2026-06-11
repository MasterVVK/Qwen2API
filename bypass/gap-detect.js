// Detect the puzzle-gap X (left edge, image-pixel coords) for an Aliyun
// slider-puzzle by EDGE-TEMPLATE MATCHING: correlate the piece's edge structure
// (its puzzle outline) against the background's horizontal-gradient edge map.
// The notch's vertical borders produce a strong horizontal gradient that aligns
// with the piece outline at the correct X. Robust to scene content. pngjs only.
const fs = require('fs')
const { PNG } = require('pngjs')
const readPNG = p => PNG.sync.read(fs.readFileSync(p))

function gradMap(png) {
    const { width: W, height: H, data } = png
    const g = (x, y) => { const i = (y * W + x) * 4; return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] }
    const e = new Float32Array(W * H)
    for (let y = 0; y < H; y++) for (let x = 1; x < W; x++) e[y * W + x] = Math.abs(g(x, y) - g(x - 1, y))
    return { e, W, H }
}

function pieceTemplate(piece) {
    const { width: W, height: H, data } = piece
    // bounding box of opaque region
    let x0 = W, x1 = 0, y0 = H, y1 = 0
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (data[(y * W + x) * 4 + 3] > 40) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
    const { e } = gradMap(piece)
    // template edges within bbox (only opaque pixels)
    const tw = x1 - x0 + 1, th = y1 - y0 + 1
    const tmpl = []
    for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
        const sx = x0 + tx, sy = y0 + ty
        if (data[(sy * W + sx) * 4 + 3] > 40) { const ev = e[sy * W + sx]; if (ev > 12) tmpl.push({ tx, ty: sy, ev }) }
    }
    return { tmpl, x0, y0, tw, th }
}

// piece opaque Y-band + width
function pieceBand(piece) {
    const { width: W, height: H, data } = piece
    let y0 = H, y1 = 0, x0 = W, x1 = 0
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (data[(y * W + x) * 4 + 3] > 40) { if (y < y0) y0 = y; if (y > y1) y1 = y; if (x < x0) x0 = x; if (x > x1) x1 = x }
    return { y0, y1, pw: x1 - x0 + 1 }
}

// method A: sharpest brightness rise (left border of the washed/light notch) in the piece Y-band
function brightnessStep(bg, band) {
    const { width: W, data } = bg
    const br = x => { let s = 0, n = 0; for (let y = band.y0; y <= band.y1; y++) { const i = (y * W + x) * 4; s += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; n++ } return s / n }
    const b = []; for (let x = 0; x < W; x++) b.push(br(x))
    const sm = x => { let s = 0, n = 0; for (let k = -2; k <= 2; k++) { const xi = x + k; if (xi >= 0 && xi < W) { s += b[xi]; n++ } } return s / n }
    let best = { d: -1, x: -1 }
    for (let x = band.pw + 4; x < W - band.pw; x++) { const d = sm(x + 3) - sm(x - 3); if (d > best.d) best = { d, x } }
    return best.x
}

// method B: edge-template match of the piece outline against bg horizontal-gradient
function templateMatch(bg, piece, band) {
    const { e: be, W } = gradMap(bg)
    const t = pieceTemplate(piece)
    if (!t.tmpl.length) return -1
    let best = { score: -1, x: -1 }
    for (let X = t.tw; X <= W - t.tw; X++) {
        let s = 0; for (const p of t.tmpl) { const bx = X + p.tx; if (bx >= 0 && bx < W) s += p.ev * be[p.ty * W + bx] }
        if (s > best.score) best = { score: s, x: X }
    }
    return best.x
}

function detectGap(bgPath, piecePath) {
    const bg = readPNG(bgPath), piece = readPNG(piecePath)
    const band = pieceBand(piece)
    const a = brightnessStep(bg, band)
    const b = templateMatch(bg, piece, band)
    // brightness-step (sharp left border of the washed/light notch) is the reliable
    // signal; edge-template gets fooled by scene structure (trees). Use brightness,
    // but if the two agree closely, average for a touch more precision.
    let gapX = a
    if (a >= 0 && b >= 0 && Math.abs(a - b) <= 6) gapX = Math.round((a + b) / 2)
    return { gapX, methodA: a, methodB: b, W: bg.width, band }
}

if (require.main === module) {
    const r = detectGap(process.argv[2] || '/tmp/cap-bg.png', process.argv[3] || '/tmp/cap-piece.png')
    console.log(`gapX=${r.gapX}  (brightness=${r.methodA} template=${r.methodB})  W=${r.W} band=${JSON.stringify(r.band)}`)
}
module.exports = { detectGap }
