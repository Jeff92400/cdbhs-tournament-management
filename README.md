# CDBHS Tournament Management System

Application complète de gestion des compétitions de billard français pour le Comité Départemental de Billard des Hauts-de-Seine (CDBHS).

## Production

**URL de l'application :** https://cdbhs-tournament-management-production.up.railway.app

**Application mobile (Player App) :** https://cdbhs-player-app-production.up.railway.app

## Fonctionnalités

### Gestion des Compétitions
- **13 catégories** : LIBRE (N3, R1-R4), CADRE (N3, R1), BANDE (N3, R1-R2), 3 BANDES (N3, R1-R2)
- **Tournois et Finales départementales** avec gestion des finalistes qualifiés
- **Inscriptions** avec import IONOS et protection des inscriptions Player App
- **Génération des poules** avec algorithme serpentine (répartition équilibrée par classement)
- **Simulation des poules** visible par tous les utilisateurs (≥3 inscrits, >7 jours avant)
- **Convocations par email** avec détails complets (poule, lieu, horaire)
- **Calendrier de la saison** (upload PDF/Excel, accès public)

### Gestion des Joueurs
- **Import CSV** depuis fichiers IONOS (joueurs et inscriptions)
- **Classements FFB** : Libre, Cadre, Bande, 3 Bandes
- **Historique complet** par joueur et par saison
- **Export Excel** des classements avec mise en forme professionnelle

### Classements CDBHS
- **Calcul automatique** basé sur : Points match → Moyenne → Série
- **Classements cumulatifs** sur 3 tournois par saison
- **Affichage "après Tx"** pour indiquer le nombre de tournois joués

### Administration
- **Authentification multi-utilisateurs** : Admin (accès complet) et Viewer (lecture seule)
- **Gestion des lieux** de compétition avec adresses complètes
- **Paramètres de la saison** et gestion des catégories
- **Relances email** pour les compétitions à venir

## Stack Technique

### Backend
- **Runtime :** Node.js 18+
- **Framework :** Express.js
- **Base de données :** PostgreSQL (Railway)
- **Authentification :** JWT + bcrypt
- **Email :** Nodemailer avec templates HTML
- **Upload :** Multer (CSV, PDF, Excel)
- **Export :** ExcelJS

### Frontend
- **HTML5 / CSS3 / JavaScript** (Vanilla)
- **Design responsive** pour desktop et mobile
- **Thème CDBHS** (bleu #1F4788)

### Déploiement
- **Hébergement :** Railway
- **Build :** Nixpacks
- **Base de données :** PostgreSQL Railway

## Architecture

```
cdbhs-tournament-management/
├── backend/
│   ├── server.js              # Point d'entrée Express
│   ├── db-loader.js           # Sélection SQLite/PostgreSQL
│   ├── db-postgres.js         # Adapter PostgreSQL
│   ├── db-sqlite.js           # Adapter SQLite (dev)
│   └── routes/
│       ├── auth.js            # Authentification JWT
│       ├── players.js         # Gestion joueurs
│       ├── tournaments.js     # Tournois et résultats
│       ├── inscriptions.js    # Inscriptions + simulation
│       ├── calendar.js        # Calendrier saison
│       └── email.js           # Envoi convocations
├── frontend/
│   ├── dashboard.html         # Tableau de bord
│   ├── generate-poules.html   # Génération poules + simulation
│   ├── rankings.html          # Classements CDBHS
│   ├── emailing.html          # Envoi emails
│   ├── calendar.html          # Gestion calendrier
│   ├── settings.html          # Paramètres admin
│   ├── css/styles.css
│   └── images/
├── nixpacks.toml              # Config déploiement Railway
└── package.json
```

## API Endpoints

### Authentification
- `POST /api/auth/login` - Connexion
- `POST /api/auth/logout` - Déconnexion
- `GET /api/auth/users` - Liste utilisateurs (admin)

### Joueurs
- `GET /api/players` - Liste des joueurs
- `POST /api/players/import` - Import CSV IONOS
- `GET /api/players/:licence` - Détails joueur

### Tournois
- `GET /api/tournaments` - Liste des tournois
- `POST /api/tournaments` - Créer tournoi
- `POST /api/tournaments/import` - Import résultats CSV

### Inscriptions
- `GET /api/inscriptions/tournoi/:id` - Inscriptions par tournoi
- `POST /api/inscriptions/import` - Import IONOS (protège Player App)
- `GET /api/inscriptions/tournoi/:id/simulation` - Simulation des poules

### Calendrier
- `POST /api/calendar/upload` - Upload calendrier (admin)
- `GET /api/calendar/public` - Accès public (Player App)

## Intégration Player App

Le système est conçu pour fonctionner avec l'application mobile CDBHS Player App :

- **Inscriptions protégées** : Les inscriptions faites via Player App (`source='player_app'`) ne sont pas écrasées par l'import IONOS
- **Calendrier partagé** : Endpoint public `/api/calendar/public` accessible par Player App
- **Simulation des poules** : Disponible sur les deux applications

## Configuration

### Variables d'environnement (Railway)
```
DATABASE_URL=postgresql://...
JWT_SECRET=your-secret-key
EMAIL_USER=your-email@gmail.com
EMAIL_PASS=your-app-password
```

### Développement local
```bash
cd backend
npm install
npm start
# Serveur sur http://localhost:3000
```

## Algorithme Serpentine

La répartition des joueurs dans les poules utilise l'algorithme serpentine :

```
Exemple avec 9 joueurs (3 poules de 3) :
- Joueurs triés par classement : #1, #2, #3, #4, #5, #6, #7, #8, #9

Distribution serpentine :
  Poule A: #1, #6, #7
  Poule B: #2, #5, #8
  Poule C: #3, #4, #9
```

Cet algorithme assure un équilibre des niveaux dans chaque poule.

## Licence

Application développée pour le CDBHS - Comité Départemental de Billard des Hauts-de-Seine.
