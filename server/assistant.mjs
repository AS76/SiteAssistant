// In-app assistant: a server-side proxy to the model with a small, read-only tool set.
// The key never reaches the browser, every query is scoped to one site and the caller's
// role, and the model can only read: writes stay in the forms the user confirms.
import { RepositoryError, requireRole } from './repository.mjs';

const fail = (code, message, status = 400) => { throw new RepositoryError(status, message, code); };
const DEFAULT_BASE = process.env.ASSISTANT_BASE_URL || 'https://api.deepseek.com';
const DEFAULT_MODEL = process.env.ASSISTANT_MODEL || 'deepseek-flash';
const MAX_TOOL_ROUNDS = 4;
const MAX_ROWS = 20;

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

const SYSTEM = `Sei l'assistente dentro SiteAssistant, un gestionale di cantiere. Rispondi in italiano, breve e concreto.
Regole non negoziabili:
- Usa solo i dati che ottieni dai tool. Se un dato non c'è, dillo: "non risulta nei dati".
- Cita sempre i record che usi con il loro codice tra parentesi quadre, per esempio [DEV-014] o [WBS 2.1].
- Non inventare numeri, stati, date o nomi. Non dedurre un totale che non hai calcolato.
- Non puoi scrivere: se l'utente chiede di modificare qualcosa, spiega quale schermata aprire.
- Massimo 120 parole, salvo richiesta esplicita di dettaglio.`;

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
  const family = FAMILIES[args?.family];
  if (name !== 'sum_hours' && !family) fail('UNKNOWN_FAMILY', 'Famiglia non supportata.');
  await requireRole(db, siteId, user);
  if (name === 'find_records') {
    const limit = Math.min(Number(args.limit) || 10, MAX_ROWS);
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
  if (name === 'sum_hours') {
    if (args.by_item) {
      const rows = await db.all(`SELECT site_progress_item_id, SUM(hours) AS hours FROM time_bookings
        WHERE site_id = ? GROUP BY site_progress_item_id ORDER BY hours DESC LIMIT ${MAX_ROWS}`, siteId);
      return { by_item: rows.map(row => ({ item_id: row.site_progress_item_id, hours: Number(row.hours) })) };
    }
    const row = await db.get('SELECT COALESCE(SUM(hours), 0) AS hours FROM time_bookings WHERE site_id = ?', siteId);
    return { total_hours: Number(row.hours) };
  }
  fail('UNKNOWN_TOOL', 'Strumento non disponibile.');
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

export async function chat(db, { siteId, user, messages, view }, { fetchImpl = fetch, apiKey = process.env.DEEPSEEK_API_KEY,
  baseUrl = DEFAULT_BASE, model = DEFAULT_MODEL } = {}) {
  if (!user?.id) fail('UNAUTHENTICATED', 'Authentication required.', 401);
  if (!apiKey) fail('ASSISTANT_NOT_CONFIGURED', 'Assistente non configurato.', 503);
  await requireRole(db, siteId, user);
  if (!allowRequest(user.id)) fail('ASSISTANT_RATE_LIMITED', 'Troppe richieste: riprova tra qualche minuto.', 429);
  const history = (Array.isArray(messages) ? messages : []).slice(-8)
    .filter(message => ['user', 'assistant'].includes(message?.role) && typeof message.content === 'string')
    .map(message => ({ role: message.role, content: message.content.slice(0, 4000) }));
  if (!history.length) fail('INVALID_MESSAGES', 'Serve almeno un messaggio.');

  const conversation = [{ role: 'system', content: `${SYSTEM}\nVista corrente dell'utente: ${view || 'panoramica'}.` }, ...history];
  const toolCalls = [], toolResults = [];
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: conversation, tools: TOOLS, tool_choice: 'auto', temperature: 0.2, max_tokens: 700 }),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) fail('ASSISTANT_AUTH', 'Chiave del provider non valida.', 503);
      if (response.status === 429) fail('ASSISTANT_RATE_LIMITED', 'Provider occupato: riprova.', 429);
      fail('ASSISTANT_UNAVAILABLE', 'Assistente non disponibile.', 502);
    }
    const payload = await response.json();
    const message = payload?.choices?.[0]?.message;
    if (!message) fail('ASSISTANT_UNAVAILABLE', 'Risposta non valida del provider.', 502);
    if (!message.tool_calls?.length) {
      return { reply: String(message.content || '').trim(), citations: citationsFrom(toolCalls, toolResults),
        model: payload.model || model, usage: payload.usage || null };
    }
    conversation.push({ role: 'assistant', content: message.content || '', tool_calls: message.tool_calls });
    for (const call of message.tool_calls) {
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
  return { reply: 'Non riesco a chiudere la risposta con i dati disponibili. Prova a restringere la domanda.',
    citations: citationsFrom(toolCalls, toolResults), model, usage: null };
}
