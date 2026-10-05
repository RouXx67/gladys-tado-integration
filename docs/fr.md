# tado° pour Gladys Assistant (Français)

Connectez vos équipements **tado°** de chauffage et de climatisation à Gladys
Assistant directement, **sans Home Assistant**. Cette intégration tourne dans
un conteneur Docker cloisonné, communique avec l'API hôte de Gladys via le SDK
officiel et avec tado° via son API REST publique.

## Vue d'ensemble

- Découverte de vos **logements** et **zones**, puis publication d'un appareil
  Gladys par zone (thermostat ou climatiseur), avec température mesurée,
  humidité, température de consigne, mode et état de fonctionnement.
- **Pilotage** depuis l'interface Gladys : consigne de température, mode
  (Éteint / Programme / Manuel) et marche/arrêt du climatiseur.
- **Uniquement cloud** : tout passe par l'API cloud tado°. Le conteneur
  n'expose **aucun port entrant** et ne reçoit jamais de trafic entrant.

## Compatibilité et limites

| Cible                                                   | Pris en charge |
| ------------------------------------------------------- | -------------- |
| tado° classique (thermostat intelligent V2/V3)          | **Oui**        |
| Climatiseur / pompe à chaleur tado° (V3)                | **Oui**        |
| tado° X (`LINE_X`)                                      | **Non**        |
| Zones d'eau chaude sanitaire                            | Relevés remontés, pilotage non exposé dans cette version |

tado° X utilise une API **différente** (`hops.tado.com`, « Rooms » au lieu de
« Zones ») et n'est pas implémentée ici : les points d'API classiques
`my.tado.com/api/v2` ne la couvrent pas entièrement. L'intégration officielle
Home Assistant fait le même choix (tado° X impose Matter). Un logement
`tado° X` est détecté automatiquement puis ignoré, avec un avertissement dans
les journaux. Le périmètre est volontairement limité à ce qui est vérifiable et
exécutable de façon fiable.

**Limites de requêtes.** tado° limite son API à **100 requêtes/jour** sur les
comptes gratuits et **20 000/jour** pour les abonnés, avec remise à zéro vers
12:00 (Europe/Berlin). L'intégration lit le budget restant dans les en-têtes de
réponse et adapte l'intervalle de sondage pour rester dans votre quota.
Choisissez des intervalles prudents sur une offre gratuite.

## Prérequis

- Gladys Assistant **4.86 ou supérieur** (pour le champ de configuration
  `account_link`).
- Un **compte tado°**. La connexion utilise le flux OAuth2 *device-code* :
  vous l'approuvez dans votre navigateur ou dans l'application tado°. Le flux
  identifiant/mot de passe n'existe plus.

## Installation

Une intégration installée est simplement une image Docker publiée + un
manifeste. À faire une fois, ensuite chaque Gladys peut l'installer en un clic
depuis le catalogue.

1. Créez un dépôt GitHub à partir de ce projet (ou poussez-le sur le vôtre).
2. Mettez à jour `docker_image` dans `gladys-assistant-integration.json` avec
   votre référence `ghcr.io/...` (par défaut :
   `ghcr.io/rouxx67/gladys-tado-integration:1.0.1`).
3. Poussez un tag (ex. `v1.0.0`). GitHub Actions exécute les tests puis
   construit une image multi-architectures vers le registre de conteneurs
   GitHub.
4. Dans Gladys : **Intégrations** → recherchez **tado°** → **Installer**.

Installation manuelle :
`docker build -t ghcr.io/rouxx67/gladys-tado-integration:1.0.1 .`
et poussez le tag correspondant à votre manifeste.

## Configuration

Dans l'écran Gladys **Intégrations → tado° → Configuration** :

1. Cliquez sur **Lier mon compte tado°**. Gladys ouvre l'URL de connexion
   tado°, approuvez-la dans votre navigateur/app. L'intégration interroge
   jusqu'à validation et ne stocke qu'un jeton de rafraîchissement (via le
   stockage sécurisé de configuration de Gladys).
2. Ajustez si besoin les intervalles :
   - **Intervalle de sondage actif** (minutes) : utilisé tant qu'une zone
     chauffe/refroidit. Défaut `15`.
   - **Intervalle de sondage au repos** (minutes) : utilisé quand tout est au
     repos. Défaut `60`.
   - **Type de consigne manuelle** : la commande dure jusqu'à modification
     (`MANUAL`) ou jusqu'au prochain bloc du programme (`NEXT_TIME_BLOCK`).

Puis ouvrez **Découverte** et lancez un scan. Gladys affiche les appareils
découverts ; créez ceux que vous voulez.

## Commandes utilisables (scènes / tableau de bord)

- **Consigne de température** — pose un hold manuel.
- **Mode** — `Éteint`, `Programme` (suivre le programme tado°), `Manuel`.
- **Marche/arrêt du climatiseur** (climatiseurs).

La température et l'humidité sont des capteurs en lecture seule ; l'état
indique si l'équipement fonctionne actuellement.

## Dépannage

- **« Liez votre compte en premier. »** — terminez l'étape 1 de la
  Configuration.
- **Aucun appareil affiché.** — lancez un scan de Découverte ; vérifiez que la
  zone tado° n'est pas une zone d'eau chaude (pilotage non exposé dans cette
  version).
- **« limite atteinte » / mises à jour lentes.** — vous êtes probablement sur
  l'offre gratuite. Augmentez les intervalles ou abonnez-vous (Auto-Assist).
- **Un logement `tado° X` est ignoré.** — normal : tado° X n'est pas pris en
  charge. Utilisez l'intégration Matter de Gladys.

## Développer et tester

- `npm ci` — installation (Node.js ≥ 20).
- `npm test` — exécute les tests unitaires. Ils utilisent des **réponses tado°
  simulées**, ne nécessitent **aucun identifiant** et **aucun appel réseau**.
- Construction :
  `docker build -t ghcr.io/rouxx67/gladys-tado-integration:1.0.1 .`

## Sécurité

Aucun port entrant. Utilisateur non privilégié, système de fichiers racine en
lecture seule, un seul volume `/data` en écriture. Aucune dépendance à Home
Assistant. Jetons uniquement via le stockage sécurisé de configuration de
Gladys.