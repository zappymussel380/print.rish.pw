import { materialName } from "./catalog";
import { colourName } from "./colours";
import type { MaterialId } from "./quote-types";

export interface OrderItemLike {
  material: MaterialId;
  colour: string;
  quantity: number;
}

/** Human summary like "2× PLA (Pitch Black), 1× Aesthetic PLA (Silk Copper)"
 *  for WhatsApp + PDF. */
export function summariseItems(items: OrderItemLike[]): string {
  const groups = new Map<string, number>();
  for (const it of items) {
    const k = `${materialName(it.material)} (${colourName(it.colour)})`;
    groups.set(k, (groups.get(k) ?? 0) + it.quantity);
  }
  return [...groups].map(([k, q]) => `${q}× ${k}`).join(", ");
}
