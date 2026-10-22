// Копирует общие модули разбора и тайлов в соседний репозиторий данных: ../svetlaya-storona-data/lib
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';

const target = new URL('../../svetlaya-storona-data/lib/', import.meta.url);
if (!existsSync(new URL('..', target))) {
  console.error('Не найден ../svetlaya-storona-data — склонируйте репозиторий данных рядом с этим');
  process.exit(1);
}
mkdirSync(target, { recursive: true });
for (const f of ['osm-rules.js', 'tile-format.js']) {
  copyFileSync(new URL(`../js/${f}`, import.meta.url), new URL(f, target));
  console.log(`скопирован ${f}`);
}
