const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db-loader');
const appSettings = require('../utils/app-settings');
const { logAdminAction, ACTION_TYPES } = require('../utils/admin-logger');

const router = express.Router();

// Enforce JWT_SECRET from environment - NO fallback allowed
if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is required');
  console.error('Set JWT_SECRET in your environment before starting the server.');
  console.error('Generate a secure secret with: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET;

const RESET_CODE_EXPIRY_MINUTES = 10;

// Generate 6-digit reset code
function generateResetCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Store reset code in database
function storeResetCode(email, code) {
  return new Promise((resolve, reject) => {
    const normalizedEmail = email.toLowerCase();
    // First, invalidate any existing codes for this email
    db.run(
      'UPDATE password_reset_codes SET used = $1 WHERE email = $2 AND used = $3',
      [true, normalizedEmail, false],
      (err) => {
        if (err) {
          console.error('Error invalidating old reset codes:', err);
        }
        // Insert new code
        db.run(
          'INSERT INTO password_reset_codes (email, code) VALUES ($1, $2)',
          [normalizedEmail, code],
          (err) => {
            if (err) {
              console.error('Error storing reset code:', err);
              reject(err);
            } else {
              resolve();
            }
          }
        );
      }
    );
  });
}

// Verify reset code from database
function verifyResetCode(email, code) {
  return new Promise((resolve, reject) => {
    const normalizedEmail = email.toLowerCase();
    db.get(
      `SELECT * FROM password_reset_codes
       WHERE email = $1 AND code = $2 AND used = $3
       ORDER BY created_at DESC LIMIT 1`,
      [normalizedEmail, code, false],
      (err, row) => {
        if (err) {
          console.error('Error verifying reset code:', err);
          reject(err);
          return;
        }

        if (!row) {
          resolve({ valid: false, error: 'Code invalide ou expire' });
          return;
        }

        // Check if code is expired (10 minutes)
        const createdAt = new Date(row.created_at).getTime();
        const now = Date.now();
        if (now - createdAt > RESET_CODE_EXPIRY_MINUTES * 60 * 1000) {
          // Mark as used (expired)
          db.run('UPDATE password_reset_codes SET used = $1 WHERE id = $2', [true, row.id], () => {});
          resolve({ valid: false, error: 'Code expire' });
          return;
        }

        // Mark code as used
        db.run('UPDATE password_reset_codes SET used = $1 WHERE id = $2', [true, row.id], (err) => {
          if (err) {
            console.error('Error marking reset code as used:', err);
          }
          resolve({ valid: true });
        });
      }
    );
  });
}

// Cleanup expired reset codes (run periodically)
function cleanupExpiredResetCodes() {
  const expiryTime = new Date(Date.now() - RESET_CODE_EXPIRY_MINUTES * 60 * 1000).toISOString();
  db.run(
    'DELETE FROM password_reset_codes WHERE created_at < $1 OR used = $2',
    [expiryTime, true],
    (err) => {
      if (err) {
        console.error('Error cleaning up expired reset codes:', err);
      }
    }
  );
}

// Run cleanup every hour
setInterval(cleanupExpiredResetCodes, 60 * 60 * 1000);

// Login with username and password
router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Nom d\'utilisateur et mot de passe requis' });
  }

  db.get('SELECT * FROM users WHERE username = $1 AND is_active = 1', [username], (err, user) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Erreur de base de données' });
    }

    if (!user) {
      // Log failed login attempt (user not found)
      logAdminAction({
        req: { ...req, user: { username: username } },
        action: ACTION_TYPES.LOGIN_FAILED,
        details: 'Utilisateur non trouvé'
      });
      return res.status(401).json({ error: 'Nom d\'utilisateur ou mot de passe incorrect' });
    }

    bcrypt.compare(password, user.password_hash, (err, result) => {
      if (err || !result) {
        // Log failed login attempt (wrong password)
        logAdminAction({
          req: { ...req, user: { userId: user.id, username: user.username, role: user.role } },
          action: ACTION_TYPES.LOGIN_FAILED,
          details: 'Mot de passe incorrect'
        });
        return res.status(401).json({ error: 'Nom d\'utilisateur ou mot de passe incorrect' });
      }

      // Update last login
      db.run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [user.id], () => {});

      const token = jwt.sign(
        {
          userId: user.id,
          username: user.username,
          role: user.role
        },
        JWT_SECRET,
        { expiresIn: '24h' }
      );

      // Log successful login
      logAdminAction({
        req: { ...req, user: { userId: user.id, username: user.username, role: user.role } },
        action: ACTION_TYPES.LOGIN_SUCCESS,
        details: `Connexion réussie pour ${user.username}`
      });

      res.json({
        token,
        message: 'Connexion réussie',
        user: {
          id: user.id,
          username: user.username,
          role: user.role
        }
      });
    });
  });
});

// Get current user info
router.get('/me', authenticateToken, (req, res) => {
  db.get('SELECT id, username, email, role, receive_tournament_alerts FROM users WHERE id = $1', [req.user.userId], (err, user) => {
    if (err || !user) {
      return res.json({
        userId: req.user.userId,
        username: req.user.username,
        role: req.user.role
      });
    }
    res.json({
      userId: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      receive_tournament_alerts: user.receive_tournament_alerts || false
    });
  });
});

// Update current user settings (email, alerts)
router.put('/me/settings', authenticateToken, (req, res) => {
  const { email, receive_tournament_alerts } = req.body;

  const updates = [];
  const params = [];
  let paramIndex = 1;

  if (email !== undefined) {
    updates.push(`email = $${paramIndex++}`);
    params.push(email ? email.toLowerCase().trim() : null);
  }

  if (typeof receive_tournament_alerts === 'boolean') {
    updates.push(`receive_tournament_alerts = $${paramIndex++}`);
    params.push(receive_tournament_alerts);
  }

  if (updates.length === 0) {
    return res.json({ message: 'No changes made' });
  }

  params.push(req.user.userId);

  db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIndex}`, params, (err) => {
    if (err) {
      return res.status(500).json({ error: 'Error updating settings' });
    }
    res.json({ message: 'Settings updated successfully' });
  });
});

// Change password (for current logged-in user)
router.post('/change-password', authenticateToken, (req, res) => {
  const { oldPassword, newPassword } = req.body;

  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: 'Mot de passe actuel et nouveau mot de passe requis' });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir au moins 6 caractères' });
  }

  if (!req.user.userId) {
    return res.status(400).json({ error: 'Session invalide, veuillez vous reconnecter' });
  }

  db.get('SELECT * FROM users WHERE id = $1', [req.user.userId], (err, user) => {
    if (err || !user) {
      return res.status(500).json({ error: 'Utilisateur non trouvé' });
    }

    bcrypt.compare(oldPassword, user.password_hash, (err, result) => {
      if (err || !result) {
        return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
      }

      bcrypt.hash(newPassword, 10, (err, hash) => {
        if (err) {
          return res.status(500).json({ error: 'Erreur lors du changement de mot de passe' });
        }

        db.run('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, user.id], (err) => {
          if (err) {
            return res.status(500).json({ error: 'Erreur lors de la mise à jour' });
          }

          // Log password change
          logAdminAction({
            req,
            action: ACTION_TYPES.PASSWORD_CHANGED,
            details: 'Mot de passe modifié par l\'utilisateur',
            targetType: 'user',
            targetId: user.id,
            targetName: user.username
          });

          res.json({ message: 'Mot de passe changé avec succès' });
        });
      });
    });
  });
});

// ==================== SELF-SERVICE PASSWORD RESET ====================

// Forgot password - send reset email
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email requis' });
  }

  // Find user by email
  db.get('SELECT * FROM users WHERE email = $1 AND is_active = 1', [email.toLowerCase().trim()], async (err, user) => {
    // Always return success to prevent email enumeration
    if (err || !user) {
      return res.json({ message: 'Si un compte existe avec cette adresse email, vous recevrez un lien de réinitialisation.' });
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenExpiry = new Date(Date.now() + 3600000); // 1 hour

    // Save token to user
    db.run(
      'UPDATE users SET reset_token = $1, reset_token_expiry = $2 WHERE id = $3',
      [resetToken, resetTokenExpiry.toISOString(), user.id],
      async (err) => {
        if (err) {
          console.error('Error saving reset token:', err);
          return res.json({ message: 'Si un compte existe avec cette adresse email, vous recevrez un lien de réinitialisation.' });
        }

        // Send email with reset link
        try {
          const { Resend } = require('resend');
          const resend = new Resend(process.env.RESEND_API_KEY);

          // Get dynamic settings for email branding
          const emailSettings = await appSettings.getSettingsBatch([
            'primary_color', 'email_convocations', 'email_sender_name',
            'organization_name', 'organization_short_name'
          ]);
          const primaryColor = emailSettings.primary_color || '#1F4788';
          const senderEmail = emailSettings.email_convocations || 'convocations@cdbhs.net';
          const senderName = emailSettings.email_sender_name || 'CDBHS';
          const orgName = emailSettings.organization_name || 'Comité Départemental de Billard des Hauts-de-Seine';
          const orgShortName = emailSettings.organization_short_name || 'CDBHS';

          const baseUrl = process.env.BASE_URL || 'https://cdbhs-tournament-management-production.up.railway.app';
          const resetLink = `${baseUrl}/reset-password.html?token=${resetToken}`;

          await resend.emails.send({
            from: `${senderName} <${senderEmail}>`,
            to: user.email,
            subject: `Réinitialisation de votre mot de passe ${orgShortName}`,
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                <h2 style="color: ${primaryColor};">Réinitialisation de mot de passe</h2>
                <p>Bonjour ${user.username},</p>
                <p>Vous avez demandé la réinitialisation de votre mot de passe ${orgShortName}.</p>
                <p>Cliquez sur le bouton ci-dessous pour définir un nouveau mot de passe :</p>
                <p style="text-align: center; margin: 30px 0;">
                  <a href="${resetLink}" style="background: ${primaryColor}; color: white; padding: 15px 30px; text-decoration: none; border-radius: 6px; display: inline-block;">
                    Réinitialiser mon mot de passe
                  </a>
                </p>
                <p style="color: #666; font-size: 14px;">Ce lien expire dans 1 heure.</p>
                <p style="color: #666; font-size: 14px;">Si vous n'avez pas demandé cette réinitialisation, ignorez cet email.</p>
                <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">
                <p style="color: #999; font-size: 12px;">${orgShortName} - ${orgName}</p>
              </div>
            `
          });

          console.log(`Password reset email sent to ${user.email}`);
        } catch (emailErr) {
          console.error('Error sending reset email:', emailErr);
        }

        res.json({ message: 'Si un compte existe avec cette adresse email, vous recevrez un lien de réinitialisation.' });
      }
    );
  });
});

// Reset password with token
router.post('/reset-password-token', (req, res) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    return res.status(400).json({ error: 'Token et nouveau mot de passe requis' });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères' });
  }

  // Find user with valid token
  db.get(
    'SELECT * FROM users WHERE reset_token = $1 AND reset_token_expiry > $2',
    [token, new Date().toISOString()],
    (err, user) => {
      if (err || !user) {
        return res.status(400).json({ error: 'Lien invalide ou expiré' });
      }

      bcrypt.hash(newPassword, 10, (err, hash) => {
        if (err) {
          return res.status(500).json({ error: 'Erreur lors du changement de mot de passe' });
        }

        // Update password and clear reset token
        db.run(
          'UPDATE users SET password_hash = $1, reset_token = NULL, reset_token_expiry = NULL WHERE id = $2',
          [hash, user.id],
          (err) => {
            if (err) {
              return res.status(500).json({ error: 'Erreur lors de la mise à jour' });
            }

            res.json({ message: 'Mot de passe réinitialisé avec succès' });
          }
        );
      });
    }
  );
});

// ==================== 6-DIGIT CODE PASSWORD RESET ====================

// Forgot password - send 6-digit code via email
router.post('/forgot', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email requis' });
  }

  const normalizedEmail = email.toLowerCase().trim();

  // Always return same response to prevent email enumeration
  const standardResponse = {
    success: true,
    message: 'Si un compte existe avec cette adresse, un code de reinitialisation a ete envoye'
  };

  // Find user by email
  db.get('SELECT * FROM users WHERE email = $1 AND is_active = 1', [normalizedEmail], async (err, user) => {
    if (err || !user) {
      return res.json(standardResponse);
    }

    // Generate 6-digit reset code
    const code = generateResetCode();
    try {
      await storeResetCode(normalizedEmail, code);
    } catch (storeErr) {
      console.error('Error storing reset code:', storeErr);
      return res.json(standardResponse);
    }

    console.log(`Password reset code generated for ${normalizedEmail}`);

    // Send email with code
    try {
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);

      // Get dynamic settings for email branding
      const emailSettings = await appSettings.getSettingsBatch([
        'primary_color', 'email_noreply', 'email_sender_name',
        'organization_name', 'organization_short_name', 'summary_email'
      ]);
      const primaryColor = emailSettings.primary_color || '#1F4788';
      const senderEmail = emailSettings.email_noreply || 'noreply@cdbhs.net';
      const senderName = emailSettings.email_sender_name || 'CDBHS';
      const orgName = emailSettings.organization_name || 'Comite Departemental de Billard des Hauts-de-Seine';
      const orgShortName = emailSettings.organization_short_name || 'CDBHS';
      const replyToEmail = emailSettings.summary_email || 'cdbhs92@gmail.com';

      if (resend) {
        await resend.emails.send({
          from: `${senderName} <${senderEmail}>`,
          replyTo: replyToEmail,
          to: [normalizedEmail],
          subject: `${orgShortName} - Code de reinitialisation`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;">
              <div style="background: ${primaryColor}; color: white; padding: 20px; text-align: center;">
                <h1 style="margin: 0; font-size: 24px;">${orgShortName} Tournois</h1>
              </div>
              <div style="padding: 30px; background: #f8f9fa;">
                <p>Bonjour ${user.username},</p>
                <p>Vous avez demande la reinitialisation de votre mot de passe.</p>
                <p>Voici votre code de verification :</p>
                <div style="background: ${primaryColor}; color: white; font-size: 32px; font-weight: bold; letter-spacing: 8px; text-align: center; padding: 20px; border-radius: 8px; margin: 20px 0;">
                  ${code}
                </div>
                <p style="color: #666; font-size: 14px;">Ce code expire dans 10 minutes.</p>
                <p style="color: #666; font-size: 14px;">Si vous n'avez pas demande cette reinitialisation, ignorez cet email.</p>
              </div>
              <div style="padding: 15px; background: #e9ecef; text-align: center; font-size: 12px; color: #666;">
                ${orgShortName} - ${orgName}
              </div>
            </div>
          `
        });
        console.log(`Reset code email sent to ${normalizedEmail}`);
      }
    } catch (emailErr) {
      console.error('Error sending reset code email:', emailErr);
    }

    res.json(standardResponse);
  });
});

// Reset password with 6-digit code
router.post('/reset-with-code', async (req, res) => {
  const { email, code, password } = req.body;

  if (!email || !code || !password) {
    return res.status(400).json({ error: 'Email, code et nouveau mot de passe requis' });
  }

  const normalizedEmail = email.toLowerCase().trim();

  // Verify code
  let codeVerification;
  try {
    codeVerification = await verifyResetCode(normalizedEmail, code);
  } catch (verifyErr) {
    console.error('Error verifying reset code:', verifyErr);
    return res.status(500).json({ error: 'Erreur lors de la verification du code' });
  }

  if (!codeVerification.valid) {
    return res.status(400).json({ error: codeVerification.error });
  }

  // Don't enforce strict password rules for now (as requested)
  if (password.length < 6) {
    return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caracteres' });
  }

  // Find user
  db.get('SELECT * FROM users WHERE email = $1', [normalizedEmail], (err, user) => {
    if (err || !user) {
      return res.status(404).json({ error: 'Compte introuvable' });
    }

    bcrypt.hash(password, 10, (err, hash) => {
      if (err) {
        return res.status(500).json({ error: 'Erreur lors du changement de mot de passe' });
      }

      db.run('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, user.id], (err) => {
        if (err) {
          return res.status(500).json({ error: 'Erreur lors de la mise a jour' });
        }

        console.log(`Password reset successful for ${normalizedEmail}`);
        res.json({ success: true, message: 'Mot de passe reinitialise avec succes' });
      });
    });
  });
});

// ==================== USER MANAGEMENT (Admin only) ====================

// Get all users (admin only)
router.get('/users', authenticateToken, requireAdmin, (req, res) => {
  db.all('SELECT id, username, email, role, is_active, receive_tournament_alerts, created_at, last_login FROM users ORDER BY username', [], (err, users) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(users);
  });
});

// Create new user (admin only)
router.post('/users', authenticateToken, requireAdmin, (req, res) => {
  const { username, password, role, email } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const validRoles = ['admin', 'viewer'];
  const userRole = validRoles.includes(role) ? role : 'viewer';
  const userEmail = email ? email.toLowerCase().trim() : null;

  // Check if username exists
  db.get('SELECT id FROM users WHERE username = $1', [username], (err, existing) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }

    if (existing) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    bcrypt.hash(password, 10, (err, hash) => {
      if (err) {
        return res.status(500).json({ error: 'Error hashing password' });
      }

      db.run(
        'INSERT INTO users (username, password_hash, role, email) VALUES ($1, $2, $3, $4) RETURNING id',
        [username, hash, userRole, userEmail],
        function(err) {
          if (err) {
            return res.status(500).json({ error: 'Error creating user' });
          }

          // Log user creation
          logAdminAction({
            req,
            action: ACTION_TYPES.USER_CREATED,
            details: `Création utilisateur: ${username} (${userRole})`,
            targetType: 'user',
            targetId: this.lastID,
            targetName: username
          });

          res.json({
            message: 'User created successfully',
            user: { id: this.lastID, username, role: userRole, email: userEmail }
          });
        }
      );
    });
  });
});

// Update user (admin only)
router.put('/users/:id', authenticateToken, requireAdmin, (req, res) => {
  const userId = req.params.id;
  const { username, password, role, is_active, email, receive_tournament_alerts } = req.body;

  // Prevent admin from deactivating themselves
  if (req.user.userId == userId && is_active === 0) {
    return res.status(400).json({ error: 'Cannot deactivate your own account' });
  }

  db.get('SELECT * FROM users WHERE id = $1', [userId], (err, user) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const updates = [];
    const params = [];
    let paramIndex = 1;

    if (username && username !== user.username) {
      updates.push(`username = $${paramIndex++}`);
      params.push(username);
    }

    if (role && ['admin', 'viewer'].includes(role)) {
      updates.push(`role = $${paramIndex++}`);
      params.push(role);
    }

    if (typeof is_active === 'number') {
      updates.push(`is_active = $${paramIndex++}`);
      params.push(is_active);
    }

    // Handle email update (can be set to null to remove)
    if (email !== undefined) {
      updates.push(`email = $${paramIndex++}`);
      params.push(email ? email.toLowerCase().trim() : null);
    }

    // Handle tournament alerts opt-in
    if (typeof receive_tournament_alerts === 'boolean') {
      updates.push(`receive_tournament_alerts = $${paramIndex++}`);
      params.push(receive_tournament_alerts);
    }

    if (password && password.length >= 6) {
      bcrypt.hash(password, 10, (err, hash) => {
        if (err) {
          return res.status(500).json({ error: 'Error hashing password' });
        }

        updates.push(`password_hash = $${paramIndex++}`);
        params.push(hash);
        params.push(userId);

        if (updates.length === 0) {
          return res.json({ message: 'No changes made' });
        }

        db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIndex}`, params, (err) => {
          if (err) {
            return res.status(500).json({ error: 'Error updating user' });
          }

          // Log user update (with password)
          logAdminAction({
            req,
            action: ACTION_TYPES.USER_UPDATED,
            details: `Modification utilisateur (avec mot de passe)`,
            targetType: 'user',
            targetId: userId,
            targetName: user.username
          });

          res.json({ message: 'User updated successfully' });
        });
      });
    } else {
      params.push(userId);

      if (updates.length === 0) {
        return res.json({ message: 'No changes made' });
      }

      db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIndex}`, params, (err) => {
        if (err) {
          return res.status(500).json({ error: 'Error updating user' });
        }

        // Log user update
        logAdminAction({
          req,
          action: ACTION_TYPES.USER_UPDATED,
          details: `Modification utilisateur`,
          targetType: 'user',
          targetId: userId,
          targetName: user.username
        });

        res.json({ message: 'User updated successfully' });
      });
    }
  });
});

// Delete user (admin only)
router.delete('/users/:id', authenticateToken, requireAdmin, (req, res) => {
  const userId = req.params.id;

  // Prevent admin from deleting themselves
  if (req.user.userId == userId) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }

  // Get user info before deleting (for logging)
  db.get('SELECT username FROM users WHERE id = $1', [userId], (err, user) => {
    if (err) {
      return res.status(500).json({ error: 'Error finding user' });
    }

    db.run('DELETE FROM users WHERE id = $1', [userId], function(err) {
      if (err) {
        return res.status(500).json({ error: 'Error deleting user' });
      }

      if (this.changes === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Log user deletion
      logAdminAction({
        req,
        action: ACTION_TYPES.USER_DELETED,
        details: `Suppression utilisateur: ${user?.username || 'inconnu'}`,
        targetType: 'user',
        targetId: userId,
        targetName: user?.username
      });

      res.json({ message: 'User deleted successfully' });
    });
  });
});

// ==================== MIDDLEWARE ====================

// Middleware to authenticate token
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }

    req.user = user;
    next();
  });
}

// Middleware to require admin role
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin' && !req.user.admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// Middleware to require at least viewer role (for read-only access)
function requireViewer(req, res, next) {
  // Both admin and viewer can access
  if (req.user.role === 'admin' || req.user.role === 'viewer' || req.user.admin) {
    return next();
  }
  return res.status(403).json({ error: 'Access denied' });
}

module.exports = router;
module.exports.authenticateToken = authenticateToken;
module.exports.requireAdmin = requireAdmin;
module.exports.requireViewer = requireViewer;
module.exports.JWT_SECRET = JWT_SECRET;
