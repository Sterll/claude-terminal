# 🎭 Créer le GIF de la mascotte qui danse

## ✨ Résumé

Votre mascotte danse déjà dans l'application ! L'animation se trouve dans `styles.css` ligne 18349.

Voici comment créer un GIF de cette animation pour l'utiliser ailleurs (README, Discord, site web, etc.).

---

## 🚀 Méthode rapide (5 minutes)

### Étape 1 : Ouvrir la démo
La page `website/mascot-demo.html` vient de s'ouvrir dans votre navigateur ! Vous devriez voir la mascotte danser en 3 tailles différentes.

### Étape 2 : Télécharger ScreenToGif
1. Allez sur https://www.screentogif.com/
2. Téléchargez et installez (gratuit, open-source)
3. C'est l'outil parfait pour créer des GIF de qualité sur Windows

### Étape 3 : Enregistrer l'animation
1. Lancez ScreenToGif
2. Choisissez "Recorder"
3. Positionnez la fenêtre de capture sur la mascotte (version moyenne 64x64)
4. **Appuyez sur F7** pour commencer
5. Attendez 1-2 secondes
6. **Appuyez sur F8** pour arrêter

### Étape 4 : Éditer et exporter
Dans l'éditeur ScreenToGif :
1. **Supprimer** les frames du début et de la fin pour ne garder qu'un cycle propre
2. **Image** → **Resize** → Réglez à 64x64 ou 128x128
3. **Playback** → **Change speed** → Réglez à 150ms (ou 15 frames/100ms)
4. **Image** → **Crop** → Serrez l'image au plus près de la mascotte
5. **File** → **Save as** → Sauvegardez dans `assets/mascot-dance.gif`

**Paramètres recommandés :**
- ⏱️ Délai : 150ms par frame
- 🔄 Boucle : Forever (infini)
- 📐 Taille : 64x64px (peut aller jusqu'à 128x128)
- 🎨 Qualité : Haute

**Résultat attendu :**
- Taille du fichier : 10-30 KB
- Animation fluide qui boucle parfaitement
- Style pixel art préservé (pas de flou)

---

## 🔧 Méthode automatique (avec Node.js)

Si vous préférez générer le GIF via code :

```bash
# Option 1 : Avec sharp + gifwrap (recommandé)
npm install --save-dev sharp gifwrap
node scripts/generate-gif-from-svg.js

# Option 2 : Avec gif-encoder + canvas
npm install --save-dev gif-encoder-2 canvas
node scripts/create-mascot-gif-simple.js
```

⚠️ **Note** : `canvas` nécessite des dépendances natives (Python, Visual Studio Build Tools). Si ça échoue, utilisez la méthode manuelle.

---

## 📦 Fichiers disponibles

Voici ce qui a été créé pour vous :

```
assets/
├── claude-mascot.svg          # Mascotte statique
├── mascot-dance.svg           # SVG avec animation SMIL intégrée
└── mascot-dance.gif           # ← À CRÉER (c'est ce qu'on fait maintenant !)

website/
└── mascot-demo.html           # Page de démo (ouverte dans votre navigateur)

scripts/
├── create-mascot-animation.js       # Générateur de SVG animé + démo HTML
├── create-mascot-gif-simple.js      # Générateur GIF (méthode 1)
├── generate-gif-from-svg.js         # Générateur GIF (méthode 2)
├── generate-mascot-gif.js           # Générateur GIF (méthode 3)
├── mascot-dance-gif.html            # Template HTML pour Puppeteer
└── quick-gif-maker.md               # Guide détaillé
```

---

## 🎨 Caractéristiques de l'animation

```css
@keyframes mascot-dance {
  0%, 100% { transform: translateY(0) rotate(0deg); }
  25% { transform: translateY(-3px) rotate(-8deg); }
  50% { transform: translateY(0) rotate(0deg); }
  75% { transform: translateY(-3px) rotate(8deg); }
}
```

- **Durée** : 0.6 secondes par cycle
- **Mouvement** : Haut/bas sur 3 pixels
- **Rotation** : -8° à +8°
- **Style** : Pixel art (image-rendering: pixelated)
- **Boucle** : Infinie

---

## ✅ Vérification

Une fois le GIF créé, vérifiez :

```bash
# Taille du fichier
ls -lh assets/mascot-dance.gif

# Tester dans un README
echo "![Mascot](./assets/mascot-dance.gif)" > test.md
```

Le GIF devrait :
- ✅ Faire moins de 50 KB
- ✅ Boucler de manière fluide
- ✅ Durer ~0.6s par cycle
- ✅ Être net (pixels bien définis)
- ✅ Avoir un fond transparent (si possible)

---

## 🎯 Utilisations possibles

Une fois le GIF créé, vous pourrez l'utiliser :

- **GitHub README** : `![Claude mascot](./assets/mascot-dance.gif)`
- **Discord/Slack** : Upload direct (les SVG animés ne marchent pas là)
- **Site web** : `<img src="mascot-dance.gif" width="64">`
- **Emails** : Support GIF quasi-universel
- **Documentation** : Rend la doc plus vivante !

---

## 🆘 Besoin d'aide ?

### Le GIF est trop lourd
- Réduisez la taille (32x32 ou 48x48)
- Gardez moins de frames (seulement les keyframes)
- Compressez avec https://ezgif.com/optimize

### Le GIF est flou
- Assurez-vous d'utiliser "nearest neighbor" lors du resize
- Pas d'antialiasing !
- Capturez directement à la bonne taille

### L'animation saccade
- Augmentez le nombre de frames
- Vérifiez que le délai est constant (150ms)
- Capturez plus longtemps pour avoir plus de frames

---

## 🎉 C'est tout !

Vous avez maintenant tout ce qu'il faut pour créer votre GIF. La page de démo est déjà ouverte dans votre navigateur.

**Temps estimé** : 5 minutes avec ScreenToGif

**Résultat** : Une mascotte adorable qui danse en GIF ! 🕺

Bon courage ! 💪
