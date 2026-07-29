'use strict';

const client = require('prom-client');

const register = new client.Registry();
register.setDefaultLabels({ service: 'worker-service' });

// Default Node.js process/runtime metrics.
client.collectDefaultMetrics({ register });

// Records processed, labelled by terminal status (done | failed).
const recordsProcessedTotal = new client.Counter({
  name: 'worker_records_processed_total',
  help: 'Total records the worker has finished processing',
  labelNames: ['result'],
  registers: [register],
});

const pollDurationSeconds = new client.Histogram({
  name: 'worker_poll_duration_seconds',
  help: 'Duration of a single poll+process batch in seconds',
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

module.exports = { register, recordsProcessedTotal, pollDurationSeconds };
