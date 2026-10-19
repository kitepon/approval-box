import { supportedLocale, type Locale } from "./locales.ts";
/** Old clients without a supported language keep Japanese responses. */
export function requestLocale(header?: string): Locale {
  const choices = (header ?? "").split(",").map((part, index) => {
    const [tag = "", ...parameters] = part.trim().toLowerCase().split(";");
    const q = parameters.find((parameter) => parameter.trim().startsWith("q="))?.trim().slice(2);
    const quality = q === undefined ? 1 : Number(q);
    return { locale: supportedLocale(tag), quality, index };
  }).filter(({ locale, quality }) => locale && Number.isFinite(quality) && quality > 0 && quality <= 1)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  return choices[0]?.locale ?? "ja";
}
