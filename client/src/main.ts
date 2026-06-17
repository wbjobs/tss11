import { ScoreRenderer } from './renderer';
import { CollaborationClient } from './collaboration-client';
import { AudioEngine } from './audio-engine';
import { ClientDocument } from './client-document';
import {
  Note,
  Operation,
  SyncMessage,
  PitchName,
  Duration,
  PITCH_NAMES,
  JIANPU_MAP,
  DURATION_LABELS,
  DURATION_SYMBOLS,
  pitchToStaffPosition,
  snapToGrid,
} from 'shared';

class App {
  private renderer: ScoreRenderer;
  private collab: CollaborationClient;
  private audio: AudioEngine;
  private doc: ClientDocument;
  private selectedDuration: Duration = 'quarter';
  private selectedNoteId: string | null = null;
  private isDragging = false;
  private dragNoteId: string | null = null;
  private dragStartX = 0;
  private dragStartY = 0;
  private currentMeasure = 1;

  constructor() {
    const canvas = document.getElementById('scoreCanvas') as HTMLCanvasElement;
    this.renderer = new ScoreRenderer(canvas);
    this.doc = new ClientDocument();
    this.collab = new CollaborationClient('localhost', 4433);
    this.audio = new AudioEngine();

    this.buildNotePanel();
    this.buildDurationPanel();
    this.buildJianpuRef();
    this.setupCanvasInteraction();
    this.setupToolbar();
    this.setupSync();
    this.setupResize();

    this.doc.onOperation((op) => {
      try {
        this.collab.sendOperation(op);
      } catch (e) {
        console.error('[App] Failed to send op:', e);
      }
      this.renderer.setNotes(this.doc.getNotes());
    });

    this.renderer.render();

    (window as any).__APP__ = {
      app: this,
      addTestNote: (name: string = 'C') => {
        this.addNoteAtCursor(name as any);
        return `Added ${name}, total notes: ${this.doc.getNotes().length}`;
      },
      getNotes: () => this.doc.getNotes(),
      render: () => this.renderer.render(),
      forceRender: (notes: any) => {
        this.renderer.setNotes(notes);
      },
    };
  }

  private buildNotePanel() {
    const palette = document.getElementById('notePalette')!;
    for (const name of PITCH_NAMES) {
      const btn = document.createElement('div');
      btn.className = 'note-btn';
      btn.draggable = true;
      btn.innerHTML = `<span>${name}</span><span class="jianpu">${JIANPU_MAP[name]}</span>`;
      btn.dataset.pitch = name;

      btn.addEventListener('dragstart', (e) => {
        e.dataTransfer!.setData('text/plain', name);
        e.dataTransfer!.effectAllowed = 'copy';
      });

      btn.addEventListener('click', () => {
        this.addNoteAtCursor(name as PitchName);
      });

      palette.appendChild(btn);
    }
  }

  private buildDurationPanel() {
    const palette = document.getElementById('durationPalette')!;
    const durations: Duration[] = ['whole', 'half', 'quarter', 'eighth', 'sixteenth'];

    for (const dur of durations) {
      const btn = document.createElement('div');
      btn.className = 'dur-btn' + (dur === this.selectedDuration ? ' active' : '');
      btn.textContent = `${DURATION_SYMBOLS[dur]} ${DURATION_LABELS[dur]}`;
      btn.dataset.duration = dur;

      btn.addEventListener('click', () => {
        this.selectedDuration = dur;
        palette.querySelectorAll('.dur-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      });

      palette.appendChild(btn);
    }
  }

  private buildJianpuRef() {
    const ref = document.getElementById('jianpuRef')!;
    ref.innerHTML = PITCH_NAMES.map(
      (n) => `${JIANPU_MAP[n]} = ${n}`
    ).join('<br>');
  }

  private setupCanvasInteraction() {
    const canvas = this.renderer.config.canvas;

    canvas.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'copy';
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      const metrics = this.renderer.getStaffMetrics();
      const snapped = snapToGrid(
        mx, my,
        metrics.measureWidth,
        metrics.lineSpacing,
        metrics.measuresPerStaff,
        metrics.staffTopY,
        metrics.staffMarginX
      );

      this.renderer.ghostNote = {
        x: snapped.snappedX,
        y: snapped.snappedY,
        pitchName: snapped.pitch,
        duration: this.selectedDuration,
      };
      this.renderer.render();
    });

    canvas.addEventListener('dragleave', () => {
      this.renderer.ghostNote = null;
      this.renderer.render();
    });

    canvas.addEventListener('drop', (e) => {
      e.preventDefault();
      this.renderer.ghostNote = null;

      const pitchName = e.dataTransfer!.getData('text/plain') as PitchName;
      if (!PITCH_NAMES.includes(pitchName)) return;

      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      this.addNoteAtPosition(pitchName, mx, my);
    });

    canvas.addEventListener('mousedown', (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      const hit = this.renderer.hitTestNote(mx, my);
      if (hit) {
        this.selectedNoteId = hit.id;
        this.dragNoteId = hit.id;
        this.isDragging = true;
        this.dragStartX = mx;
        this.dragStartY = my;
        this.renderer.selectedNoteId = hit.id;
        this.renderer.render();
        this.audio.previewNote(hit);
      } else {
        this.selectedNoteId = null;
        this.dragNoteId = null;
        this.renderer.selectedNoteId = null;
        this.renderer.render();

        const metrics = this.renderer.getStaffMetrics();
        const snapped = snapToGrid(mx, my, metrics.measureWidth, metrics.lineSpacing, metrics.measuresPerStaff, metrics.staffTopY, metrics.staffMarginX);
        this.currentMeasure = snapped.measure;
        this.renderer.cursorMeasure = snapped.measure;
        this.renderer.cursorBeat = snapped.beat;
        document.getElementById('measureDisplay')!.textContent = `${snapped.measure}`;
        document.getElementById('cursorInfo')!.textContent = `小节 ${snapped.measure}, 拍 ${snapped.beat + 1}`;
        this.renderer.render();
      }
    });

    canvas.addEventListener('mousemove', (e) => {
      if (!this.isDragging || !this.dragNoteId) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      const dx = mx - this.dragStartX;
      const dy = my - this.dragStartY;

      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        const metrics = this.renderer.getStaffMetrics();
        const snapped = snapToGrid(mx, my, metrics.measureWidth, metrics.lineSpacing, metrics.measuresPerStaff, metrics.staffTopY, metrics.staffMarginX);

        const note = this.doc.getNotes().find((n) => n.id === this.dragNoteId);
        if (note) {
          const octave = my < this.renderer.config.staffTopY + this.renderer.config.lineSpacing * 2 ? 5 : 4;
          this.doc.updateNote(this.dragNoteId, {
            x: snapped.snappedX,
            y: snapped.snappedY,
            measure: snapped.measure,
            beat: snapped.beat,
            pitch: { name: snapped.pitch as PitchName, octave, accidental: '' },
          });
          this.renderer.setNotes(this.doc.getNotes());
        }
      }
    });

    canvas.addEventListener('mouseup', () => {
      this.isDragging = false;
      this.dragNoteId = null;
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (this.selectedNoteId) {
          this.doc.removeNote(this.selectedNoteId);
          this.selectedNoteId = null;
          this.renderer.selectedNoteId = null;
          this.renderer.setNotes(this.doc.getNotes());
        }
      }

      if (e.key === 'Escape') {
        this.selectedNoteId = null;
        this.renderer.selectedNoteId = null;
        this.renderer.render();
      }

      const pitchMap: Record<string, PitchName> = {
        '1': 'C', '2': 'D', '3': 'E', '4': 'F',
        '5': 'G', '6': 'A', '7': 'B',
      };
      if (pitchMap[e.key]) {
        this.addNoteAtCursor(pitchMap[e.key]);
      }
    });
  }

  private addNoteAtPosition(pitchName: PitchName, mx: number, my: number) {
    const metrics = this.renderer.getStaffMetrics();
    const snapped = snapToGrid(mx, my, metrics.measureWidth, metrics.lineSpacing, metrics.measuresPerStaff, metrics.staffTopY, metrics.staffMarginX);

    const octave = my < metrics.staffTopY + metrics.lineSpacing * 2 ? 5 : 4;

    this.doc.addNote({
      pitch: { name: pitchName, octave, accidental: '' },
      duration: this.selectedDuration,
      x: snapped.snappedX,
      y: snapped.snappedY,
      measure: snapped.measure,
      beat: snapped.beat,
    });

    this.renderer.setNotes(this.doc.getNotes());
  }

  private addNoteAtCursor(pitchName: PitchName) {
    const metrics = this.renderer.getStaffMetrics();
    const measure = this.currentMeasure;
    const staffPos = pitchToStaffPosition({ name: pitchName, octave: 4, accidental: '' });
    const y = metrics.staffTopY + (6 - staffPos) * (metrics.lineSpacing / 2);
    const x = metrics.staffMarginX + ((measure - 1) + 0.5) * metrics.measureWidth;

    this.doc.addNote({
      pitch: { name: pitchName, octave: 4, accidental: '' },
      duration: this.selectedDuration,
      x,
      y,
      measure,
      beat: 0,
    });

    this.renderer.setNotes(this.doc.getNotes());

    const note: Note = {
      id: '', pitch: { name: pitchName, octave: 4, accidental: '' },
      duration: this.selectedDuration, x: 0, y: 0, measure, beat: 0,
    };
    this.audio.previewNote(note);
  }

  private setupToolbar() {
    document.getElementById('btnPlay')!.addEventListener('click', () => {
      this.audio.init();
      this.audio.resume();

      const measure = this.currentMeasure;
      const notes = this.doc.getNotesByMeasure(measure);

      if (notes.length === 0) return;

      this.renderer.playingMeasure = measure;

      this.audio.playChord(notes, (beat) => {
        this.renderer.playbackBeat = beat;
        this.renderer.render();
      });
    });

    document.getElementById('btnStop')!.addEventListener('click', () => {
      this.audio.stop();
      this.renderer.playingMeasure = null;
      this.renderer.playbackBeat = 0;
      this.renderer.render();
    });

    document.getElementById('btnUndo')!.addEventListener('click', () => {
      this.doc.undo();
      this.renderer.setNotes(this.doc.getNotes());
    });

    document.getElementById('btnClearMeasure')!.addEventListener('click', () => {
      const notes = this.doc.getNotesByMeasure(this.currentMeasure);
      for (const note of notes) {
        this.doc.removeNote(note.id);
      }
      this.renderer.setNotes(this.doc.getNotes());
    });
  }

  private setupSync() {
    const statusEl = document.getElementById('connStatus')!;
    const userCountEl = document.getElementById('userCount')!;

    this.collab.onMessage((msg: SyncMessage) => {
      console.log('[App] Received message:', msg.type);
      try {
        if (msg.type === 'full-sync') {
          const notes = msg.payload as Note[];
          console.log('[App] full-sync notes count:', notes.length, 'sample:', notes[0]);
          this.doc.loadFullSync(notes);
          console.log('[App] loadFullSync OK, total notes:', this.doc.getNotes().length);
          this.renderer.setNotes(this.doc.getNotes());
          console.log('[App] renderer.setNotes OK');
          userCountEl.textContent = '2+';
        } else if (msg.type === 'op') {
          const op = msg.payload as Operation;
          console.log('[App] remote op:', op.type, op.note.pitch?.name);
          const changed = this.doc.applyRemoteOperation(op);
          console.log('[App] remote op applied, changed:', changed);
          if (changed) {
            this.renderer.setNotes(this.doc.getNotes());
          }
        }
      } catch (e) {
        console.error('[App] Handler error:', (e as Error).message, (e as Error).stack);
      }
    });

    this.collab.connect().then((type) => {
      const proto = type === 'webtransport' ? 'WebTransport' : 'WebSocket';
      statusEl.textContent = `\u25CF 已连接 (${proto})`;
      statusEl.classList.add('connected');
      userCountEl.textContent = '1+';
    }).catch(() => {
      statusEl.textContent = '\u25CF 离线模式';
      statusEl.classList.remove('connected');
      userCountEl.textContent = '1';
    });
  }

  private setupResize() {
    window.addEventListener('resize', () => {
      this.renderer.resize();
    });
  }
}

new App();
