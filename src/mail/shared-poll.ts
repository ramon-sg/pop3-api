import { getMail } from "./get-mail";
import { accountKey } from "./store";

type PollOptions = Parameters<typeof getMail>[0];
type PollResult = Awaited<ReturnType<typeof getMail>>;
type Poll = (options: PollOptions) => Promise<PollResult>;

type Flight = {
  result: Promise<PollResult>;
  controller: AbortController;
  waiters: number;
};

const flights = new Map<string, Flight>();

/**
 * @description One POP3 session per account at a time. Concurrent requests
 * with the same credentials join the poll in progress and all get the same
 * mails, instead of opening parallel sessions that would split (or duplicate)
 * the mails between them.
 *
 * The shared poll is aborted (closed without `QUIT`) only when every caller
 * went away. Requests with a different password never share a poll, so a
 * wrong password cannot read the mails of someone else's session.
 */
export function sharedPoll(
  { signal, ...options }: PollOptions,
  poll: Poll = getMail
): Promise<PollResult> {
  const key = accountKey(options.username, options.password);

  let flight = flights.get(key);

  if (!flight) {
    const controller = new AbortController();
    const created: Flight = {
      controller,
      waiters: 0,
      result: poll({ ...options, signal: controller.signal }).finally(
        () => {
          if (flights.get(key) === created) flights.delete(key);
        }
      ),
    };
    flight = created;
    flights.set(key, flight);
  }

  join(flight, signal);

  return flight.result;
}

function join(flight: Flight, signal?: AbortSignal) {
  flight.waiters++;

  const leave = () => {
    flight.waiters--;
    if (flight.waiters === 0) flight.controller.abort();
  };

  if (signal?.aborted) {
    leave();
  } else {
    signal?.addEventListener("abort", leave, { once: true });
  }
}
