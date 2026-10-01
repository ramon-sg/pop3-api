import { getMail } from "./mail/get-mail";
import { sharedPoll } from "./mail/shared-poll";
import { MailStore, accountKey } from "./mail/store";
import { nok, ok, response } from "./responder";
import { PASSWORD_KEY, USERNAME_KEY } from "./constants";

type Deps = {
  store: MailStore;
  poll?: typeof getMail;
};

/**
 * @description Request handler. Every request polls the POP3 server (shared
 * between concurrent requests of the same account), stores what it brought
 * before `QUIT`, and answers with the retained mails of the account, only
 * those of `?to=<address>` when given.
 *
 * Retained mails are only returned when this poll succeeded: a request with a
 * wrong password fails to log in and gets nothing.
 */
export function createHandler({ store, poll = getMail }: Deps) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") {
      return ok("Departed");
    }

    const username = req.headers.get(USERNAME_KEY);
    const password = req.headers.get(PASSWORD_KEY);

    if (!username || !password) {
      return nok("Missing headers", { status: 400 });
    }

    const key = accountKey(username, password);
    const to = new URL(req.url).searchParams.get("to") || undefined;

    const [error] = await sharedPoll(
      { username, password, signal: req.signal },
      (options) => pollAndStore(options, key)
    );

    if (error) {
      return nok(error.message, { status: error.status });
    }

    const { mails, meta } = store.list(key, to);

    return response({ success: true, data: mails, meta });
  };

  async function pollAndStore(
    options: Parameters<typeof getMail>[0],
    key: string
  ) {
    const start = Date.now();
    let newMails = 0;

    const result = await poll({
      ...options,
      beforeQuit: (mails) => {
        newMails = store.add(key, mails);
      },
    });

    store.recordPoll(key, {
      at: new Date(start).toISOString(),
      durationMs: Date.now() - start,
      newMails,
      ...(result[0] ? { error: result[0].message } : {}),
    });

    return result;
  }
}
