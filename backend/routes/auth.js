const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db-loader');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'billard-ranking-jwt-secret-key-2024-change-in-production';

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
      return res.status(401).json({ error: 'Nom d\'utilisateur ou mot de passe incorrect' });
    }

    bcrypt.compare(password, user.password_hash, (err, result) => {
      if (err || !result) {
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
  res.json({
    userId: req.user.userId,
    username: req.user.username,
    role: req.user.role
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

          const baseUrl = process.env.BASE_URL || 'https://cdbhs-tournament-management-production.up.railway.app';
          const resetLink = `${baseUrl}/reset-password.html?token=${resetToken}`;

          await resend.emails.send({
            from: 'CDBHS <convocations@cdbhs.net>',
            to: user.email,
            subject: 'Réinitialisation de votre mot de passe CDBHS',
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                <h2 style="color: #1F4788;">Réinitialisation de mot de passe</h2>
                <p>Bonjour ${user.username},</p>
                <p>Vous avez demandé la réinitialisation de votre mot de passe CDBHS.</p>
                <p>Cliquez sur le bouton ci-dessous pour définir un nouveau mot de passe :</p>
                <p style="text-align: center; margin: 30px 0;">
                  <a href="${resetLink}" style="background: #1F4788; color: white; padding: 15px 30px; text-decoration: none; border-radius: 6px; display: inline-block;">
                    Réinitialiser mon mot de passe
                  </a>
                </p>
                <p style="color: #666; font-size: 14px;">Ce lien expire dans 1 heure.</p>
                <p style="color: #666; font-size: 14px;">Si vous n'avez pas demandé cette réinitialisation, ignorez cet email.</p>
                <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">
                <p style="color: #999; font-size: 12px;">CDBHS - Comité Départemental de Billard des Hauts-de-Seine</p>
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

// ==================== USER MANAGEMENT (Admin only) ====================

// Get all users (admin only)
router.get('/users', authenticateToken, requireAdmin, (req, res) => {
  db.all('SELECT id, username, email, role, is_active, created_at, last_login FROM users ORDER BY username', [], (err, users) => {
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
  const { username, password, role, is_active, email } = req.body;

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

  db.run('DELETE FROM users WHERE id = $1', [userId], function(err) {
    if (err) {
      return res.status(500).json({ error: 'Error deleting user' });
    }

    if (this.changes === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ message: 'User deleted successfully' });
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
