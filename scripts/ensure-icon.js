const fs = require('fs');
const path = require('path');

const ICON_URL = 'https://scyrox.net/logo.ico';
const ICON_PATH = path.join(__dirname, '..', 'icon.ico');

async function main() {
  if (fs.existsSync(ICON_PATH)) return;
  try {
    const res = await fetch(ICON_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(ICON_PATH, buf);
    console.log('Downloaded icon.ico');
  } catch (err) {
    console.warn(`Could not fetch icon.ico (${err.message}); continuing without custom icon.`);
  }
}

main();
