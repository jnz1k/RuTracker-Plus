'use strict';

/**
 * Фоновый процесс отвечает только за рейтинги и обслуживание хранилища.
 * Страница не получает API-ключи в ответах: наружу выходит лишь результат поиска.
 * Состояние очереди живёт до остановки service worker; кэш хранится в Chrome.
 */
const REQUEST_TIMEOUT_MS = 15_000;
const REQUEST_INTERVAL_MS = 250;
const MIN_COOLDOWN_SECONDS = 60;
const MAX_COOLDOWN_SECONDS = 86_400;
const MAX_CACHE_ENTRIES = 1_000;
const MAX_TITLE_LENGTH = 180;
const MIN_MOVIE_YEAR = 1880;
const MAX_MOVIE_YEAR = 2100;
const FONT_MIGRATION_KEY = 'rtp.font12Migrated';

// Различия внешних API сосредоточены здесь. Остальной код работает с общей моделью фильма.
const RATING_PROVIDERS = Object.freeze({
  kp: {
    keyField: 'kpApiKey',
    settingField: 'kpRatings',
    cachePrefix: 'rtp.kp.v1.',
    endpoint: 'https://kinopoiskapiunofficial.tech/api/v2.2/films',
    matchedTtlMs: 86_400_000,
    unmatchedTtlMs: 3_600_000,
    createParameters: (title, year) => ({
      keyword: title,
      yearFrom: year,
      yearTo: year,
      page: '1',
    }),
    decodeFilm: (film) => ({
      id: film.kinopoiskId,
      names: [film.nameRu, film.nameEn, film.nameOriginal],
      year: film.year,
      rating: film.ratingKinopoisk,
    }),
    isValidId: (id) => Number.isInteger(id) && id > 0,
  },
  imdb: {
    keyField: 'imdbApiKey',
    settingField: 'imdbRatings',
    cachePrefix: 'rtp.imdb.v1.',
    endpoint: 'https://api.kinodata.space/v1.3/titles',
    matchedTtlMs: 300_000,
    unmatchedTtlMs: 300_000,
    createParameters: (title, year) => ({ q: title, year, limit: '50' }),
    decodeFilm: (film) => ({
      id: film.imdb_id,
      names: [film.title_ru, film.title_en, film.title_original],
      year: film.year,
      rating: film.rating_imdb,
    }),
    isValidId: (id) => typeof id === 'string' && /^tt\d+$/.test(id),
  },
});
const LOOKUP_MESSAGES = Object.freeze({ kpLookup: 'kp', imdbLookup: 'imdb' });
const TEST_MESSAGES = Object.freeze({ kpTest: 'kp', imdbTest: 'imdb' });
const HTTP_ERRORS = Object.freeze({
  401: 'Неверный API-ключ',
  402: 'Лимит запросов API исчерпан',
  403: 'Доступ API запрещён',
  429: 'Слишком много запросов API',
});
const pendingLookups = new Map();
const providerCooldowns = new Map();
let requestQueue = Promise.resolve();

/** Сравниваем названия без пунктуации, но не используем нечёткое угадывание. */
function normalizeMovieName(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function isExtensionPage(sender) {
  return sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''));
}

/** Проверка отправителя граница доверия между сообщениями и платным API. */
function isAllowedSender(sender) {
  if (isExtensionPage(sender)) return true;
  try {
    const url = new URL(sender.url);
    return (
      sender.id === chrome.runtime.id &&
      ['http:', 'https:'].includes(url.protocol) &&
      /(^|\.)rutracker\.(org|net)$/.test(url.hostname)
    );
  } catch {
    return false;
  }
}

function createSearchUrl(provider, title, year) {
  const url = new URL(provider.endpoint);
  for (const [name, value] of Object.entries(provider.createParameters(title, year))) {
    url.searchParams.set(name, value);
  }
  return url.href;
}

/** После отказа авторизации или лимита не повторяем запрос для каждой строки. */
function handleHttpFailure(response, host) {
  const message = HTTP_ERRORS[response.status] || `API: HTTP ${response.status}`;
  if (Object.hasOwn(HTTP_ERRORS, response.status)) {
    const retrySeconds = Number(response.headers?.get('Retry-After')) || MIN_COOLDOWN_SECONDS;
    const boundedSeconds = Math.max(
      MIN_COOLDOWN_SECONDS,
      Math.min(MAX_COOLDOWN_SECONDS, retrySeconds),
    );
    providerCooldowns.set(host, { until: Date.now() + boundedSeconds * 1000, error: message });
  }
  throw new Error(message);
}

/** Таймер освобождается при любом исходе; перенаправления с ключом запрещены. */
async function requestJson(url, apiKey) {
  const host = new URL(url).hostname;
  const cooldown = providerCooldowns.get(host);
  if (cooldown && Date.now() < cooldown.until) throw new Error(cooldown.error);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { 'X-API-KEY': apiKey, Accept: 'application/json' },
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) handleHttpFailure(response, host);
    try {
      return await response.json();
    } catch {
      throw new Error('API вернул некорректный JSON');
    }
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('API не ответил за 15 секунд');
    if (error instanceof TypeError) throw new Error('Нет связи с API');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function readMovieQuery(input) {
  const title =
    typeof input.title === 'string' ? input.title.trim().slice(0, MAX_TITLE_LENGTH) : '';
  const year = Number(input.year);
  if (
    !normalizeMovieName(title) ||
    !Number.isInteger(year) ||
    year < MIN_MOVIE_YEAR ||
    year > MAX_MOVIE_YEAR
  )
    return null;
  return { title, year };
}

/** При совпадении нескольких фильмов возвращаем поиск, а не чужой рейтинг. */
function selectExactMovie(data, provider, query) {
  if (!data || !Array.isArray(data.items)) throw new Error('API вернул неожиданный формат данных');
  const candidates = data.items
    .filter((film) => film && typeof film === 'object')
    .map(provider.decodeFilm);
  const matchingMovies = candidates.filter(
    (film) =>
      Number(film.year) === query.year &&
      film.names.some((name) => normalizeMovieName(name) === normalizeMovieName(query.title)),
  );
  const uniqueMovies = [...new Map(matchingMovies.map((film) => [film.id, film])).values()];
  if (uniqueMovies.length !== 1 || !provider.isValidId(uniqueMovies[0].id)) {
    return {
      state: 'unmatched',
      reason:
        uniqueMovies.length > 1
          ? 'Несколько фильмов с таким названием и годом'
          : 'Точное совпадение не найдено',
    };
  }
  const movie = uniqueMovies[0];
  return {
    state: 'matched',
    id: movie.id,
    title: movie.names.find(Boolean) || query.title,
    year: Number(movie.year),
    rating:
      Number.isFinite(movie.rating) && movie.rating > 0 && movie.rating <= 10 ? movie.rating : null,
    updated: Date.now(),
  };
}

/** Настройки перечитываются при выполнении очереди: ключ могли удалить во время ожидания. */
async function loadCachedOrRemoteRating(provider, query, cacheKey) {
  const stored = await chrome.storage.local.get([provider.keyField, 'settings', cacheKey]);
  if (stored.settings?.[provider.settingField] === false) return { state: 'disabled' };
  const apiKey = String(stored[provider.keyField] || '').trim();
  if (!apiKey) return { state: 'no-key' };
  const cached = stored[cacheKey];
  if (cached?.expires > Date.now() && cached.result) return cached.result;
  const data = await requestJson(createSearchUrl(provider, query.title, query.year), apiKey);
  const result = selectExactMovie(data, provider, query);
  const ttlMs = result.state === 'matched' ? provider.matchedTtlMs : provider.unmatchedTtlMs;
  await chrome.storage.local.set({ [cacheKey]: { expires: Date.now() + ttlMs, result } });
  return result;
}

/** Дедупликация нужна, когда несколько раздач одного фильма видны одновременно. */
async function lookupRating(input, provider) {
  const query = readMovieQuery(input);
  if (!query) return { state: 'unmatched', reason: 'Не удалось определить название и год' };
  const cacheKey =
    provider.cachePrefix + encodeURIComponent(normalizeMovieName(query.title) + '|' + query.year);
  if (pendingLookups.has(cacheKey)) return pendingLookups.get(cacheKey);
  const task = requestQueue.then(() => loadCachedOrRemoteRating(provider, query, cacheKey));
  // Ошибка одного запроса не должна останавливать следующие задания.
  requestQueue = task
    .catch(() => {})
    .then(() => new Promise((resolve) => setTimeout(resolve, REQUEST_INTERVAL_MS)));
  pendingLookups.set(cacheKey, task);
  try {
    return await task;
  } finally {
    pendingLookups.delete(cacheKey);
  }
}

async function testProvider(providerName) {
  const provider = RATING_PROVIDERS[providerName];
  const stored = await chrome.storage.local.get(provider.keyField);
  if (!stored[provider.keyField]) return { ok: false, error: 'Сначала сохраните ключ' };
  providerCooldowns.delete(new URL(provider.endpoint).hostname);
  if (providerName === 'imdb') {
    const data = await requestJson(
      createSearchUrl(provider, 'Inception', 2010),
      stored[provider.keyField],
    );
    const result = selectExactMovie(data, provider, { title: 'Inception', year: 2010 });
    return { ok: true, title: result.title || 'Kinodata' };
  }
  const film = await requestJson(provider.endpoint + '/301', stored[provider.keyField]);
  return { ok: true, title: film.nameRu || 'Подключение успешно', rating: film.ratingKinopoisk };
}

/** true оставляет канал ответа открытым до завершения асинхронной операции. */
function handleMessage(message, sender, respond) {
  if (!isAllowedSender(sender) || typeof message?.type !== 'string') return;
  if (Object.hasOwn(LOOKUP_MESSAGES, message.type)) {
    const provider = RATING_PROVIDERS[LOOKUP_MESSAGES[message.type]];
    lookupRating(message, provider)
      .then(respond)
      .catch((error) => respond({ state: 'error', reason: error.message }));
    return true;
  }
  if (Object.hasOwn(TEST_MESSAGES, message.type) && isExtensionPage(sender)) {
    testProvider(TEST_MESSAGES[message.type])
      .then(respond)
      .catch((error) => respond({ ok: false, error: error.message }));
    return true;
  }
}

function handleKeyChanges(changes, area) {
  if (area !== 'local') return;
  for (const provider of Object.values(RATING_PROVIDERS)) {
    if (changes[provider.keyField]) providerCooldowns.delete(new URL(provider.endpoint).hostname);
  }
}

/** Однократная миграция сохраняет явно выбранные пользователем размеры. */
async function migrateFontSize() {
  const data = await chrome.storage.local.get(['settings', FONT_MIGRATION_KEY]);
  if (data[FONT_MIGRATION_KEY]) return;
  const settings = { ...(data.settings || {}) };
  if (!settings.badgeSize || settings.badgeSize === 10) settings.badgeSize = 12;
  await chrome.storage.local.set({ settings, [FONT_MIGRATION_KEY]: true });
}

/** Удаляем только служебный кэш: ключи, настройки и личные отметки не затрагиваем. */
async function pruneRatingCache() {
  const all = await chrome.storage.local.get(null);
  const prefixes = Object.values(RATING_PROVIDERS).map((provider) => provider.cachePrefix);
  const cache = Object.entries(all)
    .filter(([key]) => prefixes.some((prefix) => key.startsWith(prefix)))
    .sort((left, right) => (right[1]?.expires || 0) - (left[1]?.expires || 0));
  const expiredKeys = cache
    .filter(
      ([, value], index) =>
        index >= MAX_CACHE_ENTRIES || !value?.expires || value.expires < Date.now(),
    )
    .map(([key]) => key);
  if (expiredKeys.length) await chrome.storage.local.remove(expiredKeys);
}

async function maintainStorage() {
  await migrateFontSize();
  await pruneRatingCache();
}

chrome.runtime.onMessage.addListener(handleMessage);
chrome.storage.onChanged.addListener(handleKeyChanges);
chrome.runtime.onInstalled.addListener(() => {
  maintainStorage().catch(() =>
    console.warn('[RuTracker Plus] Не удалось обслужить локальный кэш'),
  );
});
