// Each era looks like a real photo taken in that period, so the time-lapse reads
// like an old family album, not a cartoon.
export function periodLook(year) {
  if (!year || year >= 2015) return 'a modern sharp color smartphone photo, natural daylight';
  if (year < 1900) return 'a 19th century sepia albumen print with soft focus, faded edges and light scratches';
  if (year < 1960) return 'a black and white film photograph with visible grain, period street photography';
  if (year < 2000) return 'a faded color film snapshot with warm cast and slight grain, like a 1970s to 1990s print';
  return 'a slightly soft early digital color photo';
}
