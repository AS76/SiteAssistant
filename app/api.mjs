import { sitePayload, taskPayload, diaryPayload, transitionPayload } from './domain.mjs';

export const DEFAULT_BASE_URL = 'https://api.siteassistant.asassi.cloud';
const siteFromApi = site => ({ ...site, start: site.start_date, end: site.end_date });
const taskFromApi = task => ({ ...task, siteId: task.site_id, assignee: task.executor, reviewer: task.verifier, due: task.due_date });
const diaryFromApi = entry => ({ ...entry, siteId: entry.site_id, date: entry.operational_date, blockers: entry.impediments, next: entry.next_step, createdAt: entry.created_at });

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
  async function request(path, input, { idempotencyKey } = {}) {
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, input === undefined ? { credentials: 'include', ...(fresh ? { cache: 'reload' } : {}) } : {
        credentials: 'include',
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) }, body: JSON.stringify(input),
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
