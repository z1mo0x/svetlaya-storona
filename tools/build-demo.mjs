// Собирает data/demo.json из выгрузок OSM API: node tools/build-demo.mjs <lat> <lon> <q0.json> [q1.json ...]
import { readFileSync, writeFileSync } from 'node:fs';
import { parseOSM, packModel } from '../js/osm.js';

const [lat, lon, ...files] = process.argv.slice(2);
const seen = new Map();
for (const f of files) for (const e of JSON.parse(readFileSync(f, 'utf8')).elements) seen.set(e.type[0] + e.id, e);
const model = parseOSM([...seen.values()], +lat, +lon);
const out = JSON.stringify(packModel(model));
writeFileSync(new URL('../data/demo.json', import.meta.url), out);
console.log(`зданий: ${model.buildings.length}, дорог: ${model.roads.length}, зон: ${model.areas.length}, деревьев: ${model.trees.length / 3}, ${(out.length / 1024).toFixed(0)} КБ`);
