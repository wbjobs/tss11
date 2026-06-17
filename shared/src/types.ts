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

export type OperationType = 'add' | 'remove' | 'update';

export interface Operation {
  type: OperationType;
  note: Note;
  timestamp: number;
  clientId: string;
}

export interface SyncMessage {
  type: 'op' | 'full-sync' | 'ack';
  payload: Operation | Note[] | { version: number };
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
