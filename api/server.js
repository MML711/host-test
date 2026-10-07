/**
 * AgriTrack host test — checks, on the host itself, what AgriTrack's API needs:
 *   1. live connections (socket.io) stay open and keep receiving messages — over real WebSockets;
 *   2. exactly one copy runs: every copy has its own id, and a timer "job" runs once a minute per copy;
 *   3. what a redeploy does: SIGTERM is logged, ids change, and any overlap shows in /jobs;
 *   4. outgoing HTTPS works (GET /outbound);
 *   5. the database: version, timezone, and whether a limited login could be created (GET /db).
 * Run locally: npm install && npm start   (PORT defaults to 3000; DATABASE_URL is optional)
 */
import express from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import postgres from 'postgres';
import { Server } from 'socket.io';

const PORT = Number(process.env.PORT) || 3000;
const INSTANCE = randomUUID().slice(0, 8);
const BOOTED_AT = new Date();
const TICK_EVERY_MS = 15_000;
const JOB_EVERY_MS = 60_000;

const jobRuns = [];
let ticks = 0;

const log = (...args) => console.log(new Date().toISOString(), `[${INSTANCE}]`, ...args);

const sql = process.env.DATABASE_URL
  ? postgres(process.env.DATABASE_URL, { max: 2, ssl: process.env.DB_SSL || 'prefer', onnotice: () => {} })
  : null;

const app = express();
const server = createServer(app);
const io = new Server(server);

app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));

app.get('/health', (req, res) => res.json({ ok: true, instance: INSTANCE }));

app.get('/info', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    instance: INSTANCE,
    bootedAt: BOOTED_AT,
    uptimeSeconds: Math.round(process.uptime()),
    hostname: os.hostname(),
    pid: process.pid,
    node: process.version,
    port: PORT,
    liveConnections: io.engine.clientsCount,
    ticks,
    lastJobRuns: jobRuns.slice(-5),
    processTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    serverTime: new Date(),
  });
});

// Any HTTP status means the service is reachable from the host; an error means the call was blocked or failed.
const OUTBOUND = [
  ['GitHub API', 'https://api.github.com/zen'],
  ['Cloudinary (uploads)', 'https://api.cloudinary.com/'],
  ['SMSEthiopia', 'https://smsethiopia.com/developer-docs.txt'],
  ['AfroMessage', 'https://api.afromessage.com/api/summary'],
  ['Stripe', 'https://api.stripe.com/'],
];

app.get('/outbound', async (req, res) => {
  const results = await Promise.all(OUTBOUND.map(async ([name, url]) => {
    const started = Date.now();
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      return { name, url, reachable: true, status: response.status, ms: Date.now() - started };
    } catch (error) {
      return { name, url, reachable: false, error: error.cause?.code || error.name, ms: Date.now() - started };
    }
  }));
  res.json({ instance: INSTANCE, results });
});

app.get('/db', async (req, res) => {
  if (!sql) return res.json({ instance: INSTANCE, database: 'not configured — link a database (DATABASE_URL)' });
  try {
    const [row] = await sql`
      select version() as version,
             current_setting('TimeZone') as timezone,
             now() as db_now,
             current_user as db_user,
             current_database() as database,
             r.rolsuper as superuser,
             r.rolcreaterole as can_create_roles,
             r.rolcreatedb as can_create_databases
      from pg_roles r
      where r.rolname = current_user`;
    const extensions = await sql`select name from pg_available_extensions order by name`;
    const result = { instance: INSTANCE, ...row, availableExtensions: extensions.map((e) => e.name) };
    if (req.query.try_role === '1') {
      // Create and drop a throwaway login with no rights: can we give the app a limited login of its own?
      const name = `host_test_probe_${Date.now()}`;
      try {
        await sql`create role ${sql(name)} nologin`;
        await sql`drop role ${sql(name)}`;
        result.createLimitedRole = 'allowed';
      } catch (error) {
        result.createLimitedRole = `refused: ${error.message}`;
      }
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ instance: INSTANCE, error: error.message });
  }
});

// Which copies ran the job, and when — two ids active in the same minutes means two copies were running.
app.get('/jobs', async (req, res) => {
  if (!sql) return res.json({ instance: INSTANCE, jobRunsInThisCopy: jobRuns.slice(-20) });
  try {
    const copies = await sql`
      select instance, count(*)::int as runs, min(ran_at) as first_run, max(ran_at) as last_run
      from host_test_job_runs
      group by instance
      order by max(ran_at) desc
      limit 20`;
    res.json({ instance: INSTANCE, copies });
  } catch (error) {
    res.status(500).json({ instance: INSTANCE, error: error.message });
  }
});

io.on('connection', (socket) => {
  const transport = socket.conn.transport.name;
  log(`connect ${socket.id} via ${transport} (${io.engine.clientsCount} live)`);
  socket.emit('hello', { instance: INSTANCE, bootedAt: BOOTED_AT, transport });
  socket.conn.on('upgrade', (t) => log(`upgrade ${socket.id} to ${t.name}`));
  socket.on('disconnect', (reason) => log(`disconnect ${socket.id}: ${reason} (${io.engine.clientsCount} live)`));
});

setInterval(() => {
  ticks += 1;
  io.emit('tick', { instance: INSTANCE, n: ticks, at: new Date().toISOString() });
}, TICK_EVERY_MS);

setInterval(async () => {
  const run = { n: jobRuns.length + 1, at: new Date().toISOString() };
  jobRuns.push(run);
  log(`job run #${run.n}`);
  io.emit('job', { instance: INSTANCE, ...run });
  if (sql) {
    try {
      await sql`insert into host_test_job_runs (instance) values (${INSTANCE})`;
    } catch (error) {
      log(`job could not record its run: ${error.message}`);
    }
  }
}, JOB_EVERY_MS);

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    log(`received ${signal} after ${Math.round(process.uptime())} s with ${io.engine.clientsCount} live connections — shutting down`);
    io.emit('bye', { instance: INSTANCE, signal, at: new Date().toISOString() });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}

if (sql) {
  try {
    await sql`create table if not exists host_test_job_runs (instance text not null, ran_at timestamptz not null default now())`;
  } catch (error) {
    log(`could not prepare the job table: ${error.message}`);
  }
}

server.listen(PORT, '0.0.0.0', () => log(`listening on 0.0.0.0:${PORT} — node ${process.version}, database ${sql ? 'linked' : 'not linked'}`));
