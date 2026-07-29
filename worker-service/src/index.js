'use strict';

const http = require('http');

const config = require('./config');
const logger = require('./logger');
const { pool, ping } = require('./db');
const { register } = require('./metrics');
const { startLoop } = require('./worker');

// Minimal internal HTTP server: health, readiness and metrics only. The worker
// exposes no business API — this exists purely for probes and scraping.
const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET') {
    res.writeHead(405).end();
    return;
  }

  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (req.url === '/readyz') {
    try {
      await ping();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ready' }));
    } catch (err) {
      logger.warn({ err }, 'readiness check failed');
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'not_ready' }));
    }
    return;
  }

  if (req.url === '/metrics') {
    res.writeHead(200, { 'Content-Type': register.contentType });
    res.end(await register.metrics());
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(config.port, () => {
  logger.info({ port: config.port }, 'worker-service health/metrics server listening');
});

const stopLoop = startLoop();
logger.info(
  { pollIntervalMs: config.pollIntervalMs, batchSize: config.batchSize },
  'worker poll loop started'
);

async function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  stopLoop();
  server.close(async () => {
    try {
      await pool.end();
    } catch (err) {
      logger.error({ err }, 'error closing postgres pool');
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
