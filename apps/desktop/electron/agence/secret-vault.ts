/**
 * Coffre de secrets local.
 *
 * - Les valeurs sont chiffrées au repos par un `SecretCipher` (en production : `safeStorage`
 *   d'Electron, adossé au trousseau du système).
 * - Le modèle ne voit jamais une valeur : il écrit `{{secret:nom}}` et la substitution a lieu
 *   dans le process main, au moment d'exécuter l'outil (`resolveReferences`).
 * - Toute sortie d'outil repasse par `redact` avant d'être renvoyée au modèle ou affichée.
 */
import { readFile } from "node:fs/promises";

import { writeFileAtomicQueued } from "../persistence/atomic-file-write";

export interface SecretCipher {
  encrypt(plain: string): Buffer;
  decrypt(encrypted: Buffer): string;
}

/** Sous-ensemble de `Electron.SafeStorage` utilisé ici (injecté pour rester testable). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
  getSelectedStorageBackend?(): string;
}

/**
 * Refuse le backend Linux « basic_text » (clé codée en dur, équivalent à du texte clair) :
 * sans trousseau système fonctionnel, le coffre reste fermé plutôt que de mentir sur la sécurité.
 */
export function createSafeStorageCipher(safeStorage: SafeStorageLike): SecretCipher {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Chiffrement indisponible : aucun trousseau système détecté.");
  }
  const backend = safeStorage.getSelectedStorageBackend?.();
  if (backend === "basic_text" || backend === "unknown") {
    throw new Error(
      `Trousseau système non sécurisé (${backend}). Installez/déverrouillez GNOME Keyring ou KWallet.`,
    );
  }
  return {
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (encrypted) => safeStorage.decryptString(encrypted),
  };
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REFERENCE_PATTERN = /\{\{secret:([a-z0-9][a-z0-9._-]{0,63})\}\}/g;
/** En dessous, masquer créerait trop de faux positifs ; on refuse plutôt de stocker. */
const MIN_SECRET_LENGTH = 6;

interface VaultFile {
  readonly version: 1;
  readonly secrets: Record<string, { readonly value: string; readonly updatedAt: string }>;
}

function decodeVaultFile(value: unknown): VaultFile {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { version?: unknown }).version !== 1 ||
    typeof (value as { secrets?: unknown }).secrets !== "object"
  ) {
    throw new Error("Fichier du coffre illisible");
  }
  return value as VaultFile;
}

export interface SecretSummary {
  readonly name: string;
  readonly updatedAt: string;
}

export interface ResolvedText {
  readonly text: string;
  readonly used: readonly string[];
}

export class SecretVault {
  private secrets = new Map<string, { value: string; updatedAt: string }>();
  private loaded = false;

  constructor(
    private readonly filePath: string,
    private readonly cipher: SecretCipher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.loaded = true;
        return;
      }
      throw error;
    }
    const file = decodeVaultFile(JSON.parse(raw));
    this.secrets = new Map(
      Object.entries(file.secrets).map(([name, entry]) => [
        name,
        {
          value: this.cipher.decrypt(Buffer.from(entry.value, "base64")),
          updatedAt: entry.updatedAt,
        },
      ]),
    );
    this.loaded = true;
  }

  list(): SecretSummary[] {
    this.assertLoaded();
    return [...this.secrets.entries()]
      .map(([name, entry]) => ({ name, updatedAt: entry.updatedAt }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  has(name: string): boolean {
    this.assertLoaded();
    return this.secrets.has(name);
  }

  async set(name: string, value: string): Promise<void> {
    this.assertLoaded();
    if (!NAME_PATTERN.test(name)) {
      throw new Error("Nom de secret invalide (a-z, 0-9, . _ -, 64 caractères max)");
    }
    if (value.length < MIN_SECRET_LENGTH) {
      throw new Error(`Un secret doit faire au moins ${MIN_SECRET_LENGTH} caractères`);
    }
    this.secrets.set(name, { value, updatedAt: this.now().toISOString() });
    await this.persist();
  }

  async delete(name: string): Promise<boolean> {
    this.assertLoaded();
    const removed = this.secrets.delete(name);
    if (removed) await this.persist();
    return removed;
  }

  /**
   * Remplace `{{secret:nom}}` par la valeur, uniquement pour les noms autorisés pour cet outil.
   * Une référence inconnue ou non autorisée fait échouer l'appel (pas de substitution partielle).
   */
  resolveReferences(text: string, allowed: ReadonlySet<string>): ResolvedText {
    this.assertLoaded();
    const used = new Set<string>();
    const resolved = text.replace(REFERENCE_PATTERN, (_match, name: string) => {
      if (!allowed.has(name)) throw new Error(`Secret non autorisé pour cet outil : ${name}`);
      const entry = this.secrets.get(name);
      if (!entry) throw new Error(`Secret inconnu : ${name}`);
      used.add(name);
      return entry.value;
    });
    return { text: resolved, used: [...used] };
  }

  /** Masque toute valeur connue (et ses formes base64/URL-encodées) dans un texte sortant. */
  redact(text: string): string {
    this.assertLoaded();
    let output = text;
    const entries = [...this.secrets.entries()].sort(
      (a, b) => b[1].value.length - a[1].value.length,
    );
    for (const [name, { value }] of entries) {
      for (const form of new Set([
        value,
        Buffer.from(value).toString("base64"),
        encodeURIComponent(value),
      ])) {
        output = output.split(form).join(`[secret:${name}]`);
      }
    }
    return output;
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error("Coffre non chargé");
  }

  private async persist(): Promise<void> {
    const file: VaultFile = {
      version: 1,
      secrets: Object.fromEntries(
        [...this.secrets.entries()].map(([name, entry]) => [
          name,
          {
            value: this.cipher.encrypt(entry.value).toString("base64"),
            updatedAt: entry.updatedAt,
          },
        ]),
      ),
    };
    await writeFileAtomicQueued(this.filePath, JSON.stringify(file), decodeVaultFile);
  }
}

/** Heuristique utilisée par la mémoire : refuse d'y écrire ce qui ressemble à un secret. */
export function looksLikeSecret(text: string): boolean {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return true;
  if (/\b(?:ghp|gho|github_pat|glpat|xox[abp]|sk|AKIA)[-_A-Za-z0-9]{12,}/.test(text)) return true;
  if (/\b(?:password|mot de passe|passwd|token|api[_ -]?key)\s*[:=]\s*\S{6,}/i.test(text))
    return true;
  return text.split(/\s+/).some((word) => word.length >= 24 && shannonEntropy(word) > 4.2);
}

function shannonEntropy(word: string): number {
  const counts = new Map<string, number>();
  for (const char of word) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / word.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}
