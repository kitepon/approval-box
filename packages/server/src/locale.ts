/** Old clients without a supported language keep Japanese responses. */
export function requestLocale(header?: string): "ja" | "en" {
  const choices = (header ?? "").split(",").map((part, index) => {
    const [tag = "", ...parameters] = part.trim().toLowerCase().split(";");
    const q = parameters.find((parameter) => parameter.trim().startsWith("q="))?.trim().slice(2);
    const quality = q === undefined ? 1 : Number(q);
    return { base: tag.split("-")[0], quality, index };
  }).filter(({ base, quality }) => (base === "ja" || base === "en") && Number.isFinite(quality) && quality > 0 && quality <= 1)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  return choices[0]?.base === "en" ? "en" : "ja";
}
