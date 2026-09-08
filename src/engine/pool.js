// pool.js — deal a trace out across cores.
//
// Worth doing only when there is enough work to pay for the message round trip
// and only when the trace is shardable at all, which even spacing is not. The
// caller checks both and falls back to the time-sliced tracer otherwise; a
// browser that refuses module workers (opening the page over file://, mostly)
// lands in the same fallback rather than failing.

const WORKER_URL = new URL('./traceworker.js', import.meta.url);

export function workerCount() {
  const n = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 1;
  // One core left for the page itself, and past eight the seeds-per-worker
  // count gets small enough that the overhead shows.
  return Math.max(1, Math.min(8, n - 1));
}

/** Whether this trace can be sharded at all. */
export function canParallelise(cfg) {
  if (typeof Worker === 'undefined') return false;
  if (cfg.even) return false;                 // shared hash: sequential by nature
  if (workerCount() < 2) return false;
  return cfg.seedCount >= 64;                 // too small to be worth the trip
}

/**
 * Trace on `workerCount()` workers and merge. Resolves with the curves in the
 * same order a single-threaded run would produce them: shard 0's curves, then
 * shard 1's, and so on, with each shard holding every Nth seed.
 */
export function parallelTrace(msg, onProgress) {
  const total = workerCount();
  const workers = [];
  const results = new Array(total).fill(null);
  let done = 0;

  return new Promise((resolve, reject) => {
    const cleanup = () => workers.forEach((w) => w.terminate());
    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(e instanceof Error ? e : new Error(String(e)));
    };

    for (let i = 0; i < total; i++) {
      let w;
      try {
        w = new Worker(WORKER_URL, { type: 'module' });
      } catch (e) {
        fail(e);
        return;
      }
      workers.push(w);
      w.onerror = (e) => fail(new Error(e.message || 'worker failed'));
      w.onmessage = (e) => {
        const d = e.data;
        if (!d.ok) { fail(new Error(d.error)); return; }
        results[d.index] = d.curves;
        done++;
        if (onProgress) onProgress(done / total);
        if (done === total && !settled) {
          settled = true;
          cleanup();
          const out = [];
          for (const shard of results) {
            if (!shard) continue;
            for (const c of shard) { c.id = out.length; out.push(c); }
          }
          resolve(out);
        }
      };

      w.postMessage({
        ...msg,
        cfg: {
          ...msg.cfg,
          // Each shard keeps its own share of the curve cap, so the total
          // matches what a single run would have produced.
          maxCurves: Math.ceil(msg.cfg.maxCurves / total),
        },
        slice: { index: i, total },
      });
    }
  });
}
