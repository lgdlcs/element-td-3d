/** Does the live deploy serve the lobby socket over wss on the same origin? */
import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--mute-audio','--hide-scrollbars'] });
const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
const sockets = [];
p.on('websocket', (ws) => sockets.push(ws.url()));
await p.goto('https://element-td-3d.onrender.com/?mp');
await p.waitForFunction(() => window.__lobby, null, { timeout: 150000 });
await p.waitForTimeout(6000);
console.log('sockets:', sockets);
console.log(JSON.stringify(await p.evaluate(() => ({
  connection: window.__lobby.connection,
  netState: window.__net.state,
  hall: document.getElementById('lobby')?.dataset.hall,
  status: document.getElementById('lobby-hall-status')?.textContent,
}))));
await b.close();
