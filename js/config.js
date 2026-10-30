/* ---------------------------------------------------------------
   Mzab League — backend configuration
   Two independent Supabase projects are recommended:

   PRODUCTION  → real league data, used by GitHub Pages
   DEVELOPMENT → sample/test data, used when running locally

   1. Create both projects at https://supabase.com
   2. Run supabase/schema.sql in each project's SQL Editor
   3. Copy each project's URL + anon/publishable key below
   4. Keep Authentication → URL Configuration pointed at the
      matching site (GitHub Pages for prod, localhost for dev)

   Both anon/publishable keys are safe to publish. Row Level Security
   protects writes. Never put a service_role/secret key in this file.
   --------------------------------------------------------------- */

(function () {
  const PRODUCTION = {
    SUPABASE_URL: 'https://vbegrfxsxsbldgwvwpeb.supabase.co',
    SUPABASE_ANON_KEY: 'sb_publishable_TmId0iOLlW18EieXMNn2JQ_zJ_R6IKi'
  };

  const DEVELOPMENT = {
    SUPABASE_URL: 'https://dcpdzyieicvtnknqlhyh.supabase.co',
    SUPABASE_ANON_KEY: 'sb_publishable_6Nv9e0wf1BYrjHll5cSeKw_dSwYWoQB'
  };

  const devConfigured = Boolean(DEVELOPMENT.SUPABASE_URL && DEVELOPMENT.SUPABASE_ANON_KEY);
  const params = new URLSearchParams(window.location.search);
  const requested = params.get('env');
  const localHost = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname) ||
    window.location.protocol === 'file:';

  let environment = 'production';
  let warning = '';

  if (requested === 'dev') {
    if (devConfigured) {
      environment = 'development';
    } else {
      warning = 'devMissing';
    }
  } else if (requested === 'prod') {
    environment = 'production';
    if (localHost) warning = 'localProd';
  } else if (localHost) {
    if (devConfigured) {
      environment = 'development';
    } else {
      // Local preview without dev keys would otherwise silently edit real data.
      warning = 'localProd';
    }
  }

  const selected = environment === 'development' ? DEVELOPMENT : PRODUCTION;

  window.KICKOFF_CONFIG = {
    SUPABASE_URL: selected.SUPABASE_URL,
    SUPABASE_ANON_KEY: selected.SUPABASE_ANON_KEY,
    ENVIRONMENT: environment,
    ENV_WARNING: warning,
    DEV_CONFIGURED: devConfigured
  };
})();
