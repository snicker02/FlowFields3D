// gradient.js — the gradient editor: drag stops, click the bar to add one,
// double-click a stop to remove it.

import { Gradient, GRADIENT_PRESETS, hexToRgb, rgbToHex } from '../engine/palette.js';

export class GradientEditor {
  constructor(root, gradient, onChange) {
    this.root = root;
    this.gradient = gradient;
    this.onChange = onChange;
    this.selected = 0;
    this.build();
  }

  build() {
    this.root.innerHTML = '';
    this.root.classList.add('gradient-editor');

    const presetRow = document.createElement('div');
    presetRow.className = 'row';
    const label = document.createElement('label');
    label.textContent = 'Palette';
    const sel = document.createElement('select');
    for (const name of Object.keys(GRADIENT_PRESETS)) {
      const o = document.createElement('option');
      o.value = name; o.textContent = name;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => {
      const g = Gradient.fromPreset(sel.value);
      this.gradient.stops = g.stops;
      this.selected = 0;
      this.refresh();
      this.onChange();
    });
    this.presetSelect = sel;
    presetRow.append(label, sel);

    this.bar = document.createElement('div');
    this.bar.className = 'gradient-bar';
    this.handles = document.createElement('div');
    this.handles.className = 'gradient-handles';
    this.bar.appendChild(this.handles);

    this.bar.addEventListener('pointerdown', (e) => {
      if (e.target !== this.bar) return;
      const r = this.bar.getBoundingClientRect();
      const t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      const c = [0, 0, 0];
      this.gradient.sample(t, c);
      this.gradient.addStop(t, c);
      this.selected = this.gradient.stops.findIndex((s) => s.t === t);
      this.refresh();
      this.onChange();
    });

    const editRow = document.createElement('div');
    editRow.className = 'row';
    this.colorInput = document.createElement('input');
    this.colorInput.type = 'color';
    this.colorInput.addEventListener('input', () => {
      const s = this.gradient.stops[this.selected];
      if (!s) return;
      s.color = hexToRgb(this.colorInput.value);
      this.refresh();
      this.onChange();
    });
    const del = document.createElement('button');
    del.className = 'ghost';
    del.textContent = 'Remove stop';
    del.addEventListener('click', () => {
      this.gradient.removeStop(this.selected);
      this.selected = Math.max(0, this.selected - 1);
      this.refresh();
      this.onChange();
    });
    const flip = document.createElement('button');
    flip.className = 'ghost';
    flip.textContent = 'Flip';
    flip.addEventListener('click', () => {
      this.gradient.stops = this.gradient.stops.map((s) => ({ t: 1 - s.t, color: s.color })).reverse();
      this.refresh();
      this.onChange();
    });
    editRow.append(this.colorInput, del, flip);

    this.root.append(presetRow, this.bar, editRow);
    this.refresh();
  }

  refresh() {
    this.gradient.sort();
    this.bar.style.background = `linear-gradient(to right, ${this.gradient.cssString()})`;
    this.handles.innerHTML = '';
    this.gradient.stops.forEach((s, i) => {
      const h = document.createElement('div');
      h.className = 'gradient-handle' + (i === this.selected ? ' selected' : '');
      h.style.left = (s.t * 100).toFixed(2) + '%';
      h.style.background = rgbToHex(s.color);
      h.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this.selected = i;
        this.colorInput.value = rgbToHex(s.color);
        this.refresh();
        const r = this.bar.getBoundingClientRect();
        const move = (ev) => {
          s.t = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
          this.refresh();
          this.onChange();
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
      h.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this.gradient.removeStop(i);
        this.selected = 0;
        this.refresh();
        this.onChange();
      });
      this.handles.appendChild(h);
    });
    const sel = this.gradient.stops[this.selected];
    if (sel) this.colorInput.value = rgbToHex(sel.color);
  }
}
