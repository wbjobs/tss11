import {
  Note,
  Operation,
  ClientPosition,
  INTERPOLATION,
  lerpNumber,
  easeOutCubic,
  snapToGrid,
} from 'shared';
import { CRDTDocument } from 'shared';

function generateId(): string {
  return Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
}

interface PendingOperation {
  op: Operation;
  appliedAt: number;
  acknowledged: boolean;
}

interface InterpolationState {
  noteId: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  fromBeat: number;
  toBeat: number;
  fromMeasure: number;
  toMeasure: number;
  fromPitch: { name: string; octave: number; accidental: string };
  toPitch: { name: string; octave: number; accidental: string };
  startTime: number;
  duration: number;
}

export class ClientDocument {
  private baseDoc: CRDTDocument;
  private pendingOps: Map<string, PendingOperation[]> = new Map();
  private undoStack: Operation[] = [];
  private onLocalOp: ((op: Operation) => void) | null = null;
  private onRemoteApplied: ((noteId: string, newNote: Note | null, prevNote: Note | null) => void) | null = null;
  private interpolations: Map<string, InterpolationState> = new Map();
  private rafId: number | null = null;
  private cursorPosition: ClientPosition | null = null;
  private staffMetrics: {
    measureWidth: number;
    lineSpacing: number;
    measuresPerStaff: number;
    staffTopY: number;
    staffMarginX: number;
  } | null = null;
  private renderCache: Map<string, Note> = new Map();

  constructor(clientId?: string) {
    this.baseDoc = new CRDTDocument(clientId || generateId());
  }

  getClientId(): string {
    return this.baseDoc.getClientId();
  }

  setStaffMetrics(metrics: {
    measureWidth: number;
    lineSpacing: number;
    measuresPerStaff: number;
    staffTopY: number;
    staffMarginX: number;
  }) {
    this.staffMetrics = metrics;
  }

  setCursorPosition(pos: Omit<ClientPosition, 'clientId' | 'lastUpdate'>) {
    this.cursorPosition = {
      clientId: this.getClientId(),
      cursorX: pos.cursorX,
      cursorY: pos.cursorY,
      lastUpdate: performance.now(),
    };
  }

  onOperation(handler: (op: Operation) => void) {
    this.onLocalOp = handler;
  }

  onRemoteNoteChange(handler: (noteId: string, newNote: Note | null, prevNote: Note | null) => void) {
    this.onRemoteApplied = handler;
  }

  private collectPendingOpsForNote(noteId: string): Operation[] {
    const pendings = this.pendingOps.get(noteId);
    if (!pendings) return [];
    return pendings
      .filter((p) => !p.acknowledged)
      .map((p) => p.op);
  }

  private buildNoteWithPending(baseNote: Note | null, noteId: string): Note | null {
    const unackOps = this.collectPendingOpsForNote(noteId);
    if (unackOps.length === 0) return baseNote ? { ...baseNote } : null;

    let current = baseNote ? { ...baseNote } : null;
    for (const op of unackOps) {
      if (!current) {
        if (op.type === 'add') {
          current = { ...op.note };
        }
      } else {
        if (op.type === 'remove') {
          current = null;
        } else if (op.type === 'update') {
          current = { ...current, ...op.note, id: noteId };
        } else if (op.type === 'add') {
          current = { ...op.note };
        }
      }
    }
    return current;
  }

  private pushPending(noteId: string, op: Operation) {
    if (!this.pendingOps.has(noteId)) {
      this.pendingOps.set(noteId, []);
    }
    this.pendingOps.get(noteId)!.push({
      op,
      appliedAt: performance.now(),
      acknowledged: false,
    });
  }

  addNote(note: Omit<Note, 'id'>): Operation {
    const fullNote: Note = { ...note, id: generateId() };
    const pos = this.cursorPosition;
    const op = this.baseDoc.addNote(fullNote, pos ? { ...pos } : undefined);
    this.pushPending(fullNote.id, op);
    this.undoStack.push(op);
    this.startInterpolationLoop();
    this.onLocalOp?.(op);
    return op;
  }

  removeNote(noteId: string): Operation | null {
    const pos = this.cursorPosition;
    const op = this.baseDoc.removeNote(noteId, pos ? { ...pos } : undefined);
    if (!op) return null;
    this.pushPending(noteId, op);
    this.undoStack.push(op);
    this.interpolations.delete(noteId);
    this.renderCache.delete(noteId);
    this.onLocalOp?.(op);
    return op;
  }

  updateNote(noteId: string, partial: Partial<Note>, immediate = true): Operation | null {
    const pos = this.cursorPosition;
    const baseBefore = this.baseDoc.getNote(noteId);
    const op = this.baseDoc.updateNote(noteId, partial, pos ? { ...pos } : undefined);
    if (!op) return null;

    if (immediate) {
      this.renderCache.delete(noteId);
    } else {
      const optimistic = this.buildNoteWithPending(op.note, noteId);
      if (optimistic) {
        this.renderCache.set(noteId, optimistic);
      }
    }
    this.pushPending(noteId, op);
    this.startInterpolationLoop();
    this.onLocalOp?.(op);
    return op;
  }

  beginDragUpdate(noteId: string, partial: Partial<Note>): void {
    const existing = this.getRenderedNote(noteId);
    if (!existing) return;
    const updated: Note = { ...existing, ...partial, id: noteId };
    this.renderCache.set(noteId, updated);
  }

  applyRemoteOperation(op: Operation): boolean {
    if (op.clientId === this.getClientId()) {
      this.acknowledgePending(op);
      return false;
    }

    const noteId = op.note.id;
    const prevRendered = this.getRenderedNote(noteId);
    const baseBefore = this.baseDoc.getNote(noteId);

    const { changed, note: newBase } = this.baseDoc.applyOperation(op);

    if (!changed) {
      return false;
    }

    const unackOps = this.collectPendingOpsForNote(noteId);
    let finalRendered: Note | null = newBase ? { ...newBase } : null;
    for (const pending of unackOps) {
      if (!finalRendered) {
        if (pending.type === 'add') finalRendered = { ...pending.note };
      } else {
        if (pending.type === 'remove') finalRendered = null;
        else if (pending.type === 'update' || pending.type === 'add') {
          finalRendered = { ...finalRendered, ...pending.note, id: noteId };
        }
      }
    }

    if (prevRendered && finalRendered && (op.type === 'update' || op.type === 'add')) {
      this.startInterpolation(noteId, prevRendered, finalRendered);
    } else if (finalRendered) {
      this.renderCache.set(noteId, finalRendered);
    } else {
      this.renderCache.delete(noteId);
      this.interpolations.delete(noteId);
    }

    this.onRemoteApplied?.(noteId, finalRendered, prevRendered || null);
    this.startInterpolationLoop();
    return true;
  }

  private acknowledgePending(remoteEcho: Operation): void {
    const noteId = remoteEcho.note.id;
    const arr = this.pendingOps.get(noteId);
    if (!arr) return;

    for (let i = arr.length - 1; i >= 0; i--) {
      const p = arr[i];
      if (!p.acknowledged &&
        p.op.type === remoteEcho.type &&
        p.op.timestamp === remoteEcho.timestamp &&
        p.op.clientId === remoteEcho.clientId) {
        p.acknowledged = true;
      }
    }

    const cutoff = performance.now() - 5000;
    const filtered = arr.filter((p) => !p.acknowledged || p.appliedAt > cutoff);
    if (filtered.length === 0) {
      this.pendingOps.delete(noteId);
    } else {
      this.pendingOps.set(noteId, filtered);
    }
  }

  private startInterpolation(noteId: string, fromNote: Note, toNote: Note): void {
    const state: InterpolationState = {
      noteId,
      fromX: fromNote.x,
      fromY: fromNote.y,
      toX: toNote.x,
      toY: toNote.y,
      fromBeat: fromNote.beat,
      toBeat: toNote.beat,
      fromMeasure: fromNote.measure,
      toMeasure: toNote.measure,
      fromPitch: { name: fromNote.pitch.name, octave: fromNote.pitch.octave, accidental: fromNote.pitch.accidental },
      toPitch: { name: toNote.pitch.name, octave: toNote.pitch.octave, accidental: toNote.pitch.accidental },
      startTime: performance.now(),
      duration: INTERPOLATION.REMOTE_POS_MS,
    };
    this.interpolations.set(noteId, state);
  }

  private tickInterpolations(now: number): boolean {
    let anyActive = false;
    const completed: string[] = [];

    for (const [noteId, state] of this.interpolations) {
      const t = Math.min(1, (now - state.startTime) / state.duration);
      const eased = easeOutCubic(t);

      const base = this.baseDoc.getNote(noteId);
      const pendingAppended = this.buildNoteWithPending(base, noteId);
      if (!pendingAppended) {
        completed.push(noteId);
        continue;
      }

      const rendered: Note = {
        ...pendingAppended,
        x: state.toX !== state.fromX ? lerpNumber(state.fromX, state.toX, eased) : state.toX,
        y: state.toY !== state.fromY ? lerpNumber(state.fromY, state.toY, eased) : state.toY,
        measure: Math.round(lerpNumber(state.fromMeasure, state.toMeasure, eased)),
        beat: lerpNumber(state.fromBeat, state.toBeat, eased),
      };
      this.renderCache.set(noteId, rendered);

      if (t >= 1) {
        completed.push(noteId);
        this.renderCache.set(noteId, { ...pendingAppended });
      } else {
        anyActive = true;
      }
    }

    for (const id of completed) {
      this.interpolations.delete(id);
    }

    return anyActive;
  }

  private startInterpolationLoop(): void {
    if (this.rafId !== null) return;

    const tick = () => {
      const now = performance.now();
      const hasInterp = this.tickInterpolations(now);
      if (hasInterp || this.pendingOps.size > 0) {
        this.rafId = requestAnimationFrame(tick);
      } else {
        this.rafId = null;
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }

  getRenderedNote(id: string): Note | null {
    const cached = this.renderCache.get(id);
    if (cached) return { ...cached };
    const base = this.baseDoc.getNote(id);
    const withPending = this.buildNoteWithPending(base, id);
    if (withPending) this.renderCache.set(id, { ...withPending });
    return withPending;
  }

  loadFullSync(notes: Note[]) {
    this.pendingOps.clear();
    this.interpolations.clear();
    this.renderCache.clear();
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.baseDoc.loadFullSync(notes);
    for (const n of notes) {
      this.renderCache.set(n.id, { ...n });
    }
  }

  getNotes(): Note[] {
    const baseNotes = this.baseDoc.getNotes();
    const result: Note[] = [];
    const seen = new Set<string>();

    for (const n of baseNotes) {
      seen.add(n.id);
      const rendered = this.getRenderedNote(n.id);
      if (rendered) result.push(rendered);
    }

    for (const [noteId, pendings] of this.pendingOps) {
      if (seen.has(noteId)) continue;
      for (const p of pendings) {
        if (p.op.type === 'add' && !p.acknowledged) {
          const rendered = this.getRenderedNote(noteId);
          if (rendered) {
            result.push(rendered);
            seen.add(noteId);
          }
          break;
        }
      }
    }

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
      const note = lastOp.note;
      const pos = this.cursorPosition;
      const op = this.baseDoc.addNote(note, pos ? { ...pos } : undefined);
      this.pushPending(note.id, op);
      this.interpolations.delete(note.id);
      this.renderCache.delete(note.id);
      this.onLocalOp?.(op);
      return op;
    }
    return null;
  }

  destroy(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }
}
