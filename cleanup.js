const { execSync } = require('child_process');
const depcheck = require('depcheck');

const options = {
  ignorePatterns: ['webpack.config.js'],
};

depcheck(process.cwd(), options, (unused) => {
  const all = [...unused.dependencies, ...unused.devDependencies];
  if (all.length === 0) {
    console.log('✅ No unused packages found.');
    return;
  }

  console.log('🧹 Removing unused packages:\n', all.join(' '));
  try {
    execSync(`npm uninstall ${all.join(' ')}`, { stdio: 'inherit' });
    console.log('✅ Uninstall complete.');
  } catch (err) {
    console.error('❌ Failed to uninstall some packages.');
  }
});
