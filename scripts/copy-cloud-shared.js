'use strict';
const fs = require('node:fs');
const path = require('node:path');
const target = path.join(__dirname, '../cloud/dist/shared');
fs.mkdirSync(target, { recursive: true });
fs.copyFileSync(path.join(__dirname, '../src/shared/extractZip.js'), path.join(target, 'extractZip.js'));
