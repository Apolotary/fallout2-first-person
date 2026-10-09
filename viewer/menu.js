// Map picker: one card per exported map, the primary one first
// (data/index.json, written by tools/fp/catalog.py).

function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

export async function showMenu(list, prompt) {
  let maps;
  try {
    const response = await fetch('data/index.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    maps = await response.json();
  } catch (error) {
    prompt.textContent = 'NO MAPS FOUND: RUN tools/fp_export.py --featured';
    return;
  }
  if (!maps.length) prompt.textContent = 'NO MAPS EXPORTED YET: RUN tools/fp_export.py --featured';
  for (const map of maps) {
    const card = element('a', 'entry');
    card.href = '?map=' + encodeURIComponent(map.map) + (map.view ? '&' + map.view : '');
    const picture = card.appendChild(element('div', 'thumb'));
    if (map.thumb) {
      const image = picture.appendChild(element('img'));
      image.alt = '';
      image.loading = 'lazy';
      image.src = `data/${map.map}/${map.thumb}`;
    }
    const name = card.appendChild(element('div', 'name'));
    name.appendChild(element('span', '', map.title.toUpperCase()));
    name.appendChild(element('span', 'tag', (map.bytes / 1e6).toFixed(1) + ' MB'));
    card.appendChild(element('div', 'desc', map.note || map.map));
    list.appendChild(element('li')).appendChild(card);
  }
}
