import { Note, Operation, SyncMessage } from 'shared';

function generateId(): string {
  return Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
}

class LWWRegister<T> {
  value: T;
  timestamp: number;
  clientId: string;

  constructor(value: T, timestamp: number, clientId: string) {
    this.value = value;
    this.timestamp = timestamp;
    this.clientId = clientId;
  }

  merge(other: LWWRegister<T>): LWWRegister<T> {
    if (other.timestamp > this.timestamp) return other;
    if (other.timestamp < this.timestamp) return this;
    return other.clientId > this.clientId ? other : this;
  }
}

export class ClientDocument {
  private notes: Map<string, LWWRegister<Note>> = new Map();
  private tombstones: Set<string> = new Set();
  private tombstoneTimestamps: Map<string, { timestamp: number; clientId: string }> = new Map();
  private clientId: string;
  private clock: number;
  private undoStack: Operation[] = [];
  private onLocalOp: ((op: Operation) => void) | null = null;

  constructor(clientId?: string) {
    this.clientId = clientId || generateId();
    this.clock = Date.now();
  }

  getClientId(): string {
    return this.clientId;
  }

  onOperation(handler: (op: Operation) => void) {
    this.onLocalOp = handler;
  }

  private getTimestamp(): number {
    this.clock = Math.max(this.clock + 1, Date.now());
    return this.clock;
  }

  private isTombstoned(noteId: string): boolean {
    return this.tombstones.has(noteId);
  }

  private shouldKeepTombstone(noteId: string, ts: number, cid: string): boolean {
    const existing = this.tombstoneTimestamps.get(noteId);
    if (!existing) return false;
    if (ts > existing.timestamp) return false;
    if (ts < existing.timestamp) return true;
    return cid <= existing.clientId;
  }

  addNote(note: Omit<Note, 'id'>): Operation {
    const timestamp = this.getTimestamp();
    const id = generateId();
    const fullNote: Note = { ...note, id };
    this.notes.set(id, new LWWRegister(fullNote, timestamp, this.clientId));
    this.tombstones.delete(id);
    this.tombstoneTimestamps.delete(id);
    const op: Operation = { type: 'add', note: fullNote, timestamp, clientId: this.clientId };
    this.undoStack.push(op);
    this.onLocalOp?.(op);
    return op;
  }

  removeNote(noteId: string): Operation | null {
    const timestamp = this.getTimestamp();
    const existing = this.notes.get(noteId);
    if (!existing) return null;
    this.tombstones.add(noteId);
    this.tombstoneTimestamps.set(noteId, { timestamp, clientId: this.clientId });
    this.notes.delete(noteId);
    const op: Operation = { type: 'remove', note: existing.value, timestamp, clientId: this.clientId };
    this.undoStack.push(op);
    this.onLocalOp?.(op);
    return op;
  }

  updateNote(noteId: string, partial: Partial<Note>): Operation | null {
    if (this.isTombstoned(noteId)) return null;
    const existing = this.notes.get(noteId);
    if (!existing) return null;
    const timestamp = this.getTimestamp();
    const updated: Note = { ...existing.value, ...partial, id: noteId };
    this.notes.set(noteId, new LWWRegister(updated, timestamp, this.clientId));
    const op: Operation = { type: 'update', note: updated, timestamp, clientId: this.clientId };
    this.undoStack.push(op);
    this.onLocalOp?.(op);
    return op;
  }

  applyRemoteOperation(op: Operation): boolean {
    const { type, note, timestamp, clientId } = op;

    if (clientId === this.clientId) return false;

    this.clock = Math.max(this.clock, timestamp + 1);

    if (type === 'add') {
      if (this.isTombstoned(note.id)) {
        if (this.shouldKeepTombstone(note.id, timestamp, clientId)) return false;
        this.tombstones.delete(note.id);
        this.tombstoneTimestamps.delete(note.id);
      }
      const existing = this.notes.get(note.id);
      const newReg = new LWWRegister(note, timestamp, clientId);
      if (existing) {
        const merged = existing.merge(newReg);
        if (merged === existing) return false;
        this.notes.set(note.id, merged);
      } else {
        this.notes.set(note.id, newReg);
      }
      return true;
    }

    if (type === 'remove') {
      const existingTs = this.tombstoneTimestamps.get(note.id);
      if (existingTs) {
        if (timestamp > existingTs.timestamp ||
          (timestamp === existingTs.timestamp && clientId > existingTs.clientId)) {
          this.tombstoneTimestamps.set(note.id, { timestamp, clientId });
        } else {
          return false;
        }
      } else {
        this.tombstoneTimestamps.set(note.id, { timestamp, clientId });
      }
      this.tombstones.add(note.id);
      this.notes.delete(note.id);
      return true;
    }

    if (type === 'update') {
      if (this.isTombstoned(note.id)) {
        if (this.shouldKeepTombstone(note.id, timestamp, clientId)) return false;
        this.tombstones.delete(note.id);
        this.tombstoneTimestamps.delete(note.id);
      }
      const existing = this.notes.get(note.id);
      const newReg = new LWWRegister(note, timestamp, clientId);
      if (existing) {
        const merged = existing.merge(newReg);
        if (merged === existing) return false;
        this.notes.set(note.id, merged);
      } else {
        this.notes.set(note.id, newReg);
      }
      return true;
    }

    return false;
  }

  loadFullSync(notes: Note[]) {
    this.notes.clear();
    this.tombstones.clear();
    this.tombstoneTimestamps.clear();
    const ts = Date.now();
    for (const note of notes) {
      this.notes.set(note.id, new LWWRegister(note, ts, 'server'));
    }
  }

  getNotes(): Note[] {
    const result: Note[] = [];
    this.notes.forEach((reg) => {
      if (!this.isTombstoned(reg.value.id)) {
        result.push(reg.value);
      }
    });
    return result.sort((a, b) => {
      if (a.measure !== b.measure) return a.measure - b.measure;
      if (a.beat !== b.beat) return a.beat - b.beat;
      return a.x - b.x;
    });
  }

  getNotesByMeasure(measure: number): Note[] {
    return this.getNotes().filter((n) => n.measure === measure);
  }

  undo(): Operation | null {
    if (this.undoStack.length === 0) return null;
    const lastOp = this.undoStack.pop()!;
    if (lastOp.type === 'add') {
      return this.removeNote(lastOp.note.id);
    }
    if (lastOp.type === 'remove') {
      const timestamp = this.getTimestamp();
      const note = lastOp.note;
      this.tombstones.delete(note.id);
      this.tombstoneTimestamps.delete(note.id);
      this.notes.set(note.id, new LWWRegister(note, timestamp, this.clientId));
      const op: Operation = { type: 'add', note, timestamp, clientId: this.clientId };
      this.onLocalOp?.(op);
      return op;
    }
    return null;
  }
}
