import {
  Note,
  NotePitch,
  Chord,
  AccompanimentPattern,
  Duration,
  ACCOMPANIMENT,
  getChordNotePitches,
  getChordRootSemitone,
  pitchToStaffPosition,
} from '../../shared/src/index';

interface MarkovState {
  chordRoot: number;
  chordQuality: string;
  chordPosition: number;
  beat: number;
  direction: 'up' | 'down' | 'same';
}

interface Transition {
  nextPosition: number;
  nextBeat: number;
  direction: 'up' | 'down' | 'same';
  probability: number;
}

const MARKOV_TRANSITIONS: Record<string, Transition[]> = {
  'alberti': [
    { nextPosition: 0, nextBeat: 0, direction: 'same', probability: 0.1 },
    { nextPosition: 2, nextBeat: 0.5, direction: 'up', probability: 0.8 },
    { nextPosition: 1, nextBeat: 1, direction: 'down', probability: 0.7 },
    { nextPosition: 2, nextBeat: 1.5, direction: 'up', probability: 0.9 },
    { nextPosition: 0, nextBeat: 0, direction: 'down', probability: 0.2 },
  ],
  'arpeggio': [
    { nextPosition: 0, nextBeat: 0, direction: 'up', probability: 0.1 },
    { nextPosition: 1, nextBeat: 0.25, direction: 'up', probability: 0.9 },
    { nextPosition: 2, nextBeat: 0.5, direction: 'up', probability: 0.95 },
    { nextPosition: 3, nextBeat: 0.75, direction: 'up', probability: 0.85 },
    { nextPosition: 2, nextBeat: 1, direction: 'down', probability: 0.7 },
    { nextPosition: 1, nextBeat: 1.25, direction: 'down', probability: 0.8 },
    { nextPosition: 0, nextBeat: 1.5, direction: 'down', probability: 0.9 },
    { nextPosition: 1, nextBeat: 1.75, direction: 'up', probability: 0.75 },
  ],
  'ostinato': [
    { nextPosition: 0, nextBeat: 0, direction: 'same', probability: 0.9 },
    { nextPosition: 2, nextBeat: 0.5, direction: 'up', probability: 0.85 },
    { nextPosition: 1, nextBeat: 1, direction: 'down', probability: 0.8 },
    { nextPosition: 0, nextBeat: 1.5, direction: 'down', probability: 0.9 },
  ],
  'walkingBass': [
    { nextPosition: 0, nextBeat: 0, direction: 'same', probability: 0.95 },
    { nextPosition: 2, nextBeat: 1, direction: 'up', probability: 0.7 },
    { nextPosition: 1, nextBeat: 2, direction: 'down', probability: 0.65 },
    { nextPosition: 0, nextBeat: 3, direction: 'down', probability: 0.85 },
  ],
};

const PATTERN_DURATIONS: Record<AccompanimentPattern, Duration> = {
  alberti: 'eighth',
  arpeggio: 'sixteenth',
  ostinato: 'eighth',
  walkingBass: 'quarter',
};

class MarkovChain {
  private transitions: Map<string, Map<string, number>> = new Map();
  private pattern: AccompanimentPattern;

  constructor(pattern: AccompanimentPattern) {
    this.pattern = pattern;
    this.buildTransitions();
  }

  private buildTransitions() {
    const baseTransitions = MARKOV_TRANSITIONS[this.pattern] || MARKOV_TRANSITIONS.alberti;
    for (let pos = 0; pos < 4; pos++) {
      for (let beat = 0; beat < 4; beat += 0.25) {
        const stateKey = `${pos}-${beat}`;
        const nextStates = new Map<string, number>();
        for (const t of baseTransitions) {
          const nextBeat = (beat + t.nextBeat) % 4;
          const nextPos = (pos + t.nextPosition) % 4;
          const nextKey = `${nextPos}-${nextBeat.toFixed(2)}`;
          nextStates.set(nextKey, t.probability);
        }
        this.transitions.set(stateKey, nextStates);
      }
    }
  }

  getNextState(currentPos: number, currentBeat: number): { position: number; beat: number } {
    const beatKey = currentBeat.toFixed(2);
    const stateKey = `${currentPos % 4}-${beatKey}`;
    const possible = this.transitions.get(stateKey);
    if (!possible || possible.size === 0) {
      return { position: (currentPos + 1) % 4, beat: (currentBeat + 0.25) % 4 };
    }
    const entries = Array.from(possible.entries());
    const total = entries.reduce((s, [, p]) => s + p, 0);
    let r = Math.random() * total;
    for (const [key, prob] of entries) {
      r -= prob;
      if (r <= 0) {
        const [pos, beat] = key.split('-');
        return { position: parseInt(pos), beat: parseFloat(beat) };
      }
    }
    const [pos, beat] = entries[0][0].split('-');
    return { position: parseInt(pos), beat: parseFloat(beat) };
  }
}

function generateNoteId(): string {
  return Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
}

function getBeatOffset(beat: number): number {
  return Math.round(beat * 4) / 4;
}

function generateAlbertiPattern(
  chord: Chord,
  measure: number,
  baseOctave: number,
  staffMetrics: { staffTopY: number; lineSpacing: number; staffMarginX: number; measureWidth: number; measuresPerStaff: number }
): Note[] {
  const notes: Note[] = [];
  const chordPitches = getChordNotePitches(chord, baseOctave);
  if (chordPitches.length < 3) return notes;

  const pattern = [0, 2, 1, 2, 0, 2, 1, 2];
  const beats = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5];

  for (let i = 0; i < pattern.length; i++) {
    const pitchIdx = pattern[i] % chordPitches.length;
    const pitch = chordPitches[pitchIdx];
    const beat = getBeatOffset(beats[i]);
    const staffPos = pitchToStaffPosition(pitch);
    const x = staffMetrics.staffMarginX + ((measure - 1) % staffMetrics.measuresPerStaff + beat / 4) * staffMetrics.measureWidth;
    const y = staffMetrics.staffTopY + (6 - staffPos) * (staffMetrics.lineSpacing / 2);

    notes.push({
      id: generateNoteId(),
      pitch: { ...pitch },
      duration: 'eighth',
      x,
      y,
      measure,
      beat,
      track: 'accompaniment',
      isAccompaniment: true,
    });
  }
  return notes;
}

function generateArpeggioPattern(
  chord: Chord,
  measure: number,
  baseOctave: number,
  staffMetrics: { staffTopY: number; lineSpacing: number; staffMarginX: number; measureWidth: number; measuresPerStaff: number }
): Note[] {
  const notes: Note[] = [];
  const chordPitches = getChordNotePitches(chord, baseOctave);
  if (chordPitches.length < 3) return notes;

  const markov = new MarkovChain('arpeggio');
  let currentPos = 0;
  let currentBeat = 0;

  for (let i = 0; i < 16; i++) {
    const pitchIdx = currentPos % chordPitches.length;
    const pitch = chordPitches[pitchIdx];
    const beat = getBeatOffset(currentBeat);
    const staffPos = pitchToStaffPosition(pitch);
    const x = staffMetrics.staffMarginX + ((measure - 1) % staffMetrics.measuresPerStaff + beat / 4) * staffMetrics.measureWidth;
    const y = staffMetrics.staffTopY + (6 - staffPos) * (staffMetrics.lineSpacing / 2);

    notes.push({
      id: generateNoteId(),
      pitch: { ...pitch },
      duration: 'sixteenth',
      x,
      y,
      measure,
      beat,
      track: 'accompaniment',
      isAccompaniment: true,
    });

    const next = markov.getNextState(currentPos, currentBeat);
    currentPos = next.position;
    currentBeat = next.beat;
  }
  return notes;
}

function generateOstinatoPattern(
  chord: Chord,
  measure: number,
  baseOctave: number,
  staffMetrics: { staffTopY: number; lineSpacing: number; staffMarginX: number; measureWidth: number; measuresPerStaff: number }
): Note[] {
  const notes: Note[] = [];
  const chordPitches = getChordNotePitches(chord, baseOctave);
  if (chordPitches.length < 3) return notes;

  const pattern = [0, 2, 1, 0, 0, 2, 1, 0];
  const beats = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5];

  for (let i = 0; i < pattern.length; i++) {
    const pitchIdx = pattern[i] % chordPitches.length;
    const pitch = chordPitches[pitchIdx];
    const beat = getBeatOffset(beats[i]);
    const staffPos = pitchToStaffPosition(pitch);
    const x = staffMetrics.staffMarginX + ((measure - 1) % staffMetrics.measuresPerStaff + beat / 4) * staffMetrics.measureWidth;
    const y = staffMetrics.staffTopY + (6 - staffPos) * (staffMetrics.lineSpacing / 2);

    notes.push({
      id: generateNoteId(),
      pitch: { ...pitch },
      duration: 'eighth',
      x,
      y,
      measure,
      beat,
      track: 'accompaniment',
      isAccompaniment: true,
    });
  }
  return notes;
}

function generateWalkingBassPattern(
  chord: Chord,
  measure: number,
  baseOctave: number,
  staffMetrics: { staffTopY: number; lineSpacing: number; staffMarginX: number; measureWidth: number; measuresPerStaff: number },
  nextChord?: Chord
): Note[] {
  const notes: Note[] = [];
  const chordPitches = getChordNotePitches(chord, baseOctave - 1);
  if (chordPitches.length < 3) return notes;

  const beats = [0, 1, 2, 3];
  const positions = [0, 1, 2, nextChord ? 3 : 0];

  for (let i = 0; i < 4; i++) {
    let pitchIdx = positions[i] % chordPitches.length;
    if (i === 3 && nextChord) {
      const nextRootSemitone = getChordRootSemitone(nextChord);
      const root = getChordRootSemitone(chord);
      const leadingTone = (nextRootSemitone - 1 + 12) % 12;
      const pitchInfo = getChordNotePitches(chord, baseOctave - 1).find(
        (p) => getChordRootSemitone({ ...chord, root: p.name, accidental: p.accidental } as Chord) === leadingTone
      );
      if (pitchInfo) {
        const staffPos = pitchToStaffPosition(pitchInfo);
        const beat = getBeatOffset(beats[i]);
        const x = staffMetrics.staffMarginX + ((measure - 1) % staffMetrics.measuresPerStaff + beat / 4) * staffMetrics.measureWidth;
        const y = staffMetrics.staffTopY + (6 - staffPos) * (staffMetrics.lineSpacing / 2);
        notes.push({
          id: generateNoteId(),
          pitch: { ...pitchInfo },
          duration: 'quarter',
          x,
          y,
          measure,
          beat,
          track: 'accompaniment',
          isAccompaniment: true,
        });
        continue;
      }
    }
    const pitch = chordPitches[pitchIdx];
    const beat = getBeatOffset(beats[i]);
    const staffPos = pitchToStaffPosition(pitch);
    const x = staffMetrics.staffMarginX + ((measure - 1) % staffMetrics.measuresPerStaff + beat / 4) * staffMetrics.measureWidth;
    const y = staffMetrics.staffTopY + (6 - staffPos) * (staffMetrics.lineSpacing / 2);

    notes.push({
      id: generateNoteId(),
      pitch: { ...pitch },
      duration: 'quarter',
      x,
      y,
      measure,
      beat,
      track: 'accompaniment',
      isAccompaniment: true,
    });
  }
  return notes;
}

export interface AccompanimentGenerationOptions {
  pattern?: AccompanimentPattern;
  baseOctaveShift?: number;
  clearExisting?: boolean;
  startMeasure?: number;
  endMeasure?: number;
  staffMetrics: {
    staffTopY: number;
    lineSpacing: number;
    staffMarginX: number;
    measureWidth: number;
    measuresPerStaff: number;
  };
}

export class AccompanimentGenerator {
  private markovChains: Map<AccompanimentPattern, MarkovChain> = new Map();

  constructor() {
    for (const pattern of ['alberti', 'arpeggio', 'ostinato', 'walkingBass'] as AccompanimentPattern[]) {
      this.markovChains.set(pattern, new MarkovChain(pattern));
    }
  }

  generate(
    chords: Chord[],
    options: AccompanimentGenerationOptions
  ): Note[] {
    const pattern = options.pattern || ACCOMPANIMENT.DEFAULT_PATTERN;
    const octaveShift = options.baseOctaveShift !== undefined ? options.baseOctaveShift : ACCOMPANIMENT.DEFAULT_OCTAVE_SHIFT;
    const baseOctave = 3 + octaveShift;

    const result: Note[] = [];
    const sortedChords = [...chords].sort((a, b) => a.measure - b.measure);

    for (let i = 0; i < sortedChords.length; i++) {
      const chord = sortedChords[i];
      if (options.startMeasure !== undefined && chord.measure < options.startMeasure) continue;
      if (options.endMeasure !== undefined && chord.measure > options.endMeasure) continue;

      const nextChord = sortedChords[i + 1];
      let measureNotes: Note[] = [];

      switch (pattern) {
        case 'alberti':
          measureNotes = generateAlbertiPattern(chord, chord.measure, baseOctave, options.staffMetrics);
          break;
        case 'arpeggio':
          measureNotes = generateArpeggioPattern(chord, chord.measure, baseOctave, options.staffMetrics);
          break;
        case 'ostinato':
          measureNotes = generateOstinatoPattern(chord, chord.measure, baseOctave, options.staffMetrics);
          break;
        case 'walkingBass':
          measureNotes = generateWalkingBassPattern(chord, chord.measure, baseOctave, options.staffMetrics, nextChord);
          break;
        default:
          measureNotes = generateAlbertiPattern(chord, chord.measure, baseOctave, options.staffMetrics);
      }

      result.push(...measureNotes);
    }

    return result;
  }

  generateForMeasure(
    chord: Chord,
    measure: number,
    options: AccompanimentGenerationOptions
  ): Note[] {
    return this.generate([{ ...chord, measure }], {
      ...options,
      startMeasure: measure,
      endMeasure: measure,
    });
  }
}
