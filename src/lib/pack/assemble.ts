import { z } from "zod";
import { DO_EXCLUDE_TAG_KEYWORDS } from "@/lib/pipeline/config";

export const SLOTS = ["watch", "listen", "wear", "do"] as const;

const slotSchema = z.enum(SLOTS);
const explainSchema = z.object({
  en: z.string(),
  es: z.string(),
});

const itemSchema = z.object({
  slot: slotSchema,
  entityId: z.string().optional(),
  name: z.string(),
  type: z.string(),
  hop: z.union([z.literal(0), z.literal(1)]),
  imageUrl: z.string().nullable().optional(),
  affinity: z.number().nullable().optional(),
  explain: explainSchema,
  confidence: z.enum(["high", "medium", "low", "unverified"]),
  provenance: z.enum(["qloo", "mock"]),
  evidence: z.record(z.unknown()).optional(),
});

const inputSchema = z.object({
  sessionId: z.string(),
  city: z.string(),
  eventKind: z.enum(["tour", "con", "comunidad"]),
  seeds: z.array(
    z.object({
      raw: z.string(),
      entityId: z.string(),
      type: z.string(),
    }),
  ),
  packs: z
    .array(
      z.object({
        label: z.enum(["A", "B"]),
        axis: z.enum(["root", "bridge"]),
        items: z.array(z.unknown()),
      }),
    )
    .min(1),
  coverage: z
    .object({
      notes: z.object({
        en: z.string(),
        es: z.string(),
      }),
      mode: z.enum(["default", "deep_cuts"]).optional(),
    })
    .optional(),
});

export type AssembledItem = z.infer<typeof itemSchema> & {
  entityId: string;
  imageUrl: string | null;
  affinity: number | null;
};

export type AssembledPack = {
  sessionId: string;
  city: string;
  eventKind: "tour" | "con" | "comunidad";
  seeds: { raw: string; entityId: string; type: string }[];
  packs: {
    label: "A" | "B";
    axis: "root" | "bridge";
    items: AssembledItem[];
  }[];
  coverage: {
    notes: { en: string; es: string };
    removedFromBridge: string[];
    mode?: "default" | "deep_cuts";
  };
};

const SLOT_LABEL = {
  watch: { en: "Watch", es: "Ver" },
  listen: { en: "Listen", es: "Oír" },
  wear: { en: "Wear", es: "Llevar" },
  do: { en: "Do", es: "Hacer" },
} as const;

const PLAN_LABEL = {
  A: { en: "Roots", es: "Raíz" },
  B: { en: "Bridge", es: "Puente" },
} as const;

function appendNote(current: string, next: string): string {
  if (!next) return current;
  if (!current) return next;
  return `${current} ${next}`;
}

export function placeTagExcluded(name: string): boolean {
  const lower = name.toLowerCase();
  return DO_EXCLUDE_TAG_KEYWORDS.some((word) => lower.includes(word));
}

function hitTagNames(item: AssembledItem): string[] {
  const value = item.evidence?.hitTags;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function keepValidItems(items: unknown[]): AssembledItem[] {
  const kept: AssembledItem[] = [];
  const seenSlots = new Set<string>();
  for (const item of items) {
    const parsed = itemSchema.safeParse(item);
    if (!parsed.success) continue;
    const entityId = parsed.data.entityId?.trim() ?? "";
    if (!entityId) continue;
    if (seenSlots.has(parsed.data.slot)) continue;
    seenSlots.add(parsed.data.slot);
    const { evidence, ...rest } = parsed.data;
    kept.push({
      ...rest,
      entityId,
      imageUrl: rest.imageUrl ?? null,
      affinity: rest.affinity ?? null,
      ...(evidence ? { evidence } : {}),
    });
  }
  return kept.sort((left, right) => SLOTS.indexOf(left.slot) - SLOTS.indexOf(right.slot));
}

export function assemblePack(input: unknown): AssembledPack {
  const parsed = inputSchema.parse(input);
  const notes = {
    en: parsed.coverage?.notes.en ?? "",
    es: parsed.coverage?.notes.es ?? "",
  };
  const packs = parsed.packs.map((pack) => ({
    label: pack.label,
    axis: pack.axis,
    items: keepValidItems(pack.items).filter((item) => {
      if (item.slot !== "do") return true;
      return !hitTagNames(item).some((tag) => placeTagExcluded(tag));
    }),
  }));

  const root = packs.find((pack) => pack.axis === "root") ?? packs.find((pack) => pack.label === "A");
  const bridge =
    packs.find((pack) => pack.axis === "bridge") ?? packs.find((pack) => pack.label === "B");
  const removedFromBridge: string[] = [];

  if (root && bridge) {
    const rootIds = new Set(root.items.map((item) => item.entityId));
    bridge.items = bridge.items.filter((item) => {
      if (!rootIds.has(item.entityId)) return true;
      if (!removedFromBridge.includes(item.entityId)) {
        removedFromBridge.push(item.entityId);
        notes.en = appendNote(
          notes.en,
          `${item.entityId} stayed on Roots and was removed from Bridge.`,
        );
        notes.es = appendNote(
          notes.es,
          `${item.entityId} se quedó en Raíz y se quitó de Puente.`,
        );
      }
      return false;
    });
  }

  for (const pack of packs) {
    for (const slot of SLOTS) {
      if (pack.items.some((item) => item.slot === slot)) continue;
      const plan = PLAN_LABEL[pack.label];
      const name = SLOT_LABEL[slot];
      notes.en = appendNote(notes.en, `${plan.en} ${name.en} is unverified.`);
      notes.es = appendNote(notes.es, `${plan.es} ${name.es} no está verificado.`);
    }
  }

  return {
    sessionId: parsed.sessionId,
    city: parsed.city,
    eventKind: parsed.eventKind,
    seeds: parsed.seeds,
    packs,
    coverage: {
      notes,
      removedFromBridge,
      ...(parsed.coverage?.mode ? { mode: parsed.coverage.mode } : {}),
    },
  };
}
