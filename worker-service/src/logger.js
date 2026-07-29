'use strict';

const pino = require('pino');
const config = require('./config');

// Structured JSON logging to stdout — same setup as api-service.
const logger = pino({
  level: config.logLevel,
  base: { service: 'worker-service' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

module.exports = logger;
