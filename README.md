# @mailtarn/node

Mailtarn for Node.js (18+). No dependencies.

- **Read captured email in tests:** wait for a message, then use its links and one-time codes.
- **Send into a Mailtarn inbox over HTTP** instead of SMTP. Mailtarn never delivers anything:
  messages land in your inbox and stay there.

```bash
npm install @mailtarn/node
```

Create an API token in Mailtarn (Developer → API tokens) with the permissions you need and keep
it in a secret, e.g. `MAILTARN_TOKEN`.

## Wait for an email in a test

```ts
import { Mailtarn } from '@mailtarn/node';

const mt = new Mailtarn({ token: process.env.MAILTARN_TOKEN! });
const inboxId = process.env.MAILTARN_INBOX!;

const since = new Date();
await signUp('priya@example.com'); // your app sends the verification email

const email = await mt.waitFor(inboxId, { to: 'priya@example.com', since });
expect(email.subject).toBe('Verify your email');
await page.goto(email.links[0]!.url); // or: await page.fill('#code', email.codes[0]!)
```

`waitFor` returns the first matching message received after `since` (without `since`, the newest
match, or the next to arrive). It waits up to `timeoutMs` (default 30 000) and throws a
`MailtarnError` with code `wait_timeout` if nothing arrives. Filters: `to`, `from`, `subject`,
`q` (anywhere), `hasAttachments`. Needs `messages:read`.

Each message has `text`, `html` (as sent; untrusted, render it only in a sandbox), `headers`,
`attachments`, `envelope` (every recipient, including BCC), `links` and `codes`.

## Send into an inbox

```ts
await mt.send({
  inbox: inboxId, // not needed with a token for one inbox
  from: { name: 'Acme', address: 'hello@acme.test' },
  to: 'priya@example.com',
  subject: 'Welcome',
  html: '<p>Hello</p>',
  attachments: [{ filename: 'invoice.pdf', content: pdfBytes, contentType: 'application/pdf' }],
});
```

Addresses take `a@b.test`, `Name <a@b.test>`, `"Last, First" <a@b.test>` or `{ name, address }`.
Needs `messages:send`. Returns once the message is stored (`202`); it is processed a moment later.

## Everything else

```ts
await mt.inboxes.list();
await mt.messages.list(inboxId, { subject: 'Welcome', limit: 20 });
await mt.messages.get(id);
await mt.messages.raw(id);            // the .eml bytes
await mt.messages.attachment(id, 0);
await mt.messages.delete(id);         // messages:delete
await mt.inboxes.clear(inboxId);      // messages:delete
await mt.usage();
```

Errors are `MailtarnError` with `status` and a stable `code` (`unauthorized`,
`insufficient_scope`, `not_found`, `rate_limited`, `wait_timeout`, …).

Another Mailtarn server (for example a local one while developing): `new Mailtarn({ token, baseUrl: 'http://localhost:3001' })`.

## Licence

MIT. Copyright (c) 2026 Mailtarn (mailtarn.com).
