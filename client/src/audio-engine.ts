import { Note, pitchToFrequency, DURATION_BEATS } from 'shared';

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private isPlaying = false;
  private scheduledNotes: number[] = [];
  private bpm = 120;

  init() {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.3;
    this.masterGain.connect(this.ctx.destination);
  }

  async resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
  }

  setBpm(bpm: number) {
    this.bpm = bpm;
  }

  getIsPlaying(): boolean {
    return this.isPlaying;
  }

  playChord(notes: Note[], onBeatUpdate?: (beat: number) => void): void {
    this.stop();
    this.init();
    if (!this.ctx || !this.masterGain) return;

    this.isPlaying = true;
    const startTime = this.ctx.currentTime + 0.05;
    const beatDuration = 60 / this.bpm;
    let maxEnd = 0;

    for (const note of notes) {
      const freq = pitchToFrequency(note.pitch);
      const startOffset = note.beat * beatDuration;
      const duration = DURATION_BEATS[note.duration] * beatDuration;

      const noteEnd = startOffset + duration;
      if (noteEnd > maxEnd) maxEnd = noteEnd;

      this.playTone(freq, startTime + startOffset, duration);
    }

    if (onBeatUpdate) {
      const totalBeats = maxEnd / beatDuration;
      this.animatePlayhead(startTime, totalBeats, beatDuration, onBeatUpdate);
    }

    const totalDuration = maxEnd + 0.1;
    const timer = window.setTimeout(() => {
      this.isPlaying = false;
    }, totalDuration * 1000);
    this.scheduledNotes.push(timer);
  }

  private playTone(frequency: number, startTime: number, duration: number) {
    if (!this.ctx || !this.masterGain) return;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(frequency, startTime);

    const attack = 0.02;
    const decay = 0.1;
    const sustain = 0.6;
    const release = Math.min(0.3, duration * 0.3);

    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(0.5, startTime + attack);
    gain.gain.linearRampToValueAtTime(sustain * 0.5, startTime + attack + decay);
    gain.gain.setValueAtTime(sustain * 0.5, startTime + duration - release);
    gain.gain.linearRampToValueAtTime(0, startTime + duration);

    const harmonics = this.ctx.createOscillator();
    const harmonicsGain = this.ctx.createGain();
    harmonics.type = 'sine';
    harmonics.frequency.setValueAtTime(frequency * 2, startTime);
    harmonicsGain.gain.setValueAtTime(0.1, startTime);
    harmonicsGain.gain.linearRampToValueAtTime(0, startTime + duration);

    osc.connect(gain);
    harmonics.connect(harmonicsGain);
    harmonicsGain.connect(gain);
    gain.connect(this.masterGain);

    osc.start(startTime);
    osc.stop(startTime + duration + 0.01);
    harmonics.start(startTime);
    harmonics.stop(startTime + duration + 0.01);
  }

  private animatePlayhead(
    startTime: number,
    totalBeats: number,
    beatDuration: number,
    onBeatUpdate: (beat: number) => void
  ) {
    const animate = () => {
      if (!this.ctx || !this.isPlaying) return;
      const elapsed = this.ctx.currentTime - startTime;
      const currentBeat = Math.min(elapsed / beatDuration, totalBeats);
      onBeatUpdate(currentBeat);

      if (currentBeat < totalBeats) {
        requestAnimationFrame(animate);
      }
    };
    requestAnimationFrame(animate);
  }

  stop() {
    this.isPlaying = false;
    for (const id of this.scheduledNotes) {
      clearTimeout(id);
    }
    this.scheduledNotes = [];

    if (this.ctx && this.masterGain) {
      this.masterGain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.05);
      setTimeout(() => {
        if (this.masterGain) {
          this.masterGain.gain.value = 0.3;
        }
      }, 60);
    }
  }

  previewNote(note: Note) {
    this.init();
    if (!this.ctx || !this.masterGain) return;
    this.resume();

    const freq = pitchToFrequency(note.pitch);
    const now = this.ctx.currentTime;
    const duration = 0.3;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(0.2, now);
    gain.gain.linearRampToValueAtTime(0, now + duration);

    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + duration);
  }
}
