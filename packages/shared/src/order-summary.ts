import type { MaterialId } from "./quote-types";

export interface OrderItemLike {
  material: MaterialId;
  colour: string;
  quantity: number;
}

/** Human summary like "2× PLA (black), 1× PETG (white)" for WhatsApp + PDF. */
export function summariseItems(items: OrderItemLike[]): string {
  const groups = new Map<string, number>();
  for (const it of items) {
    const k = `${it.material} (${it.colour})`;
    groups.set(k, (groups.get(k) ?? 0) + it.quantity);
  }
  return [...groups].map(([k, q]) => `${q}× ${k}`).join(", ");
}
