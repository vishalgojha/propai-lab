import { Sandbox } from "novita-sandbox/code-interpreter";

const sandbox = await Sandbox.create({
  apiKey: process.env.NOVITA_API_KEY || "",
});

const result = await sandbox.runCode(`
print("Hello from Novita!")
`);

console.log(result.logs);
