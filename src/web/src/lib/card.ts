// A payment card as a real form would check it, for the DEMONSTRATION of the 15 euro deposit.
//
// Everything here runs in the browser and stays there. The booking page shows the patient what a real form
// would say about the number, the date, the code and the name, so that the step looks and behaves like the
// real thing. Nothing typed into those fields is sent, stored or logged: the booking request carries the
// single word "demo", and the server refuses a request that carries anything else about a card.

export type CardBrand = "visa" | "mastercard" | "amex" | "other";
export type CardField = "card.number" | "card.name" | "card.expiry" | "card.cvc";
export type CardProblem = "required" | "invalid" | "expired";
export interface CardValues {
  number: string;
  name: string;
  expiry: string;
  cvc: string;
}

export const digitsOf = (text: string) => text.replace(/\D/g, "");

/** The scheme, by the number's first digits, as the schemes publish them. */
export function brandOf(number: string): CardBrand {
  const d = digitsOf(number);
  if (/^4/.test(d)) return "visa";
  if (/^(5[1-5]|222[1-9]|22[3-9]\d|2[3-6]\d\d|27[01]\d|2720)/.test(d)) return "mastercard";
  if (/^3[47]/.test(d)) return "amex";
  return "other";
}
export const BRAND_NAME: Record<CardBrand, string> = { visa: "Visa", mastercard: "Mastercard", amex: "American Express", other: "" };
const LENGTHS: Record<CardBrand, number[]> = { visa: [13, 16, 19], mastercard: [16], amex: [15], other: [12, 13, 14, 15, 16, 17, 18, 19] };
const longest = (brand: CardBrand) => Math.max(...LENGTHS[brand]);
export const cvcLength = (brand: CardBrand) => (brand === "amex" ? 4 : 3);

/** The check every card number carries in its last digit (Luhn). It catches a mistyped digit; it proves nothing about the card. */
export function luhn(number: string): boolean {
  const d = digitsOf(number);
  if (!d) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/** The number as it is printed on a card: in fours, or 4-6-5 for American Express. Never longer than the scheme allows. */
export function formatNumber(text: string): string {
  const brand = brandOf(text);
  const d = digitsOf(text).slice(0, longest(brand));
  const groups = brand === "amex" ? [4, 6, 5] : [4, 4, 4, 4, 3];
  const parts: string[] = [];
  let at = 0;
  for (const size of groups) {
    if (at >= d.length) break;
    parts.push(d.slice(at, at + size));
    at += size;
  }
  return parts.join(" ");
}

/** "MM/YY" as it is typed: the slash comes by itself, and a first digit above 1 is a month below ten. */
export function formatExpiry(text: string): string {
  let d = digitsOf(text).slice(0, 4);
  if (d.length === 1 && Number(d) > 1) d = `0${d}`;
  return d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
}

/** The month a card ends in, or null when the text is not a month and a year. */
export function parseExpiry(text: string): { month: number; year: number } | null {
  const m = /^(\d{2})\s*\/\s*(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const month = Number(m[1]);
  if (month < 1 || month > 12) return null;
  return { month, year: 2000 + Number(m[2]) };
}

/** What is wrong with each field, as a real form would say it; empty when all four are in order. */
export function cardProblems(card: CardValues, now: Date): Partial<Record<CardField, CardProblem>> {
  const problems: Partial<Record<CardField, CardProblem>> = {};
  const digits = digitsOf(card.number);
  const brand = brandOf(digits);
  if (!digits) problems["card.number"] = "required";
  else if (!LENGTHS[brand].includes(digits.length) || !luhn(digits)) problems["card.number"] = "invalid";

  const name = card.name.trim().replace(/\s+/g, " ");
  if (!name) problems["card.name"] = "required";
  // A name as it is embossed: letters, spaces and the few marks names have; at least two letters.
  else if (name.length > 60 || !/^[\p{L}][\p{L} .'-]*[\p{L}.]$/u.test(name)) problems["card.name"] = "invalid";

  if (!card.expiry.trim()) problems["card.expiry"] = "required";
  else {
    const end = parseExpiry(card.expiry);
    const thisMonth = now.getFullYear() * 12 + now.getMonth();
    if (!end) problems["card.expiry"] = "invalid";
    // A card is good to the end of the month on it, and no card runs twenty years.
    else if (end.year * 12 + (end.month - 1) < thisMonth) problems["card.expiry"] = "expired";
    else if (end.year * 12 + (end.month - 1) > thisMonth + 20 * 12) problems["card.expiry"] = "invalid";
  }

  const cvc = card.cvc.trim();
  if (!cvc) problems["card.cvc"] = "required";
  else if (!new RegExp(`^\\d{${cvcLength(brand)}}$`).test(cvc)) problems["card.cvc"] = "invalid";
  return problems;
}
