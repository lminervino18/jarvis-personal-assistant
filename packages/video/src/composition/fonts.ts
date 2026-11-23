import interRegular from "@fontsource/inter/files/inter-latin-400-normal.woff2";
import interMedium from "@fontsource/inter/files/inter-latin-500-normal.woff2";
import interSemibold from "@fontsource/inter/files/inter-latin-600-normal.woff2";
import groteskMedium from "@fontsource/space-grotesk/files/space-grotesk-latin-500-normal.woff2";
import groteskBold from "@fontsource/space-grotesk/files/space-grotesk-latin-700-normal.woff2";
import { loadFont } from "@remotion/fonts";

let loaded: Promise<unknown> | undefined;

/** Loads the Pulso fonts once; Remotion waits for them before capturing any frame. */
export function loadPulsoFonts(): Promise<unknown> {
  loaded ??= Promise.all([
    loadFont({ family: "Space Grotesk", url: groteskMedium, weight: "500" }),
    loadFont({ family: "Space Grotesk", url: groteskBold, weight: "700" }),
    loadFont({ family: "Inter", url: interRegular, weight: "400" }),
    loadFont({ family: "Inter", url: interMedium, weight: "500" }),
    loadFont({ family: "Inter", url: interSemibold, weight: "600" }),
  ]);
  return loaded;
}
