#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, readlink, rm, stat, symlink, writeFile, chmod } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const RUNTIME_ROOT = join(REPO_ROOT, 'runtime', 'llama');
const RUNTIME_BIN_ROOT = join(RUNTIME_ROOT, 'bin');
const MANIFEST_PATH = join(RUNTIME_ROOT, 'runtime-manifest.json');
const CACHE_ROOT = join(REPO_ROOT, '.cache', 'llama-runtime');

const RELEASE_URL = 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest';

const TARGET_CONFIG = {
  'darwin-arm64': {
    binaryName: 'llama-server',
    assetPattern: /-bin-macos-arm64\.tar\.gz$/,
  },
  'darwin-x64': {
    binaryName: 'llama-server',
    assetPattern: /-bin-macos-x64\.tar\.gz$/,
  },
  'windows-x64': {
    binaryName: 'llama-server.exe',
    assetPattern: /-bin-win-cpu-x64\.zip$/,
  },
  'windows-arm64': {
    binaryName: 'llama-server.exe',
    assetPattern: /-bin-win-cpu-arm64\.zip$/,
  },
};

function parseArgs(argv) {
  const options = {
    refresh: false,
    strict: false,
    targets: null,
  };

  for (const arg of argv) {
    if (arg === '--refresh') {
      options.refresh = true;
      continue;
    }
    if (arg === '--strict') {
      options.strict = true;
      continue;
    }
    if (arg.startsWith('--targets=')) {
      const value = arg.slice('--targets='.length).trim();
      options.targets = value ? value.split(',').map((item) => item.trim()).filter(Boolean) : [];
    }
  }

  return options;
}

function resolveHostTarget() {
  if (process.platform === 'darwin') {
    return process.arch === 'x64' ? 'darwin-x64' : 'darwin-arm64';
  }
  if (process.platform === 'win32') {
    return process.arch === 'arm64' ? 'windows-arm64' : 'windows-x64';
  }
  return null;
}

function resolveTargets(options) {
  if (options.targets) {
    return options.targets;
  }

  if (process.platform === 'darwin' && process.env.CI) {
    return ['darwin-arm64', 'darwin-x64'];
  }

  const hostTarget = resolveHostTarget();
  return hostTarget ? [hostTarget] : [];
}

function shaFromDigest(digest) {
  if (!digest || typeof digest !== 'string') {
    return null;
  }
  const normalized = digest.trim().toLowerCase();
  if (!normalized.startsWith('sha256:')) {
    return null;
  }
  return normalized.slice('sha256:'.length);
}

async function fetchLatestRelease() {
  const response = await fetch(RELEASE_URL, {
    headers: {
      'User-Agent': 'TalkToFigmaDesktop',
      Accept: 'application/vnd.github+json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch latest llama.cpp release: HTTP ${response.status}`);
  }

  return await response.json();
}

async function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    return {
      source: {
        owner: 'ggml-org',
        repo: 'llama.cpp',
      },
      release: null,
      platforms: {},
    };
  }

  const raw = await readFile(MANIFEST_PATH, 'utf8');
  return JSON.parse(raw);
}

async function saveManifest(manifest) {
  await mkdir(dirname(MANIFEST_PATH), { recursive: true });
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function pickReleaseAsset(release, target) {
  const config = TARGET_CONFIG[target];
  if (!config) {
    return null;
  }
  const assets = Array.isArray(release.assets) ? release.assets : [];
  return assets.find((asset) => config.assetPattern.test(asset.name));
}

async function downloadAsset(url, destinationPath) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'TalkToFigmaDesktop',
      Accept: 'application/octet-stream',
    },
    redirect: 'follow',
  });

  if (!response.ok || !response.body) {
    throw new Error(`Failed to download runtime asset: HTTP ${response.status}`);
  }

  await mkdir(dirname(destinationPath), { recursive: true });
  const output = createWriteStream(destinationPath);
  await pipeline(response.body, output);
}

async function computeSha256(filePath) {
  const hash = createHash('sha256');
  const content = await readFile(filePath);
  hash.update(content);
  return hash.digest('hex');
}

function runCommand(command, args) {
  return spawnSync(command, args, {
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

function extractArchive(archivePath, destinationPath) {
  const tarResult = runCommand('tar', ['-xf', archivePath, '-C', destinationPath]);
  if (tarResult.status === 0) {
    return;
  }

  if (archivePath.endsWith('.zip')) {
    const unzipResult = runCommand('unzip', ['-o', archivePath, '-d', destinationPath]);
    if (unzipResult.status === 0) {
      return;
    }

    if (process.platform === 'win32') {
      const powershellResult = runCommand('powershell', [
        '-NoProfile',
        '-Command',
        `Expand-Archive -Path "${archivePath}" -DestinationPath "${destinationPath}" -Force`,
      ]);
      if (powershellResult.status === 0) {
        return;
      }
      throw new Error(powershellResult.stderr || powershellResult.stdout || 'Failed to extract zip archive');
    }
  }

  throw new Error(tarResult.stderr || tarResult.stdout || `Failed to extract archive: ${archivePath}`);
}

async function findBinary(filePath, binaryName) {
  const entries = await readdir(filePath, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = join(filePath, entry.name);
    if (entry.isDirectory()) {
      const nested = await findBinary(absolutePath, binaryName);
      if (nested) {
        return nested;
      }
      continue;
    }

    if (entry.isFile() && entry.name === binaryName) {
      return absolutePath;
    }
  }

  return null;
}

function ensureSupportedTargets(targets) {
  for (const target of targets) {
    if (!TARGET_CONFIG[target]) {
      throw new Error(`Unsupported target "${target}". Supported: ${Object.keys(TARGET_CONFIG).join(', ')}`);
    }
  }
}

function isRuntimeDependencyFileName(fileName) {
  const lower = fileName.toLowerCase();
  return lower.endsWith('.dylib') || lower.endsWith('.so') || lower.endsWith('.dll');
}

async function copyRuntimeDependencies(binarySource, outputDir) {
  const sourceDir = dirname(binarySource);
  const entries = await readdir(sourceDir, { withFileTypes: true });
  let copiedCount = 0;

  for (const entry of entries) {
    if (!isRuntimeDependencyFileName(entry.name)) {
      continue;
    }

    const sourcePath = join(sourceDir, entry.name);
    const destinationPath = join(outputDir, entry.name);
    await rm(destinationPath, { force: true });

    if (entry.isSymbolicLink()) {
      const linkTarget = await readlink(sourcePath);
      await symlink(linkTarget, destinationPath);
      copiedCount += 1;
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    await copyFile(sourcePath, destinationPath);
    copiedCount += 1;
  }

  return copiedCount;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const targets = resolveTargets(options);

  if (targets.length === 0) {
    throw new Error('No runtime targets were resolved for this environment.');
  }
  ensureSupportedTargets(targets);

  await mkdir(RUNTIME_BIN_ROOT, { recursive: true });
  await mkdir(CACHE_ROOT, { recursive: true });

  const manifest = await loadManifest();
  const shouldRefresh = options.refresh || !manifest.release;

  if (shouldRefresh) {
    const release = await fetchLatestRelease();
    manifest.release = {
      tag: release.tag_name,
      name: release.name || release.tag_name,
      publishedAt: release.published_at || null,
      url: release.html_url || null,
    };
    manifest.platforms = manifest.platforms || {};

    for (const target of Object.keys(TARGET_CONFIG)) {
      const asset = pickReleaseAsset(release, target);
      if (!asset) {
        continue;
      }

      const existing = manifest.platforms[target] || {};
      const assetSha256 = shaFromDigest(asset.digest);
      manifest.platforms[target] = {
        ...existing,
        assetName: asset.name,
        assetUrl: asset.browser_download_url,
        assetSha256,
        lastResolvedAt: new Date().toISOString(),
      };
    }
    manifest.updatedAt = new Date().toISOString();
    await saveManifest(manifest);
  }

  for (const target of targets) {
    const platformEntry = manifest.platforms?.[target];
    if (!platformEntry?.assetUrl || !platformEntry?.assetName) {
      throw new Error(`Runtime asset metadata is missing for target "${target}". Run with --refresh.`);
    }

    const assetCachePath = join(CACHE_ROOT, manifest.release.tag, platformEntry.assetName);
    const assetExists = existsSync(assetCachePath);
    if (!assetExists || options.refresh) {
      console.log(`[prepare-llama-runtime] downloading ${target}: ${platformEntry.assetName}`);
      await downloadAsset(platformEntry.assetUrl, assetCachePath);
    }

    if (platformEntry.assetSha256) {
      const downloadedSha = await computeSha256(assetCachePath);
      if (downloadedSha !== platformEntry.assetSha256) {
        throw new Error(`SHA256 mismatch for ${platformEntry.assetName}. expected=${platformEntry.assetSha256}, actual=${downloadedSha}`);
      }
    } else if (options.strict) {
      throw new Error(`Missing pinned asset SHA256 for target "${target}"`);
    }

    const extractPath = join(CACHE_ROOT, 'extract', target);
    await rm(extractPath, { recursive: true, force: true });
    await mkdir(extractPath, { recursive: true });
    extractArchive(assetCachePath, extractPath);

    const config = TARGET_CONFIG[target];
    const binarySource = await findBinary(extractPath, config.binaryName);
    if (!binarySource) {
      throw new Error(`Could not locate ${config.binaryName} inside ${platformEntry.assetName}`);
    }

    const outputDir = join(RUNTIME_BIN_ROOT, target);
    await mkdir(outputDir, { recursive: true });
    const binaryDestination = join(outputDir, config.binaryName);
    await copyFile(binarySource, binaryDestination);
    if (process.platform !== 'win32') {
      await chmod(binaryDestination, 0o755);
    }
    const dependencyCount = await copyRuntimeDependencies(binarySource, outputDir);

    const binarySha = await computeSha256(binaryDestination);
    manifest.platforms[target] = {
      ...manifest.platforms[target],
      binaryRelativePath: relative(RUNTIME_ROOT, binaryDestination).replace(/\\/g, '/'),
      binarySha256: binarySha,
      runtimeDependencyCount: dependencyCount,
      preparedAt: new Date().toISOString(),
    };

    const size = (await stat(binaryDestination)).size;
    console.log(`[prepare-llama-runtime] prepared ${target}: ${binaryDestination} (${size} bytes, deps=${dependencyCount})`);
  }

  manifest.updatedAt = new Date().toISOString();
  await saveManifest(manifest);
}

main().catch((error) => {
  console.error('[prepare-llama-runtime] failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
