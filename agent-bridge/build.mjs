import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });

if (process.platform === 'darwin') {
  execFileSync('swiftc', [
    '-O',
    '-framework', 'AppKit',
    '-framework', 'ApplicationServices',
    '-framework', 'CoreGraphics',
    '-framework', 'AVFoundation',
    '-framework', 'AudioToolbox',
    '-framework', 'Vision',
    'native/macos-helper/main.swift',
    '-o', 'dist/macos-helper',
  ], { stdio: 'inherit' });
}

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: true,
  external: ['electron', 'serialport'],
});

await build({
  entryPoints: ['src/preload.ts'],
  outfile: 'dist/preload.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: true,
  external: ['electron'],
});

await build({
  entryPoints: ['src/renderer.ts'],
  outfile: 'dist/renderer.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  sourcemap: true,
});

await cp('src/renderer/index.html', 'dist/index.html');
await cp('src/renderer/styles.css', 'dist/styles.css');
