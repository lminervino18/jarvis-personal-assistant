import { z } from "zod";

/**
 * What a media job produces: «iphone» is H.264 and AAC in MP4, which an iPhone saves to Photos;
 * «max» is the best the site has (AV1 or VP9 in 4K on YouTube); «mp3» and «m4a» are only the audio.
 */
export const MediaFormat = z.enum(["iphone", "max", "mp3", "m4a"]);
export type MediaFormat = z.infer<typeof MediaFormat>;
