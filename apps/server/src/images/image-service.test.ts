import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AttachmentStore } from "../attachments/attachment-store.js";
import { openMigratedDatabase } from "../db/database.js";
import { Outbox } from "../worker/outbox.js";
import { ImageService } from "./image-service.js";

const PNG = Buffer.from("fake-png-bytes");
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function setup(respond: (url: string, init: RequestInit) => Response) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-images-"));
  dirs.push(dir);
  const db = openMigratedDatabase(":memory:");
  const attachments = new AttachmentStore(db, dir);
  const calls: { url: string; init: RequestInit }[] = [];
  const sent: { jid: string; text: string; attachmentId: string }[] = [];
  const service = new ImageService({
    apiKey: "sk-test",
    attachments,
    outbox: new Outbox(db),
    sendWhatsApp: (input) => sent.push(input),
    log: { info: () => {}, warn: () => {} },
    fetchFn: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return respond(url, init);
    }) as typeof fetch,
  });
  const chat = () => db.prepare("SELECT payload_json FROM outbox WHERE kind = 'chat_message'").all().map((row) => JSON.parse((row as { payload_json: string }).payload_json));
  return { service, attachments, calls, sent, chat };
}

const image = () => new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }), { status: 200 });

describe("ImageService", () => {
  it("generates an image in the background and leaves it in the chat", async () => {
    const { service, calls, chat, attachments } = setup(image);
    service.start({ prompt: "Un robot leyendo el diario", referenceIds: [], quality: "medium", format: "portrait" });
    await service.idle();
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/images/generations");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ model: "gpt-image-2", size: "1024x1536", quality: "medium", n: 1 });
    const [message] = chat();
    expect(message.text).toContain("Lista la imagen");
    expect(message.cards[0]).toMatchObject({ kind: "attachment", mediaType: "image/png" });
    expect(attachments.read(message.cards[0].attachmentId)?.data).toEqual(PNG);
  });

  it("edits the owner's photos and sends the result to the chat that was named", async () => {
    const { service, calls, sent, attachments } = setup(image);
    const photo = attachments.save({ name: "yo.jpg", mediaType: "image/jpeg", data: Buffer.from("jpeg") }, new Date());
    service.start({ prompt: "Poneme un casco de astronauta", referenceIds: [photo!.id], quality: "low", format: "square", sendTo: { jid: "123@s.whatsapp.net", name: "Ana", text: "Mirá" } });
    await service.idle();
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/images/edits");
    const form = calls[0]?.init.body as FormData;
    expect(form.get("prompt")).toBe("Poneme un casco de astronauta");
    expect(form.getAll("image[]")).toHaveLength(1);
    expect(sent).toEqual([{ jid: "123@s.whatsapp.net", text: "Mirá", attachmentId: expect.any(String) }]);
  });

  it("explains a missing OpenAI balance instead of failing silently", async () => {
    const { service, chat, sent } = setup(() => new Response(JSON.stringify({ error: { code: "insufficient_quota" } }), { status: 429 }));
    service.start({ prompt: "Un gato", referenceIds: [], quality: "medium", format: "square", sendTo: { jid: "1@s.whatsapp.net", name: "Ana" } });
    await service.idle();
    expect(chat()[0].text).toBe("No pude hacer la imagen: OpenAI no tiene crédito: cargalo en platform.openai.com › Billing.");
    expect(sent).toEqual([]);
  });
});
