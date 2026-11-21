import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecutionReport, ReviewResult, TaskSpec } from "./schemas.js";
import type { ScriptedHandler } from "./scripted-agent-backend.js";
import type { AgentRole } from "./agent-backend.js";

/**
 * A controlled task on a synthetic project, with criteria that are checked by running code.
 * Used by the tests (with scripted agents) and by `scripts/agent-demo.ts` (scripted or real Claude).
 */
export const CONTROLLED_TASK = {
  title: "Corregir el descuento en facturación demo",
  project: "facturacion-demo",
  request: [
    "En el proyecto facturacion-demo el total con descuento sale mal: con un ítem de 1000, 10 % de descuento e IVA 21 % debería dar 1089 y da 1197,9.",
    "Corregilo. Agregá pruebas para descuentos de 0 %, 10 % y 100 %.",
    "Si el descuento es menor que 0 o mayor que 100, invoiceTotal tiene que lanzar RangeError, con su prueba.",
    "Dejá un resumen corto del cambio en CHANGES.md en la raíz del repositorio.",
  ].join("\n"),
};

export interface CriterionCheck {
  id: string;
  pass: boolean;
  command: string;
  exitCode: number;
  evidence: string;
}

export function fixtureProjectsDir(): string {
  return fileURLToPath(new URL("../../fixtures/synthetic/work/projects", import.meta.url));
}

export function seedFixtureProjects(workDir: string): void {
  cpSync(fixtureProjectsDir(), join(workDir, "projects"), { recursive: true });
}

function node(cwd: string, args: string[]): { exitCode: number; output: string } {
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8", timeout: 30_000 });
  return { exitCode: result.status ?? 1, output: `${result.stdout}${result.stderr}`.trim().slice(-300) };
}

function testSources(repo: string): string {
  const dir = join(repo, "test");
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .filter((name) => name.endsWith(".mjs") || name.endsWith(".js"))
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .join("\n");
}

const totalProbe = `import("./src/totals.mjs").then((m) => { const t = m.invoiceTotal([{ unitPrice: 1000, quantity: 1 }], { discountPct: 10 }); console.log(t); process.exit(t === 1089 ? 0 : 1); })`;
const rangeProbe = `import("./src/totals.mjs").then((m) => { const bad = [150, -5].filter((d) => { try { m.invoiceTotal([{ unitPrice: 1, quantity: 1 }], { discountPct: d }); return true; } catch (e) { return !(e instanceof RangeError); } }); console.log(bad.length ? "sin RangeError para " + bad.join(", ") : "RangeError en ambos casos"); process.exit(bad.length ? 1 : 0); })`;

/** Checks the four acceptance criteria by executing code in the given repository. */
export function checkControlledCriteria(repo: string): CriterionCheck[] {
  const total = node(repo, ["--input-type=module", "-e", totalProbe]);
  const tests = node(repo, ["--test"]);
  const sources = testSources(repo);
  const coversDiscounts = [/discountPct:\s*0\b/, /discountPct:\s*10\b/, /discountPct:\s*100\b/].every((pattern) => pattern.test(sources));
  const range = node(repo, ["--input-type=module", "-e", rangeProbe]);
  const changes = join(repo, "CHANGES.md");
  const hasChanges = existsSync(changes) && readFileSync(changes, "utf8").trim().length > 20;
  return [
    { id: "C1", pass: total.exitCode === 0, command: "invoiceTotal(1000, 10 %)", exitCode: total.exitCode, evidence: `resultado: ${total.output}` },
    {
      id: "C2",
      pass: tests.exitCode === 0 && coversDiscounts,
      command: "node --test",
      exitCode: tests.exitCode,
      evidence: `${tests.exitCode === 0 ? "pruebas en verde" : "pruebas fallan"}; casos 0/10/100 ${coversDiscounts ? "presentes" : "ausentes"}`,
    },
    { id: "C3", pass: range.exitCode === 0, command: "invoiceTotal con descuento 150 y -5", exitCode: range.exitCode, evidence: range.output },
    { id: "C4", pass: hasChanges, command: "test -s CHANGES.md", exitCode: hasChanges ? 0 : 1, evidence: hasChanges ? "CHANGES.md presente" : "falta CHANGES.md" },
  ];
}

const SPEC: TaskSpec = {
  goal: "Que invoiceTotal aplique el descuento como porcentaje antes del IVA y rechace descuentos fuera de rango.",
  deliverables: ["src/totals.mjs corregido", "pruebas nuevas en test/", "CHANGES.md"],
  acceptanceCriteria: [
    { id: "C1", text: "1000 con 10 % de descuento e IVA 21 % da 1089", verification: "ejecutar invoiceTotal con esos datos" },
    { id: "C2", text: "Hay pruebas para 0 %, 10 % y 100 % y pasan", verification: "node --test" },
    { id: "C3", text: "Descuentos fuera de 0–100 lanzan RangeError", verification: "llamar con 150 y -5" },
    { id: "C4", text: "CHANGES.md resume el cambio", verification: "el archivo existe y no está vacío" },
  ],
  assumptions: ["El descuento se aplica sobre el subtotal, antes del IVA."],
  blockingQuestions: [],
  externalEffects: [],
};

const FIXED_FORMULA = `export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
}

export function invoiceTotal(items, { discountPct = 0, vatPct = 21 } = {}) {
  const discounted = subtotal(items) * (1 - discountPct / 100);
  return Math.round(discounted * (1 + vatPct / 100) * 100) / 100;
}
`;

const VALIDATED_FORMULA = FIXED_FORMULA.replace(
  "  const discounted",
  '  if (discountPct < 0 || discountPct > 100) throw new RangeError("discountPct debe estar entre 0 y 100");\n  const discounted',
);

const DISCOUNT_TESTS = `
test("descuentos de 0, 10 y 100 por ciento", () => {
  const one = [{ unitPrice: 1000, quantity: 1 }];
  assert.equal(invoiceTotal(one, { discountPct: 0 }), 1210);
  assert.equal(invoiceTotal(one, { discountPct: 10 }), 1089);
  assert.equal(invoiceTotal(one, { discountPct: 100 }), 0);
});
`;

const RANGE_TEST = `
test("descuento fuera de rango", () => {
  assert.throws(() => invoiceTotal(items, { discountPct: 150 }), RangeError);
  assert.throws(() => invoiceTotal(items, { discountPct: -5 }), RangeError);
});
`;

function report(summary: string, criteriaMet: string[]): ExecutionReport {
  return {
    status: "done",
    summary,
    changes: [{ path: "src/totals.mjs", description: "fórmula del descuento" }],
    commandsRun: [{ command: "node --test", exitCode: 0, summary: "pruebas en verde" }],
    deliverables: [{ path: "src/totals.mjs", description: "cálculo corregido" }],
    criteria: SPEC.acceptanceCriteria.map((criterion) => ({ id: criterion.id, status: criteriaMet.includes(criterion.id) ? "met" : "unsure", evidence: "según el ejecutor" })),
    questions: [],
    approvalsNeeded: [],
  };
}

/** A review computed from real checks, so the verdict depends on what the code does. */
export function reviewFromChecks(checks: CriterionCheck[]): ReviewResult {
  const failing = checks.filter((check) => !check.pass);
  return {
    verdict: failing.length === 0 ? "approve" : "changes",
    summary: failing.length === 0 ? "Los cuatro criterios pasan con evidencia propia." : `Fallan ${failing.map((check) => check.id).join(", ")}.`,
    criteria: checks.map((check) => ({ id: check.id, status: check.pass ? "pass" : "fail", evidence: check.evidence })),
    requiredChanges: failing.map((check) => `${check.id}: ${check.evidence}`),
    checksRun: checks.map((check) => ({ command: check.command, exitCode: check.exitCode, summary: check.evidence })),
  };
}

/**
 * Scripted agents for the controlled task. The first execution fixes the formula but skips
 * the range check and CHANGES.md while claiming everything is done; the reviewer catches it
 * by running the checks, and the second execution completes the work.
 */
export function controlledAgents(): Partial<Record<AgentRole, ScriptedHandler>> {
  return {
    planner: () => ({ output: SPEC }),
    executor: (request, call) => {
      const repo = request.dirs.cwd;
      if (call === 1) {
        writeFileSync(join(repo, "src/totals.mjs"), FIXED_FORMULA);
        writeFileSync(join(repo, "test/totals.test.mjs"), readFileSync(join(repo, "test/totals.test.mjs"), "utf8") + DISCOUNT_TESTS);
        return { output: report("Corregí la fórmula y agregué las pruebas; todo listo.", ["C1", "C2", "C3", "C4"]) };
      }
      writeFileSync(join(repo, "src/totals.mjs"), VALIDATED_FORMULA);
      writeFileSync(join(repo, "test/totals.test.mjs"), readFileSync(join(repo, "test/totals.test.mjs"), "utf8") + RANGE_TEST);
      writeFileSync(join(repo, "CHANGES.md"), "# Cambios\n\n- El descuento se aplica como porcentaje sobre el subtotal, antes del IVA.\n- Descuentos fuera de 0–100 lanzan RangeError.\n");
      return { output: { ...report("Agregué la validación de rango con su prueba y CHANGES.md.", ["C1", "C2", "C3", "C4"]), deliverables: [{ path: "src/totals.mjs", description: "cálculo corregido" }, { path: "CHANGES.md", description: "resumen del cambio" }] } };
    },
    reviewer: (request) => ({ output: reviewFromChecks(checkControlledCriteria(request.dirs.cwd)) }),
  };
}
