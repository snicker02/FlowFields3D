// traceworker.js — one shard of a trace.
//
// Streamlines are independent of each other, so the seeds can simply be dealt
// out across cores. Each worker builds the *same* evaluator from the same
// serialised config and takes every Nth seed, which keeps the result identical
// to a single-threaded run rather than merely similar: same seeds, same field,
// same order within each shard.
//
// Even spacing is the exception and is not run here. Its whole mechanism is a
// shared spatial hash that every curve reads and writes as it goes, plus
// candidate seeds spawned from finished curves — sequential by construction.
// Sharding it would either need a lock per sample or produce a different
// picture on every machine.

import { Noise } from './noise.js';
import { makeEvaluator } from './fields.js';
import { Tracer } from './integrator.js';
import { makeVolume } from './volume.js';
import { ImageSource, makeImageField } from './image.js';

self.onmessage = (e) => {
  const msg = e.data;
  try {
    const noise = new Noise(msg.noiseSeed | 0);
    const noiseB = new Noise(((msg.noiseSeed | 0) * 2654435761) >>> 0 || 7);

    let image = null;
    if (msg.image) {
      // Rebuilt from the raw luminance rather than re-decoding the file.
      image = Object.create(ImageSource.prototype);
      image.width = msg.image.width;
      image.height = msg.image.height;
      image.lum = msg.image.lum;
      image.name = 'image';
    }
    const imageField = image
      ? makeImageField(image, { ...msg.imageCfg, enabled: true }, msg.fieldCfg.domain)
      : null;

    const evaluate = makeEvaluator(msg.fieldCfg, {
      noise, noiseB, time: msg.time, image: imageField,
    });

    const cfg = {
      ...msg.cfg,
      inside: makeVolume(msg.volumeCfg, msg.fieldCfg.domain),
      seedWeight: msg.seedWeightCfg && imageField
        ? (x, y, z) => msg.seedWeightCfg.floor
          + (1 - msg.seedWeightCfg.floor) * Math.pow(imageField(x, y, z), msg.seedWeightCfg.power)
        : null,
      seedSlice: msg.slice,
    };

    const tracer = new Tracer(cfg, evaluate);
    const curves = tracer.runAll();

    const payload = curves.map((c) => ({
      pts: c.pts, speed: c.speed, vort: c.vort || null,
      n: c.n, rnd: c.rnd, id: c.id, length: c.length,
    }));
    const transfer = [];
    for (const c of payload) {
      transfer.push(c.pts.buffer, c.speed.buffer);
      if (c.vort) transfer.push(c.vort.buffer);
    }
    self.postMessage({ ok: true, index: msg.slice.index, curves: payload }, transfer);
  } catch (err) {
    self.postMessage({ ok: false, index: msg.slice ? msg.slice.index : 0, error: String(err && err.message || err) });
  }
};
