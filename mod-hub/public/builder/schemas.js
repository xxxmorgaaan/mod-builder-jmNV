/**
 * schemas.js
 * -----------------------------------------------------------------------
 * Декларативное описание всех редактируемых таблиц мода Alem.
 * app.js по каждой схеме сам строит форму добавления строки и таблицу
 * уже добавленных строк — переопределять HTML не нужно.
 *
 * Типы полей:
 *   text      — обычная строка
 *   number    — число (пусто = поле не задано и не попадёт в JSON)
 *   checkbox  — булево, попадает в JSON только если true
 *   select    — выпадающий список ({value,label}); пустое значение = не задано
 *   color     — HEX-цвет
 *   textarea  — многострочный текст (для desc и т.п.)
 *   json      — многострочный текст, парсится как JSON (для "more"/"extra"/"unlocks")
 *   list      — строка через запятую → массив строк (для prereq и т.п.)
 * -----------------------------------------------------------------------
 */

const SCHEMAS = {

  // ---------------------------------------------------------------- WEAPONS
  weapons: {
    title: 'оружие',
    keyField: 'id',
    idFrom: 'name', idCase: 'snake',
    itemLabel: it => `${it.name || it.id} ${it.id ? `· ${it.id}` : ''}`,
    fields: [
      { name: 'name', label: 'Название', type: 'text', required: true, placeholder: 'Кылыш' },
      { name: 'id', label: 'id (необязательно — сделаю из названия)', type: 'text', placeholder: 'kylysh', hint: 'Латиницей, если хотите задать сами' },
      { name: 'spriteId', label: 'spriteId', type: 'text', hint: 'Чья картинка используется, если своей нет' },
      { name: 'melee', label: 'Ближний бой', type: 'checkbox' },
      { name: 'family', label: 'Семейство материалов', type: 'checkbox', hint: 'Породит варианты по materials' },
      { name: 'handOnly', label: 'Только в руках (без предмета)', type: 'checkbox' },
      { name: 'dmg', label: 'Урон', type: 'number', step: '1' },
      { name: 'interval', label: 'Интервал, сек', type: 'number', step: '0.1' },
      { name: 'range', label: 'Дальность', type: 'number', step: '0.1' },
      { name: 'accMul', label: 'Множитель точности', type: 'number', step: '0.01' },
      { name: 'pen', label: 'Пробитие брони (0…1)', type: 'number', step: '0.01', min: 0, max: 1 },
      { name: 'burst', label: 'Выстрелов в очереди', type: 'number', step: '1' },
      { name: 'burstCd', label: 'Пауза внутри очереди', type: 'number', step: '0.01' },
      { name: 'dtype', label: 'Тип урона', type: 'select', options: [
        { value: '', label: '— по умолчанию (Sharp) —' },
        { value: 'Sharp', label: 'Sharp · режущий' },
        { value: 'Blunt', label: 'Blunt · дробящий' },
        { value: 'Heat', label: 'Heat · ожог' },
      ] },
      { name: 'hitLabel', label: 'Название удара', type: 'text', placeholder: 'Удар кылышем' },
      { name: 'drawScale', label: 'Размер картинки', type: 'number', step: '0.01' },
      { name: 'spriteAngle', label: 'Поворот картинки, °', type: 'number', step: '1' },
      { name: 'cost1Type', label: 'Материал 1: тип', type: 'resource' },
      { name: 'cost1', label: 'Материал 1: кол-во', type: 'number', step: '1' },
      { name: 'cost2Type', label: 'Материал 2: тип', type: 'resource' },
      { name: 'cost2', label: 'Материал 2: кол-во', type: 'number', step: '1' },
      { name: 'craftWork', label: 'Работа на изготовление', type: 'number', step: '1' },
      { name: 'more', label: 'Доп. материалы', type: 'materialList', wide: true, hint: 'Материал + количество — выбрать готовый или завести новый ресурс тут же.' },
    ],
  },

  materials: {
    title: 'материалы клинков',
    keyField: 'key',
    itemLabel: it => it.key || '(без key)',
    fields: [
      { name: 'key', label: 'key', type: 'select', required: true, options: [
        { value: '', label: '— выберите —' },
        { value: 'wood', label: 'wood · дерево' },
        { value: 'lime', label: 'lime · известняк' },
        { value: 'gran', label: 'gran · гранит' },
        { value: 'iron', label: 'iron · железо' },
        { value: 'bronze', label: 'bronze · бронза' },
        { value: 'steel', label: 'steel · сталь' },
      ] },
      { name: 'name', label: 'Название варианта', type: 'text', placeholder: 'железный' },
      { name: 'dmgMul', label: 'Множитель урона', type: 'number', step: '0.01' },
      { name: 'res', label: 'Ресурс', type: 'resource' },
      { name: 'amount', label: 'Кол-во ресурса', type: 'number', step: '1' },
    ],
  },

  // ---------------------------------------------------------------- APPAREL
  apparel: {
    title: 'одежду',
    keyField: 'id',
    idFrom: 'name', idCase: 'snake',
    itemLabel: it => `${it.name || it.id} ${it.id ? `· ${it.id}` : ''}`,
    fields: [
      { name: 'name', label: 'Название', type: 'text', required: true, placeholder: 'Степной кафтан' },
      { name: 'id', label: 'id (необязательно — сделаю из названия)', type: 'text', placeholder: 'steppecoat' },
      { name: 'slot', label: 'Слот', type: 'select', options: [
        { value: '', label: '— по умолчанию (Torso) —' },
        { value: 'Head', label: 'Head · голова' },
        { value: 'Torso', label: 'Torso · тело' },
        { value: 'TorsoOver', label: 'TorsoOver · поверх тела' },
        { value: 'Legs', label: 'Legs · ноги' },
        { value: 'ArmorOver', label: 'ArmorOver · доспех поверх всего' },
      ] },
      { name: 'armorSharp', label: 'Броня: режущий (0…1)', type: 'number', step: '0.01' },
      { name: 'armorBlunt', label: 'Броня: дробящий (0…1)', type: 'number', step: '0.01' },
      { name: 'armorHeat', label: 'Броня: ожог (0…1)', type: 'number', step: '0.01' },
      { name: 'insCold', label: 'Утепление (холод)', type: 'number', step: '1' },
      { name: 'insHeat', label: 'Защита от жары', type: 'number', step: '1' },
      { name: 'maxHp', label: 'Прочность', type: 'number', step: '1' },
      { name: 'look', label: 'Номер картинки слоя (look)', type: 'number', step: '1' },
      { name: 'matType', label: 'Материал пошива', type: 'resource' },
      { name: 'matCost', label: 'Кол-во материала', type: 'number', step: '1' },
      { name: 'waterproof', label: 'Защита от намокания (0…1)', type: 'number', step: '0.01' },
      { name: 'tendBonus', label: 'Бонус к лечению', type: 'number', step: '0.01' },
      { name: 'colorful', label: 'Красится игроком при пошиве', type: 'checkbox' },
      { name: 'coversFace', label: 'Закрывает лицо (скрывает бороду)', type: 'checkbox' },
      { name: 'tint', label: 'Постоянный цвет', type: 'color' },
      { name: 'more', label: 'Доп. материалы', type: 'materialList', wide: true, hint: 'Материал + количество — выбрать готовый или завести новый ресурс тут же.' },
    ],
  },

  // -------------------------------------------------------------- RESOURCES
  resources: {
    title: 'ресурс',
    keyField: 'id',
    idFrom: 'name', idCase: 'pascal',
    itemLabel: it => `${it.name || it.id} ${it.id ? `· ${it.id}` : ''}`,
    fields: [
      { name: 'name', label: 'Название (рус.)', type: 'text', required: true, placeholder: 'Мифрил' },
      { name: 'id', label: 'id (необязательно — сделаю из названия)', type: 'text', placeholder: 'Mithril', hint: 'С заглавной буквы, если хотите задать сами' },
      { name: 'nameEn', label: 'Название (англ.)', type: 'text', placeholder: 'Mithril' },
      { name: 'weight', label: 'Вес единицы', type: 'number', step: '0.01' },
      { name: 'value', label: 'Цена', type: 'number', step: '1' },
      { name: 'nutrition', label: 'Сытость (для еды)', type: 'number', step: '0.01' },
      { name: 'icon', label: 'Путь к картинке', type: 'text', placeholder: 'Items/mithril' },
      { name: 'shape', label: 'Форма заглушки', type: 'select', options: [
        { value: '', label: '— по умолчанию (nugget) —' },
        { value: 'ingot', label: 'ingot' }, { value: 'bar', label: 'bar' },
        { value: 'powder', label: 'powder' }, { value: 'vial', label: 'vial' },
        { value: 'coin', label: 'coin' }, { value: 'meat', label: 'meat' },
        { value: 'grain', label: 'grain' }, { value: 'tuber', label: 'tuber' },
        { value: 'cloth', label: 'cloth' }, { value: 'herb', label: 'herb' },
        { value: 'gem', label: 'gem' }, { value: 'nugget', label: 'nugget' },
      ] },
      { name: 'color', label: 'Цвет заглушки', type: 'color' },
      { name: 'mineral', label: 'Признак: минерал', type: 'checkbox' },
      { name: 'currency', label: 'Признак: валюта', type: 'checkbox' },
      { name: 'flammable', label: 'Признак: горючий', type: 'checkbox' },
      { name: 'bloodPack', label: 'Признак: пакет крови', type: 'checkbox' },
      { name: 'organ', label: 'Признак: орган', type: 'checkbox' },
      { name: 'implant', label: 'Признак: имплант', type: 'checkbox' },
      { name: 'bionic', label: 'Признак: бионика', type: 'checkbox' },
      { name: 'meal', label: 'Признак: готовое блюдо', type: 'checkbox' },
      { name: 'animalProduce', label: 'Признак: продукт животных', type: 'checkbox' },
      { name: 'plantFood', label: 'Признак: растительная еда', type: 'checkbox' },
      { name: 'meat', label: 'Признак: мясо', type: 'checkbox' },
      { name: 'fodder', label: 'Признак: корм', type: 'checkbox' },
      { name: 'food', label: 'Признак: еда', type: 'checkbox' },
    ],
  },

  // ---------------------------------------------------------------- RECIPES
  recipes: {
    title: 'рецепт',
    keyField: 'id',
    idFrom: 'name', idCase: 'snake',
    itemLabel: it => `${it.name || it.id} ${it.station ? `· ${it.station}` : ''}`,
    fields: [
      { name: 'station', label: 'Станок', type: 'select', required: true, options: [
        { value: '', label: '— выберите —' },
        { value: 'campfire', label: 'campfire · костёр' },
        { value: 'cook', label: 'cook · кухонная плита' },
        { value: 'butcher', label: 'butcher · разделочный стол' },
        { value: 'furnace', label: 'furnace · плавильная печь' },
        { value: 'steel', label: 'steel · сталеплавильная печь' },
        { value: 'stonecut', label: 'stonecut · камнерезный стол' },
        { value: 'chem', label: 'chem · химический стол' },
        { value: 'tailor', label: 'tailor · швейный стол' },
        { value: 'craft', label: 'craft · верстак' },
      ] },
      { name: 'name', label: 'Название заказа', type: 'text', required: true, placeholder: 'Выплавить мифрил' },
      { name: 'id', label: 'id (необязательно — сделаю из названия)', type: 'text', placeholder: 'mithril_ingot' },
      { name: 'in1Type', label: 'Ингредиент 1: тип', type: 'resource' },
      { name: 'in1', label: 'Ингредиент 1: кол-во', type: 'number', step: '1' },
      { name: 'in1Group', label: 'Ингредиент 1: группа', type: 'select', numeric: true, options: [
        { value: '', label: '— точный тип —' },
        { value: '0', label: '0 · точный тип' },
        { value: '1', label: '1 · любое мясо' },
        { value: '2', label: '2 · любая растительная еда' },
      ] },
      { name: 'in2Type', label: 'Ингредиент 2: тип', type: 'resource' },
      { name: 'in2', label: 'Ингредиент 2: кол-во', type: 'number', step: '1' },
      { name: 'in2Group', label: 'Ингредиент 2: группа', type: 'select', numeric: true, options: [
        { value: '', label: '— точный тип —' },
        { value: '0', label: '0 · точный тип' },
        { value: '1', label: '1 · любое мясо' },
        { value: '2', label: '2 · любая растительная еда' },
      ] },
      { name: 'outType', label: 'Результат: тип', type: 'resource' },
      { name: 'outCount', label: 'Результат: кол-во', type: 'number', step: '1' },
      { name: 'outType2', label: 'Побочный продукт: тип', type: 'resource' },
      { name: 'outCount2', label: 'Побочный продукт: кол-во', type: 'number', step: '1' },
      { name: 'work', label: 'Работа на порцию', type: 'number', step: '1' },
      { name: 'weaponId', label: 'Делает оружие с id', type: 'text' },
      { name: 'apparelId', label: 'Шьёт одежду с id', type: 'text' },
      { name: 'colorPick', label: 'Показать выбор цвета', type: 'checkbox' },
      { name: 'medicinePool', label: 'Берёт лекарства из общего пула', type: 'checkbox' },
      { name: 'more', label: 'Доп. ингредиенты', type: 'materialList', resKey: 'type', wide: true, hint: 'Материал + количество — выбрать готовый или завести новый ресурс тут же.' },
    ],
  },

  // ------------------------------------------------------------- BUILDINGS
  buildings: {
    title: 'постройку',
    keyField: 'kind',
    itemLabel: it => `${it.kind}${it.variant ? ' · ' + it.variant : ''}`,
    fields: [
      { name: 'kind', label: 'kind (вид постройки)', type: 'text', required: true, placeholder: 'Wall', hint: 'Имя должно быть игровым' },
      { name: 'variant', label: 'variant (если есть)', type: 'text' },
      { name: 'costType', label: 'Материал', type: 'resource' },
      { name: 'costAmount', label: 'Кол-во материала', type: 'number', step: '1' },
      { name: 'work', label: 'Секунд работы', type: 'number', step: '1' },
      { name: 'hp', label: 'Прочность', type: 'number', step: '1' },
      { name: 'extra', label: 'Доп. компоненты', type: 'materialList', wide: true, hint: 'Материал + количество — выбрать готовый или завести новый ресурс тут же.' },
    ],
  },

  // ----------------------------------------------------------------- TECHS
  techs: {
    title: 'технологию',
    keyField: 'id',
    idFrom: 'name', idCase: 'snake',
    itemLabel: it => `${it.name || it.id} ${it.id ? `· ${it.id}` : ''}`,
    fields: [
      { name: 'name', label: 'Название', type: 'text', required: true, placeholder: 'Степная ковка' },
      { name: 'id', label: 'id (необязательно — сделаю из названия)', type: 'text', placeholder: 'steppe_smithing' },
      { name: 'branch', label: 'Ветка', type: 'text', placeholder: 'Ремёсла' },
      { name: 'era', label: 'Эпоха', type: 'select', numeric: true, options: [
        { value: '', label: '— по умолчанию (1) —' },
        { value: '1', label: '1 · ремёсла' },
        { value: '2', label: '2 · железо' },
        { value: '3', label: '3 · порох' },
        { value: '4', label: '4 · сталь' },
        { value: '5', label: '5 · пар и электричество' },
      ] },
      { name: 'cost', label: 'Стоимость (очки исследования)', type: 'number', step: '1' },
      { name: 'desc', label: 'Описание', type: 'textarea', wide: true },
      { name: 'needAdvanced', label: 'Нужен продвинутый стол исследований', type: 'checkbox' },
      { name: 'prereq', label: 'Требует техов (через запятую)', type: 'list', placeholder: 'craft_smithy, iron_working', wide: true },
      { name: 'unlocks', label: 'Открывает ключи', type: 'unlocks', wide: true,
        hint: 'Выберите тип и впишите id/имя — конструктор сам соберёт правильный ключ.' },
    ],
  },

  // ----------------------------------------------------------------- PAWNS
  traits: {
    title: 'черту',
    keyField: 'name',
    itemLabel: it => it.name,
    fields: [
      { name: 'name', label: 'Название черты', type: 'text', required: true, placeholder: 'Степняк' },
      { name: 'desc', label: 'Описание', type: 'textarea', wide: true, placeholder: 'Вырос в седле: ходит на 10% быстрее.' },
      { name: 'blocks', label: 'Запрещённая работа', type: 'text', placeholder: 'Уборка' },
    ],
  },

  traitPairs: {
    title: 'пару черт',
    keyField: 'a',
    itemLabel: it => `${it.a} ↔ ${it.b}`,
    fields: [
      { name: 'a', label: 'Черта A', type: 'text', required: true },
      { name: 'b', label: 'Черта B', type: 'text', required: true },
    ],
  },

  childhoods: {
    title: 'детскую биографию',
    keyField: 'name',
    itemLabel: it => it.name,
    fields: [
      { name: 'name', label: 'Название', type: 'text', required: true },
      { name: 'bonus', label: 'Бонусы к навыкам (JSON)', type: 'json', placeholder: '{"Melee":2,"Social":1}', wide: true },
      { name: 'blocks', label: 'Закрытые работы (через запятую)', type: 'list', wide: true },
    ],
  },

  adulthoods: {
    title: 'взрослую биографию',
    keyField: 'name',
    itemLabel: it => it.name,
    fields: [
      { name: 'name', label: 'Название', type: 'text', required: true },
      { name: 'bonus', label: 'Бонусы к навыкам (JSON)', type: 'json', placeholder: '{"Melee":4}', wide: true },
      { name: 'blocks', label: 'Закрытые работы (через запятую)', type: 'list', wide: true },
    ],
  },

  rareFullfirst: {
    title: 'редкую пару имени',
    keyField: 'first',
    itemLabel: it => `${it.first} ${it.last}`,
    fields: [
      { name: 'first', label: 'Имя', type: 'text', required: true },
      { name: 'last', label: 'Фамилия', type: 'text', required: true },
    ],
  },

  // ------------------------------------------------------------------- LOC
  loc: {
    title: 'перевод',
    keyField: 'ru',
    itemLabel: it => `${it.ru} → ${it.en}`,
    fields: [
      { name: 'ru', label: 'Русская строка (ключ)', type: 'text', required: true, placeholder: 'Кылыш', hint: 'Символ в символ, как в таблицах' },
      { name: 'en', label: 'Перевод', type: 'text', required: true, placeholder: 'Kylysh' },
    ],
  },

};

// Простые списки строк (имена персонажей) — отдельная, более лёгкая форма.
const NAME_LISTS = [
  { key: 'maleNames', label: 'Мужские имена' },
  { key: 'femaleNames', label: 'Женские имена' },
  { key: 'lastNames', label: 'Фамилии' },
  { key: 'nicknames', label: 'Клички' },
  { key: 'rareMale', label: 'Редкие мужские имена' },
  { key: 'rareFemale', label: 'Редкие женские имена' },
  { key: 'chronic', label: 'Хронические болячки' },
];

/**
 * Автопривязка к технологиям.
 * Для схем ниже в форме появляется блок «Открыть в технологиях»:
 * можно сразу добавить ключ доступа в уже существующий тех или создать
 * новый — вручную лазить в вкладку «Технологии» после этого не нужно.
 * Функция возвращает список ключей unlocks, которые нужно вписать технологии.
 */
SCHEMAS.weapons.techLink = (item, materials) => {
  if (item.family) {
    const mats = (materials || []).filter(m => m.key);
    if (!mats.length) return [`weapon:${item.id}`];
    return mats.map(m => `weaponfam:${item.id}@${m.key}`);
  }
  return [`weapon:${item.id}`];
};

SCHEMAS.apparel.techLink = (item) => [`apparel:${item.id}`];

SCHEMAS.recipes.techLink = (item) => [`recipe:${item.id}`];

SCHEMAS.buildings.techLink = (item) => [`building:${item.kind}`];

/**
 * Типы ключей доступа для поля «Открывает ключи» в форме технологии.
 * Строится не руками (легко ошибиться в синтаксисе `weaponfam:id@материал»),
 * а через маленький конструктор: тип + id/имя (+материал для weaponfam).
 */
const UNLOCK_TYPES = [
  { value: 'building', label: 'building · постройка (имя вида)', placeholder: 'Furnace', hasTable: 'buildings' },
  { value: 'recipe', label: 'recipe · рецепт станка (его id)', placeholder: 'mithril_ingot', hasTable: 'recipes' },
  { value: 'weapon', label: 'weapon · конкретное оружие', placeholder: 'bow', hasTable: 'weapons' },
  { value: 'weaponfam', label: 'weaponfam · семейство + материал', placeholder: 'kylysh', hasTable: 'weaponsFamily', needsMaterial: true },
  { value: 'apparel', label: 'apparel · одежда или броня', placeholder: 'steppecoat', hasTable: 'apparel' },
  { value: 'bed', label: 'bed · вариант кровати', placeholder: 'Bedroll' },
  { value: 'wallmat', label: 'wallmat · материал стен', placeholder: 'Wood' },
  { value: 'power', label: 'power · машина энергосети', placeholder: 'Generator' },
  { value: 'siege', label: 'siege · осадное орудие', placeholder: 'Mortar' },
  { value: 'crop', label: 'crop · культура грядки', placeholder: 'oak' },
  { value: 'mech', label: 'mech · механика игры', placeholder: 'hunting', suggestions: ['hunting', 'fishing', 'taming', 'trading', 'firstaid'] },
];

/**
 * Готовые ресурсы игры (раздел про полный список) — показываются в
 * выпадающем списке материала, сгруппированными. Список не исчерпывающий:
 * свои ресурсы из вкладки «Ресурсы» добавляются в свою группу автоматически,
 * а «+ Новый ресурс…» заводит ещё один прямо на месте.
 */
const RESOURCE_PRESET_GROUPS = [
  { label: 'Дерево и камень', items: ['Wood', 'Planks', 'LimestoneChunk', 'GraniteChunk', 'LimestoneBlock', 'GraniteBlock', 'Hay', 'Gems'] },
  { label: 'Металлы и руды', items: ['IronOre', 'Iron', 'Coal', 'Steel', 'CopperOre', 'Copper', 'Bronze', 'LeadOre', 'Lead', 'GoldOre', 'SilverOre', 'Sulfur', 'Saltpeter', 'Glass'] },
  { label: 'Компоненты', items: ['Rivets', 'IronComponent', 'Gears', 'Springs', 'SteelMechanism', 'PreciseParts'] },
  { label: 'Ткани', items: ['Cloth', 'Leather', 'Fur', 'Wool'] },
];

/**
 * Номера look, которые в слоях Head / Torso / TorsoOver / ArmorOver уже
 * заняты встроенными вещами игры (см. раздел про облик колониста) —
 * свои номера должны начинаться после них. Для Legs игра ничего не
 * резервирует, поэтому там можно начинать с 0.
 */
const LOOK_RESERVED_START = {
  Head: 3, Torso: 3, TorsoOver: 3, ArmorOver: 3, Legs: 0,
};

/**
 * Папки слоя облика по слоту одежды (раздел 16 инструкции). Head/Torso-группа
 * подтверждены документацией; Legs — по аналогии (штаны), если игра ждёт
 * другое имя папки — в конструкторе путь всегда можно поправить руками.
 */
const TEXTURE_SLOT_FOLDERS = { Head: 'hat', Torso: 'top', TorsoOver: 'top', ArmorOver: 'top', Legs: 'legs' };

/** Четыре обязательных/необязательных вида одного варианта слоя облика. */
const APPAREL_VIEWS = [
  { key: 'down', label: 'Спереди', hint: 'обязательно' },
  { key: 'up', label: 'Со спины' },
  { key: 'left', label: 'Влево' },
  { key: 'right', label: 'Вправо' },
  { key: 'down_w', label: 'Спереди, женский вариант', hint: 'необязательно' },
];
const WEAPON_TEMPLATES = {
  knife:  { melee: true, dmg: 9,  interval: 1.6, range: 1.4, drawScale: 0.55, dtype: 'Sharp', craftWork: 2, hitLabel: 'Удар ножом' },
  sword:  { melee: true, dmg: 14, interval: 1.8, range: 1.5, drawScale: 0.9,  dtype: 'Sharp', craftWork: 5, hitLabel: 'Удар мечом' },
  spear:  { melee: true, dmg: 12, interval: 2.0, range: 1.9, drawScale: 0.88, dtype: 'Sharp', craftWork: 5, hitLabel: 'Удар копьём' },
  mace:   { melee: true, dmg: 16, interval: 2.2, range: 1.4, drawScale: 0.8,  dtype: 'Blunt', craftWork: 5, hitLabel: 'Удар дубиной' },
  bow:    { melee: false, dmg: 10, interval: 2.0, range: 18, drawScale: 1.0, dtype: 'Sharp', craftWork: 6, hitLabel: 'Попадание стрелой' },
  pistol: { melee: false, dmg: 9,  interval: 1.2, range: 15, accMul: 0.9, drawScale: 0.6, dtype: 'Sharp', craftWork: 6, hitLabel: 'Попадание пулей' },
  rifle:  { melee: false, dmg: 15, interval: 1.9, range: 26, accMul: 1.1, drawScale: 1.1, dtype: 'Sharp', craftWork: 9, hitLabel: 'Попадание пулей' },
};

const WEAPON_TEMPLATE_OPTIONS = [
  { value: '', label: '— без шаблона —' },
  { value: 'knife', label: 'Нож' },
  { value: 'sword', label: 'Меч' },
  { value: 'spear', label: 'Копьё' },
  { value: 'mace', label: 'Дубина / булава' },
  { value: 'bow', label: 'Лук' },
  { value: 'pistol', label: 'Пистолет' },
  { value: 'rifle', label: 'Ружьё / винтовка' },
];


/* =====================================================================
 * НОВЫЕ ТАБЛИЦЫ «Мир и жизнь» (разделы 23–31 инструкции)
 * ===================================================================== */

const BIOME_OPTIONS = ['forest', 'temperate', 'steppe', 'desert', 'tundra'];

SCHEMAS.events = {
  title: 'событие',
  keyField: 'id',
  idFrom: 'title', idCase: 'snake',
  itemLabel: it => `${it.title || it.id}`,
  fields: [
    { name: 'title', label: 'Заголовок письма', type: 'text', required: true, placeholder: 'Караван из Таавуна' },
    { name: 'id', label: 'id (необязательно — сделаю из заголовка)', type: 'text' },
    { name: 'text', label: 'Текст письма', type: 'textarea', wide: true, hint: '{colonist} заменится именем случайного колониста.' },
    { name: 'category', label: 'Категория', type: 'select', options: [
      { value: '', label: '— по умолчанию (neutral) —' },
      { value: 'good', label: 'good · хорошее' },
      { value: 'neutral', label: 'neutral · нейтральное' },
      { value: 'threat', label: 'threat · угроза' },
    ] },
    { name: 'weight', label: 'Вес (частота)', type: 'number', step: '0.1', hint: 'Встроенные события категории весят вместе 4.' },
    { name: 'cooldownDays', label: 'Не чаще раза в N дней', type: 'number', step: '1' },
    { name: 'once', label: 'Только один раз за игру', type: 'checkbox' },
    { name: 'minDay', label: 'С какого дня', type: 'number', step: '1' },
    { name: 'minColonists', label: 'Мин. колонистов', type: 'number', step: '1' },
    { name: 'maxColonists', label: 'Макс. колонистов', type: 'number', step: '1' },
    { name: 'minWealth', label: 'Мин. богатство', type: 'number', step: '1' },
    { name: 'maxWealth', label: 'Макс. богатство', type: 'number', step: '1' },
    { name: 'season', label: 'Сезон', type: 'select', options: [
      { value: '', label: '— любой —' },
      { value: 'spring', label: 'spring · весна' }, { value: 'summer', label: 'summer · лето' },
      { value: 'autumn', label: 'autumn · осень' }, { value: 'winter', label: 'winter · зима' },
    ] },
    { name: 'minTemp', label: 'Мин. температура', type: 'number', step: '1' },
    { name: 'maxTemp', label: 'Макс. температура', type: 'number', step: '1' },
    { name: 'needResource', label: 'Нужен ресурс', type: 'resource' },
    { name: 'needCount', label: 'Сколько ресурса', type: 'number', step: '1' },
    { name: 'effects', label: 'Последствия (JSON)', type: 'json', wide: true,
      placeholder: '[{"type":"give","resource":"Kumys","count":12}]',
      hint: 'give · take · mood · relation · raid · animal · letter · event. Либо это, либо choices — не оба сразу.' },
    { name: 'choices', label: 'Выбор из двух вариантов (JSON)', type: 'json', wide: true,
      placeholder: '[{"text":"Купить","effects":[…]},{"text":"Отказать","effects":[…]}]',
      hint: 'РОВНО два варианта — с тремя игра событие пропустит.' },
  ],
};

SCHEMAS.plants = {
  title: 'растение',
  keyField: 'id',
  idFrom: 'name', idCase: 'snake',
  itemLabel: it => `${it.name || it.id}`,
  fields: [
    { name: 'name', label: 'Название', type: 'text', required: true, placeholder: 'Саксаул' },
    { name: 'id', label: 'id (необязательно)', type: 'text', placeholder: 'saxaul' },
    { name: 'desc', label: 'Описание', type: 'textarea', wide: true },
    { name: 'texture', label: 'Картинка (спелое)', type: 'text', placeholder: 'plants/saxaul_full' },
    { name: 'emptyTexture', label: 'Картинка (после сбора)', type: 'text', placeholder: 'plants/saxaul_empty' },
    { name: 'resource', label: 'Что даёт', type: 'resource' },
    { name: 'yieldMin', label: 'Урожай: минимум', type: 'number', step: '1' },
    { name: 'yieldMax', label: 'Урожай: максимум', type: 'number', step: '1' },
    { name: 'work', label: 'Секунд работы', type: 'number', step: '0.1' },
    { name: 'regrowDays', label: 'Отрастает за N дней', type: 'number', step: '1' },
    { name: 'scale', label: 'Размер', type: 'number', step: '0.05' },
    { name: 'blocks', label: 'Непроходимо', type: 'checkbox' },
    { name: 'biomes', label: 'Биомы (через запятую)', type: 'list', wide: true, placeholder: 'steppe, desert',
      hint: BIOME_OPTIONS.join(' · ') + '. Пусто — везде, кроме ледника.' },
    { name: 'terrain', label: 'Почва (через запятую)', type: 'list', placeholder: 'sand, dirt', hint: 'grass · dirt · sand · mud' },
    { name: 'chance', label: 'Доля клеток', type: 'number', step: '0.001', hint: '0.004 — примерно одна из 250.' },
  ],
};

SCHEMAS.animals = {
  title: 'дикого зверя',
  keyField: 'id',
  idFrom: 'name', idCase: 'snake',
  itemLabel: it => `${it.name || it.id}`,
  fields: [
    { name: 'name', label: 'Название', type: 'text', required: true, placeholder: 'Дикий верблюд' },
    { name: 'id', label: 'id (необязательно)', type: 'text' },
    { name: 'nameFemale', label: 'Название самки', type: 'text' },
    { name: 'desc', label: 'Описание', type: 'textarea', wide: true },
    { name: 'behavior', label: 'Повадки (чьи берём)', type: 'text', placeholder: 'deer' },
    { name: 'texture', label: 'Картинка', type: 'text', placeholder: 'animals/camel_side' },
    { name: 'hp', label: 'Здоровье', type: 'number', step: '1' },
    { name: 'bodySize', label: 'Размер тела', type: 'number', step: '0.1' },
    { name: 'hpMul', label: 'Множитель HP', type: 'number', step: '0.1' },
    { name: 'speed', label: 'Скорость', type: 'number', step: '0.1' },
    { name: 'scale', label: 'Размер картинки', type: 'number', step: '0.05' },
    { name: 'damageMin', label: 'Урон: минимум', type: 'number', step: '1' },
    { name: 'damageMax', label: 'Урон: максимум', type: 'number', step: '1' },
    { name: 'meat', label: 'Тип мяса', type: 'resource' },
    { name: 'meatMin', label: 'Мяса: минимум', type: 'number', step: '1' },
    { name: 'meatMax', label: 'Мяса: максимум', type: 'number', step: '1' },
    { name: 'leather', label: 'Шкур', type: 'number', step: '1' },
    { name: 'biomes', label: 'Биомы (через запятую)', type: 'list', wide: true, placeholder: 'steppe, desert' },
    { name: 'groups', label: 'Групп на карте', type: 'number', step: '1' },
    { name: 'groupMin', label: 'В группе: минимум', type: 'number', step: '1' },
    { name: 'groupMax', label: 'В группе: максимум', type: 'number', step: '1' },
    { name: 'restock', label: 'Восполнение', type: 'number', step: '0.01' },
    { name: 'tameTo', label: 'Приручается в вид скота', type: 'text', placeholder: 'Верблюд' },
  ],
};

SCHEMAS.livestock = {
  title: 'скот',
  keyField: 'species',
  itemLabel: it => it.species,
  fields: [
    { name: 'species', label: 'Вид (ключ)', type: 'text', required: true, placeholder: 'Верблюд',
      hint: 'Совпал с игровым — правите его; новый — заводите свой вид.' },
    { name: 'ruName', label: 'Название в тексте', type: 'text', placeholder: 'верблюд' },
    { name: 'femaleName', label: 'Самка', type: 'text' },
    { name: 'maleName', label: 'Самец', type: 'text' },
    { name: 'babyName', label: 'Детёныш', type: 'text' },
    { name: 'spriteKey', label: 'Картинка (ключ)', type: 'text', placeholder: 'camel' },
    { name: 'scale', label: 'Размер картинки', type: 'number', step: '0.05' },
    { name: 'bodySize', label: 'Размер тела', type: 'number', step: '0.1' },
    { name: 'hpMul', label: 'Множитель HP', type: 'number', step: '0.1' },
    { name: 'adultDays', label: 'Взрослеет за N дней', type: 'number', step: '1' },
    { name: 'appetite', label: 'Аппетит', type: 'number', step: '0.1' },
    { name: 'pregnancyHours', label: 'Беременность, часов', type: 'number', step: '1' },
    { name: 'product', label: 'Продукт', type: 'text', placeholder: 'milk' },
    { name: 'productHours', label: 'Продукт раз в N часов', type: 'number', step: '1' },
    { name: 'productAmount', label: 'Продукта за раз', type: 'number', step: '1' },
    { name: 'meatType', label: 'Тип мяса', type: 'resource' },
    { name: 'meat', label: 'Мяса с туши', type: 'number', step: '1' },
    { name: 'leather', label: 'Шкур с туши', type: 'number', step: '1' },
    { name: 'price', label: 'Цена', type: 'number', step: '1' },
    { name: 'maxHerd', label: 'Максимум в стаде', type: 'number', step: '1' },
    { name: 'minTempC', label: 'Мин. температура, °C', type: 'number', step: '1' },
    { name: 'mount', label: 'Верховое животное', type: 'checkbox' },
  ],
};

SCHEMAS.furniture = {
  title: 'мебель',
  keyField: 'id',
  idFrom: 'name', idCase: 'snake',
  itemLabel: it => `${it.name || it.id}`,
  fields: [
    { name: 'name', label: 'Название', type: 'text', required: true, placeholder: 'Сундук кочевника' },
    { name: 'id', label: 'id (необязательно)', type: 'text' },
    { name: 'desc', label: 'Описание', type: 'textarea', wide: true },
    { name: 'base', label: 'Основа (чьё поведение берём)', type: 'select', wide: true, options: [
      { value: '', label: '— без основы: простой предмет 1×1 (декор, свет, преграда) —' },
      ...['Shelf','MedicineCabinet','Trough','Bed','Nightstand','Table','Chair','Campfire','Brazier','Torch',
        'ColdBox','ChessTable','Darts','Horseshoes','GymToys','SchoolDesk','Library','MedicineTable','TailorBench',
        'ChemLab','CookStove','Furnace','SteelFurnace','ButcherTable','StoneTable','ResearchBench','AdvancedBench',
        'CraftSpot','FermentBarrel','Turret','Barricade','SpikeTrap','WoodTrap','Snare','SiegeWeapon','PowerBuilding',
        'Grave','Memorial','Crematorium'].map(v => ({ value: v, label: v })),
    ], hint: 'Стены, полы, двери, мосты, заборы, провода, телеги и шахтный ствол за основу брать нельзя.' },
    { name: 'variant', label: 'Вариант основы', type: 'text', placeholder: 'Single', hint: 'У кровати Single/Double/Hospital/Cradle, у энергосети Lamp/Heater/Cooler, у осадного Ballista/Mortar…' },
    { name: 'texture', label: 'Картинка', type: 'text', placeholder: 'furniture/chest' },
    { name: 'cost', label: 'Материалы', type: 'materialList', resKey: 'resource', wide: true, hint: 'Пусто — как у основы.' },
    { name: 'work', label: 'Время стройки', type: 'number', step: '1', hint: '0 — как у основы.' },
    { name: 'hp', label: 'Прочность', type: 'number', step: '1', hint: '0 — как у основы.' },
    { name: 'light', label: 'Радиус света', type: 'number', step: '1' },
    { name: 'lightColor', label: 'Цвет света', type: 'color' },
    { name: 'blocks', label: 'Непроходимо', type: 'checkbox' },
    { name: 'scale', label: 'Размер картинки', type: 'number', step: '0.05' },
    { name: 'research', label: 'Ключ технологии', type: 'text', placeholder: 'building:steppe_chest', hint: 'Пусто — доступна сразу.' },
  ],
};

SCHEMAS.factions = {
  title: 'державу',
  keyField: 'name',
  itemLabel: it => it.name,
  fields: [
    { name: 'name', label: 'Название (ключ)', type: 'text', required: true, placeholder: 'Орда Каракум',
      hint: 'Совпал с игровым — правите его; новое — новая держава на глобусе.' },
    { name: 'archetype', label: 'Архетип', type: 'select', options: [
      { value: '', label: '— не задано —' },
      { value: 'raiders', label: 'raiders · налётчики' },
      { value: 'tribal', label: 'tribal · племя' },
      { value: 'traders', label: 'traders · торговцы' },
      { value: 'smiths', label: 'smiths · кузнецы' },
      { value: 'healers', label: 'healers · лекари' },
      { value: 'syndicate', label: 'syndicate · синдикат' },
      { value: 'outlaw', label: 'outlaw · вне закона' },
    ] },
    { name: 'color', label: 'Цвет на глобусе', type: 'color' },
    { name: 'alwaysHostile', label: 'Всегда враждебна', type: 'checkbox' },
    { name: 'tech', label: 'Техуровень (0…5)', type: 'number', step: '0.1', min: 0, max: 5 },
    { name: 'citiesMin', label: 'Городов: минимум', type: 'number', step: '1' },
    { name: 'citiesMax', label: 'Городов: максимум', type: 'number', step: '1' },
    { name: 'relationMin', label: 'Отношения: минимум', type: 'number', step: '1' },
    { name: 'relationMax', label: 'Отношения: максимум', type: 'number', step: '1' },
  ],
};

SCHEMAS.biomes = {
  title: 'настройку биома',
  keyField: 'id',
  itemLabel: it => it.id,
  fields: [
    { name: 'id', label: 'Биом', type: 'select', required: true, options: [
      { value: '', label: '— выберите —' },
      ...BIOME_OPTIONS.map(v => ({ value: v, label: v })),
    ], hint: 'Новый биом добавить нельзя — можно настроить эти пять.' },
    { name: 'trees', label: 'Густота деревьев', type: 'number', step: '0.1' },
    { name: 'rocks', label: 'Густота валунов', type: 'number', step: '0.1' },
    { name: 'bushes', label: 'Густота кустов', type: 'number', step: '0.1' },
    { name: 'richSoil', label: 'Богатая почва', type: 'number', step: '0.01', hint: '0.05 — заметно.' },
    { name: 'wildlife', label: 'Количество дичи', type: 'number', step: '0.1' },
    { name: 'temp', label: 'Прибавка к температуре, °C', type: 'number', step: '1' },
  ],
};

SCHEMAS.quests = {
  title: 'заказ',
  keyField: 'id',
  idFrom: 'title', idCase: 'snake',
  itemLabel: it => `${it.title || it.id}`,
  fields: [
    { name: 'title', label: 'Заголовок', type: 'text', required: true, placeholder: 'Кочевникам: {0} × {1}',
      hint: '{0} — количество, {1} — ресурс.' },
    { name: 'id', label: 'id (необязательно)', type: 'text' },
    { name: 'text', label: 'Текст письма', type: 'textarea', wide: true,
      hint: 'Доступны {giver}, {amount}, {item}, {days}.' },
    { name: 'archetypes', label: 'Архетипы держав (через запятую)', type: 'list', wide: true, placeholder: 'tribal, traders' },
    { name: 'factions', label: 'Только эти державы (через запятую)', type: 'list', wide: true },
    { name: 'minRelation', label: 'Мин. отношения', type: 'number', step: '1' },
    { name: 'minDay', label: 'С какого дня', type: 'number', step: '1' },
    { name: 'weight', label: 'Вес (частота)', type: 'number', step: '0.1', hint: 'Обычный заказ игры весит 3.' },
    { name: 'items', label: 'Что просят (через запятую)', type: 'list', wide: true, placeholder: 'FeltCloth, DriedMeat' },
    { name: 'amountMin', label: 'Количество: минимум', type: 'number', step: '1' },
    { name: 'amountMax', label: 'Количество: максимум', type: 'number', step: '1' },
    { name: 'daysMin', label: 'Срок: минимум дней', type: 'number', step: '1' },
    { name: 'daysMax', label: 'Срок: максимум дней', type: 'number', step: '1' },
    { name: 'moneyMin', label: 'Оплата: минимум', type: 'number', step: '1' },
    { name: 'moneyMax', label: 'Оплата: максимум', type: 'number', step: '1' },
    { name: 'rewards', label: 'Награда ресурсами (JSON)', type: 'json', wide: true, placeholder: '[{"resource":"Iron","min":15,"max":30}]' },
    { name: 'relation', label: 'Прибавка к отношениям', type: 'number', step: '1' },
    { name: 'research', label: 'Очки исследований', type: 'number', step: '1' },
  ],
};

SCHEMAS.needs = {
  title: 'потребность',
  keyField: 'id',
  idFrom: 'name', idCase: 'snake',
  itemLabel: it => `${it.name || it.id}`,
  fields: [
    { name: 'name', label: 'Название шкалы', type: 'text', required: true, placeholder: 'Жажда' },
    { name: 'id', label: 'id (необязательно)', type: 'text', placeholder: 'thirst' },
    { name: 'color', label: 'Цвет шкалы', type: 'color' },
    { name: 'start', label: 'Стартовое значение', type: 'number', step: '1' },
    { name: 'drainPerHour', label: 'Убывает за час', type: 'number', step: '0.1' },
    { name: 'lowAt', label: 'Считается низкой при', type: 'number', step: '1',
      hint: 'Ниже этого скриптам приходит on_need_low(имя, id).' },
    { name: 'moods', label: 'Настроение при падении (JSON)', type: 'json', wide: true,
      placeholder: '[{"below":45,"mood":-3,"text":"Хочется пить"}]' },
  ],
};

SCHEMAS.storytellers = {
  title: 'рассказчика',
  keyField: 'name',
  itemLabel: it => it.name,
  fields: [
    { name: 'name', label: 'Имя', type: 'text', required: true, placeholder: 'Буран' },
    { name: 'character', label: 'Характер', type: 'text', placeholder: 'Беспощадный' },
    { name: 'styleLine', label: 'Строка описания', type: 'text', wide: true, placeholder: 'бьёт волнами и почти не даёт продохнуть' },
    { name: 'style', label: 'Стиль', type: 'text', placeholder: 'waves' },
    { name: 'tensionPerDay', label: 'Напряжение за день', type: 'number', step: '1' },
    { name: 'raidShare', label: 'Доля налётов (0…1)', type: 'number', step: '0.05' },
    { name: 'sizeMin', label: 'Размер отряда: минимум', type: 'number', step: '0.1' },
    { name: 'sizeMax', label: 'Размер отряда: максимум', type: 'number', step: '0.1' },
    { name: 'graceMin', label: 'Передышка в начале, дней', type: 'number', step: '1' },
    { name: 'cavalryDay', label: 'Конница с какого дня', type: 'number', step: '1' },
  ],
};

SCHEMAS.challenges = {
  title: 'испытание',
  keyField: 'id',
  idFrom: 'name', idCase: 'snake',
  itemLabel: it => `${it.name || it.id}`,
  fields: [
    { name: 'name', label: 'Название', type: 'text', required: true, placeholder: 'Хозяин табуна' },
    { name: 'id', label: 'id (необязательно)', type: 'text' },
    { name: 'desc', label: 'Описание', type: 'textarea', wide: true },
    { name: 'rules', label: 'Правила (через запятую)', type: 'list', wide: true },
    { name: 'goal', label: 'Тип цели', type: 'text', placeholder: 'script' },
    { name: 'goalValue', label: 'Значение цели', type: 'number', step: '1' },
    { name: 'goalText', label: 'Текст цели', type: 'text', wide: true },
    { name: 'colonists', label: 'Колонистов на старте', type: 'number', step: '1' },
    { name: 'difficulty', label: 'Сложность', type: 'number', step: '1' },
    { name: 'graceDays', label: 'Передышка, дней', type: 'number', step: '1' },
    { name: 'starDay', label: 'День звезды', type: 'number', step: '1' },
    { name: 'planetSeed', label: 'Зерно планеты', type: 'number', step: '1' },
    { name: 'cargo', label: 'Стартовый груз (JSON)', type: 'json', wide: true, placeholder: '[{"resource":"Food","count":120}]' },
    { name: 'weapons', label: 'Стартовое оружие (через запятую)', type: 'list', wide: true },
    { name: 'startTech', label: 'Изученные техи (через запятую)', type: 'list', wide: true },
  ],
};

SCHEMAS.info = {
  title: 'описание «?»',
  keyField: 'key',
  itemLabel: it => it.key,
  fields: [
    { name: 'key', label: 'Ключ записи', type: 'text', required: true },
    { name: 'text', label: 'Текст описания', type: 'textarea', wide: true },
  ],
};
