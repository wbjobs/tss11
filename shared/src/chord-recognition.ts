import { Note, NotePitch, PitchName, Chord, ChordQuality, ACCOMPANIMENT } from './types';

const SEMITONE_MAP: Record<PitchName, number> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};

const CHORD_TEMPLATES: { quality: ChordQuality; intervals: number[]; name: string }[] = [
  { quality: 'diminished7', intervals: [0, 3, 6, 9], name: 'dim7' },
  { quality: 'dominant7', intervals: [0, 4, 7, 10], name: '7' },
  { quality: 'major7', intervals: [0, 4, 7, 11], name: 'maj7' },
  { quality: 'minor7', intervals: [0, 3, 7, 10], name: 'm7' },
  { quality: 'halfDiminished7', intervals: [0, 3, 6, 10], name: 'ø7' },
  { quality: 'augmented', intervals: [0, 4, 8], name: 'aug' },
  { quality: 'major', intervals: [0, 4, 7], name: '' },
  { quality: 'minor', intervals: [0, 3, 7], name: 'm' },
  { quality: 'diminished', intervals: [0, 3, 6], name: 'dim' },
];

const PITCH_NAMES_WITH_ACCIDENTALS: (PitchName | 'C#' | 'D#' | 'F#' | 'G#' | 'A#')[] = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'
];

function pitchToSemitone(pitch: NotePitch): number {
  const semitone = SEMITONE_MAP[pitch.name];
  const accidental = pitch.accidental === '#' ? 1 : pitch.accidental === 'b' ? -1 : 0;
  return ((semitone + accidental) % 12 + 12) % 12;
}

function normalizePitchClass(semitone: number): number {
  return ((semitone % 12) + 12) % 12;
}

function getPitchNameFromSemitone(semitone: number): { name: PitchName; accidental: '' | '#' | 'b' } {
  const normalized = normalizePitchClass(semitone);
  const name = PITCH_NAMES_WITH_ACCIDENTALS[normalized];
  if (name.length === 1) {
    return { name: name as PitchName, accidental: '' };
  }
  return { name: name[0] as PitchName, accidental: '#' };
}

function getPitchesForMeasure(notes: Note[], measure: number, includeAccompaniment = false): NotePitch[] {
  return notes
    .filter((n) => n.measure === measure && (includeAccompaniment || !n.isAccompaniment))
    .map((n) => n.pitch);
}

function buildPitchSet(pitches: NotePitch[]): Set<number> {
  return new Set(pitches.map(pitchToSemitone));
}

function matchChordTemplate(pitchSet: Set<number>, root: number, template: number[]): number {
  let matches = 0;
  for (const interval of template) {
    const pc = normalizePitchClass(root + interval);
    if (pitchSet.has(pc)) {
      matches++;
    }
  }
  return matches / template.length;
}

export function identifyChord(pitches: NotePitch[], measure: number): Chord | null {
  if (pitches.length < ACCOMPANIMENT.MIN_NOTES_FOR_CHORD) return null;

  const pitchSet = buildPitchSet(pitches);
  if (pitchSet.size < ACCOMPANIMENT.MIN_NOTES_FOR_CHORD) return null;

  let bestMatch: { chord: Chord; score: number } | null = null;

  for (let root = 0; root < 12; root++) {
    for (const template of CHORD_TEMPLATES) {
      const score = matchChordTemplate(pitchSet, root, template.intervals);
      const pitchInfo = getPitchNameFromSemitone(root);
      const accidentalSymbol = pitchInfo.accidental === '#' ? '#' : pitchInfo.accidental === 'b' ? '♭' : '';
      const chordName = `${pitchInfo.name}${accidentalSymbol}${template.name}`;

      const bonus = pitchSet.has(root) ? 0.1 : 0;
      const lengthBonus = template.intervals.length >= 4 ? 0.05 : 0;
      const finalScore = score + bonus + lengthBonus;

      if (!bestMatch || finalScore > bestMatch.score) {
        const chordPitches = template.intervals.map((i) => normalizePitchClass(root + i));
        bestMatch = {
          chord: {
            name: chordName,
            root: pitchInfo.name,
            accidental: pitchInfo.accidental,
            quality: template.quality,
            pitches: chordPitches,
            measure,
            confidence: Math.min(1, finalScore),
          },
          score: finalScore,
        };
      }
    }
  }

  if (bestMatch && bestMatch.score >= 0.5) {
    return bestMatch.chord;
  }
  return null;
}

export function analyzeChordProgression(notes: Note[]): Map<number, Chord> {
  const result = new Map<number, Chord>();
  const measures = new Set(notes.filter((n) => !n.isAccompaniment).map((n) => n.measure));

  for (const measure of measures) {
    const pitches = getPitchesForMeasure(notes, measure, false);
    const chord = identifyChord(pitches, measure);
    if (chord) {
      result.set(measure, chord);
    }
  }

  for (const measure of measures) {
    if (!result.has(measure)) {
      const prev = result.get(measure - 1);
      const next = result.get(measure + 1);
      if (prev && next && prev.name === next.name) {
        result.set(measure, { ...prev, measure, confidence: prev.confidence * 0.7 });
      } else if (prev) {
        result.set(measure, { ...prev, measure, confidence: prev.confidence * 0.5 });
      }
    }
  }

  return result;
}

export function getChordRootSemitone(chord: Chord): number {
  const semitone = SEMITONE_MAP[chord.root];
  const accidental = chord.accidental === '#' ? 1 : chord.accidental === 'b' ? -1 : 0;
  return normalizePitchClass(semitone + accidental);
}

export function getChordPitches(chord: Chord, octave: number = 3): number[] {
  const rootPc = getChordRootSemitone(chord);
  const template = CHORD_TEMPLATES.find((t) => t.quality === chord.quality);
  if (!template) return [];
  return template.intervals.map((interval) => {
    const pc = normalizePitchClass(rootPc + interval);
    return (octave + 1) * 12 + pc;
  });
}

export function getChordNotePitches(chord: Chord, octave: number = 3): NotePitch[] {
  const template = CHORD_TEMPLATES.find((t) => t.quality === chord.quality);
  if (!template) return [];
  const rootPc = getChordRootSemitone(chord);
  return template.intervals.map((interval) => {
    const pc = normalizePitchClass(rootPc + interval);
    const pitchInfo = getPitchNameFromSemitone(pc);
    const extraOctave = rootPc + interval >= 12 ? 1 : 0;
    return {
      name: pitchInfo.name,
      octave: octave + extraOctave,
      accidental: pitchInfo.accidental,
    };
  });
}
