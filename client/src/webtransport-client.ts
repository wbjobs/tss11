import { Operation, SyncMessage } from 'shared';

type MessageHandler = (msg: SyncMessage) => void;

export class WebTransportClient {
  private transport: WebTransport | null = null;
  private sendWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private handler: MessageHandler | null = null;
  private connected = false;
  private url: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;

  constructor(url: string) {
    this.url = url;
  }

  onMessage(handler: MessageHandler) {
    this.handler = handler;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    try {
      this.transport = new WebTransport(this.url);
      await this.transport.ready;
      this.connected = true;
      this.reconnectDelay = 1000;
      console.log('[WT] Connected to', this.url);

      this.setupReceiveLoop();
      this.setupSendStream();
    } catch (e) {
      console.error('[WT] Connection failed:', e);
      this.scheduleReconnect();
    }
  }

  private async setupSendStream() {
    if (!this.transport) return;
    try {
      const stream = await this.transport.createUnidirectionalStream();
      this.sendWriter = stream.getWriter();
    } catch (e) {
      console.error('[WT] Failed to create send stream:', e);
    }
  }

  private async setupReceiveLoop() {
    if (!this.transport) return;

    try {
      const reader = this.transport.incomingUnidirectionalStreams.getReader();

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        this.readIncomingStream(value);
      }
    } catch (e) {
      console.error('[WT] Receive loop error:', e);
    }
  }

  private async readIncomingStream(stream: ReadableStream<Uint8Array>) {
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
          try {
            const msg: SyncMessage = JSON.parse(part);
            if (this.handler) this.handler(msg);
          } catch (e) {
            console.error('[WT] Parse error:', e);
          }
        }
      }
    } catch {
      // stream closed
    } finally {
      reader.releaseLock();
    }
  }

  async sendOperation(op: Operation): Promise<void> {
    if (!this.sendWriter) {
      console.warn('[WT] No send stream available');
      return;
    }

    const msg: SyncMessage = { type: 'op', payload: op };
    const data = new TextEncoder().encode(JSON.stringify(msg) + '\n');

    try {
      await this.sendWriter.write(data);
    } catch (e) {
      console.error('[WT] Send failed:', e);
      this.sendWriter = null;
      this.setupSendStream();
    }
  }

  async requestFullSync(): Promise<void> {
    if (!this.sendWriter) return;
    const msg: SyncMessage = { type: 'full-sync', payload: { version: 0 } };
    const data = new TextEncoder().encode(JSON.stringify(msg) + '\n');
    try {
      await this.sendWriter.write(data);
    } catch (e) {
      console.error('[WT] Sync request failed:', e);
    }
  }

  async disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.sendWriter) {
      try { await this.sendWriter.close(); } catch {}
    }
    if (this.transport) {
      try { await this.transport.close(); } catch {}
    }
    this.connected = false;
    this.transport = null;
    this.sendWriter = null;
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    console.log(`[WT] Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      this.connect();
    }, this.reconnectDelay);
  }
}
