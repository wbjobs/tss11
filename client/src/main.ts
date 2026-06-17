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
import type {
  Chord,
  OwnerRole,
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
  private dragThrottleTimer: number | null = null;
  private renderRafId: number | null = null;
  private ownerRole: OwnerRole = 'guest';
  private hostClientId: string | null = null;

  constructor() {
    const canvas = document.getElementById('scoreCanvas') as HTMLCanvasElement;
    this.renderer = new ScoreRenderer(canvas);
    this.doc = new ClientDocument();
    this.collab = new CollaborationClient('localhost', 4433);
    this.audio = new AudioEngine();

    const metrics = this.renderer.getStaffMetrics();
    this.doc.setStaffMetrics({
      measureWidth: metrics.measureWidth,
      lineSpacing: metrics.lineSpacing,
      measuresPerStaff: metrics.measuresPerStaff,
      staffTopY: metrics.staffTopY,
      staffMarginX: metrics.staffMarginX,
    });

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
      this.scheduleRender();
    });

    this.doc.onSendMessage((type, payload) => {
      if (type === 'request-accompaniment') {
        this.collab.send(JSON.stringify({ type, payload }));
      }
    });

    this.doc.onChordAnalysis((chords) => {
      console.log('[App] Chord analysis:', chords);
    });

    this.doc.onRemoteNoteChange((_noteId, newNote, _prevNote) => {
      if (newNote && (newNote.isAccompaniment || newNote.track === 'accompaniment')) {
        this.renderer.setAccompanimentNotes(this.doc.getAccompanimentNotes());
      } else {
        this.scheduleRender();
      }
    });

    this.renderer.render();

    (window as any).__APP__ = {
      app: this,
      addTestNote: (name: string = 'C') => {
        this.addNoteAtCursor(name as any);
        return `Added ${name}, total notes: ${this.doc.getNotes().length}`;
      },
      getNotes: () => this.doc.getNotes(),
      getAccompanimentNotes: () => this.doc.getAccompanimentNotes(),
      getMelodyNotes: () => this.doc.getMelodyNotes(),
      isHost: () => this.ownerRole === 'host',
      render: () => this.renderer.render(),
      forceRender: (notes: any) => {
        this.renderer.setNotes(notes);
      },
    };

    this.updateHostBadge();
  }

  private scheduleRender() {
    if (this.renderRafId !== null) return;
    this.renderRafId = requestAnimationFrame(() => {
      this.renderRafId = null;
      this.renderer.setNotes(this.doc.getNotes());
    });
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
      this.doc.setCursorPosition({ cursorX: mx, cursorY: my });

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
      this.scheduleRender();
    });

    canvas.addEventListener('dragleave', () => {
      this.renderer.ghostNote = null;
      this.scheduleRender();
    });

    canvas.addEventListener('drop', (e) => {
      e.preventDefault();
      this.renderer.ghostNote = null;

      const pitchName = e.dataTransfer!.getData('text/plain') as PitchName;
      if (!PITCH_NAMES.includes(pitchName)) return;

      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      this.doc.setCursorPosition({ cursorX: mx, cursorY: my });
      this.addNoteAtPosition(pitchName, mx, my);
    });

    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      this.doc.setCursorPosition({ cursorX: mx, cursorY: my });

      if (this.isDragging && this.dragNoteId) {
        if (this.dragThrottleTimer !== null) return;
        this.dragThrottleTimer = window.setTimeout(() => {
          this.dragThrottleTimer = null;
          this.handleDragMove();
        }, 12);
        this.doc.beginDragUpdate(this.dragNoteId, { x: mx, y: my });
        this.scheduleRender();
      }
    });

    canvas.addEventListener('mousedown', (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      this.doc.setCursorPosition({ cursorX: mx, cursorY: my });

      const hit = this.renderer.hitTestNote(mx, my);
      if (hit) {
        this.selectedNoteId = hit.id;
        this.dragNoteId = hit.id;
        this.isDragging = true;
        this.dragStartX = mx;
        this.dragStartY = my;
        this.renderer.selectedNoteId = hit.id;
        this.scheduleRender();
        this.audio.previewNote(hit);
      } else {
        this.selectedNoteId = null;
        this.dragNoteId = null;
        this.renderer.selectedNoteId = null;

        const metrics = this.renderer.getStaffMetrics();
        const snapped = snapToGrid(mx, my, metrics.measureWidth, metrics.lineSpacing, metrics.measuresPerStaff, metrics.staffTopY, metrics.staffMarginX);
        this.currentMeasure = snapped.measure;
        this.renderer.cursorMeasure = snapped.measure;
        this.renderer.cursorBeat = snapped.beat;
        document.getElementById('measureDisplay')!.textContent = `${snapped.measure}`;
        document.getElementById('cursorInfo')!.textContent = `小节 ${snapped.measure}, 拍 ${snapped.beat + 1}`;
        this.scheduleRender();
      }
    });

    canvas.addEventListener('mouseup', () => {
      if (this.dragThrottleTimer !== null) {
        clearTimeout(this.dragThrottleTimer);
        this.dragThrottleTimer = null;
        this.handleDragMove();
      }
      this.isDragging = false;
      this.dragNoteId = null;
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (this.selectedNoteId) {
          this.doc.removeNote(this.selectedNoteId);
          this.selectedNoteId = null;
          this.renderer.selectedNoteId = null;
          this.scheduleRender();
        }
      }

      if (e.key === 'Escape') {
        this.selectedNoteId = null;
        this.renderer.selectedNoteId = null;
        this.scheduleRender();
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

  private handleDragMove() {
    if (!this.dragNoteId) return;
    const metrics = this.renderer.getStaffMetrics();
    const rendered = this.doc.getRenderedNote(this.dragNoteId);
    if (!rendered) return;
    const snapped = snapToGrid(rendered.x, rendered.y, metrics.measureWidth, metrics.lineSpacing, metrics.measuresPerStaff, metrics.staffTopY, metrics.staffMarginX);
    const octave = rendered.y < metrics.staffTopY + metrics.lineSpacing * 2 ? 5 : 4;
    this.doc.updateNote(this.dragNoteId, {
      x: snapped.snappedX,
      y: snapped.snappedY,
      measure: snapped.measure,
      beat: snapped.beat,
      pitch: { name: snapped.pitch as PitchName, octave, accidental: '' },
    }, true);
    this.scheduleRender();
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

    this.scheduleRender();
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

    this.scheduleRender();

    const note: Note = {
      id: '', pitch: { name: pitchName, octave: 4, accidental: '' },
      duration: this.selectedDuration, x: 0, y: 0, measure, beat: 0,
    };
    this.audio.previewNote(note);
  }

  private updateHostBadge() {
    const isHost = this.ownerRole === 'host';
    const badge = document.getElementById('hostBadge');
    if (badge) {
      badge.textContent = isHost ? '👑 房主' : '👤 访客';
    } else {
      const newBadge = document.createElement('div');
      newBadge.id = 'hostBadge';
      newBadge.style.cssText = `
        position: fixed;
        top: 16px;
        right: 16px;
        padding: 8px 16px;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
        border-radius: 20px;
        font-size: 14px;
        font-weight: 600;
        box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
        z-index: 1000;
        user-select: none;
      `;
      newBadge.textContent = isHost ? '👑 房主' : '👤 访客';
      document.body.appendChild(newBadge);
    }
  }

  private generateAccompaniment() {
    if (this.ownerRole !== 'host') {
      alert('只有房主可以生成伴奏');
      return;
    }
    this.doc.generateAccompanimentRequest();
  }

  private toggleAccompaniment() {
    const show = !this.renderer.showAccompaniment;
    this.doc.toggleAccompanimentLayer(show);
    this.renderer.toggleAccompanimentLayer(show);
  }

  private setupToolbar() {
    const btnPlay = document.getElementById('btnPlay')!;
    btnPlay.title = '播放当前小节';
    btnPlay.addEventListener('click', () => {
      this.audio.init();
      this.audio.resume();

      const measure = this.currentMeasure;
      const notes = this.doc.getNotesByMeasure(measure);

      if (notes.length === 0) return;

      this.renderer.playingMeasure = measure;

      this.audio.playChord(notes, (beat) => {
        this.renderer.playbackBeat = beat;
        this.scheduleRender();
      });
    });

    const btnStop = document.getElementById('btnStop')!;
    btnStop.title = '停止播放';
    btnStop.addEventListener('click', () => {
      this.audio.stop();
      this.renderer.playingMeasure = null;
      this.renderer.playbackBeat = 0;
      this.scheduleRender();
    });

    const btnUndo = document.getElementById('btnUndo')!;
    btnUndo.title = '撤销上一步操作';
    btnUndo.addEventListener('click', () => {
      this.doc.undo();
      this.scheduleRender();
    });

    const btnClearMeasure = document.getElementById('btnClearMeasure')!;
    btnClearMeasure.title = '清空当前小节的所有音符';
    btnClearMeasure.addEventListener('click', () => {
      const notes = this.doc.getNotesByMeasure(this.currentMeasure);
      for (const note of notes) {
        this.doc.removeNote(note.id);
      }
      this.scheduleRender();
    });

    const btnGenAcc = document.createElement('button');
    btnGenAcc.className = 'toolbar-btn';
    btnGenAcc.textContent = '🤖 生成伴奏';
    btnGenAcc.title = '只有房主可以生成伴奏';
    btnGenAcc.addEventListener('click', () => {
      this.generateAccompaniment();
    });
    btnClearMeasure.parentElement!.appendChild(btnGenAcc);

    const btnToggleAcc = document.createElement('button');
    btnToggleAcc.className = 'toolbar-btn';
    btnToggleAcc.textContent = '👁 伴奏层';
    btnToggleAcc.title = '显示/隐藏伴奏音符';
    btnToggleAcc.addEventListener('click', () => {
      this.toggleAccompaniment();
    });
    btnClearMeasure.parentElement!.appendChild(btnToggleAcc);
  }

  private setupSync() {
    const statusEl = document.getElementById('connStatus')!;
    const userCountEl = document.getElementById('userCount')!;

    this.collab.onMessage((msg: SyncMessage) => {
      try {
        if (msg.type === 'welcome') {
          const payload = msg.payload as { clientId: string };
          this.doc.setClientId(payload.clientId);
          console.log(`[App] Received welcome, set clientId: ${payload.clientId}`);
        } else if (msg.type === 'full-sync') {
          const notes = msg.payload as Note[];
          this.doc.loadFullSync(notes);
          this.scheduleRender();
          userCountEl.textContent = '2+';
        } else if (msg.type === 'op') {
          const op = msg.payload as Operation;
          this.doc.applyRemoteOperation(op);
          this.scheduleRender();
        } else if (msg.type === 'role-assign') {
          const payload = msg.payload as { role: OwnerRole; clientId: string; hostClientId: string };
          this.doc.setHostClientId(payload.hostClientId);
          this.hostClientId = payload.hostClientId;
          if (payload.clientId && payload.clientId === this.doc.getClientId()) {
            this.ownerRole = payload.role;
            this.doc.setOwnerRole(payload.role);
            this.updateHostBadge();
            console.log(`[App] My role updated: ${payload.role}, host: ${payload.hostClientId}`);
          }
        } else if (msg.type === 'accompaniment-result') {
          const payload = msg.payload as { notes: Note[] };
          this.doc.handleAccompanimentResult(payload.notes);
          this.renderer.setAccompanimentNotes(payload.notes);
          this.scheduleRender();
        } else if (msg.type === 'chord-analysis') {
          const payload = msg.payload as Chord[];
          this.doc.handleChordAnalysis(payload);
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
      const metrics = this.renderer.getStaffMetrics();
      this.doc.setStaffMetrics({
        measureWidth: metrics.measureWidth,
        lineSpacing: metrics.lineSpacing,
        measuresPerStaff: metrics.measuresPerStaff,
        staffTopY: metrics.staffTopY,
        staffMarginX: metrics.staffMarginX,
      });
      this.scheduleRender();
    });
  }
}

new App();
