# pop3-api

This is a simple API that connects to a POP3 server and returns the emails in the inbox.
Used preferably for testing purposes.
Works very well with Pop3 Gmail.


To install dependencies:

```bash
bun install
```

To run:

```bash
bun run start
```

# Configuration:
To configure the server, you can use the following environment variables:
- `MAIL_PORT`: the port the server will connect to. Default is 995.
- `MAIL_HOST`: the host the server will connect to. Default is `pop.gmail.com`.
- `MAIL_TLS`: if the client will use TLS. Default is `true`.
- `MAIL_REJECT_UNAUTHORIZED`: if the client will reject unauthorized certificates. Default is `true`.
- `LOG_LEVEL`: the log level of the server. Default is `info`.
- `PORT`: the port the server will listen to. Default is 3000.

# pop3-api
To obtain the emails it is necessary to make a query to `/` with the following headers:
- `X-POP3-USERNAME`: the email you want to check
- `X-POP3-PASSWORD`: the password of the email you want to check

The response will be a JSON with the emails in the inbox.

## Success response

```json
{
  "status": "success",
  "data": [
    {
      "from": {"name": "John Doe", "address": "john@mailcom"},

      "to": [
        { "name": "user one", "address": "one@mail.com"},
      ],
      "subject": "Hello",
      "html":  "<h1>Hello</h1>",
      "text": "Hello",
      "date": "2021-09-01T00:00:00.000Z"
      // ...
    }
  ]
}
```

**Note**: You can see the full attributes of the mail in `Mail` type in `mail/types.ts`.


## Error response

```json
{
  "status": "error",
  "message": "Error message"
}
```


## Curl example:
```bash
curl -X GET "http://localhost:3000/" -H "X-POP3-USERNAME: <email>" -H "X-POP3-PASSWORD: <password>"
```


## Docker
To run the server in a docker container, you can use the following command:

```bash
docker run -p 3000:3000 ramonsoto/pop3-api:v0.0.1
```

# Gmail Account

## Generate a password for the app, follow the steps below:
- activate the 2-step verification in your account.
- Go to the next link: [https://myaccount.google.com/apppasswords](https://myaccount.google.com/apppassword)

## Activate pop3 and disable imap, follow the steps below:
- Go to the next link: [https://mail.google.com/mail/u/0/#settings/fwdandpop](https://mail.google.com/mail/u/0/#settings/fwdandpop)

- in `POP Download` select `Enable POP for all mail (even mail that's already been downloaded)- in `IMAP Access` select `Disable IMAP`



