'use strict';

const { pool } = require('./db');
const logger = require('./logger');
const config = require('./config');
const { recordsProcessedTotal, pollDurationSeconds } = require('./metrics');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function processRecord(record) {
  logger.info({ recordId: record.id }, 'processing record');
  await sleep(config.workSimulationMs);
}

async function pollOnce() {
  const endTimer = pollDurationSeconds.startTimer();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT id, email, status
       FROM records
       WHERE status = 'pending'
       ORDER BY id
       FOR UPDATE SKIP LOCKED
       LIMIT $1`,
      [config.batchSize]
    );

    for (const record of rows) {
      try {
        await processRecord(record);
        await client.query(
          `UPDATE records SET status = 'done', updated_at = now() WHERE id = $1`,
          [record.id]
        );
        recordsProcessedTotal.inc({ result: 'done' });
      } catch (err) {
        // A single record failing must not crash the loop or abort the batch.
        logger.error({ err, recordId: record.id }, 'record processing failed');
        await client.query(
          `UPDATE records SET status = 'failed', updated_at = now() WHERE id = $1`,
          [record.id]
        );
        recordsProcessedTotal.inc({ result: 'failed' });
      }
    }

    await client.query('COMMIT');
    return rows.length;
  } catch (err) {
    logger.error({ err }, 'poll cycle failed, rolling back');
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr }, 'rollback failed');
    }
    return 0;
  } finally {
    client.release();
    endTimer();
  }
}

function startLoop() {
  let stopped = false;

  async function tick() {
    if (stopped) return;
    try {
      const n = await pollOnce();
      if (n > 0) logger.info({ processed: n }, 'poll cycle complete');
    } catch (err) {
      logger.error({ err }, 'unexpected error in poll loop');
    }
    if (!stopped) setTimeout(tick, config.pollIntervalMs);
  }

  tick();

  return function stop() {
    stopped = true;
  };
}

module.exports = { startLoop, pollOnce };
