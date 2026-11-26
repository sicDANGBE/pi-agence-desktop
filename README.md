# Pi Agence

Assistant IA de bureau pour les collaborateurs de l'agence, basé sur l'agent
[Pi](https://pi.dev). Une fenêtre de conversation simple, sans terminal, avec l'historique des
échanges, des paramètres accessibles et des capacités métier (documents, mail, diagrammes,
tâches planifiées).

## Installation (sans droits administrateur)

1. Installer Pi : `curl -fsSL https://pi.dev/install.sh | sh`
2. Télécharger `pi-agence-<version>-x86_64.AppImage` depuis l'onglet **Releases**.
3. `chmod +x pi-agence-*.AppImage && ./pi-agence-*.AppImage`

Sur Ubuntu ≥ 23.10, AppArmor restreint les user namespaces : l'application démarre alors sans
sandbox Chromium et l'indique dans le terminal. Pour la réactiver sur un parc, l'admin déploie une
fois le profil fourni (`resources/linux/apparmor-pi-agence` dans l'AppImage) :

```bash
sudo install -m 644 apparmor-pi-agence /etc/apparmor.d/pi-agence
sudo apparmor_parser -r /etc/apparmor.d/pi-agence
```

## Fonctionnalités

| Domaine                                                                                 | État        |
| --------------------------------------------------------------------------------------- | ----------- |
| Conversations en cours et passées, paramètres, fournisseurs de modèles                  | ✅          |
| Espaces de travail distants via SSH                                                     | ✅          |
| Tâches planifiées (application ouverte)                                                 | ✅          |
| Configuration et prompt système centralisés et signés, contrôle des sorties réseau      | 🧱 socle    |
| Coffre de secrets (trousseau système)                                                   | 🧱 socle    |
| Daemon utilisateur (tâches même application fermée), démarrage à l'ouverture de session | 🧱 socle    |
| Connexion OIDC, carte à puce (PKCS#11)                                                  | 📐 spécifié |
| Documents LibreOffice, mail, diagrammes, Jira, mémoire, plugins et savoirs              | 📐 spécifié |

La spécification complète est dans [`docs/agence/SPEC.md`](docs/agence/SPEC.md).

## Développement

```bash
pnpm install
pnpm dev              # lance l'application en développement
pnpm typecheck
pnpm exec playwright test -c apps/desktop/playwright.config.ts apps/desktop/tests/unit/agence-
```

Architecture et règles du dépôt : [`docs/architecture.md`](docs/architecture.md),
[`AGENTS.md`](AGENTS.md).

## Publication

- Lancement manuel du workflow **Agence AppImage** → pré-release `nightly`.
- Tag `vX.Y.Z` → release stable.

## Licence

MIT — voir [`LICENSE`](LICENSE).
