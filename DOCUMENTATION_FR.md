# CDBHS Tournois - Documentation Technique et Fonctionnelle

## Vue d'ensemble

**CDBHS Tournois** est une application web complète de gestion des tournois et classements de billard carambole, développée pour le Comité Départemental de Billard des Hauts-de-Seine (CDBHS).

---

## 1. Architecture Technique

### 1.1 Stack Technologique

| Composant | Technologie |
|-----------|-------------|
| **Backend** | Node.js + Express.js |
| **Base de données** | PostgreSQL (production) / SQLite (développement) |
| **Authentification** | JWT (JSON Web Tokens) + bcrypt |
| **Frontend** | HTML5 / CSS3 / JavaScript vanilla |
| **Génération Excel** | ExcelJS |
| **Parsing CSV** | csv-parse |
| **Upload fichiers** | Multer |
| **Hébergement** | Railway |

### 1.2 Structure du Projet

```
cdbhs-tournament-management/
├── backend/
│   ├── server.js           # Point d'entrée serveur
│   ├── db-postgres.js      # Configuration PostgreSQL
│   ├── db-loader.js        # Sélecteur de base de données
│   └── routes/
│       ├── auth.js         # Authentification utilisateurs
│       ├── players.js      # Gestion des joueurs
│       ├── tournaments.js  # Gestion des tournois
│       ├── rankings.js     # Calcul des classements
│       ├── inscriptions.js # Inscriptions & génération poules
│       ├── clubs.js        # Gestion des clubs
│       ├── calendar.js     # Calendrier de saison
│       └── backup.js       # Export/sauvegarde données
│
├── frontend/
│   ├── login.html          # Page de connexion
│   ├── dashboard.html      # Tableau de bord principal
│   ├── players-list.html   # Liste des joueurs
│   ├── rankings.html       # Affichage des classements
│   ├── tournaments-list.html   # Liste des tournois
│   ├── tournament-results.html # Résultats avec podium
│   ├── import-players.html     # Import joueurs CSV
│   ├── import-tournament.html  # Import résultats tournoi
│   ├── generate-poules.html    # Génération des poules
│   ├── player-history.html     # Historique joueur
│   ├── clubs.html          # Gestion des clubs
│   ├── calendar.html       # Calendrier saison
│   ├── settings.html       # Paramètres admin
│   └── css/styles.css      # Feuille de styles
│
└── Documentation/
    ├── README.md
    ├── DEPLOYMENT.md
    └── CSV_FORMAT_GUIDE.md
```

---

## 2. Base de Données

### 2.1 Schéma des Tables

#### **users** - Utilisateurs
| Colonne | Type | Description |
|---------|------|-------------|
| id | SERIAL | Identifiant unique |
| username | VARCHAR | Nom d'utilisateur |
| password_hash | VARCHAR | Mot de passe hashé (bcrypt) |
| role | VARCHAR | Rôle (admin/viewer) |
| is_active | BOOLEAN | Compte actif |
| last_login | TIMESTAMP | Dernière connexion |

#### **players** - Joueurs
| Colonne | Type | Description |
|---------|------|-------------|
| licence | VARCHAR | Numéro de licence (clé primaire) |
| club | VARCHAR | Club du joueur |
| first_name | VARCHAR | Prénom |
| last_name | VARCHAR | Nom |
| rank_libre | VARCHAR | Classement Libre (NC, R4, R3, etc.) |
| rank_cadre | VARCHAR | Classement Cadre |
| rank_bande | VARCHAR | Classement Bande |
| rank_3bandes | VARCHAR | Classement 3 Bandes |
| is_active | BOOLEAN | Joueur actif |

#### **categories** - Catégories (13 catégories fixes)
| Colonne | Type | Description |
|---------|------|-------------|
| id | SERIAL | Identifiant |
| game_type | VARCHAR | Type de jeu (LIBRE/CADRE/BANDE/3BANDES) |
| level | VARCHAR | Niveau (N3GC, R1, R2, R3, R4) |
| display_name | VARCHAR | Nom affiché |

**Catégories disponibles :**
- **LIBRE** : N3GC, Régionale 1, Régionale 2, Régionale 3, Régionale 4
- **CADRE** : Nationale 3, Régionale 1
- **BANDE** : Nationale 3, Régionale 1, Régionale 2
- **3 BANDES** : Nationale 3, Régionale 1, Régionale 2

#### **tournaments** - Tournois
| Colonne | Type | Description |
|---------|------|-------------|
| id | SERIAL | Identifiant |
| category_id | INTEGER | Catégorie (FK) |
| tournament_number | INTEGER | Numéro du tournoi (1-4) |
| season | VARCHAR | Saison (ex: "2024-2025") |
| tournament_date | DATE | Date du tournoi |

#### **tournament_results** - Résultats
| Colonne | Type | Description |
|---------|------|-------------|
| id | SERIAL | Identifiant |
| tournament_id | INTEGER | Tournoi (FK) |
| licence | VARCHAR | Licence joueur (FK) |
| player_name | VARCHAR | Nom complet |
| match_points | INTEGER | Points de match |
| moyenne | DECIMAL | Moyenne générale |
| serie | INTEGER | Meilleure série |
| points | INTEGER | Points totaux |

#### **rankings** - Classements cumulés
| Colonne | Type | Description |
|---------|------|-------------|
| id | SERIAL | Identifiant |
| category_id | INTEGER | Catégorie |
| season | VARCHAR | Saison |
| licence | VARCHAR | Licence joueur |
| total_match_points | INTEGER | Total points de match |
| avg_moyenne | DECIMAL | Moyenne des moyennes |
| best_serie | INTEGER | Meilleure série |
| rank_position | INTEGER | Position au classement |
| tournament_1_points | INTEGER | Points Tournoi 1 |
| tournament_2_points | INTEGER | Points Tournoi 2 |
| tournament_3_points | INTEGER | Points Tournoi 3 |

#### **clubs** - Clubs
| Colonne | Type | Description |
|---------|------|-------------|
| id | SERIAL | Identifiant |
| name | VARCHAR | Nom interne |
| display_name | VARCHAR | Nom affiché |
| logo_filename | VARCHAR | Fichier logo |
| street | VARCHAR | Adresse |
| city | VARCHAR | Ville |
| zip_code | VARCHAR | Code postal |
| phone | VARCHAR | Téléphone |
| email | VARCHAR | Email |

#### **calendar** - Calendrier
| Colonne | Type | Description |
|---------|------|-------------|
| id | SERIAL | Identifiant |
| filename | VARCHAR | Nom du fichier |
| file_type | VARCHAR | Type (PDF/Excel) |
| file_data | BYTEA | Données binaires |
| uploaded_by | VARCHAR | Uploadé par |
| uploaded_at | TIMESTAMP | Date upload |

---

## 3. Fonctionnalités

### 3.1 Authentification & Utilisateurs

- **Connexion sécurisée** avec JWT (validité 24h)
- **Deux rôles** :
  - `admin` : accès complet (import, modification, suppression)
  - `viewer` : consultation uniquement (classements, résultats)
- **Gestion des utilisateurs** (création, modification, désactivation)
- **Changement de mot de passe**

### 3.2 Gestion des Joueurs

- **Import CSV** de la liste des joueurs FFB
- **Ajout manuel** de joueurs
- **Modification** des informations (nom, prénom, club, classements)
- **Historique** des performances par joueur
- **Filtrage** par club, statut actif/inactif

### 3.3 Gestion des Tournois

- **Import des résultats** via fichier CSV
- **Validation automatique** des licences
- **Calcul automatique** de la saison à partir de la date
- **Jusqu'à 4 tournois** par saison et par catégorie
- **Recalcul** des classements après modification

### 3.4 Classements

- **Calcul automatique** des classements cumulés
- **Points de match** additionnés sur la saison
- **Moyenne des moyennes** calculée
- **Meilleure série** conservée
- **Affichage podium** (Or, Argent, Bronze)
- **Export Excel** avec mise en forme professionnelle

### 3.5 Génération des Poules

- **Sélection des joueurs** inscrits au tournoi
- **Distribution serpentine** équitable selon le classement
- **Déplacement manuel** des joueurs entre poules
- **Choix du lieu** par poule (multi-sites)
- **Export Excel** avec 3 feuilles :
  - `Poules` : Composition et planning des matchs
  - `Convocation` : Format original
  - `Convocation v2` : Format moderne avec titre "CONVOCATION TOURNOI N°X"

### 3.6 Gestion des Clubs

- **Liste des clubs** avec logos
- **Informations de contact** (adresse, téléphone, email)
- **Attribution** des clubs aux joueurs
- **Upload de logos**

### 3.7 Calendrier de Saison

- **Upload** du calendrier (PDF ou Excel)
- **Consultation** par tous les utilisateurs
- **Téléchargement** du fichier

### 3.8 Sauvegarde & Export

- **Export Excel** des joueurs
- **Export Excel** des tournois
- **Export Excel** des classements
- **Sauvegarde complète** de toutes les données

---

## 4. API REST

### 4.1 Endpoints Authentification (`/api/auth`)

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| POST | `/login` | Connexion |
| GET | `/me` | Info utilisateur courant |
| POST | `/change-password` | Changer mot de passe |
| GET | `/users` | Liste utilisateurs (admin) |
| POST | `/users` | Créer utilisateur (admin) |
| PUT | `/users/:id` | Modifier utilisateur (admin) |
| DELETE | `/users/:id` | Supprimer utilisateur (admin) |

### 4.2 Endpoints Joueurs (`/api/players`)

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/` | Liste des joueurs |
| GET | `/:licence` | Détails d'un joueur |
| POST | `/` | Ajouter un joueur |
| POST | `/import` | Import CSV |
| PUT | `/:licence` | Modifier joueur |
| DELETE | `/:licence` | Supprimer joueur |
| GET | `/:licence/history` | Historique tournois |

### 4.3 Endpoints Tournois (`/api/tournaments`)

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/categories` | Liste des 13 catégories |
| GET | `/` | Liste des tournois |
| GET | `/:id` | Détails tournoi |
| POST | `/validate` | Valider CSV avant import |
| POST | `/import` | Importer résultats |
| DELETE | `/:id` | Supprimer tournoi |
| POST | `/:id/recalculate` | Recalculer classements |

### 4.4 Endpoints Classements (`/api/rankings`)

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/` | Classements (filtres: category, season) |
| GET | `/seasons` | Liste des saisons |
| GET | `/export` | Export Excel |

### 4.5 Endpoints Inscriptions (`/api/inscriptions`)

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/external-tournaments` | Tournois externes |
| POST | `/generate-poules` | Générer poules + Excel |

### 4.6 Endpoints Clubs (`/api/clubs`)

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/` | Liste des clubs |
| GET | `/:id` | Détails club |
| POST | `/` | Créer club |
| PUT | `/:id` | Modifier club |
| DELETE | `/:id` | Supprimer club |

### 4.7 Endpoints Calendrier (`/api/calendar`)

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/` | Télécharger calendrier |
| GET | `/info` | Info calendrier actuel |
| POST | `/upload` | Uploader calendrier |

### 4.8 Endpoints Sauvegarde (`/api/backup`)

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/export-players` | Export joueurs Excel |
| GET | `/export-tournaments` | Export tournois Excel |
| GET | `/export-rankings` | Export classements Excel |
| GET | `/export-all` | Sauvegarde complète |

---

## 5. Format des Fichiers CSV

### 5.1 Import Joueurs

**Format attendu** (séparateur: virgule ou point-virgule) :
```csv
"licence","club","first_name","last_name","rank_libre","rank_cadre","rank_bande","rank_3bandes"
"123456","BILLARD CLUB PARIS","Jean","DUPONT","R3","NC","NC","R2"
```

### 5.2 Import Résultats Tournoi

**Format attendu** (séparateur: point-virgule) :
```csv
Classement;Licence;Joueur;Points;Reprises;Moyenne;Série
1;123456;DUPONT Jean;8;45;1.234;12
2;789012;MARTIN Pierre;6;52;0.987;8
```

---

## 6. Déploiement

### 6.1 Variables d'Environnement

| Variable | Description | Exemple |
|----------|-------------|---------|
| `DATABASE_URL` | URL PostgreSQL | `postgresql://user:pass@host:5432/db` |
| `JWT_SECRET` | Clé secrète JWT | `votre_secret_jwt_tres_long` |
| `PORT` | Port du serveur | `3000` |
| `NODE_ENV` | Environnement | `production` |

### 6.2 Déploiement Railway

1. Connecter le repository GitHub
2. Configurer les variables d'environnement
3. Le déploiement est automatique à chaque push sur `main`

---

## 7. Sécurité

- **Mots de passe** hashés avec bcrypt (10 rounds)
- **Tokens JWT** avec expiration 24h
- **Validation** des entrées utilisateur
- **Protection CORS** configurée
- **Rôles utilisateurs** pour contrôle d'accès
- **Requêtes préparées** contre les injections SQL

---

## 8. Évolutions Futures

1. **Tournoi N°1 basé sur la moyenne** de la saison précédente
2. **Intégration base de données FFB** pour synchronisation automatique
3. **Notifications** par email pour les convocations
4. **Application mobile** pour consultation des classements

---

## 9. Support

- **Repository GitHub** : https://github.com/Jeff92400/cdbhs-tournament-management
- **Hébergement** : Railway (https://railway.app)

---

*Document généré le 28 novembre 2025 - CDBHS Tournois v1.0*
