function required(name) {
  const value = process.env[name];
  if (!value) {
    process.stderr.write(`Mangler påkrevd miljøvariabel: ${name}\n`);
    process.exit(1);
  }
  return value;
}

export const config = {
  apiBase: process.env.HOMELY_API_BASE ?? 'https://sdk.iotiliti.cloud',
  username: required('HOMELY_USERNAME'),
  password: required('HOMELY_PASSWORD'),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_SECONDS ?? '120', 10) * 1000,
};
