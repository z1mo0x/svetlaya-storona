// Отчёт по окну: картинка для мессенджеров (canvas → PNG) и PDF через печать браузера.
// Данные собирает main.js (reportData), здесь только вёрстка.

const C = {
  paper: '#fbf8f3', bg: '#f3ede3', ink: '#1d1712', ink2: '#5d5147', ink3: '#998b7d',
  sun: '#ee9a3a', sunDeep: '#c8622a', shade: '#9aa6c0', shadeDeep: '#5d6d93', sage: '#7f9470', line: 'rgba(29,23,18,0.14)',
};
const LEVEL_COLOR = { sunny: C.sunDeep, mid: C.ink, low: C.shadeDeep };
const MONTH_LETTERS = ['я', 'ф', 'м', 'а', 'м', 'и', 'и', 'а', 'с', 'о', 'н', 'д'];
const SITE = 'svetlaya-storona.vercel.app';

async function fontsReady() {
  const list = ['500 64px Cormorant', '600 190px Cormorant', '500 28px Manrope', '700 24px Manrope', '400 22px "JetBrains Mono"'];
  try {
    await Promise.all(list.map((f) => document.fonts.load(f, 'Солнце 0123')));
  } catch (e) { /* без шрифтов нарисуем системными */ }
}

// Перенос по словам; длинное обрезается многоточием на последней строке
function wrap(g, text, maxW, maxLines) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (g.measureText(t).width <= maxW || !cur) cur = t;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let last = lines[maxLines - 1];
    while (last && g.measureText(`${last}…`).width > maxW) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last.trimEnd()}…`;
  }
  return lines;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

// Картинка «вписать с обрезкой» в прямоугольник
function cover(g, img, x, y, w, h) {
  const k = Math.max(w / img.width, h / img.height);
  const sw = w / k, sh = h / k;
  g.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
}

// ---------- Картинка для мессенджеров: ширина 1080, высота по содержимому (~1440) ----------
export async function makeCard(d) {
  await fontsReady();
  const W = 1080, P = 72, CW = W - P * 2;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = 1800;
  const g = cv.getContext('2d');
  g.fillStyle = C.paper;
  g.fillRect(0, 0, W, cv.height);

  // 3D-вид вокруг окна
  const IH = 600;
  if (d.shot) cover(g, d.shot, 0, 0, W, IH);
  else {
    g.fillStyle = C.bg;
    g.fillRect(0, 0, W, IH);
  }

  let y = IH + 72;
  g.textBaseline = 'alphabetic';
  g.fillStyle = C.ink3;
  g.font = '500 28px Manrope';
  g.fillText(wrap(g, d.kicker, CW, 1)[0], P, y);

  y += 70;
  g.fillStyle = C.ink;
  g.font = '500 64px Cormorant';
  for (const line of wrap(g, d.title, CW, 2)) {
    g.fillText(line, P, y);
    y += 68;
  }

  // Часы в год и вердикт; четырёхзначное число уменьшаем, чтобы не наехало на вердикт справа
  y += 112;
  const num = d.hoursText;
  let fs = 190;
  g.font = `600 ${fs}px Cormorant`;
  const maxNum = 590 - 40 - P - 140;
  if (g.measureText(num).width > maxNum) {
    fs = Math.floor((fs * maxNum) / g.measureText(num).width);
    g.font = `600 ${fs}px Cormorant`;
  }
  g.fillText(num, P - 6, y);
  const nw = g.measureText(num).width;
  g.font = '500 30px Manrope';
  g.fillStyle = C.ink2;
  g.fillText('ч солнца', P + nw + 10, y - 44);
  g.fillText('в год', P + nw + 10, y - 6);

  const RX = 590, RW = W - P - RX;
  g.fillStyle = LEVEL_COLOR[d.level] || C.ink;
  g.font = '500 58px Cormorant';
  g.fillText(d.levelLabel, RX, y - 96);
  g.fillStyle = C.ink2;
  g.font = '500 26px Manrope';
  let ry = y - 54;
  for (const line of wrap(g, d.levelNote, RW, 3)) {
    g.fillText(line, RX, ry);
    ry += 36;
  }

  // Норма; у Cormorant цифры старого стиля — хвосты 3, 5, 7, 9 уходят под строку
  y += 76;
  g.font = '700 24px Manrope';
  const badge = d.norm.pass ? 'Норма выполняется' : 'Норма не выполняется';
  const bw = g.measureText(badge).width + 40;
  g.fillStyle = d.norm.pass ? C.sage : C.sunDeep;
  roundRect(g, P, y, bw, 50, 25);
  g.fill();
  g.fillStyle = '#fff';
  g.fillText(badge, P + 20, y + 33);
  g.fillStyle = C.ink2;
  g.font = '500 26px Manrope';
  g.fillText(wrap(g, d.norm.line, CW - bw - 24, 1)[0], P + bw + 24, y + 34);

  // Солнечный календарь
  y += 118;
  g.fillStyle = C.ink;
  g.font = '700 24px Manrope';
  g.fillText(`Солнце в окне за ${d.year} год`, P, y);
  let lx = W - P;
  g.font = '500 22px Manrope';
  for (const [label, color] of [['закрыто домами', C.shade], ['солнце', C.sun]]) {
    const tw = g.measureText(label).width;
    lx -= tw;
    g.fillStyle = C.ink2;
    g.fillText(label, lx, y);
    lx -= 30;
    g.fillStyle = color;
    roundRect(g, lx, y - 18, 20, 20, 5);
    g.fill();
    lx -= 30;
  }
  y += 22;
  const HH = 150;
  g.save();
  roundRect(g, P, y, CW, HH, 18);
  g.clip();
  if (d.heat) g.drawImage(d.heat, P, y, CW, HH);
  g.restore();
  y += HH + 32;
  g.fillStyle = C.ink3;
  g.font = '500 20px Manrope';
  g.textAlign = 'center';
  MONTH_LETTERS.forEach((m, i) => g.fillText(m, P + ((i + 0.5) / 12) * CW, y));
  g.textAlign = 'left';

  // Подпись
  y += 44;
  g.fillStyle = C.line;
  g.fillRect(P, y, CW, 1);
  g.fillStyle = C.ink;
  g.font = '500 38px Cormorant';
  g.fillText('Светлая сторона', P, y + 56);
  g.fillStyle = C.ink3;
  g.font = '400 22px "JetBrains Mono"';
  g.textAlign = 'right';
  g.fillText(SITE, W - P, y + 50);
  g.textAlign = 'left';

  const out = document.createElement('canvas');
  out.width = W;
  out.height = y + 104;
  out.getContext('2d').drawImage(cv, 0, 0);
  return out;
}

// На телефоне — системное «Поделиться», на компьютере — скачать файл
export async function shareCard(cv, filename, text) {
  const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
  const file = new File([blob], filename, { type: 'image/png' });
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], text });
      return 'shared';
    } catch (e) {
      if (e.name === 'AbortError') return 'cancel';
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return 'downloaded';
}

// ---------- PDF: отдельная вёрстка для печати, браузер сохраняет её в PDF ----------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function readableUrl(url) {
  try {
    return decodeURIComponent(url.replace(/\+/g, ' '));
  } catch (e) {
    return url;
  }
}

export async function printReport(d) {
  let root = document.querySelector('.print-report');
  if (!root) {
    root = document.createElement('div');
    root.className = 'print-report';
    document.body.append(root);
  }
  const shot = d.shot ? `<img class="pr-shot" alt="" src="${d.shot.toDataURL('image/jpeg', 0.9)}">` : '';
  const heat = d.heat ? `<img class="pr-heat" alt="" src="${d.heat.toDataURL('image/png')}">` : '';
  const blockers = d.blockers.length
    ? `<table class="pr-table"><tbody>${d.blockers.map((b) => `<tr><td>${esc(b.name)}</td><td>${esc(b.meta)}</td><td class="num">${b.share}%</td></tr>`).join('')}</tbody></table>`
    : '<p>Соседние дома почти не закрывают это окно.</p>';
  const m = d.matrix;
  const matrix = m ? `<section class="pr-sec pr-matrix">
      <h2>Солнце по квартирам этого дома</h2>
      <p class="pr-note">Часы прямого солнца в год. Строка — этаж, столбец — сторона дома. «✓» — норма выполняется. Рамкой выделено ваше окно.${m.partial ? ' Часть ячеек не успела посчитаться.' : ''}</p>
      <table class="pr-table pr-grid"><thead><tr><th>Этаж</th>${m.cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>
      ${m.rows.map((r) => `<tr><th>${r.floor}</th>${r.cells.map((c) => `<td class="${c.cur ? 'cur' : ''}">${c.hours == null ? '—' : `${c.hours}${c.pass ? ' ✓' : ''}`}</td>`).join('')}</tr>`).join('')}
      </tbody></table>
    </section>` : '';

  root.innerHTML = `<article class="pr">
    <header class="pr-head"><span class="pr-brand">Светлая сторона</span><span>Отчёт от ${esc(d.today)}</span></header>
    <h1>${esc(d.title)}</h1>
    <p class="pr-sub">${esc(d.kicker)}</p>
    ${shot}
    <section class="pr-verdict">
      <div class="pr-num">${esc(d.hoursText)}<small>ч прямого солнца<br>в ${d.year} году</small></div>
      <div><b class="pr-level is-${d.level}">${esc(d.levelLabel)}</b><p>${esc(d.verdictText)}</p></div>
    </section>
    <section class="pr-sec">
      <h2>Норма инсоляции — ${d.norm.pass ? 'выполняется' : 'не выполняется'}</h2>
      <p>${esc(d.norm.text)}</p>
    </section>
    <section class="pr-sec">
      <h2>Солнце в окне по дням года</h2>
      ${heat}
      <div class="pr-months">${MONTH_LETTERS.map((x) => `<span>${x}</span>`).join('')}</div>
      <p class="pr-legend"><i style="background:${C.sun}"></i>солнце <i style="background:${C.shade}"></i>закрыто домами <i style="background:#e6ddcf"></i>солнце с другой стороны дома <i style="background:#2b2b3d"></i>ночь · по горизонтали — дни, по вертикали — часы суток</p>
    </section>
    <section class="pr-sec">
      <h2>Кто забирает солнце</h2>
      ${blockers}
    </section>
    ${matrix}
    <section class="pr-sec pr-method">
      <h2>Как считали</h2>
      <ul>${d.method.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    </section>
    <footer class="pr-foot">Открыть это окно в 3D: <a href="${esc(d.url)}">${esc(readableUrl(d.url))}</a></footer>
  </article>`;
  await Promise.all([...root.querySelectorAll('img')].map((i) => i.decode().catch(() => {})));

  const title = document.title;
  document.title = d.fileName;
  document.body.classList.add('is-printing');
  const done = () => {
    document.body.classList.remove('is-printing');
    document.title = title;
    removeEventListener('afterprint', done);
  };
  addEventListener('afterprint', done);
  window.print();
}
