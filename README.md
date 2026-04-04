# CC remote

基于 Supabase Broadcast 的前端控制台

**在线地址：** https://t2077.github.io/CCremote/

---

## 工作原理

1. **本地服务器**（server.js）监听 443 端口，假冒claude官方服务器与Claude Code通信，完成claudecode虚拟登录并兼容remote-control功能。
2. **Claude Code** 通过 HTTPS 连接到本地服务器，服务器通过 Bridge 协议与其通信
3. **前端控制台**（GitHub Pages）通过 Supabase Broadcast 与本地服务器双向通信
4. 所有消息经过：Claude Code → 本地服务器 → Supabase → 前端，以及反向

---

## 完整配置步骤

### 1. 本地 hosts 规则

编辑 `C:\Windows\System32\drivers\etc\hosts`（需要管理员权限）：

```
127.0.0.1 platform.claude.com
127.0.0.1 api.anthropic.com
```

### 2. HTTPS 证书

需要让本地服务器伪装成 `platform.claude.com` 和 `api.anthropic.com`。

自行生成需要的自签名证书将它的 `cert.pem` 和 `key.pem` 放到 `server.js` 同目录。

### 3. 配置 Supabase（免费额度足够）

1. 在 [Supabase](https://supabase.com) 创建项目
2. 进入项目 →左侧边栏 → Realtime → 开启 Broadcast
3. 复制 Project URL 和 Publishable Key

### 4. 启动服务器

#### 方式一：直接运行

```batch
set SUPABASE_URL=https://你的项目.supabase.co
set SUPABASE_KEY=sb_publishable_你的Key
node server.js
```

#### 方式二：使用 start.bat

创建 `start.bat`：

```batch
@echo off
cd /d "%~dp0"
set "NODE_PATH=C:\Users\你的用户名\AppData\Roaming\npm\node_modules"
set "SUPABASE_URL=https://你的项目.supabase.co"
set "SUPABASE_KEY=sb_publishable_你的Key"
node server.js
pause
```

### 5. 访问前端

打开 https://t2077.github.io/CCremote/

首次访问会弹出配置对话框，输入你的 Supabase URL 和 Publishable Key，保存即可。

### 6. 认证 Claude Code

在 Claude 界面输入 `/logout`，显示 “Successfully logged out from your Anthropic account.”

配置环境变量：
```batch
set “NODE_EXTRA_CA_CERTS=你的证书地址\cert.pem”
```

再次进入 Claude 输入 `/login` 开始登录：

1. 选择 `1. Claude account with subscription · Pro, Max, Team, or Enterprise`
2. 不用管自动打开的 Claude 官方 URL，直接输入任意合法 code（如 `a#a`）
3. 按下 Enter 完成登录，提示 “Login successful. Press Enter to continue…” 即表示已解锁 Claude Code Pro 账户权限

### 7. 开启远程控制

确保服务器正在运行，然后在新 cmd 窗口执行：

```batch
set “NODE_EXTRA_CA_CERTS=你的证书地址\cert.pem”
claude remote-control
```

成功后将提示：
```
·✔︎· Local Session
Single session · exits when complete
Continue coding in the Claude app or https://claude.ai/code/session
space to show QR code
```

---

## 文件说明

```
cc-online/
├── server.js      # 本地服务器（Bridge协议 + Supabase中继）
├── cert.pem       # HTTPS 证书
├── key.pem        # HTTPS 私钥
└── keys/          # JWT 密钥（自动生成）
    ├── private.pem
    └── public.pem
```

---

## 常见问题

**Q: 浏览器显示不安全？**
A: 需要在系统中信任 `cert.pem` 的发布者。Windows 双击证书 → 安装 → 选择"受信任的根证书颁发机构"。

**Q: 如何清除保存的 Supabase 凭证？**
A: 访问 `https://t2077.github.io/CCremote/?delete-cookie`

**Q: 启动报错 `SUPABASE_URL and SUPABASE_KEY required`？**
A: 需要先设置环境变量，或在启动命令前设置。

**Q: 多台电脑能同时使用吗？**
A: 可以，所有电脑连接同一个 Supabase 项目即可。
