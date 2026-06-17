import { Note, pitchToFrequency, DURATION_BEATS } from 'shared';

interface RenderJob {
  id: string;
  notes: Note[];
  bpm: number;
  resolve: (buffer: AudioBuffer) => void;
  reject: (err: Error) => void;
}

interface PlayingSource {
  source: AudioBufferSourceNode;
  gain: GainNode;
  startTime: number;
  duration: number;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private previewGain: GainNode | null = null;
  private isPlaying = false;
  private currentSources: PlayingSource[] = [];
  private renderQueue: RenderJob[] = [];
  private isRendering = false;
  private bpm = 120;
  private bufferCache: Map<string, AudioBuffer> = new Map();
  private rafId: number | null = null;
  private beatDuration: number = 0.5;
  private totalBeats: number = 0;
  private playStartTime: number = 0;
  private onBeatUpdate: ((beat: number) => void) | null = null;

  init() {
    if (this.ctx) return;
    try {
      const Ctor = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
      this.ctx = new Ctor();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.3;
      this.masterGain.connect(this.ctx.destination);
      this.previewGain = this.ctx.createGain();
      this.previewGain.gain.value = 0.25;
      this.previewGain.connect(this.ctx.destination);
    } catch (e) {
      console.warn('[AudioEngine] init failed:', e);
    }
  }

  async resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch (e) {
        console.warn('[AudioEngine] resume failed:', e);
      }
    }
  }

  setBpm(bpm: number) {
    this.bpm = bpm;
    this.bufferCache.clear();
  }

  getIsPlaying(): boolean {
    return this.isPlaying;
  }

  private getCacheKey(notes: Note[], bpm: number): string {
    const sig = notes
      .map((n) => `${n.pitch.name}${n.pitch.octave}${n.pitch.accidental}_${n.duration}_${n.beat.toFixed(2)}`)
      .sort()
      .join('|');
    return `${bpm}__${sig}`;
  }

  private async buildBufferWithOffline(notes: Note[], bpm: number): Promise<AudioBuffer> {
    this.init();
    if (!this.ctx) throw new Error('AudioContext unavailable');

    const beatDuration = 60 / bpm;
    let maxEndSec = 0.3;
    for (const note of notes) {
      const end = note.beat * beatDuration + DURATION_BEATS[note.duration] * beatDuration + 0.1;
      if (end > maxEndSec) maxEndSec = end;
    }

    const sampleRate = this.ctx.sampleRate;
    const totalFrames = Math.ceil(maxEndSec * sampleRate);
    const offline = new OfflineAudioContext(2, totalFrames, sampleRate);

    const offlineMaster = offline.createGain();
    offlineMaster.gain.value = 0.9;
    offlineMaster.connect(offline.destination);

    for (const note of notes) {
      const freq = pitchToFrequency(note.pitch);
      const startOffset = note.beat * beatDuration;
      const duration = DURATION_BEATS[note.duration] * beatDuration;

      this.fillOfflineNote(offline, offlineMaster, freq, startOffset, duration);
    }

    try {
      const rendered = await offline.startRendering();
      return rendered;
    } catch (e) {
      console.warn('[AudioEngine] Offline rendering failed, fallback to live:', e);
      return this.fallbackBuildBuffer(notes, bpm, maxEndSec, sampleRate);
    }
  }

  private fillOfflineNote(
    offline: OfflineAudioContext,
    master: AudioNode,
    frequency: number,
    startOffset: number,
    duration: number
  ) {
    const osc = offline.createOscillator();
    const gain = offline.createGain();

    osc.type = 'triangle';
    osc.frequency.value = frequency;

    const attack = 0.015;
    const decay = 0.08;
    const sustain = 0.6;
    const release = Math.min(0.25, Math.max(0.04, duration * 0.28));

    gain.gain.setValueAtTime(0, startOffset);
    gain.gain.linearRampToValueAtTime(0.45, startOffset + attack);
    gain.gain.linearRampToValueAtTime(sustain * 0.45, startOffset + attack + decay);
    gain.gain.setValueAtTime(sustain * 0.45, Math.max(startOffset + attack + decay, startOffset + duration - release));
    gain.gain.linearRampToValueAtTime(0, startOffset + duration);

    const harm = offline.createOscillator();
    const harmGain = offline.createGain();
    harm.type = 'sine';
    harm.frequency.value = frequency * 2;
    harmGain.gain.setValueAtTime(0.08, startOffset);
    harmGain.gain.linearRampToValueAtTime(0, startOffset + duration);

    osc.connect(gain);
    harm.connect(harmGain);
    harmGain.connect(gain);
    gain.connect(master);

    osc.start(startOffset);
    osc.stop(startOffset + duration + 0.01);
    harm.start(startOffset);
    harm.stop(startOffset + duration + 0.01);
  }

  private fallbackBuildBuffer(
    notes: Note[],
    bpm: number,
    maxEndSec: number,
    sampleRate: number
  ): AudioBuffer {
    this.init();
    if (!this.ctx) throw new Error('AudioContext unavailable');

    const beatDuration = 60 / bpm;
    const totalFrames = Math.ceil(maxEndSec * sampleRate);
    const buffer = this.ctx.createBuffer(2, totalFrames, sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);

    for (const note of notes) {
      const freq = pitchToFrequency(note.pitch);
      const startOffset = note.beat * beatDuration;
      const duration = DURATION_BEATS[note.duration] * beatDuration;
      const startFrame = Math.floor(startOffset * sampleRate);
      const endFrame = Math.min(totalFrames, Math.ceil((startOffset + duration + 0.02) * sampleRate));
      const durFrames = Math.floor(duration * sampleRate);
      const attack = Math.min(durFrames * 0.02, 0.015 * sampleRate);
      const release = Math.min(durFrames * 0.3, 0.25 * sampleRate);
      const phaseIncr = (2 * Math.PI * freq) / sampleRate;
      let phase = 0;
      const harmPhaseIncr = (2 * Math.PI * freq * 2) / sampleRate;
      let harmPhase = 0;

      for (let i = startFrame; i < endFrame; i++) {
        if (i >= totalFrames) break;
        const local = i - startFrame;
        let env = 0;
        if (local < attack) {
          env = local / attack;
        } else if (local < durFrames - release) {
          env = 0.6;
        } else if (local < durFrames) {
          env = 0.6 * (1 - (local - (durFrames - release)) / release);
        } else {
          const tail = local - durFrames;
          const tailDecay = Math.min(1, tail / (0.02 * sampleRate));
          env = 0.6 * (1 - tailDecay);
          if (env <= 0) break;
        }

        const tri = this.triangle(phase);
        const sine = Math.sin(harmPhase);
        const samp = (tri * 0.45 + sine * 0.08) * env;

        left[i] += samp;
        right[i] += samp;

        phase += phaseIncr;
        if (phase > Math.PI * 2) phase -= Math.PI * 2;
        harmPhase += harmPhaseIncr;
        if (harmPhase > Math.PI * 2) harmPhase -= Math.PI * 2;
      }
    }
    return buffer;
  }

  private triangle(p: number): number {
    const norm = ((p % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const t = norm / (Math.PI * 2);
    if (t < 0.25) return 4 * t;
    if (t < 0.75) return 2 - 4 * t;
    return -4 + 4 * t;
  }

  private async scheduleRender(job: RenderJob) {
    this.renderQueue.push(job);
    if (!this.isRendering) {
      this.pumpRenderQueue();
    }
  }

  private async pumpRenderQueue() {
    if (this.isRendering) return;
    this.isRendering = true;
    try {
      while (this.renderQueue.length > 0) {
        const job = this.renderQueue.shift()!;
        const key = this.getCacheKey(job.notes, job.bpm);
        if (this.bufferCache.has(key)) {
          const cached = this.bufferCache.get(key)!;
          job.resolve(cached);
          continue;
        }
        try {
          const buf = await this.buildBufferWithOffline(job.notes, job.bpm);
          this.bufferCache.set(key, buf);
          job.resolve(buf);
        } catch (e) {
          job.reject(e as Error);
        }
      }
    } finally {
      this.isRendering = false;
    }
  }

  private ensureBuffer(notes: Note[]): Promise<AudioBuffer> {
    const key = this.getCacheKey(notes, this.bpm);
    if (this.bufferCache.has(key)) {
      return Promise.resolve(this.bufferCache.get(key)!);
    }
    return new Promise<AudioBuffer>((resolve, reject) => {
      this.scheduleRender({
        id: key,
        notes: [...notes],
        bpm: this.bpm,
        resolve,
        reject,
      });
    });
  }

  async playChord(notes: Note[], onBeatUpdate?: (beat: number) => void): Promise<void> {
    this.stop();
    this.init();
    if (!this.ctx || !this.masterGain || notes.length === 0) return;

    await this.resume();

    this.beatDuration = 60 / this.bpm;
    this.totalBeats = notes.length > 0
      ? Math.max(...notes.map((n) => n.beat + DURATION_BEATS[n.duration]))
      : 1;

    this.isPlaying = true;
    this.onBeatUpdate = onBeatUpdate || null;

    try {
      const buffer = await this.ensureBuffer(notes);

      if (!this.isPlaying || !this.ctx || !this.masterGain) return;

      this.playStartTime = this.ctx.currentTime + 0.02;

      const fadeGain = this.ctx.createGain();
      fadeGain.gain.setValueAtTime(0, this.playStartTime - 0.001);
      fadeGain.gain.linearRampToValueAtTime(1, this.playStartTime + 0.01);
      fadeGain.connect(this.masterGain);

      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(fadeGain);
      src.start(this.playStartTime);

      this.currentSources.push({
        source: src,
        gain: fadeGain,
        startTime: this.playStartTime,
        duration: buffer.duration,
      });

      src.onended = () => {
        this.isPlaying = false;
        this.stopPlayhead();
      };

      this.startPlayhead();
    } catch (e) {
      console.error('[AudioEngine] playChord error:', e);
      this.isPlaying = false;
    }
  }

  private startPlayhead() {
    if (!this.ctx || !this.onBeatUpdate) return;
    const tick = () => {
      if (!this.isPlaying || !this.ctx || !this.onBeatUpdate) return;
      const elapsed = this.ctx.currentTime - this.playStartTime;
      const beat = Math.max(0, Math.min(this.totalBeats, elapsed / this.beatDuration));
      this.onBeatUpdate(beat);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopPlayhead() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.onBeatUpdate = null;
  }

  stop() {
    this.isPlaying = false;
    this.stopPlayhead();

    if (this.ctx && this.masterGain) {
      const now = this.ctx.currentTime;
      for (const s of this.currentSources) {
        try {
          s.gain.gain.cancelScheduledValues(now);
          s.gain.gain.setValueAtTime(s.gain.gain.value, now);
          s.gain.gain.linearRampToValueAtTime(0, now + 0.04);
          s.source.stop(now + 0.06);
        } catch (e) {}
      }
    }
    this.currentSources = [];
  }

  previewNote(note: Note) {
    this.init();
    if (!this.ctx || !this.previewGain) return;
    this.resume();

    const freq = pitchToFrequency(note.pitch);
    const now = this.ctx.currentTime;
    const duration = 0.3;

    const gain = this.ctx.createGain();
    gain.connect(this.previewGain);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.5, now + 0.01);
    gain.gain.linearRampToValueAtTime(0, now + duration);

    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    osc.connect(gain);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  clearCache() {
    this.bufferCache.clear();
  }

  destroy() {
    this.stop();
    this.clearCache();
    this.renderQueue = [];
  }
}
