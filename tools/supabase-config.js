'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function fail(message) {
  console.error('\nError: ' + message + '\n');
  process.exit(1);
}

/** Read the public Supabase URL + publishable key for an environment. */
function readConfig(envArg = 'prod') {
  let url = process.env.SUPABASE_URL;
  let key = process.env.SUPABASE_ANON_KEY;
  if (url && key) return { url, key, source: 'environment' };

  const configFile = path.join(root, 'js', 'config.js');
  const source = fs.readFileSync(configFile, 'utf8');
  const blockName = envArg === 'dev' ? 'DEVELOPMENT' : 'PRODUCTION';
  const block = source.match(new RegExp(`const ${blockName} = \\{([\\s\\S]*?)\\};`));
  if (!block) fail(`Could not find the ${blockName} block in js/config.js`);

  const urlMatch = block[1].match(/SUPABASE_URL:\s*'([^']+)'/);
  const keyMatch = block[1].match(/SUPABASE_ANON_KEY:\s*'([^']+)'/);
  if (!urlMatch || !keyMatch) fail(`Incomplete ${blockName} configuration in js/config.js`);

  return {
    url: urlMatch[1],
    key: keyMatch[1],
    source: `js/config.js (${envArg === 'dev' ? 'development' : 'production'})`
  };
}

module.exports = { root, fail, readConfig };
