# 📄 Guide des formats CSV

Ce document explique les formats CSV attendus par l'application.

## 📋 Format du fichier JOUEURS.csv

### Structure

Le fichier doit contenir les colonnes suivantes (séparées par des virgules) :

```
Licence,Club,Prénom,Nom,Classement_Libre,Classement_Cadre,Classement_Bande,Classement_3Bandes,[colonne_9],[colonne_10],Actif
```

### Exemple

```csv
"113957 Z","BILLARD BOIS COLOMBES","MICHEL","HOLIVE","R2","R1","N3","NC","624","1","1"
"152971 Y","BILLARD BOIS COLOMBES","JEAN FRANCOIS","MAYET","R3","R1","R1","NC","628","1","1"
"013901 R","BILLARD BOIS COLOMBES","ALAIN","PERIER","R2","R1","R1","NC","629","1","1"
```

### Description des colonnes

1. **Licence** (obligatoire) : Numéro de licence unique du joueur (ex: "113957 Z")
2. **Club** (optionnel) : Nom du club (ex: "BILLARD BOIS COLOMBES")
3. **Prénom** (obligatoire) : Prénom du joueur
4. **Nom** (obligatoire) : Nom du joueur
5. **Classement_Libre** : Classement en LIBRE (R1, R2, R3, R4, N3, NC, Master)
6. **Classement_Cadre** : Classement en CADRE
7. **Classement_Bande** : Classement en BANDE
8. **Classement_3Bandes** : Classement en 3 BANDES
9. **Colonne 9** : (ignorée par l'application)
10. **Colonne 10** : (ignorée par l'application)
11. **Actif** (obligatoire) : "1" = actif, "0" = inactif

### Notes importantes

- Les champs doivent être entre guillemets doubles si ils contiennent des espaces
- Utilisez "NC" (Non Classé) pour les joueurs sans classement dans une catégorie
- Le fichier doit être encodé en UTF-8
- La première ligne peut être un en-tête (elle sera ignorée si elle contient "Licence")

---

## 🏆 Format du fichier RÉSULTATS DE TOURNOI.csv

### Structure

Le fichier doit contenir les colonnes des résultats d'un tournoi :

```
Classement,Licence,Joueur,Nb_Matchs,Points_Match,Moyenne,?,Série,...
```

### Exemple

```csv
"Classt général","Licence","Joueur","Nbre matchs","Pts match","Taux victoire","Moyenne (3. Points (3.10)","Reprises","Série"
"1","120639Z","HELLAL DENIS","2","4","100","0,651","43","66"
"2","125423Z","ARCOPINTO GIOVANNI","2","4","100","0,425","43","101"
"3","012567J","BERTHOMIER JACQUES","2","4","100","0,421","43","102"
```

### Description des colonnes importantes

1. **Classement** : Position dans le tournoi (ignorée - recalculée automatiquement)
2. **Licence** (obligatoire) : Numéro de licence du joueur
3. **Joueur** (obligatoire) : Nom complet du joueur
4. **Nb_Matchs** : Nombre de matchs joués (utilisé pour information)
5. **Points_Match** (obligatoire) : Points de match obtenus
   - Victoire = 2 points
   - Égalité = 1 point
   - Défaite = 0 point
6. **Moyenne** (obligatoire) : Moyenne du joueur (nombre de points / nombre de tirs)
   - Format : décimal avec point ou virgule (ex: 0,651 ou 0.651)
7. **Série** (obligatoire) : Meilleure série réalisée

### Notes importantes

- La première ligne (en-têtes) peut contenir n'importe quel texte, elle sera ignorée
- Les lignes contenant "Classt" ou "Licence" dans la première colonne sont ignorées
- Le format de la moyenne peut être avec virgule (0,651) ou point (0.651)
- Les guillemets doubles autour des valeurs sont optionnels mais recommandés

---

## 🎯 Valeurs des classements

Les classements acceptés sont :

- **NC** : Non Classé
- **R4** : Régional 4
- **R3** : Régional 3
- **R2** : Régional 2
- **R1** : Régional 1
- **N3** : National 3
- **N3GC** : National 3 Grande Canne (LIBRE uniquement)
- **N2** : National 2
- **N1** : National 1
- **Master** : Master

---

## ✅ Vérification avant import

Avant d'importer vos fichiers, vérifiez que :

1. ✅ Le fichier est au format CSV (pas Excel .xlsx)
2. ✅ Le séparateur est la virgule (,)
3. ✅ L'encodage est UTF-8
4. ✅ Les licences sont présentes et uniques
5. ✅ Les noms des joueurs sont renseignés
6. ✅ Les valeurs numériques sont cohérentes

---

## 🔄 Conversion Excel → CSV

Si vos fichiers sont en Excel (.xlsx) :

1. Ouvrez le fichier dans Excel
2. Cliquez sur "Fichier" → "Enregistrer sous"
3. Choisissez le format "CSV UTF-8 (délimité par des virgules) (.csv)"
4. Enregistrez

---

## ❓ Problèmes courants

### "Erreur lors de l'import"

- Vérifiez que le fichier est bien au format CSV
- Vérifiez l'encodage (UTF-8)
- Vérifiez que les colonnes obligatoires sont présentes

### "Joueur non trouvé"

- Assurez-vous d'avoir importé le fichier JOUEURS.csv avant d'importer les tournois
- Vérifiez que les licences dans le fichier tournoi correspondent aux licences des joueurs

### "Caractères mal affichés"

- Le fichier n'est probablement pas en UTF-8
- Réenregistrez-le avec l'encodage UTF-8

---

## 📞 Besoin d'aide ?

Consultez le fichier README.md pour plus d'informations ou le guide d'utilisation complet.
