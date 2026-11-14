'use strict';
// Stand-alone worker process: `npm run worker`. Use it when you do not want background work inside the web servers.
const { migrate, close } = require('./lib/db');
const worker = require('./lib/worker');
(async () => {
  await migrate();
  worker.start();
  console.log('Shop-Beta worker running.');
})().catch((e) => { require('./lib/log').error('worker failed to start', { err: e }); process.exit(1); });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await worker.stop(); await close().catch(() => {}); process.exit(0); });
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e && e.message ? e.message : e));
