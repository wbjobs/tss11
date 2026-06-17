import { Note, Operation, OperationType, computeMergeScore, ClientPosition } from './types';

function generateId(): string {
  return Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
}

interface OwnershipInfo {
  clientId: string;
  timestamp: number;
}

class WeightedRegister {
  value: Note;
  timestamp: number;
  clientId: string;
  score: number;
  authorPosition?: ClientPosition;

  constructor(value: Note, timestamp: number, clientId: string, score: number, authorPosition?: ClientPosition) {
    this.value = value;
    this.timestamp = timestamp;
    this.clientId = clientId;
    this.score = score;
    this.authorPosition = authorPosition;
  }

  clone(): WeightedRegister {
    return new WeightedRegister({ ...this.value }, this.timestamp, this.clientId, this.score, this.authorPosition ? { ...this.authorPosition } : undefined);
  }
}

export class CRDTDocument {
  private notes: Map<string, WeightedRegister> = new Map();
  private tombstones: Set<string> = new Set();
  private tombstoneTimestamps: Map<string, { timestamp: number; clientId: string; score: number }> = new Map();
  private ownership: Map<string, OwnershipInfo> = new Map();
  private clientId: string;
  private clock: number;

  constructor(clientId?: string) {
    this.clientId = clientId || generateId();
    this.clock = Date.now();
  }

  getClientId(): string {
    return this.clientId;
  }

  setClientId(id: string): void {
    this.clientId = id;
  }

  private getTimestamp(): number {
    this.clock = Math.max(this.clock + 1, Date.now());
    return this.clock;
  }

  private isTombstoned(noteId: string): boolean {
    return this.tombstones.has(noteId);
  }

  private getOwnership(noteId: string): OwnershipInfo | null {
    return this.ownership.get(noteId) || null;
  }

  private updateOwnership(noteId: string, clientId: string, timestamp: number): void {
    this.ownership.set(noteId, { clientId, timestamp });
  }

  private computeNoteAnchor(noteId: string): { x: number; y: number } | null {
    const reg = this.notes.get(noteId);
    if (reg) return { x: reg.value.x, y: reg.value.y };
    for (const [id, info] of this.ownership) {
      if (id === noteId) {
        return null;
      }
    }
    return null;
  }

  private shouldKeepTombstone(
    noteId: string,
    incomingScore: number,
    timestamp: number,
    clientId: string
  ): boolean {
    const existing = this.tombstoneTimestamps.get(noteId);
    if (!existing) return false;
    if (incomingScore > existing.score) return false;
    if (incomingScore < existing.score) return true;
    if (timestamp > existing.timestamp) return false;
    if (timestamp < existing.timestamp) return true;
    return clientId <= existing.clientId;
  }

  addNote(note: Note, authorPosition?: ClientPosition): Operation {
    const timestamp = this.getTimestamp();
    const noteWithId = { ...note, id: note.id || generateId() };
    const ownership = this.getOwnership(noteWithId.id);
    const anchor = this.computeNoteAnchor(noteWithId.id);
    const score = computeMergeScore(
      { type: 'add', note: noteWithId, timestamp, clientId: this.clientId, authorPosition },
      anchor,
      ownership?.clientId || null,
      ownership?.timestamp || 0
    );
    this.notes.set(noteWithId.id, new WeightedRegister(noteWithId, timestamp, this.clientId, score, authorPosition));
    this.tombstones.delete(noteWithId.id);
    this.tombstoneTimestamps.delete(noteWithId.id);
    this.updateOwnership(noteWithId.id, this.clientId, timestamp);
    return { type: 'add', note: noteWithId, timestamp, clientId: this.clientId, authorPosition };
  }

  removeNote(noteId: string, authorPosition?: ClientPosition): Operation | null {
    const timestamp = this.getTimestamp();
    const existing = this.notes.get(noteId);
    if (!existing) return null;
    const ownership = this.getOwnership(noteId);
    const score = computeMergeScore(
      { type: 'remove', note: existing.value, timestamp, clientId: this.clientId, authorPosition },
      { x: existing.value.x, y: existing.value.y },
      ownership?.clientId || null,
      ownership?.timestamp || 0
    );
    this.tombstones.add(noteId);
    this.tombstoneTimestamps.set(noteId, { timestamp, clientId: this.clientId, score });
    this.notes.delete(noteId);
    this.updateOwnership(noteId, this.clientId, timestamp);
    return { type: 'remove', note: existing.value, timestamp, clientId: this.clientId, authorPosition };
  }

  updateNote(noteId: string, partial: Partial<Note>, authorPosition?: ClientPosition): Operation | null {
    if (this.isTombstoned(noteId)) return null;
    const existing = this.notes.get(noteId);
    if (!existing) return null;
    const timestamp = this.getTimestamp();
    const updated: Note = { ...existing.value, ...partial, id: noteId };
    const ownership = this.getOwnership(noteId);
    const anchor = { x: existing.value.x, y: existing.value.y };
    const score = computeMergeScore(
      { type: 'update', note: updated, timestamp, clientId: this.clientId, authorPosition },
      anchor,
      ownership?.clientId || null,
      ownership?.timestamp || 0
    );
    this.notes.set(noteId, new WeightedRegister(updated, timestamp, this.clientId, score, authorPosition));
    this.updateOwnership(noteId, this.clientId, timestamp);
    return { type: 'update', note: updated, timestamp, clientId: this.clientId, authorPosition };
  }

  applyOperation(op: Operation): { changed: boolean; note: Note | null; prevNote: Note | null } {
    const { type, note, timestamp, clientId, authorPosition } = op;
    let changed = false;
    let resultNote: Note | null = null;
    let prevNote: Note | null = null;

    if (this.clock < timestamp + 1) {
      this.clock = timestamp + 1;
    }

    const ownership = this.getOwnership(note.id);
    const anchor = this.computeNoteAnchor(note.id);
    const incomingScore = computeMergeScore(op, anchor, ownership?.clientId || null, ownership?.timestamp || 0);

    if (type === 'add') {
      if (this.isTombstoned(note.id)) {
        if (this.shouldKeepTombstone(note.id, incomingScore, timestamp, clientId)) {
          return { changed: false, note: null, prevNote: null };
        }
        this.tombstones.delete(note.id);
        this.tombstoneTimestamps.delete(note.id);
      }
      const existing = this.notes.get(note.id);
      const newReg = new WeightedRegister(note, timestamp, clientId, incomingScore, authorPosition);
      if (existing) {
        prevNote = { ...existing.value };
        if (incomingScore > existing.score ||
          (incomingScore === existing.score && timestamp > existing.timestamp) ||
          (incomingScore === existing.score && timestamp === existing.timestamp && clientId > existing.clientId)) {
          this.notes.set(note.id, newReg);
          changed = true;
          resultNote = note;
        }
      } else {
        this.notes.set(note.id, newReg);
        changed = true;
        resultNote = note;
      }
      if (changed || !existing) {
        this.updateOwnership(note.id, clientId, timestamp);
      }
      return { changed, note: resultNote, prevNote };
    }

    if (type === 'remove') {
      const existingTs = this.tombstoneTimestamps.get(note.id);
      const existingNote = this.notes.get(note.id);
      if (existingNote) {
        prevNote = { ...existingNote.value };
      }
      let shouldUpdate = true;
      if (existingTs) {
        if (incomingScore < existingTs.score) {
          shouldUpdate = false;
        } else if (incomingScore === existingTs.score) {
          if (timestamp < existingTs.timestamp ||
            (timestamp === existingTs.timestamp && clientId <= existingTs.clientId)) {
            shouldUpdate = false;
          }
        }
      }
      if (shouldUpdate) {
        this.tombstoneTimestamps.set(note.id, { timestamp, clientId, score: incomingScore });
        this.tombstones.add(note.id);
        if (this.notes.has(note.id)) {
          this.notes.delete(note.id);
          changed = true;
        }
        this.updateOwnership(note.id, clientId, timestamp);
      }
      return { changed: changed, note: null, prevNote };
    }

    if (type === 'update') {
      if (this.isTombstoned(note.id)) {
        if (this.shouldKeepTombstone(note.id, incomingScore, timestamp, clientId)) {
          return { changed: false, note: null, prevNote: null };
        }
        this.tombstones.delete(note.id);
        this.tombstoneTimestamps.delete(note.id);
      }
      const existing = this.notes.get(note.id);
      const newReg = new WeightedRegister(note, timestamp, clientId, incomingScore, authorPosition);
      if (existing) {
        prevNote = { ...existing.value };
        if (incomingScore > existing.score ||
          (incomingScore === existing.score && timestamp > existing.timestamp) ||
          (incomingScore === existing.score && timestamp === existing.timestamp && clientId > existing.clientId)) {
          this.notes.set(note.id, newReg);
          changed = true;
          resultNote = note;
          this.updateOwnership(note.id, clientId, timestamp);
        }
      } else {
        this.notes.set(note.id, newReg);
        changed = true;
        resultNote = note;
        this.updateOwnership(note.id, clientId, timestamp);
      }
      return { changed, note: resultNote, prevNote };
    }

    return { changed: false, note: null, prevNote: null };
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

  getNote(id: string): Note | null {
    const reg = this.notes.get(id);
    if (!reg || this.isTombstoned(id)) return null;
    return { ...reg.value };
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
    this.ownership.clear();
    for (const note of state.notes) {
      const score = computeMergeScore(
        { type: 'add', note, timestamp, clientId },
        null,
        null,
        0
      );
      this.notes.set(note.id, new WeightedRegister(note, timestamp, clientId, score));
      this.ownership.set(note.id, { clientId, timestamp });
    }
    for (const id of state.tombstones) {
      this.tombstones.add(id);
      this.tombstoneTimestamps.set(id, { timestamp, clientId, score: 0.5 });
    }
  }

  loadFullSync(notes: Note[]): void {
    const ts = Date.now();
    this.notes.clear();
    this.tombstones.clear();
    this.tombstoneTimestamps.clear();
    this.ownership.clear();
    for (const note of notes) {
      const score = computeMergeScore(
        { type: 'add', note, timestamp: ts, clientId: 'server' },
        null,
        null,
        0
      );
      this.notes.set(note.id, new WeightedRegister(note, ts, 'server', score));
      this.ownership.set(note.id, { clientId: 'server', timestamp: ts });
    }
  }
}
