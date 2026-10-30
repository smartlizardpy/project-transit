// The six bus models, read from the game's own data so the page never drifts from it.
import { MODELS } from '../../../src/game/content.ts';

export interface FleetModel {
  id: string;
  name: string;
  kind: string;
  blurb: string;
  capacity: number;
  seats: number;
  electric: boolean;
  unlock: string;
}

export const FLEET: FleetModel[] = MODELS.map((m) => ({
  id: m.id,
  name: m.name,
  kind: m.kind,
  blurb: m.blurb,
  capacity: m.capacity,
  seats: m.seats,
  electric: !!m.electric,
  unlock: m.unlockObjective ? `Reputation ${m.unlockRep}, or the Mass transit objective` : m.unlockRep ? `Reputation ${m.unlockRep}` : 'From the start',
}));
