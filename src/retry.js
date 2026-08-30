'use strict';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an async operation with exponential backoff.
 *
 * @param {() => Promise<T>} fn               operation to attempt
 * @param {object}           opts
 * @param {number}           opts.retries     max attempts (including the first)
 * @param {number}           opts.baseDelayMs initial delay before second attempt
 * @param {number}           opts.maxDelayMs  upper bound on backoff
 * @param {(err:any)=>boolean} opts.shouldRetry  predicate; default: retry all
 * @param {(err:any, attempt:number, delay:number)=>void} opts.onRetry
 */
async function retry(fn, opts = {}) {
  const {
    retries = 3,
    baseDelayMs = 500,
    maxDelayMs = 8000,
    shouldRetry = () => true,
    onRetry = () => {},
  } = opts;

  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= retries || !shouldRetry(err)) throw err;
      const jitter = Math.floor(Math.random() * 200);
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)) + jitter;
      onRetry(err, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastErr;
}

module.exports = { retry, sleep };
