import { requireModule } from './module-access.mjs';
// In-app assistant: a server-side proxy to the model with a small, read-only tool set.
// The key never reaches the browser, every query is scoped to one site and the caller's
// role, and the model can only read: writes stay in the forms the user confirms.
import { getSite, RepositoryError, requireRole } from './repository.mjs';
import { assistantPrices, assertAssistantBudget, beginAssistantUsage, finishAssistantUsage } from './assistant-usage.mjs';

const fail = (code, message, status = 400) => { throw new RepositoryError(status, message, code); };
const DEFAULT_BASE = process.env.ASSISTANT_BASE_URL || 'https://api.deepseek.com';
const DEFAULT_MODEL = process.env.ASSISTANT_MODEL || 'deepseek-flash';
const MAX_TOOL_ROUNDS = 4;
const MAX_ROWS = 20;

// Optional provider-routing policy for OpenAI-compatible gateways. OpenRouter uses
// this to enforce ZDR and a provider allowlist per request; direct providers ignore it.
function validProvider(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || JSON.stringify(parsed).length > 4000) return false;
  const strings = value => Array.isArray(value) && value.length <= 20 && value.every(item => typeof item === 'string' && item.length <= 120);
  const allowed = new Set(['order', 'allow_fallbacks', 'only', 'ignore', 'data_collection', 'zdr', 'sort', 'max_price', 'quantizations', 'require_parameters']);
  for (const [key, item] of Object.entries(parsed)) {
    if (!allowed.has(key)) return false;
    if (['order', 'only', 'ignore', 'quantizations'].includes(key) && !strings(item)) return false;
    if (['allow_fallbacks', 'zdr', 'require_parameters'].includes(key) && typeof item !== 'boolean') return false;
    if (key === 'data_collection' && !['allow', 'deny'].includes(item)) return false;
    if (key === 'sort' && (typeof item !== 'string' || item.length > 40)) return false;
    if (key === 'max_price' && !((typeof item === 'number' && Number.isFinite(item) && item >= 0) || (item && typeof item === 'object' && !Array.isArray(item)))) return false;
  }
  return true;
}
export function providerPolicy(value = process.env.ASSISTANT_PROVIDER_JSON) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return validProvider(parsed) ? parsed : { invalid: true };
  } catch {
    return { invalid: true };
  }
}
const DEFAULT_PROVIDER = providerPolicy();

const FAMILIES = {
  deviations: { table: 'deviations', label: 'deviation_no',
    columns: 'id, deviation_no, title, status, priority, assigned_to, creation_date, closed_date',
    search: ['deviation_no', 'title', 'problem_description'], order: 'creation_date DESC' },
  site_progress_items: { table: 'site_progress_items', label: 'description',
    columns: 'id, description, section, plc_area, progress_pct, planned_progress_pct, progress_type_id',
    search: ['description', 'section', 'plc_area'], order: 'source_row' },
  cost_impacts: { table: 'cost_impacts', label: 'title',
    columns: 'id, title, status, claim_amount, settlement_amount, result, created_at', search: ['title'], order: 'created_at DESC' },
  time_bookings: { table: 'time_bookings', label: 'hours',
    columns: 'id, work_day_id, site_progress_item_id, hours, created_at', search: [], order: 'created_at DESC' },
  tasks: { table: 'tasks', label: 'title',
    columns: 'id, title, status, priority, executor, verifier, due_date', search: ['title', 'area'], order: 'created_at DESC' },
  diary: { table: 'diary', label: 'operational_date',
    columns: 'id, operational_date, shift, plan, actual, impediments, next_step', search: ['actual', 'plan'], order: 'operational_date DESC' },
  wbs: { table: 'project_structure', label: 'wbs_code',
    columns: 'id, wbs_code, description, level, progress_pct, planned_start, planned_finish',
    search: ['wbs_code', 'description'], order: 'sort_order' },
};

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'find_records',
      description: 'Cerca record del cantiere corrente. Restituisce poche righe con id, codice e stato.',
      parameters: { type: 'object', properties: {
        family: { type: 'string', enum: Object.keys(FAMILIES) },
        text: { type: 'string', description: 'Testo da cercare (codice, titolo, descrizione).' },
        status: { type: 'string', description: 'Filtro esatto sullo stato, quando la famiglia ne ha uno.' },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      }, required: ['family'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'count_records',
      description: 'Conta i record di una famiglia, eventualmente per stato.',
      parameters: { type: 'object', properties: {
        family: { type: 'string', enum: Object.keys(FAMILIES) },
        group_by_status: { type: 'boolean' },
      }, required: ['family'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sum_hours',
      description: 'Somma le ore prenotate, totali o per elemento di avanzamento.',
      parameters: { type: 'object', properties: { by_item: { type: 'boolean' } }, required: [] },
    },
  },
];

const SYSTEM = {
  it: `Sei l'assistente dentro SiteAssistant, un gestionale di cantiere. Rispondi in italiano, breve e concreto.
Regole non negoziabili:
- Usa solo i dati che ottieni dai tool. Se un dato non c'è, dillo: "non risulta nei dati".
- Cita sempre i record che usi con il loro codice tra parentesi quadre, per esempio [DEV-014] o [WBS 2.1].
- Non inventare numeri, stati, date o nomi. Non dedurre un totale che non hai calcolato.
- Non puoi scrivere: se l'utente chiede di modificare qualcosa, spiega quale schermata aprire.
- Massimo 120 parole, salvo richiesta esplicita di dettaglio.
- Se la domanda è in inglese, rispondi in inglese con gli stessi codici.`,
  en: `You are the assistant inside SiteAssistant, a construction site management tool. Answer in English, briefly and concretely.
Non-negotiable rules:
- Use only the data returned by the tools. If something is missing, say "not in the data".
- Always cite the records you use with their code in square brackets, for example [DEV-014] or [WBS 2.1].
- Never invent numbers, statuses, dates or names. Do not derive a total you did not compute.
- You cannot write: if the user asks to change something, explain which screen to open.
- At most 120 words unless the user explicitly asks for detail.
- If the question is in Italian, answer in Italian with the same codes.`,
};

// One rate limiter per process: the demo runs a single instance.
const attempts = new Map();
export const WINDOW_MS = 60 * 60 * 1000;
export const MAX_PER_WINDOW = 30;
export function allowRequest(userId, now = Date.now()) {
  const entry = attempts.get(userId) || { count: 0, reset: now + WINDOW_MS };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + WINDOW_MS; }
  entry.count += 1;
  attempts.set(userId, entry);
  return entry.count <= MAX_PER_WINDOW;
}

const escapeLike = value => String(value).replace(/[%_\\]/g, match => `\\${match}`);

async function runTool(db, { siteId, user }, name, args) {
  if (!TOOLS.some(tool => tool.function.name === name)) fail('UNKNOWN_TOOL', 'Strumento non disponibile.');
  const family = Object.hasOwn(FAMILIES, args?.family) ? FAMILIES[args.family] : undefined;
  if (name !== 'sum_hours' && !family) fail('UNKNOWN_FAMILY', 'Famiglia non supportata.');
  await requireRole(db, siteId, user);
  const module = name === 'sum_hours' ? 'bookings'
    : ({ site_progress_items: 'progress', cost_impacts: 'impacts', time_bookings: 'bookings' })[args.family] || args.family;
  await requireModule(db, siteId, user, module);
  if (name === 'find_records') {
    if (args.family === 'time_bookings') await requireModule(db, siteId, user, 'workforce_names');
    const limit = Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), MAX_ROWS) : 10;
    const clauses = ['site_id = ?'], values = [siteId];
    if (args.status && typeof args.status === 'string' && family.columns.includes('status')) { clauses.push('status = ?'); values.push(args.status); }
    if (args.text && family.search.length) {
      // LOWER+LIKE works on both drivers; ILIKE is PostgreSQL-only.
      clauses.push(`(${family.search.map(column => `LOWER(${column}) LIKE LOWER(?)`).join(' OR ')})`);
      for (const _ of family.search) values.push(`%${escapeLike(args.text)}%`);
    }
    const rows = await db.all(`SELECT ${family.columns} FROM ${family.table} WHERE ${clauses.join(' AND ')}
      ORDER BY ${family.order} LIMIT ${limit}`, ...values);
    return { family: args.family, count: rows.length, rows };
  }
  if (name === 'count_records') {
    if (args.group_by_status && family.columns.includes('status')) {
      const rows = await db.all(`SELECT status, COUNT(*) AS count FROM ${family.table} WHERE site_id = ? GROUP BY status ORDER BY count DESC`, siteId);
      return { family: args.family, total: rows.reduce((sum, row) => sum + Number(row.count), 0),
        by_status: rows.map(row => ({ status: row.status, count: Number(row.count) })) };
    }
    const row = await db.get(`SELECT COUNT(*) AS count FROM ${family.table} WHERE site_id = ?`, siteId);
    return { family: args.family, total: Number(row.count) };
  }
  if (args?.by_item) {
    const rows = await db.all(`SELECT site_progress_item_id, SUM(hours) AS hours FROM time_bookings
      WHERE site_id = ? GROUP BY site_progress_item_id ORDER BY hours DESC LIMIT ${MAX_ROWS}`, siteId);
    return { by_item: rows.map(row => ({ item_id: row.site_progress_item_id, hours: Number(row.hours) })) };
  }
  const row = await db.get('SELECT COALESCE(SUM(hours), 0) AS hours FROM time_bookings WHERE site_id = ?', siteId);
  return { total_hours: Number(row.hours) };
}

function citationsFrom(calls, results) {
  const seen = new Set(), citations = [];
  const add = (family, row) => {
    const id = row.id; if (!id || seen.has(`${family}:${id}`)) return;
    seen.add(`${family}:${id}`);
    const label = family === 'wbs' ? `WBS ${row.wbs_code ?? ''}`.trim()
      : family === 'deviations' ? String(row.deviation_no ?? id).trim()
        : String(row[FAMILIES[family].label] ?? id).slice(0, 60);
    citations.push({ family, id, label });
  };
  results.forEach((result, index) => {
    if (calls[index].name === 'find_records' && Array.isArray(result.rows)) for (const row of result.rows) add(result.family, row);
  });
  return citations.slice(0, 12);
}

export async function chat(db, { siteId, user, messages, view, language = 'it' }, { fetchImpl = fetch, apiKey = process.env.DEEPSEEK_API_KEY,
  baseUrl = DEFAULT_BASE, model = DEFAULT_MODEL, provider = DEFAULT_PROVIDER } = {}) {
  if (!user?.id) fail('UNAUTHENTICATED', 'Authentication required.', 401);
  await requireRole(db, siteId, user);
  const site = await getSite(db, siteId);
  if (!site.assistant_enabled) fail('ASSISTANT_DISABLED', 'Assistente disattivato per questo cantiere.', 409);
  await assertAssistantBudget(db, siteId);
  if (!apiKey) fail('ASSISTANT_NOT_CONFIGURED', 'Assistente non configurato.', 503);
  if (provider && (!validProvider(provider) || provider.invalid)) fail('ASSISTANT_NOT_CONFIGURED', 'Configurazione del provider non valida.', 503);
  if (!allowRequest(user.id)) fail('ASSISTANT_RATE_LIMITED', 'Troppe richieste: riprova tra qualche minuto.', 429);
  const history = (Array.isArray(messages) ? messages : []).slice(-8)
    .filter(message => ['user', 'assistant'].includes(message?.role) && typeof message.content === 'string')
    .map(message => ({ role: message.role, content: message.content.slice(0, 4000) }));
  if (!history.length) fail('INVALID_MESSAGES', 'Serve almeno un messaggio.');
  const prices = assistantPrices();

  const lang = language === 'en' ? 'en' : 'it';
  const context = lang === 'en' ? `Current view: ${view || 'overview'}. Interface language: English.`
    : `Vista corrente: ${view || 'panoramica'}. Lingua dell'interfaccia: italiano.`;
  const conversation = [{ role: 'system', content: `${SYSTEM[lang]}\n${context}` }, ...history];
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new RepositoryError(504, 'Tempo di risposta dell’assistente scaduto.', 'ASSISTANT_TIMEOUT');
      controller.abort(error);
      reject(error);
    }, site.assistant_timeout_ms);
  });
  try {
    return await Promise.race([deadline, completeChat(db, { siteId, user, lang, conversation },
      { fetchImpl, apiKey, baseUrl, model, provider, prices, signal: controller.signal, deadline })]);
  } finally {
    clearTimeout(timer);
  }
}

async function providerCompletion(conversation, { fetchImpl, apiKey, baseUrl, model, provider, signal }) {
  signal.throwIfAborted();
  try {
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: conversation, tools: TOOLS, tool_choice: 'auto', temperature: 0.2, max_tokens: 700,
        ...(provider ? { provider } : {}) }),
      signal,
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) fail('ASSISTANT_AUTH', 'Chiave del provider non valida.', 503);
      if (response.status === 429) fail('ASSISTANT_RATE_LIMITED', 'Provider occupato: riprova.', 429);
      fail('ASSISTANT_UNAVAILABLE', 'Assistente non disponibile.', 502);
    }
    const payload = await response.json();
    signal.throwIfAborted();
    return payload;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof RepositoryError) throw error;
    fail('ASSISTANT_UNAVAILABLE', 'Assistente non disponibile.', 502);
  }
}

async function meteredCompletion(db, { siteId, user, conversation }, provider) {
  const { model, prices, signal, deadline } = provider;
  const id = await beginAssistantUsage(db, { siteId, userId: user.id, model, signal });
  let payload, failure;
  try {
    payload = await Promise.race([providerCompletion(conversation, provider), deadline]);
    return payload;
  } catch (error) {
    failure = signal.aborted ? 'provider_timeout' : 'provider_error';
    throw error;
  } finally {
    await finishAssistantUsage(db, id, { payload, requestedModel: model, prices, failure });
  }
}

async function completeChat(db, { siteId, user, lang, conversation }, provider) {
  const toolCalls = [], toolResults = [];
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const payload = await meteredCompletion(db, { siteId, user, conversation }, provider);
    const message = payload?.choices?.[0]?.message;
    if (!message) fail('ASSISTANT_UNAVAILABLE', 'Risposta non valida del provider.', 502);
    if (!message.tool_calls?.length) {
      return { reply: String(message.content || '').trim(), citations: citationsFrom(toolCalls, toolResults),
        model: payload.model || provider.model };
    }
    conversation.push({ role: 'assistant', content: message.content || '', tool_calls: message.tool_calls });
    for (const call of message.tool_calls) {
      provider.signal.throwIfAborted();
      let args = {};
      try { args = JSON.parse(call.function?.arguments || '{}'); } catch { args = {}; }
      let result;
      try { result = await runTool(db, { siteId, user }, call.function?.name, args); }
      catch (error) { result = { error: error.code || 'TOOL_ERROR', message: error.message }; }
      toolCalls.push({ name: call.function?.name, args });
      toolResults.push(result);
      conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 8000) });
    }
  }
  return { reply: lang === 'en' ? 'I could not answer with the available data. Try narrowing the question.'
    : 'Non riesco a chiudere la risposta con i dati disponibili. Prova a restringere la domanda.',
    citations: citationsFrom(toolCalls, toolResults), model: provider.model };
}
