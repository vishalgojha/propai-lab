import { Sandbox } from "novita-sandbox/code-interpreter";

const sandbox = await Sandbox.create({
  apiKey: process.env.NOVITA_API_KEY || "",
});

const result = await sandbox.runCode(`
import pandas as pd

df = pd.DataFrame({
    "Building": ["Lotus Arc One"],
    "Rent": [1800000]
})

print(df)
`);

console.dir(result, { depth: null });
