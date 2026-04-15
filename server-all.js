/**
 * cc-local-bridge
 *
 * 本地 Bridge 代理服务器，模拟官方 Claude Code Bridge 功能
 * 支持双渠道：Supabase Broadcast + Cloudflare Durable Objects WebSocket
 * 使用 CommonJS 模式，可以直接使用全局安装的包
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============== 日志 WebSocket 服务 ==============
const _console = { log: console.log.bind(console), error: console.error.bind(console) };
const logBuffer = [];
const logWsClients = new Set();

function broadcastLog(level, ...args) {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  const entry = { time: new Date().toISOString(), level, msg };
  logBuffer.push(entry);
  // 保持终端输出
  if (level === 'error') _console.error(...args);
  else _console.log(...args);
  // 推 WebSocket
  const data = JSON.stringify(entry) + '\n';
  for (const c of logWsClients) {
    if (c.readyState === 1) c.send(data);
  }
}

function initLogWs(httpServer) {
  const { Server } = require('ws');
  const wss = new Server({ server: httpServer, path: '/logs/ws' });
  wss.on('connection', ws => {
    logWsClients.add(ws);
    for (const e of logBuffer) ws.send(JSON.stringify(e) + '\n');
    ws.on('close', () => logWsClients.delete(ws));
  });
}

// ============== 拦截 console ==============
console.log = (...a) => broadcastLog('log', ...a);
console.error = (...a) => broadcastLog('error', ...a);

// ============== 双渠道配置（从环境变量读取） ==============
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const DO_WS_URL = process.env.DO_WS_URL;
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
const CHANNEL_NAME = 'cc-bridge-channel';

// 渠道检测
const hasSupabase = !!(SUPABASE_URL && SUPABASE_KEY);
const hasCloudflare = !!DO_WS_URL;

if (!hasSupabase && !hasCloudflare) {
  console.error('[-] 必须设置至少一个渠道的环境变量:');
  console.error('[-]   Supabase: SUPABASE_URL 和 SUPABASE_KEY');
  console.error('[-]   Cloudflare: DO_WS_URL');
  console.error('[-] 示例 (Supabase): SUPABASE_URL=https://xxx.supabase.co SUPABASE_KEY=your_key node server.js');
  console.error('[-] 示例 (Cloudflare): DO_WS_URL=wss://xxx.workers.dev/ws node server.js');
  process.exit(1);
}
if (!MINIMAX_API_KEY) {
  console.error('[-] 必须设置 MINIMAX_API_KEY 环境变量');
  process.exit(1);
}

// ============== Supabase 客户端（可选） ==============
let supabase = null;
let channel = null;
if (hasSupabase) {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
}

// ============== Cloudflare WebSocket 客户端 ==============
const WebSocket = require('ws');
let ws = null;

// ============== 配置 ==============

const PORT = process.env.PORT || 8080;

// ============== RSA 密钥对 ==============

const keyDir = path.join(__dirname, 'keys');
const privateKeyPath = path.join(keyDir, 'private.pem');
const publicKeyPath = path.join(keyDir, 'public.pem');

let privateKey, publicKey;

try {
  // 尝试从文件加载（如果存在）
  if (fs.existsSync(privateKeyPath)) {
    privateKey = fs.readFileSync(privateKeyPath, 'utf8');
    publicKey = fs.readFileSync(publicKeyPath, 'utf8');
    console.log('[+] Loaded existing RSA keys');
  } else {
    // 生成新的密钥对
    const { publicKey: pub, privateKey: priv } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    privateKey = priv;
    publicKey = pub;

    // 保存到文件（持久化）
    fs.mkdirSync(keyDir, { recursive: true });
    fs.writeFileSync(privateKeyPath, privateKey);
    fs.writeFileSync(publicKeyPath, publicKey);
    console.log('[+] Generated and saved new RSA keys');
  }
} catch (e) {
  console.error('[-] Key loading error:', e.message);
}

// ============== 工具函数 ==============

/**
 * 生成 UUID 格式的 ID
 */
function generateId(prefix = 'cse') {
  const hex = crypto.randomBytes(16).toString('hex');
  return `${prefix}_${hex}`;
}

/**
 * 签发 JWT (RS256 HMAC 签名)
 */
function signJwt(payload, secret = privateKey) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');

  const sign = crypto.createHmac('sha256', secret);
  sign.update(`${header}.${payloadB64}`);
  const signature = sign.digest('base64url');

  return `${header}.${payloadB64}.${signature}`;
}

/**
 * 创建 OAuth Access Token
 */
function createAccessToken(userId = 'local-user', email = 'local@example.com') {
  const payload = {
    sub: userId,
    email: email,
    iss: 'cc-local-bridge',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload'],
    subscriptionType: 'max',
    rateLimitTier: 'standard'
  };
  return signJwt(payload);
}

/**
 * 创建 Worker JWT
 */
function createWorkerJwt(sessionId) {
  const payload = {
    session_id: sessionId,
    role: 'worker',
    iss: 'cc-local-bridge',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  return signJwt(payload);
}

// ============== Express App ==============

const app = express();
app.use(cors());

// 增加 body 大小限制（支持大请求）
app.use(express.json({ limit: '50mb' }));

// 屏蔽根目录
app.get('/', (req, res) => res.status(204).send());

// 日志中间件（包含请求体打印）
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    // 404 时打印完整请求信息
    if (res.statusCode === 404 && req.method === 'POST') {
      console.log(`\n[404 DEBUG] ${req.method} ${req.path}`);
      console.log('Headers:', JSON.stringify(req.headers, null, 2));
      if (req.body && Object.keys(req.body).length > 0) {
        console.log('Body:', JSON.stringify(req.body, null, 2).substring(0, 3000));
      }
    }
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} → ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// 测试路由
app.get('/test', (req, res) => res.json({test: true}));

// ============== Claude Code 探测端点 ==============

/**
 * GET /api/hello
 * Claude Code 探测端点
 */
app.get('/api/hello', (req, res) => {
  res.json({ status: 'ok' });
});

/**
 * GET /v1/oauth/hello
 * OAuth 探测端点
 */
app.get('/v1/oauth/hello', (req, res) => {
  res.json({ status: 'ok' });
});

/**
 * GET /api/organization/claude_code_first_token_date
 * 获取用户首次使用 Claude Code 的日期（可选端点）
 */
app.get('/api/organization/claude_code_first_token_date', (req, res) => {
  res.json({ first_token_date: null });
});

// ============== 遥测/日志端点（返回 200 避免 404） ==============

/**
 * POST /api/event_logging/batch
 * 遥测事件，接受但不处理
 */
app.post('/api/event_logging/batch', (req, res) => {
  console.log('[Telemetry] Event batch received:', req.body?.events?.length || 0, 'events');
  res.json({ status: 'ok' });
});

/**
 * GET /api/claude_code/settings
 * 远程托管设置，返回空配置
 */
app.get('/api/claude_code/settings', (req, res) => {
  setTimeout(() => {
    console.log('[Settings] Remote settings requested');
    res.json({ settings: {} });
  }, 1000);
});

/**
 * POST /api/eval/:key
 * GrowthBook 评估，接受但不处理
 */
app.post('/api/eval/:key', (req, res) => {
  console.log('[Eval] GrowthBook eval:', req.params.key);
  res.json({ evaluations: {} });
});

// ============== CCR v2 会话端点 ==============

/**
 * POST /v1/code/sessions
 * 创建 session（env-less 模式）
 */
app.post('/v1/code/sessions', (req, res) => {
  setTimeout(() => {
    const sessionId = 'cse_' + crypto.randomBytes(16).toString('hex');
    console.log('[CCR_v2] Create session:', sessionId);
    res.json({ session: { id: sessionId } });
  }, 1000);
});

/**
 * POST /api/organizations/:orgId/claude_code/buddy_react
 * Buddy/宠物功能，返回空响应
 */
app.post('/api/organizations/:orgId/claude_code/buddy_react', (req, res) => {
  console.log('[Buddy] React request:', req.body?.name || 'unknown');
  res.json({ ok: true });
});

// ============== Minimax AI API 代理 ==============

/**
 * POST /v1/messages
 * 代理到 MiniMax API (直接转发，只改 base URL 和模型名)
 */
app.post('/v1/messages', async (req, res) => {
  console.log('[MiniMax] Proxying /v1/messages to MiniMax');

  const body = req.body;

  // 模型名称转换
  const model = 'minimax-M2.7';

  // 直接修改请求体中的模型名
  const modifiedBody = {
    ...body,
    model: model
  };

  console.log('[MiniMax] Model changed to:', model);

  const options = {
    hostname: 'api.minimaxi.com',
    port: 443,
    path: '/anthropic/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${MINIMAX_API_KEY}`
    }
  };

  const proxyReq = https.request(options, (proxyRes) => {
    console.log(`[MiniMax] Response status: ${proxyRes.statusCode}`);

    if (body.stream && proxyRes.headers['content-type']?.includes('text/event-stream')) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      proxyRes.pipe(res);
    } else {
      let data = '';
      proxyRes.on('data', chunk => { data += chunk; });
      proxyRes.on('end', () => {
        console.log(`[MiniMax] Response: ${data.substring(0, 500)}`);
        try {
          res.status(proxyRes.statusCode).json(JSON.parse(data));
        } catch (e) {
          res.status(proxyRes.statusCode).send(data);
        }
      });
    }
  });

  proxyReq.on('error', (err) => {
    console.error('[MiniMax] Proxy error:', err.message);
    res.status(500).json({ error: err.message });
  });

  proxyReq.write(JSON.stringify(modifiedBody));
  proxyReq.end();
});

// ============== OAuth Endpoints ==============

/**
 * GET /oauth/authorize
 * 模拟 OAuth 授权页面
 */
app.get('/oauth/authorize', (req, res) => {
  // 对于 API 请求（Fetch），直接返回 JSON 格式的 code
  if (req.headers.accept?.includes('application/json')) {
    const authCode = crypto.randomBytes(32).toString('hex');
    console.log('[OAuth] Authorization code issued:', authCode);
    return res.json({ code: authCode, redirect_uri: req.query.redirect_uri });
  }

  // 对于浏览器请求，显示登录页
  const { redirect_uri } = req.query;
  const authCode = crypto.randomBytes(32).toString('hex');
  const callbackUrl = new URL(redirect_uri || 'http://localhost:8080/callback');
  callbackUrl.searchParams.set('code', authCode);
  callbackUrl.searchParams.set('state', '');

  console.log('[OAuth] Authorization code issued:', authCode);

  if (redirect_uri?.includes('localhost')) {
    res.send(`
      <html><body>
        <h1>Local OAuth</h1>
        <p>Code: <code>${authCode}</code></p>
        <script>window.location = "${callbackUrl.toString()}"</script>
      </body></html>
    `);
  } else {
    res.redirect(callbackUrl.toString());
  }
});

/**
 * GET /oauth/code/callback
 * 拦截 platform.claude.com 的 OAuth 回调
 */
app.get('/oauth/code/callback', (req, res) => {
  const { code, state } = req.query;
  console.log(`[OAuth Callback] code=${code}, state=${state}`);

  // 返回成功页面，包含 code#state 格式（Claude Code 期望的粘贴格式）
  res.send(`
    <html>
    <body>
      <h1>Authorization Successful</h1>
      <p>Copy this code:</p>
      <textarea id="code" rows="3" style="width:100%">${code}#${state}</textarea>
      <script>
        // 自动复制到剪贴板
        const textarea = document.getElementById('code');
        textarea.select();
        document.execCommand('copy');
        alert('Code copied to clipboard!');
      </script>
    </body>
    </html>
  `);
});

/**
 * POST /v1/oauth/token
 * 模拟 OAuth token 端点 - 签发 access_token
 */
app.post('/v1/oauth/token', (req, res) => {
  const { grant_type, code, client_id, code_verifier, redirect_uri } = req.body;

  console.log(`[OAuth] Token request: grant_type=${grant_type}, client_id=${client_id}`);

  if (grant_type === 'authorization_code' || grant_type === 'refresh_token') {
    // 签发 access token
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

/**
 * GET /api/oauth/profile
 * 模拟 OAuth profile 端点 - 使用正确的嵌套结构
 */
app.get('/api/oauth/profile', (req, res) => {
  console.log('[OAuth] Profile request');
  res.json({
    account: {
      uuid: '00000000-0000-0000-0000-000000000001',
      email: 'local@example.com',
      display_name: 'Local User',
      created_at: '2024-01-01T00:00:00.000Z'
    },
    organization: {
      uuid: '00000000-0000-0000-0000-000000000002',
      name: 'Local Organization',
      billing_type: 'max',
      subscription_created_at: '2024-01-01T00:00:00.000Z',
      has_extra_usage_enabled: true
    }
  });
});

/**
 * GET /api/claude_cli_profile
 * 模拟 CLI profile 端点
 */
app.get('/api/claude_cli_profile', (req, res) => {
  console.log('[OAuth] CLI Profile request');
  res.json({
    account_uuid: '00000000-0000-0000-0000-000000000001',
    email_address: 'local@example.com',
    organization_uuid: '00000000-0000-0000-0000-000000000002',
    organization_name: 'Local Organization',
    display_name: 'Local User',
    billing_type: 'max',
    account_created_at: '2024-01-01T00:00:00.000Z',
    subscription_created_at: '2024-01-01T00:00:00.000Z',
    has_extra_usage_enabled: true
  });
});

/**
 * GET /api/oauth/claude_cli/roles
 * 返回用户组织角色，用于计费权限判断
 */
app.get('/api/oauth/claude_cli/roles', (req, res) => {
  console.log('[OAuth] Roles request');
  res.json({
    organization_role: 'admin',
    workspace_role: 'workspace_admin',
    organization_name: 'Local Organization'
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//                           BRIDGE 协议端点
// ══════════════════════════════════════════════════════════════════════════════

// 极简状态管理 - 证据 #7, #10: 官方只有1个 session，用 sameSessionId() 处理 cse_/session_ 格式差异
let activeSessionId = null;    // 单一活跃 session ID（可能是 cse_* 或 session_* 格式）
let currentEnvId = null;
let workerEpoch = 1;
let sseRes = null;
let sseSessionId = null;       // SSE 对应的 session ID
const pendingControlRequests = new Map();  // 追踪所有 pending 的 control_request

// ============== 双渠道消息处理 ==============

// ---- Supabase 渠道 ----
const RECONNECT_DELAY = 3000;  // 重连间隔 3 秒
let supabaseReconnecting = false;

async function cleanupSupabaseChannel() {
  if (channel) {
    await supabase.removeChannel(channel).catch(() => {});
    channel = null;
  }
}

function setupSupabaseChannel() {
  if (!hasSupabase) return;

  channel = supabase.channel(CHANNEL_NAME);

  channel
    .on('broadcast', { event: 'frontend_to_server' }, (payload) => {
      handleFrontendMessage(payload.payload);
    })
    .subscribe((status) => {
      console.log(`[Supabase] Channel subscription status: ${status}`);
      if (status === 'SUBSCRIBED') {
        console.log('[+] Supabase Broadcast channel ready');
        supabaseReconnecting = false;
      } else if (status === 'CHANNEL_ERROR' || status === 'CLOSED' || status === 'TIMED_OUT') {
        console.error(`[-] Supabase channel ${status}, will reconnect in`, RECONNECT_DELAY / 1000, 's');
        if (!supabaseReconnecting) {
          supabaseReconnecting = true;
          // 立刻清空 channel，等3秒后再重连
          ;(async () => {
            await cleanupSupabaseChannel();
            await new Promise(r => setTimeout(r, RECONNECT_DELAY));
            console.log('[Supabase] Reconnecting...');
            supabaseReconnecting = false;
            setupSupabaseChannel();
          })();
        }
      }
    });
}

// ---- Cloudflare Durable Objects WebSocket 渠道 ----
let isCfReconnecting = false;
let heartbeatTimer = null;
let heartbeatTimeoutTimer = null;
const wsPool = [];  // 记录所有活跃的 WebSocket 连接
function Poolkick(targetWs) {
  const idx = wsPool.indexOf(targetWs);
  if (idx !== -1) wsPool.splice(idx, 1);
  else console.error('[Poolkick] targetWs not found in pool');
}

function cleanupWs() {
  const poolSnapshot = [...wsPool];
  for (const targetWs of poolSnapshot) {
    silentCloseWs(targetWs);
  }
  if (wsPool.length > 0) {
    console.error('[cleanupWs] pool not empty after close, count:', wsPool.length);
  }
}

const HEARTBEAT_INTERVAL = 10000;  // 10 秒心跳
const HEARTBEAT_TIMEOUT = 5000;  // 5 秒超时

function silentCloseWs(targetWs) {
  if (!targetWs) return;
  targetWs.dead = Date.now();
  try { targetWs.removeAllListeners('close'); } catch (e) { console.error('[silentCloseWs] removeAllListeners(close):', e.message); }
  try { targetWs.removeAllListeners('open'); } catch (e) { console.error('[silentCloseWs] removeAllListeners(open):', e.message); }
  try { targetWs.removeAllListeners('message'); } catch (e) { console.error('[silentCloseWs] removeAllListeners(message):', e.message); }
  try { targetWs.removeAllListeners('error'); } catch (e) { console.error('[silentCloseWs] removeAllListeners(error):', e.message); }
  targetWs.on('open', () => targetWs.close());
  targetWs.on('message', () => targetWs.close());
  targetWs.on('error', () => targetWs.close());
  try { targetWs.close(); } catch (e) { console.error('[silentCloseWs] close:', e.message); }
  Poolkick(targetWs);
}

function stopCfHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (heartbeatTimeoutTimer) clearTimeout(heartbeatTimeoutTimer);
  heartbeatTimer = null;
  heartbeatTimeoutTimer = null;
}

function reconnectWs(delay = RECONNECT_DELAY) {
  console.log(`[reconnectWs] 1. pool=${wsPool.length} isReconnecting=${isCfReconnecting} delay=${delay}`);
  stopCfHeartbeat();
  console.log(`[reconnectWs] 2. heartbeat stopped`);
  cleanupWs();
  console.log(`[reconnectWs] 3. pool=${wsPool.length} after cleanup`);
  ws = null;
  if (!isCfReconnecting) {
    console.log(`[reconnectWs] 4. will reconnect in ${delay}ms`);
    isCfReconnecting = true;
    setTimeout(() => {
      isCfReconnecting = false;
      setupCloudflareWebSocket();
    }, delay);
  } else {
    console.log(`[reconnectWs] skipped, already reconnecting`);
  }
}

function startCfHeartbeat() {
  if (!hasCloudflare || !ws) return;
  stopCfHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send('ping');  // DO 自动回复 "pong"
      heartbeatTimeoutTimer = setTimeout(() => {
        console.log('[Cloudflare] No pong, force reconnect');
        reconnectWs(0);
      }, HEARTBEAT_TIMEOUT);
    }
  }, HEARTBEAT_INTERVAL);
}

function setupCloudflareWebSocket() {
  if (!hasCloudflare) return;

  try {
    cleanupWs();
    ws = new WebSocket(DO_WS_URL);
    wsPool.push(ws);
  } catch (e) {
    console.error('[-] Cloudflare WebSocket create error:', e.message);
    setTimeout(setupCloudflareWebSocket, RECONNECT_DELAY);
    return;
  }

  ws.on('open', function() {
    if (this !== ws) {
      console.error('[Cloudflare] BUG: Stale ws detected, closing self');
      silentCloseWs(this);
      return;
    }
    console.log('[+] Cloudflare Durable Objects WebSocket connected');
    isCfReconnecting = false;
    startCfHeartbeat();
  });

  ws.on('message', (data) => {
    // pong 是原始字符串，不是 JSON
    if (data.toString() === 'pong') {
      clearTimeout(heartbeatTimeoutTimer);
      return;
    }
    try {
      const msg = JSON.parse(data.toString());
      handleFrontendMessage(msg);
    } catch (e) {
      console.error('[-] Cloudflare WebSocket message parse error:', e.message);
    }
  });

  ws.on('close', function(code, reason) {
    if (this !== ws) {
      const thisInPool = wsPool.includes(this);
      const wsInPool = ws && wsPool.includes(ws);
      console.error(`[Cloudflare] onclose for stale ws: pool.size=${wsPool.length}, thisInPool=${thisInPool}, wsInPool=${wsInPool}, this.dead=${this.dead}, ws.dead=${ws?.dead}`);
      return;
    }
    console.log(`[-] Cloudflare WebSocket closed: ${code} ${reason}`);
    reconnectWs();
  });

  ws.on('error', (err) => {
    console.error('[-] Cloudflare WebSocket error:', err.message);
  });
}

// ---- 统一的消息处理 ----
function handleFrontendMessage(data) {
  const source = hasSupabase ? 'Supabase' : 'Cloudflare';
  console.log(`[${source}] Received from frontend:`, data.type);

  try {
    if ((data.type === 'message' || data.type === 'user') && data.text) {
      // 消息需要发送给 Claude Code
      sendToClaudeCode(data.text);
      // 注意：不进行 broadcastToFrontends({ type: 'user', text })
      // 因为 cc-all 的这个广播缺少 uuid 和 message.content，前端不会渲染
    } else if (data.type === 'control_response') {
      console.log(`[${source}] control_response received:`, data);
      const requestId = data.response?.request_id || data.request_id;
      if (requestId) pendingControlRequests.delete(requestId);
      sendControlResponseToClaudeCode(data);
    } else if (data.type === 'interrupt') {
      console.log(`[${source}] interrupt received, pending count: ${pendingControlRequests.size}`);
      if (pendingControlRequests.size > 0) {
        for (const [requestId] of pendingControlRequests) {
          // 用 control_response { behavior: 'deny' } 拒绝每个 pending 的权限请求
          sendControlResponseToClaudeCode({
            response: {
              subtype: 'success',
              request_id: requestId,
              response: {
                behavior: 'deny',
                message: 'User denied'
              }
            }
          });
        }
        pendingControlRequests.clear();
      }
      sendInterruptToClaudeCode(data.request_id || crypto.randomUUID());
    }
  } catch (e) {
    console.error('[-] Handle frontend message error:', e.message);
  }
}

// ---- 统一的双渠道广播 ----
function broadcastToFrontends(data) {
  const payload = { ...data, _ts: Date.now() };

  // Supabase 渠道
  if (hasSupabase && channel) {
    channel.send({
      type: 'broadcast',
      event: 'server_to_frontend',
      payload: payload
    }).catch(err => {
      console.error('[-] Supabase broadcast error:', err.message);
    });
  }

  // Cloudflare 渠道
  if (hasCloudflare && ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(payload));
    } catch (err) {
      console.error('[-] Cloudflare broadcast error:', err.message);
    }
  }
}

// 发送消息给 Claude Code（通过 SSE）
function sendToClaudeCode(text) {
  if (!sseRes || !sseSessionId) {
    console.log('[WS] No SSE connection to Claude Code');
    return false;
  }

  const eventPayload = {
    type: 'user',
    uuid: crypto.randomUUID(),
    session_id: sseSessionId,
    message: {
      role: 'user',
      content: text
    }
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
    sseRes.write(`event: client_event\n`);
    sseRes.write(`id: ${streamEvent.sequence_num}\n`);
    sseRes.write(`data: ${JSON.stringify(streamEvent)}\n\n`);
    console.log('[WS] Forwarded message to Claude Code');
    return true;
  } catch (e) {
    console.log('[WS] Failed to send to Claude Code:', e.message);
    return false;
  }
}

// 发送 control_response 给 Claude Code（通过 SSE）
function sendControlResponseToClaudeCode(data) {
  if (!sseRes || !sseSessionId) {
    console.log('[WS] No SSE connection to Claude Code');
    return false;
  }

  // 序列号，需要递增
  const sequenceNum = 1; // TODO: 维护真实的序列号

  // 构建 control_response 事件的 payload
  // 格式参考 cc源码: response.response.behavior
  const eventPayload = {
    type: 'control_response',
    uuid: crypto.randomUUID(),
    request_id: data.response?.request_id || data.request_id,
    response: data.response  // 包含 behavior, updatedPermissions 等
  };

  const streamEvent = {
    event_id: crypto.randomUUID(),
    sequence_num: sequenceNum,
    event_type: 'control_response',
    source: 'frontend',
    payload: eventPayload,
    created_at: new Date().toISOString()
  };

  try {
    sseRes.write(`event: client_event\n`);
    sseRes.write(`id: ${streamEvent.sequence_num}\n`);
    sseRes.write(`data: ${JSON.stringify(streamEvent)}\n\n`);
    console.log('[WS] Forwarded control_response to Claude Code:', streamEvent);
    return true;
  } catch (e) {
    console.log('[WS] Failed to send control_response to Claude Code:', e.message);
    return false;
  }
}

// 发送 control_cancel_request 给 Claude Code（通过 SSE）
function sendControlCancelRequestToClaudeCode(requestId) {
  if (!sseRes || !sseSessionId) {
    console.log('[WS] No SSE connection to Claude Code');
    return false;
  }
  const streamEvent = {
    event_id: crypto.randomUUID(),
    sequence_num: 1,
    event_type: 'control_cancel_request',
    source: 'frontend',
    payload: { type: 'control_cancel_request', request_id: requestId, session_id: sseSessionId },
    created_at: new Date().toISOString()
  };
  try {
    sseRes.write(`event: client_event\nid: ${streamEvent.sequence_num}\ndata: ${JSON.stringify(streamEvent)}\n\n`);
    console.log('[WS] Sent control_cancel_request:', requestId);
    return true;
  } catch (e) {
    console.error('[-] control_cancel_request error:', e.message);
    return false;
  }
}

// 发送 interrupt control_request 给 Claude Code（通过 SSE）
function sendInterruptToClaudeCode(requestId) {
  if (!sseRes || !sseSessionId) {
    console.log('[WS] No SSE connection to Claude Code');
    return false;
  }

  const sequenceNum = 1; // TODO: 维护真实的序列号

  const eventPayload = {
    type: 'control_request',
    uuid: crypto.randomUUID(),
    request_id: requestId,
    request: { subtype: 'interrupt' }
  };

  const streamEvent = {
    event_id: crypto.randomUUID(),
    sequence_num: sequenceNum,
    event_type: 'control_request',
    source: 'frontend',
    payload: eventPayload,
    created_at: new Date().toISOString()
  };

  try {
    sseRes.write(`event: client_event\n`);
    sseRes.write(`id: ${streamEvent.sequence_num}\n`);
    sseRes.write(`data: ${JSON.stringify(streamEvent)}\n\n`);
    console.log('[WS] Sent interrupt to Claude Code:', streamEvent);
    return true;
  } catch (e) {
    console.log('[WS] Failed to send interrupt to Claude Code:', e.message);
    return false;
  }
}

// ============== 工具函数 ==============

/**
 * 规范化 session ID：统一返回 session_* 格式
 * 证据 #10: sameSessionId() 比较底层 UUID，不管前缀
 */
function toSessionFormat(id) {
  if (!id) return null;
  if (id.startsWith('session_')) return id;
  if (id.startsWith('cse_')) return 'session_' + id.slice(4);
  return id;
}

// ============== Bridge 核心端点 ==============

/**
 * POST /v1/sessions
 * 创建 session
 */
app.post('/v1/sessions', (req, res) => {
  activeSessionId = 'session_' + crypto.randomBytes(16).toString('hex');
  console.log(`[Bridge] Session created: ${activeSessionId}`);
  res.json({ id: activeSessionId, title: 'Local Session', created_at: new Date().toISOString() });
});

/**
 * GET /v1/sessions/:id
 * 根据日志，session UUID 一定匹配，直接返回
 */
app.get('/v1/sessions/:id', (req, res) => {
  res.json({
    id: activeSessionId,
    environment_id: currentEnvId,
    title: 'Local Session',
    created_at: new Date().toISOString()
  });
});

/**
 * POST /v1/sessions/:id/archive
 */
app.post('/v1/sessions/:id/archive', (req, res) => {
  console.log(`[Bridge] Archive: ${req.params.id}`);
  res.json({ status: 'ok' });
});

/**
 * POST /v1/environments/bridge
 */
app.post('/v1/environments/bridge', (req, res) => {
  const { environment_id } = req.body;
  currentEnvId = environment_id || 'env_' + crypto.randomBytes(8).toString('hex');
  console.log(`[Bridge] Environment: ${currentEnvId}`);
  res.json({ environment_id: currentEnvId, environment_secret: 'local-secret' });
});

/**
 * DELETE /v1/environments/bridge/:id
 */
app.delete('/v1/environments/bridge/:id', (req, res) => {
  console.log(`[Bridge] Deregister env: ${req.params.id}`);
  res.status(204).send();
});

/**
 * GET /v1/environments/:envId/work/poll
 * 根据日志，每次 poll 都复用已有 session，不会创建新的
 */
app.get('/v1/environments/:envId/work/poll', (req, res) => {
  const { envId } = req.params;
  console.log(`[Bridge] Poll work for env: ${envId}`);

  const workSecret = {
    version: 1,
    session_ingress_token: createAccessToken(),
    api_base_url: `https://localhost`,
    use_code_sessions: true,
    sources: [],
    auth: [{ type: 'oauth', token: createAccessToken() }]
  };

  const workId = 'work_' + crypto.randomBytes(8).toString('hex');
  console.log(`[Bridge] Returning work: ${workId} session: ${activeSessionId}`);
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

/**
 * POST /v1/environments/:envId/work/:workId/ack
 */
app.post('/v1/environments/:envId/work/:workId/ack', (req, res) => {
  res.json({ status: 'ok' });
});

/**
 * POST /v1/environments/:envId/work/:workId/stop
 */
app.post('/v1/environments/:envId/work/:workId/stop', (req, res) => {
  res.json({ status: 'ok' });
});

// ============== CCR v2 端点 ==============

/**
 * POST /v1/code/sessions/:sessionId/bridge
 * env-less 模式使用（本次日志未触发）
 */
app.post('/v1/code/sessions/:sessionId/bridge', (req, res) => {
  console.log(`[CCR_v2] /bridge: ${req.params.sessionId}`);
  res.json({
    worker_jwt: createWorkerJwt(req.params.sessionId),
    api_base_url: `https://localhost`,
    expires_in: 3600,
    worker_epoch: workerEpoch
  });
});

/**
 * PUT /v1/code/sessions/:sessionId/worker
 * env-less 模式使用（本次日志未触发）
 */
app.put('/v1/code/sessions/:sessionId/worker', (req, res) => {
  console.log(`[CCR_v2] PUT /worker: ${req.params.sessionId}`);
  res.json({ ok: true });
});

/**
 * GET /v1/code/sessions/:sessionId/worker
 * env-less 模式使用（本次日志未触发）
 */
app.get('/v1/code/sessions/:sessionId/worker', (req, res) => {
  console.log(`[CCR_v2] GET /worker: ${req.params.sessionId}`);
  res.json({ worker: { external_metadata: null } });
});

/**
 * POST /v1/code/sessions/:sessionId/worker/register
 * env-based v2 走这里获取 epoch
 */
app.post('/v1/code/sessions/:sessionId/worker/register', (req, res) => {
  console.log(`[CCR_v2] Worker register: ${req.params.sessionId}`);
  res.json({ worker_epoch: workerEpoch++ });
});

/**
 * POST /v1/code/sessions/:sessionId/worker/heartbeat
 */
app.post('/v1/code/sessions/:sessionId/worker/heartbeat', (req, res) => {
  res.json({ lease_extended: true, state: 'active', ttl_seconds: 300 });
});

/**
 * GET /v1/code/sessions/:sessionId/worker/events/stream
 * SSE 通道，服务器通过此通道向客户端推送消息
 * 官方 StreamClientEvent 格式
 */
app.get('/v1/code/sessions/:sessionId/worker/events/stream', (req, res) => {
  const { sessionId } = req.params;
  const isReconnect = sseRes !== null;  // 是否重连
  console.log(`[SSE] Stream connected: ${sessionId}${isReconnect ? ' (重连)' : ''}`);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  res.write(`:connected\n\n`);

  // 保存 SSE 连接
  sseRes = res;
  sseSessionId = sessionId;

  // 通知前端 SSE 重连
  if (isReconnect) {
    broadcastToFrontends({ type: 'sse_reconnect', text: `SSE 重连成功 (session: ${sessionId})` });
  }

  req.on('close', () => {
    console.log(`[SSE] Stream closed: ${sessionId}`);
    if (sseRes === res) {
      sseRes = null;
      sseSessionId = null;
    }
  });
});

/**
 * POST /v1/code/sessions/:sessionId/worker/events
 * 接收客户端发来的事件（响应消息、心跳等）
 */
app.post('/v1/code/sessions/:sessionId/worker/events', (req, res) => {
  const events = req.body.events || [];
  console.log(`[CCR_v2] Received ${events.length} events`);

  // 直接广播原始事件给所有 WebSocket 前端，前端负责解析
  for (const event of events) {
    // 记录所有 control_request 的 request_id
    if (event.payload?.type === 'control_request' && event.payload.request_id) {
      pendingControlRequests.set(event.payload.request_id, true);
    }
    broadcastToFrontends({ type: 'event', data: event });
  }

  res.json({ status: 'ok' });
});

/**
 * POST /v1/code/sessions/:sessionId/worker/events/delivery
 * 客户端报告事件投递状态：received, processing, processed
 */
app.post('/v1/code/sessions/:sessionId/worker/events/delivery', (req, res) => {
  const { updates } = req.body || {};
  console.log(`[CCR_v2] Delivery: ${JSON.stringify(updates)}`);
  res.json({ status: 'ok' });
});

/**
 * POST /v1/code/sessions/:sessionId/worker/internal-events
 * 客户端发送内部事件（transcript 等）
 */
app.post('/v1/code/sessions/:sessionId/worker/internal-events', (req, res) => {
  const events = req.body.events || [];
  // 直接广播原始事件给所有 WebSocket 前端，前端负责解析
  for (const event of events) {
    broadcastToFrontends({ type: 'internal_event', data: event });
  }
  res.json({ status: 'ok' });
});

// ============== 启动服务器 ==============

// 创建 HTTPS 服务器
const httpsOptions = {
  key: fs.readFileSync(path.join(__dirname, 'key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'cert.pem'))
};

const server = https.createServer(httpsOptions, app);

// 构建启动信息
let startupInfo = `
╔════════════════════════════════════════════════════════════╗
║        CC Local Bridge Server (HTTPS on 443)              ║
╠════════════════════════════════════════════════════════════╣`;

if (hasSupabase) {
  startupInfo += `
║  Supabase:    ${SUPABASE_URL.substring(0, 30)}...  ║
║  Channel:     ${CHANNEL_NAME}                        ║`;
}

if (hasCloudflare) {
  startupInfo += `
║  Cloudflare:  ${DO_WS_URL.substring(0, 30)}...║`;
}

startupInfo += `
║  OAuth Token: https://platform.claude.com/v1/oauth/token║
╚════════════════════════════════════════════════════════════╝`;

server.listen(443, () => {
  console.log(startupInfo);
  console.log('[+] HTTPS server listening on port 443');
  if (hasSupabase) console.log('[+] Supabase Broadcast channel ready');
  if (hasCloudflare) console.log('[+] Cloudflare Durable Objects WebSocket connecting...');
  initLogWs(server);
});

// ============== 启动渠道 ==============
if (hasSupabase) {
  setupSupabaseChannel();
}
if (hasCloudflare) {
  setupCloudflareWebSocket();
}

// 处理 Ctrl+C 退出
process.on('SIGINT', async () => {
  console.log('\n[-] Shutting down...');
  if (hasSupabase && channel) {
    await supabase.removeChannel(channel);
  }
  if (hasCloudflare && ws) {
    ws.close();
  }
  server.close(() => {
    console.log('[-] Server closed');
    process.exit(0);
  });
});
