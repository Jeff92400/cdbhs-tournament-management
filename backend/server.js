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
const settingsRoutes = require('./routes/settings');
const emailingRoutes = require('./routes/emailing');

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
app.use('/api/settings', settingsRoutes);
app.use('/api/emailing', emailingRoutes);

// Serve frontend pages
app.get('/', (req, res) => {
  res.sendFile(path.join(frontendPath, 'login.html'));
});

// Email scheduler - check and send scheduled emails every minute
async function processScheduledEmails() {
  const { Resend } = require('resend');
  const db = require('./db-loader');

  if (!process.env.RESEND_API_KEY) return;

  const resend = new Resend(process.env.RESEND_API_KEY);
  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  try {
    // Get emails that are due
    const scheduledEmails = await new Promise((resolve, reject) => {
      db.all(
        `SELECT * FROM scheduled_emails WHERE status = 'pending' AND scheduled_at <= CURRENT_TIMESTAMP`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    if (scheduledEmails.length === 0) return;

    console.log(`[Email Scheduler] Processing ${scheduledEmails.length} scheduled email(s)`);

    for (const scheduled of scheduledEmails) {
      const recipientIds = JSON.parse(scheduled.recipient_ids);

      // Get recipients
      const placeholders = recipientIds.map((_, i) => `$${i + 1}`).join(',');
      const recipients = await new Promise((resolve, reject) => {
        db.all(
          `SELECT * FROM player_contacts WHERE id IN (${placeholders})`,
          recipientIds,
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          }
        );
      });

      let sentCount = 0;

      for (const recipient of recipients) {
        if (!recipient.email || !recipient.email.includes('@')) continue;

        try {
          const emailBody = scheduled.body
            .replace(/\{player_name\}/g, `${recipient.first_name} ${recipient.last_name}`)
            .replace(/\{first_name\}/g, recipient.first_name || '')
            .replace(/\{last_name\}/g, recipient.last_name || '')
            .replace(/\{club\}/g, recipient.club || '');

          const emailSubject = scheduled.subject
            .replace(/\{player_name\}/g, `${recipient.first_name} ${recipient.last_name}`)
            .replace(/\{first_name\}/g, recipient.first_name || '')
            .replace(/\{last_name\}/g, recipient.last_name || '');

          await resend.emails.send({
            from: 'CDBHS <communication@cdbhs.net>',
            to: [recipient.email],
            subject: emailSubject,
            html: `<div style="font-family: Arial; max-width: 600px; margin: 0 auto;">
              <div style="background: #1F4788; color: white; padding: 20px; text-align: center;"><h1>CDBHS</h1></div>
              <div style="padding: 20px; background: #f8f9fa;">${emailBody.replace(/\n/g, '<br>')}</div>
              <div style="background: #1F4788; color: white; padding: 10px; text-align: center; font-size: 12px;">CDBHS - cdbhs92@gmail.com</div>
            </div>`
          });

          sentCount++;
          await delay(1500);
        } catch (error) {
          console.error(`[Email Scheduler] Error sending to ${recipient.email}:`, error.message);
        }
      }

      // Update scheduled email status
      await new Promise((resolve) => {
        db.run(
          `UPDATE scheduled_emails SET status = 'completed', sent_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [scheduled.id],
          () => resolve()
        );
      });

      console.log(`[Email Scheduler] Sent ${sentCount}/${recipientIds.length} emails for scheduled ID ${scheduled.id}`);
    }

  } catch (error) {
    console.error('[Email Scheduler] Error:', error.message);
  }
}

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

  // Start email scheduler (check every minute)
  setInterval(processScheduledEmails, 60000);
  console.log('[Email Scheduler] Started - checking for scheduled emails every minute');

  // Auto-sync contacts on startup (after a short delay to ensure DB is ready)
  setTimeout(async () => {
    try {
      const { syncContacts } = require('./routes/emailing');
      await syncContacts();
      console.log('[Contacts] Auto-sync completed on startup');
    } catch (error) {
      console.error('[Contacts] Auto-sync failed:', error.message);
    }
  }, 5000);
});

module.exports = app;
