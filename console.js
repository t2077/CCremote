/**
 * CC Bridge Console - 前端控制台
 * 通过 Supabase Broadcast 与服务器通信
 */

(function() {
  'use strict';

  // ============== DOM ==============
  const consoleEl = document.getElementById('console');
  const inputBox = document.getElementById('input-box');
  const sendBtn = document.getElementById('send-btn');
  const statusDot = document.getElementById('status-dot');

  // ============== 状态 ==============
  let supabaseClient = null;
  let channel = null;
  let displayedMessages = new Set();  // 用 type+text 去重
  let pendingTools = {};  // { toolId: { el, toolName } }
  let currentControlRequest = null;
  let selectedIndex = 0;
  let pendingParentId = null;  // 记录当前消息的 parent_tool_use_id
  let autoAllowEnabled = false;  // 自动同意开关
  let notifyEnabled = false;  // 通知开关

  // 工具名称中文映射
  const toolNameMap = {
    'Glob': '文件搜索',
    'Grep': '文件内容搜索',
    'Agent': 'subagent'
  };

  // ============== 工具函数 ==============
  function appendLine(lineEl, subagentID) {
    if (subagentID) {
      const parentEl = pendingTools[subagentID]?.el;
      if (parentEl) {
        // 查找该 parent 下面的所有 subagent-child，并检查 display 状态一致性
        const allChildren = [];
        let nextEl = parentEl.nextElementSibling;
        while (nextEl && nextEl.classList.contains('subagent-child')) {
          allChildren.push(nextEl);
          nextEl = nextEl.nextElementSibling;
        }

        // 检查 display 状态是否一致
        if (allChildren.length > 0) {
          const firstDisplay = allChildren[0].style.display;
          for (const child of allChildren) {
            if (child.style.display !== firstDisplay) {
              alert(`[appendLine] display 不一致！subagentID=${subagentID}，发现 display="${child.style.display}" vs 第一个="${firstDisplay}"`);
              break;
            }
          }
          // 新元素与所有 child 保持一致
          lineEl.style.display = firstDisplay;
        }

        // 插入到最后
        const lastChild = allChildren.length > 0 ? allChildren[allChildren.length - 1] : parentEl;
        lastChild.after(lineEl);

        // 首次添加子元素，设置父级可点击
        if (!parentEl.classList.contains('subagent-parent')) {
          parentEl.classList.add('subagent-parent');
          parentEl.onclick = () => toggleSubagentChildren(parentEl);
        }
      } else {
        console.error('appendLine: parent not found:', subagentID);
        alert(`[appendLine] parent not found: ${subagentID}`);
        consoleEl.appendChild(lineEl);
      }
    } else {
      consoleEl.appendChild(lineEl);
      consoleEl.scrollTop = consoleEl.scrollHeight;
    }
  }

  function addLine(text, className = '', subagentID) {
    if (text === undefined || text === null) return;
    if (subagentID) className = className ? className + ' subagent-child' : 'subagent-child';
    const line = document.createElement('div');
    line.className = 'line' + (className ? ' ' + className : '');
    line.textContent = text;
    appendLine(line, subagentID);
    return line;
  }

  function addHtml(html, className = '', subagentID) {
    if (subagentID) className = className ? className + ' subagent-child' : 'subagent-child';
    const line = document.createElement('div');
    line.className = 'line' + (className ? ' ' + className : '');
    line.innerHTML = html;
    appendLine(line, subagentID);
    return line;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function formatTime() {
    return new Date().toLocaleTimeString('zh-CN', { hour12: false });
  }

  // 展开/收起 subagent 子消息
  function toggleSubagentChildren(parentEl) {
    // 收集所有 child
    const allChildren = [];
    let nextEl = parentEl.nextElementSibling;
    while (nextEl && nextEl.classList.contains('subagent-child')) {
      allChildren.push(nextEl);
      nextEl = nextEl.nextElementSibling;
    }

    if (allChildren.length === 0) return; // 没有 child 不需要切换

    // 找到第一个真实的 subagent-child 来判断当前状态
    const firstChild = allChildren[0];
    if (!firstChild) {
      alert(`[toggleSubagentChildren] firstChild 不存在但有 ${allChildren.length} 个 child！`);
      return;
    }

    const isCurrentlyHidden = firstChild.style.display === 'none';

    // 统一设置所有 child 的 display
    for (const child of allChildren) {
      child.style.display = isCurrentlyHidden ? '' : 'none';
    }

    // 验证所有 child display 状态一致性
    const firstDisplay = allChildren[0].style.display;
    for (const child of allChildren) {
      if (child.style.display !== firstDisplay) {
        alert(`[toggleSubagentChildren] display 不一致！parent=${parentEl.textContent?.slice(0,30)}，发现 display="${child.style.display}" vs 第一个="${firstDisplay}"`);
        break;
      }
    }
  }

  // 使用 marked.js 渲染 markdown
  function renderMarkdown(text) {
    if (!text) return '';
    try {
      return marked.parse(text);
    } catch (e) {
      return text;
    }
  }

  // ============== 连接状态 ==============
  function setStatus(connected) {
    statusDot.style.background = connected ? '#4caf50' : '#f44336';
  }

  // ============== 内容去重 ==============
  function isDuplicate(key) {
    if (displayedMessages.has(key)) return true;
    displayedMessages.add(key);
    if (displayedMessages.size > 500) {
      const first = displayedMessages.values().next().value;
      displayedMessages.delete(first);
    }
    return false;
  }

  // ============== 解析事件 ==============
  function parseEvent(event) {
    console.log('parseEvent called, event.payload:', event?.payload);

    // event 格式: { payload: { type: '...', ... } }
    const payload = event.payload;
    if (!payload) {
      console.log('parseEvent: no payload, returning');
      return;
    }

    const msgType = payload.type;
    const msgUuid = payload.uuid;
    const content = payload.message?.content;

    // 记录 parent_tool_use_id，parseEvent 结束后处理
    pendingParentId = payload.parent_tool_use_id || null;

    console.log('parseEvent: msgType =', msgType);

    // control_request 特殊处理
    if (msgType === 'control_request') {
      console.log('  → control_request:', payload.request);
      showControlRequest(payload.request, payload.request_id);
      pendingParentId = null;
      return;
    }

    switch (msgType) {
      case 'user':
        // isMeta 或 isSynthetic 的是 skill 返回的内容，不渲染
        if (payload.isMeta || payload.isSynthetic) {
          console.log('  → user isMeta/isSynthetic=true, 跳过');
          pendingParentId = null;
          return;
        }
        // 用户消息，可能是 tool_result
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              console.log('  → user.content.block.type: tool_result, tool_use_id:', block.tool_use_id, 'is_error:', block.is_error, 'content:', block.content);
              handleToolResult(block.tool_use_id, block.content, block.is_error);
            } else if (block.type === 'text' && block.text) {
              const key = 'user|' + msgUuid;
              if (!isDuplicate(key)) {
                if (pendingParentId) {
                  // subagent 的 user 消息：把内容写入父级 tool-use 行
                  const parentEl = pendingTools[pendingParentId]?.el;
                  if (parentEl) {
                    const toolSpan = parentEl.querySelector('.tool-use');
                    const shortText = block.text.slice(0, 50) + (block.text.length > 50 ? '...' : '');
                    if (toolSpan) {
                      toolSpan.textContent = 'subagent - ' + shortText;
                    }
                  }
                } else {
                  addLine(`${formatTime()} 用户: ${block.text}`, 'line-user');
                }
              }
            }
          }
        } else if (typeof content === 'string') {
          // task-notification 渲染成一行
          if (content.startsWith('<task-notification>') && content.endsWith('</task-notification>')) {
            const match = content.match(/<summary>(.*?)<\/summary>/);
            if (match) {
              const summary = match[1];
              const key = 'task|' + msgUuid;
              if (!isDuplicate(key)) {
                addHtml(`<span style="color:#60e090">●</span> <span style="color:#7d8973">${escapeHtml(summary)}</span>`, 'line-info');
              }
            }
            pendingParentId = null;
            return;
          }
          const key = 'user|' + msgUuid;
          if (!isDuplicate(key)) {
            addLine(`${formatTime()} 用户: ${content}`, 'line-user');
          }
        }
        break;

      case 'assistant':
        // AI 消息
        if (!content) {
          pendingParentId = null;
          return;
        }

        if (Array.isArray(content)) {
          // 数组格式，遍历每个 block
          for (const block of content) {
            parseAssistantBlock(block, msgUuid, pendingParentId);
          }
        } else if (typeof content === 'string') {
          const key = 'assistant|' + content.slice(0, 100);
          if (!isDuplicate(key)) {
            addHtml(`${formatTime()} AI: ${renderMarkdown(content)}`, 'line-assistant', pendingParentId);
          }
        }
        break;

      case 'system':
        // 系统消息
        const subtype = payload.subtype;
        if (subtype === 'init' || subtype === 'result') {
          const key = 'system|' + subtype + '|' + msgUuid;
          if (!isDuplicate(key)) {
            addLine(`${formatTime()} [${subtype}]`, 'line-system', pendingParentId);
          }
        }
        break;

      case 'control_response':
        // control_response 结果
        const resp = payload.response?.response;
        if (resp) {
          const behavior = resp.behavior || 'unknown';
          const key = 'control_response|' + msgUuid;
          if (!isDuplicate(key)) {
            addLine(`${formatTime()} 权限响应: ${behavior}`, 'line-system', pendingParentId);
          }
        }
        break;

      default:
        // 其他类型，打印原始 JSON 供调试
        console.log('[Unknown event type]', msgType, payload);
    }

    // parseEvent 结尾：处理 subagent 逻辑
    pendingParentId = null;
  }

  function parseAssistantBlock(block, parentUuid, subagentID) {
    if (!block || !block.type) return;

    const key = 'block|' + block.type + '|' + (block.uuid || parentUuid) + '|' + (block.text || block.name || '').slice(0, 50);

    switch (block.type) {
      case 'text':
        if (block.text) {
          console.log('  → block.type: text');
          if (!isDuplicate(key)) {
            addHtml(`${formatTime()} AI: ${renderMarkdown(block.text)}`, 'line-assistant', subagentID);
          }
        }
        break;

      case 'thinking':
        if (block.thinking) {
          console.log('  → block.type: thinking');
          if (!isDuplicate(key)) {
            addLine(`${formatTime()} 思考: ${block.thinking.slice(0, 150)}...`, 'line-thinking', subagentID);
          }
        }
        break;

      case 'redacted_thinking':
        console.log('  → block.type: redacted_thinking');
        if (!isDuplicate(key)) {
          addLine(`${formatTime()} 思考: [已折叠]`, 'line-thinking', subagentID);
        }
        break;

      case 'tool_use':
        // 工具名就是 block.name，显示关键参数
        const toolName = block.name || 'tool';
        const toolId = block.id;
        const input = block.input || {};
        const displayName = toolNameMap[toolName] || toolName;
        // 提取关键参数显示（全量，不截断）
        let inputDisplay = '';
        if (input.query) inputDisplay = input.query;
        else if (input.command) inputDisplay = input.command;
        else if (input.pattern && input.path) inputDisplay = `${input.pattern}  →  ${input.path}`;
        else if (input.path) inputDisplay = input.path;
        else inputDisplay = JSON.stringify(input);
        console.log('  → block.type: tool_use, toolName:', toolName, 'toolId:', toolId, 'input:', input);
        if (!isDuplicate(key + toolId)) {
          const el = addHtml(`${formatTime()} 工具: <span class="tool-use" data-tool-name="${displayName}">${displayName}</span> ${inputDisplay}`, 'line-tool-use', subagentID);
          if (toolId) {
            pendingTools[toolId] = { el, toolName: displayName };
          }
        }
        break;

      default:
        console.log('  → block.type:', block.type, '(unknown)');
    }
  }

  // 处理工具结果
  function handleToolResult(toolUseId, content, isError) {
    console.log('  → handleToolResult, toolUseId:', toolUseId, 'isError:', isError, 'content:', content);
    const pending = pendingTools[toolUseId];
    if (!pending) {
      console.log('  → handleToolResult: pending not found for', toolUseId);
      return;
    }
    const el = pending.el;
    const toolName = pending.toolName;  // 直接从存储中读取

    // 提取显示文本
    let displayText = '';
    if (typeof content === 'string') {
      displayText = content.slice(0, 200);
    } else if (Array.isArray(content)) {
      // 可能是 [{type: 'text', text: '...'}] 或 [{type: 'tool_reference', tool_name: '...'}]
      const parts = [];
      for (const item of content) {
        if (item.type === 'text') {
          parts.push(String(item.text || '').slice(0, 100));
        } else if (item.type === 'tool_reference') {
          parts.push(item.tool_name);
        }
      }
      displayText = parts.join(', ').slice(0, 200);
    } else if (typeof content === 'object') {
      displayText = JSON.stringify(content).slice(0, 200);
    } else {
      displayText = String(content).slice(0, 200);
    }

    if (el) {
      const isSubagentChild = el.classList.contains('subagent-child');
      const isSubagentParent = el.classList.contains('subagent-parent');
      const newEl = document.createElement('div');
      newEl.className = isSubagentChild ? 'line line-tool-use subagent-child' : 'line line-tool-use';
      const spanClass = isError ? 'tool-error' : 'tool-result';
      const label = isError ? '工具错误' : '工具结果';
      newEl.innerHTML = `${formatTime()} ${label}: <span class="${spanClass}">${toolName}</span> → ${displayText}`;
      // 替换元素时，必须继承 display 状态以保持 subagent-child 一致性
      newEl.style.display = el.style.display;
      // 替换元素
      el.replaceWith(newEl);
      // 如果原元素是 subagent-parent，需要保留展开/收起功能
      if (isSubagentParent) {
        newEl.classList.add('subagent-parent');
        newEl.onclick = () => toggleSubagentChildren(newEl);
        // 更新 pendingTools 中的引用，保留 toolName
        pendingTools[toolUseId] = { el: newEl, toolName };
      } else {
        delete pendingTools[toolUseId];
      }
    } else {
      // 没有匹配的 tool_use，直接显示结果
      const lineClass = isError ? 'line-error' : 'line-tool-result';
      const label = isError ? '工具错误' : '工具结果';
      addLine(`${formatTime()} ${label}: ${displayText}`, lineClass);
    }
  }

  // ============== Supabase 消息处理 ==============
  function handleMessage(data) {
    const type = data.type;

    switch (type) {
      case 'connected':
        break;

      case 'sse_reconnect':
        // 不再清空消息历史，保留对话上下文
        addLine(`${formatTime()} [SSE 重连]`, 'line-system');
        break;

      case 'event':
        console.log('→ 解析事件, payload.type:', data.data?.payload?.type);
        parseEvent(data.data);
        break;

      case 'internal_event':
        console.log('→ 解析内部事件, payload.type:', data.data?.payload?.type);
        parseEvent(data.data);
        break;

      case 'error':
        addLine(`${formatTime()} 错误: ${data.text}`, 'line-error');
        break;

      default:
        console.log('[Supabase Unknown type]', type, data);
    }
  }

  // ============== 工具使用请求选择器 ==============
  function showControlRequest(request, requestId) {
    currentControlRequest = { request, requestId };
    selectedIndex = 0;

    // 自动同意：直接提交本次允许
    if (autoAllowEnabled) {
      submitControlRequest(0);
      return;
    }

    // 系统通知（页面失焦且开启通知时）- 用 try-catch 防止通知失败影响对话框显示
    if (notifyEnabled && !document.hasFocus()) {
      try {
        if (Notification.permission === 'granted') {
          const toolName = request.tool_name || '权限请求';
          new Notification('CC Bridge', { body: toolName, icon: '' });
        } else if (Notification.permission !== 'denied') {
          Notification.requestPermission();
        }
      } catch (e) {
        console.log('[Notify] Notification error:', e);
      }
    }

    const selector = document.getElementById('selector');
    const info = document.getElementById('selector-info');
    const options = document.getElementById('selector-options');

    const toolName = request.tool_name || 'unknown';
    const reason = request.decision_reason || '';
    const input = request.input || {};

    // 格式化 input 为可读字符串
    let inputDisplay = '';
    if (input.command) {
      inputDisplay = escapeHtml(input.command);
    } else if (input.pattern && input.path) {
      inputDisplay = escapeHtml(`${input.pattern}  →  ${input.path}`);
    } else if (input.pattern) {
      inputDisplay = escapeHtml(input.pattern);
    } else if (input.path) {
      inputDisplay = escapeHtml(input.path);
    } else {
      inputDisplay = escapeHtml(JSON.stringify(input));
    }

    info.innerHTML = `<strong>${escapeHtml(toolName)}</strong><br><span style="color:#60e090;font-size:13px">${inputDisplay}</span><br><span style="color:#888;font-size:12px">${escapeHtml(reason)}</span>`;

    const hasSuggestions = request.permission_suggestions?.length > 0;

    // 三个选项：本次允许、允许并应用建议、拒绝
    const optionLabels = hasSuggestions
      ? ['本次允许', '允许并应用规则', '拒绝']
      : ['本次允许', '拒绝'];

    options.innerHTML = '';
    optionLabels.forEach((label, i) => {
      const el = document.createElement('div');
      el.className = 'selector-option';
      el.textContent = label;
      el.onclick = () => submitControlRequest(i);
      options.appendChild(el);
    });

    updateSelectorSelection();
    selector.classList.add('show');
  }

  function updateSelectorSelection() {
    const opts = document.querySelectorAll('.selector-option');
    opts.forEach((el, i) => {
      el.classList.toggle('selected', i === selectedIndex);
    });
  }

  function submitControlRequest(optionIndex) {
    if (!currentControlRequest) return;

    const { request, requestId } = currentControlRequest;
    const selector = document.getElementById('selector');
    selector.classList.remove('show');

    const hasSuggestions = request.permission_suggestions?.length > 0;

    // 三个选项对应的响应
    let responseData;
    let label;
    if (optionIndex === 0) {
      // 本次允许
      responseData = { behavior: 'allow', updatedInput: request.input || {} };
      label = '本次允许';
    } else if (optionIndex === 1 && hasSuggestions) {
      // 允许并应用建议
      responseData = {
        behavior: 'allow',
        updatedInput: request.input || {},
        updatedPermissions: request.permission_suggestions
      };
      label = '允许并应用规则';
    } else {
      // 拒绝 - 必须带 message 字段
      responseData = { behavior: 'deny', message: 'User denied' };
      label = '拒绝';
    }

    if (channel) {
      channel.send({
        type: 'broadcast',
        event: 'frontend_to_server',
        payload: {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: requestId,
            response: responseData
          }
        }
      });
    }

    addLine(`${formatTime()} ${label}: ${request.tool_name}`, 'line-system');
    currentControlRequest = null;
  }

  // ============== Supabase 连接 ==============
  function connect(supabaseUrl, supabaseKey, channelName) {
    if (!supabaseUrl || !supabaseKey) {
      console.error('Supabase credentials not provided');
      setStatus(false);
      return;
    }

    supabaseClient = window.supabase.createClient(supabaseUrl, supabaseKey);
    channel = supabaseClient.channel(channelName || 'cc-bridge-channel');

    channel
      .on('broadcast', { event: 'server_to_frontend' }, (payload) => {
        console.log('---');
        console.log('type:', payload.payload.type);
        console.log('data:', payload.payload);
        handleMessage(payload.payload);
      })
      .subscribe((status) => {
        console.log('Supabase subscription status:', status);
        if (status === 'SUBSCRIBED') {
          setStatus(true);
          // 不再清空消息历史，保留对话上下文
          addLine('已连接', 'line-info');
        } else if (status === 'CHANNEL_ERROR' || status === 'CLOSED') {
          setStatus(false);
          addLine('连接失败', 'line-error');
        }
      });
  }

  // ============== 发送消息 ==============
  function sendMessage(text) {
    if (!text.trim()) return;
    if (!channel) return;

    channel.send({
      type: 'broadcast',
      event: 'frontend_to_server',
      payload: { type: 'message', text: text }
    });

    inputBox.value = '';
  }

  // ============== 事件绑定 ==============
  sendBtn.addEventListener('click', () => sendMessage(inputBox.value));
  inputBox.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(inputBox.value);
    }
  });
  // textarea 自动撑开
  function autoResize() {
    inputBox.style.height = 'auto';
    inputBox.style.height = Math.min(inputBox.scrollHeight + 4, 300) + 'px';
    requestAnimationFrame(autoResize);
  }
  requestAnimationFrame(autoResize);

  // 自动同意开关
  const autoAllowEl = document.getElementById('auto-allow');
  autoAllowEl.addEventListener('click', () => {
    autoAllowEnabled = !autoAllowEnabled;
    autoAllowEl.classList.toggle('active', autoAllowEnabled);
  });

  // 通知开关
  const notifyEl = document.getElementById('notify');
  function updateNotifyUI() {
    if (!notifyEnabled) {
      notifyEl.textContent = '通知';
      notifyEl.className = 'inactive';
    } else if (document.hasFocus()) {
      notifyEl.textContent = '无需通知';
      notifyEl.className = 'no-need';
    } else {
      notifyEl.textContent = '通知';
      notifyEl.className = '';
    }
  }
  window.addEventListener('focus', updateNotifyUI);
  window.addEventListener('blur', updateNotifyUI);
  notifyEl.addEventListener('click', () => {
    if (!notifyEnabled && Notification.permission === 'denied') {
      alert('通知权限已被拒绝，请在浏览器设置中开启');
      return;
    }
    notifyEnabled = !notifyEnabled;
    updateNotifyUI();
  });

  // 暂停按钮
  const pauseEl = document.getElementById('pause');
  pauseEl.addEventListener('click', () => {
    if (channel) {
      channel.send({
        type: 'broadcast',
        event: 'frontend_to_server',
        payload: { type: 'interrupt' }
      });
      console.log('[Console] Sent interrupt');
    }
  });

  // 关闭选择器
  function closeSelector() {
    const selector = document.getElementById('selector');
    selector.classList.remove('show');
    currentControlRequest = null;
  }

  // 选择器关闭按钮
  document.getElementById('selector-close').addEventListener('click', closeSelector);

  // 选择器键盘事件
  document.addEventListener('keydown', (e) => {
    if (!currentControlRequest) return;
    if (e.key === 'Escape') {
      closeSelector();
      e.preventDefault();
      return;
    }
    const options = document.querySelectorAll('.selector-option');
    if (e.key === 'ArrowUp') {
      selectedIndex = (selectedIndex - 1 + options.length) % options.length;
      updateSelectorSelection();
      e.preventDefault();
    } else if (e.key === 'ArrowDown') {
      selectedIndex = (selectedIndex + 1) % options.length;
      updateSelectorSelection();
      e.preventDefault();
    } else if (e.key === 'Enter') {
      submitControlRequest(selectedIndex);
      e.preventDefault();
    }
  });

  // ============== 启动（等待全局凭证） ==============
  setStatus(false);

  // 等待 window.supabaseConfig 准备好
  function waitForConfig() {
    if (window.supabaseConfig && window.supabaseConfig.url && window.supabaseConfig.key) {
      connect(window.supabaseConfig.url, window.supabaseConfig.key, window.supabaseConfig.channel);
    } else {
      setTimeout(waitForConfig, 100);
    }
  }

  waitForConfig();

})();
