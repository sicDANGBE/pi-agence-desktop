# Pi Agence — spécification

Objectif : un assistant IA de bureau, façon Claude Desktop, pour **tous** les collaborateurs de
l'agence, y compris les non techniciens. Distribution en **AppImage** installée dans la session de
l'utilisateur, **sans sudo**.

## 1. Principes

1. **Aucun terminal visible** pour l'utilisateur standard. Le mode « développeur » (terminal, diff,
   worktrees) reste disponible mais masqué par défaut et activable par politique.
2. **Tout tourne en utilisateur, jamais en root.** Le daemon refuse de démarrer si `uid == 0`.
3. **L'agence garde la main** : configuration, prompt système, sorties réseau autorisées, plugins et
   savoirs sont fournis par un serveur de configuration signé.
4. **Les secrets ne passent jamais par le modèle.** L'agent manipule des références, pas des valeurs.
5. **Rester fin au-dessus de Pi** : on ajoute des extensions Pi et des
   owners Electron, on ne réécrit pas le runtime.

## 2. Interface

| Zone           | Contenu                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------- |
| Barre latérale | Conversations en cours / passées (recherche, épingles, archives), tâches planifiées          |
| Centre         | Fil de conversation, pièces jointes, aperçu des documents et diagrammes générés              |
| Bouton ⚙️      | Paramètres simples : compte, modèle (si autorisé), mail, coffre de secrets, mémoire, plugins |
| Barre système  | Icône persistante ; notifications ; briefing du matin                                        |

## 3. Modules métier (extensions Pi)

| Module     | Outils exposés à l'agent                                                               | Implémentation                                                                                    |
| ---------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Documents  | `doc_create` (odt/ods/odp), `doc_convert` (→ pdf/docx), modèles de l'agence            | `soffice --headless` fourni par le poste ; repli `odf-kit` en JS si absent                        |
| Mail       | `mail_search`, `mail_read`, `mail_draft`, `mail_send` (validation humaine obligatoire) | IMAP (`imapflow`) / SMTP (`nodemailer`), comptes configurés dans ⚙️, mots de passe dans le coffre |
| Diagrammes | `diagram_render` (Mermaid → SVG/PNG), export draw.io                                   | Rendu dans le renderer, export fichier                                                            |
| Jira       | `jira_list_my_issues`, `jira_get`, `jira_comment`                                      | API REST Jira, jeton dans le coffre (MCP en phase 4)                                              |
| Machines   | sessions SSH                                                                           | hôtes depuis `~/.ssh/config`, clés via l'agent SSH, jamais copiées                                |

## 4. Tâches planifiées et daemon

L'application sait déjà planifier (`once`, `daily`, `weekly`, `interval`) mais **seulement application
ouverte**. On ajoute :

- **Déclencheur `at-login`** : nouvelle variante de `ScheduledTaskSchedule`, exécutée une fois par
  ouverture de session (cas d'usage : briefing réunions + mails sans réponse + tickets Jira).
- **Lancement à l'ouverture de session** : fichier `~/.config/autostart/pi-agence.desktop` qui
  démarre l'app réduite dans la barre système (`--background`).
- **Daemon utilisateur** (`pi-agence --daemon`) piloté par un **timer `systemd --user`**
  (`~/.config/systemd/user/`), pour les tâches marquées « même application fermée ». Le daemon :
  - refuse de tourner en root ; ne demande jamais d'élévation ;
  - lit le même `scheduled-tasks.json` (verrou de fichier : un seul exécuteur à la fois) ;
  - exécute la tâche en session Pi headless isolée avec la liste d'outils de la tâche ;
  - notifie via `notify-send`/D-Bus et dépose le compte rendu dans l'historique.
- Si `systemd --user` est indisponible, repli silencieux sur le mode « application ouverte ».

## 5. Mémoire

Choix : **`pi-memory` (jayzeng, MIT)**, l'extension la plus utilisée : `MEMORY.md` curée, journaux
quotidiens, recherche hybride (BM25 + vecteurs) via `qmd`, injection sélective dans le contexte.
Ajouts de Pi Agence :

- **Validation par l'utilisateur** : une préférence détectée (« écris mes mails en vouvoyant »,
  « je suis les tickets du projet X ») est proposée en _carte à valider_ avant écriture durable,
  comme dans `pi-persistent-intelligence`.
- **Écran Mémoire** dans ⚙️ : lire, modifier, supprimer chaque fait.
- **Interdits** : aucun secret, mot de passe ou jeton n'est mémorisable ; un filtre rejette les
  écritures qui ressemblent à un secret (motifs + entropie).

## 6. Coffre de secrets

- Stockage chiffré local via `safeStorage` d'Electron (clé dans le trousseau système : libsecret /
  GNOME Keyring / KWallet). Option **OpenBao/Vault** côté agence pour les secrets partagés.
- L'agent ne voit que des **références** `{{secret:nom}}`. La substitution a lieu au moment de
  l'exécution de l'outil, dans le process main, jamais dans le prompt.
- **Masquage en sortie** : toute valeur de secret apparaissant dans une sortie d'outil est
  remplacée par `[secret:nom]` avant d'être renvoyée au modèle ou affichée.
- Chaque outil déclare les secrets qu'il peut demander ; la première utilisation demande l'accord.

## 7. Configuration centralisée (serveur de l'agence)

L'app récupère au démarrage (puis toutes les heures) un **bundle de configuration** :

```json
{
  "version": 1,
  "issuedAt": "2026-11-26T20:00:00Z",
  "expiresAt": "2026-12-03T20:00:00Z",
  "systemPrompt": "Tu es l'assistant de l'agence…",
  "egress": {
    "mode": "allowlist",
    "hosts": ["llm.agence.fr", "*.atlassian.net", "imap.agence.fr"]
  },
  "models": { "allowed": ["agence/mistral-large"], "default": "agence/mistral-large" },
  "packages": ["npm:pi-memory", "git:https://git.agence.fr/pi/plugins-agence.git"],
  "knowledge": [{ "id": "procedures", "url": "https://kb.agence.fr/procedures.zip" }],
  "features": { "developerMode": false }
}
```

- Le bundle est **signé Ed25519** ; la clé publique est embarquée dans l'AppImage (ou déposée par
  l'admin). Bundle non signé, mal signé ou expiré → rejet, on garde la dernière version valide.
- **Prompt système** : préfixé au prompt de Pi, non modifiable par l'utilisateur.
- **Contrôle des sorties réseau** : tout appel HTTP des outils de l'app passe par un garde
  d'egress (liste d'hôtes autorisés). Limite assumée : un outil `bash` peut contourner ce garde ; il
  est donc **désactivé par défaut** pour les profils non développeurs, et la vraie barrière reste le
  pare-feu/proxy de l'agence.

## 7 bis. Authentification : OIDC et PKCS#11

**OIDC (prioritaire)** — l'app est un client public natif (RFC 8252) :

- _Authorization Code + PKCE_ dans le **navigateur système** (jamais une webview), redirection sur
  `http://127.0.0.1:<port aléatoire>/callback`, `state` + `nonce` vérifiés, pas de client secret.
- Découverte via `/.well-known/openid-configuration` ; jetons validés (signature JWKS, `iss`, `aud`,
  `exp`). Refresh token conservé dans le coffre (§6), rotation à chaque usage.
- L'access token authentifie l'app auprès du serveur de configuration (§7) : le bundle (prompt,
  egress, plugins, savoirs) peut être **différent par groupe** (claims `groups`/`roles`).
- Écran de connexion au premier lancement ; verrouillage de l'app à l'expiration de session.

**PKCS#11 (carte à puce / jeton matériel)** — deux niveaux, cumulables :

1. **Au niveau de l'IdP (recommandé)** : Keycloak (ou équivalent) fait l'authentification par
   certificat X.509 de la carte, dans le navigateur système. L'app ne fait que de l'OIDC et
   hérite de la carte sans code natif.
2. **Dans l'app** : mTLS vers le serveur de configuration avec le certificat de la carte. Chromium
   lit les jetons via la base NSS utilisateur (`~/.pki/nssdb`, module ajouté par `modutil`, sans
   root) ; l'app choisit le certificat via l'événement `select-client-certificate`. Option
   ultérieure : signature d'un défi par la clé de la carte (`pkcs11js`) pour déverrouiller le
   coffre, le PIN étant saisi dans un dialogue natif et jamais transmis au modèle.

## 8. Bibliothèques de plugins et savoirs

- **Plugins** = paquets Pi (`extensions`, `skills`, `prompts`) publiés sur un dépôt Git ou un
  registre npm interne. Catalogue dans ⚙️ → Plugins, filtré par la liste du bundle.
- **Savoirs** = skills Pi « métier » (procédures, modèles de documents, glossaire, contacts) +
  index RAG local sur la documentation interne, synchronisés depuis le serveur.

## 9. MCP et capacités (phase 4)

Pi n'intègre pas MCP nativement ; on évaluera un pont MCP (cf. `@shog-lab/pi-toolkit`) contre des
extensions Pi natives. Critères : contrôle des secrets, egress, validation humaine, coût en tokens.

## 10. Feuille de route

| Phase | Contenu                                                                    | Critère de sortie                                   |
| ----- | -------------------------------------------------------------------------- | --------------------------------------------------- |
| 0     | Base + build AppImage en CI                                                | AppImage téléchargeable dans les Releases           |
| 1     | Socle sécurité : config signée, garde d'egress, coffre, daemon/autostart   | Tests unitaires verts ; démarrage sans sudo vérifié |
| 2     | Interface simplifiée (mode non développeur), ⚙️, écran Mémoire, `at-login` | Un non-technicien fait un briefing sans aide        |
| 3     | Modules Documents, Mail, Diagrammes, Jira                                  | Démo bout en bout sur un poste de l'agence          |
| 4     | Catalogue plugins/savoirs, MCP                                             | Plugin interne installé depuis le catalogue         |

## 11. Organisation du code

Les ajouts vivent dans `apps/desktop/electron/agence/` (process main uniquement) et sont testés
dans `apps/desktop/tests/unit/agence-*.spec.ts`. Ils ne modifient pas les owners existants tant que
leur branchement n'est pas fait (phase 1 → 2).
