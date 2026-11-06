/**
 * Страница настроек: отображение формы и явное сохранение пользовательского выбора.
 * Ключи сохраняются отдельно от оформления, поэтому сброс настроек их не удаляет.
 */
'use strict';
const settingsForm = document.querySelector('#settings');
const formStatus = document.querySelector('#status');
const savedList = document.querySelector('#saved-list');
const savedStatus = document.querySelector('#saved-status');
const MARK_KEY_PATTERN = /^rtp\.mark\.\d+\.(favorite|watched)$/;
const COLOR_LABELS = Object.freeze({
  kpColor: 'Кинопоиск',
  imdbColor: 'IMDb',
  voiceDark: 'Названия: тёмный фон',
  voiceLight: 'Названия: светлый фон',
  hd: 'HD',
  fhd: 'Full HD',
  '4k': '4K',
  '8k': '8K',
  source: 'WEB / Blu-ray',
  sd: 'SD / DVD',
  cam: 'CAM / TS',
  hdr: 'HDR / Dolby Vision',
});
let savedMarks = {};

function createColorInputs() {
  const container = document.querySelector('#colors');
  for (const [name, caption] of Object.entries(COLOR_LABELS)) {
    const label = document.createElement('label');
    label.textContent = caption;
    const input = document.createElement('input');
    input.type = 'color';
    input.name = name;
    label.append(input);
    container.append(label);
  }
}

function readFormSettings() {
  const values = {};
  for (const key of Object.keys(RTP.defaults)) {
    const input = settingsForm.elements.namedItem(key);
    values[key] = input.type === 'checkbox' ? input.checked : input.value;
  }
  return RTP.normalize(values);
}

/** Предпросмотр меняет только DOM формы; запись выполняется кнопкой «Сохранить». */
function updatePreview() {
  const settings = readFormSettings();
  for (const badge of document.querySelectorAll('#preview span')) {
    const background = settings[badge.dataset.kind];
    badge.style.backgroundColor = background;
    badge.style.color = RTP.contrastingTextColor(background);
    badge.style.fontSize = settings.badgeSize + 'px';
  }
  settingsForm.elements.autoLoad.disabled = !settings.pagination;
  settingsForm.elements.newTab.disabled = !settings.uhdSearch;
}

function populateSettings(settings) {
  for (const key of Object.keys(RTP.defaults)) {
    const input = settingsForm.elements.namedItem(key);
    if (input.type === 'checkbox') input.checked = settings[key];
    else input.value = settings[key];
  }
  updatePreview();
}

async function saveSettings(settings) {
  try {
    await chrome.storage.local.set({ settings });
    formStatus.textContent = 'Сохранено';
  } catch {
    formStatus.textContent = 'Не удалось сохранить. Попробуйте ещё раз.';
  }
}

async function loadSettings() {
  const saveButton = settingsForm.querySelector('button[type=submit]');
  saveButton.disabled = true;
  try {
    const stored = await chrome.storage.local.get('settings');
    populateSettings(RTP.normalize(stored.settings));
    saveButton.disabled = false;
  } catch {
    formStatus.textContent = 'Не удалось прочитать настройки';
  }
}

/** Имя и ссылка создаются через DOM: сохранённый заголовок не исполняется как HTML. */
function createSavedMarkItem(key, mark) {
  const item = document.createElement('li');
  const link = document.createElement('a');
  link.href = 'https://rutracker.org/forum/viewtopic.php?t=' + key.split('.')[2];
  link.textContent = mark.title;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.textContent = 'Убрать';
  removeButton.setAttribute('aria-label', 'Убрать отметку: ' + mark.title);
  removeButton.addEventListener('click', () => removeSavedMark(key, removeButton));
  item.append(link, removeButton);
  return item;
}

async function removeSavedMark(key, button) {
  button.disabled = true;
  try {
    await chrome.storage.local.remove(key);
    delete savedMarks[key];
    renderSavedMarks();
  } catch {
    button.disabled = false;
    savedStatus.textContent = 'Не удалось снять отметку';
  }
}

function renderSavedMarks() {
  const selectedKind = document.querySelector('#saved-kind').value;
  const entries = Object.entries(savedMarks)
    .filter(
      ([key, mark]) =>
        MARK_KEY_PATTERN.test(key) &&
        key.endsWith('.' + selectedKind) &&
        typeof mark?.title === 'string',
    )
    .sort((left, right) => (right[1].updated || 0) - (left[1].updated || 0));
  savedList.replaceChildren();
  savedStatus.textContent = entries.length ? `Раздач: ${entries.length}` : 'Пока нет отметок';
  for (const [key, mark] of entries) savedList.append(createSavedMarkItem(key, mark));
}

async function loadSavedMarks() {
  try {
    const stored = await chrome.storage.local.get(null);
    savedMarks = Object.fromEntries(
      Object.entries(stored).filter(([key]) => MARK_KEY_PATTERN.test(key)),
    );
    renderSavedMarks();
  } catch {
    savedStatus.textContent = 'Не удалось прочитать отметки';
  }
}

function handleMarkChanges(changes, area) {
  if (area !== 'local') return;
  let needsRender = false;
  for (const [key, change] of Object.entries(changes)) {
    if (!MARK_KEY_PATTERN.test(key)) continue;
    if (change.newValue) savedMarks[key] = change.newValue;
    else delete savedMarks[key];
    needsRender = true;
  }
  if (needsRender) renderSavedMarks();
}

/** Один контроллер для обоих провайдеров; каждый экземпляр замыкает только свои элементы. */
function bindApiKeyControls({ prefix, storageKey, testMessage, keyPattern }) {
  const input = document.querySelector(`#${prefix}-key`);
  const status = document.querySelector(`#${prefix}-status`);
  const saveButton = document.querySelector(`#${prefix}-save`);
  const testButton = document.querySelector(`#${prefix}-test`);

  async function loadKey() {
    saveButton.disabled = true;
    try {
      const stored = await chrome.storage.local.get(storageKey);
      input.value = stored[storageKey] || '';
      saveButton.disabled = false;
    } catch {
      status.textContent = 'Не удалось прочитать ключ';
    }
  }

  async function saveKey() {
    const key = input.value.trim();
    if (key && !keyPattern.test(key)) {
      status.textContent = 'Проверьте формат ключа';
      return;
    }
    try {
      await chrome.storage.local.set({ [storageKey]: key });
      status.textContent = key ? 'Ключ сохранён' : 'Ключ удалён';
    } catch {
      status.textContent = 'Не удалось сохранить ключ';
    }
  }

  async function testKey() {
    testButton.disabled = true;
    status.textContent = 'Проверка сохранённого ключа…';
    try {
      const result = await chrome.runtime.sendMessage({ type: testMessage });
      status.textContent = result?.ok
        ? 'Подключено: ' + result.title
        : result?.error || 'Нет ответа';
    } catch {
      status.textContent = 'Не удалось связаться с расширением';
    } finally {
      testButton.disabled = false;
    }
  }

  saveButton.addEventListener('click', saveKey);
  testButton.addEventListener('click', testKey);
  loadKey();
}

function initializeOptions() {
  createColorInputs();
  populateSettings(RTP.defaults);
  settingsForm.addEventListener('input', () => {
    updatePreview();
    formStatus.textContent = 'Есть несохранённые изменения';
  });
  settingsForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await saveSettings(readFormSettings());
  });
  document.querySelector('#reset').addEventListener('click', async () => {
    populateSettings(RTP.defaults);
    await saveSettings({ ...RTP.defaults });
  });
  document.querySelector('#saved-kind').addEventListener('change', renderSavedMarks);
  chrome.storage.onChanged.addListener(handleMarkChanges);
  bindApiKeyControls({
    prefix: 'kp',
    storageKey: 'kpApiKey',
    testMessage: 'kpTest',
    keyPattern: /^[a-zA-Z0-9-]{16,128}$/,
  });
  bindApiKeyControls({
    prefix: 'imdb',
    storageKey: 'imdbApiKey',
    testMessage: 'imdbTest',
    keyPattern: /^[a-zA-Z0-9_-]{16,128}$/,
  });
  loadSettings();
  loadSavedMarks();
}

initializeOptions();
