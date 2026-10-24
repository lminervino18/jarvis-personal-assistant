import { createInterface } from "node:readline/promises";
import { hashPassword } from "../src/auth/password.js";

const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY });
const password = (await rl.question("Owner password (min 12 chars): ")).trim();
rl.close();
console.log(await hashPassword(password));
