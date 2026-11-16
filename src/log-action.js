#!/usr/bin/env node
// log-action.js — the ONLY writer of logs/actions.log.
//
// A hand-typed entry once went in with a placeholder timestamp ("15:5x:xx"), which makes the log
// useless for ordering an incident. Every line now carries a real UTC timestamp taken at write
// time, and the call sites cannot supply one.
//
//   const { logAction } = require('./log-action.js');
//   logAction('WRITE', 'src/x.js -> manifest/protected.json (A1)');
const fs = require('fs');
const path = require('path');

const V2 = 'D:/code/orca-supervisor';
const LOG = path.join(V2, 'logs/actions.log');

function logAction(kind, detail) {
  const ts = new Date().toISOString();
  const line = `${ts} ${String(kind || 'NOTE').toUpperCase()} ${detail}\n`;
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, line);
  return line.trim();
}

module.exports = { logAction };

if (require.main === module) {
  const [kind, ...rest] = process.argv.slice(2);
  if (!kind) { console.error('usage: node src/log-action.js <KIND> <detail>'); process.exit(2); }
  console.log(logAction(kind, rest.join(' ')));
}
