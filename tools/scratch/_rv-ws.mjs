import { WebSocket } from 'ws';
const ZW = '​';
// Names the CLIENT enables (cleaned length 1..16). Server must never BAD_NAME them.
const names = [
  'abcdefghijklmnop',   // 16+ZWSP cleans to this
  'a b',                // a+20sp+b cleans to this
  'Ada',
  'aaaaaaaaaaaaaaab',   // 15+ZWSP+1
  '\u{1F44D}\u{1F44D}\u{1F44D}\u{1F44D}',
];
// Also send the RAW strings the client would put on the wire (client sends the cleaned name)
for (const n of names) {
  await new Promise((res) => {
    const ws = new WebSocket('ws://localhost:5274');
    const seen = [];
    const t = setTimeout(() => { console.log(JSON.stringify({ name: n, seen, verdict: 'TIMEOUT' })); ws.close(); res(); }, 4000);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name: n })));
    ws.on('message', (d) => {
      const f = JSON.parse(d.toString());
      seen.push(f.t + (f.code ? ':' + f.code : ''));
      if (f.t === 'hello' || f.t === 'welcome' || f.t === 'error') {
        ws.send(JSON.stringify({ t: 'create' }));
      }
      if (f.t === 'joined') {
        clearTimeout(t);
        console.log(JSON.stringify({ name: n, seen, serverName: f.players?.find((p) => p.id === f.you)?.name, verdict: 'JOINED_OK' }));
        ws.close(); res();
      }
      if (f.t === 'error') {
        clearTimeout(t);
        console.log(JSON.stringify({ name: n, seen, verdict: 'SERVER_REJECTED:' + f.code }));
        ws.close(); res();
      }
    });
    ws.on('error', (e) => { clearTimeout(t); console.log(JSON.stringify({ name: n, err: e.message })); res(); });
  });
}
