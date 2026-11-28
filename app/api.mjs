import { sitePayload, taskPayload, diaryPayload, transitionPayload } from './domain.mjs';

export const DEFAULT_BASE_URL = 'https://api.siteassistant.asassi.cloud';
const siteFromApi = site => ({ ...site, start: site.start_date, end: site.end_date });
const taskFromApi = task => ({ ...task, siteId: task.site_id, wbsId: task.wbs_id, wbsCode: task.wbs_code, wbsDescription: task.wbs_description, assignee: task.executor, reviewer: task.verifier, due: task.due_date });
const diaryFromApi = entry => ({ ...entry, siteId: entry.site_id, date: entry.operational_date, blockers: entry.impediments, next: entry.next_step, createdAt: entry.created_at });

// Map only contract fields; nested raw/source payloads retain their original keys and values.
const camelRecord = row => Object.fromEntries(Object.entries(row).map(([key, value]) =>
  [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
export const deviationFromApi = row => ({ ...camelRecord(row), ...(row.links ? { links: row.links.map(camelRecord) } : {}) });
export const progressFromApi = camelRecord;
export const bookingFromApi = camelRecord;
export const impactFromApi = row => ({ ...camelRecord(row), ...(row.deviations ? { deviations: row.deviations.map(deviationFromApi) } : {}) });
export const toolFromApi = camelRecord;
const toolFields = ['name', 'code', 'company', 'status', 'location', 'notes'];
export const toolPayload = input => {
  const result = {};
  if (Object.hasOwn(input, 'siteId') || Object.hasOwn(input, 'site_id')) result.site_id = input.siteId ?? input.site_id;
  for (const field of toolFields) if (Object.hasOwn(input, field)) result[field] = input[field];
  return result;
};
export const certificationFromApi = camelRecord;
export const hseFromApi = camelRecord;
export function hsePayload(input) {
  const result = {};
  for (const key of ['siteId', 'eventNo', 'type', 'severity', 'occurredOn', 'location', 'personsInvolved', 'measures', 'notes', 'deviationId']) {
    const wire = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
    if (Object.hasOwn(input, key) || Object.hasOwn(input, wire)) result[wire] = Object.hasOwn(input, key) ? input[key] : input[wire];
  }
  return result;
}
// Purchase-order JSON bodies use camelCase; responses and the list query use snake_case.
export const purchaseOrderFromApi = row => ({ ...camelRecord(row), ...(row.items ? { items: row.items.map(camelRecord) } : {}) });
export const packageFromApi = row => ({ ...camelRecord(row), ...(row.items ? { items: row.items.map(camelRecord) } : {}) });
export const shipmentFromApi = row => ({ ...camelRecord(row),
  ...(row.packages ? { packages: row.packages.map(packageFromApi) } : {}),
  ...(row.receipts ? { receipts: row.receipts.map(camelRecord) } : {}),
});
const purchaseOrderPayload = (input, fields) => Object.fromEntries(fields.flatMap(key => {
  const wire = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
  return Object.hasOwn(input, key) ? [[key, input[key]]] : Object.hasOwn(input, wire) ? [[key, input[wire]]] : [];
}));
const purchaseOrderHeaderFields = ['siteId', 'poNo', 'supplierName', 'orderedOn', 'notes'];
const purchaseOrderItemFields = ['lineNo', 'materialNo', 'description', 'unit', 'quantity', 'wbsId'];
const certificationFields = ['name', 'category', 'issuer', 'issuedOn', 'expiresOn', 'outcome', 'notes'];
export const certificationPayload = input => {
  const result = {};
  if (Object.hasOwn(input, 'siteId') || Object.hasOwn(input, 'site_id')) result.site_id = input.siteId ?? input.site_id;
  if (Object.hasOwn(input, 'employeeId') || Object.hasOwn(input, 'employee_id')) result.employee_id = input.employeeId ?? input.employee_id;
  for (const field of certificationFields) if (Object.hasOwn(input, field)) result[field] = input[field];
  return result;
};
const wireFilters = filters => Object.fromEntries(Object.entries(filters).map(([key, value]) =>
  [key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`), value]));

async function base64File(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'NETWORK_ERROR', retryAfter } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

function retrySeconds(value) {
  const seconds = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
}

// Override via <meta name="siteassistant-api-base" content="…"> or createApi({ baseUrl }).
export function createApi({ baseUrl = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch, onUnauthorized = () => {}, fresh = false } = {}) {
  const base = baseUrl.replace(/\/+$/, '');
  async function request(path, input, { idempotencyKey, method = 'POST', binary = false } = {}) {
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, input === undefined && method !== 'DELETE' ? { credentials: 'include', ...(fresh ? { cache: 'reload' } : {}) } : {
        credentials: 'include',
        method, headers: { 'Content-Type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) }, body: JSON.stringify(input),
      });
    } catch {
      throw new ApiError('apiUnavailable');
    }
    if (binary && response.ok) {
      const blob = await response.blob();
      return binary === 'evidence' ? { blob, sha256: response.headers.get('X-Content-SHA256') } : blob;
    }
    const retryAfter = response.status === 429 ? retrySeconds(response.headers.get('Retry-After')) : undefined;
    let data;
    try { data = await response.json(); }
    catch { throw new ApiError('apiError', { status: response.status, code: 'INVALID_RESPONSE', retryAfter }); }
    if (response.status === 401 && !['/api/auth/login', '/api/auth/logout'].includes(path) && !path.startsWith('/api/auth/webauthn/login/') && path !== '/api/auth/webauthn/register/verify' && !(path === '/api/auth/password' && data.code === 'INVALID_CREDENTIALS')) onUnauthorized();
    if (!response.ok) throw new ApiError(data.error || 'apiError', { status: response.status, code: data.code || 'API_ERROR',
      retryAfter: retryAfter ?? (response.status === 429 ? retrySeconds(data.retry_after) : undefined),
    });
    return data;
  }
  const query = filters => {
    const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value != null && value !== ''));
    return params.size ? `?${params}` : '';
  };
  async function listAll(path, filters, fromApi, label) {
    const { limit: requestedLimit, offset: startOffset, ...criteria } = filters ?? {};
    const limit = requestedLimit == null || requestedLimit === '' ? 200 : requestedLimit;
    const maxPages = 20;
    const entries = [];
    let offset = startOffset ?? 0;
    for (let page = 0; page < maxPages; page++) {
      const rows = await request(`${path}${query({ limit, offset, ...criteria })}`);
      entries.push(...rows);
      if (rows.length < Number(limit)) return entries.map(fromApi);
      offset = Number(offset) + rows.length;
    }
    throw new ApiError(`${label} pagination reached the ${maxPages}-page limit before all entries were loaded.`,
      { code: 'PAGINATION_LIMIT' });
  }
  return {
    baseUrl: base,
    login: input => request('/api/auth/login', input),
    passkeyLoginOptions: input => request('/api/auth/webauthn/login/options', input),
    passkeyLoginVerify: input => request('/api/auth/webauthn/login/verify', input),
    passkeyRegisterOptions: () => request('/api/auth/webauthn/register/options', {}),
    passkeyRegisterVerify: input => request('/api/auth/webauthn/register/verify', input),
    listCredentials: () => request('/api/auth/credentials'),
    renameCredential: (id, name) => request(`/api/auth/credentials/${encodeURIComponent(id)}`, { name }, { method: 'PATCH' }),
    deleteCredential: id => request(`/api/auth/credentials/${encodeURIComponent(id)}`, undefined, { method: 'DELETE' }),
    logout: () => request('/api/auth/logout', {}),
    me: () => request('/api/auth/me'),
    updatePreferences: input => request('/api/auth/me/preferences', input, { method: 'PATCH' }),
    changePassword: input => request('/api/auth/password', input),
    requestAccess: input => request('/api/auth/request', input),
    forgotPassword: input => request('/api/auth/forgot', input),
    listModuleAccess: siteId => request(`/api/member-access${query({ site_id: siteId })}`),
    saveModuleAccess: input => request('/api/member-access', input, { method: 'PUT' }),
    listJurisdictions: () => request('/api/jurisdictions'),
    listSites: async () => (await request('/api/sites')).map(siteFromApi),
    listAssignable: (siteId, purpose) => request(`/api/sites/${encodeURIComponent(siteId)}/assignable${query({ purpose })}`),
    createSite: async input => siteFromApi(await request('/api/sites', sitePayload(input))),
    updateSite: async (siteId, input) => siteFromApi(await request(`/api/sites/${encodeURIComponent(siteId)}`, input, { method: 'PATCH' })),
    updateSiteAssistant: (siteId, input) => request(`/api/sites/${encodeURIComponent(siteId)}/assistant`, input, { method: 'PATCH' }),
    listPlaces: (siteId, { includeArchived = false } = {}) =>
      request(`/api/places${query({ siteId, includeArchived: includeArchived ? 1 : undefined })}`),
    getPlace: id => request(`/api/places/${encodeURIComponent(id)}`),
    listPlaceHistory: id => request(`/api/places/${encodeURIComponent(id)}/history`),
    createPlace: input => request('/api/places', input),
    updatePlace: (id, input) => request(`/api/places/${encodeURIComponent(id)}`, input, { method: 'PATCH' }),
    archivePlace: (id, input) => request(`/api/places/${encodeURIComponent(id)}/archive`, input),
    listAssets: (siteId, { includeArchived = false, asOf, tag, serial, status, placeId } = {}) =>
      request(`/api/assets${query({ siteId, includeArchived: includeArchived ? 1 : undefined, asOf, tag, serial, status, placeId })}`),
    getAsset: id => request(`/api/assets/${encodeURIComponent(id)}`),
    listAssetPositions: id => request(`/api/assets/${encodeURIComponent(id)}/positions`),
    updateAsset: (id, input) => request(`/api/assets/${encodeURIComponent(id)}`, input, { method: 'PATCH' }),
    moveAsset: (id, input) => request(`/api/assets/${encodeURIComponent(id)}/move`, input),
    listTasks: filters => listAll('/api/tasks', filters, taskFromApi, 'Task'),
    listViews: (siteId, module) => request(`/api/views${query({ site_id: siteId, module })}`),
    createView: input => request('/api/views', input),
    updateView: (id, input) => request(`/api/views/${encodeURIComponent(id)}`, input, { method: 'PATCH' }),
    deleteView: id => request(`/api/views/${encodeURIComponent(id)}`, undefined, { method: 'DELETE' }),
    listTools: async (filters = {}) => (await request(`/api/tools${query(wireFilters(filters))}`)).map(toolFromApi),
    createTool: async input => toolFromApi(await request('/api/tools', toolPayload(input))),
    updateTool: async (id, input) => toolFromApi(await request(`/api/tools/${encodeURIComponent(id)}`, toolPayload(input), { method: 'PATCH' })),
    deleteTool: id => request(`/api/tools/${encodeURIComponent(id)}`, undefined, { method: 'DELETE' }),
    listShipments: async ({ siteId, status } = {}) => (await request(`/api/shipments${query({ site_id: siteId, status })}`)).map(shipmentFromApi),
    getShipment: async id => shipmentFromApi(await request(`/api/shipments/${encodeURIComponent(id)}`)),
    createShipment: async input => shipmentFromApi(await request('/api/shipments', purchaseOrderPayload(input, ['siteId', 'shipmentNo', 'carrier', 'shippedOn', 'expectedOn', 'notes', 'packageIds']))),
    transitionShipment: async (id, status, note) => shipmentFromApi(await request(`/api/shipments/${encodeURIComponent(id)}/status`, { status, ...(note !== undefined ? { note } : {}) })),
    addShipmentReceipt: async (id, input) => camelRecord(await request(`/api/shipments/${encodeURIComponent(id)}/receipts`, purchaseOrderPayload(input, ['purchaseOrderItemId', 'quantityReceived', 'note']))),
    listPackages: async ({ siteId, purchaseOrderId } = {}) => (await request(`/api/packages${query({ site_id: siteId, purchase_order_id: purchaseOrderId })}`)).map(packageFromApi),
    getPackage: async id => packageFromApi(await request(`/api/packages/${encodeURIComponent(id)}`)),
    createPackage: async input => packageFromApi(await request('/api/packages', {
      ...purchaseOrderPayload(input, ['siteId', 'purchaseOrderId', 'packageNo', 'notes']),
      items: input.items.map(item => purchaseOrderPayload(item, ['purchaseOrderItemId', 'quantityPacked'])),
    })),
    closePackage: async id => packageFromApi(await request(`/api/packages/${encodeURIComponent(id)}/close`, {})),
    listPurchaseOrders: async ({ siteId, status } = {}) => (await request(`/api/purchase-orders${query({ site_id: siteId, status })}`)).map(purchaseOrderFromApi),
    getPurchaseOrder: async id => purchaseOrderFromApi(await request(`/api/purchase-orders/${encodeURIComponent(id)}`)),
    createPurchaseOrder: async input => purchaseOrderFromApi(await request('/api/purchase-orders', purchaseOrderPayload(input, purchaseOrderHeaderFields))),
    updatePurchaseOrder: async (id, input) => purchaseOrderFromApi(await request(`/api/purchase-orders/${encodeURIComponent(id)}`, purchaseOrderPayload(input, ['supplierName', 'orderedOn', 'notes']), { method: 'PATCH' })),
    transitionPurchaseOrder: async (id, status) => purchaseOrderFromApi(await request(`/api/purchase-orders/${encodeURIComponent(id)}/status`, { status })),
    addPurchaseOrderItem: async (poId, input) => camelRecord(await request(`/api/purchase-orders/${encodeURIComponent(poId)}/items`, purchaseOrderPayload(input, purchaseOrderItemFields))),
    updatePurchaseOrderItem: async (poId, itemId, input) => camelRecord(await request(`/api/purchase-orders/${encodeURIComponent(poId)}/items/${encodeURIComponent(itemId)}`, purchaseOrderPayload(input, purchaseOrderItemFields), { method: 'PATCH' })),
    transitionPurchaseOrderItem: async (poId, itemId, status) => camelRecord(await request(`/api/purchase-orders/${encodeURIComponent(poId)}/items/${encodeURIComponent(itemId)}/status`, { status })),
    listCertifications: async (filters = {}) => (await request(`/api/certifications${query(wireFilters(filters))}`)).map(certificationFromApi),
    createCertification: async input => certificationFromApi(await request('/api/certifications', certificationPayload(input))),
    updateCertification: async (id, input) => certificationFromApi(await request(`/api/certifications/${encodeURIComponent(id)}`, certificationPayload(input), { method: 'PATCH' })),
    deleteCertification: id => request(`/api/certifications/${encodeURIComponent(id)}`, undefined, { method: 'DELETE' }),
    listHseAssets: async (filters = {}) => (await request(`/api/hse/assets${query({ siteId: filters.siteId })}`)).map(camelRecord),
    listInspectionTemplates: siteId => request(`/api/hse/inspection-templates${query({ siteId })}`),
    createInspection: async input => camelRecord(await request('/api/hse/inspections', input)),
    listInspections: async (filters = {}) => (await request(`/api/hse/inspections${query({ siteId: filters.siteId, assetId: filters.assetId })}`)).map(camelRecord),
    getInspection: async id => {
      const row = await request(`/api/hse/inspections/${encodeURIComponent(id)}`);
      return { ...camelRecord(row), items: row.items.map(camelRecord), asset: row.asset ? camelRecord(row.asset) : null };
    },
    createHseAsset: async input => camelRecord(await request('/api/hse/assets', input)),
    updateHseAsset: async (id, input) => camelRecord(await request(`/api/hse/assets/${encodeURIComponent(id)}`, input, { method: 'PATCH' })),
    listHseEvents: async (filters = {}) => (await request(`/api/hse-events${query(wireFilters(filters))}`)).map(hseFromApi),
    listAuditEvents: ({ siteId, entityType, limit = 20 }) => request(`/api/audit-events${query({ site_id: siteId, entity_type: entityType, limit })}`),
    hseSummary: async siteId => camelRecord(await request(`/api/hse-events${query({ site_id: siteId, summary: 1 })}`)),
    createHseEvent: async input => hseFromApi(await request('/api/hse-events', hsePayload(input))),
    updateHseEvent: async (id, input) => hseFromApi(await request(`/api/hse-events/${encodeURIComponent(id)}`, hsePayload(input), { method: 'PATCH' })),
    deleteHseEvent: id => request(`/api/hse-events/${encodeURIComponent(id)}`, undefined, { method: 'DELETE' }),
    evidenceExport: id => request(`/api/sites/${encodeURIComponent(id)}/evidence-export`, undefined, { binary: 'evidence' }),
    acceptTask: async (id, input) => taskFromApi(await request(`/api/tasks/${encodeURIComponent(id)}/acceptance`, input, { method: 'PATCH' })),
    getTask: async id => taskFromApi(await request(`/api/tasks/${encodeURIComponent(id)}`)),
    createTask: async (input, options) => taskFromApi(await request('/api/tasks', taskPayload(input), options)),
    transitionTask: async (task, input, options) => taskFromApi(await request(`/api/tasks/${encodeURIComponent(task.id)}/transition`, transitionPayload(task, input), options)),
    listDeviations: async (filters = {}) => (await request(`/api/deviations${query(wireFilters({ limit: 200, ...filters }))}`)).map(deviationFromApi),
    getDeviation: async id => deviationFromApi(await request(`/api/deviations/${encodeURIComponent(id)}`)),
    listDeviationEvents: id => request(`/api/deviations/${encodeURIComponent(id)}/events`),
    updateDeviationOwner: (id, userId) => request(`/api/deviations/${encodeURIComponent(id)}/owner`, { userId }, { method: 'PATCH' }),
    updateDeviationAttribution: (id, input) => request(`/api/deviations/${encodeURIComponent(id)}/attribution`, input, { method: 'PATCH' }),
    importDeviationWorkbook: async (siteId, file, meta) => request('/api/deviations/import', {
      site_id: siteId, filename: file.name, data_base64: await base64File(file), meta,
    }),
    deviationReconciliation: siteId => request(`/api/deviations/reconciliation${query({ site_id: siteId })}`),
    listProgress: async (filters = {}) => (await request(`/api/site-progress${query(wireFilters({ limit: 200, ...filters }))}`)).map(progressFromApi),
    getProgress: async id => progressFromApi(await request(`/api/site-progress/${encodeURIComponent(id)}`)),
    updateProgress: async (id, input) => progressFromApi(await request(
      `/api/site-progress/${encodeURIComponent(id)}`, input, { method: 'PATCH' })),
    listBookings: async (filters = {}) => (await request(`/api/time-bookings${query(wireFilters({ limit: 200, ...filters }))}`)).map(bookingFromApi),
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
    workforceSummary: async ({ siteId, groupBy, from, to }) => (await request(
      `/api/workforce/summary${query({ site_id: siteId, group_by: groupBy, from, to })}`)).map(camelRecord),
    workforcePresence: async ({ siteId, date }) => (await request(
      `/api/workforce/presence${query({ site_id: siteId, date })}`)).map(camelRecord),
    assistantChat: input => request('/api/assistant/chat', input),
    assistantUsage: siteId => request(`/api/assistant/usage${query({ site_id: siteId })}`),
    searchLocations: async query => request(`/api/location/search?q=${encodeURIComponent(query)}`),
    dashboard: siteId => request(`/api/dashboard?site_id=${encodeURIComponent(siteId)}`),
    dashboardLayout: siteId => request(`/api/dashboard/layout${query({ site_id: siteId })}`),
    saveDashboardLayout: (siteId, widgets) => request('/api/dashboard/layout', { site_id: siteId, widgets }, { method: 'PUT' }),
    deleteDashboardLayout: siteId => request(`/api/dashboard/layout${query({ site_id: siteId })}`, undefined, { method: 'DELETE' }),
    report: siteId => request(`/api/report?site_id=${encodeURIComponent(siteId)}`),
    reportingOverview: () => request('/api/reporting/overview'),
    listImportMappings: siteId => request(`/api/import-mappings${query({ site_id: siteId })}`),
    saveImportMapping: input => request('/api/import-mappings', input, { method: 'PUT' }),
    deleteImportMapping: (siteId, family) => request(`/api/import-mappings/${encodeURIComponent(family)}${query({ site_id: siteId })}`, undefined, { method: 'DELETE' }),
    previewImport: input => request('/api/import/preview', input),
    applyImport: input => request('/api/import/apply', input),
    importTemplate: async family => ({
      blob: await request(`/api/import/template${query({ family })}`, undefined, { binary: true }),
      filename: `SiteAssistant-${family}-modello.xlsx`,
    }),
    listProgressTypes: async siteId => request(`/api/progress-types${query({ site_id: siteId })}`),
    assignProgressType: async (id, progressTypeId) => progressFromApi(await request(
      `/api/site-progress/${encodeURIComponent(id)}/progress-type`, { progress_type_id: progressTypeId }, { method: 'PATCH' })),
    setStepProgress: async (id, steps) => progressFromApi(await request(
      `/api/site-progress/${encodeURIComponent(id)}/steps`, { steps }, { method: 'PUT' })),
    listWbs: (siteId, flat = false) => request(`/api/wbs${query({ site_id: siteId, flat: flat ? 1 : undefined })}`),
    getWbs: id => request(`/api/wbs/${encodeURIComponent(id)}`),
    createWbs: input => request('/api/wbs', input),
    updateWbs: (id, input) => request(`/api/wbs/${encodeURIComponent(id)}`, input, { method: 'PATCH' }),
    updateTaskWbs: async (id, wbsId) => taskFromApi(await request(`/api/tasks/${encodeURIComponent(id)}`, { wbsId }, { method: 'PATCH' })),
    listDiary: filters => listAll('/api/diary', filters, diaryFromApi, 'Diary'),
    updateDiary: async (id, input) => diaryFromApi(await request(`/api/diary/${encodeURIComponent(id)}`, input, { method: 'PATCH' })),
    listDiaryVersions: id => request(`/api/diary/${encodeURIComponent(id)}/versions`),
    createDiary: async (input, options) => diaryFromApi(await request('/api/diary', diaryPayload(input), options)),
    listAttachments: (filters = {}) => request(`/api/attachments${query(filters)}`),
    createAttachment: async ({ blob, ...input }, options) => request('/api/attachments', {
      ...input, content_type: blob.type, data_base64: await base64File(blob),
    }, options),
  };
}
