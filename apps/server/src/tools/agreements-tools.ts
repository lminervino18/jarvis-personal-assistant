import { AgreementStore, type Agreement, type AgreementStatus } from "../agenda/agreements-store.js";
import { ContactStore } from "../agenda/contacts-store.js";
import { formatLocal } from "../agenda/format.js";
import { toUtcIso, toZonedIso } from "../util/time.js";
import { fail, ok } from "./envelope.js";
import { defineTool, type ToolContext } from "./types.js";

const SOURCE = { provider: "agreements" };
const LIST_LIMIT = 50;
const STATUS_LABEL: Record<AgreementStatus, string> = { proposed: "propuesto", confirmed: "confirmado", cancelled: "cancelado" };

function present(agreement: Agreement, ownerZone: string) {
  const zone = agreement.timezone ?? ownerZone;
  return {
    id: agreement.id,
    title: agreement.title,
    details: agreement.details,
    status: agreement.status,
    when: agreement.whenUtc ? toZonedIso(agreement.whenUtc, zone) : null,
    timezone: agreement.whenUtc ? zone : null,
    source: { type: agreement.sourceType, ref: agreement.sourceRef },
    parties: agreement.parties,
    createdAt: agreement.createdAt,
    updatedAt: agreement.updatedAt,
  };
}

function whenDetail(ctx: ToolContext, when: string | undefined) {
  return when ? [{ label: "Cuándo", value: formatLocal(toUtcIso(when), ctx.services.timezone) }] : [];
}

export const agreementsList = defineTool({
  name: "agreements_list",
  description:
    "Lista acuerdos con otras personas, filtrando por estado (proposed, confirmed, cancelled), contacto o rango de fechas del acuerdo.",
  async execute(ctx, input) {
    const { agreements, hasMore } = new AgreementStore(ctx.services.db).list(
      {
        status: input.status,
        contactId: input.contactId,
        fromUtc: input.from ? toUtcIso(input.from) : undefined,
        toUtc: input.to ? toUtcIso(input.to) : undefined,
      },
      LIST_LIMIT,
    );
    return ok(
      SOURCE,
      agreements.map((agreement) => present(agreement, ctx.services.timezone)),
      { page: { hasMore }, coverage: { from: input.from, to: input.to, note: "Acuerdos registrados por J.A.R.V.IS." } },
    );
  },
});

export const agreementsPropose = defineTool({
  name: "agreements_propose",
  description:
    "Registra una propuesta de acuerdo ('podríamos jugar el viernes'). Siempre queda como propuesta; solo agreements_confirm la confirma, cuando el dueño lo dice.",
  describe(ctx, input) {
    const names = new ContactStore(ctx.services.db);
    const parties = (input.counterpartContactIds ?? []).map((id) => names.get(id)?.displayName ?? id);
    return {
      title: "Registrar propuesta de acuerdo",
      summary: input.title,
      details: [
        ...whenDetail(ctx, input.when),
        ...(parties.length ? [{ label: "Con", value: parties.join(", ") }] : []),
        { label: "Origen", value: input.sourceType },
      ],
    };
  },
  async execute(ctx, input) {
    const partyIds = input.counterpartContactIds ?? [];
    const missing = new ContactStore(ctx.services.db).missingIds(partyIds);
    if (missing.length) return fail("not_found", `No existen contactos con id: ${missing.join(", ")}. Usá contacts_resolve.`);
    const agreement = new AgreementStore(ctx.services.db).propose(
      {
        title: input.title,
        details: input.details,
        partyIds,
        whenUtc: input.when ? toUtcIso(input.when) : undefined,
        timezone: ctx.services.timezone,
        sourceType: input.sourceType,
        sourceRef: input.sourceRef,
        turnId: ctx.turnId,
      },
      ctx.now(),
    );
    return ok(SOURCE, [present(agreement, ctx.services.timezone)], {
      note: "Quedó registrado como propuesta, no como acuerdo confirmado.",
    });
  },
});

export const agreementsConfirm = defineTool({
  name: "agreements_confirm",
  description:
    "Confirma un acuerdo que está en estado propuesto, solo cuando el dueño confirma explícitamente ('quedamos el viernes a las 20'). Podés fijar la fecha final con 'when'.",
  describe(ctx, input) {
    const agreement = new AgreementStore(ctx.services.db).get(input.agreementId);
    return { title: "Confirmar acuerdo", summary: agreement?.title ?? "Acuerdo inexistente", details: whenDetail(ctx, input.when) };
  },
  async execute(ctx, input) {
    const store = new AgreementStore(ctx.services.db);
    const existing = store.get(input.agreementId);
    if (!existing) return fail("not_found", "No existe un acuerdo con ese id.");
    const confirmed = store.confirm(
      input.agreementId,
      { whenUtc: input.when ? toUtcIso(input.when) : undefined, timezone: ctx.services.timezone, turnId: ctx.turnId },
      ctx.now(),
    );
    if (!confirmed) {
      return fail("invalid_input", `Solo se puede confirmar un acuerdo propuesto; este está ${STATUS_LABEL[existing.status]}.`);
    }
    return ok(SOURCE, [present(confirmed, ctx.services.timezone)], { note: "Acuerdo confirmado." });
  },
});

export const agreementsCancel = defineTool({
  name: "agreements_cancel",
  description: "Cancela un acuerdo propuesto o confirmado, con un motivo opcional.",
  describe(ctx, input) {
    const agreement = new AgreementStore(ctx.services.db).get(input.agreementId);
    return {
      title: "Cancelar acuerdo",
      summary: agreement?.title ?? "Acuerdo inexistente",
      details: input.reason ? [{ label: "Motivo", value: input.reason }] : [],
    };
  },
  async execute(ctx, input) {
    const store = new AgreementStore(ctx.services.db);
    const existing = store.get(input.agreementId);
    if (!existing) return fail("not_found", "No existe un acuerdo con ese id.");
    if (existing.status === "cancelled") {
      return ok(SOURCE, [present(existing, ctx.services.timezone)], { note: "Ya estaba cancelado." });
    }
    const cancelled = store.cancel(input.agreementId, { reason: input.reason, turnId: ctx.turnId }, ctx.now()) as Agreement;
    return ok(SOURCE, [present(cancelled, ctx.services.timezone)], { note: "Acuerdo cancelado." });
  },
});

export const agreementsTools = [agreementsList, agreementsPropose, agreementsConfirm, agreementsCancel];
