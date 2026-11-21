import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './lib/db.mjs';
import { seedDatabase } from './lib/seed.mjs';
import { makeApp, expireStaleOrders } from './lib/app.mjs';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const DB_PATH = process.env.DB_PATH || path.join(ROOT_DIR, 'data', 'multitheme.db');

const db = openDatabase(DB_PATH);
seedDatabase(db, ROOT_DIR);

const handler = makeApp({ db, rootDir: ROOT_DIR, env: process.env });

// Periodic cleanup of expired unpaid orders (releases reserved warehouse stock)
const sweepTimer = setInterval(() => {
  try { expireStaleOrders(db); } catch (e) { console.error('[expiry sweep]', e); }
}, 60_000);
sweepTimer.unref();

const HOST = process.env.HOST || '0.0.0.0';
const server = http.createServer(handler);
server.listen(PORT, HOST, () => {
  console.log(`Multitheme Platform running at http://localhost:${PORT}`);
  console.log(`  Storefront (Trove Market):   http://localhost:${PORT}/?store=trove-market`);
  console.log(`  Storefront (Fresh Harvest):  http://localhost:${PORT}/?store=fresh-harvest`);
  console.log(`  Storefront (Urban Pantry):   http://localhost:${PORT}/?store=urban-pantry`);
  console.log(`  Responsive Preview Studio:   http://localhost:${PORT}/preview.html`);
  console.log(`  Multi-Tenant Back Office:    http://localhost:${PORT}/admin`);
});
