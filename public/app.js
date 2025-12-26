const elements = {
  localName: document.getElementById('localDeviceName'),
  peerHint: document.getElementById('peerHint'),
  peerList: document.getElementById('peerList'),
  targetName: document.getElementById('targetName'),
  fileInput: document.getElementById('fileInput'),
  sendBtn: document.getElementById('sendBtn'),
  log: document.getElementById('log'),
  incomingList: document.getElementById('incomingList'),
  incomingHint: document.getElementById('incomingHint'),
  sendProgress: document.getElementById('sendProgress'),
  sendStatus: document.getElementById('sendStatus'),
  dropZone: document.getElementById('dropZone'),
  folderInput: document.getElementById('folderInput'),
  fileBtn: document.getElementById('fileBtn'),
  folderBtn: document.getElementById('folderBtn'),
};

const state = {
  id: null,
  peers: [],
  targetId: null,
  sending: false,
  activeOutgoingId: null,
  selectedFiles: [],
  sendQueue: null,
};

resetOutgoingStatus();
setupDropZone();

const incomingTransfers = new Map();
const outgoingTransfers = new Map();
const bundleSessions = new Map(); // bundleId -> { autoAccept: boolean }
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const wsProtocol = location.protocol === 'https:' ? 'wss' : 'ws';
const socket = new WebSocket(`${wsProtocol}://${location.host}`);
socket.binaryType = 'arraybuffer';

const localDeviceName = deriveDeviceName();
elements.localName.textContent = localDeviceName;

socket.addEventListener('open', () => {
  logEvent('✅ 已连接到传输服务');
  announceDevice();
});

socket.addEventListener('close', () => {
  logEvent('⚠️ 与服务器的连接已断开');
});

socket.addEventListener('message', (event) => {
  if (typeof event.data === 'string') {
    handleTextMessage(event.data);
    return;
  }
  if (event.data instanceof ArrayBuffer) {
    handleBinaryMessage(event.data);
  }
});

// Debug utilities for diagnosing DnD/folder support
const debugEnabled = (() => {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get('debug') === '1') return true;
    return localStorage.getItem('lan_dnd_debug') === '1';
  } catch {
    return false;
  }
})();
const debugState = { uiBudget: 80, uiCount: 0, overNotified: false };
function debugLog(msg) {
  try {
    const text = String(msg || '');
    console.debug('[LAN-DND]', text);
    if (debugEnabled) {
      const isSpammy = text.startsWith('push file[');
      if (!isSpammy && debugState.uiCount < debugState.uiBudget) {
        logEvent(`🐞 ${text}`);
        debugState.uiCount += 1;
      } else if (!isSpammy && !debugState.overNotified && debugState.uiCount >= debugState.uiBudget) {
        logEvent('🐞 日志较多，已折叠后续调试输出（完整请看控制台）');
        debugState.overNotified = true;
      }
    }
  } catch {}
}

// Hint when running in insecure contexts (non-HTTPS and not localhost) that may limit folder DnD
try {
  const insecure = !window.isSecureContext && location.protocol !== 'https:' && location.hostname !== 'localhost';
  if (insecure) {
    logEvent('ℹ️ 当前为非安全上下文，部分浏览器不支持拖拽文件夹。可用 “选择文件夹” 按钮 或使用 Chrome/Edge+HTTPS。');
  }
} catch {}

function announceDevice() {
  if (socket.readyState === WebSocket.OPEN) {
    sendMessage({ type: 'register', name: localDeviceName });
  }
}

function handleTextMessage(raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    console.error('无法解析文本消息', error);
    return;
  }

  switch (payload.type) {
    case 'welcome':
      state.id = payload.id;
      updatePeers(payload.peers || []);
      logEvent('🌐 欢迎加入局域网快传');
      break;
    case 'peers':
      updatePeers(payload.peers || []);
      break;
    case 'file-offer':
      prepareIncomingTransfer(payload);
      break;
    case 'file-accept':
      beginOutgoingStream(payload.transferId, payload.fromName);
      break;
    case 'file-complete':
      finalizeIncomingTransfer(payload).catch((error) =>
        console.error('保存文件失败', error)
      );
      break;
    default:
      break;
  }
}

function handleBinaryMessage(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 4) {
    return;
  }
  const headerLength = view.getUint32(0);
  if (buffer.byteLength < 4 + headerLength) {
    return;
  }
  const headerBytes = new Uint8Array(buffer, 4, headerLength);
  const headerText = decoder.decode(headerBytes);
  let header;
  try {
    header = JSON.parse(headerText);
  } catch (error) {
    console.error('无法解析二进制头', error);
    return;
  }
  const chunk = buffer.slice(4 + headerLength);
  if (header.type === 'file-chunk') {
    handleIncomingChunk(header, new Uint8Array(chunk));
  }
}

function updatePeers(peers) {
  state.peers = peers.filter((peer) => peer.id !== state.id);
  renderPeerList();

  if (state.peers.length === 0) {
    elements.peerHint.textContent = '等待其他设备加入…';
  } else {
    elements.peerHint.textContent = `${state.peers.length} 台设备在线`;
  }

  const stillOnline = state.peers.some((peer) => peer.id === state.targetId);
  if (!stillOnline) {
    selectTarget(null);
  }
}

function renderPeerList() {
  elements.peerList.textContent = '';
  state.peers.forEach((peer) => {
    const button = document.createElement('button');
    button.className = 'peer' + (peer.id === state.targetId ? ' active' : '');
    button.innerHTML = `
      <div class="peer-name">${peer.name || '未知设备'}</div>
      <div class="peer-id">${peer.id.slice(0, 6)}</div>
    `;
    button.addEventListener('click', () => selectTarget(peer.id));
    elements.peerList.appendChild(button);
  });
}

function selectTarget(peerId) {
  state.targetId = peerId;
  const peer = state.peers.find((p) => p.id === peerId);
  elements.targetName.textContent = peer ? peer.name : '未选择';
  updateSendButton();
}

function updateSendButton() {
  const hasSelection = state.selectedFiles.length > 0;
  elements.sendBtn.disabled = !(state.targetId && hasSelection && !state.sending);
}

elements.fileBtn?.addEventListener('click', () => elements.fileInput?.click());
elements.folderBtn?.addEventListener('click', () => elements.folderInput?.click());

elements.fileInput.addEventListener('change', async () => {
  const files = await collectFiles(elements.fileInput.files);
  applySelectedFiles(files, { announce: true });
});

elements.folderInput?.addEventListener('change', async () => {
  const files = await collectFiles(elements.folderInput.files);
  applySelectedFiles(files, { announce: true });
});

// removed system directory picker to keep codebase minimal and broadly compatible

elements.sendBtn.addEventListener('click', () => {
  if (!state.targetId || state.selectedFiles.length === 0 || state.sending) {
    return;
  }
  state.sending = true;
  updateSendButton();
  const files = state.selectedFiles.slice();
  state.selectedFiles = [];
  elements.fileInput.value = '';
  updateSendPlaceholder();
  startSendQueue(files);
});

function startSendQueue(files) {
  if (!files.length || !state.targetId) {
    state.sending = false;
    updateSendButton();
    return;
  }
  if (files.length === 1 && files[0] && files[0].size === 0 && !files[0].type) {
    logEvent('⚠️ 检测到 0B 项，可能是目录占位。请使用下方“拖拽区域”或“系统目录选择”按钮选择整个文件夹。');
    state.sending = false;
    updateSendButton();
    return;
  }
  const totalBytes = files.reduce((sum, file) => sum + (file.size || 0), 0);
  const hasFolder = files.some((file) => ((file.webkitRelativePath || file.relativePath || '')).includes('/'));
  const bundleId = files.length > 1 || hasFolder ? safeUUID() : null;
  const bundleName = deriveBundleName(files);
  state.sendQueue = {
    files,
    pointer: 0,
    totalCount: files.length,
    totalBytes,
    completedBytes: 0,
    targetId: state.targetId,
    bundleId,
    bundleName,
  };
  logEvent(`📦 准备发送 ${files.length} 个文件（共 ${formatBytes(totalBytes)}）`);
  processSendQueue();
}

function processSendQueue() {
  const queue = state.sendQueue;
  if (!queue) {
    state.sending = false;
    updateSendButton();
    return;
  }
  if (queue.pointer >= queue.totalCount) {
    finishSendQueue('全部文件已发送');
    return;
  }
  const file = queue.files[queue.pointer];
  queue.currentIndex = queue.pointer;
  initiateOutgoingTransfer(file, queue.targetId, queue);
}

function finishSendQueue(message = '发送完成') {
  state.sendQueue = null;
  state.sending = false;
  state.activeOutgoingId = null;
  updateSendButton();
  setSendStatus(message);
  setTimeout(() => {
    if (!state.activeOutgoingId && !state.sendQueue) {
      resetOutgoingStatus();
    }
  }, 4000);
}

function cancelSendQueueOnError() {
  if (state.sendQueue) {
    state.sendQueue = null;
  }
  state.sending = false;
  state.activeOutgoingId = null;
  updateSendButton();
}

async function initiateOutgoingTransfer(file, targetId, queueContext = null) {
  const transferId = safeUUID();
  outgoingTransfers.set(transferId, {
    transferId,
    file,
    targetId,
    reader: file.stream().getReader(),
    seq: 0,
    sentBytes: 0,
    startTime: null,
    lastTickTime: null,
    speedBps: 0,
    queueContext,
  });
  state.activeOutgoingId = transferId;
  const queueLabel = queueContext
    ? `（文件 ${queueContext.currentIndex + 1}/${queueContext.totalCount}` +
      (queueContext.bundleName ? ` · ${queueContext.bundleName}` : '') +
      ')'
    : '';
  const basePercent = queueContext && queueContext.totalBytes
    ? (queueContext.completedBytes / queueContext.totalBytes) * 100
    : 0;
  setSendProgress(basePercent);
  setSendStatus(`等待 ${resolvePeerName(targetId)} 接受… ${queueLabel}`.trim());

  const relativePath = file.webkitRelativePath || file.relativePath || file.name;
  const offer = {
    type: 'file-offer',
    to: targetId,
    transferId,
    fileName: file.name,
    fileSize: file.size,
    mimeType: file.type,
    relativePath,
  };
  if (queueContext?.bundleId) {
    offer.bundleId = queueContext.bundleId;
    offer.bundleName = queueContext.bundleName;
    offer.bundleTotal = queueContext.totalCount;
    offer.bundleIndex = queueContext.currentIndex + 1;
  }
  sendMessage(offer);
  logEvent(`📨 已发出 ${file.name} 的传输请求，等待对方同意`);
}

async function beginOutgoingStream(transferId, remoteName = '') {
  const transfer = outgoingTransfers.get(transferId);
  if (!transfer) {
    return;
  }
  logEvent(`🔄 ${remoteName || '对方'} 已接受，将开始发送 ${transfer.file.name}`);
  transfer.startTime = performance.now();
  transfer.lastTickTime = transfer.startTime;

  try {
    await streamFileChunks(transferId, transfer);
    logEvent(`✅ 已完成发送：${transfer.file.name}`);
    if (!transfer.queueContext) {
      updateOutgoingIndicators(transfer, { done: true });
    }
  } catch (error) {
    console.error(error);
    const reason = error?.message || '传输中断';
    logEvent(`❌ 发送 ${transfer.file.name} 失败：${reason}`);
    setSendStatus(`发送失败：${reason}`);
    setTimeout(() => {
      if (!state.activeOutgoingId) {
        resetOutgoingStatus();
      }
    }, 4000);
    cancelSendQueueOnError();
  } finally {
    outgoingTransfers.delete(transferId);
    const queue = transfer.queueContext;
    if (queue) {
      queue.completedBytes += transfer.file.size;
      queue.pointer += 1;
    }
    if (state.activeOutgoingId === transferId) {
      state.activeOutgoingId = null;
    }
    if (transfer.queueContext && transfer.queueContext === state.sendQueue) {
      if (transfer.queueContext.pointer < transfer.queueContext.totalCount) {
        processSendQueue();
      } else {
        finishSendQueue('全部文件已发送');
      }
    } else if (!state.sendQueue) {
      state.sending = false;
      updateSendButton();
    }
  }
}

async function streamFileChunks(transferId, transfer) {
  const { reader, targetId } = transfer;
  let done = false;
  while (!done) {
    const { value, done: readerDone } = await reader.read();
    done = readerDone;
    if (value && value.byteLength > 0) {
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      await sendBinaryChunk(
        {
          type: 'file-chunk',
          to: targetId,
          transferId,
          seq: transfer.seq++,
        },
        chunk
      );
      transfer.sentBytes += chunk.byteLength;
      updateOutgoingMetrics(transfer, chunk.byteLength);
      updateOutgoingIndicators(transfer);
    }
  }
  sendMessage({ type: 'file-complete', to: targetId, transferId });
}

function prepareIncomingTransfer(meta) {
  if (meta.bundleId && !bundleSessions.has(meta.bundleId)) {
    bundleSessions.set(meta.bundleId, { autoAccept: false });
  }
  incomingTransfers.set(meta.transferId, {
    meta,
    accepted: false,
    writer: null,
    useMemory: !Boolean(window.showSaveFilePicker),
    chunks: [],
    writePromise: Promise.resolve(),
    receivedBytes: 0,
    pendingChunks: [],
    startTime: null,
    lastTickTime: null,
    speedBps: 0,
  });
  renderIncomingList();
  const displayName = meta.relativePath || meta.fileName;
  logEvent(`📨 ${meta.fromName || '未知设备'} 想发送 ${displayName} (${formatBytes(meta.fileSize)})`);

  const session = meta.bundleId ? bundleSessions.get(meta.bundleId) : null;
  if (session?.autoAccept) {
    acceptIncomingTransfer(meta.transferId, { auto: true }).catch((error) =>
      console.error('自动接受文件失败', error)
    );
  }
}

async function acceptIncomingTransfer(transferId, options = {}) {
  const transfer = incomingTransfers.get(transferId);
  if (!transfer || transfer.accepted) {
    return;
  }
  try {
    if (window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({
        suggestedName: transfer.meta.fileName,
      });
      transfer.writer = await handle.createWritable();
      transfer.useMemory = false;
    } else {
      transfer.useMemory = true;
    }
    transfer.accepted = true;
    transfer.writePromise = Promise.resolve();
    if (transfer.pendingChunks.length > 0) {
      transfer.pendingChunks.forEach((chunk) => {
        if (transfer.writer) {
          transfer.writePromise = transfer.writePromise.then(() => transfer.writer.write(chunk));
        } else {
          transfer.chunks.push(chunk);
        }
      });
      transfer.pendingChunks = [];
    }
    sendMessage({ type: 'file-accept', to: transfer.meta.from, transferId });
    if (!options.auto) {
      logEvent(`✅ 已接受 ${transfer.meta.fileName}，等待数据传输`);
    }
    renderIncomingList();
  } catch (error) {
    logEvent('⚠️ 取消保存，暂未接收该文件');
  }
}

function handleIncomingChunk(meta, chunkBytes) {
  const transfer = incomingTransfers.get(meta.transferId);
  if (!transfer) {
    return;
  }
  transfer.receivedBytes += chunkBytes.byteLength;

  if (!transfer.accepted) {
    transfer.pendingChunks.push(chunkBytes);
  } else if (transfer.writer) {
    transfer.writePromise = transfer.writePromise.then(() => transfer.writer.write(chunkBytes));
  } else {
    transfer.chunks.push(chunkBytes);
  }

  updateIncomingMetrics(transfer, chunkBytes.byteLength);
  renderIncomingList();
}

async function finalizeIncomingTransfer(meta) {
  const transfer = incomingTransfers.get(meta.transferId);
  if (!transfer) {
    return;
  }
  try {
    await transfer.writePromise;
    if (transfer.writer) {
      await transfer.writer.close();
      logEvent(`💾 ${transfer.meta.fileName} 已保存到磁盘`);
    } else {
      const blob = new Blob(transfer.chunks, { type: transfer.meta.mimeType || 'application/octet-stream' });
      triggerDownload(blob, transfer.meta.fileName);
      logEvent(`✅ 已接收 ${transfer.meta.fileName}`);
    }
  } catch (error) {
    logEvent(`⚠️ 保存 ${transfer.meta.fileName} 时出错：${error.message}`);
  } finally {
    incomingTransfers.delete(meta.transferId);
    if (transfer.meta.bundleId && !hasPendingBundleTransfers(transfer.meta.bundleId)) {
      bundleSessions.delete(transfer.meta.bundleId);
    }
    renderIncomingList();
  }
}

function renderIncomingList() {
  if (incomingTransfers.size === 0) {
    elements.incomingList.classList.add('empty');
    elements.incomingList.textContent = '当前没有待接收文件。';
    elements.incomingHint.textContent = '空闲';
    return;
  }
  elements.incomingList.classList.remove('empty');
  elements.incomingList.textContent = '';
  elements.incomingHint.textContent = `${incomingTransfers.size} 个任务`;

  incomingTransfers.forEach((transfer) => {
    const { meta, accepted, receivedBytes } = transfer;
    const card = document.createElement('div');
    card.className = 'incoming-card';
    const percent = meta.fileSize ? Math.min(100, (receivedBytes / meta.fileSize) * 100) : 0;
    const progressText = percent.toFixed(1);
    const speedText = transfer.speedBps ? formatSpeed(transfer.speedBps) : '--/s';
    const progressLabel = accepted ? `已接收 ${progressText}% · ${speedText}` : '等待接受';
    const fillWidth = accepted ? percent : 0;
    const displayName = meta.relativePath || meta.fileName;
    const bundleLabel = meta.bundleId
      ? ` · 第 ${meta.bundleIndex || '?'} / ${meta.bundleTotal || '?'} 个`
      : '';

    card.innerHTML = `
      <div class="incoming-title">${displayName}</div>
      <div class="incoming-from">来自 ${meta.fromName || '未知设备'}${bundleLabel} · ${formatBytes(meta.fileSize)}</div>
      <div class="incoming-progress">${progressLabel}</div>
      <div class="progress-bar incoming-progress-bar">
        <div class="progress-bar__fill" style="width:${fillWidth}%"></div>
      </div>
    `;

    if (!accepted) {
      const session = meta.bundleId ? bundleSessions.get(meta.bundleId) : null;
      if (session?.autoAccept) {
        const autoTag = document.createElement('div');
        autoTag.className = 'auto-accept';
        autoTag.textContent = '已自动接受';
        card.appendChild(autoTag);
      } else {
        const acceptBtn = document.createElement('button');
        acceptBtn.textContent = '接受并保存';
        acceptBtn.addEventListener('click', () => acceptIncomingTransfer(meta.transferId));
        card.appendChild(acceptBtn);

        if (meta.bundleId) {
          const bundleBtn = document.createElement('button');
          bundleBtn.textContent = '接受整批';
          bundleBtn.classList.add('secondary');
          bundleBtn.addEventListener('click', () => acceptBundle(meta.bundleId, meta.transferId));
          card.appendChild(bundleBtn);
        }
      }
    }

    elements.incomingList.appendChild(card);
  });
}

function acceptBundle(bundleId, initialTransferId) {
  const session = bundleSessions.get(bundleId) || { autoAccept: false };
  session.autoAccept = true;
  bundleSessions.set(bundleId, session);
  acceptIncomingTransfer(initialTransferId).catch((error) =>
    console.error('接受整批失败', error)
  );

  // 自动接受尚未处理的同一 bundle 文件
  for (const [transferId, transfer] of incomingTransfers.entries()) {
    if (!transfer.accepted && transfer.meta.bundleId === bundleId && transferId !== initialTransferId) {
      acceptIncomingTransfer(transferId, { auto: true }).catch((error) =>
        console.error('自动接受后续文件失败', error)
      );
    }
  }
}

function sendMessage(payload) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  } else {
    logEvent('⚠️ 未连接，无法发送');
  }
}

function sendBinaryChunk(meta, chunk) {
  if (socket.readyState !== WebSocket.OPEN) {
    throw new Error('连接已断开');
  }
  return waitForLowBuffer().then(() => {
    const frame = buildBinaryFrame(meta, chunk);
    try {
      // Browser WebSocket.send does NOT support a callback; exceptions are thrown synchronously.
      socket.send(frame);
      return; // resolve undefined
    } catch (error) {
      // Surface synchronous send errors (e.g., NetworkError when connection just closed)
      throw error;
    }
  });
}

function waitForLowBuffer() {
  const MAX_BUFFERED = 16 * 1024 * 1024;
  if (socket.bufferedAmount < MAX_BUFFERED) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const tick = () => {
      if (socket.bufferedAmount < MAX_BUFFERED) {
        resolve();
      } else {
        setTimeout(tick, 25);
      }
    };
    tick();
  });
}

function updateOutgoingMetrics(transfer, bytes) {
  const now = performance.now();
  if (!transfer.startTime) {
    transfer.startTime = now;
    transfer.lastTickTime = now;
  }
  const delta = Math.max(1, now - (transfer.lastTickTime || now));
  const instantBps = bytes / (delta / 1000);
  transfer.speedBps = transfer.speedBps ? transfer.speedBps * 0.8 + instantBps * 0.2 : instantBps;
  transfer.lastTickTime = now;
}

function updateOutgoingIndicators(transfer, { done = false } = {}) {
  if (state.activeOutgoingId !== transfer.transferId) {
    return;
  }
  const queue = transfer.queueContext;
  let percent = 0;
  if (queue && queue.totalBytes) {
    const base = queue.completedBytes || 0;
    percent = Math.min(100, ((base + transfer.sentBytes) / queue.totalBytes) * 100);
  } else {
    percent = transfer.file.size ? Math.min(100, (transfer.sentBytes / transfer.file.size) * 100) : 0;
  }
  setSendProgress(percent);
  if (done) {
    setSendStatus(`发送完成：${transfer.file.name}`);
    setTimeout(() => {
      if (!state.activeOutgoingId) {
        resetOutgoingStatus();
      }
    }, 4000);
    return;
  }
  const speedText = transfer.speedBps ? formatSpeed(transfer.speedBps) : '--/s';
  const queueLabel = queue ? `文件 ${queue.currentIndex + 1}/${queue.totalCount} · ` : '';
  setSendStatus(`${queueLabel}已发送 ${percent.toFixed(1)}% · ${speedText}`);
}

function updateIncomingMetrics(transfer, bytes) {
  const now = performance.now();
  if (!transfer.startTime) {
    transfer.startTime = now;
    transfer.lastTickTime = now;
  }
  const delta = Math.max(1, now - (transfer.lastTickTime || now));
  const instantBps = bytes / (delta / 1000);
  transfer.speedBps = transfer.speedBps ? transfer.speedBps * 0.8 + instantBps * 0.2 : instantBps;
  transfer.lastTickTime = now;
}

function buildBinaryFrame(meta, chunk) {
  const header = encoder.encode(JSON.stringify(meta));
  const body = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
  const buffer = new Uint8Array(4 + header.length + body.length);
  const view = new DataView(buffer.buffer);
  view.setUint32(0, header.length);
  buffer.set(header, 4);
  buffer.set(body, 4 + header.length);
  return buffer;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'lan-file';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function deriveDeviceName() {
  const platform = navigator.userAgentData?.platform || navigator.platform || '设备';
  const vendor = navigator.vendor || '';
  const base = `${platform} ${vendor}`.trim();
  const suffix = (navigator.userAgent.match(/[a-zA-Z0-9]{4,}/g) || ['NODE']).pop();
  return `${base || '设备'}-${suffix?.slice(-4) || Math.floor(Math.random() * 9999)}`;
}

function logEvent(text) {
  const item = document.createElement('li');
  item.className = 'log-item';
  const time = new Date().toLocaleTimeString();
  item.textContent = `[${time}] ${text}`;
  elements.log.prepend(item);
  while (elements.log.children.length > 30) {
    elements.log.lastChild.remove();
  }
}

function setSendProgress(percent) {
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  elements.sendProgress.style.width = `${clamped}%`;
}

function setSendStatus(text) {
  elements.sendStatus.textContent = text;
}

function resetOutgoingStatus(message = '等待选择文件') {
  if (state.activeOutgoingId) {
    return;
  }
  setSendProgress(0);
  setSendStatus(message);
}

function updateSendPlaceholder() {
  if (state.activeOutgoingId || state.sendQueue) {
    return;
  }
  if (state.selectedFiles.length === 0) {
    resetOutgoingStatus();
    return;
  }
  if (state.selectedFiles.length === 1) {
    const file = state.selectedFiles[0];
    setSendProgress(0);
    setSendStatus(`待发送：${file.name} (${formatBytes(file.size)})`);
    return;
  }
  const totalSize = state.selectedFiles.reduce((sum, file) => sum + (file.size || 0), 0);
  setSendProgress(0);
  setSendStatus(`待发送 ${state.selectedFiles.length} 个文件（${formatBytes(totalSize)}）`);
}

function formatBytes(bytes = 0) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(1)} ${units[exponent]}`;
}

function formatSpeed(bps = 0) {
  if (!Number.isFinite(bps) || bps <= 0) {
    return '--/s';
  }
  return `${formatBytes(bps)}/s`;
}

function safeUUID() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function resolvePeerName(id) {
  const peer = state.peers.find((p) => p.id === id);
  return peer?.name || '对方';
}

function deriveBundleName(files) {
  if (!files || files.length === 0) {
    return '';
  }
  const first = files[0];
  const rel = first.webkitRelativePath || first.relativePath || '';
  if (rel.includes('/')) {
    return rel.split('/')[0];
  }
  const candidate = files
    .map((file) => ((file.webkitRelativePath || file.relativePath || '')).split('/')[0])
    .find((segment) => segment);
  return candidate || first.name;
}

function setupDropZone() {
  if (!elements.dropZone) {
    return;
  }
  const zone = elements.dropZone;
  const activate = (event) => {
    event.preventDefault();
    zone.classList.add('active');
  };
  const deactivate = (event) => {
    event.preventDefault();
    zone.classList.remove('active');
  };
  zone.addEventListener('dragenter', (e) => {
    activate(e);
    debugLog('dragenter');
  });
  zone.addEventListener('dragover', (event) => {
    activate(event);
    try {
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    } catch {}
  });
  zone.addEventListener('dragleave', deactivate);
  zone.addEventListener('drop', async (event) => {
    event.preventDefault();
    zone.classList.remove('active');
    try {
      const items = event.dataTransfer?.items;
      debugLog(`drop: items=${items?.length ?? 0}, files=${event.dataTransfer?.files?.length ?? 0}`);
      if (items && items.length) {
        for (let i = 0; i < items.length; i += 1) {
          const it = items[i];
          debugLog(`item[${i}]: kind=${it.kind}, type=${it.type}, hasFSHandle=${typeof it.getAsFileSystemHandle === 'function'}, hasWebkitEntry=${typeof it.webkitGetAsEntry === 'function'}, hasGetAsEntry=${typeof it.getAsEntry === 'function'}`);
        }
      }
    } catch {}
    const files = await collectFilesFromDataTransfer(event.dataTransfer);
    if (!files || files.length === 0) {
      logEvent('⚠️ 当前浏览器/环境不支持拖拽文件夹，请点击“选择文件夹”按钮选择目录。');
      // Try to open the folder picker as a user-gesture continuation
      try { elements.folderBtn?.focus(); elements.folderInput?.click(); } catch {}
      return;
    }
    applySelectedFiles(files, { announce: true });
  });
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => {
    if (zone.contains(event.target)) {
      return;
    }
    event.preventDefault();
  });
}

async function collectFiles(fileList) {
  if (!fileList || !fileList.length) {
    return [];
  }
  const files = [];
  const chunk = 200;
  const length = fileList.length ?? fileList.size ?? 0;
  for (let index = 0; index < length; index += 1) {
    const file = fileList.item ? fileList.item(index) : fileList[index];
    if (file) {
      files.push(file);
    }
    if (index % chunk === 0) {
      await microPause();
    }
  }
  return files;
}

async function collectFilesFromDataTransfer(dt) {
  if (!dt) return [];
  const items = dt.items;
  if (items && items.length) {
    const out = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      try {
        // Prefer WebKit path first (works in non-secure contexts too)
        if (typeof item.webkitGetAsEntry === 'function' || typeof item.getAsEntry === 'function') {
          const entry = (item.webkitGetAsEntry && item.webkitGetAsEntry()) || (item.getAsEntry && item.getAsEntry());
          if (entry) {
            debugLog(`WebKitEntry: isFile=${entry.isFile}, isDirectory=${entry.isDirectory}, name=${entry.name}`);
            const nested = await collectFilesFromEntry(entry, entry.name);
            out.push(...nested);
            if (i % 20 === 0) await microPause();
            continue;
          }
        }
        // Then try modern File System Access if available
        if (typeof item.getAsFileSystemHandle === 'function') {
          const handle = await item.getAsFileSystemHandle();
          if (handle) {
            debugLog(`FSHandle: kind=${handle.kind}, name=${handle.name || ''}`);
            if (handle.kind === 'file') {
              const file = await handle.getFile();
              defineRelativePath(file, handle.name);
              out.push(file);
            } else if (handle.kind === 'directory') {
              const nested = await collectFilesFromDirectory(handle, handle.name);
              out.push(...nested);
            }
            if (i % 50 === 0) await microPause();
            continue; // proceed next item
          }
        }
        // Fallback per-item to file when available
        const file = item.getAsFile && item.getAsFile();
        if (file) out.push(file);
      } catch (_) {
        // ignore single item error and continue
      }
    }
    if (out.length) return out;
  }
  // Fallback: plain FileList (may miss directories)
  return collectFiles(dt.files);
}

async function collectFilesFromEntry(entry, basePath) {
  const out = [];
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    defineRelativePath(file, basePath);
    debugLog(`push file[webkit]: ${basePath} (${formatBytes(file.size)})`);
    out.push(file);
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    while (true) {
      const entries = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      debugLog(`readEntries(${basePath}) -> ${entries?.length || 0}`);
      if (!entries || entries.length === 0) break;
      for (const sub of entries) {
        const nested = await collectFilesFromEntry(sub, `${basePath}/${sub.name}`);
        out.push(...nested);
      }
      if (out.length % 200 === 0) await microPause();
    }
  }
  return out;
}

async function collectFilesFromDirectory(handle, basePath = handle.name) {
  const files = [];
  try {
    if (typeof handle.values === 'function') {
      for await (const entry of handle.values()) {
        const currentPath = `${basePath}/${entry.name}`;
        if (entry.kind === 'file') {
          const file = await entry.getFile();
          defineRelativePath(file, currentPath);
          debugLog(`push file[fs]: ${currentPath} (${formatBytes(file.size)})`);
          files.push(file);
        } else if (entry.kind === 'directory') {
          const nested = await collectFilesFromDirectory(entry, currentPath);
          files.push(...nested);
        }
        if (files.length % 200 === 0) await microPause();
      }
      return files;
    }
    if (typeof handle.entries === 'function') {
      for await (const [name, entry] of handle.entries()) {
        const currentPath = `${basePath}/${name}`;
        if (entry.kind === 'file') {
          const file = await entry.getFile();
          defineRelativePath(file, currentPath);
          debugLog(`push file[fs]: ${currentPath} (${formatBytes(file.size)})`);
          files.push(file);
        } else if (entry.kind === 'directory') {
          const nested = await collectFilesFromDirectory(entry, currentPath);
          files.push(...nested);
        }
        if (files.length % 200 === 0) await microPause();
      }
      return files;
    }
  } catch (e) {
    debugLog(`collectFilesFromDirectory error: ${e?.message || e}`);
  }
  debugLog('collectFilesFromDirectory fell back; no values()/entries() available');
  return files;
}

function defineRelativePath(file, path) {
  try {
    Object.defineProperty(file, 'webkitRelativePath', {
      value: path,
      configurable: true,
    });
  } catch (error) {
    file.relativePath = path;
  }
}

function applySelectedFiles(files, { announce = false, source = '' } = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    return;
  }
  state.selectedFiles = files;
  if (announce) {
    const totalSize = files.reduce((sum, file) => sum + (file.size || 0), 0);
    const label = source ? `${files.length} 个文件（来自 ${source}）` : `${files.length} 个文件`;
    logEvent(`📁 已选 ${label} · 总计 ${formatBytes(totalSize)}`);
  }
  updateSendPlaceholder();
  updateSendButton();
}

function microPause() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function hasPendingBundleTransfers(bundleId) {
  for (const transfer of incomingTransfers.values()) {
    if (transfer.meta.bundleId === bundleId) {
      return true;
    }
  }
  return false;
}
