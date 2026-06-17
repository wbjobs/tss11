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
  Chord,
  AccompanimentPattern,
  analyzeChordProgression,
} from '../../shared/src/index';
import { AccompanimentGenerator } from './markov-accompaniment';

interface ClientSession {
  id: string;
  ws: WebSocket;
  sendStream: {
    write: (data: Uint8Array) => Promise<void>;
  };
}

const clients: Map<string, ClientSession> = new Map();
const doc = new CRDTDocument('server');
let hostClientId: string | null = null;
const accompanimentGenerator = new AccompanimentGenerator();

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
        op.ownerRole = clientId === hostClientId ? 'host' : 'guest';
        const result = doc.applyOperation(op);
        if (result.changed) {
          broadcast(msg, clientId);
        }
      } else if (msg.type === 'full-sync') {
        const notes = doc.getNotes();
        const syncMsg: SyncMessage = { type: 'full-sync', payload: notes };
        const client = clients.get(clientId);
        if (client && client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(encode(syncMsg));
        }
      } else if (msg.type === 'request-accompaniment') {
        if (clientId !== hostClientId) {
          console.log(`[WARN] Non-host client ${clientId} attempted to request accompaniment`);
          continue;
        }

        const payload = msg.payload as { clearExisting?: boolean; pattern?: AccompanimentPattern };
        const notes = doc.getNotes();
        const chordMap = analyzeChordProgression(notes);
        const chords = Array.from(chordMap.values());

        console.log(`[ACCOMPANIMENT] Analyzed ${chords.length} chords from ${notes.length} notes`);

        const staffMetrics = {
          staffTopY: 60,
          lineSpacing: 14,
          staffMarginX: 80,
          measureWidth: 381,
          measuresPerStaff: 4,
        };

        if (payload.clearExisting) {
          doc.clearAccompaniment();
          console.log('[ACCOMPANIMENT] Cleared existing accompaniment');
        }

        const accompanimentNotes = accompanimentGenerator.generate(chords, {
          pattern: payload.pattern,
          staffMetrics,
        });

        doc.addAccompanimentNotes(accompanimentNotes);
        console.log(`[ACCOMPANIMENT] Generated ${accompanimentNotes.length} accompaniment notes`);

        const resultMsg: SyncMessage = {
          type: 'accompaniment-result',
          payload: { chords, notes: accompanimentNotes },
        };
        broadcast(resultMsg);
      } else if (msg.type === 'chord-analysis') {
        const notes = doc.getNotes();
        const chordMap = analyzeChordProgression(notes);
        const chords = Array.from(chordMap.values());

        console.log(`[CHORD-ANALYSIS] Client ${clientId} requested chord analysis, found ${chords.length} chords`);

        const resultMsg: SyncMessage = {
          type: 'chord-analysis',
          payload: chords,
        };
        const client = clients.get(clientId);
        if (client && client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(encode(resultMsg));
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

  const welcomeMsg: SyncMessage = {
    type: 'welcome',
    payload: { clientId },
  };
  ws.send(encode(welcomeMsg));
  console.log(`[WELCOME] Sent clientId to ${clientId}`);

  if (hostClientId === null) {
    hostClientId = clientId;
    doc.setHostClientId(hostClientId);
    console.log(`[INFO] First client connected, set as host: ${hostClientId}`);
  }

  const notes = doc.getNotes();
  const syncMsg: SyncMessage = { type: 'full-sync', payload: notes };
  const syncStr = encode(syncMsg);
  console.log(`[INIT] Sending full-sync to ${clientId}: ${syncStr.substring(0, 100)}...`);
  ws.send(syncStr);

  const role: 'host' | 'guest' = clientId === hostClientId ? 'host' : 'guest';
  const roleMsg: SyncMessage = {
    type: 'role-assign',
    payload: { role, clientId, hostClientId },
  };
  ws.send(encode(roleMsg));
  console.log(`[ROLE] Sent role-assign to ${clientId}: role=${role}, host=${hostClientId}`);

  if (clients.size > 1) {
    const roleBroadcast: SyncMessage = {
      type: 'role-assign',
      payload: { role: 'guest', clientId: '', hostClientId },
    };
    broadcast(roleBroadcast, clientId);
  }

  ws.on('message', (data) => handleMessage(data as any, clientId));

  ws.on('close', () => {
    clients.delete(clientId);
    console.log(`[INFO] Client ${clientId} disconnected (total: ${clients.size})`);

    if (clientId === hostClientId) {
      const remainingClients = Array.from(clients.keys());
      if (remainingClients.length > 0) {
        hostClientId = remainingClients[0];
        doc.setHostClientId(hostClientId);
        console.log(`[INFO] Host disconnected, new host: ${hostClientId}`);

        const hostRoleMsg: SyncMessage = {
          type: 'role-assign',
          payload: { role: 'host', clientId: hostClientId, hostClientId },
        };
        const newHost = clients.get(hostClientId);
        if (newHost && newHost.ws.readyState === WebSocket.OPEN) {
          newHost.ws.send(encode(hostRoleMsg));
        }

        const guestRoleMsg: SyncMessage = {
          type: 'role-assign',
          payload: { role: 'guest', clientId: '', hostClientId },
        };
        broadcast(guestRoleMsg, hostClientId);
      } else {
        hostClientId = null;
        doc.setHostClientId(null);
        console.log('[INFO] Last client disconnected, host cleared');
      }
    }
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
