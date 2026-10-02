import { describe, it, expect } from "vitest";
import { t, optionLabel, domainLabel, domainTitle, DISPLAY_LANG, __internals } from "./i18n";

/**
 * The panel had no i18n at all, so every string is a hardcoded literal. Rather
 * than trust a hand-run sweep, this scans the source and proves two things:
 * every t("...") key exists in the dictionary, and every dictionary entry is
 * actually reachable from a call site.
 *
 * The scanner is itself tested below. A collector that silently drops keys is
 * worse than no collector, because the missing key still shows English and
 * nothing looks broken.
 *
 * Sources are pulled in with import.meta.glob rather than node:fs so the test
 * needs no @types/node - the project has no Node type surface at all.
 */

const rawSources = import.meta.glob("./**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

interface ScanResult {
  keys: Set<string>;
  /** t(...) calls whose first argument is not a plain string literal. */
  dynamic: string[];
}

/**
 * Collect t("literal") keys. The first argument is always a plain string
 * literal in this codebase, which is why a simple quote-matching regex is
 * enough here - no parenthesis balancing is needed, because the pattern stops
 * at the closing quote. A call whose first argument is NOT a literal would
 * escape the scan, so those are reported separately and asserted empty.
 */
export function scanTSCalls(src: string): ScanResult {
  const keys = new Set<string>();
  const dynamic: string[] = [];
  const callStart = /\bt\(/g;
  let m: RegExpExecArray | null;
  while ((m = callStart.exec(src)) !== null) {
    const rest = src.slice(m.index + m[0].length);
    const literal = /^\s*"((?:[^"\\]|\\.)*)"/.exec(rest);
    if (literal) {
      keys.add(literal[1].replace(/\\(.)/g, "$1"));
    } else {
      const snippet = rest.split("\n")[0].slice(0, 40);
      dynamic.push(`${m.index}: ${snippet}`);
    }
  }
  return { keys, dynamic };
}

// i18n.ts itself is scanned: the dictionary holds its keys as object
// properties rather than t() calls, so it contributes nothing spurious, while
// its own t() call in domainTitle() is a genuine call site. Only this test file
// is excluded, because the scanner self-tests below feed it sample strings.
const scan = Object.entries(rawSources)
  .filter(([path]) => !path.endsWith("i18n.test.ts"))
  .reduce<ScanResult>(
    (acc, [path, src]) => {
      const r = scanTSCalls(src);
      for (const k of r.keys) acc.keys.add(k);
      acc.dynamic.push(...r.dynamic.map((d) => `${path}: ${d}`));
      return acc;
    },
    { keys: new Set<string>(), dynamic: [] },
  );

describe("i18n scanner self-test", () => {
  // If these fail the collector is broken and the completeness check below is
  // measuring nothing.
  it("collects a key containing parentheses, a comma and a full stop", () => {
    const r = scanTSCalls('t("Filter by state (e.g. on, off)")');
    expect([...r.keys]).toEqual(["Filter by state (e.g. on, off)"]);
    expect(r.dynamic).toEqual([]);
  });

  it("collects a key containing an apostrophe", () => {
    const r = scanTSCalls(`t("Skip glow when state value hasn't changed")`);
    expect([...r.keys]).toEqual(["Skip glow when state value hasn't changed"]);
  });

  it("collects a key containing {placeholders}", () => {
    const r = scanTSCalls('t("Copy ID: {id}", { id: "x" })');
    expect([...r.keys]).toEqual(["Copy ID: {id}"]);
  });

  it("does not get confused by a second argument or by nesting", () => {
    const r = scanTSCalls('t("Done", { n: t("Close") })');
    expect([...r.keys].sort()).toEqual(["Close", "Done"]);
  });

  it("reports a call whose first argument is not a literal instead of dropping it", () => {
    const r = scanTSCalls("t(a.label)");
    expect(r.keys.size).toBe(0);
    expect(r.dynamic).toHaveLength(1);
  });
});

describe("dictionary completeness", () => {
  it("finds call sites to check", () => {
    expect(scan.keys.size).toBeGreaterThan(80);
  });

  it("has an entry for every t() key used in the source", () => {
    const missing = [...scan.keys].filter((k) => !(k in __internals.DICT));
    expect(missing).toEqual([]);
  });

  it("has no unreachable entries", () => {
    const used = new Set(scan.keys);
    // Service action labels and automation relations are translated through
    // t(a.label) / optionLabel(), which the scanner cannot follow. They are
    // inventoried by hand below instead.
    const dynamic = [
      // force.ts SERVICE_ACTIONS labels
      "Toggle", "Turn on", "Turn off", "Run", "Stop", "Activate", "Trigger",
      "Open", "Close", "Unlock", "Lock", "Play/Pause", "Return to base",
      "Press", "Start",
      // automation relations, routed through optionLabel()
      "trigger", "condition", "action",
      // option values, routed through optionLabel()
      "domain", "device", "tree", "scatter", "dots", "stars", "default",
      "hulls", "automations", "normal", "pulse", "ring", "hidden", "only",
      "area", "supernova", "shooting-star", "flare", "pulse-wave", "color-shift",
    ];
    for (const k of dynamic) used.add(k);
    const orphans = Object.keys(__internals.DICT).filter((k) => !used.has(k));
    expect(orphans).toEqual([]);
  });

  it("translates every dynamically-passed key", () => {
    const dynamic = [
      "Toggle", "Turn on", "Turn off", "Run", "Stop", "Activate", "Trigger",
      "Open", "Close", "Unlock", "Lock", "Play/Pause", "Return to base",
      "Press", "Start",
    ];
    const untranslated = dynamic.filter((k) => t(k) === k);
    expect(untranslated).toEqual([]);
  });

  it("translates every option value", () => {
    const values = Object.keys(__internals.OPTION_LABELS);
    const untranslated = values.filter((v) => optionLabel(v) === v);
    expect(untranslated).toEqual([]);
  });
});

describe("reverse sweep: nothing reaches the screen unwrapped", () => {
  /**
   * The check above only goes t("x") -> dictionary. By construction it cannot
   * find a string that was never wrapped, which is the more likely mistake -
   * a hand sweep missed debug-log messages, a login-form error, and a toast
   * template literal before this test existed. This goes the other way.
   *
   * Template literals are included deliberately: two earlier sweeps used
   * patterns that only matched plain quoted strings and both missed
   * `showToast(\`Copied: ${id}\`)`.
   */
  const SITES = [
    /\.textContent\s*=\s*(?:"([^"]*)"|`([^`]*)`)/g,
    /\.title\s*=\s*(?:"([^"]*)"|`([^`]*)`)/g,
    /\.placeholder\s*=\s*(?:"([^"]*)"|`([^`]*)`)/g,
    /\b(?:makeSection|makeToggle|makeSelect|makeSegmented|makeSlider)\(\s*(?:"([^"]*)"|`([^`]*)`)/g,
    /\bshowToast\(\s*(?:"([^"]*)"|`([^`]*)`)/g,
    /\baddItem\(\s*(?:"([^"]*)"|`([^`]*)`)/g,
    /\bdebugLog\(\s*(?:"[^"]*"|t\([^)]*\))\s*,\s*(?:"([^"]*)"|`([^`]*)`)/g,
    /\bcreateTextNode\(\s*(?:"([^"]*)"|`([^`]*)`)\)/g,
    /\bshowLoading\(\s*\w+\s*,\s*(?:"([^"]*)"|`([^`]*)`)/g,
  ];

  // Values that are genuinely not prose and must stay literal. The reset and
  // clear glyphs are written as \uXXXX escapes in the source, so match the
  // escape text as well as the rendered character.
  const ALLOWED = [
    /^\\?u21bb$/, /^\\?u00d7$/,      // reset + clear glyphs
    /^FPS: --$/,                     // placeholder before the first sample
    /^https?:/, /^eyJ/,              // url and token examples
  ];

  const sources = Object.entries(rawSources)
    .filter(([p]) => !p.endsWith("i18n.test.ts"));

  /** Collect literals reaching the screen that are not wrapped in t(). */
  function collectUnwrapped(src: string): { line: number; value: string }[] {
    const out: { line: number; value: string }[] = [];
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
      .replace(/(^|[^:])\/\/[^\n]*/g, (m) => " ".repeat(m.length));
    for (const re of SITES) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(code)) !== null) {
        const value = m[1] ?? m[2] ?? "";
        if (!value) continue;
        if (ALLOWED.some((a) => a.test(value))) continue;
        if (/\bt\(\s*$/.test(code.slice(Math.max(0, m.index - 10), m.index))) continue;
        out.push({ line: code.slice(0, m.index).split("\n").length, value });
      }
    }
    return out;
  }

  it("leaves no screen-bound string literal outside t()", () => {
    const unwrapped: string[] = [];
    for (const [path, src] of sources) {
      for (const hit of collectUnwrapped(src)) {
        unwrapped.push(`${path}:${hit.line}  ${JSON.stringify(hit.value)}`);
      }
    }
    expect(unwrapped).toEqual([]);
  });

  it("detects an unwrapped literal, so the sweep is not vacuous", () => {
    // The corpus is clean, so counting matches in it would only prove the
    // sweep is blind. Feed it a sample instead.
    const sample = [
      'a.textContent = "Repulsion";',            // unwrapped -> caught
      'b.textContent = t("Damping");',            // wrapped   -> allowed
      'c.textContent = "\\u21bb";',               // glyph     -> allowed
      '// d.textContent = "Commented out";',      // comment   -> ignored
      '/* e.textContent = "Block comment"; */',   // comment   -> ignored
      'f.showToast(`Copied: ${id}`);',            // template  -> caught
    ].join("\n");
    // Only the values, not the line numbers - those are incidental.
    expect(collectUnwrapped(sample).map((h) => h.value)).toEqual([
      "Repulsion",
      "Copied: ${id}",
    ]);
  });
});

describe("t()", () => {
  it("translates a known key", () => {
    expect(t("Filters")).toBe("筛选");
  });

  it("falls back to the key so a missing entry stays readable", () => {
    expect(t("A string nobody translated")).toBe("A string nobody translated");
  });

  it("substitutes {placeholders}", () => {
    expect(t("{n} nodes | {a} areas", { n: 3669, a: 5 })).toBe("3669 个节点 | 5 个区域");
  });

  it("substitutes every occurrence of a repeated placeholder", () => {
    expect(t("{x}-{x}", { x: 1 })).toBe("1-1");
  });

  it("leaves the string alone when no vars are passed", () => {
    expect(t("State: ")).toBe("状态：");
  });
});

describe("optionLabel()", () => {
  it("translates a known option value", () => {
    expect(optionLabel("pulse-wave")).toBe("脉冲波");
  });

  it("passes an unknown value through unchanged", () => {
    expect(optionLabel("something_new")).toBe("something_new");
  });

  it("never changes the value that gets persisted", () => {
    // The option value is what lands in localStorage and gets compared in
    // settings logic; only the rendered text is localised.
    for (const v of Object.keys(__internals.OPTION_LABELS)) {
      expect(v).toBe(v.toLowerCase());
      expect(v).toMatch(/^[a-z-]+$/);
    }
  });
});

describe("domainLabel()", () => {
  it("translates a known domain", () => {
    expect(domainLabel("binary_sensor")).toBe("二进制传感器");
  });

  it("passes an unknown domain through so custom integrations still render", () => {
    expect(domainLabel("my_custom_thing")).toBe("my_custom_thing");
  });

  it("never changes the domain that gets stored or used as a key", () => {
    for (const d of Object.keys(__internals.DOMAIN_LABELS)) {
      expect(d).toBe(d.toLowerCase());
      expect(d).toMatch(/^[a-z_]+$/);
    }
  });

  it("translates every domain it ships", () => {
    const noop = Object.keys(__internals.DOMAIN_LABELS).filter(
      (d) => __internals.DOMAIN_LABELS[d] === d,
    );
    expect(noop).toEqual([]);
    expect(Object.keys(__internals.DOMAIN_LABELS).length).toBeGreaterThan(30);
  });
});

describe("domainTitle()", () => {
  it("keeps the raw domain discoverable in the tooltip", () => {
    expect(domainTitle("light")).toBe("灯（light）");
  });

  it("does not duplicate an untranslated domain", () => {
    expect(domainTitle("my_custom_thing")).toBe("my_custom_thing");
  });
});

describe("DISPLAY_LANG switch", () => {
  it("ships as the Chinese locale", () => {
    expect(DISPLAY_LANG).toBe("zh-CN");
  });

  it("is a union, not a literal type, so the English branch is reachable", () => {
    // A `as const` here would make `DISPLAY_LANG === "en"` a branch TypeScript
    // rejects as impossible, which is how the switch silently became a lie.
    const flipped: typeof DISPLAY_LANG = "en";
    expect(flipped).toBe("en");
  });

  it("translates every dictionary entry it can reach", () => {
    const keys = Object.keys(__internals.DICT);
    expect(keys.length).toBeGreaterThan(90);
    // An entry identical to its key would be a no-op translation.
    const noop = keys.filter((k) => __internals.DICT[k] === k);
    expect(noop).toEqual([]);
  });
});
