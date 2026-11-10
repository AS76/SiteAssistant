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

const SITES = ['FITT-01', 'FITT-02'];

const WBS = {
  'FITT-01': [['1', 'Impianto di smistamento', 0, null], ['1.1', 'Linea A', 1, '1'], ['1.2', 'Linea B', 1, '1'],
    ['2', 'Opere civili', 0, null], ['2.1', 'Fondazioni', 1, '2'], ['2.2', 'Strutture', 1, '2'],
    ['3', 'Impianti elettrici', 0, null], ['3.1', 'Quadri elettrici', 1, '3'], ['3.2', 'Cablaggi', 1, '3']],
  'FITT-02': [['1', 'Struttura principale', 0, null], ['1.1', 'Campate', 1, '1'], ['1.2', 'Copertura', 1, '1'],
    ['2', 'Viabilità', 0, null], ['2.1', 'Accessi', 1, '2']],
};

const TYPES = {
  'FITT-01': [{ code: 'MONT', name: 'Montaggio impianti', steps: [['PREL', 'Opere preliminari', 20], ['STRUT', 'Montaggio strutture', 40], ['CABL', 'Cablaggi', 25], ['COLL', 'Collaudo', 15]] },
    { code: 'CIV', name: 'Opere civili', steps: [['SCAVI', 'Scavi', 25], ['FOND', 'Fondazioni', 45], ['STRUTT', 'Strutture', 30]] }],
  'FITT-02': [{ code: 'PONTE', name: 'Opere da ponte', steps: [['PILE', 'Pile', 35], ['IMPALC', 'Impalcato', 45], ['FINIT', 'Finiture', 20]] }],
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
};

const EMPLOYEES = {
  'FITT-01': [['SIN-01', 'Ada', 'Rossi'], ['SIN-02', 'Bruno', 'Verdi'], ['SIN-03', 'Carla', 'Bianchi'], ['SIN-04', 'Dario', 'Neri'],
    ['SIN-05', 'Elena', 'Galli'], ['SIN-06', 'Fabio', 'Conti'], ['SIN-07', 'Gina', 'Ferri'], ['SIN-08', 'Ivan', 'Riva']],
  'FITT-02': [['SIN-11', 'Luca', 'Sala'], ['SIN-12', 'Mara', 'Tosi'], ['SIN-13', 'Nino', 'Villa'], ['SIN-14', 'Olga', 'Pini']],
};

const DEVIATIONS = {
  'FITT-01': [['open', 'high'], ['open', 'medium'], ['open', 'low'], ['approved', 'high'], ['approved', 'medium'],
    ['in_progress', 'high'], ['in_progress', 'medium'], ['work_completed', 'medium'], ['work_completed', 'low'],
    ['closed', 'high'], ['closed', 'low'], ['rejected', 'low']],
  'FITT-02': [['open', 'medium'], ['in_progress', 'high'], ['closed', 'low'], ['rejected', 'low']],
};

const IMPACTS = {
  'FITT-01': [['open', 12500.5, null, null], ['open', 4200, null, null], ['notification_sent', 9800, null, null], ['closed', 15000, 11250, 'settled']],
  'FITT-02': [['open', 6000, null, null], ['closed', 3500, 0, 'dropped']],
};

const TASK_STATUSES = ['todo', 'todo', 'todo', 'todo', 'in_progress', 'in_progress', 'in_progress', 'to_verify', 'to_verify', 'to_verify', 'closed', 'closed', 'closed', 'closed', 'closed', 'blocked'];

export function plan() {
  return { SITES, WBS, TYPES, ITEMS, EMPLOYEES, DEVIATIONS, IMPACTS, taskStatuses: TASK_STATUSES.length };
}

async function reset(db) {
  const sites = await db.all(`SELECT id, code FROM sites WHERE code IN (?, ?)`, ...SITES);
  let removed = 0;
  for (const site of sites) {
    for (const [table, column] of [['site_progress_item_steps', null], ['time_bookings', 'site_id'], ['cost_impact_deviations', null],
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

    const workDays = [];
    for (let week = 0; week < 3; week++) {
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
          planned_progress_pct, assigned_to, planned_start, planned_finish, has_files, has_notes, has_deviations, source_row, created_at, progress_type_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET description = excluded.description, progress_pct = excluded.progress_pct,
          wbs_id = excluded.wbs_id, progress_type_id = excluded.progress_type_id`,
      itemId, siteId, wbsCode ? wbsIds.get(wbsCode) ?? null : null, description, section, area, progress,
      Math.min(100, progress + 10), 'Squadra sintetica', '2026-10-19', '2026-12-20', index % 5 === 0, index % 7 === 0, index % 6 === 0,
      index + 1, at2, typeCode ? typeIds[typeCode].id : null);
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

    const titles = ['Verifica planimetrie', 'Consegna materiale area 1', 'Coordinate con subappaltatore', 'Prova di carico',
      'Aggiornamento cronoprogramma', 'Pulizia area di lavoro', 'Controllo serraggi', 'Rilievo quote', 'Riunione sicurezza',
      'Approvvigionamento cavi', 'Verifica quadri', 'Collaudo parziale', 'Documentazione fotografica', 'Segnalazione ostacolo',
      'Verifica accessi', 'Formazione squadra'];
    for (let index = 0; index < TASK_STATUSES.length; index++) {
      const taskId = id(`${code}:task:${index + 1}`);
      const status = TASK_STATUSES[index];
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

    for (let index = 0; index < 12; index++) {
      const operationalDate = date(index + Math.floor(index / 5) * 2);
      const shift = index % 5 === 4 ? 'night' : 'day';
      await db.run(`INSERT INTO diary (id, site_id, operational_date, shift, plan, actual, impediments, next_step, created_at, time_zone, day_cutoff_time)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Europe/Rome', '06:00')
        ON CONFLICT (id) DO UPDATE SET actual = excluded.actual`,
      id(`${code}:diary:${operationalDate}:${shift}`), siteId, operationalDate, shift,
      'Piano sintetico della giornata: montaggi e verifiche.', 'Eseguito quanto previsto, con lievi ritardi.',
      index % 4 === 0 ? 'Materiale in ritardo dal fornitore.' : null, 'Proseguire secondo cronoprogramma.', at2);
      bump('diary');
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
