/* Package entry. Pi calls the default export with the extension API; embedders use
   the named export to pass options.

   The behavior options (surface, resurface, retrieval, standout) may also come
   from ~/.config/pi-canon/settings.json, which /canon-settings edits; explicit
   options win over the file. root and mounts are per-project and stay code-only. */

import { registerCanonSettings, loadCanonSettingsFile } from "./settings.ts";
import { registerPiCanon } from "./canon.ts";

export { registerPiCanon, registerCanonSettings, loadCanonSettingsFile };

export default function piCanon(pi) {
  registerCanonSettings(pi);
  return registerPiCanon(pi, loadCanonSettingsFile());
}
