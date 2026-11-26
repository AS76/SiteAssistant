// Demo dataset for four synthetic construction sites (FITT-01 through FITT-04).
// Every identifier is derived from a fixed namespace, so re-running upserts the same rows
// and `--reset` removes exactly what this script created. No real people, sites or emails.
//
// Usage:
//   node server/seed-demo.mjs            # dry run: prints the plan
//   node server/seed-demo.mjs --apply    # write the rows
//   node server/seed-demo.mjs --reset    # delete only the rows created here
import { createHash } from 'node:crypto';
import process from 'node:process';
import { isDemoSandbox } from './demo-sandbox.mjs';
import { openDb, closeDb } from './db.mjs';
import { registeredDeviationExport, storeDeviationExport } from './deviations.mjs';
import { TEMPLATES } from './checklists.mjs';

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
const addMonths = (value, months) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  const day = parsed.getUTCDate();
  parsed.setUTCDate(1);
  parsed.setUTCMonth(parsed.getUTCMonth() + months);
  const lastDay = new Date(parsed);
  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0);
  parsed.setUTCDate(Math.min(day, lastDay.getUTCDate()));
  return parsed.toISOString().slice(0, 10);
};

const SITES = ['FITT-01', 'FITT-02', 'FITT-03', 'FITT-04', 'FITT-05'];

// Fixed reference day: expiry examples and the eight-week stories never drift on reapply.
const REFERENCE_DAY = '2026-11-15';
const SITE_META = {
  'FITT-01': { name: 'Cantiere dimostrativo Borgo Nuvolario', location: 'Comune immaginario di Nuvolario, zona industriale', start: '2026-09-21', end: '2026-12-18', weeks: 8, diary: 40 },
  'FITT-02': { name: 'Cantiere dimostrativo Ponte dei Sogni Blu', location: 'Comune immaginario di Sognalba, piccolo fiume', start: '2026-09-21', end: '2027-03-26', weeks: 8, diary: 40 },
  'FITT-03': { name: 'Demonstration site — Mille Avenue', location: 'Fictional town of Vialba, commercial district', start: '2026-09-21', end: '2027-04-30', weeks: 8, diary: 40 },
  'FITT-04': { name: 'Demonstration site — Levante Warehouse', location: 'Fictional town of Levante, warehouse district', start: '2026-09-14', end: '2026-11-06', weeks: 8, diary: 40 },
};
const english = code => code === 'FITT-03' || code === 'FITT-04';
const textFor = (code, it, en) => english(code) ? en : it;
const workingDate = (code, index) => date(Math.floor(index / 5) * 7 + index % 5, SITE_META[code].start);
const referencePlus = days => date(days, REFERENCE_DAY);
// Preserve the original date-based identity keys when moving their displayed dates.
const legacyWorkingDate = index => date(Math.floor(index / 5) * 7 + index % 5);

const TASK_PROFILES = {
  'FITT-01': ['todo', 'todo', 'todo', 'todo', 'in_progress', 'in_progress', 'in_progress', 'to_verify', 'to_verify', 'to_verify', 'closed', 'closed', 'closed', 'closed', 'closed', 'blocked'],
  'FITT-02': ['todo', 'todo', 'todo', 'in_progress', 'in_progress', 'to_verify', 'closed', 'closed', 'closed', 'blocked'],
  'FITT-03': ['todo', 'todo', 'todo', 'todo', 'todo', 'todo', 'in_progress', 'in_progress'],
  'FITT-04': ['closed', 'closed', 'closed', 'closed', 'closed', 'closed', 'closed', 'to_verify', 'closed', 'closed'],
};

const WBS = {
  'FITT-01': [['1', 'Impianto di smistamento', 0, null], ['1.1', 'Linea A', 1, '1'], ['1.2', 'Linea B', 1, '1'],
    ['2', 'Opere civili e carpenteria', 0, null], ['2.1', 'Fondazioni', 1, '2'], ['2.2', 'Strutture di sostegno', 1, '2'],
    ['3', 'Impianti elettrici', 0, null], ['3.1', 'Quadri elettrici', 1, '3'], ['3.2', 'Cavi e passerelle', 1, '3']],
  'FITT-02': [['1', 'Ponte stradale', 0, null], ['1.1', 'Pali e plinti di coronamento', 1, '1'], ['1.2', 'Spalle e impalcato', 1, '1'],
    ['2', 'Viabilità di cantiere', 0, null], ['2.1', 'Piste di accesso', 1, '2']],
  'FITT-03': [['1', 'Commercial building', 0, null], ['1.1', 'Groundworks and foundations', 1, '1'], ['1.2', 'Ground floor and blockwork', 1, '1'],
    ['2', 'Site preparation', 0, null], ['2.1', 'Utilities and temporary works', 1, '2']],
  'FITT-04': [['1', 'Warehouse finishes', 0, null], ['1.1', 'Ceilings and painting', 1, '1'], ['1.2', 'Doors and floor finishes', 1, '1'],
    ['2', 'Building services', 0, null], ['2.1', 'Electrical and HVAC', 1, '2'], ['2.2', 'Sprinklers', 1, '2'],
    ['3', 'Handover', 0, null], ['3.1', 'Cleaning and demobilisation', 1, '3']],
};

const PURCHASE_ORDERS = {
  'FITT-01': [
    { poNo: 'PO-001', supplierName: 'Rulliere Nuvola Demo Srl', orderedOn: '2026-09-28', status: 'in_execution',
      notes: 'Linea A completata; montaggio della linea B in corso.', items: [
        { lineNo: 10, materialNo: 'DEM-RUL-A', description: 'Rulliere per la linea A', unit: 'm', quantity: 60, wbsCode: '1.1',
          status: 'completed', execution_started_on: '2026-10-16', completed_on: '2026-10-20' },
        { lineNo: 20, materialNo: 'DEM-RUL-B', description: 'Rulliere per la linea B', unit: 'm', quantity: 50, wbsCode: '1.2',
          status: 'in_execution', execution_started_on: '2026-10-30' },
        { lineNo: 30, description: 'Carter terminali della linea B', unit: 'pz', quantity: 6, wbsCode: '1.2', status: 'open' },
      ] },
    { poNo: 'PO-002', supplierName: 'Cablaggi Aurora Demo Srl', orderedOn: '2026-10-19', status: 'template_generated',
      notes: 'Modello generato per le integrazioni elettriche della linea B; primo lotto di prolunghe preparato e ricevuto.', items: [
        { lineNo: 10, materialNo: 'DEM-PAS-B', description: 'Prolunghe passerelle portacavi linea B', unit: 'm', quantity: 32, wbsCode: '3.2', status: 'open' },
        { lineNo: 20, materialNo: 'DEM-MOR-B', description: 'Morsettiere per i terminali della linea B', unit: 'pz', quantity: 12, wbsCode: '3.1', status: 'open' },
      ] },
  ],
  'FITT-02': [
    { poNo: 'PO-001', supplierName: 'Fondazioni Sognalba Demo Srl', orderedOn: '2026-09-21', status: 'completed',
      closedAt: '2026-10-16T16:00:00.000Z', notes: 'Forniture per gli otto pali completate prima delle opere sulle spalle.', items: [
        { lineNo: 10, materialNo: 'DEM-GAB-08', description: 'Gabbie di armatura per gli otto pali', unit: 'pz', quantity: 8, wbsCode: '1.1',
          status: 'completed', execution_started_on: '2026-09-28', completed_on: '2026-10-16' },
        { lineNo: 20, materialNo: 'DEM-CLS-PA', description: 'Calcestruzzo per i pali', unit: 'm3', quantity: 80, wbsCode: '1.1',
          status: 'completed', execution_started_on: '2026-09-29', completed_on: '2026-10-16' },
        { lineNo: 30, description: 'Distanziatori aggiuntivi per gabbie di riserva', unit: 'pz', quantity: 40, wbsCode: '1.1',
          status: 'not_relevant', not_relevant_on: '2026-10-16' },
      ] },
    { poNo: 'PO-002', supplierName: 'Casseri Fiume Demo Srl', orderedOn: '2026-10-12', status: 'in_execution',
      notes: 'Casseri delle spalle in uso; prima campata dell’impalcato in preparazione.', items: [
        { lineNo: 10, materialNo: 'DEM-CAS-SP', description: 'Pannelli per casseri delle spalle', unit: 'm2', quantity: 180, wbsCode: '1.2',
          status: 'in_execution', execution_started_on: '2026-11-03' },
        { lineNo: 20, materialNo: 'DEM-PUN-IM', description: 'Puntelli aggiuntivi per proseguire l’impalcato', unit: 'pz', quantity: 48, wbsCode: '1.2', status: 'open' },
      ] },
  ],
  'FITT-03': [
    { poNo: 'PO-001', supplierName: 'Cloudstone Demo Supplies Ltd', orderedOn: '2026-10-05', status: 'completed',
      closedAt: '2026-11-06T16:00:00.000Z', notes: 'Foundation and ground-floor slab materials completed before blockwork starts.', items: [
        { lineNo: 10, materialNo: 'DEM-REBAR', description: 'Foundation reinforcement steel', unit: 'kg', quantity: 4200, wbsCode: '1.1',
          status: 'completed', execution_started_on: '2026-10-26', completed_on: '2026-10-27' },
        { lineNo: 20, materialNo: 'DEM-CON-F', description: 'Foundation concrete', unit: 'm3', quantity: 36, wbsCode: '1.1',
          status: 'completed', execution_started_on: '2026-10-29', completed_on: '2026-11-02' },
        { lineNo: 30, materialNo: 'DEM-MESH', description: 'Ground-floor slab reinforcement mesh', unit: 'm2', quantity: 300, wbsCode: '1.2',
          status: 'completed', execution_started_on: '2026-11-05', completed_on: '2026-11-06' },
      ] },
    { poNo: 'PO-002', supplierName: 'Skybrick Demo Materials Ltd', orderedOn: '2026-11-09', status: 'open',
      notes: 'Next blockwork batch; the first courses used existing site stock.', items: [
        { lineNo: 10, materialNo: 'DEM-BLOCK', description: 'Blocks for the next north wall courses', unit: 'pcs', quantity: 1600, wbsCode: '1.2', status: 'open' },
        { lineNo: 20, materialNo: 'DEM-MORTAR', description: 'Bagged mortar for the next blockwork batch', unit: 'kg', quantity: 1200, wbsCode: '1.2', status: 'open' },
      ] },
  ],
  'FITT-04': [
    { poNo: 'PO-001', supplierName: 'Brightbay Demo Fit-out Ltd', orderedOn: '2026-09-14', status: 'completed',
      closedAt: '2026-11-05T16:00:00.000Z', notes: 'Final fit-out materials completed before warehouse handover.', items: [
        { lineNo: 10, materialNo: 'DEM-CEIL', description: 'Office ceiling panels', unit: 'm2', quantity: 200, wbsCode: '1.1',
          status: 'completed', execution_started_on: '2026-09-29', completed_on: '2026-09-30' },
        { lineNo: 20, materialNo: 'DEM-DOOR', description: 'Replacement door leaf and threshold set', unit: 'set', quantity: 1, wbsCode: '1.2',
          status: 'completed', execution_started_on: '2026-10-16', completed_on: '2026-10-16' },
        { lineNo: 30, materialNo: 'DEM-FILTER', description: 'Final HVAC filter sets', unit: 'set', quantity: 6, wbsCode: '2.1',
          status: 'completed', execution_started_on: '2026-10-12', completed_on: '2026-10-19' },
      ] },
    { poNo: 'PO-002', supplierName: 'Clearquay Demo Services Ltd', orderedOn: '2026-10-19', status: 'not_relevant',
      closedAt: '2026-11-06T16:00:00.000Z', notes: 'Duplicate door adjustment and optional extra cleaning were removed at handover.', items: [
        { lineNo: 10, description: 'Duplicate door adjustment kit', unit: 'set', quantity: 1, wbsCode: '1.2',
          status: 'not_relevant', not_relevant_on: '2026-10-30' },
        { lineNo: 20, description: 'Optional additional cleaning supplies', unit: 'set', quantity: 1,
          status: 'not_relevant', not_relevant_on: '2026-11-06' },
      ] },
  ],
};

const PACKAGES = {
  'FITT-01': [
    { key: 'line-b', poNo: 'PO-001', packageNo: 'PKG-001', status: 'closed', packedOn: '2026-11-09',
      notes: 'Rulliere e carter per proseguire il montaggio della linea B.',
      items: [{ lineNo: 20, quantity: 20 }, { lineNo: 30, quantity: 6 }] },
    { key: 'electrical', poNo: 'PO-002', packageNo: 'PKG-001', status: 'closed', packedOn: '2026-11-09',
      notes: 'Prolunghe passerelle per il tratto successivo della linea B.', items: [{ lineNo: 10, quantity: 8 }] },
  ],
  'FITT-02': [
    { key: 'formwork', poNo: 'PO-002', packageNo: 'PKG-001', status: 'open', packedOn: '2026-11-12',
      notes: 'Pannelli per casseri delle spalle, primo lotto.', items: [{ lineNo: 10, quantity: 60 }] },
  ],
  'FITT-03': [
    { key: 'blockwork', poNo: 'PO-002', packageNo: 'PKG-001', status: 'open', packedOn: '2026-11-13',
      notes: 'Next north wall batch packed at the supplier; dispatch planned.', items: [{ lineNo: 10, quantity: 800 }] },
  ],
  'FITT-04': [
    { key: 'ceilings', poNo: 'PO-001', packageNo: 'PKG-001', status: 'closed', packedOn: '2026-09-20',
      notes: 'Ceiling panels for the office area, delivered before handover.', items: [{ lineNo: 10, quantity: 200 }] },
  ],
};

const SHIPMENTS = {
  'FITT-01': [
    { shipmentNo: 'SHP-001', status: 'received', packageKeys: ['line-b', 'electrical'],
      shippedOn: '2026-11-10', expectedOn: '2026-11-11', arrivedOn: '2026-11-11',
      notes: 'Ricevuti due colli per la linea B; montaggio ancora in corso.',
      receipts: [{ poNo: 'PO-001', lineNo: 20, quantity: 20, receivedOn: '2026-11-11',
        note: 'Venti metri di rulliere ricevuti; riscontro degli altri materiali da registrare.' }] },
  ],
  'FITT-02': [
    { shipmentNo: 'SHP-001', status: 'in_transit', packageKeys: ['formwork'],
      shippedOn: '2026-11-13', expectedOn: '2026-11-18', notes: 'Primo lotto di pannelli in viaggio verso il cantiere.' },
  ],
  'FITT-03': [
    { shipmentNo: 'SHP-001', status: 'planned', packageKeys: ['blockwork'],
      expectedOn: '2026-11-17', notes: 'Next blockwork delivery after the first courses from site stock.' },
  ],
  'FITT-04': [
    { shipmentNo: 'SHP-001', status: 'received', packageKeys: ['ceilings'],
      shippedOn: '2026-09-22', expectedOn: '2026-09-24', arrivedOn: '2026-09-24',
      notes: 'Ceiling panels received and installed before handover.',
      receipts: [{ poNo: 'PO-001', lineNo: 10, quantity: 200, receivedOn: '2026-09-24',
        note: 'All 200 panels received; two spares kept in stores.' }] },
  ],
};

const TYPES = {
  'FITT-01': [{ code: 'MONT', name: 'Montaggio impianti', steps: [['PREL', 'Opere preliminari', 20], ['STRUT', 'Montaggio strutture', 40], ['CABL', 'Cablaggi', 25], ['COLL', 'Collaudo', 15]] },
    { code: 'CIV', name: 'Opere civili', steps: [['SCAVI', 'Scavi', 25], ['FOND', 'Fondazioni', 45], ['STRUTT', 'Strutture', 30]] }],
  'FITT-02': [{ code: 'PONTE', name: 'Opere da ponte', steps: [['PILE', 'Pali e plinti di coronamento', 35], ['IMPALC', 'Spalle e impalcato', 45], ['FINIT', 'Finiture', 20]] }],
  'FITT-03': [{ code: 'CIVNEW', name: 'Commercial building works', steps: [['SCAVI', 'Excavation', 30], ['FOND', 'Foundations and slab', 40], ['ELEV', 'Blockwork', 30]] }],
  'FITT-04': [{ code: 'MAG', name: 'Warehouse fit-out', steps: [['STRUTT', 'Partitions and ceilings', 40], ['IMPIANTI', 'Services installation', 35], ['FINIT', 'Finishes and handover', 25]] }],
};

const ITEMS = {
  'FITT-01': [
    ['Montaggio rulliere linea A', '1.1', 'Linea A', 'Zona 1', 100], ['Scavi fondazioni', '2.1', 'Opere civili', 'Zona 4', 100],
    ['Allineamento guide linea A', '1.1', 'Linea A', 'Zona 2', 100], ['Montaggio rulliere linea B', '1.2', 'Linea B', 'Zona 3', 40],
    ['Casseri fondazioni', '2.1', 'Opere civili', 'Zona 4', 100], ['Montaggio carrelli linea B', '1.2', 'Linea B', 'Zona 3', 40],
    ['Montaggio quadri principali', '3.1', 'Impianti elettrici', 'Zona 6', 75], ['Getto fondazioni', '2.1', 'Opere civili', 'Zona 4', 100],
    ['Montaggio carrelli linea A', '1.1', 'Linea A', 'Zona 1', 100], ['Quadri secondari', '3.1', 'Impianti elettrici', 'Zona 6', 60],
    ['Carpenteria strutture', '2.2', 'Carpenteria metallica', 'Zona 5', 100], ['Passerelle portacavi linea A', '3.2', 'Impianti elettrici', 'Zona 1', 100],
    ['Passerelle portacavi linea B', '3.2', 'Impianti elettrici', 'Zona 3', 40], ['Ripristini pavimentazione', '2.1', 'Opere civili', 'Zona 4', 100],
    ['Terminali linea A', '3.2', 'Impianti elettrici', 'Zona 2', 100], ['Terminali linea B', '3.2', 'Impianti elettrici', 'Zona 3', 20],
    ['Ripristini basamenti', '2.1', 'Opere civili', 'Zona 5', 100], ['Prove a vuoto linea A', '1.1', 'Avviamento', 'Zona 1', 60],
    ['Prove a vuoto linea B', '1.2', 'Avviamento', 'Zona 3', 0], ['Pulizia finale', null, 'Chiusura lavori', 'Intero impianto', 0]],
  'FITT-02': [
    ['Perforazione di otto pali', '1.1', 'Fondazioni profonde', 'Sponda nord e sud', 100], ['Gabbie di armatura pali', '1.1', 'Fondazioni profonde', 'Sponda nord e sud', 100],
    ['Getto degli otto pali', '1.1', 'Fondazioni profonde', 'Sponda nord e sud', 100], ['Spalle del ponte', '1.2', 'Opere in elevazione', 'Sponda nord e sud', 50],
    ['Casseratura iniziale impalcato', '1.2', 'Impalcato', 'Campata unica', 10], ['Accesso lato nord', '2.1', 'Viabilità', 'Sponda nord', 100],
    ['Accesso lato sud', '2.1', 'Viabilità', 'Sponda sud', 100], ['Impermeabilizzazione impalcato', null, 'Impalcato', 'Campata unica', 0]],
  'FITT-03': [
    ['Bulk excavation', '1.1', 'Groundworks', 'Footprint C1', 100], ['Blinding concrete', '1.1', 'Groundworks', 'Footprint C1', 100],
    ['Foundation reinforcement', '1.1', 'Foundations', 'Grid C2', 100], ['Foundation concrete', '1.1', 'Foundations', 'Grid C2', 100],
    ['Ground-floor slab', '1.2', 'Ground floor', 'Floor C2', 100], ['First blockwork courses', '1.2', 'Masonry', 'North wall C3', 15],
    ['Utility connections', '2.1', 'Site preparation', 'Service bay C0', 100], ['Fencing and scaffold', '2.1', 'Temporary works', 'Perimeter C0', 75]],
  'FITT-04': [
    ['Ceiling installation', '1.1', 'Finishes', 'Office D1', 100], ['Wall painting', '1.1', 'Finishes', 'Office D1', 100],
    ['Doors and thresholds', '1.2', 'Finishes', 'Loading bay D2', 100], ['Electrical commissioning', '2.1', 'Services', 'Plant room D3', 100],
    ['Sprinkler acceptance tests', '2.2', 'Services', 'Warehouse D3', 100], ['Cleaning and demobilisation', '3.1', 'Handover', 'Yard D4', 100],
    ['HVAC commissioning', '2.1', 'Services', 'Plant room D3', 100], ['As-built documentation', '3.1', 'Handover', 'Office D1', 100]],
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


// Seven manual register events per site. Inspection-linked rows are counted separately.
// [type, severity, calendar-day offset, location, persons, measures, notes]
const HSE = {
  'FITT-01': [
    ['near_miss', 'medium', 16, 'Passerella di servizio linea A', null, 'Interdetto il passaggio inferiore e aggiunti contenitori chiusi per la bulloneria.', 'Un bullone è caduto dalla passerella durante il serraggio, senza colpire nessuno.'],
    ['near_miss', 'high', 23, 'Scarico rulliere zona 3', null, 'Separati i percorsi e ripristinato il segnalatore acustico prima della ripresa.', 'Un sollevatore telescopico in retromarcia ha sfiorato una barriera del percorso pedonale vuoto.'],
    ['observation', 'medium', 30, 'Ponteggio interno linea B', null, 'Bloccato il piano di lavoro fino al completamento delle tavole fermapiede.', 'Mancano due tavole fermapiede sul piano inferiore del ponteggio.'],
    ['accident', 'low', 31, 'Banco di preparazione carter', 1, 'Medicata la mano e sbavati i bordi delle lamiere prima di riprendere il montaggio.', 'Un bordo vivo del carter ha tagliato un guanto causando una ferita superficiale alla mano.'],
    ['observation', 'low', 37, 'Passaggio quadri zona 6', null, 'Posata una canalina passacavo e ricollocata la presa temporanea.', 'Un cavo di alimentazione attraversa il passaggio davanti ai quadri secondari.'],
    ['near_miss', 'high', 44, 'Scarico motore di ricambio zona 6', null, 'Deposto il motore e sostituita la protezione del punto di presa.', 'Un motore di ricambio sospeso si è inclinato per lo scorrimento di una braca, senza urti o persone sotto il carico.'],
    ['observation', 'low', 51, 'Ingresso sala quadri', null, 'Ripristinati gli identificativi e verificata la raggiungibilità dei presidi.', 'Due estintori sono privi di identificativo dopo lo spostamento del deposito.'],
  ],
  'FITT-02': [
    ['near_miss', 'medium', 2, 'Scarico recinzione accesso nord', null, 'Fermata la manovra e separata la zona di scarico dal passaggio.', 'Un sollevatore telescopico in retromarcia ha urtato una transenna senza coinvolgere persone.'],
    ['observation', 'low', 8, 'Deposito carburante pista sud', null, 'Applicati gli identificativi mancanti ai presidi antincendio.', 'Due estintori sono presenti ma privi di identificativo nel deposito temporaneo.'],
    ['near_miss', 'high', 16, 'Bordo scavo palo N2', null, 'Allontanato il mezzo e installate barriere rigide alla distanza prevista dal piano di scavo.', 'Una ruota del mezzo di servizio ha raggiunto il bordo non protetto dello scavo senza cedimenti.'],
    ['accident', 'low', 23, 'Banco gabbie sponda sud', 1, 'Prestato primo soccorso e spostati gli spezzoni nel contenitore dedicato.', 'Inciampo su uno spezzone di armatura con lieve contusione al ginocchio.'],
    ['observation', 'medium', 30, 'Accesso plinto sud', null, 'Installato un passacavo e rialzata la presa della pompa.', 'Il cavo della pompa attraversa la passerella di accesso al plinto.'],
    ['near_miss', 'high', 44, 'Casseratura spalla nord', null, 'Sospeso il lavoro sottostante e assicurati gli utensili in quota.', 'Un morsetto è caduto dal cassero della spalla nel settore sottostante vuoto.'],
    ['observation', 'medium', 51, 'Piano iniziale impalcato', null, 'Interdetta la campata incompleta e montate le tavole mancanti.', 'Mancano tavole fermapiede su due metri del primo piano di casseratura.'],
  ],
  'FITT-03': [
    ['observation', 'low', 16, 'North perimeter fence', null, 'Reinstalled the missing panel and checked the remaining connections.', 'A fence panel is missing beside the locked vehicle gate.'],
    ['near_miss', 'medium', 23, 'Shed demolition loading bay', null, 'Stopped vehicle movements and installed a rigid pedestrian barrier.', 'A reversing telehandler struck an empty pedestrian barrier while collecting shed debris.'],
    ['near_miss', 'high', 30, 'East excavation edge', null, 'Removed the pallet and installed rigid edge protection.', 'A pallet slid towards an unguarded excavation edge and stopped against a spoil ridge.'],
    ['accident', 'low', 31, 'Drainage pipe cutting bench', 1, 'Provided first aid and fitted a clamp to hold pipe sections.', 'A slipping pipe section trapped a gloved finger against the bench, causing minor bruising.'],
    ['observation', 'medium', 37, 'Concrete spacer cutting station', null, 'Connected water suppression and relocated the cutting station.', 'Dry cutting of concrete spacer blocks is leaving dust across the adjacent materials route.'],
    ['near_miss', 'high', 44, 'Slab perimeter access', null, 'Isolated the route and secured the loose scaffold board.', 'A loose access board tipped into an empty shallow service trench.'],
    ['observation', 'medium', 51, 'North wall scaffold', null, 'Closed the incomplete platform until toe boards were installed.', 'Toe boards are missing from the first scaffold bay beside the new blockwork.'],
  ],
  'FITT-04': [
    ['near_miss', 'medium', 2, 'MEP unloading bay D2', null, 'Lowered the pallet and secured the duct sections before moving it again.', 'An unsecured duct section slid from a raised pallet onto an empty loading bay.'],
    ['observation', 'low', 8, 'Plant room entrance D3', null, 'Installed a cable ramp and moved the temporary socket.', 'A temporary lighting cable crosses the plant room access route.'],
    ['near_miss', 'high', 16, 'Ceiling installation bay D1', null, 'Closed the bay and fitted tool restraints before restarting overhead work.', 'A ceiling fixing fell from the access platform onto an empty floor bay.'],
    ['accident', 'low', 23, 'Door trimming bench D2', 1, 'Provided first aid and deburred the remaining metal trims.', 'A sharp door trim cut a glove and caused a superficial hand wound.'],
    ['observation', 'medium', 30, 'East access scaffold', null, 'Isolated the platform and requested replacement standards and ties.', 'Two scaffold standards are bent and two ties are loose.'],
    ['near_miss', 'medium', 37, 'Commissioning plant room D3', null, 'Isolated the route and secured the cover with its specified fixings.', 'An unsecured floor duct cover tipped into an empty cable trench.'],
    ['observation', 'low', 44, 'Finished office corridor D1', null, 'Restored extinguisher location markers before the handover walk.', 'Extinguisher location markers are missing following final painting.'],
  ],
};

// English media scenes are kept outside the site-language register tuples.
const HSE_SCENES = {
  'FITT-01': [
    'a single bolt falling from a steel conveyor walkway onto an empty concrete floor',
    'a reversing telehandler beside a displaced pedestrian barrier in an industrial hall',
    'two missing toe boards on an internal scaffold beside unfinished conveyor frames',
    'a cropped anonymous gloved hand caught on a sharp sheet metal conveyor guard, non-graphic',
    'a loose power cable crossing a concrete walkway beside electrical cabinets',
    'a suspended spare conveyor motor tilting as one lifting sling slips at its attachment',
    'two unmarked fire extinguishers beside the entrance to an electrical room',
  ],
  'FITT-02': [
    'a reversing telehandler contacting a freestanding barrier beside stacked fence panels',
    'two unmarked fire extinguishers beside a temporary fuel storage cabinet',
    'a service vehicle wheel beside an unguarded open bored pile excavation',
    'a cropped anonymous boot tripping over a loose rebar offcut beside a reinforcement cage, non-graphic',
    'a pump cable lying across a narrow temporary walkway beside a pile cap excavation',
    'a single formwork clamp falling from a bridge abutment shutter onto empty ground',
    'missing toe boards along a short unfinished bridge deck formwork platform',
  ],
  'FITT-03': [
    'a missing mesh fence panel beside a closed gate and stacked demolition rubble',
    'a reversing telehandler contacting an empty pedestrian barrier beside demolished shed debris',
    'a material pallet stopped against a spoil ridge beside an unguarded excavation edge',
    'a pipe section trapping one cropped anonymous gloved finger against a cutting bench, non-graphic',
    'dust settling around a dry concrete spacer cutting bench beside stacked reinforcement cages',
    'a loose scaffold access board tipping into an empty shallow service trench',
    'a scaffold bay with missing toe boards beside newly laid concrete blockwork',
  ],
  'FITT-04': [
    'one sheet metal duct section sliding from a raised pallet onto an empty loading bay',
    'a temporary lighting cable crossing a plant room doorway beside unfinished electrical cabinets',
    'a single ceiling fixing falling from an access platform onto an empty warehouse floor',
    'a cropped anonymous gloved hand against the sharp edge of a metal door trim, non-graphic',
    'two bent scaffold standards and loose wall ties beside an internal warehouse wall',
    'an unsecured metal floor duct cover tipping into an empty cable trench',
    'unmarked extinguisher brackets and extinguishers beside a freshly painted office corridor wall',
  ],
};

// Eight assets and seven inspections. Machine codes stay unchanged; display fields are localised.
const HSE_ASSETS = {
  'FITT-01': [
    ['tool', 'Sollevamento', 'Gru a torre', 'GRU-01', 'it_lifting'],
    ['site_work', 'Ponteggi', 'Ponteggio interno linea B', null, 'it_scaffolding'],
    ['ppe', 'Dispositivi di protezione individuale', 'Imbracature squadra A', null, 'it_ppe'],
  ],
  'FITT-02': [
    ['tool', 'Sollevamento', 'Escavatore cingolato E-12', 'ESC-12', 'it_lifting'],
    ['site_work', 'Ponteggi', 'Ponteggio spalla sud', 'PON-SUD', 'it_scaffolding'],
  ],
  'FITT-03': [['tool', 'Lifting equipment', 'Tower crane T-04', 'GRU-T04', 'it_lifting']],
  'FITT-04': [
    ['site_work', 'Scaffolding', 'East access scaffold', 'PON-EST', 'it_scaffolding'],
    ['ppe', 'Personal protective equipment', 'Final handover PPE kit', null, 'it_ppe'],
  ],
};

// Offsets are relative to REFERENCE_DAY, including historical equipment inspections.
// [asset, days ago, performed by, role, mode, outcome, notes, item exceptions]
const HSE_INSPECTIONS = {
  'FITT-01': [
    ['Gru a torre', 56, 'Ada Rossi', 'direttore di cantiere', 'internal', 'pass_with_notes',
      'Funi in ordine; anticipare la sostituzione della guarnizione del martinetto.', { leaks: ['not_ok', 'Trafilamento lieve dal raccordo del martinetto.'] }],
    ['Ponteggio interno linea B', 123, 'Ada Rossi', 'direttore di cantiere', 'internal', 'pass', 'Verbale storico del ponteggio prima del trasferimento in cantiere.'],
  ],
  'FITT-02': [
    ['Escavatore cingolato E-12', 10, 'Luca Sala', 'direttore di cantiere', 'internal', 'pass', null],
    ['Ponteggio spalla sud', 61, 'Luca Sala', 'direttore di cantiere', 'internal', 'pass', 'Verbale precedente al montaggio sulla spalla sud.'],
  ],
  'FITT-03': [['Tower crane T-04', 44, 'Pietro Amato', 'site manager', 'internal', 'pass', 'Stored crane sections checked before later erection; crane not used for groundworks.']],
  'FITT-04': [
    ['East access scaffold', 19, 'Teresa Greco', 'safety coordinator', 'external', 'fail',
      'Two bent standards and loose ties: east platform isolated and removed during demobilisation.',
      { uprights: ['not_ok', 'Two bent standards.'], anchors: ['not_ok', 'Loose ties on two bays.'] }],
    ['Final handover PPE kit', 10, 'Teresa Greco', 'supervisor', 'internal', 'pass', 'Return inspection before removal from site.'],
  ],
};

// Preserve checklist codes and item IDs, translating only their saved human-readable labels.
const EN_CHECKLIST_TITLES = { it_lifting: 'Lifting equipment', it_scaffolding: 'Scaffolding', it_ppe: 'Personal protective equipment' };
const EN_CHECKLIST_LABELS = {
  identification: 'Identification plate present and legible', rated_load: 'Rated load marked and legible',
  wire_ropes: 'Wire ropes free of broken wires, corrosion or crushing', chains: 'Chains free of cracks, distortion or wear',
  hooks: 'Hooks undamaged with safety latches intact', sheaves: 'Sheaves intact with ropes seated in grooves',
  structure: 'Frame free of visible cracks or deformation', fasteners: 'Bolts and pins present and secure',
  leaks: 'Hoses and fittings free of visible leaks', controls: 'Controls identified and emergency stop intact',
  base_supports: 'Base plates seated on sound and stable supports', uprights: 'Standards free of bends or visible damage',
  bracing: 'Bracing present and secured', anchors: 'Ties intact and secured', couplers: 'Couplers complete and secure',
  platforms: 'Platforms complete and secured with no broken boards', guardrails: 'Guardrails and intermediate rails present',
  toe_boards: 'Toe boards present and secured', access: 'Access ladders secured and trapdoors intact',
  clear_walkways: 'Walkways clear of materials and debris', markings: 'Markings and labels legible',
  helmet_shell: 'Helmet shell free of cracks or deformation', helmet_harness: 'Helmet suspension intact and secure',
  eye_protection: 'Lenses clear and free of cracks', hearing_protection: 'Ear defenders with clean intact cushions',
  gloves: 'Gloves free of cuts, holes or open seams', footwear: 'Footwear soles intact with no separation',
  high_visibility: 'Reflective strips visible and secure', harness_webbing: 'Fall arrest webbing and stitching intact',
  connectors: 'Buckles and connectors free of cracks or deformation',
};

// Forty distinct working days per site; the fifth element is media-only English.
const photo = scene => `${scene}, documentary photograph, no people, no faces, no text, no logos`;
const DIARY = {
  'FITT-01': [
    // Week 1 — civil foundations.
    ['Tracciare dodici plinti nella zona 4 con la squadra civile.', 'Rilevati dodici centri e predisposta una pista per l’escavatore.', null, 'Scavare i primi sei plinti sul lato ovest.', photo('survey tripod beside twelve marked foundation positions')],
    ['Scavare sei plinti occidentali con l’escavatore da venti tonnellate.', 'Aperti quattro scavi; pompata l’acqua dagli ultimi due dopo la pioggia.', 'La pioggia mattutina ha allagato due impronte.', 'Completare i due scavi e stendere il magrone.', photo('excavator beside rainwater filled concrete footing excavations')],
    ['Completare sei scavi e gettare il magrone sul lato ovest.', 'Completati i sei scavi e posati sei metri cubi di magrone.', null, 'Posare le gabbie e scavare i sei plinti orientali.', photo('six blinding pads beside stacked reinforcement cages')],
    ['Armare sei plinti occidentali e preparare quelli orientali.', 'Posate sei gabbie, verificati i tirafondi e completati gli scavi orientali.', null, 'Gettare i primi ventiquattro metri cubi di fondazioni.', photo('reinforcement cages and anchor bolts inside foundation shutters')],
    ['Gettare sei plinti occidentali con l’impresa civile.', 'Gettati ventiquattro metri cubi e armati i sei plinti orientali.', null, 'Completare il getto orientale dopo il controllo dei tirafondi.', photo('fresh concrete footings beside reinforced eastern foundation shutters')],
    // Week 2 — foundations complete, columns.
    ['Verificare i tirafondi orientali e gettare sei plinti.', 'Verificate quattro dime; preparati i casseri in attesa del dettaglio aggiornato.', 'Mancava il disegno di due gruppi di tirafondi.', 'Ricevere il dettaglio e completare i ventiquattro metri cubi restanti.', photo('anchor bolt templates inside prepared concrete footing shutters')],
    ['Completare le fondazioni orientali con la pompa per calcestruzzo.', 'Gettati ventiquattro metri cubi; tutte le dodici fondazioni sono complete.', null, 'Proteggere il getto e predisporre le colonne metalliche.', photo('completed concrete footings with protected projecting anchor bolts')],
    ['Preparare dodici colonne e controllare le quote dei plinti occidentali.', 'Disarmati sei plinti e misurate le basi con scarto massimo di due millimetri.', null, 'Montare le prime sei colonne dopo il controllo della resistenza.', photo('steel columns stacked beside surveyed cured concrete footings')],
    ['Sollevare sei colonne occidentali con i carpentieri metallici.', 'Montate sei colonne e fissati i controventi provvisori.', null, 'Verificare la resistenza dei plinti orientali e montare le altre colonne.', photo('six erected steel columns with temporary diagonal braces')],
    ['Montare sei colonne orientali e regolare le piastre di base.', 'Posizionate tre colonne; le altre tre restano sui cavalletti.', 'La gru condivisa con un altro cantiere è arrivata nel pomeriggio.', 'Completare le tre colonne e avviare la posa delle travi.', photo('partly erected steel support columns beside mobile crane')],
    // Week 3 — steel support structure complete.
    ['Completare le tre colonne orientali con la gru mobile.', 'Montate tre colonne e controllata la verticalità di tutti i dodici montanti.', null, 'Posare le prime quattro travi di sostegno.', photo('twelve steel support columns on finished concrete foundations')],
    ['Montare quattro travi sul settore occidentale con i carpentieri.', 'Posate quattro travi e serrati i collegamenti principali.', null, 'Montare quattro travi nel settore centrale.', photo('four steel support beams fixed between western columns')],
    ['Posare quattro travi centrali e verificare gli appoggi.', 'Completate quattro travi centrali con gli appoggi entro due millimetri.', null, 'Ricevere e montare le ultime quattro travi orientali.', photo('central steel beams above clean industrial concrete floor')],
    ['Montare quattro travi orientali e chiudere i controventi.', 'Preparati quattro appoggi e completati i controventi centrali.', 'Il camion delle ultime travi è slittato al mattino successivo.', 'Scaricare le quattro travi e chiudere la struttura.', photo('empty eastern steel beam seats beside diagonal bracing')],
    ['Completare travi e serraggi della struttura di sostegno.', 'Montate le quattro travi restanti e verificati tutti i dodici nodi principali.', null, 'Iniziare i sessanta metri di telai della linea A.', photo('completed steel conveyor support structure inside industrial hall')],
    // Week 4 — conveyor A frames, electrical rough-in.
    ['Montare venti metri di telai della linea A con i montatori meccanici.', 'Posati venti metri di telai sul tratto ovest con il sollevatore.', null, 'Proseguire sul tratto centrale e preparare le passerelle elettriche.', photo('twenty metres of conveyor frames on steel supports')],
    ['Montare venti metri di telai centrali e dieci metri di passerelle.', 'Completati venti metri di telai e dieci metri di passerelle portacavi.', null, 'Montare il tratto est e verificare gli ingombri impiantistici.', photo('conveyor centre frames beside newly mounted cable trays')],
    ['Posare venti metri di telai orientali e proseguire le passerelle.', 'Completati i sessanta metri di telai della linea A; fermata una derivazione elettrica.', 'Una passerella interferisce con una tubazione antincendio esistente.', 'Approvare il percorso rialzato e avviare la posa delle rulliere.', photo('conveyor end frames beside crossing pipe and tray')],
    ['Rialzare la derivazione elettrica e preparare venti metri di rulliere.', 'Spostati sei metri di passerella e distribuiti i moduli occidentali.', null, 'Fissare le rulliere sul primo tratto della linea A.', photo('raised cable tray beside staged conveyor roller modules')],
    ['Montare venti metri di rulliere occidentali con i montatori meccanici.', 'Fissati venti metri di rulliere e verificati dodici supporti.', null, 'Estendere le rulliere al tratto centrale e ricevere i quadri.', photo('western conveyor roller section with bolted steel brackets')],
    // Week 5 — conveyor A assembled, panels.
    ['Montare venti metri di rulliere centrali e scaricare due quadri.', 'Completato il tratto centrale; i due quadri sono sul basamento della zona 6.', null, 'Completare le rulliere orientali e ancorare i quadri.', photo('central conveyor rollers beside two staged electrical cabinets')],
    ['Completare venti metri di rulliere orientali e ancorare due quadri.', 'Completata la linea A meccanica; ancorato un quadro su due.', 'Il cancello di accesso alla zona 6 era occupato da un altro scarico.', 'Liberare l’accesso e terminare il secondo quadro.', photo('complete conveyor rollers beside partly fixed electrical cabinets')],
    ['Fissare il secondo quadro e posare trenta metri di cavi.', 'Ancorati entrambi i quadri principali e posati trenta metri di cavi.', null, 'Collegare i motori occidentali della linea A.', photo('anchored electrical cabinets with new power cable runs')],
    ['Collegare quattro motori e montare due quadri secondari.', 'Collegati quattro motori occidentali e fissati due quadri secondari su quattro.', null, 'Collegare i quattro motori orientali e preparare gli strumenti di allineamento.', photo('conveyor drive motors beside mounted secondary electrical panels')],
    ['Collegare quattro motori orientali e controllare i giunti meccanici.', 'Completati otto collegamenti motore e verificati sedici giunti della linea A.', null, 'Allineare i tre tratti da venti metri della linea A.', photo('assembled conveyor drives with exposed aligned coupling components')],
    // Week 6 — alignment A, first 20% of B.
    ['Allineare venti metri occidentali e tracciare la linea B.', 'Allineati sedici metri; corretti quattro riferimenti sul pavimento.', 'Un riferimento topografico risultava spostato di sei millimetri.', 'Chiudere il tratto ovest usando i riferimenti corretti.', photo('survey instrument beside conveyor guide rails and shims')],
    ['Completare l’allineamento ovest e regolare venti metri centrali.', 'Allineati quaranta metri complessivi con tolleranza entro due millimetri.', null, 'Regolare gli ultimi venti metri orientali e posare i telai B.', photo('aligned conveyor guide rails with adjustment shims installed')],
    ['Allineare il tratto orientale e montare dieci metri di telai B.', 'Linea A interamente allineata; posati dieci metri di telai della linea B.', null, 'Estendere la linea B e completare le terminazioni della linea A.', photo('aligned conveyor line beside first adjacent support frames')],
    ['Montare altri dieci metri di telai B e terminare otto motori A.', 'Raggiunti venti metri di telai B e chiuse tutte le terminazioni motore A.', null, 'Installare venti metri di rulliere B e verificare l’alimentazione.', photo('twenty metres of second conveyor frames beside cabinets')],
    ['Montare venti metri di rulliere B e alimentare i quadri A.', 'Montati venti metri di rulliere B; completati i controlli elettrici senza tensione.', 'Il collegamento definitivo alla rete è stato rinviato dal gestore sintetico.', 'Ottenere l’alimentazione e iniziare le prove a vuoto della linea A.', photo('second conveyor rollers beside isolated electrical distribution cabinets')],
    // Week 7 — commissioning A begins, B reaches 30%.
    ['Alimentare i quadri A e controllare otto sensi di rotazione.', 'Disponibile l’alimentazione; verificati otto motori con impulsi singoli.', null, 'Provare gli arresti e avviare il tratto occidentale senza carico.', photo('energised conveyor drive cabinets beside stationary roller sections')],
    ['Provare sei arresti di emergenza e avviare venti metri della linea A.', 'Verificati sei arresti e completata una prova a vuoto di trenta minuti.', null, 'Estendere la prova al tratto centrale e montare dieci metri di telai B.', photo('conveyor drive train beside installed emergency stop hardware')],
    ['Provare quaranta metri di linea A e posare dieci metri di telai B.', 'Provati quaranta metri a vuoto e raggiunti trenta metri di telai B.', null, 'Installare dieci metri di rulliere B e verificare i sensori A.', photo('extended second conveyor frames beside completed first line')],
    ['Montare dieci metri di rulliere B e tarare dodici sensori A.', 'Raggiunti trenta metri di rulliere B e tarati dieci sensori A.', 'Manca la staffa di regolazione di due sensori terminali.', 'Ricevere le due staffe e provare la linea A completa.', photo('conveyor terminal sensors beside unfinished mounting brackets')],
    ['Completare due sensori e provare sessanta metri di linea A.', 'Tarati tutti i dodici sensori e completata una prova a vuoto di un’ora.', null, 'Avviare le prove con cassette campione e proseguire la linea B.', photo('complete conveyor line with blank plastic test crates')],
    // Week 8 — B at 40%, commissioning A still in progress.
    ['Provare cinquanta cassette campione e montare dieci metri di telai B.', 'Transitate cinquanta cassette e raggiunti quaranta metri di telai B.', null, 'Installare le rulliere B e regolare il deviatore A.', photo('blank test crates beside forty metre conveyor frames')],
    ['Montare dieci metri di rulliere B e regolare un deviatore A.', 'Linea B al quaranta per cento dei cento metri previsti; regolato il deviatore A.', null, 'Provare cento cassette e proseguire i cavi sulla linea B.', photo('partly completed parallel conveyor beside mechanical diverter assembly')],
    ['Provare cento cassette e tirare venti metri di cavi B.', 'Completate ottanta transizioni campione e posati venti metri di cavi B.', 'La versione aggiornata del disegno del deviatore richiede un nuovo riscontro dimensionale.', 'Confermare la quota del deviatore e ripetere la prova completa.', photo('conveyor diverter mechanism beside cable drums and trays')],
    ['Ripetere cento transizioni campione e montare due quadri secondari.', 'Completate cento transizioni; montato il terzo quadro secondario su quattro.', null, 'Eseguire una prova continuativa della linea A e verificare i verbali elettrici.', photo('test crates on conveyor beside secondary electrical cabinet')],
    ['Provare la linea A per due ore e verificare quaranta metri di linea B.', 'Completata la prova continuativa A; linea B confermata al quaranta per cento.', null, 'Proseguire l’avviamento A, completare il quarto quadro e i restanti sessanta metri B.', photo('completed first conveyor beside unfinished second conveyor sections')],
  ],
  'FITT-02': [
    // Week 1 — establishment and access.
    ['Tracciare il recinto e predisporre il deposito sulla sponda nord.', 'Tracciati centoventi metri di perimetro e livellati duecento metri quadrati di deposito.', null, 'Montare la recinzione e preparare la pista nord.', photo('survey tripod beside levelled riverside construction compound')],
    ['Montare sessanta metri di recinzione e iniziare la pista nord.', 'Montati sessanta metri di rete e stesi trenta metri di pietrisco.', null, 'Chiudere il recinto e completare altri trenta metri di pista.', photo('mesh fencing beside fresh aggregate access road')],
    ['Chiudere sessanta metri di recinto e proseguire la pista nord.', 'Chiuso il recinto e stesi quindici metri di pista prima del temporale.', 'La pioggia ha reso impraticabile l’ultimo tratto argilloso.', 'Drenare la pista e completare i quindici metri mancanti.', photo('muddy aggregate access road beside closed mesh fencing')],
    ['Drenare il tratto nord con miniescavatore e posare pietrisco.', 'Posati quindici metri di drenaggio laterale e completata la pista nord.', null, 'Preparare l’accesso sud e piazzare i servizi di cantiere.', photo('mini excavator beside gravel road and drainage ditch')],
    ['Posizionare due moduli di servizio e tracciare la pista sud.', 'Posati due moduli e tracciati cinquanta metri di accesso sud.', null, 'Stendere il geotessile e compattare la pista sud.', photo('two temporary cabins beside marked southern access alignment')],
    // Week 2 — piling platform and survey.
    ['Stendere cinquanta metri di geotessile e pietrisco sulla pista sud.', 'Posati cinquanta metri di geotessile e compattati venticinque metri di pista.', null, 'Completare la pista sud e preparare la piazzola della perforatrice.', photo('aggregate roller beside geotextile lined southern access road')],
    ['Completare venticinque metri di pista e iniziare la piazzola nord.', 'Completata la pista sud e preparati centocinquanta metri quadrati di piazzola.', 'Un autocarro fermo ha bloccato l’accesso al deposito per due ore.', 'Liberare il deposito e completare la piazzola nord.', photo('partly compacted piling platform beside aggregate delivery truck')],
    ['Completare la piazzola nord e tracciare quattro pali.', 'Compattati altri centocinquanta metri quadrati e tracciati i pali N1-N4.', null, 'Preparare la piazzola sud e controllare i riferimenti.', photo('compacted piling platform with four pile setting markers')],
    ['Preparare duecentocinquanta metri quadrati di piazzola sud.', 'Completata la piazzola sud e rilevati i quattro centri S1-S4.', null, 'Ricevere la perforatrice e verificare le gabbie del primo lotto.', photo('southern piling platform beside stacked reinforcement cage sections')],
    ['Scaricare la perforatrice e controllare quattro gabbie nord.', 'Perforatrice stabilizzata; controllate quattro gabbie lunghe dodici metri.', null, 'Perforare N1 e N2 con la squadra specializzata.', photo('bored piling rig beside four long reinforcement cages')],
    // Week 3 — first bored piles.
    ['Perforare i pali N1 e N2 fino a dodici metri.', 'Completato N1 e perforati sei metri di N2.', 'Pioggia persistente e fango sulla pista hanno rallentato i rifornimenti.', 'Completare N2 e calare le prime due gabbie.', photo('piling rig beside muddy bore casing and spoil')],
    ['Completare N2 e calare due gabbie con la gru di servizio.', 'Completati due fori da dodici metri e posate le gabbie N1-N2.', null, 'Gettare N1 e N2 con tubo di convogliamento.', photo('reinforcement cages lowered into two steel bore casings')],
    ['Gettare venti metri cubi nei pali N1 e N2.', 'Completati entrambi i pali con venti metri cubi e prelevati sei provini.', null, 'Perforare N3 e N4 sulla stessa piazzola.', photo('concrete pump beside completed bored pile heads')],
    ['Perforare N3 e N4 per ventiquattro metri complessivi.', 'Completati due fori e preparate le ultime due gabbie nord.', null, 'Calare le gabbie e prenotare il secondo getto.', photo('two open pile casings beside prepared reinforcement cages')],
    ['Calare le gabbie N3-N4 e gettare venti metri cubi.', 'Posate le due gabbie e mantenuti i fori protetti in attesa del getto.', 'Il fornitore di calcestruzzo ha rinviato le due autobetoniere.', 'Confermare la consegna e completare i pali nord.', photo('protected pile casings beside stationary concrete placing pipe')],
    // Week 4 — south piles.
    ['Gettare N3-N4 e trasferire la perforatrice sulla sponda sud.', 'Gettati venti metri cubi e trasferita la perforatrice lungo la pista.', null, 'Perforare S1 e S2 con le gabbie già disponibili.', photo('piling rig crossing gravel access beside completed piles')],
    ['Perforare e armare i pali S1-S2 da dodici metri.', 'Completati ventiquattro metri di foro e calate due gabbie.', null, 'Gettare S1-S2 e predisporre S3-S4.', photo('southern pile casings beside rig and reinforcement cages')],
    ['Gettare venti metri cubi nei pali S1-S2.', 'Completato il getto e lavata la linea della pompa nella vasca dedicata.', null, 'Perforare S3-S4 e preparare le ultime gabbie.', photo('concrete pump beside southern pile heads and washout')],
    ['Perforare S3-S4 e posare le due gabbie restanti.', 'Completati i fori; posata una sola gabbia.', 'La gru condivisa con un altro cantiere era disponibile solo al mattino.', 'Calare la seconda gabbia e completare il getto sud.', photo('single staged reinforcement cage beside open pile casing')],
    ['Calare l’ultima gabbia e gettare i pali S3-S4.', 'Completati venti metri cubi; tutti gli otto pali risultano gettati.', null, 'Controllare le teste nord e avviare gli scavi dei plinti.', photo('eight completed pile positions beside parked piling rig')],
    // Week 5 — pile caps.
    ['Scavare il plinto nord e scoprire quattro teste palo.', 'Rimossi ottanta metri cubi di terreno e scoperte le quattro teste nord.', null, 'Scapitozzare i pali e gettare il magrone del plinto.', photo('excavator beside four exposed northern concrete pile heads')],
    ['Scapitozzare quattro pali nord e predisporre il magrone.', 'Scapitozzate tre teste e predisposta la pompa di drenaggio.', 'Il livello del fiume è salito dopo la pioggia notturna.', 'Abbassare l’acqua nello scavo e completare il quarto palo.', photo('dewatering pump beside partly trimmed concrete pile heads')],
    ['Completare la scapitozzatura nord e stendere il magrone.', 'Completate quattro teste e gettati quattro metri cubi di magrone.', null, 'Posare l’armatura del plinto nord e aprire lo scavo sud.', photo('trimmed pile reinforcement above fresh blinding concrete')],
    ['Armare il plinto nord e scavare ottanta metri cubi a sud.', 'Posate due tonnellate di armatura nord e completato lo scavo sud.', null, 'Chiudere i casseri nord e preparare le teste sud.', photo('pile cap reinforcement beside timber shutters and excavation')],
    ['Chiudere il cassero nord e scapitozzare quattro pali sud.', 'Completati i casseri nord e tagliate le quattro teste sud.', null, 'Gettare il plinto nord e il magrone sud.', photo('closed pile cap shutters beside trimmed southern piles')],
    // Week 6 — caps complete.
    ['Gettare quaranta metri cubi nel plinto nord e quattro nel magrone sud.', 'Gettato il magrone sud; controllate armature e casseri nord.', 'Il fornitore ha cancellato il primo turno di consegna del calcestruzzo.', 'Ricevere le autobetoniere e completare il plinto nord.', photo('ready pile cap shutters beside fresh southern blinding')],
    ['Gettare il plinto nord con la pompa da trentasei metri.', 'Gettati quaranta metri cubi e posati i teli di maturazione.', null, 'Armare il plinto sud e controllare i richiami nord.', photo('fresh northern pile cap beneath concrete curing sheets')],
    ['Posare due tonnellate di armatura nel plinto sud.', 'Posata tutta l’armatura sud e verificati i ferri di ripresa nord.', null, 'Chiudere il cassero sud e predisporre il getto.', photo('southern pile cap reinforcement with projecting abutment bars')],
    ['Completare i casseri sud e controllare otto distanziatori principali.', 'Chiuso il cassero e verificati copriferro e quote del plinto sud.', null, 'Gettare quaranta metri cubi nel plinto sud.', photo('completed southern pile cap formwork beside concrete pump')],
    ['Gettare il plinto sud e controllare la maturazione nord.', 'Gettati quaranta metri cubi; mantenute umide entrambe le superfici.', 'Il vento asciutto ha richiesto una seconda stesura dei teli di cura.', 'Avviare la spalla nord dopo il controllo della resistenza.', photo('two curing pile caps beside river access tracks')],
    // Week 7 — abutments.
    ['Armare i primi tre metri della spalla nord.', 'Posata una tonnellata di ferri verticali e verificati gli inserti.', null, 'Montare sessanta metri quadrati di casseri nord.', photo('vertical abutment reinforcement above cured northern pile cap')],
    ['Montare sessanta metri quadrati di casseri sulla spalla nord.', 'Completati i casseri nord e fissati i puntelli esterni.', null, 'Controllare le quote e gettare il primo tratto nord.', photo('bridge abutment shutters with external steel push props')],
    ['Controllare le quote nord e gettare trenta metri cubi.', 'Rilevato uno scarto di dodici millimetri e riallineato il cassero senza gettare.', 'Il riferimento di quota sul cassero era stato riportato in modo errato.', 'Ripetere il rilievo e confermare il getto nord.', photo('survey level beside realigned bridge abutment formwork')],
    ['Ripetere il rilievo e gettare il primo tratto della spalla nord.', 'Quote confermate e gettati trenta metri cubi con sei provini.', null, 'Armare la spalla sud e mantenere umido il getto nord.', photo('fresh northern bridge abutment beside stored reinforcement bars')],
    ['Armare i primi tre metri della spalla sud.', 'Posata una tonnellata di armatura e preparati trenta metri quadrati di casseri.', null, 'Completare la casseratura sud e preparare gli appoggi provvisori dell’impalcato.', photo('southern abutment reinforcement beside partly erected timber shutters')],
    // Week 8 — deck formwork only starts.
    ['Completare sessanta metri quadrati di casseri sud.', 'Chiusi i casseri sud e preparate sei basi per i puntelli dell’impalcato.', null, 'Gettare il tratto sud e controllare la maturazione nord.', photo('southern abutment shutters beside six temporary support bases')],
    ['Gettare trenta metri cubi nella spalla sud.', 'Completato il getto e protetta la sommità con teli umidi.', null, 'Disarmare il tratto nord verificato e montare i primi puntelli.', photo('curing southern abutment beside completed northern concrete wall')],
    ['Disarmare la spalla nord e scaricare sei torri di puntellazione.', 'Disarmati sessanta metri quadrati nord; scaricate tre torri.', 'La pista sud è stata chiusa temporaneamente per fango dopo la pioggia.', 'Ripristinare la pista e ricevere le tre torri mancanti.', photo('exposed bridge abutment beside three stacked shoring towers')],
    ['Ricevere tre torri e montare sei puntellazioni iniziali.', 'Montate sei torri sul settore nord e controllate le basette.', null, 'Posare il primo tratto di travi e pannelli dell’impalcato.', photo('six shoring towers beside incomplete bridge deck supports')],
    ['Posare venti metri quadrati iniziali di casseratura dell’impalcato.', 'Completati venti metri quadrati su duecento previsti; spalle al primo tratto di getto.', null, 'Completare le spalle e proseguire la casseratura prima delle armature dell’impalcato.', photo('first bridge deck shuttering panels above shoring towers')],
  ],
  'FITT-03': [
    // Week 1 — permits pending; preparation only.
    ['Start perimeter fencing and establish the survey datum for the commercial building.', 'Checked 180 metres of boundary from the existing access; excavation plant remained off site.', 'The demolition and groundworks permit has not been issued.', 'Confirm the permit conditions and inspect the stored fence panels.', photo('closed shed beside stacked temporary mesh fence panels')],
    ['Check thirty stored fence panels and prepare the survey equipment.', 'Checked thirty panels and two survey tripods in the temporary storage bay.', null, 'Measure the existing access width and prepare the cabin base layout.', photo('mesh fence panels beside two folded survey tripods')],
    ['Measure the delivery access and set out two cabin base positions.', 'Recorded a four metre gate opening and marked two bases within the permitted storage strip.', null, 'Confirm the temporary power route before booking cabin delivery.', photo('narrow entrance gate beside marked temporary cabin bases')],
    ['Confirm the temporary power route and inspect the service cabinet.', 'Measured a 45 metre cable route and checked the empty cabinet plinth.', 'The utility connection appointment remains unconfirmed.', 'Prepare a temporary battery lighting arrangement for the storage strip.', photo('empty service cabinet plinth beside coiled power cable')],
    ['Prepare two battery lighting units and sort fence fixings.', 'Tested two lighting units and packed fixings for thirty panels.', null, 'Check the permit decision and arrange the first fencing delivery.', photo('battery lighting units beside sorted steel fence fixings')],
    // Week 2 — continued delay, no unapproved physical works.
    ['Release fencing and demolition plant orders after the permit decision.', 'Reserved thirty fence panels and a compact excavator without mobilising either.', 'The permit review requested confirmation of the shed boundary clearance.', 'Submit the measured clearance and keep the plant booking provisional.', photo('existing shed beside unused compact excavator transport trailer')],
    ['Verify the shed clearance and prepare the temporary drainage layout.', 'Measured six metres between the shed and boundary; marked the proposed outfall on the survey copy.', null, 'Confirm the service crossing levels before ordering drainage pipe.', photo('existing shed beside survey tripod and stacked drainage pipes')],
    ['Confirm levels at two service crossings and finalise the drainage order.', 'Measured the western crossing; held the eastern connection pending clarification.', 'The service drawing omits the eastern connection depth.', 'Obtain the missing depth and check the route for the temporary cable.', photo('exposed service chamber beside survey staff and pipe sections')],
    ['Recheck the eastern service depth and prepare the fencing sequence.', 'Confirmed the connection depth and grouped thirty panels into three delivery lots.', null, 'Confirm the permit release and utility appointment for mobilisation.', photo('three stacks of fencing beside existing service chamber')],
    ['Mobilise the first fencing lot and connect temporary power.', 'Received the permit release and booked fencing for Monday; tested battery lighting again.', 'The utility connection was moved to the following working week.', 'Install fencing under battery lighting and prepare the connection cabinet.', photo('battery work lights beside unopened electrical service cabinet')],
    // Week 3 — fencing, survey and connection.
    ['Install sixty metres of fencing with the general works crew.', 'Installed sixty metres along the north boundary and fixed the vehicle gate posts.', null, 'Close the remaining perimeter and establish two permanent survey points.', photo('new northern mesh fencing beside fixed steel gateposts')],
    ['Complete 120 metres of fencing and establish two survey points.', 'Closed all 180 metres of perimeter and fixed two survey monuments.', null, 'Survey the shed and mark the proposed building footprint.', photo('completed mesh perimeter beside two concrete survey monuments')],
    ['Survey the shed and set out the 300 square metre building footprint.', 'Recorded the shed corners and marked twelve grid intersections.', null, 'Connect temporary power and confirm the demolition exclusion area.', photo('survey instrument beside twelve marked building grid intersections')],
    ['Connect the service cabinet and establish the shed demolition boundary.', 'Connected temporary power and installed twenty metres of rigid demolition barrier.', 'A parked delivery trailer blocked the shed access until midday.', 'Remove the shed roof after confirming service isolation.', photo('connected electrical cabinet beside rigid shed demolition barriers')],
    ['Remove eighty square metres of shed roof with the demolition crew.', 'Removed all roof sheets and stacked them in covered skips.', null, 'Dismantle the shed frame and sort the concrete base debris.', photo('roofless small shed frame beside covered demolition skips')],
    // Week 4 — demolition and excavation.
    ['Dismantle the shed frame using the compact excavator.', 'Removed eight steel posts and segregated two tonnes of scrap.', null, 'Break out the eighty square metre shed base.', photo('dismantled steel shed columns beside compact excavator')],
    ['Break out the shed base and remove forty tonnes of rubble.', 'Broke out eighty square metres and loaded forty tonnes into four trucks.', null, 'Recheck the building grid before bulk excavation.', photo('broken concrete shed base beside four rubble skips')],
    ['Recheck twelve grid intersections and start foundation excavation.', 'Corrected two grid points and excavated the first thirty cubic metres.', 'A survey transcription error displaced the eastern grid by forty millimetres.', 'Use the corrected grid to complete the eastern excavation.', photo('corrected survey markers beside shallow eastern foundation excavation')],
    ['Excavate sixty cubic metres from the eastern half of the footprint.', 'Removed sixty cubic metres and trimmed the formation with the excavator bucket.', null, 'Complete the western excavation and check the formation levels.', photo('excavator trimming eastern formation beside stacked spoil')],
    ['Excavate sixty cubic metres west and survey the formation.', 'Completed 150 cubic metres of bulk excavation with levels within ten millimetres.', null, 'Cut the drainage trenches before placing foundation blinding.', photo('completed building excavation beside level survey equipment')],
    // Week 5 — drainage and blinding.
    ['Cut forty metres of drainage trench with the groundworks crew.', 'Excavated forty metres and prepared two inspection chamber bases.', null, 'Lay the first twenty metres of drainage pipe.', photo('fresh drainage trenches beside two concrete chamber bases')],
    ['Lay twenty metres of drainage pipe and one inspection chamber.', 'Installed twenty metres of pipe on granular bedding and set the western chamber.', null, 'Complete the eastern drainage run and test both chambers.', photo('drainage pipe on gravel bedding beside installed chamber')],
    ['Install twenty metres of eastern drainage and the second chamber.', 'Installed twelve metres before pumping water from the trench.', 'Heavy rain filled the lowest eight metres of trench.', 'Dewater the remaining trench and complete the drainage test.', photo('dewatering pump beside rain filled drainage trench')],
    ['Complete eight metres of drainage and test forty metres of pipe.', 'Installed the remaining pipe and passed the water test on both runs.', null, 'Backfill the pipe trenches and prepare foundation blinding.', photo('completed drainage pipes beside two inspection chambers')],
    ['Backfill forty metres of drainage and place six cubic metres of blinding.', 'Compacted the trench backfill and completed blinding below all twelve pads.', null, 'Fix the first six foundation reinforcement cages.', photo('twelve concrete blinding pads beside compacted drainage backfill')],
    // Week 6 — foundations.
    ['Fix reinforcement cages for six western foundation pads.', 'Installed six cages and checked 75 millimetre cover blocks.', null, 'Fix the six eastern cages and prepare pad shutters.', photo('six reinforcement cages seated on concrete blinding pads')],
    ['Fix six eastern cages and erect twelve pad shutters.', 'Completed all cages and fixed shutters around twelve pads.', null, 'Inspect the reinforcement and set column starter bars.', photo('twelve reinforced foundation pads within timber shutters')],
    ['Inspect twelve pad cages and set twenty-four starter bar groups.', 'Checked all cages and secured twenty-four starter groups with templates.', null, 'Cast the western pads and prepare the eastern concrete delivery.', photo('column starter reinforcement fixed within concrete pad shutters')],
    ['Cast eighteen cubic metres in six western pads.', 'Completed six western pads and took six concrete samples.', null, 'Cast eighteen cubic metres in the eastern pads.', photo('six fresh concrete foundation pads beside sample moulds')],
    ['Cast six eastern pads with eighteen cubic metres of concrete.', 'Checked shutters and starter bars; kept the eastern pads ready for pouring.', 'The concrete supplier postponed the second delivery after a plant breakdown.', 'Confirm the replacement delivery and complete the eastern pads.', photo('ready eastern foundation shutters beside stationary concrete pump')],
    // Week 7 — ground-floor slab.
    ['Cast eighteen cubic metres in the six eastern pads.', 'Completed all twelve pads and covered the eastern concrete for curing.', null, 'Verify western pad strength and prepare slab sub-base.', photo('completed concrete foundation pads beneath protective curing sheets')],
    ['Check pad strength and place 300 square metres of slab sub-base.', 'Western strength results accepted; compacted the first 150 square metres.', null, 'Complete the sub-base and install service sleeves.', photo('aggregate compactor beside partly completed ground floor subbase')],
    ['Compact 150 square metres and install eight service sleeves.', 'Completed the sub-base and fixed all eight sleeves to the grid.', null, 'Lay the membrane and reinforcement mesh over the slab footprint.', photo('compacted slab subbase with eight vertical service sleeves')],
    ['Lay 300 square metres of membrane and reinforcement mesh.', 'Completed the membrane and mesh; eastern pad strength results accepted.', null, 'Pour the slab and arrange the first block delivery.', photo('slab membrane and reinforcement mesh around service sleeves')],
    ['Pour thirty cubic metres for the ground-floor slab and receive blocks.', 'Completed the 300 square metre slab and applied curing compound.', 'The block delivery was moved by one working day after a vehicle fault.', 'Maintain slab curing and unload the replacement block delivery.', photo('fresh ground floor concrete slab beside empty pallets')],
    // Week 8 — curing, blockwork and scaffold start.
    ['Maintain slab curing and unload twelve pallets of concrete blocks.', 'Protected the slab and stored twelve pallets outside the building footprint.', null, 'Check slab levels and prepare perimeter scaffold bases.', photo('curing concrete slab beside twelve concrete block pallets')],
    ['Survey the slab and prepare twenty scaffold sole boards.', 'Recorded levels within six millimetres and installed twenty sole boards externally.', null, 'Erect the first ten metres of scaffold outside the north wall.', photo('survey tripod on slab beside timber scaffold soleboards')],
    ['Erect ten metres of north scaffold and sort masonry mortar materials.', 'Installed ten metres of scaffold from the external access strip and staged six sand bags.', null, 'Extend the scaffold and confirm slab access for masonry.', photo('first scaffold bays beside stacked mortar material bags')],
    ['Extend scaffold to twenty metres and verify slab loading clearance.', 'Completed twenty metres of scaffold; the seven-day slab review released the north wall strip.', null, 'Lay the first two block courses along the north wall.', photo('twenty metres of scaffold beside cured concrete slab')],
    ['Lay two courses over thirty metres of north wall with the masonry crew.', 'Completed twelve square metres of starter blockwork and checked six opening positions.', null, 'Continue blockwork above the starter courses and extend the scaffold along the east wall.', photo('starter concrete blockwork beside scaffold and finished slab')],
  ],
  'FITT-04': [
    // Week 1 — MEP rough-in.
    ['Install forty metres of cable tray in warehouse bay D3.', 'Electrical crew fixed forty metres of tray using two scissor lifts.', null, 'Extend the tray route and start the main ventilation duct.', photo('cable trays beside two parked warehouse scissor lifts')],
    ['Install thirty metres of tray and twenty metres of ventilation duct.', 'Completed thirty metres of tray and twenty metres of main duct.', null, 'Install the office branch ducts and sprinkler supports.', photo('main ventilation duct beside overhead steel cable trays')],
    ['Install twelve office branch ducts and twenty sprinkler supports.', 'Installed eight branch ducts and all twenty sprinkler supports.', 'The revised drawing omits the clearance above four office partitions.', 'Confirm the branch levels and complete the remaining ducts.', photo('unfinished branch ducts above office partition framing')],
    ['Complete four branch ducts and pull sixty metres of power cable.', 'Completed all twelve branches and pulled sixty metres of cable to the plant room.', null, 'Fit sprinkler mains and terminate the first lighting circuits.', photo('completed office duct branches beside coiled electrical cables')],
    ['Install thirty metres of sprinkler main and terminate four lighting circuits.', 'Fixed thirty metres of main and terminated four circuits in the distribution board.', null, 'Complete the sprinkler main and prepare the ceiling service inspection.', photo('sprinkler main beside partly terminated electrical distribution board')],
    // Week 2 — sprinklers and ceiling grid.
    ['Install thirty metres of sprinkler main and forty branch fittings.', 'Completed sixty metres of main in total and installed forty branch fittings.', null, 'Install forty sprinkler heads and pressure-test the first section.', photo('completed sprinkler mains above open warehouse ceiling grid')],
    ['Install forty sprinkler heads and pressure-test the western section.', 'Installed thirty heads and prepared the western pressure-test manifold.', 'The final ten heads were missing from the delivery crate.', 'Receive the ten heads and complete the western pressure test.', photo('sprinkler branches beside partly filled delivery crate')],
    ['Install ten remaining heads and test the western sprinkler section.', 'Completed forty heads and held the western section at test pressure for two hours.', null, 'Test the eastern section and inspect concealed services.', photo('sprinkler test manifold beside completed overhead branch pipework')],
    ['Test the eastern sprinkler section and inspect services above offices.', 'Eastern test passed; inspected 200 square metres of concealed service routes.', null, 'Release the office ceiling grid installation.', photo('exposed ceiling services beside sprinkler pressure test manifold')],
    ['Install 100 square metres of suspended ceiling grid in office D1.', 'Installed 100 square metres of grid and checked twenty suspension points.', null, 'Extend the grid and install the first ceiling tiles.', photo('suspended office ceiling grid above unfinished partition walls')],
    // Week 3 — ceilings and painting.
    ['Install 100 square metres of grid and receive ceiling tiles.', 'Completed 200 square metres of grid and sorted the first tile pallets.', 'The access gate was blocked by a shared delivery trailer for two hours.', 'Install the first 100 square metres of ceiling tiles.', photo('complete ceiling grid beside stacked wrapped ceiling tiles')],
    ['Install 100 square metres of ceiling tiles with the finishing crew.', 'Fitted 100 square metres and cut eight access hatch openings.', null, 'Complete the remaining tiles and prepare wall surfaces.', photo('partly tiled suspended ceiling beside open access hatches')],
    ['Complete 100 square metres of ceiling tiles and sand office walls.', 'Completed the office ceiling and prepared 250 square metres of wall surface.', null, 'Prime the office walls and protect the finished ceiling edges.', photo('completed suspended ceiling above prepared bare office walls')],
    ['Prime 250 square metres of office walls and mask door frames.', 'Applied primer to all office walls and masked twelve frames.', null, 'Apply the first finish coat after checking surface dryness.', photo('primed office walls beside masked metal door frames')],
    ['Apply the first finish coat to 250 square metres of wall.', 'Painted 150 square metres and ventilated the remaining damp partition faces.', 'High humidity after overnight rain delayed drying in the east office.', 'Finish the first coat once the eastern surfaces are dry.', photo('partly painted office walls beside portable ventilation equipment')],
    // Week 4 — doors and electrical completion.
    ['Complete the first coat and prepare twelve door openings.', 'Finished the remaining 100 square metres and measured all twelve openings.', null, 'Fit the first six internal doors and apply the second paint coat.', photo('painted office walls beside twelve empty door openings')],
    ['Fit six internal doors and paint 125 square metres of wall.', 'Installed six doors and completed the second coat in the west office.', null, 'Fit the eastern doors and finish the remaining wall surfaces.', photo('installed internal doors beside freshly painted western office')],
    ['Fit six eastern doors and finish 125 square metres of painting.', 'Installed five doors and completed the second coat throughout the offices.', null, 'Resolve the last door opening and finish electrical terminations.', photo('five installed doors beside one empty eastern opening')],
    ['Fit the final door and terminate twelve lighting circuits.', 'Terminated twelve circuits; held the final door off its opening.', 'The delivered final door leaf is forty millimetres too narrow.', 'Order the correct leaf and test circuit continuity.', photo('undersized door leaf beside open frame and tools')],
    ['Test continuity on sixteen circuits and fit twenty-four light fittings.', 'Continuity checks passed and twenty-four fittings were installed.', null, 'Energise the lighting circuits and begin HVAC pre-commissioning.', photo('installed warehouse light fittings beside closed distribution boards')],
    // Week 5 — electrical and HVAC commissioning.
    ['Energise sixteen lighting circuits and inspect three air handling units.', 'Lighting operated on all circuits; checked filters and belts on three units.', null, 'Test electrical protection and start the first air handling unit.', photo('warehouse lighting beside three assembled air handling units')],
    ['Test sixteen protective devices and start air handling unit one.', 'All sixteen devices passed; unit one ran for thirty minutes.', null, 'Start units two and three and record preliminary airflows.', photo('electrical test equipment beside running ventilation fan assembly')],
    ['Start units two and three and record airflow at twelve outlets.', 'Started both units and measured eight outlets before a supply interruption.', 'The scheduled permanent power connection required a two-hour isolation.', 'Restore power and complete the four remaining airflow readings.', photo('airflow measuring hood beside office ventilation diffusers')],
    ['Complete four airflow readings and balance the three ventilation branches.', 'Recorded all twelve outlets and adjusted three dampers to the design range.', null, 'Test sprinkler alarms and confirm the final door delivery.', photo('ventilation dampers beside installed ceiling diffusers and ductwork')],
    ['Test four sprinkler alarm interfaces and fit the replacement door.', 'All four interfaces responded; the correctly sized final door was installed.', null, 'Complete integrated electrical and HVAC checks before snagging.', photo('completed door assembly beside sprinkler alarm interface cabinet')],
    // Week 6 — commissioning completion and snagging.
    ['Run integrated electrical and HVAC checks for four hours.', 'Completed the four-hour run and listed eighteen finishing snags.', null, 'Close ceiling and door snags and assemble the test certificates.', photo('commissioned plant equipment beside finished warehouse office entrance')],
    ['Close six ceiling snags and assemble sixteen circuit test certificates.', 'Closed six snags and collected fifteen of the sixteen certificates.', 'One protective-device test certificate was missing from the electrical pack.', 'Obtain the missing certificate and close the door adjustment snags.', photo('completed ceiling tiles beside electrical testing instrument case')],
    ['Obtain the final certificate and adjust four door closers.', 'Completed the electrical certificate pack and closed four door snags.', null, 'Repair four paint defects and check scaffold removal requirements.', photo('adjusted door closer beside completed painted door frame')],
    ['Repair four paint defects and inspect the east access scaffold.', 'Closed four paint snags; kept the isolated scaffold out of use pending removal.', null, 'Close the last four snags using the mobile access platform.', photo('repaired office wall beside isolated internal access scaffold')],
    ['Close four remaining snags with the mobile access platform.', 'All eighteen snags closed; repeated the final lighting and ventilation checks.', null, 'Start deep cleaning and compile the as-built service drawings.', photo('parked mobile access platform inside completed warehouse bay')],
    // Week 7 — cleaning and documentation.
    ['Deep-clean 600 square metres of warehouse floor.', 'Cleaned 400 square metres with the scrubber dryer.', 'A pallet collection delay left 200 square metres inaccessible.', 'Remove the pallets and finish the remaining floor area.', photo('floor scrubber beside stacked pallets on warehouse concrete')],
    ['Remove twelve empty pallets and clean 200 square metres.', 'Removed twelve pallets and completed the full 600 square metre floor clean.', null, 'Clean the offices and verify the electrical as-built drawing set.', photo('clean warehouse concrete floor beside parked scrubber dryer')],
    ['Clean 200 square metres of offices and verify eight electrical drawings.', 'Cleaned all office areas and checked eight electrical as-built sheets.', null, 'Verify six HVAC sheets and complete sprinkler test records.', photo('clean office floor beneath finished ceilings and diffusers')],
    ['Check six HVAC drawings and four sprinkler test records.', 'Verified six drawings and compiled all four sprinkler test records.', null, 'Confirm concealed valve positions and assemble the handover pack.', photo('finished sprinkler valve assembly beside closed equipment covers')],
    ['Confirm six concealed valves and assemble the handover pack.', 'Located five valves and assembled the test and maintenance sections.', 'One access hatch position differs from the latest service drawing.', 'Survey the sixth valve and correct its as-built position.', photo('open ceiling access hatch beside concealed sprinkler valve')],
    // Week 8 — handover and demobilisation.
    ['Survey the sixth valve and complete the final handover pack.', 'Corrected one as-built position and completed all eighteen drawing sheets.', null, 'Carry out the acceptance walk and remove surplus materials.', photo('completed ceiling hatch beneath finished warehouse service routes')],
    ['Complete the acceptance walk and remove two skips of surplus material.', 'Acceptance walk completed; removed one skip and segregated the second load.', 'The second collection vehicle was delayed until the following morning.', 'Remove the last skip and demobilise the access equipment.', photo('single surplus material skip beside finished warehouse entrance')],
    ['Remove the final skip and dismantle the isolated access scaffold.', 'Removed the skip and all scaffold components; returned the mobile platform.', null, 'Return the temporary cabins and inspect the handover equipment kit.', photo('stacked dismantled scaffold components beside empty loading bay')],
    ['Remove two temporary cabins and complete the final clean.', 'Removed both cabins, checked the returned equipment kit and cleaned the loading apron.', null, 'Record key transfer and close the demobilisation checklist.', photo('empty cabin bases beside freshly cleaned loading apron')],
    ['Transfer twelve keys and record completion of the fit-out.', 'Twelve keys and the complete handover pack were accepted; all temporary plant left site.', null, 'Retain the signed handover record and schedule the routine warranty review.', photo('completed empty warehouse with closed doors and ceilings')],
  ],
};

const TASK_TITLES = {
  'FITT-01': ['Montare i restanti sessanta metri della linea B', 'Completare i cablaggi della linea B', 'Programmare le prove a vuoto della linea B', 'Installare il quarto quadro secondario',
    'Completare l’avviamento della linea A', 'Verificare le sequenze del deviatore A', 'Proseguire le passerelle della linea B', 'Verificare i verbali elettrici della linea A',
    'Verificare le terminazioni degli otto motori', 'Approvare il percorso rialzato della passerella', 'Completare le dodici fondazioni', 'Chiudere la struttura di sostegno',
    'Assemblare i sessanta metri della linea A', 'Allineare le guide della linea A', 'Montare i quaranta metri iniziali della linea B', 'Ricevere le staffe per il tratto successivo della linea B'],
  'FITT-02': ['Completare la casseratura dell’impalcato', 'Posare le armature dell’impalcato', 'Programmare il getto dell’impalcato', 'Completare le spalle del ponte',
    'Estendere le prime sei torri di puntellazione', 'Verificare i verbali degli otto pali', 'Chiudere la recinzione di cantiere', 'Completare le piste nord e sud',
    'Gettare i due plinti di coronamento', 'Confermare il calcestruzzo per la sommità delle spalle'],
  'FITT-03': ['Extend the north wall blockwork', 'Start the east wall blockwork', 'Extend the scaffold along the east wall', 'Install the first lintels',
    'Prepare the upper wall reinforcement', 'Plan the roof steel delivery', 'Check the first blockwork courses', 'Complete the scaffold inspection'],
  'FITT-04': ['Complete MEP rough-in', 'Accept the sprinkler pressure tests', 'Complete office ceilings', 'Finish office painting', 'Replace the undersized door',
    'Complete electrical commissioning', 'Balance the three HVAC branches', 'Verify the internal handover record', 'Close all eighteen finishing snags', 'Complete cleaning and demobilisation'],
};

const DEVIATION_TEXTS = {
  'FITT-01': [
    ['Staffa mancante per il tratto successivo B', 'Mancano quattro staffe del lotto successivo ai quaranta metri già montati della linea B.'],
    ['Certificato quadro secondario incompleto', 'Il fascicolo del terzo quadro secondario non comprende il verbale della prova dielettrica.'],
    ['Disegno finale deviatore da aggiornare', 'Il disegno del deviatore A deve recepire la quota verificata durante le prove con cassette.'],
    ['Passerella interferente con tubazione antincendio', 'Il percorso originario in zona 2 collide con la tubazione; la variante rialzata richiede approvazione formale.'],
    ['Prolunga passerelle linea B', 'Occorre prolungare di otto metri il percorso portacavi oltre il tratto B già montato.'],
    ['Taratura sensori terminali A', 'I due sensori terminali richiedono il controllo delle soglie durante le prove continuative.'],
    ['Terminazioni elettriche linea B', 'Restano da collegare i motori dei sessanta metri di linea B non ancora montati.'],
    ['Riscontro quota deviatore A', 'La quota del deviatore è stata corretta e attende verifica interna sul verbale di misura.'],
    ['Documentazione serraggi struttura', 'Completata la raccolta delle coppie di serraggio; resta la verifica interna del fascicolo.'],
    ['Consegna tardiva carpenteria', 'Quattro travi sono arrivate con un giorno di ritardo; struttura completata nella terza settimana.'],
    ['Riferimento topografico spostato', 'Corretto uno scarto di sei millimetri prima di completare l’allineamento della linea A.'],
    ['Richiesta duplicata di ripristino basamento', 'La ripresa del basamento era già compresa nelle opere civili e non costituisce lavoro aggiuntivo.'],
  ],
  'FITT-02': [
    ['Consegna calcestruzzo per sommità spalle', 'La finestra di consegna del prossimo getto non è confermata dopo due rinvii del fornitore.'],
    ['Pista sud da stabilizzare', 'La pioggia provoca ristagni ricorrenti; in corso il rinforzo del fondo con pietrisco.'],
    ['Quota cassero spalla nord errata', 'Corretto uno scarto di dodici millimetri e ripetuto il rilievo prima del getto.'],
    ['Richiesta di impermeabilizzazione anticipata', 'L’impermeabilizzazione non può iniziare sulla casseratura iniziale, prima del getto dell’impalcato.'],
  ],
  'FITT-03': [
    ['Utility connection delay', 'The temporary connection arrived in week three and delayed full mobilisation during the first two weeks.'],
    ['Demolition permit release delay', 'Groundworks and shed demolition waited for the permit release at the end of week two.'],
    ['Eastern grid survey offset', 'A forty millimetre transcription error was corrected before eastern foundation excavation.'],
  ],
  'FITT-04': [
    ['Undersized final door leaf', 'The delivered leaf was forty millimetres too narrow; the replacement was installed before acceptance.'],
    ['Missing electrical test certificate', 'One protective-device certificate was retrieved and added to the completed test pack.'],
    ['Concealed valve position mismatch', 'The sixth valve position was surveyed and corrected on the final as-built drawing.'],
    ['Ceiling fixing clearance clash', 'Four branch ducts were coordinated with the partition heads before closing the ceiling.'],
    ['Delayed surplus pallet collection', 'Twelve pallets were removed before the final floor cleaning was completed.'],
    ['Duplicate request for door adjustment', 'The requested adjustment was already included in the original snag list and carried out once.'],
  ],
};

const DEVIATION_DAYS = {
  'FITT-01': [36, 38, 39, 17, 32, 33, 39, 37, 38, 13, 25, 27],
  'FITT-02': [39, 2, 32, 38], 'FITT-03': [9, 0, 17], 'FITT-04': [18, 26, 34, 2, 30, 28],
};
const IMPACT_DEVIATIONS = { 'FITT-01': [4, 1, 3, 9], 'FITT-02': [0, 2], 'FITT-03': [1], 'FITT-04': [0, 5] };

const IMPACT_TITLES = {
  'FITT-01': ['Prolunga passerelle della linea B', 'Recupero certificazione del quadro secondario', 'Rialzo passerella presso la tubazione antincendio', 'Attesa della carpenteria metallica'],
  'FITT-02': ['Attesa delle autobetoniere per le spalle', 'Rilievo ripetuto della spalla nord'],
  'FITT-03': ['Extended plant reservation during permit delay'],
  'FITT-04': ['Replacement of the undersized door leaf', 'Duplicate door adjustment request'],
};

export function mediaPlan() {
  return SITES.flatMap(code => [
    ...DIARY[code].map((entry, index) => ({ site: code, date: workingDate(code, index), kind: 'diary', prompt: entry[4] })),
    ...HSE[code].map(([type, severity], index) => ({
      site: code, kind: 'hse', type, severity,
      prompt: type === 'observation'
        ? `${HSE_SCENES[code][index]}, documentary construction photograph, no people, no faces, no text, no logos`
        : `1930s construction safety poster, single clear scene: ${HSE_SCENES[code][index]}, bold flat shapes, limited ink colours, no faces, no identifiable people, no text, no logos`,
    })),
  ]);
}

// A local WBS code is not a site identifier. These fixtures deliberately repeat C03.
SITE_META['FITT-05'] = { name: 'Impianto di smistamento C03', location: 'Zona dimostrativa', start: '2026-11-02', end: '2026-11-27', weeks: 0, diary: 0 };
WBS['FITT-03'].push(['C03', 'C03 night work section', 0, null]);
WBS['FITT-05'] = [['C03', 'Tratta C03 del secondo cantiere', 0, null]];
for (const dataset of [PURCHASE_ORDERS, PACKAGES, SHIPMENTS, TYPES, ITEMS, EMPLOYEES, DEVIATIONS, DEVIATION_TEXTS,
  IMPACTS, HSE, HSE_ASSETS, HSE_INSPECTIONS, DIARY, TASK_TITLES, TASK_PROFILES]) dataset['FITT-05'] = [];

export function plan() {
  const total = dataset => SITES.reduce((sum, code) => sum + dataset[code].length, 0);
  return { SITES, SITE_META, WBS, PURCHASE_ORDERS, PACKAGES, SHIPMENTS, TYPES, ITEMS, EMPLOYEES, DEVIATIONS, DEVIATION_TEXTS, IMPACTS,
    HSE, HSE_ASSETS, HSE_INSPECTIONS, DIARY, TASK_TITLES, TASK_PROFILES,
    taskStatuses: TASK_PROFILES['FITT-01'].length,
    counts: { sites: SITES.length, diary: total(DIARY), hse: total(HSE), tasks: total(TASK_PROFILES) + 1,
      hseAssets: total(HSE_ASSETS), inspections: total(HSE_INSPECTIONS),
      purchaseOrders: total(PURCHASE_ORDERS),
      purchaseOrderItems: SITES.reduce((sum, code) => sum + PURCHASE_ORDERS[code].reduce((count, order) => count + order.items.length, 0), 0),
      packages: total(PACKAGES),
      packageItems: SITES.reduce((sum, code) => sum + PACKAGES[code].reduce((count, pkg) => count + pkg.items.length, 0), 0),
      shipments: total(SHIPMENTS),
      shipmentReceipts: SITES.reduce((sum, code) => sum + SHIPMENTS[code].reduce((count, shipment) => count + (shipment.receipts?.length ?? 0), 0), 0),
      inspectionEvents: total(HSE_INSPECTIONS), media: mediaPlan().length } };
}

const evidenceOwnerId = id('responsibility:synthetic-account');
const waiverTaskKey = 'FITT-01:evidence:waiver';
async function seedEvidence(db, siteId, bump) {
  const examples = [
    ['FITT-EV-1', 'Verifica del supporto campione', 'in_progress'],
    ['FITT-EV-2', 'Allineamento della guida campione', 'open'],
    ['FITT-EV-3', 'Controllo della passerella campione', 'approved'],
  ].map(([source_id, title, status]) => ({ source_id, deviation_no: source_id, title, status, source_status: status }));
  for (const [sourceSystem, exportDate, scope, rows] of [
    ['internal', '2026-11-10', 'Area dimostrativa A', examples.slice(0, 2)],
    ['internal', '2026-11-11', 'Area dimostrativa A', []],
    ['other', '2026-11-10', 'Area dimostrativa B', examples.slice(2)],
    ['other', '2026-11-11', 'Area dimostrativa C', []],
  ]) {
    const fileSha256 = createHash('sha256').update(JSON.stringify([siteId, sourceSystem, exportDate, scope, rows])).digest('hex');
    const meta = { sourceSystem, exportDate, scope, complete: true, fileSha256 };
    if (!await registeredDeviationExport(db, siteId, meta)) {
      await storeDeviationExport(db, siteId, meta, rows, at);
      const batch = await registeredDeviationExport(db, siteId, meta);
      await db.run(`INSERT INTO demo_seed_records (table_name, record_id) VALUES ('deviation_exports', ?) ON CONFLICT DO NOTHING`, String(batch.id));
      if (rows.length) {
        await db.run(`INSERT INTO users (id, email, name, password_hash, password_algo, created_at)
          VALUES (?, 'demo-responsible@example.invalid', 'Responsabile dimostrativo', 'unusable', 'scrypt', ?) ON CONFLICT (id) DO NOTHING`,
        evidenceOwnerId, at);
        await db.run("INSERT INTO site_members (site_id, user_id, role) VALUES (?, ?, 'editor') ON CONFLICT DO NOTHING", siteId, evidenceOwnerId);
        await db.run(`UPDATE deviations SET internal_owner_id = ?, internal_owner_since = ?
          WHERE site_id = ? AND source_system = ? AND source_id IN ('FITT-EV-1', 'FITT-EV-3')`, evidenceOwnerId, at, siteId, sourceSystem);
      }
    }
    rows.forEach(() => bump('deviations'));
  }
  const taskId = id(waiverTaskKey), declared = '2026-11-10T08:00:00.000Z', closed = '2026-11-11T08:00:00.000Z';
  const reason = 'Taratura dimostrativa registrata a mano durante la simulazione.';
  const task = await db.get('SELECT id FROM tasks WHERE id = ?', taskId);
  if (!task) {
    await db.run(`INSERT INTO tasks (id, site_id, title, executor, verifier, status, created_at, declared_at, acceptance_state)
      VALUES (?, ?, 'Registrare la taratura campione', 'Squadra dimostrativa', 'Verificatore dimostrativo', 'closed', ?, ?, 'declared')`, taskId, siteId, at, declared);
    await db.run(`INSERT INTO task_events (task_id, at, actor, from_status, to_status, action, note, reason, waiver)
      VALUES (?, ?, 'Squadra dimostrativa', 'in_progress', 'to_verify', 'submit', 'Taratura dichiarata.', NULL, FALSE),
      (?, ?, 'Verificatore dimostrativo', 'to_verify', 'closed', 'close', NULL, ?, TRUE)`,
    taskId, declared, taskId, closed, reason);
  }
  bump('tasks');
}

async function requireDemoSeedRecords(db) {
  try {
    await db.get('SELECT table_name, record_id FROM demo_seed_records LIMIT 0');
  } catch (error) {
    if (error.code !== '42P01' &&
        !(error.code === 'ERR_SQLITE_ERROR' && error.message === 'no such table: demo_seed_records')) throw error;
    throw new Error('Missing demo_seed_records table. Apply the database migrations (including 054) before running the demo seed.', { cause: error });
  }
}

// The seed manifest records exact inserted/upserted IDs. Reset never deletes by
// site alone. Unknown rows and legacy seeds without a manifest remain untouched;
// inbound operational references block deletion and roll back the reset.
export async function reset(db) {
  await requireDemoSeedRecords(db);
  let removed = 0;
  const ids = table => db.all('SELECT record_id FROM demo_seed_records WHERE table_name = ?', table);
  const tables = ['deviation_exports', 'shipment_receipts', 'shipments', 'package_items', 'packages', 'purchase_order_items', 'purchase_orders',
    'site_progress_item_steps', 'employee_certifications', 'time_bookings', 'cost_impacts', 'deviations',
    'progress_entries', 'site_progress_items', 'progress_type_steps', 'progress_types', 'work_days', 'employees',
    'hse_inspection_items', 'hse_inspections', 'hse_assets', 'hse_events', 'task_events', 'tasks', 'diary', 'project_structure'];
  for (const table of tables) {
    for (const { record_id: recordId } of await ids(table)) {
      if (table === 'shipments') await db.run('DELETE FROM shipment_packages WHERE shipment_id = ?', recordId);
      if (table === 'packages') await db.run('DELETE FROM package_items WHERE package_id = ?', recordId);
      if (table === 'cost_impacts') await db.run('DELETE FROM cost_impact_deviations WHERE cost_impact_id = ?', recordId);
      if (table === 'deviations') await db.run('DELETE FROM deviation_links WHERE deviation_id = ?', recordId);
      if (table === 'tasks') {
        await db.run('DELETE FROM task_events WHERE task_id = ? AND at = ?', recordId, at);
        if (recordId === id(waiverTaskKey)) await db.run(`DELETE FROM task_events WHERE task_id = ?
          AND ((at = ? AND action = 'submit') OR (at = ? AND action = 'close' AND waiver = TRUE))`,
        recordId, '2026-11-10T08:00:00.000Z', '2026-11-11T08:00:00.000Z');
      }
      if (table === 'project_structure') {
        // Seed descendants may refer to earlier seed roots. All seed links are
        // removed together; an unrelated child still prevents deleting its parent.
        await db.run(`UPDATE project_structure SET parent_id = NULL WHERE CAST(id AS TEXT) IN
          (SELECT record_id FROM demo_seed_records WHERE table_name = 'project_structure')`);
      }
      removed += Number((await db.run(`DELETE FROM ${table} WHERE id = ?`, recordId)).rowCount);
    }
  }
  if ((await ids('users')).some(row => row.record_id === evidenceOwnerId)) {
    await db.run(`DELETE FROM site_members WHERE user_id = ? AND site_id IN
      (SELECT id FROM sites WHERE code = 'FITT-01')`, evidenceOwnerId);
    // Keep identities referenced by invitation or permission history.
    await db.run(`DELETE FROM users WHERE id = ?
      AND NOT EXISTS (SELECT 1 FROM invitations WHERE created_by = ?)
      AND NOT EXISTS (SELECT 1 FROM user_permissions WHERE user_id = ? OR granted_by = ?)`,
    evidenceOwnerId, evidenceOwnerId, evidenceOwnerId, evidenceOwnerId);
  }
  await db.run("DELETE FROM demo_seed_records WHERE table_name <> 'sites'");
  return removed;
}

export async function apply(db, { demoSandbox = isDemoSandbox() } = {}) {
  await requireDemoSeedRecords(db);
  const storage = db;
  db = { ...storage, run: async (sql, ...args) => {
    const result = await storage.run(sql, ...args);
    const insert = /^\s*INSERT INTO (\w+)\s*\(id,/.exec(sql);
    if (insert && typeof args[0] === 'string') await storage.run(`INSERT INTO demo_seed_records (table_name, record_id)
      VALUES (?, ?) ON CONFLICT DO NOTHING`, insert[1], args[0]);
    return result;
  } };
  const referenceSite = await db.get('SELECT demo_sandbox FROM sites WHERE code = ?', SITES[0]);
  const counts = {};
  const bump = key => { counts[key] = (counts[key] || 0) + 1; };
  for (const code of SITES) {
    const meta = SITE_META[code];
    await db.run(`INSERT INTO sites (id, code, name, location, start_date, end_date, created_at, demo_sandbox)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (code) DO UPDATE SET name = excluded.name, location = excluded.location,
        start_date = excluded.start_date, end_date = excluded.end_date`,
    id(`${code}:site`), code, meta.name, meta.location, meta.start, meta.end, at,
    Boolean(demoSandbox || referenceSite?.demo_sandbox));
    const site = await db.get('SELECT id FROM sites WHERE code = ?', code);
    if (!site) throw new Error(`Missing synthetic site ${code}`);
    const siteId = site.id;
    if (demoSandbox) await db.run('UPDATE sites SET demo_sandbox = TRUE WHERE id = ? AND NOT demo_sandbox', siteId);
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

    for (const order of PURCHASE_ORDERS[code]) {
      const orderId = id(`${code}:purchase-order:${order.poNo}`);
      const createdAt = `${order.orderedOn}T08:00:00.000Z`;
      const updatedAt = `${REFERENCE_DAY}T08:00:00.000Z`;
      await db.run(`INSERT INTO purchase_orders
        (id, site_id, po_no, supplier_name, ordered_on, status, notes, closed_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET supplier_name = excluded.supplier_name, ordered_on = excluded.ordered_on,
          status = excluded.status, notes = excluded.notes, closed_at = excluded.closed_at, updated_at = excluded.updated_at`,
      orderId, siteId, order.poNo, order.supplierName, order.orderedOn, order.status, order.notes ?? null,
      order.closedAt ?? null, createdAt, updatedAt);
      bump('purchaseOrders');
      for (const item of order.items) {
        const wbs = item.wbsCode
          ? await db.get('SELECT id FROM project_structure WHERE site_id = ? AND wbs_code = ?', siteId, item.wbsCode)
          : null;
        await db.run(`INSERT INTO purchase_order_items
          (id, purchase_order_id, line_no, material_no, description, unit, quantity, wbs_id, status,
            execution_started_on, completed_on, not_relevant_on, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET line_no = excluded.line_no, material_no = excluded.material_no,
            description = excluded.description, unit = excluded.unit, quantity = excluded.quantity, wbs_id = excluded.wbs_id,
            status = excluded.status, execution_started_on = excluded.execution_started_on,
            completed_on = excluded.completed_on, not_relevant_on = excluded.not_relevant_on, updated_at = excluded.updated_at`,
        id(`${code}:purchase-order:${order.poNo}:line:${item.lineNo}`), orderId, item.lineNo, item.materialNo ?? null,
        item.description, item.unit, item.quantity, wbs?.id ?? null, item.status,
        item.execution_started_on ?? null, item.completed_on ?? null, item.not_relevant_on ?? null, createdAt, updatedAt);
        bump('purchaseOrderItems');
      }
    }

    const purchaseItem = async (poNo, lineNo) => {
      const item = await db.get(`SELECT i.* FROM purchase_order_items i
        JOIN purchase_orders o ON o.id = i.purchase_order_id
        WHERE o.site_id = ? AND o.po_no = ? AND i.line_no = ?`, siteId, poNo, lineNo);
      if (!item) throw new Error(`Missing demo purchase order line ${code}/${poNo}/${lineNo}`);
      return item;
    };
    for (const pkg of PACKAGES[code]) {
      const packageId = id(`${code}:package:${pkg.key}`);
      const createdAt = `${pkg.packedOn}T08:00:00.000Z`;
      const closedAt = pkg.status === 'closed' ? `${pkg.packedOn}T16:00:00.000Z` : null;
      const order = await db.get('SELECT id FROM purchase_orders WHERE site_id = ? AND po_no = ?', siteId, pkg.poNo);
      if (!order) throw new Error(`Missing demo purchase order ${code}/${pkg.poNo}`);
      await db.run(`INSERT INTO packages
        (id, site_id, purchase_order_id, package_no, status, notes, closed_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET package_no = excluded.package_no, status = excluded.status,
          notes = excluded.notes, closed_at = excluded.closed_at, updated_at = excluded.updated_at`,
      packageId, siteId, order.id, pkg.packageNo, pkg.status, pkg.notes, closedAt, createdAt, closedAt ?? createdAt);
      bump('packages');
      for (const line of pkg.items) {
        const item = await purchaseItem(pkg.poNo, line.lineNo);
        // A closed historical package may contain a line that was completed later.
        if (['completed', 'not_relevant'].includes(item.status) && pkg.status !== 'closed') {
          throw new Error(`Cannot package final demo line ${code}/${pkg.poNo}/${line.lineNo}`);
        }
        const packageItemId = id(`${code}:package:${pkg.key}:line:${line.lineNo}`);
        const otherParts = await db.all(`SELECT quantity_packed FROM package_items
          WHERE purchase_order_item_id = ? AND id <> ?`, item.id, packageItemId);
        const packed = otherParts.reduce((sum, part) => sum + Math.round(Number(part.quantity_packed) * 1000),
          Math.round(line.quantity * 1000));
        if (line.quantity <= 0 || packed > Math.round(Number(item.quantity) * 1000)) {
          throw new Error(`Invalid demo packed quantity ${code}/${pkg.poNo}/${line.lineNo}`);
        }
        await db.run(`INSERT INTO package_items
          (id, package_id, purchase_order_item_id, quantity_packed, unit, material_no, description, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET quantity_packed = excluded.quantity_packed,
            unit = excluded.unit, material_no = excluded.material_no, description = excluded.description`,
        packageItemId, packageId, item.id, line.quantity, item.unit, item.material_no, item.description, createdAt);
        bump('packageItems');
        // Reapplying also restores this transition after the purchase order upsert above.
        if (item.status === 'open') {
          await db.run(`UPDATE purchase_order_items SET status = 'in_execution', execution_started_on = ?,
            completed_on = NULL, not_relevant_on = NULL, updated_at = ? WHERE id = ?`, pkg.packedOn, createdAt, item.id);
        }
      }
      await db.run(`UPDATE purchase_orders SET status = 'in_execution', updated_at = ?
        WHERE id = ? AND closed_at IS NULL AND EXISTS (
          SELECT 1 FROM purchase_order_items WHERE purchase_order_id = ? AND status = 'in_execution')`,
      `${REFERENCE_DAY}T08:00:00.000Z`, order.id, order.id);
    }

    for (const shipment of SHIPMENTS[code]) {
      const shipmentId = id(`${code}:shipment:${shipment.shipmentNo}`);
      const createdAt = `${PACKAGES[code].find(pkg => pkg.key === shipment.packageKeys[0]).packedOn}T16:00:00.000Z`;
      await db.run(`INSERT INTO shipments
        (id, site_id, shipment_no, carrier, shipped_on, expected_on, arrived_on, status, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET shipment_no = excluded.shipment_no, carrier = excluded.carrier,
          shipped_on = excluded.shipped_on, expected_on = excluded.expected_on, arrived_on = excluded.arrived_on,
          status = excluded.status, notes = excluded.notes, updated_at = excluded.updated_at`,
      shipmentId, siteId, shipment.shipmentNo, textFor(code, 'Trasporti dimostrativi', 'Demonstration carrier'),
      shipment.shippedOn ?? null, shipment.expectedOn ?? null, shipment.arrivedOn ?? null, shipment.status,
      shipment.notes, createdAt, `${shipment.arrivedOn ?? shipment.shippedOn ?? createdAt.slice(0, 10)}T16:00:00.000Z`);
      bump('shipments');
      for (const key of shipment.packageKeys) {
        const pkg = await db.get('SELECT id FROM packages WHERE id = ? AND site_id = ?', id(`${code}:package:${key}`), siteId);
        if (!pkg) throw new Error(`Missing demo shipment package ${code}/${key}`);
        const assigned = await db.get('SELECT shipment_id FROM shipment_packages WHERE package_id = ?', pkg.id);
        if (assigned && assigned.shipment_id !== shipmentId) throw new Error(`Demo package already assigned ${code}/${key}`);
        await db.run(`INSERT INTO shipment_packages (shipment_id, package_id) VALUES (?, ?)
          ON CONFLICT (shipment_id, package_id) DO NOTHING`, shipmentId, pkg.id);
      }
      for (const receipt of shipment.receipts ?? []) {
        const item = await purchaseItem(receipt.poNo, receipt.lineNo);
        const packed = await db.all(`SELECT pi.quantity_packed FROM package_items pi
          JOIN shipment_packages sp ON sp.package_id = pi.package_id
          WHERE sp.shipment_id = ? AND pi.purchase_order_item_id = ?`, shipmentId, item.id);
        if (!packed.length || receipt.quantity > packed.reduce((sum, part) => sum + Number(part.quantity_packed), 0)) {
          throw new Error(`Invalid demo receipt ${code}/${receipt.poNo}/${receipt.lineNo}`);
        }
        await db.run(`INSERT INTO shipment_receipts
          (id, shipment_id, purchase_order_item_id, quantity_received, note, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET quantity_received = excluded.quantity_received, note = excluded.note`,
        id(`${code}:shipment:${shipment.shipmentNo}:receipt:${receipt.poNo}:${receipt.lineNo}`), shipmentId,
        item.id, receipt.quantity, receipt.note, `${receipt.receivedOn}T16:00:00.000Z`);
        bump('shipmentReceipts');
      }
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
    const englishCertNames = ['Mobile elevating work platform qualification', 'Periodic fitness examination',
      'Four-hour safety training', 'Periodic fitness examination', 'Crane operator qualification', 'First aid training',
      'Periodic fitness examination', 'Forklift operator qualification', 'Electrical work safety training',
      'Scaffold erection qualification', 'Periodic fitness examination', 'Fall protection training'];
    const englishIssuers = { qualification: 'Synthetic qualification body', medical: 'Synthetic occupational health provider', training: 'Synthetic training body' };
    for (const [index, [category, name, issuer, issuedOffset, expiresOffset]] of certPlan.entries()) {
      const employeeId = employeeIds[index % employeeIds.length];
      if (!employeeId) break;
      const certId = id(`${code}:cert:${index}:${category}`);
      await db.run(`INSERT INTO employee_certifications
        (id, site_id, employee_id, category, name, issuer, issued_on, expires_on, outcome, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
        ON CONFLICT (id) DO UPDATE SET name = excluded.name, issuer = excluded.issuer,
          issued_on = excluded.issued_on, expires_on = excluded.expires_on, outcome = excluded.outcome`,
      certId, siteId, employeeId, category, english(code) ? englishCertNames[index] : name, english(code) ? englishIssuers[category] : issuer,
      referencePlus(issuedOffset), expiresOffset == null ? null : referencePlus(expiresOffset),
      category === 'medical' ? textFor(code, 'Idoneo', 'Fit for work') : null, at2, at2);
      bump('certifications');
    }

    const workDays = [];
    for (let week = 0; week < meta.weeks; week++) {
      for (let day = 0; day < 5; day++) {
        const operationalDate = workingDate(code, week * 5 + day);
        for (const [index, employeeId] of employeeIds.entries()) {
          const night = index % 4 === 3;
          const workDayId = id(`${code}:day:${employeeId}:${legacyWorkingDate(week * 5 + day)}`);
          workDays.push({ id: workDayId, employeeId, operationalDate });
          await db.run(`INSERT INTO work_days (id, site_id, employee_id, operational_date, shift, start_time, finish_time, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET operational_date = excluded.operational_date`,
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
      // Use SQL boolean literals for compatibility with SQLite drivers that cannot bind JS booleans.
      await db.run(`INSERT INTO site_progress_items (id, site_id, wbs_id, description, section, plc_area, progress_pct,
          planned_progress_pct, assigned_to, planned_start, planned_finish, has_files, has_notes, has_deviations, source_row, created_at, progress_type_id, planned_hours)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ${index % 5 === 0 ? 'TRUE' : 'FALSE'}, ${index % 7 === 0 ? 'TRUE' : 'FALSE'}, ${index % 6 === 0 ? 'TRUE' : 'FALSE'},
          ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET description = excluded.description, progress_pct = excluded.progress_pct,
          wbs_id = excluded.wbs_id, progress_type_id = excluded.progress_type_id, planned_hours = excluded.planned_hours,
          section = excluded.section, plc_area = excluded.plc_area, assigned_to = excluded.assigned_to,
          planned_start = excluded.planned_start, planned_finish = excluded.planned_finish, planned_progress_pct = excluded.planned_progress_pct`,
      itemId, siteId, wbsCode ? wbsIds.get(wbsCode) ?? null : null, description, section, area, progress,
      Math.min(100, progress + 10), textFor(code, 'Squadra dimostrativa', 'Demonstration crew'), meta.start, meta.end,
      index + 1, at2, typeCode ? typeIds[typeCode].id : null, 40 * (1 + index % 10));
      bump('items');
      if (typeCode) {
        let completedWeight = 0;
        for (const step of typeIds[typeCode].steps) {
          // Complete weighted steps in order so the resulting percentage matches the item.
          const percent = Math.max(0, Math.min(100, (progress - completedWeight) * 100 / step.weight));
          completedWeight += step.weight;
          await db.run(`INSERT INTO site_progress_item_steps (id, site_progress_item_id, progress_type_step_id, percent, updated_at)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET percent = excluded.percent`,
          id(`${code}:state:${index + 1}:${step.id}`), itemId, step.id, percent, at2);
          bump('itemSteps');
        }
      }
    }

    // Eight chronological weekly samples, from zero to current; original suffixes 0–6 remain stable.
    const typedItems = await db.all(`SELECT s.id, s.progress_type_id, st.progress_type_step_id, st.percent
      FROM site_progress_items s JOIN site_progress_item_steps st ON st.site_progress_item_id = s.id
      WHERE s.site_id = ? AND s.progress_type_id IS NOT NULL`, siteId);
    for (const row of typedItems) {
      for (let week = 0; week < meta.weeks; week++) {
        const target = Number(row.percent) * week / (meta.weeks - 1);
        const recordedAt = `${workingDate(code, week * 5 + 4)}T16:00:00.000Z`;
        await db.run(`INSERT INTO progress_entries
          (id, site_id, site_progress_item_id, progress_type_step_id, percent, recorded_at, recorded_by)
          VALUES (?, ?, ?, ?, ?, ?, NULL) ON CONFLICT (id) DO UPDATE SET
            percent = excluded.percent, recorded_at = excluded.recorded_at`,
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
      const [title, description] = DEVIATION_TEXTS[code][index];
      const createdOn = workingDate(code, DEVIATION_DAYS[code][index]);
      await db.run(`INSERT INTO deviations (id, site_id, deviation_no, title, problem_description, status, priority, assigned_to,
          creation_date, closed_date, created_at, source_system)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'internal')
        ON CONFLICT (id) DO UPDATE SET source_system = COALESCE(deviations.source_system, excluded.source_system), status = excluded.status, title = excluded.title,
          problem_description = excluded.problem_description, assigned_to = excluded.assigned_to,
          creation_date = excluded.creation_date, closed_date = excluded.closed_date`,
      deviationId, siteId, `DEV-${String(index + 1).padStart(3, '0')}`, title, description, status, priority,
      textFor(code, 'Squadra dimostrativa', 'Demonstration crew'), createdOn,
      status === 'closed' ? workingDate(code, 39) : null, at2);
      bump('deviations');
    }

    for (const [index, [status, claim, settlement, result]] of IMPACTS[code].entries()) {
      const impactId = id(`${code}:impact:${index + 1}`);
      await db.run(`INSERT INTO cost_impacts (id, site_id, title, status, claim_amount, settlement_amount, result, created_at, closed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET status = excluded.status,
        claim_amount = excluded.claim_amount, settlement_amount = excluded.settlement_amount, result = excluded.result,
        title = excluded.title, closed_at = excluded.closed_at`,
      impactId, siteId, IMPACT_TITLES[code][index], status, claim, settlement, result, at2, status === 'closed' ? at2 : null);
      bump('impacts');
      await db.run('DELETE FROM cost_impact_deviations WHERE cost_impact_id = ?', impactId);
      await db.run(`INSERT INTO cost_impact_deviations (cost_impact_id, deviation_id) VALUES (?, ?) ON CONFLICT DO NOTHING`,
        impactId, deviationIds[IMPACT_DEVIATIONS[code][index]]);
    }

    // The previous revision had an eighth manual event on FITT-01. Remove only that seed ID.
    if (code === 'FITT-01') await db.run('DELETE FROM hse_events WHERE id = ? AND site_id = ?', id(`${code}:hse:8`), siteId);
    for (const [index, [type, severity, dayOffset, location, persons, measures, notes]] of (HSE[code] || []).entries()) {
      const eventId = id(`${code}:hse:${index + 1}`);
      await db.run(`INSERT INTO hse_events (id, site_id, event_no, type, severity, occurred_on, location, persons_involved, measures, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET type = excluded.type, severity = excluded.severity,
          occurred_on = excluded.occurred_on, location = excluded.location, persons_involved = excluded.persons_involved,
          measures = excluded.measures, notes = excluded.notes`,
      eventId, siteId, `HSE-${String(index + 1).padStart(3, '0')}`, type, severity, date(dayOffset, meta.start), location, persons, measures, notes, at2, at2);
      bump('hse');
    }

    for (const [index, [kind, category, name, assetCode, templateCode]] of (HSE_ASSETS[code] || []).entries()) {
      await db.run(`INSERT INTO hse_assets (id, site_id, kind, category, name, code, template_code, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, TRUE, ?, ?)
        ON CONFLICT (id) DO UPDATE SET name = excluded.name, code = excluded.code, category = excluded.category,
          template_code = excluded.template_code, active = TRUE`,
      id(`${code}:hse-asset:${index + 1}`), siteId, kind, category, name, assetCode, templateCode, at2, at2);
      bump('hseAssets');
    }

    for (const [index, [assetName, daysAgo, performedBy, performerRole, mode, outcome, notes, exceptions]] of (HSE_INSPECTIONS[code] || []).entries()) {
      const asset = await db.get('SELECT id, name, code, template_code FROM hse_assets WHERE site_id = ? AND name = ?', siteId, assetName);
      if (!asset) continue;
      const template = TEMPLATES.find(item => item.code === asset.template_code);
      const performedOn = referencePlus(-daysAgo);
      const nextDueOn = addMonths(performedOn, template.intervalMonths);
      const severity = { fail: 'high', pass_with_notes: 'medium', pass: 'low' }[outcome];
      const inspectionId = id(`${code}:hse-inspection:${index + 1}`);
      const eventId = id(`${code}:hse-inspection-event:${index + 1}`);
      // The register row is not a copy made by hand: it is the same row the API writes.
      await db.run(`INSERT INTO hse_events (id, site_id, event_no, type, severity, occurred_on, location,
          persons_involved, measures, notes, created_at, updated_at)
        VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET type = excluded.type, severity = excluded.severity,
          occurred_on = excluded.occurred_on, location = excluded.location, notes = excluded.notes`,
      eventId, siteId, mode === 'internal' ? 'inspection' : 'external_visit', severity, performedOn,
      asset.name, `${asset.name} — ${english(code) ? EN_CHECKLIST_TITLES[template.code] : template.title}`, at2, at2);
      bump('hseEvents');
      await db.run(`INSERT INTO hse_inspections (id, site_id, asset_id, performed_on, performed_by, performer_role,
          mode, outcome, notes, next_due_on, hse_event_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET performed_on = excluded.performed_on, outcome = excluded.outcome,
          notes = excluded.notes, next_due_on = excluded.next_due_on, performed_by = excluded.performed_by,
          performer_role = excluded.performer_role`,
      inspectionId, siteId, asset.id, performedOn, performedBy, performerRole, mode, outcome, notes, nextDueOn, eventId, at2, at2);
      bump('inspections');
      for (const [position, item] of template.items.entries()) {
        const [result, note] = exceptions?.[item.code] || ['ok', null];
        await db.run(`INSERT INTO hse_inspection_items (id, inspection_id, item_code, label, result, note, position)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET label = excluded.label, result = excluded.result, note = excluded.note`,
        id(`${code}:hse-inspection:${index + 1}:item:${item.code}`), inspectionId, item.code, english(code) ? EN_CHECKLIST_LABELS[item.code] : item.label, result, note, position);
        bump('inspectionItems');
      }
    }

    const titles = TASK_TITLES[code];
    const taskStatuses = TASK_PROFILES[code];
    for (let index = 0; index < taskStatuses.length; index++) {
      const taskId = id(`${code}:task:${index + 1}`);
      const status = taskStatuses[index];
      const due = status === 'closed' || status === 'to_verify' ? workingDate(code, 39) : date(3 + index, workingDate(code, 39));
      const reviewDay = due < REFERENCE_DAY ? due : REFERENCE_DAY;
      const declaredAt = ['closed', 'to_verify'].includes(status) ? `${reviewDay}T08:00:00.000Z` : null;
      const verifiedAt = status === 'closed' ? `${reviewDay}T16:00:00.000Z` : null;
      const executor = textFor(code, 'Squadra dimostrativa', 'Demonstration crew');
      const verifier = textFor(code, 'Verificatore dimostrativo', 'Demonstration verifier');
      await db.run(`INSERT INTO tasks (id, site_id, title, area, company, executor, verifier, priority, due_date, status, created_at,
          declared_at, verified_at, submitted_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET status = excluded.status, title = excluded.title,
          area = excluded.area, company = excluded.company, executor = excluded.executor, verifier = excluded.verifier, due_date = excluded.due_date,
          declared_at = excluded.declared_at, verified_at = excluded.verified_at, submitted_by = excluded.submitted_by`,
      taskId, siteId, titles[index], textFor(code, 'Zona ', 'Zone ') + (index % 6 + 1),
      textFor(code, 'Impresa dimostrativa', 'Demonstration contractor'), executor, verifier, ['low', 'medium', 'high'][index % 3],
      due, status, at2, declaredAt, verifiedAt, declaredAt ? executor : null);
      bump('tasks');
      if (declaredAt) {
        const events = [[at2, executor, 'todo', 'in_progress', 'start'],
          [declaredAt, executor, 'in_progress', 'to_verify', 'submit']];
        if (verifiedAt) events.push([verifiedAt, verifier, 'to_verify', 'closed', 'verify']);
        for (const [time, actor, from, to, action] of events) {
          const event = await db.get(`INSERT INTO task_events (task_id, at, actor, from_status, to_status, action)
            SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS
              (SELECT 1 FROM task_events WHERE task_id = ? AND at = ? AND action = ?)
            RETURNING id`, taskId, time, actor, from, to, action, taskId, time, action);
          if (event) await db.run(`INSERT INTO demo_seed_records (table_name, record_id)
            VALUES ('task_events', ?) ON CONFLICT DO NOTHING`, String(event.id));
        }
      } else if (status !== 'todo') {
        await db.run(`UPDATE task_events SET actor = ? WHERE task_id = ? AND at = ? AND from_status = 'todo' AND to_status = ?`,
          executor, taskId, at2, status);
        await db.run(`INSERT INTO task_events (task_id, at, actor, from_status, to_status)
          SELECT ?, ?, ?, 'todo', ? WHERE NOT EXISTS
            (SELECT 1 FROM task_events WHERE task_id = ? AND at = ? AND from_status = 'todo' AND to_status = ?)`,
          taskId, at2, executor, status, taskId, at2, status);
      }
    }

    for (const [index, [dPlan, dActual, dImp, dNext]] of DIARY[code].entries()) {
      const operationalDate = workingDate(code, index);
      // Keep the original Friday shift in identity keys; all displayed entries describe daytime work.
      const legacyShift = index % 5 === 4 ? 'night' : 'day';
      const diaryId = id(`${code}:diary:${legacyWorkingDate(index)}:${legacyShift}`);
      // The base seed may already own this slot. Leave its entry outside the demo reset manifest.
      if (await db.get(`SELECT id FROM diary
        WHERE site_id = ? AND operational_date = ? AND shift = 'day' AND id <> ?`, siteId, operationalDate, diaryId)) continue;
      await db.run(`INSERT INTO diary (id, site_id, operational_date, shift, plan, actual, impediments, next_step, created_at, time_zone, day_cutoff_time)
        VALUES (?, ?, ?, 'day', ?, ?, ?, ?, ?, 'Europe/Rome', '06:00')
        ON CONFLICT (id) DO UPDATE SET operational_date = excluded.operational_date, shift = excluded.shift,
          plan = excluded.plan, actual = excluded.actual, impediments = excluded.impediments, next_step = excluded.next_step`,
      diaryId, siteId, operationalDate, dPlan, dActual, dImp, dNext, at2);
      bump('diary');
    }
  }
  const main = await db.get("SELECT id FROM sites WHERE code = 'FITT-03'");
  const c03 = id('FITT-03:wbs:C03'), progress = id('FITT-03:c03:progress'), employee = id('FITT-03:c03:employee');
  const workDay = id('FITT-03:c03:night'), task = id('FITT-03:c03:task'), deviation = id('FITT-03:c03:deviation');
  await db.run(`INSERT INTO employees (id, site_id, employee_no, first_name, created_at) VALUES (?, ?, 'DEMO-C03', 'Synthetic night crew', ?) ON CONFLICT (id) DO NOTHING`, employee, main.id, at);
  await db.run(`INSERT INTO site_progress_items (id, site_id, wbs_id, description, progress_pct, planned_hours, source_row, created_at)
    VALUES (?, ?, ?, 'C03 night installation', 25, 32, 10003, ?) ON CONFLICT (id) DO UPDATE SET wbs_id = excluded.wbs_id`, progress, main.id, c03, at);
  await db.run(`INSERT INTO work_days (id, site_id, employee_id, operational_date, shift, start_time, finish_time, created_at)
    VALUES (?, ?, ?, '2026-11-16', 'night', '22:00', '06:00', ?) ON CONFLICT (id) DO NOTHING`, workDay, main.id, employee, at);
  await db.run(`INSERT INTO time_bookings (id, site_id, work_day_id, site_progress_item_id, hours, created_at)
    VALUES (?, ?, ?, ?, 6, ?) ON CONFLICT (id) DO NOTHING`, id('FITT-03:c03:booking'), main.id, workDay, progress, at);
  await db.run(`INSERT INTO tasks (id, site_id, wbs_id, title, area, company, executor, verifier, status, created_at)
    VALUES (?, ?, ?, 'C03 night installation', 'Night work area', 'Synthetic contractor', 'Synthetic crew', 'Synthetic checker', 'blocked', ?)
    ON CONFLICT (id) DO UPDATE SET wbs_id = excluded.wbs_id`, task, main.id, c03, at);
  await db.run(`INSERT INTO deviations (id, site_id, deviation_no, title, problem_description, status, creation_date, created_at)
    VALUES (?, ?, 'DEMO-C03', 'C03 access impediment', 'Synthetic access clearance awaited', 'open', ?, ?) ON CONFLICT (id) DO NOTHING`, deviation, main.id, '2026-09-21', at);
  await db.run(`INSERT INTO deviation_links (deviation_id, entity_type, entity_id)
    VALUES (?, 'task', ?) ON CONFLICT DO NOTHING`, deviation, task);
  await db.run(`INSERT INTO diary (id, site_id, operational_date, shift, plan, actual, impediments, next_step, created_at, time_zone, day_cutoff_time)
    VALUES (?, ?, '2026-11-16', 'night', 'Install C03 section', 'C03: six hours booked against the linked progress item',
      'C03 access clearance awaited', 'Resume C03 after clearance', ?, 'Europe/Rome', '06:00') ON CONFLICT (id) DO NOTHING`, id('FITT-03:c03:diary'), main.id, at);
  // Copy active roles from the reference site while keeping sandbox roles in the sandbox.
  const reference = await db.get('SELECT id FROM sites WHERE code = ?', SITES[0]);
  if (reference) {
    const members = await db.all('SELECT user_id, role FROM accessible_site_members WHERE site_id = ? AND user_id <> ?', reference.id, evidenceOwnerId);
    for (const code of SITES.slice(1)) {
      const site = await db.get('SELECT id, demo_sandbox FROM sites WHERE code = ?', code);
      if (!site) continue;
      for (const member of members) {
        if (member.role === 'demo_user' && !site.demo_sandbox) continue;
        await db.run('INSERT INTO site_members (site_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
          site.id, member.user_id, member.role);
        bump('members');
      }
    }
    await seedEvidence(db, reference.id, bump);
  }
  return counts;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const applyFlag = process.argv.includes('--apply');
  const resetFlag = process.argv.includes('--reset');
  if (!applyFlag && !resetFlag) {
    const dataset = plan();
    console.log(JSON.stringify({ dryRun: true, plan: Object.fromEntries(Object.entries(dataset).map(([key, value]) =>
      [key, key === 'counts' ? value : Array.isArray(value) ? value.length : typeof value === 'object' ? Object.keys(value).length : value])) }, null, 1));
  } else {
    const db = await openDb(undefined, { migrate: false });
    try {
      if (resetFlag) {
        const removed = await db.transaction(tx => reset(tx));
        console.log(JSON.stringify({ reset: true, removed }));
      } else {
        const counts = await db.transaction(tx => apply(tx));
        console.log(JSON.stringify({ applied: true, counts }));
      }
    } finally {
      await closeDb(db);
    }
  }
}
