'use strict';

/*
 * Build step for the ATML File Manager web app.
 *
 * This app ships browser-ready static files (vanilla JS + the vendored Nimble
 * bundle) and needs no transpile/bundle step, so "building" simply assembles a
 * clean copy of webapp/ into dist/app/. That folder is the Plugin Manager
 * buildDir (see nipkg.config.json) that `slcli webapp pack` packages.
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'webapp');
const outDir = path.join(root, 'dist', 'app');

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
fs.cpSync(srcDir, outDir, { recursive: true });

console.log(`Built web app: ${path.relative(root, srcDir)} -> ${path.relative(root, outDir)}`);
