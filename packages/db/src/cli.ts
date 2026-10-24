import { migrate, seed, closeDb } from './index.ts';
try {
  await migrate();
  if (process.argv.includes('--seed')) await seed();
  console.log('Database migration completed (synthetic seed only when requested).');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Database operation failed.');
  process.exitCode = 1;
} finally { await closeDb(); }
