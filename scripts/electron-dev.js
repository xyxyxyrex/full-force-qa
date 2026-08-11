// Load the repository-local environment before electron-vite starts in dev so
// both the renderer and Electron main process inherit the current credentials.
// Values already present in the parent shell are intentionally overridden by
// .env for a predictable `npm run dev` experience. Build/release commands keep
// their existing CI environment behavior.
if (process.argv.slice(2).includes('dev')) {
  const path = require('path');
  const dotenv = require('dotenv');
  const envPath = path.resolve(__dirname, '..', '.env');
  const envResult = dotenv.config({ path: envPath, override: true, quiet: true });

  if (envResult.error) {
    console.warn(`[Parity] Local .env was not loaded: ${envResult.error.message}`);
  } else {
    console.log('[Parity] Loaded current local .env for development.');
  }
}

// Clears ELECTRON_RUN_AS_NODE (inherited from parent Electron shells like VS Code)
// then runs the given command.
delete process.env.ELECTRON_RUN_AS_NODE;
const { execSync } = require('child_process');
execSync(process.argv.slice(2).join(' '), { stdio: 'inherit' });
