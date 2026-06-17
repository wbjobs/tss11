export type PitchName = 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';
export type Duration = 'whole' | 'half' | 'quarter' | 'eighth' | 'sixteenth';

export interface NotePitch {
  name: PitchName;
  octave: number;
  accidental: '' | '#' | 'b';
}

export interface Note {
  id: string;
  pitch: NotePitch;
  duration: Duration;
  x: number;
  y: number;
  measure: number;
  beat: number;
}

export interface ClientPosition {
  clientId: string;
  cursorX: number;
  cursorY: number;
  lastUpdate: number;
}

export type OperationType = 'add' | 'remove' | 'update';

export interface Operation {
  type: OperationType;
  note: Note;
  timestamp: number;
  clientId: string;
  authorPosition?: ClientPosition;
}

export interface SyncMessage {
  type: 'op' | 'full-sync' | 'ack';
  payload: Operation | Note[] | { version: number };
  serverTimestamp?: number;
}

export const PITCH_NAMES: PitchName[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

export const JIANPU_MAP: Record<PitchName, string> = {
  C: '1', D: '2', E: '3', F: '4', G: '5', A: '6', B: '7',
};

export const DURATION_BEATS: Record<Duration, number> = {
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  sixteenth: 0.25,
};

export const DURATION_SYMBOLS: Record<Duration, string> = {
  whole: '𝅝',
  half: '𝅗𝅥',
  quarter: '♩',
  eighth: '♪',
  sixteenth: '𝅘𝅥𝅯',
};

export const DURATION_LABELS: Record<Duration, string> = {
  whole: '全音符',
  half: '二分',
  quarter: '四分',
  eighth: '八分',
  sixteenth: '十六分',
};

export const CRDT_WEIGHT = {
  DISTANCE_DECAY: 0.003,
  MAX_DISTANCE: 800,
  TIME_WEIGHT: 0.45,
  DISTANCE_WEIGHT: 0.40,
  OWNERSHIP_BONUS: 0.15,
  OWNERSHIP_HOLD_MS: 800,
} as const;

export const INTERPOLATION = {
  REMOTE_POS_MS: 220,
  UPDATE_THROTTLE_MS: 16,
} as const;

function dist2(x1: number, y1: number, x2: number, y2: number): number {
  const dx = x1 - x2;
  const dy = y1 - y2;
  return dx * dx + dy * dy;
}

export function computeMergeScore(op: Operation, noteAnchor: { x: number; y: number } | null, ownerClientId: string | null, ownerTimestamp: number): number {
  const { timestamp, clientId, authorPosition, note } = op;

  const recency = Math.max(0, Math.min(1, timestamp / (Date.now() + 100000)));
  const timeScore = CRDT_WEIGHT.TIME_WEIGHT * recency;

  let distanceScore = 0;
  if (authorPosition && noteAnchor) {
    const d2 = dist2(authorPosition.cursorX, authorPosition.cursorY, noteAnchor.x, noteAnchor.y);
    const d = Math.sqrt(d2);
    const clampedD = Math.min(d, CRDT_WEIGHT.MAX_DISTANCE);
    const decay = Math.exp(-CRDT_WEIGHT.DISTANCE_DECAY * clampedD);
    distanceScore = CRDT_WEIGHT.DISTANCE_WEIGHT * decay;
  } else if (!authorPosition && !noteAnchor) {
    distanceScore = CRDT_WEIGHT.DISTANCE_WEIGHT * 0.3;
  }

  let ownerBonus = 0;
  if (ownerClientId === clientId) {
    const hold = Date.now() - ownerTimestamp;
    if (hold < CRDT_WEIGHT.OWNERSHIP_HOLD_MS) {
      ownerBonus = CRDT_WEIGHT.OWNERSHIP_BONUS * (1 - hold / CRDT_WEIGHT.OWNERSHIP_HOLD_MS);
    }
  }

  return timeScore + distanceScore + ownerBonus;
}

export function pitchToFrequency(pitch: NotePitch): number {
  const semitoneMap: Record<PitchName, number> = {
    C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
  };
  const midiNote = (pitch.octave + 1) * 12 + semitoneMap[pitch.name] +
    (pitch.accidental === '#' ? 1 : pitch.accidental === 'b' ? -1 : 0);
  return 440 * Math.pow(2, (midiNote - 69) / 12);
}

export function pitchToStaffPosition(pitch: NotePitch): number {
  const posMap: Record<PitchName, number> = {
    C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6,
  };
  return posMap[pitch.name] + (pitch.octave - 4) * 7;
}

export function staffPositionToPitch(pos: number, accidental: '' | '#' | 'b' = ''): NotePitch {
  const names: PitchName[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
  const idx = ((pos % 7) + 7) % 7;
  const octave = 4 + Math.floor(pos / 7);
  return { name: names[idx], octave, accidental };
}

export function snapToGrid(
  x: number,
  y: number,
  measureWidth: number,
  lineSpacing: number,
  measuresPerStaff: number,
  staffTopY: number,
  canvasOffsetX: number
): { measure: number; beat: number; snappedX: number; snappedY: number; pitch: PitchName } {
  const relX = x - canvasOffsetX;
  const measure = Math.max(0, Math.floor(relX / measureWidth));
  const beatX = relX - measure * measureWidth;
  const beatsPerMeasure = 4;
  const beat = Math.max(0, Math.min(beatsPerMeasure, (beatX / measureWidth) * beatsPerMeasure));
  const snappedBeat = Math.round(beat * 4) / 4;
  const snappedX = canvasOffsetX + measure * measureWidth + (snappedBeat / beatsPerMeasure) * measureWidth;

  const relY = y - staffTopY;
  const staffPos = Math.round(relY / (lineSpacing / 2));
  const pitch = staffPositionToPitch(-staffPos + 6, '');

  return {
    measure: measure + 1,
    beat: snappedBeat,
    snappedX,
    snappedY: staffTopY + (6 - staffPos) * (lineSpacing / 2),
    pitch: pitch.name,
  };
}

export function lerpNumber(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}
