# 🎭 Mascotte Claude Terminal - Animation

Ce dossier contient la mascotte de Claude Terminal et ses animations.

## Fichiers disponibles

- `claude-mascot.svg` - Mascotte statique (14x14 pixels, style pixel art)
- `mascot-dance.svg` - Mascotte avec animation SMIL intégrée (SVG animé)
- `mascot-dance.gif` - Animation GIF (à générer)

## Voir l'animation

Ouvrez `website/mascot-demo.html` dans votre navigateur pour voir la mascotte danser en différentes tailles.

## Générer le GIF

### Option 1 : Avec sharp et gifwrap (recommandé)

```bash
npm install sharp gifwrap
node scripts/generate-gif-from-svg.js
```

### Option 2 : Avec gif-encoder-2 et canvas

```bash
npm install gif-encoder-2 canvas
node scripts/create-mascot-gif-simple.js
```

### Option 3 : Capture d'écran manuelle (plus simple)

1. Ouvrez `website/mascot-demo.html` dans votre navigateur
2. Utilisez un outil de capture GIF :
   - **Windows** : [ScreenToGif](https://www.screentogif.com/) (gratuit, excellent)
   - **macOS** : [Gifski](https://gif.ski/) ou [Kap](https://getkap.co/)
   - **Multi-plateforme** : [LICEcap](https://www.cockos.com/licecap/)
3. Enregistrez pendant 0.6 secondes (1 cycle complet)
4. Configurez en boucle infinie
5. Exportez vers `assets/mascot-dance.gif`

## Paramètres de l'animation

- **Durée** : 0.6s par cycle
- **FPS** : 30 FPS recommandé
- **Frames clés** :
  - 0% : Y=0px, Rotation=0°
  - 25% : Y=-3px, Rotation=-8°
  - 50% : Y=0px, Rotation=0°
  - 75% : Y=-3px, Rotation=8°
  - 100% : Y=0px, Rotation=0°
- **Boucle** : Infinie
- **Taille recommandée** : 64x64px ou 128x128px

## Code CSS

L'animation est utilisée dans `styles.css` (ligne 18349) :

```css
.chat-thinking-logo {
  width: 16px;
  height: 16px;
  image-rendering: pixelated;
  animation: mascot-dance 0.6s ease-in-out infinite;
}

@keyframes mascot-dance {
  0%, 100% { transform: translateY(0) rotate(0deg); }
  25% { transform: translateY(-3px) rotate(-8deg); }
  50% { transform: translateY(0) rotate(0deg); }
  75% { transform: translateY(-3px) rotate(8deg); }
}
```

## Utilisation du SVG animé

Le fichier `mascot-dance.svg` peut être utilisé directement :

```html
<img src="assets/mascot-dance.svg" width="64" height="64" alt="Mascotte qui danse">
```

Parfait pour :
- README GitHub
- Documentation
- Sites web
- Emails HTML

⚠️ **Note** : Les SVG animés avec SMIL ne fonctionnent pas partout (pas sur Discord, Slack, etc.). Utilisez le GIF pour ces plateformes.
