/** Общая схема настроек. Чистые функции не обращаются к DOM, сети или Chrome. */
(() => {
  'use strict';
  const MIN_BADGE_SIZE = 9;
  const MAX_BADGE_SIZE = 18;
  const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
  const defaults = Object.freeze({
    imdbRatings: true,
    ratingOnClick: true,
    kpRatings: true,
    localMarks: false,
    autoLoad: false,
    pagination: true,
    hideAds: true,
    badges: true,
    voiceHighlight: false,
    sorting: true,
    uhdSearch: true,
    newTab: true,
    kpColor: '#6d3700',
    imdbColor: '#f5c518',
    badgeSize: 12,
    voiceDark: '#ffca72',
    voiceLight: '#8a4300',
    hd: '#075985',
    fhd: '#166534',
    '4k': '#6b21a8',
    '8k': '#9d174d',
    source: '#155e75',
    sd: '#475569',
    cam: '#991b1b',
    hdr: '#854d0e',
  });

  /** Не доверяем хранилищу: старые версии и ручные изменения могут нарушить схему. */
  function normalizeSettings(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    const result = { ...defaults };
    for (const key of Object.keys(defaults)) {
      const expectedType = typeof defaults[key];
      if (expectedType === 'boolean' && typeof source[key] === 'boolean') {
        result[key] = source[key];
      }
      if (expectedType === 'string' && HEX_COLOR_PATTERN.test(source[key] || '')) {
        result[key] = source[key];
      }
    }
    const requestedSize = Number(source.badgeSize);
    result.badgeSize =
      Number.isFinite(requestedSize) && requestedSize > 0
        ? Math.max(MIN_BADGE_SIZE, Math.min(MAX_BADGE_SIZE, requestedSize))
        : defaults.badgeSize;
    return result;
  }

  /** Единый выбор контраста для предпросмотра и страницы RuTracker. */
  function contrastingTextColor(backgroundColor) {
    if (!HEX_COLOR_PATTERN.test(backgroundColor)) return '#ffffff';
    const [red, green, blue] = backgroundColor
      .match(/[a-f0-9]{2}/gi)
      .map((value) => parseInt(value, 16));
    const brightness = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    return brightness > 155 ? '#101820' : '#ffffff';
  }

  // Сохраняем публичное имя normalize: оно является контрактом модулей расширения.
  globalThis.RTP = Object.freeze({ defaults, normalize: normalizeSettings, contrastingTextColor });
})();
