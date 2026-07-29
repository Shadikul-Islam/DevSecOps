'use strict';

const { Pool } = require('pg');
const config = require('./config');
const logger = require('./logger');

const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  max: config.db.max,
});

pool.on('error', (err) => {
  logger.error({ err }, 'unexpected idle postgres client error');
});

// Lightweight readiness probe: run a trivial query to prove we can reach PG.
async function ping() {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
}

module.exports = { pool, ping };
