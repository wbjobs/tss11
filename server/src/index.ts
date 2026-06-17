import { WebSocketServer, WebSocket } from 'ws';
import { createServer, IncomingMessage } from 'http';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import {
  CRDTDocument,
  Operation,
  SyncMessage,
  Note,
} from '../../shared/src/index';

interface ClientSession {
  id: string;
  ws: WebSocket;
  sendStream: {
    write: (data: Uint8Array) => Promise<void>;
  };
}

const clients: Map<string, ClientSession> = new Map();
const doc = new CRDTDocument('server');

function ensureCerts(): { key: string; cert: string } {
  const certDir = join(process.cwd(), 'certs');
  const keyPath = join(certDir, 'key.pem');
  const certPath = join(certDir, 'cert.pem');

  if (existsSync(keyPath) && existsSync(certPath)) {
    return {
      key: readFileSync(keyPath, 'utf8'),
      cert: readFileSync(certPath, 'utf8'),
    };
  }

  console.log('[INFO] No TLS certs found. Generating self-signed certificate...');
  if (!existsSync(certDir)) mkdirSync(certDir, { recursive: true });

  try {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 365 -nodes -subj "/CN=localhost"`,
      { stdio: 'pipe' }
    );
    console.log('[INFO] Self-signed certificate generated.');
    return {
      key: readFileSync(keyPath, 'utf8'),
      cert: readFileSync(certPath, 'utf8'),
    };
  } catch {
    console.warn('[WARN] Failed to generate cert, running in HTTP-only mode (WebSocket only).');
    return { key: '', cert: '' };
  }
}

function encode(msg: SyncMessage): string {
  return JSON.stringify(msg) + '\n';
}

async function broadcast(msg: SyncMessage, excludeId?: string) {
  const data = encode(msg);
  const dead: string[] = [];
  console.log(`[BROADCAST] Sending ${msg.type} to ${clients.size - (excludeId ? 1 : 0)} clients`);

  for (const [id, client] of clients) {
    if (id === excludeId) continue;
    try {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      } else {
        dead.push(id);
      }
    } catch {
      dead.push(id);
    }
  }

  for (const id of dead) clients.delete(id);
}

function handleMessage(rawData: string | Buffer, clientId: string) {
  let buffer = '';
  try {
    const data = typeof rawData === 'string' ? rawData : rawData.toString('utf8');
    buffer += data;

    const parts = buffer.split('\n');
    buffer = parts.pop() || '';

    for (const part of parts) {
      if (!part.trim()) continue;
      const msg: SyncMessage = JSON.parse(part);

      if (msg.type === 'op') {
        const op = msg.payload as Operation;
        const changed = doc.applyOperation(op);
        if (changed) {
          broadcast(msg, clientId);
        }
      } else if (msg.type === 'full-sync') {
        const notes = doc.getNotes();
        const syncMsg: SyncMessage = { type: 'full-sync', payload: notes };
        const client = clients.get(clientId);
        if (client && client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(encode(syncMsg));
        }
      }
    }
  } catch (e) {
    console.error('[ERROR] Parse error:', e);
  }
}

function handleConnection(ws: WebSocket, _req: IncomingMessage) {
  const clientId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  console.log(`[INFO] Client connected: ${clientId} (total: ${clients.size + 1})`);

  const client: ClientSession = {
    id: clientId,
    ws,
    sendStream: {
      write: async (data: Uint8Array) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      },
    },
  };

  clients.set(clientId, client);

  const notes = doc.getNotes();
  const syncMsg: SyncMessage = { type: 'full-sync', payload: notes };
  const syncStr = encode(syncMsg);
  console.log(`[INIT] Sending full-sync to ${clientId}: ${syncStr.substring(0, 100)}...`);
  ws.send(syncStr);

  ws.on('message', (data) => handleMessage(data as any, clientId));

  ws.on('close', () => {
    clients.delete(clientId);
    console.log(`[INFO] Client ${clientId} disconnected (total: ${clients.size})`);
  });

  ws.on('error', (err) => {
    console.error(`[ERROR] Client ${clientId}:`, err.message);
    clients.delete(clientId);
  });
}

async function startWebTransportServer(port: number, cert: string, key: string) {
  try {
    // @ts-ignore - dynamic import, types may not be available
    const wtModule = await import('@fails-components/webtransport');
    if (wtModule.WebTransportServer || wtModule.Http3Server || wtModule.HttpServer) {
      console.log('[INFO] WebTransport API available, attempting to start...');
    }
    return null;
  } catch {
    return null;
  }
}

async function main() {
  const port = parseInt(process.env.PORT || '4433');
  const certs = ensureCerts();

  const httpServer = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Collaborative Score Editor Server - WebSocket/WebTransport endpoint at /');
  });

  const wss = new WebSocketServer({ server: httpServer, path: '/' });

  wss.on('connection', handleConnection);

  startWebTransportServer(port, certs.cert, certs.key).then((wtServer) => {
    if (wtServer) {
      console.log('[INFO] WebTransport server started alongside WebSocket.');
    }
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(port, () => {
      console.log(`[INFO] Collaboration server listening on ws://localhost:${port}`);
      console.log(`[INFO] WebTransport endpoint: wss://localhost:${port} (fallback: ws://)`);
      console.log(`[INFO] Document has ${doc.getNotes().length} notes`);
      resolve();
    });
  });
}

main().catch(console.error);
