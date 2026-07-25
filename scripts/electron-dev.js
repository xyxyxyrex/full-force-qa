// Clears ELECTRON_RUN_AS_NODE (inherited from parent Electron shells like VS Code)
// then runs the given command.
delete process.env.ELECTRON_RUN_AS_NODE;
const { execSync } = require('child_process');
execSync(process.argv.slice(2).join(' '), { stdio: 'inherit' });
