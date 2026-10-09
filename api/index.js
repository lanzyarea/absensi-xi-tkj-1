// Entry point untuk Vercel Serverless Functions.
// Vercel memanggil module ini, sedangkan server.js tetap bisa
// dijalankan lokal dengan `npm start`.
const app = require('../server.js');

module.exports = app;
