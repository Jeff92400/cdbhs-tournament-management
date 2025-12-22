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
const statisticsRoutes = require('./routes/statistics');

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
app.use('/api/statistics', statisticsRoutes);

// Serve frontend pages
app.get('/', (req, res) => {
  res.sendFile(path.join(frontendPath, 'login.html'));
});

// Helper to check if campaign was already sent manually
async function checkIfAlreadySentManually(db, emailType, mode, category, tournamentId) {
  return new Promise((resolve, reject) => {
    let query = `SELECT id FROM email_campaigns
                 WHERE campaign_type = $1
                   AND status IN ('completed', 'sending')
                   AND (test_mode = FALSE OR test_mode IS NULL)`;
    const params = [emailType];
    let paramIndex = 2;

    if (mode) {
      query += ` AND (mode = $${paramIndex++} OR mode IS NULL)`;
      params.push(mode);
    }
    if (category) {
      query += ` AND (category = $${paramIndex++} OR category IS NULL)`;
      params.push(category);
    }
    if (tournamentId) {
      query += ` AND tournament_id = $${paramIndex++}`;
      params.push(tournamentId);
    }

    query += ' LIMIT 1';

    db.get(query, params, (err, row) => {
      if (err) reject(err);
      else resolve(!!row);
    });
  });
}

// Process templated scheduled emails (relance, results, finale)
async function processTemplatedScheduledEmail(db, resend, scheduled, delay) {
  const emailType = scheduled.email_type;
  console.log(`[Email Scheduler] Processing templated email ${scheduled.id} (${emailType})`);

  let recipients = [];
  let templateVariables = {};

  // Fetch recipients based on email type
  if (emailType.startsWith('relance_')) {
    // Get all contacts for this mode/category
    recipients = await new Promise((resolve, reject) => {
      db.all(
        `SELECT * FROM player_contacts WHERE email IS NOT NULL AND email LIKE '%@%'`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    // Parse custom data for template
    const customData = scheduled.custom_data ? JSON.parse(scheduled.custom_data) : {};
    templateVariables = {
      category: `${scheduled.mode} ${scheduled.category}`,
      tournament_date: customData.tournament_date || '',
      tournament_lieu: customData.tournament_lieu || '',
      finale_date: customData.finale_date || '',
      finale_lieu: customData.finale_lieu || '',
      deadline_date: customData.deadline_date || ''
    };

  } else if (emailType === 'tournament_results' && scheduled.tournament_id) {
    // Get tournament participants
    const tournament = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM tournaments WHERE id = $1`, [scheduled.tournament_id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!tournament) throw new Error('Tournament not found');

    const results = await new Promise((resolve, reject) => {
      db.all(
        `SELECT tr.*, pc.email, pc.first_name, pc.last_name
         FROM tournament_results tr
         LEFT JOIN player_contacts pc ON REPLACE(tr.licence, ' ', '') = REPLACE(pc.licence, ' ', '')
         WHERE tr.tournament_id = $1`,
        [scheduled.tournament_id],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    recipients = results.filter(r => r.email && r.email.includes('@'));
    templateVariables = {
      tournament_name: tournament.display_name || tournament.name,
      tournament_date: tournament.tournament_date ? new Date(tournament.tournament_date).toLocaleDateString('fr-FR') : ''
    };

  } else if (emailType === 'finale_convocation' && scheduled.tournament_id) {
    // Get finale finalists - simplified version
    const finale = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM tournoi_ext WHERE tournoi_id = $1`, [scheduled.tournament_id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!finale) throw new Error('Finale not found');

    // Get contacts for this mode/category
    recipients = await new Promise((resolve, reject) => {
      db.all(
        `SELECT * FROM player_contacts WHERE email IS NOT NULL AND email LIKE '%@%'`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    templateVariables = {
      finale_date: finale.debut ? new Date(finale.debut).toLocaleDateString('fr-FR') : '',
      finale_lieu: finale.lieu || ''
    };
  }

  // Handle test mode - send only to test email
  const isTestMode = scheduled.test_mode === true || scheduled.test_mode === 1;
  if (isTestMode && scheduled.test_email) {
    console.log(`[Email Scheduler] TEST MODE - sending to ${scheduled.test_email} instead of ${recipients.length} recipients`);
    // Use a single fake recipient with test email
    recipients = [{
      email: scheduled.test_email,
      first_name: 'Test',
      last_name: 'User',
      club: 'Test Club'
    }];
  }

  if (recipients.length === 0) {
    console.log(`[Email Scheduler] No recipients for scheduled email ${scheduled.id}`);
    await new Promise((resolve) => {
      db.run(`UPDATE scheduled_emails SET status = 'completed', sent_at = CURRENT_TIMESTAMP WHERE id = $1`, [scheduled.id], () => resolve());
    });
    return;
  }

  console.log(`[Email Scheduler] Sending to ${recipients.length} recipients`);

  let sentCount = 0;
  let failedCount = 0;

  for (const recipient of recipients) {
    try {
      // Replace template variables
      let emailBody = (scheduled.body || '')
        .replace(/\{player_name\}/g, `${recipient.first_name || ''} ${recipient.last_name || ''}`.trim())
        .replace(/\{first_name\}/g, recipient.first_name || '')
        .replace(/\{last_name\}/g, recipient.last_name || '')
        .replace(/\{club\}/g, recipient.club || '')
        .replace(/\{category\}/g, templateVariables.category || '')
        .replace(/\{tournament_date\}/g, templateVariables.tournament_date || '')
        .replace(/\{tournament_lieu\}/g, templateVariables.tournament_lieu || '')
        .replace(/\{finale_date\}/g, templateVariables.finale_date || '')
        .replace(/\{finale_lieu\}/g, templateVariables.finale_lieu || '')
        .replace(/\{deadline_date\}/g, templateVariables.deadline_date || '');

      let emailSubject = (scheduled.subject || '')
        .replace(/\{category\}/g, templateVariables.category || '')
        .replace(/\{tournament_date\}/g, templateVariables.tournament_date || '');

      const outroText = scheduled.outro_text || '';
      const imageHtml = scheduled.image_url ? `<div style="text-align: center; margin: 20px 0;"><img src="${scheduled.image_url}" alt="Image" style="max-width: 100%; height: auto; border-radius: 8px;"></div>` : '';

      await resend.emails.send({
        from: 'CDBHS <communication@cdbhs.net>',
        replyTo: 'cdbhs92@gmail.com',
        to: [recipient.email],
        cc: scheduled.cc_email ? [scheduled.cc_email] : undefined,
        subject: emailSubject,
        html: `<div style="font-family: Arial; max-width: 600px; margin: 0 auto;">
          <div style="background: #1F4788; color: white; padding: 20px; text-align: center;">
            <img src="https://cdbhs-tournament-management-production.up.railway.app/images/billiard-icon.png" alt="CDBHS" style="height: 50px; margin-bottom: 10px;" onerror="this.style.display='none'">
            <h1 style="margin: 0; font-size: 24px;">Comité Départemental Billard Hauts-de-Seine</h1>
          </div>
          <div style="padding: 20px; background: #f8f9fa;">
            ${imageHtml}
            ${emailBody.replace(/\n/g, '<br>')}
            ${outroText ? `<br><br>${outroText.replace(/\n/g, '<br>')}` : ''}
          </div>
          <div style="background: #1F4788; color: white; padding: 10px; text-align: center; font-size: 12px;">CDBHS - cdbhs92@gmail.com</div>
        </div>`
      });

      sentCount++;
      await delay(1500);
    } catch (error) {
      console.error(`[Email Scheduler] Error sending to ${recipient.email}:`, error.message);
      failedCount++;
    }
  }

  // Update status
  await new Promise((resolve) => {
    db.run(`UPDATE scheduled_emails SET status = 'completed', sent_at = CURRENT_TIMESTAMP WHERE id = $1`, [scheduled.id], () => resolve());
  });

  // Create campaign record
  await new Promise((resolve) => {
    db.run(
      `INSERT INTO email_campaigns (subject, body, template_key, recipients_count, sent_count, failed_count, status, sent_at, campaign_type, mode, category, tournament_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'completed', CURRENT_TIMESTAMP, $7, $8, $9, $10)`,
      [scheduled.subject, scheduled.body, scheduled.template_key, recipients.length, sentCount, failedCount, scheduled.email_type, scheduled.mode, scheduled.category, scheduled.tournament_id],
      () => resolve()
    );
  });

  console.log(`[Email Scheduler] Completed ${scheduled.id}: ${sentCount} sent, ${failedCount} failed`);
}

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
      // Check if this email type was already sent manually (block if so)
      if (scheduled.email_type) {
        const alreadySent = await checkIfAlreadySentManually(
          db,
          scheduled.email_type,
          scheduled.mode,
          scheduled.category,
          scheduled.tournament_id
        );

        if (alreadySent) {
          // Block this scheduled email
          await new Promise((resolve) => {
            db.run(
              `UPDATE scheduled_emails SET status = 'blocked' WHERE id = $1`,
              [scheduled.id],
              () => resolve()
            );
          });
          console.log(`[Email Scheduler] Blocked scheduled email ${scheduled.id} (${scheduled.email_type}) - already manually sent`);
          continue;
        }
      }

      const recipientIds = JSON.parse(scheduled.recipient_ids || '[]');

      // For templated emails (relance, results, finale), recipients need to be fetched dynamically
      if (scheduled.email_type && recipientIds.length === 0) {
        try {
          await processTemplatedScheduledEmail(db, resend, scheduled, delay);
        } catch (error) {
          console.error(`[Email Scheduler] Error processing templated email ${scheduled.id}:`, error.message);
          await new Promise((resolve) => {
            db.run(`UPDATE scheduled_emails SET status = 'failed' WHERE id = $1`, [scheduled.id], () => resolve());
          });
        }
        continue;
      }

      // Get recipients for custom emails
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

          // Build optional image HTML
          const imageHtml = scheduled.image_url ? `<div style="text-align: center; margin: 20px 0;"><img src="${scheduled.image_url}" alt="Image" style="max-width: 100%; height: auto; border-radius: 8px;"></div>` : '';

          await resend.emails.send({
            from: 'CDBHS <communication@cdbhs.net>',
            to: [recipient.email],
            subject: emailSubject,
            html: `<div style="font-family: Arial; max-width: 600px; margin: 0 auto;">
              <div style="background: #1F4788; color: white; padding: 20px; text-align: center;">
                <img src="https://cdbhs-tournament-management-production.up.railway.app/images/billiard-icon.png" alt="CDBHS" style="height: 50px; margin-bottom: 10px;" onerror="this.style.display='none'">
                <h1 style="margin: 0; font-size: 24px;">Comite Departemental Billard Hauts-de-Seine</h1>
              </div>
              <div style="padding: 20px; background: #f8f9fa;">${imageHtml}${emailBody.replace(/\n/g, '<br>')}</div>
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

  // Start email scheduler (check every hour, process at configured hour)
  setInterval(async () => {
    const now = new Date();
    const currentHour = now.getHours();

    // Get configured hour from database (default: 6)
    let schedulerHour = 6;
    try {
      const setting = await new Promise((resolve) => {
        db.get(`SELECT value FROM app_settings WHERE key = 'email_scheduler_hour'`, [], (err, row) => {
          resolve(row);
        });
      });
      if (setting && setting.value) {
        schedulerHour = parseInt(setting.value, 10);
      }
    } catch (e) {
      console.error('[Email Scheduler] Error reading scheduler hour setting:', e.message);
    }

    if (currentHour === schedulerHour) {
      console.log(`[Email Scheduler] ${schedulerHour}h - processing scheduled emails`);
      processScheduledEmails();
    }
  }, 3600000); // Check every hour (3600000ms)
  console.log('[Email Scheduler] Started - checking for scheduled emails every hour');

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
