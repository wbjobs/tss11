import { Note, Operation, OperationType } from './types';

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
    if (other.clientId > this.clientId) return other;
    return this;
  }
}

export class CRDTDocument {
  private notes: Map<string, LWWRegister<Note>> = new Map();
  private tombstones: Set<string> = new Set();
  private tombstoneTimestamps: Map<string, { timestamp: number; clientId: string }> = new Map();
  private clientId: string;
  private clock: number;

  constructor(clientId?: string) {
    this.clientId = clientId || generateId();
    this.clock = Date.now();
  }

  getClientId(): string {
    return this.clientId;
  }

  private getTimestamp(): number {
    this.clock = Math.max(this.clock + 1, Date.now());
    return this.clock;
  }

  private isTombstoned(noteId: string): boolean {
    return this.tombstones.has(noteId);
  }

  private shouldKeepTombstone(
    noteId: string,
    timestamp: number,
    clientId: string
  ): boolean {
    const existing = this.tombstoneTimestamps.get(noteId);
    if (!existing) return false;
    if (timestamp > existing.timestamp) return false;
    if (timestamp < existing.timestamp) return true;
    return clientId <= existing.clientId;
  }

  addNote(note: Note): Operation {
    const timestamp = this.getTimestamp();
    const noteWithId = { ...note, id: note.id || generateId() };
    this.notes.set(noteWithId.id, new LWWRegister(noteWithId, timestamp, this.clientId));
    this.tombstones.delete(noteWithId.id);
    this.tombstoneTimestamps.delete(noteWithId.id);
    return { type: 'add', note: noteWithId, timestamp, clientId: this.clientId };
  }

  removeNote(noteId: string): Operation | null {
    const timestamp = this.getTimestamp();
    const existing = this.notes.get(noteId);
    if (!existing) return null;
    this.tombstones.add(noteId);
    this.tombstoneTimestamps.set(noteId, { timestamp, clientId: this.clientId });
    this.notes.delete(noteId);
    return { type: 'remove', note: existing.value, timestamp, clientId: this.clientId };
  }

  updateNote(noteId: string, partial: Partial<Note>): Operation | null {
    if (this.isTombstoned(noteId)) return null;
    const existing = this.notes.get(noteId);
    if (!existing) return null;
    const timestamp = this.getTimestamp();
    const updated: Note = { ...existing.value, ...partial, id: noteId };
    this.notes.set(noteId, new LWWRegister(updated, timestamp, this.clientId));
    return { type: 'update', note: updated, timestamp, clientId: this.clientId };
  }

  applyOperation(op: Operation): boolean {
    const { type, note, timestamp, clientId } = op;

    if (type === 'add') {
      if (this.isTombstoned(note.id)) {
        if (this.shouldKeepTombstone(note.id, timestamp, clientId)) {
          return false;
        }
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
        if (this.shouldKeepTombstone(note.id, timestamp, clientId)) {
          return false;
        }
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

  getDocumentState(): { notes: Note[]; tombstones: string[] } {
    return {
      notes: this.getNotes(),
      tombstones: Array.from(this.tombstones),
    };
  }

  loadDocumentState(state: { notes: Note[]; tombstones: string[] }, timestamp: number, clientId: string): void {
    this.notes.clear();
    this.tombstones.clear();
    this.tombstoneTimestamps.clear();
    for (const note of state.notes) {
      this.notes.set(note.id, new LWWRegister(note, timestamp, clientId));
    }
    for (const id of state.tombstones) {
      this.tombstones.add(id);
      this.tombstoneTimestamps.set(id, { timestamp, clientId });
    }
  }
}
