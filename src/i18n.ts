import { en } from "./lang/en";
import { de } from "./lang/de";

const locales: Record<string, Record<string, string>> = { en, de };

export function t(key: string, vars?: Record<string, string>): string {
  const lang = (window.moment?.locale() ?? "en").split("-")[0];
  const map  = locales[lang] ?? locales["en"];
  let str    = map[key] ?? locales["en"][key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.split(`{${k}}`).join(v);
    }
  }
  return str;
}
