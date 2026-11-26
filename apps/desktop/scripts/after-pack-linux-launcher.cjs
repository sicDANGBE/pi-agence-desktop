// electron-builder afterPack : sous Linux, remplace l'exécutable par un lanceur qui choisit
// le mode sandbox de Chromium avant le démarrage d'Electron.
//
// Pourquoi : sur Ubuntu ≥ 23.10, AppArmor interdit les user namespaces non privilégiés.
// Chromium retombe alors sur le helper SUID `chrome-sandbox`, qui ne peut pas être
// setuid-root dans une AppImage montée par l'utilisateur : l'app s'arrête au démarrage.
// Le lanceur garde la sandbox chaque fois qu'elle est disponible et ne la désactive que
// dans ce cas précis (sans root, il n'existe pas d'autre moyen de démarrer).
const { chmod, readFile, rename, writeFile } = require("node:fs/promises");
const path = require("node:path");

const MARKER = "# pi-agence-launcher";

function launcherScript(binaryName) {
  return `#!/bin/sh
${MARKER}
HERE=$(dirname "$(readlink -f "$0")")
BIN="$HERE/${binaryName}"

sandbox_usable() {
  # 1. user namespaces disponibles -> sandbox namespaces de Chromium
  if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" != "1" ] \\
    && [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)" != "0" ] \\
    && [ "$(cat /proc/sys/user/max_user_namespaces 2>/dev/null)" != "0" ]; then
    return 0
  fi
  # 2. helper SUID correctement installé (installation hors AppImage par un admin)
  if [ -u "$HERE/chrome-sandbox" ] && [ "$(stat -c %u "$HERE/chrome-sandbox" 2>/dev/null)" = "0" ]; then
    return 0
  fi
  # 3. profil AppArmor installé par l'admin (resources/linux/apparmor-pi-agence)
  if [ -r /etc/apparmor.d/pi-agence ]; then
    return 0
  fi
  return 1
}

if [ "\${PI_AGENCE_FORCE_SANDBOX:-0}" = "1" ] || sandbox_usable; then
  exec "$BIN" "$@"
fi

echo "pi-agence: sandbox Chromium indisponible (user namespaces restreints par AppArmor)." >&2
echo "pi-agence: démarrage avec --no-sandbox. Voir resources/linux/apparmor-pi-agence pour l'activer." >&2
exec "$BIN" --no-sandbox "$@"
`;
}

/** @param {import("app-builder-lib").AfterPackContext} context */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "linux") return;
  const executableName = context.packager.executableName;
  const exePath = path.join(context.appOutDir, executableName);
  const binaryName = `${executableName}.bin`;

  const head = await readFile(exePath).then((buffer) => buffer.subarray(0, 256).toString("latin1"));
  if (head.includes(MARKER)) return; // déjà en place (rebuild incrémental)

  await rename(exePath, path.join(context.appOutDir, binaryName));
  await writeFile(exePath, launcherScript(binaryName), { mode: 0o755 });
  await chmod(exePath, 0o755);
};

exports.launcherScript = launcherScript;
