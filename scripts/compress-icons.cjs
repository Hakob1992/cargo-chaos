// One-off: compress source art (from Downloads) into small square card icons.
// Run with: node scripts/compress-icons.cjs
const Jimp = require('jimp');
const path = require('path');

const SRC = 'C:/Users/PC/Downloads';
const OUT = path.join(__dirname, '..', 'public', 'icons');
const SIZE = 256;
const QUALITY = 82;

const jobs = [
  ['Cardboard_Boxes.png', 'boxes.jpg'],
  ['hf_20260613_091553_b00fcc00-fadc-441d-a150-6ac603b6a9b8.png', 'dino-egg.jpg'],
];

(async () => {
  for (const [src, out] of jobs) {
    const img = await Jimp.read(path.join(SRC, src));
    const s = Math.min(img.bitmap.width, img.bitmap.height);
    const x = Math.floor((img.bitmap.width - s) / 2);
    const y = Math.floor((img.bitmap.height - s) / 2);
    img.crop(x, y, s, s).resize(SIZE, SIZE).quality(QUALITY);
    const dest = path.join(OUT, out);
    await img.writeAsync(dest);
    console.log('wrote', dest);
  }
})().catch((e) => { console.error(e); process.exit(1); });
