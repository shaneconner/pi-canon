/* /canon-settings: user-facing configuration for the behavior options that are
   otherwise code. The storage stays exactly what registerPiCanon accepts; this
   module only changes the experience: one validation path, an in-TUI editor over
   a JSON file, and every state that reaches disk already passed validation.

   root and mounts deliberately have no row here: they are per-project topology,
   and a global file overriding them would be wrong. The editor carries the four
   behavior options a user might legitimately flip session to session.

   The editor is built from pi-tui's own SettingsList and Input so it looks and
   behaves like Pi's native /settings screen, and ALL key handling goes through
   matchesKey: raw byte matching freezes on terminals in application cursor mode,
   where arrows arrive as SS3 rather than CSI.

   This file must stay loadable by PLAIN NODE (the entry-point gate imports it
   without jiti), so it uses none of the TypeScript that requires a transform:
   no parameter properties and no accessibility modifiers, only erasable
   annotations. */

import { homedir } from "node:os";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Container, Input, Key, matchesKey, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";

export const DEFAULT_CANON_SETTINGS_PATH = join(
  homedir(),
  ".config",
  "pi-canon",
  "settings.json",
);

export interface CanonUserSettings {
  surface?: boolean;
  resurface?: boolean;
  retrieval?: "none" | "lexical";
  standout?: number;
}

const SETTING_IDS = ["surface", "resurface", "retrieval", "standout"] as const;
export type CanonSettingId = (typeof SETTING_IDS)[number];

const RETRIEVAL_CHOICES = ["none", "lexical"];
/* The standout lattice, stepped by left/right and clamped at the ends. 1 is no
   cutoff; the default 1.4 is the operating point the 120-cell study priced. */
const STANDOUT_LATTICE = [1, 1.2, 1.4, 1.6, 1.8, 2, 2.5, 3];

export function applyCanonSettingsEdit(
  draft: CanonUserSettings,
  id: CanonSettingId,
  rawValue: string,
): { ok: true; draft: CanonUserSettings } | { ok: false; error: string } {
  const text = rawValue.trim();
  if (id === "surface" || id === "resurface") {
    if (text !== "on" && text !== "off") {
      return { ok: false, error: `${id} must be on or off` };
    }
    return { ok: true, draft: { ...draft, [id]: text === "on" } };
  }
  if (id === "retrieval") {
    if (!RETRIEVAL_CHOICES.includes(text)) {
      return { ok: false, error: 'retrieval must be "none" or "lexical"' };
    }
    return { ok: true, draft: { ...draft, retrieval: text as "none" | "lexical" } };
  }
  const value = Number(text);
  if (!Number.isFinite(value) || value < 1) {
    return { ok: false, error: "standout must be a number of at least 1 (1 is no cutoff)" };
  }
  return { ok: true, draft: { ...draft, standout: value } };
}

export function loadCanonSettingsFile(path: string = DEFAULT_CANON_SETTINGS_PATH): CanonUserSettings {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  for (const key of Object.keys(parsed)) {
    if (!SETTING_IDS.includes(key as CanonSettingId)) {
      throw new Error(`canon settings file has no ${key} field: the surface is surface, resurface, retrieval, standout`);
    }
  }
  let draft: CanonUserSettings = {};
  for (const id of SETTING_IDS) {
    if (parsed[id] === undefined) continue;
    const raw =
      typeof parsed[id] === "boolean" ? (parsed[id] ? "on" : "off") : String(parsed[id]);
    const result = applyCanonSettingsEdit(draft, id, raw);
    if (!result.ok) throw new Error(result.error);
    draft = result.draft;
  }
  return draft;
}

export function saveCanonSettingsFile(path: string, settings: CanonUserSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(temporary, path);
}

interface EditorRow {
  id: CanonSettingId;
  label: string;
  description: string;
}

const EDITOR_ROWS: readonly EditorRow[] = [
  { id: "surface", label: "Surfacing on touch", description: "Govern articles surface as tool calls touch their assets" },
  { id: "resurface", label: "Resurface after folding", description: "A surfaced article surfaces again once it leaves the context window" },
  { id: "retrieval", label: "Retrieval ranking", description: "How off-spine articles are ranked against what the agent is doing" },
  { id: "standout", label: "Standout cutoff", description: "How far the best rank must stand out before it rides; ignored while retrieval is none" },
];

function rowRawValue(settings: CanonUserSettings, id: CanonSettingId): string {
  if (id === "surface" || id === "resurface") return settings[id] === false ? "off" : "on";
  if (id === "retrieval") return settings.retrieval ?? "none";
  return String(settings.standout ?? 1.4);
}

function rowDisplayValue(settings: CanonUserSettings, id: CanonSettingId): string {
  const raw = rowRawValue(settings, id);
  if (id === "standout" && (settings.retrieval ?? "none") === "none") return `${raw} (unused)`;
  return raw;
}

// The frame Pi's own /settings screen draws around its list. Implemented locally
// rather than imported because jiti keeps a separate module cache: the border's
// default color closure would bind to a different theme instance than the one the
// editor receives, so the color always arrives explicitly.
class SettingsBorder {
  color: (text: string) => string;

  constructor(color: (text: string) => string) {
    this.color = color;
  }

  invalidate(): void {}

  render(width: number): string[] {
    return [this.color("─".repeat(Math.max(1, width)))];
  }
}

// The exact-value editor behind the standout row's submenu: an Input prefilled
// with the raw value; Enter applies through applyCanonSettingsEdit and only a
// valid result calls done, so an invalid state can never reach the list, the
// file, or registration. Composition mirrors the native SelectSubmenu.
class StandoutEditor extends Container {
  input: Input;
  errorText: Text;
  themeLike: any;
  apply: (raw: string) => { ok: true; display: string } | { ok: false; error: string };
  done: (displayValue?: string) => void;

  constructor(themeLike: any, initialValue: string, apply: any, done: (displayValue?: string) => void) {
    super();
    this.themeLike = themeLike;
    this.apply = apply;
    this.done = done;
    const theme = this.themeLike;
    this.input = new Input();
    this.errorText = new Text("", 0, 0);
    this.addChild(new Text(theme.bold(theme.fg("accent", "Standout cutoff")), 0, 0));
    this.addChild(new Text(theme.fg("muted", "How far the best-ranked article must outscore the rest before it rides. 1 is no cutoff."), 0, 0));
    this.addChild(new Spacer(1));
    this.input.setValue(initialValue);
    // setValue parks the cursor at 0; a prefilled editor must start at the end,
    // or typing inserts at the front and backspace deletes nothing.
    (this.input as any).cursor = initialValue.length;
    this.input.onSubmit = () => this.submit();
    this.input.onEscape = () => this.done();
    this.addChild(this.input);
    this.addChild(new Spacer(1));
    this.addChild(this.errorText);
    this.addChild(new Text(theme.fg("dim", "  Enter to apply · Esc to go back"), 0, 0));
  }

  submit(): void {
    const result = this.apply(this.input.getValue());
    if (!result.ok) {
      this.errorText.setText(this.themeLike.fg("error", `  ${result.error}`));
      return;
    }
    this.done(result.display);
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
  }
}

// The /canon-settings screen itself. Boolean and retrieval rows CYCLE through
// their values natively; the standout row STEPS along its lattice with left/right
// (clamped at the ends) and takes an exact value on Enter.
export class CanonSettingsEditor extends Container {
  draft: CanonUserSettings;
  settingsPath: string;
  themeLike: any;
  done: (saved: boolean) => void;
  settingsList: SettingsList;

  constructor(draft: CanonUserSettings, settingsPath: string, themeLike: any, done: (saved: boolean) => void) {
    super();
    this.draft = draft;
    this.settingsPath = settingsPath;
    this.themeLike = themeLike;
    this.done = done;
    const theme = this.themeLike;
    this.addChild(new SettingsBorder((text: string) => theme.fg("border", text)));
    this.addChild(new Text(theme.bold(theme.fg("accent", "pi-canon settings")), 0, 0));
    this.addChild(new Text(theme.fg("muted", "Edits save immediately. ←→ steps the cutoff · Enter changes or types a value."), 0, 0));
    this.addChild(new Spacer(1));
    // SettingsList takes its own theme shape; adapt it off the live theme.
    const listTheme = {
      label: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : text),
      value: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
      description: (text: string) => theme.fg("dim", text),
      cursor: theme.fg("accent", "→ "),
      hint: (text: string) => theme.fg("dim", text),
    };
    this.settingsList = new SettingsList(
      EDITOR_ROWS.map((row) => ({
        id: row.id,
        label: row.label,
        description: row.description,
        currentValue: rowDisplayValue(this.draft, row.id),
        values: row.id === "surface" || row.id === "resurface"
          ? ["on", "off"]
          : row.id === "retrieval"
            ? [...RETRIEVAL_CHOICES]
            : undefined,
        submenu: row.id === "standout"
          ? (_current: string, submenuDone: (displayValue?: string) => void) =>
            new StandoutEditor(
              themeLike,
              rowRawValue(this.draft, row.id),
              (raw: string) => this.applyAndSave(row.id, raw),
              submenuDone,
            )
          : undefined,
      })),
      EDITOR_ROWS.length + 2,
      listTheme,
      (id: string, newValue: string) => this.applyCycled(id as CanonSettingId, newValue),
      () => this.done(true),
    );
    this.addChild(this.settingsList);
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("dim", "  ←→ to step the cutoff · Enter to change · Esc to close"), 0, 0));
    this.addChild(new SettingsBorder((text: string) => theme.fg("border", text)));
  }

  applyAndSave(id: CanonSettingId, raw: string): { ok: true; display: string } | { ok: false; error: string } {
    const result = applyCanonSettingsEdit(this.draft, id, raw);
    if (!result.ok) return result;
    this.draft = result.draft;
    saveCanonSettingsFile(this.settingsPath, this.draft);
    for (const row of EDITOR_ROWS) {
      const item = (this.settingsList as any).items.find((candidate: any) => candidate.id === row.id);
      if (item) item.currentValue = rowDisplayValue(this.draft, row.id);
    }
    return { ok: true, display: rowDisplayValue(this.draft, id) };
  }

  /* Cycling rows reach this handler from SettingsList itself. The standout row
     reaches it too when its submenu closes: SettingsList re-fires onChange with
     the DISPLAY string, which is not a number, so the handler ignores that row
     entirely; the submit path already applied and saved it. */
  applyCycled(id: CanonSettingId, newValue: string): void {
    if (id === "standout") return;
    this.applyAndSave(id, newValue);
  }

  // One step along the standout lattice, clamped at its ends. Stepping is inert
  // while retrieval is none, because the value is ignored there anyway.
  stepStandout(direction: number): void {
    if ((this.draft.retrieval ?? "none") === "none") return;
    const current = Number(rowRawValue(this.draft, "standout"));
    const target = direction > 0
      ? STANDOUT_LATTICE.find((candidate) => candidate > current + 1e-9)
      : [...STANDOUT_LATTICE].reverse().find((candidate) => candidate < current - 1e-9);
    if (target === undefined) return;
    this.applyAndSave("standout", String(target));
  }

  handleInput(data: string): void {
    // An open submenu owns everything until it closes.
    if (this.settingsList.submenuComponent) {
      this.settingsList.handleInput(data);
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.stepStandout(-1);
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.stepStandout(+1);
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.done(true);
      return;
    }
    this.settingsList.handleInput(data);
  }
}

export function registerCanonSettings(
  pi: any,
  options: { settingsPath?: string } = {},
): void {
  const settingsPath = options.settingsPath ?? DEFAULT_CANON_SETTINGS_PATH;
  pi.registerCommand("canon-settings", {
    description: "Configure pi-canon: surfacing, resurfacing, retrieval ranking, standout cutoff",
    handler: async (_args: string, ctx: any) => {
      if (typeof ctx.ui?.custom !== "function") {
        throw new Error("/canon-settings needs an interactive UI; set the options in the settings file instead");
      }
      const draft = loadCanonSettingsFile(settingsPath);
      await ctx.ui.custom((_tui: unknown, theme: any, _keybindings: unknown, done: (saved: boolean) => void) =>
        new CanonSettingsEditor(draft, settingsPath, theme, done));
    },
  });
}
