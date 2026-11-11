#!/usr/bin/env node
'use strict';
// Runs ONLY the background worker (no website). Not needed today: both web instances already run the worker inside themselves,
// which costs nothing extra. Use this if you later move the worker to its own service (an extra paid Render service: ask first)
// and start the web instances with WORKER=0.
try { for (const l of require('fs').readFileSync(require('path').join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2'); } } catch { /* no .env */ }
delete process.env.WORKER;
const { migrate } = require('../lib/migrate');
const jobs = require('../lib/jobs');
const { end } = require('../lib/db');
(async () => {
  await migrate(); jobs.start(); console.log('Worker running. Press Ctrl+C to stop.');
  const bye = async () => { await jobs.stop(); await end(); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
  setInterval(() => {}, 1 << 30);
})().catch((e) => { console.error(e.message); process.exit(1); });
