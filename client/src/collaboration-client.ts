import { Operation, SyncMessage } from 'shared';

type MessageHandler = (msg: SyncMessage) => void;

type TransportType = 'webtransport' | 'websocket';

interface Transport {
  type: TransportType;
  send: (data: Uint8Array) => Promise<void>;
  close: () => Promise<void>;
  isConnected: () => boolean;
}

export class CollaborationClient {
  private transport: Transport | null = null;
  private handler: MessageHandler | null = null;
  private connected = false;
  private wtUrl: string;
  private wsUrl: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;

  constructor(host: string, port: number) {
    this.wtUrl = `https://${host}:${port}`;
    this.wsUrl = `ws://${host}:${port}`;
  }

  onMessage(handler: MessageHandler) {
    this.handler = handler;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getTransportType(): TransportType | null {
    return this.transport?.type ?? null;
  }

  async connect(): Promise<TransportType> {
    try {
      await this.connectWebTransport();
      return 'webtransport';
    } catch (wtError) {
      console.warn('[Transport] WebTransport failed, falling back to WebSocket:', (wtError as Error).message);
      try {
        await this.connectWebSocket();
        return 'websocket';
      } catch (wsError) {
        console.error('[Transport] Both WebTransport and WebSocket failed:', (wsError as Error).message);
        this.scheduleReconnect();
        throw wsError;
      }
    }
  }

  private async connectWebTransport(): Promise<void> {
    if (typeof WebTransport === 'undefined') {
      throw new Error('WebTransport not supported in this browser');
    }

    console.log('[Transport] Attempting WebTransport connection to', this.wtUrl);

    const wt = new WebTransport(this.wtUrl, {
      serverCertificateHashes: [],
    } as WebTransportOptions);

    await wt.ready;
    this.connected = true;
    this.reconnectDelay = 1000;
    console.log('[Transport] WebTransport connected');

    const sendStream = await wt.createUnidirectionalStream();
    const sendWriter = sendStream.getWriter();

    this.transport = {
      type: 'webtransport',
      send: async (data: Uint8Array) => {
        try {
          await sendWriter.write(data);
        } catch (e) {
          console.error('[WT] Send failed:', e);
        }
      },
      close: async () => {
        try { await sendWriter.close(); } catch {}
        try { await wt.close(); } catch {}
      },
      isConnected: () => this.connected,
    };

    this.setupWTReceiveLoop(wt);

    wt.closed.then(() => {
      console.log('[Transport] WebTransport closed');
      this.connected = false;
      this.scheduleReconnect();
    }).catch(() => {
      this.connected = false;
      this.scheduleReconnect();
    });
  }

  private async setupWTReceiveLoop(wt: WebTransport) {
    try {
      const reader = wt.incomingUnidirectionalStreams.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        this.readStream(value);
      }
    } catch {
      // receive loop closed
    }
  }

  private async connectWebSocket(): Promise<void> {
    console.log('[Transport] Attempting WebSocket connection to', this.wsUrl);

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      ws.binaryType = 'arraybuffer';

      let settled = false;

      const cleanup = () => {
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
      };

      const onOpen = () => {
        if (settled) return;
        settled = true;
        cleanup();

        this.connected = true;
        this.reconnectDelay = 1000;
        console.log('[Transport] WebSocket connected');

        this.transport = {
          type: 'websocket',
          send: async (data: Uint8Array) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(data);
            }
          },
          close: async () => {
            ws.close();
          },
          isConnected: () => ws.readyState === WebSocket.OPEN,
        };

        ws.addEventListener('message', (ev) => {
          try {
            if (typeof ev.data === 'string') {
              console.log('[Transport] WS received string, length:', ev.data.length);
              this.handleRawText(ev.data);
              return;
            }
            let data: Uint8Array;
            if (ev.data instanceof ArrayBuffer) {
              data = new Uint8Array(ev.data);
              console.log('[Transport] WS received ArrayBuffer, bytes:', data.length);
            } else if (ev.data instanceof Blob) {
              console.log('[Transport] WS received Blob, bytes:', ev.data.size);
              ev.data.arrayBuffer().then((buf) => {
                this.handleRawData(new Uint8Array(buf));
              });
              return;
            } else {
              data = new TextEncoder().encode(ev.data as string);
            }
            this.handleRawData(data);
          } catch (e) {
            console.error('[Transport] WS message error:', e);
          }
        });

        ws.addEventListener('close', (ev) => {
          console.log('[Transport] WebSocket closed. code:', ev.code, 'reason:', ev.reason, 'wasClean:', ev.wasClean);
          this.connected = false;
          this.scheduleReconnect();
        });

        ws.addEventListener('error', (ev) => {
          console.error('[Transport] WebSocket error:', ev);
          this.connected = false;
          this.scheduleReconnect();
        });

        resolve();
      };

      const onError = (err: Event) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
    });
  }

  private async readStream(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    let buffer = '';

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += new TextDecoder().decode(value, { stream: true });
        const parts = buffer.split('\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
          if (!part.trim()) continue;
          this.handleMessageString(part);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private handleRawText(text: string) {
    console.log('[Transport] handleRawText, length:', text.length, 'preview:', text.substring(0, Math.min(100, text.length)));
    const parts = text.split('\n');
    for (const part of parts) {
      if (!part.trim()) continue;
      this.handleMessageString(part);
    }
  }

  private handleRawData(data: Uint8Array) {
    const text = new TextDecoder().decode(data);
    const parts = text.split('\n');
    for (const part of parts) {
      if (!part.trim()) continue;
      this.handleMessageString(part);
    }
  }

  private handleMessageString(str: string) {
    try {
      const msg: SyncMessage = JSON.parse(str);
      console.log('[Transport] Parsed msg type:', msg.type);
      this.handler?.(msg);
    } catch (e) {
      console.error('[Transport] Parse error:', (e as Error).message, 'str:', str.substring(0, 200));
      console.error('[Transport] Parse stack:', (e as Error).stack);
    }
  }

  async sendOperation(op: Operation): Promise<void> {
    if (!this.transport) {
      console.warn('[Transport] No transport available');
      return;
    }
    const msg: SyncMessage = { type: 'op', payload: op };
    const json = JSON.stringify(msg) + '\n';
    const data = new TextEncoder().encode(json);
    await this.transport.send(data);
  }

  async requestFullSync(): Promise<void> {
    if (!this.transport) return;
    const msg: SyncMessage = { type: 'full-sync', payload: { version: 0 } };
    const json = JSON.stringify(msg) + '\n';
    const data = new TextEncoder().encode(json);
    await this.transport.send(data);
  }

  async send(message: string): Promise<void> {
    if (!this.transport) {
      console.warn('[Transport] No transport available');
      return;
    }
    const json = message + '\n';
    const data = new TextEncoder().encode(json);
    await this.transport.send(data);
  }

  async disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.transport) {
      try { await this.transport.close(); } catch {}
    }
    this.connected = false;
    this.transport = null;
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    console.log(`[Transport] Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      this.connect().catch(() => {});
    }, this.reconnectDelay);
  }
}
