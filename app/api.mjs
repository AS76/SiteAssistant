import { sitePayload, taskPayload, diaryPayload, transitionPayload } from './domain.mjs';

export const DEFAULT_BASE_URL = 'https://api.siteassistant.asassi.cloud';
const siteFromApi = site => ({ ...site, start: site.start_date, end: site.end_date });
const taskFromApi = task => ({ ...task, siteId: task.site_id, assignee: task.executor, reviewer: task.verifier, due: task.due_date });
const diaryFromApi = entry => ({ ...entry, siteId: entry.site_id, date: entry.operational_date, blockers: entry.impediments, next: entry.next_step, createdAt: entry.created_at });

// Map only contract fields; nested raw/source payloads retain their original keys and values.
const camelRecord = row => Object.fromEntries(Object.entries(row).map(([key, value]) =>
  [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
export const deviationFromApi = row => ({ ...camelRecord(row), ...(row.links ? { links: row.links.map(camelRecord) } : {}) });
export const progressFromApi = camelRecord;
export const bookingFromApi = camelRecord;
export const impactFromApi = row => ({ ...camelRecord(row), ...(row.deviations ? { deviations: row.deviations.map(deviationFromApi) } : {}) });
const wireFilters = filters => Object.fromEntries(Object.entries(filters).map(([key, value]) =>
  [key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`), value]));

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'NETWORK_ERROR' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Override via <meta name="siteassistant-api-base" content="…"> or createApi({ baseUrl }).
export function createApi({ baseUrl = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch, onUnauthorized = () => {}, fresh = false } = {}) {
  const base = baseUrl.replace(/\/+$/, '');
  async function request(path, input, { idempotencyKey, method = 'POST' } = {}) {
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, input === undefined && method !== 'DELETE' ? { credentials: 'include', ...(fresh ? { cache: 'reload' } : {}) } : {
        credentials: 'include',
        method, headers: { 'Content-Type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) }, body: JSON.stringify(input),
      });
    } catch {
      throw new ApiError('apiUnavailable');
    }
    let data;
    try { data = await response.json(); }
    catch { throw new ApiError('apiError', { status: response.status, code: 'INVALID_RESPONSE' }); }
    if (response.status === 401 && path !== '/api/auth/login' && !(path === '/api/auth/password' && data.code === 'INVALID_CREDENTIALS')) onUnauthorized();
    if (!response.ok) throw new ApiError(data.error || 'apiError', { status: response.status, code: data.code || 'API_ERROR' });
    return data;
  }
  const query = filters => {
    const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value != null && value !== ''));
    return params.size ? `?${params}` : '';
  };
  return {
    baseUrl: base,
    login: input => request('/api/auth/login', input),
    logout: () => request('/api/auth/logout', {}),
    me: () => request('/api/auth/me'),
    changePassword: input => request('/api/auth/password', input),
    requestAccess: input => request('/api/auth/request', input),
    forgotPassword: input => request('/api/auth/forgot', input),
    listSites: async () => (await request('/api/sites')).map(siteFromApi),
    createSite: async input => siteFromApi(await request('/api/sites', sitePayload(input))),
    listTasks: async (filters = {}) => (await request(`/api/tasks${query(filters)}`)).map(taskFromApi),
    getTask: async id => taskFromApi(await request(`/api/tasks/${encodeURIComponent(id)}`)),
    createTask: async (input, options) => taskFromApi(await request('/api/tasks', taskPayload(input), options)),
    transitionTask: async (task, input, options) => taskFromApi(await request(`/api/tasks/${encodeURIComponent(task.id)}/transition`, transitionPayload(task, input), options)),
    listDeviations: async (filters = {}) => (await request(`/api/deviations${query(wireFilters(filters))}`)).map(deviationFromApi),
    getDeviation: async id => deviationFromApi(await request(`/api/deviations/${encodeURIComponent(id)}`)),
    listProgress: async (filters = {}) => (await request(`/api/site-progress${query(wireFilters(filters))}`)).map(progressFromApi),
    getProgress: async id => progressFromApi(await request(`/api/site-progress/${encodeURIComponent(id)}`)),
    listBookings: async (filters = {}) => (await request(`/api/time-bookings${query(wireFilters(filters))}`)).map(bookingFromApi),
    createBooking: async input => bookingFromApi(await request('/api/time-bookings', {
      work_day_id: input.workDayId, site_progress_item_id: input.siteProgressItemId, hours: input.hours,
    })),
    deleteBooking: id => request(`/api/time-bookings/${encodeURIComponent(id)}`, undefined, { method: 'DELETE' }),
    listImpacts: async (filters = {}) => (await request(`/api/cost-impacts${query(wireFilters(filters))}`)).map(impactFromApi),
    getImpact: async id => impactFromApi(await request(`/api/cost-impacts/${encodeURIComponent(id)}`)),
    createImpact: async input => impactFromApi(await request('/api/cost-impacts', {
      site_id: input.siteId, title: input.title, deviation_ids: input.deviationIds,
      claim_amount: input.claimAmount, settlement_amount: input.settlementAmount,
    })),
    transitionImpact: async (id, input) => impactFromApi(await request(`/api/cost-impacts/${encodeURIComponent(id)}/transition`, {
      to: input.to, ...(input.to === 'closed' ? { result: input.result } : {}),
    })),
    listWorkDays: async (filters = {}) => (await request(`/api/work-days${query(wireFilters(filters))}`)).map(camelRecord),
    listEmployees: async (filters = {}) => (await request(`/api/employees${query(wireFilters(filters))}`)).map(camelRecord),
    assistantChat: input => request('/api/assistant/chat', input),
    searchLocations: async query => request(`/api/location/search?q=${encodeURIComponent(query)}`),
    dashboard: siteId => request(`/api/dashboard?site_id=${encodeURIComponent(siteId)}`),
    previewImport: input => request('/api/import/preview', input),
    applyImport: input => request('/api/import/apply', input),
    listProgressTypes: async siteId => request(`/api/progress-types${query({ site_id: siteId })}`),
    assignProgressType: async (id, progressTypeId) => progressFromApi(await request(
      `/api/site-progress/${encodeURIComponent(id)}/progress-type`, { progress_type_id: progressTypeId }, { method: 'PATCH' })),
    setStepProgress: async (id, steps) => progressFromApi(await request(
      `/api/site-progress/${encodeURIComponent(id)}/steps`, { steps }, { method: 'PUT' })),
    listWbs: (siteId, flat = false) => request(`/api/wbs${query({ site_id: siteId, flat: flat ? 1 : undefined })}`),
    getWbs: id => request(`/api/wbs/${encodeURIComponent(id)}`),
    listDiary: async (filters = {}) => (await request(`/api/diary${query(filters)}`)).map(diaryFromApi),
    createDiary: async (input, options) => diaryFromApi(await request('/api/diary', diaryPayload(input), options)),
    listAttachments: (filters = {}) => request(`/api/attachments${query(filters)}`),
    createAttachment: async ({ blob, ...input }, options) => {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      return request('/api/attachments', { ...input, content_type: blob.type, data_base64: btoa(binary) }, options);
    },
  };
}
