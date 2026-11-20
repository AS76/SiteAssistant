import { createHash, randomBytes } from 'node:crypto';
import { hashPassword } from './auth.mjs';
import { findTemplate } from './checklists.mjs';
import { closeDb, openDb } from './db.mjs';

// Set NORTHLINE_SEED_PASSWORD before the first apply to enable password login.
// Otherwise each account receives a random password that is never printed.
const REFERENCE_DAY = '2026-11-19';
const at = (day, time = '16:00') => `${day}T${time}:00.000Z`;
const addDays = (day, days) => {
  const date = new Date(at(day, '12:00'));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
const id = (...parts) => {
  const hash = createHash('sha256').update(['siteassistant:northline:v1', ...parts].join(':')).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};
const number = (prefix, index) => `${prefix}-${String(index + 1).padStart(2, '0')}`;

const SITES = [
  { code: 'NL-IT-01', jurisdiction: 'IT', timeZone: 'Europe/Rome', start: '2026-09-07', finish: '2027-02-27',
    diaryStart: '2026-10-12', name: 'Northline Piacenza — Impianto intralogistico', location: 'Zona simulata, Piacenza, Italia' },
  { code: 'NL-UK-01', jurisdiction: 'UK', timeZone: 'Europe/London', start: '2026-09-14', finish: '2027-03-06',
    diaryStart: '2026-10-19', name: 'Northline Midlands — Intralogistics installation', location: 'Simulated site, Daventry, United Kingdom' },
];

const ACCOUNTS = [
  ['owner.it', 'Direzione Tramagel', 'owner'], ['editor.it', 'Squadra Veltoluce', 'editor'],
  ['verifier.it', 'Verifica Listarovo', 'verifier'], ['owner.uk', 'Flintmere Site Lead', 'owner'],
  ['editor.uk', 'Copperquill Crew Lead', 'editor'], ['verifier.uk', 'Nacrewharf Reviewer', 'verifier'],
  ['viewer', 'Northline Portfolio', 'viewer'],
].map(([login, name, role]) => ({ id: id('user', login), email: `${login}@northline.invalid`, login, name, role }));

// WBS code, Italian and English description, planned day offsets, planned hours, work area.
const WBS = [
  ['1', 'Allestimento del cantiere', 'Mobilisation and work areas', 0, 14, 96, 'YARD'],
  ['2', 'Fondazioni e opere civili', 'Foundations and civil works', 7, 30, 240, 'YARD'],
  ['3', 'Soppalchi e strutture in acciaio', 'Steelwork and mezzanines', 14, 45, 360, 'L1'],
  ['4', 'Linee di trasporto', 'Conveyor lines', 28, 78, 480, 'L1'],
  ['4.1', 'Telai e rulliere', 'Conveyor frames and rollers', 28, 54, 180, 'L1'],
  ['4.2', 'Azionamenti e trasmissioni', 'Drives and transmissions', 35, 63, 120, 'L2'],
  ['4.3', 'Montaggio e centratura nastri', 'Belt fitting and tracking', 42, 78, 180, 'L2'],
  ['5', 'Magazzino automatico verticale', 'Automated storage and retrieval', 28, 85, 560, 'ASRS'],
  ['5.1', 'Montanti delle scaffalature', 'Rack uprights', 28, 54, 200, 'ASRS'],
  ['5.2', 'Travi e guide del magazzino', 'Storage beams and guide rails', 35, 65, 180, 'ASRS'],
  ['5.3', 'Trasloelevatori', 'Stacker cranes', 42, 85, 180, 'ASRS'],
  ['6', 'Installazioni elettriche', 'Electrical installation', 28, 91, 390, 'Q01'],
  ['6.1', 'Supporti e passerelle portacavi', 'Cable supports and trays', 28, 52, 100, 'L1'],
  ['6.2', 'Posa e identificazione cavi', 'Cable installation and labelling', 35, 78, 180, 'L2'],
  ['6.3', 'Quadri e morsettiere', 'Panels and terminal blocks', 42, 91, 110, 'Q01'],
  ['7', 'Automazione e controllo', 'Controls and software', 35, 112, 300, 'Q01'],
  ['7.1', 'Controllori e moduli di ingresso e uscita', 'PLCs and I/O modules', 35, 68, 90, 'Q01'],
  ['7.2', 'Comunicazioni industriali', 'Industrial communications', 42, 91, 90, 'Q01'],
  ['7.3', 'Parametri e sequenze', 'Parameters and sequences', 49, 112, 120, 'TEST'],
  ['8', 'Prove e collaudi', 'Testing and commissioning', 49, 154, 240, 'TEST'],
  ['8.1', 'Cicli a vuoto', 'No-load cycles', 49, 112, 64, 'TEST'],
  ['8.2', 'Prove a carico e di flusso integrato', 'Load and integrated flow tests', 56, 154, 176, 'TEST'],
  ['9', 'Consegna e addestramento', 'Handover and operator training', 140, 168, 100, 'TEST'],
  ['10', 'Elaborati di fine lavori', 'Closeout and as-built drawings', 140, 173, 96, 'TEST'],
];

const AREAS = {
  YARD: ['Area carico', 'Loading bay'], L1: ['Linea 1', 'Line 1'], L2: ['Linea 2', 'Line 2'],
  ASRS: ['Magazzino automatico', 'Automated store'], Q01: ['Quadro Q01', 'Panel Q01'], TEST: ['Area collaudo', 'Test bay'],
};

const COMPANIES = {
  mechanical: ['Montaggi Tramagel — simulazione', 'Flintmere Mechanical — simulation'],
  electrical: ['Impianti Veltoluce — simulazione', 'Copperquill Electrical — simulation'],
  controls: ['Controlli Listarovo — simulazione', 'Nacrewharf Controls — simulation'],
  supplier: ['Forniture Ramofuso — simulazione', 'Coilfen Supplies — simulation'],
};

// Each task carries its acceptance criterion in the creation event.
const TASKS = [
  ['4.1', 'mechanical', 'closed', ['Allineare i telai della linea 1', 'Align the line 1 frames'],
    ['Scostamento massimo di 2 mm su quattro telai.', 'Maximum deviation of 2 mm across four frames.']],
  ['4.1', 'mechanical', 'to_verify', ['Montare sei rulliere motorizzate', 'Fit six powered roller sections'],
    ['Sei rulliere girano libere a mano.', 'All six roller sections turn freely by hand.']],
  ['4.2', 'mechanical', 'in_progress', ['Posare i motoriduttori della linea 2', 'Fit the line 2 geared motors'],
    ['Tre motoriduttori hanno i fissaggi marcati.', 'All three geared motors have marked fixings.']],
  ['4.3', 'mechanical', 'todo', ['Centrare il nastro di trasferimento', 'Track the transfer belt'],
    ['Nessun contatto laterale durante tre giri.', 'There is no side contact over three revolutions.']],
  ['5.1', 'mechanical', 'closed', ['Montare i montanti della campata A', 'Erect the bay A uprights'],
    ['Otto montanti rilevati e misure registrate.', 'Eight uprights are surveyed and measurements recorded.']],
  ['5.2', 'mechanical', 'in_progress', ['Registrare le guide di ingresso', 'Adjust the infeed guides'],
    ['Due guide parallele allo scartamento di progetto.', 'Both guides are parallel at the design gauge.']],
  ['6.1', 'electrical', 'closed', ['Posare la passerella della linea 1', 'Install the line 1 cable tray'],
    ['Dodici metri posati e tutti i supporti fissati.', 'Twelve metres are installed and all supports secured.']],
  ['6.2', 'electrical', 'to_verify', ['Identificare i cavi di campo', 'Label the field cables'],
    ['Dodici cavi etichettati su entrambe le estremità.', 'Twelve cables carry labels at both ends.']],
  ['6.3', 'electrical', 'in_progress', ['Terminare i conduttori del quadro Q01', 'Terminate the Q01 panel conductors'],
    ['Venti terminazioni corrispondono allo schema di prova.', 'Twenty terminations match the test drawing.']],
  ['6.3', 'electrical', 'todo', ['Rilevare la continuità dei collegamenti', 'Record bonding continuity'],
    ['Quattro misure riportate nel verbale di prova.', 'Four readings are entered in the test record.']],
  ['7.1', 'controls', 'closed', ['Verificare gli ingressi del controllore', 'Check the PLC inputs'],
    ['Otto ingressi rispondono alla simulazione.', 'Eight inputs respond to simulation.']],
  ['7.2', 'controls', 'to_verify', ['Verificare i nodi della rete industriale', 'Check the industrial network nodes'],
    ['Tutti i sei nodi compaiono nella diagnostica.', 'All six nodes appear in diagnostics.']],
  ['7.3', 'controls', 'todo', ['Configurare la sequenza di accumulo', 'Configure the accumulation sequence'],
    ['Tre contenitori mantengono la distanza prevista.', 'Three totes maintain the specified spacing.']],
  ['8.1', 'controls', 'in_progress', ['Eseguire dieci cicli a vuoto', 'Run ten no-load cycles'],
    ['Dieci cicli registrati senza arresti inattesi.', 'Ten cycles are recorded without unexpected stops.']],
  ['8.2', 'controls', 'todo', ['Provare il trasferimento con carico campione', 'Test transfer with a trial load'],
    ['Cinque trasferimenti registrati senza inceppamenti.', 'Five transfers are recorded without jams.']],
  ['4.1', 'mechanical', 'in_progress', ['Ripristinare la tavola fermapiede', 'Reinstate the toe board'],
    ['Tavola riposizionata e fissaggi ricontrollati.', 'The toe board is refitted and its fixings rechecked.']],
  ['6.3', 'electrical', 'to_verify', ['Correggere la numerazione delle morsettiere', 'Correct the terminal block numbering'],
    ['Le etichette da 11 a 14 corrispondono alla distinta.', 'Labels 11 to 14 match the terminal schedule.']],
  ['4.3', 'mechanical', 'blocked', ['Montare i carter di ritorno', 'Fit the return guards'],
    ['Otto carter montati con fissaggi completi.', 'All eight guards are fitted with complete fixings.']],
];

const DEVIATIONS = [
  ['open', 'high', 'L2', ['Due carter mancanti', 'Two guards missing'],
    ['Ricevuti sei carter sugli otto imballati.', 'Six of the eight packed guards were received.']],
  ['open', 'low', 'ASRS', ['Quota di ingresso da confermare', 'Infeed height to confirm'],
    ['Il rilievo della guida non coincide con il disegno di montaggio.', 'The guide survey differs from the installation drawing.']],
  ['approved', 'medium', 'L2', ['Nuovo supporto per il ritorno del nastro', 'New belt return bracket'],
    ['La modifica evita interferenze con la traversa.', 'The change clears the cross member.']],
  ['approved', 'low', 'TEST', ['Ripetizione di un ciclo a vuoto', 'Repeat one no-load cycle'],
    ['Ripetere la prova dopo il riallineamento del sensore.', 'Repeat the test after realigning the sensor.']],
  ['in_progress', 'high', 'L1', ['Tavola fermapiede allentata', 'Loose toe board'],
    ['Manca un fissaggio sul lato di accesso al ponteggio.', 'One fixing is missing on the scaffold access side.']],
  ['in_progress', 'medium', 'ASRS', ['Guida di ingresso fuori quota', 'Infeed guide outside tolerance'],
    ['La squadra sta ripetendo il rilievo su quattro punti.', 'The crew is repeating the survey at four points.']],
  ['work_completed', 'medium', 'Q01', ['Etichette morsettiere invertite', 'Terminal labels swapped'],
    ['Corrette quattro etichette; resta il controllo indipendente.', 'Four labels have been corrected and await independent review.']],
  ['closed', 'low', 'TEST', ['Contenitore campione non identificato', 'Trial tote unlabelled'],
    ['Ripristinata l’identificazione e ripetuto il passaggio.', 'Identification was restored and the run repeated.']],
];

// One row per weekday, in story order: area, plan, actual, next step, optional obstruction.
const DIARY = [
  ['L1', ['Rilevare quattro telai', 'Survey four frames'], ['La squadra meccanica ha rilevato quattro telai.', 'The mechanical crew surveyed four frames.'], ['Fissare gli appoggi', 'Secure the supports']],
  ['YARD', ['Spostare due casse', 'Move two crates'], ['Una cassa è entrata al coperto.', 'One crate was moved under cover.'], ['Spostare la seconda cassa a piazzale asciutto', 'Move the second crate once the yard dries'], ['Pioggia: movimentazione sospesa nel piazzale.', 'Rain halted handling in the yard.']],
  ['L1', ['Posare sei rulliere', 'Fit six roller sections'], ['Quattro rulliere posate dalla squadra meccanica.', 'The mechanical crew fitted four roller sections.'], ['Completare le ultime due rulliere', 'Fit the last two roller sections']],
  ['ASRS', ['Montare quattro montanti', 'Erect four uprights'], ['Quattro montanti rilevati in campata A.', 'Four uprights were surveyed in bay A.'], ['Montare i quattro montanti restanti', 'Erect the four remaining uprights']],
  ['L1', ['Posare dodici metri di passerella', 'Fit twelve metres of cable tray'], ['La squadra elettrica ha posato dodici metri.', 'The electrical crew fitted twelve metres.'], ['Numerare le uscite', 'Number the outlets']],
  ['L2', ['Posare tre motoriduttori', 'Fit three geared motors'], ['Due motoriduttori sono fissati.', 'Two geared motors are secured.'], ['Attrezzare il terzo supporto', 'Prepare the third bracket']],
  ['ASRS', ['Verificare la quota di ingresso', 'Check the infeed height'], ['Rilevati quattro punti sulle guide.', 'Four points were surveyed on the guides.'], ['Riprendere dopo il riscontro tecnico', 'Resume after the technical decision'], ['Si attende la decisione tecnica sulla quota.', 'The technical decision on height is pending.']],
  ['Q01', ['Numerare venti morsetti', 'Number twenty terminals'], ['La squadra elettrica ha numerato venti morsetti.', 'The electrical crew numbered twenty terminals.'], ['Riscontrare la numerazione con la distinta', 'Check numbering against the schedule']],
  ['L2', ['Preparare il montaggio del nastro', 'Prepare for belt fitting'], ['Allestiti due punti di appoggio.', 'Two support points were prepared.'], ['Posare il tratto di ritorno', 'Fit the return section']],
  ['ASRS', ['Completare la campata A', 'Complete bay A'], ['Rilevati gli ultimi quattro montanti.', 'The last four uprights were surveyed.'], ['Installare due travi', 'Install two beams']],
  ['L2', ['Montare otto carter di ritorno', 'Fit eight return guards'], ['Contati sei carter; il montaggio resta sospeso.', 'Six guards were counted and fitting remains on hold.'], ['Sollecitare i due carter mancanti', 'Chase the two missing guards'], ['Consegna incompleta: mancano due carter.', 'Short delivery: two guards are missing.']],
  ['L2', ['Identificare dodici cavi', 'Label twelve cables'], ['La squadra elettrica ha etichettato dodici cavi.', 'The electrical crew labelled twelve cables.'], ['Controllare le etichette lato quadro', 'Check the panel-end labels']],
  ['Q01', ['Simulare otto ingressi', 'Simulate eight inputs'], ['Otto risposte registrate dalla squadra automazione.', 'The controls crew recorded eight responses.'], ['Verificare due uscite', 'Check two outputs']],
  ['Q01', ['Rilevare sei nodi di rete', 'Check six network nodes'], ['Trovati sei nodi e annotati gli indirizzi sul banco prova.', 'Six nodes were found and their addresses logged on the test bench.'], ['Ripetere il controllo a quadro chiuso', 'Repeat the check with the panel closed']],
  ['L1', ['Ispezionare il ponteggio di accesso', 'Inspect the access scaffold'], ['Un fissaggio della tavola fermapiede è allentato.', 'One toe board fixing is loose.'], ['Verificare il ripristino con la squadra meccanica', 'Review the repair with the mechanical crew'], ['Accesso al ponteggio sospeso.', 'Scaffold access is suspended.']],
  ['Q01', ['Correggere quattro etichette', 'Correct four terminal labels'], ['Sostituite le etichette da 11 a 14.', 'Labels 11 to 14 were replaced.'], ['Richiedere la verifica indipendente', 'Request independent verification']],
  ['TEST', ['Provare la sequenza a vuoto', 'Test the no-load sequence'], ['Registrati quattro cicli dalla squadra collaudo.', 'The test crew recorded four cycles.'], ['Proseguire fino a dieci cicli', 'Continue to ten cycles']],
  ['ASRS', ['Controllare due guide di ingresso', 'Check two infeed guides'], ['La squadra meccanica ha misurato due guide.', 'The mechanical crew measured two guides.'], ['Confermare lo scartamento', 'Confirm the guide gauge']],
  ['TEST', ['Identificare il contenitore campione', 'Label the trial tote'], ['Etichetta ripristinata e un passaggio ripetuto.', 'The label was restored and one pass repeated.'], ['Preparare i cinque passaggi a carico', 'Prepare five loaded passes']],
  ['TEST', ['Verificare il conteggio dei cicli', 'Verify the cycle count'], ['La squadra collaudo ha registrato altri tre cicli.', 'The test crew recorded three more cycles.'], ['Pianificare gli ultimi tre cicli', 'Schedule the last three cycles']],
];

const NIGHTS = [
  [4, 'L1', ['Completare due rulliere in turno notturno', 'Fit two roller sections on the night shift'],
    ['Una rulliera fissata prima delle 00:00 e una alle 01:20.', 'One roller section was secured before midnight and one at 01:20.'],
    ['Ricontrollare i fissaggi al cambio turno', 'Recheck the fixings at shift change']],
  [9, 'ASRS', ['Posizionare due travi della campata A', 'Position two beams in bay A'],
    ['Prima trave alle 23:10 e seconda alle 02:00.', 'The first beam was placed at 23:10 and the second at 02:00.'],
    ['Rilevare le quote delle travi', 'Survey the beam heights']],
  [14, 'Q01', ['Verificare due uscite al banco', 'Check two outputs on the test bench'],
    ['Prima uscita alle 22:40 e seconda alle 01:10.', 'The first output was checked at 22:40 and the second at 01:10.'],
    ['Confrontare i riscontri con la squadra elettrica', 'Review the findings with the electrical crew']],
  [19, 'TEST', ['Completare tre cicli a vuoto', 'Complete three no-load cycles'],
    ['Un ciclo alle 23:45 e due completati entro le 03:00.', 'One cycle ran at 23:45 and two more finished by 03:00.'],
    ['Consolidare il conteggio dei dieci cicli', 'Reconcile the total of ten cycles']],
];

const PEOPLE = {
  IT: [
    'Nerivo Tramagel', 'Livessa Broccen', 'Taverno Filorosso', 'Orelva Spondiva',
    'Dacivel Norcast', 'Lumitra Varosel', 'Ralvian Corbesc', 'Ilevara Muntesc',
    'Nivestra Veltoluce', 'Valmero Ramefitto', 'Dorelin Cernavel', 'Miralba Datifilo',
    'Silveto Listarovo', 'Anveria Palturel',
  ],
  UK: [
    'Tavren Flintmere', 'Elvara Coilfen', 'Bramwick Siltbrook', 'Marnelle Wakeforge',
    'Dagmir Zelowik', 'Veliska Drzewan', 'Jarevik Smolaryn', 'Milveta Borzewik',
    'Fenwick Copperquill', 'Norabelle Wirehurst', 'Zorvian Rzedlow', 'Linvara Gridmarsh',
    'Eldran Nacrewharf', 'Varlen Wrzosvek',
  ],
};

const CERTIFICATES = [
  ['qualification', -45, 'Abilitazione PLE', 'MEWP operator qualification'],
  ['qualification', -16, 'Abilitazione carrello elevatore', 'Forklift operator qualification'],
  ['training', -7, 'Formazione lavori in quota', 'Work at height training'],
  ['training', 5, 'Formazione primo soccorso', 'First aid training'],
  ['training', 12, 'Formazione antincendio', 'Fire warden training'],
  ['medical', 26, 'Visita periodica di idoneità', 'Periodic fitness assessment'],
  ['medical', 80, 'Visita periodica di idoneità', 'Periodic fitness assessment'],
  ['qualification', 96, 'Abilitazione PLE', 'MEWP operator qualification'],
  ['medical', 105, 'Visita di idoneità alla mansione', 'Fitness assessment for assigned work'],
  ['medical', 120, 'Visita periodica di idoneità', 'Periodic fitness assessment'],
  ['medical', 135, 'Visita di idoneità alla mansione', 'Fitness assessment for assigned work'],
  ['training', 149, 'Formazione sicurezza elettrica', 'Electrical safety training'],
  ['training', 180, 'Formazione accesso al cantiere', 'Site induction training'],
  ['training', 210, 'Formazione su rischi di interferenza', 'Training on risks from overlapping work'],
  ['medical', 250, 'Visita periodica di idoneità', 'Periodic fitness assessment'],
  ['qualification', 279, 'Abilitazione carrello elevatore', 'Forklift operator qualification'],
];

const TOOLS = [
  ['mechanical', 'in_use', 'L1', 'Piattaforma a pantografo', 'Scissor lift'],
  ['mechanical', 'available', 'YARD', 'Carrello elevatore', 'Forklift'],
  ['mechanical', 'in_use', 'ASRS', 'Chiave dinamometrica', 'Torque wrench'],
  ['mechanical', 'maintenance', 'YARD', 'Paranco a catena', 'Chain hoist'],
  ['electrical', 'in_use', 'Q01', 'Misuratore di isolamento', 'Insulation tester'],
  ['electrical', 'available', 'L2', 'Scala portatile', 'Portable ladder'],
  ['controls', 'in_use', 'TEST', 'Banco prova segnali', 'Signal test bench'],
  ['mechanical', 'retired', 'YARD', 'Carrello portautensili', 'Tool trolley'],
];

const HSE_EVENTS = [
  ['near_miss', 'high', 1, 'YARD', 1, ['Una cassa si è spostata senza urtare persone.', 'A crate shifted clear of personnel.'], ['Sospendere la movimentazione e ripristinare l’area delimitata.', 'Pause handling and reinstate the exclusion area.']],
  ['near_miss', 'medium', 3, 'ASRS', 1, ['Il bordo del vano è rimasto esposto durante lo spostamento di una protezione.', 'The floor opening was exposed while a barrier was moved.'], ['Ripristinare la barriera del vano.', 'Reinstate the floor opening barrier.']],
  ['near_miss', 'medium', 5, 'L2', 1, ['Una scala portatile si è spostata prima dell’uso.', 'A portable ladder shifted before use.'], ['Ritirare la scala per un controllo.', 'Withdraw the ladder for inspection.']],
  ['near_miss', 'high', 7, 'Q01', 2, ['Percorso di accesso al quadro Q01 intercettato da un carrello.', 'A trolley crossed the Q01 panel access route.'], ['Separare il percorso del carrello.', 'Separate the trolley route.']],
  ['accident', 'low', 8, 'L2', 1, ['Piccolo taglio durante la movimentazione di un profilo.', 'Minor cut while handling a profile.'], ['Prestato primo soccorso e segregato il profilo.', 'First aid was given and the profile set aside.']],
  ['accident', 'medium', 10, 'YARD', 1, ['Contusione durante lo scarico dei carter.', 'Bruising during unloading of the guards.'], ['Sospeso lo scarico e prestato primo soccorso.', 'Unloading was paused and first aid given.']],
  ['observation', 'medium', 11, 'Q01', 0, ['L’accesso al quadro elettrico è ingombrato da un contenitore.', 'A container obstructs access to the electrical panel.'], ['Sgomberare la fascia di accesso.', 'Clear the marked access area.']],
  ['observation', 'low', 12, 'ASRS', 0, ['Un paio di occhiali dei DPI ha una lente graffiata.', 'One pair of PPE glasses has a scratched lens.'], ['Sostituire gli occhiali.', 'Replace the glasses.']],
  ['observation', 'high', 14, 'L1', 0, ['Fissaggio mancante sulla tavola fermapiede del ponteggio.', 'One scaffold toe board fixing is missing.'], ['Sospendere l’accesso e ripristinare il fissaggio.', 'Close access and reinstate the fixing.']],
  ['observation', 'low', 17, 'YARD', 0, ['La segnaletica pedonale dell’area di carico è poco visibile.', 'Pedestrian markings at the loading bay are hard to see.'], ['Rinnovare le marcature del percorso.', 'Renew the route markings.']],
];

const INSPECTIONS = [
  ['scaffolding', 4, 'internal', 'pass', null, null],
  ['ppe', 8, 'internal', 'pass', null, null],
  ['ppe', 12, 'external', 'pass_with_notes', 'eye_protection', ['Sostituire gli occhiali con la lente graffiata.', 'Replace the glasses with the scratched lens.']],
  ['scaffolding', 14, 'external', 'fail', 'toe_boards', ['Accesso sospeso. Ripristinare il fissaggio e ricontrollare (DEV-05).', 'Access suspended. Reinstate and recheck the fixing (DEV-05).']],
];

function buildDataset() {
  const tables = new Map();
  const add = (table, row) => {
    if (!tables.has(table)) tables.set(table, []);
    tables.get(table).push(row);
  };
  for (const site of SITES) {
    add('sites', { id: id(site.code), code: site.code, name: site.name, location: site.location,
      jurisdiction: site.jurisdiction, start_date: site.start, end_date: site.finish, created_at: at(site.start) });
  }
  for (const user of ACCOUNTS) {
    add('users', { id: user.id, email: user.email, name: user.name, password_algo: 'scrypt', created_at: at(SITES[0].start) });
  }
  for (const site of SITES) {
    const language = site.jurisdiction === 'IT' ? 0 : 1;
    const local = pair => pair[language];
    const key = (...parts) => id(site.code, ...parts);
    const day = index => addDays(site.diaryStart, Math.floor(index / 5) * 7 + index % 5);
    const wbsId = code => key('wbs', code);
    const scope = { site_id: key() };
    const stamp = index => at(day(index));
    const company = discipline => local(COMPANIES[discipline]);
    const account = role => ACCOUNTS.find(user => user.login === `${role}.${site.jurisdiction.toLowerCase()}`);
    const owner = account('owner'), editor = account('editor'), verifier = account('verifier');
    const area = code => local(AREAS[code]);
    const addSite = (table, row) => add(table, { ...scope, ...row });
    const context = { site, key, day, stamp, wbsId, owner, editor, verifier, local, company, area, add, addSite };

    for (const user of ACCOUNTS) {
      if ([owner, editor, verifier].includes(user)) addSite('site_members', { user_id: user.id, role: user.role });
      else if (['owner', 'viewer'].includes(user.role)) addSite('site_members', { user_id: user.id, role: 'viewer' });
    }
    for (const [index, [code, it, en, start, finish, hours, zone]] of WBS.entries()) {
      const parent = code.split('.')[0];
      addSite('project_structure', {
        id: wbsId(code), parent_id: parent === code ? null : wbsId(parent), wbs_code: code, description: local([it, en]),
        level: parent === code ? 0 : 1, sort_order: index + 1, summary_task: WBS.some(([child]) => child.startsWith(`${code}.`)),
        planned_start: at(addDays(site.start, start), '08:00'), planned_finish: at(addDays(site.start, finish)),
        planned_hours: hours, section: area(zone), plc_area: zone, is_synthetic: true, created_at: at(site.start),
      });
    }
    addTasksAndDiary(context);
    addProgress(context);
    addAttendance(context);
    addDeviations(context);
    addSafety(context);
    addLogistics(context);
  }
  return tables;
}

function addTasksAndDiary({ site, key, day, stamp, wbsId, owner, editor, verifier, local, company, area, add, addSite }) {
  for (const [index, [wbsCode, discipline, status, title, criterion]] of TASKS.entries()) {
    const taskId = key('task', index);
    const created = Math.min(index, 14);
    const zone = WBS.find(([code]) => code === wbsCode)[6];
    const submitted = status === 'to_verify' || status === 'closed';
    const declaredAt = submitted ? stamp(created + 1) : null;
    const verifiedAt = status === 'closed' ? stamp(created + 2) : null;
    const blocked = status === 'blocked';
    const corrective = index === 15 || index === 16;
    addSite('tasks', {
      id: taskId, wbs_id: wbsId(wbsCode), title: local(title), area: area(zone), company: company(discipline),
      executor: editor.name, verifier: verifier.name, executor_id: editor.id, verifier_id: verifier.id,
      priority: blocked || corrective ? 'high' : ['normal', 'high', 'low'][index % 3],
      due_date: addDays(day(created), 7), status, created_at: at(day(created), '08:00'),
      blocked_from: blocked ? 'todo' : null, submitted_by: submitted ? editor.name : null,
      submitted_by_id: submitted ? editor.id : null, kind: corrective ? 'corrective' : null,
      declared_at: declaredAt, verified_at: verifiedAt,
    });
    const event = (time, actor, from, to, action, note, reason = '') => add('task_events', {
      task_id: taskId, at: time, actor: actor.name, from_status: from, to_status: to, action, note: local(note), reason,
    });
    event(at(day(created), '08:00'), owner, 'todo', 'todo', 'create',
      [`Criterio di accettazione: ${criterion[0]}`, `Acceptance criterion: ${criterion[1]}`]);
    if (blocked) event(stamp(created), editor, 'todo', 'blocked', 'block',
      ['Montaggio rinviato.', 'Fitting deferred.'], local(['Mancano due carter.', 'Two guards are missing.']));
    if (status === 'in_progress' || submitted) event(at(day(created), '10:00'), editor, 'todo', 'in_progress', 'start',
      ['Avviato il lavoro nell’area assegnata.', 'Work started in the assigned area.']);
    if (declaredAt) event(declaredAt, editor, 'in_progress', 'to_verify', 'submit',
      ['Lavoro dichiarato eseguito. Richiesto controllo indipendente.', 'Work reported complete. Independent review requested.']);
    if (verifiedAt) event(verifiedAt, verifier, 'to_verify', 'closed', 'verify',
      ['Verifica indipendente eseguita. Criterio soddisfatto.', 'Independent review complete. Criterion met.']);
  }
  const entry = (index, shift, zone, plan, actual, next, obstruction) => addSite('diary', {
    id: key('diary', index, shift), operational_date: day(index), shift, plan: `${area(zone)}. ${local(plan)}.`,
    actual: local(actual), next_step: `${local(next)}.`,
    impediments: local(obstruction ?? ['Nessun impedimento registrato.', 'No issues recorded.']),
    time_zone: site.timeZone, day_cutoff_time: '06:00',
    created_at: shift === 'day' ? stamp(index) : at(addDays(day(index), 1), '03:00'),
  });
  for (const [index, content] of DIARY.entries()) entry(index, 'day', ...content);
  for (const [index, ...content] of NIGHTS) entry(index, 'night', ...content);
}

function addProgress({ key, stamp, wbsId, owner, editor, local, area, add, addSite }) {
  // Quantity and yes/no examples use the supported percentage scale. The binary examples only use 0 or 100.
  const types = [
    ['weighted', ['Montaggio a fasi ponderate', 'Weighted installation steps'], [
      ['prepare', 20, 'Predisposizione', 'Preparation'], ['install', 60, 'Montaggio', 'Installation'],
      ['review', 20, 'Controllo', 'Review'],
    ]],
    ['quantity_pct', ['Quantità montata (%)', 'Installed quantity (%)'], [['installed', 100, 'Quota montata', 'Installed share']]],
    ['binary_pct', ['Esito sì/no (0/100%)', 'Yes/no outcome (0/100%)'], [['verified', 100, 'Esito registrato', 'Recorded outcome']]],
  ];
  for (const [code, name, steps] of types) {
    const typeId = key('progress-type', code);
    addSite('progress_types', { id: typeId, code, name: local(name), created_by: owner.id, created_at: stamp(0) });
    for (const [index, [step, weight, it, en]] of steps.entries()) {
      add('progress_type_steps', { id: key('progress-step', code, step), progress_type_id: typeId, position: index + 1,
        code: step, description: local([it, en]), weight });
    }
  }

  const items = [
    ['4.1', 0, [[100, 100], [25, 75], [0, 50]]],
    ['4.2', 0, [[100, 100], [0, 50], [0, 0]]],
    ['5.2', 0, [[50, 100], [0, 25], [0, 0]]],
    ['6.3', 0, [[100, 100], [50, 100], [0, 75]]],
    ['4.3', 1, [[0, 1]], 4], ['5.1', 1, [[4, 8]], 8], ['6.1', 1, [[6, 12]], 12], ['6.2', 1, [[4, 12]], 16],
    ['7.1', 2, [[100]]], ['7.2', 2, [[100]]], ['8.1', 2, [[0]]], ['8.2', 2, [[0]]],
  ];
  for (const [index, [wbsCode, typeIndex, samples, target]] of items.entries()) {
    const [, it, en, , , hours, zone] = WBS.find(([code]) => code === wbsCode);
    const [type, , steps] = types[typeIndex];
    const itemId = key('progress-item', index);
    addSite('site_progress_items', { id: itemId, wbs_id: wbsId(wbsCode), description: local([it, en]), section: area(zone),
      plc_area: zone, progress_pct: [50, 30, 10, 85, 20, 100, 75, 50, 100, 0, 0, 0][index],
      planned_progress_pct: [80, 55, 40, 95, 40, 100, 100, 75, 100, 100, 60, 30][index],
      planned_start: stamp(0), planned_finish: stamp(19), planned_hours: hours,
      source_row: index + 1, created_at: stamp(0),
      progress_type_id: key('progress-type', type) });
    for (const [stepIndex, [step]] of steps.entries()) {
      const stepId = key('progress-step', type, step);
      const values = target ? samples[stepIndex].map(quantity => quantity / target * 100) : samples[stepIndex];
      add('site_progress_item_steps', { id: key('progress-state', index, step), site_progress_item_id: itemId,
        progress_type_step_id: stepId, wbs_id: wbsId(wbsCode), percent: values.at(-1), updated_by: editor.id, updated_at: stamp(19) });
      for (const [sample, percent] of values.entries()) {
        addSite('progress_entries', { id: key('progress-entry', index, step, sample), site_progress_item_id: itemId,
          progress_type_step_id: stepId, percent, recorded_at: stamp(sample === values.length - 1 ? 19 : 9), recorded_by: editor.id });
      }
    }
  }
}

function addAttendance({ site, key, day, stamp, editor, local, company, addSite }) {
  const people = PEOPLE[site.jurisdiction];
  const shiftLead = people.length - 1;
  for (const [index, name] of people.entries()) {
    const [first, last] = name.split(' ');
    const employeeId = key('employee', index);
    const [discipline, qualification, crew] = [
      ['mechanical', ['Montatore meccanico', 'Mechanical fitter'], ['Squadra montaggi', 'Installation crew']],
      ['electrical', ['Cablatore', 'Electrical fitter'], ['Squadra cablaggi', 'Wiring crew']],
      ['controls', ['Tecnico automazione', 'Controls technician'], ['Squadra prove', 'Test crew']],
    ][index < 8 ? 0 : index < 12 ? 1 : 2];
    addSite('employees', { id: employeeId, employee_no: number('NL-E', index), first_name: first, last_name: last,
      company: company(discipline), qualification: local(qualification), team: local(crew), supervisor: editor.name, created_at: stamp(0) });
    for (const dayIndex of DIARY.keys()) {
      const workDayId = key('work-day', index, dayIndex);
      const night = index >= 11 && NIGHTS.some(([nightDay]) => nightDay === dayIndex);
      const extendedShift = !night && (dayIndex + index) % 7 === 0;
      const hours = extendedShift ? 9 : 8;
      const booked = [dayIndex % shiftLead, (dayIndex + 5) % shiftLead, shiftLead].includes(index);
      const sourceHours = booked ? (night ? 6 : 7.5) : 0;
      addSite('work_days', { id: workDayId, employee_id: employeeId, operational_date: day(dayIndex),
        shift: night ? 'night' : 'day', start_time: night ? '21:00:00' : '06:00:00',
        finish_time: night ? '05:00:00' : extendedShift ? '15:00:00' : '14:00:00',
        work_time: hours, booked_hours: sourceHours, open_hours: hours - sourceHours, created_at: stamp(dayIndex) });
      if (booked) addSite('time_bookings', { id: key('booking', index, dayIndex), work_day_id: workDayId,
        site_progress_item_id: key('progress-item', (dayIndex + index) % 12), hours: night ? 5.5 : [6, 7, 7.5][dayIndex % 3],
        created_by: editor.id, created_at: night ? at(addDays(day(dayIndex), 1), '06:00') : stamp(dayIndex) });
    }
  }
  for (const [index, [category, offset, it, en]] of CERTIFICATES.entries()) {
    const expires = addDays(REFERENCE_DAY, offset);
    addSite('employee_certifications', { id: key('certification', index), employee_id: key('employee', index % people.length),
      category, name: local([it, en]), issuer: local(['Ente di prova simulato', 'Simulated assessment provider']),
      issued_on: addDays(expires, -365), expires_on: expires,
      outcome: category === 'medical' ? local(['Idoneità registrata', 'Fitness recorded']) : null, created_at: stamp(19), updated_at: stamp(19) });
  }
}

function addDeviations({ key, stamp, owner, editor, local, add, addSite }) {
  for (const [index, [status, priority, zone, title, description]] of DEVIATIONS.entries()) {
    const created = [10, 6, 8, 12, 14, 14, 15, 17][index];
    addSite('deviations', {
      id: key('deviation', index), deviation_no: number('DEV', index), title: local(title),
      problem_description: local(description), status, priority, plc_area: zone, author: owner.name, assigned_to: editor.name,
      creation_date: stamp(created), approved_date: status === 'open' ? null : stamp(created),
      due_date: stamp(Math.min(created + 3, 19)), closed_date: status === 'closed' ? stamp(19) : null,
      created_at: stamp(created),
    });
  }
  for (const [deviation, task] of [[4, 15], [6, 16]]) {
    add('deviation_links', { deviation_id: key('deviation', deviation), entity_type: 'task', entity_id: key('task', task) });
  }
  const impactId = key('cost-impact', 'guard-shortfall');
  addSite('cost_impacts', { id: impactId, title: local(['Fermo montaggio per carter mancanti', 'Fitting delay due to missing guards']),
    status: 'open', claim_amount: 480, created_by: owner.id, created_at: stamp(10) });
  add('cost_impact_deviations', { cost_impact_id: impactId, deviation_id: key('deviation', 0) });
}

function addSafety({ site, key, day, stamp, verifier, local, company, area, add, addSite }) {
  for (const [index, [discipline, status, zone, it, en]] of TOOLS.entries()) {
    addSite('tools', { id: key('tool', index), code: number('NL-T', index), name: local([it, en]), status,
      company: company(discipline), location: area(zone), created_at: stamp(0), updated_at: stamp(19),
      notes: status === 'in_use' ? local(['Consegnata alla squadra incaricata.', 'Issued to the assigned crew.']) : null });
  }
  for (const [index, [type, severity, dayIndex, zone, persons, notes, measures]] of HSE_EVENTS.entries()) {
    addSite('hse_events', { id: key('hse-event', index), event_no: number('NL-HSE', index), type, severity, occurred_on: day(dayIndex),
      location: area(zone), persons_involved: persons, notes: local(notes), measures: local(measures),
      deviation_id: index === 8 ? key('deviation', 4) : null, created_at: stamp(dayIndex), updated_at: stamp(dayIndex) });
  }
  const templateFor = category => findTemplate(`${site.jurisdiction.toLowerCase()}_${category}`);
  // The asset form requires a supported checklist. Other subjects appear in the event register.
  for (const [category, code, name] of [
    ['scaffolding', 'NL-H-A01', ['Ponteggio di accesso linea 1', 'Line 1 access scaffold']],
    ['ppe', 'NL-H-A02', ['DPI della squadra montaggi', 'Installation crew PPE']],
  ]) {
    const template = templateFor(category);
    addSite('hse_assets', { id: key('hse-asset', category), kind: template.kind, category: template.category,
      name: local(name), code, template_code: template.code, created_at: stamp(0), updated_at: stamp(0) });
  }
  for (const [index, [category, dayIndex, mode, outcome, exception, note]] of INSPECTIONS.entries()) {
    const template = templateFor(category);
    const inspectionId = key('hse-inspection', index);
    const performed = day(dayIndex);
    // These are historical snapshots of the eight checks carried out during each visit.
    addSite('hse_inspections', { id: inspectionId, asset_id: key('hse-asset', category), performed_on: performed,
      performed_by: mode === 'internal' ? verifier.name : local(['Referente HSE Ruvensal', 'Greyspindle HSE Reviewer']),
      performer_role: local(['Verifica HSE', 'HSE reviewer']), mode, outcome, notes: note ? local(note) : null,
      next_due_on: outcome === 'fail' ? addDays(performed, 2) : null, created_at: stamp(dayIndex), updated_at: stamp(dayIndex) });
    const exceptionCode = site.jurisdiction === 'UK' && exception === 'toe_boards' ? 'edge_protection' : exception;
    for (const [position, item] of template.items.slice(0, 8).entries()) {
      const defect = item.code === exceptionCode;
      add('hse_inspection_items', { id: key('hse-inspection-item', index, item.code), inspection_id: inspectionId,
        item_code: item.code, label: item.label, position, result: defect ? 'not_ok' : 'ok', note: defect ? local(note) : null });
    }
  }
}

function addLogistics({ key, day, stamp, wbsId, local, company, add, addSite }) {
  const orders = [
    ['in_execution', ['Carter in consegna frazionata.', 'Guards being delivered in batches.'], [
      ['4.3', 8, 'in_execution', 'Carter di ritorno', 'Return guards'],
      ['4.2', 4, 'in_execution', 'Supporti per motoriduttori', 'Geared motor brackets'],
    ]],
    ['open', ['Conferma del fornitore ricevuta; ritiro da concordare.', 'Supplier confirmation received; collection to be arranged.'], [
      ['6.3', 12, 'in_execution', 'Morsetti numerati', 'Numbered terminal blocks'],
    ]],
    ['completed', ['Fornitura ricevuta integralmente.', 'Delivery received in full.'], [
      ['6.1', 12, 'completed', 'Sezioni di passerella da un metro', 'One-metre cable tray sections'],
    ]],
  ];
  const unit = local(['pz', 'pcs']);
  const packedLines = [];
  for (const [orderIndex, [status, notes, lines]] of orders.entries()) {
    const orderId = key('po', orderIndex);
    const complete = status === 'completed';
    addSite('purchase_orders', { id: orderId, po_no: number('NL-PO', orderIndex), supplier_name: company('supplier'),
      ordered_on: day(0), status, notes: local(notes), closed_at: complete ? stamp(4) : null,
      created_at: stamp(0), updated_at: stamp(complete ? 4 : 10) });
    for (const [lineIndex, [wbsCode, quantity, lineStatus, it, en]] of lines.entries()) {
      const lineId = key('po-line', orderIndex, lineIndex);
      const materialNo = `NL-M-${wbsCode}`;
      const description = local([it, en]);
      add('purchase_order_items', { id: lineId, purchase_order_id: orderId, line_no: (lineIndex + 1) * 10,
        material_no: materialNo, description, unit, quantity, status: lineStatus, wbs_id: wbsId(wbsCode),
        execution_started_on: day(1), completed_on: complete ? day(4) : null, created_at: stamp(0), updated_at: stamp(complete ? 4 : 2) });
      packedLines.push({ orderId, lineId, quantity, materialNo, description });
    }
  }
  const packageNotes = [
    ['Collo spedito; riscontro parziale ancora aperto.', 'Package dispatched; partial receipt still open.'],
    ['Collo imballato in attesa di ritiro.', 'Package packed and awaiting collection.'],
    ['Collo imballato e pronto al ritiro.', 'Package packed and ready for collection.'],
    ['Collo ricevuto integralmente.', 'Package received in full.'],
  ];
  for (const [index, { orderId, lineId, quantity, materialNo, description }] of packedLines.entries()) {
    const packageId = key('package', index);
    addSite('packages', { id: packageId, purchase_order_id: orderId, package_no: number('NL-PK', index),
      status: 'closed', notes: local(packageNotes[index]), closed_at: stamp(2), created_at: stamp(1), updated_at: stamp(2) });
    add('package_items', { id: key('package-item', index), package_id: packageId, purchase_order_item_id: lineId,
      quantity_packed: quantity, material_no: materialNo, description, unit, created_at: stamp(2) });
  }
  for (const [index, packageIndex] of [0, 3].entries()) {
    const partial = index === 0;
    const shipmentId = key('shipment', index);
    const arrived = partial ? 10 : 4;
    const { lineId, quantity } = packedLines[packageIndex];
    addSite('shipments', { id: shipmentId, shipment_no: number('NL-SP', index),
      carrier: local(['Trasporti Ramofuso — simulazione', 'Coilfen Haulage — simulation']),
      shipped_on: day(arrived - 1), expected_on: day(arrived), arrived_on: day(arrived),
      status: partial ? 'arrived' : 'received', created_at: stamp(arrived - 1), updated_at: stamp(arrived) });
    add('shipment_packages', { shipment_id: shipmentId, package_id: key('package', packageIndex) });
    add('shipment_receipts', { id: key('receipt', index), shipment_id: shipmentId, purchase_order_item_id: lineId,
      quantity_received: partial ? 6 : quantity, created_at: stamp(arrived),
      note: partial ? local(['Sei carter su otto. Uno ammaccato, separato per controllo.', 'Six of eight guards. One dented and set aside for inspection.']) : null });
  }
}

// Keys also define the reset scope. Task events use their logical key because
// the database allocates their integer primary key.
const KEYS = {
  site_members: ['site_id', 'user_id'],
  task_events: ['task_id', 'at', 'action'],
  deviation_links: ['deviation_id', 'entity_type', 'entity_id'],
  cost_impact_deviations: ['cost_impact_id', 'deviation_id'],
  shipment_packages: ['shipment_id', 'package_id'],
};
const rowKeys = table => KEYS[table] ?? ['id'];
const whereKey = keys => keys.map(key => `${key} = ?`).join(' AND ');
const eventKey = row => JSON.stringify([row.task_id, new Date(row.at).toISOString(), row.action]);

function matchingKeys(table, rows) {
  const keys = rowKeys(table);
  const values = rows.flatMap(row => keys.map(key => row[key]));
  const condition = keys.length === 1
    ? `${keys[0]} IN (${rows.map(() => '?').join(', ')})`
    : rows.map(() => `(${whereKey(keys)})`).join(' OR ');
  return [condition, ...values];
}

export function plan() {
  return {
    sites: SITES.map(({ code, jurisdiction, timeZone }) => ({ code, jurisdiction, timeZone })),
    referenceDay: REFERENCE_DAY,
    counts: Object.fromEntries(Array.from(buildDataset(), ([table, rows]) => [table, rows.length])),
  };
}

async function insert(tx, table, rows) {
  if (!rows.length) return 0;
  const keys = rowKeys(table);
  const columns = Object.keys(rows[0]);
  const values = [];
  const bind = value => {
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    values.push(value);
    return '?';
  };
  const tuples = rows.map(row => `(${columns.map(column => bind(row[column])).join(', ')})`);
  const conflict = table === 'task_events' ? '' : ` ON CONFLICT (${keys.join(', ')}) DO NOTHING`;
  return Number((await tx.run(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}${conflict}`, ...values)).rowCount);
}

async function lockSites(tx, sites) {
  // A write lock serialises the seed commands using the same site order on both drivers.
  for (const site of sites) await tx.run('UPDATE sites SET id = id WHERE id = ?', site.id);
}

export async function apply(db, { password = process.env.NORTHLINE_SEED_PASSWORD } = {}) {
  if (password !== undefined && (typeof password !== 'string' || !password || password.length > 1024)) {
    throw new Error('Invalid NORTHLINE_SEED_PASSWORD.');
  }
  const tables = buildDataset();
  return db.transaction(async tx => {
    const counts = { sites: await insert(tx, 'sites', tables.get('sites')) };
    await lockSites(tx, tables.get('sites'));
    for (const [table, plannedRows] of tables) {
      if (table === 'sites') continue;
      let rows = plannedRows;
      if (table === 'users') {
        const [where, ...values] = matchingKeys(table, rows);
        const users = await tx.all(`SELECT id FROM users WHERE ${where}`, ...values);
        const existing = new Set(users.map(user => user.id));
        rows = [];
        for (const row of plannedRows) {
          if (existing.has(row.id)) continue;
          const password_hash = await hashPassword(password ?? randomBytes(32).toString('base64url'));
          rows.push({ ...row, password_hash });
        }
      } else if (table === 'task_events') {
        const [where, ...values] = matchingKeys(table, rows);
        const events = await tx.all(`SELECT task_id, at, action FROM task_events WHERE ${where}`, ...values);
        const existing = new Set(events.map(eventKey));
        rows = rows.filter(row => !existing.has(eventKey(row)));
      }
      counts[table] = await insert(tx, table, rows);
    }
    return counts;
  });
}

export async function reset(db) {
  const tables = buildDataset();
  return db.transaction(async tx => {
    await lockSites(tx, tables.get('sites'));
    const removed = {};
    for (const [table, rows] of [...tables].reverse()) {
      const [where, ...values] = matchingKeys(table, rows);
      if (table === 'users') {
        const placeholders = rows.map(() => '?').join(', ');
        removed.sessions = Number((await tx.run(`DELETE FROM sessions WHERE user_id IN (${placeholders})`, ...values)).rowCount);
      }
      removed[table] = Number((await tx.run(`DELETE FROM ${table} WHERE ${where}`, ...values)).rowCount);
    }
    return removed;
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(JSON.stringify({ dryRun: true, ...plan() }, null, 2));
  } else {
    if (args.length !== 1 || !['--apply', '--reset'].includes(args[0])) {
      throw new Error('Usage: node server/seed-northline.mjs [--apply | --reset]');
    }
    if (process.env.NODE_ENV === 'production') throw new Error('Synthetic seed is disabled in production.');
    const db = await openDb();
    try {
      const result = args[0] === '--apply' ? { applied: true, inserted: await apply(db) } : { reset: true, removed: await reset(db) };
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await closeDb(db);
    }
  }
}
