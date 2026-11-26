const fs = require('fs');
const path = require('path');
const { packager } = require('@electron/packager');

async function main() {
  const rootDir = path.join(__dirname, '..');
  const iconPath = path.join(rootDir, 'icon.ico');

  const appPaths = await packager({
    dir: rootDir,
    name: 'Scyrox Hub',
    platform: 'win32',
    arch: 'x64',
    out: path.join(rootDir, 'dist'),
    overwrite: true,
    ignore: [/^\/dist($|\/)/],
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
  });

  console.log('Built:', appPaths.join(', '));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
