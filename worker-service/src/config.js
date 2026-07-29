'use strict';

// Centralised env-var parsing. Never hardcode credentials.
const config = {
  // Small internal HTTP server for health/metrics only — no business API here.
  port: parseInt(process.env.PORT || '3001', 10),
  logLevel: process.env.LOG_LEVEL || 'info',
  // Poll cadence and batch size for the processing loop.
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '5000', 10),
  batchSize: parseInt(process.env.BATCH_SIZE || '10', 10),
  workSimulationMs: parseInt(process.env.WORK_SIMULATION_MS || '2000', 10),
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'app',
    password: process.env.DB_PASSWORD || 'app',
    database: process.env.DB_NAME || 'records',
    max: parseInt(process.env.DB_POOL_MAX || '5', 10),
  },
};

module.exports = config;
