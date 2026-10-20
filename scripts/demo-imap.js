'use strict';
// Buzón IMAP de prueba (en memoria) con correos sintéticos, para probar la app sin tocar un correo real.
//   node scripts/demo-imap.js [puerto]   → usuario testuser / contraseña testpass, sin SSL
const hoodiecrow = require('hoodiecrow-imap');
const { msg } = require('../test/helpers/servers');
const { CASES } = require('../test/fixtures/emails');

const port = +(process.argv[2] || 1143);
const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const inbox = [];
let k = 0;
for (const c of CASES) {
  // lo promocional llega seguido; lo personal, de vez en cuando
  const copies = c.want === 'promo' ? 6 : c.want === 'duda' ? 3 : 2;
  for (let i = 0; i < copies; i++) {
    const unsub = c.bulk ? `<https://example.com/unsub/${k}>` : undefined;
    inbox.push(msg({ from: c.from, subject: c.subject, body: c.body, day: day((k * 7 + i * 11) % 75), unsub, unsubPost: unsub ? 'List-Unsubscribe=One-Click' : undefined }));
    k++;
  }
}
const server = hoodiecrow({
  plugins: ['SPECIAL-USE', 'MOVE', 'UIDPLUS', 'ENABLE', 'SASL-IR', 'AUTH-PLAIN'],
  storage: { INBOX: { messages: inbox }, '': { separator: '/', folders: { Papelera: { 'special-use': '\\Trash', messages: [] }, Enviados: { 'special-use': '\\Sent', messages: [] } } } },
});
server.listen(port, '127.0.0.1', () => console.log(`IMAP de prueba en 127.0.0.1:${port} · ${inbox.length} correos · testuser / testpass`));
