import type { Mail, MailFilter, Matcher } from "./types.js";

export function matches(mail: Mail, filter: MailFilter): boolean {
  if (mail.error) {
    return false;
  }

  return (
    matchAny(recipients(mail), filter.to, true) &&
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
    if (matcher instanceof RegExp) return toRegExp(matcher).test(value);
    return ignoreCase
      ? value.toLowerCase() === matcher.toLowerCase()
      : value === matcher;
  });
}

/**
 * @description Copy of a RegExp without `g` and `y`: both make `test`/`match`
 * depend on `lastIndex`, so a reused RegExp would skip matches.
 */
export function toRegExp(regExp: RegExp): RegExp {
  return new RegExp(regExp.source, regExp.flags.replace(/[gy]/g, ""));
}

/**
 * @description Every address the mail was delivered to: `to`, `cc`, `bcc` and
 * `Delivered-To` (the only place an alias shows up when it was sent as BCC).
 */
function recipients(mail: Mail): (string | undefined)[] {
  return [
    ...addresses(mail.to),
    ...addresses(mail.cc),
    ...addresses(mail.bcc),
    mail.deliveredTo,
  ];
}

/**
 * @description Lowercased recipients, also read from the raw headers of an
 * unreadable mail (it has no parsed `to`), like pop3-api does for `?to=`.
 */
export function recipientsOf(mail: Mail): string[] {
  const found = new Set<string>();

  for (const address of recipients(mail)) {
    if (address) found.add(address.trim().toLowerCase());
  }

  if (mail.headers) {
    const unfolded = mail.headers.replace(/\r?\n[ \t]+/g, " ");
    for (const line of unfolded.split(/\r?\n/)) {
      if (!/^(to|cc|bcc|delivered-to):/i.test(line)) continue;
      for (const match of line.matchAll(/[^\s<>,;:"']+@[^\s<>,;"']+/g)) {
        found.add(match[0].toLowerCase());
      }
    }
  }

  return [...found];
}

function addresses(list: Mail["to"] = []): (string | undefined)[] {
  return list.flatMap((item) =>
    item.group ? addresses(item.group) : [item.address]
  );
}
