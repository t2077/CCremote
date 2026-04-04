/**
 * CC Local Server
 *
 * Supabase Broadcast 中继服务器
 * 需要设置环境变量:
 *   SUPABASE_URL=你的Supabase项目URL
 *   SUPABASE_KEY=你的PublishableKey
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============== Supabase 配置（从环境变量读取） ==============
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const CHANNEL_NAME = 'cc-bridge-channel';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[-] 必须设置 SUPABASE_URL 和 SUPABASE_KEY 环境变量');
  console.error('[-] 示例: SUPABASE_URL=https://xxx.supabase.co SUPABASE_KEY=your_key node server.js');
  process.exit(1);
}

// ============== Supabase 客户端 ==============
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
let channel = null;

// ============== Express App ==============
const app = express();
app.use(cors());
app.use(express.json());

// 屏蔽根目录
app.get('/', (req, res) => res.status(204).send());

// 日志中间件
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} → ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// 测试路由
app.get('/test', (req, res) => res.json({test: true}));

// ============== RSA 密钥对 ==============
const keyDir = path.join(__dirname, 'keys');
const privateKeyPath = path.join(keyDir, 'private.pem');
const publicKeyPath = path.join(keyDir, 'public.pem');

let privateKey, publicKey;

try {
  if (fs.existsSync(privateKeyPath)) {
    privateKey = fs.readFileSync(privateKeyPath, 'utf8');
    publicKey = fs.readFileSync(publicKeyPath, 'utf8');
    console.log('[+] Loaded existing RSA keys');
  } else {
    const { publicKey: pub, privateKey: priv } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    privateKey = priv;
    publicKey = pub;
    fs.mkdirSync(keyDir, { recursive: true });
    fs.writeFileSync(privateKeyPath, privateKey);
    fs.writeFileSync(publicKeyPath, publicKey);
    console.log('[+] Generated and saved new RSA keys');
  }
} catch (e) {
  console.error('[-] Key loading error:', e.message);
}

// ============== 工具函数 ==============
function signJwt(payload, secret = privateKey) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sign = crypto.createHmac('sha256', secret);
  sign.update(`${header}.${payloadB64}`);
  const signature = sign.digest('base64url');
  return `${header}.${payloadB64}.${signature}`;
}

function createAccessToken(userId = 'local-user', email = 'local@example.com') {
  const payload = {
    sub: userId,
    email: email,
    iss: 'cc-online',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload'],
    subscriptionType: 'pro',
    rateLimitTier: 'standard'
  };
  return signJwt(payload);
}

function createWorkerJwt(sessionId) {
  const payload = {
    session_id: sessionId,
    role: 'worker',
    iss: 'cc-online',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  return signJwt(payload);
}

// ============== OAuth Endpoints ==============
app.get('/oauth/authorize', (req, res) => {
  if (req.headers.accept?.includes('application/json')) {
    const authCode = crypto.randomBytes(32).toString('hex');
    return res.json({ code: authCode, redirect_uri: req.query.redirect_uri });
  }
  const { redirect_uri } = req.query;
  const authCode = crypto.randomBytes(32).toString('hex');
  const callbackUrl = new URL(redirect_uri || 'http://localhost:8080/callback');
  callbackUrl.searchParams.set('code', authCode);
  callbackUrl.searchParams.set('state', '');
  if (redirect_uri?.includes('localhost')) {
    res.send(`<html><body><h1>Local OAuth</h1><p>Code: <code>${authCode}</code></p><script>window.location = "${callbackUrl.toString()}"</script></body></html>`);
  } else {
    res.redirect(callbackUrl.toString());
  }
});

app.get('/oauth/code/callback', (req, res) => {
  const { code, state } = req.query;
  res.send(`<html><body><h1>Authorization Successful</h1><p>Copy this code:</p><textarea id="code" rows="3" style="width:100%">${code}#${state}</textarea><script>const textarea = document.getElementById('code'); textarea.select(); document.execCommand('copy'); alert('Code copied to clipboard!');</script></body></html>`);
});

app.post('/v1/oauth/token', (req, res) => {
  const { grant_type, client_id } = req.body;
  if (grant_type === 'authorization_code' || grant_type === 'refresh_token') {
    const accessToken = createAccessToken();
    const refreshToken = crypto.randomBytes(32).toString('hex');
    res.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600,
      scope: 'user:inference user:profile user:sessions:claude_code user:mcp_servers user:file_upload',
      token_type: 'Bearer'
    });
  } else {
    res.status(400).json({ error: 'unsupported_grant_type' });
  }
});

app.get('/api/oauth/profile', (req, res) => {
  res.json({
    account: { uuid: '00000000-0000-0000-0000-000000000001', email: 'local@example.com', display_name: 'Local User', created_at: '2024-01-01T00:00:00.000Z' },
    organization: { uuid: '00000000-0000-0000-0000-000000000002', name: 'Local Organization', billing_type: 'pro', subscription_created_at: '2024-01-01T00:00:00.000Z', has_extra_usage_enabled: true }
  });
});

app.get('/api/claude_cli_profile', (req, res) => {
  res.json({
    account_uuid: '00000000-0000-0000-0000-000000000001',
    email_address: 'local@example.com',
    organization_uuid: '00000000-0000-0000-0000-000000000002',
    organization_name: 'Local Organization',
    display_name: 'Local User',
    billing_type: 'pro',
    account_created_at: '2024-01-01T00:00:00.000Z',
    subscription_created_at: '2024-01-01T00:00:00.000Z',
    has_extra_usage_enabled: true
  });
});

// ============== Bridge 协议端点 ==============
let activeSessionId = null;
let currentEnvId = null;
let workerEpoch = 1;
let sseRes = null;
let sseSessionId = null;

// ============== Supabase Broadcast 消息处理 ==============
function setupSupabaseChannel() {
  channel = supabase.channel(CHANNEL_NAME);
  channel
    .on('broadcast', { event: 'frontend_to_server' }, (payload) => {
      handleFrontendMessage(payload.payload);
    })
    .subscribe((status) => {
      console.log(`[Supabase] Channel subscription status: ${status}`);
      if (status === 'SUBSCRIBED') {
        console.log('[+] Supabase Broadcast channel ready');
      } else if (status === 'CHANNEL_ERROR' || status === 'CLOSED') {
        console.error('[-] Supabase channel error');
      }
    });
}

function handleFrontendMessage(data) {
  console.log('[Supabase] Received from frontend:', data.type);
  try {
    if (data.type === 'message' && data.text) {
      sendToClaudeCode(data.text);
      broadcastToFrontends({ type: 'user', text: data.text });
    } else if (data.type === 'control_response') {
      sendControlResponseToClaudeCode(data);
    }
  } catch (e) {
    console.error('[-] Handle frontend message error:', e.message);
  }
}

function broadcastToFrontends(data) {
  if (!channel) return;
  channel.send({
    type: 'broadcast',
    event: 'server_to_frontend',
    payload: { ...data, _ts: Date.now() }
  }).catch(err => {
    console.error('[-] Broadcast error:', err.message);
  });
}

function sendToClaudeCode(text) {
  if (!sseRes || !sseSessionId) {
    console.log('[Bridge] No SSE connection to Claude Code');
    return false;
  }
  const eventPayload = {
    type: 'user',
    uuid: crypto.randomUUID(),
    session_id: sseSessionId,
    message: { role: 'user', content: text }
  };
  const streamEvent = {
    event_id: crypto.randomUUID(),
    sequence_num: 1,
    event_type: 'user',
    source: 'server',
    payload: eventPayload,
    created_at: new Date().toISOString()
  };
  try {
    sseRes.write(`event: client_event\nid: ${streamEvent.sequence_num}\ndata: ${JSON.stringify(streamEvent)}\n\n`);
    return true;
  } catch (e) {
    console.log('[Bridge] Failed to send to Claude Code:', e.message);
    return false;
  }
}

function sendControlResponseToClaudeCode(data) {
  if (!sseRes || !sseSessionId) return false;
  const eventPayload = {
    type: 'control_response',
    uuid: crypto.randomUUID(),
    request_id: data.response?.request_id || data.request_id,
    response: data.response
  };
  const streamEvent = {
    event_id: crypto.randomUUID(),
    sequence_num: 1,
    event_type: 'control_response',
    source: 'frontend',
    payload: eventPayload,
    created_at: new Date().toISOString()
  };
  try {
    sseRes.write(`event: client_event\nid: ${streamEvent.sequence_num}\ndata: ${JSON.stringify(streamEvent)}\n\n`);
    return true;
  } catch (e) {
    return false;
  }
}

// ============== Bridge 核心端点 ==============
app.post('/v1/sessions', (req, res) => {
  activeSessionId = 'session_' + crypto.randomBytes(16).toString('hex');
  res.json({ id: activeSessionId, title: 'Online Session', created_at: new Date().toISOString() });
});

app.get('/v1/sessions/:id', (req, res) => {
  res.json({ id: activeSessionId, environment_id: currentEnvId, title: 'Online Session', created_at: new Date().toISOString() });
});

app.post('/v1/sessions/:id/archive', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/v1/environments/bridge', (req, res) => {
  const { environment_id } = req.body;
  currentEnvId = environment_id || 'env_' + crypto.randomBytes(8).toString('hex');
  res.json({ environment_id: currentEnvId, environment_secret: 'online-secret' });
});

app.delete('/v1/environments/bridge/:id', (req, res) => {
  res.status(204).send();
});

app.get('/v1/environments/:envId/work/poll', (req, res) => {
  const { envId } = req.params;
  const workSecret = {
    version: 1,
    session_ingress_token: createAccessToken(),
    api_base_url: `https://localhost`,
    use_code_sessions: true,
    sources: [],
    auth: [{ type: 'oauth', token: createAccessToken() }]
  };
  const workId = 'work_' + crypto.randomBytes(8).toString('hex');
  res.json({
    id: workId,
    type: 'work',
    environment_id: envId,
    state: 'pending',
    data: { type: 'session', id: activeSessionId },
    secret: Buffer.from(JSON.stringify(workSecret)).toString('base64url'),
    created_at: new Date().toISOString()
  });
});

app.post('/v1/environments/:envId/work/:workId/ack', (req, res) => res.json({ status: 'ok' }));
app.post('/v1/environments/:envId/work/:workId/stop', (req, res) => res.json({ status: 'ok' }));

// ============== CCR v2 端点 ==============
app.post('/v1/code/sessions/:sessionId/bridge', (req, res) => {
  res.json({
    worker_jwt: createWorkerJwt(req.params.sessionId),
    api_base_url: `https://localhost`,
    expires_in: 3600,
    worker_epoch: workerEpoch
  });
});

app.put('/v1/code/sessions/:sessionId/worker', (req, res) => res.json({ ok: true }));
app.get('/v1/code/sessions/:sessionId/worker', (req, res) => res.json({ worker: { external_metadata: null } }));

app.post('/v1/code/sessions/:sessionId/worker/register', (req, res) => {
  res.json({ worker_epoch: workerEpoch++ });
});

app.post('/v1/code/sessions/:sessionId/worker/heartbeat', (req, res) => {
  res.json({ lease_extended: true, state: 'active', ttl_seconds: 300 });
});

app.get('/v1/code/sessions/:sessionId/worker/events/stream', (req, res) => {
  const { sessionId } = req.params;
  const isReconnect = sseRes !== null;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  res.write(`:connected\n\n`);
  sseRes = res;
  sseSessionId = sessionId;
  if (isReconnect) {
    broadcastToFrontends({ type: 'sse_reconnect', text: `SSE 重连成功 (session: ${sessionId})` });
  }
  req.on('close', () => {
    if (sseRes === res) {
      sseRes = null;
      sseSessionId = null;
    }
  });
});

app.post('/v1/code/sessions/:sessionId/worker/events', (req, res) => {
  const events = req.body.events || [];
  for (const event of events) {
    broadcastToFrontends({ type: 'event', data: event });
  }
  res.json({ status: 'ok' });
});

app.post('/v1/code/sessions/:sessionId/worker/events/delivery', (req, res) => res.json({ status: 'ok' }));

app.post('/v1/code/sessions/:sessionId/worker/internal-events', (req, res) => {
  const events = req.body.events || [];
  for (const event of events) {
    broadcastToFrontends({ type: 'internal_event', data: event });
  }
  res.json({ status: 'ok' });
});

// ============== 启动服务器 ==============
const httpsOptions = {
  key: fs.readFileSync(path.join(__dirname, 'key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'cert.pem'))
};

const server = https.createServer(httpsOptions, app);

server.listen(443, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║        CC Online Server (HTTPS on 443)                    ║
╠════════════════════════════════════════════════════════════╣
║  Supabase:    ${SUPABASE_URL.substring(0, 30)}...  ║
║  Channel:     ${CHANNEL_NAME}                        ║
╚════════════════════════════════════════════════════════════╝
  `);
});

setupSupabaseChannel();

process.on('SIGINT', async () => {
  console.log('\n[-] Shutting down...');
  if (channel) await supabase.removeChannel(channel);
  server.close(() => process.exit(0));
});
