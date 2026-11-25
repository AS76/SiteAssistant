export function normalizeLanguage(value) {
  if (typeof value !== 'string') return null;
  const match = /^(it|en)(?:-[a-z0-9]+)*$/i.exec(value.trim());
  return match ? match[1].toLowerCase() : null;
}

export function resolveLanguage({ profile, device, browser } = {}) {
  const candidates = Array.isArray(browser) ? browser : [browser];
  for (const value of [profile, device, ...candidates]) {
    const language = normalizeLanguage(value);
    if (language) return language;
  }
  return 'en';
}
