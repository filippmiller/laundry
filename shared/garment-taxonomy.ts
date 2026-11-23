/**
 * The garment taxonomy shared by the server and the web client.
 *
 * Why a controlled vocabulary: the courier used to type the category of every
 * garment as free Russian text ("Пальто / Костюм", "футболка ", "tee"), so the
 * same garment landed under different keys and no aggregate over "what did we
 * receive" was possible. A customer tapping an icon cannot produce a typo, and
 * the taxonomy is the single list the server validates against.
 *
 * The canonical `category` values are the ones the analytics already
 * understand; `normalizeCategory` folds anything else into `прочее` without
 * guessing.
 *
 * This module is plain TypeScript with no imports so that both the Node server
 * and the browser bundle can use it.
 */

export type GarmentIconKey =
  | "tshirt"
  | "shirt"
  | "dress"
  | "coat"
  | "jacket"
  | "hoodie"
  | "trousers"
  | "shorts"
  | "skirt"
  | "underwear"
  | "set"
  | "bra"
  | "socks"
  | "towel"
  | "bedsheet"
  | "robe"
  | "nightgown"
  | "thermal"
  | "shoes"
  | "belt"
  | "bag";

export type GarmentSubtype = {
  /** Stable identifier. It goes into the quote snapshot, so it must not change. */
  id: string;
  /** Russian label shown on the subtype button. */
  label: string;
  /** Canonical category the item is counted under. */
  category: string;
  icon: GarmentIconKey;
};

export type GarmentCategory = {
  id: string;
  label: string;
  icon: GarmentIconKey;
  subtypes: GarmentSubtype[];
};

/**
 * The top level of the picker: one icon per family of garments. Tapping an icon
 * opens the overlay with that family's subtypes.
 */
export const GARMENT_CATEGORIES: GarmentCategory[] = [
  {
    id: "tshirt",
    label: "Футболки",
    icon: "tshirt",
    subtypes: [
      { id: "tshirt_plain", label: "Футболка", category: "футболка", icon: "tshirt" },
      { id: "tshirt_polo", label: "Футболка-поло", category: "футболка", icon: "tshirt" },
      { id: "tshirt_print", label: "С принтом", category: "футболка", icon: "tshirt" },
      { id: "tshirt_long", label: "Лонгслив", category: "футболка", icon: "tshirt" },
      { id: "tshirt_tank", label: "Топ, майка", category: "футболка", icon: "tshirt" },
      { id: "tshirt_kids", label: "Детская", category: "футболка", icon: "tshirt" },
    ],
  },
  {
    id: "shirt",
    label: "Рубашки",
    icon: "shirt",
    subtypes: [
      { id: "shirt_classic", label: "Рубашка", category: "рубашка", icon: "shirt" },
      { id: "shirt_polo", label: "Рубашка-поло", category: "рубашка", icon: "shirt" },
      { id: "shirt_french", label: "Френч", category: "рубашка", icon: "shirt" },
      { id: "shirt_blouse", label: "Блузка", category: "рубашка", icon: "shirt" },
      { id: "shirt_kids", label: "Детская", category: "рубашка", icon: "shirt" },
    ],
  },
  {
    id: "trousers",
    label: "Брюки",
    icon: "trousers",
    subtypes: [
      { id: "trousers_classic", label: "Брюки", category: "брюки", icon: "trousers" },
      { id: "trousers_jeans", label: "Джинсы", category: "джинсы", icon: "trousers" },
      { id: "trousers_chino", label: "Чиносы", category: "брюки", icon: "trousers" },
      { id: "trousers_warm", label: "Утеплённые", category: "брюки", icon: "trousers" },
      { id: "trousers_sport", label: "Спортивные штаны", category: "спортивные штаны", icon: "trousers" },
      { id: "shorts_sport", label: "Шорты", category: "шорты", icon: "shorts" },
    ],
  },
  {
    id: "dress",
    label: "Платья",
    icon: "dress",
    subtypes: [
      { id: "dress_sundress", label: "Платье", category: "платье", icon: "dress" },
      { id: "dress_pinafore", label: "Сарафан", category: "платье", icon: "dress" },
      { id: "dress_overalls", label: "Комбинезон", category: "платье", icon: "dress" },
      { id: "dress_skirt", label: "Юбка", category: "юбка", icon: "skirt" },
    ],
  },
  {
    id: "coat",
    label: "Куртки и пальто",
    icon: "coat",
    subtypes: [
      { id: "coat_jacket", label: "Куртка", category: "куртка", icon: "jacket" },
      { id: "coat_overcoat", label: "Пальто", category: "куртка", icon: "coat" },
      { id: "coat_down", label: "Пуховик", category: "куртка", icon: "coat" },
      { id: "coat_denim", label: "Джинсовка", category: "куртка", icon: "jacket" },
      { id: "coat_parka", label: "Парка", category: "куртка", icon: "coat" },
      { id: "coat_trench", label: "Плащ", category: "куртка", icon: "coat" },
      { id: "coat_windbreaker", label: "Ветровка", category: "куртка", icon: "jacket" },
    ],
  },
  {
    id: "knitwear",
    label: "Кофты и свитеры",
    icon: "hoodie",
    subtypes: [
      { id: "knit_hoodie", label: "Худи", category: "кофта", icon: "hoodie" },
      { id: "knit_sweater", label: "Свитер", category: "свитер", icon: "hoodie" },
      { id: "knit_sweatshirt", label: "Свитшот", category: "кофта", icon: "hoodie" },
      { id: "knit_cardigan", label: "Кардиган", category: "кофта", icon: "hoodie" },
      { id: "knit_jumper", label: "Джемпер", category: "кофта", icon: "hoodie" },
      { id: "knit_bolero", label: "Толстовка", category: "кофта", icon: "hoodie" },
    ],
  },
  {
    id: "underwear",
    label: "Бельё",
    icon: "underwear",
    subtypes: [
      { id: "underwear_set", label: "Комплект нательного", category: "бельё", icon: "set" },
      { id: "underwear_briefs", label: "Трусы", category: "бельё", icon: "underwear" },
      { id: "underwear_bra", label: "Бюстгальтер", category: "бельё", icon: "bra" },
      { id: "underwear_socks", label: "Носки", category: "бельё", icon: "socks" },
      { id: "underwear_night", label: "Ночная рубашка", category: "бельё", icon: "nightgown" },
      { id: "underwear_robe", label: "Халат", category: "бельё", icon: "robe" },
      { id: "underwear_thermal", label: "Термобельё", category: "бельё", icon: "thermal" },
    ],
  },
  {
    id: "linen",
    label: "Текстиль",
    icon: "towel",
    subtypes: [
      { id: "linen_towel", label: "Полотенце", category: "полотенце", icon: "towel" },
      { id: "linen_towel_fluffy", label: "Махровое", category: "полотенце", icon: "towel" },
      { id: "linen_sheet", label: "Простыня", category: "бельё", icon: "bedsheet" },
      { id: "linen_pillow", label: "Подушка", category: "бельё", icon: "bedsheet" },
      { id: "linen_blanket", label: "Плед", category: "бельё", icon: "bedsheet" },
    ],
  },
  {
    id: "shoes",
    label: "Обувь",
    icon: "shoes",
    subtypes: [
      { id: "shoes_sneakers", label: "Кроссовки", category: "обувь", icon: "shoes" },
      { id: "shoes_boots", label: "Ботинки", category: "обувь", icon: "shoes" },
      { id: "shoes_shoes", label: "Туфли", category: "обувь", icon: "shoes" },
      { id: "shoes_boots_high", label: "Сапоги", category: "обувь", icon: "shoes" },
      { id: "shoes_slippers", label: "Тапочки", category: "обувь", icon: "shoes" },
    ],
  },
  {
    id: "accessories",
    label: "Аксессуары",
    icon: "belt",
    subtypes: [
      { id: "accessory_belt", label: "Ремень", category: "прочее", icon: "belt" },
      { id: "accessory_bag", label: "Сумка", category: "прочее", icon: "bag" },
      { id: "accessory_scarf", label: "Шарф", category: "прочее", icon: "bag" },
      { id: "accessory_hat", label: "Головной убор", category: "прочее", icon: "bag" },
    ],
  },
];

const SUBTYPE_INDEX = new Map<string, GarmentSubtype>();
for (const category of GARMENT_CATEGORIES) {
  for (const subtype of category.subtypes) SUBTYPE_INDEX.set(subtype.id, subtype);
}

/** Every subtype, in picker order. */
export const GARMENT_SUBTYPES: GarmentSubtype[] = [...SUBTYPE_INDEX.values()];

export function findSubtype(subtypeId: string): GarmentSubtype | undefined {
  return SUBTYPE_INDEX.get(subtypeId);
}

/** The canonical category of a subtype id, or `undefined` when the id is unknown. */
export function categoryForSubtype(subtypeId: string): string | undefined {
  return SUBTYPE_INDEX.get(subtypeId)?.category;
}

/**
 * Synonyms of the canonical categories. A subtype always resolves to a canonical
 * value, but the analytics also has to cope with rows written before the
 * taxonomy existed, or with a partner typing a category by hand.
 */
const CATEGORY_SYNONYMS: Record<string, string[]> = {
  футболка: ["футболка", "футболки", "tee", "t-shirt", "t shirt", "футболка-хайтас", "хайтас", "майка"],
  рубашка: ["рубашка", "рубашки", "shirt", "френч", "блузка"],
  брюки: ["брюки", "брюк", "pants", "trousers", "тренеры", "чиносы"],
  джинсы: ["джинсы", "jeans", "джинса"],
  шорты: ["шорты", "shorts", "шортинки"],
  платье: ["платье", "dress", "платья", "сарафан"],
  юбка: ["юбка", "skirt"],
  кофта: ["кофта", "худи", "свитшот", "hoodie", "sweatshirt", "свитка", "кардиган", "джемпер", "толстовка"],
  свитер: ["свитер", "свитера"],
  куртка: ["куртка", "пуховик", "пальто", "coat", "jacket", "куртки", "джинсовка", "парка", "плащ", "ветровка"],
  бельё: ["белье", "бельё", "постельное бельё", "комплект белья", "трусы", "бюстгальтер", "носки", "халат", "термобельё"],
  полотенце: ["полотенце", "полотенца", "towel"],
  обувь: ["обувь", "кроссовки", "ботинки", "shoes", "туфли", "сапоги", "тапочки"],
  "спортивные штаны": ["спортивные штаны", "спортштаны", "joggers", "спортивные брюки"],
  костюм: ["костюм", "suit"],
  прочее: ["прочее", "разное", "other", "бытовая", "unknown", ""],
};

const CATEGORY_LOOKUP = new Map<string, string>();
for (const [canonical, synonyms] of Object.entries(CATEGORY_SYNONYMS)) {
  for (const synonym of synonyms) CATEGORY_LOOKUP.set(synonym.toLowerCase(), canonical);
}

/**
 * Maps a free-text category onto the controlled vocabulary. Falls back to
 * `прочее` — never to a guess that would inflate one bucket and deflate
 * another. The raw value is always kept alongside so nothing is silently lost.
 */
export function normalizeCategory(raw: string): string {
  const key = (raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!key) return "прочее";
  return CATEGORY_LOOKUP.get(key) ?? "прочее";
}

/** The maximum quantity one picker row may carry. */
export const MAX_PICKED_QUANTITY = 30;

/** The maximum number of distinct subtypes one declaration may list. */
export const MAX_DECLARED_ROWS = 50;

/** One declared piece of laundry: a subtype plus how many of it. */
export type DeclaredItem = {
  subtypeId: string;
  category: string;
  label: string;
  quantity: number;
};

export type DeclaredItemsResult =
  | { ok: true; items: DeclaredItem[] }
  | {
      ok: false;
      error: "UNKNOWN_GARMENT_SUBTYPE" | "INVALID_GARMENT_QUANTITY" | "TOO_MANY_DECLARED_ROWS";
      detail?: Record<string, unknown>;
    };

/**
 * Validates and merges a declaration against the taxonomy.
 *
 * The same function runs in the browser (to keep the picker honest) and on the
 * server (to keep the API honest) — the server never trusts a category string
 * that the taxonomy can derive itself. Duplicated subtypes are merged and the
 * total per subtype is capped, so a client cannot smuggle a quantity of 10 000
 * past the slider.
 */
export function normalizeDeclaredItems(
  rows: ReadonlyArray<{ subtypeId: string; quantity: number }> | null | undefined,
): DeclaredItemsResult {
  if (!rows?.length) return { ok: true, items: [] };
  if (rows.length > MAX_DECLARED_ROWS) {
    return { ok: false, error: "TOO_MANY_DECLARED_ROWS", detail: { max: MAX_DECLARED_ROWS } };
  }
  const merged = new Map<string, DeclaredItem>();
  for (const row of rows) {
    const subtype = findSubtype(row.subtypeId);
    if (!subtype) {
      return { ok: false, error: "UNKNOWN_GARMENT_SUBTYPE", detail: { subtypeId: row.subtypeId } };
    }
    if (!Number.isInteger(row.quantity) || row.quantity < 1 || row.quantity > MAX_PICKED_QUANTITY) {
      return {
        ok: false,
        error: "INVALID_GARMENT_QUANTITY",
        detail: { subtypeId: row.subtypeId, max: MAX_PICKED_QUANTITY },
      };
    }
    const existing = merged.get(subtype.id);
    if (existing) {
      existing.quantity = Math.min(MAX_PICKED_QUANTITY, existing.quantity + row.quantity);
    } else {
      merged.set(subtype.id, {
        subtypeId: subtype.id,
        category: subtype.category,
        label: subtype.label,
        quantity: row.quantity,
      });
    }
  }
  return { ok: true, items: [...merged.values()] };
}
