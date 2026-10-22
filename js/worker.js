// Фоновый расчёт: год солнца, сравнение этажей и точка отсчёта — без подвисаний интерфейса
import { Analyzer } from './insolation.js';

let an = null;
let floorsJob = 0;
let matrixJob = 0;

self.onmessage = async ({ data: m }) => {
  try {
    switch (m.type) {
      case 'model':
        an = new Analyzer(m.model);
        return;
      case 'height':
        an.items[m.i].h = m.h;
        an.heights[m.i] = m.h;
        return;
      case 'year': {
        const r = an.year(m.win, m.y, m.tz, m.step, m.dayStep);
        self.postMessage({ id: m.id, result: r }, [r.grid.buffer, r.perDay.buffer]);
        return;
      }
      case 'max':
        self.postMessage({ id: m.id, result: an.maxYear(m.y, m.tz) });
        return;
      case 'matrix': {
        // новая матрица отменяет предыдущую
        const job = ++matrixJob;
        const out = await an.matrix(m.base, m.sides, m.floors, m.y, m.tz,
          (cells) => job === matrixJob && self.postMessage({ id: m.id, progress: cells }),
          () => job !== matrixJob);
        self.postMessage({ id: m.id, result: out });
        return;
      }
      case 'floors': {
        // новый запрос этажей отменяет предыдущий
        const job = ++floorsJob;
        const out = await an.floors(m.win, m.y, m.tz,
          (arr) => job === floorsJob && self.postMessage({ id: m.id, progress: arr }),
          () => job !== floorsJob);
        self.postMessage({ id: m.id, result: out });
        return;
      }
    }
  } catch (e) {
    self.postMessage({ id: m.id, error: String(e?.message || e) });
  }
};
