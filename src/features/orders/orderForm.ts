/**
 * Parsing a customer-filled order form.
 *
 * Sellers send a short form over WhatsApp or SMS, the customer fills it in and
 * sends it back, and the seller pastes the reply into SellFlow. Nothing
 * guarantees the reply will look like the form, so this module is deliberately
 * forgiving about shape and strict about what it claims: anything it cannot
 * account for comes back in `warnings` or `unmatched` for the seller to see,
 * rather than being silently dropped or guessed into the order.
 *
 * The template these fields come from:
 *
 *   Please Fill This Order Form:
 *
 *   Name:
 *   Product:
 *   Size:
 *   Quantity:
 *   Address:
 *   Thana:
 *   Jela:
 *   Your Message:
 *
 * "Jela" is the spelling sellers actually use for district. It is accepted here
 * alongside the usual Zila/District forms, and the generated form keeps their
 * spelling so the round trip is exact.
 */

/** A catalogue product the parser may match against. */
import { normaliseDigits } from '@/lib/money';

export interface MatchableProduct {
  id: string;
  name: string;
  sku: string | null;
  variants?: { id: string; name: string }[];
}

export type ParsedField =
  | 'name'
  | 'phone'
  | 'product'
  | 'size'
  | 'quantity'
  | 'address'
  | 'thana'
  | 'district'
  | 'message';

export interface ParsedLine {
  /** Catalogue product this resolved to, when it resolved to exactly one. */
  productId: string | null;
  /** Product text as the customer wrote it. */
  raw: string;
  /** Human-readable name for the line, from the catalogue when known. */
  name: string;
  quantity: number;
  /** Size the customer asked for, when they gave one. */
  size: string | null;
  /**
   * Set when more than one catalogue product could match, so the seller picks
   * rather than the app guessing.
   */
  candidates: { id: string; name: string }[];
}

export interface ParsedOrderForm {
  name: string | null;
  phone: string | null;
  address: string | null;
  thana: string | null;
  district: string | null;
  message: string | null;
  size: string | null;
  lines: ParsedLine[];
  /** True when nothing usable was found at all. */
  empty: boolean;
  /**
   * Things the seller must look at. Empty means the parse was clean and can be
   * trusted as a starting draft.
   */
  warnings: string[];
}

/**
 * The blank form exactly as it is offered to the seller to copy and send.
 *
 * "Jela" is the spelling the sellers using this actually write, so the template
 * keeps it. The parser accepts Zila and District too, for freehand replies.
 */
export const BLANK_FORM_TEMPLATE = `Please Fill This Order Form:

Name:
Product:
Size:
Quantity:
Address:
Thana:
Jela:
Your Message:`;

/**
 * Rebuilds the filled form as text from a request that arrived through a shared
 * link.
 *
 * This is deliberately a round trip through the same template and the same
 * parser as a pasted reply. A customer who fills a link and a customer who sends
 * a WhatsApp message want the same thing handled the same way, and the cheapest
 * way to guarantee that is for both to go through one code path -- otherwise the
 * two drift apart and the link flow quietly grows its own idea of what a product
 * name means.
 */
export function requestToFormText(request: {
  customer_name: string;
  customer_phone?: string | null;
  items?: { name: string; quantity: number; size?: string | null }[];
  address?: string | null;
  thana?: string | null;
  district?: string | null;
  message?: string | null;
}): string {
  const items = request.items ?? [];
  const productLines = items.length
    ? [
        `Product: ${items.map((item) => item.name).join(', ')}`,
        `Quantity: ${items.map((item) => String(item.quantity || 1)).join(', ')}`,
        items.some((item) => item.size) ? `Size: ${items[0]?.size ?? ''}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    : '';

  return [
    BLANK_FORM_TEMPLATE,
    `Name: ${request.customer_name}`,
    request.customer_phone ? `Phone: ${request.customer_phone}` : '',
    productLines,
    request.address ? `Address: ${request.address}` : '',
    request.thana ? `Thana: ${request.thana}` : '',
    request.district ? `Jela: ${request.district}` : '',
    request.message ? `Your Message: ${request.message}` : '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}
const LABELS: { field: ParsedField; aliases: string[] }[] = [
  { field: 'name', aliases: ['name', 'customer name', 'full name', 'naam'] },
  { field: 'phone', aliases: ['phone', 'mobile', 'phone number', 'contact', 'number', 'cell'] },
  { field: 'product', aliases: ['product', 'products', 'item', 'items', 'product name'] },
  { field: 'size', aliases: ['size', 'sizes', 'measurement'] },
  { field: 'quantity', aliases: ['quantity', 'qty', 'quantities', 'amount of'] },
  { field: 'address', aliases: ['address', 'location', 'home address'] },
  { field: 'thana', aliases: ['thana', 'thanа', 'upazila', 'police station'] },
  { field: 'district', aliases: ['jela', 'zila', 'zilla', 'district'] },
  { field: 'message', aliases: ['your message', 'message', 'note', 'notes', 'comment', 'remarks'] },
];

/** Bangladeshi mobile numbers, tolerant of spaces, dashes and +88. */
const PHONE_PATTERN = /(?:\+?88[\s-]?)?(0?1[3-9]\d[\s-]?\d{3}[\s-]?\d{4})/g;

/**
 * 1kg === 1 kg, ৳1500 === Tk1500. Keeps scraped text readable in the summary.
 *
 * Bangla digits are normalised by the shared helper in src/lib/money.ts rather than a
 * second local map, so a digit that parses here also parses in a quantity field.
 */
function tidy(value: string): string {
  return value
    .replace(/[০-৯]/g, (d) => normaliseDigits(d))
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function normaliseForCompare(value: string): string {
  return tidy(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pulls the first integer out of a value, tolerating "2 pcs", "২টি", "3 x".
 *
 * Returns null for anything that is not a positive whole number, including
 * missing input: a paste with more products than quantities must not throw its
 * way out of the order screen.
 */
export function parseQuantity(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  // Normalise first: Bangla digits are only digits once they have been mapped,
  // so matching before this would read "৪" as no number at all.
  const match = tidy(value).match(/-?\d+/);
  if (!match) return null;
  const n = Number.parseInt(match[0], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Splits normalised text into comparable tokens. */
function tokens(value: string): string[] {
  const normalised = normaliseForCompare(value);
  return normalised ? normalised.split(' ') : [];
}

/**
 * True when `needle`'s tokens appear as a consecutive run inside `haystack`'s.
 *
 * Token runs, not `String.includes`: plain substring matching makes "ba" match
 * "Premium Bag", which then silently prices the order from the wrong product.
 */
function containsRun(haystack: string[], needle: string[]): boolean {
  if (!needle.length || needle.length > haystack.length) return false;
  // Pad both sides so a match must sit between spaces. Without the padding,
  // "bag" would match inside "baggage" tokens and price the wrong product.
  return (' ' + haystack.join(' ') + ' ').indexOf(' ' + needle.join(' ') + ' ') !== -1;
}

/**
 * Trailing quantity chatter: "Saree x2", "Earbuds (3)", "Saree 2".
 *
 * Both forms require a number, so "TWS-9 Earbuds" and the SKU "EAR-9" keep their
 * digits instead of losing them to the cleaner.
 */
const TRAILING_COUNT =
  /[\s(]*(?:[-–]\s*)?(?:(?:x|×)\s*\d+|\d+\s*(?:pcs?|pieces?|sets?|টি)?)\s*\)?\s*$/i;

/**
 * Matches free product text against the catalogue.
 *
 * Order matters: an exact name always beats a substring, and a substring that
 * hits several products is reported as ambiguous rather than resolved to the
 * nearest one. Picking a favourite here is how "Saree" silently becomes "Cotton
 * Saree" on a customer's real order.
 */
export function matchProduct(
  raw: string,
  products: MatchableProduct[],
): { productId: string | null; name: string; candidates: { id: string; name: string }[] } {
  const asCandidates = (hits: MatchableProduct[]) =>
    hits.map((p) => ({ id: p.id, name: p.name }));

  const rawNorm = normaliseForCompare(raw);
  const stripped = raw.replace(TRAILING_COUNT, '');
  const strippedNorm = normaliseForCompare(stripped);

  // A SKU resolves first, and against both the raw and the stripped text. Doing
  // this after the cleaner would look for "ear" instead of "ear 9".
  const bySku = products.filter(
    (p) =>
      !!p.sku &&
      (normaliseForCompare(p.sku) === rawNorm || normaliseForCompare(p.sku) === strippedNorm),
  );
  const onlySku = bySku[0];
  if (bySku.length === 1 && onlySku) return { productId: onlySku.id, name: onlySku.name, candidates: [] };
  if (bySku.length > 1) return { productId: null, name: raw, candidates: asCandidates(bySku) };

  const needle = tokens(stripped.trim() ? stripped : raw);
  if (!needle.length) return { productId: null, name: raw, candidates: [] };

  const exact = products.filter((p) => {
    const name = tokens(p.name);
    return name.length === needle.length && containsRun(name, needle);
  });
  const onlyExact = exact[0];
  if (exact.length === 1 && onlyExact) return { productId: onlyExact.id, name: onlyExact.name, candidates: [] };
  if (exact.length > 1) return { productId: null, name: raw, candidates: asCandidates(exact) };

  // A partial hit. Exactly one candidate is not a guess -- there is nothing
  // else it could be -- so a single distinctive word like "earbuds" resolves.
  // Two or more candidates is where guessing would happen, and that is reported
  // instead of decided.
  const partial = products.filter((p) => {
    const name = tokens(p.name);
    return name.length !== needle.length && containsRun(name, needle);
  });
  const onlyPartial = partial[0];
  if (partial.length === 1 && onlyPartial) {
    return { productId: onlyPartial.id, name: onlyPartial.name, candidates: [] };
  }
  if (partial.length) return { productId: null, name: raw, candidates: asCandidates(partial) };

  return { productId: null, name: raw, candidates: [] };
}

/** Splits "Saree, Earbuds" or "Saree x2, Earbuds x1" into separate entries. */
function splitProductList(value: string): string[] {
  const parts = value
    .split(/\s*(?:,|;|\n|\/|&|\band\b|\bplus\b)\s*/i)
    .map(tidy)
    .filter(Boolean);

  if (parts.length > 1) return parts;

  // "Saree 2 Earbuds 1" — a name followed by a bare count, repeated.
  const tokens = value.split(/\s+/).filter(Boolean);
  if (tokens.length >= 4 && tokens.filter((t) => /^\d+$/.test(t)).length >= 2) {
    const out: string[] = [];
    let buffer: string[] = [];
    for (const token of tokens) {
      if (/^\d+$/.test(token)) {
        if (buffer.length) out.push(buffer.join(' '));
        buffer = [];
      } else {
        buffer.push(token);
      }
    }
    if (buffer.length) out.push(buffer.join(' '));
    if (out.length > 1) return out;
  }

  return parts.length ? parts : [value.trim()];
}

/**
 * Splits a pasted form into labelled values.
 *
 * Unlabelled lines continue the previous field, because an address typed on a
 * phone is very often split across three lines and the second and third lines
 * carry no label at all.
 */
function extractFields(text: string): Map<ParsedField, string[]> {
  const found = new Map<ParsedField, string[]>();
  let lastField: ParsedField | null = null;

  const push = (field: ParsedField, value: string) => {
    const cleaned = tidy(value);
    if (!cleaned) return;
    const list = found.get(field) ?? [];
    list.push(cleaned);
    found.set(field, list);
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    // Skip the template's own headings and instructions.
    if (/please\s+fill/i.test(line)) continue;

    const colonAt = line.indexOf(':');
    let matched: { field: ParsedField; rest: string } | null = null;

    if (colonAt > 0) {
      const label = normaliseForCompare(line.slice(0, colonAt)).replace(/[*-]\s*$/, '').trim();
      for (const entry of LABELS) {
        if (entry.aliases.some((alias) => label === alias)) {
          matched = { field: entry.field, rest: line.slice(colonAt + 1) };
          break;
        }
      }
    }

    if (matched) {
      lastField = matched.field;
      push(matched.field, matched.rest);
      continue;
    }

    // A bare "Saree: 2" is still a product; treat an unknown short label with a
    // numeric value as a product line rather than throwing the text away.
    if (colonAt > 0 && lastField === null) {
      const label = normaliseForCompare(line.slice(0, colonAt));
      if (label && label.split(' ').length <= 3 && /^\d+/.test(tidy(line.slice(colonAt + 1)))) {
        push('product', line.slice(0, colonAt));
        push('quantity', line.slice(colonAt + 1));
        lastField = 'quantity';
        continue;
      }
    }

    if (lastField) push(lastField, line);
    else push('message', line);
  }

  return found;
}

/**
 * Parses a pasted customer reply into a draft order.
 *
 * `products` is the seller's catalogue for the active store; matching against
 * it is what turns "saree" into a real line with a real price. Products with no
 * match are still returned, unmatched, so the seller can decide whether to add
 * them by hand or fix the name.
 */
export function parseOrderForm(text: string, products: MatchableProduct[] = []): ParsedOrderForm {
  const fields = extractFields(text ?? '');
  const warnings: string[] = [];

  const single = (field: ParsedField): string | null => {
    const list = fields.get(field);
    return list && list.length ? list.join(' ').trim() : null;
  };

  const name = single('name');
  const size = single('size');
  const address = single('address');
  const thana = single('thana');
  const district = single('district');
  const message = single('message');

  // A phone is worth finding even where the form has no phone field, because it
  // is how the seller recognises an existing customer. Any match wins, so the
  // label is irrelevant.
  let phone = single('phone');
  const phoneMatches = tidy(text).match(PHONE_PATTERN);
  if (phoneMatches?.length) {
    const digits = phoneMatches[0].replace(/\D/g, '').replace(/^88/, '');
    const local = digits.length === 10 ? '0' + digits.slice(1) : digits;
    if (phone && phone.replace(/\D/g, '') !== local) {
      warnings.push('Found more than one phone number. Check the customer.');
    }
    phone = local;
  } else if (phone) {
    phone = phone.replace(/\D/g, '');
  }

  // Products may be repeated ("Product: X" twice) or comma-separated in one
  // value; quantities follow the same shape. Both are flattened to lists.
  const productValues = (fields.get('product') ?? []).flatMap(splitProductList);
  const quantityValues = (fields.get('quantity') ?? []);

  const quantities = quantityValues.flatMap((value) =>
    // "2, 1" or "2 x 1" inside one Quantity line means two different counts.
    value.includes(',') || /\d+\s*[x×]\s*\d+/.test(value)
      ? value.split(/\s*(?:,|x|×)\s*/i).map(tidy).filter(Boolean)
      : [value],
  );

  const lines: ParsedLine[] = [];

  if (productValues.length && quantities.length === productValues.length) {
    productValues.forEach((raw, index) => {
      const match = matchProduct(raw, products);
      lines.push({ ...match, raw, quantity: parseQuantity(quantities[index]) ?? 1, size });
    });
  } else if (productValues.length && quantities.length === 1) {
    // One count for several products: the common "Product: saree, earbuds /
    // Quantity: 2" meaning two of each. Applied, but called out, because the
    // other reading (two items in total) is also possible.
    const quantity = parseQuantity(quantities[0]) ?? 1;
    if (productValues.length > 1) {
      warnings.push(`Assumed ${quantity} of each product. Check the quantities.`);
    }
    for (const raw of productValues) {
      const match = matchProduct(raw, products);
      lines.push({ ...match, raw, quantity, size });
    }
  } else if (productValues.length) {
    if (quantities.length > productValues.length) {
      warnings.push('More quantities than products. Only the first counts were used.');
    }
    productValues.forEach((raw, index) => {
      const match = matchProduct(raw, products);
      lines.push({ ...match, raw, quantity: parseQuantity(quantities[index]) ?? 1, size });
    });
  } else if (quantities.length) {
    warnings.push('Found a quantity but no product name.');
  }

  // Anything the catalogue could not place is kept visible rather than dropped.
  const unmatched = lines.filter((line) => line.productId === null);
  const firstUnmatched = unmatched[0];

  if (!name) warnings.push('No customer name found.');
  if (!lines.length) warnings.push('No products found. Add them by hand.');
  if (unmatched.length && firstUnmatched) {
    warnings.push(
      unmatched.length === 1
        ? `"${firstUnmatched.name}" is not in your catalogue. Add it or pick a product.`
        : `${unmatched.length} products are not in your catalogue. Add them or pick from the list.`,
    );
  }

  const empty =
    !name && !phone && !address && !thana && !district && !message && !lines.length;

  return { name, phone, address, thana, district, message, size, lines, empty, warnings };
}
