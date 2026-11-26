/**
 * Intégration à la session de l'utilisateur, sans aucun droit root :
 *   - lancement à l'ouverture de session (XDG autostart) ;
 *   - daemon de tâches planifiées via un timer `systemd --user`.
 *
 * Tous les fichiers sont écrits sous le $HOME de l'utilisateur. Rien n'est jamais écrit
 * dans /etc ni /usr, et le daemon refuse de tourner en root.
 */
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const APP_ID = "pi-agence";

export function assertNotRoot(uid: number | undefined = process.getuid?.()): void {
  if (uid === 0) {
    throw new Error("Pi Agence ne doit pas être lancé en root : relancez-le depuis votre session.");
  }
}

/**
 * Chemin à lancer. Pour une AppImage, `process.execPath` pointe dans le montage temporaire
 * /tmp/.mount_* qui disparaît à la fermeture : il faut utiliser $APPIMAGE.
 */
export function resolveLaunchPath(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
): string {
  const appImage = env.APPIMAGE;
  if (appImage && appImage.startsWith("/")) return appImage;
  if (execPath.includes("/.mount_")) {
    throw new Error("AppImage détectée sans variable APPIMAGE : impossible de fixer le lanceur.");
  }
  return execPath;
}

/** Échappement pour la ligne Exec= d'un fichier .desktop / unité systemd. */
function quoteExec(path: string): string {
  if (/[\n\r]/.test(path)) throw new Error("Chemin d'exécutable invalide");
  return `"${path.replace(/(["\\`$])/g, "\\$1")}"`;
}

export function renderAutostartEntry(launchPath: string): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Pi Agence",
    "Comment=Assistant IA de l'agence (démarrage en arrière-plan)",
    `Exec=${quoteExec(launchPath)} --background`,
    "Icon=pi-agence",
    "X-GNOME-Autostart-enabled=true",
    "X-GNOME-Autostart-Delay=10",
    "NoDisplay=true",
    "",
  ].join("\n");
}

export interface DaemonUnitOptions {
  readonly launchPath: string;
  /** Fréquence de passage du daemon (il exécute seulement les tâches arrivées à échéance). */
  readonly everyMinutes: number;
}

export function renderSystemdUserUnits(options: DaemonUnitOptions): {
  readonly service: string;
  readonly timer: string;
} {
  if (
    !Number.isInteger(options.everyMinutes) ||
    options.everyMinutes < 1 ||
    options.everyMinutes > 1440
  ) {
    throw new Error("everyMinutes doit être un entier entre 1 et 1440");
  }
  const service = [
    "[Unit]",
    "Description=Pi Agence — exécution des tâches planifiées",
    "",
    "[Service]",
    "Type=oneshot",
    `ExecStart=${quoteExec(options.launchPath)} --daemon --run-due`,
    "Nice=10",
    // Pas de NoNewPrivileges/ProtectSystem ici : une AppImage se monte via fusermount (setuid),
    // que NoNewPrivileges casse, et ProtectSystem exige des user namespaces souvent absents.
    "",
  ].join("\n");
  const timer = [
    "[Unit]",
    "Description=Pi Agence — minuterie des tâches planifiées",
    "",
    "[Timer]",
    "OnStartupSec=2min",
    `OnUnitActiveSec=${options.everyMinutes}min`,
    "Persistent=true",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
  return { service, timer };
}

export interface UserIntegrationPaths {
  readonly autostartFile: string;
  readonly serviceFile: string;
  readonly timerFile: string;
}

export function userIntegrationPaths(
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env,
): UserIntegrationPaths {
  const configHome = env.XDG_CONFIG_HOME?.startsWith("/")
    ? env.XDG_CONFIG_HOME
    : join(homeDir, ".config");
  return {
    autostartFile: join(configHome, "autostart", `${APP_ID}.desktop`),
    serviceFile: join(configHome, "systemd", "user", `${APP_ID}-tasks.service`),
    timerFile: join(configHome, "systemd", "user", `${APP_ID}-tasks.timer`),
  };
}

export type SystemctlRunner = (
  args: readonly string[],
) => Promise<{ readonly ok: boolean; readonly output: string }>;

const defaultSystemctl: SystemctlRunner = (args) =>
  new Promise((resolve) => {
    execFile(
      "systemctl",
      ["--user", ...args],
      { encoding: "utf8", timeout: 15_000 },
      (error, stdout, stderr) => {
        resolve({ ok: error === null, output: `${stdout}${stderr}`.trim() });
      },
    );
  });

export interface InstallResult {
  readonly autostart: boolean;
  /** false si systemd --user est indisponible : les tâches ne tournent alors qu'app ouverte. */
  readonly daemon: boolean;
  readonly detail?: string;
}

export async function installUserIntegration(options: {
  readonly homeDir: string;
  readonly launchPath: string;
  readonly everyMinutes?: number;
  readonly enableDaemon: boolean;
  readonly systemctl?: SystemctlRunner;
  readonly env?: NodeJS.ProcessEnv;
  /** Injectable pour les tests ; par défaut l'uid du process. */
  readonly uid?: number;
}): Promise<InstallResult> {
  assertNotRoot(options.uid ?? process.getuid?.());
  const paths = userIntegrationPaths(options.homeDir, options.env);
  await mkdir(join(paths.autostartFile, ".."), { recursive: true });
  await writeFile(paths.autostartFile, renderAutostartEntry(options.launchPath), { mode: 0o644 });

  if (!options.enableDaemon) return { autostart: true, daemon: false };

  const systemctl = options.systemctl ?? defaultSystemctl;
  const units = renderSystemdUserUnits({
    launchPath: options.launchPath,
    everyMinutes: options.everyMinutes ?? 5,
  });
  await mkdir(join(paths.serviceFile, ".."), { recursive: true });
  await writeFile(paths.serviceFile, units.service, { mode: 0o644 });
  await writeFile(paths.timerFile, units.timer, { mode: 0o644 });

  const reload = await systemctl(["daemon-reload"]);
  if (!reload.ok) return { autostart: true, daemon: false, detail: reload.output };
  const enable = await systemctl(["enable", "--now", `${APP_ID}-tasks.timer`]);
  return enable.ok
    ? { autostart: true, daemon: true }
    : { autostart: true, daemon: false, detail: enable.output };
}

export async function uninstallUserIntegration(options: {
  readonly homeDir: string;
  readonly systemctl?: SystemctlRunner;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const paths = userIntegrationPaths(options.homeDir, options.env);
  const systemctl = options.systemctl ?? defaultSystemctl;
  await systemctl(["disable", "--now", `${APP_ID}-tasks.timer`]);
  await rm(paths.autostartFile, { force: true });
  await rm(paths.serviceFile, { force: true });
  await rm(paths.timerFile, { force: true });
  await systemctl(["daemon-reload"]);
}
