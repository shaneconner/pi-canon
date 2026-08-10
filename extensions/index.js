/* Package entry. Pi calls the default export with the extension API; embedders use
   the named export to pass options. */

import { registerPiCanon } from "./canon.ts";

export { registerPiCanon };

export default function piCanon(pi) {
  return registerPiCanon(pi, {});
}
