'use strict';

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  logLevel: process.env.LOG_LEVEL || 'info',
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'app',
    password: process.env.DB_PASSWORD || 'app',
    database: process.env.DB_NAME || 'records',
    max: parseInt(process.env.DB_POOL_MAX || '10', 10),
  },
};

module.exports = config;
