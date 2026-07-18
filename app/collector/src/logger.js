const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const threshold = LEVELS[(process.env.LOG_LEVEL ?? 'info').toLowerCase()] ?? LEVELS.info;

function emit(level, msg, fields) {
  if (LEVELS[level] < threshold) return;
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + '\n'
  );
}

export const log = {
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
};
