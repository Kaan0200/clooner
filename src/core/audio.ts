// File types Serato can play. Anything else found in a library is ignored
// when counting or syncing tracks.
export const AUDIO_EXTENSIONS = new Set([
  "mp3", "m4a", "aac", "flac", "aif", "aiff", "wav", "ogg", "alac", "mp4",
]);

export function isAudioFile(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return AUDIO_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}
