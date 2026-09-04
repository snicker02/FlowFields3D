// spatialhash.js — uniform grid over an unbounded domain, used by the
// evenly-spaced streamline placer. Cell size equals the separation distance,
// so a proximity query only ever touches the 27 neighbouring cells.

export class SpatialHash {
  constructor(cellSize) {
    this.cell = cellSize;
    this.inv = 1 / cellSize;
    this.map = new Map();
    this.px = []; this.py = []; this.pz = [];
    this.cid = []; this.idx = [];
    this.count = 0;
  }

  key(ix, iy, iz) {
    // 21 bits per axis, biased to keep the value positive and collision-free
    // for any coordinate within +/- 1e6 cells.
    return ((ix + 1048576) * 2097152 + (iy + 1048576)) * 2097152 + (iz + 1048576);
  }

  insert(x, y, z, curveId, sampleIndex) {
    const i = this.count++;
    this.px.push(x); this.py.push(y); this.pz.push(z);
    this.cid.push(curveId); this.idx.push(sampleIndex);
    const k = this.key(Math.floor(x * this.inv), Math.floor(y * this.inv), Math.floor(z * this.inv));
    const bucket = this.map.get(k);
    if (bucket) bucket.push(i); else this.map.set(k, [i]);
    return i;
  }

  /**
   * True if any stored sample lies within `d` of (x,y,z), ignoring samples that
   * belong to `selfId` within `skip` steps of `selfIndex` — a streamline must be
   * allowed to run away from its own recent past without tripping the test.
   */
  hasWithin(x, y, z, d, selfId = -1, selfIndex = 0, skip = 0) {
    const d2 = d * d;
    const cx = Math.floor(x * this.inv), cy = Math.floor(y * this.inv), cz = Math.floor(z * this.inv);
    const r = Math.max(1, Math.ceil(d * this.inv));
    for (let ix = cx - r; ix <= cx + r; ix++) {
      for (let iy = cy - r; iy <= cy + r; iy++) {
        for (let iz = cz - r; iz <= cz + r; iz++) {
          const bucket = this.map.get(this.key(ix, iy, iz));
          if (!bucket) continue;
          for (let b = 0; b < bucket.length; b++) {
            const i = bucket[b];
            if (this.cid[i] === selfId && Math.abs(this.idx[i] - selfIndex) <= skip) continue;
            const dx = this.px[i] - x, dy = this.py[i] - y, dz = this.pz[i] - z;
            if (dx * dx + dy * dy + dz * dz < d2) return true;
          }
        }
      }
    }
    return false;
  }
}
