# CDBHS Tournois - Guide Utilisateur

## Table des matières
1. [Connexion](#1-connexion)
2. [Tableau de bord](#2-tableau-de-bord)
3. [Gestion des fichiers IONOS](#3-gestion-des-fichiers-ionos)
4. [Génération des poules](#4-génération-des-poules)
5. [Classements](#5-classements)
6. [Tournois joués](#6-tournois-joués)
7. [Gestion des joueurs](#7-gestion-des-joueurs)
8. [Gestion des clubs](#8-gestion-des-clubs)
9. [Paramètres](#9-paramètres)

---

## 1. Connexion

### Accès à l'application
- URL : https://cdbhs-tournament-management-production.up.railway.app
- Identifiants par défaut : `admin` / `admin123`

### Rôles utilisateurs
| Rôle | Droits |
|------|--------|
| **Admin** | Accès complet (import, modification, suppression) |
| **Viewer** | Consultation uniquement (classements, résultats) |

---

## 2. Tableau de bord

Le tableau de bord affiche :
- Statistiques globales (joueurs, tournois, catégories)
- Accès rapide aux fonctionnalités principales
- État des derniers imports

---

## 3. Gestion des fichiers IONOS

### Accès
Menu **Fichiers** > **Compétitions & Inscriptions**

### Fichiers à importer depuis IONOS
L'application nécessite 3 fichiers CSV exportés depuis la base IONOS :

| Fichier | Description | Fréquence |
|---------|-------------|-----------|
| **Joueurs** | Liste des joueurs FFB avec licences et classements | Début de saison |
| **Tournois** | Liste des compétitions CDBHS | Début de saison |
| **Inscriptions** | Inscriptions des joueurs aux tournois | Avant chaque tournoi |

### Procédure d'import

1. **Exporter depuis IONOS** :
   - Connectez-vous à l'interface IONOS
   - Exportez chaque fichier au format CSV

2. **Importer dans l'application** :
   - Allez dans **Fichiers** > **Compétitions & Inscriptions**
   - Sélectionnez l'onglet correspondant (Joueurs, Tournois, Inscriptions)
   - Cliquez sur **Choisir un fichier**
   - Sélectionnez le fichier CSV
   - Cliquez sur **Importer**

3. **Vérification** :
   - Un message confirme le nombre d'enregistrements importés
   - Les dates de dernière mise à jour sont affichées

### Indicateurs de fraîcheur des données

Sur la page "Tournois à jouer", un panneau affiche l'état des 3 fichiers avec un code couleur :

| Couleur | Signification |
|---------|---------------|
| 🟢 Vert | Mis à jour il y a moins de 24h |
| 🟡 Jaune | Mis à jour il y a 1-2 jours |
| 🟠 Orange | Mis à jour il y a 3-7 jours |
| 🔴 Rouge | Mis à jour il y a plus de 7 jours |

---

## 4. Génération des poules

### Accès
Menu principal > **Tournois à jouer**

### Étape 1 : Vérification des données

À l'ouverture de la page, un avertissement vous rappelle de mettre à jour les fichiers IONOS :
- Cliquez sur **Mettre à jour les inscriptions** pour importer les derniers fichiers
- Ou cliquez sur **Continuer sans mise à jour** si les données sont à jour

### Étape 2 : Sélection du tournoi

**Tournois à venir** :
- L'application affiche automatiquement les tournois prévus dans les 2 prochaines semaines
- Cliquez sur un tournoi pour pré-remplir automatiquement les sélections

**Sélection manuelle** :
1. Choisissez la **Catégorie** (ex: LIBRE - REGIONALE 3)
2. Vérifiez la **Saison** (pré-sélectionnée)
3. Sélectionnez le **Tournoi** (1, 2, 3 ou Finale)
4. Cliquez sur **Charger les joueurs**

### Étape 3 : Sélection des joueurs

L'écran affiche 3 sections :

**Joueurs classés** :
- Liste des joueurs du classement actuel
- Marqués "Inscrit" (vert) ou "Forfait" (rouge)
- Les inscrits sont pré-sélectionnés automatiquement

**Nouveaux joueurs** :
- Joueurs inscrits mais non présents au classement
- Marqués "Nouveau" (orange)
- Tous pré-sélectionnés automatiquement

**Ajout last minute** :
- Recherchez un joueur par nom ou licence
- Ajoutez-le manuellement si absent des inscriptions

**Actions rapides** :
- **Tout sélectionner** : Sélectionne tous les joueurs
- **Tout désélectionner** : Désélectionne tous les joueurs
- **Sélectionner les inscrits** : Sélectionne uniquement les joueurs inscrits

**Résumé en temps réel** :
- Nombre de joueurs sélectionnés
- Configuration des poules (ex: "5 poules de 3 et 1 poule de 4")
- Nombre de tables nécessaires

### Étape 4 : Validation et aperçu

**Résumé du tournoi** :
- Catégorie, numéro de tournoi, date, lieu
- Nombre de joueurs et configuration

**Aperçu des poules** :
- Distribution serpentine automatique
- Possibilité de **déplacer un joueur** entre poules
- Chaque joueur affiche son classement final

**Configuration du lieu** :
1. Sélectionnez le **Lieu principal** (club)
2. Choisissez l'**Heure de début**
3. Optionnel : Ajoutez un **second lieu** (split) pour les poules

**Attribution des lieux par poule** :
- Chaque poule peut être assignée à Lieu 1 ou Lieu 2
- Utile pour les tournois split sur 2 clubs

### Étape 5 : Génération du fichier Excel

Cliquez sur **Générer le fichier Excel**

Le fichier contient 3 feuilles :
1. **Poules** : Composition des poules avec planning des matchs
2. **Convocation** : Format classique
3. **Convocation v2** : Format moderne avec mise en page professionnelle

---

## 5. Classements

### Accès
Menu principal > **Classements**

### Fonctionnalités
- Filtrage par **Catégorie** et **Saison**
- Affichage du **podium** (Or, Argent, Bronze)
- Détails par joueur :
  - Total points de match
  - Moyenne des moyennes
  - Meilleure série
  - Points par tournoi
- **Export Excel** du classement

### Calcul du classement
- Points de match additionnés sur la saison
- Départage par : Moyenne > Meilleure série

---

## 6. Tournois joués

### Accès
Menu principal > **Tournois joués**

### Fonctionnalités
- Liste de tous les tournois importés
- Filtrage par catégorie et saison
- Visualisation des résultats avec podium
- Suppression de tournoi (recalcule le classement)

### Import des résultats
Menu **Fichiers** > **Tournois joués** > **Importer**

1. Préparez le fichier CSV des résultats
2. Sélectionnez la **Catégorie**
3. Indiquez le **Numéro de tournoi**
4. Saisissez la **Date du tournoi**
5. Uploadez le fichier
6. Validez après vérification

---

## 7. Gestion des joueurs

### Accès
Menu **Fichiers** > **Joueurs**

### Fonctionnalités
- Liste de tous les joueurs
- Filtrage par club, statut actif/inactif
- Modification des informations :
  - Nom, prénom
  - Club
  - Classements (Libre, Cadre, Bande, 3 Bandes)
- Historique des performances par joueur
- Import CSV de la liste FFB

---

## 8. Gestion des clubs

### Accès
Menu **Fichiers** > **Clubs**

### Informations gérées
- Nom du club
- Adresse complète (rue, code postal, ville)
- Téléphone
- Email
- Logo

Ces informations sont utilisées dans les convocations générées.

---

## 9. Paramètres

### Accès
Menu **Paramètres** > **Configuration**

### Gestion des utilisateurs
- Création de nouveaux comptes
- Attribution des rôles (Admin/Viewer)
- Désactivation de comptes
- Changement de mot de passe

### Calendrier
Menu **Paramètres** > **Calendrier**
- Upload du calendrier de saison (PDF ou Excel)
- Consultation et téléchargement

---

## Annexe : Format des fichiers CSV

### Joueurs (export FFB)
```csv
licence,club,first_name,last_name,rank_libre,rank_cadre,rank_bande,rank_3bandes
123456,BILLARD CLUB PARIS,Jean,DUPONT,R3,NC,NC,R2
```

### Résultats tournoi
```csv
Classement;Licence;Joueur;Points;Reprises;Moyenne;Série
1;123456;DUPONT Jean;8;45;1.234;12
2;789012;MARTIN Pierre;6;52;0.987;8
```

---

## Support

- **Repository** : https://github.com/Jeff92400/cdbhs-tournament-management
- **Hébergement** : Railway

---

*Guide utilisateur - CDBHS Tournois v1.1*
*Mis à jour le 30 novembre 2025*
