const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// Ensure database directory exists for SQLite (when running locally)
if (!process.env.DATABASE_URL) {
  const dbDir = path.join(__dirname, '../database');
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
}

// Use database loader - automatically selects PostgreSQL or SQLite
const db = require('./db-loader');

const authRoutes = require('./routes/auth');
const playersRoutes = require('./routes/players');
const tournamentsRoutes = require('./routes/tournaments');
const rankingsRoutes = require('./routes/rankings');
const calendarRoutes = require('./routes/calendar');
const clubsRoutes = require('./routes/clubs');
const backupRoutes = require('./routes/backup');
const inscriptionsRoutes = require('./routes/inscriptions');
const emailRoutes = require('./routes/email');

const app = express();
const PORT = process.env.PORT || 3000;

console.log('Railway deployment - using PORT:', PORT);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files
// Check if frontend folder exists in current directory (Railway) or parent directory (local)
const frontendPath = fs.existsSync(path.join(__dirname, 'frontend'))
  ? path.join(__dirname, 'frontend')
  : path.join(__dirname, '../frontend');
app.use(express.static(frontendPath));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/players', playersRoutes);
app.use('/api/tournaments', tournamentsRoutes);
app.use('/api/rankings', rankingsRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/clubs', clubsRoutes);
app.use('/api/backup', backupRoutes);
app.use('/api/inscriptions', inscriptionsRoutes);
app.use('/api/email', emailRoutes);

// Serve frontend pages
app.get('/', (req, res) => {
  res.sendFile(path.join(frontendPath, 'login.html'));
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  const os = require('os');
  const networkInterfaces = os.networkInterfaces();
  let localIP = 'localhost';

  // Find the local network IP
  for (const interfaceName in networkInterfaces) {
    for (const iface of networkInterfaces[interfaceName]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        localIP = iface.address;
        break;
      }
    }
  }

  console.log(`
╔════════════════════════════════════════════╗
║  French Billiard Ranking System           ║
║  Server running on:                       ║
║  - Local: http://localhost:${PORT}            ║
║  - Network: http://${localIP}:${PORT}${' '.repeat(Math.max(0, 10 - localIP.length))} ║
╚════════════════════════════════════════════╝
  `);
});

module.exports = app;
