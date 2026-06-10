import { describe, it, expect, vi } from "vitest";

const KEY = "ha-hypertree-force-settings";

async function freshModule(stored?: string) {
  vi.resetModules();
  const store = new Map<string, string>();
  if (stored !== undefined) store.set(KEY, stored);
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
  });
  const mod = await import("./settings");
  return { mod, store };
}

describe("settings load", () => {
  it("uses defaults when storage is empty", async () => {
    const { mod } = await freshModule();
    expect(mod.settings).toEqual(mod.defaults);
    expect(mod.settings).not.toBe(mod.defaults);
  });

  it("merges stored values over defaults", async () => {
    const { mod } = await freshModule(JSON.stringify({ starSize: 3, showLabels: false }));
    expect(mod.settings.starSize).toBe(3);
    expect(mod.settings.showLabels).toBe(false);
    expect(mod.settings.glowSize).toBe(mod.defaults.glowSize);
  });

  it("migrates pulseUnavailable to unavailableMode", async () => {
    const { mod } = await freshModule(JSON.stringify({ pulseUnavailable: true }));
    expect(mod.settings.unavailableMode).toBe("pulse");
  });

  it("does not migrate when unavailableMode is already present", async () => {
    const { mod } = await freshModule(JSON.stringify({ pulseUnavailable: true, unavailableMode: "hidden" }));
    expect(mod.settings.unavailableMode).toBe("hidden");
  });

  it("drops keys that are no longer part of the schema", async () => {
    const { mod, store } = await freshModule(JSON.stringify({ removedSetting: 42, starSize: 2 }));
    mod.saveSettings();
    expect(JSON.parse(store.get(KEY)!)).not.toHaveProperty("removedSetting");
  });

  it("falls back to defaults on corrupted JSON", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { mod } = await freshModule("{not json");
    expect(mod.settings).toEqual(mod.defaults);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not share array instances with defaults", async () => {
    const { mod } = await freshModule();
    mod.settings.hiddenDomains.push("light");
    expect(mod.defaults.hiddenDomains).toEqual([]);
  });
});

describe("saveSettings", () => {
  it("persists direct mutations", async () => {
    const { mod, store } = await freshModule();
    mod.settings.repulsion = 1234;
    mod.saveSettings();
    expect(JSON.parse(store.get(KEY)!).repulsion).toBe(1234);
  });
});

describe("applySettings", () => {
  it("resets unlisted fields to defaults and persists", async () => {
    const { mod, store } = await freshModule(JSON.stringify({ starSize: 3 }));
    mod.settings.glowSize = 99;
    mod.applySettings({ damping: 0.5 });
    expect(mod.settings.starSize).toBe(mod.defaults.starSize);
    expect(mod.settings.glowSize).toBe(mod.defaults.glowSize);
    expect(mod.settings.damping).toBe(0.5);
    expect(JSON.parse(store.get(KEY)!).damping).toBe(0.5);
  });

  it("with an empty partial acts as a full reset", async () => {
    const { mod } = await freshModule(JSON.stringify({ starSize: 3, showLabels: false }));
    mod.applySettings({});
    expect(mod.settings).toEqual(mod.defaults);
  });
});
