/**
 * app.js
 * -----------------------------------------------------------------------
 * Вся логика конструктора работает в браузере:
 *  - хранит данные мода в объекте `state`;
 *  - автосохраняет его в localStorage, чтобы работа не терялась;
 *  - по схемам из schemas.js строит формы добавления/редактирования
 *    и списки уже добавленных строк для каждой таблицы;
 *  - на «Экспорт» собирает mod.json + weapons.json + ... + textures/*
 *    в один .zip через JSZip и запускает скачивание.
 * -----------------------------------------------------------------------
 */

// ============================================================ УТИЛИТЫ

const qs = (sel, root = document) => root.querySelector(sel);
const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v === false || v === null || v === undefined) { /* skip */ }
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function slugify(str) {
  return (str || 'my_mod')
    .toString().trim().toLowerCase()
    .replace(/[^a-z0-9а-яё_\- ]/gi, '')
    .replace(/\s+/g, '_') || 'my_mod';
}

// Практическая транслитерация — только чтобы не заставлять человека
// придумывать латинский id и черновой перевод самому.
const TRANSLIT_MAP = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};
function translit(str) {
  return (str || '').toString().toLowerCase().split('')
    .map(ch => (TRANSLIT_MAP[ch] !== undefined ? TRANSLIT_MAP[ch] : ch)).join('');
}

/** id-заглушку из названия: snake_case (kylysh) или PascalCase (Mithril). */
function idFromName(name, existingIds, mode) {
  const t = translit(name);
  let base;
  if (mode === 'pascal') {
    base = t.split(/[^a-z0-9]+/i).filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('') || 'Item';
  } else {
    base = t.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'item';
  }
  let id = base, n = 1;
  while (existingIds.has(id)) id = mode === 'pascal' ? `${base}${++n}` : `${base}_${++n}`;
  return id;
}

/** Черновой перевод «на глаз» — заготовка, которую пользователь потом поправит. */
function guessTranslation(ruText) {
  return translit(ruText).split(/[^a-z0-9]+/i).filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || ruText;
}

/** Первый свободный номер look для слота одежды (с учётом занятого игрой). */
function nextFreeLook(slot) {
  const start = LOOK_RESERVED_START[slot] ?? 0;
  const used = new Set(state.tables.apparel
    .filter(a => a.slot === slot && a.look !== undefined)
    .map(a => Number(a.look)));
  let n = start;
  while (used.has(n)) n++;
  return n;
}

/**
 * Если человек вписал только «Название» и ничего больше — предмет не должен
 * остаться «пустым» (0 урона навсегда, наложение слоёв одежды и т.п.).
 * Дозаполняем только то, что пользователь не трогал сам.
 */
function applyBaselineDefaults(schemaKey, item) {
  if (schemaKey === 'weapons') {
    const untouched = item.dmg === undefined && item.interval === undefined && item.range === undefined && item.melee === undefined;
    if (!untouched) return;
    Object.assign(item, {
      melee: true, dmg: 6, interval: 1.6, range: 1.4, dtype: 'Sharp',
      craftWork: 2, hitLabel: `Удар: ${item.name}`,
    });
  } else if (schemaKey === 'apparel') {
    if (item.slot === undefined) item.slot = 'Torso';
    if (item.look === undefined) item.look = nextFreeLook(item.slot);
    if (item.matType === undefined) item.matType = 'Cloth';
    if (item.matCost === undefined) item.matCost = 10;
    if (item.maxHp === undefined) item.maxHp = 100;
  }
}

class FieldError extends Error {
  constructor(field, msg) {
    super(`«${field.label}»: ${msg}`);
    this.field = field;
  }
}

// ============================================================ СОСТОЯНИЕ

const STORAGE_KEY = 'alemModBuilder.state.v1';

const TABLE_KEYS = [
  'weapons', 'materials', 'apparel', 'resources', 'recipes', 'buildings',
  'techs', 'traits', 'traitPairs', 'childhoods', 'adulthoods', 'rareFullfirst', 'loc',
  // «Мир и жизнь» — разделы 23–31 инструкции
  'events', 'plants', 'animals', 'livestock', 'furniture',
  'factions', 'biomes', 'quests', 'needs', 'storytellers', 'challenges', 'info',
];

// Таблицы, которые ложатся в свой файл «как есть»: имя файла → ключ списка внутри.
const SIMPLE_TABLE_FILES = {
  events: ['events.json', 'events'],
  plants: ['plants.json', 'plants'],
  animals: ['animals.json', 'animals'],
  livestock: ['livestock.json', 'livestock'],
  furniture: ['furniture.json', 'furniture'],
  factions: ['factions.json', 'factions'],
  biomes: ['biomes.json', 'biomes'],
  quests: ['quests.json', 'quests'],
  needs: ['needs.json', 'needs'],
  storytellers: ['storytellers.json', 'storytellers'],
  challenges: ['challenges.json', 'challenges'],
};

function defaultState() {
  const tables = {};
  TABLE_KEYS.forEach(k => { tables[k] = []; });
  const names = {};
  NAME_LISTS.forEach(n => { names[n.key] = []; });
  return {
    info: { id: '', name: '', author: '', version: '1.0', desc: '' },
    tables,
    names,
    textures: [], // { id, fileName, path, dataUrl, size }
  };
}

let state = defaultState();
let storageAvailable = true;

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const fresh = defaultState();
    state = {
      info: { ...fresh.info, ...(parsed.info || {}) },
      tables: { ...fresh.tables, ...(parsed.tables || {}) },
      names: { ...fresh.names, ...(parsed.names || {}) },
      textures: Array.isArray(parsed.textures) ? parsed.textures : [],
    };
  } catch (e) {
    console.warn('Не удалось прочитать сохранённый проект:', e);
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    storageAvailable = true;
  } catch (e) {
    storageAvailable = false;
    console.warn('Не удалось сохранить проект в localStorage (возможно, превышен лимит из-за текстур):', e);
  }
  refreshCounts();
}

function refreshCounts() {
  TABLE_KEYS.forEach(k => {
    qsa(`[data-count-for="${k}"]`).forEach(b => { b.textContent = state.tables[k].length; });
  });
  qsa('[data-count-for="textures"]').forEach(b => { b.textContent = state.textures.length; });
}

// ============================================================ ВКЛАДКИ

function initTabs() {
  qsa('.rail-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      qsa('.rail-tab').forEach(b => b.classList.remove('is-active'));
      qsa('.panel').forEach(p => p.classList.remove('is-active'));
      btn.classList.add('is-active');
      qs(`#tab-${btn.dataset.tab}`).classList.add('is-active');
      if (btn.dataset.tab === 'export') renderExportTab();
    });
  });
}

// ============================================================ ПОЛЯ ФОРМ

/**
 * Виджет для поля «Открывает ключи» технологии: тип + id/имя (+материал для
 * weaponfam) → правильно собранный ключ доступа, без ручного набора синтаксиса.
 * Хранит значение в скрытом input[name=unlocks], которое читают обычные
 * readFieldFromForm/writeFieldToForm (как у типа 'list').
 */
function buildUnlocksWidget(controlId, field) {
  const box = el('div', { class: 'unlocks-widget' });
  const hidden = el('input', { type: 'hidden', id: controlId, name: field.name });
  let keys = [];

  const chipRow = el('div', { class: 'chip-row' });
  function syncHidden() { hidden.value = keys.join(', '); }
  function renderChips() {
    chipRow.innerHTML = '';
    if (!keys.length) { chipRow.appendChild(el('span', { class: 'empty-hint-inline' }, 'пока ничего не открывает')); return; }
    keys.forEach((k, i) => {
      const chip = el('span', { class: 'chip' }, [k, el('button', { type: 'button', class: 'chip-x', 'aria-label': 'Удалить' }, '×')]);
      chip.querySelector('.chip-x').addEventListener('click', () => { keys.splice(i, 1); syncHidden(); renderChips(); });
      chipRow.appendChild(chip);
    });
  }
  hidden.__setKeys = (arr) => { keys = Array.isArray(arr) ? arr.slice() : []; syncHidden(); renderChips(); };
  hidden.__getKeys = () => keys.slice();
  renderChips();

  const typeSelect = el('select', {});
  UNLOCK_TYPES.forEach(t => typeSelect.appendChild(el('option', { value: t.value }, t.label)));

  const idInput = el('input', { type: 'text', placeholder: UNLOCK_TYPES[0].placeholder });
  const idListId = `${controlId}-idlist`;
  const idList = el('datalist', { id: idListId });
  idInput.setAttribute('list', idListId);

  const matInput = el('input', { type: 'text', placeholder: 'iron / wood / steel…', hidden: true });
  const matListId = `${controlId}-matlist`;
  const matList = el('datalist', { id: matListId });
  matInput.setAttribute('list', matListId);

  function refreshSuggestions() {
    const meta = UNLOCK_TYPES.find(t => t.value === typeSelect.value) || UNLOCK_TYPES[0];
    idInput.placeholder = meta.placeholder;
    matInput.hidden = !meta.needsMaterial;

    let ids = [];
    if (meta.value === 'weapon') ids = state.tables.weapons.filter(w => !w.family).map(w => w.id);
    else if (meta.value === 'weaponfam') ids = state.tables.weapons.filter(w => w.family).map(w => w.id);
    else if (meta.value === 'apparel') ids = state.tables.apparel.map(a => a.id);
    else if (meta.value === 'building') ids = state.tables.buildings.map(b => b.kind);
    else if (meta.value === 'recipe') ids = state.tables.recipes.map(r => r.id);
    else if (meta.suggestions) ids = meta.suggestions;
    idList.innerHTML = '';
    ids.filter(Boolean).forEach(v => idList.appendChild(el('option', { value: v })));

    matList.innerHTML = '';
    state.tables.materials.map(m => m.key).filter(Boolean).forEach(v => matList.appendChild(el('option', { value: v })));
  }
  typeSelect.addEventListener('focus', refreshSuggestions);
  typeSelect.addEventListener('change', refreshSuggestions);
  refreshSuggestions();

  const addBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, 'Добавить ключ');
  function addKey() {
    const idVal = idInput.value.trim();
    if (!idVal) return;
    const meta = UNLOCK_TYPES.find(t => t.value === typeSelect.value) || UNLOCK_TYPES[0];
    const key = meta.needsMaterial
      ? `weaponfam:${idVal}@${matInput.value.trim() || 'iron'}`
      : `${meta.value}:${idVal}`;
    if (!keys.includes(key)) keys.push(key);
    syncHidden(); renderChips();
    idInput.value = ''; matInput.value = '';
    idInput.focus();
  }
  addBtn.addEventListener('click', addKey);
  idInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addKey(); } });
  matInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addKey(); } });

  const addRow = el('div', { class: 'unlocks-add-row' }, [typeSelect, idInput, idList, matInput, matList, addBtn]);
  box.appendChild(chipRow);
  box.appendChild(addRow);
  box.appendChild(hidden);
  return box;
}

/** Находит ресурс по id/названию или заводит новый — используется виджетами материалов. */
function resolveOrCreateResourceByName(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return null;
  const existing = state.tables.resources.find(r => r.id === trimmed || r.name === trimmed);
  if (existing) return existing.id;
  const id = idFromName(trimmed, new Set(state.tables.resources.map(r => r.id)), 'pascal');
  state.tables.resources.push({ id, name: trimmed });
  saveState();
  if (sectionRenderers.resources) sectionRenderers.resources();
  return id;
}

/**
 * Выпадающий список материала: готовые ресурсы игры + свои из этого мода +
 * «Новый ресурс» (заводится на месте, без переключения на вкладку «Ресурсы»).
 * name можно не задавать — тогда select не привязан к полю формы напрямую
 * (используется как внутренний пикер в buildMaterialListWidget).
 */
function buildResourcePicker(controlId, name) {
  const box = el('div', { class: 'resource-picker' });
  const select = el('select', { id: controlId, name });
  const newInput = el('input', {
    type: 'text', hidden: true, class: 'resource-new-input',
    placeholder: 'Название нового ресурса — Enter, чтобы добавить',
  });

  function refresh(forceValue) {
    const current = forceValue !== undefined ? forceValue : select.value;
    select.innerHTML = '';
    select.appendChild(el('option', { value: '' }, '— не указано —'));
    RESOURCE_PRESET_GROUPS.forEach(g => {
      const og = el('optgroup', { label: g.label });
      g.items.forEach(v => og.appendChild(el('option', { value: v }, v)));
      select.appendChild(og);
    });
    const own = state.tables.resources.map(r => r.id).filter(Boolean);
    if (own.length) {
      const og = el('optgroup', { label: 'Ваши ресурсы в этом моде' });
      own.forEach(v => og.appendChild(el('option', { value: v }, v)));
      select.appendChild(og);
    }
    select.appendChild(el('option', { value: '__new' }, '+ Новый ресурс…'));
    // Значение может быть не из пресетов и ещё не заведено на вкладке
    // «Ресурсы» — например, у мода, импортированного из чужого .zip. Раньше
    // такое значение молча терялось (select откатывался на «не указано»,
    // а при сохранении формы это стирало исходные данные). Теперь для
    // такого случая добавляем свою временную опцию, чтобы ничего не терялось.
    if (current && current !== '__new' && !Array.from(select.options).some(o => o.value === current)) {
      const custom = el('optgroup', { label: 'Текущее значение (не из списка)' });
      custom.appendChild(el('option', { value: current }, current));
      select.insertBefore(custom, select.querySelector('option[value="__new"]'));
    }
    if (Array.from(select.options).some(o => o.value === current)) select.value = current;
  }
  select.__setValue = (v) => refresh(v || '');

  select.addEventListener('focus', () => refresh());
  select.addEventListener('change', () => {
    if (select.value === '__new') { newInput.hidden = false; newInput.focus(); }
    else { newInput.hidden = true; }
  });

  function confirmNew() {
    const id = resolveOrCreateResourceByName(newInput.value);
    newInput.value = '';
    newInput.hidden = true;
    refresh(id || '');
  }
  newInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); confirmNew(); } });
  newInput.addEventListener('blur', confirmNew);

  refresh();
  box.appendChild(select);
  box.appendChild(newInput);
  return box;
}

/**
 * Список «материал × количество» (для «more»/«extra») — чипы вместо ручного
 * JSON. Хранит значение в hidden input (тот же паттерн, что buildUnlocksWidget).
 */
function buildMaterialListWidget(controlId, name, resKey) {
  // resKey — как называется поле ресурса в этой конкретной таблице:
  // у оружия/одежды это "res", у мебели "resource", у рецептов "type".
  const RES_KEY = resKey || 'res';
  const box = el('div', { class: 'material-list-widget' });
  const hidden = el('input', { type: 'hidden', id: controlId, name });
  let items = [];

  const chipRow = el('div', { class: 'chip-row' });
  function syncHidden() { hidden.value = items.length ? JSON.stringify(items) : ''; }
  function renderChips() {
    chipRow.innerHTML = '';
    if (!items.length) { chipRow.appendChild(el('span', { class: 'empty-hint-inline' }, 'пока нет доп. материалов')); return; }
    items.forEach((it, i) => {
      const chip = el('span', { class: 'chip' }, [
        `${it[RES_KEY]} × ${it.count}`,
        el('button', { type: 'button', class: 'chip-x', 'aria-label': 'Удалить' }, '×'),
      ]);
      chip.querySelector('.chip-x').addEventListener('click', () => { items.splice(i, 1); syncHidden(); renderChips(); });
      chipRow.appendChild(chip);
    });
  }
  hidden.__setItems = (arr) => {
    // при импорте чужого мода ключ может быть любым из трёх — приводим к своему
    items = Array.isArray(arr)
      ? arr.map(x => {
          const res = x && (x[RES_KEY] ?? x.res ?? x.resource ?? x.type);
          return res ? { [RES_KEY]: res, count: Number(x.count) || 1 } : null;
        }).filter(Boolean)
      : [];
    syncHidden(); renderChips();
  };
  renderChips();

  const picker = buildResourcePicker(`${controlId}-pick`);
  const pickerSelect = picker.querySelector('select');
  const countInput = el('input', { type: 'number', min: 1, step: 1, value: '1', class: 'material-count-input' });
  const addBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, 'Добавить материал');
  addBtn.addEventListener('click', () => {
    const res = pickerSelect.value;
    if (!res || res === '__new') { alert('Выберите материал (или заведите новый ресурс и подтвердите Enter/уходом из поля).'); return; }
    const count = Math.max(1, Number(countInput.value) || 1);
    items.push({ [RES_KEY]: res, count });
    syncHidden(); renderChips();
    countInput.value = '1';
  });

  box.appendChild(chipRow);
  box.appendChild(el('div', { class: 'material-add-row' }, [picker, countInput, addBtn]));
  box.appendChild(hidden);
  return box;
}

function buildFieldControl(field, formId) {
  const controlId = `f-${formId}-${field.name}`;
  const wrap = el('div', { class: 'field' + (field.wide ? ' field-wide' : '') });

  if (field.type === 'checkbox') {
    const input = el('input', { type: 'checkbox', id: controlId, name: field.name });
    const label = el('label', { class: 'checkbox-field', for: controlId }, [input, ` ${field.label}`]);
    wrap.appendChild(label);
    if (field.hint) wrap.appendChild(el('p', { class: 'field-hint' }, field.hint));
    return wrap;
  }

  wrap.appendChild(el('label', { for: controlId }, field.label + (field.required ? ' *' : '')));

  let input;
  if (field.type === 'select') {
    input = el('select', { id: controlId, name: field.name });
    field.options.forEach(opt => {
      input.appendChild(el('option', { value: opt.value }, opt.label));
    });
  } else if (field.type === 'textarea') {
    input = el('textarea', { id: controlId, name: field.name, rows: 3, placeholder: field.placeholder || '' });
  } else if (field.type === 'json') {
    input = el('textarea', {
      id: controlId, name: field.name, rows: 3, class: 'mono',
      placeholder: field.placeholder || '',
    });
  } else if (field.type === 'color') {
    const text = el('input', {
      type: 'text', id: controlId, name: field.name, placeholder: '#7A5A38', class: 'color-text',
    });
    const swatch = el('input', { type: 'color', class: 'color-swatch', value: '#888888' });
    swatch.addEventListener('input', () => { text.value = swatch.value; });
    const row = el('div', { class: 'color-row' }, [text, swatch]);
    wrap.appendChild(row);
    if (field.hint) wrap.appendChild(el('p', { class: 'field-hint' }, field.hint));
    return wrap;
  } else if (field.type === 'unlocks') {
    wrap.appendChild(buildUnlocksWidget(controlId, field));
    if (field.hint) wrap.appendChild(el('p', { class: 'field-hint' }, field.hint));
    return wrap;
  } else if (field.type === 'resource') {
    wrap.appendChild(buildResourcePicker(controlId, field.name));
    if (field.hint) wrap.appendChild(el('p', { class: 'field-hint' }, field.hint));
    return wrap;
  } else if (field.type === 'materialList') {
    wrap.appendChild(buildMaterialListWidget(controlId, field.name, field.resKey));
    if (field.hint) wrap.appendChild(el('p', { class: 'field-hint' }, field.hint));
    return wrap;
  } else if (field.type === 'number') {
    input = el('input', {
      type: 'number', id: controlId, name: field.name,
      step: field.step || 'any', min: field.min, max: field.max,
      placeholder: field.placeholder || '',
    });
  } else {
    input = el('input', { type: 'text', id: controlId, name: field.name, placeholder: field.placeholder || '' });
  }

  wrap.appendChild(input);
  if (field.hint) wrap.appendChild(el('p', { class: 'field-hint' }, field.hint));
  return wrap;
}

function readFieldFromForm(field, formEl) {
  const input = formEl.elements[field.name];
  if (field.type === 'checkbox') return input.checked ? true : undefined;

  const raw = (input.value || '').trim();

  switch (field.type) {
    case 'number': {
      if (raw === '') return undefined;
      const n = Number(raw);
      if (Number.isNaN(n)) throw new FieldError(field, 'должно быть числом');
      return n;
    }
    case 'select': {
      if (raw === '') return undefined;
      return field.numeric ? Number(raw) : raw;
    }
    case 'resource': {
      // '__new' — значит выбрали «+ Новый ресурс…», но не подтвердили имя
      // (Enter/уход из поля) до отправки формы. Раньше это сохранялось
      // буквальной строкой "__new" прямо в JSON мода — считаем это пустым.
      if (raw === '' || raw === '__new') return undefined;
      return raw;
    }
    case 'json':
    case 'materialList': {
      if (raw === '') return undefined;
      try { return JSON.parse(raw); }
      catch (e) { throw new FieldError(field, 'некорректный JSON — ' + e.message); }
    }
    case 'list':
    case 'unlocks': {
      const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
      return parts.length ? parts : undefined;
    }
    default:
      return raw === '' ? undefined : raw;
  }
}

function writeFieldToForm(field, formEl, value) {
  const input = formEl.elements[field.name];
  if (field.type === 'checkbox') { input.checked = !!value; return; }
  if (field.type === 'unlocks') { input.__setKeys ? input.__setKeys(value) : (input.value = Array.isArray(value) ? value.join(', ') : ''); return; }
  if (field.type === 'materialList') { input.__setItems ? input.__setItems(value) : (input.value = value ? JSON.stringify(value) : ''); return; }
  if (field.type === 'resource') { input.__setValue ? input.__setValue(value) : (input.value = value || ''); return; }
  if (value === undefined || value === null) { input.value = ''; return; }
  if (field.type === 'json') { input.value = JSON.stringify(value, null, 1); return; }
  if (field.type === 'list') { input.value = Array.isArray(value) ? value.join(', ') : String(value); return; }
  input.value = value;
}

// ================================================== УНИВЕРСАЛЬНАЯ СЕКЦИЯ

const sectionEditState = {}; // schemaKey -> editing index or null
const sectionRenderers = {}; // schemaKey -> function that redraws its card list

/** Добавляет черновую строку перевода, если такой русской строки ещё нет. */
function ensureLocDraft(ruText) {
  if (!ruText) return;
  if (state.tables.loc.some(r => r.ru === ruText)) return;
  state.tables.loc.push({ ru: ruText, en: guessTranslation(ruText) });
  if (sectionRenderers.loc) sectionRenderers.loc();
}

/** Блок «Открыть в технологиях» — общий для оружия/одежды/рецептов. */
function buildTechLinkBox() {
  const box = el('div', { class: 'tech-link-box' });
  box.appendChild(el('h3', {}, '⚙ Открыть в технологиях'));
  box.appendChild(el('p', { class: 'field-hint' }, 'Без этого запись останется в таблице, но её нигде нельзя будет сделать в игре — ключ доступа впишется автоматически.'));

  const select = el('select', {});
  const newFields = el('div', { class: 'tech-link-new field-grid', hidden: true });
  const nameInput = el('input', { type: 'text', placeholder: 'Название технологии' });
  const branchInput = el('input', { type: 'text', placeholder: 'Ремёсла', value: 'Ремёсла' });
  const eraInput = el('input', { type: 'number', value: '1', min: 1, max: 5, step: 1 });
  const costInput = el('input', { type: 'number', value: '100', step: 1 });
  [
    ['Название', nameInput], ['Ветка', branchInput], ['Эпоха (1–5)', eraInput], ['Стоимость', costInput],
  ].forEach(([label, input]) => {
    newFields.appendChild(el('div', { class: 'field' }, [el('label', {}, label), input]));
  });

  function refreshOptions() {
    const current = select.value;
    select.innerHTML = '';
    select.appendChild(el('option', { value: '__none' }, 'Не привязывать — открою вручную'));
    select.appendChild(el('option', { value: '__new' }, '+ Создать новую технологию'));
    state.tables.techs.forEach(t => {
      select.appendChild(el('option', { value: t.id }, `${t.name || t.id} (${t.id})`));
    });
    if (Array.from(select.options).some(o => o.value === current)) select.value = current;
  }
  select.addEventListener('focus', refreshOptions);
  select.addEventListener('change', () => { newFields.hidden = select.value !== '__new'; });
  refreshOptions();

  box.appendChild(select);
  box.appendChild(newFields);

  return {
    box,
    refreshOptions,
    reset() {
      select.value = '__none';
      newFields.hidden = true;
      nameInput.value = ''; branchInput.value = 'Ремёсла'; eraInput.value = '1'; costInput.value = '100';
    },
    getChoice() {
      if (select.value === '__none') return { mode: 'none' };
      if (select.value === '__new') {
        return {
          mode: 'new',
          name: nameInput.value.trim(), branch: branchInput.value.trim(),
          era: eraInput.value, cost: costInput.value,
        };
      }
      return { mode: 'existing', techId: select.value };
    },
  };
}

/** Дописывает ключ(и) доступа новой записи в выбранную/новую технологию. */
function applyTechLink(schemaKey, item, choice) {
  const schema = SCHEMAS[schemaKey];
  if (!schema.techLink || !choice || choice.mode === 'none') return;
  const keys = schema.techLink(item, state.tables.materials);
  if (!keys.length) return;

  if (choice.mode === 'existing') {
    const tech = state.tables.techs.find(t => t.id === choice.techId);
    if (!tech) return;
    tech.unlocks = Array.from(new Set([...(tech.unlocks || []), ...keys]));
    return;
  }

  const existingIds = new Set(state.tables.techs.map(t => t.id));
  let id = slugify(item.id || item.name) + '_tech';
  let n = 1;
  while (existingIds.has(id)) id = slugify(item.id || item.name) + '_tech' + (++n);
  state.tables.techs.push({
    id,
    name: choice.name || `Технология: ${item.name || item.id}`,
    branch: choice.branch || 'Ремёсла',
    era: choice.era ? Number(choice.era) : 1,
    cost: choice.cost ? Number(choice.cost) : 100,
    unlocks: keys,
  });
}

function initSchemaSection(schemaKey) {
  const schema = SCHEMAS[schemaKey];
  const formMount = qs(`.form-mount[data-schema="${schemaKey}"]`);
  const tableMount = qs(`.table-mount[data-schema="${schemaKey}"]`);
  if (!formMount || !tableMount) return;

  sectionEditState[schemaKey] = null;

  const form = el('form', { class: 'entry-form' });
  const grid = el('div', { class: 'field-grid' });
  schema.fields.forEach(f => grid.appendChild(buildFieldControl(f, schemaKey)));
  form.appendChild(grid);

  // --- Шаблон характеристик (только для оружия) ------------------------
  if (schemaKey === 'weapons') {
    const tplField = el('div', { class: 'field field-wide' });
    tplField.appendChild(el('label', {}, 'Шаблон (заполнит характеристики — можно поправить или очистить)'));
    const tplSelect = el('select', {});
    WEAPON_TEMPLATE_OPTIONS.forEach(o => tplSelect.appendChild(el('option', { value: o.value }, o.label)));
    tplSelect.addEventListener('change', () => {
      const tpl = WEAPON_TEMPLATES[tplSelect.value];
      if (!tpl) return;
      schema.fields.forEach(f => {
        if (tpl[f.name] === undefined) return;
        if (f.type === 'checkbox') { form.elements[f.name].checked = tpl[f.name]; return; }
        if ((form.elements[f.name].value || '').trim() !== '') return; // не затираем то, что уже вписали
        writeFieldToForm(f, form, tpl[f.name]);
      });
    });
    tplField.appendChild(tplSelect);
    tplField.appendChild(el('p', { class: 'field-hint' }, 'Черновые значения для старта, не игровой баланс — смело меняйте.'));
    grid.insertBefore(tplField, grid.firstChild);
  }

  // --- Автономер «look» по занятому слоту (только для одежды) ----------
  if (schemaKey === 'apparel') {
    const slotEl = form.elements['slot'];
    const lookEl = form.elements['look'];
    if (slotEl && lookEl) {
      slotEl.addEventListener('change', () => {
        if ((lookEl.value || '').trim() !== '') return;
        lookEl.value = nextFreeLook(slotEl.value || 'Torso');
      });
    }
  }


  // --- Автопривязка к технологиям (оружие / одежда / рецепты) ----------
  const techUI = schema.techLink ? buildTechLinkBox() : null;
  if (techUI) form.appendChild(techUI.box);

  const errorBox = el('p', { class: 'form-error', hidden: true });
  form.appendChild(errorBox);

  const actions = el('div', { class: 'form-actions' });
  const submitBtn = el('button', { type: 'submit', class: 'btn btn-primary' }, `Добавить ${schema.title}`);
  const cancelBtn = el('button', { type: 'button', class: 'btn btn-ghost', hidden: true }, 'Отменить редактирование');
  actions.appendChild(submitBtn);
  actions.appendChild(cancelBtn);
  form.appendChild(actions);

  function resetCustomWidgets() {
    schema.fields.forEach(f => {
      const inp = form.elements[f.name];
      if (!inp) return;
      if (f.type === 'unlocks' && inp.__setKeys) inp.__setKeys([]);
      if (f.type === 'materialList' && inp.__setItems) inp.__setItems([]);
      if (f.type === 'resource' && inp.__setValue) inp.__setValue(''); // убирает временную опцию «Текущее значение»
    });
  }

  cancelBtn.addEventListener('click', () => {
    form.reset();
    resetCustomWidgets();
    if (techUI) techUI.reset();
    sectionEditState[schemaKey] = null;
    submitBtn.textContent = `Добавить ${schema.title}`;
    cancelBtn.hidden = true;
    errorBox.hidden = true;
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    errorBox.hidden = true;
    // При редактировании стартуем с копии старой записи — так поля, которых
    // нет в этой форме (например, из импортированного стороннего мода),
    // не потеряются молча.
    const editIdxAtStart = sectionEditState[schemaKey];
    const item = editIdxAtStart !== null ? { ...state.tables[schemaKey][editIdxAtStart] } : {};
    try {
      schema.fields.forEach(f => {
        const v = readFieldFromForm(f, form);
        if (v !== undefined) item[f.name] = v; else delete item[f.name];
      });
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
      return;
    }
    const missing = schema.fields.find(f => f.required && (item[f.name] === undefined || item[f.name] === ''));
    if (missing) {
      errorBox.textContent = `Поле «${missing.label}» обязательно.`;
      errorBox.hidden = false;
      return;
    }

    // Пустой id — сгенерируем сами из названия, чтобы не заставлять его придумывать.
    if (schema.idFrom && !item.id && item[schema.idFrom]) {
      const existingIds = new Set(state.tables[schemaKey]
        .map((it, i) => (i === sectionEditState[schemaKey] ? null : it[schema.keyField]))
        .filter(Boolean));
      item.id = idFromName(item[schema.idFrom], existingIds, schema.idCase);
    }
    applyBaselineDefaults(schemaKey, item);

    const techChoice = techUI ? techUI.getChoice() : null;

    const list = state.tables[schemaKey];
    const editIdx = sectionEditState[schemaKey];
    if (editIdx === null) {
      list.push(item);
    } else {
      list[editIdx] = item;
      sectionEditState[schemaKey] = null;
      submitBtn.textContent = `Добавить ${schema.title}`;
      cancelBtn.hidden = true;
    }
    applyTechLink(schemaKey, item, techChoice);
    if (item.name) ensureLocDraft(item.name);
    form.reset();
    resetCustomWidgets();
    if (techUI) techUI.reset();
    saveState();
    renderList();
    if (techUI) techUI.refreshOptions();
  });

  formMount.appendChild(form);

  function renderList() {
    tableMount.innerHTML = '';
    const list = state.tables[schemaKey];
    if (!list.length) {
      tableMount.appendChild(el('p', { class: 'empty-hint' }, 'Пока пусто — заполните форму выше и нажмите «Добавить».'));
      return;
    }
    const wrap = el('div', { class: 'card-list' });
    list.forEach((item, idx) => {
      const details = el('pre', { class: 'card-json mono', hidden: true }, JSON.stringify(item, null, 2));
      const toggle = el('button', { type: 'button', class: 'btn-link' }, 'детали');
      toggle.addEventListener('click', () => { details.hidden = !details.hidden; });

      const editBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, 'Изменить');
      editBtn.addEventListener('click', () => {
        schema.fields.forEach(f => writeFieldToForm(f, form, item[f.name]));
        sectionEditState[schemaKey] = idx;
        submitBtn.textContent = `Сохранить изменения`;
        cancelBtn.hidden = false;
        formMount.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });

      const delBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-danger-text' }, 'Удалить');
      delBtn.addEventListener('click', () => {
        if (!confirm(`Удалить «${schema.itemLabel(item)}»?`)) return;
        list.splice(idx, 1);
        saveState();
        renderList();
      });

      const card = el('div', { class: 'card' }, [
        el('div', { class: 'card-row' }, [
          el('span', { class: 'card-title' }, schema.itemLabel(item)),
          el('div', { class: 'card-actions' }, [toggle, editBtn, delBtn]),
        ]),
        details,
      ]);
      wrap.appendChild(card);
    });
    tableMount.appendChild(wrap);
  }

  sectionRenderers[schemaKey] = renderList;
  renderList();
  refreshCounts();
}

// ============================================================ ФОРМА МОДА

const INFO_FIELDS = [
  { name: 'id', label: 'id мода (ключ, уникальный)', type: 'text', required: true, placeholder: 'steppe_pack' },
  { name: 'name', label: 'Название', type: 'text', required: true, placeholder: 'Степной набор' },
  { name: 'author', label: 'Автор', type: 'text', placeholder: 'ваше имя' },
  { name: 'version', label: 'Версия', type: 'text', placeholder: '1.0' },
  { name: 'desc', label: 'Описание', type: 'textarea', wide: true, placeholder: 'Кылыш, степной кафтан и мифрил.' },
];

function initInfoForm() {
  const mount = qs('#infoForm');
  const form = el('form', { class: 'entry-form field-grid' });
  INFO_FIELDS.forEach(f => form.appendChild(buildFieldControl(f, 'info')));
  mount.appendChild(form);

  INFO_FIELDS.forEach(f => {
    const input = form.elements[f.name];
    input.value = state.info[f.name] || '';
    input.addEventListener('input', () => {
      state.info[f.name] = input.value; // храним и пустые — это черновик, не финальный экспорт
      saveState();
    });
  });
}

// ============================================================ СПИСКИ ИМЁН

function initNameLists() {
  const mount = qs('#nameListsForm');
  NAME_LISTS.forEach(({ key, label }) => {
    const box = el('div', { class: 'namelist-box' });
    box.appendChild(el('h3', {}, label));

    const chipRow = el('div', { class: 'chip-row' });
    box.appendChild(chipRow);

    const addRow = el('div', { class: 'chip-add-row' });
    const input = el('input', { type: 'text', placeholder: 'Добавить и нажать Enter' });
    const addBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, 'Добавить');
    addRow.appendChild(input);
    addRow.appendChild(addBtn);
    box.appendChild(addRow);

    function renderChips() {
      chipRow.innerHTML = '';
      state.names[key].forEach((val, idx) => {
        const chip = el('span', { class: 'chip' }, [
          val,
          el('button', { type: 'button', class: 'chip-x', 'aria-label': 'Удалить' }, '×'),
        ]);
        chip.querySelector('.chip-x').addEventListener('click', () => {
          state.names[key].splice(idx, 1);
          saveState();
          renderChips();
        });
        chipRow.appendChild(chip);
      });
      if (!state.names[key].length) {
        chipRow.appendChild(el('span', { class: 'empty-hint-inline' }, 'пока пусто'));
      }
    }

    function addValue() {
      const v = input.value.trim();
      if (!v) return;
      state.names[key].push(v);
      input.value = '';
      saveState();
      renderChips();
    }
    addBtn.addEventListener('click', addValue);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addValue(); }
    });

    renderChips();
    mount.appendChild(box);
  });
}

// ============================================================== ТЕКСТУРЫ

const TEXTURE_CATEGORIES = [
  { key: 'weapon', label: 'Оружие' },
  { key: 'apparel', label: 'Одежда / облик' },
  { key: 'resource', label: 'Ресурс на земле' },
  { key: 'other', label: 'Другое' },
];

function initTextures() {
  const catRow = qs('#texCatRow');
  const body = qs('#texCatBody');
  const tableMount = qs('.table-mount[data-schema="textures"]');
  let activeCat = 'weapon';

  function addTexture(path, file, dataUrl) {
    state.textures.push({ id: uid(), fileName: file.name, path, dataUrl, size: file.size });
    saveState();
    renderTextures();
  }

  /** Читает все выбранные в input файлы и добавляет их по пути из pathFn(file). */
  function readAndAdd(fileInput, pathFn) {
    if (!fileInput.files.length) return;
    Array.from(fileInput.files).forEach(file => {
      const reader = new FileReader();
      reader.onload = () => {
        const path = pathFn(file);
        if (path) addTexture(path, file, reader.result);
      };
      reader.readAsDataURL(file);
    });
    fileInput.value = '';
  }

  function fileButton(label, onPick, opts = {}) {
    const fileInput = el('input', Object.assign({ type: 'file', accept: 'image/png', hidden: true }, opts.inputAttrs || {}));
    fileInput.addEventListener('change', () => onPick(fileInput));
    const cls = 'btn file-btn ' + (opts.labelClass || 'btn-primary');
    return el('label', { class: cls }, [label, fileInput]);
  }

  function renderCatRow() {
    catRow.innerHTML = '';
    TEXTURE_CATEGORIES.forEach(c => {
      const btn = el('button', { type: 'button', class: 'tex-cat-btn' + (c.key === activeCat ? ' is-active' : '') }, c.label);
      btn.addEventListener('click', () => { activeCat = c.key; renderCatRow(); renderBody(); });
      catRow.appendChild(btn);
    });
  }

  function renderBody() {
    body.innerHTML = '';

    if (activeCat === 'weapon') {
      body.appendChild(el('p', { class: 'tex-hint' },
        'Картинка в руке. Рисуйте горизонтально, остриём вправо — вертикальный клинок игра сама повернёт на -90°.'));

      const select = el('select', {});
      select.appendChild(el('option', { value: '' }, '— выбрать оружие из списка —'));
      state.tables.weapons.forEach(w => select.appendChild(el('option', { value: w.id }, `${w.name || w.id} (${w.id})`)));
      select.appendChild(el('option', { value: '__custom' }, '+ своё название — оружия ещё нет в списке'));
      const customInput = el('input', { type: 'text', placeholder: 'Название или id, например Кылыш', hidden: true });
      select.addEventListener('change', () => { customInput.hidden = select.value !== '__custom'; });

      const btn = fileButton('Загрузить PNG', (fileInput) => {
        let id = select.value;
        if (id === '__custom' || !id) {
          const name = customInput.value.trim();
          if (!name) { alert('Впишите название оружия или выберите его из списка.'); fileInput.value = ''; return; }
          id = idFromName(name, new Set(state.tables.weapons.map(w => w.id)), 'snake');
        }
        readAndAdd(fileInput, () => `Guns/${id}/${id}-right.png`);
      });

      body.appendChild(el('div', { class: 'tex-pick-row' }, [select, customInput, btn]));
      body.appendChild(el('p', { class: 'field-hint' }, 'Путь: Guns/<id>/<id>-right.png — соберётся сам.'));

    } else if (activeCat === 'apparel') {
      body.appendChild(el('p', { class: 'tex-hint' },
        'До 5 файлов на вариант: спереди обязательно, остальные — по возможности. Номера look у игры идут подряд без пропусков.'));

      const select = el('select', {});
      select.appendChild(el('option', { value: '' }, '— выбрать одежду из списка —'));
      state.tables.apparel.forEach(a => select.appendChild(el('option', { value: a.id }, `${a.name || a.id} (${a.id})`)));
      select.appendChild(el('option', { value: '__custom' }, '+ своя — ещё не добавлена на вкладке «Одежда»'));
      body.appendChild(el('div', { class: 'tex-pick-row' }, [select]));

      const slotSelect = el('select', {});
      ['Head', 'Torso', 'TorsoOver', 'Legs', 'ArmorOver'].forEach(s => slotSelect.appendChild(el('option', { value: s }, s)));
      const lookInput = el('input', { type: 'number', step: 1, min: 0, placeholder: 'look' });
      slotSelect.addEventListener('change', () => { lookInput.value = nextFreeLook(slotSelect.value); });
      const customRow = el('div', { class: 'tex-pick-row', hidden: true }, [
        el('span', { class: 'tex-pick-label' }, 'Слот:'), slotSelect,
        el('span', { class: 'tex-pick-label' }, 'look:'), lookInput,
      ]);
      body.appendChild(customRow);
      select.addEventListener('change', () => {
        customRow.hidden = select.value !== '__custom';
        if (select.value === '__custom' && lookInput.value === '') slotSelect.dispatchEvent(new Event('change'));
      });

      function resolveSlotLook() {
        if (select.value === '__custom') {
          const slot = slotSelect.value || 'Torso';
          const look = lookInput.value !== '' ? Number(lookInput.value) : nextFreeLook(slot);
          return { slot, look };
        }
        if (select.value) {
          const item = state.tables.apparel.find(a => a.id === select.value);
          if (!item) return null;
          const slot = item.slot || 'Torso';
          return { slot, look: item.look !== undefined ? item.look : nextFreeLook(slot) };
        }
        return null;
      }

      const viewGrid = el('div', { class: 'tex-view-grid' });
      APPAREL_VIEWS.forEach(v => {
        viewGrid.appendChild(fileButton(v.hint ? `${v.label} (${v.hint})` : v.label, (fileInput) => {
          const resolved = resolveSlotLook();
          if (!resolved) { alert('Сначала выберите одежду или впишите слот и look.'); fileInput.value = ''; return; }
          const folder = TEXTURE_SLOT_FOLDERS[resolved.slot] || 'top';
          readAndAdd(fileInput, () => `char/${folder}/${resolved.look}_${v.key}.png`);
        }, { labelClass: 'btn-ghost btn-sm' }));
      });
      body.appendChild(viewGrid);
      body.appendChild(el('p', { class: 'field-hint' }, 'Путь: char/<папка слота>/<look>_<вид>.png — например char/hat/3_down.png.'));

    } else if (activeCat === 'resource') {
      body.appendChild(el('p', { class: 'tex-hint' }, 'Картинка предмета на земле и в инвентаре.'));

      const select = el('select', {});
      select.appendChild(el('option', { value: '' }, '— выбрать ресурс из списка —'));
      state.tables.resources.forEach(r => select.appendChild(el('option', { value: r.id }, `${r.name || r.id} (${r.id})`)));
      select.appendChild(el('option', { value: '__custom' }, '+ своё название — ресурса ещё нет в списке'));
      const customInput = el('input', { type: 'text', placeholder: 'Название или id, например Mithril', hidden: true });
      select.addEventListener('change', () => { customInput.hidden = select.value !== '__custom'; });

      const btn = fileButton('Загрузить PNG', (fileInput) => {
        let path;
        if (select.value && select.value !== '__custom') {
          const res = state.tables.resources.find(r => r.id === select.value);
          path = res && res.icon ? `${res.icon}.png` : `Items/${select.value}.png`;
        } else {
          const name = customInput.value.trim();
          if (!name) { alert('Впишите название ресурса или выберите его из списка.'); fileInput.value = ''; return; }
          path = `Items/${idFromName(name, new Set(state.tables.resources.map(r => r.id)), 'pascal')}.png`;
        }
        readAndAdd(fileInput, () => path);
      });

      body.appendChild(el('div', { class: 'tex-pick-row' }, [select, customInput, btn]));
      body.appendChild(el('p', { class: 'field-hint' }, 'Путь: Items/<id>.png (или из поля «Путь к картинке» ресурса, если оно заполнено).'));

    } else {
      body.appendChild(el('p', { class: 'tex-hint' },
        'Для всего, что не подходит под другие категории (обломки камня, надгробия и т.п.) — путь впишите вручную в списке файлов ниже.'));
      body.appendChild(fileButton('Выбрать PNG-файлы', (fileInput) => {
        readAndAdd(fileInput, (file) => file.name.replace(/\.png$/i, '') + '.png');
      }, { inputAttrs: { multiple: true } }));
    }
  }

  function renderTextures() {
    tableMount.innerHTML = '';
    if (!state.textures.length) {
      tableMount.appendChild(el('p', { class: 'empty-hint' }, 'Пока не загружено ни одной текстуры.'));
      return;
    }
    const wrap = el('div', { class: 'texture-grid' });
    state.textures.forEach((tex, idx) => {
      const img = el('img', { src: tex.dataUrl, class: 'texture-thumb', alt: tex.fileName });
      const pathInput = el('input', { type: 'text', value: tex.path, class: 'texture-path' });
      pathInput.addEventListener('input', () => {
        tex.path = pathInput.value.trim();
        saveState();
      });

      // Заменить сам файл (не только путь) — например, у мода, загруженного
      // .zip-импортом, где картинка уже не устраивает, но путь верный.
      const replaceInput = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true });
      replaceInput.addEventListener('change', () => {
        const file = replaceInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          tex.dataUrl = reader.result;
          tex.fileName = file.name;
          tex.size = file.size;
          saveState();
          renderTextures();
        };
        reader.readAsDataURL(file);
      });
      const replaceBtn = el('label', { class: 'btn btn-ghost btn-sm file-btn' }, ['Заменить файл', replaceInput]);

      const delBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-danger-text' }, 'Удалить');
      delBtn.addEventListener('click', () => {
        state.textures.splice(idx, 1);
        saveState();
        renderTextures();
      });
      const meta = el('div', { class: 'texture-meta' }, [
        el('div', { class: 'texture-filename' }, tex.fileName),
        el('label', { class: 'texture-path-label' }, [
          'Путь: textures/',
          pathInput,
        ]),
        el('div', { class: 'texture-actions' }, [replaceBtn, delBtn]),
      ]);
      wrap.appendChild(el('div', { class: 'texture-card' }, [img, meta]));
    });
    tableMount.appendChild(wrap);
  }

  renderCatRow();
  renderBody();
  renderTextures();
}

// ================================================================ ЭКСПОРТ

/** Собирает содержимое всех JSON-файлов мода. Возвращает { fileName: object }. */
function buildFilesPayload() {
  const files = {};

  // mod.json
  const info = {};
  INFO_FIELDS.forEach(f => { if (state.info[f.name]) info[f.name] = state.info[f.name]; });
  files['mod.json'] = info;

  // weapons.json (weapons + materials)
  const weaponsPayload = {};
  if (state.tables.weapons.length) weaponsPayload.weapons = state.tables.weapons;
  if (state.tables.materials.length) weaponsPayload.materials = state.tables.materials;
  if (Object.keys(weaponsPayload).length) files['weapons.json'] = weaponsPayload;

  if (state.tables.apparel.length) files['apparel.json'] = { apparel: state.tables.apparel };
  if (state.tables.resources.length) files['resources.json'] = { resources: state.tables.resources };
  if (state.tables.recipes.length) files['recipes.json'] = { recipes: state.tables.recipes };
  if (state.tables.buildings.length) files['buildings.json'] = { buildings: state.tables.buildings };
  if (state.tables.techs.length) files['techs.json'] = { techs: state.tables.techs };

  // Таблицы «Мир и жизнь» — каждая в свой файл, одинаковой формой.
  Object.entries(SIMPLE_TABLE_FILES).forEach(([tableKey, [fileName, listKey]]) => {
    if (state.tables[tableKey] && state.tables[tableKey].length) {
      files[fileName] = { [listKey]: state.tables[tableKey] };
    }
  });

  // info.json — не список, а объект «ключ записи → текст».
  if (state.tables.info.length) {
    const entries = {};
    state.tables.info.forEach(row => { if (row.key) entries[row.key] = row.text || ''; });
    files['info.json'] = { entries };
  }

  // pawns.json
  const pawns = {};
  if (state.tables.traits.length) pawns.traits = state.tables.traits;
  if (state.tables.traitPairs.length) pawns.traitPairs = state.tables.traitPairs;
  if (state.tables.childhoods.length) pawns.childhoods = state.tables.childhoods;
  if (state.tables.adulthoods.length) pawns.adulthoods = state.tables.adulthoods;
  if (state.tables.rareFullfirst.length) pawns.rareFullfirst = state.tables.rareFullfirst;
  NAME_LISTS.forEach(({ key }) => { if (state.names[key].length) pawns[key] = state.names[key]; });
  if (Object.keys(pawns).length) files['pawns.json'] = pawns;

  // loc.json
  if (state.tables.loc.length) {
    const en = {};
    state.tables.loc.forEach(row => { if (row.ru && row.en) en[row.ru] = row.en; });
    files['loc.json'] = { en };
  }

  return files;
}

function validateProject() {
  const problems = [];
  const warnings = [];

  if (!state.info.id) problems.push('Не задан id мода (вкладка «Мод»).');
  if (!state.info.name) problems.push('Не задано название мода (вкладка «Мод»).');

  TABLE_KEYS.forEach(k => {
    const schema = SCHEMAS[k];
    if (!schema || !schema.keyField) return;
    const seen = new Set();
    state.tables[k].forEach(item => {
      const key = String(item[schema.keyField] ?? '');
      if (!key) return;
      if (seen.has(key)) warnings.push(`Повтор ключа «${key}» в таблице «${schema.title}» — вторая запись перезапишет первую.`);
      seen.add(key);
    });
  });

  // Два костюма в одном слоте делят один и тот же номер look — второй
  // перекроет первый на экране, слот один look = одна вещь.
  {
    const bySlot = new Map();
    state.tables.apparel.forEach(a => {
      if (a.look === undefined) return;
      const slotKey = `${a.slot || 'Torso'}#${a.look}`;
      if (!bySlot.has(slotKey)) bySlot.set(slotKey, []);
      bySlot.get(slotKey).push(a);
    });
    bySlot.forEach((items, slotKey) => {
      if (items.length < 2) return;
      const [slot, look] = slotKey.split('#');
      warnings.push(`«${items.map(a => a.name || a.id).join('» и «')}» делят look ${look} в слоте ${slot} — в игре они наложатся друг на друга. Дайте каждому свой номер (например ${Number(look) + 1}).`);
    });
  }

  // Не привязано ни к одной технологии — сделать вещь в игре будет нельзя.
  // Для оружия-семейств (weaponfam) сверяем не точный список материалов
  // (он мог измениться после того, как технологию уже привязали — новый
  // материал добавили позже, или наоборот), а сам факт: есть ли хоть один
  // ключ weaponfam:<id>@... или запасной weapon:<id> у этого оружия.
  const allUnlockKeys = state.tables.techs.flatMap(t => t.unlocks || []);
  ['weapons', 'apparel', 'recipes', 'buildings'].forEach(k => {
    const schema = SCHEMAS[k];
    if (!schema.techLink) return;
    state.tables[k].forEach(item => {
      const keys = schema.techLink(item, state.tables.materials);
      let unlocked = keys.some(key => allUnlockKeys.includes(key));
      if (!unlocked && k === 'weapons' && item.family) {
        unlocked = allUnlockKeys.some(u => u.startsWith(`weaponfam:${item.id}@`)) || allUnlockKeys.includes(`weapon:${item.id}`);
      }
      if (!unlocked) warnings.push(`«${schema.itemLabel(item)}» не открыто ни одной технологией — в игре его нельзя будет сделать.`);
    });
  });

  // Событие: игра требует либо effects, либо ровно два choices.
  state.tables.events.forEach(e => {
    const hasEffects = Array.isArray(e.effects) && e.effects.length;
    const hasChoices = Array.isArray(e.choices) && e.choices.length;
    if (!hasEffects && !hasChoices) {
      warnings.push(`Событие «${e.title || e.id}»: не заданы ни последствия, ни выбор — ничего не произойдёт.`);
    }
    if (hasEffects && hasChoices) {
      warnings.push(`Событие «${e.title || e.id}»: заданы и последствия, и выбор — нужно что-то одно.`);
    }
    if (hasChoices && e.choices.length !== 2) {
      warnings.push(`Событие «${e.title || e.id}»: вариантов выбора ${e.choices.length}, а игра ждёт ровно 2 — иначе событие будет пропущено.`);
    }
  });

  // Мебель без основы — это просто декор; предупреждаем, если задали вариант основы без самой основы.
  state.tables.furniture.forEach(f => {
    if (f.variant && !f.base) {
      warnings.push(`Мебель «${f.name || f.id}»: задан вариант основы, но не выбрана сама основа — вариант будет проигнорирован.`);
    }
  });

  // Рецепт без результата — станок не будет знать, что выдавать.
  state.tables.recipes.forEach(r => {
    if (!r.outType) warnings.push(`Рецепт «${r.name || r.id}» без поля «Результат: тип» — станок не поймёт, что производить.`);
  });

  // Защита от старого бага: значение "__new" могло сохраниться в поле-материале,
  // если выбрали «+ Новый ресурс…» и отправили форму, не подтвердив имя. Если
  // такое найдётся в данных, сохранённых ещё до исправления — подсветим явно.
  TABLE_KEYS.forEach(k => {
    state.tables[k].forEach(item => {
      Object.entries(item).forEach(([fieldName, v]) => {
        if (v === '__new') warnings.push(`«${SCHEMAS[k].itemLabel(item)}»: поле «${fieldName}» содержит служебное значение "__new" вместо материала — откройте запись, перевыберите материал и сохраните заново.`);
      });
    });
  });

  // Черновые переводы, которые ещё не поправили руками.
  state.tables.loc.forEach(row => {
    if (row.ru && row.en && row.en === guessTranslation(row.ru) && /[a-z]/i.test(row.en)) {
      warnings.push(`Перевод «${row.ru} → ${row.en}» — черновой (получен транслитерацией), стоит проверить.`);
    }
  });

  const usedPaths = new Set();
  state.textures.forEach(t => {
    if (!t.path) { warnings.push(`У файла «${t.fileName}» не задан путь — он не попадёт в архив.`); return; }
    if (usedPaths.has(t.path)) warnings.push(`Два файла указывают один и тот же путь textures/${t.path}.`);
    usedPaths.add(t.path);
  });

  const filesPayload = buildFilesPayload();
  if (Object.keys(filesPayload).length <= 1 && !state.textures.length) {
    warnings.push('Пока не заполнено ни одной таблицы — мод будет пустым (кроме mod.json).');
  }

  return { problems, warnings };
}

function renderExportTab() {
  const summary = qs('#exportSummary');
  summary.innerHTML = '';
  const counts = TABLE_KEYS.map(k => `${SCHEMAS[k].title}: ${state.tables[k].length}`).join(' · ');
  summary.appendChild(el('p', {}, `${counts} · текстур: ${state.textures.length}`));
  if (!storageAvailable) {
    summary.appendChild(el('p', { class: 'warn-line' },
      'Внимание: браузер не смог сохранить проект локально (обычно из-за размера текстур). Пока вкладка открыта — данные целы; сохраните проект кнопкой «Сохранить проект» слева, чтобы не потерять работу.'));
  }
  renderPreview();
}

function renderPreview() {
  const tabsMount = qs('#previewTabs');
  const codeMount = qs('#previewCode');
  tabsMount.innerHTML = '';
  const files = buildFilesPayload();
  const names = Object.keys(files);
  if (!names.length) {
    codeMount.textContent = 'Пока нечего показывать — заполните хотя бы одну таблицу.';
    return;
  }
  names.forEach((name, i) => {
    const btn = el('button', { type: 'button', class: 'preview-tab' + (i === 0 ? ' is-active' : '') }, name);
    btn.addEventListener('click', () => {
      qsa('.preview-tab', tabsMount).forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      codeMount.textContent = JSON.stringify(files[name], null, 2);
    });
    tabsMount.appendChild(btn);
  });
  codeMount.textContent = JSON.stringify(files[names[0]], null, 2);
}

function showExportLog(lines, kind) {
  const box = qs('#exportLog');
  box.hidden = false;
  box.className = 'export-log' + (kind ? ` export-log-${kind}` : '');
  box.innerHTML = '';
  lines.forEach(l => box.appendChild(el('p', {}, l)));
}

async function exportZip() {
  const { problems, warnings } = validateProject();
  if (problems.length) {
    showExportLog(['Нельзя собрать архив:', ...problems.map(p => '· ' + p)], 'error');
    return;
  }

  const folderName = slugify(state.info.id);
  const zip = new JSZip();
  const root = zip.folder(folderName);

  const files = buildFilesPayload();
  Object.entries(files).forEach(([name, payload]) => {
    root.file(name, JSON.stringify(payload, null, 2));
  });

  let texCount = 0;
  state.textures.forEach(tex => {
    if (!tex.path) return;
    const base64 = tex.dataUrl.split(',')[1];
    root.file(`textures/${tex.path}`, base64, { base64: true });
    texCount++;
  });

  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${folderName}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  const lines = [`Готово: ${folderName}.zip`, `Файлов JSON: ${Object.keys(files).length} · текстур: ${texCount}`];
  if (warnings.length) lines.push('Предупреждения:', ...warnings.map(w => '· ' + w));
  showExportLog(lines, warnings.length ? 'warn' : 'ok');

  const publishLine = el('p', {}, [
    'Архив скачан — теперь можно ',
    el('a', { href: '/mods/new' }, 'опубликовать его на сайте'),
    '.',
  ]);
  qs('#exportLog').appendChild(publishLine);
}

function initExportTab() {
  qs('#btnExport').addEventListener('click', exportZip);
  qs('#btnValidate').addEventListener('click', () => {
    const { problems, warnings } = validateProject();
    if (!problems.length && !warnings.length) {
      showExportLog(['Ошибок и предупреждений не найдено.'], 'ok');
      return;
    }
    const lines = [];
    if (problems.length) lines.push('Ошибки:', ...problems.map(p => '· ' + p));
    if (warnings.length) lines.push('Предупреждения:', ...warnings.map(w => '· ' + w));
    showExportLog(lines, problems.length ? 'error' : 'warn');
  });
}

// ========================================================== ПРОЕКТ-ФАЙЛ

function initProjectControls() {
  qs('#btnSaveProject').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slugify(state.info.id || state.info.name)}.project.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  qs('#loadProjectInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        const fresh = defaultState();
        state = {
          info: { ...fresh.info, ...(parsed.info || {}) },
          tables: { ...fresh.tables, ...(parsed.tables || {}) },
          names: { ...fresh.names, ...(parsed.names || {}) },
          textures: Array.isArray(parsed.textures) ? parsed.textures : [],
        };
        saveAndRefresh();
      } catch (err) {
        alert('Не удалось прочитать файл проекта: ' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  qs('#btnResetProject').addEventListener('click', () => {
    if (!confirm('Удалить все введённые данные и начать заново? Это нельзя отменить.')) return;
    state = defaultState();
    saveAndRefresh();
  });

  qs('#loadModZipInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('Загрузка мода из архива заменит все текущие данные в конструкторе. Если не сохранили текущую работу — сначала сохраните её кнопкой «Сохранить проект». Продолжить?')) {
      e.target.value = '';
      return;
    }
    importModZip(file);
    e.target.value = '';
  });
}

/** Разбирает .zip уже готового мода (свой экспорт или чужой) и полностью заменяет им текущий проект. */
async function importModZip(file) {
  try {
    const zip = await JSZip.loadAsync(file);
    const names = Object.keys(zip.files);
    const modJsonName = names.find(n => /(^|\/)mod\.json$/i.test(n) && !zip.files[n].dir);
    if (!modJsonName) {
      alert('В архиве не найден mod.json — похоже, это не мод для Alem (или он лежит не на верхнем уровне архива).');
      return;
    }
    const prefix = modJsonName.slice(0, modJsonName.length - 'mod.json'.length);

    async function readJson(name) {
      const entry = zip.file(prefix + name);
      if (!entry) return {};
      try { return JSON.parse(await entry.async('string')) || {}; }
      catch (err) { console.warn(`Не удалось разобрать ${name}:`, err); return {}; }
    }

    const [modJson, weaponsJson, apparelJson, resourcesJson, recipesJson, buildingsJson, techsJson, pawnsJson, locJson] =
      await Promise.all(['mod.json', 'weapons.json', 'apparel.json', 'resources.json', 'recipes.json', 'buildings.json', 'techs.json', 'pawns.json', 'loc.json'].map(readJson));

    // Таблицы «Мир и жизнь» — читаются тем же способом, каждая из своего файла.
    const worldTables = {};
    for (const [tableKey, [fileName, listKey]] of Object.entries(SIMPLE_TABLE_FILES)) {
      const parsed = await readJson(fileName);
      worldTables[tableKey] = Array.isArray(parsed[listKey]) ? parsed[listKey] : [];
    }
    const infoJson = await readJson('info.json');
    worldTables.info = Object.entries(infoJson.entries || {}).map(([key, text]) => ({ key, text }));

    const fresh = defaultState();
    const next = {
      info: { ...fresh.info, ...modJson },
      tables: {
        weapons: Array.isArray(weaponsJson.weapons) ? weaponsJson.weapons : [],
        materials: Array.isArray(weaponsJson.materials) ? weaponsJson.materials : [],
        apparel: Array.isArray(apparelJson.apparel) ? apparelJson.apparel : [],
        resources: Array.isArray(resourcesJson.resources) ? resourcesJson.resources : [],
        recipes: Array.isArray(recipesJson.recipes) ? recipesJson.recipes : [],
        buildings: Array.isArray(buildingsJson.buildings) ? buildingsJson.buildings : [],
        techs: Array.isArray(techsJson.techs) ? techsJson.techs : [],
        traits: Array.isArray(pawnsJson.traits) ? pawnsJson.traits : [],
        traitPairs: Array.isArray(pawnsJson.traitPairs) ? pawnsJson.traitPairs : [],
        childhoods: Array.isArray(pawnsJson.childhoods) ? pawnsJson.childhoods : [],
        adulthoods: Array.isArray(pawnsJson.adulthoods) ? pawnsJson.adulthoods : [],
        rareFullfirst: Array.isArray(pawnsJson.rareFullfirst) ? pawnsJson.rareFullfirst : [],
        loc: Object.entries(locJson.en || {}).map(([ru, en]) => ({ ru, en })),
        ...worldTables,
      },
      names: {},
      textures: [],
    };
    NAME_LISTS.forEach(({ key }) => { next.names[key] = Array.isArray(pawnsJson[key]) ? pawnsJson[key] : []; });

    const texturePrefix = `${prefix}textures/`;
    const textureNames = names.filter(n => n.startsWith(texturePrefix) && !zip.files[n].dir);
    for (const n of textureNames) {
      const relPath = n.slice(texturePrefix.length);
      const ext = (relPath.split('.').pop() || 'png').toLowerCase();
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
      const base64 = await zip.files[n].async('base64');
      next.textures.push({
        id: uid(), fileName: relPath.split('/').pop(), path: relPath,
        dataUrl: `data:${mime};base64,${base64}`, size: Math.round(base64.length * 0.75),
      });
    }

    state = next;
    saveAndRefresh();
  } catch (err) {
    alert('Не удалось прочитать архив: ' + err.message);
  }
}

// =================================================================== INIT

/** Пересобирает всю форму по текущему state — без loadState() и без reload(). */
function rebuildUI() {
  qsa('.form-mount, .table-mount').forEach(m => { m.innerHTML = ''; });
  const infoForm = qs('#infoForm'); if (infoForm) infoForm.innerHTML = '';
  const nameForm = qs('#nameListsForm'); if (nameForm) nameForm.innerHTML = '';
  const texBody = qs('#texCatBody'); if (texBody) texBody.innerHTML = '';
  Object.keys(sectionRenderers).forEach(k => delete sectionRenderers[k]);
  Object.keys(sectionEditState).forEach(k => delete sectionEditState[k]);

  initInfoForm();
  TABLE_KEYS.forEach(k => { if (SCHEMAS[k]) initSchemaSection(k); });
  initNameLists();
  initTextures();
  refreshCounts();
}

/** Сохраняет и обновляет экран: перезагружает страницу, если сохранение в localStorage удалось,
 *  иначе пересобирает форму на месте, чтобы не потерять только что загруженные данные. */
function saveAndRefresh() {
  saveState();
  if (storageAvailable) {
    location.reload();
    return;
  }
  alert('Не удалось сохранить всё в памяти браузера — обычно из-за размера текстур. '
    + 'Данные остались только в этой открытой вкладке: не закрывайте её и сохраните '
    + 'проект кнопкой «Сохранить проект», чтобы точно не потерять работу.');
  rebuildUI();
}

function init() {
  loadState();
  initTabs();
  initInfoForm();
  TABLE_KEYS.forEach(k => { if (SCHEMAS[k]) initSchemaSection(k); });
  initNameLists();
  initTextures();
  initExportTab();
  initProjectControls();
  initMobileProjectToggle();
  refreshCounts();
}

/** Кнопка «⚙ Проект» на телефоне — открывает/закрывает блок с сохранением,
 *  загрузкой проекта/мода и ссылками (на десктопе он всегда виден снизу слева). */
function initMobileProjectToggle() {
  const btn = qs('#railProjectToggle');
  const foot = qs('.rail-foot');
  if (!btn || !foot) return;
  btn.addEventListener('click', () => {
    const open = foot.classList.toggle('is-open');
    btn.classList.toggle('is-active', open);
    btn.textContent = open ? '✕ Проект' : '⚙ Проект';
  });
  // Выбрали пункт вкладки — закрываем панель проекта, если она была открыта.
  qsa('.rail-tab').forEach(t => t.addEventListener('click', () => {
    foot.classList.remove('is-open');
    btn.classList.remove('is-active');
    btn.textContent = '⚙ Проект';
  }));
}

document.addEventListener('DOMContentLoaded', init);
