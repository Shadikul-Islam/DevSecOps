'use strict';

const crypto = require('crypto');
const express = require('express');
const pinoHttp = require('pino-http');

const logger = require('./logger');
const { pool, ping } = require('./db');
const { register, metricsMiddleware } = require('./metrics');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(
    pinoHttp({
      logger,
      genReqId(req, res) {
        const existing = req.headers['x-request-id'];
        const id = existing || crypto.randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
    })
  );

  app.use(metricsMiddleware);

  // --- Liveness: process is up. No dependency checks. ---
  app.get('/healthz', (req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // --- Readiness: only ready if we can reach Postgres. ---
  app.get('/readyz', async (req, res) => {
    try {
      await ping();
      res.status(200).json({ status: 'ready' });
    } catch (err) {
      req.log.warn({ err }, 'readiness check failed');
      res.status(503).json({ status: 'not_ready' });
    }
  });

  // --- Prometheus metrics ---
  app.get('/metrics', async (req, res) => {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  });

  // --- Create a record ---
  app.post('/records', async (req, res) => {
    const { email } = req.body || {};
    if (typeof email !== 'string' || email.trim() === '') {
      return res.status(400).json({ error: 'email is required and must be a non-empty string' });
    }
    try {
      const result = await pool.query(
        `INSERT INTO records (email, status)
         VALUES ($1, 'pending')
         RETURNING id, email, status, created_at, updated_at`,
        [email]
      );
      return res.status(201).json(result.rows[0]);
    } catch (err) {
      req.log.error({ err }, 'failed to insert record');
      return res.status(500).json({ error: 'internal error' });
    }
  });

  // --- Fetch a record by id ---
  app.get('/records/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'id must be a positive integer' });
    }
    try {
      const result = await pool.query(
        `SELECT id, email, status, created_at, updated_at
         FROM records WHERE id = $1`,
        [id]
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'record not found' });
      }
      return res.status(200).json(result.rows[0]);
    } catch (err) {
      req.log.error({ err }, 'failed to fetch record');
      return res.status(500).json({ error: 'internal error' });
    }
  });

  return app;
}

module.exports = { createApp };
