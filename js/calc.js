// Тяжёлый расчёт уходит в Web Worker. Если воркер недоступен, считаем здесь же — медленнее, но работает.
import { Analyzer } from './insolation.js';

export class Calc {
  constructor() {
    this.seq = 0;
    this.pending = new Map();
    this.model = null;
    this.local = null;
    try {
      this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => this.#onMessage(e.data);
      this.worker.onerror = (e) => {
        console.warn('Расчёт в фоне недоступен, считаем в основном потоке', e.message || e);
        this.#fallback();
      };
    } catch (e) {
      this.worker = null;
    }
  }

  setModel(model) {
    this.model = model;
    this.local = null;
    this.worker?.postMessage({ type: 'model', model });
  }

  setHeight(i, h) {
    this.worker?.postMessage({ type: 'height', i, h });
    if (this.local) {
      this.local.items[i].h = h;
      this.local.heights[i] = h;
    }
  }

  year(win, y, tz, step = 10, dayStep = 1) {
    return this.#call({ type: 'year', win: plain(win), y, tz, step, dayStep });
  }

  max(y, tz) {
    return this.#call({ type: 'max', y, tz });
  }

  floors(win, y, tz, onProgress) {
    return this.#call({ type: 'floors', win: plain(win), y, tz }, onProgress);
  }

  #call(msg, onProgress) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { msg, resolve, reject, onProgress });
      if (this.worker) this.worker.postMessage({ id, ...msg });
      else this.#runLocal(id);
    });
  }

  #onMessage(m) {
    const p = this.pending.get(m.id);
    if (!p) return;
    if (m.progress) {
      p.onProgress?.(m.progress);
      return;
    }
    this.pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error));
    else p.resolve(m.result);
  }

  #fallback() {
    this.worker?.terminate();
    this.worker = null;
    for (const id of this.pending.keys()) this.#runLocal(id);
  }

  async #runLocal(id) {
    const p = this.pending.get(id);
    if (!p) return;
    try {
      if (!this.local) this.local = new Analyzer(this.model);
      const { msg } = p;
      let result;
      if (msg.type === 'year') result = this.local.year(msg.win, msg.y, msg.tz, msg.step, msg.dayStep);
      else if (msg.type === 'max') result = this.local.maxYear(msg.y, msg.tz);
      else if (msg.type === 'floors') result = await this.local.floors(msg.win, msg.y, msg.tz, p.onProgress);
      this.pending.delete(id);
      p.resolve(result);
    } catch (e) {
      this.pending.delete(id);
      p.reject(e);
    }
  }
}

// В воркер уходят только числа и строки окна
function plain(win) {
  const { x, y, nx, ny, z, floor, lo, hi, fh, outdoor, depth } = win;
  return { x, y, nx, ny, z, floor, lo, hi, fh, outdoor, depth };
}
