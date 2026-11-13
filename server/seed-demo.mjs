// Demo dataset for the two synthetic sites (FITT-01, FITT-02).
// Every identifier is derived from a fixed namespace, so re-running upserts the same rows
// and `--reset` removes exactly what this script created. No real people, sites or emails.
//
// Usage:
//   node server/seed-demo.mjs            # dry run: prints the plan
//   node server/seed-demo.mjs --apply    # write the rows
//   node server/seed-demo.mjs --reset    # delete only the rows created here
import { createHash } from 'node:crypto';
import process from 'node:process';
import { openDb, closeDb } from './db.mjs';
import { migrate } from './migrations/index.mjs';

const NS = '6d1f7c42-8f0e-4a4c-9d2b0f7a2c9d1e3f';
const at = '2026-11-01T08:00:00.000Z';
const id = name => {
  const hash = createHash('sha1').update(`${NS}:${name}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};
const date = (offsetDays, base = '2026-10-19') => {
  const value = new Date(`${base}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + offsetDays);
  return value.toISOString().slice(0, 10);
};

const SITES = ['FITT-01', 'FITT-02', 'FITT-03', 'FITT-04'];

// Four different stories: a large site well advanced, a bridge just started, a small site
// only begun, and a finished one. Same synthetic namespace, different shape.
const SITE_META = {
  'FITT-01': { name: 'Cantiere dimostrativo Borgo Nuvolario', location: 'Comune immaginario di Nuvolario, area A', start: '2026-11-01', end: '2026-12-20', weeks: 3, diary: 12 },
  'FITT-02': { name: 'Cantiere dimostrativo Ponte dei Sogni Blu', location: 'Comune immaginario di Sognalba, area B', start: '2026-11-02', end: '2026-12-22', weeks: 3, diary: 10 },
  'FITT-03': { name: 'Cantiere dimostrativo Viale dei Mille', location: 'Comune immaginario di Vialba, area C', start: '2026-11-09', end: '2027-01-30', weeks: 1, diary: 4 },
  'FITT-04': { name: 'Cantiere dimostrativo Magazzino Levante', location: 'Comune immaginario di Levante, area D', start: '2026-08-03', end: '2026-10-30', weeks: 3, diary: 8 },
};

const TASK_PROFILES = {
  'FITT-01': ['todo', 'todo', 'todo', 'todo', 'in_progress', 'in_progress', 'in_progress', 'to_verify', 'to_verify', 'to_verify', 'closed', 'closed', 'closed', 'closed', 'closed', 'blocked'],
  'FITT-02': ['todo', 'todo', 'todo', 'in_progress', 'in_progress', 'to_verify', 'closed', 'closed', 'closed', 'blocked'],
  'FITT-03': ['todo', 'todo', 'todo', 'todo', 'todo', 'todo', 'in_progress', 'in_progress'],
  'FITT-04': ['closed', 'closed', 'closed', 'closed', 'closed', 'closed', 'closed', 'to_verify', 'closed', 'closed'],
};

const WBS = {
  'FITT-01': [['1', 'Impianto di smistamento', 0, null], ['1.1', 'Linea A', 1, '1'], ['1.2', 'Linea B', 1, '1'],
    ['2', 'Opere civili', 0, null], ['2.1', 'Fondazioni', 1, '2'], ['2.2', 'Strutture', 1, '2'],
    ['3', 'Impianti elettrici', 0, null], ['3.1', 'Quadri elettrici', 1, '3'], ['3.2', 'Cablaggi', 1, '3']],
  'FITT-02': [['1', 'Struttura principale', 0, null], ['1.1', 'Campate', 1, '1'], ['1.2', 'Copertura', 1, '1'],
    ['2', 'Viabilità', 0, null], ['2.1', 'Accessi', 1, '2']],
};

const WBS_NEW = {
  'FITT-03': [['1', 'Corpo di fabbrica', 0, null], ['1.1', 'Fondazioni', 1, '1'], ['1.2', 'Elevazioni', 1, '1'],
    ['2', 'Copertura', 0, null], ['2.1', 'Tralicci', 1, '2']],
  'FITT-04': [['1', 'Magazzino', 0, null], ['1.1', 'Struttura portante', 1, '1'], ['1.2', 'Pavimentazioni', 1, '1'],
    ['2', 'Impianti', 0, null], ['2.1', 'Elettrico', 1, '2'], ['2.2', 'Antincendio', 1, '2'],
    ['3', 'Esterni', 0, null], ['3.1', 'Piazzale', 1, '3']],
};

Object.assign(WBS, WBS_NEW);

const TYPES = {
  'FITT-01': [{ code: 'MONT', name: 'Montaggio impianti', steps: [['PREL', 'Opere preliminari', 20], ['STRUT', 'Montaggio strutture', 40], ['CABL', 'Cablaggi', 25], ['COLL', 'Collaudo', 15]] },
    { code: 'CIV', name: 'Opere civili', steps: [['SCAVI', 'Scavi', 25], ['FOND', 'Fondazioni', 45], ['STRUTT', 'Strutture', 30]] }],
  'FITT-02': [{ code: 'PONTE', name: 'Opere da ponte', steps: [['PILE', 'Pile', 35], ['IMPALC', 'Impalcato', 45], ['FINIT', 'Finiture', 20]] }],
  'FITT-03': [{ code: 'CIVNEW', name: 'Opere civili', steps: [['SCAVI', 'Scavi', 30], ['FOND', 'Fondazioni', 40], ['ELEV', 'Elevazioni', 30]] }],
  'FITT-04': [{ code: 'MAG', name: 'Magazzino', steps: [['STRUTT', 'Struttura', 40], ['IMPIANTI', 'Impianti', 35], ['FINIT', 'Finitura', 25]] }],
};

const ITEMS = {
  'FITT-01': [
    ['Montaggio rulliere linea A', '1.1', 'Linea A', 'Area 1', 100], ['Montaggio carrelli linea A', '1.1', 'Linea A', 'Area 1', 80],
    ['Allineamento guide linea A', '1.1', 'Linea A', 'Area 2', 55], ['Montaggio rulliere linea B', '1.2', 'Linea B', 'Area 3', 40],
    ['Montaggio carrelli linea B', '1.2', 'Linea B', 'Area 3', 25], ['Scavi platea', '2.1', 'Civile', 'Area 4', 100],
    ['Casseri fondazioni', '2.1', 'Civile', 'Area 4', 90], ['Getto fondazioni', '2.1', 'Civile', 'Area 5', 70],
    ['Carpenteria strutture', '2.2', 'Civile', 'Area 5', 35], ['Montaggio quadri principali', '3.1', 'Elettrico', 'Area 6', 60],
    ['Quadri secondari', '3.1', 'Elettrico', 'Area 6', 30], ['Passaggio cavi area 1', '3.2', 'Elettrico', 'Area 1', 45],
    ['Passaggio cavi area 3', '3.2', 'Elettrico', 'Area 3', 10], ['Terminali linea A', null, 'Linea A', 'Area 2', 0],
    ['Terminali linea B', null, 'Linea B', 'Area 3', 0], ['Pavimentazione zona 4', '2.2', 'Civile', 'Area 4', 20],
    ['Illuminazione area 6', '3.1', 'Elettrico', 'Area 6', 5], ['Prove a vuoto linea A', null, 'Linea A', 'Area 1', 0],
    ['Prove a vuoto linea B', null, 'Linea B', 'Area 3', 0], ['Pulizia finale', null, null, null, 0]],
  'FITT-02': [
    ['Scavi pile 1-3', '1.1', 'Ponte', 'Area A', 100], ['Armature pile 1-3', '1.1', 'Ponte', 'Area A', 85],
    ['Getto pile 1-3', '1.1', 'Ponte', 'Area A', 60], ['Impalcato campata 1', '1.2', 'Ponte', 'Area B', 30],
    ['Impalcato campata 2', '1.2', 'Ponte', 'Area B', 10], ['Accesso lato nord', '2.1', 'Viabilità', 'Area C', 50],
    ['Accesso lato sud', '2.1', 'Viabilità', 'Area C', 20], ['Impermeabilizzazione', null, 'Ponte', 'Area B', 0]],
  'FITT-03': [
    ['Scavo di sbancamento', '1.1', 'Civile', 'Area C1', 60], ['Magrone di sottofondo', '1.1', 'Civile', 'Area C1', 25],
    ['Armature plinti', '1.1', 'Civile', 'Area C2', 0], ['Getto plinti', '1.1', 'Civile', 'Area C2', 0],
    ['Predisposizione impianti', '1.2', 'Impianti', 'Area C2', 0], ['Tralicci copertura', '2.1', 'Civile', 'Area C3', 0],
    ['Approntamento cantiere', null, 'Logistica', 'Area C0', 100], ['Recinzione e accessi', null, 'Logistica', 'Area C0', 80]],
  'FITT-04': [
    ['Montaggio struttura portante', '1.1', 'Civile', 'Area D1', 100], ['Saldature secondarie', '1.1', 'Civile', 'Area D1', 100],
    ['Pavimentazione industriale', '1.2', 'Civile', 'Area D2', 100], ['Quadri elettrici', '2.1', 'Impianti', 'Area D3', 100],
    ['Impianto antincendio', '2.2', 'Impianti', 'Area D3', 95], ['Piazzale esterno', '3.1', 'Esterni', 'Area D4', 90],
    ['Collaudo impianti', null, 'Impianti', 'Area D3', 80], ['Consegna documentazione', null, 'Civile', 'Area D1', 70]],
};

const EMPLOYEES = {
  'FITT-01': [['SIN-01', 'Ada', 'Rossi'], ['SIN-02', 'Bruno', 'Verdi'], ['SIN-03', 'Carla', 'Bianchi'], ['SIN-04', 'Dario', 'Neri'],
    ['SIN-05', 'Elena', 'Galli'], ['SIN-06', 'Fabio', 'Conti'], ['SIN-07', 'Gina', 'Ferri'], ['SIN-08', 'Ivan', 'Riva']],
  'FITT-02': [['SIN-11', 'Luca', 'Sala'], ['SIN-12', 'Mara', 'Tosi'], ['SIN-13', 'Nino', 'Villa'], ['SIN-14', 'Olga', 'Pini']],
  'FITT-03': [['SIN-21', 'Pietro', 'Amato'], ['SIN-22', 'Rosa', 'Costa'], ['SIN-23', 'Sergio', 'Fabbri']],
  'FITT-04': [['SIN-31', 'Teresa', 'Greco'], ['SIN-32', 'Umberto', 'Lombardi'], ['SIN-33', 'Vera', 'Marchetti'],
    ['SIN-34', 'Walter', 'Ortolani'], ['SIN-35', 'Xenia', 'Pellegrini'], ['SIN-36', 'Zeno', 'Ricci']],
};

const DEVIATIONS = {
  'FITT-01': [['open', 'high'], ['open', 'medium'], ['open', 'low'], ['approved', 'high'], ['approved', 'medium'],
    ['in_progress', 'high'], ['in_progress', 'medium'], ['work_completed', 'medium'], ['work_completed', 'low'],
    ['closed', 'high'], ['closed', 'low'], ['rejected', 'low']],
  'FITT-02': [['open', 'medium'], ['in_progress', 'high'], ['closed', 'low'], ['rejected', 'low']],
  'FITT-03': [['open', 'medium'], ['open', 'high'], ['approved', 'low']],
  'FITT-04': [['closed', 'high'], ['closed', 'medium'], ['closed', 'low'], ['closed', 'high'], ['closed', 'low'], ['rejected', 'low']],
};

const IMPACTS = {
  'FITT-01': [['open', 12500.5, null, null], ['open', 4200, null, null], ['notification_sent', 9800, null, null], ['closed', 15000, 11250, 'settled']],
  'FITT-02': [['open', 6000, null, null], ['closed', 3500, 0, 'dropped']],
  'FITT-03': [['open', 2400, null, null]],
  'FITT-04': [['closed', 8000, 7200, 'settled'], ['closed', 1200, 0, 'dropped']],
};


// Health and safety register: realistic near misses of the trade, no health data and no names.
// Categories follow what construction near-miss literature lists most often: dropped objects,
// plant movements, fall protection, housekeeping, temporary electrical supply.
const HSE = {
  'FITT-01': [
    ['near_miss', 'low', 2, 'Passerella di servizio linea A', null, 'Caduta di un bullone dalla passerella mentre si serrava una flangia. Nessuno sotto nel momento della caduta.',
      'Il bullone è caduto dentro la zona di lavoro delimitata; nessuna persona presente.'],
    ['near_miss', 'medium', 3, 'Corsia mezzi area 4', null, 'Carrello elevatore in retromarcia senza segnalatore acustico: un operatore si è spostato per tempo.',
      'Il segnalatore era disinserito. Percorso pedonale e carraio non separati in quel tratto.'],
    ['observation', 'low', 4, 'Ponteggi area 2', null, 'Ponteggio privo di cartello di portata massima sul lato est.',
      'Cartello presente sugli altri tre lati, mancante su quello aggiunto la settimana precedente.'],
    ['near_miss', 'high', 5, 'Area di sollevamento linea A', null, 'Il carico sospeso ha oscillato oltre l\'area interdetta, passando sopra il corridoio pedonale.',
      'Raffica di vento durante il sollevamento. Area interdetta troppo stretta per la geometria del carico.'],
    ['accident', 'medium', 7, 'Area montaggio carrelli', 1, 'Taglio superficiale alla mano durante la posa di lamierato grecato.',
      'Guanto destro tagliato sul bordo lamiera; medicazione in cantiere, nessun ricorso a struttura sanitaria.'],
    ['observation', 'medium', 9, 'Vano scale area 5', null, 'Illuminazione insufficiente nel vano scale: due lampade su cinque non funzionanti.',
      'Segnalato dall\'impresa di finiture durante il sopralluogo serale.'],
    ['near_miss', 'low', 11, 'Passaggio pedonale area 1', null, 'Prolunga elettrica attraversava il passaggio pedonale senza canalina di protezione.',
      'Cavo di alimentazione di una levigatrice, posato temporaneamente.'],
    ['near_miss', 'medium', 13, 'Area 6 quadri elettrici', null, 'Scala a pioli usata come appoggio su pavimento irregolare: si è ribaltata a vuoto.',
      'Nessuno sulla scala. Superficie con residui di malta.'],
  ],
  'FITT-02': [
    ['near_miss', 'high', 1, 'Impalcato campata 1', null, 'Caduta di un casseruola in legno dall\'impalcato verso l\'area sottostante.',
      'Elemento scivolato oltre il bordo privo di tavola fermapiede nel tratto in lavorazione.'],
    ['observation', 'low', 2, 'Accesso impalcato lato sud', null, 'Linea vita non installata per un tratto di tre metri all\'accesso dell\'impalcato.',
      'Tratto in attesa di installazione; segnalato con nastro.'],
    ['near_miss', 'medium', 4, 'Bordo scavo area A', null, 'Mezzo d\'opera in manovra a meno di un metro dal ciglio dello scavo non protetto.',
      'Manovra di accostamento per scarico materiale, senza segnalazione a terra.'],
    ['accident', 'low', 6, 'Area A armature', 1, 'Contusione lieve al ginocchio per inciampo su armatura non segnalata.',
      'Ferramenta lasciata fuori dalla zona di stoccaggio; nessun giorno di assenza.'],
  ],
  'FITT-03': [
    ['observation', 'medium', 1, 'Perimetro cantiere lato nord', null, 'Recinzione di cantiere incompleta: un pannello mancante consente l\'accesso dalla strada.',
      'Pannello rimosso per il passaggio di un mezzo e non riposizionato.'],
    ['near_miss', 'low', 2, 'Area di scavo C1', null, 'Un passante ha oltrepassato il nastro di delimitazione dello scavo aperto.',
      'Nastro abbassato e non riposizionato dopo il turno precedente.'],
    ['near_miss', 'medium', 3, 'Area taglio materiali', null, 'Taglio di blocchi senza bagnatura: polvere diffusa verso l\'area di transito.',
      'Nebulizzatore non collegato alla rete idrica del cantiere.'],
  ],
  'FITT-04': [
    ['accident', 'medium', 2, 'Pedana area D2', 1, 'Distorsione alla caviglia scendendo da una pedana priva di gradino.',
      'Pedana di servizio senza rampa; valutazione medica senza giorni di assenza.'],
    ['near_miss', 'medium', 5, 'Area D3 impianti', null, 'Pannello antincendio movimentato senza cinghie di contenimento su bancale.',
      'Bancale non idoneo al peso del pannello.'],
    ['observation', 'low', 7, 'Area D3 impianti', null, 'Estintori presenti ma non segnalati con cartello di posizione.',
      'Segnaletica rimossa durante la tinteggiatura.'],
    ['near_miss', 'high', 9, 'Area montaggio quadri', null, 'Carico sospeso transitato sopra la zona di montaggio dei quadri elettrici.',
      'Coordinamento sollevamenti non aggiornato dopo lo spostamento dell\'area di montaggio.'],
    ['observation', 'low', 12, 'Area D1 ufficio cantiere', null, 'Documentazione di collaudo non disponibile in cantiere, solo in sede.',
      'Copia cartacea non aggiornata; il fascicolo digitale non era accessibile dal cantiere.'],
  ],
};

// Diary entries per site: plan, what happened, impediments, next step.
const DIARY = {
  'FITT-01': [
    ['Montaggio rulliere linea A e serraggio flange.', 'Completato il tratto 1-4; resta il tratto 5 per domani.', null, 'Completare il tratto 5 e iniziare l\'allineamento.'],
    ['Allineamento guide linea A.', 'Allineamento eseguito su tre campate, tolleranze entro 2 mm.', 'Mancava la dima per la quarta campata.', 'Recuperare la dima e chiudere la quarta campata.'],
    ['Getto fondazioni area 4.', 'Getto completato, maturazione in corso.', 'Fornaitura arrivata con due ore di ritardo.', 'Disarmo previsto tra due giorni.'],
    ['Montaggio quadri secondari.', 'Installati quattro quadri su sei.', null, 'Completare i due quadri restanti.'],
  ],
  'FITT-02': [
    ['Armature pile 1-3.', 'Armature chiuse, controllate dal direttore dei lavori.', null, 'Preparare il getto per domani.'],
    ['Getto pile 1-3.', 'Getto eseguito in due fasi, provini prelevati.', 'Bettoniera in avaria a metà turno, sostituita.', 'Controllo maturazione e disarmo casseri.'],
    ['Impalcato campata 1.', 'Posizionati i primi tre elementi.', 'Vento forte nel pomeriggio: sospensione dei sollevamenti.', 'Riprendere con il quarto elemento.'],
  ],
  'FITT-03': [
    ['Scavo di sbancamento area C1.', 'Scavato circa il 60 per cento dell\'area.', 'Mezzo fermo per perdita idraulica.', 'Ripresa dello scavo con il secondo mezzo.'],
    ['Magrone di sottofondo.', 'Getto eseguito su metà area.', null, 'Completare il magrone e tracciare i plinti.'],
  ],
  'FITT-04': [
    ['Collaudo impianti elettrici.', 'Prove effettuate su tre quadri su quattro.', 'Manca la dichiarazione di conformità di un quadro.', 'Recuperare la dichiarazione e chiudere le prove.'],
    ['Consegna documentazione.', 'Raccolta quasi completa, mancano gli as-built degli esterni.', null, 'Chiudere gli as-built e consegnare il fascicolo.'],
  ],
};

const TASK_STATUSES = ['todo', 'todo', 'todo', 'todo', 'in_progress', 'in_progress', 'in_progress', 'to_verify', 'to_verify', 'to_verify', 'closed', 'closed', 'closed', 'closed', 'closed', 'blocked'];

export function plan() {
  return { SITES, WBS, TYPES, ITEMS, EMPLOYEES, DEVIATIONS, IMPACTS, taskStatuses: TASK_STATUSES.length };
}

async function reset(db) {
  const sites = await db.all(`SELECT id, code FROM sites WHERE code IN (${SITES.map(() => '?').join(', ')})`, ...SITES);
  let removed = 0;
  for (const site of sites) {
    for (const [table, column] of [['site_progress_item_steps', null], ['employee_certifications', 'site_id'], ['time_bookings', 'site_id'], ['cost_impact_deviations', null],
      ['cost_impacts', 'site_id'], ['deviations', 'site_id'], ['site_progress_items', 'site_id'], ['progress_type_steps', null],
      ['progress_types', 'site_id'], ['work_days', 'site_id'], ['employees', 'site_id'], ['project_structure', 'site_id'],
      ['task_events', null], ['tasks', 'site_id'], ['diary', 'site_id']]) {
      const sql = column
        ? `DELETE FROM ${table} WHERE ${column} = ?`
        : table === 'site_progress_item_steps'
          ? `DELETE FROM site_progress_item_steps WHERE site_progress_item_id IN (SELECT id FROM site_progress_items WHERE site_id = ?)`
          : table === 'progress_type_steps'
            ? `DELETE FROM progress_type_steps WHERE progress_type_id IN (SELECT id FROM progress_types WHERE site_id = ?)`
            : table === 'cost_impact_deviations'
              ? `DELETE FROM cost_impact_deviations WHERE cost_impact_id IN (SELECT id FROM cost_impacts WHERE site_id = ?)`
              : `DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE site_id = ?)`;
      const result = await db.run(sql, site.id);
      removed += Number(result?.rowCount ?? 0);
    }
  }
  return removed;
}

export async function apply(db) {
  const counts = {};
  const bump = key => { counts[key] = (counts[key] || 0) + 1; };
  for (const code of SITES) {
    const meta = SITE_META[code];
    await db.run(`INSERT INTO sites (id, code, name, location, start_date, end_date, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (code) DO NOTHING`,
    id(`${code}:site`), code, meta.name, meta.location, meta.start, meta.end, at);
    const site = await db.get('SELECT id FROM sites WHERE code = ?', code);
    if (!site) throw new Error(`Missing synthetic site ${code}`);
    const siteId = site.id;
    const at2 = at;

    const wbsIds = new Map();
    for (const [index, [wbsCode, description, level, parentCode]] of WBS[code].entries()) {
      const nodeId = id(`${code}:wbs:${wbsCode}`);
      wbsIds.set(wbsCode, nodeId);
      await db.run(`INSERT INTO project_structure (id, site_id, parent_id, wbs_code, description, level, sort_order, is_synthetic, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, FALSE, ?) ON CONFLICT (id) DO UPDATE SET description = excluded.description,
        parent_id = excluded.parent_id, level = excluded.level, sort_order = excluded.sort_order`,
      nodeId, siteId, parentCode ? wbsIds.get(parentCode) ?? null : null, wbsCode, description, level, index + 1, at2);
      bump('wbs');
    }

    const typeIds = {};
    for (const type of TYPES[code]) {
      const typeId = id(`${code}:type:${type.code}`);
      typeIds[type.code] = { id: typeId, steps: [] };
      await db.run(`INSERT INTO progress_types (id, site_id, code, name, created_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET name = excluded.name`, typeId, siteId, type.code, type.name, at2);
      bump('types');
      for (const [position, [stepCode, description, weight]] of type.steps.entries()) {
        const stepId = id(`${code}:step:${type.code}:${stepCode}`);
        typeIds[type.code].steps.push({ id: stepId, weight });
        await db.run(`INSERT INTO progress_type_steps (id, progress_type_id, position, code, description, weight)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET weight = excluded.weight, description = excluded.description`,
        stepId, typeId, position + 1, stepCode, description, weight);
        bump('typeSteps');
      }
    }

    const employeeIds = [];
    for (const [employeeNo, firstName, lastName] of EMPLOYEES[code]) {
      const employeeId = id(`${code}:employee:${employeeNo}`);
      employeeIds.push(employeeId);
      await db.run(`INSERT INTO employees (id, site_id, employee_no, first_name, last_name, created_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET first_name = excluded.first_name, last_name = excluded.last_name`,
      employeeId, siteId, employeeNo, firstName, lastName, at2);
      bump('employees');
    }

    // Personnel fitness records: the picture a site clerk actually needs to see — a few
    // already expired, a few about to lapse, most valid, one without any expiry.
    const todayIso = () => new Date().toISOString().slice(0, 10);
    const todayPlus = days => { const value = new Date(`${todayIso()}T12:00:00.000Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); };
    const certPlan = [
      ['qualification', 'Patentino PLE', 'Ente certificatore sintetico', -400, -120],
      ['medical', 'Visita medica periodica', 'Medico competente sintetico', -370, -10],
      ['training', 'Corso sicurezza 4 ore', 'Ente formazione sintetico', -370, -1],
      ['medical', 'Visita medica periodica', 'Medico competente sintetico', -360, 5],
      ['qualification', 'Abilitazione gru', 'Ente certificatore sintetico', -344, 18],
      ['training', 'Formazione primo soccorso', 'Ente formazione sintetico', -350, 30],
      ['medical', 'Visita medica periodica', 'Medico competente sintetico', -160, 200],
      ['qualification', 'Patentino carrello elevatore', 'Ente certificatore sintetico', -200, 365],
      ['training', 'Corso PES-PAV', 'Ente formazione sintetico', -120, 540],
      ['qualification', 'Abilitazione ponteggi', 'Ente certificatore sintetico', -90, 800],
      ['medical', 'Visita medica periodica', 'Medico competente sintetico', -30, 1200],
      ['training', 'Formazione anticaduta', 'Ente formazione sintetico', -600, null],
    ];
    for (const [index, [category, name, issuer, issuedOffset, expiresOffset]] of certPlan.entries()) {
      const employeeId = employeeIds[index % employeeIds.length];
      if (!employeeId) break;
      const certId = id(`${code}:cert:${index}:${category}`);
      await db.run(`INSERT INTO employee_certifications
        (id, site_id, employee_id, category, name, issuer, issued_on, expires_on, outcome, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
        ON CONFLICT (id) DO UPDATE SET name = excluded.name, expires_on = excluded.expires_on`,
      certId, siteId, employeeId, category, name, issuer,
      todayPlus(issuedOffset), expiresOffset == null ? null : todayPlus(expiresOffset),
      category === 'medical' ? 'Idoneo' : null, at2, at2);
      bump('certifications');
    }

    const workDays = [];
    for (let week = 0; week < (SITE_META[code].weeks || 3); week++) {
      for (let day = 0; day < 5; day++) {
        const operationalDate = date(week * 7 + day);
        for (const [index, employeeId] of employeeIds.entries()) {
          const night = index % 4 === 3;
          const workDayId = id(`${code}:day:${employeeId}:${operationalDate}`);
          workDays.push({ id: workDayId, employeeId, operationalDate });
          await db.run(`INSERT INTO work_days (id, site_id, employee_id, operational_date, shift, start_time, finish_time, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
          workDayId, siteId, employeeId, operationalDate, night ? 'night' : 'day', night ? '22:00' : '06:00', night ? '06:00' : '14:00', at2);
          bump('workDays');
        }
      }
    }

    const itemIds = [];
    for (const [index, [description, wbsCode, section, area, progress]] of ITEMS[code].entries()) {
      const itemId = id(`${code}:item:${index + 1}`);
      itemIds.push(itemId);
      const typeCode = index % 3 === 0 ? TYPES[code][0].code : index % 3 === 1 ? TYPES[code][TYPES[code].length - 1].code : null;
      await db.run(`INSERT INTO site_progress_items (id, site_id, wbs_id, description, section, plc_area, progress_pct,
          planned_progress_pct, assigned_to, planned_start, planned_finish, has_files, has_notes, has_deviations, source_row, created_at, progress_type_id, planned_hours)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET description = excluded.description, progress_pct = excluded.progress_pct,
          wbs_id = excluded.wbs_id, progress_type_id = excluded.progress_type_id, planned_hours = excluded.planned_hours`,
      itemId, siteId, wbsCode ? wbsIds.get(wbsCode) ?? null : null, description, section, area, progress,
      Math.min(100, progress + 10), 'Squadra sintetica', '2026-10-19', '2026-12-20', index % 5 === 0, index % 7 === 0, index % 6 === 0,
      index + 1, at2, typeCode ? typeIds[typeCode].id : null, 40 * (1 + index % 10));
      bump('items');
      if (typeCode) {
        const stepCount = typeIds[typeCode].steps.length;
        for (const [stepIndex, step] of typeIds[typeCode].steps.entries()) {
          // Linear ramp: each step is completed in order, so the weighted result tracks the imported value.
          const percent = Math.max(0, Math.min(100, Math.round((progress - stepIndex * (100 / stepCount)) * stepCount)));
          await db.run(`INSERT INTO site_progress_item_steps (id, site_progress_item_id, progress_type_step_id, percent, updated_at)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET percent = excluded.percent`,
          id(`${code}:state:${index + 1}:${step.id}`), itemId, step.id, percent, at2);
          bump('itemSteps');
        }
      }
    }

    // History for the curves: weekly step recordings from zero to the current percent.
    const typedItems = await db.all(`SELECT s.id, s.progress_type_id, st.progress_type_step_id, st.percent
      FROM site_progress_items s JOIN site_progress_item_steps st ON st.site_progress_item_id = s.id
      WHERE s.site_id = ? AND s.progress_type_id IS NOT NULL`, siteId);
    for (const row of typedItems) {
      for (let week = 6; week >= 0; week--) {
        const target = Math.round(Number(row.percent) * (7 - week) / 7);
        const recordedAt = new Date(`${date(week * 7)}T16:00:00.000Z`).toISOString();
        await db.run(`INSERT INTO progress_entries
          (id, site_id, site_progress_item_id, progress_type_step_id, percent, recorded_at, recorded_by)
          VALUES (?, ?, ?, ?, ?, ?, NULL) ON CONFLICT (id) DO NOTHING`,
        id(`${code}:history:${row.id}:${row.progress_type_step_id}:${week}`), siteId, row.id,
        row.progress_type_step_id, target, recordedAt);
        bump('progressEntries');
      }
    }

    // Bookings: one per work day, rotating over the first few items.
    for (const [index, workDay] of workDays.entries()) {
      if (index % 3 === 2) continue;
      const itemId = itemIds[index % Math.min(itemIds.length, 8)];
      const hours = [2, 3.5, 4, 6, 7.5][index % 5];
      await db.run(`INSERT INTO time_bookings (id, site_id, work_day_id, site_progress_item_id, hours, created_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET hours = excluded.hours`,
      id(`${code}:booking:${workDay.id}:${itemId}`), siteId, workDay.id, itemId, hours, at2);
      bump('bookings');
    }

    const deviationIds = [];
    for (const [index, [status, priority]] of DEVIATIONS[code].entries()) {
      const deviationId = id(`${code}:deviation:${index + 1}`);
      deviationIds.push(deviationId);
      await db.run(`INSERT INTO deviations (id, site_id, deviation_no, title, problem_description, status, priority, assigned_to,
          creation_date, closed_date, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET status = excluded.status, title = excluded.title`,
      deviationId, siteId, `DEV-${String(index + 1).padStart(3, '0')}`, `Deviazione sintetica ${index + 1}`,
      'Descrizione sintetica della deviazione.', status, priority, 'Squadra sintetica',
      date(index), status === 'closed' ? date(index + 3) : null, at2);
      bump('deviations');
    }

    for (const [index, [status, claim, settlement, result]] of IMPACTS[code].entries()) {
      const impactId = id(`${code}:impact:${index + 1}`);
      await db.run(`INSERT INTO cost_impacts (id, site_id, title, status, claim_amount, settlement_amount, result, created_at, closed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET status = excluded.status,
        claim_amount = excluded.claim_amount, settlement_amount = excluded.settlement_amount, result = excluded.result`,
      impactId, siteId, `Claim sintetico ${index + 1}`, status, claim, settlement, result, at2, status === 'closed' ? at2 : null);
      bump('impacts');
      await db.run(`INSERT INTO cost_impact_deviations (cost_impact_id, deviation_id) VALUES (?, ?) ON CONFLICT DO NOTHING`,
        impactId, deviationIds[index % deviationIds.length]);
    }

    for (const [index, [type, severity, dayOffset, location, persons, measures, notes]] of (HSE[code] || []).entries()) {
      const eventId = id(`${code}:hse:${index + 1}`);
      await db.run(`INSERT INTO hse_events (id, site_id, event_no, type, severity, occurred_on, location, persons_involved, measures, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET type = excluded.type, severity = excluded.severity, measures = excluded.measures, notes = excluded.notes`,
      eventId, siteId, `HSE-${String(index + 1).padStart(3, '0')}`, type, severity, date(dayOffset), location, persons, measures, notes, at2, at2);
      bump('hse');
    }

    const titles = ['Verifica planimetrie', 'Consegna materiale area 1', 'Coordinate con subappaltatore', 'Prova di carico',
      'Aggiornamento cronoprogramma', 'Pulizia area di lavoro', 'Controllo serraggi', 'Rilievo quote', 'Riunione sicurezza',
      'Approvvigionamento cavi', 'Verifica quadri', 'Collaudo parziale', 'Documentazione fotografica', 'Segnalazione ostacolo',
      'Verifica accessi', 'Formazione squadra'];
    const taskStatuses = TASK_PROFILES[code] || TASK_STATUSES;
    for (let index = 0; index < taskStatuses.length; index++) {
      const taskId = id(`${code}:task:${index + 1}`);
      const status = taskStatuses[index];
      await db.run(`INSERT INTO tasks (id, site_id, title, area, company, executor, verifier, priority, due_date, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET status = excluded.status, title = excluded.title`,
      taskId, siteId, titles[index % titles.length], 'Area ' + (index % 6 + 1), 'Impresa sintetica', 'Squadra sintetica',
      'Verifica sintetica', ['low', 'medium', 'high'][index % 3], date(2 + index), status, at2);
      bump('tasks');
      if (status !== 'todo') {
        await db.run(`INSERT INTO task_events (task_id, at, actor, from_status, to_status) VALUES (?, ?, ?, 'todo', ?)`,
          taskId, at2, 'Squadra sintetica', status);
      }
    }

    const diaryTexts = DIARY[code] || [];
    for (let index = 0; index < (SITE_META[code].diary || 12); index++) {
      const operationalDate = date(index + Math.floor(index / 5) * 2 - (SITE_META[code].weeks ? 0 : 0));
      const shift = index % 5 === 4 ? 'night' : 'day';
      const [dPlan, dActual, dImp, dNext] = diaryTexts[index % Math.max(1, diaryTexts.length)] || [];
      await db.run(`INSERT INTO diary (id, site_id, operational_date, shift, plan, actual, impediments, next_step, created_at, time_zone, day_cutoff_time)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Europe/Rome', '06:00')
        ON CONFLICT (id) DO UPDATE SET actual = excluded.actual`,
      id(`${code}:diary:${operationalDate}:${shift}`), siteId, operationalDate, shift,
      dPlan || 'Piano sintetico della giornata: montaggi e verifiche.',
      dActual || 'Eseguito quanto previsto, con lievi ritardi.',
      dImp ?? (index % 4 === 0 ? 'Materiale in ritardo dal fornitore.' : null),
      dNext || 'Proseguire secondo cronoprogramma.', at2);
      bump('diary');
    }
  }
  // Membership: whoever owns the first synthetic site gets the same role on the others, so the
  // extra sites are visible to the same account that already uses the demo.
  const reference = await db.get('SELECT id FROM sites WHERE code = ?', SITES[0]);
  if (reference) {
    const members = await db.all('SELECT user_id, role FROM site_members WHERE site_id = ?', reference.id);
    for (const code of SITES.slice(1)) {
      const site = await db.get('SELECT id FROM sites WHERE code = ?', code);
      if (!site) continue;
      for (const member of members) {
        await db.run('INSERT INTO site_members (site_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
          site.id, member.user_id, member.role);
        bump('members');
      }
    }
  }
  return counts;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const applyFlag = process.argv.includes('--apply');
  const resetFlag = process.argv.includes('--reset');
  const driver = process.env.DB_DRIVER || 'sqlite';
  const db = await openDb();
  try {
    await migrate(db, { driver });
    if (resetFlag) {
      const removed = await reset(db);
      console.log(JSON.stringify({ reset: true, removed }));
    } else if (applyFlag) {
      const counts = await db.transaction(tx => apply(tx));
      console.log(JSON.stringify({ applied: true, counts }));
    } else {
      console.log(JSON.stringify({ dryRun: true, plan: Object.fromEntries(Object.entries(plan()).map(([key, value]) =>
        [key, Array.isArray(value) ? value.length : typeof value === 'object' ? Object.keys(value).length : value])) }, null, 1));
    }
  } finally {
    await closeDb(db);
  }
}
