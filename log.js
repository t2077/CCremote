const WebSocket = require('ws');

const URL = 'wss://localhost/logs/ws';
let ws;

function connect() {
  ws = new WebSocket(URL);
  ws.on('open', () => console.log('[+] Connected to', URL));
  ws.on('message', data => {
    try {
      const obj = JSON.parse(data.toString());
      const ts = obj.time ? obj.time.slice(11, 19) : '';
      if (obj.level === 'error') {
        console.error(`[${ts}] ${obj.msg}`);
      } else {
        console.log(`[${ts}] ${obj.msg}`);
      }
    } catch {
      process.stdout.write(data);
    }
  });
  ws.on('close', () => {
    console.error('[-] Disconnected, reconnecting in 2s...');
    setTimeout(connect, 2000);
  });
  ws.on('error', e => {
    console.error('[-] Error:', e.message);
    ws.close();
  });
}

connect();
