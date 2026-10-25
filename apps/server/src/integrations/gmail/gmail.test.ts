import { describe, expect, it } from "vitest";
import { buildGoogleHarness, loadFixture } from "../google/test-support.js";
import { MAX_BODY_CHARS } from "./parse.js";

const PERSONAL = "loren.prueba@example.test";
const WORK = "loren.trabajo@example.test";

async function setup(labels: ("personal" | "work")[] = ["personal"]) {
  const harness = buildGoogleHarness();
  for (const label of labels) await harness.connect(label, label === "personal" ? PERSONAL : WORK);
  harness.fake.threads.set("t1", loadFixture("gmail/thread.json"));
  harness.fake.calls.length = 0;
  return harness;
}

describe("gmail search", () => {
  it("returns headers, decoded snippets and Buenos Aires dates tagged with the account", async () => {
    const { gmail, fake } = await setup();
    const outcome = await gmail.search("personal", "reunión", 10);

    expect(outcome.items).toHaveLength(2);
    expect(outcome.items[0]).toMatchObject({
      account: "personal",
      accountEmail: PERSONAL,
      messageId: "m1",
      threadId: "t1",
      from: "Ana Prueba <ana@example.test>",
      subject: "Reunión del martes",
      snippet: "Te confirmo la reuni'n del martes",
      labels: ["INBOX", "UNREAD"],
    });
    expect(outcome.items[0]?.date).toMatch(/-03:00$/);
    expect(outcome.nextCursor).toBe("PAGE2");
    expect(fake.calls.find((call) => call.url.includes("/messages?"))?.url).toContain("q=reuni%C3%B3n");
  });

  it("never modifies anything and never downloads attachments", async () => {
    const { gmail, fake } = await setup();
    await gmail.search("personal", "factura", 5);
    await gmail.getThread("personal", "t1");
    const gmailCalls = fake.calls.filter((call) => call.url.startsWith("https://gmail.googleapis.com/"));
    const urls = gmailCalls.map((call) => call.url);
    expect(gmailCalls.length).toBeGreaterThan(0);
    expect(gmailCalls.every((call) => call.method === "GET")).toBe(true);
    expect(urls.some((url) => url.includes("attachments") || url.includes("modify") || url.includes("trash"))).toBe(false);
  });

  it("with account all keeps accounts separate and tolerates a missing work account", async () => {
    const { gmail } = await setup(["personal"]);
    const outcome = await gmail.search("all", "reunión", 10);
    expect(outcome.items.every((item) => item.account === "personal" && item.accountEmail === PERSONAL)).toBe(true);
    expect(outcome.unavailable).toEqual([{ account: "work", code: "not_connected", message: "La cuenta de trabajo de Gmail no está conectada.", retryable: false }]);
    expect(outcome.nextCursor).toMatch(/^all\./);
  });

  it("queries both accounts, labels each item and pages them independently", async () => {
    const { gmail, fake } = await setup(["personal", "work"]);
    const first = await gmail.search("all", "reunión", 10);
    expect([...new Set(first.items.map((item) => item.accountEmail))].sort()).toEqual([PERSONAL, WORK]);
    expect(first.unavailable).toEqual([]);

    fake.calls.length = 0;
    const second = await gmail.search("all", "reunión", 10, first.nextCursor);
    const listCalls = fake.calls.filter((call) => new URL(call.url).pathname.endsWith("/messages"));
    expect(listCalls).toHaveLength(2);
    expect(listCalls.every((call) => call.url.includes("pageToken=PAGE2"))).toBe(true);
    expect(second.items.length).toBeGreaterThan(0);
  });

  it("rejects a malformed cursor and a missing explicit account", async () => {
    const { gmail } = await setup();
    await expect(gmail.search("all", "x", 5, "all.!!!")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(gmail.search("work", "x", 5)).rejects.toMatchObject({ code: "not_connected", account: "work" });
    await expect(gmail.getThread("work", "t1")).rejects.toMatchObject({ code: "not_connected" });
  });

  it("refreshes once when Gmail answers 401 and gives up with auth_expired when it persists", async () => {
    const { gmail, fake } = await setup();
    fake.staleTokens.add("access-1");
    await expect(gmail.search("personal", "x", 5)).rejects.toMatchObject({ code: "auth_expired" });

    fake.staleTokens.clear();
    fake.accessToken = "access-2";
    expect((await gmail.search("personal", "x", 5)).items).toHaveLength(2);
  });

  it("maps invalid_grant on refresh to an expired account in status", async () => {
    const { gmail, fake, tokens } = await setup();
    tokens.invalidate("personal");
    fake.refreshFails = true;
    await expect(gmail.search("personal", "x", 5)).rejects.toMatchObject({ code: "auth_expired" });
    expect(await gmail.status()).toEqual([
      { provider: "gmail", account: PERSONAL, status: "needs_action", detail: "Cuenta personal: la autorización venció; hay que reconectarla." },
      { provider: "gmail", account: "work", status: "disconnected", detail: "Cuenta de trabajo: no conectada." },
    ]);
  });

  it("maps upstream failures to retryable errors", async () => {
    const { gmail, fake } = await setup();
    fake.gmailStatus = 503;
    await expect(gmail.search("personal", "x", 5)).rejects.toMatchObject({ code: "upstream_error", retryable: true });
    fake.gmailStatus = 429;
    await expect(gmail.search("personal", "x", 5)).rejects.toMatchObject({ code: "rate_limited", retryable: true });
  });
});

describe("gmail thread parsing", () => {
  it("prefers text/plain, falls back to stripped html and lists attachments as metadata", async () => {
    const { gmail } = await setup();
    const thread = await gmail.getThread("personal", "t1");

    expect(thread.accountEmail).toBe(PERSONAL);
    const [first, second] = thread.messages;
    expect(first?.body).toBe("Hola Loren,\n\nNos vemos el martes a las 10.\n\nAna");
    expect(first?.attachments).toEqual([{ filename: "agenda.pdf", mimeType: "application/pdf", sizeBytes: 20480 }]);
    expect(first).toMatchObject({ to: "Loren Prueba <loren.prueba@example.test>", subject: "Reunión del martes" });
    expect(second?.body).toBe("Perfecto, confirmado & listo.");
    expect(second?.bodyTruncated).toBe(false);
  });

  it("truncates long bodies and flags them", async () => {
    const { gmail } = await setup();
    const third = (await gmail.getThread("personal", "t1")).messages[2];
    expect(third?.bodyTruncated).toBe(true);
    expect(third?.body.length).toBeLessThanOrEqual(MAX_BODY_CHARS + 1);
    expect(third?.body.endsWith("…")).toBe(true);
  });

  it("caps very long threads to the latest messages", async () => {
    const { gmail, fake } = await setup();
    const base = loadFixture<{ messages: { id: string }[] }>("gmail/thread.json");
    const many = Array.from({ length: 20 }, (_, index) => ({ ...base.messages[0], id: `n${index}` }));
    fake.threads.set("big", { id: "big", messages: many });
    const thread = await gmail.getThread("personal", "big");
    expect(thread.messages).toHaveLength(15);
    expect(thread.omittedOlder).toBe(5);
    expect(thread.messages[0]?.messageId).toBe("n5");
  });

  it("reports a missing thread as not_found", async () => {
    const { gmail } = await setup();
    await expect(gmail.getThread("personal", "nope")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("gmail status", () => {
  it("shows the work label as cleanly not connected while personal is connected", async () => {
    const { gmail } = await setup();
    expect(await gmail.status()).toEqual([
      { provider: "gmail", account: PERSONAL, status: "connected", detail: "Cuenta personal conectada (solo lectura)." },
      { provider: "gmail", account: "work", status: "disconnected", detail: "Cuenta de trabajo: no conectada." },
    ]);
  });
});
