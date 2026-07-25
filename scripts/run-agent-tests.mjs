import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

async function collectTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTestFiles(target));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(target);
    }
  }
  return files;
}

function runTestFile(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--test", file],
      { stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${file} was terminated by ${signal}`));
      } else {
        resolve(code ?? 1);
      }
    });
  });
}

const testFiles = (await collectTestFiles("agent")).sort();
if (testFiles.length === 0) {
  throw new Error("No Agent test files were found.");
}

for (const file of testFiles) {
  const exitCode = await runTestFile(file);
  if (exitCode !== 0) process.exit(exitCode);
}

console.log(`Agent test files passed: ${testFiles.length}`);
