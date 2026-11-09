/**
 * Mailtarn for Node.js.
 *
 *   import { Mailtarn } from '@mailtarn/node';
 *   const mt = new Mailtarn({ token: process.env.MAILTARN_TOKEN! });
 *
 *   const since = new Date();
 *   await signUp('priya@example.com');                       // your app sends the email
 *   const email = await mt.waitFor(inboxId, { to: 'priya@example.com', since });
 *   expect(email.subject).toBe('Verify your email');
 *   await page.goto(email.links[0]!.url);                   // or type email.codes[0]
 *
 * Mailtarn captures email and never delivers it. `send` puts a message into a Mailtarn inbox
 * over HTTP (instead of SMTP); it does not send to the real recipients.
 */

export interface Address {
  name: string;
  address: string;
}

export interface Attachment {
  index: number;
  filename: string | null;
  contentType: string;
  size: number;
  contentId: string | null;
  inline: boolean;
}

export interface Message {
  id: string;
  inboxId: string;
  status: 'received' | 'parsed' | 'failed';
  receivedAt: string;
  subject: string | null;
  from: string | null;
  to: Address[];
  cc: Address[];
  messageId: string | null;
  envelope: { from: string | null; to: string[] };
  text: string | null;
  /** The HTML exactly as sent. Untrusted: never render it outside a sandbox. */
  html: string | null;
  headers: Array<{ name: string; value: string }>;
  attachments: Attachment[];
  /** http(s) links, from the HTML (with their text) then the plain text. */
  links: Array<{ url: string; text: string | null }>;
  /** One-time codes near words like "code" or "OTP", most likely first. */
  codes: string[];
  warnings: string[];
}

export interface MessageSummary {
  id: string;
  inboxId: string;
  status: Message['status'];
  receivedAt: string;
  subject: string | null;
  from: string | null;
  to: Address[];
  snippet: string | null;
  hasAttachments: boolean;
}

export interface Inbox {
  id: string;
  name: string;
  projectId: string;
  smtpUsername: string;
  isCi: boolean;
  createdAt: string;
}

export interface Filters {
  /** Substring of a To/Cc/envelope recipient. */
  to?: string;
  from?: string;
  /** Substring of the subject. */
  subject?: string;
  /** Words anywhere (subject, addresses, body). */
  q?: string;
  /** Only messages received after this time. */
  since?: Date | string;
  hasAttachments?: boolean;
}

/** `a@b.test`, `Name <a@b.test>`, `"Last, First" <a@b.test>`, or the object form. */
export type AddressInput = string | { name?: string; address: string };

export interface SendInput {
  /** Inbox id. Not needed with a token for one inbox. */
  inbox?: string;
  from: AddressInput;
  to?: AddressInput | AddressInput[];
  cc?: AddressInput | AddressInput[];
  bcc?: AddressInput | AddressInput[];
  replyTo?: AddressInput;
  subject?: string;
  text?: string;
  html?: string;
  /** Custom headers such as X-Env (addressing and MIME headers come from the fields). */
  headers?: Record<string, string>;
  attachments?: Array<{ filename?: string; content: string | Uint8Array; contentType?: string; contentId?: string; inline?: boolean }>;
}

export interface MailtarnOptions {
  /** An API token (mtk_…). */
  token: string;
  /** Default https://app.mailtarn.com */
  baseUrl?: string;
  /** For tests and unusual runtimes. Default: the global fetch. */
  fetch?: typeof fetch;
}

/** An error response from the API, with its stable code (e.g. "insufficient_scope", "wait_timeout"). */
export class MailtarnError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'MailtarnError';
  }
}

const WAIT_MAX_S = 60;

export class Mailtarn {
  private readonly base: string;
  private readonly token: string;
  private readonly doFetch: typeof fetch;

  constructor(opts: MailtarnOptions) {
    if (!opts?.token) throw new Error('Mailtarn: pass { token } (an API token starting with mtk_).');
    this.token = opts.token;
    this.base = (opts.baseUrl ?? 'https://app.mailtarn.com').replace(/\/+$/, '');
    this.doFetch = opts.fetch ?? fetch;
  }

  /** Puts a message into a Mailtarn inbox (stored, never delivered). Needs messages:send. */
  async send(input: SendInput): Promise<{ id: string; inboxId: string; status: 'received' }> {
    const body = {
      ...input,
      attachments: input.attachments?.map((a) => ({
        ...a,
        content: typeof a.content === 'string' ? a.content : base64(a.content),
      })),
    };
    return this.json('POST', '/v1/send', body);
  }

  /**
   * Waits for a message matching the filters and returns it in full. With `since`, the first
   * match received after it; without, the newest match (or the next to arrive). `timeoutMs`
   * (default 30 s) may exceed the server's 60 s per request: it keeps asking until then.
   * Throws MailtarnError with code "wait_timeout" if nothing arrives.
   */
  async waitFor(inboxId: string, filters: Filters & { timeoutMs?: number } = {}): Promise<Message> {
    const deadline = Date.now() + (filters.timeoutMs ?? 30_000);
    for (;;) {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      try {
        const r = await this.json<{ message: Message }>('GET', `/v1/inboxes/${enc(inboxId)}/messages/wait${qs({ ...filters, timeout: Math.min(left, WAIT_MAX_S) })}`);
        return r.message;
      } catch (e) {
        if (e instanceof MailtarnError && e.code === 'wait_timeout' && Date.now() < deadline) continue;
        throw e;
      }
    }
  }

  readonly inboxes = {
    list: async (): Promise<Inbox[]> => (await this.json<{ inboxes: Inbox[] }>('GET', '/v1/inboxes')).inboxes,
    /** Needs inboxes:manage. The password is returned once. */
    create: async (input: { name: string; projectId?: string; isCi?: boolean }) =>
      this.json<{ inbox: { id: string; name: string; projectId: string; smtpUsername: string }; credential: { username: string; password: string } }>('POST', '/v1/inboxes', input),
    /** Deletes every message in the inbox. Needs messages:delete. */
    clear: async (inboxId: string) => this.json<{ deleted: number }>('DELETE', `/v1/inboxes/${enc(inboxId)}/messages`),
  };

  readonly messages = {
    list: async (inboxId: string, filters: Filters & { limit?: number; cursor?: string } = {}) =>
      this.json<{ messages: MessageSummary[]; nextCursor: string | null }>('GET', `/v1/inboxes/${enc(inboxId)}/messages${qs(filters)}`),
    get: async (id: string): Promise<Message> => (await this.json<{ message: Message }>('GET', `/v1/messages/${enc(id)}`)).message,
    /** The message as received (.eml bytes). */
    raw: async (id: string): Promise<Uint8Array> => new Uint8Array(await (await this.request('GET', `/v1/messages/${enc(id)}/raw`)).arrayBuffer()),
    attachment: async (id: string, index: number): Promise<Uint8Array> =>
      new Uint8Array(await (await this.request('GET', `/v1/messages/${enc(id)}/attachments/${index}`)).arrayBuffer()),
    delete: async (id: string): Promise<void> => { await this.request('DELETE', `/v1/messages/${enc(id)}`); },
  };

  /** This month's usage for what the token can see: its organization, project or inbox (`scope`). */
  async usage() {
    return this.json<{ scope: 'org' | 'project' | 'inbox'; periodStart: string; messages: number; bytesIn: number; storageBytes: number }>('GET', '/v1/usage');
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await this.doFetch(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const e = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      throw new MailtarnError(res.status, e?.error?.code ?? `http_${res.status}`, e?.error?.message ?? res.statusText);
    }
    return res;
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.request(method, path, body);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

function qs(f: object): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f as Record<string, unknown>)) {
    if (v === undefined || v === null || k === 'timeoutMs') continue;
    p.set(k, v instanceof Date ? v.toISOString() : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

function base64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
