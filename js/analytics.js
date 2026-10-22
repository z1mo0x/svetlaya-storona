// Яндекс Метрика: цели по ключевым шагам и ошибки JS. Без номера счётчика ничего не отправляется.
import { CONFIG } from './config.js';

const id = CONFIG.metrikaId;
const debug = new URLSearchParams(location.search).has('debug');
let errors = 0;

export function initAnalytics() {
  if (id) {
    // Официальный код подключения Метрики
    (function (m, e, t, r, i, k, a) {
      m[i] = m[i] || function () { (m[i].a = m[i].a || []).push(arguments); };
      m[i].l = 1 * new Date();
      k = e.createElement(t); a = e.getElementsByTagName(t)[0];
      k.async = 1; k.src = r; a.parentNode.insertBefore(k, a);
    })(window, document, 'script', 'https://mc.yandex.ru/metrika/tag.js', 'ym');
    window.ym(id, 'init', { clickmap: true, trackLinks: true, accurateTrackBounce: true });
    showCookieNotice();
  }
  addEventListener('error', (e) => jsError(e.message, e.filename, e.lineno));
  addEventListener('unhandledrejection', (e) => jsError(String(e.reason?.message || e.reason)));
}

// Цель: search, place_loaded, window_set, floor_change, outdoor_change, report_interest, share_link, open_app, quick_place
export function goal(name, params) {
  if (debug) console.info('[цель]', name, params || '');
  if (id && window.ym) window.ym(id, 'reachGoal', name, params);
}

function jsError(msg, file = '', line = 0) {
  if (errors++ > 5) return; // не засыпаем статистику одной и той же ошибкой
  goal('js_error', { msg: String(msg).slice(0, 200), at: `${String(file).split('/').pop()}:${line}` });
}

function showCookieNotice() {
  try {
    if (localStorage.getItem('cookie-ok')) return;
  } catch (e) { /* без localStorage просто показываем каждый раз */ }
  const bar = document.createElement('div');
  bar.className = 'cookie';
  bar.innerHTML = 'Сайт использует cookies Яндекс Метрики, чтобы понимать, как им пользуются. <a href="privacy.html">Подробнее</a> <button type="button">Понятно</button>';
  bar.querySelector('button').addEventListener('click', () => {
    try { localStorage.setItem('cookie-ok', '1'); } catch (e) { /* ничего */ }
    bar.remove();
  });
  document.body.appendChild(bar);
}
