// ============================================================
//  PRODUCTION CONFIG — this file is gitignored.
//  Copy from config.example.js and fill in your real values.
//  Loaded by index.html BEFORE app.js.
// ============================================================
window.APP_CONFIG = {
  SUPABASE_URL:  'https://djklzeiwasevjatfasnl.supabase.co',
  SUPABASE_KEY:  'sb_publishable_NPMNAXMEzN_61lpHI0MyhQ_90Dz0D49',

  // n8n webhook — used only as a fallback / manual override.
  // Primary trigger is Supabase Database Webhook on location_logs INSERT.
  WEBHOOK_URL: 'https://n8n.srv1249349.hstgr.cloud/webhook/driver-tracker',
  API_KEY:     'YOUR_SECRET_API_KEY',
};
