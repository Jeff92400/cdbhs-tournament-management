# Guide Utilisateur - Tournois à Jouer

Ce guide vous accompagne pas à pas dans la préparation des poules pour vos tournois de billard.

---

## Vue d'ensemble

Le module "Tournois à jouer" vous permet de :
- Vérifier la fraîcheur des données IONOS
- Sélectionner un tournoi à préparer
- Choisir les joueurs participants
- Visualiser et ajuster les poules
- Générer le fichier Excel de convocation

Le processus se déroule en **4 étapes** :
1. **Sélection** - Choisir le tournoi
2. **Joueurs** - Sélectionner les participants
3. **Validation** - Vérifier et ajuster les poules
4. **Génération** - Créer le fichier Excel

---

## Écran d'accueil - Vérification des données

![Écran de vérification des imports](screenshots/step0-import-check.png)

### Ce que vous voyez

À l'ouverture de la page, un **panneau d'avertissement jaune** s'affiche avec :

- **Inscriptions** : Date de dernière mise à jour du fichier des inscriptions
- **Tournois** : Date de dernière mise à jour du fichier des tournois externes
- **Joueurs** : Date de dernière mise à jour du fichier des joueurs FFB

### Code couleur des dates

| Couleur | Signification |
|---------|---------------|
| 🟢 Vert | Mis à jour il y a moins de 24h |
| 🟡 Jaune | Mis à jour il y a 1-2 jours |
| 🟠 Orange | Mis à jour il y a 3-7 jours |
| 🔴 Rouge | Mis à jour il y a plus de 7 jours ou jamais importé |

### Ce que vous pouvez faire

1. **Mettre à jour les inscriptions** (bouton jaune)
   - Cliquez pour accéder à la page d'import des fichiers IONOS
   - Recommandé si les données ont plus de 2 jours

2. **Continuer sans mise à jour** (bouton gris)
   - Cliquez si vous êtes sûr que vos données sont à jour
   - Passe directement à l'étape de sélection du tournoi

---

## Étape 1 : Sélection du Tournoi

![Sélection du tournoi](screenshots/step1-selection.png)

### Tournois à venir

En haut de l'écran, une section **"Tournois à venir"** affiche automatiquement les tournois prévus dans les 2 prochaines semaines.

Chaque carte de tournoi affiche :
- **Mode et catégorie** (ex: 3 BANDES - N3, LIBRE - R2)
- **Numéro du tournoi** (Tournoi 1, 2, 3 ou Finale)
- **Date** du tournoi
- **Lieu** prévu
- **Nombre d'inscrits** dans le système IONOS

### Ce que vous pouvez faire

**Option 1 : Cliquer sur un tournoi à venir**
- Les champs Catégorie, Saison et Tournoi se remplissent automatiquement
- Le tournoi sélectionné est mis en surbrillance (bordure bleue)
- Un résumé bleu apparaît avec les détails du tournoi

**Option 2 : Sélection manuelle**
- **Catégorie** : Choisissez le mode de jeu et le niveau (ex: LIBRE - REGIONALE 3)
- **Saison** : Pré-sélectionnée automatiquement (ex: 2025-2026)
- **Tournoi à préparer** : Sélectionnez Tournoi 1, 2, 3 ou Finale

### Validation

Une fois le tournoi sélectionné, un **résumé bleu** apparaît avec :
- La catégorie complète
- La date du tournoi
- Le lieu prévu
- Le nombre de joueurs inscrits

Cliquez sur **"Charger les joueurs"** pour passer à l'étape 2.

---

## Étape 2 : Sélection des Joueurs

![Sélection des joueurs](screenshots/step2-joueurs.png)

### Résumé en temps réel

En haut de l'écran, un panneau affiche en temps réel :
- **Joueurs sélectionnés** : Nombre total de joueurs cochés
- **Configuration des poules** : Répartition optimale (ex: "5 poules de 3 et 1 poule de 4")
- **Tables nécessaires** : Nombre de tables de billard requises

### Les 3 sections de joueurs

#### 1. Joueurs classés (du classement actuel)

Liste des joueurs présents dans le classement de la catégorie, triés par position :
- **#1, #2, #3...** : Position au classement
- **Nom du joueur**
- **Club** et **Licence**
- **Badge "Inscrit"** (vert) : Le joueur est inscrit dans IONOS
- **Badge "Forfait"** (rouge) : Le joueur a déclaré forfait

Les joueurs inscrits sont **automatiquement pré-cochés**.

#### 2. Nouveaux joueurs (inscrits non classés)

Joueurs inscrits dans IONOS mais absents du classement actuel :
- Marqués avec un badge **"Nouveau"** (orange)
- Position affichée comme **"-"**
- Automatiquement pré-cochés

Ces joueurs seront placés en fin de distribution serpentine.

#### 3. Ajout last minute

Permet d'ajouter un joueur qui n'est pas inscrit dans IONOS :
- Tapez le nom ou le numéro de licence
- Sélectionnez le joueur dans la liste déroulante
- Cliquez sur **"Ajouter"**

Utile pour les inscriptions de dernière minute ou les remplacements.

### Boutons d'action rapide

| Bouton | Action |
|--------|--------|
| **Tout sélectionner** | Coche tous les joueurs de la liste |
| **Tout désélectionner** | Décoche tous les joueurs |
| **Sélectionner les inscrits** | Coche uniquement les joueurs avec le badge "Inscrit" |

### Navigation

- **Retour** : Revenir à l'étape 1 (sélection du tournoi)
- **Valider la liste** : Passer à l'étape 3 (aperçu des poules)

---

## Étape 3 : Validation et Aperçu des Poules

![Validation et aperçu](screenshots/step3-validation.png)

### Résumé du tournoi

En haut, un tableau récapitule :
- **Catégorie** : Mode et niveau
- **Tournoi** : Numéro du tournoi
- **Date** : Date de la compétition
- **Lieu** : Lieu prévu (depuis IONOS)
- **Nombre de joueurs** : Total des participants
- **Configuration** : Répartition des poules
- **Tables nécessaires** : Nombre de tables requises

### Aperçu des Poules (Distribution Serpentine)

Les joueurs sont répartis automatiquement selon la **méthode serpentine** :
- Les joueurs sont distribués en zigzag selon leur classement
- Cela garantit un équilibre entre les poules

Chaque poule affiche :
- **Titre** : "Poule 1 (3 joueurs)", "Poule 2 (3 joueurs)", etc.
- **Liste des joueurs** avec leur position au classement entre parenthèses
- **Badge "Nouveau"** pour les joueurs non classés
- **Sélecteur de lieu** pour chaque poule

### Déplacer un joueur

Pour chaque joueur, un bouton **"Déplacer..."** permet de le transférer vers une autre poule :
1. Cliquez sur "Déplacer..."
2. Sélectionnez la poule de destination
3. Le joueur est immédiatement déplacé

Utile pour :
- Éviter que des joueurs du même club soient dans la même poule
- Ajuster manuellement la répartition si nécessaire

### Lieu et Horaire de la Compétition

#### Lieu principal
- Sélectionnez le club où se déroule le tournoi
- Liste déroulante avec tous les clubs enregistrés

#### Heure de début
- Choisissez l'heure de début (14:00, 14:30, 15:00, etc.)

#### Option : Ajouter un second lieu (split)

Pour les tournois répartis sur 2 clubs :
1. Cliquez sur **"+ Ajouter un second lieu (split)"**
2. Un deuxième sélecteur de lieu apparaît
3. Pour chaque poule, sélectionnez "Lieu 1" ou "Lieu 2"

### Navigation

- **Modifier la liste** : Revenir à l'étape 2 pour ajuster les joueurs
- **Générer le fichier Excel** : Créer le fichier de convocation

---

## Étape 4 : Génération du Fichier Excel

Après avoir cliqué sur **"Générer le fichier Excel"**, le fichier est automatiquement téléchargé.

### Contenu du fichier Excel

Le fichier généré contient **3 feuilles** :

#### Feuille 1 : Poules
- Composition de chaque poule
- Planning des matchs avec ordre de passage
- Colonnes pour noter les scores

#### Feuille 2 : Convocation (format classique)
- Liste des joueurs convoqués
- Informations sur le lieu et l'heure
- Format traditionnel

#### Feuille 3 : Convocation v2 (format moderne)
- Mise en page professionnelle
- Logo du club
- Informations détaillées
- Prêt à imprimer ou envoyer par email

### Nom du fichier

Le fichier est nommé automatiquement selon le format :
```
Poules_[CATEGORIE]_T[NUMERO]_[DATE].xlsx
```
Exemple : `Poules_3BANDES-N3_T2_06-12-2025.xlsx`

---

## Astuces et Bonnes Pratiques

### Avant le tournoi

1. **Mettez à jour les fichiers IONOS** la veille ou le matin du tournoi
2. **Vérifiez les forfaits** déclarés dans le système
3. **Préparez la liste des joueurs last minute** potentiels

### Pendant la sélection

1. **Utilisez les tournois à venir** pour gagner du temps
2. **Vérifiez le nombre de tables** disponibles dans votre club
3. **Ajustez les poules** si des joueurs du même club sont ensemble

### Après la génération

1. **Vérifiez le fichier Excel** avant impression
2. **Envoyez les convocations** aux joueurs si nécessaire
3. **Gardez une copie** du fichier pour l'arbitrage

---

## Questions Fréquentes

### Pourquoi un joueur n'apparaît-il pas dans la liste ?

Vérifiez que :
- Le joueur est bien inscrit dans IONOS
- Le fichier des inscriptions a été importé récemment
- Le joueur n'a pas été déclaré forfait

### Comment ajouter un joueur de dernière minute ?

Utilisez la section **"Ajout last minute"** :
1. Tapez son nom ou numéro de licence
2. Sélectionnez-le dans la liste
3. Cliquez sur "Ajouter"

### Comment gérer un tournoi sur 2 lieux ?

1. À l'étape 3, cliquez sur **"+ Ajouter un second lieu (split)"**
2. Sélectionnez les 2 clubs
3. Pour chaque poule, choisissez le lieu approprié

### Les données sont-elles sauvegardées ?

Non, la sélection des joueurs n'est pas sauvegardée entre les sessions. Vous devez refaire la sélection à chaque fois que vous générez un nouveau fichier.

---

*Guide utilisateur - Module Tournois à Jouer*
*CDBHS Tournois - Version 1.1*
*Mis à jour le 30 novembre 2025*
