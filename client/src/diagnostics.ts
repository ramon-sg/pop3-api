import type { Mail, MailboxMeta } from "./types.js";

/** One poll made by a `waitFor`. */
export type PollRecord = {
  at: string;
  durationMs: number;
  /** Mails this poll brought that the mailbox had not received before. */
  newMails?: number;
  /** The deadline came while the poll was still running. */
  pending?: boolean;
  error?: string;
};

/**
 * Summary of a mail for diagnostics. Never the body (`html`, `text`) nor the
 * attachments: they carry verification links and codes.
 */
export type MailSummary = {
  uidl?: string;
  subject?: string;
  from?: string;
  to: string[];
  date?: string;
  /** Already returned by an earlier `waitFor`. */
  taken: boolean;
  error?: string;
};

export type Verdict =
  | "found"
  | "filter-mismatch"
  | "taken"
  | "unreadable"
  | "expired"
  | "never-arrived"
  | "no-match";

export type WaitDiagnostics = {
  id: number;
  filter: string;
  /** Address the nearby mails were selected by, when the filter has one. */
  address?: string;
  startedAt: string;
  endedAt?: string;
  found: boolean;
  polls: PollRecord[];
  /** Mails for `address` (or the last ones received, without it). */
  nearby: MailSummary[];
  meta?: MailboxMeta;
  verdict: Verdict;
};

const VERDICTS: Record<Verdict, string> = {
  found: "a mail matched the filter",
  "filter-mismatch":
    "a mail for this address arrived, but it does not match the rest of the filter (subject, from, …)",
  taken:
    "the mails for this address were already returned by an earlier waitFor (overlapping filters?)",
  unreadable: "a mail for this address arrived, but pop3-api could not read it",
  expired:
    "pop3-api consumed mails for this address, but they expired before this waitFor asked",
  "never-arrived": "no mail for this address reached the inbox",
  "no-match":
    "no mail received matches the filter (add a string `to` for a precise verdict)",
};

export function summarize(mail: Mail, taken: boolean, to: string[]): MailSummary {
  return {
    uidl: mail.uidl,
    subject: mail.subject,
    from: mail.from?.address,
    to,
    date: mail.date,
    taken,
    ...(mail.error ? { error: mail.error } : {}),
  };
}

/** @description Which of the known causes explains a mail that was not found. */
export function verdictOf(
  found: boolean,
  nearby: MailSummary[],
  address: string | undefined,
  meta?: MailboxMeta
): Verdict {
  if (found) return "found";
  if (address && nearby.some((m) => !m.taken && !m.error)) return "filter-mismatch";
  if (address && nearby.some((m) => !m.taken && m.error)) return "unreadable";
  if (address && nearby.length > 0) return "taken";
  if (!address) return "no-match";
  if (meta && meta.expired > 0) return "expired";
  return "never-arrived";
}

/** @description "30 polls: 27 ok (3 with new mails), 3 errors: …". */
export function summarizePolls(polls: PollRecord[]): string {
  const ok = polls.filter((p) => !p.error && !p.pending);
  const withMails = ok.filter((p) => (p.newMails ?? 0) > 0).length;
  const pending = polls.filter((p) => p.pending).length;
  const errors = polls.filter((p) => p.error);

  const parts = [`${ok.length} ok (${withMails} with new mails)`];
  if (pending) parts.push(`${pending} still running at the deadline`);
  if (errors.length) {
    // The same error tends to repeat: group it, with its first and last time.
    const groups = new Map<string, PollRecord[]>();
    for (const p of errors) {
      groups.set(p.error!, [...(groups.get(p.error!) ?? []), p]);
    }
    const shown = [...groups]
      .map(([error, list]) => {
        const first = time(list[0]!.at);
        const last = time(list[list.length - 1]!.at);
        const when = first === last ? `at ${first}` : `from ${first} to ${last}`;
        return `${list.length}× "${error}" ${when}`;
      })
      .join("; ");
    parts.push(`${errors.length} errors: ${shown}`);
  }

  return `${polls.length} polls: ${parts.join(", ")}`;
}

/** @description Human readable report of a `waitFor`, for errors and attachments. */
export function formatDiagnostics(d: WaitDiagnostics): string {
  const lines = [
    `Filter: ${d.filter}`,
    `Verdict: ${d.verdict} — ${VERDICTS[d.verdict]}.`,
    `Polls: ${summarizePolls(d.polls)}.`,
  ];

  if (d.meta) {
    const last = d.meta.lastPoll;
    const lastText = last
      ? `last poll at ${time(last.at)} ${last.error ? `failed: ${last.error}` : `ok (${last.durationMs} ms, ${last.newMails} new)`}`
      : "no poll recorded";
    lines.push(
      `pop3-api: ${d.meta.retained} retained, ${d.meta.expired} expired ${d.address ? "for this address" : "in the account"}; ${lastText}.`
    );
  }

  const title = d.address
    ? `Mails for ${d.address} (${d.nearby.length}):`
    : `Last mails received (${d.nearby.length}):`;
  lines.push(d.nearby.length ? title : `${title} none`);

  for (const mail of d.nearby) {
    const flags = [mail.taken && "taken", mail.error && `unreadable: ${mail.error}`]
      .filter(Boolean)
      .join(", ");
    lines.push(
      `  - ${flags ? `[${flags}] ` : ""}"${mail.subject ?? "(no subject)"}" from ${mail.from ?? "?"} to ${mail.to.join(", ") || "?"}${mail.date ? ` at ${mail.date}` : ""}`
    );
  }

  return lines.join("\n");
}

function time(iso: string): string {
  return iso.slice(11, 19);
}
