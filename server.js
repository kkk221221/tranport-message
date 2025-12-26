const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { randomUUID } = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const USE_HTTPS = String(process.env.HTTPS || '').toLowerCase() === '1';

const app = express();
// Basic hardening for static server
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));

let server;
if (USE_HTTPS) {
  try {
    const keyPath = process.env.SSL_KEY_PATH || path.join(__dirname, 'certs', 'server.key');
    const certPath = process.env.SSL_CERT_PATH || path.join(__dirname, 'certs', 'server.crt');
    const creds = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    };
    server = https.createServer(creds, app);
  } catch (e) {
    console.warn('[WARN] HTTPS 启用失败，回退到 HTTP：', e?.message || e);
    server = http.createServer(app);
  }
} else {
  server = http.createServer(app);
}
const wss = new WebSocketServer({ server });

const clients = new Map(); // id -> { ws, info }

function getPeerSnapshot() {
  return Array.from(clients.values()).map(({ info }) => ({
    id: info.id,
    name: info.name,
    joinedAt: info.joinedAt,
  }));
}

function broadcastPeers() {
  const peers = getPeerSnapshot();
  for (const { ws } of clients.values()) {
    safeSend(ws, { type: 'peers', peers });
  }
}

function safeSend(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function relay(toId, payload) {
  const target = clients.get(toId);
  if (!target) {
    return false;
  }
  safeSend(target.ws, payload);
  return true;
}

wss.on('connection', (ws) => {
  const id = randomUUID();
  const info = {
    id,
    name: `设备-${id.slice(0, 5)}`,
    joinedAt: Date.now(),
  };
  clients.set(id, { ws, info });

  safeSend(ws, { type: 'welcome', id, peers: getPeerSnapshot() });
  broadcastPeers();

  ws.on('message', (raw, isBinary) => {
    const client = clients.get(id);
    if (!client) {
      return;
    }

    if (isBinary) {
      handleBinaryMessage(id, raw);
      return;
    }

    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (error) {
      return;
    }

    switch (message.type) {
      case 'register': {
        const cleanName = (message.name || '').toString().trim();
        client.info.name = cleanName.substring(0, 60) || client.info.name;
        broadcastPeers();
        break;
      }
      case 'file-offer': {
        const payload = {
          type: 'file-offer',
          from: id,
          fromName: client.info.name,
          transferId: message.transferId,
          fileName: message.fileName,
          fileSize: message.fileSize,
          mimeType: message.mimeType,
          // Pass-through extra metadata to support folder bundles and relative paths
          relativePath: message.relativePath,
          bundleId: message.bundleId,
          bundleName: message.bundleName,
          bundleTotal: message.bundleTotal,
          bundleIndex: message.bundleIndex,
        };
        relay(message.to, payload);
        break;
      }
      case 'file-accept': {
        relay(message.to, {
          type: 'file-accept',
          from: id,
          fromName: client.info.name,
          transferId: message.transferId,
        });
        break;
      }
      case 'file-complete': {
        relay(message.to, {
          type: 'file-complete',
          from: id,
          transferId: message.transferId,
        });
        break;
      }
      default:
        break;
    }
  });

  ws.on('close', () => {
    clients.delete(id);
    broadcastPeers();
  });

  ws.on('error', () => {
    // Ensure cleanup even on error
    clients.delete(id);
    broadcastPeers();
  });
});

server.listen(PORT, () => {
  const scheme = server instanceof https.Server ? 'https' : 'http';
  console.log(`LAN transfer server running on ${scheme}://localhost:${PORT}`);
});

function handleBinaryMessage(senderId, buffer) {
  if (!Buffer.isBuffer(buffer)) {
    buffer = Buffer.from(buffer);
  }
  if (buffer.length < 4) {
    return;
  }
  const headerLength = buffer.readUInt32BE(0);
  // Guard against unreasonable header sizes
  const MAX_HEADER = 256 * 1024; // 256 KiB is more than enough
  if (headerLength <= 0 || headerLength > MAX_HEADER) {
    return;
  }
  if (buffer.length < 4 + headerLength) {
    return;
  }
  const headerSlice = buffer.subarray(4, 4 + headerLength);
  let header;
  try {
    header = JSON.parse(headerSlice.toString('utf8'));
  } catch (error) {
    return;
  }
  const chunk = buffer.subarray(4 + headerLength);
  if (header.type !== 'file-chunk' || !header.to) {
    return;
  }
  const sender = clients.get(senderId);
  relayBinary(
    senderId,
    header.to,
    {
      type: 'file-chunk',
      transferId: header.transferId,
      seq: header.seq,
      fromName: sender?.info?.name,
    },
    chunk
  );
}

function relayBinary(fromId, toId, meta, chunk = Buffer.alloc(0)) {
  const target = clients.get(toId);
  if (!target) {
    return false;
  }
  const headerBuffer = Buffer.from(
    JSON.stringify({
      ...meta,
      from: fromId,
    }),
    'utf8'
  );
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(headerBuffer.length, 0);
  const payload = Buffer.concat([prefix, headerBuffer, chunk]);
  target.ws.send(payload, { binary: true });
  return true;
}
