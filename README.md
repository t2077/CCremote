# CC remote

基于 Supabase Broadcast 的前端控制台

**在线地址：** https://t2077.github.io/CCremote/

支持版本：v2.1.85-v2.1.92

---

## 工作原理

1. **本地服务器**（server.js / server-all.js）监听 443 端口，假冒 Claude 官方服务器与 Claude Code 通信，完成虚拟登录并兼容 remote-control 功能。
2. **Claude Code** 通过 HTTPS 连接到本地服务器，服务器通过 Bridge 协议与其通信
3. **前端控制台**（GitHub Pages）通过 Supabase Broadcast 与本地服务器双向通信
4. 所有消息经过：Claude Code → 本地服务器 → Supabase → 前端，以及反向

本地服务器版本：

- **server.js**：标准版，只接管 remote-control 流量
- **server-all.js**：增强版，代理官方对话消息到第三方（minimax），因此能解锁绝大部分 Max 套餐专属功能

| rc 启动方式 | server.js | server-all.js |
|-------------|-----------|---------------|
| CMD  `claude remote-control` | ✅ | ✅ |
| 会话内 `/remote-control` 命令 | ❌ | ✅ |

>  `claude remote-control` 只能从新会话开始，且无法在 CLI 中同步进行交互。

---

## 完整配置步骤

### 1. 本地 hosts 规则

```
127.0.0.1 platform.claude.com
127.0.0.1 api.anthropic.com
```

### 2. HTTPS 证书

​	自行为 hosts 两条规则生成签名证书，将 `cert.pem` 和 `key.pem` 放到服务器同目录。

### 3. 配置 Supabase（免费额度足够）

1. 新建 [Supabase](https://supabase.com) 账户
2. 进入项目 →左侧边栏 → Realtime → 开启 Broadcast
3. 复制 Project URL 和 Publishable Key

### 4. 启动本地服务器

**bat 程序：**

```batch
@echo off
cd /d "%~dp0"
set "NODE_PATH=C:\Users\你的用户名\AppData\Roaming\npm\node_modules"
set "SUPABASE_URL=https://你的项目.supabase.co"
set "SUPABASE_KEY=sb_publishable_你的Key"
# server-all 版本特有：set "MINIMAX_API_KEY=你的MiniMax密钥"
node server.js
pause
```

### 5. 访问前端

打开 https://t2077.github.io/CCremote/

首次访问会弹出配置对话框，输入你的 Supabase URL 和 Publishable Key，保存即可。

### 6. 认证 Claude Code

在 Claude 界面输入 `/logout`，同时配置环境变量（sysdm.cpl）：

```batch
set "NODE_EXTRA_CA_CERTS=证书地址\cert.pem"
```

再次进入 Claude 输入 `/login` 开始登录：

1. 选择 `1. Claude account with subscription · Pro, Max, Team, or Enterprise`
2. 不用管自动打开的 Claude 官方 URL，直接输入任意合法 code（如 `a#a`）
3. 按下 Enter 完成登录，提示 "Login successful. Press Enter to continue…" 即表示已解锁 Claude Code Pro 账户权限

### 7. 开启远程控制

在 CMD 中执行：

```batch
claude remote-control
```

成功后将提示：

```
·✔︎· Local Session
Single session · exits when complete
Continue coding in the Claude app or https://claude.ai/code/session
space to show QR code
```

#### server-all.js 特有

会话界面中输入 `/rc` 或 `/remote-control` 可开启，成功后将提示：

```
> /remote-control
  ⎿  Remote Control connecting…

  /remote-control is active · Code in CLI or at http://localhost:4000/code/session
```

> server-all.js 会把模型的官网也代理掉，Claude Code 的 settings 请勿填 ANTHROPIC_BASE_URL 和 ANTHROPIC_AUTH_TOKEN。

> 欢迎界面显示如下说明通过验证，解锁对话内 /rc 功能：

```
Claude Code v2.1.xx
minimax-M2.7 · Claude API
C:\Users\xxx
```

---

## 文件说明

```
CCremote/
├── server.js          # 标准版服务器
├── server-all.js      # 增强版服务器
├── cert.pem           # HTTPS 证书
├── key.pem            # HTTPS 私钥
└── keys/              # JWT 密钥（自动生成）
    ├── private.pem
    └── public.pem
```

---

## 常见问题

**Q: 浏览器显示不安全？**
A: 需要在系统中信任 `cert.pem` 的发布者。Windows 双击证书 → 安装 → 选择"受信任的根证书颁发机构"。

**Q: 如何清除保存的 Supabase 凭证？**
A: 访问 `https://t2077.github.io/CCremote/?delete-cookie`

**Q: 如何清除历史记录？**
A: 访问 `https://t2077.github.io/CCremote/?delete-history`

**Q: 启动报错 `SUPABASE_URL and SUPABASE_KEY required`？**
A: 需要先设置环境变量，或在启动命令前设置。

**Q: 多台电脑能同时使用吗？**
A: 可以，所有电脑连接同一个 Supabase 项目即可。

**Q: 欢迎界面显示 Claude API 用户，仍然没有 /rc 命令。**
A: 已知 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 设置后可造成这种现象，临时清空 settings.json 可修复。
