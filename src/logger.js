'use strict';

function ts() {
  return new Date().toISOString();
}

function emit(level, msg, meta) {
  const line = { ts: ts(), level, msg };
  if (meta && typeof meta === 'object') Object.assign(line, meta);
  const text = JSON.stringify(line);
  if (level === 'error' || level === 'warn') {
    process.stderr.write(text + '\n');
  } else {
    process.stdout.write(text + '\n');
  }
}

module.exports = {
  info: (msg, meta) => emit('info', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  error: (msg, meta) => emit('error', msg, meta),
  debug: (msg, meta) => {
    if (process.env.LOG_LEVEL === 'debug') emit('debug', msg, meta);
  },
};
