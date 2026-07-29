'use strict';

const config = require('./config');
const logger = require('./logger');
const { pool } = require('./db');
const { createApp } = require('./app');

const app = createApp();
const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, 'api-service listening');
});

// Graceful shutdown so in-flight requests drain and the PG pool closes cleanly.
async function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  server.close(async () => {
    try {
      await pool.end();
    } catch (err) {
      logger.error({ err }, 'error closing postgres pool');
    }
    process.exit(0);
  });
  // Failsafe: don't hang forever if connections won't close.
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
