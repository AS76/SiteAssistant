import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const supported = new Set(['it', 'en']);
const escape = value => String(value ?? '').replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export const DEFAULT_PRIVACY_CONFIG = new URL('../config/privacy.json', import.meta.url);
export const EXAMPLE_PRIVACY_CONFIG = new URL('../config/privacy.example.json', import.meta.url);

function readConfig(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

function nonEmpty(value) { return typeof value === 'string' && value.trim().length > 0; }

/**
 * A deployment is allowed to render the notices only when the public operator
 * fields and legal-basis placeholders have been supplied. This prevents a
 * production page from looking complete while omitting the controller.
 */
export function loadPrivacyConfig({ env = process.env } = {}) {
  const path = env.PRIVACY_CONFIG_FILE
    ? resolve(env.PRIVACY_CONFIG_FILE)
    : DEFAULT_PRIVACY_CONFIG;
  const config = readConfig(path);
  if (!config) return { configured: false, reason: 'missing-config' };
  const operator = config.operator || {};
  const legalBases = Array.isArray(config.legalBases) ? config.legalBases.filter(nonEmpty) : [];
  const configured = nonEmpty(operator.name) && nonEmpty(operator.address) &&
    nonEmpty(operator.privacyEmail) && nonEmpty(config.updatedAt) && legalBases.length > 0;
  return { ...config, configured, reason: configured ? null : 'incomplete-config', legalBases };
}

export function languageFromRequest(request, url) {
  const query = url.searchParams.get('lang');
  if (supported.has(query)) return query;
  const header = request.headers?.['accept-language'] || '';
  for (const part of header.split(',')) {
    const tag = part.trim().split(';')[0].toLowerCase();
    const base = tag.split('-')[0];
    if (supported.has(base)) return base;
  }
  return 'en';
}

function pageShell({ language, title, body }) {
  return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)} | SiteAssistant</title>
<style>
:root{--paper:#FAF6EC;--ink:#1E1A15;--brick:#8E2E24;--line:#D8CCB5;--muted:#62594C}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 "Source Sans 3",system-ui,sans-serif}
main{max-width:860px;margin:auto;padding:32px 20px 64px}h1{font:600 32px/1.15 "Source Serif 4",serif;margin:0 0 8px}h2{font:600 22px/1.2 "Source Serif 4",serif;margin:32px 0 8px}h3{font-size:17px;margin:20px 0 6px}p,li{max-width:72ch}a{color:var(--brick)}.meta{color:var(--muted);font-size:14px;margin-bottom:24px}.rule{height:1px;background:var(--line);margin:24px 0}.back{display:inline-block;margin-bottom:24px;font-weight:600}table{width:100%;border-collapse:collapse;margin:12px 0 20px;font-size:14px}th,td{text-align:left;vertical-align:top;border-bottom:1px solid var(--line);padding:8px 8px 8px 0}th{background:#F2EBDC}.note{padding:12px 14px;border-left:3px solid var(--brick);background:#F6EBDD}.small{font-size:13px;color:var(--muted)}@media(max-width:640px){main{padding:24px 16px 48px}h1{font-size:27px}table{display:block;overflow-x:auto;white-space:normal}th,td{min-width:150px}}
</style>
</head>
<body><main>${body}</main></body></html>`;
}

function configRequired(language) {
  const it = language === 'it';
  return pageShell({
    language,
    title: it ? 'Informative non configurate' : 'Notices not configured',
    body: `<a class="back" href="/">← SiteAssistant</a>
<h1>${it ? 'Informative non configurate' : 'Notices not configured'}</h1>
<p>${it ? 'Questa installazione non ha ancora fornito i dati del gestore e le basi giuridiche richieste. Le informative saranno disponibili solo dopo la configurazione e la validazione.' : 'This installation has not yet supplied the operator details and legal bases required by the notice template. The notices will be available only after configuration and validation.'}</p>`
  });
}

export function renderPrivacyPage(config, language) {
  if (!config.configured) return configRequired(language);
  const it = language === 'it';
  const operator = config.operator;
  const retention = config.retention || {};
  const legal = config.legalBases.map((basis, index) => `<li>${escape(basis)}</li>`).join('');
  const services = Array.isArray(config.services) ? config.services : [];
  const serviceRows = services.map(service => `<tr><td>${escape(service.name)}</td><td>${escape(service.purpose)}</td><td>${escape(service.location || (it ? 'da confermare' : 'to be confirmed'))}</td></tr>`).join('');
  return pageShell({
    language,
    title: it ? 'Informativa privacy' : 'Privacy notice',
    body: `<a class="back" href="/">← SiteAssistant</a>
<h1>${it ? 'Informativa privacy' : 'Privacy notice'}</h1>
<p class="meta">${it ? 'Ultimo aggiornamento' : 'Last updated'}: <time datetime="${escape(config.updatedAt)}">${escape(config.updatedAt)}</time></p>
<div class="note"><strong>${it ? 'Ambito' : 'Scope'}.</strong> ${it ? 'Questa informativa riguarda la demo pubblica SiteAssistant. Le installazioni self-hosted devono configurare il proprio gestore e le proprie informazioni; non ereditano automaticamente questa informativa.' : 'This notice covers the public SiteAssistant demo. Self-hosted installations must configure their own operator and information; they do not automatically inherit this notice.'}</div>
<h2>${it ? 'Titolare del trattamento' : 'Data controller'}</h2>
<p>${escape(operator.name)}<br>${escape(operator.address)}<br>${it ? 'Contatto privacy' : 'Privacy contact'}: <a href="mailto:${escape(operator.privacyEmail)}">${escape(operator.privacyEmail)}</a>${operator.dpo ? `<br>${it ? 'DPO' : 'DPO'}: ${escape(operator.dpo)}` : ''}</p>
<h2>${it ? 'Quali dati trattiamo e perché' : 'What data we process and why'}</h2>
<p>${it ? 'La demo tratta account e richieste di accesso, sessioni e metadati tecnici, dati operativi sintetici, contenuti inseriti volontariamente, allegati e registrazioni di audit. I dati di cantiere della demo sono fittizi; non inserire dati personali, riservati o reali.' : 'The demo processes accounts and access requests, sessions and technical metadata, synthetic operational records, voluntarily entered content, attachments and audit records. Demo site records are fictional; do not enter real, personal or confidential data.'}</p>
<table><thead><tr><th>${it ? 'Categoria' : 'Category'}</th><th>${it ? 'Finalità' : 'Purpose'}</th></tr></thead><tbody>
<tr><td>${it ? 'Account e accesso' : 'Account and access'}</td><td>${it ? 'Creare e gestire l’account, autenticare, inviare email transazionali, prevenire abusi.' : 'Create and manage the account, authenticate, send transactional email, prevent abuse.'}</td></tr>
<tr><td>${it ? 'Sessioni e sicurezza' : 'Sessions and security'}</td><td>${it ? 'Mantenere la sessione, revocarla, applicare limiti e registrare eventi di autenticazione.' : 'Maintain and revoke the session, apply limits and record authentication events.'}</td></tr>
<tr><td>${it ? 'Dati di cantiere sintetici' : 'Synthetic site records'}</td><td>${it ? 'Mostrare le funzionalità della demo con scenari fittizi.' : 'Demonstrate features with fictional scenarios.'}</td></tr>
<tr><td>${it ? 'Assistente AI' : 'AI assistant'}</td><td>${it ? 'Rispondere alle domande usando i dati sintetici del cantiere, se l’assistente è abilitato.' : 'Answer questions using synthetic site data when the assistant is enabled.'}</td></tr>
<tr><td>${it ? 'Audit e log' : 'Audit and logs'}</td><td>${it ? 'Sicurezza, diagnosi, integrità delle operazioni e prevenzione degli abusi.' : 'Security, diagnostics, operational integrity and abuse prevention.'}</td></tr>
</tbody></table>
<h2>${it ? 'Cookie e memoria del dispositivo' : 'Cookies and device storage'}</h2>
<p>${it ? 'Il cookie sa_session è necessario per l’autenticazione. Le preferenze e le cache locali sono descritte nella Cookie Policy. Non usiamo analytics, advertising o profilazione.' : 'The sa_session cookie is necessary for authentication. Preferences and local caches are described in the Cookie Policy. We do not use analytics, advertising or profiling.'} <a href="/cookie-policy${language === 'it' ? '?lang=it' : '?lang=en'}">${it ? 'Cookie Policy' : 'Cookie Policy'}</a></p>
<h2>${it ? 'Fornitori e destinatari' : 'Providers and recipients'}</h2>
${serviceRows ? `<table><thead><tr><th>${it ? 'Servizio' : 'Service'}</th><th>${it ? 'Finalità' : 'Purpose'}</th><th>${it ? 'Localizzazione' : 'Location'}</th></tr></thead><tbody>${serviceRows}</tbody></table>` : `<p>${it ? 'Nessun fornitore configurato nell’informativa.' : 'No provider configured in the notice.'}</p>`}
<p>${it ? 'L’assistente AI può inviare prompt e risultati delle query a un provider di inferenza configurato. La ricerca indirizzi può interrogare servizi cartografici esterni. Le email transazionali passano dal servizio configurato. Non usiamo questi servizi per finalità diverse da quelle descritte.' : 'The AI assistant may send prompts and query results to a configured inference provider. Address search may query external mapping services. Transactional email uses the configured service. We do not use these services for purposes other than those described.'}</p>
<h2>${it ? 'Conservazione' : 'Retention'}</h2>
<table><thead><tr><th>${it ? 'Categoria' : 'Category'}</th><th>${it ? 'Periodo' : 'Period'}</th></tr></thead><tbody>
<tr><td>${it ? 'Sessioni attive' : 'Active sessions'}</td><td>${escape(retention.activeSessions || (it ? '7 giorni' : '7 days'))}</td></tr>
<tr><td>${it ? 'Sessioni scadute o revocate' : 'Expired or revoked sessions'}</td><td>${escape(retention.expiredSessions || (it ? '30 giorni' : '30 days'))}</td></tr>
<tr><td>${it ? 'Eventi di autenticazione' : 'Authentication events'}</td><td>${escape(retention.authEvents || (it ? '90 giorni' : '90 days'))}</td></tr>
<tr><td>${it ? 'Richieste di accesso concluse' : 'Closed access requests'}</td><td>${escape(retention.signupRequests || (it ? '30 giorni' : '30 days'))}</td></tr>
<tr><td>${it ? 'Log applicativi' : 'Application logs'}</td><td>${escape(retention.applicationLogs || (it ? '30 giorni, se gestiti' : '30 days, if managed'))}</td></tr>
<tr><td>${it ? 'Backup' : 'Backups'}</td><td>${escape(retention.backups || (it ? 'secondo la configurazione dell’hosting' : 'according to hosting configuration'))}</td></tr>
</tbody></table>
<p class="small">${it ? 'I tempi effettivi dei fornitori possono differire e sono indicati nella configurazione dell’istanza.' : 'Actual provider periods may differ and are stated in the instance configuration.'}</p>
<h2>${it ? 'Basi giuridiche' : 'Legal bases'}</h2><ul>${legal}</ul>
<h2>${it ? 'Diritti e contatti' : 'Rights and contact'}</h2>
<p>${it ? 'Puoi chiedere accesso, rettifica, cancellazione, limitazione, opposizione e portabilità nei limiti applicabili. Scrivi al contatto privacy indicato sopra. Puoi proporre reclamo all’autorità di controllo competente.' : 'You may request access, rectification, erasure, restriction, objection and portability within applicable limits. Write to the privacy contact above. You may lodge a complaint with the competent supervisory authority.'}</p>
<h2>${it ? 'Modifiche' : 'Changes'}</h2>
<p>${it ? 'La data in alto indica l’ultimo aggiornamento. Le modifiche sostanziali saranno comunicate con un avviso appropriato.' : 'The date above shows the last update. Material changes will be communicated with an appropriate notice.'}</p>
<p class="small">${it ? 'Questa informativa descrive i trattamenti tecnici noti; non è una dichiarazione di conformità GDPR o UK GDPR.' : 'This notice describes known technical processing; it is not a declaration of GDPR or UK GDPR compliance.'}</p>`
  });
}

export function renderCookiePage(config, language) {
  if (!config.configured) return configRequired(language);
  const it = language === 'it';
  return pageShell({
    language,
    title: it ? 'Cookie Policy' : 'Cookie Policy',
    body: `<a class="back" href="/">← SiteAssistant</a>
<h1>Cookie Policy</h1>
<p class="meta">${it ? 'Ultimo aggiornamento' : 'Last updated'}: <time datetime="${escape(config.updatedAt)}">${escape(config.updatedAt)}</time></p>
${it ? `<p>Questa pagina descrive cookie e memorizzazione locale della demo pubblica e della configurazione predefinita. Le installazioni self-hosted devono verificare e aggiornare questa pagina per la propria istanza.</p>` : `<p>This page describes cookies and local storage in the public demo and the default configuration. Self-hosted installations must verify and update this page for their instance.</p>`}
<h2>${it ? 'Cookie' : 'Cookies'}</h2>
<table><thead><tr><th>${it ? 'Nome' : 'Name'}</th><th>${it ? 'Finalità' : 'Purpose'}</th><th>${it ? 'Durata' : 'Duration'}</th><th>${it ? 'Necessario' : 'Necessary'}</th></tr></thead><tbody>
<tr><td><code>sa_session</code></td><td>${it ? 'Autenticazione e sessione; HttpOnly, SameSite=Lax, Secure in produzione.' : 'Authentication and session; HttpOnly, SameSite=Lax, Secure in production.'}</td><td>${it ? '7 giorni' : '7 days'}</td><td>${it ? 'Sì' : 'Yes'}</td></tr>
</tbody></table>
<p>${it ? 'Non risultano cookie di analytics, advertising, profilazione o tracciamento di terze parti.' : 'No analytics, advertising, profiling or third-party tracking cookies are currently used.'}</p>
<h2>${it ? 'Memoria locale del browser' : 'Browser local storage'}</h2>
<table><thead><tr><th>${it ? 'Meccanismo' : 'Mechanism'}</th><th>${it ? 'Contenuto' : 'Content'}</th><th>${it ? 'Durata' : 'Duration'}</th></tr></thead><tbody>
<tr><td>localStorage</td><td>${it ? 'Preferenze di visualizzazione, lingua, avviso demo, stato della navigazione.' : 'Display and language preferences, demo notice, navigation state.'}</td><td>${it ? 'Fino alla cancellazione del browser o dell’utente.' : 'Until cleared by the browser or user.'}</td></tr>
<tr><td>sessionStorage</td><td>${it ? 'Vista logistica e HSE della sessione corrente.' : 'Logistics and HSE view for the current session.'}</td><td>${it ? 'Fine della sessione del browser.' : 'End of browser session.'}</td></tr>
<tr><td>IndexedDB</td><td>${it ? 'Mirror e coda delle operazioni offline, isolate per utente e API.' : 'Offline mirror and operation queue, scoped to the user and API.'}</td><td>${it ? 'Rimossa al logout; può restare dopo una scadenza della sessione fino alla pulizia.' : 'Removed on sign-out; may remain after session expiry until cleanup.'}</td></tr>
<tr><td>Cache Storage</td><td>${it ? 'Shell dell’applicazione e risposte API selezionate; allegati binari esclusi.' : 'Application shell and selected API responses; binary attachments excluded.'}</td><td>${it ? 'Rimossa al logout o al cambio di versione.' : 'Removed on sign-out or version change.'}</td></tr>
</tbody></table>
<h2>${it ? 'Consenso' : 'Consent'}</h2>
<p>${it ? 'Il cookie di sessione e le preferenze necessarie non richiedono un banner di consenso nella configurazione attuale. Se l’istanza introduce analytics, advertising o altri strumenti non necessari, deve aggiungere un meccanismo di blocco preventivo, scelta granulare e revoca.' : 'The session cookie and necessary preferences do not require a consent banner in the current configuration. If an instance introduces analytics, advertising or other non-essential tools, it must add prior blocking, granular choice and withdrawal.'}</p>
<h2>${it ? 'Contatti' : 'Contact'}</h2>
<p>${escape(config.operator.name)} · <a href="mailto:${escape(config.operator.privacyEmail)}">${escape(config.operator.privacyEmail)}</a></p>
<p class="small">${it ? 'Questa pagina descrive la configurazione tecnica; non è una dichiarazione di conformità GDPR o UK GDPR.' : 'This page describes the technical configuration; it is not a declaration of GDPR or UK GDPR compliance.'}</p>`
  });
}

export function privacyResponse(request, response, url, config) {
  const language = languageFromRequest(request, url);
  const path = url.pathname;
  if (!['/privacy', '/cookie-policy'].includes(path)) return false;
  const html = path === '/privacy' ? renderPrivacyPage(config, language) : renderCookiePage(config, language);
  const status = config.configured ? 200 : 503;
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Vary': 'Accept-Language', 'Cache-Control': 'no-store' });
  response.end(html);
  return true;
}
