import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

import { createEgressGuard, createGuardedFetch } from "../../electron/agence/egress-guard";
import { loadManagedConfig, openSignedConfig } from "../../electron/agence/managed-config";
import {
  createSafeStorageCipher,
  looksLikeSecret,
  SecretVault,
  type SecretCipher,
} from "../../electron/agence/secret-vault";
import {
  assertNotRoot,
  installUserIntegration,
  renderAutostartEntry,
  renderSystemdUserUnits,
  resolveLaunchPath,
} from "../../electron/agence/user-daemon";

const NOW = new Date("2026-11-26T20:00:00Z");

function bundle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    issuedAt: "2026-11-26T19:00:00Z",
    expiresAt: "2026-12-03T19:00:00Z",
    systemPrompt: "Tu es l'assistant de l'agence.",
    egress: { mode: "allowlist", hosts: ["llm.agence.fr", "*.atlassian.net"] },
    models: { allowed: ["agence/mistral"], default: "agence/mistral" },
    packages: ["npm:pi-memory"],
    knowledge: [{ id: "procedures", url: "https://kb.agence.fr/p.zip" }],
    features: { developerMode: false },
    ...overrides,
  };
}

function keys(): {
  publicKeyPem: string;
  seal: (value: unknown) => { payload: string; signature: string };
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    seal: (value) => {
      const payload = Buffer.from(JSON.stringify(value));
      return {
        payload: payload.toString("base64"),
        signature: sign(null, payload, privateKey).toString("base64"),
      };
    },
  };
}

test.describe("garde d'egress", () => {
  const guard = createEgressGuard({
    mode: "allowlist",
    hosts: ["llm.agence.fr", "*.atlassian.net", "git.agence.fr:8443"],
  });

  test("autorise les hôtes listés et refuse le reste", () => {
    expect(guard.check("https://llm.agence.fr/v1/chat").allowed).toBe(true);
    expect(guard.check("https://agence.atlassian.net/rest").allowed).toBe(true);
    expect(guard.check("https://atlassian.net/").allowed).toBe(false);
    expect(guard.check("https://evil-llm.agence.fr.attacker.io/").allowed).toBe(false);
    expect(guard.check("https://git.agence.fr:8443/x").allowed).toBe(true);
    expect(guard.check("https://git.agence.fr/x").allowed).toBe(false);
  });

  test("exige https sauf en boucle locale et refuse les identifiants dans l'URL", () => {
    expect(guard.check("http://llm.agence.fr/").allowed).toBe(false);
    expect(createEgressGuard({ mode: "deny-all" }).check("http://localhost:11434/v1").allowed).toBe(
      false,
    );
    expect(createEgressGuard({ mode: "open" }).check("http://localhost:11434/v1").allowed).toBe(
      true,
    );
    expect(createEgressGuard({ mode: "open" }).check("https://user:pw@example.com/").allowed).toBe(
      false,
    );
  });

  test("bloque une redirection vers un hôte non autorisé", async () => {
    const fakeFetch = (() =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { location: "https://exfil.example/" } }),
      )) as typeof fetch;
    const guarded = createGuardedFetch(guard, fakeFetch);
    await expect(guarded("https://llm.agence.fr/")).rejects.toThrow(/Redirection bloquée/);
    await expect(guarded("https://exfil.example/")).rejects.toThrow(/Sortie réseau bloquée/);
  });
});

test.describe("configuration signée", () => {
  test("accepte un bundle correctement signé", () => {
    const { publicKeyPem, seal } = keys();
    const config = openSignedConfig(seal(bundle()), publicKeyPem, NOW);
    expect(config.systemPrompt).toContain("agence");
    expect(config.egress).toEqual({
      mode: "allowlist",
      hosts: ["llm.agence.fr", "*.atlassian.net"],
    });
  });

  test("refuse une signature d'une autre clé, un payload modifié ou un bundle expiré", () => {
    const a = keys();
    const b = keys();
    expect(() => openSignedConfig(b.seal(bundle()), a.publicKeyPem, NOW)).toThrow(/signature/);
    const sealed = a.seal(bundle());
    const tampered = {
      ...sealed,
      payload: Buffer.from(JSON.stringify(bundle({ egress: { mode: "open" } }))).toString("base64"),
    };
    expect(() => openSignedConfig(tampered, a.publicKeyPem, NOW)).toThrow(/signature/);
    expect(() =>
      openSignedConfig(a.seal(bundle({ expiresAt: "2026-11-01T00:00:00Z" })), a.publicKeyPem, NOW),
    ).toThrow(/expiré/);
    expect(() =>
      openSignedConfig(
        a.seal(bundle({ models: { allowed: ["x"], default: "y" } })),
        a.publicKeyPem,
        NOW,
      ),
    ).toThrow(/models.default/);
  });

  test("retombe sur le dernier bundle valide si le serveur échoue", async () => {
    const { publicKeyPem, seal } = keys();
    const dir = await mkdtemp(join(tmpdir(), "agence-config-"));
    try {
      const cachePath = join(dir, "managed-config.json");
      const ok = (() => Promise.resolve(Response.json(seal(bundle())))) as typeof fetch;
      const down = (() => Promise.reject(new Error("réseau coupé"))) as typeof fetch;
      const url = "https://config.agence.fr/bundle.json";
      expect(
        (await loadManagedConfig({ url, publicKeyPem, cachePath, fetchImpl: ok, now: () => NOW }))
          .source,
      ).toBe("server");
      const fallback = await loadManagedConfig({
        url,
        publicKeyPem,
        cachePath,
        fetchImpl: down,
        now: () => NOW,
      });
      expect(fallback.source).toBe("cache");
      const forged = (() =>
        Promise.resolve(
          Response.json(keys().seal(bundle({ egress: { mode: "open" } }))),
        )) as typeof fetch;
      const rejected = await loadManagedConfig({
        url,
        publicKeyPem,
        cachePath,
        fetchImpl: forged,
        now: () => NOW,
      });
      expect(rejected.source).toBe("cache");
      expect(await readFile(cachePath, "utf8")).not.toContain("open");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test.describe("coffre de secrets", () => {
  const xorCipher: SecretCipher = {
    encrypt: (plain) => Buffer.from([...Buffer.from(plain)].map((byte) => byte ^ 0x5a)),
    decrypt: (data) => Buffer.from([...data].map((byte) => byte ^ 0x5a)).toString(),
  };

  test("chiffre au repos, résout les références autorisées et masque les sorties", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agence-vault-"));
    try {
      const file = join(dir, "vault.json");
      const vault = new SecretVault(file, xorCipher, () => NOW);
      await vault.load();
      await vault.set("jira.token", "tok-SUPER-secret-42");
      expect(await readFile(file, "utf8")).not.toContain("tok-SUPER-secret-42");

      const reopened = new SecretVault(file, xorCipher);
      await reopened.load();
      const resolved = reopened.resolveReferences(
        "Bearer {{secret:jira.token}}",
        new Set(["jira.token"]),
      );
      expect(resolved).toEqual({ text: "Bearer tok-SUPER-secret-42", used: ["jira.token"] });
      expect(() => reopened.resolveReferences("{{secret:jira.token}}", new Set())).toThrow(
        /non autorisé/,
      );
      expect(() => reopened.resolveReferences("{{secret:absent}}", new Set(["absent"]))).toThrow(
        /inconnu/,
      );

      const b64 = Buffer.from("tok-SUPER-secret-42").toString("base64");
      expect(reopened.redact(`réponse: tok-SUPER-secret-42 / ${b64}`)).toBe(
        "réponse: [secret:jira.token] / [secret:jira.token]",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuse le backend Linux en clair", () => {
    const base = {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(s),
      decryptString: (b: Buffer) => b.toString(),
    };
    expect(() =>
      createSafeStorageCipher({ ...base, getSelectedStorageBackend: () => "basic_text" }),
    ).toThrow(/non sécurisé/);
    expect(() =>
      createSafeStorageCipher({ ...base, getSelectedStorageBackend: () => "gnome_libsecret" }),
    ).not.toThrow();
  });

  test("détecte ce qui ressemble à un secret pour la mémoire", () => {
    expect(looksLikeSecret("mon mot de passe: Hunter2024!")).toBe(true);
    expect(looksLikeSecret("ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe(true);
    expect(looksLikeSecret("Je préfère vouvoyer mes clients dans les mails.")).toBe(false);
  });
});

test.describe("intégration session sans root", () => {
  test("refuse root et utilise $APPIMAGE plutôt que le montage temporaire", () => {
    expect(() => assertNotRoot(0)).toThrow(/root/);
    expect(() => assertNotRoot(1000)).not.toThrow();
    expect(
      resolveLaunchPath({ APPIMAGE: "/home/romeo/Apps/Pi-Agence.AppImage" }, "/tmp/.mount_x/pi"),
    ).toBe("/home/romeo/Apps/Pi-Agence.AppImage");
    expect(() => resolveLaunchPath({}, "/tmp/.mount_abc/pi-gui")).toThrow(/APPIMAGE/);
  });

  test("génère des unités utilisateur et un autostart corrects", () => {
    const units = renderSystemdUserUnits({
      launchPath: "/home/r/Apps/Pi Agence.AppImage",
      everyMinutes: 5,
    });
    expect(units.service).toContain(
      'ExecStart="/home/r/Apps/Pi Agence.AppImage" --daemon --run-due',
    );
    expect(units.service).not.toContain("NoNewPrivileges");
    expect(units.timer).toContain("OnUnitActiveSec=5min");
    expect(units.timer).toContain("WantedBy=timers.target");
    expect(renderAutostartEntry("/a/b.AppImage")).toContain('Exec="/a/b.AppImage" --background');
    expect(() => renderSystemdUserUnits({ launchPath: "/x", everyMinutes: 0 })).toThrow();
  });

  test("installe tout sous $HOME et dégrade proprement sans systemd", async () => {
    const home = await mkdtemp(join(tmpdir(), "agence-home-"));
    try {
      const calls: string[][] = [];
      const result = await installUserIntegration({
        homeDir: home,
        env: {},
        uid: 1000,
        launchPath: "/home/r/Pi.AppImage",
        enableDaemon: true,
        systemctl: (args) => {
          calls.push([...args]);
          return Promise.resolve({ ok: false, output: "Failed to connect to bus" });
        },
      });
      expect(result).toEqual({
        autostart: true,
        daemon: false,
        detail: "Failed to connect to bus",
      });
      expect(await readFile(join(home, ".config/autostart/pi-agence.desktop"), "utf8")).toContain(
        "--background",
      );
      expect(
        await readFile(join(home, ".config/systemd/user/pi-agence-tasks.timer"), "utf8"),
      ).toContain("[Timer]");
      expect(calls).toEqual([["daemon-reload"]]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
