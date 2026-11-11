import { format } from "@fragaria/address-formatter";
import type { Address } from "@free-commerce/schema";
import {
  postcodeValidator,
  postcodeValidatorExistsForCountry,
} from "postcode-validator";

export type AddressField =
  | "line1"
  | "city"
  | "region"
  | "postalCode"
  | "country";
export type AddressIssue = {
  field: AddressField;
  code: "required" | "invalid";
};
export type AddressCheck = { ok: true } | { ok: false; issues: AddressIssue[] };

const PROBE = "\u0000region";

const toInput = (a: Address) => ({
  road: a.line1,
  city: a.city,
  state: a.region,
  postcode: a.postalCode,
  countryCode: a.country,
  country: a.country,
});

/** Whether the country's address template prints a region, i.e. the region is part of a valid address. */
const needsRegion = (country: string): boolean =>
  format(
    {
      road: "r",
      city: "c",
      postcode: "p",
      state: PROBE,
      countryCode: country,
      country,
    },
    { output: "string" },
  ).includes(PROBE);

/** ISO 3166-1 alpha-2 membership, from the formatter's country list: it resolves a known code to a name and echoes an unknown one back. */
const countryKnown = (country: string): boolean =>
  format(
    { countryCode: country },
    { output: "string", appendCountry: true },
  ).trim() !== country;

const hasPostcodeRule = (country: string): boolean => {
  try {
    return postcodeValidatorExistsForCountry(country);
  } catch {
    return false;
  }
};

const postalIssue = (a: Address): AddressIssue | undefined => {
  if (!hasPostcodeRule(a.country)) return undefined;
  if (a.postalCode === undefined)
    return { field: "postalCode", code: "required" };
  return postcodeValidator(a.postalCode, a.country)
    ? undefined
    : { field: "postalCode", code: "invalid" };
};

/**
 * Country-aware validation. Postal codes follow `postcode-validator`'s per-country patterns (required
 * when the country has one, otherwise optional and unchecked); the region is required where the country's address format prints one.
 */
export const validateAddress = (a: Address): AddressCheck => {
  if (!countryKnown(a.country))
    return { ok: false, issues: [{ field: "country", code: "invalid" }] };
  const issues: AddressIssue[] = [];
  const postal = postalIssue(a);
  if (postal) issues.push(postal);
  if (a.region === undefined && needsRegion(a.country))
    issues.push({ field: "region", code: "required" });
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
};

/** Mailing lines in the country's local order: recipient, company, street, then the country's city/region/postcode layout. Country name is not included. */
export const formatAddress = (a: Address): string[] => {
  const lines = format(toInput(a), { output: "array" });
  lines.pop(); // trailing country name; callers render it localised
  if (a.line2 !== undefined) {
    const i = lines.indexOf(a.line1);
    lines.splice(i < 0 ? lines.length : i + 1, 0, a.line2);
  }
  return [a.name, ...(a.company ? [a.company] : []), ...lines];
};
