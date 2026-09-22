const { execFileSync } = require('child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('fs');
const { tmpdir } = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const config = {
  ...pkg.build,
  // 空字符串会跳过 package.json 里的 macOS Electron，改去下载 Windows 版。
  electronDist: '',
  win: {
    icon: 'build/icon.png',
    target: [{ target: 'nsis', arch: ['x64'] }],
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    artifactName: '${productName}-${version}-win-x64.${ext}',
  },
};

const dir = mkdtempSync(path.join(tmpdir(), 'astro-gc-win-'));
const configPath = path.join(dir, 'builder.json');
writeFileSync(configPath, JSON.stringify(config));

try {
  execFileSync(
    path.join(root, 'node_modules', '.bin', 'electron-builder'),
    ['--win', '--x64', '--publish', 'never', '--config', configPath],
    {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
    },
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
