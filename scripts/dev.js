'use strict';
// Servidor de desarrollo con su propia carpeta de datos y puerto:
//   node scripts/dev.js <carpeta-de-datos> [puerto]
process.env.NONIMAIL_DATA_DIR = require('path').resolve(process.argv[2] || 'dev-data');
require('fs').mkdirSync(process.env.NONIMAIL_DATA_DIR, { recursive: true });
require('../server').start({ port: +(process.argv[3] || 8790) });
