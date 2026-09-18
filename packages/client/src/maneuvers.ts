/**
 * How a manoeuvre is worded and drawn. ONE table, read by the step list and by the banner.
 *
 * EXTRACTED AT GATE 8, when the navigation banner arrived and became the second surface that
 * names a turn. Two tables would drift: the banner would say "Bear left" while the list said
 * "Keep left" for the same instruction, and nothing would report it because both would be
 * internally consistent. The turn-by-turn list and the thing on screen at the moment of the turn
 * disagreeing is worse than either wording being wrong.
 *
 * Governed by `rules/copy.md`: no em dash, no en dash, no interpunct anywhere in this file.
 */
import type { Instruction, ManeuverType } from '@wayfinder/shared';

export const PHRASE: Record<ManeuverType, string> = {
  depart: 'Start on',
  'turn-left': 'Turn left onto',
  'turn-right': 'Turn right onto',
  'turn-slight-left': 'Bear left onto',
  'turn-slight-right': 'Bear right onto',
  'turn-sharp-left': 'Sharp left onto',
  'turn-sharp-right': 'Sharp right onto',
  straight: 'Continue onto',
  'roundabout-enter': 'Enter the roundabout',
  'roundabout-exit': 'At the roundabout, take exit',
  merge: 'Merge onto',
  'fork-left': 'Keep left onto',
  'fork-right': 'Keep right onto',
  'u-turn': 'Make a U turn onto',
  arrive: 'Arrive at your destination',
};

/** The arrow shown beside each step. Text, not an icon set, so it survives at any zoom. */
export const GLYPH: Record<ManeuverType, string> = {
  depart: '●',
  'turn-left': '←',
  'turn-right': '→',
  'turn-slight-left': '↖',
  'turn-slight-right': '↗',
  'turn-sharp-left': '↙',
  'turn-sharp-right': '↘',
  straight: '↑',
  'roundabout-enter': '↻',
  'roundabout-exit': '↱',
  merge: '↗',
  'fork-left': '↖',
  'fork-right': '↗',
  'u-turn': '↶',
  arrive: '■',
};

export function stepText(step: Instruction): string {
  if (step.type === 'arrive') return PHRASE.arrive;
  if (step.type === 'roundabout-enter') return PHRASE['roundabout-enter'];
  if (step.type === 'roundabout-exit') {
    // One instruction per circle, given BEFORE entering it, which is the moment the driver needs
    // it. The engine positions it at the entry; the wording has to match that or the panel says
    // "take exit 2" at a point the driver has already passed.
    const nth = step.roundaboutExit ?? 1;
    const where = step.roadName === undefined ? '' : ` onto ${step.roadName}`;
    return `At the roundabout, take exit ${nth}${where}`;
  }
  // An unnamed road is the common case in this city, not an error, so it must read as a sentence
  // rather than as a missing value.
  if (step.roadName === undefined) {
    return step.type === 'depart' ? 'Start out' : PHRASE[step.type].replace(/ onto$/, '');
  }
  return `${PHRASE[step.type]} ${step.roadName}`;
}

/** Distance for a person, not for a machine. Rounded to what a driver can act on. */
export function distance(m: number): string {
  if (m < 950) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

/**
 * A duration in words.
 *
 * NEVER quoted finer than a minute. The speed model behind it is a class default for 98.5% of
 * ways, so seconds would assert precision the model does not have.
 */
export function duration(totalS: number): string {
  const mins = Math.max(0, Math.round(totalS / 60));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}
