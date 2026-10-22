// Собирает dist/index.html — один файл, который открывается двойным кликом (без локального сервера):
// стили, все модули и демо-квартал встраиваются внутрь. Запуск: node tools/build-standalone.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

// Порядок важен: модуль идёт после тех, от кого зависит
// Воркер в один файл не встраивается — без него расчёт идёт в основном потоке (см. js/calc.js)
const MODULES = ['sun', 'osm', 'insolation', 'geocode', 'quality', 'config', 'analytics', 'calc', 'scene', 'main'];

const threeImports = new Set();
const parts = [];

for (const name of MODULES) {
  let code = read(`js/${name}.js`);
  // импорты three оставляем настоящими — их подтянет importmap с CDN
  code = code.replace(/import\s+[^;]*?from\s*'three[^']*';\n?/g, (m) => {
    threeImports.add(m.trim());
    return '';
  });
  // локальные импорты → деструктуризация из уже собранного модуля
  code = code.replace(/import\s*\{([\s\S]*?)\}\s*from\s*'\.\/([\w-]+)\.js';/g, (_, names, mod) => {
    const list = names.split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/\s+as\s+/, ': '));
    return `const { ${list.join(', ')} } = __${mod};`;
  });
  const exported = [];
  code = code.replace(/^export\s+((?:async\s+)?function\*?|class|const|let)\s+(\w+)/gm, (_, kind, id) => {
    exported.push(id);
    return `${kind} ${id}`;
  });
  code = code.replace(/^export\s*\{([^}]*)\};?\n?/gm, (_, names) => {
    exported.push(...names.split(',').map((s) => s.trim()).filter(Boolean));
    return '';
  });
  if (name === 'main') {
    code = code.replace(/fetch\('data\/demo\.json'\)\.then\(\(r\) => r\.json\(\)\)/g,
      "Promise.resolve(JSON.parse(document.getElementById('demo-data').textContent))");
    parts.push(`{\n${code}\n}`);
  } else {
    parts.push(`const __${name} = (() => {\n${code}\nreturn { ${exported.join(', ')} };\n})();`);
  }
}

const bundle = `${[...threeImports].join('\n')}\n\n${parts.join('\n\n')}\n`;
const css = read('css/style.css');
const demo = read('data/demo.json').replace(/<\//g, '<\\/');

let html = read('index.html');
html = html.replace('<link rel="stylesheet" href="css/style.css">', () => `<style>\n${css}\n</style>`);
html = html.replace('<script type="module" src="js/main.js"></script>', () =>
  `<script type="application/json" id="demo-data">${demo}</script>\n  <script type="module">\n${bundle}</script>`);

mkdirSync(new URL('dist/', root), { recursive: true });
writeFileSync(new URL('dist/index.html', root), html);
console.log(`dist/index.html — ${(html.length / 1024).toFixed(0)} КБ`);
