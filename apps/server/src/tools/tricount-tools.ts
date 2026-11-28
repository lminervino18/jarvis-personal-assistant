import { aliasKey, balances, formatSplit, peopleOf, settle } from "../tricount/split.js";
import { TricountStore } from "../tricount/tricount-store.js";
import { fail, ok } from "./envelope.js";
import { defineTool } from "./types.js";

const SOURCE = { provider: "tricount" };

export const tricount = defineTool({
  name: "tricount",
  description:
    "Reparte gastos entre amigos como Tricount, con un motor de cuentas exacto (no hagas cuentas vos). Cada reparto se guarda por nombre: la primera vez pasá las personas y los gastos (quién pagó cuánto y, si no todos consumieron lo mismo, quiénes participaron o con qué pesos); después podés sumar gastos, sacar conceptos, corregir la lista de personas o anotar pagos ya hechos sin repetir todo. Devuelve text, las transferencias mínimas en el formato del dueño, y missingAliases: los que cobran y no tienen alias guardado. Con solo el nombre muestra cómo está.",
  async execute(ctx, input) {
    const store = new TricountStore(ctx.services.db);
    const now = ctx.now();
    const saved = store.get(input.name);
    if (!saved && !input.expenses?.length) return fail("not_found", `No hay un reparto «${input.name}». Para empezarlo pasá las personas y los gastos.`);
    for (const [name, alias] of Object.entries(input.aliases ?? {})) store.setAlias(name, alias, now);
    const removed = new Set((input.removeExpenses ?? []).map(aliasKey));
    const expenses = [...(saved?.expenses ?? []).filter((expense) => !removed.has(aliasKey(expense.concept))), ...(input.expenses ?? [])];
    const payments = [...(saved?.payments ?? []), ...(input.payments ?? [])];
    const people = peopleOf([
      ...(input.people ?? saved?.people ?? []),
      ...expenses.flatMap((expense) => [expense.paidBy, ...(expense.participants ?? [])]),
      ...payments.flatMap((payment) => [payment.from, payment.to]),
    ]);
    if (people.length < 2) return fail("invalid_input", "Un reparto necesita al menos dos personas.");
    let balance: Map<string, number>;
    try {
      balance = balances(people, expenses, payments);
    } catch (error) {
      return fail("invalid_input", error instanceof Error ? error.message : "No pude hacer las cuentas.");
    }
    const { text, missingAliases } = formatSplit(people, settle(people, balance), store.aliases());
    store.save({ name: saved?.name ?? input.name, people, expenses, payments }, now);
    const total = expenses.reduce((sum, expense) => sum + expense.amount, 0);
    return ok(SOURCE, [{ name: saved?.name ?? input.name, text, missingAliases, people, total, expenses: expenses.map(({ concept, amount, paidBy }) => ({ concept, amount, paidBy })) }], {
      note: missingAliases.length
        ? `Faltan los alias de ${missingAliases.join(", ")}: pedíselos al dueño y volvé a llamar con aliases. Mientras, mostrá text tal cual.`
        : "Respondé exactamente con text: sin títulos, emojis ni explicaciones.",
    });
  },
});

export const tricountTools = [tricount] as const;
