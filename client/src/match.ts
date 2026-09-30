import type { Mail, MailFilter, Matcher } from "./types.js";

export function matches(mail: Mail, filter: MailFilter): boolean {
  if (mail.error) {
    return false;
  }

  return (
    matchAny(addresses(mail.to), filter.to, true) &&
    matchAny(addresses(mail.from ? [mail.from] : []), filter.from, true) &&
    matchAny([mail.subject], filter.subject) &&
    matchAny([mail.text], filter.text) &&
    matchAny([mail.html], filter.html) &&
    (!filter.where || filter.where(mail))
  );
}

/**
 * @description Serializes a filter for error messages. `JSON.stringify` alone
 * turns a RegExp into `{}` and drops functions.
 *
 * @example
 * describeFilter({ subject: /pago/i }); // '{"subject":"/pago/i"}'
 */
export function describeFilter(filter: MailFilter): string {
  return JSON.stringify(filter, (_key, value) => {
    if (value instanceof RegExp) return value.toString();
    if (typeof value === "function") return "[function]";
    return value;
  });
}

function matchAny(
  values: (string | undefined)[],
  matcher: Matcher | undefined,
  ignoreCase = false
): boolean {
  if (matcher === undefined) {
    return true;
  }

  return values.some((value) => {
    if (value == null) return false;
    if (typeof matcher === "function") return matcher(value);
    if (matcher instanceof RegExp) return new RegExp(matcher).test(value);
    return ignoreCase
      ? value.toLowerCase() === matcher.toLowerCase()
      : value === matcher;
  });
}

function addresses(list: Mail["to"] = []): (string | undefined)[] {
  return list.flatMap((item) =>
    item.group ? addresses(item.group) : [item.address]
  );
}
