/** One expense: who paid it and who shares it; equal parts unless `shares` gives weights (2 = double). */
export interface Expense {
  concept: string;
  /** In pesos; cents allowed. */
  amount: number;
  paidBy: string;
  /** Who consumed it; everyone when absent. */
  participants?: string[];
  /** Unequal parts: name → weight. */
  shares?: Record<string, number>;
}

/** Money already handed over to settle the split. */
export interface Payment {
  from: string;
  to: string;
  amount: number;
}

export interface Transfer {
  from: string;
  to: string;
  /** In cents. */
  cents: number;
}

const key = (name: string) => name.trim().toLocaleLowerCase("es-AR");
const toCents = (pesos: number) => Math.round(pesos * 100);

/** The people of a split by their first spelling, without repeats. */
export function peopleOf(names: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const name of names) if (name.trim() && !seen.has(key(name))) seen.set(key(name), name.trim());
  return [...seen.values()];
}

/** Splits `cents` by weights, whole cents only, giving the leftover cents to the largest remainders (then by order). */
export function apportion(cents: number, weights: readonly number[]): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return weights.map(() => 0);
  const exact = weights.map((weight) => (cents * weight) / total);
  const parts = exact.map(Math.floor);
  let left = cents - parts.reduce((sum, part) => sum + part, 0);
  const order = exact.map((value, index) => ({ index, rest: value - Math.floor(value) })).sort((a, b) => b.rest - a.rest || a.index - b.index);
  for (const { index } of order) {
    if (left <= 0) break;
    parts[index] = (parts[index] ?? 0) + 1;
    left -= 1;
  }
  return parts;
}

/** What each person is owed (positive) or owes (negative), in cents, after expenses and payments. */
export function balances(people: readonly string[], expenses: readonly Expense[], payments: readonly Payment[]): Map<string, number> {
  const names = new Map(people.map((name) => [key(name), name]));
  const balance = new Map(people.map((name) => [name, 0]));
  const add = (name: string, cents: number) => {
    const display = names.get(key(name));
    if (display === undefined) throw new Error(`«${name}» no está entre los participantes`);
    balance.set(display, (balance.get(display) ?? 0) + cents);
  };
  for (const expense of expenses) {
    const cents = toCents(expense.amount);
    const sharing = expense.participants?.length ? peopleOf(expense.participants) : [...people];
    const weights = sharing.map((name) => {
      const weight = Object.entries(expense.shares ?? {}).find(([person]) => key(person) === key(name))?.[1];
      return weight ?? 1;
    });
    add(expense.paidBy, cents);
    apportion(cents, weights).forEach((part, index) => add(sharing[index] ?? "", -part));
  }
  for (const payment of payments) {
    add(payment.from, toCents(payment.amount));
    add(payment.to, -toCents(payment.amount));
  }
  return balance;
}

/**
 * The transfers that settle the balances: the biggest debtor pays the biggest creditor, again and
 * again. Each transfer clears at least one person, so there are never more than people minus one.
 * Ties go by the order people were listed, so the same split always gives the same answer.
 */
export function settle(people: readonly string[], balance: ReadonlyMap<string, number>): Transfer[] {
  const order = new Map(people.map((name, index) => [name, index]));
  const left = new Map(balance);
  const transfers: Transfer[] = [];
  const pick = (sign: 1 | -1) =>
    [...left.entries()]
      .filter(([, cents]) => sign * cents > 0)
      .sort((a, b) => sign * (b[1] - a[1]) || (order.get(a[0]) ?? 0) - (order.get(b[0]) ?? 0))[0];
  for (;;) {
    const creditor = pick(1);
    const debtor = pick(-1);
    if (!creditor || !debtor) return transfers;
    const cents = Math.min(creditor[1], -debtor[1]);
    transfers.push({ from: debtor[0], to: creditor[0], cents });
    left.set(creditor[0], creditor[1] - cents);
    left.set(debtor[0], debtor[1] + cents);
  }
}

/** «$13.495», or «$13.495,50» when there are cents. */
export function pesos(cents: number): string {
  const whole = cents % 100 === 0;
  return `$${(cents / 100).toLocaleString("es-AR", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 })}`;
}

/**
 * The answer in the owner's format: one line per transfer grouped by who receives (the one who
 * receives most first, payers in the order people were listed), a blank line between groups, then
 * the known alias of each one who receives. Nothing else.
 */
export function formatSplit(people: readonly string[], transfers: readonly Transfer[], aliases: ReadonlyMap<string, string>): { text: string; missingAliases: string[] } {
  const order = new Map(people.map((name, index) => [name, index]));
  const received = new Map<string, number>();
  for (const transfer of transfers) received.set(transfer.to, (received.get(transfer.to) ?? 0) + transfer.cents);
  const creditors = [...received.keys()].sort((a, b) => (received.get(b) ?? 0) - (received.get(a) ?? 0) || (order.get(a) ?? 0) - (order.get(b) ?? 0));
  const groups = creditors.map((creditor) =>
    transfers
      .filter((transfer) => transfer.to === creditor)
      .sort((a, b) => (order.get(a.from) ?? 0) - (order.get(b.from) ?? 0))
      .map((transfer) => `${transfer.from} → ${transfer.to}: ${pesos(transfer.cents)}`)
      .join("\n"),
  );
  const missingAliases = creditors.filter((creditor) => !aliases.get(key(creditor)));
  const aliasLines = creditors.flatMap((creditor) => {
    const alias = aliases.get(key(creditor));
    return alias ? [`Alias ${creditor}: ${alias}`] : [];
  });
  const text = [...groups, ...(aliasLines.length ? [aliasLines.join("\n")] : [])].join("\n\n");
  return { text: text || "No hay nada para transferir: están todos a mano.", missingAliases };
}

export const aliasKey = key;
