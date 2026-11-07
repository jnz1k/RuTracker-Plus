/**
 * Контроллер страницы RuTracker: DOM, подгрузка, сортировка и локальные отметки.
 * Сетевую работу с рейтингами выполняет background.js через сообщения.
 * Каждый renderer удаляет только элементы, принадлежащие расширению.
 */
(async () => {
  'use strict';
  if (document.documentElement.dataset.rutrackerNew) return;
  document.documentElement.dataset.rutrackerNew = '2.7.0';

  const PAGE_REQUEST_TIMEOUT_MS = 25_000;
  const AUTOLOAD_DISTANCE_PX = 350;
  const RATING_VIEWPORT_MARGIN = '150px';
  const MARK_PREFIX = 'rtp.mark.';
  const MARK_KEY_PATTERN = /^rtp\.mark\.\d+\.(favorite|watched)$/;
  const CONTENT_SELECTOR = '.hl-tr, #topic_main > tbody[id]';
  const RATING_VIEWS = Object.freeze({
    kp: {
      label: 'КП',
      className: 'rtp-kp',
      messageType: 'kpLookup',
      searchUrl: 'https://www.kinopoisk.ru/index.php?kp_query=',
      filmUrl: 'https://www.kinopoisk.ru/film/',
    },
    imdb: {
      label: 'IMDb',
      className: 'rtp-imdb',
      messageType: 'imdbLookup',
      searchUrl: 'https://www.imdb.com/find/?q=',
      filmUrl: 'https://www.imdb.com/title/',
    },
  });
  let settings = RTP.normalize();
  const marks = {};
  let imdbReady = false;
  let kpReady = false;
  // Читаем единый снимок настроек. Сбой хранилища не должен ломать всю страницу.
  try {
    const stored = await chrome.storage.local.get(null);
    settings = RTP.normalize(stored.settings);
    imdbReady = Boolean(stored.imdbApiKey);
    kpReady = Boolean(stored.kpApiKey);
    for (const [key, value] of Object.entries(stored)) {
      if (MARK_KEY_PATTERN.test(key)) marks[key] = value;
    }
  } catch {
    console.warn('[RuTracker Plus] Настройки недоступны, использованы стандартные');
  }
  const originalHeaders = new Map();
  let loader;

  const seen = new Set([canonicalPageUrl(location.href)]);
  let nextUrl = findNextPageUrl(document, location.href);
  let busy = false;
  let failed = false;
  let sortEnabled = false;
  let sortDirection = 'desc';
  let scheduled = false;
  let status;

  /** Одинаковые адреса с разным порядком параметров считаются одной страницей. */
  function canonicalPageUrl(value) {
    const url = new URL(value, location.href);
    url.hash = '';
    url.searchParams.sort();
    return url.href;
  }

  /** Находит следующую страницу, не изменяя текущую навигацию. */
  function findNextPageUrl(doc, base) {
    const paginator = doc.querySelector('#pagination');
    if (!paginator) return null;
    const current = [...paginator.querySelectorAll('b')]
      .reverse()
      .map((el) => el.textContent.trim())
      .find((text) => /^\d+$/.test(text));
    const anchors = [...paginator.querySelectorAll('a[href]')];
    const link =
      anchors.find(
        (a) =>
          current &&
          /^\d+$/.test(a.textContent.trim()) &&
          Number(a.textContent.trim()) === Number(current) + 1,
      ) ||
      anchors.find(
        (a) =>
          a.rel.split(/\s+/).includes('next') ||
          /^(след\.?|следующая|след\.?\s*страница|next|[›»→])$/i.test(a.textContent.trim()),
      );
    if (!link) return null;
    const url = new URL(link.getAttribute('href'), base);
    // Не выходим за текущий сайт и раздел: похожая ссылка может вести в другую тему.
    const previous = new URL(base);
    if (url.origin !== location.origin || url.pathname !== previous.pathname) return null;
    for (const key of ['t', 'f', 'nm']) {
      if (url.searchParams.get(key) !== previous.searchParams.get(key)) return null;
    }
    return url.href;
  }

  function titleIsOnDarkBackground(link) {
    for (let el = link; el; el = el.parentElement) {
      const color = getComputedStyle(el).backgroundColor;
      const values = color.match(/[\d.]+/g)?.map(Number);
      if (!values || values.length < 3 || (values.length > 3 && values[3] < 0.5)) continue;
      return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722 < 145;
    }
    return false;
  }

  /** Метки выводятся из названия; они не подтверждают реальное качество файла. */
  function renderQualityBadges() {
    for (const link of document.querySelectorAll('a.torTopic')) {
      const text = link.textContent;
      link.closest('tr')?.classList.remove('rtn-muted');
      const voice = /\b(?:MVO|AVO|DVO|VO)\b/i.test(text);
      link.classList.toggle('rtn-voice', settings.voiceHighlight && voice);
      link.classList.toggle('rtn-dark', titleIsOnDarkBackground(link));
      // Пересоздаём только собственные метки, включая строки подгруженных страниц.
      if (link.nextElementSibling?.classList.contains('rtn-badges'))
        link.nextElementSibling.remove();
      const badges = createQualityBadges(text);
      if (badges.childElementCount) link.after(badges);
    }
  }

  /** Правила распознавания релиза отделены от обхода строк и подсветки озвучки. */
  function createQualityBadges(text) {
    if (!settings.badges) return document.createElement('span');
    const badges = document.createElement('span');
    badges.className = 'rtn-badges';
    const add = (label, kind, description) => {
      const badge = document.createElement('span');
      badge.className = `rtn-badge rtn-badge-${kind}`;
      badge.textContent = label;
      badge.title = description + ' — по названию раздачи';
      badges.append(badge);
    };
    if (/\b(?:4320[pi]?|8k)\b/i.test(text)) add('8K', '8k', 'Разрешение 4320p / 8K');
    else if (/\b(?:2160[pi]?|4k|uhd)\b|ultra[ .-]*hd/i.test(text))
      add('4K', '4k', 'Разрешение 2160p / Ultra HD');
    else if (/\b1080[pi]?\b|\bfull[ .-]*hd\b|\bfhd\b/i.test(text))
      add('Full HD', 'fhd', 'Разрешение 1080p / 1080i');
    else if (/\b720[pi]?\b|\bhd\b(?![ .-]*(?:rip|tv|cam|ts))/i.test(text))
      add('HD', 'hd', 'HD / разрешение 720p, если указано');
    else if (/\b(?:480[pi]?|576[pi]?|sd)\b/i.test(text)) add('SD', 'sd', 'Стандартное разрешение');
    if (/\b(?:cam(?:rip)?|hdcam|hdts|ts|telesync)(?:\b|[-_])/i.test(text))
      add('CAM / TS', 'cam', 'Экранная запись: высокое разрешение не гарантирует качество');
    else if (/\b(?:blu[ .-]*ray|bdremux|bdrip)\b/i.test(text))
      add('Blu-ray', 'source', 'Источник Blu-ray / BDRip / BDRemux');
    else if (/\bweb[ .-]*dl(?:rip)?\b/i.test(text))
      add('WEB-DL', 'source', 'Источник WEB-DL / WEB-DLRip');
    else if (/\bweb[ .-]*rip\b/i.test(text)) add('WEBRip', 'source', 'Источник WEBRip');
    else if (/\bdvd(?:rip)?\b/i.test(text)) add('DVD', 'sd', 'Источник DVD / DVDRip');
    if (/\bhdr(?:10\+?)?\b/i.test(text)) add('HDR', 'hdr', 'Расширенный динамический диапазон');
    if (/\bdolby[ .-]*vision\b|\bdovi\b|\bdv\b/i.test(text))
      add('Dolby Vision', 'hdr', 'Метка Dolby Vision / DV');
    return badges;
  }

  function readSeedCount(row) {
    return Number((row.querySelector('.seedmed')?.textContent || '').replace(/[^\d]/g, '')) || 0;
  }

  /** Сортировка затрагивает только уже загруженные раздачи. */
  function sortTorrentRows() {
    for (const body of document.querySelectorAll('table.forumline.forum tbody')) {
      const rows = [...body.children].filter(
        (row) => row.matches('tr[id]') && row.querySelector('a.torTopic'),
      );
      // Сортируем через временные позиции, чтобы не сдвигать заголовки и служебные строки.
      const slots = rows.map((row) => {
        const slot = document.createComment('rtn-sort');
        row.replaceWith(slot);
        return slot;
      });
      rows.sort((a, b) =>
        sortDirection === 'desc'
          ? readSeedCount(b) - readSeedCount(a)
          : readSeedCount(a) - readSeedCount(b),
      );
      slots.forEach((slot, i) => slot.replaceWith(rows[i]));
    }
  }

  function installSortControls() {
    if (!settings.sorting) return;
    for (const header of document.querySelectorAll('table.forumline.forum th:nth-child(2)')) {
      if (header.querySelector('.rtn-sort')) continue;
      const button = document.createElement('button');
      button.className = 'rtn-sort';
      button.type = 'button';
      button.textContent = 'По сидам ↓';
      button.title = 'Сортировать по сидам: от большего к меньшему';
      button.addEventListener('click', () => {
        sortDirection = sortEnabled && sortDirection === 'desc' ? 'asc' : 'desc';
        sortEnabled = true;
        sortTorrentRows();
        for (const control of document.querySelectorAll('.rtn-sort')) {
          control.textContent = sortDirection === 'desc' ? 'По сидам ↓' : 'По сидам ↑';
          control.title =
            sortDirection === 'desc'
              ? 'От большего к меньшему. Нажмите, чтобы изменить направление'
              : 'От меньшего к большему. Нажмите, чтобы изменить направление';
          control
            .closest('th')
            ?.setAttribute('aria-sort', sortDirection === 'desc' ? 'descending' : 'ascending');
        }
      });
      if (!originalHeaders.has(header)) originalHeaders.set(header, [...header.childNodes]);
      header.replaceChildren(button);
    }
  }

  function showStatus(text, retry = false) {
    if (!status) {
      status = document.createElement('div');
      status.className = 'rtn-status';
      status.setAttribute('role', 'status');
      document.body.append(status);
    }
    status.replaceChildren(document.createTextNode(text));
    if (retry) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Повторить';
      button.addEventListener('click', () => {
        failed = false;
        loadNextPage();
      });
      status.append(' ', button);
    }
    status.hidden = false;
  }

  function requestPage(url) {
    // XHR учитывает кодировку сервера, в том числе windows-1251.
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url);
      xhr.timeout = PAGE_REQUEST_TIMEOUT_MS;
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(`HTTP ${xhr.status}`));
        if (new URL(xhr.responseURL || url).origin !== location.origin)
          return reject(new Error('Переадресация на другой сайт'));
        resolve({ html: xhr.responseText, url: xhr.responseURL || url });
      };
      xhr.onerror = () => reject(new Error('Ошибка сети'));
      xhr.ontimeout = () => reject(new Error('Сервер не ответил за 25 секунд'));
      xhr.onabort = () => reject(new Error('Запрос отменён'));
      xhr.send();
    });
  }

  /** Удаляем активное содержимое перед переносом HTML из загруженного документа. */
  function sanitizeImportedNode(node, base) {
    node
      .querySelectorAll('script, iframe, object, embed, base, meta, link')
      .forEach((el) => el.remove());
    for (const el of [node, ...node.querySelectorAll('*')]) {
      for (const attr of [...el.attributes]) {
        if (/^on/i.test(attr.name) || attr.name === 'srcdoc') el.removeAttribute(attr.name);
      }
      for (const attr of ['href', 'src', 'action', 'poster']) {
        if (!el.hasAttribute(attr)) continue;
        try {
          const url = new URL(el.getAttribute(attr), base);
          if (['http:', 'https:', 'magnet:', 'mailto:'].includes(url.protocol))
            el.setAttribute(attr, url.href);
          else el.removeAttribute(attr);
        } catch {
          el.removeAttribute(attr);
        }
      }
    }
    return node;
  }

  /** Транзакция подгрузки: адрес помечается просмотренным только после вставки новых строк. */
  async function loadNextPage() {
    if (!settings.pagination || busy || failed || !nextUrl || seen.has(canonicalPageUrl(nextUrl)))
      return;
    const existing = [...document.querySelectorAll(CONTENT_SELECTOR)];
    if (!existing.length) return;
    busy = true;
    updateLoader();
    const requested = nextUrl;
    showStatus('RuTracker Plus: загрузка следующей страницы…');
    try {
      const response = await requestPage(requested);
      const parsed = new DOMParser().parseFromString(response.html, 'text/html');
      const nodes = [...parsed.querySelectorAll(CONTENT_SELECTOR)];
      if (!nodes.length)
        throw new Error('Нет раздач или сообщений. Возможна страница входа или проверки доступа');
      const following = findNextPageUrl(parsed, response.url);
      const fresh = nodes.filter((node) => !node.id || !document.getElementById(node.id));
      if (!fresh.length) throw new Error('Сервер вернул уже загруженную страницу');
      const fragment = document.createDocumentFragment();
      for (const node of fresh)
        fragment.append(sanitizeImportedNode(document.importNode(node, true), response.url));
      existing.at(-1).after(fragment);
      seen.add(canonicalPageUrl(requested));
      seen.add(canonicalPageUrl(response.url));
      nextUrl = following && !seen.has(canonicalPageUrl(following)) ? following : null;
      renderTopicControls();
      if (settings.sorting && sortEnabled) sortTorrentRows();
      status.hidden = true;
    } catch (error) {
      failed = true;
      showStatus(`RuTracker Plus: ${error.message}.`, true);
      console.warn('[RuTracker Plus]', error);
    } finally {
      busy = false;
      updateLoader();
      schedulePositionCheck();
    }
  }

  function checkAutoLoadPosition() {
    scheduled = false;
    if (!settings.pagination || !settings.autoLoad || !nextUrl || busy || failed) return;
    const rows = document.querySelectorAll(CONTENT_SELECTOR);
    const last = rows[rows.length - 1];
    if (last && last.getBoundingClientRect().bottom <= innerHeight + AUTOLOAD_DISTANCE_PX)
      loadNextPage();
  }

  /** Объединяем частые события прокрутки в одну проверку за кадр. */
  function schedulePositionCheck() {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(checkAutoLoadPosition);
    }
  }

  /** Отделяет название и год от данных релиза для UHD и рейтингов. */
  function buildMovieSearchQuery(text) {
    const year =
      text.match(/\[\s*((?:19|20)\d{2})\b/)?.[1] || text.match(/\b((?:19|20)\d{2})\b/)?.[1];
    let name = text.split(/\s+\/\s+/)[0].split(/[[(]/)[0];
    name = name
      .replace(/^[\s✓✔★☆►▶•·]+/, '')
      .replace(/^Т\s*·\s*/, '')
      .trim();
    // Технические метки релиза не входят в название фильма.
    name = name
      .replace(
        /\s+(?:WEB[ .-]*(?:DL|Rip)|Blu[ .-]*ray|BDRip|BDRemux|\d{3,4}[pi]|UHD|HDR|4K)\b.*$/i,
        '',
      )
      .trim();
    return [name, year && !new RegExp(`\\b${year}\\b`).test(name) ? year : '']
      .filter(Boolean)
      .join(' ');
  }

  function renderUhdSearchLinks() {
    document.querySelectorAll('.rtn-uhd-search').forEach((el) => el.remove());
    if (!settings.uhdSearch) return;
    const targets = findTopicTargets();
    for (const target of targets) {
      const query = buildMovieSearchQuery(target.textContent);
      if (!query) continue;
      const link = document.createElement('a');
      link.className = 'rtn-uhd-search';
      const url = new URL('/forum/tracker.php', location.origin);
      url.searchParams.set('f', '1457,1940,271,272,718,775');
      url.searchParams.set('nm', query);
      link.href = url.href;
      link.textContent = 'Найти UHD';
      link.title = `Найти UHD: ${query} (разделы 1457,1940,271,272,718,775)`;
      link.target = settings.newTab ? '_blank' : '_self';
      link.rel = 'noopener noreferrer';
      const anchor = target.nextElementSibling?.classList.contains('rtn-badges')
        ? target.nextElementSibling
        : target;
      anchor.after(link);
    }
  }

  /** Возвращает названия раздач либо заголовок открытой темы. */
  function findTopicTargets() {
    const targets = [...document.querySelectorAll('a.torTopic')];
    const heading =
      document.querySelector('#topic-title') ||
      (location.pathname.endsWith('/viewtopic.php') ? document.querySelector('h1') : null);
    if (heading) targets.push(heading);
    return targets;
  }

  /** Соблюдаем порядок элементов, не помещая кнопки внутрь ссылки заголовка. */
  function insertAfterControls(target, element, precedingSelector) {
    let anchor = target;
    while (anchor.nextElementSibling?.matches(precedingSelector))
      anchor = anchor.nextElementSibling;
    anchor.after(element);
  }

  function topicIdForTarget(target) {
    const url = new URL(target.matches('a.torTopic') ? target.href : location.href, location.href);
    const id = url.searchParams.get('t');
    return /^\d+$/.test(id || '') ? id : null;
  }

  /** Сначала сохраняем состояние, затем меняем интерфейс: ошибка не создаёт ложной отметки. */
  async function toggleTopicMark(key, id, kind, target, button) {
    button.disabled = true;
    try {
      if (marks[key]) {
        await chrome.storage.local.remove(key);
        delete marks[key];
      } else {
        const value = { id, title: target.textContent.trim(), kind, updated: Date.now() };
        await chrome.storage.local.set({ [key]: value });
        marks[key] = value;
      }
      renderMarks();
    } catch {
      button.disabled = false;
      showStatus('RuTracker Plus: не удалось сохранить отметку. Попробуйте ещё раз.');
    }
  }

  function createMarkButton(id, kind, target) {
    const key = `${MARK_PREFIX}${id}.${kind}`;
    const active = Boolean(marks[key]);
    const captions = {
      favorite: active ? '★ В избранном' : '☆ В избранное',
      watched: active ? '✓ Уже смотрел' : '○ Уже смотрел',
    };
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rtp-mark rtp-mark-' + kind;
    button.setAttribute('aria-pressed', String(active));
    button.textContent = captions[kind];
    button.title = active ? 'Снять отметку' : 'Сохранить локальную отметку у этой раздачи';
    button.addEventListener('click', () => toggleTopicMark(key, id, kind, target, button));
    return button;
  }

  function renderMarks() {
    document.querySelectorAll('.rtp-marks').forEach((element) => element.remove());
    if (!settings.localMarks) return;
    for (const target of findTopicTargets()) {
      const id = topicIdForTarget(target);
      if (!id) continue;
      const container = document.createElement('span');
      container.className = 'rtp-marks';
      for (const kind of ['favorite', 'watched'])
        container.append(createMarkButton(id, kind, target));
      insertAfterControls(target, container, '.rtn-badges, .rtn-uhd-search');
    }
  }

  let ratingObservers = [];

  /** Старые наблюдатели отключаем до замены DOM, иначе они удерживают удалённые элементы. */
  function renderRatings() {
    ratingObservers.forEach((observer) => observer.disconnect());
    ratingObservers = [];
    document.querySelectorAll('.rtp-kp,.rtp-imdb').forEach((element) => element.remove());
    if (settings.kpRatings && kpReady) renderRatingProvider(RATING_VIEWS.kp);
    if (settings.imdbRatings && imdbReady) renderRatingProvider(RATING_VIEWS.imdb);
  }

  function showRatingResult(badge, provider, result) {
    if (result?.state !== 'matched') {
      badge.textContent = provider.label + (result?.state === 'error' ? ': ошибка' : ': поиск');
      badge.title = result?.reason || 'Точное совпадение не найдено. Открыть поиск';
      return;
    }
    badge.href = provider.filmUrl + encodeURIComponent(result.id) + '/';
    badge.textContent =
      provider.label + ': ' + (result.rating == null ? '—' : result.rating.toFixed(1));
    badge.title = `${result.title} (${result.year}). Проверено: ${new Date(result.updated).toLocaleString()}`;
  }

  /** Явное состояние загрузки не зависит от текста кнопки или перевода интерфейса. */
  async function loadRating(badge, provider) {
    if (badge.dataset.state !== 'idle') return;
    badge.dataset.state = 'loading';
    badge.textContent = provider.label + ': …';
    try {
      const result = await chrome.runtime.sendMessage({
        type: provider.messageType,
        title: badge.dataset.name,
        year: Number(badge.dataset.year),
      });
      if (badge.isConnected) showRatingResult(badge, provider, result);
    } catch {
      if (badge.isConnected) {
        badge.textContent = provider.label + ': ошибка';
        badge.title = 'Нет ответа расширения. Обновите страницу';
      }
    } finally {
      badge.dataset.state = 'loaded';
    }
  }

  function createRatingBadge(target, provider) {
    const query = buildMovieSearchQuery(target.textContent);
    const year = query.match(/\b((?:19|20)\d{2})$/)?.[1];
    if (!year) return null;
    const title = query.slice(0, -year.length).trim();
    if (!title) return null;
    const badge = document.createElement('a');
    badge.className = provider.className;
    badge.textContent = provider.label + (settings.ratingOnClick ? ': рейтинг' : ': …');
    badge.dataset.name = title;
    badge.dataset.year = year;
    badge.dataset.state = 'idle';
    badge.href = provider.searchUrl + encodeURIComponent(query);
    badge.target = settings.newTab ? '_blank' : '_self';
    badge.rel = 'noopener noreferrer';
    badge.title = (settings.ratingOnClick ? 'Показать рейтинг ' : 'Рейтинг ') + provider.label;
    return badge;
  }

  function createRatingObserver(provider) {
    if (settings.ratingOnClick || typeof IntersectionObserver === 'undefined') return null;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer.unobserve(entry.target);
          loadRating(entry.target, provider);
        }
      },
      { rootMargin: RATING_VIEWPORT_MARGIN },
    );
    ratingObservers.push(observer);
    return observer;
  }

  /** Первый клик получает оценку, последующий открывает карточку или поиск. */
  function bindRatingClick(badge, provider) {
    badge.addEventListener('click', (event) => {
      if (badge.dataset.state === 'loaded') return;
      event.preventDefault();
      if (badge.dataset.state === 'idle') loadRating(badge, provider);
    });
  }

  function renderRatingProvider(provider) {
    const observer = createRatingObserver(provider);
    for (const target of findTopicTargets()) {
      const badge = createRatingBadge(target, provider);
      if (!badge) continue;
      insertAfterControls(target, badge, '.rtn-badges,.rtn-uhd-search,.rtp-marks,.rtp-kp');
      if (settings.ratingOnClick) bindRatingClick(badge, provider);
      else if (observer) observer.observe(badge);
      else loadRating(badge, provider);
    }
  }

  function updateLoader() {
    const rows = document.querySelectorAll(CONTENT_SELECTOR);
    if (!rows.length) {
      loader?.remove();
      return;
    }
    if (!loader) {
      loader = document.createElement('div');
      loader.className = 'rtn-loader';
    }
    const last = rows[rows.length - 1];
    const table = last.closest('table');
    (table || last).after(loader);
    loader.replaceChildren();
    loader.hidden = !settings.pagination || (settings.autoLoad && !failed);
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = busy
      ? 'Загрузка…'
      : failed
        ? 'Повторить загрузку'
        : nextUrl
          ? 'Загрузить ещё'
          : 'Все страницы загружены';
    button.disabled = busy || !nextUrl;
    button.addEventListener('click', () => {
      failed = false;
      loadNextPage();
    });
    loader.append(button);
  }

  /** Порядок важен: каждый следующий элемент вставляется после предыдущих. */
  function renderTopicControls() {
    renderQualityBadges();
    renderUhdSearchLinks();
    renderMarks();
    renderRatings();
  }

  /** Применяет настройки к странице без её перезагрузки. */
  function applySettings() {
    const root = document.documentElement;
    root.classList.toggle('rtp-hide-ads', settings.hideAds);
    root.style.setProperty('--rtn-badge-size', settings.badgeSize + 'px');
    for (const key of [
      'voiceDark',
      'voiceLight',
      'hd',
      'fhd',
      '4k',
      '8k',
      'source',
      'sd',
      'cam',
      'hdr',
      'kpColor',
      'imdbColor',
    ]) {
      root.style.setProperty('--rtn-' + key, settings[key]);
      if (!key.startsWith('voice')) {
        root.style.setProperty('--rtn-text-' + key, RTP.contrastingTextColor(settings[key]));
      }
    }
    if (!settings.sorting) {
      sortEnabled = false;
      for (const [header, nodes] of originalHeaders) {
        header.replaceChildren(...nodes);
        header.removeAttribute('aria-sort');
      }
    } else installSortControls();
    renderTopicControls();
    updateLoader();
    schedulePositionCheck();
  }

  /** Обновления приходят и из других вкладок; изменение ключа не раскрывает его в DOM. */
  function handleStorageChanges(changes, area) {
    if (area !== 'local') return;
    if (changes.imdbApiKey) {
      imdbReady = Boolean(changes.imdbApiKey.newValue);
      renderRatings();
    }
    if (changes.kpApiKey) {
      kpReady = Boolean(changes.kpApiKey.newValue);
      renderRatings();
    }
    let marksChanged = false;
    for (const [key, change] of Object.entries(changes)) {
      if (!MARK_KEY_PATTERN.test(key)) continue;
      if (change.newValue) marks[key] = change.newValue;
      else delete marks[key];
      marksChanged = true;
    }
    if (marksChanged) renderMarks();
    if (changes.settings) {
      settings = RTP.normalize(changes.settings.newValue);
      applySettings();
    }
  }

  applySettings();
  chrome.storage.onChanged.addListener(handleStorageChanges);
  window.addEventListener('scroll', schedulePositionCheck, { passive: true });
  window.addEventListener('resize', schedulePositionCheck, { passive: true });
})();
