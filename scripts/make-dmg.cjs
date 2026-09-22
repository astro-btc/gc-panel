const { execFileSync } = require('child_process');
const { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } = require('fs');
const { tmpdir } = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const productName = pkg.build.productName;
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const appPath = path.join(root, 'release', `mac-${arch}`, `${productName}.app`);

if (!existsSync(appPath)) {
  console.error(`找不到应用：${appPath}`);
  process.exit(1);
}

const stage = mkdtempSync(path.join(tmpdir(), 'gate-crossex-dmg-'));
const dmgPath = path.join(root, 'release', `${productName}-${pkg.version}-${arch}.dmg`);

try {
  execFileSync('ditto', [appPath, path.join(stage, `${productName}.app`)]);
  symlinkSync('/Applications', path.join(stage, 'Applications'));
  execFileSync('hdiutil', [
    'create',
    '-volname', productName,
    '-srcfolder', stage,
    '-ov',
    '-format', 'UDZO',
    dmgPath,
  ], { stdio: 'inherit' });
  console.log(dmgPath);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
