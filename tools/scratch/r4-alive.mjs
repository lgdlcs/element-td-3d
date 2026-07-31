import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
let bad = 0;
page.on('console', (m) => { if (m.type() === 'error' || m.text().includes('not valid')) bad++; });
await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;' }));
try {
  await page.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__game, null, { timeout: 60000 });
  await page.waitForTimeout(3000);
  const buf = await page.screenshot({ type: 'png', timeout: 60000 });
  const lum = await page.evaluate(async (b64) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const d = x.getImageData(160, 120, 320, 200).data;
    let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
    return +(s / (d.length / 4) / 3).toFixed(1);
  }, buf.toString('base64'));
  console.log(JSON.stringify({ lum, badLogs: bad }));
} catch (e) { console.log(JSON.stringify({ lum: -1, err: e.message.slice(0, 80) })); }
await browser.close();
