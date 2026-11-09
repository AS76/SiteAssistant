import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// Hosting: GitHub Pages by default; override with DOCS_SITE / DOCS_BASE
// (for example a custom domain: DOCS_SITE=https://docs.example.com DOCS_BASE=/).
const site = process.env.DOCS_SITE || 'https://as76.github.io';
const base = process.env.DOCS_BASE || '/SiteAssistant';

export default defineConfig({
  site,
  base,
  integrations: [
    starlight({
      title: { it: 'SiteAssistant Docs', en: 'SiteAssistant Docs' },
      description:
        'Manuale operativo e riferimento tecnico di SiteAssistant: cantieri, attività, verifiche e diario di cantiere.',
      logo: { src: './src/assets/logo.svg', alt: 'SiteAssistant' },
      defaultLocale: 'root',
      locales: {
        root: { label: 'Italiano', lang: 'it' },
        en: { label: 'English', lang: 'en' },
      },
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/AS76/SiteAssistant',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/AS76/SiteAssistant/edit/main/docs-site/',
      },
      customCss: ['./src/styles/brand.css'],
      sidebar: [
        { label: 'Benvenuto', translations: { en: 'Welcome' }, link: '/' },
        {
          label: 'Guida',
          translations: { en: 'Guide' },
          items: [
            { label: 'Accesso e sessioni', translations: { en: 'Sign in and sessions' }, slug: 'guida/accesso' },
            { label: 'Funzioni comuni', translations: { en: 'Common features' }, slug: 'guida/funzioni-comuni' },
          ],
        },
        {
          label: 'Moduli',
          translations: { en: 'Modules' },
          items: [
            { label: 'Cantieri', translations: { en: 'Sites' }, slug: 'moduli/cantieri' },
            { label: 'Attività e verifiche', translations: { en: 'Tasks and verification' }, slug: 'moduli/attivita' },
            { label: 'Diario di cantiere', translations: { en: 'Site diary' }, slug: 'moduli/diario' },
          ],
        },
        {
          label: 'Amministrazione',
          translations: { en: 'Administration' },
          items: [
            { label: 'Utenti e ruoli', translations: { en: 'Users and roles' }, slug: 'amministrazione/utenti-e-ruoli' },
            { label: 'Configurare un cantiere', translations: { en: 'Configure a site' }, slug: 'amministrazione/configurare-cantiere' },
          ],
        },
        {
          label: 'Riferimento',
          translations: { en: 'Reference' },
          items: [
            { label: 'API REST', translations: { en: 'REST API' }, slug: 'riferimento/api' },
            { label: 'Glossario', translations: { en: 'Glossary' }, slug: 'riferimento/glossario' },
            { label: 'Novità', translations: { en: "What's new" }, slug: 'note/novita' },
            { label: 'Stato del prodotto', translations: { en: 'Product status' }, slug: 'note/rilascio' },
          ],
        },
      ],
    }),
  ],
});
