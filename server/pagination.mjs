import { RepositoryError } from './repository.mjs';

export function readPagination(url) {
  const read = (name, fallback, min, max = Number.MAX_SAFE_INTEGER) => {
    const raw = url.searchParams.get(name);
    if (raw === null) return fallback;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new RepositoryError(400, `Invalid ${name}.`, 'VALIDATION_ERROR');
    }
    return value;
  };
  return { limit: read('limit', 50, 1, 200), offset: read('offset', 0, 0) };
}
