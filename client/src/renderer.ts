import {
  Note,
  NotePitch,
  Duration,
  JIANPU_MAP,
  DURATION_SYMBOLS,
  pitchToStaffPosition,
} from 'shared';

interface RenderConfig {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  lineSpacing: number;
  staffTopY: number;
  staffMarginX: number;
  measuresPerStaff: number;
  staffsPerPage: number;
  noteRadius: number;
  measureWidth: number;
}

export class ScoreRenderer {
  config: RenderConfig;
  notes: Note[] = [];
  selectedNoteId: string | null = null;
  cursorMeasure = 1;
  cursorBeat = 0;
  ghostNote: { x: number; y: number; pitchName: string; duration: Duration } | null = null;
  playingMeasure: number | null = null;
  playbackBeat = 0;

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const lineSpacing = 14;
    const staffMarginX = 80;
    const measuresPerStaff = 4;
    const staffsPerPage = 4;
    const noteRadius = lineSpacing * 0.55;
    const measureWidth = (rect.width - staffMarginX * 2) / measuresPerStaff;

    this.config = {
      canvas,
      ctx,
      lineSpacing,
      staffTopY: 60,
      staffMarginX,
      measuresPerStaff,
      staffsPerPage,
      noteRadius,
      measureWidth,
    };
  }

  resize() {
    const { canvas, ctx } = this.config;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    this.config.measureWidth = (rect.width - this.config.staffMarginX * 2) / this.config.measuresPerStaff;
    this.render();
  }

  setNotes(notes: Note[]) {
    this.notes = notes;
    this.render();
  }

  render() {
    const { ctx, canvas, lineSpacing, staffTopY, staffMarginX, measuresPerStaff, noteRadius, measureWidth } = this.config;
    const w = canvas.getBoundingClientRect().width;
    const h = canvas.getBoundingClientRect().height;

    ctx.clearRect(0, 0, w, h);

    for (let staffIdx = 0; staffIdx < this.config.staffsPerPage; staffIdx++) {
      const currentStaffTopY = staffTopY + staffIdx * (lineSpacing * 12);
      if (currentStaffTopY > h) break;

      this.drawStaff(currentStaffTopY, w);
      this.drawMeasureLines(currentStaffTopY);
      this.drawClef(currentStaffTopY);
      this.drawNotes(currentStaffTopY, staffIdx);
    }

    this.drawGhostNote();
    this.drawPlayhead();
    this.drawCursorInfo();
  }

  private drawStaff(topY: number, canvasWidth: number) {
    const { ctx, lineSpacing, staffMarginX } = this.config;

    for (let i = 0; i < 5; i++) {
      const y = topY + i * lineSpacing;
      ctx.beginPath();
      ctx.moveTo(staffMarginX, y);
      ctx.lineTo(canvasWidth - staffMarginX, y);
      ctx.strokeStyle = '#3a4060';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  private drawMeasureLines(topY: number) {
    const { ctx, lineSpacing, staffMarginX, measuresPerStaff, measureWidth } = this.config;
    const staffHeight = lineSpacing * 4;

    for (let m = 0; m <= measuresPerStaff; m++) {
      const x = staffMarginX + m * measureWidth;
      ctx.beginPath();
      ctx.moveTo(x, topY);
      ctx.lineTo(x, topY + staffHeight);
      ctx.strokeStyle = '#3a4060';
      ctx.lineWidth = m === 0 ? 2 : 1;
      ctx.stroke();
    }

    for (let m = 0; m < measuresPerStaff; m++) {
      const x = staffMarginX + m * measureWidth + measureWidth / 2;
      ctx.fillStyle = '#2e3348';
      ctx.font = '11px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(`${m + 1}`, x, topY - 8);
    }
  }

  private drawClef(topY: number) {
    const { ctx, lineSpacing, staffMarginX } = this.config;
    ctx.fillStyle = '#6c8cff';
    ctx.font = `${lineSpacing * 5}px serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('\u{1D11E}', staffMarginX - 50, topY + lineSpacing * 2);
  }

  private drawNotes(staffTopY: number, staffIdx: number) {
    const { measuresPerStaff } = this.config;
    const startMeasure = staffIdx * measuresPerStaff + 1;
    const endMeasure = startMeasure + measuresPerStaff;

    const staffNotes = this.notes.filter(
      (n) => n.measure >= startMeasure && n.measure < endMeasure
    );

    for (const note of staffNotes) {
      const pos = this.noteToCanvasPos(note, staffTopY, staffIdx);
      const isSelected = note.id === this.selectedNoteId;
      const isPlaying = this.playingMeasure === note.measure;
      this.drawSingleNote(pos.x, pos.y, note, isSelected, isPlaying, staffTopY);
    }
  }

  private noteToCanvasPos(note: Note, staffTopY: number, staffIdx: number) {
    const { lineSpacing, staffMarginX, measuresPerStaff, measureWidth } = this.config;
    const localMeasure = note.measure - staffIdx * measuresPerStaff - 1;
    const beatsPerMeasure = 4;
    const x = staffMarginX + (localMeasure + note.beat / beatsPerMeasure) * measureWidth;
    const staffPos = pitchToStaffPosition(note.pitch);
    const y = staffTopY + (6 - staffPos) * (lineSpacing / 2);
    return { x, y };
  }

  private drawSingleNote(
    x: number,
    y: number,
    note: Note,
    isSelected: boolean,
    isPlaying: boolean,
    staffTopY: number
  ) {
    const { ctx, lineSpacing, noteRadius } = this.config;

    if (y < staffTopY - lineSpacing * 2 || y > staffTopY + lineSpacing * 6) {
      this.drawLedgerLines(x, y, staffTopY);
    }

    if (note.pitch.accidental === '#') {
      ctx.fillStyle = '#ffc44e';
      ctx.font = `${lineSpacing * 1.5}px serif`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText('\u266F', x - noteRadius - 4, y);
    } else if (note.pitch.accidental === 'b') {
      ctx.fillStyle = '#ffc44e';
      ctx.font = `${lineSpacing * 1.5}px serif`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText('\u266D', x - noteRadius - 4, y);
    }

    ctx.beginPath();
    const rx = noteRadius;
    const ry = noteRadius * 0.75;
    ctx.ellipse(x, y, rx, ry, -0.2, 0, Math.PI * 2);

    if (isSelected) {
      ctx.fillStyle = '#ffc44e';
      ctx.shadowColor = '#ffc44e';
      ctx.shadowBlur = 12;
    } else if (isPlaying) {
      ctx.fillStyle = '#4ecb71';
      ctx.shadowColor = '#4ecb71';
      ctx.shadowBlur = 8;
    } else {
      ctx.fillStyle = '#6c8cff';
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
    }
    ctx.fill();
    ctx.shadowBlur = 0;

    if (note.duration === 'half' || note.duration === 'whole') {
      ctx.strokeStyle = isSelected ? '#ffc44e' : isPlaying ? '#4ecb71' : '#1a1d27';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    if (note.duration !== 'whole') {
      const stemX = x + rx;
      const stemDir = y < staffTopY + lineSpacing * 2 ? 1 : -1;
      const stemLen = lineSpacing * 3.5;
      ctx.beginPath();
      ctx.moveTo(stemX, y);
      ctx.lineTo(stemX, y + stemDir * stemLen);
      ctx.strokeStyle = isSelected ? '#ffc44e' : isPlaying ? '#4ecb71' : '#6c8cff';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      if (note.duration === 'eighth') {
        this.drawFlag(stemX, y + stemDir * stemLen, stemDir, 1, isSelected, isPlaying);
      } else if (note.duration === 'sixteenth') {
        this.drawFlag(stemX, y + stemDir * stemLen, stemDir, 2, isSelected, isPlaying);
      }
    }

    const jianpu = JIANPU_MAP[note.pitch.name];
    const octDots = note.pitch.octave > 4 ? '\u00B7'.repeat(note.pitch.octave - 4) : '';
    const octUnders = note.pitch.octave < 4 ? '_'.repeat(4 - note.pitch.octave) : '';
    ctx.fillStyle = isSelected ? '#ffc44e' : isPlaying ? '#4ecb71' : '#9ca3b8';
    ctx.font = '10px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(`${jianpu}${octDots}${octUnders}`, x, staffTopY + lineSpacing * 5 + 4);
  }

  private drawFlag(x: number, y: number, dir: number, count: number, isSelected: boolean, isPlaying: boolean) {
    const { ctx, lineSpacing } = this.config;
    ctx.strokeStyle = isSelected ? '#ffc44e' : isPlaying ? '#4ecb71' : '#6c8cff';
    ctx.lineWidth = 2;
    for (let i = 0; i < count; i++) {
      const flagY = y + i * 6 * dir;
      ctx.beginPath();
      ctx.moveTo(x, flagY);
      ctx.quadraticCurveTo(x + lineSpacing * 1.2, flagY + dir * lineSpacing, x + lineSpacing * 0.5, flagY + dir * lineSpacing * 1.8);
      ctx.stroke();
    }
  }

  private drawLedgerLines(x: number, y: number, staffTopY: number) {
    const { ctx, lineSpacing, noteRadius } = this.config;

    if (y >= staffTopY + lineSpacing * 4) {
      for (let ly = staffTopY + lineSpacing * 4 + lineSpacing; ly <= y + lineSpacing / 2; ly += lineSpacing) {
        ctx.beginPath();
        ctx.moveTo(x - noteRadius * 1.8, ly);
        ctx.lineTo(x + noteRadius * 1.8, ly);
        ctx.strokeStyle = '#3a4060';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    if (y <= staffTopY - lineSpacing) {
      for (let ly = staffTopY - lineSpacing; ly >= y - lineSpacing / 2; ly -= lineSpacing) {
        ctx.beginPath();
        ctx.moveTo(x - noteRadius * 1.8, ly);
        ctx.lineTo(x + noteRadius * 1.8, ly);
        ctx.strokeStyle = '#3a4060';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  private drawGhostNote() {
    if (!this.ghostNote) return;
    const { ctx, noteRadius } = this.config;

    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    ctx.ellipse(this.ghostNote.x, this.ghostNote.y, noteRadius, noteRadius * 0.75, -0.2, 0, Math.PI * 2);
    ctx.fillStyle = '#6c8cff';
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  private drawPlayhead() {
    if (this.playingMeasure === null) return;
    const { ctx, lineSpacing, staffMarginX, measuresPerStaff, measureWidth } = this.config;

    for (let staffIdx = 0; staffIdx < this.config.staffsPerPage; staffIdx++) {
      const topY = this.config.staffTopY + staffIdx * (lineSpacing * 12);
      const localMeasure = this.playingMeasure - staffIdx * measuresPerStaff - 1;
      if (localMeasure < 0 || localMeasure >= measuresPerStaff) continue;

      const beatsPerMeasure = 4;
      const px = staffMarginX + (localMeasure + this.playbackBeat / beatsPerMeasure) * measureWidth;
      const staffHeight = lineSpacing * 4;

      ctx.beginPath();
      ctx.moveTo(px, topY - 4);
      ctx.lineTo(px, topY + staffHeight + 4);
      ctx.strokeStyle = '#4ecb71';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(px - 4, topY - 4);
      ctx.lineTo(px, topY - 10);
      ctx.lineTo(px + 4, topY - 4);
      ctx.fillStyle = '#4ecb71';
      ctx.fill();
    }
  }

  private drawCursorInfo() {
    const { ctx, lineSpacing, staffMarginX, measuresPerStaff, measureWidth } = this.config;
    for (let staffIdx = 0; staffIdx < this.config.staffsPerPage; staffIdx++) {
      const topY = this.config.staffTopY + staffIdx * (lineSpacing * 12);
      const m = this.cursorMeasure - staffIdx * measuresPerStaff;
      if (m < 1 || m > measuresPerStaff) continue;
      const beatsPerMeasure = 4;
      const cx = staffMarginX + ((m - 1) + this.cursorBeat / beatsPerMeasure) * measureWidth;
      const staffHeight = lineSpacing * 4;

      ctx.beginPath();
      ctx.moveTo(cx, topY - 2);
      ctx.lineTo(cx, topY + staffHeight + 2);
      ctx.strokeStyle = 'rgba(108, 140, 255, 0.3)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  hitTestNote(mx: number, my: number): Note | null {
    const { lineSpacing, staffMarginX, measuresPerStaff, noteRadius, measureWidth, staffTopY } = this.config;

    for (let staffIdx = 0; staffIdx < this.config.staffsPerPage; staffIdx++) {
      const topY = staffTopY + staffIdx * (lineSpacing * 12);
      const startMeasure = staffIdx * measuresPerStaff + 1;
      const endMeasure = startMeasure + measuresPerStaff;

      const staffNotes = this.notes.filter(
        (n) => n.measure >= startMeasure && n.measure < endMeasure
      );

      for (const note of staffNotes) {
        const pos = this.noteToCanvasPos(note, topY, staffIdx);
        const dist = Math.sqrt((mx - pos.x) ** 2 + (my - pos.y) ** 2);
        if (dist < noteRadius * 1.5) {
          return note;
        }
      }
    }
    return null;
  }

  getStaffMetrics() {
    return {
      lineSpacing: this.config.lineSpacing,
      staffMarginX: this.config.staffMarginX,
      measuresPerStaff: this.config.measuresPerStaff,
      measureWidth: this.config.measureWidth,
      staffTopY: this.config.staffTopY,
    };
  }
}
