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

const countryKnown = (country: string): boolean => {
  try {
    return postcodeValidatorExistsForCountry(country);
  } catch {
    return false;
  }
};

/**
 * Country-aware validation. Postal codes follow `postcode-validator`'s per-country patterns (required
 * when the country has one); the region is required where the country's address format prints one.
 * Countries without a postal-code pattern accept any (or no) postal code.
 */
export const validateAddress = (a: Address): AddressCheck => {
  const issues: AddressIssue[] = [];
  if (!countryKnown(a.country))
    issues.push({ field: "country", code: "invalid" });
  else {
    if (a.postalCode === undefined)
      issues.push({ field: "postalCode", code: "required" });
    else if (!postcodeValidator(a.postalCode, a.country))
      issues.push({ field: "postalCode", code: "invalid" });
    if (a.region === undefined && needsRegion(a.country))
      issues.push({ field: "region", code: "required" });
  }
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
